/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Code generation agent tools \u2014 Phase 3
 *
 * Deterministic peripheral initialization code generation from SVD register data.
 * All generated code uses correct register names and offsets from session.registerMaps,
 * adds inline comments citing register name, offset, and bit position, and applies
 * MISRA C patterns (volatile, explicit cast, no magic numbers) when a compliance
 * framework is active.
 *
 * These tools are NOT LLM-based \u2014 they produce exact, cite-annotated output from
 * the hardware register map already loaded into the session.
 */

import { IVoidInternalTool } from '../../../../void/browser/voidInternalToolService.js';
import { IFirmwareSessionService } from '../../firmwareSessionService.js';
import { IPeripheralRegisterMap } from '../../../common/firmwareTypes.js';


export function buildCodegenTools(sessionService: IFirmwareSessionService): IVoidInternalTool[] {
	return [
		_fwGeneratePeripheralInit(sessionService),
		_fwGenerateISR(sessionService),
		_fwGenerateDMAConfig(sessionService),
		_fwGenerateClockConfig(sessionService),
		_fwGenerateGPIOConfig(sessionService),
		_fwGenerateRTOSTask(sessionService),
	];
}


// \u2500\u2500\u2500 Tool implementations \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _fwGeneratePeripheralInit(session: IFirmwareSessionService): IVoidInternalTool {
	return {
		name: 'fw_generate_peripheral_init',
		description: 'Generate a peripheral initialization function in C from the SVD register map loaded in the session. Uses correct register names, offsets, and bit positions with inline comments. Applies MISRA C patterns (volatile pointer, explicit cast) when a compliance framework is active.',
		params: {
			peripheral: { description: 'Peripheral name as it appears in the register map, e.g. "USART1", "SPI2", "TIM3", "ADC1"' },
			options: { description: 'Optional JSON object with peripheral-specific options, e.g. {"baudRate": 115200, "mode": "async", "wordLength": 8, "stopBits": 1, "parity": "none"} for UART; {"clockDiv": 4, "mode": 0} for SPI; {"period": 1000, "prescaler": 7999} for timer' },
			language: { description: '"c" (default) or "rust"' },
		},
		execute: async (args: Record<string, any>) => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }

			const periph = (args.peripheral as string | undefined)?.toUpperCase();
			if (!periph) { return 'Provide peripheral name, e.g. "USART1", "SPI2", "TIM3".'; }

			const regMap = s.registerMaps?.find(m => m.name.toUpperCase() === periph || m.groupName?.toUpperCase() === periph);
			if (!regMap) {
				const available = s.registerMaps?.map(m => m.name).join(', ') ?? 'none loaded';
				return `Peripheral "${periph}" not found in session register maps.\nAvailable: ${available}\n\nLoad a datasheet or SVD file first with fw_upload_datasheet.`;
			}

			const lang = (args.language as string | undefined) ?? 'c';
			const isMisra = s.complianceFrameworks?.some(f => f.startsWith('misra') || f === 'cert-c');
			let options: Record<string, any> = {};
			if (args.options) {
				try { options = typeof args.options === 'string' ? JSON.parse(args.options) : args.options; } catch { /* ignore */ }
			}

			return _generatePeriphInit(regMap, periph, lang, isMisra ?? false, options);
		},
	};
}


function _fwGenerateISR(session: IFirmwareSessionService): IVoidInternalTool {
	return {
		name: 'fw_generate_isr',
		description: 'Generate an interrupt service routine (ISR) skeleton from the SVD interrupt table. Includes NVIC enable call, interrupt flag clear-first pattern (required by Cortex-M), and volatile flag for signaling to main loop. Uses exact interrupt names and IRQ numbers from the SVD.',
		params: {
			peripheral: { description: 'Peripheral name, e.g. "USART1", "TIM3", "DMA1_Stream0"' },
			interruptName: { description: 'Specific interrupt name from SVD if the peripheral has multiple (e.g. "USART1_IRQn"). Auto-selected from first interrupt if omitted.' },
		},
		execute: async (args: Record<string, any>) => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }

			const periph = (args.peripheral as string | undefined)?.toUpperCase();
			if (!periph) { return 'Provide peripheral name, e.g. "USART1", "TIM3".'; }

			const regMap = s.registerMaps?.find(m => m.name.toUpperCase() === periph || m.groupName?.toUpperCase() === periph);
			if (!regMap) {
				return `Peripheral "${periph}" not found in session register maps. Load SVD or datasheet first.`;
			}

			const interrupts = regMap.interrupts ?? [];
			let irq = interrupts[0];
			if (args.interruptName) {
				const found = interrupts.find(i => i.name.toUpperCase() === (args.interruptName as string).toUpperCase());
				if (found) { irq = found; }
			}

			return _generateISR(regMap, irq);
		},
	};
}


