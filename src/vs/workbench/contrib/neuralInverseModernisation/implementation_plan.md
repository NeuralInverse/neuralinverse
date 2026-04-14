# Neural Inverse Modernisation — Firmware & Industrial Refocus

## Background

The current Neural Inverse Modernisation platform is built primarily for **financial mainframe legacy migration** (COBOL, PL/SQL, RPG, NATURAL, VB6, etc.). The goal of this refactor is to **remove the COBOL / financial legacy domain** and rebuild the platform around two new first-class domains:

1. **Firmware Modernisation** — Embedded C/C++, bare-metal → RTOS, HAL abstraction, MISRA compliance, MCU toolchain migration, SVD-driven register modernisation.
2. **Industrial Modernisation** — PLC ladder logic / IEC 61131-3, SCADA/HMI, OT/IT convergence, protocol migration (Modbus → MQTT/OPC-UA), and safety-critical (IEC 62443, IEC 61508) workflows.

---

## User Review Required

> [!IMPORTANT]  
> **Scope of removal**: All COBOL-specific types, patterns, language pairs, and migration presets will be deleted. This includes `COBOL_FIELD_PATTERNS`, `COBOL_STRUCTURAL_PATTERNS`, `COBOL → Java/TypeScript/Python/Go` language pair profiles, and every `cobol-*` migration preset in the session service. If you want any of these preserved, please confirm before proceeding.

> [!WARNING]  
> **Breaking change**: The `UnitType` union, `MigrationUnitType` union, and `legacyPatternRegistry` all have COBOL-specific literals embedded in their types. Removing them may break any saved serialised session data that references those literal values. A schema version bump and a migration guard will be added to handle this gracefully at runtime.

> [!CAUTION]  
> **`languagePairRegistry.ts` is 1,391 lines** — it is the largest file in the module. Most of the file is COBOL-specific pair profiles. This file will be effectively **rebuilt from scratch** with firmware/industrial profiles in its place.

---

## Estimated Time

| Work item | Estimated effort |
|---|---|
| Scoping & design (this plan) | ✅ Done |
| `modernisationTypes.ts` — UnitType / MigrationUnitType cleanup | ~30 min |
| `knowledgeBaseTypes.ts` — domain-neutral terminology review | ~20 min |
| `legacyPatternRegistry.ts` — full replacement with firmware/industrial patterns | ~2 hr |
| `modernisationSessionService.ts` — replace MIGRATION_PATTERN_PRESETS | ~45 min |
| `languagePairRegistry.ts` — full replacement with firmware/industrial profiles | ~3 hr |
| `discoveryService.ts` / `languageDetector.ts` — add firmware/industrial language detection | ~1 hr |
| `migrationEffortEstimator.ts` — recalibrate effort scoring for firmware units | ~45 min |
| `unitDecomposer.ts` — add firmware/industrial unit decomposer rules | ~1 hr |
| `complianceOrderer.ts` / `phaseBuilder.ts` — add IEC 61508 / IEC 62443 phases | ~1 hr |
| `regulatedDataScanner.ts` — replace financial GRC with safety-critical scan patterns | ~45 min |
| `mcpToolDefinitions.ts` — add firmware agent tools (SVD parse, MISRA check, etc.) | ~1.5 hr |
| Docs update (`ARCHITECTURE.md`, `PRODUCT_VISION.md`) | ~30 min |
| **Total** | **≈ 13–15 hours of focused work** |

---

## Proposed Changes

### 1. Core Types (`common/`)

#### [MODIFY] [modernisationTypes.ts](file:///Users/sanjaysenthilkumar/Documents/IDE/void/src/vs/workbench/contrib/neuralInverseModernisation/common/modernisationTypes.ts)

- **`MigrationUnitType`** — Remove `'paragraph'`, `'section'`, `'program'` (COBOL-specific). Add: `'function-block'` (IEC 61131), `'ladder-rung'`, `'hal-driver'`, `'isr'` (interrupt service routine), `'rtos-task'`, `'device-driver'`, `'register-map'`.
- **`IModernisationProjectFile`** example comment** — Replace the `ACME-COBOL` example with a firmware project example.
- **`IMigrationPhase.phaseType`** — Replace `'schema'` (DB schema, no meaning in firmware) with `'bsp'` (board support package layer). Replace `'api-layer'` with `'hal-layer'`. Add `'safety-critical'` phase type for IEC 61508 SIL-rated units.
- **`MigrationBlockerType`** — Add: `'unsafe-pointer-arithmetic'`, `'isr-reentrance-risk'`, `'misra-c-critical-violation'`, `'hardware-dependency'`, `'no-hal-equivalent'`. Remove `'goto-usage'` only where it conflicts (GOTO is also relevant in C; keep generic description).

