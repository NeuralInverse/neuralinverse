# Neural Inverse Modernisation — Architecture

> **Domain**: Firmware & Industrial Safety-Critical Modernisation  
> **Standards**: IEC 61508 · IEC 62443 · MISRA-C:2012 · IEC 61131-3 · ISO 26262  
> **Version**: 2.0 (Firmware Edition)

---

## 1. Overview

Neural Inverse Modernisation is a six-layer, agentic code modernisation engine embedded inside the Neural Inverse IDE. It orchestrates the transformation of legacy embedded C, bare-metal firmware, PLC Ladder Logic, and industrial control code into modern, safety-certified equivalents (FreeRTOS, Zephyr RTOS, MISRA-C++, IEC 61131-3 Structured Text, OPC-UA).

The engine is **compliance-first**: every pipeline decision is gated by IEC 61508 (Functional Safety), IEC 62443 (Industrial Cybersecurity), and MISRA-C:2012 (Safety-critical C) requirements. No unit can reach the translation stage without passing the regulated-data scanner and the compliance orderer.

```
┌─────────────────────────────────────────────────────────────────────┐
│                  Neural Inverse Modernisation Engine                 │
│                                                                      │
│  Stage 1: Discovery ──► Stage 2: Planning ──► Stage 3: Translation  │
│                                                                      │
│  Layer 1: Fingerprint        Layer 4: Phase Builder                  │
│  Layer 2: Discovery          Layer 5: Compliance Orderer             │
│  Layer 3: Resolution         Layer 6: Translation Engine             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Pipeline Stages

### Stage 1 — Discovery

Scans the project file system, decomposes source files into migration units, detects safety-regulated patterns, and constructs a dependency and call graph.

**Key outputs:**
- `IProjectScanResult` — units, GRC snapshot, dependency edges, call graph, effort estimates
- `IRegulatedDataHit[]` — MMIO casts, ISR definitions, watchdog calls, IEC 62443 credentials
- `IDiscoveryResult` — cross-project pairings for source ↔ target matching

### Stage 2 — Planning (Roadmap)

Takes the Stage 1 result and produces a fully phased `IMigrationRoadmap` with:
- **CPM critical path** (Critical Path Method scheduling)
- **Phase assignment** respecting firmware dependency order
- **Compliance ordering** — SIL-rated units always migrate last
- **API compatibility gates** — protocol adapter units that require integration testing
- **Migration blockers** — MISRA violations, ISR reentrance risks, timing constraints

### Stage 3 — Translation

Executes unit-by-unit LLM translation using firmware-specific language pair profiles. Each translation attempt is:
1. **Pre-resolved** — header/SVD dependencies expanded inline
2. **Profile-guided** — system persona + idiom map injected into the prompt
3. **Post-verified** — decisions raised, interface recorded in KB for downstream units

---

## 3. Layer Architecture

### Layer 1 — Deterministic Fingerprint Extractor

**File:** `browser/engine/fingerprint/deterministicExtractor.ts`

Extracts `IRegulatedField[]` and `ILogicalInvariant[]` from source text using **structural pattern matching only** — no LLM. This ensures safety-regulated fields are identified deterministically, regardless of context window.

**Pattern sources:** `common/legacyPatternRegistry.ts`
- Embedded C: `EMBEDDED_C_FIELD_PATTERNS`, `EMBEDDED_C_STRUCTURAL_PATTERNS`
- MISRA-C: `MISRA_C_STRUCTURAL_PATTERNS` (mandatory rule violations)
- C++/AUTOSAR: `CPP_EMBEDDED_STRUCTURAL_PATTERNS`
- IEC 61131-3: `IEC61131_STRUCTURAL_PATTERNS`, `IEC61131_FIELD_PATTERNS`
- Assembly: `ASSEMBLY_EMBEDDED_STRUCTURAL_PATTERNS`

**Invariant types emitted:**
- `rounding_behaviour` — packed decimal / fixed-point precision
- `decimal_precision` — register-width precision loss risk
- `transaction_atomicity` — RTOS critical section boundaries
- `paragraph_logic_preservation` — ISR / safety FB logic preservation

---

### Layer 2 — Discovery Engine

**Directory:** `browser/engine/discovery/`

#### Language Detector (`languageDetector.ts`)
Maps file extensions to canonical language keys. Supports `.c`, `.cpp`, `.h`, `.hpp`, `.s`, `.asm`, `.st`, `.ld`, `.svd`, `.dbc`.

#### Unit Decomposer (`unitDecomposer.ts`)
Extracts `IDecomposedUnit[]` from each file. Four firmware-specific decomposers:

| Decomposer | Unit types emitted |
|---|---|
| `decomposeEmbeddedC` | `function` · `isr` · `rtos-task` · `hal-driver` |
| `decomposeEmbeddedCpp` | `class` · `function` · `rtos-task` |
| `decomposeAssembly` | `function` · `isr` · `linker-section` |
| `decomposeIEC61131` | `program` · `function-block` · `function` |

#### Regulated Data Scanner (`regulatedDataScanner.ts`)
Scans each source line for **10 safety-critical + 10 PII patterns**:

| Category | Patterns |
|---|---|
| Safety / MISRA-C | `peripheral-register` · `raw-mmio-cast` · `isr-definition` · `watchdog-refresh` · `dynamic-allocation` |
| IEC 62443 / OT Security | `safety-function-block` · `hardcoded-ip` · `api-key` · `private-key` · `connection-string` |
| Hybrid / PII (legacy) | `ssn` · `credit-card` · `iban` · `email` · `ip-address` etc. |

Every hit is mapped to its applicable regulatory framework via `PATTERN_TAGS`.

---

### Layer 3 — Resolution Engine

**Directory:** `browser/engine/resolution/`

Resolves a "pending" unit's external dependencies before sending it to the LLM.

#### Resolution Router (`resolutionRouter.ts`)
Dispatches to the correct inliner by language:

| Language | Inliner |
|---|---|
| `c` · `cpp` · `embedded-c` | `cobolCopybookInliner` → **C Header & SVD Inliner** + C Function Call Resolver |
| `plsql` · `sql` | `plsqlTypeInliner` |
| `java` | `javaInterfaceInliner` |
| `rpg` · `rpgle` | `rpgBindingInliner` |
| `natural` | `naturalDataAreaInliner` |
| (all others) | `genericImportInliner` |

#### C Header & SVD Inliner (`cobolCopybookInliner.ts`)
Recursively expands `#include` directives for project-local headers:
- **System header detection** — CMSIS, FreeRTOS, Zephyr headers are annotated but not expanded
- **SVD register block injection** — injects named register constants from the SVD before the source
- **Cycle guard** — prevents infinite recursion from circular includes
- **Search path strategy** — `Inc/`, `Core/Inc/`, `BSP/`, `Middlewares/`, `Drivers/`