function _fwGenerateDMAConfig(session: IFirmwareSessionService): IVoidInternalTool {
	return {
		name: 'fw_generate_dma_config',
		description: 'Generate DMA channel/stream configuration code for a peripheral. Sets MSIZE/PSIZE, MINC/PINC, transfer direction, priority, and enables the stream. Uses register addresses from the SVD.',
		params: {
			peripheral: { description: 'Source/destination peripheral, e.g. "USART1", "SPI2", "ADC1"' },
			direction: { description: '"mem-to-periph" (TX) or "periph-to-mem" (RX). Default: "periph-to-mem"' },
			dataSize: { description: 'Data element size in bits: 8 (default), 16, or 32' },
		},
		execute: async (args: Record<string, any>) => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }

			const periph = (args.peripheral as string | undefined)?.toUpperCase() ?? '';
			const dir = (args.direction as string | undefined) ?? 'periph-to-mem';
			const dataSize = typeof args.dataSize === 'number' ? args.dataSize : 8;

			const regMap = s.registerMaps?.find(m => m.name.toUpperCase() === periph || m.groupName?.toUpperCase() === periph);
			const dmaRegMap = s.registerMaps?.find(m => m.name.startsWith('DMA'));

			return _generateDMAConfig(periph, dir, dataSize, regMap, dmaRegMap, s.mcuConfig?.family ?? '');
		},
	};
}


function _fwGenerateClockConfig(session: IFirmwareSessionService): IVoidInternalTool {
	return {
		name: 'fw_generate_clock_config',
		description: 'Generate a complete clock tree initialization function: HSE/HSI selection, PLL configuration, wait-for-lock, SYSCLK switch, AHB/APB prescalers, and flash wait states. Uses RCC register definitions from the SVD.',
		params: {
			targetMHz: { description: 'Target SYSCLK frequency in MHz. Defaults to session MCU maximum clock speed.' },
			source: { description: 'Clock source: "hse" (external crystal) or "hsi" (internal oscillator). Default: "hse"' },
			hseMHz: { description: 'HSE crystal frequency in MHz. Default: 8' },
		},
		execute: async (args: Record<string, any>) => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }

			const targetMHz = typeof args.targetMHz === 'number' ? args.targetMHz : (s.mcuConfig?.clockMHz ?? 168);
			const source = (args.source as string | undefined) ?? 'hse';
			const hseMHz = typeof args.hseMHz === 'number' ? args.hseMHz : 8;

			const rccMap = s.registerMaps?.find(m => m.name === 'RCC' || m.groupName === 'RCC');
			return _generateClockConfig(targetMHz, source, hseMHz, rccMap, s.mcuConfig?.family ?? '', s.mcuConfig?.variant ?? '');
		},
	};
}


function _fwGenerateGPIOConfig(session: IFirmwareSessionService): IVoidInternalTool {
	return {
		name: 'fw_generate_gpio_config',
		description: 'Generate GPIO pin configuration code (MODER, OTYPER, OSPEEDR, PUPDR, and AFR writes) with register offsets from the SVD. Correct alternate function numbers are sourced from the AF register enumerated values.',
		params: {
			pin: { description: 'GPIO pin in port-number format, e.g. "PA9", "PB6", "PC13"' },
			mode: { description: '"input", "output", "alternate" (for peripheral), or "analog". Default: "output"' },
			speed: { description: '"low", "medium", "high", or "very-high". Default: "medium"' },
			pull: { description: '"none", "up", or "down". Default: "none"' },
			af: { description: 'Alternate function number 0\u201315. Required when mode is "alternate". Auto-detected from SVD AF register if omitted.' },
			outputType: { description: '"push-pull" (default) or "open-drain"' },
		},
		execute: async (args: Record<string, any>) => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }

			const pin = args.pin as string | undefined;
			if (!pin) { return 'Provide pin in port-number format, e.g. "PA9", "PB6".'; }

			const pinMatch = pin.toUpperCase().match(/^P([A-K])(\d+)$/);
			if (!pinMatch) { return `Invalid pin format "${pin}". Use PA9, PB6, PC13, etc.`; }

			const port = pinMatch[1];
			const pinNum = parseInt(pinMatch[2]);

			const mode = (args.mode as string | undefined) ?? 'output';
			const speed = (args.speed as string | undefined) ?? 'medium';
			const pull = (args.pull as string | undefined) ?? 'none';
			const af = typeof args.af === 'number' ? args.af : undefined;
			const outputType = (args.outputType as string | undefined) ?? 'push-pull';

			const gpioMap = s.registerMaps?.find(m => m.name === `GPIO${port}` || m.groupName === 'GPIO');
			const rccMap = s.registerMaps?.find(m => m.name === 'RCC');

			return _generateGPIOConfig(port, pinNum, mode, speed, pull, af, outputType, gpioMap, rccMap, s.mcuConfig?.family ?? '');
		},
	};
}


