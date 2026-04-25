/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Migration Effort Estimator
 *
 * Produces heuristic `IMigrationEffortEstimate` per unit using a weighted
 * multi-factor model. No machine learning is required — the model is calibrated
 * against typical enterprise legacy migration projects.
 *
 * ## Scoring Model
 *
 * Each factor contributes "difficulty points" (0–∞):
 *
 * | Factor                        | Points Added                                          |
 * |-------------------------------|-------------------------------------------------------|
 * | Logical lines (LL)            | <50 \u2192 0  │  50-200 \u2192 1  │  200-500 \u2192 2  │  >500 \u2192 4 |
 * | Cyclomatic complexity (CC)    | <5 \u2192 0   │  5-10 \u2192 1    │  10-20 \u2192 2    │  >20 \u2192 4  |
 * | Nesting depth                 | ≤3 \u2192 0   │  4-5 \u2192 1     │  >5 \u2192 2                   |
 * | Parameter count               | ≤5 \u2192 0   │  6-10 \u2192 1    │  >10 \u2192 2                  |
 * | External calls                | +1 if present                                         |
 * | Database operations           | +1 if present                                         |
 * | File I/O                      | +1 if present                                         |
 * | UI interaction                | +1 if present                                         |
 * | Regulated fields (count)      | ≤2 \u2192 0   │  3-5 \u2192 1     │  >5 \u2192 3                   |
 * | GRC violations (count)        | ≤2 \u2192 0   │  3-10 \u2192 1    │  >10 \u2192 2                  |
 * | Tech debt items (count)       | 0 \u2192 0    │  1-3 \u2192 1     │  >3 \u2192 2                   |
 * | Language difficulty factor    | Applied as a multiplier after summing raw points      |
 * | Complexity of target language | +0-2 additional points for paradigm mismatch          |
 *
 * ## Language Difficulty Factors (multiplier)
 *
 * | Source Lang         | Multiplier | Rationale                                          |
 * |---------------------|------------|----------------------------------------------------|
 * | COBOL               | 2.5        | Unique idioms, FD/copybook expansion, GRC baggage  |
 * | PL/I                | 2.2        | Complex data types, ON conditions, pointer arith   |
 * | RPG                 | 2.0        | Fixed-format, indicator variables, RPG cycle       |
 * | JCL                 | 1.8        | Step sequencing, DD statements, conditional steps  |
 * | PL/SQL / T-SQL      | 1.4        | Implicit cursors, package state, bulk ops          |
 * | Java / Kotlin       | 1.3        | Verbose but structured                             |
 * | C# / VB.NET         | 1.3        | Framework coupling                                 |
 * | C / C++             | 1.6        | Manual memory, undefined behaviour, macros         |
 * | Embedded C          | 2.2        | Register maps, ISR, MISRA, HAL migration           |
 * | Assembler           | 3.0        | Highest; register semantics, calling conventions   |
 * | AUTOSAR             | 2.8        | RTE port re-mapping, manifest regen, ara::com      |
 * | CAN DBC             | 2.0        | OD mapping, PDO/SDO, COB-ID assignment             |
 * | IEC 61131-3         | 2.3        | Scan-cycle semantics, safety FB, vendor extensions |
 * | TTCN-3              | 2.5        | Verdict semantics, altstep \u2192 async receive         |
 * | Energy / IEC 61850  | 2.4        | GOOSE/SV, DNP3, OPC-UA mapping                     |
 * | Python              | 1.0        | Readable, minimal ceremony                         |
 * | TypeScript / JS     | 1.0        | Readable, but async complexity adds                |
 * | Go                  | 1.1        | Explicit error handling adds translation ceremony  |
 * | Rust                | 1.5        | Ownership/borrow complexity                        |
 * | Scala               | 1.4        | Functional + OO hybrid, implicits                  |
 * | Groovy / PHP        | 1.2        | Dynamic typing, framework magic                    |
 * | Ruby                | 1.1        | Metaprogramming, DSL patterns                      |
 * | Others              | 1.2        | Default moderate difficulty                        |
 *
 * ## Band \u2192 Hours Mapping
 *
 * | Band    | Hours (Low) | Hours (High) | Typical Effort                              |
 * |---------|-------------|--------------|---------------------------------------------|
 * | trivial |  0.5        |  2           | Rename / copy with minor adaptation         |
 * | small   |  2          |  8           | Simple utility class / utility paragraph    |
 * | medium  |  8          |  24          | Business-logic unit with moderate complexity|
 * | large   | 24          |  80          | Complex unit with regulated data / GRC ops  |
 * | xlarge  | 80          | 200+         | God unit, massive complexity, critical GRC  |
 */

