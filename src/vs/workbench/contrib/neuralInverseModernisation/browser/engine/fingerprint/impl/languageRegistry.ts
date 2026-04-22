/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Language Registry
 *
 * Maintains a profile for every source language the FingerprintService supports.
 * A language profile maps:
 *   - Aliases → canonical key (so 'COBOL', 'cobol', 'cob' all resolve to 'cobol')
 *   - Whether the language has Layer 1 deterministic patterns in legacyPatternRegistry
 *   - The registry key used to look up patterns (may differ from canonical key)
 *   - Language-specific terminology used in compliance explanations
 *   - Human-readable display name
 *
 * ## Adding a New Language
 *
 * 1. Add its patterns to legacyPatternRegistry.ts (Layer 1 support)
 * 2. Add a ILanguageProfile entry here
 * 3. No other changes required — the FingerprintService picks up registry entries automatically
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Language-specific terminology mapping for compliance descriptions.
 * When the assembler builds invariant descriptions, it substitutes language terms
 * so descriptions read naturally for the source language.
 */
export interface ILanguageTerminology {
	/** What this language calls a "function" (e.g. "paragraph", "procedure", "method") */
	unitTerm: string;
	/** What this language calls a "variable" (e.g. "field", "variable", "identifier") */
	variableTerm: string;
	/** What this language calls packed/exact decimal arithmetic (e.g. "COMP-3 packed decimal", "NUMBER precision") */
	precisionTerm: string;
	/** What this language calls a transaction boundary (e.g. "CICS operation", "COMMIT/ROLLBACK") */
	transactionTerm: string;
	/** Any compliance notes specific to this language */
	complianceNotes?: string;
}

/**
 * A language profile registered in the registry.
 */
export interface ILanguageProfile {
	/** Canonical key — the normalised identifier used internally */
	key: string;

	/** Human-readable display name used in UI and logs */
	displayName: string;

	/**
	 * All aliases that resolve to this canonical key (case-insensitive).
	 * Include file extensions, common shorthands, and dialect names.
	 */
	aliases: string[];

	/**
	 * Whether this language has Layer 1 deterministic pattern support
	 * in legacyPatternRegistry.ts. If false, fingerprinting relies on Layer 2 (LLM) only.
	 */
	hasLayer1Support: boolean;

	/**
	 * The registry key used to look up patterns in LEGACY_PATTERN_REGISTRY.
	 * Usually the same as `key` but may differ for dialect aliases.
	 * Only relevant when hasLayer1Support === true.
	 */
	patternRegistryKey: string;

	/** Language-specific terminology for natural-language compliance descriptions */
	terminology: ILanguageTerminology;

	/**
	 * Primary compliance framework(s) associated with this language in typical deployments.
	 * Informational only — used to enrich the LLM prompt context.
	 */
	primaryFrameworks: string[];
}

// ─── Language Profiles ────────────────────────────────────────────────────────

