# neuralInverseFirmware — Enterprise Firmware Environment

## Context

Neural Inverse is competing with Embedder.com in the AI-native firmware/embedded development space. This is a **dedicated enterprise environment** (like Modernisation), not a chat mode. Lives on the **main branch** — entirely enterprise-only.

**Key architectural pattern**: The Firmware Environment has its own **auxiliary window** for session management and hardware-specific UI (daasheets, register maps, serial monitor). The actual coding happens through the **existing Void sidebar chat and Power Mode terminal** — firmware context is **injected into their system prompts** when a firmware session is active.

---

## Context Injection Flow

```
neuralInverseFirmware session active
    │
    ├─→ convertToLLMMessageService._buildFirmwareContext()     ← Void sidebar chat
    │     └─→ _getCombinedAIInstructions()                     ← injected alongside modernisation, GRC
    │
    └─→ Power Mode systemPrompt.ts                             ← <firmware_session> block
          └─→ buildSystemPrompt({ firmwareContext })            ← same pattern as modernisationContext
```

Both Void chat and Power Mode see:
- Active MCU/board info
- Loaded datasheet summaries
- Register map references
- MISRA/compliance rules in effect
- Available firmware-specific tools

---

## Directory Structure

```
src/vs/workbench/contrib/neuralInverseFirmware/
├── browser/
│   ├── neuralInverseFirmware.contribution.ts       ← Workbench contribution + Cmd+Alt+F
│   ├── firmwareSessionService.ts                   ← Session state (MCU, datasheets, SVDs)
│   ├── voidFirmwareToolsContrib.ts                 ← Registers tools with Void internal tool service
│   ├── engine/
│   │   ├── agentTools/
│   │   │   ├── service.ts                          ← IFirmwareAgentToolService
│   │   │   ├── FirmwareAgentToolServiceImpl.ts     ← Implements all firmware tools
│   │   │   ├── index.ts                            ← DI registration
│   │   │   └── impl/
│   │   │       ├── datasheetTools.ts               ← upload_datasheet, query_datasheet, get_datasheet_citations
│   │   │       ├── registerMapTools.ts             ← get_register_map, get_peripheral_config, get_bit_field_info
│   │   │       ├── errataTools.ts                  ← get_errata, check_silicon_bug
│   │   │       ├── timingTools.ts                  ← get_timing_constraints, get_clock_config
│   │   │       └── complianceTools.ts              ← misra_check, cert_c_check, safety_audit
│   │   ├── datasheet/
│   │   │   ├── pdfParserService.ts                 ← PDF → raw text (pdf.js)
│   │   │   ├── datasheetExtractorService.ts        ← LLM-assisted structured extraction (BYOLLM)
│   │   │   └── datasheetStorageService.ts          ← Per-project JSON storage in .neuralInverse/firmware/
│   │   ├── svd/
│   │   │   ├── svdParserService.ts                 ← ARM CMSIS SVD XML → register map JSON
│   │   │   └── svdTypes.ts                         ← ISVDDevice, ISVDPeripheral, ISVDRegister, ISVDBitField
│   │   ├── hardwareContext/
│   │   │   └── hardwareContextProvider.ts          ← Builds firmware context for system prompt injection
│   │   └── serial/                                 ← Phase 3
│   │       └── serialMonitorService.ts
│   ├── ui/
│   │   ├── firmwarePart.ts                         ← Main Part for auxiliary window
│   │   └── console/
│   │       ├── firmwareConsole.ts                  ← Tab-based console layout
│   │       ├── datasheetBrowser.ts                 ← Browse/search parsed datasheets
│   │       ├── registerMapView.ts                  ← Visual register map explorer
│   │       ├── peripheralConfigView.ts             ← Peripheral configuration
│   │       └── serialMonitorView.ts                ← Serial monitor panel (Phase 3)
│   └── statusbar/
│       └── firmwareStatus.contribution.ts          ← MCU info, compliance status in status bar
├── common/
│   └── firmwareTypes.ts                            ← Shared types (IFirmwareSession, IMCUConfig, etc.)
└── docs/
    └── architecture.md
```

---

## Proposed Changes

### Component 1: Core Contribution

