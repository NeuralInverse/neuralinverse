# Neural Inverse Modernisation — Product Vision

> **Mission**: The world's most capable safety-critical firmware modernisation engine,  
> embedded inside a developer IDE with zero cloud dependency.

---

## 1. The Problem

Embedded firmware and industrial control code age faster than the hardware it runs on. Across defence, automotive, medical devices, and industrial automation, there are hundreds of millions of lines of:

- **Bare-metal C** written for MCUs that are end-of-life, with hand-crafted register manipulation instead of HAL abstraction
- **Legacy RTOS code** (FreeRTOS 9, VxWorks, INTEGRITY) that predates modern RTOS APIs, device trees, and power management frameworks
- **IEC 61131-3 Ladder Logic** in PLCs that need to migrate to Structured Text, Linux-RT, or cloud-edge applications — but carry SIL 1–3 safety ratings that make any change legally and technically fraught
- **AUTOSAR Classic Software Components** that need to move to AUTOSAR Adaptive (ARA) for next-generation vehicle platforms

These migrations carry enormous risk. A missed watchdog refresh or an incorrect MMIO cast can result in field failures, safety incidents, or regulatory non-compliance. **The cost of getting it wrong is not a bug — it is a product recall, a civil penalty, or a person harmed.**

Yet the tools available are:
- Generic LLM assistants with no firmware context and no compliance awareness
- Static analysis tools that find problems but cannot fix them
- Manual refactoring teams that spend months per system

**Neural Inverse fills the gap**: a deterministic, compliance-gated, agentic firmware modernisation engine that understands hardware registers, RTOS scheduling semantics, and functional safety standards.

---

## 2. Target Users

| Persona | Pain | What Neural Inverse provides |
|---|---|---|
| **Embedded Software Engineer** | Spending weeks manually porting bare-metal code to RTOS | Automated register-to-HAL mapping, RTOS task scaffolding, idiom translation |
| **Safety Engineer / Assessor** | No tooling to track which units are SIL-rated and whether their safety invariants are preserved | Compliance fingerprinting, SIL gate enforcement, audit-ready translation evidence |
| **Firmware Architect** | No visibility into circular dependencies, timing risks, or watchdog gaps before migration starts | CPM roadmap, blocker detection, phase ordering with compliance gates |
| **PLC / OT Engineer** | Legacy Ladder Logic running on obsolete PLCs with no modern equivalent | Ladder → Structured Text + Linux-RT migration profiles |
| **AUTOSAR Platform Team** | AUTOSAR Classic SWC migration to Adaptive taking 3–5 years manually | Automated SWC decomposition, ARA interface mapping, RTE call resolution |

---

## 3. Core Principles

### 3.1 Safety-First, Not Productivity-First

Most AI coding tools optimise for developer velocity. Neural Inverse optimises for **correctness in a safety-critical context**. This means:

- **Deterministic pattern matching** for regulated fields — MMIO addresses, ISR definitions, watchdog calls are never inferred by the LLM; they are detected by structural regex patterns matched against MISRA-C and IEC 61508 structural indicators
- **Compliance gating** — units in the `safety-critical` phase require a human safety engineer sign-off before any Stage 3 translation can begin
- **HIL/SIL gate** — the `hal-layer` and `safety-critical` phases require hardware-in-the-loop or software-in-the-loop test evidence before approval
- **Blocker-first planning** — a unit with an `isr-reentrance-risk` or `unsafe-pointer-arithmetic` blocker cannot be approved until the blocker is explicitly resolved or waived with documented rationale

### 3.2 Context-Complete Translation

The LLM never sees a unit in isolation. Before any translation:

1. All `#include` dependencies are expanded inline (C Header & SVD Inliner)
2. SVD peripheral register definitions are injected as named constants (no raw hex)
3. Every called function with a KB entry has its interface annotated as a comment in the source
4. The RTOS task topology, stack sizes, and priority structure are pre-analysed by the `analyse_rtos_tasks` MCP tool

This produces **context-complete source** — the LLM sees the same view a veteran embedded engineer would have after reading the full BSP and RTOS documentation.

### 3.3 BYOLLM — No Cloud Dependency

Neural Inverse runs entirely local. The session service connects to any LLM endpoint (Ollama, Anthropic, OpenAI, Azure OpenAI, local models) via the BYOLLM infrastructure. This is essential for:

- **Defence and government** — code cannot leave air-gapped environments
- **Automotive** — IP protection requirements prevent cloud-based code analysis
- **Medical devices** — HIPAA / MDR require control over where patient-adjacent code is processed

---

## 4. Competitive Positioning

### vs. Embedder.com

| Capability | Embedder.com | Neural Inverse |
|---|---|---|
| LLM integration | Cloud-hosted proprietary LLM | BYOLLM — any model, any endpoint |
| MISRA-C compliance | Static checker integration | Deterministic scanner + blocker-gated planning |
| IEC 61508 support | None documented | Native SIL gating, compliance orderer, safety invariant fingerprinting |
| SVD / register map | Manual context | Auto-parsed SVD injected as named constants |
| RTOS migration | Manual | FreeRTOS→Zephyr, bare-metal→FreeRTOS idiom maps |
| PLC migration | None | Ladder→ST, PLC→Linux-RT profiles |
| AUTOSAR | None | Classic→Adaptive SWC migration profile |
| IDE integration | Web app | Embedded in Neural Inverse IDE (VS Code fork) |
| Air-gap support | No | Yes — fully local |
| CAN / DBC | None | `analyse_can_dbc` MCP tool |
| Roadmap planning | None | CPM critical path, phase ordering, blocker detection |