const LANGUAGE_PROFILES: ILanguageProfile[] = [

	// ── COBOL (IBM z/OS) ──────────────────────────────────────────────────────
	{
		key: 'cobol',
		displayName: 'COBOL (IBM z/OS)',
		aliases: ['cobol', 'cbl', 'cob', 'cpy', 'copybook', 'ibm-cobol', 'enterprise-cobol', 'vs-cobol', 'cobol-ii'],
		hasLayer1Support: true,
		patternRegistryKey: 'cobol',
		terminology: {
			unitTerm: 'paragraph',
			variableTerm: 'field',
			precisionTerm: 'COMP-3 packed decimal',
			transactionTerm: 'CICS operation',
			complianceNotes: 'COBOL COMP-3 fields are always financial. PIC S9V9 clauses mandate decimal precision preservation. CICS commands imply transactional atomicity.',
		},
		primaryFrameworks: ['financial-core', 'pci-dss', 'sox', 'telecom-billing'],
	},

	// ── PL/SQL (Oracle) ───────────────────────────────────────────────────────
	{
		key: 'plsql',
		displayName: 'PL/SQL (Oracle)',
		aliases: ['plsql', 'pl/sql', 'oracle', 'oracle-plsql', 'sql', 'pls'],
		hasLayer1Support: true,
		patternRegistryKey: 'plsql',
		terminology: {
			unitTerm: 'procedure',
			variableTerm: 'variable',
			precisionTerm: 'NUMBER(precision, scale)',
			transactionTerm: 'COMMIT/ROLLBACK boundary',
			complianceNotes: 'PL/SQL NUMBER(p,s) types with scale > 0 are monetary. Autonomous transactions and savepoints affect atomicity boundaries.',
		},
		primaryFrameworks: ['financial-core', 'tax-compliance', 'sox'],
	},

	// ── RPG (IBM AS/400) ──────────────────────────────────────────────────────
	{
		key: 'rpg',
		displayName: 'RPG (IBM AS/400 / IBM i)',
		aliases: ['rpg', 'rpg400', 'rpgle', 'rpgiv', 'rpg-iv', 'rpgii', 'rpg-ii', 'as400', 'ibm-i'],
		hasLayer1Support: true,
		patternRegistryKey: 'rpg',
		terminology: {
			unitTerm: 'procedure',
			variableTerm: 'field',
			precisionTerm: 'packed decimal (P specification)',
			transactionTerm: 'COMMIT/ROLBK boundary',
			complianceNotes: 'RPG P-spec fields (packed decimal) are equivalent to COBOL COMP-3. COMMIT/ROLBK opcodes define transaction boundaries.',
		},
		primaryFrameworks: ['financial-core', 'telecom-billing'],
	},

	// ── NATURAL / ADABAS ──────────────────────────────────────────────────────
	{
		key: 'natural',
		displayName: 'NATURAL (ADABAS)',
		aliases: ['natural', 'nat', 'natural-adabas', 'adabas', 'nsp', 'nbs'],
		hasLayer1Support: true,
		patternRegistryKey: 'natural',
		terminology: {
			unitTerm: 'subprogram',
			variableTerm: 'variable',
			precisionTerm: 'packed numeric (P format)',
			transactionTerm: 'END TRANSACTION / BACKOUT TRANSACTION',
			complianceNotes: 'NATURAL P-format variables are packed decimal. ADABAS FIND/STORE operations are the data access layer — transactional semantics must be preserved.',
		},
		primaryFrameworks: ['financial-core', 'sox'],
	},

	// ── Java EE ───────────────────────────────────────────────────────────────
	{
		key: 'java',
		displayName: 'Java EE',
		aliases: ['java', 'javaee', 'java-ee', 'java8', 'java11', 'java17', 'java21', 'j2ee'],
		hasLayer1Support: true,
		patternRegistryKey: 'java',
		terminology: {
			unitTerm: 'method',
			variableTerm: 'field',
			precisionTerm: 'BigDecimal',
			transactionTerm: '@Transactional boundary',
			complianceNotes: 'Java BigDecimal is the canonical exact decimal type. @Transactional annotations mark transaction boundaries. JPA @Column(precision,scale) indicates monetary columns.',
		},
		primaryFrameworks: ['financial-core', 'pci-dss', 'gdpr-pii'],
	},

	// ── Python 2 ──────────────────────────────────────────────────────────────
	{
		key: 'python',
		displayName: 'Python 2',
		aliases: ['python', 'python2', 'py', 'python3', 'py3', 'python-2'],
		hasLayer1Support: true,
		patternRegistryKey: 'python',
		terminology: {
			unitTerm: 'function',
			variableTerm: 'variable',
			precisionTerm: 'decimal.Decimal',
			transactionTerm: 'database commit/rollback',
			complianceNotes: 'Python decimal.Decimal is required for monetary arithmetic. Float arithmetic is prohibited for regulated amounts. DB commit() calls define transaction boundaries.',
		},
		primaryFrameworks: ['financial-core', 'tax-compliance'],
	},

	// ── VB6 / VBA ─────────────────────────────────────────────────────────────
	{
		key: 'vb6',
		displayName: 'VB6 / VBA',
		aliases: ['vb6', 'vba', 'vb', 'visualbasic', 'visual-basic', 'vbs', 'vbscript'],
		hasLayer1Support: true,
		patternRegistryKey: 'vb6',
		terminology: {
			unitTerm: 'procedure',
			variableTerm: 'variable',
			precisionTerm: 'Currency type',
			transactionTerm: 'ADO transaction (BeginTrans/CommitTrans)',
			complianceNotes: 'VB6 Currency type is a scaled 64-bit integer — exact decimal arithmetic. ADO BeginTrans/CommitTrans define transaction boundaries.',
		},
		primaryFrameworks: ['financial-core', 'tax-compliance'],
	},

	// ── PL/1 ──────────────────────────────────────────────────────────────────
	{
		key: 'pl1',
		displayName: 'PL/1',
		aliases: ['pl1', 'pl/1', 'pli', 'pl-1', 'plone'],
		hasLayer1Support: false,
		patternRegistryKey: 'pl1',
		terminology: {
			unitTerm: 'procedure',
			variableTerm: 'variable',
			precisionTerm: 'FIXED DECIMAL precision attribute',
			transactionTerm: 'COMMIT/ROLLBACK',
			complianceNotes: 'PL/1 FIXED DECIMAL(p,q) attributes are monetary. Layer 1 pattern support pending — Layer 2 LLM extraction provides full coverage.',
		},
		primaryFrameworks: ['financial-core', 'sox'],
	},

	// ── NATURAL/z (BS2000) ────────────────────────────────────────────────────
	{
		key: 'naturalz',
		displayName: 'NATURAL/z (BS2000)',
		aliases: ['naturalz', 'natural-z', 'bs2000', 'natural-bs2000'],
		hasLayer1Support: false,
		patternRegistryKey: 'naturalz',
		terminology: {
			unitTerm: 'subprogram',
			variableTerm: 'variable',
			precisionTerm: 'packed numeric',
			transactionTerm: 'END TRANSACTION',
			complianceNotes: 'Siemens BS2000 dialect of NATURAL. Similar patterns to standard NATURAL/ADABAS but with BS2000-specific system calls.',
		},
		primaryFrameworks: ['financial-core'],
	},

	// ── Assembler (z/OS) ──────────────────────────────────────────────────────
	{
		key: 'assembler',
		displayName: 'Assembler (z/OS)',
		aliases: ['assembler', 'asm', 'hlasm', 'ibm-asm', 'zos-asm', 'macro-asm'],
		hasLayer1Support: false,
		patternRegistryKey: 'assembler',
		terminology: {
			unitTerm: 'routine',
			variableTerm: 'storage location',
			precisionTerm: 'packed decimal (PL/ZL storage)',
			transactionTerm: 'SVC or CICS call boundary',
			complianceNotes: 'z/OS Assembler packed decimal (PL/ZL) instructions are equivalent to COBOL COMP-3. Pattern extraction requires expert LLM analysis.',
		},
		primaryFrameworks: ['financial-core', 'sox'],
	},

	// ── Fortran 77/90 ─────────────────────────────────────────────────────────
	{
		key: 'fortran',
		displayName: 'Fortran 77/90',
		aliases: ['fortran', 'fortran77', 'fortran90', 'fortran95', 'f77', 'f90', 'f95', 'for', 'f'],
		hasLayer1Support: false,
		patternRegistryKey: 'fortran',
		terminology: {
			unitTerm: 'subroutine',
			variableTerm: 'variable',
			precisionTerm: 'DOUBLE PRECISION',
			transactionTerm: 'I/O operation',
			complianceNotes: 'Fortran DOUBLE PRECISION and REAL(8) are used for monetary computations. COMMON blocks share state across routines — mutation order matters for compliance.',
		},
		primaryFrameworks: ['financial-core'],
	},

	// ── Angular 1 (JavaScript) ────────────────────────────────────────────────
	{
		key: 'angular1',
		displayName: 'Angular 1 (JavaScript)',
		aliases: ['angular1', 'angularjs', 'angular-1', 'ng1', 'javascript', 'js'],
		hasLayer1Support: false,
		patternRegistryKey: 'angular1',
		terminology: {
			unitTerm: 'service',
			variableTerm: 'property',
			precisionTerm: 'Number / custom precision library',
			transactionTerm: '$http call',
			complianceNotes: 'JavaScript Number type uses IEEE 754 double precision — monetary arithmetic must use a decimal library (decimal.js, bignumber.js). REST calls are stateless — transactionality is server-side.',
		},
		primaryFrameworks: ['financial-core', 'pci-dss'],
	},

	// ── C / C++ (generic financial) ───────────────────────────────────────────
	{
		key: 'c',
		displayName: 'C / C++',
		aliases: ['c', 'c++', 'cpp', 'cxx', 'cc', 'h', 'hpp', 'hxx'],
		hasLayer1Support: false,
		patternRegistryKey: 'c',
		terminology: {
			unitTerm: 'function',
			variableTerm: 'variable',
			precisionTerm: 'double / float monetary',
			transactionTerm: 'database commit boundary',
			complianceNotes: 'C/C++ double and float are IEEE 754 — monetary arithmetic requires explicit rounding. No native decimal type; regulated fields should use scaled integers or external libraries.',
		},
		primaryFrameworks: ['financial-core', 'sox'],
	},

	// ── Embedded C (firmware) ────────────────────────────────────────────────
	{
		key: 'embedded-c',
		displayName: 'Embedded C (firmware)',
		aliases: ['embedded-c', 'embedded-cpp', 'embedded-c++', 'mcu-c', 'firmware-c', 'bare-metal-c'],
		hasLayer1Support: true,
		patternRegistryKey: 'embedded-c',
		terminology: {
			unitTerm: 'function',
			variableTerm: 'variable',
			precisionTerm: 'fixed-point arithmetic',
			transactionTerm: 'ISR / critical section boundary',
			complianceNotes: 'Safety-critical embedded C must comply with MISRA-C:2012 and IEC 61508. ISR handlers, watchdog refresh points, and peripheral register accesses are always regulated.',
		},
		primaryFrameworks: ['iec-61508', 'misra-c', 'iso-26262'],
	},

	// ── IEC 61131-3 / PLC ────────────────────────────────────────────────────
	{
		key: 'iec61131',
		displayName: 'IEC 61131-3 (PLC / IPC)',
		aliases: ['iec61131', 'iec-61131', 'plc', 'structured-text', 'st', 'ladder', 'ladder-diagram', 'ld', 'fbd', 'il', 'sfc', 'pou'],
		hasLayer1Support: true,
		patternRegistryKey: 'iec61131',
		terminology: {
			unitTerm: 'function block',
			variableTerm: 'variable',
			precisionTerm: 'REAL / LREAL fixed arithmetic',
			transactionTerm: 'scan cycle boundary',
			complianceNotes: 'IEC 61131-3 programs run in deterministic scan cycles. Safety function blocks (SF_ prefix) are normative IEC 61508 SIL-rated components and must never be simplified.',
		},
		primaryFrameworks: ['iec-61508', 'iec-61131', 'iec-62443'],
	},

	// ── AUTOSAR ──────────────────────────────────────────────────────────────
	{
		key: 'autosar',
		displayName: 'AUTOSAR Classic / Adaptive',
		aliases: ['autosar', 'autosar-classic', 'autosar-adaptive', 'autosar-cp', 'autosar-ap', 'arxml'],
		hasLayer1Support: true,
		patternRegistryKey: 'autosar',
		terminology: {
			unitTerm: 'runnable',
			variableTerm: 'port element',
			precisionTerm: 'fixed-point or IEEE 754 with compu-method scaling',
			transactionTerm: 'runnable execution / RTE activation',
			complianceNotes: 'AUTOSAR SWCs communicate exclusively via the RTE (Classic) or ara::com (Adaptive). E2E protection checksums on safety-relevant signals are mandatory for ISO 26262 ASIL compliance.',
		},
		primaryFrameworks: ['autosar', 'iso-26262', 'misra-c'],
	},

	// ── CAN DBC / CAN-FD ────────────────────────────────────────────────────
	{
		key: 'can-dbc',
		displayName: 'CAN DBC / CAN-FD Network',
		aliases: ['can-dbc', 'dbc', 'can', 'can-fd', 'candb', 'lin-ldf', 'flexray'],
		hasLayer1Support: false,
		patternRegistryKey: 'embedded-c',
		terminology: {
			unitTerm: 'message',
			variableTerm: 'signal',
			precisionTerm: 'signal scaling (factor / offset)',
			transactionTerm: 'frame transmission cycle',
			complianceNotes: 'CAN DBC signals have scale factor and offset defining physical unit mapping. Safety-relevant signals require AUTOSAR E2E protection or CRC. Cycle time violations break real-time guarantees.',
		},
		primaryFrameworks: ['iso-26262', 'autosar', 'iec-61508'],
	},

	// ── Assembly (embedded ARM/AVR) ──────────────────────────────────────────
	{
		key: 'assembler',
		displayName: 'Assembly (ARM / AVR / RISC-V)',
		aliases: ['assembler', 'assembly', 'asm', 's', 'arm-asm', 'avr-asm', 'riscv-asm'],
		hasLayer1Support: true,
		patternRegistryKey: 'assembler',
		terminology: {
			unitTerm: 'subroutine',
			variableTerm: 'register / storage location',
			precisionTerm: 'integer arithmetic (no floating point)',
			transactionTerm: 'interrupt return / SVC boundary',
			complianceNotes: 'Assembly ISR handlers control interrupt entry/exit and must preserve all caller-saved registers. ARM SVC and AVR CLI/SEI instructions directly control safety-critical interrupt enable state.',
		},
		primaryFrameworks: ['iec-61508', 'misra-c'],
	},

	// ── Rust (embedded) ──────────────────────────────────────────────────────
	{
		key: 'rust',
		displayName: 'Rust (embedded)',
		aliases: ['rust', 'rs', 'embedded-rust', 'rust-embedded'],
		hasLayer1Support: false,
		patternRegistryKey: 'embedded-c',
		terminology: {
			unitTerm: 'function',
			variableTerm: 'binding',
			precisionTerm: 'integer / fixed-point (no_std)',
			transactionTerm: 'critical section / cortex-m::interrupt::free',
			complianceNotes: 'Embedded Rust uses no_std. Critical sections use cortex_m::interrupt::free(). Unsafe blocks accessing volatile hardware registers are always safety-regulated.',
		},
		primaryFrameworks: ['iec-61508', 'misra-c'],
	},

	// ── SVD (CMSIS peripheral description) ──────────────────────────────────
	{
		key: 'svd',
		displayName: 'CMSIS SVD (Peripheral Description)',
		aliases: ['svd', 'cmsis-svd', 'peripheral-description'],
		hasLayer1Support: false,
		patternRegistryKey: 'embedded-c',
		terminology: {
			unitTerm: 'peripheral',
			variableTerm: 'register / bit field',
			precisionTerm: 'bit-field mask / reset value',
			transactionTerm: 'register read-modify-write',
			complianceNotes: 'SVD peripheral descriptions define the hardware register map. Bit fields with "read-write" access and reset values 0 are safety-critical configuration registers.',
		},
		primaryFrameworks: ['iec-61508'],
	},

	// ── TTCN-3 (Telecom protocol testing) ────────────────────────────────────
	{
		key: 'ttcn3',
		displayName: 'TTCN-3 (3GPP Protocol Testing)',
		aliases: ['ttcn3', 'ttcn', 'ttcn-3', 'ttcnpp'],
		hasLayer1Support: false,
		patternRegistryKey: 'telecom',
		terminology: {
			unitTerm: 'testcase',
			variableTerm: 'component variable',
			precisionTerm: 'integer / float (TTCN-3 basic types)',
			transactionTerm: 'test verdict / port send-receive',
			complianceNotes: '3GPP TTCN-3 test suites exercise protocol conformance. Subscriber identity (IMSI/TMSI) and security keys (K/Kenc/Kint) appearing in test data are regulated PII/cryptographic material.',
		},
		primaryFrameworks: ['iec-62443'],
	},

	// ── Energy / Critical Infrastructure ─────────────────────────────────────
	{
		key: 'energy',
		displayName: 'Energy / Critical Infrastructure (IEC 61850 / DNP3)',
		aliases: ['energy', 'iec61850', 'iec-61850', 'dnp3', 'scada-ot', 'substation'],
		hasLayer1Support: true,
		patternRegistryKey: 'energy',
		terminology: {
			unitTerm: 'logical node',
			variableTerm: 'data attribute',
			precisionTerm: 'REAL32 / FLOAT process value',
			transactionTerm: 'GOOSE / SV publication cycle',
			complianceNotes: 'IEC 61850 GOOSE messages have sub-4ms timing requirements for protection relay functions. XCBR trip/close operations are always safety-regulated. IEC 62443 SL2+ required for external access.',
		},
		primaryFrameworks: ['iec-61508', 'iec-62443'],
	},

	// ── Industrial IoT / OT ───────────────────────────────────────────────────
	{
		key: 'iiot-ot',
		displayName: 'Industrial IoT & OT (EtherCAT / CANopen / MQTT)',
		aliases: ['iiot-ot', 'iiot', 'industrial-iot', 'ot', 'ethercat', 'canopen', 'profinet'],
		hasLayer1Support: true,
		patternRegistryKey: 'iiot-ot',
		terminology: {
			unitTerm: 'function block / process data object',
			variableTerm: 'PDO signal',
			precisionTerm: 'REAL32 / INT32 process value with scaling',
			transactionTerm: 'PDO cycle / MQTT publish interval',
			complianceNotes: 'EtherCAT/Profinet real-time field data has hard latency requirements. CANopen NMT state transitions are safety-critical for machine axes. MQTT cloud bridges must respect IEC 62443 Zone/Conduit boundaries.',
		},
		primaryFrameworks: ['iec-61508', 'iec-62443'],
	},

	// ── Automotive (ISO 26262) ────────────────────────────────────────────────
	{
		key: 'automotive',
		displayName: 'Automotive Software (ISO 26262 / AUTOSAR)',
		aliases: ['automotive', 'iso26262', 'iso-26262', 'asil', 'vehicle-software'],
		hasLayer1Support: true,
		patternRegistryKey: 'automotive',
		terminology: {
			unitTerm: 'runnable / SWC',
			variableTerm: 'port element / signal',
			precisionTerm: 'fixed-point with compu-method',
			transactionTerm: 'RTE activation / CAN frame transmission',
			complianceNotes: 'ISO 26262 ASIL-D code requires formal verification and diverse redundancy. Safety mechanisms (diagnostic coverage, MPF independence) must be preserved across translation. CAN signals carry ASIL-rated torque/brake commands.',
		},
		primaryFrameworks: ['iso-26262', 'autosar', 'misra-c'],
	},
];


