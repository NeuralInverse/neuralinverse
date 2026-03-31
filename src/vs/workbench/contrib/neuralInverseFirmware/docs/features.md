# neuralInverseFirmware — Feature Reference

Status key: ✅ Built  ⚠️ Partial  🗂 Planned

---

## Core Infrastructure ✅

### Session Management
- Firmware session tied to workspace — survives IDE restart via workspace storage
- Active MCU config: family, variant, core, clock, flash, RAM, memory map, peripheral list, FPU/MPU/DSP flags
- Board name, RTOS, build system, platform ID tracked per session
- Session restore re-loads register maps from `.inverse/hardware-kb/` on startup (MCU family prefix guard prevents cross-MCU bleeding)
- `Firmware.inverse` manifest written to workspace root — team-shareable session anchor

### MCU Database
- 357 unique MCU variants across 11 manufacturers (STM, NXP, Renesas, TI, Infineon, Nordic, Espressif, Silicon Labs, GigaDevice, Microchip, others)
- Searchable by part number, family, board name, keyword
- Covers: Cortex-M0/M0+/M3/M4/M4F/M7/M23/M33/M55, RISC-V, TriCore (AURIX), AVR, Xtensa (ESP32), RX, PPC
- Duplicate-free (audited March 2026, see `mcu_db_audit_report.md`)

### SVD Auto-Load & Parsing
- Custom lightweight XML parser (avoids VS Code Trusted Types block on DOMParser)
- Fetches CMSIS-SVD from `posborne/cmsis-svd` GitHub repository on demand (60+ STM32 patterns + Nordic + RP2040)
- Caches SVD in memory by URL — no repeated downloads
- Handles `derivedFrom` peripheral inheritance
- Auto-fetches matching SVD on session start if bundled SVD exists for the MCU family
- Per-peripheral source provenance: `source` field on `IPeripheralRegisterMap` tracks which SVD or datasheet contributed each peripheral's data

---

## Datasheet Intelligence ✅

### PDF Extraction Pipeline (3-tier, BYOLLM)
- **Tier 0**: Content-hash cache — re-opening same PDF costs zero LLM calls
- **Tier 1**: Custom FlateDecode + BT/ET PDF text extraction (no pdf.js dependency)
- **Tier 2**: Heuristic page classification (register, timing, errata, pinout, memory-map pages via keyword scoring)
- **Tier 3a**: LLM reclassification in batches of 5 pages for ambiguous pages (capped at 150 pages)
- **Tier 3b**: SVD override — if part numbers found in PDF filename/cover → fetch authoritative SVD, bypass heuristic register extraction entirely

### Extraction Quality
- Part number extraction: from filename first (highest confidence), then cover/overview pages
- Register extraction: 3 regex patterns (inline offset, ST table format, proximity scan)
- Timing extraction: compact table format + description format
- Errata extraction: numbered item detection + severity heuristics
- Citations: every extracted entry carries `datasheetId`, `pageNumber`, `sectionTitle`, `confidence`

### Knowledge Base
- Persistent at `.inverse/hardware-kb/` (content-hash deduplicated)
- Committed alongside `Firmware.inverse` for team sharing
- Instant reload on IDE restart: 0 LLM calls for known PDFs

### Multi-Source Register Maps
- SVD-loaded peripherals take precedence over datasheet-extracted ones
- Multiple sources coexist: source provenance tracked per peripheral
- UI groups register sidebar by source with colored headers; mismatched MCU sources get ⚠ badge

---

## Hardware Context in AI ✅

### Void Sidebar Chat
- Firmware context injected via `convertToLLMMessageService._buildFirmwareContext()`
- Agent sees: active MCU, loaded peripherals, datasheet summaries, compliance frameworks, tool list
- Context only injected when session is active — no impact on normal coding

### Power Mode Terminal
- Firmware-specific system prompt (`firmwareSystemPrompt.ts`) **replaces** the generic Power Mode prompt when a session is active
- ABSOLUTE RULES block prevents agent from narrating tool calls via bash
- Dispatch table maps user questions directly to the correct `fw_*` tool
- `fw_*` tools registered in `PowerToolRegistry` as native function calls (not XML-pattern tools)
- `<firmware_session>` XML block provides structured hardware context alongside the identity prompt

---

## Agent Tools — 22 fw_* Tools ✅

