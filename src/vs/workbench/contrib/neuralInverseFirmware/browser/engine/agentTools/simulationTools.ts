/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Simulation availability tools — Phase 5
 *
 * Two lightweight discovery tools. No execution — just check whether the current
 * MCU has a QEMU machine model or a Renode platform script, and return the
 * exact command to launch it.
 *
 * Lets the agent suggest a fw_build → QEMU/Renode test loop when no hardware
 * is connected, and set up a simulation environment automatically.
 */

import { IVoidInternalTool } from '../../../../void/browser/voidInternalToolService.js';
import { IFirmwareSessionService } from '../../firmwareSessionService.js';


export function buildSimulationTools(sessionService: IFirmwareSessionService): IVoidInternalTool[] {
	return [
		_fwQEMUAvailability(sessionService),
		_fwRenodeBoardCheck(sessionService),
	];
}


// ─── Tool implementations ─────────────────────────────────────────────────────

function _fwQEMUAvailability(session: IFirmwareSessionService): IVoidInternalTool {
	return {
		name: 'fw_qemu_availability',
		description: 'Check whether QEMU has a machine model for the current MCU family. Returns the -machine flag, minimum QEMU version, peripheral simulation gaps, and a sample launch command. Use when no hardware is connected to suggest a simulation-based development loop.',
		params: {},
		execute: async () => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }

			const family = s.mcuConfig?.family ?? '';
			const variant = s.mcuConfig?.variant ?? '';

			return _checkQEMUSupport(family, variant);
		},
	};
}


function _fwRenodeBoardCheck(session: IFirmwareSessionService): IVoidInternalTool {
	return {
		name: 'fw_renode_board_check',
		description: 'Check whether Renode (by Antmicro) has a platform script (.resc) for the current MCU. Renode has the broadest embedded simulation coverage including STM32, nRF52, RISC-V, ESP32 with actual peripheral simulation (UART, SPI, I2C, GPIO with IRQ delivery). Returns the script name and sample launch command.',
		params: {},
		execute: async () => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }

			const family = s.mcuConfig?.family ?? '';
			const variant = s.mcuConfig?.variant ?? '';

			return _checkRenodeSupport(family, variant);
		},
	};
}


// ─── QEMU support database ────────────────────────────────────────────────────

interface QEMUEntry {
	machine: string;
	description: string;
	minVersion: string;
	gaps: string[];
	elfFlag?: string;
}

const QEMU_MACHINES: Array<{ pattern: RegExp; entry: QEMUEntry }> = [
	{
		pattern: /STM32F103/i,
		entry: {
			machine: 'stm32-p103',
			description: 'Olimex STM32-P103 (STM32F103RBT6)',
			minVersion: '7.0',
			gaps: ['ADC', 'USB', 'CAN', 'DMA (partial)', 'RTC alarm'],
			elfFlag: '-kernel',
		},
	},
	{
		pattern: /STM32F4/i,
		entry: {
			machine: 'netduinoplus2',
			description: 'Netduino Plus 2 (STM32F405RGT6)',
			minVersion: '7.0',
			gaps: ['ADC', 'DAC', 'USB OTG', 'Ethernet', 'CRYPTO', 'HASH', 'RNG'],
			elfFlag: '-kernel',
		},
	},
	{
		pattern: /LM3S|LM4F|TM4C/i,
		entry: {
			machine: 'lm3s6965evb',
			description: 'TI Stellaris LM3S6965 EVB',
			minVersion: '5.0',
			gaps: ['ADC', 'PWM', 'USB', 'Ethernet (partial)'],
			elfFlag: '-kernel',
		},
	},
	{
		pattern: /LPC1768|LPC17/i,
		entry: {
			machine: 'lpc1768evb',
			description: 'NXP LPC1768 mbed evaluation board',
			minVersion: '6.0',
			gaps: ['USB', 'Ethernet', 'DAC', 'ADC (partial)'],
			elfFlag: '-kernel',
		},
	},
	{
		pattern: /ATMEGA|AVR/i,
		entry: {
			machine: 'arduino-uno',
			description: 'Arduino Uno (ATmega328P)',
			minVersion: '7.0',
			gaps: ['External EEPROM', 'SPI Flash', 'USB (via ATmega16U2 not simulated)'],
			elfFlag: '-bios',
		},
	},
	{
		pattern: /MPS2|MUSCA|AN385|AN386|AN500|AN505/i,
		entry: {
			machine: 'mps2-an386',
			description: 'ARM MPS2 FPGA board (Cortex-M4)',
			minVersion: '6.0',
			gaps: ['FPGA-specific peripherals'],
			elfFlag: '-kernel',
		},
	},
	{
		pattern: /VIRT|GENERIC.*CORTEX/i,
		entry: {
			machine: 'mps2-an386',
			description: 'Generic Cortex-M4 (MPS2 AN386 approximation)',
			minVersion: '6.0',
			gaps: ['Target-specific peripherals', 'Flash at real MCU address'],
			elfFlag: '-kernel',
		},
	},
];