// ─── Registry Implementation ──────────────────────────────────────────────────

/** Alias map: lowercase alias → canonical profile key */
const ALIAS_MAP = new Map<string, string>();

/** Profile map: canonical key → ILanguageProfile */
const PROFILE_MAP = new Map<string, ILanguageProfile>();

for (const profile of LANGUAGE_PROFILES) {
	PROFILE_MAP.set(profile.key, profile);
	for (const alias of profile.aliases) {
		ALIAS_MAP.set(alias.toLowerCase(), profile.key);
	}
}


// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve a raw language string (user-supplied or from file extension) to a
 * canonical profile. Returns undefined if the language is not recognised.
 *
 * Matching is case-insensitive. Whitespace and hyphens are normalised.
 */
export function resolveLanguageProfile(rawLanguage: string): ILanguageProfile | undefined {
	const normalised = rawLanguage.toLowerCase().replace(/\s+/g, '-');
	const canonicalKey = ALIAS_MAP.get(normalised);
	if (!canonicalKey) {
		return undefined;
	}
	return PROFILE_MAP.get(canonicalKey);
}

/**
 * Get the canonical language key for a raw language string.
 * Returns the original string lowercased if not found in registry.
 */
export function canonicaliseLanguage(rawLanguage: string): string {
	const profile = resolveLanguageProfile(rawLanguage);
	return profile ? profile.key : rawLanguage.toLowerCase();
}