#### C Function Call Resolver (`cobolCallResolver.ts`)
Annotates each unique function call with KB interface comments:
- Skips CMSIS intrinsics (`__disable_irq`, `taskENTER_CRITICAL`, etc.)
- Injects `// ── CALL INTERFACE: funcName ──` blocks with params, risk level, and modern equivalent

---

### Layer 4 — Phase Builder

**File:** `browser/engine/planning/phaseBuilder.ts`

Assigns each unit to a `MigrationPhaseType` and builds `IMigrationPhase` objects:

| Phase | Units assigned |
|---|---|
| `foundation` | Pure utility functions, macros, no peripheral dependencies |
| `bsp` | Clock setup, memory map, startup code, linker sections |
| `schema` | Memory map / data schema setup |
| `core-logic` | Main control loops, state machines, PLC programs |
| `hal-layer` | HAL drivers, RTOS integration, peripheral abstractions |
| `api-layer` | Protocol stacks — Modbus, OPC-UA, CAN, fieldbus adapters |
| `integration` | External system integrations |
| `safety-critical` | SIL-rated functions, PLCopen Safety FBs — **sign-off required** |
| `compliance` | Compliance review gating |
| `cutover` | System init, top-level orchestrators — **migrated last** |

Each phase object includes:
- `hasComplianceGate` — IEC 61508 sign-off required
- `hasValidationGate` — HIL/SIL test evidence required
- `hasAPICompatibilityGate` — protocol adapter verification required
- `blockerCount` — blockers that must clear before phase starts