function _checkQEMUSupport(family: string, variant: string): string {
	const searchStr = `${family} ${variant}`.toUpperCase();

	for (const { pattern, entry } of QEMU_MACHINES) {
		if (pattern.test(searchStr)) {
			return [
				`QEMU support found for ${family} ${variant}:`,
				'',
				`  Machine:     ${entry.machine}`,
				`  Description: ${entry.description}`,
				`  Min QEMU:    v${entry.minVersion}`,
				'',
				`Sample launch command:`,
				`  qemu-system-arm \\`,
				`    -machine ${entry.machine} \\`,
				`    -nographic \\`,
				`    -semihosting-config enable=on,target=native \\`,
				`    ${entry.elfFlag ?? '-kernel'} build/firmware.elf`,
				'',
				`With GDB server (for fw_debug_start with tool: "qemu"):`,
				`  qemu-system-arm \\`,
				`    -machine ${entry.machine} \\`,
				`    -nographic \\`,
				`    -semihosting-config enable=on,target=native \\`,
				`    -gdb tcp::3333 -S \\`,
				`    ${entry.elfFlag ?? '-kernel'} build/firmware.elf`,
				'',
				`Peripheral simulation gaps (not simulated):`,
				entry.gaps.map(g => `  - ${g}`).join('\n'),
				'',
				`Note: QEMU simulates Cortex-M instruction set accurately. Timing-dependent`,
				`code and peripheral-interrupt-heavy code may not behave identically to hardware.`,
			].join('\n');
		}
	}

	// No match
	const suggestRenode = /STM32|NRF52|RP2040|ESP32|RISC/i.test(searchStr);

	return [
		`No QEMU machine model found for "${family} ${variant}".`,
		'',
		`QEMU Cortex-M coverage is limited to:`,
		`  - STM32F103 (stm32-p103)`,
		`  - STM32F405 (netduinoplus2)`,
		`  - TI Stellaris LM3S6965 (lm3s6965evb)`,
		`  - NXP LPC1768 (lpc1768evb)`,
		`  - AVR ATmega (arduino-uno)`,
		`  - ARM MPS2 Cortex-M4 (mps2-an386)`,
		...(suggestRenode ? [
			'',
			`Renode has broader coverage for your MCU — try fw_renode_board_check.`,
		] : []),
	].join('\n');
}


// ─── Renode support database ──────────────────────────────────────────────────

interface RenodeEntry {
	script: string;
	description: string;
	simulatedPeripherals: string[];
	launchCmd: string;
}

