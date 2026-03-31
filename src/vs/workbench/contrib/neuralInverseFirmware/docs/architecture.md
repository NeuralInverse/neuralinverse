# neuralInverseFirmware — Architecture

## Overview

neuralInverseFirmware is a dedicated enterprise environment for AI-native firmware and embedded software development. It provides hardware-aware AI coding by injecting MCU specifications, register maps, timing constraints, silicon errata, and compliance rules into the system prompts of Void sidebar chat and Power Mode terminal.

**Design principle**: The Firmware Environment does NOT replace Void or Power Mode for coding. It provides a dedicated auxiliary window (Cmd+Alt+F) for session management and hardware-specific UI. The actual AI-assisted coding happens through Void chat and Power Mode — firmware context is injected transparently into their system prompts when a session is active.

---

## Context Injection Flow

```
neuralInverseFirmware session active
    │
    ├─→ convertToLLMMessageService._buildFirmwareContext()
    │         └─→ _getCombinedAIInstructions()         → Void sidebar chat system prompt
    │
    └─→ Power Mode buildSystemPrompt()
              ├─→ firmwareAgentPrompt                   → replaces generic BUILD_AGENT_PROMPT
              │     └─→ FIRMWARE_AGENT_IDENTITY         → domain identity + ABSOLUTE RULES
              │     └─→ FIRMWARE_TOOL_DISPATCH          → tool → use-case dispatch table
              │     └─→ FIRMWARE_TOOLS_BLOCK            → tool reference with signatures
              │     └─→ FIRMWARE_WORKFLOW_BLOCK         → build-flash-monitor loop
              │     └─→ buildComplianceBlock()          → active framework rules
              │     └─→ buildPlatformBlock()            → STM32/ESP32/nRF/RP2040 tips
              └─→ <firmware_session> XML block          → hardware context data
```

Both surfaces see the same hardware data. Power Mode gets a domain-tuned agent identity on top of it.

---

## Module Structure

```
neuralInverseFirmware/
├── common/
│   ├── firmwareTypes.ts                       ← All shared types (see Types section below)
│   ├── mcuDatabase.ts                         ← 357 MCU entries, e() factory pattern
│   └── bundledSVDs.ts                         ← Bundled SVD XML strings for common MCU families
│
└── browser/
    ├── neuralInverseFirmware.contribution.ts  ← Workbench registration, Cmd+Alt+F, DI side-effect imports
    ├── firmwareSessionService.ts              ← Session state, SVD reload, KB restore, event emitter
    ├── mcuDatabaseService.ts                  ← lookupMCU(), fuzzy search, platform ID detection
    ├── projectDetectorService.ts             ← Auto-detect MCU/build system from platformio.ini, CMakeLists, .ioc, sdkconfig, etc.
    ├── voidFirmwareToolsContrib.ts            ← Registers fw_* tools with IVoidInternalToolService (Void sidebar)
    │
    ├── engine/
    │   ├── agentTools/
    │   │   ├── firmwareAgentToolService.ts    ← IFirmwareAgentToolService DI, getTools() orchestrator
    │   │   ├── debugTools.ts                 ← Phase 1a: 11 GDB debug tools
    │   │   ├── serialTools.ts                ← Phase 1b: 6 serial monitor tools
    │   │   ├── buildAnalysisTools.ts         ← Phase 1c+2: 6 build/binary analysis tools
    │   │   ├── codegenTools.ts               ← Phase 3: 6 SVD-accurate code generation tools
    │   │   ├── peripheralIntelTools.ts       ← Phase 4: 5 peripheral intelligence tools
    │   │   ├── simulationTools.ts            ← Phase 5: 2 QEMU/Renode discovery tools
    │   │   └── complianceTools.ts            ← Phase 6: 3 live GRC compliance tools
    │   │
    │   ├── datasheet/
    │   │   ├── datasheetIntelligenceService.ts ← 3-tier PDF extraction: cache → heuristic → LLM batch
    │   │   ├── datasheetKBService.ts           ← .inverse/hardware-kb/ persistence, content-hash dedup
    │   │   └── svdFetchService.ts             ← GitHub CMSIS-SVD fetch + custom XML parser
    │   │
    │   ├── hardwareContext/
    │   │   └── hardwareContextProvider.ts     ← buildFirmwareContext() for system prompt injection
    │   │
    │   ├── build/
    │   │   └── buildSystemService.ts          ← Build + flash commands, binary size analysis, error parsing
    │   │
    │   ├── serial/
    │   │   └── serialMonitorService.ts        ← Web Serial API, 10k-line ring buffer, debug probe detection
    │   │
    │   ├── debug/
    │   │   └── debugService.ts               ← GDB server integration (OpenOCD/J-Link/pyocd), register/memory reads
    │   │
    │   ├── lsp/
    │   │   ├── firmwareHoverProvider.ts       ← SVD register hover in editor
    │   │   └── firmwareLSPBridge.ts          ← clangd integration bridge
    │   │
    │   ├── skills/
    │   │   └── platformSkills.ts             ← STM32/ESP32/nRF/RP2040 knowledge packs
    │   │
    │   ├── svd/
    │   │   ├── svdParserService.ts            ← Full CMSIS SVD XML parser (local files)
    │   │   └── svdTypes.ts                   ← ISvdResult, ISvdDevice, ISvdPeripheral types
    │   │
    │   └── firmwareSystemPrompt.ts           ← buildFirmwareSystemPrompt() — replaces generic Power Mode prompt
    │
    ├── ui/
    │   └── firmwarePart.ts                   ← Auxiliary window Part (Dashboard/Datasheets/Registers/Serial/Compliance/Build tabs)
    │
    └── statusbar/
        └── firmwareStatus.contribution.ts    ← ⚡ MCU | frameworks | datasheet count in status bar
```