#### [NEW] neuralInverseFirmware.contribution.ts
- Workbench contribution that opens a dedicated auxiliary window
- Keybinding: `Cmd+Alt+F` (Firmware)
- Commands: `neuralInverse.openFirmware`, `neuralInverse.endFirmwareSession`
- Registers all DI singletons via side-effect imports
- Restores window state on reload (same pattern as Modernisation)

#### [NEW] firmwareSessionService.ts
- `IFirmwareSessionService` with `session` state and `onDidChangeSession` event
- Session stores: MCU family, board, loaded datasheets, SVD files, active peripheral, compliance frameworks
- Persists to workspace storage (`StorageScope.WORKSPACE`)

#### [NEW] firmwareTypes.ts
- `IFirmwareSession` — session state interface
- `IMCUConfig` — MCU family, variant, core, clock, memory map
- `IDatasheetInfo` — parsed datasheet metadata
- `IRegisterMap`, `IRegister`, `IBitField` — register map types
- `IPeripheralConfig` — peripheral configuration
- `IErrata` — silicon errata entry

---

### Component 2: Context Injection (Critical Path)

#### [MODIFY] [convertToLLMMessageService.ts](file:///Users/sanjaysenthilkumar/Documents/IDE/void/src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts)

Add `_buildFirmwareContext()` alongside existing `_buildModernisationContext()`:

```typescript
// Lazy-resolved firmware session service
private _firmwareSession: IFirmwareSessionService | null | undefined
private _getFirmwareSession(): IFirmwareSessionService | null {
    if (this._firmwareSession === undefined) {
        try {
            this._firmwareSession = this.instantiationService.invokeFunction(a => a.get(IFirmwareSessionService))
        } catch {
            this._firmwareSession = null
        }
    }
    return this._firmwareSession
}

private _buildFirmwareContext(): string | undefined {
    const session = this._getFirmwareSession()?.session
    if (!session?.isActive) return undefined

    const lines: string[] = [
        '## Active Firmware Session',
        `MCU: ${session.mcuFamily} ${session.mcuVariant}  |  Core: ${session.core}  |  Clock: ${session.clockMHz}MHz`,
        `Board: ${session.boardName ?? 'custom'}`,
    ]
    // ... datasheet summaries, register maps, compliance frameworks, available tools
    return lines.join('\n')
}
```

Inject in `_getCombinedAIInstructions()`:
```typescript
const firmwareContext = this._buildFirmwareContext()
if (firmwareContext) ans.push(firmwareContext)
```

#### [MODIFY] [systemPrompt.ts](file:///Users/sanjaysenthilkumar/Documents/IDE/void/src/vs/workbench/contrib/powerMode/browser/session/systemPrompt.ts)

Add `firmwareContext?: string` to `buildSystemPrompt` input, inject as `<firmware_session>` block:

```typescript
if (input.firmwareContext) {
    parts.push(`<firmware_session>\n${input.firmwareContext}\n</firmware_session>`);
}
```

---

### Component 3: Datasheet Intelligence Engine

#### [NEW] pdfParserService.ts
- `IPdfParserService` — extracts raw text + tables from PDF datasheets
- Uses pdf.js (available in Electron)
- Returns structured pages with text blocks and table regions