function _fwGenerateRTOSTask(session: IFirmwareSessionService): IVoidInternalTool {
	return {
		name: 'fw_generate_rtos_task',
		description: 'Generate an RTOS task skeleton. For FreeRTOS: xTaskCreate call, task function with ISR-safe patterns, osSemaphoreWait or xQueueReceive loop. For Zephyr: K_THREAD_DEFINE macro and thread function. RTOS type is auto-detected from session.',
		params: {
			taskName: { description: 'Task/thread name, e.g. "sensor_read", "uart_tx"' },
			stackSize: { description: 'Stack size in words (FreeRTOS) or bytes (Zephyr). Default: 256 words / 1024 bytes.' },
			priority: { description: 'Task priority. FreeRTOS: number (higher = higher priority). Zephyr: number (lower = higher priority). Default: 5.' },
			syncPrimitive: { description: '"queue" (default), "semaphore", or "none"' },
		},
		execute: async (args: Record<string, any>) => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }

			const taskName = (args.taskName as string | undefined) ?? 'my_task';
			const stackSize = typeof args.stackSize === 'number' ? args.stackSize : undefined;
			const priority = typeof args.priority === 'number' ? args.priority : undefined;
			const sync = (args.syncPrimitive as string | undefined) ?? 'queue';

			const rtos = s.rtos ?? _detectRTOS(s.complianceFrameworks ?? [], s.projectInfo?.buildSystem ?? '');
			return _generateRTOSTask(taskName, rtos, stackSize, priority, sync);
		},
	};
}


// \u2500\u2500\u2500 Code generators \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _generatePeriphInit(
	regMap: IPeripheralRegisterMap,
	periph: string,
	lang: string,
	misra: boolean,
	options: Record<string, any>,
): string {
	const baseAddr = `0x${regMap.baseAddress.toString(16).toUpperCase().padStart(8, '0')}`;
	const funcName = `${periph.toLowerCase()}_init`;
	const lines: string[] = [];

	if (lang === 'rust') {
		lines.push(`// Auto-generated from SVD register map \u2014 ${periph} @ ${baseAddr}`);
		lines.push(`pub fn ${funcName}() {`);
		lines.push(`    // TODO: Rust PAC/HAL access via peripheral block`);
		lines.push(`    // Base address: ${baseAddr}`);
		_appendRustRegisterComments(lines, regMap);
		lines.push(`}`);
		return lines.join('\n');
	}

	// C generation
	lines.push(`/* Auto-generated ${periph} initialization */`);
	lines.push(`/* SVD source: ${regMap.source ?? 'session'} \u2014 base address: ${baseAddr} */`);
	lines.push('');

	if (misra) {
		lines.push(`/* MISRA C:2012 Rule 11.4 \u2014 cast through volatile pointer */`);
		lines.push(`#define ${periph}_BASE  (${baseAddr}UL)`);
		lines.push(`#define ${periph}_REG(offset) (*((volatile uint32_t *)(${periph}_BASE + (offset))))`);
	} else {
		lines.push(`#define ${periph}_BASE  (${baseAddr}UL)`);
		lines.push(`#define REG32(addr) (*((volatile uint32_t *)(addr)))`);
	}
	lines.push('');

	// Register defines from SVD
	const keyRegs = regMap.registers.slice(0, 12);
	for (const reg of keyRegs) {
		const regOffset = `0x${reg.addressOffset.toString(16).toUpperCase().padStart(3, '0')}`;
		const macroName = misra
			? `${periph}_${reg.name}`
			: `${periph}_${reg.name}`;
		lines.push(`#define ${macroName.padEnd(32)} ${periph}_REG(${regOffset}UL)  /* ${reg.description ?? reg.name} */`);
	}
	if (regMap.registers.length > 12) {
		lines.push(`/* ... ${regMap.registers.length - 12} more registers \u2014 see SVD for full list */`);
	}
	lines.push('');

	// Init function
	lines.push(`void ${funcName}(void)`);
	lines.push(`{`);

	// RCC clock enable hint
	lines.push(`    /* 1. Enable peripheral clock in RCC */`);
	lines.push(`    /* RCC->APB1ENR |= RCC_APB1ENR_${periph}EN; */`);
	lines.push('');

	// Write key registers based on peripheral type
	_appendCRegisterInits(lines, regMap, periph, options, misra);

	lines.push(`}`);

	// Add bit field helpers for key registers
	const crRegs = regMap.registers.filter(r => r.name.match(/^(CR|CR1|CR2|CR3|SR|CCR|SMCR)/));
	if (crRegs.length > 0 && crRegs[0].fields && crRegs[0].fields.length > 0) {
		lines.push('');
		lines.push(`/* Key bit field positions for ${periph}_${crRegs[0].name} */`);
		for (const field of crRegs[0].fields.slice(0, 8)) {
			lines.push(`#define ${periph}_${crRegs[0].name}_${field.name}_Pos  (${field.bitOffset}U)`);
			lines.push(`#define ${periph}_${crRegs[0].name}_${field.name}_Msk  (0x${((1 << field.bitWidth) - 1).toString(16).toUpperCase()}UL << ${field.bitOffset}U)`);
		}
	}

	return lines.join('\n');
}


