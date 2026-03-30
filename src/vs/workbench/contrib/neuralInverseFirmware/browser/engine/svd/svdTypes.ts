/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * SVD Types
 *
 * Type definitions for ARM CMSIS SVD (System View Description) file parsing.
 * SVD files are XML-based and describe the hardware registers of ARM Cortex-M MCUs.
 * This gives immediate coverage for STM32, nRF, NXP, RP2040, etc.
 *
 * Spec: https://arm-software.github.io/CMSIS_5/SVD/html/index.html
 */

/** SVD access type for registers and fields. */
export type SVDAccess = 'read-only' | 'write-only' | 'read-write' | 'writeOnce' | 'read-writeOnce';

/** An enumerated value for a bit field. */
export interface ISVDEnumeratedValue {
	name: string;
	description: string;
	value: number;
}

/** A bit field within a register. */
export interface ISVDBitField {
	name: string;
	description: string;
	bitOffset: number;
	bitWidth: number;
	access?: SVDAccess;
	enumeratedValues: ISVDEnumeratedValue[];
}

/** A single register. */
export interface ISVDRegister {
	name: string;
	description: string;
	addressOffset: number;
	size: number;          // in bits (typically 8, 16, 32)
	access?: SVDAccess;
	resetValue: number;
	fields: ISVDBitField[];
}

/** A register cluster (group of related registers that repeat). */
export interface ISVDCluster {
	name: string;
	description: string;
	addressOffset: number;
	registers: ISVDRegister[];
}

/** An interrupt associated with a peripheral. */
export interface ISVDInterrupt {
	name: string;
	description: string;
	value: number;
}

/** A peripheral (e.g. USART1, SPI2, GPIOA). */
export interface ISVDPeripheral {
	name: string;
	/** Group name (e.g. "USART" for USART1, USART2, etc.) */
	groupName: string;
	description: string;
	baseAddress: number;
	/** Peripheral this one is derived from (register set is inherited). */
	derivedFrom?: string;
	registers: ISVDRegister[];
	clusters: ISVDCluster[];
	interrupts: ISVDInterrupt[];
	/** Size in bits for registers in this peripheral (default from device if not set). */
	size?: number;
	/** Default access type for registers in this peripheral. */
	access?: SVDAccess;
	/** Default reset value for registers in this peripheral. */
	resetValue?: number;
}

/** The top-level device described by the SVD file. */
export interface ISVDDevice {
	vendor: string;
	name: string;
	series: string;
	version: string;
	description: string;
	/** CPU core, e.g. "CM4", "CM7", "CM0+" */
	cpu: string;
	/** Address unit bits (typically 8). */
	addressUnitBits: number;
	/** Default register width in bits (typically 32). */
	width: number;
	/** Default register size in bits. */
	size: number;
	/** Default access type. */
	access: SVDAccess;
	/** Default reset value. */
	resetValue: number;
	/** All peripherals in this device. */
	peripherals: ISVDPeripheral[];
}