---

### Layer 5 — Compliance Orderer & Blocker Detector

**Files:** `complianceOrderer.ts` · `migrationBlockerDetector.ts`

The compliance orderer enforces that:
1. `safety-critical` units never precede their dependencies
2. Units with blocking GRC violations are held until resolved
3. ISR and watchdog units are grouped and reviewed as a safety cluster

The blocker detector surfaces 19 blocker types, including firmware-specific:

| Blocker | Trigger |
|---|---|
| `unsafe-pointer-arithmetic` | Raw MMIO cast without HAL abstraction |
| `isr-reentrance-risk` | ISR accesses shared data without critical section |
| `misra-c-critical-violation` | MISRA-C:2012 mandatory rule violation |
| `hardware-dependency` | Logic tightly coupled to MCU register with no HAL |
| `watchdog-gap` | Long function missing watchdog refresh |
| `timing-constraint` | Hard real-time deadline at risk post-migration |
| `plc-vendor-extension` | Vendor PLC instruction with no IEC 61131-3 equivalent |
| `safety-integrity-level` | SIL-rated function requiring formal verification |

---

### Layer 6 — Translation Engine

**Directory:** `browser/engine/translation/`

#### Language Pair Registry (`languagePairRegistry.ts`)

12 firmware/industrial profile entries. Each provides a `systemPersona`, `idiomMap` (20–35 construct mappings), `conventionNotes`, `warningPatterns`, and `targetFramework`.

| Source | Target | Profile ID |
|---|---|---|
| Bare-metal C | FreeRTOS C | `bare-metal-c-to-freertos` |
| Bare-metal C | Zephyr RTOS C | `bare-metal-c-to-zephyr` |
| Embedded C | MISRA-C++ / AUTOSAR | `embedded-c-to-misra-cpp` |
| ARM/AVR Assembly | Embedded C (HAL) | `assembly-to-embedded-c` |
| IEC 61131-3 Ladder | Structured Text | `ladder-to-structured-text` |
| Register-direct C (STM32) | STM32 HAL C | `stm32-register-to-hal` |
| Register-direct C (NXP) | NXP SDK C | `nxp-register-to-sdk` |
| FreeRTOS C | Zephyr RTOS C | `freertos-to-zephyr` |
| AUTOSAR Classic SWC | AUTOSAR Adaptive (ARA) | `autosar-classic-to-adaptive` |
| PLC / Ladder | Linux-RT IPC C/C++ | `plc-to-linux-rt` |
| Modbus RTU/TCP C | OPC-UA C++ | `modbus-to-opcua` |
| (Generic firmware) | Any embedded target | `generic-firmware-fallback` |

#### MCP Agent Tools (`agentTools/mcpToolDefinitions.ts`)

7 firmware-specific tools exposed to the AI agent:

| Tool | Purpose |
|---|---|
| `parse_svd_file` | Parse CMSIS SVD → peripheral register map |
| `check_misra_rules` | Static MISRA-C:2012 rule check on a code snippet |
| `analyse_rtos_tasks` | Detect task stack sizes, priorities, and blocking patterns |
| `map_hal_functions` | Map bare-metal register ops to HAL API equivalents |
| `parse_plc_ladder` | Parse Ladder Logic rungs into structured representation |
| `analyse_can_dbc` | Parse CAN DBC signal definitions for protocol migration |
| `check_watchdog_coverage` | Identify functions missing watchdog refresh calls |