### MCU & Hardware Info
- `fw_get_mcu_info` — Full MCU specs, memory map, GPIO count
- `fw_list_peripherals` — All loaded peripherals with base addresses and register counts
- `fw_search_mcu` — Search the built-in MCU database
- `fw_scan_project` — Auto-detect project type, MCU, build system, RTOS from config files

### Register Access
- `fw_get_register_map` — Full register map for a peripheral (all registers, offsets, bit fields, reset values, enums)
- `fw_get_peripheral_config` — Configuration registers with all fields and enum values
- `fw_get_bit_field_info` — Detailed bit field info for a specific register
- `fw_get_clock_config` — Clock tree info (RCC registers, PLL config)

### Datasheet & Documentation
- `fw_upload_datasheet` — Parse a PDF datasheet (queues extraction pipeline)
- `fw_query_datasheet` — Natural language query against loaded datasheets
- `fw_get_datasheet_citations` — Page-level citations for a peripheral

### Errata & Timing
- `fw_get_errata` — Silicon errata for MCU or specific peripheral
- `fw_check_silicon_bug` — Check if a specific operation is affected by known errata
- `fw_get_timing_constraints` — Setup/hold times, clock limits for a peripheral

### Build, Flash & Serial
- `fw_build` — Build firmware project (auto-detects build system)
- `fw_flash` — Flash to target MCU (auto-detects flash tool)
- `fw_binary_size` — Flash/RAM usage analysis
- `fw_serial_send` — Send data to connected serial port
- `fw_serial_monitor` — Serial connection status and configuration

### Compliance
- `fw_misra_check` — MISRA C:2012 check on a code snippet
- `fw_cert_c_check` — CERT C check on a code snippet
- `fw_safety_audit` — IEC 62304 / ISO 26262 / DO-178C audit

---

## Firmware Environment UI ✅

### Auxiliary Window (Cmd+Alt+F)
Six-tab layout in a floating aux window (same pattern as Modernisation Cmd+Alt+M):

- **Dashboard**: MCU selector with database search, board/RTOS/build system config, status at a glance
- **Datasheets**: Upload PDFs, extraction progress, mismatch detection (⚠ Wrong MCU badge + ↺ Replace auto-fix)
- **Registers**: Interactive peripheral tree — grouped by source when multiple SVDs/datasheets loaded
- **Serial**: Connect/disconnect, send, live RX output (wired to `SerialMonitorService`)
- **Compliance**: Active frameworks, MISRA rule summary, errata warnings
- **Build**: Build + flash buttons, output log, binary size gauges

### SVD Mismatch Handling
- On SVD load, MCU family prefix (6 chars) is compared against active session MCU
- Mismatch shows ⚠ badge on datasheet entry with MCU detected vs MCU expected
- "↺ Replace" button removes bad entry and auto-fetches the correct SVD via `svdFetchService.fetchForParts()`

---

## Build, Flash & Debug Services ✅

### BuildSystemService
- 9 project types: PlatformIO, CMake, Make, ESP-IDF, Cargo, Arduino CLI, Zephyr, STM32CubeIDE, Mbed
- 11 flash tools: openocd, stm32-programmer-cli, st-flash, esptool, nrfjprog, jlink, pyocd, probe-rs, dfu-util, arduino-cli, west
- GCC diagnostic parser: `file:line:col: severity: message` format
- Binary size analysis: text/data/bss sections, Flash/RAM usage percentages
- Integrated terminal dispatch via `ITerminalService`

### SerialMonitorService
- Web Serial API + platform port enumeration
- 10,000-line RX/TX ring buffer with timestamps
- Debug probe auto-detection (ST-Link, J-Link, CMSIS-DAP, FTDI, CP210x, CH340, etc.)
- Baud rate auto-detection heuristic
- DTR/RTS signal control (bootloader auto-reset for ESP32)
- Log export: text or CSV

### FirmwareDebugService
- 5 GDB server integrations: OpenOCD, J-Link GDB Server, pyocd, st-util, QEMU
- CPU register read (r0–r15, sp, lr, pc, xpsr)
- Memory read/write at arbitrary addresses
- Breakpoint set/remove by file:line or function name
- Step, step-instruction, continue, halt, reset
- GDB/MI output parsing for structured responses
- Breakpoint hit events

---

## Visual IDE Features 🗂 Planned