---

## Key Types (`firmwareTypes.ts`)

### Session & MCU

| Type | Description |
|---|---|
| `IFirmwareSessionData` | Main session state: isActive, sessionId, mcuConfig, boardName, svdFiles[], datasheets[], complianceFrameworks[], registerMaps[], timingConstraints[], errata[], rtos, buildSystem, projectInfo, lastBuildResult, lastSerialConfig, debugState, platformId |
| `IMCUConfig` | MCU hardware: family, variant, manufacturer, core (MCUCoreType), clockMHz, flashSize, ramSize, memoryMap[], peripherals[], fpu, hasMPU, hasDSP |
| `MCUCoreType` | cortex-m0/m3/m4/m7/m33/m55/m85, cortex-a/r, risc-v, xtensa, c28x, mips32, tricore, arm7, powerpc, rx, 8051, avr, pic, msp430 |
| `FirmwareComplianceFramework` | misra-c-2012, misra-c-2023, cert-c, iec-62304, iso-26262, do-178c, iec-61508, autosar |

### Register Maps

| Type | Description |
|---|---|
| `IPeripheralRegisterMap` | Peripheral: name, groupName, baseAddress, description, registers[], interrupts[], `source?` (SVD filename or datasheet ID — provenance tracking) |
| `IRegister` | Register: name, addressOffset, size, access (RegisterAccess), resetValue, description, fields[] |
| `IBitField` | Bit field: name, bitOffset, bitWidth, access, description, resetValue, enumeratedValues |
| `RegisterAccess` | read-only, write-only, read-write, write-once, read-write-once |

### Datasheet & Extraction

| Type | Description |
|---|---|
| `IDatasheetInfo` | Metadata: id, fileName, title, mcuFamily, partNumbers[], pageCount, parsedAt, peripheralCount, registerCount, errataCount, svdSource |
| `ITimingConstraint` | peripheral, name, min/typ/maxValue, unit, conditions, datasheetPage |
| `IErrata` | id, title, affectedPeripheral, description, workaround, severity, affectedRevisions[], fixedInRevision, documentPage |
| `ICitation` | datasheetId, pageNumber, sectionTitle, confidence (0–1) |

### Build, Serial & Debug

| Type | Description |
|---|---|
| `IBuildResult` | success, durationMs, outputPath, binarySize, flashUsagePercent, ramUsagePercent, errors[], warnings[] |
| `IBuildDiagnostic` | file, line, column, severity, message, code |
| `ISerialPortConfig` | port, baudRate, dataBits, stopBits, parity, flowControl |
| `ISerialPortInfo` | path, manufacturer, productId, vendorId, isDebugProbe |
| `IDebugSessionState` | isActive, gdbServer, gdbPort, targetDevice, lastCommand, lastResponse |
| `FirmwareProjectType` | firmware-inverse, stm32cubeide, platformio, esp-idf, zephyr, cmake-embedded, make-embedded, rust-embedded, arduino, mbed, generic |
| `FirmwareCodegenTarget` | peripheral-init, isr-handler, dma-config, clock-config, gpio-config, linker-script, startup-code, rtos-task |