#### [MODIFY] [knowledgeBaseTypes.ts](file:///Users/sanjaysenthilkumar/Documents/IDE/void/src/vs/workbench/contrib/neuralInverseModernisation/common/knowledgeBaseTypes.ts)

- **`UnitType`** — Remove `'paragraph'`, `'copybook'`, `'jcl-step'` (COBOL-only). Add: `'function-block'`, `'ladder-rung'`, `'structured-text-function'`, `'isr'`, `'rtos-task'`, `'hal-driver'`, `'device-driver'`, `'register-map'`, `'safety-function'`.
- **`IRegulatedField.framework`** — Insurance that `'iec-61508'`, `'iec-62443'`, `'misra-c'`, `'autosar'` are accepted as framework strings (currently it's an open `string`, so no type change needed — just update comments and examples).
- **Comment/JSDoc updates** — Remove COBOL-specific examples from JSDoc. Replace with firmware-domain examples (e.g. `CALC-LATE-FEE` → `HAL_UART_Init`, `CUSTMAST` → `DEVICE_REG_MAP`).

#### [MODIFY] [legacyPatternRegistry.ts](file:///Users/sanjaysenthilkumar/Documents/IDE/void/src/vs/workbench/contrib/neuralInverseModernisation/common/legacyPatternRegistry.ts)

This file is **entirely rebuilt**. Remove all 7 existing language sections (COBOL, Java EE, PL/SQL, Python 2, RPG, NATURAL, VB6). Replace with:

**New language sections:**
- **Embedded C (bare-metal)** — Patterns for `volatile` memory-mapped registers, `#pragma` ISR declarations, HAL function names (`HAL_*`, `BSP_*`), unsafe casts (`(uint32_t*)(0x40000000)`), `__disable_irq()`, watchdog patterns.
- **C++ (embedded/MISRA)** — RTOS API calls (`osThreadNew`, `xTaskCreate`, `osMutexAcquire`), dynamic allocation violations (`new`/`delete` in MISRA C++ scope), `reinterpret_cast` flagging.
- **IEC 61131-3 (Ladder/ST/FBD)** — Coils, contacts, function block calls (`FB_MotorControl`), timer/counter instances (`TON`, `CTU`), safety function calls (`SF_EmergencyStop`).
- **MISRA C violation patterns** — Structural patterns detecting rule violations: unbounded recursion, variable-width integer types, missing `default` in switch, non-boolean conditions in `if`.

---

### 2. Session Service — Migration Presets

#### [MODIFY] [modernisationSessionService.ts](file:///Users/sanjaysenthilkumar/Documents/IDE/void/src/vs/workbench/contrib/neuralInverseModernisation/browser/modernisationSessionService.ts)

Replace the `MIGRATION_PATTERN_PRESETS` array entirely. Remove all COBOL, mainframe, database, and web framework categories. Replace with:

**New categories and presets:**

| Category | Preset ID | Label |
|---|---|---|
| **Firmware Modernisation** | `bare-metal-to-rtos` | Bare-metal → RTOS |
| | `hal-abstraction` | Add HAL Abstraction Layer |
| | `c-to-cpp-embedded` | Embedded C → C++ (MISRA) |
| | `mcu-migration` | MCU Platform Migration |
| | `legacy-bsp-modernisation` | Legacy BSP Modernisation |
| | `register-map-migration` | Register Map (SVD) Migration |
| | `isr-refactor` | ISR Architecture Refactor |
| **Industrial & OT** | `plc-to-ipc` | PLC → IPC (Industrial PC) |
| | `ladder-to-structured-text` | Ladder Logic → Structured Text |
| | `modbus-to-opcua` | Modbus → OPC-UA |
| | `scada-modernisation` | SCADA/HMI Modernisation |
| | `ot-it-convergence` | OT/IT Convergence |
| | `iec61131-harmonisation` | IEC 61131-3 Harmonisation |
| **Safety & Compliance** | `sil-uplift` | SIL Uplift (IEC 61508) |
| | `misra-c-remediation` | MISRA-C Remediation |
| | `autosar-migration` | AUTOSAR Classic → Adaptive |
| | `functional-safety-audit` | Functional Safety Audit |
| **Architecture** | `monolith-firmware-modular` | Monolithic Firmware → Modular |
| | `custom` | Custom |

---

### 3. Translation Engine — Language Pair Registry

#### [MODIFY] [languagePairRegistry.ts](file:///Users/sanjaysenthilkumar/Documents/IDE/void/src/vs/workbench/contrib/neuralInverseModernisation/browser/engine/translation/impl/languagePairRegistry.ts)

**Remove all 22+ existing profiles** (COBOL→Java, COBOL→TypeScript, PL/SQL→TypeScript, etc.).

**Add new firmware/industrial profiles:**

| Profile | Source → Target | Key focus |
|---|---|---|
| `BARE_METAL_C_TO_RTOS_C` | Embedded C → RTOS C (FreeRTOS/Zephyr) | Task creation, mutex/semaphore, HAL init |
| `EMBEDDED_C_TO_CPP` | Embedded C → C++ (MISRA C++) | Class-based HAL, RAII, no dynamic alloc |
| `LADDER_TO_ST` | IEC 61131-3 Ladder → Structured Text | Contacts/coils → IF/WHILE, FB calls |
| `LEGACY_C_TO_HAL_C` | Bare-metal C (register-direct) → HAL C (STM32/NXP HAL) | `*(uint32_t*)0x...` → `HAL_*()` |
| `CLASSIC_BSP_TO_ZEPHYR` | Legacy BSP → Zephyr RTOS | Device tree bindings, DT API |
| `MODBUS_RTU_TO_OPCUA` | Modbus RTU polling → OPC-UA (open62541) | Tag → Node mapping, subscription |
| `AUTOSAR_CLASSIC_TO_ADAPTIVE` | AUTOSAR Classic (COM/RTE) → AUTOSAR Adaptive (ARA) | SWC → executables, SOME/IP |
| `MISRA_C_REMEDIATION` | Non-compliant C → MISRA-C:2012 | Rule-by-rule idiom corrections |
| `ASSEMBLY_TO_C_EMBEDDED` | ARM/AVR Assembly → Embedded C | Register ops → HAL, ISR to C handlers |
| `GENERIC_FIRMWARE` | Any → Any (fallback) | Generic persona and idiom notes |

Each profile will include:
- **systemPersona** — expert embedded/industrial engineer persona
- **idiomMap** — 15–30 construct-level mappings
- **conventionNotes** — MISRA, AUTOSAR, or IEC 61131 conventions
- **warningPatterns** — hardware-dependency patterns, ISR safety, watchdog, timing constraints

---

### 4. Discovery Engine

#### [MODIFY] [languageDetector.ts](file:///Users/sanjaysenthilkumar/Documents/IDE/void/src/vs/workbench/contrib/neuralInverseModernisation/browser/engine/discovery/languageDetector.ts)

- Add detection for: `.c`, `.h` (embedded heuristics — `volatile`, `__attribute__`, `#include "stm32*"`), `.cpp` (MISRA), `.ld` (linker scripts), `.st` / `.il` (IEC 61131-3 Structured Text / Instruction List), `.ldr` (Ladder Logic), `.aml`/`.svd` (CMSIS SVD), `.dbc` (CAN database), `.arxml` (AUTOSAR).
- Remove special COBOL file detection (`.cbl`, `.cob`, `.cpy`, `.jcl`).

#### [MODIFY] [unitDecomposer.ts](file:///Users/sanjaysenthilkumar/Documents/IDE/void/src/vs/workbench/contrib/neuralInverseModernisation/browser/engine/discovery/unitDecomposer.ts)

- Add decomposition rules for: C functions (by `{}`-depth), IEC 61131-3 function blocks, RTOS task bodies, ISR handlers (`void *_IRQHandler(void)`).
- Remove COBOL paragraph/section decomposition rules.

#### [MODIFY] [regulatedDataScanner.ts](file:///Users/sanjaysenthilkumar/Documents/IDE/void/src/vs/workbench/contrib/neuralInverseModernisation/browser/engine/discovery/regulatedDataScanner.ts)

- Remove financial GRC patterns (PCI-DSS, SOX account balance fields).
- Add safety-critical patterns: SIL-rated variables (`_SIL2`, `safety_`), memory-mapped peripheral access (`volatile uint32_t*`), watchdog timers, IEC 61508 diagnostic patterns, AUTOSAR diagnostic event managers.

---

### 5. Planning Engine

#### [MODIFY] [phaseBuilder.ts](file:///Users/sanjaysenthilkumar/Documents/IDE/void/src/vs/workbench/contrib/neuralInverseModernisation/browser/engine/planning/phaseBuilder.ts)

- Replace `MigrationPhaseType` references (`schema`, `api-layer`) with firmware equivalents (`bsp`, `hal-layer`, `safety-critical`).
- Add new phase ordering: BSP/HAL first, then drivers, then middleware, then application, then safety-critical units last (with sign-off gate).

#### [MODIFY] [complianceOrderer.ts](file:///Users/sanjaysenthilkumar/Documents/IDE/void/src/vs/workbench/contrib/neuralInverseModernisation/browser/engine/planning/complianceOrderer.ts)

- Replace financial compliance frameworks (SOX, PCI-DSS) with safety-critical frameworks: IEC 61508 (functional safety), IEC 62443 (industrial cybersecurity), MISRA C:2012, AUTOSAR.
- Add ordering rules: SIL-rated units gate on compliance officer sign-off; MISRA-critical violations are blocking.

---

### 6. Agent Tools

#### [MODIFY] [mcpToolDefinitions.ts](file:///Users/sanjaysenthilkumar/Documents/IDE/void/src/vs/workbench/contrib/neuralInverseModernisation/browser/engine/agentTools/mcpToolDefinitions.ts)

- Remove COBOL-specific tools (COBOL copybook expander, JCL job analyser, COMP-3 field detector).
- Add firmware-specific agent tools:
  - `parse_svd_file` — Parse CMSIS SVD register description files into structured register maps.
  - `check_misra_rules` — Run a MISRA C:2012 static analysis summary.
  - `analyse_rtos_tasks` — Detect task starvation, priority inversion risks, and ISR/task boundary violations.
  - `map_hal_functions` — Map bare-metal register-direct function calls to STM32/NXP HAL equivalents.
  - `parse_plc_ladder` — Parse IEC 61131-3 ladder logic into a structured AST.
  - `analyse_can_dbc` — Parse CAN database files to extract signal definitions for migration.
  - `check_watchdog_coverage` — Detect functions that modify hardware state without watchdog refresh.

---

### 7. Docs

#### [MODIFY] [ARCHITECTURE.md](file:///Users/sanjaysenthilkumar/Documents/IDE/void/src/vs/workbench/contrib/neuralInverseModernisation/docs/ARCHITECTURE.md)
#### [MODIFY] [PRODUCT_VISION.md](file:///Users/sanjaysenthilkumar/Documents/IDE/void/src/vs/workbench/contrib/neuralInverseModernisation/docs/PRODUCT_VISION.md)
#### [MODIFY] [MODERNISATION_PLATFORM_PLAN.md](file:///Users/sanjaysenthilkumar/Documents/IDE/void/src/vs/workbench/contrib/neuralInverseModernisation/docs/MODERNISATION_PLATFORM_PLAN.md)

- Update all COBOL/mainframe references to firmware/industrial.
- Update feature tables, platform comparators, and phase plans.

---

## Open Questions

> [!IMPORTANT]
> **Q1 — Keep RPG/Assembler?** The current platform has RPG (IBM i) and x86/z-series Assembler profiles. The Assembler→C profile is relevant to embedded work. Should the `Assembler → Embedded C` profile be **kept and adapted** (not removed)?

> [!IMPORTANT]
> **Q2 — RTOS target?** For the `bare-metal → RTOS` translation profile, which RTOS should be the primary first-class target? Options:  
> - **FreeRTOS** (most common in industrial/MCU)  
> - **Zephyr** (Linux Foundation, growing fast)  
> - **Both** (two separate profiles)

> [!IMPORTANT]
> **Q3 — Compliance frameworks to include?** The existing system supports SOX/PCI-DSS/HIPAA for finance. For the new domain, which of these should be the primary compliance frameworks?  
> - IEC 61508 (functional safety — SIL)  
> - IEC 62443 (industrial cybersecurity)  
> - MISRA C:2012  
> - AUTOSAR (Automotive)  
> - All of the above?

---

## Verification Plan

### Automated
- TypeScript compilation with `tsc --noEmit` after each file change to catch type errors from removed union members.
- Search for any remaining `cobol` / `COBOL` / `mainframe` string literals in `.ts` files after completion.

### Manual
- Open a new Modernisation session in the IDE, confirm the new firmware/industrial pattern categories appear.
- Start a bare-metal C project modernisation session; confirm the `bare-metal-to-rtos` preset and `BARE_METAL_C_TO_RTOS_C` language pair profile resolve correctly.
- Confirm that the compliance gate correctly references IEC 61508 / MISRA frameworks instead of SOX/PCI-DSS.
