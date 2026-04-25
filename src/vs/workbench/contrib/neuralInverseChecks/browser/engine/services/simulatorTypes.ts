/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Simulator Types
 *
 * Shared types for the simulator layer — runtime violation detection via
 * QEMU, Renode, GDB hardware simulation, Proteus, Spike, and custom simulators.
 */

// ─── Simulator kinds ─────────────────────────────────────────────────────────

export type SimulatorKind =
	| 'qemu'           // QEMU system emulation (ARM, RISC-V, x86)
	| 'renode'         // Renode multi-platform embedded simulator
	| 'gdb-sim'        // GDB built-in simulator (--target=sim)
	| 'spike'          // RISC-V ISA simulator
	| 'proteus'        // Labcenter Proteus VSM (Windows only)
	| 'armvirt'        // ARM Fast Models / AEM
	| 'matlab'         // MATLAB / Simulink Coder + SIL/PIL execution
	| 'simulink'       // Simulink Test harness (model-in-the-loop)
	| 'gem5'           // gem5 full-system / syscall-emulation simulator
	| 'ovpsim'         // OVP Imperas instruction-accurate simulator
	| 'bochs'          // Bochs x86 PC emulator
	| 'virtualbox'     // VirtualBox headless (OS-level testing)
	| 'custom';        // Any CLI simulator via custom command


// ─── Session status ───────────────────────────────────────────────────────────

export type SimulatorSessionStatus =
	| 'idle'
	| 'building'
	| 'loading'
	| 'running'
	| 'complete'
	| 'failed'
	| 'cancelled';


// ─── Runtime violation kinds ──────────────────────────────────────────────────

export type RuntimeViolationKind =
	| 'stack-overflow'
	| 'heap-overflow'
	| 'null-deref'
	| 'watchdog-timeout'
	| 'timing-violation'      // deadline missed
	| 'assertion-failure'
	| 'memory-access-fault'   // MPU/MMU fault
	| 'divide-by-zero'
	| 'unaligned-access'
	| 'isr-stack-overflow'
	| 'double-fault'
	| 'privilege-violation'
	| 'resource-leak'
	| 'deadlock'
	| 'data-race'
	| 'undefined-behaviour'
	| 'custom';


// ─── Runtime violation ────────────────────────────────────────────────────────

export interface ISimulatorViolation {
	kind: RuntimeViolationKind;
	message: string;
	/** Source file if known (from DWARF debug info or log) */
	file?: string;
	/** Source line if known */
	line?: number;
	/** PC address where fault occurred */
	address?: string;
	/** Register dump or backtrace */
	context?: string;
	/** Raw log line that produced this violation */
	rawLine: string;
	timestamp: number;
}


// ─── Session config ───────────────────────────────────────────────────────────

export interface ISimulatorSessionConfig {
	/** Unique session ID */
	id: string;
	/** Human-readable name */
	name: string;
	kind: SimulatorKind;
	/** Shell command to build the ELF — supports ${workspace} */
	buildCommand?: string;
	/** Path to ELF/binary, relative to workspace root — supports ${workspace} */
	elfPath: string;
	/** Full simulator launch command — supports ${workspace}, ${elf}, ${elfAbs} */
	launchCommand: string;
	/** Optional test script to run after launch (e.g. GDB commands file) */
	testScript?: string;
	/** Max runtime in ms before force-kill */
	timeoutMs: number;
	/** Extra env vars */
	env?: Record<string, string>;
	/** Whether to persist config to .inverse/simulators/{id}.json */
	persist?: boolean;
}


// ─── Session record (live state) ─────────────────────────────────────────────

export interface ISimulatorSession {
	config: ISimulatorSessionConfig;
	status: SimulatorSessionStatus;
	startedAt?: number;
	completedAt?: number;
	/** Raw output lines captured from simulator stdout/stderr */
	outputLines: string[];
	/** Violations parsed from output */
	violations: ISimulatorViolation[];
	/** How many GRC results were injected into the engine for this run */
	injectedCount?: number;
	/** Error message if status === 'failed' */
	error?: string;
}


// ─── Simulator preset ─────────────────────────────────────────────────────────

export interface ISimulatorPreset {
	id: string;
	name: string;
	sector: string;
	targetPlatform: string;
	kind: SimulatorKind;
	description: string;
	tags: string[];
	/** Placeholder ELF path shown in the form */
	elfPath: string;
	buildCommand?: string;
	/** Ready-to-use launch command with ${workspace} / ${elfAbs} substitutions */
	launchCommand: string;
	timeoutMs: number;
	env?: Record<string, string>;
}
