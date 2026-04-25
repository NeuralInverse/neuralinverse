/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MCU Database
 *
 * Pre-indexed hardware specifications for 357+ popular MCU variants across
 * STM32, Nordic, ESP32, RP2040, NXP, Microchip, TI C2000, AURIX, Renesas, Kinetis, and RISC-V families.
 *
 * Each entry contains complete hardware specs: core, clock, flash, RAM,
 * peripherals, memory map, FPU/MPU/DSP capabilities, common boards,
 * and search keywords for fuzzy matching.
 *
 * This enables zero-config session start: detect MCU from project files \u2192
 * look up in database \u2192 auto-populate session with full hardware context.
 */

import { IMCUDatabaseEntry, IMemoryRegion, MCUCoreType } from './firmwareTypes.js';


// ─── Helper: build memory map ────────────────────────────────────────────────

function mem(name: string, baseAddress: number, size: number, access: IMemoryRegion['access'] = 'read-write'): IMemoryRegion {
	return { name, baseAddress, size, access };
}

/** Common STM32 peripheral list by category. */
const STM32_COMMON_PERIPHS = ['GPIO', 'USART', 'SPI', 'I2C', 'TIM', 'ADC', 'DAC', 'DMA', 'RCC', 'EXTI', 'NVIC', 'SYSCFG', 'PWR', 'RTC', 'IWDG', 'WWDG'];
const STM32_ADVANCED_PERIPHS = [...STM32_COMMON_PERIPHS, 'USB_OTG', 'CAN', 'SDIO', 'ETHERNET', 'DCMI', 'RNG', 'HASH', 'CRYP', 'FSMC'];
const NORDIC_COMMON_PERIPHS = ['GPIO', 'UARTE', 'SPIM', 'TWIM', 'TIMER', 'SAADC', 'PWM', 'RTC', 'WDT', 'NVMC', 'RADIO', 'CLOCK', 'POWER', 'GPIOTE', 'PPI'];
const ESP_COMMON_PERIPHS = ['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'DAC', 'RMT', 'LEDC', 'MCPWM', 'PCNT', 'WiFi', 'BT', 'RNG', 'RTC', 'WDT'];


// ─── Database entries ────────────────────────────────────────────────────────

function e(
	variant: string, family: string, subfamily: string, manufacturer: string,
	core: MCUCoreType, clockMHz: number, flashSize: number, ramSize: number,
	fpu: IMCUDatabaseEntry['fpu'], hasMPU: boolean, hasDSP: boolean,
	gpioCount: number, peripherals: string[], memoryMap: IMemoryRegion[],
	commonBoards: string[], searchKeywords: string[],
	extras?: Partial<IMCUDatabaseEntry>,
): IMCUDatabaseEntry {
	return {
		variant, family, subfamily, manufacturer, core, clockMHz, flashSize, ramSize,
		fpu, hasMPU, hasDSP, gpioCount, peripherals, memoryMap,
		commonBoards, searchKeywords: [variant, family, subfamily, manufacturer, ...commonBoards, ...searchKeywords],
		...extras,
	};
}


export const MCU_DATABASE: IMCUDatabaseEntry[] = [

	// ═══════════════════════════════════════════════════════════════════════
	// STM32F0 — Cortex-M0
	// ═══════════════════════════════════════════════════════════════════════

	e('STM32F030F4P6', 'STM32F0', 'STM32F030', 'STMicroelectronics',
		'cortex-m0', 48, 16 * 1024, 4 * 1024, 'none', false, false, 15,
		STM32_COMMON_PERIPHS, [mem('FLASH', 0x08000000, 16 * 1024, 'read-only'), mem('SRAM', 0x20000000, 4 * 1024)],
		[], ['f030', 'stm32f030']),

	e('STM32F072RBT6', 'STM32F0', 'STM32F072', 'STMicroelectronics',
		'cortex-m0', 48, 128 * 1024, 16 * 1024, 'none', false, false, 51,
		[...STM32_COMMON_PERIPHS, 'USB', 'CAN', 'CEC'],
		[mem('FLASH', 0x08000000, 128 * 1024, 'read-only'), mem('SRAM', 0x20000000, 16 * 1024)],
		['NUCLEO-F072RB', 'STM32F072B-Discovery'], ['f072', 'stm32f072', 'stm32f0', 'usb', 'can', 'hdmi-cec', 'crystal-less-usb']),

	// ═══════════════════════════════════════════════════════════════════════
	// STM32F1 — Cortex-M3
	// ═══════════════════════════════════════════════════════════════════════

	e('STM32F103C8T6', 'STM32F1', 'STM32F103', 'STMicroelectronics',
		'cortex-m3', 72, 64 * 1024, 20 * 1024, 'none', false, false, 37,
		STM32_COMMON_PERIPHS,
		[mem('FLASH', 0x08000000, 64 * 1024, 'read-only'), mem('SRAM', 0x20000000, 20 * 1024)],
		['Blue Pill', 'Maple Mini'], ['bluepill', 'blue pill', 'f103', 'stm32f103', 'f103c8', 'stm32f103c8t6', 'maple', 'maple mini', 'arduino-ide']),

	e('STM32F103RET6', 'STM32F1', 'STM32F103', 'STMicroelectronics',
		'cortex-m3', 72, 512 * 1024, 64 * 1024, 'none', false, false, 51,
		[...STM32_COMMON_PERIPHS, 'FSMC', 'SDIO'],
		[mem('FLASH', 0x08000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 64 * 1024)],
		[], ['f103re', 'stm32f103re']),

	// ═══════════════════════════════════════════════════════════════════════
	// STM32F4 — Cortex-M4F (most popular family)
	// ═══════════════════════════════════════════════════════════════════════

	e('STM32F401CCU6', 'STM32F4', 'STM32F401', 'STMicroelectronics',
		'cortex-m4', 84, 256 * 1024, 64 * 1024, 'single', true, true, 36,
		STM32_COMMON_PERIPHS,
		[mem('FLASH', 0x08000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 64 * 1024)],
		['Black Pill', 'WeAct Studio'], ['blackpill', 'black pill', 'f401', 'stm32f401']),

	e('STM32F401RET6', 'STM32F4', 'STM32F401', 'STMicroelectronics',
		'cortex-m4', 84, 512 * 1024, 96 * 1024, 'single', true, true, 51,
		STM32_COMMON_PERIPHS,
		[mem('FLASH', 0x08000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 96 * 1024)],
		['NUCLEO-F401RE'], ['f401re', 'nucleo-f401']),

	e('STM32F407VGT6', 'STM32F4', 'STM32F407', 'STMicroelectronics',
		'cortex-m4', 168, 1024 * 1024, 192 * 1024, 'single', true, true, 82,
		STM32_ADVANCED_PERIPHS,
		[
			mem('FLASH', 0x08000000, 1024 * 1024, 'read-only'),
			mem('SRAM1', 0x20000000, 112 * 1024),
			mem('SRAM2', 0x2001C000, 16 * 1024),
			mem('CCM', 0x10000000, 64 * 1024),
		],
		['STM32F4DISCOVERY', 'STM32F407G-DISC1'], ['f407', 'stm32f407', 'stm32f407vgt6', 'discovery', 'f407vg', 'f407vgt6', 'f4discovery']),

	e('STM32F411CEU6', 'STM32F4', 'STM32F411', 'STMicroelectronics',
		'cortex-m4', 100, 512 * 1024, 128 * 1024, 'single', true, true, 36,
		STM32_COMMON_PERIPHS,
		[mem('FLASH', 0x08000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 128 * 1024)],
		['Black Pill V3'], ['blackpill v3', 'f411', 'stm32f411']),

	e('STM32F429ZIT6', 'STM32F4', 'STM32F429', 'STMicroelectronics',
		'cortex-m4', 180, 2048 * 1024, 256 * 1024, 'single', true, true, 114,
		[...STM32_ADVANCED_PERIPHS, 'LTDC', 'FMC', 'SAI'],
		[
			mem('FLASH', 0x08000000, 2048 * 1024, 'read-only'),
			mem('SRAM1', 0x20000000, 112 * 1024),
			mem('SRAM2', 0x2001C000, 16 * 1024),
			mem('SRAM3', 0x20020000, 64 * 1024),
			mem('CCM', 0x10000000, 64 * 1024),
		],
		['STM32F429I-DISC1', '32F429IDISCOVERY'], ['f429', 'stm32f429', 'stm32f429zit6', 'tft-display', 'ltdc', 'dma2d', 'chrom-art']),

	e('STM32F446RET6', 'STM32F4', 'STM32F446', 'STMicroelectronics',
		'cortex-m4', 180, 512 * 1024, 128 * 1024, 'single', true, true, 51,
		[...STM32_COMMON_PERIPHS, 'USB_OTG', 'CAN', 'SAI', 'QUADSPI'],
		[mem('FLASH', 0x08000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 128 * 1024)],
		['NUCLEO-F446RE'], ['f446', 'stm32f446', 'stm32f446ret6', 'f446re', 'sai', 'spdif', 'i2s']),

	// ═══════════════════════════════════════════════════════════════════════
	// STM32F7 — Cortex-M7
	// ═══════════════════════════════════════════════════════════════════════

	e('STM32F746NGH6', 'STM32F7', 'STM32F746', 'STMicroelectronics',
		'cortex-m7', 216, 1024 * 1024, 320 * 1024, 'single', true, true, 114,
		[...STM32_ADVANCED_PERIPHS, 'LTDC', 'FMC', 'SAI', 'QUADSPI', 'JPEG'],
		[
			mem('FLASH', 0x08000000, 1024 * 1024, 'read-only'),
			mem('ITCM', 0x00000000, 16 * 1024),
			mem('DTCM', 0x20000000, 64 * 1024),
			mem('SRAM1', 0x20010000, 240 * 1024),
			mem('SRAM2', 0x2004C000, 16 * 1024),
		],
		['STM32F746G-DISCO', '32F746GDISCOVERY'], ['f746', 'stm32f746', 'stm32f7']),

	// ═══════════════════════════════════════════════════════════════════════
	// STM32H7 — Cortex-M7 (dual-core variants)
	// ═══════════════════════════════════════════════════════════════════════

	e('STM32H743VIT6', 'STM32H7', 'STM32H743', 'STMicroelectronics',
		'cortex-m7', 480, 2048 * 1024, 1024 * 1024, 'double', true, true, 82,
		[...STM32_ADVANCED_PERIPHS, 'LTDC', 'FMC', 'SAI', 'QUADSPI', 'JPEG', 'MDMA', 'BDMA'],
		[
			mem('FLASH', 0x08000000, 2048 * 1024, 'read-only'),
			mem('ITCM', 0x00000000, 64 * 1024),
			mem('DTCM', 0x20000000, 128 * 1024),
			mem('AXI_SRAM', 0x24000000, 512 * 1024),
			mem('SRAM1', 0x30000000, 128 * 1024),
			mem('SRAM2', 0x30020000, 128 * 1024),
			mem('SRAM3', 0x30040000, 32 * 1024),
			mem('SRAM4', 0x38000000, 64 * 1024),
			mem('BACKUP_SRAM', 0x38800000, 4 * 1024),
		],
		['NUCLEO-H743ZI', 'STM32H743I-EVAL'], ['h743', 'stm32h743', 'stm32h7', 'stm32h743vit6', '480mhz', 'double-precision', 'ethercat-ready']),

	e('STM32H750VBT6', 'STM32H7', 'STM32H750', 'STMicroelectronics',
		'cortex-m7', 480, 128 * 1024, 1024 * 1024, 'double', true, true, 82,
		[...STM32_ADVANCED_PERIPHS, 'LTDC', 'FMC', 'SAI', 'QUADSPI', 'JPEG', 'MDMA'],
		[
			mem('FLASH', 0x08000000, 128 * 1024, 'read-only'),
			mem('DTCM', 0x20000000, 128 * 1024),
			mem('AXI_SRAM', 0x24000000, 512 * 1024),
		],
		['WeAct H750', 'DevEBox H750'], ['h750', 'stm32h750', '128kb-boot-mcu', 'xspi-flash', 'execute-in-place']),

	// ═══════════════════════════════════════════════════════════════════════
	// STM32L4 — Ultra-low-power Cortex-M4
	// ═══════════════════════════════════════════════════════════════════════

	e('STM32L476RGT6', 'STM32L4', 'STM32L476', 'STMicroelectronics',
		'cortex-m4', 80, 1024 * 1024, 128 * 1024, 'single', true, true, 51,
		[...STM32_COMMON_PERIPHS, 'USB_OTG', 'CAN', 'SAI', 'QUADSPI', 'LCD', 'TSC', 'OPAMP', 'COMP'],
		[mem('FLASH', 0x08000000, 1024 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 96 * 1024), mem('SRAM2', 0x10000000, 32 * 1024)],
		['NUCLEO-L476RG', 'STM32L476G-DISCO'], ['l476', 'stm32l476', 'stm32l4']),

	// ═══════════════════════════════════════════════════════════════════════
	// STM32G4 — Mixed-signal Cortex-M4
	// ═══════════════════════════════════════════════════════════════════════

	e('STM32G431KBU6', 'STM32G4', 'STM32G431', 'STMicroelectronics',
		'cortex-m4', 170, 128 * 1024, 32 * 1024, 'single', true, true, 25,
		[...STM32_COMMON_PERIPHS, 'FDCAN', 'OPAMP', 'COMP', 'CORDIC', 'FMAC'],
		[mem('FLASH', 0x08000000, 128 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['NUCLEO-G431KB', 'B-G431B-ESC1'], ['g431', 'stm32g431', 'stm32g4']),

	// ═══════════════════════════════════════════════════════════════════════
	// STM32U5 — Ultra-low-power Cortex-M33 with TrustZone
	// ═══════════════════════════════════════════════════════════════════════

	e('STM32U575ZIT6Q', 'STM32U5', 'STM32U575', 'STMicroelectronics',
		'cortex-m33', 160, 2048 * 1024, 786 * 1024, 'single', true, true, 114,
		[...STM32_COMMON_PERIPHS, 'USB_OTG', 'FDCAN', 'OCTOSPI', 'SAI', 'ADF', 'GFXTIM', 'HASH', 'AES'],
		[
			mem('FLASH', 0x08000000, 2048 * 1024, 'read-only'),
			mem('SRAM1', 0x20000000, 192 * 1024),
			mem('SRAM2', 0x20030000, 64 * 1024),
			mem('SRAM3', 0x20040000, 512 * 1024),
			mem('SRAM4', 0x28000000, 16 * 1024),
		],
		['NUCLEO-U575ZI-Q', 'B-U585I-IOT02A'], ['u575', 'stm32u575', 'stm32u5', 'trustzone', 'psoc-level', 'ultra-low-power', 'iot02a']),

	// ═══════════════════════════════════════════════════════════════════════
	// Nordic Semiconductor — nRF52 Series
	// ═══════════════════════════════════════════════════════════════════════

	e('nRF52832-QIAA', 'nRF52', 'nRF52832', 'Nordic Semiconductor',
		'cortex-m4', 64, 512 * 1024, 64 * 1024, 'single', true, false, 32,
		NORDIC_COMMON_PERIPHS,
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('RAM', 0x20000000, 64 * 1024)],
		['nRF52-DK', 'PCA10040', 'Adafruit Feather nRF52832'],
		['nrf52832', 'nrf52', 'ble', 'bluetooth', 'softdevice', 's132', 'ant', 'wireless']),

	e('nRF52840-QIAA', 'nRF52', 'nRF52840', 'Nordic Semiconductor',
		'cortex-m4', 64, 1024 * 1024, 256 * 1024, 'single', true, false, 48,
		[...NORDIC_COMMON_PERIPHS, 'QSPI', 'USB', 'NFCT', 'CRYPTOCELL'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('RAM', 0x20000000, 256 * 1024)],
		['nRF52840-DK', 'PCA10056', 'Adafruit Feather nRF52840', 'Particle Xenon', 'Arduino Nano 33 BLE'],
		['nrf52840', 'nrf52', 'ble', 'bluetooth', 'usb', 'thread', 'zigbee', 'wireless', '802.15.4', 'matter', 'openthread']),

	e('nRF52833-QIAA', 'nRF52', 'nRF52833', 'Nordic Semiconductor',
		'cortex-m4', 64, 512 * 1024, 128 * 1024, 'single', true, false, 42,
		[...NORDIC_COMMON_PERIPHS, 'USB'],
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('RAM', 0x20000000, 128 * 1024)],
		['nRF52833-DK', 'PCA10100', 'micro:bit v2'],
		['nrf52833', 'microbit', 'microbit v2', 'bbc microbit', 'ble', 'bluetooth', 'wireless', 'education']),

	// ═══════════════════════════════════════════════════════════════════════
	// Nordic Semiconductor — nRF53 / nRF91
	// ═══════════════════════════════════════════════════════════════════════

	e('nRF5340-QKAA', 'nRF53', 'nRF5340', 'Nordic Semiconductor',
		'cortex-m33', 128, 1024 * 1024, 512 * 1024, 'single', true, true, 48,
		[...NORDIC_COMMON_PERIPHS, 'USB', 'QSPI', 'NFCT', 'CRYPTOCELL', 'IPC'],
		[mem('APP_FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('APP_RAM', 0x20000000, 512 * 1024),
		mem('NET_FLASH', 0x01000000, 256 * 1024, 'read-only'), mem('NET_RAM', 0x21000000, 64 * 1024)],
		['nRF5340-DK', 'PCA10095', 'Thingy:53'],
		['nrf5340', 'nrf53', 'dual-core', 'ble', 'bluetooth 5.3']),

	e('nRF9160-SICA', 'nRF91', 'nRF9160', 'Nordic Semiconductor',
		'cortex-m33', 64, 1024 * 1024, 256 * 1024, 'single', true, true, 32,
		['GPIO', 'UARTE', 'SPIM', 'TWIM', 'TIMER', 'SAADC', 'PWM', 'RTC', 'WDT', 'MODEM', 'GPS'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('RAM', 0x20000000, 256 * 1024)],
		['nRF9160-DK', 'PCA10090', 'Thingy:91'],
		['nrf9160', 'nrf91', 'lte-m', 'nb-iot', 'cellular', 'gps', 'gnss', 'modem', 'thingy91', 'asset-tracker']),

	// ═══════════════════════════════════════════════════════════════════════
	// Espressif — ESP32 Family
	// ═══════════════════════════════════════════════════════════════════════

	e('ESP32-D0WDQ6', 'ESP32', 'ESP32', 'Espressif',
		'xtensa', 240, 4 * 1024 * 1024, 520 * 1024, 'none', false, false, 34,
		ESP_COMMON_PERIPHS,
		[mem('IROM', 0x400D0000, 3 * 1024 * 1024, 'read-only'), mem('DROM', 0x3F400000, 1024 * 1024, 'read-only'),
		mem('IRAM', 0x40080000, 128 * 1024), mem('DRAM', 0x3FFAE000, 328 * 1024)],
		['ESP32-DevKitC', 'ESP32-WROVER', 'ESP32-WROOM-32', 'NodeMCU-32S', 'Adafruit HUZZAH32'],
		['esp32', 'espressif', 'wifi', 'bluetooth', 'dual-core', 'wroom', 'wrover', 'esp-idf', 'arduino-esp32', 'micropython', 'tasmota']),

	e('ESP32-S3-WROOM-1', 'ESP32', 'ESP32-S3', 'Espressif',
		'xtensa', 240, 8 * 1024 * 1024, 512 * 1024, 'none', false, false, 45,
		[...ESP_COMMON_PERIPHS, 'USB_OTG', 'LCD_CAM', 'TWAI'],
		[mem('IROM', 0x42000000, 8 * 1024 * 1024, 'read-only'), mem('IRAM', 0x40370000, 512 * 1024)],
		['ESP32-S3-DevKitC', 'ESP32-S3-WROOM-1', 'Adafruit Feather ESP32-S3'],
		['esp32s3', 'esp32-s3', 'usb', 'ai', 'camera', 'wifi6', 'espressif']),


	e('ESP32-C3-MINI-1', 'ESP32', 'ESP32-C3', 'Espressif',
		'risc-v', 160, 4 * 1024 * 1024, 400 * 1024, 'none', false, false, 22,
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'RMT', 'LEDC', 'WiFi', 'BT', 'RNG', 'WDT', 'TWAI'],
		[mem('IROM', 0x42000000, 4 * 1024 * 1024, 'read-only'), mem('IRAM', 0x40380000, 400 * 1024)],
		['ESP32-C3-DevKitM', 'Seeed XIAO ESP32C3', 'Adafruit QT Py ESP32-C3'],
		['esp32c3', 'esp32-c3', 'risc-v', 'wifi', 'bluetooth', 'espressif']),


	e('ESP32-C6-WROOM-1', 'ESP32', 'ESP32-C6', 'Espressif',
		'risc-v', 160, 4 * 1024 * 1024, 512 * 1024, 'none', false, false, 30,
		[...ESP_COMMON_PERIPHS, 'TWAI', 'USB_SERIAL_JTAG', 'IEEE802154'],
		[mem('IROM', 0x42000000, 4 * 1024 * 1024, 'read-only'), mem('IRAM', 0x40800000, 512 * 1024)],
		['ESP32-C6-DevKitC'], ['esp32c6', 'esp32-c6', 'wifi6', 'thread', 'zigbee', 'matter', 'espressif']),


	e('ESP32-H2-MINI-1', 'ESP32', 'ESP32-H2', 'Espressif',
		'risc-v', 96, 4 * 1024 * 1024, 320 * 1024, 'none', false, false, 27,
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'RMT', 'LEDC', 'BT', 'IEEE802154', 'WDT'],
		[mem('IROM', 0x42000000, 4 * 1024 * 1024, 'read-only'), mem('IRAM', 0x40800000, 320 * 1024)],
		['ESP32-H2-DevKitM'], ['esp32h2', 'esp32-h2', 'thread', 'zigbee', 'matter', 'ble', 'espressif']),


	// ═══════════════════════════════════════════════════════════════════════
	// Raspberry Pi — RP2040/RP2350
	// ═══════════════════════════════════════════════════════════════════════

	e('RP2040', 'RP2040', 'RP2040', 'Raspberry Pi',
		'cortex-m0+', 133, 0, 264 * 1024, 'none', false, false, 30, // External flash
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'PWM', 'PIO', 'USB', 'DMA', 'RTC', 'WDT'],
		[mem('ROM', 0x00000000, 16 * 1024, 'read-only'), mem('XIP_FLASH', 0x10000000, 16 * 1024 * 1024),
		mem('SRAM', 0x20000000, 264 * 1024)],
		['Raspberry Pi Pico', 'Pico W', 'Adafruit Feather RP2040', 'Seeed XIAO RP2040', 'Arduino Nano RP2040 Connect'],
		['rp2040', 'pico', 'raspberry pi pico', 'pio', 'dual-core', 'external-flash', 'pioasm', 'micropython', 'circuitpython']),

	e('RP2350A', 'RP2350', 'RP2350', 'Raspberry Pi',
		'cortex-m33', 150, 0, 520 * 1024, 'single', true, true, 30,
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'PWM', 'PIO', 'USB', 'DMA', 'RTC', 'WDT', 'HSTX'],
		[mem('ROM', 0x00000000, 32 * 1024, 'read-only'), mem('XIP_FLASH', 0x10000000, 16 * 1024 * 1024),
		mem('SRAM', 0x20000000, 520 * 1024)],
		['Raspberry Pi Pico 2', 'Pico 2 W'],
		['rp2350', 'pico 2', 'raspberry pi pico 2', 'trustzone', 'risc-v', 'external-flash', 'hazard3', 'pioasm', '150mhz']),

	// ═══════════════════════════════════════════════════════════════════════
	// NXP — i.MX RT, LPC, Kinetis
	// ═══════════════════════════════════════════════════════════════════════

	e('MIMXRT1062DVL6A', 'i.MX RT', 'i.MX RT1060', 'NXP',
		'cortex-m7', 600, 0, 1024 * 1024, 'double', true, true, 124,
		['GPIO', 'LPUART', 'LPSPI', 'LPI2C', 'GPT', 'PIT', 'ADC', 'DAC', 'USB', 'ENET', 'CAN', 'SEMC', 'CSI', 'LCDIF', 'DMA'],
		[mem('ITCM', 0x00000000, 512 * 1024), mem('DTCM', 0x20000000, 512 * 1024), mem('OCRAM', 0x20200000, 512 * 1024)],
		['MIMXRT1060-EVK', 'Teensy 4.1', 'Teensy 4.0'],
		['imxrt1060', 'imxrt', 'teensy', 'teensy 4.1', 'nxp', 'crossover']),

	e('LPC55S69JBD100', 'LPC55', 'LPC55S69', 'NXP',
		'cortex-m33', 150, 640 * 1024, 320 * 1024, 'single', true, true, 64,
		['GPIO', 'FLEXCOMM', 'CTIMER', 'ADC', 'DAC', 'USB', 'SDIO', 'CAN', 'DMA', 'RNG', 'HASH', 'CASPER'],
		[mem('FLASH', 0x00000000, 640 * 1024, 'read-only'), mem('SRAM', 0x20000000, 320 * 1024)],
		['LPCXpresso55S69'],
		['lpc55s69', 'lpc55', 'nxp', 'trustzone', 'dual-core']),

	// ═══════════════════════════════════════════════════════════════════════
	// Microchip — SAM, PIC32, AVR
	// ═══════════════════════════════════════════════════════════════════════

	e('ATSAMD21G18A', 'SAM D21', 'SAMD21', 'Microchip',
		'cortex-m0+', 48, 256 * 1024, 32 * 1024, 'none', false, false, 38,
		['GPIO', 'SERCOM', 'TC', 'TCC', 'ADC', 'DAC', 'USB', 'DMAC', 'RTC', 'WDT', 'EIC', 'EVSYS'],
		[mem('FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['Arduino Zero', 'Adafruit Feather M0', 'Seeed XIAO SAMD21', 'SparkFun SAMD21'],
		['samd21', 'sam d21', 'arduino zero', 'feather m0', 'atmel']),

	e('ATSAME51J20A', 'SAM E51', 'SAME51', 'Microchip',
		'cortex-m4', 120, 1024 * 1024, 256 * 1024, 'single', true, true, 51,
		['GPIO', 'SERCOM', 'TC', 'TCC', 'ADC', 'DAC', 'USB', 'CAN', 'DMAC', 'QSPI', 'I2S', 'RTC'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 256 * 1024)],
		['Adafruit Grand Central M4', 'Adafruit Metro M4'],
		['same51', 'sam e51', 'grand central', 'atmel']),

	e('ATmega328P', 'AVR', 'ATmega328', 'Microchip',
		'avr', 20, 32 * 1024, 2 * 1024, 'none', false, false, 23,
		['GPIO', 'USART', 'SPI', 'TWI', 'TIMER', 'ADC', 'WDT', 'EEPROM'],
		[mem('FLASH', 0x0000, 32 * 1024, 'read-only'), mem('SRAM', 0x0100, 2 * 1024), mem('EEPROM', 0x0000, 1024)],
		['Arduino Uno', 'Arduino Nano', 'Arduino Pro Mini'],
		['atmega328p', 'atmega328', 'avr', 'arduino uno', 'arduino nano', 'arduino pro mini', 'pro mini', 'duemilanove', '8-bit', 'arduino-ide']),

	e('ATmega2560', 'AVR', 'ATmega2560', 'Microchip',
		'avr', 16, 256 * 1024, 8 * 1024, 'none', false, false, 86,
		['GPIO', 'USART', 'SPI', 'TWI', 'TIMER', 'ADC', 'WDT', 'EEPROM'],
		[mem('FLASH', 0x0000, 256 * 1024, 'read-only'), mem('SRAM', 0x0200, 8 * 1024), mem('EEPROM', 0x0000, 4096)],
		['Arduino Mega 2560'],
		['atmega2560', 'avr', 'arduino mega', 'arduino mega 2560', 'mega adk', '8-bit', 'arduino-ide']),

	// ═══════════════════════════════════════════════════════════════════════
	// Texas Instruments — MSP430, CC series
	// ═══════════════════════════════════════════════════════════════════════

	e('MSP430F5529', 'MSP430', 'MSP430F5529', 'Texas Instruments',
		'msp430', 25, 128 * 1024, 8 * 1024, 'none', false, false, 63,
		['GPIO', 'USCI_A', 'USCI_B', 'TIMER_A', 'TIMER_B', 'ADC12A', 'USB', 'DMA', 'RTC', 'WDT'],
		[mem('FLASH', 0x4400, 128 * 1024, 'read-only'), mem('RAM', 0x2400, 8 * 1024)],
		['MSP-EXP430F5529LP'],
		['msp430f5529', 'msp430', 'launchpad', 'msp430-launchpad', 'ti', 'ultra-low-power', 'usb', 'adc12', 'energia']),

	e('CC2640R2F', 'CC26xx', 'CC2640R2', 'Texas Instruments',
		'cortex-m3', 48, 128 * 1024, 20 * 1024, 'none', false, false, 31,
		['GPIO', 'UART', 'SSI', 'I2C', 'TIMER', 'ADC', 'AES', 'TRNG', 'RF_CORE', 'WDT'],
		[mem('FLASH', 0x00000000, 128 * 1024, 'read-only'), mem('SRAM', 0x20000000, 20 * 1024)],
		['LAUNCHXL-CC2640R2', 'CC2640R2F-LaunchPad'],
		['cc2640', 'cc2640r2f', 'ble4', 'bluetooth', 'ti', 'simplelink', 'easylink', '2.4ghz']),

	// ═══════════════════════════════════════════════════════════════════════
	// RISC-V — GD32VF, BL602
	// ═══════════════════════════════════════════════════════════════════════

	e('GD32VF103CBT6', 'GD32VF', 'GD32VF103', 'GigaDevice',
		'risc-v', 108, 128 * 1024, 32 * 1024, 'none', false, false, 37,
		['GPIO', 'USART', 'SPI', 'I2C', 'TIMER', 'ADC', 'DAC', 'USB', 'CAN', 'DMA', 'RTC', 'WDT'],
		[mem('FLASH', 0x08000000, 128 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['Sipeed Longan Nano', 'GD32VF103-EVAL'],
		['gd32vf103', 'gd32vf', 'risc-v', 'gigadevice', 'longan nano']),

	e('BL602', 'BL602', 'BL602', 'Bouffalo Lab',
		'risc-v', 192, 128 * 1024, 276 * 1024, 'single', false, false, 16,
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'DAC', 'PWM', 'WiFi', 'BT', 'DMA', 'RTC'],
		[mem('FLASH', 0x23000000, 128 * 1024, 'read-only'), mem('RAM', 0x42010000, 276 * 1024)],
		['Ai-Thinker Ai-WB2', 'Pine64 PineCone'],
		['bl602', 'bouffalo', 'risc-v', 'wifi4', 'bluetooth', 'ble5', 'rtos', 'pinecone']),

	// ═══════════════════════════════════════════════════════════════════════
	// STM32 WB / WL — Wireless MCUs
	// ═══════════════════════════════════════════════════════════════════════

	e('STM32WB55RGV6', 'STM32WB', 'STM32WB55', 'STMicroelectronics',
		'cortex-m4', 64, 1024 * 1024, 256 * 1024, 'single', true, true, 48,
		[...STM32_COMMON_PERIPHS, 'USB', 'QUADSPI', 'SAI', 'AES', 'RNG', 'RF_CORE'],
		[mem('FLASH', 0x08000000, 1024 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 192 * 1024), mem('SRAM2', 0x20030000, 64 * 1024)],
		['NUCLEO-WB55RG', 'P-NUCLEO-WB55'],
		['stm32wb55', 'stm32wb', 'ble5', 'bluetooth', 'thread', 'zigbee', 'openthread', 'matter', 'dual-core', 'rf-co-processor']),

	e('STM32WLE5JCI6', 'STM32WL', 'STM32WLE5', 'STMicroelectronics',
		'cortex-m4', 48, 256 * 1024, 64 * 1024, 'single', true, false, 43,
		[...STM32_COMMON_PERIPHS, 'SUBGHZ_RADIO', 'AES', 'RNG'],
		[mem('FLASH', 0x08000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 64 * 1024)],
		['NUCLEO-WL55JC', 'Seeed LoRa-E5'],
		['stm32wle5', 'stm32wl', 'lora', 'lorawan', 'sub-ghz']),

	// ═══════════════════════════════════════════════════════════════════════
	// STM32G0 — Value Line Cortex-M0+
	// ═══════════════════════════════════════════════════════════════════════

	e('STM32G071RBT6', 'STM32G0', 'STM32G071', 'STMicroelectronics',
		'cortex-m0+', 64, 128 * 1024, 36 * 1024, 'none', false, false, 51,
		[...STM32_COMMON_PERIPHS, 'FDCAN', 'USB_PD', 'CEC'],
		[mem('FLASH', 0x08000000, 128 * 1024, 'read-only'), mem('SRAM', 0x20000000, 36 * 1024)],
		['NUCLEO-G071RB'], ['g071', 'stm32g071', 'stm32g0']),

	e('STM32G0B1RET6', 'STM32G0', 'STM32G0B1', 'STMicroelectronics',
		'cortex-m0+', 64, 512 * 1024, 144 * 1024, 'none', false, false, 51,
		[...STM32_COMMON_PERIPHS, 'FDCAN', 'USB_PD', 'CEC'],
		[mem('FLASH', 0x08000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 144 * 1024)],
		['NUCLEO-G0B1RE'], ['g0b1', 'stm32g0b1', 'stm32g0']),

	// ═══════════════════════════════════════════════════════════════════════
	// STM32G4 — Mixed-signal Cortex-M4 (motor control / BLDC)
	// ═══════════════════════════════════════════════════════════════════════

	e('STM32G474RET6', 'STM32G4', 'STM32G474', 'STMicroelectronics',
		'cortex-m4', 170, 512 * 1024, 128 * 1024, 'single', true, true, 51,
		[...STM32_COMMON_PERIPHS, 'FDCAN', 'HRTIM', 'OPAMP', 'COMP', 'CORDIC', 'FMAC', 'DAC', 'ADC5'],
		[mem('FLASH', 0x08000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 128 * 1024)],
		['NUCLEO-G474RE', 'B-G474E-DPOW1'], ['g474', 'stm32g474', 'stm32g4', 'motor control', 'hrtim']),

	e('STM32G491RET6', 'STM32G4', 'STM32G491', 'STMicroelectronics',
		'cortex-m4', 170, 512 * 1024, 112 * 1024, 'single', true, true, 51,
		[...STM32_COMMON_PERIPHS, 'FDCAN', 'OPAMP', 'COMP', 'CORDIC', 'FMAC'],
		[mem('FLASH', 0x08000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 112 * 1024)],
		['NUCLEO-G491RE'], ['g491', 'stm32g491', 'stm32g4']),

	// ═══════════════════════════════════════════════════════════════════════
	// STM32L4 extended — Ultra-low-power
	// ═══════════════════════════════════════════════════════════════════════

	e('STM32L432KCU6', 'STM32L4', 'STM32L432', 'STMicroelectronics',
		'cortex-m4', 80, 256 * 1024, 64 * 1024, 'single', true, true, 20,
		[...STM32_COMMON_PERIPHS, 'USB', 'SAI', 'OPAMP', 'COMP', 'TSC'],
		[mem('FLASH', 0x08000000, 256 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 48 * 1024), mem('SRAM2', 0x10000000, 16 * 1024)],
		['NUCLEO-L432KC'], ['l432', 'stm32l432', 'stm32l4', 'ultra-low-power']),

	e('STM32L496RGT6', 'STM32L4', 'STM32L496', 'STMicroelectronics',
		'cortex-m4', 80, 1024 * 1024, 320 * 1024, 'single', true, true, 51,
		[...STM32_COMMON_PERIPHS, 'USB_OTG', 'CAN', 'SAI', 'QUADSPI', 'LCD', 'TSC', 'OPAMP', 'COMP', 'DFSDM'],
		[mem('FLASH', 0x08000000, 1024 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 256 * 1024), mem('SRAM2', 0x10000000, 64 * 1024)],
		['NUCLEO-L496ZG'], ['l496', 'stm32l496', 'stm32l4']),

	e('STM32L4R9ZIT6', 'STM32L4+', 'STM32L4R9', 'STMicroelectronics',
		'cortex-m4', 120, 2048 * 1024, 640 * 1024, 'single', true, true, 114,
		[...STM32_COMMON_PERIPHS, 'USB_OTG', 'CAN', 'SAI', 'OCTOSPI', 'LCD', 'DSI', 'LTDC', 'TSC', 'AES', 'HASH', 'RNG'],
		[mem('FLASH', 0x08000000, 2048 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 192 * 1024), mem('SRAM2', 0x10000000, 64 * 1024), mem('SRAM3', 0x20040000, 384 * 1024)],
		['STM32L4R9I-DISCO'], ['l4r9', 'stm32l4r9', 'stm32l4+']),

	// ═══════════════════════════════════════════════════════════════════════
	// STM32H7 extended
	// ═══════════════════════════════════════════════════════════════════════

	e('STM32H723ZGT6', 'STM32H7', 'STM32H723', 'STMicroelectronics',
		'cortex-m7', 550, 1024 * 1024, 564 * 1024, 'double', true, true, 114,
		[...STM32_ADVANCED_PERIPHS, 'FMC', 'SAI', 'OCTOSPI', 'JPEG', 'MDMA', 'BDMA', 'FDCAN'],
		[mem('FLASH', 0x08000000, 1024 * 1024, 'read-only'), mem('DTCM', 0x20000000, 128 * 1024), mem('AXI_SRAM', 0x24000000, 320 * 1024)],
		['NUCLEO-H723ZG'], ['h723', 'stm32h723', 'stm32h7']),

	e('STM32H757ZIT6', 'STM32H7', 'STM32H757', 'STMicroelectronics',
		'cortex-m7', 480, 2048 * 1024, 1024 * 1024, 'double', true, true, 114,
		[...STM32_ADVANCED_PERIPHS, 'LTDC', 'FMC', 'SAI', 'QUADSPI', 'JPEG', 'MDMA', 'BDMA', 'FDCAN', 'ETHERNET'],
		[mem('FLASH', 0x08000000, 2048 * 1024, 'read-only'), mem('DTCM', 0x20000000, 128 * 1024), mem('AXI_SRAM', 0x24000000, 512 * 1024)],
		['STM32H757I-EVAL', 'STM32H747I-DISCO'], ['h757', 'stm32h757', 'stm32h7', 'dual-core']),

	// ═══════════════════════════════════════════════════════════════════════
	// STM32F7 extended
	// ═══════════════════════════════════════════════════════════════════════

	e('STM32F767ZIT6', 'STM32F7', 'STM32F767', 'STMicroelectronics',
		'cortex-m7', 216, 2048 * 1024, 512 * 1024, 'double', true, true, 114,
		[...STM32_ADVANCED_PERIPHS, 'LTDC', 'FMC', 'SAI', 'QUADSPI', 'JPEG', 'ETHERNET'],
		[mem('FLASH', 0x08000000, 2048 * 1024, 'read-only'), mem('ITCM', 0x00000000, 16 * 1024), mem('DTCM', 0x20000000, 128 * 1024), mem('SRAM1', 0x20020000, 368 * 1024)],
		['NUCLEO-F767ZI'], ['f767', 'stm32f767', 'stm32f7']),

	e('STM32F769NIT6', 'STM32F7', 'STM32F769', 'STMicroelectronics',
		'cortex-m7', 216, 2048 * 1024, 512 * 1024, 'double', true, true, 168,
		[...STM32_ADVANCED_PERIPHS, 'LTDC', 'FMC', 'DSI', 'SAI', 'QUADSPI', 'JPEG', 'ETHERNET'],
		[mem('FLASH', 0x08000000, 2048 * 1024, 'read-only'), mem('DTCM', 0x20000000, 128 * 1024), mem('SRAM1', 0x20020000, 368 * 1024)],
		['STM32F769I-DISCO'], ['f769', 'stm32f769', 'stm32f7']),

	e('STM32F722RET6', 'STM32F7', 'STM32F722', 'STMicroelectronics',
		'cortex-m7', 216, 512 * 1024, 256 * 1024, 'single', true, true, 51,
		[...STM32_COMMON_PERIPHS, 'USB_OTG', 'SAI', 'QUADSPI'],
		[mem('FLASH', 0x08000000, 512 * 1024, 'read-only'), mem('ITCM', 0x00000000, 16 * 1024), mem('DTCM', 0x20000000, 64 * 1024), mem('SRAM1', 0x20010000, 176 * 1024)],
		['NUCLEO-F722ZE'], ['f722', 'stm32f722', 'stm32f7']),

	// ═══════════════════════════════════════════════════════════════════════
	// STM32F1 extended
	// ═══════════════════════════════════════════════════════════════════════

	e('STM32F105RCT6', 'STM32F1', 'STM32F105', 'STMicroelectronics',
		'cortex-m3', 72, 256 * 1024, 64 * 1024, 'none', false, false, 51,
		[...STM32_COMMON_PERIPHS, 'USB_OTG', 'CAN', 'ETHERNET'],
		[mem('FLASH', 0x08000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 64 * 1024)],
		[], ['f105', 'stm32f105', 'connectivity line']),

	e('STM32F302R8T6', 'STM32F3', 'STM32F302', 'STMicroelectronics',
		'cortex-m4', 72, 64 * 1024, 16 * 1024, 'single', false, true, 51,
		[...STM32_COMMON_PERIPHS, 'OPAMP', 'COMP', 'HRTIM'],
		[mem('FLASH', 0x08000000, 64 * 1024, 'read-only'), mem('SRAM', 0x20000000, 16 * 1024)],
		['NUCLEO-F302R8'], ['f302', 'stm32f302', 'stm32f3']),

	e('STM32F303RET6', 'STM32F3', 'STM32F303', 'STMicroelectronics',
		'cortex-m4', 72, 512 * 1024, 80 * 1024, 'single', false, true, 51,
		[...STM32_COMMON_PERIPHS, 'OPAMP', 'COMP', 'HRTIM', 'USB'],
		[mem('FLASH', 0x08000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 80 * 1024)],
		['NUCLEO-F303RE', 'DISCO-F303VC'], ['f303', 'stm32f303', 'stm32f3']),

	// ═══════════════════════════════════════════════════════════════════════
	// TI C2000 DSP — Motor Control / Power Conversion
	// ═══════════════════════════════════════════════════════════════════════

	e('TMS320F28379D', 'C2000', 'F28379D', 'Texas Instruments',
		'c28x', 200, 1024 * 1024, 204 * 1024, 'single', false, true, 169,
		['GPIO', 'SCI', 'SPI', 'I2C', 'CAN', 'McBSP', 'ePWM', 'eCAP', 'eQEP', 'ADC', 'DAC', 'CMPSS', 'DMA', 'CLB', 'FSI'],
		[mem('FLASH', 0x080000, 1024 * 1024, 'read-only'), mem('M0_SRAM', 0x000000, 1024), mem('GSRAM', 0x00C000, 204 * 1024)],
		['LAUNCHXL-F28379D', 'TMDSCNCD28379D'],
		['f28379d', 'c2000', 'ti', 'dsp', 'piccolo', 'delfino', 'motor control', 'power electronics', 'dual-core']),

	e('TMS320F28069M', 'C2000', 'F28069M', 'Texas Instruments',
		'c28x', 90, 512 * 1024, 100 * 1024, 'single', false, true, 54,
		['GPIO', 'SCI', 'SPI', 'I2C', 'CAN', 'ePWM', 'eCAP', 'eQEP', 'ADC', 'DAC', 'CMPSS', 'DMA'],
		[mem('FLASH', 0x3E8000, 512 * 1024, 'read-only'), mem('SARAM', 0x000000, 100 * 1024)],
		['LAUNCHXL-F28069M', 'TMDSCNCD28069M'],
		['f28069m', 'f28069', 'c2000', 'piccolo', 'ti', 'motor control', 'inverter']),

	e('TMS320F28335', 'C2000', 'F28335', 'Texas Instruments',
		'c28x', 150, 512 * 1024, 68 * 1024, 'single', false, true, 88,
		['GPIO', 'SCI', 'SPI', 'I2C', 'CAN', 'McBSP', 'ePWM', 'eCAP', 'eQEP', 'ADC', 'DMA', 'XINTF'],
		[mem('FLASH', 0x300000, 512 * 1024, 'read-only'), mem('L0_SRAM', 0x008000, 4 * 1024), mem('H0_SRAM', 0x3F8000, 8 * 1024)],
		['TMS320F28335 controlCARD', 'TMDSDOCK28335'],
		['f28335', 'c2000', 'ti', 'dsp', 'real-time control']),

	e('TMS320F2802xF', 'C2000', 'F2802x', 'Texas Instruments',
		'c28x', 60, 64 * 1024, 10 * 1024, 'none', false, false, 22,
		['GPIO', 'SCI', 'SPI', 'I2C', 'ePWM', 'eCAP', 'ADC', 'CMPSS'],
		[mem('FLASH', 0x3E8000, 64 * 1024, 'read-only'), mem('SARAM', 0x000000, 10 * 1024)],
		['LAUNCHXL-F28027', 'LAUNCHXL-F28023'],
		['f2802x', 'f28027', 'f28023', 'c2000', 'piccolo', 'ti']),

	e('TMS320F28386D', 'C2000', 'F28386D', 'Texas Instruments',
		'c28x', 200, 1536 * 1024, 212 * 1024, 'single', false, true, 169,
		['GPIO', 'SCI', 'SPI', 'I2C', 'CAN', 'ePWM', 'eCAP', 'eQEP', 'ADC', 'DAC', 'CMPSS', 'DMA', 'CLB', 'FSI', 'PMBus'],
		[mem('FLASH', 0x080000, 1536 * 1024, 'read-only'), mem('GSRAM', 0x00C000, 212 * 1024)],
		['TMDSCNCD28386D'],
		['f28386d', 'c2000', 'ti', 'delfino', 'dual-core', 'motor control']),

	// ═══════════════════════════════════════════════════════════════════════
	// Infineon AURIX — Automotive ASIL-D Multicore
	// ═══════════════════════════════════════════════════════════════════════

	e('TC264DA', 'AURIX', 'TC26x', 'Infineon',
		'tricore', 200, 4096 * 1024, 472 * 1024, 'single', true, true, 157,
		['GPIO', 'ASCLIN', 'QSPI', 'I2C', 'CAN', 'MSC', 'SENT', 'GTM', 'ADC', 'ePWM', 'HSM', 'DMA'],
		[mem('PMU_FLASH', 0xA0000000, 4096 * 1024, 'read-only'), mem('DSPR0', 0x70000000, 240 * 1024), mem('DSPR1', 0x60000000, 120 * 1024), mem('LMU', 0x90000000, 64 * 1024)],
		['KIT_AURIX_TC264_TRB', 'TriBoard TC264'],
		['tc264', 'aurix', 'tricore', 'infineon', 'automotive', 'asil-d', 'functional safety']),

	e('TC275TA', 'AURIX', 'TC27x', 'Infineon',
		'tricore', 200, 8192 * 1024, 600 * 1024, 'single', true, true, 221,
		['GPIO', 'ASCLIN', 'QSPI', 'I2C', 'MultiCAN', 'MSC', 'SENT', 'GTM', 'EVADC', 'ePWM', 'HSM', 'DMA', 'EMEM'],
		[mem('PMU_FLASH', 0xA0000000, 8192 * 1024, 'read-only'), mem('DSPR0', 0x70000000, 240 * 1024), mem('DSPR1', 0x60000000, 120 * 1024), mem('DSPR2', 0x50000000, 120 * 1024)],
		['KIT_AURIX_TC275_TRB', 'TriBoard TC275', 'ShieldBuddy TC275'],
		['tc275', 'aurix', 'tricore', 'infineon', 'automotive', 'asil-d', 'iso26262', 'triple-core']),

	e('TC397XX', 'AURIX', 'TC39x', 'Infineon',
		'tricore', 300, 16384 * 1024, 6912 * 1024, 'double', true, true, 239,
		['GPIO', 'ASCLIN', 'QSPI', 'I2C', 'MultiCAN_FD', 'MSC', 'SENT', 'GTM', 'EVADC', 'GtmFixedClk', 'HSM', 'DMA', 'EMEM', 'ETHERNET', 'FlexRay'],
		[mem('PMU_FLASH', 0xA0000000, 16384 * 1024, 'read-only'), mem('DSPR0', 0x70000000, 240 * 1024), mem('LMU0', 0x90000000, 1024 * 1024)],
		['KIT_A2G_TC397_5V_TRB', 'AURIX Development Studio Board'],
		['tc397', 'aurix', 'tricore', 'infineon', 'automotive', 'asil-d', 'iso26262', 'six-core', 'lockstep']),

	e('TC234LP', 'AURIX', 'TC23x', 'Infineon',
		'tricore', 180, 2048 * 1024, 192 * 1024, 'single', true, true, 100,
		['GPIO', 'ASCLIN', 'QSPI', 'MultiCAN', 'SENT', 'GTM', 'EVADC', 'HSM', 'DMA'],
		[mem('PMU_FLASH', 0xA0000000, 2048 * 1024, 'read-only'), mem('DSPR0', 0x70000000, 192 * 1024)],
		['KIT_AURIX_TC234_TRB'],
		['tc234', 'aurix', 'tricore', 'infineon', 'automotive', 'asil-b', 'single-core']),

	// ═══════════════════════════════════════════════════════════════════════
	// NXP Kinetis K Series — Cortex-M4/M0+
	// ═══════════════════════════════════════════════════════════════════════

	e('MK64FN1M0VLL12', 'Kinetis K', 'K64F', 'NXP',
		'cortex-m4', 120, 1024 * 1024, 256 * 1024, 'single', true, true, 100,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN', 'USB', 'ENET', 'ADC', 'DAC', 'DMA', 'RTC', 'LPTMR', 'PIT', 'FTM', 'I2S'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('SRAM_U', 0x20000000, 192 * 1024), mem('SRAM_L', 0x1FFF0000, 64 * 1024)],
		['FRDM-K64F', 'Arduino M0 Pro'],
		['k64f', 'kinetis k', 'nxp', 'frdm-k64f', 'mbed', 'ethernet']),

	e('MK22FN512VLH12', 'Kinetis K', 'K22F', 'NXP',
		'cortex-m4', 120, 512 * 1024, 128 * 1024, 'single', true, true, 64,
		['GPIO', 'UART', 'SPI', 'I2C', 'USB', 'ADC', 'DAC', 'DMA', 'RTC', 'LPTMR', 'PIT', 'FTM'],
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM_U', 0x20000000, 64 * 1024), mem('SRAM_L', 0x1FFF0000, 64 * 1024)],
		['FRDM-K22F'],
		['k22f', 'kinetis k', 'nxp', 'frdm-k22f']),

	e('MK66FN2M0VLQ18', 'Kinetis K', 'K66F', 'NXP',
		'cortex-m4', 180, 2048 * 1024, 256 * 1024, 'single', true, true, 100,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN', 'USB', 'ENET', 'ADC', 'DAC', 'DMA', 'PIT', 'FTM', 'SDHC'],
		[mem('FLASH', 0x00000000, 2048 * 1024, 'read-only'), mem('SRAM_U', 0x20000000, 192 * 1024), mem('SRAM_L', 0x1FFF0000, 64 * 1024)],
		['FRDM-K66F', 'Teensy 3.6'],
		['k66f', 'kinetis k', 'nxp', 'teensy 3.6']),

	e('MK20DX256VLH7', 'Kinetis K', 'K20D', 'NXP',
		'cortex-m4', 72, 256 * 1024, 64 * 1024, 'single', true, true, 64,
		['GPIO', 'UART', 'SPI', 'I2C', 'USB', 'ADC', 'DAC', 'DMA', 'RTC', 'PIT', 'FTM'],
		[mem('FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('SRAM_U', 0x20000000, 32 * 1024), mem('SRAM_L', 0x1FFF8000, 32 * 1024)],
		['Teensy 3.1', 'Teensy 3.2'],
		['k20', 'kinetis k', 'nxp', 'teensy 3.2', 'teensy 3.1']),

	e('MKL25Z128VLK4', 'Kinetis L', 'KL25Z', 'NXP',
		'cortex-m0+', 48, 128 * 1024, 16 * 1024, 'none', false, false, 80,
		['GPIO', 'UART', 'SPI', 'I2C', 'USB', 'ADC', 'DAC', 'DMA', 'RTC', 'TPM'],
		[mem('FLASH', 0x00000000, 128 * 1024, 'read-only'), mem('SRAM_U', 0x20000000, 8 * 1024), mem('SRAM_L', 0x1FFFE000, 8 * 1024)],
		['FRDM-KL25Z'],
		['kl25z', 'kinetis l', 'nxp', 'frdm-kl25z', 'ultra-low-power']),

	e('MKV31F512VLL12', 'Kinetis V', 'KV31F', 'NXP',
		'cortex-m4', 120, 512 * 1024, 96 * 1024, 'single', true, true, 100,
		['GPIO', 'UART', 'SPI', 'I2C', 'ADC', 'DAC', 'DMA', 'FTM', 'eFlexPWM', 'ENC', 'CMP'],
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM_U', 0x20000000, 64 * 1024), mem('SRAM_L', 0x1FFF0000, 32 * 1024)],
		['TWR-KV31F120M', 'FRDM-KV31F'],
		['kv31f', 'kinetis v', 'nxp', 'motor control', 'eflex']),

	// ═══════════════════════════════════════════════════════════════════════
	// NXP i.MX RT Extended — Crossover MCUs
	// ═══════════════════════════════════════════════════════════════════════

	e('MIMXRT1011DAE5A', 'i.MX RT', 'i.MX RT1010', 'NXP',
		'cortex-m7', 500, 0, 128 * 1024, 'double', true, true, 32,
		['GPIO', 'LPUART', 'LPSPI', 'LPI2C', 'GPT', 'PIT', 'ADC', 'USB', 'DMA'],
		[mem('ITCM', 0x00000000, 64 * 1024), mem('DTCM', 0x20000000, 64 * 1024)],
		['MIMXRT1010-EVK'],
		['imxrt1010', 'imxrt', 'nxp', 'crossover', 'usb']),

	e('MIMXRT1024DAG5A', 'i.MX RT', 'i.MX RT1020', 'NXP',
		'cortex-m7', 500, 4096 * 1024, 256 * 1024, 'double', true, true, 75,
		['GPIO', 'LPUART', 'LPSPI', 'LPI2C', 'GPT', 'PIT', 'ADC', 'USB', 'ENET', 'DMA'],
		[mem('FLASH', 0x60000000, 4096 * 1024, 'read-only'), mem('ITCM', 0x00000000, 128 * 1024), mem('DTCM', 0x20000000, 128 * 1024)],
		['MIMXRT1020-EVK'],
		['imxrt1020', 'imxrt', 'nxp', 'crossover', 'ethernet']),

	e('MIMXRT1176DVMAA', 'i.MX RT', 'i.MX RT1170', 'NXP',
		'cortex-m7', 1000, 0, 2048 * 1024, 'double', true, true, 160,
		['GPIO', 'LPUART', 'LPSPI', 'LPI2C', 'GPT', 'PIT', 'ADC', 'USB', 'ENET', 'CAN', 'SEMC', 'CSI', 'LCDIF', 'PXP', 'DMA', 'CAAM'],
		[mem('ITCM', 0x00000000, 256 * 1024), mem('DTCM', 0x20000000, 256 * 1024), mem('OCRAM1', 0x20240000, 512 * 1024), mem('OCRAM2', 0x202C0000, 512 * 1024)],
		['MIMXRT1170-EVK'],
		['imxrt1170', 'imxrt', 'nxp', 'crossover', '1ghz', 'dual-core', 'ai']),

	e('LPC54618J512ET180', 'LPC5', 'LPC54618', 'NXP',
		'cortex-m4', 220, 512 * 1024, 200 * 1024, 'single', true, true, 100,
		['GPIO', 'FLEXCOMM', 'CTIMER', 'ADC', 'USB', 'ENET', 'SDIO', 'LCD', 'DMA'],
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM0', 0x20000000, 160 * 1024), mem('SRAM1', 0x20028000, 40 * 1024)],
		['LPCXpresso54618'],
		['lpc54618', 'lpc5', 'nxp', 'ethernet', 'lcd']),

	e('LPC1768FBD100', 'LPC17', 'LPC1768', 'NXP',
		'cortex-m3', 100, 512 * 1024, 64 * 1024, 'none', true, false, 70,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN', 'USB', 'ENET', 'ADC', 'DAC', 'DMA', 'PWM', 'QEI', 'RTC'],
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM', 0x10000000, 32 * 1024), mem('SRAM2', 0x2007C000, 32 * 1024)],
		['mbed LPC1768', 'LPCXpresso1768'],
		['lpc1768', 'lpc17', 'nxp', 'mbed', 'ethernet']),

	// ═══════════════════════════════════════════════════════════════════════
	// Renesas RA Series — Cortex-M33/M4/M23
	// ═══════════════════════════════════════════════════════════════════════

	e('R7FA6M5BH2CBG', 'RA6', 'RA6M5', 'Renesas',
		'cortex-m33', 200, 2048 * 1024, 512 * 1024, 'single', true, true, 105,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN', 'USB', 'ETHER', 'ADC', 'DAC', 'DMA', 'GPT', 'RTC', 'WDT', 'CRC', 'QSPI', 'OSPI', 'SDHI', 'GLCDC'],
		[mem('CODE_FLASH', 0x00000000, 2048 * 1024, 'read-only'), mem('DATA_FLASH', 0x08000000, 8 * 1024, 'read-only'), mem('SRAM', 0x20000000, 512 * 1024)],
		['EK-RA6M5'],
		['ra6m5', 'ra6', 'renesas', 'trustzone', 'ethernet', 'usb']),

	e('R7FA4M1AB3CBM', 'RA4', 'RA4M1', 'Renesas',
		'cortex-m4', 48, 256 * 1024, 32 * 1024, 'single', true, true, 40,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'USB', 'ADC', 'DAC', 'DMA', 'GPT', 'RTC', 'WDT'],
		[mem('CODE_FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['EK-RA4M1', 'Arduino UNO R4'],
		['ra4m1', 'ra4', 'renesas', 'arduino uno r4', 'uno r4']),

	e('R7FA6M3AH3CFC', 'RA6', 'RA6M3', 'Renesas',
		'cortex-m4', 120, 2048 * 1024, 640 * 1024, 'double', true, true, 100,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN', 'USB', 'ETHER', 'ADC', 'DAC', 'DMA', 'GPT', 'RTC', 'WDT', 'SDHI', 'GLCDC', 'DRW', 'JPEG'],
		[mem('CODE_FLASH', 0x00000000, 2048 * 1024, 'read-only'), mem('SRAM0', 0x20000000, 256 * 1024), mem('SRAM1', 0x28000000, 256 * 1024), mem('SRAM2', 0x20040000, 128 * 1024)],
		['EK-RA6M3', 'EK-RA6M3G'],
		['ra6m3', 'ra6', 'renesas', 'ethernet', 'graphics', 'jpeg']),

	e('R7FA2L1AB2DFL', 'RA2', 'RA2L1', 'Renesas',
		'cortex-m23', 48, 256 * 1024, 32 * 1024, 'none', true, false, 40,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'ADC', 'DAC', 'DMA', 'GPT', 'RTC', 'WDT'],
		[mem('CODE_FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['EK-RA2L1'],
		['ra2l1', 'ra2', 'renesas', 'ultra-low-power', 'trustzone']),

	// ═══════════════════════════════════════════════════════════════════════
	// Renesas RX Series — 32-bit CISC
	// ═══════════════════════════════════════════════════════════════════════

	e('R5F565NEDDFB', 'RX65N', 'RX65N', 'Renesas',
		'rx', 120, 2048 * 1024, 640 * 1024, 'double', true, true, 134,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN', 'USB', 'ETHER', 'ADC', 'DMA', 'TMR', 'GPT', 'RTC', 'WDT', 'SDHI', 'GLCDC', 'JPEG', 'DRW', 'TrustZone'],
		[mem('ROM', 0xFF000000, 2048 * 1024, 'read-only'), mem('RAM0', 0x00000000, 512 * 1024), mem('RAM1', 0x00800000, 128 * 1024)],
		['RSK-RX65N', 'Target Board RX65N'],
		['rx65n', 'rx', 'renesas', 'ethernet', 'graphics', 'iot']),

	e('R5F572NNNDFB', 'RX72N', 'RX72N', 'Renesas',
		'rx', 240, 4096 * 1024, 1024 * 1024, 'double', true, true, 134,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN', 'USB', 'ETHER', 'ADC', 'DMA', 'GPT', 'RTC', 'WDT', 'SDHI', 'GLCDC', 'JPEG', 'DRW'],
		[mem('ROM', 0xFF000000, 4096 * 1024, 'read-only'), mem('RAM0', 0x00000000, 1024 * 1024)],
		['RSK-RX72N', 'Envision Kit RX72N'],
		['rx72n', 'rx', 'renesas', 'ethernet', 'graphics', 'ml', '240mhz']),

	// ═══════════════════════════════════════════════════════════════════════
	// Microchip PIC32 — MIPS32 Based
	// ═══════════════════════════════════════════════════════════════════════

	e('PIC32MZ2048EFH144', 'PIC32MZ', 'PIC32MZ EF', 'Microchip',
		'mips32', 252, 2048 * 1024, 512 * 1024, 'double', false, false, 144,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN', 'USB', 'ADC', 'DMA', 'OC', 'IC', 'RTCC', 'WDT', 'ETHERNET', 'CRYPTO'],
		[mem('PROGRAM_FLASH', 0x1D000000, 2048 * 1024, 'read-only'), mem('BOOT_FLASH', 0x1FC00000, 64 * 1024, 'read-only'), mem('DATA_RAM', 0x00000000, 512 * 1024)],
		['Curiosity PIC32MZ EF', 'chipKIT Wi-FIRE'],
		['pic32mz', 'pic32', 'microchip', 'mips32', 'ethernet', 'crypto']),

	e('PIC32MX795F512L', 'PIC32MX', 'PIC32MX7', 'Microchip',
		'mips32', 80, 512 * 1024, 128 * 1024, 'none', false, false, 83,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN', 'USB', 'ADC', 'DMA', 'OC', 'IC', 'RTCC', 'WDT', 'ETHERNET'],
		[mem('PROGRAM_FLASH', 0x1D000000, 512 * 1024, 'read-only'), mem('DATA_RAM', 0x00000000, 128 * 1024)],
		['chipKIT Max32', 'Digilent cerebot'],
		['pic32mx', 'pic32', 'microchip', 'mips32', 'ethernet']),

	// ═══════════════════════════════════════════════════════════════════════
	// Microchip SAM E/D extended
	// ═══════════════════════════════════════════════════════════════════════

	e('ATSAMC21G18A', 'SAM C21', 'SAMC21', 'Microchip',
		'cortex-m0+', 48, 256 * 1024, 32 * 1024, 'none', false, false, 38,
		['GPIO', 'SERCOM', 'TC', 'TCC', 'ADC', 'DAC', 'CAN', 'DMAC', 'RTC', 'WDT', 'EIC', 'EVSYS', 'TSENS'],
		[mem('FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['SAM C21 Xplained Pro'],
		['samc21', 'sam c21', 'microchip', 'can', 'industrial', '5v']),

	e('ATSAME54P20A', 'SAM E54', 'SAME54', 'Microchip',
		'cortex-m4', 120, 1024 * 1024, 256 * 1024, 'double', true, true, 64,
		['GPIO', 'SERCOM', 'TC', 'TCC', 'ADC', 'DAC', 'CAN', 'USB', 'GMAC', 'DMAC', 'QSPI', 'I2S', 'PDEC'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('SRAM0', 0x20000000, 192 * 1024), mem('SRAM1', 0x20400000, 64 * 1024)],
		['SAM E54 Xplained Pro', 'Adafruit Feather M4 CAN'],
		['same54', 'sam e54', 'microchip', 'can-fd', 'ethernet', 'qspi']),

	e('ATSAMD51J20A', 'SAM D51', 'SAMD51', 'Microchip',
		'cortex-m4', 120, 1024 * 1024, 256 * 1024, 'single', true, true, 51,
		['GPIO', 'SERCOM', 'TC', 'TCC', 'ADC', 'DAC', 'USB', 'DMAC', 'QSPI', 'SDHC', 'I2S', 'PDEC'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('SRAM0', 0x20000000, 192 * 1024), mem('SRAM1', 0x20400000, 64 * 1024)],
		['Adafruit Metro M4 Express', 'Adafruit Feather M4 Express', 'Adafruit Grand Central M4 Express'],
		['samd51', 'sam d51', 'microchip', 'feather m4', 'metro m4', 'circuitpython']),

	// ═══════════════════════════════════════════════════════════════════════
	// Silicon Labs EFM32 / EFR32 — Wireless + Ultra-low-power
	// ═══════════════════════════════════════════════════════════════════════

	e('EFR32MG24A020F1536IM48', 'EFR32MG', 'EFR32MG24', 'Silicon Labs',
		'cortex-m33', 78, 1536 * 1024, 256 * 1024, 'single', true, true, 24,
		['GPIO', 'USART', 'EUSART', 'I2C', 'TIMER', 'ADC', 'DMA', 'RTC', 'WDT', '2.4GHz Radio', 'BLE', 'Thread', 'Matter', 'Zigbee', 'AES', 'SHA'],
		[mem('FLASH', 0x08000000, 1536 * 1024, 'read-only'), mem('SRAM', 0x20000000, 256 * 1024)],
		['xG24 Dev Kit', 'Sparkfun ThingsStream MGM240'],
		['efr32mg24', 'efr32mg', 'silabs', 'matter', 'zigbee', 'thread', 'ble', 'wireless']),

	e('EFM32GG12B810F1024GL112', 'EFM32GG', 'EFM32GG12', 'Silicon Labs',
		'cortex-m4', 72, 1024 * 1024, 512 * 1024, 'single', true, true, 85,
		['GPIO', 'UART', 'USART', 'I2C', 'TIMER', 'ADC', 'DAC', 'DMA', 'USB', 'LCD', 'RTC', 'WDT', 'CRYPTO'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 512 * 1024)],
		['Thunderboard EFM32GG12'],
		['efm32gg12', 'efm32', 'silabs', 'ultra-low-power', 'usb', 'lcd']),

	e('EFR32BG22C224F512IM32', 'EFR32BG', 'EFR32BG22', 'Silicon Labs',
		'cortex-m33', 76, 512 * 1024, 32 * 1024, 'single', true, true, 14,
		['GPIO', 'EUSART', 'I2C', 'TIMER', 'ADC', 'DMA', 'RTC', 'WDT', 'BLE', 'AES', 'SHA'],
		[mem('FLASH', 0x08000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['xG22 Dev Kit', 'Thunderboard BG22'],
		['efr32bg22', 'efr32bg', 'silabs', 'ble', 'bluetooth', 'ultra-low-power', 'coin cell']),

	// ═══════════════════════════════════════════════════════════════════════
	// Texas Instruments CC Family — Wireless SoC
	// ═══════════════════════════════════════════════════════════════════════

	e('CC1312R', 'CC13xx', 'CC1312R', 'Texas Instruments',
		'cortex-m4', 48, 352 * 1024, 80 * 1024, 'single', false, false, 30,
		['GPIO', 'UART', 'SSI', 'I2C', 'TIMER', 'ADC', 'AES', 'TRNG', 'Sub-GHz_RF', 'WDT'],
		[mem('FLASH', 0x00000000, 352 * 1024, 'read-only'), mem('SRAM', 0x20000000, 80 * 1024)],
		['LAUNCHXL-CC1312R1'],
		['cc1312r', 'cc13xx', 'ti', 'sub-ghz', 'lorawan', 'wisun', 'simplelink']),

	e('CC2652R', 'CC26xx', 'CC2652R', 'Texas Instruments',
		'cortex-m4', 48, 352 * 1024, 80 * 1024, 'single', false, false, 30,
		['GPIO', 'UART', 'SSI', 'I2C', 'TIMER', 'ADC', 'AES', 'TRNG', 'RF_CORE', 'WDT'],
		[mem('FLASH', 0x00000000, 352 * 1024, 'read-only'), mem('SRAM', 0x20000000, 80 * 1024)],
		['LAUNCHXL-CC26X2R1', 'Zigbee2mqtt coordinator'],
		['cc2652r', 'cc2652', 'ti', 'ble', 'zigbee', 'thread', 'simplelink']),

	e('CC3235SF', 'CC32xx', 'CC3235SF', 'Texas Instruments',
		'cortex-m4', 240, 2048 * 1024, 256 * 1024, 'single', false, false, 50,
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'DMA', 'WiFi', 'TLS', 'AES', 'SHA'],
		[mem('FLASH', 0x20000000, 2048 * 1024, 'read-only'), mem('SRAM', 0x20100000, 256 * 1024)],
		['CC3235SF LaunchPad'],
		['cc3235', 'cc32xx', 'ti', 'wifi', 'simplelink', 'iot', 'cloud']),

	// ═══════════════════════════════════════════════════════════════════════
	// Nordic nRF52 extended
	// ═══════════════════════════════════════════════════════════════════════

	e('nRF52811-QCAA', 'nRF52', 'nRF52811', 'Nordic Semiconductor',
		'cortex-m4', 64, 192 * 1024, 24 * 1024, 'single', false, false, 22,
		[...NORDIC_COMMON_PERIPHS],
		[mem('FLASH', 0x00000000, 192 * 1024, 'read-only'), mem('RAM', 0x20000000, 24 * 1024)],
		['nRF52811 DK'],
		['nrf52811', 'nrf52', 'ble', 'bluetooth', 'direction finding', 'aoa', 'aod']),

	e('nRF52820-QDAA', 'nRF52', 'nRF52820', 'Nordic Semiconductor',
		'cortex-m4', 64, 256 * 1024, 32 * 1024, 'single', false, false, 20,
		[...NORDIC_COMMON_PERIPHS, 'USB'],
		[mem('FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('RAM', 0x20000000, 32 * 1024)],
		['nRF52820 DK'],
		['nrf52820', 'nrf52', 'ble', 'bluetooth', 'usb', 'thread', 'zigbee']),

	e('nRF7002-DK', 'nRF70', 'nRF7002', 'Nordic Semiconductor',
		'cortex-m33', 64, 1024 * 1024, 256 * 1024, 'single', true, true, 48,
		['GPIO', 'UARTE', 'SPIM', 'TWIM', 'TIMER', 'SAADC', 'PWM', 'WiFi6', 'WPA3', 'BLE'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('RAM', 0x20000000, 256 * 1024)],
		['nRF7002 DK'],
		['nrf7002', 'nrf70', 'nordic', 'wifi6', 'wi-fi 6', 'wpa3', 'ble']),

	// ═══════════════════════════════════════════════════════════════════════
	// ESP32 extended S2/C2/P4
	// ═══════════════════════════════════════════════════════════════════════

	e('ESP32-S2-WROOM', 'ESP32', 'ESP32-S2', 'Espressif',
		'xtensa', 240, 4 * 1024 * 1024, 320 * 1024, 'none', false, false, 43,
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'DAC', 'RMT', 'LEDC', 'USB_OTG', 'PCNT', 'WiFi', 'RNG', 'RTC', 'WDT', 'TWAI'],
		[mem('IROM', 0x42000000, 4 * 1024 * 1024, 'read-only'), mem('IRAM', 0x40370000, 320 * 1024)],
		['ESP32-S2-DevKitM', 'Adafruit MagTag', 'Unexpected Maker FeatherS2'],
		['esp32s2', 'esp32-s2', 'espressif', 'usb-otg', 'usb', 'wifi', 'single-core', 'touchpad', 'no-bluetooth']),

	e('ESP32-C2-WROOM', 'ESP32', 'ESP32-C2', 'Espressif',
		'risc-v', 120, 4 * 1024 * 1024, 272 * 1024, 'none', false, false, 14,
		['GPIO', 'UART', 'SPI', 'I2C', 'PWM', 'ADC', 'WiFi', 'BT', 'RNG', 'WDT'],
		[mem('IROM', 0x42000000, 4 * 1024 * 1024, 'read-only'), mem('IRAM', 0x40800000, 272 * 1024)],
		['ESP8684 DevKit'],
		['esp32c2', 'esp32-c2', 'esp8684', 'espressif', 'risc-v', 'wifi', 'ble', 'smallest', 'cost-effective', 'budget']),

	e('ESP32-P4', 'ESP32', 'ESP32-P4', 'Espressif',
		'risc-v', 400, 0, 32 * 1024 * 1024, 'none', false, false, 54,
		['GPIO', 'UART', 'SPI', 'I2C', 'I3C', 'CAM', 'MIPI_DSI', 'MIPI_CSI', 'DMA', 'ADC', 'USB', 'SDMMC', 'GMAC'],
		[mem('SRAM', 0x4FF00000, 32 * 1024 * 1024)],
		['ESP32-P4-Function-EV-Board'],
		['esp32p4', 'esp32-p4', 'espressif', 'risc-v', 'dual-core', 'ai', 'camera', 'display', 'hmi', 'high-performance', '400mhz']),

	// ═══════════════════════════════════════════════════════════════════════
	// GigaDevice GD32 — STM32-compatible RISC-V / Cortex
	// ═══════════════════════════════════════════════════════════════════════

	e('GD32F407VGT6', 'GD32F4', 'GD32F407', 'GigaDevice',
		'cortex-m4', 168, 1024 * 1024, 192 * 1024, 'single', true, true, 82,
		STM32_ADVANCED_PERIPHS,
		[mem('FLASH', 0x08000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 112 * 1024), mem('SRAM2', 0x2001C000, 80 * 1024)],
		['GD32450I-EVAL'],
		['gd32f407', 'gd32f4', 'gigadevice', 'stm32 compatible', 'cortex-m4']),

	e('GD32F303RCT6', 'GD32F3', 'GD32F303', 'GigaDevice',
		'cortex-m4', 120, 256 * 1024, 48 * 1024, 'single', true, true, 51,
		STM32_COMMON_PERIPHS,
		[mem('FLASH', 0x08000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 48 * 1024)],
		['GD32303E-EVAL'],
		['gd32f303', 'gd32f3', 'gigadevice', 'stm32 compatible']),

	e('GD32E103CBT6', 'GD32E1', 'GD32E103', 'GigaDevice',
		'cortex-m4', 120, 128 * 1024, 20 * 1024, 'single', true, true, 37,
		STM32_COMMON_PERIPHS,
		[mem('FLASH', 0x08000000, 128 * 1024, 'read-only'), mem('SRAM', 0x20000000, 20 * 1024)],
		['GD32E103C-START'],
		['gd32e103', 'gd32e1', 'gigadevice', 'ecm-series', 'enhanced']),

	// ═══════════════════════════════════════════════════════════════════════
	// Nuvoton M480 / M2354 — Cortex-M4/M23 TrustZone
	// ═══════════════════════════════════════════════════════════════════════

	e('M480LGAAE', 'M480', 'M480', 'Nuvoton',
		'cortex-m4', 192, 512 * 1024, 160 * 1024, 'single', true, true, 84,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN', 'USB', 'EMAC', 'ADC', 'DAC', 'DMA', 'TIMER', 'PWM', 'CRYPTO'],
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 160 * 1024)],
		['NuMaker-PFM-M487'],
		['m480', 'm487', 'nuvoton', 'ethernet', 'crypto', 'industrial']),

	e('M2354KJFAE', 'M2354', 'M2354', 'Nuvoton',
		'cortex-m23', 64, 1024 * 1024, 256 * 1024, 'none', true, false, 84,
		['GPIO', 'UART', 'SPI', 'I2C', 'USB', 'ADC', 'DMA', 'TIMER', 'CRYPTO', 'TrustZone', 'KS'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 256 * 1024)],
		['NuMaker-M2354'],
		['m2354', 'nuvoton', 'trustzone', 'cortex-m23', 'secure', 'iot']),

	// ═══════════════════════════════════════════════════════════════════════
	// WCH CH32 — RISC-V / ARM (China domestic)
	// ═══════════════════════════════════════════════════════════════════════

	e('CH32V307VCT6', 'CH32V', 'CH32V307', 'WCH',
		'risc-v', 144, 256 * 1024, 64 * 1024, 'single', false, false, 80,
		['GPIO', 'USART', 'SPI', 'I2C', 'CAN', 'USB', 'ETH', 'ADC', 'DAC', 'DMA', 'OPA', 'RTC', 'DVP'],
		[mem('FLASH', 0x08000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 64 * 1024)],
		['CH32V307V-EVT'],
		['ch32v307', 'ch32v', 'wch', 'risc-v', 'ethernet', 'usb hs', 'china']),

	e('CH32V003F4P6', 'CH32V', 'CH32V003', 'WCH',
		'risc-v', 48, 16 * 1024, 2 * 1024, 'none', false, false, 18,
		['GPIO', 'USART', 'SPI', 'I2C', 'TIM', 'ADC', 'DMA'],
		[mem('FLASH', 0x08000000, 16 * 1024, 'read-only'), mem('SRAM', 0x20000000, 2 * 1024)],
		['CH32V003F4P6-EVT'],
		['ch32v003', 'ch32v', 'wch', 'risc-v', '10 cent mcu', 'budget']),

	// ═══════════════════════════════════════════════════════════════════════
	// Ambiq Apollo — Ultra-Low-Power ARM
	// ═══════════════════════════════════════════════════════════════════════

	e('AMA3B2KK-KBR', 'Apollo3', 'Apollo3 Blue', 'Ambiq',
		'cortex-m4', 96, 1024 * 1024, 384 * 1024, 'single', true, true, 50,
		['GPIO', 'UART', 'SPI', 'I2C', 'I2S', 'PDM', 'ADC', 'DMA', 'RTC', 'WDT', 'BLE'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x10000000, 384 * 1024)],
		['SparkFun Artemis', 'SparkFun RedBoard Artemis', 'Arduino Nano BLE Sense 33'],
		['apollo3', 'ambiq', 'ultra-low-power', 'ble', 'voice', 'pdm', 'artemis']),

	// ═══════════════════════════════════════════════════════════════════════
	// Nordic nRF91 Extended + Thingy
	// ═══════════════════════════════════════════════════════════════════════

	e('nRF9161-SICA', 'nRF91', 'nRF9161', 'Nordic Semiconductor',
		'cortex-m33', 64, 1024 * 1024, 256 * 1024, 'single', true, true, 44,
		['GPIO', 'UARTE', 'SPIM', 'TWIM', 'TIMER', 'SAADC', 'PWM', 'RTC', 'WDT', 'MODEM', 'GPS'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('RAM', 0x20000000, 256 * 1024)],
		['nRF9161 DK'],
		['nrf9161', 'nrf91', 'lte-m', 'nb-iot', 'cellular', 'gps', 'gnss']),

	// ═══════════════════════════════════════════════════════════════════════
	// STM32 MP1 — Linux-capable dual Cortex-A7 + Cortex-M4
	// ═══════════════════════════════════════════════════════════════════════

	e('STM32MP151AAB3', 'STM32MP1', 'STM32MP151', 'STMicroelectronics',
		'cortex-a', 650, 0, 0, 'none', true, false, 176,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN', 'USB', 'ETHERNET', 'ADC', 'DAC', 'DDR', 'GPU', 'LTDC', 'DSI', 'MIPI_CSI', 'CRYP', 'HASH', 'RNG'],
		[mem('DDR', 0xC0000000, 512 * 1024 * 1024), mem('SYSRAM', 0x2FFC0000, 256 * 1024)],
		['STM32MP157F-DK2', 'STM32MP151C-EV1'],
		['stm32mp1', 'stm32mp151', 'linux', 'mpuyunit', 'dual-core', 'a7', 'openembedded']),

	e('STM32MP157FAC3', 'STM32MP1', 'STM32MP157', 'STMicroelectronics',
		'cortex-a', 800, 0, 0, 'double', true, true, 176,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN', 'USB', 'ETHERNET', 'ADC', 'DAC', 'DDR', 'GPU', 'LTDC', 'DSI', 'MIPI_CSI', 'CRYP', 'HASH', 'RNG', 'CORTEX_M4'],
		[mem('DDR', 0xC0000000, 512 * 1024 * 1024), mem('SYSRAM', 0x2FFC0000, 256 * 1024), mem('MCU_SRAM', 0x10000000, 384 * 1024)],
		['STM32MP157F-DK2', 'STM32MP157D-DK1'],
		['stm32mp157', 'stm32mp1', 'linux', 'embedded-linux', 'dual-a7', 'cortex-m4', 'heterogeneous']),

	// ═══════════════════════════════════════════════════════════════════════
	// Microchip AVR Extended
	// ═══════════════════════════════════════════════════════════════════════

	e('ATmega4809', 'AVR', 'ATmega4809', 'Microchip',
		'avr', 20, 48 * 1024, 6 * 1024, 'none', false, false, 41,
		['GPIO', 'USART', 'SPI', 'TWI', 'TCA', 'TCB', 'ADC', 'DAC', 'WDT', 'RTC', 'CCL', 'EEPROM', 'OPAMP'],
		[mem('FLASH', 0x0000, 48 * 1024, 'read-only'), mem('SRAM', 0x3800, 6 * 1024), mem('EEPROM', 0x1400, 256)],
		['Arduino Nano Every', 'Arduino UNO WiFi Rev2', 'Curiosity Nano ATmega4809'],
		['atmega4809', 'avr0', 'arduino nano every', 'megaavr', 'new avr']),

	e('ATtiny416', 'AVR', 'ATtiny416', 'Microchip',
		'avr', 20, 4 * 1024, 256, 'none', false, false, 18,
		['GPIO', 'USART', 'SPI', 'TWI', 'TCA', 'TCB', 'ADC', 'WDT', 'RTC'],
		[mem('FLASH', 0x0000, 4 * 1024, 'read-only'), mem('SRAM', 0x3E00, 256), mem('EEPROM', 0x1400, 128)],
		['ATtiny416 Xplained'],
		['attiny416', 'attiny', 'tinyavr', 'avr', 'tiny']),

	e('AVRDA48', 'AVR', 'AVR128DA48', 'Microchip',
		'avr', 24, 128 * 1024, 16 * 1024, 'none', false, false, 41,
		['GPIO', 'USART', 'SPI', 'TWI', 'TCA', 'TCB', 'TCD', 'ADC', 'DAC', 'WDT', 'RTC', 'CCL', 'ZCD', 'OPAMP', 'MVIO'],
		[mem('FLASH', 0x0000, 128 * 1024, 'read-only'), mem('SRAM', 0x4000, 16 * 1024), mem('EEPROM', 0x1400, 512)],
		['AVR128DA48 Curiosity Nano'],
		['avr128da48', 'avrda', 'avr da', 'avrda48', 'multi-voltage']),

	// ═══════════════════════════════════════════════════════════════════════
	// Lattice MachXO / iCE40 — FPGA (for mixed HW/SW projects)
	// ═══════════════════════════════════════════════════════════════════════

	e('LCMXO3LF-4300C-6BG324C', 'MachXO3', 'MachXO3LF', 'Lattice',
		'other', 133, 2048 * 1024, 128 * 1024, 'none', false, false, 206,
		['GPIO', 'SPI', 'I2C', 'UART', 'EFB', 'PLL', 'DPRAM', 'sysCLOCK'],
		[mem('CONFIG_FLASH', 0x00000000, 2048 * 1024, 'read-only'), mem('SRAM', 0x20000000, 128 * 1024)],
		['MachXO3 Breakout Board'],
		['machxo3', 'lattice', 'fpga', 'cpld', 'bridging', 'glue logic']),

	// ═══════════════════════════════════════════════════════════════════════
	// RP2040 / RP2350 variants (boards)
	// ═══════════════════════════════════════════════════════════════════════

	e('RP2040B2', 'RP2040', 'RP2040', 'Raspberry Pi',
		'cortex-m0+', 133, 0, 264 * 1024, 'none', false, false, 30,
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'PWM', 'PIO', 'USB', 'DMA', 'RTC', 'WDT'],
		[mem('ROM', 0x00000000, 16 * 1024, 'read-only'), mem('XIP_FLASH', 0x10000000, 16 * 1024 * 1024), mem('SRAM', 0x20000000, 264 * 1024)],
		['Seeed XIAO RP2040', 'Adafruit Feather RP2040', 'SparkFun Pro Micro RP2040', 'Pimoroni Tiny 2040'],
		['rp2040', 'pico', 'pio', 'micropython', 'circuitpython', 'raspberry']),

	e('RP2350B', 'RP2350', 'RP2350', 'Raspberry Pi',
		'cortex-m33', 150, 0, 520 * 1024, 'single', true, true, 48,
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'PWM', 'PIO', 'USB', 'DMA', 'RTC', 'WDT', 'HSTX', 'SHA256'],
		[mem('ROM', 0x00000000, 32 * 1024, 'read-only'), mem('XIP_FLASH', 0x10000000, 16 * 1024 * 1024), mem('SRAM', 0x20000000, 520 * 1024)],
		['Adafruit Feather RP2350', 'Pimoroni Pico Plus 2'],
		['rp2350', 'pico 2', 'pio', 'trustzone', 'risc-v capable', 'hazard3']),

	// ═══════════════════════════════════════════════════════════════════════
	// Microchip PIC18 — 8-bit Enhanced
	// ═══════════════════════════════════════════════════════════════════════

	e('PIC18F47Q10', 'PIC18', 'PIC18F47Q10', 'Microchip',
		'pic', 64, 128 * 1024, 8 * 1024, 'none', false, false, 40,
		['GPIO', 'UART', 'SPI', 'I2C', 'TMR', 'ADC', 'DAC', 'CMP', 'WDT', 'CLC', 'CRC', 'NCO'],
		[mem('PROGRAM_FLASH', 0x0000, 128 * 1024, 'read-only'), mem('DATA_SRAM', 0x0000, 8 * 1024)],
		['Curiosity Nano PIC18F47Q10'],
		['pic18f47q10', 'pic18', 'pic', 'microchip', '8-bit', 'q10']),

	e('PIC18LF2550', 'PIC18', 'PIC18F2550', 'Microchip',
		'pic', 48, 32 * 1024, 2048, 'none', false, false, 25,
		['GPIO', 'UART', 'SPI', 'I2C', 'TMR', 'ADC', 'USB', 'CMP', 'WDT', 'CCP', 'EEPROM'],
		[mem('PROGRAM_FLASH', 0x0000, 32 * 1024, 'read-only'), mem('DATA_SRAM', 0x0000, 2 * 1024)],
		['PIC18F2550 USB Dev Board'],
		['pic18f2550', 'pic18', 'pic', 'microchip', 'usb', '8-bit']),

	// ═══════════════════════════════════════════════════════════════════════
	// Blu (WB) extended & new STM32WBA
	// ═══════════════════════════════════════════════════════════════════════

	e('STM32WBA55CGU6', 'STM32WBA', 'STM32WBA55', 'STMicroelectronics',
		'cortex-m33', 100, 1024 * 1024, 512 * 1024, 'single', true, true, 37,
		[...STM32_COMMON_PERIPHS, 'BLE', 'Thread', 'Zigbee', 'AES', 'PKA', 'RNG', 'HASH'],
		[mem('FLASH', 0x08000000, 1024 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 128 * 1024), mem('SRAM2', 0x20020000, 32 * 1024), mem('SRAM6', 0x48000000, 512 * 1024)],
		['NUCLEO-WBA55CG'],
		['stm32wba55', 'stm32wba', 'ble 5.4', 'thread', 'zigbee', 'matter', 'trustzone']),

	// ─── STM32F4 extended variants ────────────────────────────────────────
	e('STM32F412RGT6', 'STM32F4', 'STM32F412', 'STMicroelectronics',
		'cortex-m4', 100, 1024 * 1024, 256 * 1024, 'single', true, true, 51,
		[...STM32_COMMON_PERIPHS, 'QUADSPI', 'CAN', 'DFSDM'],
		[mem('FLASH', 0x08000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 256 * 1024)],
		['NUCLEO-F412ZG'], ['f412', 'stm32f412']),

	e('STM32F427ZIT6', 'STM32F4', 'STM32F427', 'STMicroelectronics',
		'cortex-m4', 180, 2048 * 1024, 256 * 1024, 'single', true, true, 114,
		[...STM32_ADVANCED_PERIPHS, 'LTDC', 'FMC', 'SAI'],
		[mem('FLASH', 0x08000000, 2048 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 112 * 1024), mem('CCM', 0x10000000, 64 * 1024)],
		['STM32F427I-DISC1'], ['f427', 'stm32f427']),

	e('STM32F437ZIT6', 'STM32F4', 'STM32F437', 'STMicroelectronics',
		'cortex-m4', 180, 2048 * 1024, 256 * 1024, 'single', true, true, 114,
		[...STM32_ADVANCED_PERIPHS, 'LTDC', 'FMC', 'SAI', 'CRYP', 'HASH', 'RNG'],
		[mem('FLASH', 0x08000000, 2048 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 192 * 1024), mem('CCM', 0x10000000, 64 * 1024)],
		[], ['f437', 'stm32f437', 'crypto']),

	e('STM32F469NIT6', 'STM32F4', 'STM32F469', 'STMicroelectronics',
		'cortex-m4', 180, 2048 * 1024, 384 * 1024, 'single', true, true, 168,
		[...STM32_ADVANCED_PERIPHS, 'LTDC', 'DSI', 'FMC', 'SAI', 'QUADSPI', 'CRYP', 'HASH', 'RNG'],
		[mem('FLASH', 0x08000000, 2048 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 320 * 1024), mem('CCM', 0x10000000, 64 * 1024)],
		['STM32F469I-DISCO'], ['f469', 'stm32f469', 'dsi', 'display']),

	// ─── STM32L0 — Ultra-low-power Cortex-M0+ ────────────────────────────
	e('STM32L073RZT6', 'STM32L0', 'STM32L073', 'STMicroelectronics',
		'cortex-m0+', 32, 192 * 1024, 20 * 1024, 'none', false, false, 51,
		['GPIO', 'USART', 'SPI', 'I2C', 'USB', 'ADC', 'DAC', 'DMA', 'RTC', 'LPTIM', 'LCD', 'TSC', 'AES'],
		[mem('FLASH', 0x08000000, 192 * 1024, 'read-only'), mem('SRAM', 0x20000000, 20 * 1024)],
		['NUCLEO-L073RZ'], ['l073', 'stm32l073', 'stm32l0', 'ultra-low-power', 'lora']),

	e('STM32L010F4P6', 'STM32L0', 'STM32L010', 'STMicroelectronics',
		'cortex-m0+', 32, 16 * 1024, 2 * 1024, 'none', false, false, 15,
		['GPIO', 'USART', 'SPI', 'I2C', 'ADC', 'RTC', 'LPTIM', 'WDT'],
		[mem('FLASH', 0x08000000, 16 * 1024, 'read-only'), mem('SRAM', 0x20000000, 2 * 1024)],
		[], ['l010', 'stm32l010', 'stm32l0', 'smallest', 'coin-cell']),

	// ─── STM32L1 — Cortex-M3 medium-density ULP ──────────────────────────
	e('STM32L152RET6', 'STM32L1', 'STM32L152', 'STMicroelectronics',
		'cortex-m3', 32, 512 * 1024, 80 * 1024, 'none', false, false, 51,
		['GPIO', 'USART', 'SPI', 'I2C', 'USB', 'ADC', 'DAC', 'DMA', 'RTC', 'LCD', 'TSC', 'AES', 'COMP'],
		[mem('FLASH', 0x08000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 80 * 1024), mem('EEPROM', 0x08080000, 16 * 1024)],
		['NUCLEO-L152RE'], ['l152', 'stm32l152', 'stm32l1', 'eeprom', 'lcd']),

	e('STM32L162RDT6', 'STM32L1', 'STM32L162', 'STMicroelectronics',
		'cortex-m3', 32, 384 * 1024, 48 * 1024, 'none', false, false, 51,
		['GPIO', 'USART', 'SPI', 'I2C', 'USB', 'ADC', 'DAC', 'DMA', 'RTC', 'LCD', 'TSC', 'AES'],
		[mem('FLASH', 0x08000000, 384 * 1024, 'read-only'), mem('SRAM', 0x20000000, 48 * 1024)],
		[], ['l162', 'stm32l162', 'stm32l1', 'aes']),

	// ─── TI MSP430 extended ───────────────────────────────────────────────
	e('MSP430FR5994', 'MSP430', 'MSP430FR5994', 'Texas Instruments',
		'msp430', 16, 256 * 1024, 8 * 1024, 'none', false, false, 51,
		['GPIO', 'USCI_A', 'USCI_B', 'TIMER_A', 'TIMER_B', 'ADC12', 'DMA', 'RTC', 'WDT', 'LEA', 'AES'],
		[mem('FRAM', 0x4400, 256 * 1024, 'read-write'), mem('RAM', 0x1C00, 8 * 1024)],
		['MSP-EXP430FR5994'],
		['msp430fr5994', 'msp430fr', 'msp430', 'ti', 'fram', 'ultra-low-power', 'lea']),

	e('MSP430G2553IN20', 'MSP430', 'MSP430G2553', 'Texas Instruments',
		'msp430', 16, 16 * 1024, 512, 'none', false, false, 16,
		['GPIO', 'USCI_A', 'USCI_B', 'TIMER_A', 'ADC10', 'COMP', 'WDT'],
		[mem('FLASH', 0xC000, 16 * 1024, 'read-only'), mem('RAM', 0x0200, 512)],
		['MSP-EXP430G2'],
		['msp430g2553', 'msp430g2', 'msp430', 'ti', 'launchpad', 'value line']),

	e('MSP430FR6989', 'MSP430', 'MSP430FR6989', 'Texas Instruments',
		'msp430', 16, 128 * 1024, 2 * 1024, 'none', false, false, 83,
		['GPIO', 'USCI_A', 'USCI_B', 'TIMER_A', 'TIMER_B', 'ADC12', 'DMA', 'RTC', 'LCD_C', 'WDT', 'AES'],
		[mem('FRAM', 0x4400, 128 * 1024, 'read-write'), mem('RAM', 0x1C00, 2 * 1024)],
		['MSP-EXP430FR6989'],
		['msp430fr6989', 'msp430fr', 'msp430', 'ti', 'fram', 'lcd', 'ultra-low-power']),

	// ─── NXP LPC43xx — Dual-core Cortex-M4 + M0 ─────────────────────────
	e('LPC4370FET256', 'LPC43', 'LPC4370', 'NXP',
		'cortex-m4', 204, 0, 264 * 1024, 'single', true, true, 165,
		['GPIO', 'USART', 'SSP', 'I2C', 'USB', 'ENET', 'CAN', 'ADC', 'DAC', 'DMA', 'SGPIO', 'ADCHS', 'I2S'],
		[mem('SRAM0', 0x10000000, 96 * 1024), mem('SRAM1', 0x10080000, 40 * 1024), mem('SRAM2', 0x20000000, 72 * 1024), mem('SRAM3', 0x20012000, 16 * 1024)],
		['LPC4370-Link2', 'HackRF SDR'],
		['lpc4370', 'lpc43', 'nxp', 'dual-core', 'sdr', 'sgpio', 'adchs']),

	e('LPC4357FET256', 'LPC43', 'LPC4357', 'NXP',
		'cortex-m4', 204, 1024 * 1024, 264 * 1024, 'single', true, true, 165,
		['GPIO', 'USART', 'SSP', 'I2C', 'USB', 'ENET', 'CAN', 'ADC', 'DAC', 'DMA', 'LCD', 'SPIFI', 'I2S'],
		[mem('FLASH_A', 0x1A000000, 512 * 1024, 'read-only'), mem('FLASH_B', 0x1B000000, 512 * 1024, 'read-only'), mem('SRAM0', 0x10000000, 96 * 1024)],
		['LPC4357-EVB', 'Hitex LPC4357'],
		['lpc4357', 'lpc43', 'nxp', 'dual-core', 'ethernet', 'lcd']),

	// ─── ST STM32C0 — Value-line Cortex-M0+ ─────────────────────────────
	e('STM32C071RBT6', 'STM32C0', 'STM32C071', 'STMicroelectronics',
		'cortex-m0+', 48, 128 * 1024, 24 * 1024, 'none', false, false, 51,
		['GPIO', 'USART', 'SPI', 'I2C', 'ADC', 'DMA', 'RTC', 'LPTIM', 'WDT', 'FDCAN'],
		[mem('FLASH', 0x08000000, 128 * 1024, 'read-only'), mem('SRAM', 0x20000000, 24 * 1024)],
		['NUCLEO-C071RB'], ['c071', 'stm32c071', 'stm32c0', 'value-line']),

	// ─── Microchip SAML21/SAML22 — Ultra-low-power ───────────────────────
	e('ATSAML21J18B', 'SAM L21', 'SAML21', 'Microchip',
		'cortex-m0+', 48, 256 * 1024, 32 * 1024, 'none', false, false, 51,
		['GPIO', 'SERCOM', 'TC', 'TCC', 'ADC', 'DAC', 'USB', 'DMAC', 'RTC', 'WDT', 'EIC', 'EVSYS', 'OPAMP', 'CCL'],
		[mem('FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024), mem('LP_SRAM', 0x30000000, 8 * 1024)],
		['SAM L21 Xplained Pro'], ['saml21', 'sam l21', 'microchip', 'ultra-low-power', 'picoPower']),

	// ─── Renesas RA8 — Cortex-M85 ────────────────────────────────────────
	e('R7FA8D1BHECBD', 'RA8', 'RA8D1', 'Renesas',
		'cortex-m85', 480, 2048 * 1024, 1024 * 1024, 'double', true, true, 105,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN', 'USB', 'ETHER', 'ADC', 'DAC', 'DMA', 'GPT', 'RTC', 'SDHI', 'GLCDC', 'DRW', 'JPEG', 'NPU', 'OSPI'],
		[mem('CODE_FLASH', 0x00000000, 2048 * 1024, 'read-only'), mem('SRAM0', 0x20000000, 1024 * 1024), mem('SRAM1', 0x22000000, 128 * 1024)],
		['EK-RA8D1'],
		['ra8d1', 'ra8', 'renesas', 'cortex-m85', '480mhz', 'ai', 'npu', 'helium']),

	// ─── Nordic nRF54 ────────────────────────────────────────────────────
	e('nRF54L15-QKAA', 'nRF54', 'nRF54L15', 'Nordic Semiconductor',
		'cortex-m33', 256, 1536 * 1024, 256 * 1024, 'single', true, true, 50,
		[...NORDIC_COMMON_PERIPHS, 'BLE6', 'Thread', 'Zigbee', 'Matter', 'DECT-NR+', 'AES', 'PKA', 'USB'],
		[mem('FLASH', 0x00000000, 1536 * 1024, 'read-only'), mem('RAM', 0x20000000, 256 * 1024)],
		['nRF54L15 DK'],
		['nrf54l15', 'nrf54', 'nordic', 'ble6', 'matter', 'thread', 'dect-nr+']),

	// ─── Infineon PSoC 6 — Dual-core ARM ─────────────────────────────────
	e('CY8C6347BZI-BLD53', 'PSoC 6', 'PSoC 62', 'Infineon',
		'cortex-m4', 150, 1024 * 1024, 288 * 1024, 'single', true, true, 79,
		['GPIO', 'SCB', 'TCPWM', 'SAR_ADC', 'CTDAC', 'USB', 'BLE', 'WIFI', 'DMA', 'RTC', 'WDT', 'CAN_FD', 'SMIF'],
		[mem('FLASH', 0x10000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x08000000, 288 * 1024)],
		['CY8CKIT-062-BLE', 'CY8CPROTO-063-BLE'],
		['cy8c6347', 'psoc6', 'psoc 6', 'infineon', 'cypress', 'dual-core', 'ble', 'trustzone']),

	e('CY8C6244LQI-S4D92', 'PSoC 6', 'PSoC 64', 'Infineon',
		'cortex-m4', 150, 2048 * 1024, 1024 * 1024, 'single', true, true, 104,
		['GPIO', 'SCB', 'TCPWM', 'SAR_ADC', 'USB', 'DMA', 'RTC', 'WDT', 'SMIF', 'TFM', 'CAN_FD'],
		[mem('SECURE_FLASH', 0x10000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x08000000, 512 * 1024)],
		['CY8CKIT-064B0S2-4343W', 'CY8CPROTO-064B0S3'],
		['cy8c624', 'psoc64', 'psoc 64', 'infineon', 'cypress', 'secure', 'iot', 'aws', 'azure']),

	// ─── SiFive RISC-V ───────────────────────────────────────────────────
	e('FE310-G002', 'FE310', 'FE310-G002', 'SiFive',
		'risc-v', 320, 4 * 1024 * 1024, 16 * 1024, 'none', false, false, 19,
		['GPIO', 'UART', 'SPI', 'I2C', 'PWM', 'QSPI', 'DMA', 'RTC', 'WDT'],
		[mem('QSPI_FLASH', 0x20000000, 4 * 1024 * 1024, 'read-only'), mem('DTIM', 0x80000000, 16 * 1024)],
		['HiFive1 Rev B', 'SparkFun RED-V RedBoard'],
		['fe310', 'sifive', 'risc-v', 'hifive', 'freedom', 'open-source']),

	e('FU740-C000', 'FU740', 'FU740-C000', 'SiFive',
		'risc-v', 1800, 0, 8192 * 1024, 'none', false, false, 64,
		['GPIO', 'UART', 'SPI', 'I2C', 'PCIe', 'DDR', 'GEM_MAC', 'DMA'],
		[mem('DDR', 0x80000000, 8192 * 1024), mem('L2_CACHE', 0x08000000, 2048 * 1024)],
		['HiFive Unmatched'],
		['fu740', 'sifive', 'risc-v', 'hifive unmatched', 'linux capable', '4-core']),

	// ─── Renesas RX72M / RA6T2 ───────────────────────────────────────────
	e('R5F572MNNDFB', 'RX72M', 'RX72M', 'Renesas',
		'rx', 240, 4096 * 1024, 1024 * 1024, 'double', true, true, 177,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN', 'USB', 'ETHER', 'ADC', 'DMA', 'GPT', 'RTC', 'GLCDC', 'DRW', 'JPEG'],
		[mem('ROM', 0xFF000000, 4096 * 1024, 'read-only'), mem('RAM0', 0x00000000, 1024 * 1024)],
		['RSK-RX72M'],
		['rx72m', 'rx', 'renesas', 'ethernet', 'graphics', 'industrial']),

	e('R7FA6T2AB3CFM', 'RA6', 'RA6T2', 'Renesas',
		'cortex-m33', 240, 1024 * 1024, 128 * 1024, 'double', true, true, 48,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN_FD', 'ADC', 'DAC', 'DMA', 'GPT', 'RTC', 'IOPORT', 'POEG', 'EQDC', 'MTU3', 'GLCDC'],
		[mem('CODE_FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 128 * 1024)],
		['MCK-RA6T2'],
		['ra6t2', 'ra6', 'renesas', 'motor control', 'can-fd', 'high-speed']),

	// ─── Microchip SAM E70 — Cortex-M7 Ethernet ──────────────────────────
	e('ATSAME70Q21B', 'SAM E70', 'SAME70', 'Microchip',
		'cortex-m7', 300, 2048 * 1024, 384 * 1024, 'double', true, true, 103,
		['GPIO', 'USART', 'SPI', 'TWIHS', 'CAN', 'GMAC', 'SDHC', 'USB', 'ADC', 'DAC', 'DMA', 'TC', 'PWM', 'QSPI', 'XDMAC', 'ISI'],
		[mem('FLASH', 0x00400000, 2048 * 1024, 'read-only'), mem('SRAM0', 0x20400000, 256 * 1024), mem('SRAM1', 0x20400000, 64 * 1024), mem('TCM', 0x00000000, 64 * 1024)],
		['SAM E70 Xplained Ultra'],
		['same70', 'sam e70', 'microchip', 'cortex-m7', 'ethernet', 'usb hs', 'isi']),

	e('ATSAMS70Q21B', 'SAM S70', 'SAMS70', 'Microchip',
		'cortex-m7', 300, 2048 * 1024, 384 * 1024, 'double', true, true, 66,
		['GPIO', 'USART', 'SPI', 'TWIHS', 'CAN', 'USB', 'ADC', 'DAC', 'XDMAC', 'TC', 'PWM'],
		[mem('FLASH', 0x00400000, 2048 * 1024, 'read-only'), mem('SRAM', 0x20400000, 384 * 1024)],
		['SAM S70 Xplained'],
		['sams70', 'sam s70', 'microchip', 'cortex-m7']),

	// ─── Kinetis E / KE series ───────────────────────────────────────────
	e('MKE18F512VLL16', 'Kinetis E', 'KE18F', 'NXP',
		'cortex-m4', 168, 512 * 1024, 64 * 1024, 'single', true, true, 100,
		['GPIO', 'LPUART', 'LPSPI', 'LPI2C', 'CAN', 'ADC', 'DAC', 'DMA', 'FTM', 'PIT', 'CMP', 'WDOG'],
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 64 * 1024)],
		['FRDM-KE18F'],
		['ke18f', 'kinetis e', 'nxp', 'frdm-ke18f', 'automotive grade', '5v tolerant']),

	// ─── TI C2000 more variants ───────────────────────────────────────────
	e('TMS320F28388D', 'C2000', 'F28388D', 'Texas Instruments',
		'c28x', 200, 1536 * 1024, 212 * 1024, 'single', false, true, 169,
		['GPIO', 'SCI', 'SPI', 'I2C', 'CAN', 'ePWM', 'eCAP', 'eQEP', 'ADC', 'DAC', 'CMPSS', 'DMA', 'CLB', 'FSI', 'PMBus', 'EtherCAT'],
		[mem('FLASH', 0x080000, 1536 * 1024, 'read-only'), mem('GSRAM', 0x00C000, 212 * 1024)],
		['TMDSCNCD28388D', 'C2000 EtherCAT board'],
		['f28388d', 'c2000', 'ti', 'ethercat', 'industrial', 'motor control']),

	e('TMS320F28P650DK', 'C2000', 'F28P65x', 'Texas Instruments',
		'c28x', 200, 1024 * 1024, 212 * 1024, 'single', false, true, 169,
		['GPIO', 'SCI', 'SPI', 'I2C', 'CAN', 'ePWM', 'eCAP', 'eQEP', 'ADC', 'DAC', 'CMPSS', 'DMA', 'CLB', 'FSI', 'SENT'],
		[mem('FLASH', 0x080000, 1024 * 1024, 'read-only'), mem('GSRAM', 0x00C000, 212 * 1024)],
		['LAUNCHXL-F28P65X'],
		['f28p65x', 'f28p650', 'c2000', 'ti', 'motor control', 'ev charger', 'solar']),

	// ─── AURIX TC3xx additional ───────────────────────────────────────────
	e('TC367DP', 'AURIX', 'TC36x', 'Infineon',
		'tricore', 300, 6144 * 1024, 1024 * 1024, 'single', true, true, 200,
		['GPIO', 'ASCLIN', 'QSPI', 'I2C', 'MultiCAN_FD', 'MSC', 'SENT', 'GTM', 'EVADC', 'HSM', 'DMA', 'EMEM', 'ETHERNET'],
		[mem('PMU_FLASH', 0xA0000000, 6144 * 1024, 'read-only'), mem('DSPR0', 0x70000000, 240 * 1024), mem('LMU', 0x90000000, 512 * 1024)],
		['KIT_A2G_TC367_5V_TRB'],
		['tc367', 'aurix', 'tricore', 'infineon', 'automotive', 'asil-d', 'lockstep']),

	// ─── Espressif ESP8266 ────────────────────────────────────────────────
	e('ESP8266EX', 'ESP8266', 'ESP8266', 'Espressif',
		'xtensa', 80, 4 * 1024 * 1024, 160 * 1024, 'none', false, false, 17,
		['GPIO', 'UART', 'SPI', 'I2C', 'PWM', 'ADC', 'WiFi', 'WDT', 'RTC'],
		[mem('IROM', 0x40200000, 4 * 1024 * 1024, 'read-only'), mem('DRAM', 0x3FFE8000, 80 * 1024), mem('IRAM', 0x40100000, 32 * 1024)],
		['ESP-01', 'ESP-12E', 'NodeMCU', 'Wemos D1 Mini'],
		['esp8266', 'esp8266ex', 'esp-01', 'nodemcu', 'wemos', 'esp-12e', 'espressif', 'wifi', 'iot', 'arduino-ota', '80mhz', 'classic']),

	// ─── NXP i.MX RT1050 ─────────────────────────────────────────────────
	e('MIMXRT1052DVL6B', 'i.MX RT', 'i.MX RT1050', 'NXP',
		'cortex-m7', 600, 0, 512 * 1024, 'double', true, true, 124,
		['GPIO', 'LPUART', 'LPSPI', 'LPI2C', 'GPT', 'PIT', 'ADC', 'USB', 'ENET', 'CAN', 'SEMC', 'CSI', 'LCDIF', 'DMA'],
		[mem('ITCM', 0x00000000, 512 * 1024), mem('DTCM', 0x20000000, 512 * 1024), mem('OCRAM', 0x20200000, 512 * 1024)],
		['MIMXRT1050-EVK', 'Teensy 4.0'],
		['imxrt1050', 'imxrt', 'nxp', 'crossover', 'teensy 4.0', 'ethernet']),

	// ─── STM32H5 — Cortex-M33 with TrustZone ─────────────────────────────
	e('STM32H573IIT6Q', 'STM32H5', 'STM32H573', 'STMicroelectronics',
		'cortex-m33', 250, 2048 * 1024, 640 * 1024, 'single', true, true, 114,
		[...STM32_COMMON_PERIPHS, 'USB', 'FDCAN', 'ETH', 'OCTOSPI', 'AES', 'PKA', 'RNG', 'HASH', 'SAI', 'SDMMC'],
		[mem('FLASH', 0x08000000, 2048 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 256 * 1024), mem('SRAM2', 0x20040000, 384 * 1024)],
		['NUCLEO-H573ZI'],
		['h573', 'stm32h573', 'stm32h5', 'trustzone', 'ethernet', 'usb hs']),

	e('STM32H503CBT6', 'STM32H5', 'STM32H503', 'STMicroelectronics',
		'cortex-m33', 250, 128 * 1024, 32 * 1024, 'single', true, true, 25,
		[...STM32_COMMON_PERIPHS, 'FDCAN', 'AES', 'PKA', 'RNG'],
		[mem('FLASH', 0x08000000, 128 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['NUCLEO-H503RB'],
		['h503', 'stm32h503', 'stm32h5', 'trustzone', 'value-line']),

	// ─── STM32H7RS — High-performance + HyperRAM ─────────────────────────
	e('STM32H7R7L8H6H', 'STM32H7RS', 'STM32H7R7', 'STMicroelectronics',
		'cortex-m7', 600, 64 * 1024, 620 * 1024, 'double', true, true, 168,
		[...STM32_ADVANCED_PERIPHS, 'XSPI', 'GFXMMU', 'GPU2D', 'LTDC', 'JPEG', 'MDMA', 'FDCAN', 'PSSI'],
		[mem('FLASH', 0x08000000, 64 * 1024, 'read-only'), mem('ITCM', 0x00000000, 64 * 1024), mem('DTCM', 0x20000000, 64 * 1024), mem('AXI_SRAM', 0x24000000, 456 * 1024)],
		['STM32H7S78-DK'],
		['h7r7', 'stm32h7rs', 'stm32h7', 'gpu2d', 'gfxmmu', 'hyperram', 'display']),

	// ─── STM32U5 extended ─────────────────────────────────────────────────
	e('STM32U545RET6Q', 'STM32U5', 'STM32U545', 'STMicroelectronics',
		'cortex-m33', 160, 512 * 1024, 256 * 1024, 'single', true, true, 51,
		[...STM32_COMMON_PERIPHS, 'FDCAN', 'OCTOSPI', 'SAI', 'AES', 'HASH', 'RNG'],
		[mem('FLASH', 0x08000000, 512 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 192 * 1024), mem('SRAM2', 0x20030000, 64 * 1024)],
		['NUCLEO-U545RE-Q'],
		['u545', 'stm32u545', 'stm32u5', 'ultra-low-power', 'trustzone']),

	// ─── Microchip PIC32MK ————————————————————————————————————————————────
	e('PIC32MK0512MCJ064', 'PIC32MK', 'PIC32MK MC', 'Microchip',
		'mips32', 120, 512 * 1024, 128 * 1024, 'double', false, false, 54,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN_FD', 'ADC', 'DAC', 'DMA', 'QEI', 'MCCP', 'SCCP', 'PWM'],
		[mem('PROGRAM_FLASH', 0x1D000000, 512 * 1024, 'read-only'), mem('DATA_RAM', 0x00000000, 128 * 1024)],
		['Curiosity PIC32MK MC'],
		['pic32mk', 'pic32mk mc', 'microchip', 'motor control', 'can-fd', 'mips32']),

	e('PIC32MK1024GPE100', 'PIC32MK', 'PIC32MK GP', 'Microchip',
		'mips32', 120, 1024 * 1024, 256 * 1024, 'double', false, false, 83,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN', 'USB', 'ADC', 'DAC', 'DMA', 'OC', 'IC', 'RTCC', 'ETHERNET'],
		[mem('PROGRAM_FLASH', 0x1D000000, 1024 * 1024, 'read-only'), mem('DATA_RAM', 0x00000000, 256 * 1024)],
		['Curiosity PIC32MK GP'],
		['pic32mk gp', 'pic32mk', 'microchip', 'ethernet', 'usb', 'mips32']),

	// ─── Kendryte K210 — RISC-V AI SoC ───────────────────────────────────
	e('K210', 'K210', 'K210', 'Kendryte',
		'risc-v', 400, 0, 8192 * 1024, 'double', false, true, 48,
		['GPIO', 'UART', 'SPI', 'I2C', 'I2S', 'AES', 'SHA256', 'FFT', 'DMA', 'DVP', 'SYSCTL', 'KPU', 'FPU'],
		[mem('SRAM', 0x80000000, 6 * 1024 * 1024), mem('AI_SRAM', 0x80600000, 2 * 1024 * 1024)],
		['Sipeed Maixduino', 'Sipeed MAIX Bit', 'M5StickV', 'Yahboom K210'],
		['k210', 'kendryte', 'risc-v', 'ai', 'kpu', 'machine learning', 'face detection', 'sipeed']),

	// ─── Silicon Labs EFR32FG — Sub-GHz ──────────────────────────────────
	e('EFR32FG14P231F256GM48', 'EFR32FG', 'EFR32FG14', 'Silicon Labs',
		'cortex-m4', 40, 256 * 1024, 32 * 1024, 'single', true, true, 27,
		['GPIO', 'USART', 'I2C', 'TIMER', 'ADC', 'DMA', 'Sub-GHz_Radio', 'AES', 'SHA'],
		[mem('FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['EFR32FG14 Radio Board'],
		['efr32fg14', 'efr32fg', 'silabs', 'sub-ghz', 'lorawan', 'wisun', 'proprietary']),

	// ─── Renesas RA4E1/RA6E2 ─────────────────────────────────────────────
	e('R7FA4E10D2CFM', 'RA4', 'RA4E1', 'Renesas',
		'cortex-m33', 100, 512 * 1024, 128 * 1024, 'single', true, true, 64,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN_FD', 'USB', 'ADC', 'DAC', 'DMA', 'GPT', 'RTC', 'WDT', 'QSPI'],
		[mem('CODE_FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 128 * 1024)],
		['EK-RA4E1'],
		['ra4e1', 'ra4', 'renesas', 'can-fd', 'trustzone-m']),

	e('R7FA6E2BB3CFM', 'RA6', 'RA6E2', 'Renesas',
		'cortex-m33', 200, 512 * 1024, 128 * 1024, 'single', true, true, 72,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN_FD', 'USB', 'ETH', 'ADC', 'DAC', 'DMA', 'GPT', 'RTC', 'WDT', 'QSPI'],
		[mem('CODE_FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 128 * 1024)],
		['EK-RA6E2'],
		['ra6e2', 'ra6', 'renesas', 'can-fd', 'ethernet', 'trustzone']),

	// ─── MAX32 — Maxim (now Analog Devices) ──────────────────────────────
	e('MAX32670', 'MAX32', 'MAX32670', 'Analog Devices',
		'cortex-m4', 100, 384 * 1024, 160 * 1024, 'single', true, true, 31,
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'DMA', 'RTC', 'WDT', 'AES', 'TRNG', 'I3C'],
		[mem('FLASH', 0x10000000, 384 * 1024, 'read-only'), mem('SRAM', 0x20000000, 160 * 1024)],
		['MAX32670EVKIT'],
		['max32670', 'max32', 'maxim', 'analog devices', 'ultra-low-power', 'i3c']),

	e('MAX32690', 'MAX32', 'MAX32690', 'Analog Devices',
		'cortex-m4', 120, 3072 * 1024, 1024 * 1024, 'single', true, true, 55,
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'DMA', 'RTC', 'WDT', 'AES', 'TRNG', 'CNN', 'USB', 'SDIO'],
		[mem('FLASH', 0x10000000, 3072 * 1024, 'read-only'), mem('SRAM', 0x20000000, 1024 * 1024)],
		['MAX32690EVKIT'],
		['max32690', 'max32', 'maxim', 'analog devices', 'ai', 'cnn', 'microml']),

	// ─── Bosch BMA / BME interface MCU examples ──────────────────────────
	e('SAMR34J18B', 'SAM R34', 'SAMR34', 'Microchip',
		'cortex-m0+', 48, 256 * 1024, 40 * 1024, 'none', false, false, 33,
		['GPIO', 'SERCOM', 'TC', 'ADC', 'DAC', 'DMAC', 'RTC', 'WDT', 'EIC', 'Sub-GHz_Radio'],
		[mem('FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 40 * 1024)],
		['SAM R34 Xplained Pro', 'WLR089U0 Module'],
		['samr34', 'sam r34', 'microchip', 'lora', 'lorawan', 'sub-ghz', 'ism radio']),

	// ─── STM32WL dual-core extended ───────────────────────────────────────
	e('STM32WL55JCI6', 'STM32WL', 'STM32WL55', 'STMicroelectronics',
		'cortex-m4', 48, 256 * 1024, 64 * 1024, 'single', true, false, 43,
		[...STM32_COMMON_PERIPHS, 'SUBGHZ_RADIO', 'AES', 'RNG', 'PKA'],
		[mem('FLASH', 0x08000000, 256 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 32 * 1024), mem('SRAM2', 0x20008000, 16 * 1024)],
		['NUCLEO-WL55JC'],
		['stm32wl55', 'stm32wl', 'lora', 'lorawan', 'sub-ghz', 'dual-core']),

	// ─── Infineon AURIX TC2xx ─────────────────────────────────────────────
	e('TC237LP', 'AURIX', 'TC23x', 'Infineon',
		'tricore', 200, 4096 * 1024, 248 * 1024, 'single', true, true, 157,
		['GPIO', 'ASCLIN', 'QSPI', 'MultiCAN', 'SENT', 'GTM', 'EVADC', 'HSM', 'DMA'],
		[mem('PMU_FLASH', 0xA0000000, 4096 * 1024, 'read-only'), mem('DSPR0', 0x70000000, 248 * 1024)],
		['KIT_AURIX_TC237_TRB'],
		['tc237', 'aurix', 'tricore', 'infineon', 'automotive', 'asil-b']),

	e('TC299TP', 'AURIX', 'TC29x', 'Infineon',
		'tricore', 200, 16384 * 1024, 1024 * 1024, 'double', true, true, 239,
		['GPIO', 'ASCLIN', 'QSPI', 'MultiCAN', 'SENT', 'GTM', 'EVADC', 'HSM', 'DMA', 'EMEM', 'ETHERNET', 'FlexRay'],
		[mem('PMU_FLASH', 0xA0000000, 16384 * 1024, 'read-only'), mem('DSPR0', 0x70000000, 240 * 1024), mem('LMU', 0x90000000, 512 * 1024)],
		['KIT_AURIX_TC299_TRB'],
		['tc299', 'aurix', 'tricore', 'infineon', 'automotive', 'asil-d', 'flexray']),

	// ─── NXP S32K — Automotive Cortex-M ──────────────────────────────────
	e('S32K144HAT0MLHR', 'S32K', 'S32K144', 'NXP',
		'cortex-m4', 112, 512 * 1024, 64 * 1024, 'single', true, true, 100,
		['GPIO', 'LPUART', 'LPSPI', 'LPI2C', 'FlexCAN', 'ADC', 'DAC', 'DMA', 'FTM', 'PIT', 'CMP', 'CRC', 'WDOG'],
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM_L', 0x1FFF8000, 32 * 1024), mem('SRAM_U', 0x20000000, 32 * 1024)],
		['S32K144EVB-Q100'],
		['s32k144', 's32k', 'nxp', 'automotive', 'autosar', 'iso26262', 'can', 'asil-b']),

	e('S32K312', 'S32K3', 'S32K312', 'NXP',
		'cortex-m7', 240, 2048 * 1024, 512 * 1024, 'double', true, true, 130,
		['GPIO', 'LPUART', 'LPSPI', 'LPI2C', 'FlexCAN_FD', 'ADC', 'DMA', 'GTM', 'PIT', 'CRC', 'WDOG', 'HSE'],
		[mem('FLASH', 0x00400000, 2048 * 1024, 'read-only'), mem('SRAM0', 0x20400000, 256 * 1024), mem('SRAM1', 0x20440000, 256 * 1024)],
		['S32K312 EVB'],
		['s32k312', 's32k3', 'nxp', 'automotive', 'can-fd', 'asil-d', 'autosar']),

	// ─── STM32F0 extended ─────────────────────────────────────────────────
	e('STM32F042K6T6', 'STM32F0', 'STM32F042', 'STMicroelectronics',
		'cortex-m0', 48, 32 * 1024, 6 * 1024, 'none', false, false, 25,
		['GPIO', 'USART', 'SPI', 'I2C', 'USB', 'ADC', 'DMA', 'TIM', 'RTC', 'CAN', 'CEC', 'WDT'],
		[mem('FLASH', 0x08000000, 32 * 1024, 'read-only'), mem('SRAM', 0x20000000, 6 * 1024)],
		[], ['f042', 'stm32f042', 'stm32f0', 'usb', 'can']),

	e('STM32F091RCT6', 'STM32F0', 'STM32F091', 'STMicroelectronics',
		'cortex-m0', 48, 256 * 1024, 32 * 1024, 'none', false, false, 51,
		['GPIO', 'USART', 'SPI', 'I2C', 'CAN', 'CEC', 'ADC', 'DAC', 'DMA', 'TIM', 'RTC', 'WDT'],
		[mem('FLASH', 0x08000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['NUCLEO-F091RC'], ['f091', 'stm32f091', 'stm32f0', 'can']),

	// ─── STM32G0 extended ─────────────────────────────────────────────────
	e('STM32G031J6M6', 'STM32G0', 'STM32G031', 'STMicroelectronics',
		'cortex-m0+', 64, 32 * 1024, 8 * 1024, 'none', false, false, 8,
		['GPIO', 'USART', 'SPI', 'I2C', 'ADC', 'DMA', 'RTC', 'LPTIM', 'WDT'],
		[mem('FLASH', 0x08000000, 32 * 1024, 'read-only'), mem('SRAM', 0x20000000, 8 * 1024)],
		[], ['g031', 'stm32g031', 'stm32g0', 'sot23-8', 'tiny']),

	// ─── TI MSP432 — Cortex-M4F Ultra-low-power ──────────────────────────
	e('MSP432P401R', 'MSP432', 'MSP432P401R', 'Texas Instruments',
		'cortex-m4', 48, 256 * 1024, 64 * 1024, 'single', true, true, 84,
		['GPIO', 'EUSCI_A', 'EUSCI_B', 'TIMER_A', 'TIMER32', 'ADC14', 'DMA', 'RTC', 'WDT', 'AES256', 'CRC32'],
		[mem('FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 64 * 1024)],
		['MSP-EXP432P401R LaunchPad'],
		['msp432p401r', 'msp432', 'ti', 'cortex-m4', 'ultra-low-power', 'launchpad']),

	e('MSP432E401Y', 'MSP432', 'MSP432E401Y', 'Texas Instruments',
		'cortex-m4', 120, 1024 * 1024, 256 * 1024, 'single', true, true, 111,
		['GPIO', 'UART', 'SSI', 'I2C', 'CAN', 'USB', 'ENET', 'ADC', 'DAC', 'DMA', 'QEI', 'WDT'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 256 * 1024)],
		['MSP-EXP432E401Y LaunchPad'],
		['msp432e401y', 'msp432e', 'ti', 'ethernet', 'usb', '120mhz']),

	// ─── Microchip dsPIC33 — DSP Motor Control ───────────────────────────
	e('dsPIC33EP512MU810', 'dsPIC33', 'dsPIC33EP', 'Microchip',
		'other', 70, 512 * 1024, 52 * 1024, 'single', false, true, 85,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN', 'ADC', 'DAC', 'DMA', 'PWM', 'QEI', 'PTGO', 'REFO', 'CTMUi'],
		[mem('PROGRAM_FLASH', 0x000000, 512 * 1024, 'read-only'), mem('DATA_RAM', 0x000800, 52 * 1024)],
		['Explorer 16/32', 'dsPICDEM MC1H'],
		['dspic33ep', 'dspic33', 'microchip', 'dsp', 'motor control', 'foc']),

	e('dsPIC33CK256MP508', 'dsPIC33', 'dsPIC33CK', 'Microchip',
		'other', 100, 256 * 1024, 48 * 1024, 'double', false, true, 68,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN_FD', 'ADC', 'DAC', 'DMA', 'PWM', 'QEI', 'CMP', 'SENT'],
		[mem('PROGRAM_FLASH', 0x000000, 256 * 1024, 'read-only'), mem('DATA_RAM', 0x000800, 48 * 1024)],
		['Curiosity Development Board dsPIC33CK'],
		['dspic33ck', 'dspic33', 'microchip', 'dsp', 'motor control', 'can-fd', 'foc']),

	// ─── Nordic nRF52 low-end variants ───────────────────────────────────
	e('nRF52805-CAAA', 'nRF52', 'nRF52805', 'Nordic Semiconductor',
		'cortex-m4', 64, 192 * 1024, 24 * 1024, 'single', false, false, 18,
		['GPIO', 'UARTE', 'SPIM', 'TWIM', 'TIMER', 'SAADC', 'PWM', 'RTC', 'WDT', 'RADIO'],
		[mem('FLASH', 0x00000000, 192 * 1024, 'read-only'), mem('RAM', 0x20000000, 24 * 1024)],
		['nRF52805 DK'],
		['nrf52805', 'nrf52', 'ble', 'bluetooth', 'wearable', 'smallest nrf52']),

	// ─── Raspberry Pi RP2040 industrial variants ──────────────────────────
	e('W55RP20', 'RP2040', 'W55RP20', 'WIZnet',
		'cortex-m0+', 133, 0, 264 * 1024, 'none', false, false, 24,
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'PWM', 'PIO', 'USB', 'DMA', 'W5500_MAC'],
		[mem('XIP_FLASH', 0x10000000, 2 * 1024 * 1024), mem('SRAM', 0x20000000, 264 * 1024)],
		['WIZnet W55RP20-EVB-Pico'],
		['w55rp20', 'rp2040', 'wiznet', 'ethernet', 'w5500', 'hardwired tcp']),

	// ─── STM32F2 ─────────────────────────────────────────────────────────
	e('STM32F207ZGT6', 'STM32F2', 'STM32F207', 'STMicroelectronics',
		'cortex-m3', 120, 1024 * 1024, 128 * 1024, 'none', true, false, 114,
		[...STM32_ADVANCED_PERIPHS, 'ETHERNET', 'DCMI', 'CRYP', 'HASH', 'RNG'],
		[mem('FLASH', 0x08000000, 1024 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 112 * 1024), mem('SRAM2', 0x2001C000, 16 * 1024)],
		[], ['f207', 'stm32f207', 'stm32f2', 'ethernet', 'crypto']),

	// ─── Microchip PIC24 ─────────────────────────────────────────────────
	e('PIC24FJ256GA412', 'PIC24', 'PIC24FJ', 'Microchip',
		'other', 64, 256 * 1024, 96 * 1024, 'none', false, false, 100,
		['GPIO', 'UART', 'SPI', 'I2C', 'USB', 'ADC', 'DMA', 'OC', 'IC', 'RTCC', 'WDT', 'CRC'],
		[mem('PROGRAM_FLASH', 0x000000, 256 * 1024, 'read-only'), mem('DATA_RAM', 0x000800, 96 * 1024)],
		['Explorer 16/32', 'PIC24 Starter Kit'],
		['pic24fj', 'pic24', 'microchip', 'usb', '16-bit']),

	// ─── TI Tiva-C — Cortex-M4F ──────────────────────────────────────────
	e('TM4C1294NCPDT', 'TM4C', 'TM4C1294', 'Texas Instruments',
		'cortex-m4', 120, 1024 * 1024, 256 * 1024, 'single', true, true, 90,
		['GPIO', 'UART', 'SSI', 'I2C', 'CAN', 'USB', 'ENET', 'ADC', 'QEI', 'DMA', 'PWM', 'WDT'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 256 * 1024)],
		['EK-TM4C1294XL Connected LaunchPad'],
		['tm4c1294', 'tm4c', 'tiva-c', 'ti', 'ethernet', 'usb', 'cortex-m4']),

	e('TM4C123GH6PM', 'TM4C', 'TM4C123G', 'Texas Instruments',
		'cortex-m4', 80, 256 * 1024, 32 * 1024, 'single', true, true, 43,
		['GPIO', 'UART', 'SSI', 'I2C', 'CAN', 'USB', 'ADC', 'QEI', 'DMA', 'PWM', 'WDT'],
		[mem('FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['EK-TM4C123GXL Tiva C LaunchPad'],
		['tm4c123', 'tiva-c', 'ti', 'stellaris', 'usb', 'cortex-m4']),

	// ─── Infineon XMC4000 — Cortex-M4 Industrial ─────────────────────────
	e('XMC4800-F144K2048AA', 'XMC4', 'XMC4800', 'Infineon',
		'cortex-m4', 144, 2048 * 1024, 352 * 1024, 'single', true, true, 120,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN', 'USB', 'ETH', 'ADC', 'DAC', 'DMA', 'CCU4', 'CCU8', 'POSIF', 'EtherCAT', 'SDMMC'],
		[mem('FLASH', 0x08000000, 2048 * 1024, 'read-only'), mem('PSRAM', 0x1FFE8000, 352 * 1024)],
		['XMC4800 Relax EtherCAT Kit'],
		['xmc4800', 'xmc4', 'infineon', 'ethercat', 'industrial', 'motor control', 'cortex-m4']),

	e('XMC4700-F144K2048AA', 'XMC4', 'XMC4700', 'Infineon',
		'cortex-m4', 144, 2048 * 1024, 352 * 1024, 'single', true, true, 120,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN', 'USB', 'ETH', 'ADC', 'DAC', 'DMA', 'CCU4', 'CCU8', 'POSIF', 'SDMMC'],
		[mem('FLASH', 0x08000000, 2048 * 1024, 'read-only'), mem('PSRAM', 0x1FFE8000, 352 * 1024)],
		['XMC4700 Relax Kit'],
		['xmc4700', 'xmc4', 'infineon', 'ethernet', 'industrial', 'cortex-m4']),

	e('XMC1302-T016X0064AA', 'XMC1', 'XMC1302', 'Infineon',
		'cortex-m0', 32, 64 * 1024, 16 * 1024, 'none', false, false, 16,
		['GPIO', 'USIC', 'CCU4', 'CCU8', 'POSIF', 'ADC', 'DAC', 'WDT', 'ERU'],
		[mem('FLASH', 0x10001000, 64 * 1024, 'read-only'), mem('SRAM', 0x20000000, 16 * 1024)],
		['XMC1302 Boot Kit'],
		['xmc1302', 'xmc1', 'infineon', 'motor control', 'cortex-m0', 'low-cost']),

	// ─── STM32L5 — Cortex-M33 TrustZone ─────────────────────────────────
	e('STM32L562QEI6Q', 'STM32L5', 'STM32L562', 'STMicroelectronics',
		'cortex-m33', 110, 512 * 1024, 256 * 1024, 'single', true, true, 114,
		[...STM32_COMMON_PERIPHS, 'USB', 'FDCAN', 'OCTOSPI', 'SAI', 'AES', 'PKA', 'HASH', 'RNG', 'DFSDM'],
		[mem('FLASH', 0x08000000, 512 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 192 * 1024), mem('SRAM2', 0x20030000, 64 * 1024)],
		['STM32L562E-DK', 'NUCLEO-L552ZE-Q'],
		['l562', 'stm32l562', 'stm32l5', 'trustzone', 'ultra-low-power']),

	// ─── Microchip SAMA5 — Linux-capable ARM Cortex-A5 ───────────────────
	e('ATSAMA5D27C-D1G-CU', 'SAMA5', 'SAMA5D27', 'Microchip',
		'cortex-a', 500, 0, 0, 'none', true, false, 128,
		['GPIO', 'UART', 'SPI', 'TWIHS', 'CAN', 'USB', 'GMAC', 'SDMMC', 'ADC', 'DMA', 'TC', 'PWM', 'ISC', 'CLASSD', 'DDR3'],
		[mem('DDR', 0x20000000, 128 * 1024 * 1024), mem('SRAM', 0x00200000, 128 * 1024), mem('SRAM1', 0x00300000, 128 * 1024)],
		['SAMA5D27 SOM1 Kit', 'ATSAMA5D27-SOM1-EK1'],
		['sama5d27', 'sama5', 'microchip', 'linux', 'cortex-a5', 'ddr3', 'ethernet']),

	// ─── RISC-V Espressif extended ────────────────────────────────────────
	e('ESP32-C5-WROOM', 'ESP32', 'ESP32-C5', 'Espressif',
		'risc-v', 240, 4 * 1024 * 1024, 512 * 1024, 'none', false, false, 28,
		[...ESP_COMMON_PERIPHS, 'TWAI', 'IEEE802154', 'USB_SERIAL_JTAG'],
		[mem('IROM', 0x42000000, 4 * 1024 * 1024, 'read-only'), mem('IRAM', 0x40800000, 512 * 1024)],
		['ESP32-C5 DevKit'],
		['esp32c5', 'esp32-c5', 'espressif', 'risc-v', 'wifi6e', 'ble5.3', 'thread', 'zigbee', 'matter', 'dual-band', '2.4ghz-5ghz']),

	// ─── Bouffalo Lab BL616 ───────────────────────────────────────────────
	e('BL616', 'BL61x', 'BL616', 'Bouffalo Lab',
		'risc-v', 320, 4 * 1024 * 1024, 480 * 1024, 'single', false, false, 35,
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'DAC', 'PWM', 'WiFi6', 'BT', 'DMA', 'RTC', 'USB'],
		[mem('FLASH', 0x23000000, 4 * 1024 * 1024, 'read-only'), mem('RAM', 0x22008000, 480 * 1024)],
		['Sipeed M0S', 'Pine64 Ox64'],
		['bl616', 'bouffalo', 'risc-v', 'wifi6', 'ble', 'usb']),

	// ─── GigaDevice GD32L23x — Ultra-low-power ───────────────────────────
	e('GD32L233RCT6', 'GD32L', 'GD32L233', 'GigaDevice',
		'cortex-m23', 64, 256 * 1024, 32 * 1024, 'none', true, false, 51,
		['GPIO', 'USART', 'SPI', 'I2C', 'ADC', 'DAC', 'DMA', 'RTC', 'LPTIMER', 'WDT', 'CMP', 'SLCD'],
		[mem('FLASH', 0x08000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['GD32L233R-START'],
		['gd32l233', 'gd32l', 'gigadevice', 'ultra-low-power', 'cortex-m23', 'trustzone']),

	// ─── Arm Virtual Targets (placeholder for QEMU testing) ──────────────
	e('MPS2-AN386', 'Virtual', 'MPS2+ Cortex-M4', 'Arm',
		'cortex-m4', 25, 4096 * 1024, 4096 * 1024, 'single', true, true, 0,
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'DMA', 'RTC', 'WDT'],
		[mem('CODE', 0x00000000, 4096 * 1024), mem('SRAM', 0x20000000, 4096 * 1024)],
		['QEMU MPS2+ AN386', 'Arm MPS2+ FPGA Board'],
		['mps2', 'an386', 'arm', 'qemu', 'virtual', 'simulation', 'fvp', 'model']),

	// ─── RISC-V AllWinner D1 ─────────────────────────────────────────────
	e('D1-H', 'D1', 'AllWinner D1', 'AllWinner',
		'risc-v', 1000, 0, 0, 'double', false, true, 128,
		['GPIO', 'UART', 'SPI', 'I2C', 'USB', 'GMAC', 'MIPI_DSI', 'MIPI_CSI', 'DDR3', 'EMMC', 'AUDIO', 'DMA'],
		[mem('DDR3', 0x40000000, 512 * 1024 * 1024), mem('SRAM_A', 0x00020000, 64 * 1024)],
		['MangoPi MQ Pro', 'Sipeed Lichee RV', 'D1 Nezha'],
		['d1', 'allwinner', 'risc-v', 'linux', 'xuantie', 'c906', 'rv64gc']),

	// ─── STM32F1 more variants ────────────────────────────────────────────
	e('STM32F107VCT6', 'STM32F1', 'STM32F107', 'STMicroelectronics',
		'cortex-m3', 72, 256 * 1024, 64 * 1024, 'none', false, false, 80,
		[...STM32_COMMON_PERIPHS, 'USB_OTG', 'CAN', 'ETHERNET'],
		[mem('FLASH', 0x08000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 64 * 1024)],
		[], ['f107', 'stm32f107', 'stm32f1', 'connectivity', 'ethernet']),

	e('STM32F100RBT6B', 'STM32F1', 'STM32F100', 'STMicroelectronics',
		'cortex-m3', 24, 128 * 1024, 8 * 1024, 'none', false, false, 51,
		['GPIO', 'USART', 'SPI', 'I2C', 'ADC', 'DAC', 'DMA', 'TIM', 'RTC', 'WDT'],
		[mem('FLASH', 0x08000000, 128 * 1024, 'read-only'), mem('SRAM', 0x20000000, 8 * 1024)],
		['STM32VLDISCOVERY'], ['f100', 'stm32f100', 'stm32f1', 'value-line', 'discovery']),

	// ─── STM32F4 more ─────────────────────────────────────────────────────
	e('STM32F405RGT6', 'STM32F4', 'STM32F405', 'STMicroelectronics',
		'cortex-m4', 168, 1024 * 1024, 192 * 1024, 'single', true, true, 51,
		[...STM32_ADVANCED_PERIPHS, 'USB_OTG'],
		[mem('FLASH', 0x08000000, 1024 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 112 * 1024), mem('SRAM2', 0x2001C000, 16 * 1024), mem('CCM', 0x10000000, 64 * 1024)],
		['PyBoard v1.x', 'STM32F4 Discovery'], ['f405', 'stm32f405', 'micropython', 'pyboard']),

	e('STM32F415RGT6', 'STM32F4', 'STM32F415', 'STMicroelectronics',
		'cortex-m4', 168, 1024 * 1024, 192 * 1024, 'single', true, true, 51,
		[...STM32_ADVANCED_PERIPHS, 'USB_OTG', 'CRYP', 'HASH', 'RNG'],
		[mem('FLASH', 0x08000000, 1024 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 112 * 1024), mem('CCM', 0x10000000, 64 * 1024)],
		[], ['f415', 'stm32f415', 'stm32f4', 'crypto']),

	// ─── NXP i.MX RT1040 ─────────────────────────────────────────────────
	e('MIMXRT1042DVJ5B', 'i.MX RT', 'i.MX RT1040', 'NXP',
		'cortex-m7', 600, 4096 * 1024, 1024 * 1024, 'double', true, true, 124,
		['GPIO', 'LPUART', 'LPSPI', 'LPI2C', 'FlexCAN', 'USB', 'ENET', 'ADC', 'GPT', 'PIT', 'DMA'],
		[mem('FLASH', 0x60000000, 4096 * 1024, 'read-only'), mem('ITCM', 0x00000000, 256 * 1024), mem('DTCM', 0x20000000, 256 * 1024), mem('OCRAM', 0x20200000, 512 * 1024)],
		['MIMXRT1040-EVK'],
		['imxrt1040', 'imxrt', 'nxp', 'crossover', 'industrial', 'on-chip flash']),

	// ─── NXP LPC845 — Cortex-M0+ Low Cost ───────────────────────────────
	e('LPC845M301JBD64', 'LPC8', 'LPC845', 'NXP',
		'cortex-m0+', 30, 64 * 1024, 16 * 1024, 'none', false, false, 54,
		['GPIO', 'USART', 'SPI', 'I2C', 'ADC', 'DAC', 'DMA', 'SCT', 'CTIMER', 'WDT', 'CMP', 'CRC', 'MRT'],
		[mem('FLASH', 0x00000000, 64 * 1024, 'read-only'), mem('SRAM', 0x10000000, 16 * 1024)],
		['LPC845-BRK'],
		['lpc845', 'lpc8', 'nxp', 'cortex-m0+', 'budget', 'low-cost']),

	// ─── Renesas RA2A1 / RA6M4 ───────────────────────────────────────────
	e('R7FA2A1AB3CBF', 'RA2', 'RA2A1', 'Renesas',
		'cortex-m23', 48, 256 * 1024, 32 * 1024, 'none', true, false, 40,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'ADC', 'DAC', 'CTSU', 'DMA', 'GPT', 'RTC', 'WDT'],
		[mem('CODE_FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['EK-RA2A1'],
		['ra2a1', 'ra2', 'renesas', 'cortex-m23', 'touch', 'capacitive']),

	e('R7FA6M4AF3CFM', 'RA6', 'RA6M4', 'Renesas',
		'cortex-m33', 200, 1024 * 1024, 256 * 1024, 'single', true, true, 105,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN_FD', 'USB', 'ETHER', 'ADC', 'DAC', 'DMA', 'GPT', 'RTC', 'WDT', 'QSPI', 'OSPI'],
		[mem('CODE_FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 256 * 1024)],
		['EK-RA6M4'],
		['ra6m4', 'ra6', 'renesas', 'trustzone', 'can-fd', 'ethernet']),

	// ─── Microchip SAMD11 — smallest SAMD ────────────────────────────────
	e('ATSAMD11D14AM', 'SAM D11', 'SAMD11', 'Microchip',
		'cortex-m0+', 48, 16 * 1024, 4 * 1024, 'none', false, false, 16,
		['GPIO', 'SERCOM', 'TC', 'ADC', 'DAC', 'USB', 'DMAC', 'RTC', 'WDT', 'EIC'],
		[mem('FLASH', 0x00000000, 16 * 1024, 'read-only'), mem('SRAM', 0x20000000, 4 * 1024)],
		['SAMD11 Xplained Pro', 'Adafruit Trinket M0'],
		['samd11', 'sam d11', 'microchip', 'tiny', 'usb', 'trinket m0']),

	// ─── Microchip SAML11 — TrustZone Cortex-M23 ─────────────────────────
	e('ATSAML11E16A', 'SAM L11', 'SAML11', 'Microchip',
		'cortex-m23', 32, 64 * 1024, 16 * 1024, 'none', true, false, 22,
		['GPIO', 'SERCOM', 'TC', 'ADC', 'DAC', 'DMAC', 'RTC', 'WDT', 'EIC', 'IDAU'],
		[mem('FLASH', 0x00000000, 64 * 1024, 'read-only'), mem('SRAM', 0x20000000, 16 * 1024)],
		['SAM L11 Xplained Pro'],
		['saml11', 'sam l11', 'microchip', 'trustzone', 'cortex-m23', 'secure element']),

	// ─── Silicon Labs EFM32PG — Pearl Gecko ──────────────────────────────
	e('EFM32PG12B500F1024GL125', 'EFM32PG', 'EFM32PG12', 'Silicon Labs',
		'cortex-m4', 40, 1024 * 1024, 256 * 1024, 'single', true, true, 89,
		['GPIO', 'USART', 'I2C', 'TIMER', 'ADC', 'DAC', 'DMA', 'USB', 'LCD', 'RTC', 'WDT', 'CRYPTO'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 256 * 1024)],
		['EFM32PG12 Starter Kit'],
		['efm32pg12', 'efm32pg', 'silabs', 'pearl gecko', 'ultra-low-power', 'lcd']),

	// ─── ATmega extended ─────────────────────────────────────────────────
	e('ATmega32U4', 'AVR', 'ATmega32U4', 'Microchip',
		'avr', 16, 32 * 1024, 2560, 'none', false, false, 26,
		['GPIO', 'USART', 'SPI', 'TWI', 'TIMER', 'ADC', 'USB', 'WDT', 'EEPROM', 'PWM'],
		[mem('FLASH', 0x0000, 32 * 1024, 'read-only'), mem('SRAM', 0x0100, 2560), mem('EEPROM', 0x0000, 1024)],
		['Arduino Leonardo', 'Arduino Micro', 'Arduino Pro Micro', 'Adafruit Feather 32u4'],
		['atmega32u4', 'avr', 'arduino leonardo', 'arduino micro', 'usb hid', 'keyboard', 'mouse']),

	e('ATmega1284P', 'AVR', 'ATmega1284P', 'Microchip',
		'avr', 20, 128 * 1024, 16 * 1024, 'none', false, false, 32,
		['GPIO', 'USART', 'SPI', 'TWI', 'TIMER', 'ADC', 'WDT', 'EEPROM'],
		[mem('FLASH', 0x0000, 128 * 1024, 'read-only'), mem('SRAM', 0x0100, 16 * 1024), mem('EEPROM', 0x0000, 4096)],
		['Sanguinololu', 'Melzi 3D Printer Board'],
		['atmega1284p', 'avr', 'reprap', '3d printer', 'sanguinololu']),

	// ─── Cypress FM4 — Cortex-M4F ─────────────────────────────────────────
	e('MB9BF568R', 'FM4', 'FM4-S6E2CC', 'Infineon',
		'cortex-m4', 200, 2048 * 1024, 256 * 1024, 'single', true, true, 112,
		['GPIO', 'MFS', 'BT', 'ADC', 'DAC', 'DMA', 'USB', 'CAN', 'ETHERNET', 'SDIO', 'QSPI', 'LCD'],
		[mem('FLASH', 0x00000000, 2048 * 1024, 'read-only'), mem('SRAM', 0x1FFF0000, 256 * 1024)],
		['SK-FM4-176L-S6E2CC', 'SK-FM4-U120-9B560'],
		['fm4', 's6e2cc', 'cypress', 'infineon', 'cortex-m4', 'ethernet', 'industrial']),

	// ─── STM32F4 PyBoard / Feather extras ────────────────────────────────
	e('STM32F413ZHT6', 'STM32F4', 'STM32F413', 'STMicroelectronics',
		'cortex-m4', 100, 1024 * 1024, 320 * 1024, 'single', true, true, 114,
		[...STM32_COMMON_PERIPHS, 'QUADSPI', 'CAN', 'DFSDM', 'SAI', 'I2S', 'FMPI2C'],
		[mem('FLASH', 0x08000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 320 * 1024)],
		['NUCLEO-F413ZH'], ['f413', 'stm32f413', 'stm32f4', 'audio']),

	// ─── NXP Kinetis MKV58 ───────────────────────────────────────────────
	e('MKV58F1M0VLQ24', 'Kinetis V', 'KV58F', 'NXP',
		'cortex-m7', 240, 1024 * 1024, 256 * 1024, 'double', true, true, 100,
		['GPIO', 'LPUART', 'DSPI', 'I2C', 'FlexCAN', 'ADC', 'DAC', 'DMA', 'FlexTimer', 'eFlexPWM', 'ENC'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('SRAM_U', 0x20000000, 192 * 1024), mem('SRAM_L', 0x1FFC0000, 64 * 1024)],
		['TWR-KV58F220M'],
		['mkv58', 'kv58f', 'kinetis v', 'nxp', 'motor control', 'eflex', 'cortex-m7']),

	// ─── STM32G4 more ────────────────────────────────────────────────────
	e('STM32G473RET6', 'STM32G4', 'STM32G473', 'STMicroelectronics',
		'cortex-m4', 170, 512 * 1024, 128 * 1024, 'single', true, true, 51,
		[...STM32_COMMON_PERIPHS, 'FDCAN', 'HRTIM', 'OPAMP', 'COMP', 'CORDIC', 'FMAC', 'DAC', 'ADC5'],
		[mem('FLASH', 0x08000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 128 * 1024)],
		['NUCLEO-G473RE'], ['g473', 'stm32g473', 'stm32g4', 'motor control']),

	// ─── Puya PY32 — Budget RISC MCU (Chinese market) ────────────────────
	e('PY32F002AF15P', 'PY32', 'PY32F002A', 'Puya',
		'cortex-m0+', 24, 20 * 1024, 3 * 1024, 'none', false, false, 18,
		['GPIO', 'USART', 'SPI', 'I2C', 'TIM', 'ADC', 'WDT', 'RTC'],
		[mem('FLASH', 0x08000000, 20 * 1024, 'read-only'), mem('SRAM', 0x20000000, 3 * 1024)],
		['PY32F002A DevBoard'],
		['py32f002a', 'py32', 'puya', 'cortex-m0+', 'budget', 'chinese mcu', 'ultra-low-cost']),

	// ─── STM32H7 more ─────────────────────────────────────────────────────
	e('STM32H733VGT6', 'STM32H7', 'STM32H733', 'STMicroelectronics',
		'cortex-m7', 550, 1024 * 1024, 564 * 1024, 'double', true, true, 82,
		[...STM32_ADVANCED_PERIPHS, 'FMC', 'SAI', 'OCTOSPI', 'JPEG', 'MDMA', 'BDMA', 'FDCAN'],
		[mem('FLASH', 0x08000000, 1024 * 1024, 'read-only'), mem('DTCM', 0x20000000, 128 * 1024), mem('AXI_SRAM', 0x24000000, 320 * 1024)],
		['NUCLEO-H733ZG'], ['h733', 'stm32h733', 'stm32h7']),

	e('STM32H745ZIT6', 'STM32H7', 'STM32H745', 'STMicroelectronics',
		'cortex-m7', 480, 2048 * 1024, 1024 * 1024, 'double', true, true, 114,
		[...STM32_ADVANCED_PERIPHS, 'LTDC', 'FMC', 'SAI', 'QUADSPI', 'JPEG', 'MDMA', 'BDMA', 'FDCAN'],
		[mem('FLASH', 0x08000000, 2048 * 1024, 'read-only'), mem('DTCM', 0x20000000, 128 * 1024), mem('AXI_SRAM', 0x24000000, 512 * 1024)],
		['STM32H745I-DISCO', 'NUCLEO-H745ZI-Q'], ['h745', 'stm32h745', 'stm32h7', 'dual-core']),

	// ─── STM32C0 extended ─────────────────────────────────────────────────
	e('STM32C031C6T6', 'STM32C0', 'STM32C031', 'STMicroelectronics',
		'cortex-m0+', 48, 32 * 1024, 12 * 1024, 'none', false, false, 37,
		['GPIO', 'USART', 'SPI', 'I2C', 'ADC', 'DMA', 'RTC', 'LPTIM', 'WDT'],
		[mem('FLASH', 0x08000000, 32 * 1024, 'read-only'), mem('SRAM', 0x20000000, 12 * 1024)],
		['NUCLEO-C031C6'], ['c031', 'stm32c031', 'stm32c0', 'value-line', 'entry-level']),

	// ─── Renesas RX extended ──────────────────────────────────────────────
	e('R5F52305ADFM', 'RX231', 'RX231', 'Renesas',
		'rx', 54, 512 * 1024, 64 * 1024, 'double', false, true, 100,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'USB', 'ADC', 'DMA', 'TMR', 'GPT', 'RTC', 'WDT', 'CTSU'],
		[mem('ROM', 0xFFE00000, 512 * 1024, 'read-only'), mem('RAM', 0x00000000, 64 * 1024)],
		['RSK-RX231'],
		['rx231', 'rx', 'renesas', 'usb', 'capacitive touch', 'iot']),

	e('R5F51403ADFP', 'RX140', 'RX140', 'Renesas',
		'rx', 48, 256 * 1024, 64 * 1024, 'none', false, false, 71,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'ADC', 'DMA', 'TMR', 'RTC', 'WDT', 'CTSU'],
		[mem('ROM', 0xFFFC0000, 256 * 1024, 'read-only'), mem('RAM', 0x00000000, 64 * 1024)],
		['Target Board RX140'],
		['rx140', 'rx', 'renesas', 'ultra-low-power', 'capacitive touch']),

	// ─── NXP S32G — Automotive Network Processor ─────────────────────────
	e('S32G399A', 'S32G', 'S32G399A', 'NXP',
		'cortex-a', 1000, 0, 0, 'none', true, false, 200,
		['GPIO', 'UART', 'SPI', 'I2C', 'FlexCAN_FD', 'GMAC', 'PCIe', 'DDR4', 'LLCE', 'HSE', 'PFE'],
		[mem('DDR4', 0x80000000, 4096 * 1024 * 1024), mem('SRAM', 0x34000000, 8 * 1024 * 1024)],
		['S32G-VNP-RDB2', 'S32G-VNP-GOLDS'],
		['s32g399a', 's32g', 'nxp', 'automotive', 'vehicle network', 'soc', 'linux', 'autosar']),

	// ─── GD32VW553 — WiFi RISC-V ─────────────────────────────────────────
	e('GD32VW553HHK6', 'GD32VW', 'GD32VW553', 'GigaDevice',
		'risc-v', 160, 2048 * 1024, 448 * 1024, 'none', false, false, 51,
		['GPIO', 'USART', 'SPI', 'I2C', 'ADC', 'DMA', 'RTC', 'WDT', 'WiFi', 'BT'],
		[mem('FLASH', 0x08000000, 2048 * 1024, 'read-only'), mem('SRAM', 0x20000000, 448 * 1024)],
		['GD32VW553H-START', 'Sipeed RISC-V WiFi'],
		['gd32vw553', 'gd32vw', 'gigadevice', 'risc-v', 'wifi', 'ble']),

	// ─── Microchip SAM4 — Cortex-M4 ──────────────────────────────────────
	e('ATSAM4SD32C', 'SAM4', 'SAM4SD', 'Microchip',
		'cortex-m4', 120, 2048 * 1024, 160 * 1024, 'single', true, true, 79,
		['GPIO', 'USART', 'SPI', 'TWI', 'CAN', 'USB', 'ADC', 'DAC', 'DMAC', 'TC', 'PWM', 'RTC', 'NAND_FLASH'],
		[mem('FLASH', 0x00400000, 2048 * 1024, 'read-only'), mem('SRAM', 0x20000000, 160 * 1024)],
		['SAM4S Xplained Pro'],
		['sam4sd', 'sam4s', 'sam4', 'microchip', 'cortex-m4', 'atmel']),

	e('ATSAM4E16E', 'SAM4', 'SAM4E', 'Microchip',
		'cortex-m4', 120, 1024 * 1024, 128 * 1024, 'double', true, true, 117,
		['GPIO', 'USART', 'SPI', 'TWI', 'CAN', 'USB', 'GMAC', 'ADC', 'DAC', 'DMAC', 'TC', 'PWM'],
		[mem('FLASH', 0x00400000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 128 * 1024)],
		['SAM4E Xplained Pro'],
		['sam4e', 'sam4', 'microchip', 'cortex-m4', 'ethernet']),

	// ─── Ambiq Apollo4 ───────────────────────────────────────────────────
	e('AMA4B2KP-KBR', 'Apollo4', 'Apollo4 Blue Plus', 'Ambiq',
		'cortex-m4', 192, 2048 * 1024, 2688 * 1024, 'single', true, true, 74,
		['GPIO', 'UART', 'SPI', 'I2C', 'I3C', 'I2S', 'PDM', 'ADC', 'DMA', 'USB', 'SDIO', 'MSPI', 'BLE', 'GPU'],
		[mem('FLASH', 0x00018000, 2048 * 1024, 'read-only'), mem('TCM', 0x10000000, 384 * 1024), mem('SSRAM', 0x10060000, 2304 * 1024)],
		['Apollo4 Blue Plus EVB'],
		['apollo4', 'ambiq', 'ultra-low-power', 'ble', 'voice', 'ai', 'turbo', 'i3c']),

	// ─── TI CC3220 — WiFi SoC with Cortex-M4 ─────────────────────────────
	e('CC3220SF', 'CC32xx', 'CC3220SF', 'Texas Instruments',
		'cortex-m4', 80, 1024 * 1024, 256 * 1024, 'single', false, false, 40,
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'DMA', 'WiFi', 'TLS', 'AES', 'SHA', 'WDT'],
		[mem('FLASH', 0x01000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 256 * 1024)],
		['CC3220SF LaunchPad'],
		['cc3220sf', 'cc32xx', 'ti', 'wifi', 'simplelink', 'cloud', 'wpa3']),

	// ─── PIC16F — 8-bit baseline ──────────────────────────────────────────
	e('PIC16F877A', 'PIC16', 'PIC16F877A', 'Microchip',
		'pic', 20, 14 * 1024, 368, 'none', false, false, 33,
		['GPIO', 'USART', 'SPI', 'I2C', 'TMR', 'ADC', 'CCP', 'WDT', 'EEPROM', 'PSP'],
		[mem('PROGRAM_FLASH', 0x0000, 14 * 1024, 'read-only'), mem('DATA_SRAM', 0x0020, 368)],
		['PIC16F877A Dev Board', 'ECG/EEG learning boards'],
		['pic16f877a', 'pic16', 'pic', 'microchip', '8-bit', 'classic', 'academic']),

	e('PIC16F18877', 'PIC16', 'PIC16F18877', 'Microchip',
		'pic', 32, 56 * 1024, 4 * 1024, 'none', false, false, 40,
		['GPIO', 'USART', 'SPI', 'I2C', 'TMR', 'ADC', 'DAC', 'CMP', 'WDT', 'CLC', 'NCO', 'EEPROM'],
		[mem('PROGRAM_FLASH', 0x0000, 56 * 1024, 'read-only'), mem('DATA_SRAM', 0x2000, 4 * 1024)],
		['Curiosity Nano PIC16F18877'],
		['pic16f18877', 'pic16', 'pic', 'microchip', '8-bit', 'clc']),

	// ─── STM32U5 more ─────────────────────────────────────────────────────
	e('STM32U585AII6Q', 'STM32U5', 'STM32U585', 'STMicroelectronics',
		'cortex-m33', 160, 2048 * 1024, 786 * 1024, 'single', true, true, 96,
		[...STM32_COMMON_PERIPHS, 'USB_OTG', 'FDCAN', 'OCTOSPI', 'SAI', 'AES', 'HASH', 'RNG', 'PKA', 'GFXMMU'],
		[mem('FLASH', 0x08000000, 2048 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 192 * 1024), mem('SRAM2', 0x20030000, 64 * 1024), mem('SRAM3', 0x20040000, 512 * 1024)],
		['B-U585I-IOT02A', 'STM32U585 Discovery'],
		['u585', 'stm32u585', 'stm32u5', 'trustzone', 'iot', 'matter', 'smart-home']),

	// ─── Infineon ETC/XMC extended ───────────────────────────────────────
	e('XMC4500-F144K1024AA', 'XMC4', 'XMC4500', 'Infineon',
		'cortex-m4', 120, 1024 * 1024, 160 * 1024, 'single', true, true, 120,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN', 'USB', 'ETH', 'ADC', 'DAC', 'DMA', 'CCU4', 'CCU8', 'POSIF'],
		[mem('FLASH', 0x08000000, 1024 * 1024, 'read-only'), mem('PSRAM', 0x1FFE8000, 160 * 1024)],
		['XMC4500 Relax Kit'],
		['xmc4500', 'xmc4', 'infineon', 'cortex-m4', 'ethernet', 'industrial', 'motor control']),

	// ─── More NXP LPC4000 ────────────────────────────────────────────────
	e('LPC4088FBD208', 'LPC40', 'LPC4088', 'NXP',
		'cortex-m4', 120, 512 * 1024, 96 * 1024, 'single', true, true, 165,
		['GPIO', 'UART', 'SSP', 'CAN', 'USB', 'ENET', 'ADC', 'DAC', 'DMA', 'LCD', 'SDIO', 'QEI', 'RTC'],
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM0', 0x10000000, 64 * 1024), mem('SRAM1', 0x20000000, 32 * 1024)],
		['LPC4088 QuickStart Board', 'LPC4088 Developer Kit'],
		['lpc4088', 'lpc40', 'nxp', 'cortex-m4', 'ethernet', 'lcd', 'mbed']),

	// ─── More ESP32 variants ──────────────────────────────────────────────
	e('ESP32-S3-MINI-1', 'ESP32', 'ESP32-S3-MINI', 'Espressif',
		'xtensa', 240, 4 * 1024 * 1024, 512 * 1024, 'none', false, false, 23,
		[...ESP_COMMON_PERIPHS, 'USB_OTG', 'LCD_CAM', 'TWAI'],
		[mem('IROM', 0x42000000, 4 * 1024 * 1024, 'read-only'), mem('IRAM', 0x40370000, 512 * 1024)],
		['ESP32-S3-DevKitM-1', 'Seeed XIAO ESP32S3', 'Adafruit QT Py ESP32-S3'],
		['esp32s3 mini', 'esp32s3', 'espressif', 'tiny', 'camera', 'ai', 'usb']),

	// ─── Nordic nRF9160 extended boards ──────────────────────────────────
	e('nRF9161-QXAA', 'nRF91', 'nRF9161 DECT', 'Nordic Semiconductor',
		'cortex-m33', 64, 1024 * 1024, 256 * 1024, 'single', true, true, 44,
		['GPIO', 'UARTE', 'SPIM', 'TWIM', 'TIMER', 'SAADC', 'PWM', 'RTC', 'WDT', 'MODEM', 'DECT-NR+'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('RAM', 0x20000000, 256 * 1024)],
		['nRF9161 DK DECT'],
		['nrf9161 dect', 'nrf91', 'nordic', 'dect-nr+', '5ghz', 'iiot']),

	// ─── Microchip PIC32MM ────────────────────────────────────────────────
	e('PIC32MM0256GPM064', 'PIC32MM', 'PIC32MM', 'Microchip',
		'mips32', 25, 256 * 1024, 32 * 1024, 'none', false, false, 52,
		['GPIO', 'UART', 'SPI', 'I2C', 'ADC', 'DMA', 'OC', 'IC', 'RTCC', 'WDT', 'CRC', 'USB'],
		[mem('PROGRAM_FLASH', 0x1D000000, 256 * 1024, 'read-only'), mem('DATA_RAM', 0x00000000, 32 * 1024)],
		['Curiosity PIC32MM USB'],
		['pic32mm', 'pic32', 'microchip', 'mips32', 'usb', 'ultra-low-power', 'nano']),

	// ─── Microchip ATxmega ────────────────────────────────────────────────
	e('ATxmega256A3U', 'AVR', 'ATxmega256A3', 'Microchip',
		'avr', 32, 256 * 1024, 16 * 1024, 'none', false, false, 50,
		['GPIO', 'USART', 'SPI', 'TWI', 'TCC', 'ADC', 'DAC', 'DMA', 'USB', 'AES', 'CRC', 'WDT', 'EEPROM'],
		[mem('FLASH', 0x0000, 256 * 1024, 'read-only'), mem('SRAM', 0x2000, 16 * 1024), mem('EEPROM', 0x0000, 4096)],
		['Xplained A3U'],
		['atxmega256a3', 'atxmega', 'xmega', 'avr', 'usb', 'aes']),

	// ─── Microchip ATSAMG — Cortex-M4 Audio ──────────────────────────────
	e('ATSAMG55J19A', 'SAM G', 'SAMG55', 'Microchip',
		'cortex-m4', 120, 512 * 1024, 176 * 1024, 'single', true, true, 47,
		['GPIO', 'USART', 'SPI', 'TWI', 'USB', 'ADC', 'MEM2MEM', 'TC', 'PWM', 'PDM', 'I2SC', 'RTC'],
		[mem('FLASH', 0x00400000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 176 * 1024)],
		['SAM G55 Xplained Pro'],
		['samg55', 'sam g55', 'samg', 'microchip', 'cortex-m4', 'audio', 'pdm']),

	// ─── NXP LPC2000 — Classic ARM7TDMI ──────────────────────────────────
	e('LPC2378FBD144', 'LPC2', 'LPC2378', 'NXP',
		'arm7', 72, 512 * 1024, 58 * 1024, 'none', false, false, 104,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN', 'USB', 'ENET', 'ADC', 'DAC', 'DMA', 'RTC', 'WDT', 'SD_MMC'],
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM', 0x40000000, 32 * 1024), mem('SRAM1', 0x40008000, 16 * 1024)],
		['LPC2378 Evaluation Board', 'MCB2300'],
		['lpc2378', 'lpc2000', 'nxp', 'arm7', 'ethernet', 'classic arm']),

	e('LPC2148FBD64', 'LPC2', 'LPC2148', 'NXP',
		'arm7', 60, 512 * 1024, 40 * 1024, 'none', false, false, 45,
		['GPIO', 'UART', 'SPI', 'I2C', 'USB', 'ADC', 'DAC', 'DMA', 'RTC', 'WDT'],
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM', 0x40000000, 40 * 1024)],
		['LPC-P2148', 'Olimex LPC-E2148'],
		['lpc2148', 'lpc2000', 'nxp', 'arm7', 'usb', 'classic', 'educational']),

	// ─── Renesas RL78 — 16-bit Ultra-low-power ────────────────────────────
	e('R5F10268ASP', 'RL78', 'RL78/G14', 'Renesas',
		'other', 32, 64 * 1024, 4 * 1024, 'none', false, false, 50,
		['GPIO', 'UART', 'CSI', 'IIC', 'TAU', 'ADC', 'DAC', 'WDT', 'RTC', 'LVDC'],
		[mem('CODE_FLASH', 0x00000, 64 * 1024, 'read-only'), mem('DATA_FLASH', 0xF1000, 3 * 1024), mem('RAM', 0xFE000, 4 * 1024)],
		['RL78/G14 Fast Prototyping Board'],
		['rl78g14', 'rl78', 'renesas', '16-bit', 'ultra-low-power', 'automotive']),

	e('R5F10BMG', 'RL78', 'RL78/G1E', 'Renesas',
		'other', 32, 128 * 1024, 8 * 1024, 'none', false, false, 78,
		['GPIO', 'UART', 'CSI', 'IIC', 'TAU', 'ADC', 'WDT', 'RTC', 'COMPARATOR', 'LVI'],
		[mem('CODE_FLASH', 0x00000, 128 * 1024, 'read-only'), mem('DATA_FLASH', 0xF0000, 8 * 1024), mem('RAM', 0xFE000, 8 * 1024)],
		['RL78/G1E Evaluation Board'],
		['rl78g1e', 'rl78', 'renesas', '16-bit', 'automotive', 'adas']),

	// ─── SiFive E21 / S76 cores ──────────────────────────────────────────
	e('FE310-G003', 'FE310', 'FE310-G003', 'SiFive',
		'risc-v', 320, 16 * 1024 * 1024, 16 * 1024, 'none', false, false, 19,
		['GPIO', 'UART', 'SPI', 'I2C', 'PWM', 'OTP', 'DMA', 'RTC'],
		[mem('QSPI_FLASH', 0x20000000, 16 * 1024 * 1024, 'read-only'), mem('DTIM', 0x80000000, 16 * 1024)],
		['HiFive1 Rev C'],
		['fe310-g003', 'fe310', 'sifive', 'risc-v', 'hifive', 'arduino compatible']),

	// ─── TI Cortex-M4 SimpleLink extended ────────────────────────────────
	e('CC2340R53RHBR', 'CC23xx', 'CC2340R5', 'Texas Instruments',
		'cortex-m0+', 48, 512 * 1024, 36 * 1024, 'none', false, false, 22,
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'AES', 'TRNG', 'BLE6', 'WDT'],
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 36 * 1024)],
		['LP-EM-CC2340R5'],
		['cc2340r5', 'cc23xx', 'ti', 'ble6', 'bluetooth 6', 'channel sounding', 'direction finding']),

	// ─── Infineon PSoC 4 ─────────────────────────────────────────────────
	e('CY8C4245AZI-M443', 'PSoC 4', 'PSoC 4200', 'Infineon',
		'cortex-m0', 48, 32 * 1024, 4 * 1024, 'none', false, false, 36,
		['GPIO', 'SCB', 'TCPWM', 'SAR_ADC', 'DAC', 'CMP', 'WDT', 'CTDAC'],
		[mem('FLASH', 0x00000000, 32 * 1024, 'read-only'), mem('SRAM', 0x20000000, 4 * 1024)],
		['CY8CKIT-042 PSoC 4 Pioneer Kit'],
		['cy8c4245', 'psoc4', 'psoc 4', 'infineon', 'cypress', 'touch', 'capacitive']),

	// ─── Raspberry Pi Compute Modules ────────────────────────────────────
	e('BCM2711', 'BCM27', 'Raspberry Pi CM4', 'Raspberry Pi',
		'cortex-a', 1500, 0, 0, 'double', true, true, 40,
		['GPIO', 'UART', 'SPI', 'I2C', 'USB', 'GMAC', 'PCIe', 'HDMI', 'CSI', 'DSI', 'SDMMC', 'DDR4'],
		[mem('DDR4', 0x40000000, 8192 * 1024 * 1024)],
		['Raspberry Pi CM4', 'Compute Module 4 IO Board'],
		['bcm2711', 'raspberry pi cm4', 'compute module 4', 'linux', 'cortex-a72', 'quad-core']),

	// ─── STM32WB extended ────────────────────────────────────────────────
	e('STM32WB35CEU6A', 'STM32WB', 'STM32WB35', 'STMicroelectronics',
		'cortex-m4', 64, 512 * 1024, 96 * 1024, 'single', true, true, 37,
		[...STM32_COMMON_PERIPHS, 'BLE', 'Thread', 'AES', 'RNG', 'PKA'],
		[mem('FLASH', 0x08000000, 512 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 64 * 1024), mem('SRAM2', 0x20010000, 32 * 1024)],
		['STM32WB35 Nucleo'],
		['stm32wb35', 'stm32wb', 'ble', 'thread', 'zigbee', 'dual-core']),

	// ─── More Microchip SAM ───────────────────────────────────────────────
	e('ATSAM3X8E', 'SAM3', 'SAM3X', 'Microchip',
		'cortex-m3', 84, 512 * 1024, 96 * 1024, 'none', true, false, 103,
		['GPIO', 'USART', 'SPI', 'TWI', 'CAN', 'USB', 'ADC', 'DAC', 'DMAC', 'TC', 'PWM', 'SSC'],
		[mem('FLASH', 0x00080000, 512 * 1024, 'read-only'), mem('SRAM0', 0x20000000, 64 * 1024), mem('SRAM1', 0x20080000, 32 * 1024)],
		['Arduino Due', 'Arduino Due Enterprise'],
		['sam3x', 'sam3x8e', 'atsam3x8e', 'microchip', 'cortex-m3', 'arduino due', 'due']),

	// ─── More Infineon AURIX TC1xx ────────────────────────────────────────
	e('TC1797SA', 'AURIX', 'TC1797', 'Infineon',
		'tricore', 150, 2048 * 1024, 192 * 1024, 'none', false, false, 146,
		['GPIO', 'ASC', 'SSC', 'MultiCAN', 'SENT', 'GTM', 'VADC', 'DMA', 'EMEM', 'ETHERNET'],
		[mem('PMU_FLASH', 0xA0000000, 2048 * 1024, 'read-only'), mem('DSPR', 0xC0000000, 192 * 1024)],
		['TriBoard TC1797'],
		['tc1797', 'aurix', 'tricore', 'infineon', 'automotive', 'legacy']),

	// ─── STM32H5 extended ────────────────────────────────────────────────
	e('STM32H562RGT6', 'STM32H5', 'STM32H562', 'STMicroelectronics',
		'cortex-m33', 250, 1024 * 1024, 640 * 1024, 'single', true, true, 51,
		[...STM32_COMMON_PERIPHS, 'USB', 'FDCAN', 'OCTOSPI', 'AES', 'PKA', 'RNG', 'HASH'],
		[mem('FLASH', 0x08000000, 1024 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 256 * 1024), mem('SRAM2', 0x20040000, 384 * 1024)],
		['NUCLEO-H562RG'],
		['h562', 'stm32h562', 'stm32h5', 'trustzone']),

	// ─── Renesas RA2E extended ────────────────────────────────────────────
	e('R7FA2E1A92DFM', 'RA2', 'RA2E1', 'Renesas',
		'cortex-m23', 48, 128 * 1024, 16 * 1024, 'none', true, false, 40,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'ADC', 'DAC', 'DMA', 'GPT', 'RTC', 'WDT', 'CTSU'],
		[mem('CODE_FLASH', 0x00000000, 128 * 1024, 'read-only'), mem('SRAM', 0x20000000, 16 * 1024)],
		['EK-RA2E1'],
		['ra2e1', 'ra2', 'renesas', 'cortex-m23', 'ultra-low-power', 'touch']),

	// ─── GigaDevice GD32W515 — WiFi + Cortex-M33 ─────────────────────────
	e('GD32W515PIQ6', 'GD32W', 'GD32W515', 'GigaDevice',
		'cortex-m33', 180, 2048 * 1024, 448 * 1024, 'single', true, true, 51,
		['GPIO', 'USART', 'SPI', 'I2C', 'ADC', 'DMA', 'RTC', 'WDT', 'WiFi', 'BT', 'AES', 'TRNG'],
		[mem('FLASH', 0x08000000, 2048 * 1024, 'read-only'), mem('SRAM', 0x20000000, 448 * 1024)],
		['GD32W515 IoT Board'],
		['gd32w515', 'gd32w', 'gigadevice', 'wifi', 'ble', 'trustzone', 'iot']),


	e('STM32G081RBT6', 'STM32G0', 'STM32G081', 'STMicroelectronics',
		'cortex-m0+', 64, 128 * 1024, 36 * 1024, 'none', false, false, 51,
		['GPIO', 'USART', 'SPI', 'I2C', 'ADC', 'DAC', 'DMA', 'RTC', 'LPTIM', 'WDT'],
		[mem('FLASH', 0x08000000, 128 * 1024, 'read-only'), mem('SRAM', 0x20000000, 36 * 1024)],
		['NUCLEO-G081RB'], ['g081', 'stm32g081', 'stm32g0']),

	// ─── STM32F3 ─────────────────────────────────────────────────────────
	e('STM32F303VCT6', 'STM32F3', 'STM32F303', 'STMicroelectronics',
		'cortex-m4', 72, 256 * 1024, 48 * 1024, 'single', true, true, 80,
		[...STM32_COMMON_PERIPHS, 'CAN', 'USB', 'OPAMP', 'COMP', 'ADC1_2'],
		[mem('FLASH', 0x08000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 40 * 1024), mem('CCM', 0x10000000, 8 * 1024)],
		['STM32F3DISCOVERY', 'NUCLEO-F303VC'],
		['f303', 'stm32f303', 'stm32f3', 'discovery', 'analog']),

	e('STM32F334R8T6', 'STM32F3', 'STM32F334', 'STMicroelectronics',
		'cortex-m4', 72, 64 * 1024, 12 * 1024, 'single', true, true, 51,
		[...STM32_COMMON_PERIPHS, 'HRTIM', 'OPAMP', 'COMP', 'CAN'],
		[mem('FLASH', 0x08000000, 64 * 1024, 'read-only'), mem('SRAM', 0x20000000, 12 * 1024), mem('CCM', 0x10000000, 4 * 1024)],
		['NUCLEO-F334R8'],
		['f334', 'stm32f334', 'stm32f3', 'hrtim', 'digital power']),

	// ─── STM32L4 more variants ────────────────────────────────────────────
	e('STM32L496ZGT6', 'STM32L4', 'STM32L496', 'STMicroelectronics',
		'cortex-m4', 80, 1024 * 1024, 320 * 1024, 'single', true, true, 114,
		[...STM32_COMMON_PERIPHS, 'USB_OTG', 'SDMMC', 'DFSDM', 'SAI', 'OCTOSPI', 'ADC', 'DAC'],
		[mem('FLASH', 0x08000000, 1024 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 256 * 1024), mem('SRAM2', 0x10000000, 64 * 1024)],
		['NUCLEO-L496ZG', 'STM32L496G-Discovery'],
		['l496', 'stm32l496', 'stm32l4', 'ultra-low-power', 'usb hs']),

	e('STM32L471QGT6', 'STM32L4', 'STM32L471', 'STMicroelectronics',
		'cortex-m4', 80, 1024 * 1024, 128 * 1024, 'single', true, true, 82,
		[...STM32_COMMON_PERIPHS, 'ADC', 'DAC', 'DFSDM', 'SAI'],
		[mem('FLASH', 0x08000000, 1024 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 96 * 1024), mem('SRAM2', 0x10000000, 32 * 1024)],
		[],
		['l471', 'stm32l471', 'stm32l4', 'ultra-low-power']),

	// ─── NXP LPC5500 — Cortex-M33 ────────────────────────────────────────
	e('LPC5528JBD100', 'LPC55', 'LPC55S28', 'NXP',
		'cortex-m33', 150, 512 * 1024, 272 * 1024, 'single', true, true, 84,
		['GPIO', 'FLEXCOMM', 'USB', 'CAN', 'ADC', 'DAC', 'DMA', 'SCT', 'CTimer', 'RTC', 'WDT', 'CASPER', 'PRINCE'],
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM0', 0x20000000, 192 * 1024), mem('SRAM1', 0x20030000, 80 * 1024)],
		['LPCXpresso55S28'],
		['lpc55s28', 'lpc55', 'nxp', 'cortex-m33', 'trustzone', 'casper', 'powerquad']),

	e('LPC55S16JBD64', 'LPC55', 'LPC55S16', 'NXP',
		'cortex-m33', 150, 256 * 1024, 96 * 1024, 'single', true, true, 48,
		['GPIO', 'FLEXCOMM', 'USB', 'ADC', 'DMA', 'SCT', 'CTimer', 'RTC', 'WDT', 'CASPER'],
		[mem('FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 96 * 1024)],
		['LPCXpresso55S16'],
		['lpc55s16', 'lpc55', 'nxp', 'cortex-m33', 'trustzone']),

	// ─── Renesas RX66N / RA6M5 ───────────────────────────────────────────
	e('R5F566NNHDFB', 'RX66N', 'RX66N', 'Renesas',
		'rx', 120, 4096 * 1024, 1024 * 1024, 'double', true, true, 224,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN', 'USB', 'ETHER', 'ADC', 'DMA', 'GPT', 'RTC', 'GLCDC', 'DRW', 'TSIP'],
		[mem('ROM', 0xFF000000, 4096 * 1024, 'read-only'), mem('RAM0', 0x00000000, 1024 * 1024)],
		['RSK-RX66N'],
		['rx66n', 'rx', 'renesas', 'ethernet', 'tsip', 'security', 'industrial']),

	e('R7FA6M5BH3CFP', 'RA6', 'RA6M5', 'Renesas',
		'cortex-m33', 200, 2048 * 1024, 512 * 1024, 'double', true, true, 105,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN_FD', 'USB', 'ETHER', 'ADC', 'DAC', 'DMA', 'GPT', 'RTC', 'WDT', 'OSPI', 'SRAM_BACKUP'],
		[mem('CODE_FLASH', 0x00000000, 2048 * 1024, 'read-only'), mem('SRAM', 0x20000000, 512 * 1024)],
		['EK-RA6M5'],
		['ra6m5', 'ra6', 'renesas', 'trustzone', 'can-fd', 'ethernet', 'octal-spi']),

	// ─── Microchip SAMA7 ─────────────────────────────────────────────────
	e('ATSAMA7G54', 'SAMA7', 'SAMA7G54', 'Microchip',
		'cortex-a', 1000, 0, 0, 'none', true, false, 176,
		['GPIO', 'FLEXCOM', 'SPI', 'I2C', 'CAN_FD', 'USB', 'GMAC', 'SDMMC', 'ADC', 'DMA', 'TC', 'PWM', 'ISI', 'LCDC', 'XDMAC', 'DDR'],
		[mem('DDR', 0x60000000, 1024 * 1024 * 1024), mem('SRAM', 0x00100000, 128 * 1024)],
		['SAMA7G54 Evaluation Kit'],
		['sama7g54', 'sama7', 'microchip', 'linux', 'cortex-a7', 'gigabit ethernet', 'can-fd']),

	// ─── TI C2000 Extended ───────────────────────────────────────────────
	e('TMS320F280039C', 'C2000', 'F280039C', 'Texas Instruments',
		'c28x', 120, 384 * 1024, 100 * 1024, 'none', false, true, 100,
		['GPIO', 'SCI', 'SPI', 'I2C', 'CAN', 'ePWM', 'eCAP', 'eQEP', 'ADC', 'CMPSS', 'DMA', 'CLB', 'FSI'],
		[mem('FLASH', 0x080000, 384 * 1024, 'read-only'), mem('GSRAM', 0x00C000, 100 * 1024)],
		['LAUNCHXL-F280039C'],
		['f280039c', 'c2000', 'ti', 'piccolo', 'motor control', 'solar', 'ev charger']),

	// ─── Nuvoton M55M1 — Cortex-M55 ─────────────────────────────────────
	e('M55M1TIAE8AE', 'M55M1', 'M55M1', 'Nuvoton',
		'cortex-m55', 480, 2048 * 1024, 2048 * 1024, 'double', true, true, 128,
		['GPIO', 'UART', 'SPI', 'I2C', 'I2S', 'USB', 'EMAC', 'ADC', 'DAC', 'PDMA', 'QSPI', 'CRYPTO', 'NPU', 'CANFD'],
		[mem('FLASH', 0x00000000, 2048 * 1024, 'read-only'), mem('SRAM', 0x20000000, 2048 * 1024)],
		['NuMaker-M55M1'],
		['m55m1', 'nuvoton', 'cortex-m55', 'helium', 'ai', 'ethos-u55', 'tflite']),



	// ─── Renesas RA4M1/RA2L1 ─────────────────────────────────────────────
	e('R7FA4M1AB3CBF', 'RA4', 'RA4M1', 'Renesas',
		'cortex-m4', 48, 256 * 1024, 32 * 1024, 'single', true, true, 64,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'USB', 'ADC', 'DAC', 'DMA', 'GPT', 'RTC', 'WDT', 'CTSU'],
		[mem('CODE_FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['EK-RA4M1', 'Arduino UNO R4 Minima/WiFi'],
		['ra4m1', 'ra4', 'renesas', 'arduino uno r4', 'usb', 'cortex-m4']),

	e('R7FA2L1AB2CBF', 'RA2', 'RA2L1', 'Renesas',
		'cortex-m23', 48, 256 * 1024, 32 * 1024, 'none', true, false, 40,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'ADC', 'DAC', 'DMA', 'GPT', 'RTC', 'WDT', 'CTSU'],
		[mem('CODE_FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['EK-RA2L1'],
		['ra2l1', 'ra2', 'renesas', 'cortex-m23', 'touch']),

	// ─── Nordic nRF52833 ─────────────────────────────────────────────────
	e('nRF52833-QDAA', 'nRF52', 'nRF52833', 'Nordic Semiconductor',
		'cortex-m4', 64, 512 * 1024, 128 * 1024, 'single', true, true, 46,
		[...NORDIC_COMMON_PERIPHS, 'BLE', 'LR-FHSS', 'IEEE802154', 'AES_CCM', 'USB'],
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('RAM', 0x20000000, 128 * 1024)],
		['nRF52833 DK', 'BBC micro:bit v2', 'Makecode Arcade'],
		['nrf52833', 'nrf52', 'ble', 'nordic', 'microbit v2', 'ieee802154', 'thread zigbee']),

	// ─── TI AM243x (2022-era, automotive) ────────────────────────────────
	e('AM2432', 'AM243x', 'AM2432', 'Texas Instruments',
		'cortex-r', 400, 0, 0, 'double', true, false, 228,
		['GPIO', 'UART', 'SPI', 'I2C', 'MCAN', 'MDIO', 'ENET_PRU', 'ADC', 'DMA', 'EPWM', 'EQEP', 'ECAP', 'HWA', 'SA2UL'],
		[mem('MSRAM', 0x70000000, 2048 * 1024), mem('ATCM', 0x00000000, 512 * 1024)],
		['AM243x LaunchPad EVM', 'AM243x Control Card'],
		['am2432', 'am243x', 'ti', 'cortex-r5', 'industrial ethernet', 'ethercat', 'profinet', 'osal']),


	// ─── STM32H7 more ─────────────────────────────────────────────────────
	e('STM32H753ZIT6', 'STM32H7', 'STM32H753', 'STMicroelectronics',
		'cortex-m7', 480, 2048 * 1024, 1024 * 1024, 'double', true, true, 114,
		[...STM32_ADVANCED_PERIPHS, 'LTDC', 'FMC', 'SAI', 'QUADSPI', 'MDMA', 'BDMA', 'FDCAN', 'CRYP', 'HASH', 'RNG'],
		[mem('FLASH', 0x08000000, 2048 * 1024, 'read-only'), mem('DTCM', 0x20000000, 128 * 1024), mem('AXI_SRAM', 0x24000000, 512 * 1024)],
		['NUCLEO-H753ZI'],
		['h753', 'stm32h753', 'stm32h7', 'crypto', 'aes']),


	// ─── TI SimpleLink CC1352 ─────────────────────────────────────────────
	e('CC1352R1FRGZ', 'CC13xx', 'CC1352R', 'Texas Instruments',
		'cortex-m4', 48, 352 * 1024, 80 * 1024, 'single', true, true, 40,
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'DMA', 'Sub-GHz_Radio', 'BLE', 'IEEE802154', 'AES', 'SHA'],
		[mem('FLASH', 0x00000000, 352 * 1024, 'read-only'), mem('SRAM', 0x20000000, 80 * 1024)],
		['LAUNCHXL-CC1352R1', 'LAUNCHXL-CC26X2R1'],
		['cc1352r', 'cc13xx', 'ti', 'sub-ghz', 'ble', 'thread', 'zigbee', 'simplelink']),

	// ─── Silicon Labs EFR32MG24 — Matter/Zigbee ──────────────────────────
	e('EFR32MG24B020F1536IM48', 'EFR32MG', 'EFR32MG24', 'Silicon Labs',
		'cortex-m33', 78, 1536 * 1024, 256 * 1024, 'single', true, true, 33,
		['GPIO', 'USART', 'I2C', 'TIMER', 'ADC', 'DMA', 'BLE', 'IEEE802154', 'AES', 'SHA', 'PKA', 'TRNG', 'USB'],
		[mem('FLASH', 0x08000000, 1536 * 1024, 'read-only'), mem('SRAM', 0x20000000, 256 * 1024)],
		['xG24-DK2601B', 'xG24-EK2703A'],
		['efr32mg24', 'efr32mg', 'silabs', 'matter', 'thread', 'zigbee', 'ble', 'trustzone']),

	// ─── Microchip SAMC21 CAN ────────────────────────────────────────────
	e('ATSAMC21J18A', 'SAM C21', 'SAMC21', 'Microchip',
		'cortex-m0+', 48, 256 * 1024, 32 * 1024, 'none', false, false, 64,
		['GPIO', 'SERCOM', 'TC', 'TCC', 'ADC', 'DAC', 'DMAC', 'RTC', 'WDT', 'EIC', 'CAN', 'SDADC'],
		[mem('FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['SAM C21 Xplained Pro'],
		['samc21', 'sam c21', 'microchip', 'can', 'industrial', '5v-tolerant']),

	// ─── STM32MP1 Cortex-A7 ──────────────────────────────────────────────
	e('STM32MP157CAC3', 'STM32MP1', 'STM32MP157C', 'STMicroelectronics',
		'cortex-a', 650, 0, 0, 'none', true, false, 448,
		['GPIO', 'USART', 'SPI', 'I2C', 'CAN_FD', 'USB', 'GMAC', 'SDMMC', 'ADC', 'DAC', 'DMA', 'GPU', 'LTDC', 'CSI', 'CRYP'],
		[mem('DDR', 0xC0000000, 512 * 1024 * 1024), mem('RETRAM', 0x00000000, 64 * 1024), mem('SYSRAM', 0x2FFE0000, 256 * 1024)],
		['STM32MP157C-DK2', 'STM32MP157F-DK2'],
		['stm32mp157', 'stm32mp1', 'linux', 'cortex-a7', 'dual-core', 'openamp', 'gpu']),

	// ─── Renesas RA8M1 ───────────────────────────────────────────────────
	e('R7FA8M1AHECBD', 'RA8', 'RA8M1', 'Renesas',
		'cortex-m85', 480, 2048 * 1024, 1024 * 1024, 'double', true, true, 105,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN_FD', 'USB', 'ETHER', 'ADC', 'DAC', 'DMA', 'GPT', 'RTC', 'SDHI', 'GLCDC', 'DRW', 'CEU', 'OSPI'],
		[mem('CODE_FLASH', 0x00000000, 2048 * 1024, 'read-only'), mem('SRAM0', 0x20000000, 1024 * 1024)],
		['EK-RA8M1'],
		['ra8m1', 'ra8', 'renesas', 'cortex-m85', 'helium', 'ai', 'npu']),

	// ─── AURIX TC4x — Newest AURIX ────────────────────────────────────────
	e('TC4D6', 'AURIX', 'TC4D6', 'Infineon',
		'tricore', 400, 16384 * 1024, 2048 * 1024, 'double', true, true, 300,
		['GPIO', 'ASCLIN', 'QSPI', 'I2C', 'MultiCAN_FD', 'MSC', 'SENT', 'GTM', 'EVADC', 'HSM', 'DMA', 'EMEM', 'ETHERNET', 'PCIe'],
		[mem('PMU_FLASH', 0xA0000000, 16384 * 1024, 'read-only'), mem('DSPR0', 0x70000000, 512 * 1024), mem('LMU', 0x90000000, 1024 * 1024)],
		['KIT_A2G_TC4X_TRB'],
		['tc4d6', 'tc4x', 'aurix', 'tricore', 'infineon', 'automotive', 'asil-d', 'pcie']),

	// ─── PSoC 4000 — Entry-level Cypress ─────────────────────────────────
	e('CY8C4014LQI-422', 'PSoC 4', 'PSoC 4000', 'Infineon',
		'cortex-m0', 16, 8 * 1024, 2 * 1024, 'none', false, false, 10,
		['GPIO', 'SCB', 'TCPWM', 'SAR_ADC', 'WDT'],
		[mem('FLASH', 0x00000000, 8 * 1024, 'read-only'), mem('SRAM', 0x20000000, 2 * 1024)],
		['CY8CKIT-040 PSoC 4 Pioneer Kit'],
		['cy8c4014', 'psoc4000', 'psoc 4', 'infineon', 'cypress', 'ultra-low-cost']),

	// ─── Microchip PIC18F57Q43 ────────────────────────────────────────────
	e('PIC18F57Q43T-I/PT', 'PIC18', 'PIC18F57Q43', 'Microchip',
		'pic', 64, 128 * 1024, 8 * 1024, 'none', false, false, 48,
		['GPIO', 'UART', 'SPI', 'I2C', 'ADC', 'DAC', 'CMP', 'TMR', 'CCP', 'WDT', 'EEPROM', 'CLC', 'NCO', 'DMA'],
		[mem('PROGRAM_FLASH', 0x000000, 128 * 1024, 'read-only'), mem('DATA_SRAM', 0x000000, 8 * 1024)],
		['Curiosity Nano PIC18F57Q43', 'Curiosity HPC'],
		['pic18f57q43', 'pic18fq43', 'pic18', 'pic', 'microchip', '8-bit', 'dma']),

	// ─── ATtiny series ───────────────────────────────────────────────────
	e('ATtiny416-MNR', 'AVR', 'ATtiny416', 'Microchip',
		'avr', 20, 4 * 1024, 256, 'none', false, false, 14,
		['GPIO', 'USART', 'SPI', 'TWI', 'TCA', 'TCB', 'ADC', 'DAC', 'CCL', 'WDT', 'RTC'],
		[mem('FLASH', 0x0000, 4 * 1024, 'read-only'), mem('SRAM', 0x3F00, 256)],
		['ATtiny416 Xplained Nano'],
		['attiny416', 'attiny', 'avr', 'microchip', 'tiny', '$1 mcu']),

	e('ATtiny3217-MFR', 'AVR', 'ATtiny3217', 'Microchip',
		'avr', 20, 32 * 1024, 2 * 1024, 'none', false, false, 22,
		['GPIO', 'USART', 'SPI', 'TWI', 'TCA', 'TCB', 'ADC', 'DAC', 'CCL', 'AC', 'WDT', 'RTC'],
		[mem('FLASH', 0x0000, 32 * 1024, 'read-only'), mem('SRAM', 0x3800, 2 * 1024)],
		['ATtiny3217 Xplained Pro'],
		['attiny3217', 'attiny', 'avr', 'microchip', 'tinyavr']),

	// ─── NXP MKS22FN512 ─────────────────────────────────────────────────
	e('MKS22FN512VLL12', 'Kinetis K', 'KS22F', 'NXP',
		'cortex-m4', 120, 512 * 1024, 128 * 1024, 'single', true, true, 80,
		['GPIO', 'LPUART', 'DSPI_SPI', 'I2C', 'USB', 'ADC', 'DAC', 'DMA', 'FTM', 'PIT', 'I2S', 'SDHC'],
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM_U', 0x20000000, 128 * 1024)],
		['FRDM-KS22F'],
		['ks22f', 'kinetis k', 'nxp', 'usb', 'audio', 'i2s']),

	// ─── More STM32F1 ────────────────────────────────────────────────────
	e('STM32F103ZET6', 'STM32F1', 'STM32F103ZE', 'STMicroelectronics',
		'cortex-m3', 72, 512 * 1024, 64 * 1024, 'none', true, false, 144,
		[...STM32_COMMON_PERIPHS, 'USB', 'CAN', 'SDIO', 'FSMC', 'DAC'],
		[mem('FLASH', 0x08000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 64 * 1024)],
		['STM32F103ZE Eval Board', 'Maple Mini compatible'],
		['f103ze', 'stm32f103ze', 'stm32f103', 'stm32f1', 'performance', 'usb', 'can']),

	// ─── Nordic nRF21540 — Range Extender ────────────────────────────────
	e('nRF21540-QFAA', 'nRF21', 'nRF21540', 'Nordic Semiconductor',
		'other', 0, 0, 0, 'none', false, false, 7,
		['GPIO', 'SPI', 'UART', 'PDN', 'ANT_SEL', 'MODE', 'TX_EN', 'RX_EN'],
		[mem('SRAM', 0x00000000, 4 * 1024)],
		['nRF21540 DK', 'Nordic DK extension'],
		['nrf21540', 'nrf21', 'nordic', 'range extender', 'power amplifier', 'lna', '+20dBm']),

	// ─── Espressif ESP32-C6 ───────────────────────────────────────────────
	e('ESP32-C6-MINI-1', 'ESP32', 'ESP32-C6-MINI', 'Espressif',
		'risc-v', 160, 8 * 1024 * 1024, 512 * 1024, 'none', false, false, 22,
		[...ESP_COMMON_PERIPHS, 'IEEE802154', 'Thread', 'Zigbee', 'TWAI', 'USB_SERIAL'],
		[mem('IROM', 0x42000000, 8 * 1024 * 1024, 'read-only'), mem('IRAM', 0x40800000, 512 * 1024)],
		['ESP32-C6-DevKitC-1', 'ESP Thread Border Router'],
		['esp32c6 mini', 'esp32c6-mini', 'esp32c6', 'espressif', 'risc-v', 'wifi6e', 'ble5.3', 'matter', 'thread', 'zigbee', 'border-router']),

	// ─── Microchip SAMD51 extended ───────────────────────────────────────
	e('ATSAMD51N20A', 'SAM D5x', 'SAMD51', 'Microchip',
		'cortex-m4', 120, 1024 * 1024, 256 * 1024, 'single', true, true, 64,
		['GPIO', 'SERCOM', 'TC', 'TCC', 'ADC', 'DAC', 'USB', 'DMAC', 'RTC', 'WDT', 'SDHC', 'EIC', 'CAN'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 256 * 1024)],
		['SAM E54 Xplained Pro', 'Adafruit Grand Central M4'],
		['samd51n20a', 'samd51', 'same54', 'microchip', 'cortex-m4', 'grand central m4']),

	// ─── Infineon XMC1400 — C/I grade ─────────────────────────────────────
	e('XMC1404-Q064X0200', 'XMC1', 'XMC1404', 'Infineon',
		'cortex-m0', 48, 200 * 1024, 16 * 1024, 'none', false, false, 48,
		['GPIO', 'USIC', 'CCU4', 'CCU8', 'POSIF', 'ADC', 'DAC', 'WDT', 'ERU', 'CAN'],
		[mem('FLASH', 0x10001000, 200 * 1024, 'read-only'), mem('SRAM', 0x20000000, 16 * 1024)],
		['XMC1404 Boot Kit'],
		['xmc1404', 'xmc1', 'infineon', 'motor control', 'cortex-m0', 'can', '5v']),

	// ─── TI Sitara AM335x ────────────────────────────────────────────────
	e('AM3358BZCZA100', 'AM335x', 'AM3358', 'Texas Instruments',
		'cortex-a', 1000, 0, 0, 'none', false, false, 562,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN', 'USB', 'GMAC', 'SDMMC', 'ADC', 'eCAP', 'eQEP', 'ePWM', 'PRU', 'DDR3', 'SATA'],
		[mem('DDR3', 0x80000000, 512 * 1024 * 1024), mem('OCMCRAM', 0x40300000, 256 * 1024)],
		['BeagleBone Black', 'BeagleBone Green', 'AM335x EVM'],
		['am3358', 'am335x', 'ti', 'cortex-a8', 'linux', 'pru', 'beaglebone black', 'yocto']),


	// ─── STM32WB55 extended ───────────────────────────────────────────────
	e('STM32WB55CGU6', 'STM32WB', 'STM32WB55CG', 'STMicroelectronics',
		'cortex-m4', 64, 1024 * 1024, 256 * 1024, 'single', true, true, 37,
		[...STM32_COMMON_PERIPHS, 'BLE', 'Thread', 'Zigbee', 'AES', 'PKA', 'RNG'],
		[mem('FLASH', 0x08000000, 1024 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 192 * 1024), mem('SRAM2', 0x20030000, 64 * 1024)],
		['P-NUCLEO-WB55', 'STM32WB5MM-DK'],
		['stm32wb55cg', 'stm32wb55', 'stm32wb', 'ble', 'thread', 'usb', 'dual-core']),

	// ─── Renesas RA6M2 / RA4W1 ───────────────────────────────────────────
	e('R7FA6M2AF3CFB', 'RA6', 'RA6M2', 'Renesas',
		'cortex-m4', 120, 1024 * 1024, 384 * 1024, 'single', true, true, 100,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN', 'USB', 'ETHER', 'ADC', 'DAC', 'DMA', 'GPT', 'RTC', 'WDT', 'QSPI'],
		[mem('CODE_FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 384 * 1024)],
		['EK-RA6M2'], ['ra6m2', 'ra6', 'renesas', 'ethernet', 'usb', 'iot']),

	e('R7FA4W1AD2CNG', 'RA4', 'RA4W1', 'Renesas',
		'cortex-m4', 48, 512 * 1024, 96 * 1024, 'single', true, true, 56,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'USB', 'ADC', 'DAC', 'DMA', 'GPT', 'RTC', 'WDT', 'BLE'],
		[mem('CODE_FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 96 * 1024)],
		['EK-RA4W1'], ['ra4w1', 'ra4', 'renesas', 'ble', 'wifi', 'iot']),

	// ─── NXP MKL — Cortex-M0+ FRDM line ─────────────────────────────────
	e('MKL46Z256VLL4', 'Kinetis L', 'KL46Z', 'NXP',
		'cortex-m0+', 48, 256 * 1024, 32 * 1024, 'none', false, false, 100,
		['GPIO', 'UART', 'SPI', 'I2C', 'USB', 'ADC', 'DAC', 'DMA', 'TPM', 'PIT', 'LCD', 'TOUCH', 'WDT'],
		[mem('FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('SRAM_L', 0x1FFFE000, 16 * 1024), mem('SRAM_U', 0x20000000, 16 * 1024)],
		['FRDM-KL46Z'], ['kl46z', 'kinetis l', 'nxp', 'frdm', 'lcd', 'touch', 'mbed']),

	// ─── NXP MKW — Wireless Kinetis ──────────────────────────────────────
	e('MKW41Z512VHT4', 'Kinetis W', 'KW41Z', 'NXP',
		'cortex-m0+', 48, 512 * 1024, 128 * 1024, 'none', false, false, 40,
		['GPIO', 'LPUART', 'LPSPI', 'LPI2C', 'ADC', 'DMA', 'TPM', 'IEEE802154', 'BLE', 'WDT'],
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM_U', 0x20000000, 128 * 1024)],
		['FRDM-KW41Z'], ['kw41z', 'kinetis w', 'nxp', 'ble', 'thread', 'zigbee', 'ieee802154']),

	// ─── Nordic nRF5340 extended ──────────────────────────────────────────
	e('nRF5340-QKAA-R7', 'nRF53', 'nRF5340', 'Nordic Semiconductor',
		'cortex-m33', 128, 1024 * 1024, 512 * 1024, 'double', true, true, 48,
		[...NORDIC_COMMON_PERIPHS, 'BLE', 'IEEE802154', 'AES_CCM', 'USB', 'PDM', 'I2S', 'QDEC'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('RAM', 0x20000000, 512 * 1024)],
		['nRF5340 DK', 'Thingy:53', 'nRF5340 Audio DK'],
		['nrf5340', 'nrf53', 'nordic', 'ble', 'thread', 'zigbee', 'matter', 'usb', 'audio', 'dual-core']),


	// ─── Microchip SAMD21 extended ────────────────────────────────────────
	e('ATSAMD21E18A', 'SAM D21', 'SAMD21E', 'Microchip',
		'cortex-m0+', 48, 256 * 1024, 32 * 1024, 'none', false, false, 32,
		['GPIO', 'SERCOM', 'TC', 'TCC', 'ADC', 'DAC', 'USB', 'DMAC', 'RTC', 'WDT', 'EIC'],
		[mem('FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['Adafruit Feather M0', 'Seeeduino XIAO', 'SparkFun SAMD21 Mini'],
		['samd21e', 'samd21', 'microchip', 'feather m0', 'seeed xiao', 'arduino zero']),

	// ─── Silicon Labs EFM32GG11 ───────────────────────────────────────────
	e('EFM32GG11B820F2048GL192', 'EFM32GG', 'EFM32GG11B', 'Silicon Labs',
		'cortex-m4', 72, 2048 * 1024, 512 * 1024, 'single', true, true, 128,
		['GPIO', 'USART', 'I2C', 'TIMER', 'ADC', 'DAC', 'DMA', 'USB', 'LCD', 'SDIO', 'QSPI', 'ETH', 'RTC', 'WDT', 'CRYPTO'],
		[mem('FLASH', 0x00000000, 2048 * 1024, 'read-only'), mem('SRAM', 0x20000000, 512 * 1024)],
		['EFM32GG11-SLSTK3701A'],
		['efm32gg11', 'efm32gg', 'silabs', 'giant gecko', 'ethernet', 'usb', 'lcd']),

	// ─── TI Hercules — Safety MCU ─────────────────────────────────────────
	e('TMS570LS3137ZWT', 'Hercules', 'TMS570LS31x', 'Texas Instruments',
		'cortex-r', 180, 4096 * 1024, 512 * 1024, 'double', true, true, 337,
		['GPIO', 'SCI', 'SPI', 'I2C', 'CAN', 'ENET', 'ADC', 'DMA', 'HET', 'GIO', 'NHET', 'RTI', 'WDT'],
		[mem('FLASH', 0x00000000, 4096 * 1024, 'read-only'), mem('SRAM', 0x08000000, 512 * 1024)],
		['TMS570LC43x LaunchPad', 'RM46L852 LaunchPad'],
		['tms570ls31x', 'tms570', 'hercules', 'ti', 'cortex-r4', 'iso26262', 'iec61508', 'asil-d', 'safety']),

	e('RM57L843ZWT', 'Hercules', 'RM57L843', 'Texas Instruments',
		'cortex-r', 330, 4096 * 1024, 512 * 1024, 'double', true, true, 337,
		['GPIO', 'SCI', 'SPI', 'I2C', 'CAN', 'ENET', 'ADC', 'DMA', 'HET', 'N2HET', 'RTI', 'WDT', 'PBIST'],
		[mem('FLASH', 0x00000000, 4096 * 1024, 'read-only'), mem('SRAM', 0x08000000, 512 * 1024)],
		['RM57L843 LaunchPad EVM'],
		['rm57l843', 'rm57', 'hercules', 'ti', 'cortex-r5', 'asil-d', 'lockstep', 'ecc']),

	// ─── Nuvoton NUC980 ───────────────────────────────────────────────────
	e('NUC980DR61Y', 'NUC980', 'NUC980', 'Nuvoton',
		'other', 300, 0, 0, 'none', false, false, 128,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN', 'USB', 'EMAC', 'ADC', 'DMA', 'SDIO', 'LCD', 'I2S', 'DDR'],
		[mem('DDR2', 0x00000000, 64 * 1024 * 1024), mem('SRAM', 0x00080000, 256 * 1024)],
		['NuMaker-HMI-NUC980'],
		['nuc980', 'nuvoton', 'arm9', 'linux', 'hmi', 'display', 'ethernet']),


	// ─── More STM32L4 ────────────────────────────────────────────────────
	e('STM32L431RCT6', 'STM32L4', 'STM32L431', 'STMicroelectronics',
		'cortex-m4', 80, 256 * 1024, 64 * 1024, 'single', true, true, 51,
		[...STM32_COMMON_PERIPHS, 'FDCAN', 'SAI', 'DFSDM', 'DAC'],
		[mem('FLASH', 0x08000000, 256 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 48 * 1024), mem('SRAM2', 0x10000000, 16 * 1024)],
		['NUCLEO-L431RC'], ['l431', 'stm32l431', 'stm32l4', 'ultra-low-power']),


	// ─── More NXP LPC ────────────────────────────────────────────────────
	e('LPC55S69JEV98', 'LPC55', 'LPC55S69', 'NXP',
		'cortex-m33', 150, 640 * 1024, 320 * 1024, 'double', true, true, 68,
		['GPIO', 'FLEXCOMM', 'USB', 'CAN', 'ADC', 'DAC', 'DMA', 'SCT', 'CTimer', 'RTC', 'WDT', 'CASPER', 'PRINCE', 'PUF'],
		[mem('FLASH', 0x00000000, 640 * 1024, 'read-only'), mem('SRAM0', 0x20000000, 272 * 1024), mem('SRAM1', 0x20040000, 16 * 1024)],
		['LPCXpresso55S69'],
		['lpc55s69', 'lpc55', 'nxp', 'dual-core', 'cortex-m33', 'trustzone', 'puf', 'pkc']),

	// ─── TI CC2652 ───────────────────────────────────────────────────────
	e('CC2652P1FRGZR', 'CC26xx', 'CC2652P', 'Texas Instruments',
		'cortex-m4', 48, 352 * 1024, 80 * 1024, 'single', true, true, 40,
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'DMA', 'BLE', 'IEEE802154', 'AES', 'ECC', 'PA'],
		[mem('FLASH', 0x00000000, 352 * 1024, 'read-only'), mem('SRAM', 0x20000000, 80 * 1024)],
		['LAUNCHXL-CC26X2R1'],
		['cc2652p', 'cc26xx', 'ti', 'ble5', 'thread', 'zigbee', 'matter', '+20dbm', 'simplelink']),


	// ─── STM32F7 extended ────────────────────────────────────────────────
	e('STM32F730R8T6', 'STM32F7', 'STM32F730', 'STMicroelectronics',
		'cortex-m7', 216, 64 * 1024, 256 * 1024, 'single', true, true, 51,
		[...STM32_COMMON_PERIPHS, 'USB_OTG', 'CRYP', 'HASH', 'RNG', 'TRNG'],
		[mem('FLASH', 0x08000000, 64 * 1024, 'read-only'), mem('DTCM', 0x20000000, 64 * 1024), mem('AXI_SRAM', 0x20010000, 192 * 1024)],
		['NUCLEO-F730R8'], ['f730', 'stm32f730', 'stm32f7', 'crypto', 'usb hs']),

	// ─── Renesas RA6M1 / RX660 ───────────────────────────────────────────
	e('R7FA6M1AD3CFP', 'RA6', 'RA6M1', 'Renesas',
		'cortex-m4', 120, 512 * 1024, 256 * 1024, 'single', true, true, 100,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN', 'USB', 'ETHER', 'ADC', 'DAC', 'DMA', 'GPT', 'RTC', 'WDT'],
		[mem('CODE_FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 256 * 1024)],
		['EK-RA6M1'], ['ra6m1', 'ra6', 'renesas', 'ethernet', 'usb']),

	e('R5F56609CDDFB', 'RX660', 'RX660', 'Renesas',
		'rx', 120, 2048 * 1024, 512 * 1024, 'double', true, true, 177,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN', 'USB', 'ETHER', 'ADC', 'DMA', 'GPT', 'RTC', 'GLCDC', 'DRW', 'TSIP'],
		[mem('ROM', 0xFFE00000, 2048 * 1024, 'read-only'), mem('RAM', 0x00000000, 512 * 1024)],
		['RSK-RX660'],
		['rx660', 'rx', 'renesas', 'ethernet', 'tsip', 'industrial']),

	// ─── NXP LPC804 — Cortex-M0+ Budget ──────────────────────────────────
	e('LPC804M101JDH20', 'LPC8', 'LPC804', 'NXP',
		'cortex-m0+', 15, 32 * 1024, 4 * 1024, 'none', false, false, 20,
		['GPIO', 'USART', 'SPI', 'I2C', 'ADC', 'DAC', 'SCT', 'CTIMER', 'WDT', 'CMP', 'MRT'],
		[mem('FLASH', 0x00000000, 32 * 1024, 'read-only'), mem('SRAM', 0x10000000, 4 * 1024)],
		['LPC804 Eval Board'],
		['lpc804', 'lpc8', 'nxp', 'cortex-m0+', 'budget', '10-pin dip']),


	// ─── Silicon Labs EFR32BG27 ───────────────────────────────────────────
	e('EFR32BG27C140F768IM40', 'EFR32BG', 'EFR32BG27', 'Silicon Labs',
		'cortex-m33', 78, 768 * 1024, 64 * 1024, 'single', true, true, 24,
		['GPIO', 'USART', 'I2C', 'TIMER', 'ADC', 'DMA', 'BLE', 'AES', 'SHA', 'PKA', 'TRNG', 'PDM'],
		[mem('FLASH', 0x08000000, 768 * 1024, 'read-only'), mem('SRAM', 0x20000000, 64 * 1024)],
		['xG27-DK2602A'],
		['efr32bg27', 'efr32bg', 'silabs', 'ble', 'trustzone', 'audio', 'pdm']),

	// ─── Microchip SAMD20 ────────────────────────────────────────────────
	e('ATSAMD20J18A', 'SAM D20', 'SAMD20', 'Microchip',
		'cortex-m0+', 48, 256 * 1024, 32 * 1024, 'none', false, false, 64,
		['GPIO', 'SERCOM', 'TC', 'ADC', 'DAC', 'DMAC', 'RTC', 'WDT', 'EIC', 'EVSYS'],
		[mem('FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['SAM D20 Xplained Pro'],
		['samd20', 'sam d20', 'microchip', 'cortex-m0+', 'no usb', 'serial']),

	// ─── Microchip dsPIC33CH ─────────────────────────────────────────────
	e('dsPIC33CH512MP508', 'dsPIC33', 'dsPIC33CH', 'Microchip',
		'other', 90, 512 * 1024, 48 * 1024, 'double', false, true, 80,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN_FD', 'ADC', 'DAC', 'DMA', 'PWM', 'QEI', 'CMP', 'SENT', 'MCCP'],
		[mem('PROGRAM_FLASH', 0x000000, 512 * 1024, 'read-only'), mem('DATA_RAM', 0x000800, 48 * 1024)],
		['Curiosity Development Board dsPIC33CH'],
		['dspic33ch', 'dspic33', 'microchip', 'dsp', 'motor control', 'can-fd', 'dual-core']),


	// ─── Nordic nRF7002 — WiFi 6 companion ───────────────────────────────
	e('nRF7002-QFAA', 'nRF70', 'nRF7002', 'Nordic Semiconductor',
		'other', 0, 0, 0, 'none', false, false, 15,
		['WiFi6', 'WPA3', 'TWT', 'OFDMA', 'MU-MIMO', 'SPI', 'QSPI'],
		[mem('SRAM', 0x00000000, 256 * 1024)],
		['nRF7002 DK', 'nRF7002 EK'],
		['nrf7002', 'nrf70', 'nordic', 'wifi6', 'wifi', 'wpa3', 'iot companion']),

	// ─── Ambiq Apollo3 ────────────────────────────────────────────────────
	e('AMA3B1KK-KBR', 'Apollo3', 'Apollo3 Blue', 'Ambiq',
		'cortex-m4', 96, 1024 * 1024, 384 * 1024, 'single', true, true, 50,
		['GPIO', 'UART', 'SPI', 'I2C', 'I2S', 'PDM', 'ADC', 'DMA', 'MSPI', 'BLE', 'WDT'],
		[mem('FLASH', 0x00018000, 1024 * 1024, 'read-only'), mem('TCM', 0x10000000, 64 * 1024), mem('SSRAM', 0x10010000, 384 * 1024)],
		['SparkFun Edge', 'SparkFun Artemis'],
		['apollo3', 'ambiq', 'ble', 'ultra-low-power', 'tensorflow lite', 'sparkfun edge']),

	// ─── Renesas RA2E2 ───────────────────────────────────────────────────
	e('R7FA2E2A72DFM', 'RA2', 'RA2E2', 'Renesas',
		'cortex-m23', 32, 64 * 1024, 8 * 1024, 'none', true, false, 17,
		['GPIO', 'SCI', 'RIIC', 'ADC', 'DAC', 'GPT', 'RTC', 'WDT'],
		[mem('CODE_FLASH', 0x00000000, 64 * 1024, 'read-only'), mem('SRAM', 0x20000000, 8 * 1024)],
		['EK-RA2E2'], ['ra2e2', 'ra2', 'renesas', 'cortex-m23', 'tiny']),

	// ─── STM32G0 C-line ──────────────────────────────────────────────────
	e('STM32G0C1RET6', 'STM32G0', 'STM32G0C1', 'STMicroelectronics',
		'cortex-m0+', 64, 512 * 1024, 144 * 1024, 'none', false, false, 51,
		['GPIO', 'USART', 'SPI', 'I2C', 'ADC', 'DAC', 'DMA', 'RTC', 'LPTIM', 'FDCAN', 'USB', 'UCPD', 'WDT'],
		[mem('FLASH', 0x08000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 144 * 1024)],
		['NUCLEO-G0C1RE'],
		['g0c1', 'stm32g0c1', 'stm32g0', 'fdcan', 'usb-pd', 'ucpd']),

	// ─── TI AM62x — Sitara MP ────────────────────────────────────────────
	e('AM6254BSKEABCAB4', 'AM62x', 'AM6254', 'Texas Instruments',
		'cortex-a', 1400, 0, 0, 'none', true, false, 300,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN_FD', 'USB', 'GMAC', 'SDMMC', 'ADC', 'DMA', 'ECAP', 'EQEP', 'PRU', 'DDR4', 'PCIe'],
		[mem('DDR4', 0x80000000, 2048 * 1024 * 1024), mem('MSRAM', 0x00070000, 256 * 1024)],
		['SK-AM62', 'BeaglePlay', 'AM62x EVM'],
		['am6254', 'am62x', 'ti', 'cortex-a53', 'linux', 'android', 'beagleplay', 'hmi']),

	// ─── More STM32G0 ────────────────────────────────────────────────────
	e('STM32G050C8T6', 'STM32G0', 'STM32G050', 'STMicroelectronics',
		'cortex-m0+', 64, 64 * 1024, 18 * 1024, 'none', false, false, 37,
		['GPIO', 'USART', 'SPI', 'I2C', 'ADC', 'DMA', 'TIM', 'RTC', 'WDT'],
		[mem('FLASH', 0x08000000, 64 * 1024, 'read-only'), mem('SRAM', 0x20000000, 18 * 1024)],
		[], ['g050', 'stm32g050', 'stm32g0', 'value-line']),

	// ─── Microchip SAME53 / SAME54 ───────────────────────────────────────
	e('ATSAME53J20A', 'SAM E5x', 'SAME53', 'Microchip',
		'cortex-m4', 120, 1024 * 1024, 256 * 1024, 'single', true, true, 64,
		['GPIO', 'SERCOM', 'TC', 'TCC', 'ADC', 'DAC', 'USB', 'DMAC', 'RTC', 'WDT', 'SDHC', 'EIC', 'CAN', 'GMAC'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 256 * 1024)],
		['SAM E53 Xplained Pro'],
		['same53', 'sam e53', 'microchip', 'cortex-m4', 'ethernet', 'usb hs', 'can']),

	// ─── Infineon XMC4300 / XMC4200 ──────────────────────────────────────
	e('XMC4300-F256K256AA', 'XMC4', 'XMC4300', 'Infineon',
		'cortex-m4', 144, 256 * 1024, 64 * 1024, 'single', true, true, 100,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN', 'USB', 'ADC', 'DAC', 'DMA', 'CCU4', 'CCU8', 'POSIF', 'EtherCAT'],
		[mem('FLASH', 0x08000000, 256 * 1024, 'read-only'), mem('PSRAM', 0x1FFF8000, 64 * 1024)],
		['XMC4300 Relax EtherCAT Kit'],
		['xmc4300', 'xmc4', 'infineon', 'ethercat', 'cortex-m4', 'industrial']),

	// ─── NXP MK82F — FRDM ────────────────────────────────────────────────
	e('MK82FN256VLL15', 'Kinetis K', 'K82F', 'NXP',
		'cortex-m4', 150, 256 * 1024, 256 * 1024, 'single', true, true, 100,
		['GPIO', 'LPUART', 'DSPI', 'I2C', 'USB', 'QSPI', 'ADC', 'DAC', 'DMA', 'FTM', 'PIT', 'I2S', 'AES'],
		[mem('FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('SRAM_U', 0x20000000, 256 * 1024)],
		['FRDM-K82F'],
		['k82f', 'kinetis k', 'nxp', 'frdm', 'quadspi', 'usb hs', 'crypto']),

	// ─── STM32L4 more ────────────────────────────────────────────────────
	e('STM32L412RBT6P', 'STM32L4', 'STM32L412', 'STMicroelectronics',
		'cortex-m4', 80, 128 * 1024, 40 * 1024, 'single', true, true, 51,
		[...STM32_COMMON_PERIPHS, 'USB', 'DAC'],
		[mem('FLASH', 0x08000000, 128 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 32 * 1024), mem('SRAM2', 0x10000000, 8 * 1024)],
		['NUCLEO-L412RB-P'], ['l412', 'stm32l412', 'stm32l4', 'ultra-low-power', 'usb']),

	// ─── Nordic nRF52 midrange ────────────────────────────────────────────
	e('nRF52832-CIAA-R7', 'nRF52', 'nRF52832 QFN48', 'Nordic Semiconductor',
		'cortex-m4', 64, 512 * 1024, 64 * 1024, 'single', true, true, 31,
		[...NORDIC_COMMON_PERIPHS, 'BLE', 'AES_CCM', 'ANT'],
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('RAM', 0x20000000, 64 * 1024)],
		['nRF52832 DK', 'nRF52840 DK (compat)', 'Particle Argon', 'Adafruit Bluefruit'],
		['nrf52832 qfn48', 'nrf52832', 'nrf52', 'ble', 'nordic', 'ant', 'smaller package']),

	// ─── STM32F3 more ─────────────────────────────────────────────────────
	e('STM32F373CCT6', 'STM32F3', 'STM32F373', 'STMicroelectronics',
		'cortex-m4', 72, 256 * 1024, 32 * 1024, 'single', true, true, 51,
		[...STM32_COMMON_PERIPHS, 'USB', 'SDADC', 'OPAMP', 'COMP'],
		[mem('FLASH', 0x08000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		[], ['f373', 'stm32f373', 'stm32f3', 'sdadc', 'analog']),

	// ─── More Renesas RA and RX series ───────────────────────────────────
	e('R7FA6M6AF3CFP', 'RA6', 'RA6M6', 'Renesas',
		'cortex-m33', 200, 2048 * 1024, 512 * 1024, 'double', true, true, 105,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN_FD', 'USB', 'ETHER', 'ADC', 'DAC', 'DMA', 'GPT', 'RTC', 'WDT', 'OSPI', 'SRAM_ECC'],
		[mem('CODE_FLASH', 0x00000000, 2048 * 1024, 'read-only'), mem('SRAM', 0x20000000, 512 * 1024)],
		['EK-RA6M6'],
		['ra6m6', 'ra6', 'renesas', 'trustzone', 'can-fd', 'ethernet', 'ecc', 'functional safety']),

	e('R5F52316ADFM', 'RX231', 'RX230', 'Renesas',
		'rx', 54, 256 * 1024, 64 * 1024, 'none', false, false, 64,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'USB', 'ADC', 'DMA', 'TMR', 'GPT', 'RTC', 'WDT'],
		[mem('ROM', 0xFFFC0000, 256 * 1024, 'read-only'), mem('RAM', 0x00000000, 64 * 1024)],
		['RSK-RX230'], ['rx230', 'rx231', 'rx', 'renesas', 'usb', 'iot']),

	// ─── NXP S32K388 — latest S32K3 ──────────────────────────────────────
	e('S32K388', 'S32K3', 'S32K388', 'NXP',
		'cortex-m7', 320, 4096 * 1024, 2048 * 1024, 'double', true, true, 200,
		['GPIO', 'LPUART', 'LPSPI', 'LPI2C', 'FlexCAN_FD', 'ADC', 'DMA', 'GTM', 'PIT', 'WDOG', 'HSE', 'ERM'],
		[mem('FLASH', 0x00400000, 4096 * 1024, 'read-only'), mem('SRAM', 0x20400000, 2048 * 1024)],
		['S32K388 EVB'],
		['s32k388', 's32k3', 'nxp', 'automotive', 'can-fd', 'asil-d', 'autosar']),


	// ─── STM32L0 more ─────────────────────────────────────────────────────
	e('STM32L053R8T6', 'STM32L0', 'STM32L053', 'STMicroelectronics',
		'cortex-m0+', 32, 64 * 1024, 8 * 1024, 'none', false, false, 51,
		['GPIO', 'USART', 'SPI', 'I2C', 'USB', 'ADC', 'DAC', 'DMA', 'RTC', 'LPTIM', 'LCD', 'AES', 'WDT'],
		[mem('FLASH', 0x08000000, 64 * 1024, 'read-only'), mem('SRAM', 0x20000000, 8 * 1024)],
		['NUCLEO-L053R8'], ['l053', 'stm32l053', 'stm32l0', 'usb', 'aes']),

	// ─── More Silicon Labs EFM32/EFR32 ───────────────────────────────────
	e('EFR32MG21A010F1024IM32', 'EFR32MG', 'EFR32MG21', 'Silicon Labs',
		'cortex-m33', 80, 1024 * 1024, 96 * 1024, 'single', true, true, 20,
		['GPIO', 'USART', 'I2C', 'TIMER', 'ADC', 'DMA', 'BLE', 'IEEE802154', 'AES', 'SHA', 'PKA', 'TRNG'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 96 * 1024)],
		['xG21-RB4180B'],
		['efr32mg21', 'efr32mg', 'silabs', 'ble', 'zigbee', 'thread', 'matter', 'trustzone']),

	e('EFM32WG280F256', 'EFM32WG', 'EFM32WG', 'Silicon Labs',
		'cortex-m4', 48, 256 * 1024, 32 * 1024, 'single', true, true, 89,
		['GPIO', 'USART', 'I2C', 'TIMER', 'ADC', 'DAC', 'DMA', 'LCD', 'RTC', 'WDT', 'CRYPTO'],
		[mem('FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['EFM32WG-STK3800'],
		['efm32wg', 'efm32wg280', 'silabs', 'wonder gecko', 'ultra-low-power', 'lcd']),

	// ─── TI CC2650/CC2640 ─────────────────────────────────────────────────
	e('CC2650MODA', 'CC26xx', 'CC2650', 'Texas Instruments',
		'cortex-m3', 48, 128 * 1024, 20 * 1024, 'none', false, false, 5,
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'BLE', 'AES', 'WDT'],
		[mem('FLASH', 0x00000000, 128 * 1024, 'read-only'), mem('SRAM', 0x20000000, 20 * 1024)],
		['CC2650 LaunchPad', 'SensorTag'],
		['cc2650', 'cc26xx', 'ti', 'ble4', 'sensortag', 'simplelink', 'beagle bone cape']),

	// ─── Microchip PIC18F K-series ────────────────────────────────────────
	e('PIC18F47K42', 'PIC18', 'PIC18F47K42', 'Microchip',
		'pic', 64, 128 * 1024, 8 * 1024, 'none', false, false, 40,
		['GPIO', 'UART', 'SPI', 'I2C', 'ADC', 'DAC', 'CMP', 'TMR', 'WDT', 'CLC', 'DMA', 'EEPROM'],
		[mem('PROGRAM_FLASH', 0x000000, 128 * 1024, 'read-only'), mem('DATA_SRAM', 0x000000, 8 * 1024)],
		['Curiosity Nano PIC18F47K42'],
		['pic18f47k42', 'pic18fk42', 'pic18', 'microchip', '8-bit', 'dma', 'clc']),


	// ─── NXP LPC5500 M33 dual-core ────────────────────────────────────────
	e('LPC5534JBD100', 'LPC55', 'LPC5534', 'NXP',
		'cortex-m33', 150, 512 * 1024, 256 * 1024, 'single', true, true, 84,
		['GPIO', 'FLEXCOMM', 'CAN', 'ADC', 'DAC', 'DMA', 'SCT', 'CTimer', 'WDT', 'CASPER'],
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 256 * 1024)],
		['LPCXpresso5534'],
		['lpc5534', 'lpc55', 'nxp', 'cortex-m33', 'trustzone', 'powerquad', 'can-fd']),

	// ─── Espressif ESP32-S2 more ───────────────────────────────────────────
	e('ESP32-S2-MINI-1U', 'ESP32', 'ESP32-S2-MINI', 'Espressif',
		'xtensa', 240, 4 * 1024 * 1024, 320 * 1024, 'none', false, false, 27,
		['GPIO', 'UART', 'SPI', 'I2C', 'I2S', 'RMT', 'TIMER', 'ADC', 'DAC', 'USB_OTG', 'DMA', 'WDT'],
		[mem('IROM', 0x40080000, 4 * 1024 * 1024, 'read-only'), mem('IRAM', 0x40370000, 320 * 1024)],
		['ESP32-S2-MINI-1 DevKit', 'Unexpected Maker FeatherS2'],
		['esp32s2 mini', 'esp32s2', 'espressif', 'usb-otg', 'wifi', 'no bluetooth', 'iot']),

	// ─── Renesas RA4T1 ────────────────────────────────────────────────────
	e('R7FA4T1BB3CFM', 'RA4', 'RA4T1', 'Renesas',
		'cortex-m33', 100, 512 * 1024, 128 * 1024, 'single', true, true, 48,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN_FD', 'ADC', 'DAC', 'DMA', 'GPT', 'POEG', 'EQDC', 'MTU3'],
		[mem('CODE_FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 128 * 1024)],
		['MCK-RA4T1'],
		['ra4t1', 'ra4', 'renesas', 'motor control', 'can-fd', 'trustzone-m']),

	// ─── STM32G0 B-series ─────────────────────────────────────────────────
	e('STM32G0B0RET6', 'STM32G0', 'STM32G0B0', 'STMicroelectronics',
		'cortex-m0+', 64, 512 * 1024, 144 * 1024, 'none', false, false, 51,
		['GPIO', 'USART', 'SPI', 'I2C', 'ADC', 'DMA', 'RTC', 'LPTIM', 'WDT'],
		[mem('FLASH', 0x08000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 144 * 1024)],
		['NUCLEO-G0B0RE'], ['g0b0', 'stm32g0b0', 'stm32g0', 'value-line', 'no-usb']),

	// ─── More NXP iMX RT ──────────────────────────────────────────────────
	e('MIMXRT1062DVL6B', 'i.MX RT', 'i.MX RT1060', 'NXP',
		'cortex-m7', 600, 0, 1024 * 1024, 'double', true, true, 124,
		['GPIO', 'LPUART', 'LPSPI', 'LPI2C', 'FlexCAN', 'USB', 'ENET', 'ADC', 'GPT', 'PIT', 'SEMC', 'DMA', 'CSI', 'LCDIF'],
		[mem('ITCM', 0x00000000, 512 * 1024), mem('DTCM', 0x20000000, 512 * 1024), mem('OCRAM', 0x20200000, 1024 * 1024)],
		['MIMXRT1060-EVK', 'Teensy 4.1', 'MIMXRT1064-EVK'],
		['imxrt1060', 'imxrt', 'nxp', 'crossover', 'teensy 4.1', 'ethernet', 'camera']),

	// ─── TI MSP430FR2355 ──────────────────────────────────────────────────
	e('MSP430FR2355TRHBR', 'MSP430', 'MSP430FR2355', 'Texas Instruments',
		'msp430', 24, 32 * 1024, 4 * 1024, 'none', false, false, 32,
		['GPIO', 'eUSCI_A', 'eUSCI_B', 'TIMER_A', 'ADC', 'DMA', 'RTC', 'WDT', 'CRC', 'COMPARATOR'],
		[mem('FRAM', 0x8000, 32 * 1024, 'read-write'), mem('RAM', 0x2000, 4 * 1024)],
		['MSP-EXP430FR2355 LaunchPad'],
		['msp430fr2355', 'msp430fr', 'msp430', 'ti', 'fram', 'ultra-low-power', 'launchpad']),

	// ─── Nordic nRF52820 ─────────────────────────────────────────────────
	e('nRF52820-QDAA-R7', 'nRF52', 'nRF52820', 'Nordic Semiconductor',
		'cortex-m4', 64, 256 * 1024, 32 * 1024, 'single', false, false, 32,
		['GPIO', 'UARTE', 'SPIM', 'TWIM', 'TIMER', 'SAADC', 'RTC', 'WDT', 'RADIO', 'USB'],
		[mem('FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('RAM', 0x20000000, 32 * 1024)],
		['nRF52820 DK'],
		['nrf52820', 'nrf52', 'ble', 'nordic', 'usb', 'thread', 'zigbee', 'tiny']),

	// ─── RISC-V BL602 ────────────────────────────────────────────────────
	e('BL602C4', 'BL60x', 'BL602', 'Bouffalo Lab',
		'risc-v', 192, 2 * 1024 * 1024, 276 * 1024, 'none', false, false, 22,
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'DAC', 'WiFi', 'BT', 'DMA', 'WDT'],
		[mem('FLASH', 0x23000000, 2 * 1024 * 1024, 'read-only'), mem('RAM', 0x22008000, 276 * 1024)],
		['Pine64 Ox64 v1', 'Ai-Thinker BL-01'],
		['bl602', 'bouffalo', 'risc-v', 'wifi', 'ble', 'low-cost']),

	// ─── Microchip SAM4C — Dual Cortex-M4 ───────────────────────────────
	e('ATSAM4C32E', 'SAM4', 'SAM4C', 'Microchip',
		'cortex-m4', 120, 2048 * 1024, 304 * 1024, 'double', true, true, 100,
		['GPIO', 'USART', 'SPI', 'TWI', 'CAN', 'USB', 'ADC', 'DMAC', 'TC', 'IPC', 'SLCD'],
		[mem('FLASH', 0x01000000, 2048 * 1024, 'read-only'), mem('SRAM0', 0x20000000, 256 * 1024), mem('SRAM1', 0x20100000, 48 * 1024)],
		['SAM4C-EK'],
		['sam4c', 'sam4c32e', 'microchip', 'dual-core', 'cortex-m4', 'energy metering']),

	// ─── STM32MP2 ─────────────────────────────────────────────────────────
	e('STM32MP257FAI3', 'STM32MP2', 'STM32MP257', 'STMicroelectronics',
		'cortex-a', 1500, 0, 0, 'double', true, false, 400,
		['GPIO', 'USART', 'SPI', 'I2C', 'CAN_FD', 'USB', 'GMAC', 'SDMMC', 'ADC', 'DMA', 'GPU', 'LTDC', 'MIPI_DSI', 'MIPI_CSI', 'DDR4', 'NPU'],
		[mem('DDR4', 0x80000000, 2048 * 1024 * 1024), mem('SYSRAM', 0x2FFC0000, 256 * 1024)],
		['STM32MP257F-DK'],
		['stm32mp257', 'stm32mp2', 'linux', 'cortex-a35', 'dual-core', 'npu', 'ai', 'gpu']),

	// ─── More NXP S32K ───────────────────────────────────────────────────
	e('S32K146HAT0MLHR', 'S32K', 'S32K146', 'NXP',
		'cortex-m4', 112, 1024 * 1024, 128 * 1024, 'single', true, true, 100,
		['GPIO', 'LPUART', 'LPSPI', 'LPI2C', 'FlexCAN', 'LIN', 'ADC', 'DMA', 'FTM', 'PIT', 'WDOG'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 128 * 1024)],
		['S32K146EVB'],
		['s32k146', 's32k', 'nxp', 'automotive', 'lin', 'can', 'asil-b']),

	// ─── Microchip EV ATSAMV70 ───────────────────────────────────────────
	e('ATSAMV70Q20B', 'SAM V70', 'SAMV70', 'Microchip',
		'cortex-m7', 300, 1024 * 1024, 384 * 1024, 'double', true, true, 100,
		['GPIO', 'USART', 'SPI', 'TWIHS', 'MCAN', 'USB', 'GMAC', 'SDR', 'ADC', 'XDMAC', 'TC', 'PWM', 'MLB'],
		[mem('FLASH', 0x00400000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20400000, 384 * 1024)],
		['SAM V70 Xplained Ultra'],
		['samv70', 'sam v70', 'microchip', 'cortex-m7', 'automotive', 'can-fd', 'mlb']),

	// ─── Infineon TC39x large ─────────────────────────────────────────────
	e('TC399XP', 'AURIX', 'TC39x', 'Infineon',
		'tricore', 300, 32768 * 1024, 6144 * 1024, 'double', true, true, 400,
		['GPIO', 'ASCLIN', 'QSPI', 'I2C', 'MultiCAN_FD', 'MSC', 'SENT', 'GTM', 'EVADC', 'HSM', 'DMA', 'EMEM', 'ETHERNET', 'FlexRay', 'PCIe'],
		[mem('PMU_FLASH', 0xA0000000, 32768 * 1024, 'read-only'), mem('DSPR', 0x70000000, 512 * 1024), mem('LMU', 0x90000000, 2048 * 1024)],
		['KIT_AURIX_TC39X_TRB'],
		['tc399', 'tc39x', 'aurix', 'tricore', 'infineon', 'automotive', 'asil-d', 'flexray']),

	// ─── Renesas RA8T1 ────────────────────────────────────────────────────
	e('R7FA8T1BHECBD', 'RA8', 'RA8T1', 'Renesas',
		'cortex-m85', 480, 1024 * 1024, 128 * 1024, 'double', true, true, 48,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN_FD', 'ADC', 'DAC', 'DMA', 'GPT', 'POEG', 'EQDC', 'MTU3'],
		[mem('CODE_FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 128 * 1024)],
		['MCK-RA8T1'],
		['ra8t1', 'ra8', 'renesas', 'cortex-m85', 'motor control', 'helium']),

	// ─── More GigaDevice GD32 ─────────────────────────────────────────────
	e('GD32E503RET6', 'GD32E', 'GD32E503', 'GigaDevice',
		'cortex-m33', 180, 512 * 1024, 96 * 1024, 'single', true, true, 51,
		['GPIO', 'USART', 'SPI', 'I2C', 'ADC', 'DAC', 'DMA', 'RTC', 'WDT', 'TRIGMUX', 'SHRTIMER'],
		[mem('FLASH', 0x08000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 96 * 1024)],
		['GD32E503 Evaluation'],
		['gd32e503', 'gd32e', 'gigadevice', 'cortex-m33', 'hrtimer', 'digital power']),

	// ─── NXP MCX A-series ─────────────────────────────────────────────────
	e('MCXA153VLH', 'MCX A', 'MCX A153', 'NXP',
		'cortex-m33', 96, 128 * 1024, 32 * 1024, 'none', true, false, 57,
		['GPIO', 'FLEXCOMM', 'CMP', 'ADC', 'DAC', 'DMA', 'CTimer', 'SCT', 'WDT', 'RTC'],
		[mem('FLASH', 0x00000000, 128 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['FRDM-MCXA153'],
		['mcxa153', 'mcx a', 'nxp', 'cortex-m33', 'mcx', 'frdm', 'value-line']),

	e('MCXN947VDF', 'MCX N', 'MCX N947', 'NXP',
		'cortex-m33', 150, 2048 * 1024, 512 * 1024, 'double', true, true, 128,
		['GPIO', 'FLEXCOMM', 'USB', 'FlexCAN_FD', 'ADC', 'DMA', 'CTimer', 'SCT', 'WDT', 'CASPER', 'NPU', 'MIPI_DSI'],
		[mem('FLASH', 0x00000000, 2048 * 1024, 'read-only'), mem('SRAM', 0x20000000, 512 * 1024)],
		['FRDM-MCXN947'],
		['mcxn947', 'mcx n', 'nxp', 'cortex-m33', 'dual-core', 'npu', 'ethos-u55', 'ai']),

	// ─── STM32WBA more ────────────────────────────────────────────────────
	e('STM32WBA52CGU6', 'STM32WBA', 'STM32WBA52', 'STMicroelectronics',
		'cortex-m33', 100, 1024 * 1024, 96 * 1024, 'single', true, true, 37,
		[...STM32_COMMON_PERIPHS, 'BLE', 'AES', 'PKA', 'RNG', 'HASH'],
		[mem('FLASH', 0x08000000, 1024 * 1024, 'read-only'), mem('SRAM1', 0x20000000, 64 * 1024), mem('SRAM2', 0x20010000, 16 * 1024)],
		['NUCLEO-WBA52CG'],
		['stm32wba52', 'stm32wba', 'ble 5.4', 'trustzone', 'ultra-low-power']),

	// ─── Renesas RA2A2 ────────────────────────────────────────────────────
	e('R7FA2A2AD3CFM', 'RA2', 'RA2A2', 'Renesas',
		'cortex-m23', 48, 128 * 1024, 16 * 1024, 'none', true, false, 40,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'ADC', 'DAC', 'DMA', 'GPT', 'RTC', 'WDT', 'CTSU'],
		[mem('CODE_FLASH', 0x00000000, 128 * 1024, 'read-only'), mem('SRAM', 0x20000000, 16 * 1024)],
		['EK-RA2A2'],
		['ra2a2', 'ra2', 'renesas', 'cortex-m23', 'touch sensor']),

	// ─── TI Sitara AM573x ─────────────────────────────────────────────────
	e('AM5728BBBCXA', 'AM57x', 'AM5728', 'Texas Instruments',
		'cortex-a', 1500, 0, 0, 'double', true, false, 500,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN', 'USB', 'GMAC', 'SDMMC', 'ADC', 'DMA', 'PRU', 'DSP', 'M4', 'DDR4', 'HDMI', 'PCIe'],
		[mem('DDR4', 0x80000000, 2048 * 1024 * 1024), mem('L4_RAM', 0x402F0000, 256 * 1024)],
		['BeagleBoard-X15', 'AM572x IDK'],
		['am5728', 'am57xx', 'ti', 'cortex-a15', 'linux', 'pru', 'dsp', 'vision-sdk']),

	// ─── Microchip ATSAM4N ───────────────────────────────────────────────
	e('ATSAM4N16C', 'SAM4', 'SAM4N', 'Microchip',
		'cortex-m4', 100, 1024 * 1024, 80 * 1024, 'single', true, false, 83,
		['GPIO', 'USART', 'SPI', 'TWI', 'ADC', 'DMA', 'TC', 'PWM', 'RTC', 'WDT'],
		[mem('FLASH', 0x00400000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 80 * 1024)],
		['SAM4N Xplained Pro'],
		['sam4n', 'atsam4n', 'microchip', 'cortex-m4', 'no-usb', 'simple']),


	// ─── NXP MKE06 ────────────────────────────────────────────────────────
	e('MKE06Z128VLK4', 'Kinetis E', 'KE06Z', 'NXP',
		'cortex-m0+', 48, 128 * 1024, 16 * 1024, 'none', false, false, 81,
		['GPIO', 'UART', 'SPI', 'I2C', 'ADC', 'DMA', 'FTM', 'PIT', 'CMP', 'WDT'],
		[mem('FLASH', 0x00000000, 128 * 1024, 'read-only'), mem('SRAM', 0x20000000, 16 * 1024)],
		['FRDM-KE06Z'],
		['ke06z', 'kinetis e', 'nxp', 'frdm', '5v-tolerant', 'automotive-grade']),

	// ─── Renesas RA6E1 ────────────────────────────────────────────────────
	e('R7FA6E1AB3CFM', 'RA6', 'RA6E1', 'Renesas',
		'cortex-m33', 200, 512 * 1024, 128 * 1024, 'single', true, true, 100,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN_FD', 'USB', 'ADC', 'DAC', 'DMA', 'GPT', 'RTC', 'WDT', 'TFU'],
		[mem('CODE_FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 128 * 1024)],
		['EK-RA6E1'],
		['ra6e1', 'ra6', 'renesas', 'trustzone', 'can-fd', 'tfu', 'trig-functions']),

	// ─── Nuvoton M480 ────────────────────────────────────────────────────
	e('M484SAD', 'M480', 'M484', 'Nuvoton',
		'cortex-m4', 192, 512 * 1024, 160 * 1024, 'single', true, true, 128,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN', 'USB', 'EMAC', 'ADC', 'DAC', 'PDMA', 'QSPI', 'CRYPTO'],
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 160 * 1024)],
		['NuMaker-M482'],
		['m484', 'm480', 'nuvoton', 'cortex-m4', 'ethernet', 'usb hs', 'crypto']),

	// ─── Microchip ATmega4808 ─────────────────────────────────────────────
	e('ATmega4808-MFR', 'AVR', 'ATmega4808', 'Microchip',
		'avr', 20, 48 * 1024, 6 * 1024, 'none', false, false, 28,
		['GPIO', 'USART', 'SPI', 'TWI', 'TCA', 'TCB', 'TCD', 'ADC', 'DAC', 'AC', 'CCL', 'WDT', 'RTC', 'EEPROM'],
		[mem('FLASH', 0x0000, 48 * 1024, 'read-only'), mem('SRAM', 0x2800, 6 * 1024)],
		['ATmega4808 Curiosity Nano'],
		['atmega4808', 'mega4808', 'avr', 'microchip', 'nano-series', 'tcd']),

	// ─── STM32L1 more ────────────────────────────────────────────────────
	e('STM32L151RDT6', 'STM32L1', 'STM32L151', 'STMicroelectronics',
		'cortex-m3', 32, 384 * 1024, 48 * 1024, 'none', false, false, 51,
		['GPIO', 'USART', 'SPI', 'I2C', 'USB', 'ADC', 'DAC', 'DMA', 'RTC', 'LCD', 'AES'],
		[mem('FLASH', 0x08000000, 384 * 1024, 'read-only'), mem('SRAM', 0x20000000, 48 * 1024), mem('EEPROM', 0x08080000, 12 * 1024)],
		[], ['l151', 'stm32l151', 'stm32l1', 'eeprom', 'lcd']),

	// ─── Ambiq Apollo2 ────────────────────────────────────────────────────
	e('AM-AMA2-KBR', 'Apollo2', 'Apollo2', 'Ambiq',
		'cortex-m4', 96, 512 * 1024, 256 * 1024, 'single', true, true, 50,
		['GPIO', 'UART', 'SPI', 'I2C', 'I2S', 'PDM', 'ADC', 'DMA', 'WDT'],
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('TCM', 0x10000000, 64 * 1024), mem('SSRAM', 0x10010000, 256 * 1024)],
		['SparkFun Edge v1', 'Ambiq Apollo2 EVB'],
		['apollo2', 'ambiq', 'ultra-low-power', 'voice', 'pdm', 'tensorflow micro']),

	// ─── STM32F0 more ─────────────────────────────────────────────────────
	e('STM32F091CCT6', 'STM32F0', 'STM32F091', 'STMicroelectronics',
		'cortex-m0', 48, 256 * 1024, 32 * 1024, 'none', false, false, 51,
		['GPIO', 'USART', 'SPI', 'I2C', 'ADC', 'DMA', 'TIM', 'RTC', 'CAN', 'HDMI_ARC', 'WDT'],
		[mem('FLASH', 0x08000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['NUCLEO-F091RC'], ['f091', 'stm32f091', 'stm32f0', 'can', 'hdmi-arc']),

	// ─── Renesas RA4E1 / RA6T3 ───────────────────────────────────────────
	e('R7FA4E1AB3CFM', 'RA4', 'RA4E1', 'Renesas',
		'cortex-m33', 100, 512 * 1024, 128 * 1024, 'single', true, true, 68,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN_FD', 'USB', 'ADC', 'DAC', 'DMA', 'GPT', 'RTC', 'WDT'],
		[mem('CODE_FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 128 * 1024)],
		['EK-RA4E1'], ['ra4e1', 'ra4', 'renesas', 'trustzone', 'can-fd', 'usb']),

	e('R7FA6T3BB3CFM', 'RA6', 'RA6T3', 'Renesas',
		'cortex-m33', 200, 512 * 1024, 128 * 1024, 'double', true, true, 84,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN_FD', 'ADC', 'DAC', 'DMA', 'GPT', 'POEG', 'EQDC', 'MTU3', 'TFU'],
		[mem('CODE_FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 128 * 1024)],
		['MCK-RA6T3'], ['ra6t3', 'ra6', 'renesas', 'motor control', 'trustzone', 'sensorless']),

	// ─── NXP MCXW Series — Wireless ──────────────────────────────────────
	e('MCXW716CMFTA', 'MCX W', 'MCX W716', 'NXP',
		'cortex-m33', 96, 1024 * 1024, 256 * 1024, 'single', true, true, 44,
		['GPIO', 'FLEXCOMM', 'ADC', 'DMA', 'CTimer', 'WDT', 'BLE', 'IEEE802154', 'AES', 'PKA', 'TRNG'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 256 * 1024)],
		['FRDM-MCXW71'],
		['mcxw716', 'mcx w', 'nxp', 'ble', 'thread', 'zigbee', 'matter', 'trustzone']),

	// ─── Silicon Labs EFR32 series ────────────────────────────────────────
	e('EFR32BG22C224F512IM40', 'EFR32BG', 'EFR32BG22', 'Silicon Labs',
		'cortex-m33', 38, 512 * 1024, 32 * 1024, 'none', true, true, 20,
		['GPIO', 'USART', 'I2C', 'TIMER', 'ADC', 'DMA', 'BLE', 'AES', 'SHA', 'TRNG', 'PDM'],
		[mem('FLASH', 0x00000000, 512 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['xG22-DK2503A', 'Thunderboard BG22'],
		['efr32bg22', 'efr32bg', 'silabs', 'ble', 'ultra-low-power', 'thunderboard']),

	// ─── TI CC1312R — Sub-GHz only ────────────────────────────────────────
	e('CC1312R1FRGZ', 'CC13xx', 'CC1312R', 'Texas Instruments',
		'cortex-m4', 48, 352 * 1024, 80 * 1024, 'single', true, true, 40,
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'DMA', 'Sub-GHz_Radio', 'AES', 'SHA'],
		[mem('FLASH', 0x00000000, 352 * 1024, 'read-only'), mem('SRAM', 0x20000000, 80 * 1024)],
		['LAUNCHXL-CC1312R1'],
		['cc1312r', 'cc13xx', 'ti', 'sub-ghz', 'lorawan', '915mhz', '868mhz', 'simplelink']),


	// ─── Nordic nRF54L15 — next-gen ──────────────────────────────────────
	e('nRF54L15-QFAA', 'nRF54', 'nRF54L15', 'Nordic Semiconductor',
		'cortex-m33', 128, 1536 * 1024, 256 * 1024, 'double', true, true, 36,
		['GPIO', 'UARTE', 'SPIM', 'TWIM', 'TIMER', 'SAADC', 'PWM', 'RTC', 'WDT', 'RADIO', 'USB'],
		[mem('FLASH', 0x00000000, 1536 * 1024, 'read-only'), mem('RAM', 0x20000000, 256 * 1024)],
		['nRF54L15 DK'],
		['nrf54l15', 'nrf54', 'nordic', 'ble6', 'channel sounding', 'matter', 'next-gen']),

	// ─── Renesas RA6T2 — Motor control ───────────────────────────────────
	e('R7FA6T2BD3CFP', 'RA6', 'RA6T2', 'Renesas',
		'cortex-m33', 240, 2048 * 1024, 1024 * 1024, 'double', true, true, 105,
		['GPIO', 'SCI', 'RSPI', 'RIIC', 'CAN_FD', 'ADC', 'DAC', 'DMA', 'GPT', 'POEG', 'EQDC', 'MTU3', 'TFU'],
		[mem('CODE_FLASH', 0x00000000, 2048 * 1024, 'read-only'), mem('SRAM', 0x20000000, 1024 * 1024)],
		['MCK-RA6T2'],
		['ra6t2', 'ra6', 'renesas', 'motor control', 'inverter', 'trustzone', 'sensorless foc']),

	// ─── STM32G0 A-sub ────────────────────────────────────────────────────
	e('STM32G030C8T6', 'STM32G0', 'STM32G030', 'STMicroelectronics',
		'cortex-m0+', 64, 64 * 1024, 8 * 1024, 'none', false, false, 37,
		['GPIO', 'USART', 'SPI', 'I2C', 'ADC', 'DMA', 'TIM', 'RTC', 'WDT'],
		[mem('FLASH', 0x08000000, 64 * 1024, 'read-only'), mem('SRAM', 0x20000000, 8 * 1024)],
		[], ['g030', 'stm32g030', 'stm32g0', 'entry-level']),



	// ─── PolarFire SoC — RISC-V + Linux ──────────────────────────────────
	e('MPFS250T', 'PolarFire', 'PolarFire SoC', 'Microchip',
		'risc-v', 667, 0, 0, 'double', true, false, 300,
		['GPIO', 'UART', 'SPI', 'I2C', 'CAN', 'USB', 'GMAC', 'DDR4', 'PCIe', 'I2S', 'MMC', 'FPGA'],
		[mem('DDR4', 0x80000000, 2048 * 1024 * 1024), mem('L2_LIM', 0x08000000, 256 * 1024)],
		['Icicle Kit'],
		['mpfs250t', 'polarfire soc', 'microchip', 'risc-v', 'linux', 'fpga', 'hart-v', 'pcie']),

	// ─── TI CC2674 ────────────────────────────────────────────────────────
	e('CC2674P10RSKT', 'CC26xx', 'CC2674P10', 'Texas Instruments',
		'cortex-m4', 48, 1024 * 1024, 256 * 1024, 'single', true, true, 40,
		['GPIO', 'UART', 'SPI', 'I2C', 'TIMER', 'ADC', 'DMA', 'BLE', 'IEEE802154', 'Thread', 'AES', 'ECC', 'PA'],
		[mem('FLASH', 0x00000000, 1024 * 1024, 'read-only'), mem('SRAM', 0x20000000, 256 * 1024)],
		['LP-EM-CC1354P10-1', 'LP-EM-CC1354P10-6'],
		['cc2674p10', 'cc26xx', 'ti', 'simplelink', 'ble', 'thread', 'matter', 'sub-ghz', '+20dbm']),

	// ─── STM32H7RS ────────────────────────────────────────────────────────
	e('STM32H7S3L8H6', 'STM32H7RS', 'STM32H7S3', 'STMicroelectronics',
		'cortex-m7', 600, 64 * 1024, 3712 * 1024, 'double', true, true, 168,
		[...STM32_ADVANCED_PERIPHS, 'XSPI', 'DMA2D', 'JPEG', 'NNlib', 'FMC', 'LTDC', 'GFXTIM', 'SDMMC', 'GPU2D'],
		[mem('FLASH', 0x08000000, 64 * 1024, 'read-only'), mem('AXI_SRAM', 0x24000000, 768 * 1024), mem('ITCM', 0x00000000, 64 * 1024)],
		['STM32H7S78-DK'],
		['stm32h7s3', 'stm32h7rs', 'stm32h7', 'cortex-m7', '600mhz', 'neural net', 'gpu2d', 'ai']),


	// ─── Microchip PIC16F84A ──────────────────────────────────────────────
	e('PIC16F84A-04I/P', 'PIC16', 'PIC16F84A', 'Microchip',
		'pic', 4, 1024, 68, 'none', false, false, 18,
		['GPIO', 'TMR0', 'TMR1', 'WDT', 'EEPROM'],
		[mem('PROGRAM_FLASH', 0x0000, 1024, 'read-only'), mem('DATA_SRAM', 0x000C, 68)],
		['Classic Breadboard Demo', 'PIC16F84A Academic Board'],
		['pic16f84a', 'pic16f84', 'pic16', 'pic', 'microchip', '8-bit', 'classic', 'academic', 'mplab-x']),

	// ─── NXP MCX A mid ────────────────────────────────────────────────────
	e('MCXA156VLH', 'MCX A', 'MCX A156', 'NXP',
		'cortex-m33', 96, 256 * 1024, 64 * 1024, 'none', true, false, 57,
		['GPIO', 'FLEXCOMM', 'CMP', 'ADC', 'DAC', 'DMA', 'CTimer', 'SCT', 'WDT', 'RTC', 'USB'],
		[mem('FLASH', 0x00000000, 256 * 1024, 'read-only'), mem('SRAM', 0x20000000, 64 * 1024)],
		['FRDM-MCXA156'],
		['mcxa156', 'mcx a', 'nxp', 'cortex-m33', 'frdm', 'usb']),



	// ─── GD32L233 — ultra-low-power ───────────────────────────────────────
	e('GD32L233RBT6', 'GD32L', 'GD32L233', 'GigaDevice',
		'cortex-m23', 64, 128 * 1024, 32 * 1024, 'none', false, false, 51,
		['GPIO', 'USART', 'SPI', 'I2C', 'ADC', 'DAC', 'DMA', 'RTC', 'LPTIM', 'WDT'],
		[mem('FLASH', 0x08000000, 128 * 1024, 'read-only'), mem('SRAM', 0x20000000, 32 * 1024)],
		['GD32L233 Evaluation'],
		['gd32l233', 'gd32l', 'gigadevice', 'cortex-m23', 'ultra-low-power']),

	// ─── TI AM64x ────────────────────────────────────────────────────────
	e('AM6442', 'AM64x', 'AM6442', 'Texas Instruments',
		'cortex-a', 1000, 0, 0, 'double', true, false, 400,
		['GPIO', 'UART', 'SPI', 'I2C', 'MCAN', 'USB', 'GMAC', 'ICSSG', 'DDR4', 'PCIe', 'OSPI', 'SA3UL', 'PRU', 'R5', 'M4'],
		[mem('DDR4', 0x80000000, 2048 * 1024 * 1024), mem('MSRAM', 0x70000000, 2048 * 1024)],
		['SK-AM64', 'AM64x EVM'],
		['am6442', 'am64x', 'ti', 'cortex-a53', 'linux', 'industrial-ethernet', 'ethercat', 'profinet']),
];


/** Total number of MCU variants in the database. */
export const MCU_DATABASE_COUNT = MCU_DATABASE.length;

/** All unique MCU families in the database. */
export const MCU_FAMILIES: string[] = [...new Set(MCU_DATABASE.map(m => m.family))].sort();

/** All unique manufacturers in the database. */
export const MCU_MANUFACTURERS: string[] = [...new Set(MCU_DATABASE.map(m => m.manufacturer))].sort();