import { IMigrationEffortEstimate, MigrationEffortBand, IUnitComplexity } from './discoveryTypes.js';

// ─── Public API ───────────────────────────────────────────────────────────────

export interface IEffortInput {
	unitId: string;
	lang: string;
	complexity: IUnitComplexity;
	regulatedFieldCount: number;
	grcViolationCount: number;
	techDebtItemCount: number;
}

/**
 * Estimate migration effort for a single unit.
 */
export function estimateMigrationEffort(input: IEffortInput): IMigrationEffortEstimate {
	const { unitId, lang, complexity, regulatedFieldCount, grcViolationCount, techDebtItemCount } = input;

	const drivers: string[] = [];
	let rawPoints = 0;

	// ── Logical lines ───────────────────────────────────────────────────
	const ll = complexity.logicalLineCount;
	if (ll > 500)       { rawPoints += 4; drivers.push(`${ll} logical lines (very large)`); }
	else if (ll > 200)  { rawPoints += 2; drivers.push(`${ll} logical lines (large)`); }
	else if (ll >= 50)  { rawPoints += 1; drivers.push(`${ll} logical lines`); }

	// ── Cyclomatic complexity ────────────────────────────────────────────
	const cc = complexity.cyclomaticComplexity;
	if (cc > 20)        { rawPoints += 4; drivers.push(`CC=${cc} (very high)`); }
	else if (cc > 10)   { rawPoints += 2; drivers.push(`CC=${cc} (high)`); }
	else if (cc >= 5)   { rawPoints += 1; drivers.push(`CC=${cc}`); }

	// ── Nesting depth ────────────────────────────────────────────────────
	const nd = complexity.nestingDepth;
	if (nd > 5)         { rawPoints += 2; drivers.push(`nesting depth ${nd}`); }
	else if (nd >= 4)   { rawPoints += 1; }

	// ── Parameter count ──────────────────────────────────────────────────
	const pc = complexity.paramCount;
	if (pc > 10)        { rawPoints += 2; drivers.push(`${pc} parameters`); }
	else if (pc > 5)    { rawPoints += 1; }

	// ── I/O operations ──────────────────────────────────────────────────
	if (complexity.hasExternalCalls) { rawPoints += 1; drivers.push('external API/service calls'); }
	if (complexity.hasDatabaseOps)   { rawPoints += 1; drivers.push('database operations'); }
	if (complexity.hasFileOps)       { rawPoints += 1; drivers.push('file I/O'); }
	if (complexity.hasUIInteraction) { rawPoints += 1; drivers.push('UI interaction'); }

	// ── Regulated fields ────────────────────────────────────────────────
	if (regulatedFieldCount > 5)     { rawPoints += 3; drivers.push(`${regulatedFieldCount} regulated data fields`); }
	else if (regulatedFieldCount > 2) { rawPoints += 1; drivers.push(`${regulatedFieldCount} regulated fields`); }

	// ── GRC violations ──────────────────────────────────────────────────
	if (grcViolationCount > 10)      { rawPoints += 2; drivers.push(`${grcViolationCount} GRC violations`); }
	else if (grcViolationCount > 2)  { rawPoints += 1; }

	// ── Tech debt ────────────────────────────────────────────────────────
	if (techDebtItemCount > 3)       { rawPoints += 2; drivers.push(`${techDebtItemCount} tech debt items`); }
	else if (techDebtItemCount > 0)  { rawPoints += 1; }

	// ── Safety-critical language surcharge ────────────────────────────────
	const SAFETY_CRITICAL_LANGS = new Set([
		'embedded-c', 'embedded-cpp', 'assembler', 'autosar', 'iec61131',
		'ttcn3', 'energy', 'iiot-ot', 'can-dbc', 'flexray',
	]);
	if (SAFETY_CRITICAL_LANGS.has(lang)) {
		rawPoints += 3;
		drivers.push('safety-critical language (compliance documentation overhead)');
	}

	// ── Language difficulty multiplier ───────────────────────────────────
	const multiplier = LANGUAGE_DIFFICULTY[lang] ?? 1.2;
	const adjustedPoints = rawPoints * multiplier;

	// ── Map to band ──────────────────────────────────────────────────────
	let band: MigrationEffortBand;
	if (adjustedPoints < 2)       { band = 'trivial'; }
	else if (adjustedPoints < 5)  { band = 'small'; }
	else if (adjustedPoints < 10) { band = 'medium'; }
	else if (adjustedPoints < 18) { band = 'large'; }
	else                           { band = 'xlarge'; }

	const [hoursLow, hoursHigh] = BAND_HOURS[band];

	// ── Confidence ───────────────────────────────────────────────────────
	let confidence: IMigrationEffortEstimate['confidence'];
	if (cc > 0 && ll > 0) {
		confidence = regulatedFieldCount > 0 || grcViolationCount > 5 ? 'medium' : 'high';
	} else {
		confidence = 'low'; // insufficient metrics
	}

	return {
		unitId,
		effortBand:         band,
		estimatedHoursLow:  hoursLow,
		estimatedHoursHigh: hoursHigh,
		drivers,
		confidence,
	};
}