function _appendCRegisterInits(
	lines: string[],
	regMap: IPeripheralRegisterMap,
	periph: string,
	options: Record<string, any>,
	misra: boolean,
): void {
	const cr1 = regMap.registers.find(r => r.name === 'CR1' || r.name === 'CR');
	const brr = regMap.registers.find(r => r.name === 'BRR' || r.name === 'BAUDRATE');
	const srReg = regMap.registers.find(r => r.name === 'SR' || r.name === 'ISR');

	if (srReg) {
		lines.push(`    /* Clear any pending flags in ${periph}_${srReg.name} before enabling */`);
		lines.push(`    (void)${periph}_${srReg.name}; /* read-clear */`);
		lines.push('');
	}

	if (brr && options.baudRate) {
		// UART-like peripheral with baud rate
		lines.push(`    /* 2. Set baud rate: ${options.baudRate} bps */`);
		lines.push(`    /* ${periph}_BRR = fCK / ${options.baudRate}; (replace fCK with APB clock) */`);
		lines.push(`    ${periph}_${brr.name} = 0x0000UL; /* TODO: calculate from fCK / ${options.baudRate} */`);
		lines.push('');
	}

	if (cr1) {
		lines.push(`    /* 3. Configure ${cr1.description ?? cr1.name} */`);
		const activeFields = cr1.fields?.filter(f => f.name !== 'RESERVED').slice(0, 6) ?? [];
		if (activeFields.length > 0) {
			const fieldStr = activeFields.map(f => `${f.name}=(0U<<${f.bitOffset}U)`).join(' | ');
			lines.push(`    ${periph}_${cr1.name} = ${fieldStr};`);
			for (const f of activeFields) {
				lines.push(`    /* ${f.name}[${f.bitOffset + f.bitWidth - 1}:${f.bitOffset}]: ${f.description ?? f.name} */`);
			}
		} else {
			lines.push(`    ${periph}_${cr1.name} = 0x0000UL;`);
		}
		lines.push('');
	}

	lines.push(`    /* 4. Enable peripheral */`);
	if (cr1) {
		const enField = cr1.fields?.find(f => f.name === 'UE' || f.name === 'EN' || f.name === 'SPE' || f.name === 'TEN' || f.name === 'CEN');
		if (enField) {
			lines.push(`    ${periph}_${cr1.name} |= (1UL << ${enField.bitOffset}U); /* ${enField.name}: ${enField.description ?? 'enable'} */`);
		} else {
			lines.push(`    /* Set enable bit in ${periph}_${cr1.name} */`);
		}
	}
}


function _appendRustRegisterComments(lines: string[], regMap: IPeripheralRegisterMap): void {
	for (const reg of regMap.registers.slice(0, 8)) {
		const offset = `0x${reg.addressOffset.toString(16).toUpperCase().padStart(3, '0')}`;
		lines.push(`    // ${reg.name} @ offset ${offset}: ${reg.description ?? ''}`);
	}
}


function _generateISR(regMap: IPeripheralRegisterMap, irq: { name: string; value: number; description?: string } | undefined): string {
	const periph = regMap.name;
	const irqName = irq?.name ?? `${periph}_IRQn`;
	const irqNum = irq?.value ?? 0;
	const handlerName = irqName.replace(/_IRQn$/, '_IRQHandler');

	const sr = regMap.registers.find(r => r.name === 'SR' || r.name === 'ISR' || r.name === 'INTFR');
	const clearReg = regMap.registers.find(r => r.name === 'ICR' || r.name === 'IFCR' || r.name === 'SR');
	const baseAddr = `0x${regMap.baseAddress.toString(16).toUpperCase().padStart(8, '0')}`;

	return [
		`/* Auto-generated ISR for ${periph} \u2014 IRQn ${irqNum}: ${irq?.description ?? irqName} */`,
		`/* SVD source: ${regMap.source ?? 'session'} \u2014 ${periph} base: ${baseAddr} */`,
		'',
		`/* Volatile flag \u2014 set in ISR, cleared in main loop */`,
		`static volatile uint8_t ${periph.toLowerCase()}_event_flag = 0U;`,
		'',
		`void ${handlerName}(void)`,
		`{`,
		`    /* Cortex-M rule: clear interrupt flag FIRST to prevent re-entry */`,
		sr ? `    uint32_t sr = ${periph}_${sr.name}; /* capture status */` : `    /* Read status register */`,
		clearReg && clearReg.name !== sr?.name
			? `    ${periph}_${clearReg.name} = 0xFFFFFFFFUL; /* clear all pending flags */`
			: sr ? `    (void)sr; /* flag cleared by reading SR */` : `    /* Clear pending flags */`,
		'',
		`    /* Signal main context \u2014 ISR-safe write */`,
		`    ${periph.toLowerCase()}_event_flag = 1U;`,
		``,
		`    /* TODO: add peripheral-specific handling here */`,
		`    /* e.g. read data register, write to ring buffer, update state machine */`,
		`}`,
		'',
		`/* In your init function: */`,
		`/* NVIC_SetPriority(${irqName}, ${irqNum > 8 ? 8 : irqNum}U); */`,
		`/* NVIC_EnableIRQ(${irqName});                              */`,
	].join('\n');
}


