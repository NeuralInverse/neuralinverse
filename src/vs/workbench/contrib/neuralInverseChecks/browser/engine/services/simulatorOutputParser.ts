/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Simulator Output Parser
 *
 * Parses stdout/stderr from QEMU, Renode, GDB sim, Spike, and custom simulators
 * into structured ISimulatorViolation[].
 *
 * Each simulator produces different output formats — this module contains
 * per-simulator pattern sets plus a universal fallback.
 */

import { ISimulatorViolation, RuntimeViolationKind, SimulatorKind } from './simulatorTypes.js';

// ─── Pattern record ───────────────────────────────────────────────────────────

interface IViolationPattern {
	kind: RuntimeViolationKind;
	re: RegExp;
	/** Extract file from match groups */
	fileGroup?: number;
	lineGroup?: number;
	addrGroup?: number;
	msgOverride?: string;
}

// ─── QEMU patterns ───────────────────────────────────────────────────────────

const QEMU_PATTERNS: IViolationPattern[] = [
	{ kind: 'null-deref',           re: /qemu.*Segmentation fault|Null pointer dereference/i },
	{ kind: 'stack-overflow',       re: /qemu.*Stack overflow|stack smashing detected/i },
	{ kind: 'memory-access-fault',  re: /qemu.*Bus error|Memory access fault|unmapped address/i },
	{ kind: 'unaligned-access',     re: /qemu.*Unaligned access|alignment fault/i,           addrGroup: 1 },
	{ kind: 'watchdog-timeout',     re: /watchdog.*expired|WDT.*timeout|watchdog reset/i },
	{ kind: 'assertion-failure',    re: /Assertion `(.+?)' failed|assert.*failed/i,           msgOverride: 'Assertion failed' },
	{ kind: 'divide-by-zero',       re: /Division by zero|divide by zero|SIGFPE/i },
	{ kind: 'double-fault',         re: /double fault|DOUBLE_FAULT/i },
	{ kind: 'isr-stack-overflow',   re: /ISR stack overflow|interrupt stack overflow/i },
	{ kind: 'privilege-violation',  re: /privilege.*violation|UsageFault|BusFault|HardFault/i },
	{ kind: 'timing-violation',     re: /deadline.*missed|timing.*violation|RTOS.*overrun/i },
	{ kind: 'undefined-behaviour',  re: /undefined behaviour|UBSan:|sanitizer.*runtime/i },
	{ kind: 'data-race',            re: /ThreadSanitizer|data race detected|TSan:/i },
];

// ─── Renode patterns ─────────────────────────────────────────────────────────

const RENODE_PATTERNS: IViolationPattern[] = [
	{ kind: 'memory-access-fault',  re: /\[CPU\].*Memory access.*fault|BusError.*at 0x([0-9a-fA-F]+)/i, addrGroup: 1 },
	{ kind: 'watchdog-timeout',     re: /\[Watchdog\].*timeout|WDT.*triggered/i },
	{ kind: 'assertion-failure',    re: /\[.*\] Assert.*failed|CpuAbortException/i },
	{ kind: 'stack-overflow',       re: /Stack pointer.*out of range|stack overflow/i },
	{ kind: 'privilege-violation',  re: /HardFault|UsageFault|BusFault|MemManage/i },
	{ kind: 'timing-violation',     re: /missed deadline|timing constraint violated|WCET exceeded/i },
	{ kind: 'null-deref',           re: /null pointer|NullReferenceException/i },
	{ kind: 'unaligned-access',     re: /unaligned.*access at 0x([0-9a-fA-F]+)/i, addrGroup: 1 },
];

// ─── GDB sim patterns ─────────────────────────────────────────────────────────

const GDB_SIM_PATTERNS: IViolationPattern[] = [
	{ kind: 'null-deref',           re: /Program received signal SIGSEGV|Segmentation fault/i },
	{ kind: 'stack-overflow',       re: /Program received signal SIGSEGV.*stack/i },
	{ kind: 'memory-access-fault',  re: /Cannot access memory at address 0x([0-9a-fA-F]+)/i, addrGroup: 1 },
	{ kind: 'assertion-failure',    re: /Program received signal SIGABRT|Aborted|assert.*failed/i },
	{ kind: 'divide-by-zero',       re: /Program received signal SIGFPE|Arithmetic exception/i },
	{ kind: 'undefined-behaviour',  re: /UBSan:|undefined behavior/i },
	{ kind: 'privilege-violation',  re: /Illegal instruction|SIGILL|HardFault/i },
	{ kind: 'timing-violation',     re: /WCET.*exceeded|timing.*violation/i },
];

// ─── Spike (RISC-V) patterns ──────────────────────────────────────────────────

const SPIKE_PATTERNS: IViolationPattern[] = [
	{ kind: 'memory-access-fault',  re: /trap_load_access_fault|trap_store_access_fault|Access fault at 0x([0-9a-fA-F]+)/i, addrGroup: 1 },
	{ kind: 'unaligned-access',     re: /trap_load_address_misaligned|trap_store_address_misaligned/i },
	{ kind: 'privilege-violation',  re: /trap_illegal_instruction|Illegal instruction/i },
	{ kind: 'divide-by-zero',       re: /trap_illegal_instruction.*div/i },
	{ kind: 'assertion-failure',    re: /ABORT|assertion.*failed/i },
	{ kind: 'stack-overflow',       re: /stack.*overflow|sp.*out of range/i },
];

// ─── ARM Fast Models / AEM patterns ──────────────────────────────────────────

const ARMVIRT_PATTERNS: IViolationPattern[] = [
	{ kind: 'memory-access-fault',  re: /ESR_EL\d=0x[0-9a-fA-F]+.*FAR_EL\d=0x([0-9a-fA-F]+)/i, addrGroup: 1 },
	{ kind: 'privilege-violation',  re: /SCTLR.*undefined|SError interrupt|Unexpected exception/i },
	{ kind: 'stack-overflow',       re: /SP.*alignment|stack.*guard.*hit/i },
	{ kind: 'unaligned-access',     re: /Alignment fault at 0x([0-9a-fA-F]+)/i, addrGroup: 1 },
	{ kind: 'double-fault',         re: /Double fault|SError/i },
	{ kind: 'timing-violation',     re: /watchdog.*expired|timer.*overrun/i },
	{ kind: 'undefined-behaviour',  re: /UBSan:|undefined.*instruction/i },
];

// ─── Proteus VSM patterns ─────────────────────────────────────────────────────

const PROTEUS_PATTERNS: IViolationPattern[] = [
	{ kind: 'stack-overflow',       re: /Stack overflow detected|STKOF/i },
	{ kind: 'watchdog-timeout',     re: /WDT Reset|Watchdog.*overflow/i },
	{ kind: 'null-deref',           re: /Null pointer|Access violation/i },
	{ kind: 'divide-by-zero',       re: /Divide.*zero|DIV0/i },
	{ kind: 'assertion-failure',    re: /Assertion failed|BREAK instruction/i },
	{ kind: 'privilege-violation',  re: /Illegal instruction|Trap.*instruction/i },
	{ kind: 'timing-violation',     re: /Real time.*exceeded|CPU usage.*100/i },
];

// ─── MATLAB / Simulink Coder (SIL/PIL) patterns ──────────────────────────────

const MATLAB_PATTERNS: IViolationPattern[] = [
	{ kind: 'assertion-failure',   re: /Assertion failed|Model assertion.*failed|Test.*FAILED/i,            msgOverride: 'MATLAB assertion failed' },
	{ kind: 'stack-overflow',      re: /Stack overflow|MATLAB.*stack.*exceeded/i },
	{ kind: 'divide-by-zero',      re: /Division by zero|Singular matrix|divide.*zero/i },
	{ kind: 'timing-violation',    re: /Deadline.*missed|Task.*overrun|WCET.*exceeded|Sample time.*violation/i },
	{ kind: 'memory-access-fault', re: /Segmentation fault|Access violation|Invalid memory/i },
	{ kind: 'null-deref',          re: /Null pointer dereference|Uninitialized.*pointer/i },
	{ kind: 'undefined-behaviour', re: /Undefined behavior|Integer overflow.*model|data type overflow/i },
	{ kind: 'resource-leak',       re: /Memory leak detected|resource.*not.*released/i },
	{ kind: 'data-race',           re: /Race condition|concurrent.*access/i },
	{ kind: 'custom',              re: /Error in.*model|Model.*error|Simulation.*aborted/i,                 msgOverride: 'MATLAB/Simulink simulation error' },
];

// ─── gem5 patterns ────────────────────────────────────────────────────────────

const GEM5_PATTERNS: IViolationPattern[] = [
	{ kind: 'memory-access-fault', re: /memory access fault|bus error|Unaligned.*access at 0x([0-9a-fA-F]+)/i, addrGroup: 1 },
	{ kind: 'stack-overflow',      re: /stack pointer.*out of bounds|stack.*overflow/i },
	{ kind: 'privilege-violation', re: /Illegal instruction|privilege.*fault|SIGILL/i },
	{ kind: 'divide-by-zero',      re: /divide by zero|SIGFPE/i },
	{ kind: 'undefined-behaviour', re: /undefined instruction|unknown opcode/i },
	{ kind: 'assertion-failure',   re: /assert.*failed|panic.*gem5/i },
	{ kind: 'timing-violation',    re: /deadline.*overrun|latency.*violation/i },
	{ kind: 'data-race',           re: /data race|concurrent.*memory/i },
];

// ─── OVPsim / Imperas patterns ────────────────────────────────────────────────

const OVPSIM_PATTERNS: IViolationPattern[] = [
	{ kind: 'memory-access-fault', re: /Read.*from uninitialized|Illegal.*address|Memory.*fault at 0x([0-9a-fA-F]+)/i, addrGroup: 1 },
	{ kind: 'stack-overflow',      re: /Stack.*overflow|SP.*bounds/i },
	{ kind: 'privilege-violation', re: /Privileged.*instruction|Illegal.*instruction|invalid.*opcode/i },
	{ kind: 'unaligned-access',    re: /Unaligned.*access/i },
	{ kind: 'watchdog-timeout',    re: /Watchdog.*trigger|WDT.*expired/i },
	{ kind: 'assertion-failure',   re: /OVPSIM.*Assert|simulation.*abort/i },
	{ kind: 'undefined-behaviour', re: /UNPREDICTABLE.*behavior|undefined.*instruction/i },
];

// ─── Bochs x86 patterns ───────────────────────────────────────────────────────

const BOCHS_PATTERNS: IViolationPattern[] = [
	{ kind: 'memory-access-fault', re: /Bochs.*page fault|exception.*0x0e|access.*violation/i },
	{ kind: 'stack-overflow',      re: /stack.*overflow|SS.*limit/i },
	{ kind: 'privilege-violation', re: /general protection fault|exception.*0x0d|privilege.*fault/i },
	{ kind: 'divide-by-zero',      re: /divide.*error|exception.*0x00/i },
	{ kind: 'double-fault',        re: /double fault|exception.*0x08/i },
	{ kind: 'undefined-behaviour', re: /invalid.*opcode|exception.*0x06|UD2/i },
	{ kind: 'assertion-failure',   re: /BOCHS.*panic|bochs.*abort/i },
	{ kind: 'unaligned-access',    re: /alignment.*check|exception.*0x11/i },
];

// ─── VirtualBox headless patterns ────────────────────────────────────────────

const VIRTUALBOX_PATTERNS: IViolationPattern[] = [
	{ kind: 'memory-access-fault', re: /VERR_PAGE_FAULT|page fault|VERR_ACCESS_DENIED/i },
	{ kind: 'assertion-failure',   re: /AssertFailed|VBox.*assertion|VERR_ASSERT/i },
	{ kind: 'privilege-violation', re: /VERR_PRIVILEGE|access.*denied.*VBox/i },
	{ kind: 'stack-overflow',      re: /kernel.*stack.*overflow|VERR_STACK/i },
	{ kind: 'resource-leak',       re: /VERR_NO_MEMORY|out of memory|VERR_NO_MORE/i },
	{ kind: 'timing-violation',    re: /time.*drift.*exceeded|timer.*error.*VBox/i },
	{ kind: 'custom',              re: /VERR_|VWRN_|E_FAIL.*VBox/i,                                        msgOverride: 'VirtualBox runtime error' },
];

// ─── Universal fallback patterns (any simulator) ─────────────────────────────

const UNIVERSAL_PATTERNS: IViolationPattern[] = [
	{ kind: 'stack-overflow',       re: /stack.{0,20}overflow|STACKOVERFLOW/i },
	{ kind: 'heap-overflow',        re: /heap.{0,20}overflow|buffer overflow|HEAPOVERFLOW/i },
	{ kind: 'null-deref',           re: /null.{0,20}(deref|pointer|access)|SIGSEGV/i },
	{ kind: 'watchdog-timeout',     re: /watchdog|WDT.{0,10}(timeout|reset|expire)/i },
	{ kind: 'timing-violation',     re: /timing.{0,20}violation|deadline.{0,10}miss|WCET/i },
	{ kind: 'assertion-failure',    re: /assert(ion)?.{0,20}fail|ASSERT_FAILED/i },
	{ kind: 'memory-access-fault',  re: /memory.{0,20}fault|access.{0,20}violation|MPU fault/i },
	{ kind: 'divide-by-zero',       re: /divide.{0,10}zero|division.{0,10}zero|SIGFPE/i },
	{ kind: 'unaligned-access',     re: /unaligned.{0,20}access|alignment.{0,10}(fault|error)/i },
	{ kind: 'isr-stack-overflow',   re: /ISR.{0,10}stack|interrupt.{0,10}stack.{0,10}overflow/i },
	{ kind: 'double-fault',         re: /double.{0,10}fault|DOUBLE_FAULT/i },
	{ kind: 'privilege-violation',  re: /privilege.{0,20}violation|HardFault|BusFault|UsageFault|MemManage/i },
	{ kind: 'resource-leak',        re: /resource.{0,10}leak|file descriptor leak|memory leak detected/i },
	{ kind: 'deadlock',             re: /deadlock.{0,20}detect|mutex.*timeout.*expired/i },
	{ kind: 'data-race',            re: /data.{0,10}race|race.{0,10}condition.{0,10}detect|ThreadSanitizer/i },
	{ kind: 'undefined-behaviour',  re: /undefined.{0,10}behav|UBSan:|ubsan/i },
];

// ─── File/line extraction helpers ────────────────────────────────────────────

// Matches: "file.c:42" or "/path/to/file.c:42:5" or "at file.c line 42"
const FILE_LINE_RE = /(?:at\s+)?([^\s:,]+\.[a-zA-Z]+):(\d+)/;
const ADDR_RE = /(?:address|at|pc)\s*(?:=\s*)?0x([0-9a-fA-F]+)/i;

function extractFileLine(line: string): { file?: string; lineNo?: number; addr?: string } {
	const fm = FILE_LINE_RE.exec(line);
	const am = ADDR_RE.exec(line);
	return {
		file: fm?.[1],
		lineNo: fm ? parseInt(fm[2], 10) : undefined,
		addr: am?.[1],
	};
}

// ─── Main parser ─────────────────────────────────────────────────────────────

function getPatternsForKind(kind: SimulatorKind): IViolationPattern[] {
	switch (kind) {
		case 'qemu':    return [...QEMU_PATTERNS, ...UNIVERSAL_PATTERNS];
		case 'renode':  return [...RENODE_PATTERNS, ...UNIVERSAL_PATTERNS];
		case 'gdb-sim': return [...GDB_SIM_PATTERNS, ...UNIVERSAL_PATTERNS];
		case 'spike':   return [...SPIKE_PATTERNS, ...UNIVERSAL_PATTERNS];
		case 'armvirt':     return [...ARMVIRT_PATTERNS, ...UNIVERSAL_PATTERNS];
		case 'proteus':     return [...PROTEUS_PATTERNS, ...UNIVERSAL_PATTERNS];
		case 'matlab':      return [...MATLAB_PATTERNS, ...UNIVERSAL_PATTERNS];
		case 'simulink':    return [...MATLAB_PATTERNS, ...UNIVERSAL_PATTERNS]; // same parser, Simulink uses identical output
		case 'gem5':        return [...GEM5_PATTERNS, ...UNIVERSAL_PATTERNS];
		case 'ovpsim':      return [...OVPSIM_PATTERNS, ...UNIVERSAL_PATTERNS];
		case 'bochs':       return [...BOCHS_PATTERNS, ...UNIVERSAL_PATTERNS];
		case 'virtualbox':  return [...VIRTUALBOX_PATTERNS, ...UNIVERSAL_PATTERNS];
		default:            return UNIVERSAL_PATTERNS;
	}
}

/**
 * Parse raw simulator output lines into ISimulatorViolation[].
 *
 * Each line is matched against the pattern set for the simulator kind.
 * First match wins per line. Duplicate violations (same kind + file + line) are deduplicated.
 */
export function parseSimulatorOutput(
	lines: string[],
	kind: SimulatorKind,
	timestamp: number,
): ISimulatorViolation[] {
	const patterns = getPatternsForKind(kind);
	const violations: ISimulatorViolation[] = [];
	const seen = new Set<string>();

	for (const rawLine of lines) {
		const trimmed = rawLine.trim();
		if (!trimmed) continue;

		for (const pat of patterns) {
			const m = pat.re.exec(trimmed);
			if (!m) continue;

			const { file, lineNo, addr } = extractFileLine(trimmed);
			const address = pat.addrGroup ? m[pat.addrGroup] : addr;
			const message = pat.msgOverride ?? _buildMessage(pat.kind, trimmed, m);

			const dedupKey = `${pat.kind}:${file ?? ''}:${lineNo ?? ''}:${address ?? ''}`;
			if (seen.has(dedupKey)) break;
			seen.add(dedupKey);

			violations.push({
				kind: pat.kind,
				message,
				file,
				line: lineNo,
				address,
				rawLine: trimmed,
				timestamp,
			});
			break; // first pattern match wins per line
		}
	}

	return violations;
}

function _buildMessage(kind: RuntimeViolationKind, line: string, _m: RegExpExecArray): string {
	const prefix = _kindLabel(kind);
	// Truncate raw line to 120 chars for message
	const detail = line.length > 120 ? line.slice(0, 120) + '…' : line;
	return `${prefix}: ${detail}`;
}

function _kindLabel(kind: RuntimeViolationKind): string {
	const labels: Record<RuntimeViolationKind, string> = {
		'stack-overflow':      'Stack Overflow',
		'heap-overflow':       'Heap Overflow',
		'null-deref':          'Null Pointer Dereference',
		'watchdog-timeout':    'Watchdog Timeout',
		'timing-violation':    'Timing Violation',
		'assertion-failure':   'Assertion Failure',
		'memory-access-fault': 'Memory Access Fault',
		'divide-by-zero':      'Divide by Zero',
		'unaligned-access':    'Unaligned Memory Access',
		'isr-stack-overflow':  'ISR Stack Overflow',
		'double-fault':        'Double Fault',
		'privilege-violation': 'Privilege Violation',
		'resource-leak':       'Resource Leak',
		'deadlock':            'Deadlock Detected',
		'data-race':           'Data Race',
		'undefined-behaviour': 'Undefined Behaviour',
		'custom':              'Runtime Violation',
	};
	return labels[kind] ?? 'Runtime Violation';
}
