/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Peripheral intelligence agent tools — Phase 4
 *
 * Answers the questions firmware engineers look up manually dozens of times a day:
 *   - What PSC/ARR/CCR values do I need for 8 Hz at 50% duty?
 *   - Which AF number routes USART1 to PA9?
 *   - Which DMA stream/channel handles SPI2_RX?
 *   - What NVIC priority is safe to call FreeRTOS APIs from?
 *   - What does my platformio.ini / sdkconfig say about baud rate?
 *
 * All tools are deterministic — no LLM calls. Data sourced from the session
 * register maps (SVD), session MCU config, and bundled lookup tables.
 */

import { IVoidInternalTool } from '../../../../void/browser/voidInternalToolService.js';
import { IFirmwareSessionService } from '../../firmwareSessionService.js';
import { IPeripheralRegisterMap } from '../../../common/firmwareTypes.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { URI } from '../../../../../../base/common/uri.js';


export function buildPeripheralIntelTools(
	sessionService: IFirmwareSessionService,
	fileService: IFileService,
): IVoidInternalTool[] {
	return [
		_fwCalculatePrescaler(sessionService),
		_fwGPIOAlternateFunctions(sessionService),
		_fwDMAChannelMap(sessionService),
		_fwNVICPriorityGuide(sessionService),
		_fwReadConfigFile(sessionService, fileService),
		_fwGetPinAssignments(sessionService),
	];
}


// ─── Tool implementations ─────────────────────────────────────────────────────

function _fwCalculatePrescaler(session: IFirmwareSessionService): IVoidInternalTool {
	return {
		name: 'fw_calculate_prescaler',
		description: 'Calculate PSC (prescaler), ARR (auto-reload), and CCR (capture/compare) register values for a timer peripheral to hit a target frequency and duty cycle. Shows the math and the actual achieved frequency due to integer division. Returns ready-to-paste C defines.',
		params: {
			peripheral: { description: 'Timer peripheral name, e.g. "TIM2", "TIM3", "TIM1"' },
			targetFrequencyHz: { description: 'Target output frequency in Hz, e.g. 1000 for 1 kHz, 0.5 for 2 second period' },
			targetDutyCycle: { description: 'PWM duty cycle as percentage 0-100. Default: 50. Omit for basic period calculation.' },
		},
		execute: async (args: Record<string, any>) => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }

			const periph = (args.peripheral as string | undefined)?.toUpperCase() ?? 'TIM2';
			const targetHz = typeof args.targetFrequencyHz === 'number' ? args.targetFrequencyHz : 1000;
			const dutyCycle = typeof args.targetDutyCycle === 'number' ? args.targetDutyCycle : 50;

			if (targetHz <= 0) { return 'targetFrequencyHz must be > 0.'; }
			if (dutyCycle < 0 || dutyCycle > 100) { return 'targetDutyCycle must be between 0 and 100.'; }

			// Determine timer clock frequency from MCU config
			const sysclk = s.mcuConfig?.clockMHz ?? 168;
			const timerClk = _timerClockMHz(periph, sysclk, s.mcuConfig?.family ?? '');

			return _calculatePrescaler(periph, targetHz, dutyCycle, timerClk);
		},
	};
}


function _fwGPIOAlternateFunctions(session: IFirmwareSessionService): IVoidInternalTool {
	return {
		name: 'fw_gpio_alternate_functions',
		description: 'Look up GPIO alternate function (AF) mappings from the SVD register enumerated values. Given a pin (e.g. "PA9") or peripheral (e.g. "USART1"), returns which AF number routes which peripheral signal to which pin. Eliminates the most common embedded bug: wrong AF number.',
		params: {
			pin: { description: 'GPIO pin in port-number format, e.g. "PA9", "PB6". Returns all AF mappings for this pin.' },
			peripheral: { description: 'Peripheral name, e.g. "USART1", "SPI2". Returns all pins that can carry this peripheral\'s signals.' },
		},
		execute: async (args: Record<string, any>) => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }

			const pin = args.pin as string | undefined;
			const periph = args.peripheral as string | undefined;

			if (!pin && !periph) { return 'Provide pin (e.g. "PA9") or peripheral (e.g. "USART1").'; }

			// Look for GPIO AF registers in the register maps
			const gpioMaps = s.registerMaps?.filter(m => m.name.startsWith('GPIO') || m.groupName === 'GPIO') ?? [];
			const afData = _extractAFData(gpioMaps);

			if (afData.length === 0) {
				return [
					'No GPIO alternate function data found in session register maps.',
					'',
					'Load an SVD file with GPIO AF registers to use this tool:',
					'  fw_upload_datasheet - upload the MCU datasheet or SVD',
					'',
					'STM32 AF table reference: See "GPIO alternate function mapping" table in the datasheet.',
				].join('\n');
			}

			if (pin) {
				const pinUpper = pin.toUpperCase();
				const pinMatch = pinUpper.match(/^P([A-K])(\d+)$/);
				if (!pinMatch) { return `Invalid pin format "${pin}". Use PA9, PB6, PC13, etc.`; }

				const filtered = afData.filter(e => e.port === pinMatch[1] && e.pin === parseInt(pinMatch[2]));
				if (filtered.length === 0) { return `No AF data found for pin ${pinUpper} in loaded SVD.`; }

				const lines = [`Alternate functions for ${pinUpper}:`, ''];
				for (const e of filtered.sort((a, b) => a.af - b.af)) {
					lines.push(`  AF${e.af}: ${e.signal}`);
				}
				return lines.join('\n');
			}

			if (periph) {
				const periphUpper = periph.toUpperCase();
				const filtered = afData.filter(e => e.signal.toUpperCase().startsWith(periphUpper));
				if (filtered.length === 0) { return `No AF data found for peripheral ${periphUpper} in loaded SVD.`; }

				const lines = [`GPIO pins carrying ${periphUpper} signals:`, ''];
				for (const e of filtered.sort((a, b) => a.port.localeCompare(b.port) || a.pin - b.pin)) {
					lines.push(`  P${e.port}${e.pin}  AF${e.af}: ${e.signal}`);
				}
				return lines.join('\n');
			}

			return 'Provide pin or peripheral.';
		},
	};
}