/**
 * Aggregate effort estimates into a summary distribution.
 */
export function summariseEffort(
	estimates: IMigrationEffortEstimate[],
): Record<MigrationEffortBand, number> {
	const dist: Record<MigrationEffortBand, number> = {
		trivial: 0, small: 0, medium: 0, large: 0, xlarge: 0,
	};
	for (const e of estimates) { dist[e.effortBand]++; }
	return dist;
}

/**
 * Compute total estimated hours range across all estimates.
 */
export function totalEffortHours(estimates: IMigrationEffortEstimate[]): { low: number; high: number } {
	return estimates.reduce(
		(acc, e) => ({ low: acc.low + e.estimatedHoursLow, high: acc.high + e.estimatedHoursHigh }),
		{ low: 0, high: 0 },
	);
}


// ─── Constants ────────────────────────────────────────────────────────────────

const LANGUAGE_DIFFICULTY: Record<string, number> = {
	// Mainframe / legacy
	cobol:          2.5,
	pl1:            2.2,
	rpg:            2.0,
	jcl:            1.8,
	// Database languages
	plsql:          1.4,
	sql:            1.3,
	// Systems languages
	c:              1.6,
	cpp:            1.6,
	rust:           1.5,
	// ── Market vertical: Firmware & Embedded ─────────────────────────────
	'embedded-c':   2.2,  // Bare-metal C: register maps, ISR semantics, HAL migration, MISRA compliance
	'embedded-cpp': 2.0,  // Embedded C++: same + vtable / exception constraints
	assembler:      3.0,  // Assembly \u2192 C/Rust: highest effort; register semantics, calling conventions
	svd:            1.0,  // CMSIS SVD \u2192 code generation — simple structural transform
	'linker-script': 1.8, // LD/SCF \u2192 target toolchain: memory region mapping, VMA/LMA
	cmake:          0.8,  // CMake \u2192 CMake (cross-compilation refinement)
	// ── Market vertical: Automotive ──────────────────────────────────────
	autosar:        2.8,  // AUTOSAR Classic CP \u2192 Adaptive AP: RTE port re-mapping, manifest regen
	'can-dbc':      2.0,  // CAN DBC \u2192 CANopen: OD mapping, PDO configuration, COB-ID assignment
	'lin-ldf':      1.8,  // LIN LDF \u2192 ISO 17987: frame schedule, NAD mapping
	flexray:        2.4,  // FlexRay OPF \u2192 Ethernet TSN: static slot \u2192 TDMA schedule translation
	// ── Market vertical: Industrial / PLC ────────────────────────────────
	iec61131:       2.3,  // IEC 61131-3 Ladder/ST \u2192 Structured Text or Python: scan-cycle semantics
	// ── Market vertical: Telecom & 5G ────────────────────────────────────
	ttcn3:          2.5,  // TTCN-3 \u2192 PyTest/Robot: verdict semantics, altstep \u2192 async receive
	// ── Market vertical: Energy / OT ─────────────────────────────────────
	energy:         2.4,  // IEC 61850 / DNP3 / SCADA \u2192 OPC-UA + MQTT SparkplugB
	'iiot-ot':      2.2,  // IIoT/OT protocol migration: EtherCAT \u2192 Profinet, CANopen \u2192 EtherCAT
	// Functional / complex
	scala:          1.4,
	haskell:        1.5,
	erlang:         1.4,
	elixir:         1.3,
	// Object-oriented
	java:           1.3,
	kotlin:         1.2,
	csharp:         1.3,
	vb:             1.4,
	vbnet:          1.4,
	groovy:         1.2,
	// Web / scripting
	typescript:     1.0,
	javascript:     1.0,
	python:         1.0,
	ruby:           1.1,
	php:            1.2,
	perl:           1.3,
	// Modern systems
	go:             1.1,
	swift:          1.1,
	dart:           1.1,
	// Markup / config
	xml:            0.6,
	json:           0.4,
	yaml:           0.4,
	toml:           0.4,
};

const BAND_HOURS: Record<MigrationEffortBand, [number, number]> = {
	trivial: [0.5, 2],
	small:   [2,   8],
	medium:  [8,   24],
	large:   [24,  80],
	xlarge:  [80,  240],
};
