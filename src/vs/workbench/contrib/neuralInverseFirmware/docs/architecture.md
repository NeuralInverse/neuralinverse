# neuralInverseFirmware — Architecture

## Overview

neuralInverseFirmware is a dedicated enterprise environment for AI-native firmware and embedded software development. It provides hardware-aware AI coding tools by injecting MCU specifications, register maps, timing constraints, and compliance rules into the system prompts of Void sidebar chat and Power Mode terminal.

## Design Principle

**The Firmware Environment does NOT replace Void or Power Mode for coding.** It provides a dedicated auxiliary window for firmware session management and hardware-specific UI (datasheet browser, register map explorer, serial monitor). The actual AI-assisted coding happens through the existing Void chat and Power Mode — firmware context is injected transparently.

## Context Injection Flow

```
neuralInverseFirmware session active
    │
    ├─→ convertToLLMMessageService._buildFirmwareContext()
    │     └─→ _getCombinedAIInstructions()   → Void sidebar chat system prompt
    │
    └─→ Power Mode systemPrompt.ts
          └─→ <firmware_session> XML block   → Power Mode terminal system prompt
```

## Module Structure

```
neuralInverseFirmware/
├── common/
│   └── firmwareTypes.ts                   ← Core types (MCU, registers, datasheets, errata)
├── browser/
│   ├── neuralInverseFirmware.contribution.ts  ← Workbench contribution + Cmd+Alt+F
│   ├── firmwareSessionService.ts              ← Session state management
│   ├── voidFirmwareToolsContrib.ts            ← Registers fw_* tools with Void
│   ├── engine/
│   │   ├── hardwareContext/
│   │   │   └── hardwareContextProvider.ts     ← Builds system prompt context block
│   │   ├── svd/
│   │   │   ├── svdTypes.ts                    ← ARM CMSIS SVD type definitions
│   │   │   └── svdParserService.ts            ← SVD XML → register maps
│   │   └── agentTools/
│   │       └── firmwareAgentToolService.ts     ← 15 fw_* agent tools
│   ├── ui/
│   │   └── firmwarePart.ts                    ← Auxiliary window Part
│   └── statusbar/
│       └── firmwareStatus.contribution.ts     ← Status bar entry
└── docs/
    └── architecture.md                        ← This file
```

## Agent Tools (fw_* prefix)

| Tool | Category | Description |
|---|---|---|
| fw_get_mcu_info | MCU | MCU specs and memory map |
| fw_list_peripherals | MCU | List all loaded peripherals |
| fw_get_register_map | Registers | Full register map for a peripheral |
| fw_get_peripheral_config | Registers | Configuration registers and options |
| fw_get_bit_field_info | Registers | Detailed bit field info for a register |
| fw_get_errata | Errata | Silicon errata / known hardware bugs |
| fw_check_silicon_bug | Errata | Check if a bug affects current code |
| fw_get_timing_constraints | Timing | Timing constraints from datasheets |
| fw_get_clock_config | Timing | Clock tree / RCC configuration |
| fw_upload_datasheet | Datasheets | Parse a PDF datasheet |
| fw_query_datasheet | Datasheets | Natural language datasheet query |
| fw_get_datasheet_citations | Datasheets | Page-level datasheet citations |
| fw_misra_check | Compliance | MISRA C:2012 compliance check |
| fw_cert_c_check | Compliance | CERT C compliance check |
| fw_safety_audit | Compliance | IEC 62304 / ISO 26262 / DO-178C audit |

## Keybinding

`Cmd+Alt+F` — Open Firmware Environment (alongside `Cmd+Alt+M` for Modernisation, `Cmd+Alt+A` for Agent Manager)

## Dependencies

- `convertToLLMMessageService` — for context injection into Void chat
- `powerMode/systemPrompt` — for context injection into Power Mode
- `voidInternalToolService` — for agent tool registration
- No dependencies on `neuralInverseModernisation` — completely independent module