function _fwDMAChannelMap(session: IFirmwareSessionService): IVoidInternalTool {
	return {
		name: 'fw_dma_channel_map',
		description: 'Return the complete DMA channel/stream to peripheral mapping for the current MCU family. Shows which DMA controller, stream, and channel handles each peripheral signal (USART1_TX, SPI2_RX, ADC1, TIM3_CH1, etc.). Eliminates the second most common DMA bug: wrong channel assignment.',
		params: {
			peripheral: { description: 'Filter by peripheral name, e.g. "USART1", "SPI2". Returns all DMA assignments for this peripheral. Omit to see the complete mapping table.' },
		},
		execute: async (args: Record<string, any>) => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }

			const family = s.mcuConfig?.family ?? '';
			const filter = (args.peripheral as string | undefined)?.toUpperCase();

			return _getDMAChannelMap(family, filter);
		},
	};
}


function _fwNVICPriorityGuide(session: IFirmwareSessionService): IVoidInternalTool {
	return {
		name: 'fw_nvic_priority_guide',
		description: 'Get NVIC interrupt priority guidance for a peripheral. Returns the IRQ number from the SVD interrupt table, recommended NVIC_SetPriority call, and RTOS safety notes (whether the priority is safe to call FreeRTOS/Zephyr APIs from the ISR).',
		params: {
			peripheral: { description: 'Peripheral name, e.g. "USART1", "TIM3", "DMA1_Stream0"' },
		},
		execute: async (args: Record<string, any>) => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }

			const periph = (args.peripheral as string | undefined)?.toUpperCase();
			if (!periph) { return 'Provide peripheral name, e.g. "USART1", "TIM3".'; }

			const regMap = s.registerMaps?.find(m =>
				m.name.toUpperCase() === periph || m.groupName?.toUpperCase() === periph
			);

			const interrupts = regMap?.interrupts ?? [];
			const rtos = s.rtos ?? s.projectInfo?.rtos;
			const priorityBits = _nvicPriorityBits(s.mcuConfig?.family ?? '');

			return _generateNVICGuide(periph, interrupts, rtos, priorityBits, s.mcuConfig?.core ?? 'cortex-m4');
		},
	};
}