---

## 4. Data Flow

```
Source Files (.c/.cpp/.s/.st/.ld)
        │
        ▼
  Language Detector ──► Unit Decomposer ──► Regulated Data Scanner
                                │
                         IMigrationUnit[]
                                │
                         Dependency Graph
                         + Call Graph
                                │
                    ┌───────────┴────────────┐
                    │  Stage 2: Roadmap       │
                    │  Phase Builder          │
                    │  Compliance Orderer     │
                    │  Blocker Detector       │
                    │  CPM Critical Path      │
                    └───────────┬────────────┘
                                │
                         IMigrationRoadmap
                                │
                    ┌───────────┴────────────┐
                    │  Stage 3: Translation   │
                    │  Resolution Router      │
                    │    └─ Header Inliner    │
                    │    └─ SVD Injector      │
                    │    └─ Call Resolver     │
                    │  Language Pair Profile  │
                    │  LLM Translation Loop   │
                    │  Translation Recorder   │
                    └───────────┬────────────┘
                                │
                  Translated Output + KB Interface
```

---

## 5. Safety-First Design Principles

1. **Deterministic pattern matching** for regulated fields (no LLM inference for MMIO / ISR detection)
2. **Compliance gating** — `safety-critical` phase units require IEC 61508 sign-off before Stage 3
3. **HIL/SIL gate** — `hal-layer` and `safety-critical` phases require hardware-in-the-loop test evidence
4. **Blocker-first** — units with `unsafe-pointer-arithmetic` or `isr-reentrance-risk` blockers cannot be approved until the blocker is resolved
5. **Interface preservation** — every translated unit records its public interface in the KB for downstream call-site resolution
6. **No dynamic allocation** — `dynamic-allocation` hits are flagged and blocked per MISRA-C Rule 21.3
7. **Watchdog continuity** — `watchdog-gap` blockers prevent translation of functions that break watchdog refresh timing

---

## 6. File Structure

```
neuralInverseModernisation/
├── browser/
│   ├── engine/
│   │   ├── discovery/
│   │   │   ├── discoveryTypes.ts          # All Stage 1 types (RegulatedDataPattern, etc.)
│   │   │   ├── languageDetector.ts        # Extension → language key
│   │   │   ├── unitDecomposer.ts          # Firmware & IEC 61131-3 decomposers
│   │   │   └── regulatedDataScanner.ts    # Safety-critical pattern scanner
│   │   ├── fingerprint/
│   │   │   └── deterministicExtractor.ts  # Layer 1 structural fingerprint
│   │   ├── planning/
│   │   │   ├── phaseBuilder.ts            # Phase assignment + IMigrationPhase construction
│   │   │   ├── complianceOrderer.ts       # IEC 61508 ordering constraints
│   │   │   ├── migrationBlockerDetector.ts # 19-type blocker catalogue
│   │   │   └── roadmapBuilder.ts          # Full IMigrationRoadmap orchestrator
│   │   ├── resolution/
│   │   │   ├── resolutionRouter.ts        # Language dispatch (C/C++ → header inliner)
│   │   │   └── impl/
│   │   │       ├── cobolCopybookInliner.ts # C Header & SVD Inliner
│   │   │       └── cobolCallResolver.ts    # C Function Call Resolver
│   │   ├── translation/
│   │   │   └── impl/
│   │   │       ├── languagePairRegistry.ts # 12 firmware profiles
│   │   │       └── translationRecorder.ts  # KB write-back + interface extraction
│   │   └── agentTools/
│   │       └── mcpToolDefinitions.ts      # 7 firmware MCP tools
│   └── modernisationSessionService.ts     # MIGRATION_PATTERN_PRESETS (firmware presets)
└── common/
    ├── modernisationTypes.ts              # IMigrationPhase, MigrationPhaseType, etc.
    └── legacyPatternRegistry.ts           # Firmware structural patterns (LEGACY_PATTERN_REGISTRY)
```
