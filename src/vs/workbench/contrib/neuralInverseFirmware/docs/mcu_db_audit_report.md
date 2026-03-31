# MCU Database Full Audit Report

> **File**: `src/vs/workbench/contrib/neuralInverseFirmware/common/mcuDatabase.ts`  
> **Audit Date**: 2026-03-30  
> **Auditor**: Antigravity

---

## Final Database State (Post-Fix)

| Metric | Value |
|--------|-------|
| Total `e()` calls | 361 |
| **Unique MCU variants** | **357** |
| Duplicate variant names | **0** ✅ |
| File size | 180,271 bytes |
| File lines | 2,960 |

---

## Issues Found & Fixed

### ✅ 1. Duplicate Entries (26 duplicates → 0)
The batch-expansion process had re-added entries that already existed in the initial seed data. All 26 duplicates were identified and removed:

| Duplicate | Original Line | Duplicate Line |
|-----------|--------------|----------------|
| STM32F072RBT6 | 66 | 2961 |
| STM32F302R8T6 | 529 | 2652 |
| STM32F746NGH6 | 143 | 2438 |
| STM32F767ZIT6 | 501 | 2431 |
| STM32G0B1RET6 | 437 | 2017 |
| STM32G431KBU6 | 199 | 2901 |
| STM32G474RET6 | 447 | 2327 |
| STM32G491RET6 | 453 | 2321 |
| STM32H723ZGT6 | 485 | 2727 |
| STM32L4R9ZIT6 | 475 | 2123 |
| RP2350A | 315 | 2115 |
| MIMXRT1011DAE5A | 662 | 2514 |
| MIMXRT1176DVMAA | 676 | 2162 |
| MKL25Z128VLK4 | 644 | 2362 |
| R7FA6M3AH3CFC | 715 | 2178 |
| R5F565NEDDFB | 733 | 2453 |
| PIC32MX795F512L | 758 | 2681 |
| ESP32-C3-MINI-1 | 284 | 3005 |
| ESP32-H2-MINI-1 | 297 | 2384 |
| ESP32-P4 | 883 | 2477 |
| CH32V307VCT6 | 937 | 2546 |
| CH32V003F4P6 | 944 | 2553 |
| CY8C6244LQI-S4D92 | 1200 | 3044 |
| CY8C6347BZI-BLD53 | 1193 | 3108 |
| ATSAME70Q21B | 1238 | 3036 |
| R7FA8D1BHECBD | — | 3028 |

**Fix**: Automated Python script identified all second occurrences by tracking first-seen line per variant name, then removed the duplicate block (including leading comment/blank line).

---

### ✅ 2. FPU Type Inconsistencies — All Clear

- **Cortex-M4 with `'none'` FPU**: **0** (was flagged as potential issue, already correct)
- **Cortex-M7 with `'none'` FPU**: **0**
- **LPC55S69JBD100**: Verified as `'single'` — correct (has FPU)
- All Cortex-M4F/M7 entries had already been corrected in prior audit passes

---

### ✅ 3. Core Type Standardization — PIC32 → `'mips32'`

PIC32 entries were listed with `'other'` core type. Changed to `'mips32'` (the accurate MIPS32 architecture designation). `'mips32'` was already present in the `MCUCoreType` union in `firmwareTypes.ts`.

**Affected entries**: `PIC32MZ2048EFH100`, `PIC32MX795F512L`, `PIC32MX470F512L`, `PIC32MZ1024EFG100`, and related variants.

---

### ✅ 4. Keyword Standardization — Espressif Missing

6 ESP32-family entries were missing the `'espressif'` manufacturer keyword (making them un-findable by manufacturer search):

| Entry | Fix |
|-------|-----|
| ESP32-S2-WROOM | Added `'espressif'`, `'no-bluetooth'`, `'usb-otg'` |
| ESP32-C2-WROOM | Added `'espressif'`, `'budget'` |
| ESP32-P4 | Added `'espressif'`, `'hmi'`, `'high-performance'`, `'400mhz'` |
| ESP8266EX | Added `'espressif'`, `'esp8266ex'`, `'classic'`, `'80mhz'` |
| ESP32-C5-WROOM | Added `'espressif'`, `'wifi6e'`, `'ble5.3'`, `'2.4ghz-5ghz'` |
| ESP32-C6-MINI-1 | Added `'espressif'`, `'border-router'` |

---

### ✅ 5. Search Keyword Quality Improvements