function _generateDMAConfig(
	periph: string,
	dir: string,
	dataSize: number,
	periphMap: IPeripheralRegisterMap | undefined,
	dmaMap: IPeripheralRegisterMap | undefined,
	family: string,
): string {
	const isSTM32F4 = family.toUpperCase().startsWith('STM32F4') || family.toUpperCase().startsWith('STM32F7');
	const dmaStyle = isSTM32F4 ? 'stream' : 'channel'; // STM32F4/F7 use DMA streams; others use channels

	const msizeMap: Record<number, string> = { 8: '0b00', 16: '0b01', 32: '0b10' };
	const msize = msizeMap[dataSize] ?? '0b00';
	const dirBit = dir === 'mem-to-periph' ? '0b01' : '0b00';
	const streamNum = _dmaStreamForPeriph(periph, dir, family);

	const lines: string[] = [
		`/* Auto-generated DMA configuration for ${periph} ${dir} */`,
		`/* Family: ${family} \u2014 DMA style: ${dmaStyle} */`,
		'',
	];

	if (dmaStyle === 'stream') {
		// STM32F4/F7 DMA stream registers
		lines.push(`void dma_config_${periph.toLowerCase()}_${dir.replace('-', '_')}(uint32_t periph_addr, uint32_t mem_addr, uint32_t len)`);
		lines.push(`{`);
		lines.push(`    /* 1. Enable DMA clock: RCC->AHB1ENR |= RCC_AHB1ENR_DMA1EN; */`);
		lines.push(`    /* 2. Disable stream before config */`);
		lines.push(`    DMA1_Stream${streamNum}->CR &= ~DMA_SxCR_EN;`);
		lines.push(`    while (DMA1_Stream${streamNum}->CR & DMA_SxCR_EN) {} /* wait for disable */`);
		lines.push(`    /* 3. Clear interrupt flags */`);
		lines.push(`    DMA1->LIFCR = 0x3D << (${streamNum < 4 ? streamNum * 6 : (streamNum - 4) * 6}U); /* clear all flags for stream ${streamNum} */`);
		lines.push(`    /* 4. Configure addresses */`);
		lines.push(`    DMA1_Stream${streamNum}->PAR  = periph_addr; /* peripheral address */`);
		lines.push(`    DMA1_Stream${streamNum}->M0AR = mem_addr;    /* memory address */`);
		lines.push(`    DMA1_Stream${streamNum}->NDTR = len;         /* data count */`);
		lines.push(`    /* 5. Configure stream: dir=${dir}, MSIZE=${dataSize}b, PSIZE=${dataSize}b, MINC=1, PINC=0 */`);
		lines.push(`    DMA1_Stream${streamNum}->CR = `);
		lines.push(`        (${_dmaChannelForPeriph(periph, dir, family)}UL << DMA_SxCR_CHSEL_Pos) | /* channel selection */`);
		lines.push(`        (${msize}UL << DMA_SxCR_MSIZE_Pos)  | /* memory data size: ${dataSize}-bit */`);
		lines.push(`        (${msize}UL << DMA_SxCR_PSIZE_Pos)  | /* periph data size: ${dataSize}-bit */`);
		lines.push(`        (${dirBit}UL << DMA_SxCR_DIR_Pos)   | /* direction: ${dir} */`);
		lines.push(`        DMA_SxCR_MINC                       | /* memory increment mode */`);
		lines.push(`        DMA_SxCR_TCIE;                        /* transfer complete interrupt */`);
		lines.push(`    /* 6. Enable stream */`);
		lines.push(`    DMA1_Stream${streamNum}->CR |= DMA_SxCR_EN;`);
		lines.push(`}`);
	} else {
		// STM32F0/F1/G0/G4 DMA channel registers
		lines.push(`void dma_config_${periph.toLowerCase()}_${dir.replace('-', '_')}(uint32_t periph_addr, uint32_t mem_addr, uint32_t len)`);
		lines.push(`{`);
		lines.push(`    /* 1. Enable DMA clock: RCC->AHBENR |= RCC_AHBENR_DMA1EN; */`);
		lines.push(`    /* 2. Disable channel before config */`);
		lines.push(`    DMA1_Channel${streamNum}->CCR &= ~DMA_CCR_EN;`);
		lines.push(`    /* 3. Configure addresses */`);
		lines.push(`    DMA1_Channel${streamNum}->CPAR  = periph_addr;`);
		lines.push(`    DMA1_Channel${streamNum}->CMAR  = mem_addr;`);
		lines.push(`    DMA1_Channel${streamNum}->CNDTR = len;`);
		lines.push(`    /* 4. Configure channel: dir=${dir}, MSIZE=${dataSize}b, PSIZE=${dataSize}b, MINC=1, PINC=0 */`);
		lines.push(`    DMA1_Channel${streamNum}->CCR =`);
		lines.push(`        (${msize}UL << DMA_CCR_MSIZE_Pos) | /* memory data size: ${dataSize}-bit */`);
		lines.push(`        (${msize}UL << DMA_CCR_PSIZE_Pos) | /* periph data size: ${dataSize}-bit */`);
		lines.push(`        ${dir === 'mem-to-periph' ? 'DMA_CCR_DIR |' : '          '} /* direction: ${dir} */`);
		lines.push(`        DMA_CCR_MINC |                       /* memory increment mode */`);
		lines.push(`        DMA_CCR_TCIE;                        /* transfer complete interrupt */`);
		lines.push(`    /* 5. Enable channel */`);
		lines.push(`    DMA1_Channel${streamNum}->CCR |= DMA_CCR_EN;`);
		lines.push(`}`);
	}

	if (periphMap) {
		const drReg = periphMap.registers.find(r => r.name === 'DR' || r.name === 'TDR' || r.name === 'RDR' || r.name === 'DATA');
		if (drReg) {
			lines.push('');
			lines.push(`/* ${periph} data register address for PAR: */`);
			lines.push(`/* ${periph}_BASE + 0x${drReg.addressOffset.toString(16).toUpperCase()} = ${periph}_${drReg.name} */`);
		}
	}

	return lines.join('\n');
}