function _fwGetPinAssignments(session: IFirmwareSessionService): IVoidInternalTool {
	return {
		name: 'fw_get_pin_assignments',
		description: 'Returns the complete peripheral assignment map for the current MCU: every loaded peripheral with its type category (USART/SPI/I2C/TIM/ADC/DMA/GPIO/...), base address, register count, and SVD/datasheet source provenance. Also reports any conflicts where the same peripheral group name appears in more than one SVD file. Mirrors what the Pinout tab shows visually.',
		params: {
			filter: { description: 'Optional: filter by peripheral type category, e.g. "USART", "SPI", "TIM", "GPIO". Case-insensitive prefix match.' },
		},
		execute: async (args: Record<string, any>) => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }
			if (!s.registerMaps || s.registerMaps.length === 0) {
				return 'No register maps loaded. Use fw_upload_datasheet or attach an SVD file to load peripheral data.';
			}

			const filterRaw = (args.filter as string | undefined)?.toLowerCase();

			// Group peripherals by type category
			const TYPE_PATTERNS: Array<[RegExp, string]> = [
				[/^USART|^UART/i,  'USART/UART'],
				[/^SPI/i,          'SPI'],
				[/^I2C/i,          'I2C'],
				[/^I2S/i,          'I2S'],
				[/^TIM/i,          'Timer'],
				[/^ADC/i,          'ADC'],
				[/^DAC/i,          'DAC'],
				[/^DMA/i,          'DMA'],
				[/^USB/i,          'USB'],
				[/^CAN/i,          'CAN'],
				[/^ETH/i,          'Ethernet'],
				[/^SDIO|^SDMMC/i,  'SDIO/SDMMC'],
				[/^GPIO/i,         'GPIO'],
				[/^EXTI/i,         'EXTI'],
				[/^NVIC|^SCB/i,    'Core (NVIC/SCB)'],
				[/^RCC/i,          'RCC (Clocks)'],
				[/^PWR/i,          'Power'],
				[/^FLASH/i,        'Flash'],
				[/^IWDG|^WWDG/i,   'Watchdog'],
				[/^RTC/i,          'RTC'],
				[/^CRC/i,          'CRC'],
				[/^SYSCFG|^AFIO/i, 'SysCfg/AFIO'],
				[/^QSPI|^OCTOSPI/i,'QSPI/OctoSPI'],
				[/^FMC|^FSMC/i,    'FMC/FSMC'],
				[/^DCMI/i,         'Camera (DCMI)'],
				[/^SAI/i,          'SAI (Audio)'],
				[/^FDCAN/i,        'FDCAN'],
				[/^LPTIM/i,        'LP Timer'],
				[/^LPUART/i,       'LP UART'],
			];

			function categorize(name: string): string {
				const upper = name.toUpperCase();
				for (const [pat, label] of TYPE_PATTERNS) {
					if (pat.test(upper)) { return label; }
				}
				return 'Other';
			}

			// Build grouped map: category → peripherals
			const grouped = new Map<string, IPeripheralRegisterMap[]>();
			for (const rm of s.registerMaps) {
				const cat = categorize(rm.groupName || rm.name);
				if (!grouped.has(cat)) { grouped.set(cat, []); }
				grouped.get(cat)!.push(rm);
			}

			// Detect real conflicts: same peripheral NAME from two different SVD sources
			const nameSources = new Map<string, Set<string>>();
			for (const rm of s.registerMaps) {
				const key = rm.name.toUpperCase();
				if (!nameSources.has(key)) { nameSources.set(key, new Set()); }
				if (rm.source) { nameSources.get(key)!.add(rm.source); }
			}
			const conflicts: string[] = [];
			for (const [name, sources] of nameSources) {
				if (sources.size > 1) {
					conflicts.push(`${name}: defined in ${[...sources].join(' and ')} - last-loaded definition wins`);
				}
			}

			const lines: string[] = [];
			lines.push(`# Pin / Peripheral Assignment Map`);
			lines.push(`MCU: ${s.mcuConfig?.family ?? 'Unknown'} ${s.mcuConfig?.variant ?? ''} @ ${s.mcuConfig?.clockMHz ?? '?'} MHz`);
			lines.push(`Total peripherals loaded: ${s.registerMaps.length}`);
			lines.push('');

			// Apply filter
			const categories = [...grouped.keys()].sort();
			for (const cat of categories) {
				if (filterRaw && !cat.toLowerCase().startsWith(filterRaw)) { continue; }
				const periphList = grouped.get(cat)!;
				lines.push(`## ${cat} (${periphList.length})`);
				for (const rm of periphList) {
					const baseHex = `0x${rm.baseAddress.toString(16).toUpperCase().padStart(8, '0')}`;
					const regCount = rm.registers?.length ?? 0;
					const src = rm.source ? ` [source: ${rm.source}]` : '';
					const irqCount = rm.interrupts?.length ?? 0;
					const irqNote = irqCount > 0 ? `, ${irqCount} IRQ${irqCount > 1 ? 's' : ''}` : '';
					lines.push(`  ${rm.name.padEnd(16)} base=${baseHex}  regs=${String(regCount).padStart(3)}${irqNote}${src}`);
				}
				lines.push('');
			}

			if (conflicts.length > 0) {
				lines.push('## [!] Source Conflicts');
				lines.push('The following peripheral groups appear in more than one SVD/datasheet source.');
				lines.push('Last-loaded definition wins. Consider loading only one SVD per MCU family.');
				for (const c of conflicts) { lines.push(`  - ${c}`); }
				lines.push('');
			}

			if (s.mcuConfig) {
				lines.push('## MCU Summary');
				lines.push(`  Core:    ${s.mcuConfig.core}`);
				lines.push(`  Flash:   ${s.mcuConfig.flashSize} KB`);
				lines.push(`  RAM:     ${s.mcuConfig.ramSize} KB`);
				if (s.mcuConfig.fpu)    { lines.push(`  FPU:     yes`); }
				if (s.mcuConfig.hasMPU) { lines.push(`  MPU:     yes`); }
				if (s.mcuConfig.hasDSP) { lines.push(`  DSP:     yes`); }
			}

			return lines.join('\n');
		},
	};
}


function _fwReadConfigFile(session: IFirmwareSessionService, fileService: IFileService): IVoidInternalTool {
	return {
		name: 'fw_read_config_file',
		description: 'Read and parse the project build configuration file. For PlatformIO: platformio.ini sections. For CMake: CMakeCache.txt key values. For ESP-IDF: sdkconfig options. For Zephyr: prj.conf Kconfig values. Lets the agent answer "what\'s my tick rate?" or "is UART DMA enabled?" from the project config.',
		params: {
			key: { description: 'Optional: search for a specific key or value, e.g. "monitor_speed", "CONFIG_FREERTOS_HZ", "UART". Returns all matching entries.' },
		},
		execute: async (args: Record<string, any>) => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }

			const projectType = s.projectInfo?.projectType ?? 'generic';
			const firstConfig = s.projectInfo?.configFiles?.[0];
			const projectRoot = firstConfig
				? firstConfig.path.replace(/\/[^/]+$/, '') // strip filename from IDetectedConfigFile.path
				: undefined;

			if (!projectRoot) {
				return [
					'No project config file path available in session.',
					'Run fw_scan_project first to detect project configuration.',
				].join('\n');
			}

			const key = (args.key as string | undefined)?.toLowerCase();
			return _parseProjectConfig(projectType, projectRoot, key, fileService);
		},
	};
}


// ─── Prescaler calculator ─────────────────────────────────────────────────────

