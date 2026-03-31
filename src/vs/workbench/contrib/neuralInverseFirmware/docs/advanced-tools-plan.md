# neuralInverseFirmware — Advanced Agent Tools Plan

> **Scope**: New `fw_*` tools only. Everything in this plan lives inside
> `engine/agentTools/` and is returned by `getTools()`. Zero impact on any
> service, contrib, or UI outside the firmware module.

---

## What Exists Today (22 tools)

| Category | Tools |
|---|---|
| MCU Info | `fw_get_mcu_info`, `fw_list_peripherals`, `fw_search_mcu` |
| Registers | `fw_get_register_map`, `fw_get_peripheral_config`, `fw_get_bit_field_info`, `fw_get_clock_config` |
| Datasheets | `fw_upload_datasheet`, `fw_query_datasheet`, `fw_get_datasheet_citations` |
| Errata & Timing | `fw_get_errata`, `fw_check_silicon_bug`, `fw_get_timing_constraints` |
| Compliance | `fw_misra_check`, `fw_cert_c_check`, `fw_safety_audit` |
| Build & Flash | `fw_build`, `fw_flash`, `fw_binary_size`, `fw_scan_project` |
| Serial | `fw_serial_send`, `fw_serial_monitor` |

The services behind these tools are fully implemented (`BuildSystemService`, `SerialMonitorService`, `FirmwareDebugService`) but most fw_* tools return stubs rather than calling the service APIs. The plan below connects those gaps and adds entirely new capabilities.

---

## Phase 1 — Connect Existing Services

> Highest ROI: the service layer already does the work. These tools just wire the agent to it.

### 1a. Debug Tools — new file `debugTools.ts`

`FirmwareDebugService` is fully implemented (5 GDB servers, register/memory reads, breakpoints, step/continue). Nothing exposes it to the agent today.

| Tool | Calls | What agent gets |
|---|---|---|
| `fw_debug_start` | `debugService.startGDBServer()` + `connectGDB()` | Server PID, port, connection confirmed |
| `fw_debug_halt` | `debugService.halt()` | Target halted — required before memory/register reads |
| `fw_debug_continue` | `debugService.continue()` | Target resumed |
| `fw_debug_step` | `debugService.step()` | Stepped one source line |
| `fw_debug_step_instruction` | `debugService.stepInstruction()` | Stepped one machine instruction |
| `fw_debug_read_registers` | `debugService.readRegisters()` | r0–r15, sp, lr, pc, xpsr as hex values |
| `fw_debug_read_memory` | `debugService.readMemory(address, length)` | Hex dump at address — lets agent inspect live peripheral registers |
| `fw_debug_set_breakpoint` | `debugService.setBreakpoint(location)` | Breakpoint ID |
| `fw_debug_remove_breakpoint` | `debugService.removeBreakpoint(id)` | Confirmed removed |
| `fw_debug_backtrace` | `debugService.sendCommand('backtrace')` | Call stack: function → file:line |
| `fw_debug_stop` | `debugService.stopDebug()` | GDB disconnected, server stopped |

**Impact**: The agent can now set a breakpoint, halt at it, read CPU registers and peripheral memory, walk the call stack, and suggest a fix — all within one conversation turn. This closes the biggest gap vs Embedder.

### 1b. Serial Tools — new file `serialTools.ts`

`SerialMonitorService` has a 10,000-line RX ring buffer. Today the agent cannot read it.

| Tool | Calls | What agent gets |
|---|---|---|
| `fw_serial_list_ports` | `serialMonitorService.listPorts()` | Port paths, manufacturers, debug probe detection |
| `fw_serial_connect` | `serialMonitorService.connect(config)` | Connected — port, baud rate confirmed |
| `fw_serial_disconnect` | `serialMonitorService.disconnect()` | Disconnected |
| `fw_serial_read` | Read from `rxBuffer` | Last N lines with timestamps — actual firmware output |
| `fw_serial_clear` | `serialMonitorService.clearBuffers()` | Buffers cleared |
| `fw_serial_auto_baud` | `serialMonitorService.autoDetectBaudRate(port)` | Detected baud rate |