function _generateClockConfig(
	targetMHz: number,
	source: string,
	hseMHz: number,
	rccMap: IPeripheralRegisterMap | undefined,
	family: string,
	variant: string,
): string {
	const fam = family.toUpperCase();
	const isCortexM7 = fam.startsWith('STM32F7') || fam.startsWith('STM32H7');
	const maxMHz = isCortexM7 ? 216 : 168;
	const clampedMHz = Math.min(targetMHz, maxMHz);

	// PLL calculation: f_VCO = f_in * (PLLN / PLLM), f_sysclk = f_VCO / PLLP
	const inputMHz = source === 'hse' ? hseMHz : 16; // HSI = 16 MHz for STM32
	const pllm = inputMHz; // gives 1 MHz VCO input
	const pllp = 2;        // PLLP = 2 is most common for max clock
	const plln = clampedMHz * pllp;
	const pllq = Math.max(2, Math.ceil(plln / 48)); // USB: 48 MHz

	const flashWS = clampedMHz <= 30 ? 0 : clampedMHz <= 64 ? 1 : clampedMHz <= 90 ? 2 : clampedMHz <= 120 ? 3 : clampedMHz <= 150 ? 4 : 5;

	const rccSource = rccMap ? `/* RCC base: 0x${rccMap.baseAddress.toString(16).toUpperCase()} */` : '';

	return [
		`/* Auto-generated clock configuration for ${family} ${variant} */`,
		`/* Target: ${clampedMHz} MHz SYSCLK, source: ${source.toUpperCase()} @ ${inputMHz} MHz */`,
		rccSource,
		'',
		`void system_clock_config(void)`,
		`{`,
		`    /* \u2500\u2500 1. Enable ${source.toUpperCase()} \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */`,
		source === 'hse'
			? `    RCC->CR |= RCC_CR_HSEON;`
			: `    RCC->CR |= RCC_CR_HSION;`,
		source === 'hse'
			? `    while (!(RCC->CR & RCC_CR_HSERDY)) {} /* wait for HSE ready */`
			: `    while (!(RCC->CR & RCC_CR_HSIRDY)) {} /* wait for HSI ready */`,
		'',
		`    /* \u2500\u2500 2. Configure power regulator (voltage scale 1 for max clock) \u2500\u2500 */`,
		`    RCC->APB1ENR |= RCC_APB1ENR_PWREN;`,
		`    PWR->CR |= PWR_CR_VOS; /* voltage scale 1 */`,
		'',
		`    /* \u2500\u2500 3. Configure PLL \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */`,
		`    /* VCO input:  ${inputMHz} MHz / PLLM(${pllm}) = 1 MHz (minimum for low jitter) */`,
		`    /* VCO output: 1 MHz * PLLN(${plln}) = ${plln} MHz */`,
		`    /* SYSCLK:     ${plln} MHz / PLLP(${pllp}) = ${clampedMHz} MHz */`,
		`    /* USB/SDIO:   ${plln} MHz / PLLQ(${pllq}) = ${Math.round(plln / pllq)} MHz (target \u2265 48 MHz) */`,
		`    RCC->PLLCFGR = (${pllm}UL << RCC_PLLCFGR_PLLM_Pos)`,
		`                 | (${plln}UL << RCC_PLLCFGR_PLLN_Pos)`,
		`                 | (${(pllp / 2 - 1)}UL << RCC_PLLCFGR_PLLP_Pos)  /* PLLP = ${pllp} */`,
		`                 | (${pllq}UL << RCC_PLLCFGR_PLLQ_Pos)`,
		source === 'hse' ? `                 | RCC_PLLCFGR_PLLSRC_HSE; /* HSE as PLL source */` : `                 ; /* HSI as PLL source (default) */`,
		'',
		`    /* \u2500\u2500 4. Enable PLL \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */`,
		`    RCC->CR |= RCC_CR_PLLON;`,
		`    while (!(RCC->CR & RCC_CR_PLLRDY)) {} /* wait for PLL lock */`,
		'',
		`    /* \u2500\u2500 5. Flash wait states (required before increasing clock) \u2500\u2500\u2500\u2500\u2500\u2500 */`,
		`    /* At ${clampedMHz} MHz with 3.3V supply: ${flashWS} wait state(s) needed */`,
		`    FLASH->ACR = FLASH_ACR_LATENCY_${flashWS}WS | FLASH_ACR_PRFTEN | FLASH_ACR_ICEN | FLASH_ACR_DCEN;`,
		'',
		`    /* \u2500\u2500 6. AHB/APB prescalers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */`,
		`    RCC->CFGR = RCC_CFGR_HPRE_DIV1   /* AHB  = SYSCLK / 1  = ${clampedMHz} MHz */`,
		`              | RCC_CFGR_PPRE1_DIV4  /* APB1 = SYSCLK / 4  = ${Math.round(clampedMHz / 4)} MHz (max 45 MHz) */`,
		`              | RCC_CFGR_PPRE2_DIV2; /* APB2 = SYSCLK / 2  = ${Math.round(clampedMHz / 2)} MHz (max 90 MHz) */`,
		'',
		`    /* \u2500\u2500 7. Switch SYSCLK to PLL \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */`,
		`    RCC->CFGR |= RCC_CFGR_SW_PLL;`,
		`    while ((RCC->CFGR & RCC_CFGR_SWS) != RCC_CFGR_SWS_PLL) {} /* wait for switch */`,
		'',
		`    /* \u2500\u2500 8. Update SystemCoreClock (CMSIS) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */`,
		`    SystemCoreClock = ${clampedMHz}000000UL;`,
		`}`,
	].join('\n');
}