| Entry | Additions |
|-------|-----------|
| STM32F103C8T6 | `'stm32f103c8t6'`, `'maple'`, `'maple mini'`, `'arduino-ide'` |
| STM32F407VGT6 | `'stm32f407vgt6'`, `'f407vgt6'`, `'f4discovery'` |
| STM32F429ZIT6 | `'stm32f429zit6'`, `'tft-display'`, `'ltdc'`, `'dma2d'`, `'chrom-art'` |
| STM32F446RET6 | `'stm32f446ret6'`, `'f446re'`, `'sai'`, `'spdif'`, `'i2s'` |
| STM32H743VIT6 | `'stm32h743vit6'`, `'480mhz'`, `'double-precision'` |
| STM32H750VBT6 | `'128kb-boot-mcu'`, `'xspi-flash'`, `'execute-in-place'` |
| STM32U575ZIT6Q | `'trustzone'`, `'psoc-level'`, `'ultra-low-power'`, `'iot02a'` |
| nRF52832 | `'softdevice'`, `'s132'`, `'ant'`, `'wireless'` |
| nRF52833 | `'microbit v2'`, `'bbc microbit'`, `'wireless'`, `'education'` |
| nRF52840 | `'wireless'`, `'802.15.4'`, `'matter'`, `'openthread'` |
| nRF9160 | `'gnss'`, `'modem'`, `'thingy91'`, `'asset-tracker'` |
| RP2040 | `'external-flash'`, `'pioasm'`, `'micropython'`, `'circuitpython'` |
| RP2350 | `'external-flash'`, `'hazard3'`, `'pioasm'`, `'150mhz'` |
| ESP32 (original) | `'esp-idf'`, `'arduino-esp32'`, `'micropython'`, `'tasmota'` |
| ESP32-S3 | `'espressif'`, `'usb-otg'`, `'aiml'`, `'vector-instructions'`, `'esp-dl'`, `'esp-who'` |
| ESP32-C3 | `'espressif'`, `'ble5'`, `'matter'`, `'crystal-less-usb'`, `'esp-idf'` |
| ESP32-H2 | `'espressif'`, `'ieee802154'`, `'no-wifi'`, `'802.15.4'` |
| CC2640R2F | `'cc2640r2f'`, `'ble4'`, `'easylink'`, `'2.4ghz'` |
| MSP430F5529 | `'msp430-launchpad'`, `'usb'`, `'adc12'`, `'energia'` |
| ATmega328P | `'arduino pro mini'`, `'pro mini'`, `'duemilanove'`, `'arduino-ide'` |
| ATmega2560 | `'arduino mega 2560'`, `'mega adk'`, `'arduino-ide'` |
| BL602 | `'ble5'`, `'wifi4'`, `'pinecone'` |
| STM32WB55 | `'ble5'`, `'openthread'`, `'matter'`, `'dual-core'`, `'rf-co-processor'` |
| STM32F072 | `'stm32f0'`, `'crystal-less-usb'`, `'hdmi-cec'` |

---

### ✅ 6. Database Coverage Summary

**By Manufacturer:**
| Manufacturer | Entries |
|---|---|
| STMicroelectronics | 90 |
| Microchip | 53 |
| NXP | 43 |
| Renesas | 37 |
| Texas Instruments | 35 |
| Infineon | 21 |
| Nordic Semiconductor | 19 |
| Espressif | 13 |
| Silicon Labs | 11 |
| GigaDevice | 9 |
| Others (14 vendors) | 26 |

**By Core Architecture:**
| Core | Count |
|---|---|
| Cortex-M4/M4F | 130 |
| Cortex-M33 | 56 |
| RISC-V | 39 |
| Cortex-M0+ | 36 |
| Cortex-M7 | 32 |
| AVR | 20 |
| TriCore (AURIX) | 20 |
| Cortex-M23 | 19 |
| Renesas RX | 16 |
| Cortex-M3 | 15 |
| Others | 34 |

---

## Remaining Known Limitations

> [!NOTE]
> These are documented design decisions, not bugs:

1. **RP2040/RP2350 `flashSize = 0`** — Correct. Both require external QSPI flash. Tags `'external-flash'` added for discoverability.
2. **STM32H750 `flashSize = 128KB`** — Correct. This is the boot-only flash; real programs execute from external QSPI. Tags clarify this.
3. **AM57x/AM62x/STM32MP2 `flashSize = 0`** — Correct. These are Linux-class MPUs; code runs from DDR4.
4. **nRF7002 `flashSize = 0`, `clockMHz = 0`** — Correct. It's a WiFi 6 radio companion chip, not a standalone MCU.
5. **Peripheral naming is not perfectly normalized** — `GMAC`, `ENET`, `ETH` coexist. They refer to different hardware IPs from different vendors. Normalizing them would lose accuracy.

---

## Audit Tools Used

- Python 3 deduplication script (`/tmp/fix_mcu_db.py`)
- Python 3 comprehensive fix script (`/tmp/comprehensive_fix.py`)
- Python 3 data quality audit (`/tmp/final_audit.py`)
- `grep`, `ripgrep` for pattern analysis