function _calculatePrescaler(
	periph: string,
	targetHz: number,
	dutyCycle: number,
	timerClkMHz: number,
): string {
	const timerClk = timerClkMHz * 1_000_000;

	// Find PSC + ARR that minimizes frequency error
	// f = timerClk / ((PSC+1) * (ARR+1))
	// PSC and ARR are 16-bit for basic timers, 32-bit for TIM2/TIM5

	let bestPsc = 0;
	let bestArr = 0;
	let bestError = Infinity;

	// Try common PSC values that give a "nice" tick rate
	for (let psc = 0; psc <= 65535; psc++) {
		const tickHz = timerClk / (psc + 1);
		const arr = Math.round(tickHz / targetHz) - 1;
		if (arr < 0 || arr > 65535) { continue; }
		const actual = tickHz / (arr + 1);
		const error = Math.abs(actual - targetHz) / targetHz;
		if (error < bestError) {
			bestError = error;
			bestPsc = psc;
			bestArr = arr;
		}
		if (error < 0.0001) { break; } // good enough
	}

	const tickHz = timerClk / (bestPsc + 1);
	const actualHz = tickHz / (bestArr + 1);
	const ccr = Math.round((bestArr + 1) * (dutyCycle / 100)) - 1;
	const actualDuty = ((ccr + 1) / (bestArr + 1)) * 100;

	const lines = [
		`Timer Prescaler Calculation: ${periph}`,
		`  Timer clock:   ${timerClkMHz} MHz`,
		`  Target freq:   ${targetHz} Hz`,
		`  Target duty:   ${dutyCycle}%`,
		'',
		`Results:`,
		`  PSC = ${bestPsc}   -> tick rate: ${(tickHz / 1000).toFixed(1)} kHz`,
		`  ARR = ${bestArr}   -> output: ${actualHz.toFixed(4)} Hz (error: ${(bestError * 100).toFixed(4)}%)`,
		`  CCR = ${ccr}   -> duty: ${actualDuty.toFixed(2)}%`,
		'',
		`/* Ready-to-paste C defines */`,
		`#define ${periph}_PSC  ${bestPsc}U  /* ${timerClkMHz}MHz / (${bestPsc}+1) = ${(tickHz / 1000).toFixed(0)} kHz tick */`,
		`#define ${periph}_ARR  ${bestArr}U  /* ${(tickHz / 1000).toFixed(0)} kHz / (${bestArr}+1) = ${actualHz.toFixed(2)} Hz output */`,
		`#define ${periph}_CCR  ${ccr}U  /* ${actualDuty.toFixed(1)}% duty cycle */`,
		'',
		`/* Apply in init function: */`,
		`/* ${periph}->PSC = ${periph}_PSC; */`,
		`/* ${periph}->ARR = ${periph}_ARR; */`,
		`/* ${periph}->CCR1 = ${periph}_CCR; /* or CCR2/CCR3/CCR4 for other channels */`,
	];

	if (bestError > 0.01) {
		lines.push('', `[!] Frequency error ${(bestError * 100).toFixed(2)}% - consider using a different source clock or fractional prescaler (if available).`);
	}

	return lines.join('\n');
}


function _timerClockMHz(periph: string, sysclkMHz: number, family: string): number {
	// STM32: APB1 timers (TIM2-7, TIM12-14) get APB1*2 when APB1 prescaler != 1
	// APB2 timers (TIM1, TIM8-11) get APB2*2 when APB2 prescaler != 1
	// Default config: SYSCLK/4 APB1, SYSCLK/2 APB2 → timer clocks = SYSCLK
	return sysclkMHz; // simplified: assume timer clock = SYSCLK
}


// ─── GPIO AF data extractor ───────────────────────────────────────────────────

interface AFEntry { port: string; pin: number; af: number; signal: string }

function _extractAFData(gpioMaps: IPeripheralRegisterMap[]): AFEntry[] {
	const entries: AFEntry[] = [];

	for (const gmap of gpioMaps) {
		const portMatch = gmap.name.match(/GPIO([A-K])/);
		if (!portMatch) { continue; }
		const port = portMatch[1];

		// Find AFRL and AFRH registers
		for (const reg of gmap.registers) {
			if (!reg.name.match(/^AFR[LH]$/i)) { continue; }
			const isHigh = reg.name.toUpperCase() === 'AFRH';
			const pinOffset = isHigh ? 8 : 0;

			if (!reg.fields) { continue; }

			for (const field of reg.fields) {
				// Field names like AFR0, AFR1, ..., AFR7 or AFRL0, AFRL1
				const fieldPinMatch = field.name.match(/(\d+)$/);
				if (!fieldPinMatch) { continue; }
				const pinNum = parseInt(fieldPinMatch[1]) + pinOffset;

				// Enumerated values: Record<number, string> — afNumber → signalName
				if (field.enumeratedValues) {
					for (const [afStr, signal] of Object.entries(field.enumeratedValues)) {
						entries.push({ port, pin: pinNum, af: parseInt(afStr, 10), signal });
					}
				} else {
					// No enumerated values — just record that this pin has AF capability
					for (let af = 0; af <= 15; af++) {
						entries.push({ port, pin: pinNum, af, signal: `AF${af}` });
					}
				}
			}
		}
	}

	return entries;
}


// ─── DMA channel map ─────────────────────────────────────────────────────────