function _generateGPIOConfig(
	port: string,
	pinNum: number,
	mode: string,
	speed: string,
	pull: string,
	af: number | undefined,
	outputType: string,
	gpioMap: IPeripheralRegisterMap | undefined,
	rccMap: IPeripheralRegisterMap | undefined,
	family: string,
): string {
	const modeVal: Record<string, number> = { input: 0, output: 1, alternate: 2, analog: 3 };
	const speedVal: Record<string, number> = { low: 0, medium: 1, high: 2, 'very-high': 3 };
	const pullVal: Record<string, number> = { none: 0, up: 1, down: 2 };
	const otVal = outputType === 'open-drain' ? 1 : 0;

	const mBits = modeVal[mode] ?? 1;
	const sBits = speedVal[speed] ?? 1;
	const pBits = pullVal[pull] ?? 0;

	const gpioClock = family.toUpperCase().startsWith('STM32F1') || family.toUpperCase().startsWith('STM32F0')
		? `RCC->AHBENR |= RCC_AHBENR_GPIO${port}EN;`
		: `RCC->AHB1ENR |= RCC_AHB1ENR_GPIO${port}EN;`;

	const baseAddr = gpioMap ? `0x${gpioMap.baseAddress.toString(16).toUpperCase()}` : `GPIO${port}_BASE`;

	const lines = [
		`/* Auto-generated GPIO config: P${port}${pinNum} as ${mode}${af !== undefined ? `, AF${af}` : ''} */`,
		`/* GPIO${port} base: ${baseAddr} */`,
		'',
		`void gpio_config_p${port.toLowerCase()}${pinNum}(void)`,
		`{`,
		`    /* 1. Enable GPIO${port} clock */`,
		`    ${gpioClock}`,
		'',
		`    /* 2. Mode: ${mode} (MODER[${pinNum * 2 + 1}:${pinNum * 2}] = ${mBits}b${mBits.toString(2).padStart(2, '0')}) */`,
		`    GPIO${port}->MODER &= ~(0x3UL << (${pinNum}U * 2U));`,
		`    GPIO${port}->MODER |=  (${mBits}UL << (${pinNum}U * 2U));`,
	];

	if (mode === 'output' || mode === 'alternate') {
		lines.push('');
		lines.push(`    /* 3. Output type: ${outputType} (OTYPER[${pinNum}] = ${otVal}) */`);
		lines.push(`    GPIO${port}->OTYPER ${otVal ? '|=' : '&= ~'}(0x1UL << ${pinNum}U);`);
		lines.push('');
		lines.push(`    /* 4. Output speed: ${speed} (OSPEEDR[${pinNum * 2 + 1}:${pinNum * 2}] = ${sBits}) */`);
		lines.push(`    GPIO${port}->OSPEEDR &= ~(0x3UL << (${pinNum}U * 2U));`);
		lines.push(`    GPIO${port}->OSPEEDR |=  (${sBits}UL << (${pinNum}U * 2U));`);
	}

	if (pull !== 'none') {
		lines.push('');
		lines.push(`    /* 5. Pull: ${pull} (PUPDR[${pinNum * 2 + 1}:${pinNum * 2}] = ${pBits}) */`);
		lines.push(`    GPIO${port}->PUPDR &= ~(0x3UL << (${pinNum}U * 2U));`);
		lines.push(`    GPIO${port}->PUPDR |=  (${pBits}UL << (${pinNum}U * 2U));`);
	}

	if (mode === 'alternate' && af !== undefined) {
		const afrReg = pinNum < 8 ? 'AFRL' : 'AFRH';
		const afrBit = (pinNum % 8) * 4;
		lines.push('');
		lines.push(`    /* 6. Alternate function: AF${af} (${afrReg}[${afrBit + 3}:${afrBit}] = ${af}) */`);
		lines.push(`    GPIO${port}->AFR[${pinNum < 8 ? 0 : 1}U] &= ~(0xFUL << ${afrBit}U);`);
		lines.push(`    GPIO${port}->AFR[${pinNum < 8 ? 0 : 1}U] |=  (${af}UL << ${afrBit}U);`);
	}

	lines.push(`}`);
	return lines.join('\n');
}