`fw_serial_read` is the critical tool. It lets the agent read log lines, panic messages, and assert failures from running firmware and correlate them with register state and errata — without the user copy-pasting anything.

### 1c. Build Analysis Tools — add to `firmwareAgentToolService.ts`

`BuildSystemService` parses GCC diagnostics and linker errors into structured data. Today `fw_build` returns a generic stub.

| Tool | What changes |
|---|---|
| `fw_get_build_errors` | Return `session.lastBuildResult.errors[]` formatted as `file:line: severity: message`. Include linker errors separately. |
| `fw_detect_flash_tools` | Call `buildSystemService.detectFlashTools()` — which tools are installed, their versions. Agent picks the right flash command. |
| `fw_get_build_command` | Return the exact shell command for this project type. User can see or override it. |

---

## Phase 2 — Binary & Memory Analysis

> New capability. Extracts intelligence from compiler/linker output that no IDE currently surfaces to an AI agent.

### 2a. `fw_analyze_map_file` — new file `buildAnalysisTools.ts`

Parse the `.map` file the linker emits alongside the ELF binary.

**Input**: `mapPath?` (auto-detected from build output directory if omitted)

**Extracts**:
- Memory region usage: FLASH used/total/%, SRAM used/total/%, CCM, backup SRAM
- Top 20 largest symbols by size (function name, object file, bytes) — tells agent exactly what's bloating the binary
- Section sizes: `.text`, `.rodata`, `.data`, `.bss`, `.stack`, `.heap`
- Orphan sections: code that didn't fit expected placement (common linker script bug)
- Object file contribution ranking: which translation units take the most space

When a project is over its flash budget, the agent can name the 3 functions to optimize — without the user ever opening the map file.

### 2b. `fw_analyze_stack_usage`

GCC emits a `.su` file per translation unit when compiled with `-fstack-usage`. Each entry is `function_name bytes qualifier` where qualifier is `static`, `dynamic`, or `dynamic,bounded`.

**Input**: `suDir?` (build directory, auto-detected if omitted)

**Extracts**:
- Top 20 functions by frame size with file and qualifier
- Functions with `dynamic` or `dynamic,bounded` frames — potential stack overflow sources
- Estimated worst-case stack depth if call chains are readable
- Warning if any function exceeds a configurable threshold (default 256 bytes)

Stack overflows are the most common silent crash in embedded systems. No current tool surfaces this data to an AI agent.

### 2c. `fw_read_elf_symbols`

Run `arm-none-eabi-nm` (or equivalent) on the ELF to extract the symbol table.

**Input**: `elfPath?`, `filter?: 'functions' | 'variables' | 'all'`, `minSize?: number`

**Extracts**:
- Symbol name, section (.text/.data/.bss), address, size in bytes
- Weak vs strong symbols (linker resolution conflicts)
- Undefined symbols (not yet resolved — useful when debugging partial builds)

Lets the agent verify that new code doesn't duplicate or shadow existing symbols before linking.

---

## Phase 3 — Code Generation

> Leverages the register data already in session to generate exact, cite-annotated initialization code. Deterministic — not LLM-based. Values come from SVD.

All tools in new file `codegenTools.ts`. All generated code:
- Uses correct register names and offsets from `session.registerMaps`
- Adds inline comments citing register name, offset, and bit position
- Applies MISRA C patterns (volatile, explicit cast, no magic numbers) when framework is active

| Tool | Generates | Key inputs |
|---|---|---|
| `fw_generate_peripheral_init` | Peripheral init function in C or Rust | `peripheral` (e.g. `USART1`), `options` (baud, mode, etc.) |
| `fw_generate_isr` | ISR handler skeleton with NVIC enable, flag-clear-first pattern, volatile flag | `peripheral`, interrupt name from SVD |
| `fw_generate_dma_config` | DMA channel/stream setup with MSIZE/PSIZE, MINC/PINC, direction, priority | `peripheral`, `direction` (mem-to-periph / periph-to-mem) |
| `fw_generate_clock_config` | Full clock tree init: HSE/HSI → PLL → wait-for-lock → SYSCLK switch → AHB/APB prescalers → flash wait states | Target SYSCLK frequency |
| `fw_generate_gpio_config` | GPIO pin mode/speed/pull/alternate function setup with MODER/OTYPER/OSPEEDR/PUPDR writes | `pin` (e.g. `PA9`), `mode`, `af?` |
| `fw_generate_rtos_task` | FreeRTOS `xTaskCreate` or Zephyr `k_thread_define` skeleton with stack size, priority, ISR-safe patterns | `taskName`, `stackSize?`, `priority?` |