const RENODE_BOARDS: Array<{ pattern: RegExp; entry: RenodeEntry }> = [
	{
		pattern: /STM32F0/i,
		entry: {
			script: 'stm32f0discovery.resc',
			description: 'STM32F0 Discovery (STM32F051R8)',
			simulatedPeripherals: ['USART', 'I2C', 'SPI', 'GPIO', 'TIM', 'ADC'],
			launchCmd: 'renode --disable-xwt -e "include @scripts/single-node/stm32f0discovery.resc; start"',
		},
	},
	{
		pattern: /STM32F4/i,
		entry: {
			script: 'stm32f4discovery.resc',
			description: 'STM32F4 Discovery (STM32F407VGT6)',
			simulatedPeripherals: ['USART1-6', 'SPI1-3', 'I2C1-3', 'GPIO', 'TIM1-14', 'DMA1-2', 'RCC', 'NVIC'],
			launchCmd: 'renode --disable-xwt -e "include @scripts/single-node/stm32f4_discovery.resc; start"',
		},
	},
	{
		pattern: /STM32F7/i,
		entry: {
			script: 'stm32f746.resc',
			description: 'STM32F746 Nucleo (STM32F746ZG)',
			simulatedPeripherals: ['USART', 'SPI', 'I2C', 'GPIO', 'TIM', 'DMA', 'SDMMC'],
			launchCmd: 'renode --disable-xwt -e "include @scripts/single-node/stm32f746.resc; start"',
		},
	},
	{
		pattern: /STM32L0/i,
		entry: {
			script: 'stm32l0.resc',
			description: 'STM32L0 (ultra-low-power)',
			simulatedPeripherals: ['USART', 'SPI', 'I2C', 'GPIO', 'TIM', 'RTC', 'LPTIM'],
			launchCmd: 'renode --disable-xwt -e "include @scripts/single-node/stm32l0.resc; start"',
		},
	},
	{
		pattern: /STM32G0/i,
		entry: {
			script: 'stm32g0.resc',
			description: 'STM32G0 Nucleo',
			simulatedPeripherals: ['USART', 'SPI', 'I2C', 'GPIO', 'TIM', 'DMA'],
			launchCmd: 'renode --disable-xwt -e "include @scripts/single-node/stm32g0.resc; start"',
		},
	},
	{
		pattern: /NRF52840/i,
		entry: {
			script: 'nrf52840.resc',
			description: 'Nordic nRF52840 DK',
			simulatedPeripherals: ['UART0/1', 'SPI0-3', 'TWI0-1', 'GPIOTE', 'RADIO (partial)', 'RTC0-2', 'TIMER0-4'],
			launchCmd: 'renode --disable-xwt -e "include @scripts/single-node/nrf52840.resc; start"',
		},
	},
	{
		pattern: /NRF52/i,
		entry: {
			script: 'nrf52832.resc',
			description: 'Nordic nRF52832 DK',
			simulatedPeripherals: ['UART0', 'SPI0-2', 'TWI0-1', 'GPIOTE', 'RADIO (partial)', 'RTC0-2'],
			launchCmd: 'renode --disable-xwt -e "include @scripts/single-node/nrf52832.resc; start"',
		},
	},
	{
		pattern: /RP2040/i,
		entry: {
			script: 'rpi-pico.resc',
			description: 'Raspberry Pi Pico (RP2040)',
			simulatedPeripherals: ['UART0-1', 'SPI0-1', 'I2C0-1', 'GPIO', 'PIO0-1 (partial)', 'DMA', 'Timer'],
			launchCmd: 'renode --disable-xwt -e "include @scripts/single-node/rpi-pico.resc; start"',
		},
	},
	{
		pattern: /ESP32(?!-S|-C)/i,
		entry: {
			script: 'esp32.resc',
			description: 'Espressif ESP32 (Xtensa LX6)',
			simulatedPeripherals: ['UART0-2', 'SPI0-3', 'I2C0-1', 'GPIO', 'Timer', 'RMT (partial)'],
			launchCmd: 'renode --disable-xwt -e "include @scripts/single-node/esp32.resc; start"',
		},
	},
	{
		pattern: /RISCV|RISC.V|GD32VF|FE310|SiFive/i,
		entry: {
			script: 'sifive_fe310.resc',
			description: 'SiFive FE310 (RISC-V RV32)',
			simulatedPeripherals: ['UART0-1', 'SPI0-2', 'GPIO', 'CLINT', 'PLIC'],
			launchCmd: 'renode --disable-xwt -e "include @scripts/single-node/sifive_fe310.resc; start"',
		},
	},
];


function _checkRenodeSupport(family: string, variant: string): string {
	const searchStr = `${family} ${variant}`.toUpperCase();

	for (const { pattern, entry } of RENODE_BOARDS) {
		if (pattern.test(searchStr)) {
			return [
				`Renode platform script found for ${family} ${variant}:`,
				'',
				`  Script:      ${entry.script}`,
				`  Description: ${entry.description}`,
				'',
				`Simulated peripherals:`,
				entry.simulatedPeripherals.map(p => `  ✓ ${p}`).join('\n'),
				'',
				`Launch command (no GUI):`,
				`  ${entry.launchCmd}`,
				'',
				`With UART output redirected to terminal:`,
				`  renode --disable-xwt -e "\\`,
				`    include @scripts/single-node/${entry.script.replace('.resc', '')}.resc;\\`,
				`    machine StartGdbServer 3333;\\`,
				`    emulation RunFor '00:00:05';\\`,
				`    start"`,
				'',
				`Load your ELF before starting:`,
				`  -e "sysbus LoadELF @build/firmware.elf"`,
				'',
				`Renode logs UART output to console — pair with fw_serial_read for agent-readable output.`,
				`Install: https://renode.io (cross-platform, also available via apt/brew/pip).`,
			].join('\n');
		}
	}

	return [
		`No Renode platform script found for "${family} ${variant}".`,
		'',
		`Renode coverage includes:`,
		`  STM32F0/F4/F7/L0/G0, nRF52832/840, RP2040, ESP32, RISC-V (SiFive FE310)`,
		'',
		`Check the full Renode board list:`,
		`  https://github.com/renode/renode/tree/master/scripts/single-node`,
		'',
		`If your MCU is not listed, you can create a custom .resc platform script.`,
		`Renode platform scripts are written in a domain-specific language (Robot Framework variant).`,
		`Reference: https://renode.readthedocs.io/en/latest/`,
	].join('\n');
}