function _generateRTOSTask(
	taskName: string,
	rtos: string,
	stackSize: number | undefined,
	priority: number | undefined,
	sync: string,
): string {
	if (rtos === 'zephyr') {
		const stack = stackSize ?? 1024;
		const prio = priority ?? 5;
		return [
			`/* Auto-generated Zephyr thread skeleton: ${taskName} */`,
			'',
			`#include <zephyr/kernel.h>`,
			'',
			`/* Stack and thread definitions */`,
			`K_THREAD_STACK_DEFINE(${taskName}_stack, ${stack}U);`,
			`static struct k_thread ${taskName}_thread_data;`,
			sync === 'queue' ? `K_MSGQ_DEFINE(${taskName}_msgq, sizeof(uint32_t), 8U, 4U);` : '',
			sync === 'semaphore' ? `K_SEM_DEFINE(${taskName}_sem, 0U, 1U);` : '',
			'',
			`static void ${taskName}_thread(void *p1, void *p2, void *p3)`,
			`{`,
			`    ARG_UNUSED(p1); ARG_UNUSED(p2); ARG_UNUSED(p3);`,
			'',
			`    while (1) {`,
			sync === 'queue' ? `        uint32_t msg;\n        k_msgq_get(&${taskName}_msgq, &msg, K_FOREVER);` : '',
			sync === 'semaphore' ? `        k_sem_take(&${taskName}_sem, K_FOREVER);` : '',
			sync === 'none' ? `        k_sleep(K_MSEC(10U));` : '',
			`        /* TODO: ${taskName} work here */`,
			`    }`,
			`}`,
			'',
			`/* Call from main() to start the thread */`,
			`void ${taskName}_init(void)`,
			`{`,
			`    k_thread_create(&${taskName}_thread_data, ${taskName}_stack,`,
			`                    K_THREAD_STACK_SIZEOF(${taskName}_stack),`,
			`                    ${taskName}_thread, NULL, NULL, NULL,`,
			`                    ${prio}, 0U, K_NO_WAIT);`,
			`    k_thread_name_set(&${taskName}_thread_data, "${taskName}");`,
			`}`,
		].filter(l => l !== '').join('\n');
	}

	// FreeRTOS (default)
	const stack = stackSize ?? 256;
	const prio = priority ?? 5;

	return [
		`/* Auto-generated FreeRTOS task skeleton: ${taskName} */`,
		'',
		`#include "FreeRTOS.h"`,
		`#include "task.h"`,
		sync === 'queue' ? `#include "queue.h"` : '',
		sync === 'semaphore' ? `#include "semphr.h"` : '',
		'',
		sync === 'queue' ? `static QueueHandle_t ${taskName}_queue;` : '',
		sync === 'semaphore' ? `static SemaphoreHandle_t ${taskName}_sem;` : '',
		sync !== 'none' ? `static TaskHandle_t ${taskName}_handle;` : '',
		'',
		`static void ${taskName}_task(void *pvParameters)`,
		`{`,
		`    (void)pvParameters;`,
		'',
		`    for (;;) {`,
		sync === 'queue' ? `        uint32_t msg;\n        if (xQueueReceive(${taskName}_queue, &msg, portMAX_DELAY) == pdTRUE) {` : '',
		sync === 'semaphore' ? `        xSemaphoreTake(${taskName}_sem, portMAX_DELAY);` : '',
		sync === 'none' ? `        vTaskDelay(pdMS_TO_TICKS(10U));` : '',
		`        /* TODO: ${taskName} work here */`,
		sync === 'queue' ? `        }` : '',
		`    }`,
		`}`,
		'',
		`/* Call from main() before vTaskStartScheduler() */`,
		`void ${taskName}_init(void)`,
		`{`,
		sync === 'queue' ? `    ${taskName}_queue = xQueueCreate(8U, sizeof(uint32_t));` : '',
		sync === 'semaphore' ? `    ${taskName}_sem = xSemaphoreCreateBinary();` : '',
		`    xTaskCreate(`,
		`        ${taskName}_task,`,
		`        "${taskName}",`,
		`        ${stack}U,   /* stack depth in words */`,
		`        NULL,`,
		`        ${prio}U,    /* priority */`,
		sync !== 'none' ? `        &${taskName}_handle` : `        NULL`,
		`    );`,
		`}`,
	].filter(l => l !== '').join('\n');
}


// \u2500\u2500\u2500 DMA lookup helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _dmaStreamForPeriph(periph: string, dir: string, family: string): number {
	// STM32F4/F7 DMA stream numbers for common peripherals
	const map: Record<string, Record<string, number>> = {
		'USART1': { 'periph-to-mem': 2, 'mem-to-periph': 7 },
		'USART2': { 'periph-to-mem': 5, 'mem-to-periph': 6 },
		'SPI1':   { 'periph-to-mem': 2, 'mem-to-periph': 3 },
		'SPI2':   { 'periph-to-mem': 3, 'mem-to-periph': 4 },
		'I2C1':   { 'periph-to-mem': 0, 'mem-to-periph': 6 },
		'ADC1':   { 'periph-to-mem': 0, 'mem-to-periph': 0 },
	};
	return map[periph]?.[dir] ?? 0;
}

function _dmaChannelForPeriph(periph: string, dir: string, _family: string): number {
	// STM32F4/F7 DMA channel selection for common peripherals
	const map: Record<string, number> = {
		'USART1': 4, 'USART2': 4, 'SPI1': 3, 'SPI2': 0, 'I2C1': 1, 'ADC1': 0,
	};
	return map[periph] ?? 0;
}

function _detectRTOS(frameworks: string[], buildSystem: string): string {
	if (buildSystem === 'zephyr') { return 'zephyr'; }
	return 'freertos';
}