---

## Agent Tools — 58 `fw_*` tools

### Core hardware tools (22)

| Category | Tool | Source | Status |
|---|---|---|---|
| MCU Info | fw_get_mcu_info | session.mcuConfig | ✅ |
| MCU Info | fw_list_peripherals | session.registerMaps | ✅ |
| MCU Info | fw_search_mcu | mcuDatabaseService | ✅ |
| MCU Info | fw_scan_project | session.projectInfo | ✅ |
| Registers | fw_get_register_map | session register lookup | ✅ |
| Registers | fw_get_peripheral_config | session register lookup | ✅ |
| Registers | fw_get_bit_field_info | session register lookup | ✅ |
| Registers | fw_get_clock_config | session RCC register lookup | ✅ |
| Datasheets | fw_upload_datasheet | datasheetIntelligenceService | ⚠️ queues; extraction pipeline needs file I/O wiring |
| Datasheets | fw_query_datasheet | session.datasheets | ⚠️ stub — no semantic search yet |
| Datasheets | fw_get_datasheet_citations | session timing + errata | ✅ |
| Errata | fw_get_errata | session.errata | ✅ |
| Errata | fw_check_silicon_bug | session.errata keyword match | ✅ |
| Timing | fw_get_timing_constraints | session.timingConstraints | ✅ |
| Build | fw_build | buildSystemService → ITerminalService | ✅ |
| Build | fw_flash | buildSystemService → ITerminalService | ✅ |
| Build | fw_binary_size | buildSystemService.analyzeBinarySize | ⚠️ returns zeros — ELF parsing stub |
| Serial | fw_serial_send | serialMonitorService | ✅ |
| Serial | fw_serial_monitor | serialMonitorService.lastSerialConfig | ✅ |
| Compliance | fw_misra_check | stub; fw_misra_check_file is the full replacement | ⚠️ |
| Compliance | fw_cert_c_check | stub | ⚠️ |
| Compliance | fw_safety_audit | stub | ⚠️ |

### Phase 1+2 — Connected services + binary analysis (17)

| Tool | Source | What it does |
|---|---|---|
| fw_debug_start | debugService.startGDBServer + connectGDB | Launch GDB server (OpenOCD/J-Link/pyocd/QEMU), connect GDB |
| fw_debug_halt | debugService.halt | Halt CPU — required before register/memory reads |
| fw_debug_continue | debugService.continue | Resume execution |
| fw_debug_step | debugService.step | Step one source line |
| fw_debug_step_instruction | debugService.stepInstruction | Step one machine instruction |
| fw_debug_read_registers | debugService.readRegisters | r0–r15, sp, lr, pc, xpsr as hex |
| fw_debug_read_memory | debugService.readMemory | Hex dump at address — inspect live peripheral registers |
| fw_debug_set_breakpoint | debugService.setBreakpoint | Set by function name, file:line, or address |
| fw_debug_remove_breakpoint | debugService.removeBreakpoint | Remove by ID |
| fw_debug_backtrace | debugService.sendCommand('backtrace') | Call stack with file:line |
| fw_debug_stop | debugService.stopDebug | Disconnect GDB, stop server |
| fw_serial_list_ports | serialMonitorService.listPorts | Enumerate ports, identify debug probes |
| fw_serial_connect | serialMonitorService.connect | Connect with full config (baud/parity/bits) |
| fw_serial_disconnect | serialMonitorService.disconnect | Disconnect |
| fw_serial_read | serialMonitorService.rxBuffer | Read ring buffer — actual firmware output with timestamps |
| fw_serial_clear | serialMonitorService.clearBuffers | Clear RX/TX buffers |
| fw_serial_auto_baud | serialMonitorService.autoDetectBaudRate | Auto-detect baud rate |
| fw_get_build_errors | buildSystemService.lastBuildResult.errors[] | Structured GCC diagnostics with file:line |
| fw_detect_flash_tools | buildSystemService.detectFlashTools | Installed flash tools with versions |
| fw_get_build_command | buildSystemService.getBuildCommand | Exact shell command for this project type |
| fw_analyze_map_file | IFileService.readFile(.map) | Section sizes, flash/RAM %, top symbols, object file ranking |
| fw_analyze_stack_usage | IFileService.readFile(.su) | Per-function frame sizes, dynamic frames, threshold warnings |
| fw_read_elf_symbols | IFileService.readFile(.nm) | Symbol table: size/type/address, undefined/weak symbols |