function _getDMAChannelMap(family: string, filter: string | undefined): string {
	const fam = family.toUpperCase();

	// STM32F4/F7: DMA streams with channel selection
	if (fam.startsWith('STM32F4') || fam.startsWith('STM32F7') || fam.startsWith('STM32H7')) {
		const table = STM32F4_DMA_TABLE;
		return _formatDMATable(table, filter, 'DMA (STM32F4/F7/H7 - streams with channel selection)');
	}

	// STM32G4/L4
	if (fam.startsWith('STM32G4') || fam.startsWith('STM32L4') || fam.startsWith('STM32G0')) {
		const table = STM32G4_DMA_TABLE;
		return _formatDMATable(table, filter, 'DMA (STM32G4/L4/G0 - DMAMUX channel routing)');
	}

	// STM32F1/F0/F3
	if (fam.startsWith('STM32F0') || fam.startsWith('STM32F1') || fam.startsWith('STM32F3')) {
		const table = STM32F1_DMA_TABLE;
		return _formatDMATable(table, filter, 'DMA (STM32F0/F1/F3 - fixed channel routing)');
	}

	// nRF52
	if (fam.startsWith('NRF52')) {
		return [
			'nRF52 uses EasyDMA - each peripheral has its own DMA built in.',
			'No separate DMA controller. Configure MAXCNT/PTR registers in the peripheral.',
			'Peripherals with EasyDMA: UART, SPIM, TWIM, SAADC, PDM, I2S, QSPI.',
		].join('\n');
	}

	// RP2040
	if (fam.startsWith('RP2040') || fam.startsWith('RP2350')) {
		return [
			'RP2040/RP2350 has 12 DMA channels, all freely assignable to any peripheral.',
			'',
			'Configure with dma_channel_set_config() + dreq from DREQ_* constants:',
			'  DREQ_UART0_TX=20, DREQ_UART0_RX=21',
			'  DREQ_UART1_TX=22, DREQ_UART1_RX=23',
			'  DREQ_SPI0_TX=16,  DREQ_SPI0_RX=17',
			'  DREQ_SPI1_TX=18,  DREQ_SPI1_RX=19',
			'  DREQ_I2C0_TX=32,  DREQ_I2C0_RX=33',
			'  DREQ_ADC=36',
			'  DREQ_PIO0_TX0=0..DREQ_PIO0_TX3=3',
			'  DREQ_PIO0_RX0=4..DREQ_PIO0_RX3=7',
		].join('\n');
	}

	return `DMA mapping table not available for MCU family "${family}". Load a datasheet with fw_upload_datasheet for full register-level data.`;
}

function _formatDMATable(
	table: Array<{ dma: number; stream: number; channel: number; signal: string }>,
	filter: string | undefined,
	header: string,
): string {
	const rows = filter
		? table.filter(r => r.signal.toUpperCase().includes(filter))
		: table;

	if (rows.length === 0) { return `No DMA assignment found for "${filter}".`; }

	const lines = [`${header}:`, '', `${'DMA'.padEnd(5)} ${'Stream/Ch'.padEnd(10)} Signal`];
	for (const r of rows) {
		lines.push(`  DMA${r.dma}  Stream/Ch ${r.stream}, Ch ${r.channel}  ${r.signal}`);
	}
	return lines.join('\n');
}


// ─── NVIC priority guide ──────────────────────────────────────────────────────

function _generateNVICGuide(
	periph: string,
	interrupts: Array<{ name: string; value: number; description?: string }>,
	rtos: string | undefined,
	priorityBits: number,
	core: string,
): string {
	const maxPriority = (1 << priorityBits) - 1;
	const lines: string[] = [`NVIC Priority Guide: ${periph}`, ''];

	if (interrupts.length === 0) {
		lines.push(`No interrupt data found for ${periph} in session register maps.`);
		lines.push('Load an SVD file with interrupt definitions via fw_upload_datasheet.');
		return lines.join('\n');
	}

	for (const irq of interrupts) {
		lines.push(`  ${irq.name.padEnd(30)} IRQn = ${irq.value}${irq.description ? `  (${irq.description})` : ''}`);
	}

	lines.push('');
	lines.push(`Priority configuration (${priorityBits}-bit NVIC, levels 0-${maxPriority}):`);
	lines.push(`  0 = highest priority (non-maskable from basepri)`);
	lines.push(`  ${maxPriority} = lowest priority`);

	const irq = interrupts[0];
	const recommendedPriority = Math.min(8, maxPriority);

	lines.push('');
	lines.push(`Recommended setup:`);
	lines.push(`  NVIC_SetPriority(${irq.name}, ${recommendedPriority}U);`);
	lines.push(`  NVIC_EnableIRQ(${irq.name});`);

	if (rtos) {
		const isFreertos = rtos.toLowerCase().includes('freertos') || rtos.toLowerCase().includes('free_rtos');
		const isZephyr = rtos.toLowerCase().includes('zephyr');

		lines.push('');
		if (isFreertos) {
			lines.push(`FreeRTOS safety (detected: ${rtos}):`);
			lines.push(`  configMAX_SYSCALL_INTERRUPT_PRIORITY is typically set to 5 (priority level 5).`);
			lines.push(`  ISRs with priority <= configMAX_SYSCALL_INTERRUPT_PRIORITY CAN call FromISR() APIs.`);
			lines.push(`  ISRs with priority > configMAX_SYSCALL_INTERRUPT_PRIORITY CANNOT call FreeRTOS APIs.`);
			lines.push(`  Recommended: use priority ${recommendedPriority} (safe for xQueueSendFromISR, xSemaphoreGiveFromISR).`);
			lines.push(`  Never call vTaskDelay() or non-FromISR APIs from an ISR.`);
		} else if (isZephyr) {
			lines.push(`Zephyr safety (detected: ${rtos}):`);
			lines.push(`  Zephyr uses IRQ priority levels - lower number = higher priority.`);
			lines.push(`  Use IRQ_CONNECT() macro or DT_IRQ() for devicetree-driven IRQ config.`);
			lines.push(`  ISR-safe Zephyr APIs: k_sem_give(), k_msgq_put(), k_fifo_put_isr().`);
		}
	} else {
		lines.push('');
		lines.push('No RTOS detected. Use standard NVIC_SetPriority / NVIC_EnableIRQ.');
	}

	lines.push('');
	lines.push(`Cortex-${core.replace('cortex-', '').toUpperCase()} notes:`);
	lines.push(`  Priority grouping: NVIC_SetPriorityGrouping(0U) uses all bits for preemption.`);
	lines.push(`  basepri register: masks IRQs with priority >= basepri value.`);
	lines.push(`  NMI and HardFault cannot be masked.`);

	return lines.join('\n');
}