### Interactive Bit-Math Panel
When the user clicks a register assignment in code (e.g. `ADC1->CR1 |= (1 << 8)`), a side panel opens showing the 32-bit register with live checkboxes for each field. Checking a field injects the correct bit manipulation into the source file. Editing the hex value shows which fields are set.

**Why**: Turns error-prone manual bit manipulation into a visual config tool while keeping the generated C code visible.

### Live MCU Pinout Visualizer
Graphical MCU package view (TQFP, LQFP, BGA). As code is written or agent generates peripheral config, claimed pins light up on the visualizer showing which peripheral "owns" them. Conflicts (two peripherals claiming the same pin) shown in amber.

**Why**: Eliminates the need to keep a PDF pin matrix open on a second monitor.

### Architecture Block Diagram (Code-to-Design)
Parses `init` functions and peripheral configs in real-time to construct a data-flow graph. Draws connections: `TIM3 → DMA1_Channel4 → USART1` from what the code actually configures. Interactive — click a block to navigate to the config code.

**Why**: New team members understand system architecture in seconds by opening the diagram, not reading 10 init files.

### SVD Hover Provider ✅ Partial
`firmwareHoverProvider.ts` and `firmwareLSPBridge.ts` exist. When cursor is on a register access (`USART2->BRR`), hover shows SVD description, reset value, access type, and bit field breakdown.

---

## Platform Skills ✅

Four pre-built platform knowledge packs injected into the firmware system prompt:

| Platform | Notes included |
|---|---|
| STM32 | RCC peripheral clock enable pattern, GPIO AF table, HAL vs LL choice, FLASH wait states, DMA MINC/PINC patterns |
| ESP32 | ESP-IDF framework, FreeRTOS core affinity, ADC2 WiFi conflict, IRAM_ATTR for ISRs, menuconfig workflow |
| nRF (Nordic) | Zephyr west build, EasyDMA RAM buffer requirement, HFXO for BLE, devicetree pin assignments |
| RP2040/RP2350 | Dual-core patterns, PIO state machines, QSPI XIP, CMake pico-sdk, USB 48MHz constraint |

Each pack includes clock configuration notes and debug probe setup.

---

## Status Bar ✅

Entry format: `⚡ STM32F030F4 | MISRA | 3 datasheets`

Shown only when firmware session is active. Click to focus the Firmware Environment window. Updates on every session state change.

---

## Compliance Frameworks ✅ (context + stubs)

Active frameworks injected into system prompt with specific rule reminders:

| Framework | Rules surfaced to agent |
|---|---|
| MISRA C:2012 / 2023 | No implicit conversions, no void* arithmetic, no recursion, no dynamic allocation, default in switch, bounded loops, explicit casts, stdint types |
| CERT C | Validate inputs, check return values, prevent integer overflow, secure string functions |
| IEC 62304 | Software safety class, interface documentation, requirements traceability |
| ISO 26262 | ASIL decomposition, freedom from interference, defensive programming |
| IEC 61508, DO-178C, AUTOSAR | Framework names injected; deep rule enforcement via GRC engine (planned Phase 6) |

---

## Upcoming — Advanced Tools (see `advanced-tools-plan.md`)

36 new `fw_*` tools across 6 phases:

| Phase | Category | Tools |
|---|---|---|
| 1a | Debug | `fw_debug_start/halt/continue/step/read_registers/read_memory/set_breakpoint/backtrace/stop` (9) |
| 1b | Serial | `fw_serial_list_ports/connect/disconnect/read/clear/auto_baud` (6) |
| 1c | Build analysis | `fw_get_build_errors`, `fw_detect_flash_tools`, `fw_get_build_command` (3) |
| 2 | Binary analysis | `fw_analyze_map_file`, `fw_analyze_stack_usage`, `fw_read_elf_symbols` (3) |
| 3 | Code generation | `fw_generate_peripheral_init/isr/dma_config/clock_config/gpio_config/rtos_task` (6) |
| 4 | Peripheral intel | `fw_calculate_prescaler`, `fw_gpio_alternate_functions`, `fw_dma_channel_map`, `fw_nvic_priority_guide`, `fw_read_config_file` (5) |
| 5 | Simulation | `fw_qemu_availability`, `fw_renode_board_check` (2) |
| 6 | Compliance depth | `fw_misra_check_file`, enhanced stubs, `fw_generate_traceability` (3) |