### Phase 3 — Code generation (6)

| Tool | Generates |
|---|---|
| fw_generate_peripheral_init | C/Rust init function from SVD registers, MISRA patterns if active |
| fw_generate_isr | ISR skeleton with clear-first pattern + NVIC enable |
| fw_generate_dma_config | DMA stream/channel setup (STM32F4 stream vs F0/F1 channel style) |
| fw_generate_clock_config | Full PLL config: HSE/HSI → PLL → wait states → APB prescalers |
| fw_generate_gpio_config | MODER/OTYPER/OSPEEDR/PUPDR/AFR writes with bit offsets |
| fw_generate_rtos_task | FreeRTOS xTaskCreate or Zephyr K_THREAD_DEFINE skeleton |

### Phase 4 — Peripheral intelligence (5)

| Tool | What it answers |
|---|---|
| fw_calculate_prescaler | PSC/ARR/CCR values for target frequency + duty cycle, math shown |
| fw_gpio_alternate_functions | AF number lookup from SVD AFRL/AFRH enumeratedValues |
| fw_dma_channel_map | Full DMA stream/channel table for STM32F4/F7, F0/F1/F3, G4/L4, nRF52, RP2040 |
| fw_nvic_priority_guide | IRQ numbers + FreeRTOS/Zephyr ISR-safety notes per peripheral |
| fw_read_config_file | platformio.ini / CMakeCache.txt / sdkconfig / prj.conf key-value parse |

### Phase 5 — Simulation (2)

| Tool | Returns |
|---|---|
| fw_qemu_availability | QEMU machine model, -machine flag, peripheral gaps, launch command |
| fw_renode_board_check | Renode .resc script, simulated peripherals, launch command |

### Phase 6 — Compliance depth (3)

| Tool | Source |
|---|---|
| fw_misra_check_file | IGRCEngineService.getAllResults() filtered to file + MISRA rules |
| fw_list_framework_violations | IGRCEngineService.getAllResults() filtered to active safety frameworks |
| fw_generate_traceability | Markdown RTM table linking files to framework requirements |

---

## Power Mode Integration

`buildFirmwarePowerTools()` in `powerMode/browser/tools/firmwareTools.ts` adapts `IVoidInternalTool[]` → `IPowerTool[]` for the Power Mode `PowerToolRegistry`.

- All 22+ fw_* tools appear as native JSON schema function calls in the LLM request (`tools:` field)
- LLM calls them natively — no XML parsing, no bash workarounds
- Tools are registered unconditionally; tools themselves check `session.isActive` and return graceful errors when no session exists
- Registry is built once per directory (cached in `_toolRegistries` Map) — includes fw_* tools from first build

```
firmwareAgentToolService.getTools()
    │
    └─→ buildFirmwarePowerTools()               ← firmwareTools.ts
              └─→ PowerToolRegistry.registerMany()
                        └─→ buildToolSchemas()  ← JSON schema for each fw_* tool
                                  └─→ ILLMRequest.tools  ← sent to LLM with every request
```

---

## Keybinding

`Cmd+Alt+F` — Open Firmware Environment
`Cmd+Alt+M` — Open Modernisation Environment
`Cmd+Alt+A` — Open Agent Manager

---

## Dependencies (within the IDE)

| Dependency | Used for |
|---|---|
| `convertToLLMMessageService` | Void sidebar context injection |
| `powerMode/session/systemPrompt.ts` | Power Mode context + identity injection |
| `powerMode/tools/firmwareTools.ts` | IPowerTool adapter for Power Mode registry |
| `voidInternalToolService` | Void sidebar tool registration |
| `IGRCEngineService` | Compliance tool integration (Phase 6) |

No dependency on `neuralInverseModernisation`, `neuralInverseChecks`, or any other contrib module.