---

## Phase 4 — Peripheral Intelligence

> Answers the questions firmware engineers look up manually dozens of times a day. All new file `peripheralIntelTools.ts`.

### `fw_calculate_prescaler`

**Input**: `peripheral` (e.g. `TIM2`), `targetFrequencyHz`, `targetDutyCycle?`

**Calculates**:
1. Source clock from session MCU config (APB1/APB2 multiplier applied for timers)
2. PSC (prescaler) and ARR (auto-reload register) values to hit the target frequency with minimum error
3. CCR (capture/compare register) value for the requested duty cycle
4. Actual achieved frequency and error percentage (due to integer division)

**Returns**: Ready-to-paste C defines with the math shown:
```c
#define TIM2_PSC   7999   // APB1=64MHz → timer=64MHz, 64MHz/(7999+1) = 8kHz tick
#define TIM2_ARR    999   // 8kHz / (999+1) = 8Hz output
#define TIM2_CCR    499   // 50% duty cycle
```

### `fw_gpio_alternate_functions`

**Input**: `pin` (e.g. `PA9`) OR `peripheral` (e.g. `USART1`)

**Returns**: Complete AF mapping from the SVD's `enumeratedValues` on `AFRL`/`AFRH` fields — which AF number maps to which peripheral signal. Eliminates the most common embedded bug: wrong alternate function number.

### `fw_dma_channel_map`

**Input**: `peripheral?`

