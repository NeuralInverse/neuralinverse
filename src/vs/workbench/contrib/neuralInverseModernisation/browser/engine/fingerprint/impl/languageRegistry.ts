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

	// ── C / C++ ───────────────────────────────────────────────────────────────
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