### vs. Manual Migration Teams

- **Speed**: Days per unit vs. weeks per subsystem
- **Consistency**: Same idiom map applied to every function — no engineer-to-engineer variation
- **Traceability**: Every translation decision recorded in the KB with rationale, for IEC 61508 / ISO 26262 audit packages
- **Risk visibility**: Roadmap surfaces all blockers, timing constraints, and circular dependencies before the first line of code is changed

---

## 5. The 12 Migration Profiles

Neural Inverse ships 12 pre-built migration profiles covering the most common industry transitions:

| # | Migration | Industry |
|---|---|---|
| 1 | Bare-metal C → FreeRTOS | Embedded / IoT |
| 2 | Bare-metal C → Zephyr RTOS | Embedded / IoT |
| 3 | Embedded C → MISRA-C++ / AUTOSAR | Automotive / Medical |
| 4 | ARM/AVR Assembly → Embedded C (HAL) | Legacy firmware |
| 5 | IEC 61131-3 Ladder → Structured Text | Industrial / PLC |
| 6 | Register-direct C (STM32) → STM32 HAL | STM32 ecosystem |
| 7 | Register-direct C (NXP) → NXP SDK | NXP ecosystem |
| 8 | FreeRTOS → Zephyr RTOS | RTOS platform migration |
| 9 | AUTOSAR Classic SWC → Adaptive (ARA) | Automotive |
| 10 | PLC / Ladder → Linux-RT IPC | OT/IT convergence |
| 11 | Modbus RTU/TCP → OPC-UA | Industry 4.0 / IIoT |
| 12 | Generic firmware fallback | Any embedded target |

Each profile contains **20–35 idiom mappings**, a system persona (expert role injected into the LLM system prompt), convention notes, warning patterns, and a target framework recommendation.

---

## 6. Safety Compliance Architecture

### IEC 61508 (Functional Safety)

- All `isr-definition`, `watchdog-refresh`, and `safety-function-block` patterns are flagged and tracked
- `safety-critical` phase units require explicit IEC 61508 safety approval before Stage 3
- Logical invariants (`rounding_behaviour`, `transaction_atomicity`) are recorded in every unit's compliance fingerprint
- HIL/SIL test evidence is a mandatory gate for the `hal-layer` and `safety-critical` phases

### MISRA-C:2012

- Mandatory rule violations are detected deterministically by `MISRA_C_STRUCTURAL_PATTERNS`
- `misra-c-critical-violation` blockers halt translation until the violation is resolved in the source
- `dynamic-allocation` (malloc/free — MISRA Rule 21.3) and `raw-mmio-cast` (Rule 11.4) are blocking patterns

### IEC 62443 (Industrial Cybersecurity)

- Hardcoded IP addresses, OT connection strings, and API keys in PLC / SCADA code are scanned
- `hardcoded-ip` and `connection-string` hits are flagged as `IEC 62443` applicable
- Credential externalisation is a mandatory blocker resolution step before migration

### IEC 61131-3 (PLC Programming)

- PLCopen Safety FB calls (`SF_EmergencyStop`, `SF_SafelyLimitedSpeed`) are detected as `safety-function-block` regulated hits
- Vendor-specific PLC instructions trigger `plc-vendor-extension` blockers
- Ladder Logic decomposer extracts PROGRAM, FUNCTION_BLOCK, and FUNCTION units for independent migration

---

## 7. Roadmap

### Now (v2.0 — Firmware Edition)
- ✅ 12 language pair profiles
- ✅ 7 firmware MCP agent tools (SVD parser, MISRA checker, RTOS analyser, HAL mapper, CAN DBC parser, watchdog coverage, PLC ladder parser)
- ✅ C Header & SVD Inliner (resolution layer)
- ✅ C Function Call Resolver (resolution layer)
- ✅ Firmware-specific unit decomposers (ISR/RTOS-task/HAL-driver typed)
- ✅ Safety-critical regulated data scanner (10 firmware + 10 PII patterns)
- ✅ IEC 61508 / IEC 62443 compliance gating

### Next (v2.1)
- 🔲 PDF Datasheet Intelligence — parse MCU/SoC datasheets and inject peripheral specs into the translation context
- 🔲 HIL/SIL verification pipeline — automated test case generation and pass/fail evidence collection
- 🔲 AUTOSAR XML parser — extract SWC port interfaces and runnable scheduling from AUTOSAR XML
- 🔲 Zephyr device tree binding generator — auto-generate `.overlay` files from SVD peripheral maps
- 🔲 CAN signal → ROS 2 topic mapper — for automotive/robotics OT/IT convergence

### Future (v3.0)
- 🔲 Formal verification integration (Frama-C / CBMC) for SIL 3–4 units
- 🔲 ISO 26262 ASIL decomposition planner
- 🔲 Multi-MCU topology migration (single MCU → distributed multi-core / hypervisor)
- 🔲 AI-assisted FMEA (Failure Mode and Effects Analysis) generation from migration diff