**Returns**: Complete DMA channel → peripheral mapping for this MCU family. Which DMA/Stream/Channel handles USART1_TX, SPI2_RX, ADC1, TIM3_CH1, etc. Sourced from per-family lookup tables (bundled since this data isn't in SVD). Eliminates the second most common DMA bug: wrong channel assignment.

### `fw_nvic_priority_guide`

**Input**: `peripheral`, `rtos?`

**Returns**:
- IRQ number from the SVD interrupt table
- `NVIC_SetPriority(IRQn, priority)` call with recommended value
- If RTOS detected: whether priority is safe to call RTOS APIs from ISR (vs `configMAX_SYSCALL_INTERRUPT_PRIORITY`)
- Platform notes: STM32 NVIC priority grouping, Cortex-M basepri semantics

### `fw_read_config_file`

**Input**: none — reads project config files from `session.projectInfo.configFiles`

**Returns**: Parsed key-value sections from the build config:
- **PlatformIO** (`platformio.ini`): `[env:*]` board, framework, monitor_speed, build_flags, lib_deps
- **CMake** (`CMakeCache.txt`): toolchain, MCU target, preprocessor defines
- **ESP-IDF** (`sdkconfig`): partition table, WiFi, FreeRTOS tick rate, log level, enabled components
- **Zephyr** (`prj.conf`): Kconfig values relevant to the current task

Lets the agent answer "what's my tick rate?" or "is UART DMA enabled in Kconfig?" from the project config without the user pasting it.

---

## Phase 5 — Simulation Availability

> New file `simulationTools.ts`. Two lightweight checks — no execution, just discovery.

### `fw_qemu_availability`

Checks whether QEMU has a machine model matching the current MCU family.

**Returns**: Whether QEMU supports this MCU; if yes, the exact `-machine` flag, the minimum QEMU version, and any known peripheral simulation gaps. Lets the agent suggest a `fw_build` → QEMU test loop when no hardware is connected.

Coverage: STM32 Cortex-M (limited, via `netduinoplus2`/`stm32-p103`), TI Stellaris/LM3S, NXP LPC, AVR.

### `fw_renode_board_check`

Checks whether Renode (by Antmicro) has a platform script for this MCU.

Renode has the broadest embedded simulation coverage: STM32, nRF52, RISC-V cores, ESP32, and supports peripheral simulation including UART, SPI, I2C, GPIO with actual IRQ delivery.

**Returns**: Whether a `.resc` platform script exists; if yes, the script name and a sample launch command. Lets the agent set up a Renode simulation environment automatically.

---

## Phase 6 — Compliance Depth

> Route existing stub tools through the live `IGRCEngineService`. New file `complianceTools.ts`.

### `fw_misra_check_file`

Run MISRA C analysis on a whole file, not just a snippet.

**Input**: `filePath`

**Calls**: `IGRCEngineService.getAllResults()` filtered to MISRA C:2012 rules and the target file.

**Returns**: All violations in file order with rule number (e.g. `Rule 11.3`), description, severity (mandatory/required/advisory), and the offending line.

### Enhanced `fw_misra_check` and `fw_cert_c_check`

Replace stubs with actual GRC engine calls for the provided code snippet. Violations returned with rule number and description, not just "connect to GRC engine."

### `fw_generate_traceability`

Generate a requirements traceability matrix for IEC 62304 or ISO 26262 documentation.

**Input**: `framework` (`iec-62304` / `iso-26262`), `sourceDir?`

**Returns**: Markdown table linking source functions (from ELF symbols) to safety requirements derived from the active compliance framework rules. Suitable for inclusion in a Software Requirements Specification or Technical Safety Concept document.

---

## File Layout

All new code lives inside `engine/agentTools/`. No other file is touched.

```
engine/agentTools/
├── firmwareAgentToolService.ts   (existing — getTools() spreads from each module)
├── debugTools.ts                 (Phase 1a — 11 debug tools)
├── serialTools.ts                (Phase 1b — 6 serial tools)
├── buildAnalysisTools.ts         (Phase 1c + Phase 2 — 6 tools)
├── codegenTools.ts               (Phase 3 — 6 generation tools)
├── peripheralIntelTools.ts       (Phase 4 — 5 tools)
├── simulationTools.ts            (Phase 5 — 2 tools)
└── complianceTools.ts            (Phase 6 — 3 tools)
```

`getTools()` becomes:

```typescript
getTools(): IVoidInternalTool[] {
    return [
        ...existingTools,
        ...buildDebugTools(this._debugService),
        ...buildSerialTools(this._serialMonitorService),
        ...buildBuildAnalysisTools(this._buildSystemService, this._session),
        ...buildCodegenTools(this._session),
        ...buildPeripheralIntelTools(this._session),
        ...buildSimulationTools(this._session),
        ...buildComplianceTools(this._grcEngine, this._session),
    ];
}
```

`buildFirmwarePowerTools()` in Power Mode picks up the complete list automatically — no changes needed in `powerModeService.ts`.

---

## Tool Count Summary

| Phase | New tools | Total cumulative |
|---|---|---|
| Existing | 22 | 22 |
| Phase 1 — Connect services | +17 | 39 |
| Phase 2 — Binary analysis | +3 | 42 |
| Phase 3 — Code generation | +6 | 48 |
| Phase 4 — Peripheral intelligence | +5 | 53 |
| Phase 5 — Simulation | +2 | 55 |
| Phase 6 — Compliance depth | +3 | 58 |

---

## Implementation Order

```
Phase 1a  debug tools         ← highest value, closes the GDB gap
Phase 1b  serial read tools   ← lets agent read actual firmware output
Phase 1c  build analysis      ← structured errors instead of raw text
Phase 2   binary analysis     ← map file + stack usage + ELF symbols
Phase 3   code generation     ← SVD-accurate peripheral init code
Phase 4   peripheral intel    ← prescaler calc, AF table, DMA map, NVIC guide
Phase 5   simulation          ← QEMU + Renode discovery
Phase 6   compliance depth    ← real MISRA/CERT C via GRC engine
```
