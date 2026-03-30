# Firmware Production Parity — Task Tracker

## Stream 1 — MCU Database (41 → 400+)
- [ ] Add TI C2000 family (F2802x, F28069M, F28335, F28379D)
- [ ] Add AURIX family (TC264, TC275, TC397)
- [ ] Add NXP Kinetis (K22F, K64F, K66F) + i.MX RT (RT1060, RT1170)
- [ ] Add Renesas RA (RA4M1, RA6M5, RA6M3) + RX (RX65N, RX72N)
- [ ] Add STM32 extended (G0, G4, U5, WL, WB, MP1 series)
- [ ] Add Nordic extended (nRF5340, nRF9160, nRF7002DK)
- [ ] Add Microchip (PIC32MZ, SAMD21, SAME54, SAMC21)
- [ ] Verify mcuDbService.count ≥ 400

## Stream 2 — SVD Auto-Load
- [ ] Create bundledSVDs.ts with 8 SVD XML strings
- [ ] Wire firmwareSessionService.startSession() to auto-parse SVD on MCU family match
- [ ] Verify Registers tab shows populated data for STM32F4 session

## Stream 3 — Real Build Execution
- [ ] Inject ITerminalService into BuildSystemService
- [ ] Replace stub with createTerminal + sendText in build()
- [ ] Replace stub with createTerminal + sendText in flash()
- [ ] Replace stub in clean()
- [ ] Verify terminal opens and command runs on Build click

## Stream 4 — Serial Monitor UI Wiring
- [ ] Inject ISerialMonitorService into FirmwarePart
- [ ] Remove fake _serialLines / _serialConnected local state
- [ ] Wire Connect button → serialSvc.connect()
- [ ] Wire Disconnect button → serialSvc.disconnect()
- [ ] Wire Send / Enter → serialSvc.send()
- [ ] Subscribe onDataReceived → append to output DOM
- [ ] Subscribe onConnectionChanged → update dot + button
- [ ] Call listPorts() to populate port dropdown with real ports
- [ ] Wire "Auto Baud" option

## Stream 5 — PDF Extraction Pipeline
- [ ] Wire extractFromPDF() to read file bytes via IFileService
- [ ] Integrate pdf.js (VS Code bundled copy) for page text extraction
- [ ] Connect page text to existing LLM extraction chain
- [ ] Wire Upload button in Datasheets tab to call service
- [ ] Show extraction progress bar in UI

## Stream 6 — Persistent Project Memory
- [ ] Create firmwareProjectMemoryService.ts
- [ ] Save detected MCU + project type to workspace storage on session start
- [ ] Load and inject into hardwareContextProvider on session restore
- [ ] Verify agent's first message contains project context after IDE restart