function _nvicPriorityBits(family: string): number {
	const fam = family.toUpperCase();
	if (fam.startsWith('STM32')) { return 4; } // all STM32 use 4-bit NVIC priority
	if (fam.startsWith('NRF52')) { return 3; }
	if (fam.startsWith('RP2040')) { return 3; }
	if (fam.startsWith('ESP32')) { return 5; }
	return 4; // Cortex-M default
}


// ─── Config file parser ───────────────────────────────────────────────────────

async function _parseProjectConfig(
	projectType: string,
	projectRoot: string,
	key: string | undefined,
	fileService: IFileService,
): Promise<string> {
	const configCandidates: Array<{ name: string; path: string; parser: (content: string, key?: string) => string }> = [
		{
			name: 'platformio.ini',
			path: `${projectRoot}/platformio.ini`,
			parser: _parsePlatformIOConfig,
		},
		{
			name: 'CMakeCache.txt',
			path: `${projectRoot}/build/CMakeCache.txt`,
			parser: _parseCMakeCache,
		},
		{
			name: 'sdkconfig',
			path: `${projectRoot}/sdkconfig`,
			parser: _parseSDKConfig,
		},
		{
			name: 'prj.conf',
			path: `${projectRoot}/prj.conf`,
			parser: _parseKconfig,
		},
	];

	// Try project-type-specific file first
	const preferred: Record<string, string> = {
		platformio: 'platformio.ini',
		'esp-idf': 'sdkconfig',
		zephyr: 'prj.conf',
		'cmake-embedded': 'CMakeCache.txt',
	};

	const preferredName = preferred[projectType];
	const ordered = preferredName
		? [
			...configCandidates.filter(c => c.name === preferredName),
			...configCandidates.filter(c => c.name !== preferredName),
		]
		: configCandidates;

	for (const candidate of ordered) {
		try {
			const raw = await fileService.readFile(URI.file(candidate.path));
			const content = raw.value.toString();
			return `${candidate.name}:\n\n${candidate.parser(content, key)}`;
		} catch { /* file not found, try next */ }
	}

	return [
		`No config file found in ${projectRoot}.`,
		'',
		'Expected locations:',
		'  PlatformIO:  platformio.ini',
		'  CMake:       build/CMakeCache.txt (run cmake first)',
		'  ESP-IDF:     sdkconfig (run idf.py menuconfig or idf.py build first)',
		'  Zephyr:      prj.conf',
	].join('\n');
}

function _parsePlatformIOConfig(content: string, key?: string): string {
	const lines = content.split('\n');
	const sections: Map<string, Array<[string, string]>> = new Map();
	let currentSection = '';

	for (const line of lines) {
		const sec = line.match(/^\[(.+?)\]/);
		if (sec) { currentSection = sec[1]; sections.set(currentSection, []); continue; }
		const kv = line.match(/^(\w[\w_]*)\s*=\s*(.+?)(?:\s*;.*)?$/);
		if (kv && currentSection) {
			sections.get(currentSection)!.push([kv[1].trim(), kv[2].trim()]);
		}
	}

	const out: string[] = [];
	for (const [section, entries] of sections) {
		const filtered = key ? entries.filter(([k, v]) => k.toLowerCase().includes(key) || v.toLowerCase().includes(key)) : entries;
		if (filtered.length === 0) { continue; }
		out.push(`[${section}]`);
		for (const [k, v] of filtered) { out.push(`  ${k} = ${v}`); }
		out.push('');
	}

	return out.length > 0 ? out.join('\n') : `No matching entries found${key ? ` for "${key}"` : ''}.`;
}

function _parseCMakeCache(content: string, key?: string): string {
	const entries: string[] = [];
	for (const line of content.split('\n')) {
		if (line.startsWith('//') || line.startsWith('#') || !line.includes('=')) { continue; }
		const m = line.match(/^([A-Z_0-9]+(?::[A-Z]+)?)\s*=\s*(.*)$/);
		if (!m) { continue; }
		const k = m[1]; const v = m[2];
		if (key && !k.toLowerCase().includes(key) && !v.toLowerCase().includes(key)) { continue; }
		// Skip internal/uninteresting cmake keys
		if (k.match(/^CMAKE_(INSTALL|BINARY|SOURCE|GENERATOR|MAKE_PROGRAM|INSTALL_PREFIX|CTEST|EXTRA_SHARED|AR |RANLIB|LINKER|SYSTEM|HOST|FIND|BUILD_RPATH)/) && !key) { continue; }
		entries.push(`  ${k} = ${v}`);
	}
	if (entries.length === 0) { return `No matching entries${key ? ` for "${key}"` : ''}.`; }
	return entries.slice(0, 40).join('\n') + (entries.length > 40 ? `\n  ... and ${entries.length - 40} more` : '');
}