#### [NEW] datasheetExtractorService.ts
- `IDatasheetExtractorService` — LLM-assisted structured extraction
- Uses BYOLLM (user's chosen model) via `sendLLMMessage`
- Extraction prompts for: register maps, bit fields, timing constraints, errata
- Outputs structured JSON per peripheral

#### [NEW] datasheetStorageService.ts
- `IDatasheetStorageService` — per-project storage
- Stores in workspace `.neuralInverse/firmware/datasheets/`
- JSON files per datasheet: `{datasheetId}.json`

---

### Component 4: SVD Parser (IDE-side)

#### [NEW] svdParserService.ts
- `ISVDParserService` — parses ARM CMSIS SVD XML files
- Browser-side XML parsing (DOMParser available in Electron)
- Immediate coverage: STM32, nRF, NXP, RP2040, ESP32
- Handles derived-from inheritance, cluster expansion, dimension arrays

#### [NEW] svdTypes.ts
- `ISVDDevice` — device-level info (name, version, description, address unit bits)
- `ISVDPeripheral` — peripheral (base address, registers, interrupts)
- `ISVDRegister` — register (offset, size, reset value, access, fields)
- `ISVDBitField` — bit field (offset, width, access, enumerated values)

---

### Component 5: Firmware Agent Tools

#### [NEW] FirmwareAgentToolServiceImpl.ts
15 tools registered with Void's internal tool service:

| Tool | Description |
|---|---|
| `fw_upload_datasheet` | Upload and parse a PDF datasheet |
| `fw_query_datasheet` | Natural language query against parsed datasheets |
| `fw_get_datasheet_citations` | Get page-level citations for a peripheral |
| `fw_get_register_map` | Get register map for a peripheral |
| `fw_get_peripheral_config` | Get peripheral configuration options |
| `fw_get_bit_field_info` | Get bit field details for a specific register |
| `fw_get_errata` | Get silicon errata for current MCU revision |
| `fw_check_silicon_bug` | Check if a specific silicon bug affects the code |
| `fw_get_timing_constraints` | Get timing constraints for a peripheral |
| `fw_get_clock_config` | Get clock tree configuration |
| `fw_misra_check` | Run MISRA C:2012 compliance check on code |
| `fw_cert_c_check` | Run CERT C compliance check on code |
| `fw_safety_audit` | Run safety audit (IEC 62304 / ISO 26262 / DO-178C) |
| `fw_list_peripherals` | List all peripherals for current MCU |
| `fw_get_mcu_info` | Get MCU specifications and memory map |

All tools prefixed with `fw_` to avoid collision with existing tools.

#### [NEW] voidFirmwareToolsContrib.ts
- Registers all firmware tools with `IVoidInternalToolService`
- Same pattern as `voidDiscoveryToolsContrib.ts`
- Tools only registered when firmware session is active

---

### Component 6: UI (Auxiliary Window)

#### [NEW] firmwarePart.ts
- `FirmwarePart extends Part` — main Part for the auxiliary window
- Tab-based layout: **Dashboard** | **Datasheets** | **Registers** | **Serial** | **Compliance**
- Dashboard shows: MCU info, loaded datasheets, quick actions

#### [NEW] Console views
- `firmwareConsole.ts` — tab navigation and layout management
- `datasheetBrowser.ts` — browse/search parsed datasheets, drill into peripherals
- `registerMapView.ts` — visual register map (address table, bit field diagrams)
- `peripheralConfigView.ts` — configure peripheral settings visually
- `serialMonitorView.ts` — serial monitor panel (Phase 3)

---

### Component 7: Status Bar

#### [NEW] firmwareStatus.contribution.ts
- Shows when firmware session is active: `⚡ STM32F4 | MISRA ✓ | 3 datasheets`
- Click → focus/open Firmware Environment window
- Updates on session change events

---

## Execution Order

| Step | Component | Dependencies | Effort |
|---|---|---|---|
| 1 | `firmwareTypes.ts` | None | Small |
| 2 | `firmwareSessionService.ts` | firmwareTypes | Medium |
| 3 | `neuralInverseFirmware.contribution.ts` + `firmwarePart.ts` | sessionService | Medium |
| 4 | `hardwareContextProvider.ts` | sessionService | Small |
| 5 | Modify `convertToLLMMessageService.ts` | hardwareContextProvider | Small |
| 6 | Modify Power Mode `systemPrompt.ts` | hardwareContextProvider | Small |
| 7 | `svdParserService.ts` + `svdTypes.ts` | firmwareTypes | Medium |
| 8 | `FirmwareAgentToolServiceImpl.ts` + tool impls | all engine services | Large |
| 9 | `voidFirmwareToolsContrib.ts` | agent tools | Small |
| 10 | `firmwareStatus.contribution.ts` | sessionService | Small |
| 11 | `pdfParserService.ts` + `datasheetExtractorService.ts` | firmwareTypes | Large |
| 12 | Console views (UI) | all services | Large |

---

## Verification Plan

### Automated Tests
- Unit tests for SVD parser (parse sample STM32 SVD → verify register map output)
- Unit tests for firmware session lifecycle
- Unit tests for hardware context builder output format

### Manual Verification
- Build IDE → `Cmd+Alt+F` → Firmware Environment opens
- Verify firmware context appears in Void sidebar chat system prompt when session active
- Verify firmware context appears in Power Mode system prompt
- Verify `fw_*` tools appear in agent tool list
- Status bar shows MCU info when session active
- Load SVD file → browse register maps in UI