/**
 * Returns true if the given language has Layer 1 deterministic extraction support.
 * Languages without Layer 1 still fingerprint via Layer 2 (LLM).
 */
export function hasLayer1Support(rawLanguage: string): boolean {
	const profile = resolveLanguageProfile(rawLanguage);
	return profile?.hasLayer1Support ?? false;
}

/**
 * Returns the pattern registry key to look up in LEGACY_PATTERN_REGISTRY for a given language.
 * Returns the canonical key if the profile exists, or the raw key if not found.
 */
export function getPatternRegistryKey(rawLanguage: string): string {
	const profile = resolveLanguageProfile(rawLanguage);
	return profile?.patternRegistryKey ?? rawLanguage.toLowerCase();
}

/**
 * Returns the terminology profile for a language, or a sensible default
 * if the language is not in the registry.
 */
export function getTerminology(rawLanguage: string): ILanguageTerminology {
	const profile = resolveLanguageProfile(rawLanguage);
	return profile?.terminology ?? {
		unitTerm: 'function',
		variableTerm: 'variable',
		precisionTerm: 'decimal arithmetic',
		transactionTerm: 'transaction boundary',
	};
}

/**
 * Returns all registered language profiles.
 */
export function getAllLanguageProfiles(): ILanguageProfile[] {
	return [...PROFILE_MAP.values()];
}

/**
 * Returns the display name for a language, or the raw string if not found.
 */
export function getLanguageDisplayName(rawLanguage: string): string {
	const profile = resolveLanguageProfile(rawLanguage);
	return profile?.displayName ?? rawLanguage;
}