function _parseSDKConfig(content: string, key?: string): string {
	const entries: string[] = [];
	for (const line of content.split('\n')) {
		if (line.startsWith('#') && !line.includes('CONFIG_')) { continue; }
		if (!line.includes('CONFIG_')) { continue; }
		const commented = line.startsWith('#');
		const kv = line.replace(/^#\s*/, '').match(/^(CONFIG_\w+)\s*=\s*(.*)$/);
		if (!kv) { continue; }
		const k = kv[1]; const v = kv[2];
		if (key && !k.toLowerCase().includes(key) && !v.toLowerCase().includes(key)) { continue; }
		entries.push(`  ${commented ? '# ' : ''}${k} = ${v}`);
	}
	if (entries.length === 0) { return `No matching sdkconfig entries${key ? ` for "${key}"` : ''}.`; }
	return entries.slice(0, 60).join('\n') + (entries.length > 60 ? `\n  ... and ${entries.length - 60} more` : '');
}

function _parseKconfig(content: string, key?: string): string {
	const entries: string[] = [];
	for (const line of content.split('\n')) {
		const kv = line.match(/^(CONFIG_\w+)\s*=\s*(.+)$/);
		if (!kv) { continue; }
		const k = kv[1]; const v = kv[2];
		if (key && !k.toLowerCase().includes(key) && !v.toLowerCase().includes(key)) { continue; }
		entries.push(`  ${k} = ${v}`);
	}
	if (entries.length === 0) { return `No matching prj.conf entries${key ? ` for "${key}"` : ''}.`; }
	return entries.join('\n');
}


// ─── DMA lookup tables ────────────────────────────────────────────────────────

const STM32F4_DMA_TABLE: Array<{ dma: number; stream: number; channel: number; signal: string }> = [
	// DMA1
	{ dma: 1, stream: 0, channel: 0, signal: 'SPI3_RX / I2S3_RX' },
	{ dma: 1, stream: 0, channel: 2, signal: 'I2C1_RX' },
	{ dma: 1, stream: 0, channel: 3, signal: 'TIM4_CH1' },
	{ dma: 1, stream: 0, channel: 4, signal: 'I2S3_RX' },
	{ dma: 1, stream: 0, channel: 6, signal: 'TIM5_CH3 / TIM5_UP' },
	{ dma: 1, stream: 1, channel: 0, signal: 'SPI3_RX / I2S3_RX' },
	{ dma: 1, stream: 1, channel: 3, signal: 'TIM2_UP / TIM2_CH3' },
	{ dma: 1, stream: 1, channel: 4, signal: 'USART3_RX' },
	{ dma: 1, stream: 1, channel: 5, signal: 'TIM7_UP' },
	{ dma: 1, stream: 1, channel: 6, signal: 'TIM5_CH4 / TIM5_TRIG' },
	{ dma: 1, stream: 1, channel: 7, signal: 'TIM6_UP' },
	{ dma: 1, stream: 2, channel: 0, signal: 'SPI3_RX / I2S3_RX' },
	{ dma: 1, stream: 2, channel: 2, signal: 'I2C3_RX' },
	{ dma: 1, stream: 2, channel: 3, signal: 'TIM4_CH2' },
	{ dma: 1, stream: 2, channel: 4, signal: 'I2S2_RX / SPI2_RX' },
	{ dma: 1, stream: 2, channel: 6, signal: 'TIM5_CH1' },
	{ dma: 1, stream: 2, channel: 7, signal: 'I2C2_RX' },
	{ dma: 1, stream: 3, channel: 0, signal: 'SPI2_RX / I2S2_RX' },
	{ dma: 1, stream: 3, channel: 2, signal: 'TIM4_CH3' },
	{ dma: 1, stream: 3, channel: 3, signal: 'USART3_TX' },
	{ dma: 1, stream: 3, channel: 4, signal: 'I2S2_TX / SPI2_TX' },
	{ dma: 1, stream: 3, channel: 5, signal: 'TIM2_CH1' },
	{ dma: 1, stream: 3, channel: 7, signal: 'TIM5_CH4 / TIM5_TRIG' },
	{ dma: 1, stream: 4, channel: 2, signal: 'USART3_TX' },
	{ dma: 1, stream: 4, channel: 3, signal: 'TIM4_UP' },
	{ dma: 1, stream: 4, channel: 5, signal: 'TIM2_CH2 / TIM2_CH4' },
	{ dma: 1, stream: 4, channel: 6, signal: 'USART3_TX' },
	{ dma: 1, stream: 4, channel: 7, signal: 'TIM7_UP' },
	{ dma: 1, stream: 5, channel: 0, signal: 'SPI3_TX / I2S3_TX' },
	{ dma: 1, stream: 5, channel: 2, signal: 'I2C1_RX' },
	{ dma: 1, stream: 5, channel: 3, signal: 'TIM2_CH1' },
	{ dma: 1, stream: 5, channel: 4, signal: 'USART2_RX' },
	{ dma: 1, stream: 5, channel: 5, signal: 'TIM3_CH2' },
	{ dma: 1, stream: 5, channel: 6, signal: 'DAC1' },
	{ dma: 1, stream: 5, channel: 7, signal: 'TIM5_CH2' },
	{ dma: 1, stream: 6, channel: 1, signal: 'TIM4_TRIG' },
	{ dma: 1, stream: 6, channel: 2, signal: 'I2C1_TX' },
	{ dma: 1, stream: 6, channel: 3, signal: 'USART2_TX' },
	{ dma: 1, stream: 6, channel: 4, signal: 'I2S3_TX / SPI3_TX' },
	{ dma: 1, stream: 6, channel: 5, signal: 'TIM3_CH1 / TIM3_TRIG' },
	{ dma: 1, stream: 6, channel: 6, signal: 'DAC2' },
	{ dma: 1, stream: 6, channel: 7, signal: 'TIM5_UP' },
	{ dma: 1, stream: 7, channel: 0, signal: 'SPI3_TX / I2S3_TX' },
	{ dma: 1, stream: 7, channel: 1, signal: 'TIM4_CH3' },
	{ dma: 1, stream: 7, channel: 2, signal: 'I2C1_TX' },
	{ dma: 1, stream: 7, channel: 3, signal: 'TIM2_CH4 / TIM2_UP' },
	{ dma: 1, stream: 7, channel: 4, signal: 'I2S3_TX' },
	{ dma: 1, stream: 7, channel: 5, signal: 'TIM3_CH3' },
	{ dma: 1, stream: 7, channel: 7, signal: 'I2C2_TX' },
	// DMA2
	{ dma: 2, stream: 0, channel: 0, signal: 'ADC1' },
	{ dma: 2, stream: 0, channel: 3, signal: 'SPI1_RX' },
	{ dma: 2, stream: 0, channel: 4, signal: 'SPI4_RX' },
	{ dma: 2, stream: 1, channel: 4, signal: 'USART6_RX' },
	{ dma: 2, stream: 1, channel: 5, signal: 'USART3_RX (remapped)' },
	{ dma: 2, stream: 2, channel: 3, signal: 'SPI1_RX' },
	{ dma: 2, stream: 2, channel: 4, signal: 'USART1_RX' },
	{ dma: 2, stream: 2, channel: 5, signal: 'USART6_RX' },
	{ dma: 2, stream: 3, channel: 3, signal: 'SPI1_TX' },
	{ dma: 2, stream: 3, channel: 4, signal: 'SDIO' },
	{ dma: 2, stream: 3, channel: 5, signal: 'SPI4_RX' },
	{ dma: 2, stream: 4, channel: 0, signal: 'ADC1' },
	{ dma: 2, stream: 4, channel: 5, signal: 'USART1_TX (alt)' },
	{ dma: 2, stream: 5, channel: 4, signal: 'SPI4_TX' },
	{ dma: 2, stream: 5, channel: 5, signal: 'SPI5_TX' },
	{ dma: 2, stream: 6, channel: 4, signal: 'SDIO' },
	{ dma: 2, stream: 6, channel: 5, signal: 'USART6_TX' },
	{ dma: 2, stream: 7, channel: 4, signal: 'USART1_TX' },
	{ dma: 2, stream: 7, channel: 5, signal: 'USART6_TX' },
];

const STM32F1_DMA_TABLE: Array<{ dma: number; stream: number; channel: number; signal: string }> = [
	{ dma: 1, stream: 1, channel: 1, signal: 'ADC1' },
	{ dma: 1, stream: 2, channel: 1, signal: 'USART3_TX' },
	{ dma: 1, stream: 3, channel: 1, signal: 'USART3_RX' },
	{ dma: 1, stream: 4, channel: 1, signal: 'USART1_TX' },
	{ dma: 1, stream: 5, channel: 1, signal: 'USART1_RX' },
	{ dma: 1, stream: 6, channel: 1, signal: 'USART2_RX' },
	{ dma: 1, stream: 7, channel: 1, signal: 'USART2_TX' },
	{ dma: 1, stream: 2, channel: 2, signal: 'SPI1_RX' },
	{ dma: 1, stream: 3, channel: 2, signal: 'SPI1_TX' },
	{ dma: 1, stream: 4, channel: 2, signal: 'SPI2_RX / I2S2_RX' },
	{ dma: 1, stream: 5, channel: 2, signal: 'SPI2_TX / I2S2_TX' },
	{ dma: 1, stream: 6, channel: 2, signal: 'I2C1_TX' },
	{ dma: 1, stream: 7, channel: 2, signal: 'I2C1_RX' },
	{ dma: 1, stream: 2, channel: 3, signal: 'TIM1_CH1' },
	{ dma: 1, stream: 3, channel: 3, signal: 'TIM1_CH2' },
	{ dma: 1, stream: 4, channel: 3, signal: 'TIM1_TX/COM' },
	{ dma: 1, stream: 5, channel: 3, signal: 'TIM1_UP' },
	{ dma: 1, stream: 6, channel: 3, signal: 'TIM1_CH3' },
	{ dma: 2, stream: 1, channel: 1, signal: 'SPI3_RX / I2S3_RX' },
	{ dma: 2, stream: 2, channel: 1, signal: 'SPI3_TX / I2S3_TX' },
	{ dma: 2, stream: 3, channel: 1, signal: 'UART4_RX' },
	{ dma: 2, stream: 4, channel: 1, signal: 'SDIO' },
	{ dma: 2, stream: 5, channel: 1, signal: 'UART4_TX' },
	{ dma: 2, stream: 1, channel: 2, signal: 'TIM5_CH4 / TIM5_TRIG' },
	{ dma: 2, stream: 2, channel: 2, signal: 'TIM5_CH3 / TIM5_UP' },
	{ dma: 2, stream: 4, channel: 2, signal: 'TIM5_CH2' },
	{ dma: 2, stream: 5, channel: 2, signal: 'TIM5_CH1' },
];

const STM32G4_DMA_TABLE: Array<{ dma: number; stream: number; channel: number; signal: string }> = [
	// STM32G4 uses DMAMUX — channels freely assignable but these are common defaults
	{ dma: 1, stream: 1, channel: 11, signal: 'USART1_RX' },
	{ dma: 1, stream: 2, channel: 12, signal: 'USART1_TX' },
	{ dma: 1, stream: 3, channel: 13, signal: 'USART2_RX' },
	{ dma: 1, stream: 4, channel: 14, signal: 'USART2_TX' },
	{ dma: 1, stream: 5, channel: 10, signal: 'SPI1_RX' },
	{ dma: 1, stream: 6, channel: 11, signal: 'SPI1_TX' },
	{ dma: 1, stream: 7, channel: 12, signal: 'SPI2_RX' },
	{ dma: 2, stream: 1, channel: 13, signal: 'SPI2_TX' },
	{ dma: 1, stream: 1, channel: 5,  signal: 'ADC1' },
	{ dma: 2, stream: 1, channel: 36, signal: 'ADC2' },
	{ dma: 1, stream: 1, channel: 20, signal: 'I2C1_RX' },
	{ dma: 1, stream: 2, channel: 21, signal: 'I2C1_TX' },
];
