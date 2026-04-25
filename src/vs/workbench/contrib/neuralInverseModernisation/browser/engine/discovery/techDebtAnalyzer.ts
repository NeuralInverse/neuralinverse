/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Tech Debt Analyzer
 *
 * Detects 17 generic + 9 firmware/industrial debt categories from source text
 * without an AST. Works universally across all supported languages.
 *
 * ## Debt Categories & Detection Strategy
 *
 * ### Generic
 * | Category                  | Detection Heuristic                                          |
 * |---------------------------|--------------------------------------------------------------|
 * | god-unit                  | CC > 20 AND logical lines > 300                              |
 * | dead-code                 | Unit never referenced in any rawImport or call expression    |
 * | code-clone                | Trigram fingerprint similarity > 0.75 among units            |
 * | magic-number              | Bare numeric literal not in named const / #define / final    |
 * | hardcoded-credential      | password= / secret= / api_key= followed by non-empty string  |
 * | hardcoded-url             | http:// / https:// literals in non-comment source             |
 * | deep-nesting              | Nesting depth > 5 (brace/indent)                             |
 * | long-parameter-list       | Function/method with > 7 parameters                          |
 * | missing-error-handling    | Has I/O ops (file/DB/network) but no error handling keywords  |
 * | commented-out-code        | Block of \u2265 3 consecutive comment lines that contain keywords  |
 * | todo-fixme                | TODO / FIXME / HACK / XXX / NOSONAR / BUG markers           |
 * | implicit-type-coercion    | == in JS/PHP, auto-widening cast patterns                    |
 * | unbounded-loop            | while(true) / loop / DO UNTIL without VARYING                |
 * | copy-paste-cobol          | Identical COBOL paragraph bodies                             |
 * | goto-usage                | GOTO / GOBACK / jump / computed-goto statements              |
 * | global-state              | Module-level mutable var / field outside class               |
 * | no-unit-tests             | Unit name not matched by any test file in the project        |
 *
 * ### Firmware / Industrial / Telecom / Energy
 * | Category                  | Detection Heuristic                                          |
 * |---------------------------|--------------------------------------------------------------|
 * | unsafe-pointer-arithmetic | Cast to volatile uint*_t pointer at raw hex address (reg map)|
 * | isr-reentrance-risk       | ISR body accesses a global variable with no critical section  |
 * | misra-c-critical-violation| MISRA Rule 11.4 (ptr cast), 14.4 (non-bool branch), 17.3 (int promo)|
 * | hardware-dependency       | MCU-specific register macro with no HAL alias (#define GPIOx) |
 * | watchdog-gap              | Function body > 100 lines with no watchdog refresh call      |
 * | autosar-rte-dependency    | Rte_Read/Write with no matching Adaptive ara::com mapping hint|
 * | e2e-protection-gap        | Com_SendSignal / Rte_Write with E2E profile but no E2E wrapper|
 * | security-key-material     | 3GPP AS/NAS key arrays or SUPI/SUCI inline material detected  |
 * | goose-protection-relay    | IEC 61850 GOOSE XCBR/XSWI trip command bridged via TCP/HTTP  |
 */

import { ITechDebtItem, IUnitComplexity } from './discoveryTypes.js';

// \u2500\u2500\u2500 Public API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IDebtAnalysisInput {
	unitId: string;
	unitName: string;
	content: string;
	lang: string;
	complexity: IUnitComplexity;
	/** All unit IDs in the project (for dead code detection). */
	allUnitIds: string[];
	/** All raw call expressions across the project (for dead code). */
	allCallExpressions: string[];
	/** All unit IDs from test files (for no-unit-test detection). */
	testUnitIds: string[];
}

/**
 * Analyse a single unit for technical debt.
 * Returns all debt items found (may be empty).
 */
export function analyzeUnitDebt(input: IDebtAnalysisInput): ITechDebtItem[] {
	const items: ITechDebtItem[] = [];
	const { unitId, unitName, content, lang, complexity } = input;
	const lines = content.split('\n');

	// \u2500\u2500 god-unit \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (complexity.cyclomaticComplexity > 20 && complexity.logicalLineCount > 300) {
		items.push({
			unitId, category: 'god-unit',
			description: `Unit has CC=${complexity.cyclomaticComplexity} and ${complexity.logicalLineCount} logical lines \u2014 likely doing too much.`,
			severity: 'error',
			migrationImpact: 'Must be decomposed before migration; direct translation will produce an unmaintainable target module.',
		});
	} else if (complexity.cyclomaticComplexity > 15 && complexity.logicalLineCount > 200) {
		items.push({
			unitId, category: 'god-unit',
			description: `Unit has CC=${complexity.cyclomaticComplexity} and ${complexity.logicalLineCount} logical lines \u2014 approaching god-unit territory.`,
			severity: 'warning',
			migrationImpact: 'Consider decomposing before or during migration to reduce translator complexity.',
		});
	}

	// \u2500\u2500 deep-nesting \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (complexity.nestingDepth > 7) {
		items.push({
			unitId, category: 'deep-nesting',
			description: `Maximum nesting depth of ${complexity.nestingDepth} exceeds the critical threshold of 7.`,
			severity: 'error',
			lineNumber: undefined,
			migrationImpact: 'Deep nesting is language-specific and must be refactored using early returns, guard clauses, or extracted methods in the target.',
		});
	} else if (complexity.nestingDepth > 5) {
		items.push({
			unitId, category: 'deep-nesting',
			description: `Nesting depth of ${complexity.nestingDepth} exceeds the recommended maximum of 5.`,
			severity: 'warning',
			migrationImpact: 'May require structural refactoring in the target language.',
		});
	}

	// \u2500\u2500 long-parameter-list \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (complexity.paramCount > 10) {
		items.push({
			unitId, category: 'long-parameter-list',
			description: `Unit entry point has ${complexity.paramCount} parameters (threshold: 7).`,
			severity: 'error',
			migrationImpact: 'Introduce a parameter object / DTO in the target to reduce the signature width.',
		});
	} else if (complexity.paramCount > 7) {
		items.push({
			unitId, category: 'long-parameter-list',
			description: `Unit entry point has ${complexity.paramCount} parameters.`,
			severity: 'warning',
			migrationImpact: 'Consider consolidating parameters into a data structure.',
		});
	}

	// \u2500\u2500 missing-error-handling \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	detectMissingErrorHandling(unitId, content, lang, complexity, items);

	// \u2500\u2500 hardcoded-credential \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	detectHardcodedCredentials(unitId, lines, lang, items);

	// \u2500\u2500 hardcoded-url \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	detectHardcodedURLs(unitId, lines, lang, items);

	// \u2500\u2500 magic-number \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	detectMagicNumbers(unitId, lines, lang, items);

	// \u2500\u2500 commented-out-code \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	detectCommentedOutCode(unitId, lines, lang, items);

	// \u2500\u2500 todo-fixme \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	detectTodoFixme(unitId, lines, items);

	// \u2500\u2500 implicit-type-coercion \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	detectImplicitCoercion(unitId, lines, lang, items);

	// \u2500\u2500 unbounded-loop \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	detectUnboundedLoop(unitId, lines, lang, items);

	// \u2500\u2500 goto-usage \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	detectGotoUsage(unitId, lines, lang, items);

	// \u2500\u2500 global-state \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	detectGlobalState(unitId, lines, lang, items);

	// \u2500\u2500 dead-code \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	detectDeadCode(unitId, unitName, lang, input.allCallExpressions, items);

	// \u2500\u2500 no-unit-tests \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	detectNoUnitTests(unitId, unitName, input.testUnitIds, items);

	// \u2500\u2500 Firmware / embedded / industrial debt (market vertical-specific) \u2500\u2500\u2500\u2500
	if (['c', 'cpp', 'embedded-c', 'embedded-cpp', 'assembler'].includes(lang)) {
		detectUnsafePointerArithmetic(unitId, lines, items);
		detectISRReentranceRisk(unitId, lines, items);
		detectMisraCCriticalViolations(unitId, lines, items);
		detectHardwareDependency(unitId, lines, items);
		detectWatchdogGap(unitId, lines, complexity.logicalLineCount, items);
	}
	if (['autosar', 'c', 'cpp', 'embedded-c'].includes(lang)) {
		detectAutosarRteDependency(unitId, lines, items);
		detectE2EProtectionGap(unitId, lines, items);
	}
	if (['c', 'cpp', 'embedded-c', 'typescript', 'javascript', 'python'].includes(lang)) {
		detectSecurityKeyMaterial(unitId, lines, items);
	}
	if (['c', 'cpp', 'python', 'java'].includes(lang)) {
		detectGooseProtectionRelay(unitId, lines, items);
	}
	// \u2500\u2500 Energy / Critical Infrastructure \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (['c', 'cpp', 'embedded-c', 'python', 'java', 'javascript', 'typescript'].includes(lang)) {
		detectDnp3UnencryptedTransport(unitId, lines, items);
		detectModbusHardcodedCoils(unitId, lines, items);
		detectIEC62443CredentialInOTContext(unitId, lines, items);
	}
	if (['iec61131', 'c', 'cpp', 'embedded-c', 'python'].includes(lang)) {
		detectSILRatedFunctionWithoutDiagnosticCoverage(unitId, lines, items);
	}
	// \u2500\u2500 Telecom & 5G \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (['c', 'cpp', 'embedded-c', 'python', 'java'].includes(lang)) {
		detectNASKeyDerivationInCode(unitId, lines, items);
		detectFronthaulLatencyRisk(unitId, lines, items);
		detectGTPTunnelPlaneViolation(unitId, lines, items);
	}
	if (lang === 'ttcn3') {
		detectTTCN3InConcVerdictSuppression(unitId, lines, items);
	}
	// \u2500\u2500 Industrial IoT & OT \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (['c', 'cpp', 'embedded-c', 'python', 'java', 'javascript', 'typescript'].includes(lang)) {
		detectEtherCATTimingViolation(unitId, lines, items);
		detectCANopenSDOTimeout(unitId, lines, items);
		detectMQTTSparkplugBirthCertificate(unitId, lines, items);
		detectOPCUANodeWithoutSecurity(unitId, lines, items);
		detectTSNGateScheduleViolation(unitId, lines, items);
	}
	if (['c', 'cpp', 'embedded-c'].includes(lang)) {
		detectPROFINETDeviceNameHardcoded(unitId, lines, items);
	}

	return items;
}

/**
 * Detect code-clone pairs across a set of units.
 * Returns debt items for each unit that appears to be a clone.
 */
export function detectCodeClones(
	units: Array<{ unitId: string; content: string; lang: string }>,
): ITechDebtItem[] {
	const items: ITechDebtItem[] = [];
	const fingerprints = units.map(u => ({
		unitId: u.unitId,
		trigrams: buildTrigrams(normaliseForClone(u.content, u.lang)),
	}));

	for (let i = 0; i < fingerprints.length; i++) {
		for (let j = i + 1; j < fingerprints.length; j++) {
			const sim = jaccardSimilarity(fingerprints[i].trigrams, fingerprints[j].trigrams);
			if (sim >= 0.80) {
				items.push({
					unitId: fingerprints[i].unitId,
					category: 'code-clone',
					description: `Near-duplicate of unit "${fingerprints[j].unitId}" (similarity: ${(sim * 100).toFixed(0)}%).`,
					severity: sim >= 0.95 ? 'error' : 'warning',
					migrationImpact: 'Clones should be extracted into a shared function/module before migration to avoid duplicating translator effort and introducing inconsistencies.',
				});
			}
		}
	}
	return items;
}

/**
 * Detect copy-paste COBOL paragraphs (identical trimmed body after normalisation).
 */
export function detectCopyPasteCobol(
	units: Array<{ unitId: string; content: string }>,
): ITechDebtItem[] {
	if (units.length === 0) { return []; }
	const items: ITechDebtItem[] = [];
	const normalized = units.map(u => ({ unitId: u.unitId, norm: normaliseCOBOL(u.content) }));
	const bodyCount = new Map<string, string[]>();

	for (const { unitId, norm } of normalized) {
		if (!norm) { continue; }
		const list = bodyCount.get(norm) ?? [];
		list.push(unitId);
		bodyCount.set(norm, list);
	}

	for (const [, dupes] of bodyCount) {
		if (dupes.length < 2) { continue; }
		for (const uid of dupes) {
			items.push({
				unitId: uid,
				category: 'copy-paste-cobol',
				description: `Paragraph body is identical to ${dupes.length - 1} other paragraph(s): ${dupes.filter(d => d !== uid).slice(0, 3).join(', ')}.`,
				severity: 'warning',
				migrationImpact: 'Consolidate into a shared paragraph/section before migration to avoid duplicating translated logic.',
			});
		}
	}
	return items;
}


// \u2500\u2500\u2500 Detection Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectMissingErrorHandling(
	unitId: string, content: string, lang: string,
	complexity: IUnitComplexity, items: ITechDebtItem[],
): void {
	if (!complexity.hasFileOps && !complexity.hasDatabaseOps && !complexity.hasExternalCalls) { return; }

	const hasErrorHandling = (() => {
		switch (lang) {
			case 'java': case 'kotlin': case 'scala': case 'groovy':
				return /\btry\b|\bcatch\b|\bfinally\b/.test(content);
			case 'csharp':
				return /\btry\b|\bcatch\b|\bfinally\b/.test(content);
			case 'python':
				return /\btry\b|\bexcept\b/.test(content);
			case 'javascript': case 'typescript':
				return /\btry\b|\bcatch\b|\b\.catch\s*\(|\b\.then\s*\([^)]*,/.test(content);
			case 'go':
				return /\bif\s+err\b|\berr\s*!=\s*nil\b/.test(content);
			case 'rust':
				return /\bResult\b|\bOption\b|\bunwrap_or\b|\bmatch\b/.test(content);
			case 'ruby':
				return /\brescue\b|\bbegin\b/.test(content);
			case 'php':
				return /\btry\b|\bcatch\b/.test(content);
			case 'swift':
				return /\btry\b|\bcatch\b|\bdo\b/.test(content);
			case 'cobol':
				return /\bON\s+EXCEPTION\b|\bINVALID\s+KEY\b|\bNOT\s+ON\s+EXCEPTION\b/.test(content.toUpperCase());
			case 'plsql':
				return /\bEXCEPTION\b|\bWHEN\s+OTHERS\b/.test(content.toUpperCase());
			default:
				return true; // assume handled for unknown languages
		}
	})();

	if (!hasErrorHandling) {
		const ops = [
			complexity.hasFileOps      && 'file I/O',
			complexity.hasDatabaseOps  && 'database operations',
			complexity.hasExternalCalls && 'external calls',
		].filter(Boolean).join(', ');

		items.push({
			unitId,
			category: 'missing-error-handling',
			description: `Unit performs ${ops} but has no visible error handling.`,
			severity: 'warning',
			migrationImpact: 'Target language translation must add appropriate error handling \u2014 the translator cannot infer intent from missing handlers.',
		});
	}
}

function detectHardcodedCredentials(
	unitId: string, lines: string[], lang: string, items: ITechDebtItem[],
): void {
	const credentialPatterns: RegExp[] = [
		/(?:password|passwd|pwd|pass)\s*[=:]\s*["'`][^"'`\s]{4,}["'`]/i,
		/(?:secret|api[_-]?key|auth[_-]?token|access[_-]?token|bearer[_-]?token)\s*[=:]\s*["'`][^"'`\s]{8,}["'`]/i,
		/(?:private[_-]?key|rsa[_-]?key)\s*[=:]\s*["'`][^"'`\s]{8,}/i,
		/-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
		/(?:jdbc|mongodb|postgresql|mysql|redis|amqp):\/\/[^:@\s]+:[^@\s]{4,}@/i,
	];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Skip comment lines
		if (isCommentLine(line, lang)) { continue; }
		for (const re of credentialPatterns) {
			if (re.test(line)) {
				items.push({
					unitId, category: 'hardcoded-credential',
					description: `Possible hardcoded credential at line ${i + 1}.`,
					severity: 'error',
					lineNumber: i + 1,
					migrationImpact: 'Credentials must be externalised to environment variables or a secrets manager before migration \u2014 never carry forward into target.',
				});
				break;
			}
		}
	}
}

function detectHardcodedURLs(
	unitId: string, lines: string[], lang: string, items: ITechDebtItem[],
): void {
	const urlRe = /https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[^\s"'`>]{10,}/gi;
	for (let i = 0; i < lines.length; i++) {
		if (isCommentLine(lines[i], lang)) { continue; }
		if (urlRe.test(lines[i])) {
			items.push({
				unitId, category: 'hardcoded-url',
				description: `Hardcoded URL detected at line ${i + 1}: "${lines[i].trim().slice(0, 80)}".`,
				severity: 'warning',
				lineNumber: i + 1,
				migrationImpact: 'Externalise to configuration before migration; target environment endpoints will differ.',
			});
			urlRe.lastIndex = 0;
		}
	}
}

function detectMagicNumbers(
	unitId: string, lines: string[], lang: string, items: ITechDebtItem[],
): void {
	// Skip these languages where numeric literals have specific syntax context
	if (['cobol', 'plsql', 'sql', 'rpg', 'pl1', 'jcl'].includes(lang)) { return; }

	// Numbers that are NOT magic: 0, 1, -1, 2, 100 (common), numbers in array literals
	const ALLOWED = new Set(['0', '1', '-1', '2', '100', '1000', '1024', '255', '256', '360', '365', '24', '60']);

	let count = 0;
	for (let i = 0; i < lines.length; i++) {
		if (isCommentLine(lines[i], lang)) { continue; }
		// Strip strings first
		const stripped = lines[i]
			.replace(/"(?:[^"\\]|\\.)*"/g, '""')
			.replace(/'(?:[^'\\]|\\.)*'/g, "''");

		// Look for bare numeric literals not preceded by const/final/static/val/let/define
		const magicRe = /(?<![a-zA-Z_$\w.])(-?\d+\.?\d*)(?![a-zA-Z_$\w.])/g;
		let m: RegExpExecArray | null;
		while ((m = magicRe.exec(stripped)) !== null) {
			const num = m[1];
			if (ALLOWED.has(num)) { continue; }
			// Check if it's in a const/final assignment context
			const linePrefix = stripped.slice(0, m.index);
			if (/\b(?:const|final|static\s+final|val\s|#define\s|CONSTANT|VALUE\s*=)\b/.test(linePrefix)) { continue; }
			count++;
		}
	}

	if (count > 5) {
		items.push({
			unitId, category: 'magic-number',
			description: `Found ${count} potential magic numeric literals. Name them as constants.`,
			severity: count > 15 ? 'error' : 'warning',
			migrationImpact: 'Magic numbers obscure business meaning and make target code fragile if values must differ per environment.',
		});
	}
}

function detectCommentedOutCode(
	unitId: string, lines: string[], lang: string, items: ITechDebtItem[],
): void {
	const CODE_KEYWORDS = /\b(if|for|while|return|function|def|class|import|var|let|const|void|int|String|public|private|PERFORM|MOVE|ADD|COMPUTE)\b/;
	let consecutiveCommentCodeLines = 0;
	let firstLine = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (isCommentContent(line, lang) && CODE_KEYWORDS.test(line)) {
			if (consecutiveCommentCodeLines === 0) { firstLine = i + 1; }
			consecutiveCommentCodeLines++;
		} else {
			if (consecutiveCommentCodeLines >= 3) {
				items.push({
					unitId, category: 'commented-out-code',
					description: `${consecutiveCommentCodeLines} consecutive lines of commented-out code starting at line ${firstLine}.`,
					severity: 'info',
					lineNumber: firstLine,
					migrationImpact: 'Commented-out code increases cognitive load for the translator and should be removed or tracked in version control.',
				});
			}
			consecutiveCommentCodeLines = 0;
		}
	}
}

function detectTodoFixme(
	unitId: string, lines: string[], items: ITechDebtItem[],
): void {
	const TODO_RE = /\b(TODO|FIXME|HACK|XXX|NOSONAR|BUG|WORKAROUND|KLUDGE|SMELL)\b/i;
	for (let i = 0; i < lines.length; i++) {
		const m = TODO_RE.exec(lines[i]);
		if (m) {
			items.push({
				unitId, category: 'todo-fixme',
				description: `${m[1].toUpperCase()} marker at line ${i + 1}: "${lines[i].trim().slice(0, 100)}"`,
				severity: 'info',
				lineNumber: i + 1,
				migrationImpact: 'Unresolved TODOs/FIXMEs represent deferred work that must be addressed during or before migration.',
			});
		}
	}
}

function detectImplicitCoercion(
	unitId: string, lines: string[], lang: string, items: ITechDebtItem[],
): void {
	if (!['javascript', 'typescript', 'php', 'perl', 'ruby', 'python'].includes(lang)) { return; }

	let count = 0;
	for (const line of lines) {
		if (isCommentLine(line, lang)) { continue; }
		// Loose equality in JS/PHP
		if ((lang === 'javascript' || lang === 'typescript') && /[^=!]==[^=]/.test(line) && !/===/.test(line)) { count++; }
		if (lang === 'php' && /==[^=]/.test(line) && !/===[^=]/.test(line)) { count++; }
		// Python 2 compat division
		if (lang === 'python' && /\/\//.test(line) && !/^\s*#/.test(line)) { count++; }
	}
	if (count > 3) {
		items.push({
			unitId, category: 'implicit-type-coercion',
			description: `${count} potential implicit type coercion / loose equality patterns detected.`,
			severity: 'warning',
			migrationImpact: 'Loose equality semantics often differ in target languages \u2014 explicit type checks must be added during migration.',
		});
	}
}

function detectUnboundedLoop(
	unitId: string, lines: string[], lang: string, items: ITechDebtItem[],
): void {
	const patterns: Partial<Record<string, RegExp[]>> = {
		javascript: [/\bwhile\s*\(\s*true\s*\)/, /\bfor\s*\(\s*;;\s*\)/],
		typescript: [/\bwhile\s*\(\s*true\s*\)/, /\bfor\s*\(\s*;;\s*\)/],
		java:       [/\bwhile\s*\(\s*true\s*\)/, /\bfor\s*\(\s*;;\s*\)/],
		kotlin:     [/\bwhile\s*\(\s*true\s*\)/],
		csharp:     [/\bwhile\s*\(\s*true\s*\)/, /\bfor\s*\(\s*;;\s*\)/],
		python:     [/\bwhile\s+True\s*:/, /\bwhile\s+1\s*:/],
		go:         [/\bfor\s*\{/, /\bfor\s+true\b/],
		rust:       [/\bloop\s*\{/],
		ruby:       [/\bloop\s+do\b/, /\bwhile\s+true\b/],
		php:        [/\bwhile\s*\(\s*true\s*\)/],
		cobol:      [/\bPERFORM\b(?!.*\bUNTIL\b)/],
	};

	const langPatterns = patterns[lang] ?? [];
	for (let i = 0; i < lines.length; i++) {
		if (isCommentLine(lines[i], lang)) { continue; }
		for (const re of langPatterns) {
			if (re.test(lines[i])) {
				items.push({
					unitId, category: 'unbounded-loop',
					description: `Potentially unbounded loop at line ${i + 1}.`,
					severity: 'warning',
					lineNumber: i + 1,
					migrationImpact: 'Unbounded loops require explicit termination conditions in the target \u2014 translator cannot infer the intent from `while(true)` alone.',
				});
				break;
			}
		}
	}
}

function detectGotoUsage(
	unitId: string, lines: string[], lang: string, items: ITechDebtItem[],
): void {
	const gotoPatterns: Partial<Record<string, RegExp>> = {
		cobol:      /\bGO\s+TO\b|\bGOBACK\b/i,
		java:       /\bgoto\b/,     // reserved but unused \u2014 just flag if present
		c:          /\bgoto\b/,
		cpp:        /\bgoto\b/,
		csharp:     /\bgoto\b/,
		php:        /\bgoto\b/,
		python:     /\bgoto\b/,     // third-party goto lib
		javascript: /\blabel\s*:/,
		typescript: /\blabel\s*:/,
		fortran:    /\bGOTO\b|\bGO\s+TO\b/i,
		rpg:        /\bGOTO\b/i,
		pl1:        /\bGOTO\b|\bGO\s+TO\b/i,
	};

	const re = gotoPatterns[lang];
	if (!re) { return; }

	for (let i = 0; i < lines.length; i++) {
		if (isCommentLine(lines[i], lang)) { continue; }
		if (re.test(lines[i])) {
			items.push({
				unitId, category: 'goto-usage',
				description: `GOTO/jump statement at line ${i + 1}.`,
				severity: 'warning',
				lineNumber: i + 1,
				migrationImpact: 'GOTO-based control flow must be replaced with structured control flow (loops, early returns, exceptions) in the target language.',
			});
		}
	}
}

function detectGlobalState(
	unitId: string, lines: string[], lang: string, items: ITechDebtItem[],
): void {
	// Look for module-level mutable state patterns
	const patterns: Partial<Record<string, RegExp>> = {
		javascript: /^(?:var|let)\s+\w+\s*=/,
		typescript: /^(?:let|var)\s+\w+\s*(?::\s*\w+)?\s*=/,
		python:     /^[A-Z_][A-Z0-9_]{2,}\s*=/,  // Module-level ALLCAPS mutable globals
		go:         /^var\s+\w+\s+(?!func)[\w*\[\]]+\s*=/,
		rust:       /^(?:static\s+mut|lazy_static!)\b/,
		java:       /\bpublic\s+static\s+(?!final)\w/,
		kotlin:     /\bobject\s+\w+.*\bvar\b/,
		csharp:     /\bpublic\s+static\s+(?!readonly)\w/,
		php:        /\bstatic\s+\$\w+\s*=/,
		ruby:       /^\$\w+\s*=/,  // Global variables
	};

	const re = patterns[lang];
	if (!re) { return; }

	let count = 0;
	for (const line of lines) {
		if (isCommentLine(line, lang)) { continue; }
		if (re.test(line.trim())) { count++; }
	}
	if (count > 0) {
		items.push({
			unitId, category: 'global-state',
			description: `${count} potential mutable global/module-level variable(s) detected.`,
			severity: count > 5 ? 'error' : 'warning',
			migrationImpact: 'Global mutable state causes thread-safety issues and testing difficulties; must be encapsulated or injected in the target.',
		});
	}
}

function detectDeadCode(
	unitId: string, unitName: string, lang: string,
	allCallExpressions: string[], items: ITechDebtItem[],
): void {
	// Only meaningful for named units (not file-level units)
	if (unitName.includes('$module') || unitName.includes('$file')) { return; }
	// Very common utility patterns \u2014 skip
	if (/^(?:main|Main|Program|App|index|Index|init|Init|constructor|Constructor)$/.test(unitName)) { return; }

	const normalised = unitName.replace(/[-_$]/g, '').toLowerCase();
	const isReferenced = allCallExpressions.some(expr => {
		const exprNorm = expr.replace(/[-_$]/g, '').toLowerCase();
		return exprNorm.includes(normalised) || exprNorm.includes(unitName);
	});

	if (!isReferenced && allCallExpressions.length > 0) {
		items.push({
			unitId, category: 'dead-code',
			description: `Unit "${unitName}" does not appear to be called from any other unit in this project.`,
			severity: 'info',
			migrationImpact: 'Verify whether this unit is called externally (e.g., as a CICS program, JCL step, or API endpoint) before removing. If unused, skip migration.',
		});
	}
}

function detectNoUnitTests(
	unitId: string, unitName: string, testUnitIds: string[], items: ITechDebtItem[],
): void {
	if (testUnitIds.length === 0) { return; } // No test files detected at all \u2014 skip
	const norm = unitName.toLowerCase().replace(/[-_$]/g, '');
	const hasTest = testUnitIds.some(tid => {
		const tnorm = tid.toLowerCase().replace(/[-_$]/g, '');
		return tnorm.includes(norm) || tnorm.includes(`test${norm}`) || tnorm.includes(`${norm}test`) ||
		       tnorm.includes(`spec${norm}`) || tnorm.includes(`${norm}spec`);
	});

	if (!hasTest) {
		items.push({
			unitId, category: 'no-unit-tests',
			description: `No test file found that corresponds to unit "${unitName}".`,
			severity: 'info',
			migrationImpact: 'Untested units carry higher migration risk \u2014 write characterisation tests before translating to catch regressions.',
		});
	}
}


// \u2500\u2500\u2500 Firmware / Industrial Debt Detectors \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectUnsafePointerArithmetic(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	// Cast of an integer literal to volatile uint*_t \u2014 typical direct register access
	const re = /\(\s*volatile\s+uint(?:8|16|32|64)_t\s*\*\s*\)\s*0x[0-9A-Fa-f]+/;
	for (let i = 0; i < lines.length; i++) {
		if (re.test(lines[i])) {
			items.push({
				unitId, category: 'unsafe-pointer-arithmetic',
				description: `Raw peripheral register address cast at line ${i + 1} \u2014 MISRA-C:2012 Rule 11.4 violation.`,
				severity: 'error',
				lineNumber: i + 1,
				migrationImpact:
					'Replace raw register casts with HAL/SDK named-register macros (e.g. GPIOA->ODR \u2192 GPIO_PinWrite) ' +
					'before migration. MISRA-C:2012 R11.4 prohibits casts between pointer and integer types.',
			});
		}
	}
}

function detectISRReentranceRisk(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	const isrDecl = /\bvoid\s+\w+_IRQHandler\s*\(\s*void\s*\)/;
	let inISR = false;
	let braceDepth = 0;
	let globalWriteInISR = false;
	let globalWriteLine = 0;
	const criticalSectionRe = /\b(?:taskENTER_CRITICAL|__disable_irq|portDISABLE_INTERRUPTS|BaseType_t\s+xHigherPriority|portYIELD_FROM_ISR)\b/;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (isrDecl.test(line)) { inISR = true; braceDepth = 0; globalWriteInISR = false; continue; }
		if (!inISR) { continue; }
		braceDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
		if (braceDepth <= 0) { inISR = false; continue; }
		// Detect global variable write: assignment to a global-like name (lowercase snake, all-caps)
		if (/\b[a-zA-Z_][a-zA-Z0-9_]+\s*(?:\[.*\])?\s*[+\-*/%&|^]?=(?!=)/.test(line) &&
		    !criticalSectionRe.test(line) && !/\blocal|const\s|uint\s+\w+\s*=|int\s+\w+\s*=/.test(line)) {
			globalWriteInISR = true;
			globalWriteLine = i + 1;
		}
	}
	if (globalWriteInISR) {
		items.push({
			unitId, category: 'isr-reentrance-risk',
			description: `ISR appears to write a shared variable at line ${globalWriteLine} without a critical section guard.`,
			severity: 'error',
			lineNumber: globalWriteLine,
			migrationImpact:
				'Wrap all ISR-to-mainline shared-variable accesses in taskENTER_CRITICAL / taskEXIT_CRITICAL (FreeRTOS) ' +
				'or irq_lock / irq_unlock (Zephyr). In RTOS migration, use a queue or semaphore instead of globals.',
		});
	}
}

function detectMisraCCriticalViolations(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	// Rule 11.4: Cast between pointer and integer
	const r11_4 = /\(\s*(?:uint|int)(?:8|16|32|64)_t\s*\*\s*\)/;
	// Rule 14.4: Non-boolean condition in if/while (e.g. if(ptr) rather than if(ptr != NULL))
	const r14_4 = /\bif\s*\(\s*(?!\s*\w+\s*(?:!=|==|<|>|<=|>=|!|\|\||\&\&))\s*[\w*&]+\s*\)/;
	let r11_4Count = 0; let r14_4Count = 0;
	for (const line of lines) {
		if (r11_4.test(line)) { r11_4Count++; }
		if (r14_4.test(line)) { r14_4Count++; }
	}
	if (r11_4Count > 0) {
		items.push({
			unitId, category: 'misra-c-critical-violation',
			description: `${r11_4Count} instance(s) of MISRA-C:2012 Rule 11.4 (pointer/integer cast) detected.`,
			severity: 'error',
			migrationImpact: 'Replace integer-to-pointer casts with CMSIS-named peripheral base macros (e.g. GPIOA_BASE \u2192 (GPIO_TypeDef *)) per MISRA-C Advisory Rule 11.4.',
		});
	}
	if (r14_4Count > 0) {
		items.push({
			unitId, category: 'misra-c-critical-violation',
			description: `${r14_4Count} instance(s) of MISRA-C:2012 Rule 14.4 (non-boolean controlling expression) detected.`,
			severity: 'warning',
			migrationImpact: 'Replace implicit null/zero checks with explicit comparisons (ptr != NULL, count != 0u) to satisfy MISRA-C Advisory Rule 14.4.',
		});
	}
}

function detectHardwareDependency(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	// MCU-specific peripheral #defines used as values (not CMSIS/HAL abstractions)
	const mcuRegRe = /\b(GPIO[A-H]|USART\d|SPI\d|I2C\d|TIM\d+|ADC\d|DMA\d|RCC|EXTI|NVIC|SCB|SysTick)\b->|\b\(GPIO_TypeDef\s*\*\)\s*0x/;
	let count = 0;
	for (const line of lines) {
		if (mcuRegRe.test(line) && !/HAL_|LL_|CMSIS/.test(line)) { count++; }
	}
	if (count > 0) {
		items.push({
			unitId, category: 'hardware-dependency',
			description: `${count} direct peripheral register access(es) without HAL/LL abstraction.`,
			severity: count > 5 ? 'error' : 'warning',
			migrationImpact:
				'Each peripheral access must be mapped to its HAL/SDK equivalent before migration. ' +
				'Target SDK (NXP MCUXpresso, STM32 HAL, Zephyr drivers) requires driver API calls \u2014 not raw register writes.',
		});
	}
}

function detectWatchdogGap(unitId: string, lines: string[], logicalLineCount: number, items: ITechDebtItem[]): void {
	if (logicalLineCount < 50) { return; } // Short functions don't need watchdog refresh
	const watchdogRefresh = /\b(?:HAL_IWDG_Refresh|IWDG_ReloadCounter|wdt_feed|watchdog_reset|ioctl.*WDIOC_KEEPALIVE|vTaskDelay|HAL_Delay|taskYIELD)\b/;
	const hasWatchdog = lines.some(l => watchdogRefresh.test(l));
	if (!hasWatchdog) {
		items.push({
			unitId, category: 'watchdog-gap',
			description: `Function body has ${logicalLineCount} logical lines with no watchdog refresh call.`,
			severity: logicalLineCount > 200 ? 'error' : 'warning',
			migrationImpact:
				'Long-running firmware functions without watchdog refresh can cause unexpected resets in target. ' +
				'Insert watchdog refresh calls at safe points, or use FreeRTOS task delay (which yields to watchdog task).',
		});
	}
}

function detectAutosarRteDependency(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	const rteRe = /\bRte_(?:Read|Write|Call|Send|Receive|IRead|IWrite)\s*\(/;
	const araComRe = /\bara::com|AraComProxy|AraComSkeleton|ara::core::Result/;
	const rteCount = lines.filter(l => rteRe.test(l)).length;
	if (rteCount === 0) { return; }
	const hasAraCom = lines.some(l => araComRe.test(l));
	if (!hasAraCom) {
		items.push({
			unitId, category: 'autosar-rte-dependency',
			description: `${rteCount} AUTOSAR Classic Rte_Read/Write/Call invocation(s) with no Adaptive ara::com mapping found in this unit.`,
			severity: 'warning',
			migrationImpact:
				'Each Classic RTE port must be mapped to an Adaptive ara::com service interface. ' +
				'Generate ara::com proxy/skeleton from ServiceInterface ARXML before translating this SWC.',
		});
	}
}

function detectE2EProtectionGap(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	const e2eProfileRe = /\bCom_SendSignal|Rte_Write|E2E_P\w+_Protect|E2E_P\w+_Check\b/;
	const e2eWrapperRe = /\bE2E_P(?:01|02|04|05|06|07|08|11)_Protect|E2EPW_Write|E2EPW_Read\b/;
	const hasSend = lines.some(l => e2eProfileRe.test(l));
	const hasWrapper = lines.some(l => e2eWrapperRe.test(l));
	if (hasSend && !hasWrapper) {
		items.push({
			unitId, category: 'e2e-protection-gap',
			description: 'Com_SendSignal / Rte_Write found but no E2E protection wrapper (E2EPW_Write) detected.',
			severity: 'warning',
			migrationImpact:
				'ASIL-rated signals require E2E protection (CRC + counter) in the target Adaptive stack. ' +
				'Configure the E2E profile in the ComM/ara::com manifest and link the SWS_E2ELibrary.',
		});
	}
}

function detectSecurityKeyMaterial(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	// 3GPP key arrays: uint8_t kNAS[16], uint8_t kRRC[32] etc.
	const keyArrayRe = /\b(?:uint8_t|unsigned char|bytes)\s+k(?:NAS|RRC|AMF|SEAF|AUSF|ASME|eNB|gNB|UPint|KAMF)\s*\[/i;
	// SUPI/SUCI inline
	const supiRe = /\bsupi\s*=\s*["']\d{15}["']|\bimsi\s*=\s*["']\d{15}["']/i;
	// Generic master key or PSK
	const pskRe = /\b(?:master_key|msk|emsk|pmk|psk|mk)\s*=\s*(?:0x[0-9A-Fa-f]+|\{[0x0-9A-Fa-f,\s]+\})/i;

	for (let i = 0; i < lines.length; i++) {
		if (keyArrayRe.test(lines[i]) || supiRe.test(lines[i]) || pskRe.test(lines[i])) {
			items.push({
				unitId, category: 'security-key-material',
				description: `3GPP/wireless security key material found inline at line ${i + 1}.`,
				severity: 'error',
				lineNumber: i + 1,
				migrationImpact:
					'Key material MUST NOT be hardcoded per 3GPP TS 33.501 §6.2. ' +
					'Externalise to an HSM, TEE, or key provisioning service before migration. ' +
					'This is a blocking prerequisite \u2014 failure to remediate violates GSMA NESAS requirements.',
			});
			break; // One item per unit is enough
		}
	}
}

function detectGooseProtectionRelay(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	// IEC 61850 GOOSE trip command being sent over TCP or HTTP (forbidden for protection relays)
	const gooseRe = /\b(?:XCBR|XSWI|goose|GOOSE|IEC61850|iec61850)\b/;
	const tcpHttpRe = /\b(?:send|write|publish|post|put)\s*\(|http(?:s)?:\/\/|mqtt|opc.?ua|opcua/i;
	const hasGoose = lines.some(l => gooseRe.test(l));
	const hasTcpHttp = lines.some(l => tcpHttpRe.test(l));
	if (hasGoose && hasTcpHttp) {
		items.push({
			unitId, category: 'goose-protection-relay',
			description: 'IEC 61850 GOOSE protection-relay logic co-located with TCP/HTTP/MQTT send calls.',
			severity: 'error',
			migrationImpact:
				'GOOSE trip commands for protection relays (XCBR/XSWI) must remain on IEC 61850 multicast GOOSE. ' +
				'Bridging via OPC-UA, MQTT, or HTTP cannot meet IEC 61850-5 Class P5/P6 latency (< 4 ms). ' +
				'Separate protection-relay logic from monitoring/HMI data paths before migration.',
		});
	}
}


// \u2500\u2500\u2500 Energy / Critical Infrastructure Detectors \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectDnp3UnencryptedTransport(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	// DNP3 usage without Secure Authentication v5 (SAv5) \u2014 IEC 62351-5 / NERC CIP
	const dnp3Re = /\bdnp3|DNP3|DnpMaster|DnpOutstation|DnpChannel\b/;
	const sauthRe = /\bSAv5|SecureAuthentication|HMAC_SHA256|challengeKey\b/;
	const hasDnp3 = lines.some(l => dnp3Re.test(l));
	const hasSAuth = lines.some(l => sauthRe.test(l));
	if (hasDnp3 && !hasSAuth) {
		items.push({
			unitId, category: 'dnp3-secure-auth-gap',
			description: 'DNP3 communication detected without Secure Authentication v5 (SAv5) \u2014 NERC CIP / IEC 62351-5 violation.',
			severity: 'error',
			migrationImpact:
				'DNP3 without SAv5 is prohibited in NERC CIP BES Cyber Systems (CIP-005, CIP-007). ' +
				'The migration target must implement DNP3 SAv5 (HMAC-SHA-256 challenges) or replace DNP3 with IEC 60870-5-104 over TLS.',
		});
	}
}

function detectModbusHardcodedCoils(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	// Hardcoded Modbus coil/register addresses \u2014 should be symbolic constants per IEC 62443
	const modbusRe = /\b(?:ReadCoils|ReadHoldingRegisters|WriteSingleCoil|WriteMultipleRegisters|mb_read|mb_write)\s*\([^)]*\d{3,}/;
	let count = 0;
	for (const line of lines) {
		if (modbusRe.test(line)) { count++; }
	}
	if (count > 3) {
		items.push({
			unitId, category: 'hardware-dependency',
			description: `${count} hardcoded Modbus register/coil address(es) detected \u2014 should be symbolic constants.`,
			severity: 'warning',
			migrationImpact:
				'Hardcoded Modbus addresses must be replaced with named symbolic constants or an OPC-UA NodeId map ' +
				'in the migration target to support reconfiguration without code changes.',
		});
	}
}

function detectIEC62443CredentialInOTContext(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	// OT/IT credentials in SCADA/PLC context \u2014 IEC 62443-2-4 requirement
	const otContextRe = /\b(?:scada|plc|rtu|hmi|historian|ied|substation|dcs)\b/i;
	const credRe = /(?:password|passwd|secret)\s*[=:]\s*["'][^"']{4,}["']/i;
	const hasOtContext = lines.some(l => otContextRe.test(l));
	const hasCredential = lines.some(l => credRe.test(l));
	if (hasOtContext && hasCredential) {
		items.push({
			unitId, category: 'hardcoded-credential',
			description: 'Hardcoded credential detected in OT/SCADA/PLC context \u2014 IEC 62443-2-4 violation.',
			severity: 'error',
			migrationImpact:
				'IEC 62443-2-4 SP.03.03 requires that IACS component credentials are provisioned externally. ' +
				'Remove all hardcoded passwords and replace with a PAM/CyberArk/vault integration in the migration target.',
		});
	}
}

function detectSILRatedFunctionWithoutDiagnosticCoverage(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	// SIL-rated safety function block without diagnostic coverage
	const silFbRe = /\b(?:SF_EmergencyStop|SF_SafelyLimitedSpeed|SF_SafelyLimitedPosition|SF_GuardMonitoring|SF_SafeStop|SF_EnableSwitch|SF_MutingPar|SF_MutingSeq|STO_function|SS1_function|SS2_function|SLS_function|SBC_function)\s*\(/;
	const diagnosticRe = /\b(?:DiagCode|FaultState|S_FaultState|error_code|ErrorID|errId|diagnosis|DIAG)\b/;
	const hasSilFb = lines.some(l => silFbRe.test(l));
	const hasDiag = lines.some(l => diagnosticRe.test(l));
	if (hasSilFb && !hasDiag) {
		items.push({
			unitId, category: 'misra-c-critical-violation',
			description: 'PLCopen Safety FB call without DiagCode/FaultState diagnostic output handling.',
			severity: 'error',
			migrationImpact:
				'IEC 62061 §6.7.6 requires that safety function diagnostic outputs (DiagCode, FaultState, ErrorID) ' +
				'are monitored and reacted to. Target migration must wire all diagnostic outputs to a safety PLC fault handler.',
		});
	}
}

// \u2500\u2500\u2500 Telecom & 5G Detectors \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectNASKeyDerivationInCode(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	// NAS/AS key derivation inline \u2014 3GPP TS 33.501 §6.2 violation
	const kdfRe = /\b(?:KDF|derive_key|compute_ck_ik|f2_f3_f4_f5|milenage_|kasumi_|snow3g_|zuc_)\s*\(/i;
	const keyOutputRe = /\b(?:CK|IK|AK|RES|AUTN|XRES)\b/;
	const hasKdf = lines.some(l => kdfRe.test(l));
	const hasKeyOutput = lines.some(l => keyOutputRe.test(l));
	if (hasKdf && hasKeyOutput) {
		items.push({
			unitId, category: 'security-key-material',
			description: 'NAS/AS key derivation function (KDF/Milenage/KASUMI/SNOW 3G) called with key output in source \u2014 3GPP TS 33.501 §6.2 violation.',
			severity: 'error',
			migrationImpact:
				'3GPP TS 33.501 §6.2 requires all AS/NAS key material to remain within the SIM/USIM or HSM/TEE. ' +
				'Key derivation must be delegated to the UICC or a secure enclave. ' +
				'This is a blocking prerequisite before telecom NF migration.',
		});
	}
}

function detectFronthaulLatencyRisk(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	// O-RAN fronthaul path through HTTP/REST \u2014 fatal for eCPRI latency
	const fhRe = /\b(?:eCPRI|ecpri|fronthaul|iq_data|IQ_sample|oranU|oran_u_plane)\b/i;
	const httpRe = /\b(?:http|REST|axios|fetch|XMLHttpRequest|curl|requests\.get|requests\.post)\b/i;
	const hasFh = lines.some(l => fhRe.test(l));
	const hasHttp = lines.some(l => httpRe.test(l));
	if (hasFh && hasHttp) {
		items.push({
			unitId, category: 'goose-protection-relay',
			description: 'O-RAN fronthaul IQ data path co-located with HTTP/REST calls \u2014 fatal for eCPRI timing.',
			severity: 'error',
			migrationImpact:
				'O-RAN Option 7-2x eCPRI fronthaul requires < 100 µs one-way latency. ' +
				'HTTP/REST cannot meet this constraint. ' +
				'Separate IQ-plane (U-Plane) processing from management/control plane (M-Plane over NETCONF/YANG). ' +
				'Use shared memory + DPDK or kernel bypass for the U-plane path.',
		});
	}
}

function detectTTCN3InConcVerdictSuppression(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	// TTCN-3 INCONC verdict suppressed or ignored \u2014 GSMA PRD FS.13
	const inconcRe = /\bverdict\s*:=\s*inconc\b|\bsetverdict\s*\(\s*inconc\s*\)/i;
	let inconcLines = 0;
	let hasTraceabilityComment = false;
	for (const line of lines) {
		if (inconcRe.test(line)) { inconcLines++; }
		if (inconcLines > 0 && /\b(?:\/\/|--)\s*3GPP\s+TS\s+\d+/.test(line)) { hasTraceabilityComment = true; }
	}
	if (inconcLines > 0 && !hasTraceabilityComment) {
		items.push({
			unitId, category: 'ttcn3-verdict-suppression',
			description: `${inconcLines} INCONC verdict(s) without 3GPP TS clause reference \u2014 GSMA PRD FS.13 violation.`,
			severity: 'warning',
			migrationImpact:
				'GSMA PRD FS.13 requires that every INCONC verdict in a TTCN-3 test module is accompanied by ' +
				'a reference to the specific 3GPP TS clause it corresponds to. ' +
				'The migration target (PyTest/Robot Framework) must replace each INCONC with pytest.skip() or SKIP ' +
				'with a documented 3GPP TS clause justification.',
		});
	}
}

function detectGTPTunnelPlaneViolation(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	// GTP-U tunnel endpoint in C-Plane code path \u2014 3GPP TS 23.501 UP/CP separation
	const gtpURe = /\b(?:gtpu|GTP_U|gtp1u|gtp_u_send|pfcp|PFCP|PDR|FAR|URR)\b/i;
	const cpSignalRe = /\b(?:AMF|SMF|ngap_|nas_encode|nas_decode|rrc_setup|NAS_PDU)\b/;
	const hasGtpU = lines.some(l => gtpURe.test(l));
	const hasCpSignal = lines.some(l => cpSignalRe.test(l));
	if (hasGtpU && hasCpSignal) {
		items.push({
			unitId, category: 'protocol-state-machine-break',
			description: 'GTP-U (User Plane) processing mixed with Control Plane NAS/RRC in same unit \u2014 3GPP TS 23.501 UP/CP separation violation.',
			severity: 'error',
			migrationImpact:
				'3GPP TS 23.501 §5.8 requires strict separation of User Plane (UPF/GTP-U/PFCP) from ' +
				'Control Plane (AMF/SMF/NAS). Mixing them blocks O-RAN CU-UP / CU-CP split. ' +
				'Decompose into separate translation units before NF migration.',
		});
	}
}

// \u2500\u2500\u2500 Industrial IoT & OT Detectors \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectEtherCATTimingViolation(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	// EtherCAT application code using OS sleep/delay \u2014 fatal for deterministic cycle time
	const ecatRe = /\b(?:EC_Master|ecrt_|soem_|ethercatmaster|EcMasterLib|EtherCATmaster)\b/i;
	const sleepRe = /\b(?:sleep|usleep|nanosleep|std::this_thread::sleep|time\.sleep|Thread\.Sleep|delay|HAL_Delay)\s*\(/i;
	const hasEcat = lines.some(l => ecatRe.test(l));
	const hasSleep = lines.some(l => sleepRe.test(l));
	if (hasEcat && hasSleep) {
		items.push({
			unitId, category: 'isr-reentrance-risk',
			description: 'EtherCAT master application uses OS sleep/delay \u2014 violates deterministic cycle time requirement.',
			severity: 'error',
			migrationImpact:
				'EtherCAT cycle times (250 µs\u20131 ms) require a PREEMPT-RT or dedicated RTOS task loop without OS sleeps. ' +
				'Replace sleep() calls with cycle-synchronised ecrt_master_receive/ecrt_domain_process/ecrt_master_send ' +
				'inside a SCHED_FIFO real-time thread. Target must use Linux PREEMPT_RT or a bare-metal RTOS.',
		});
	}
}

function detectCANopenSDOTimeout(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	// CANopen SDO transfer without timeout \u2014 can block network management forever
	const sdoRe = /\b(?:CO_SDO_readExpedited|CO_SDO_writeExpedited|CO_SDOclientRead|SDO_write|sdo_read|co_sdo)\s*\(/i;
	const timeoutRe = /\b(?:timeout|SDO_TIMEOUT|timeoutMs|maxWait|SDO_BLOCK_TIMEOUT)\b/i;
	const hasSdo = lines.some(l => sdoRe.test(l));
	const hasTimeout = lines.some(l => timeoutRe.test(l));
	if (hasSdo && !hasTimeout) {
		items.push({
			unitId, category: 'unbounded-loop',
			description: 'CANopen SDO transfer without timeout \u2014 can block NMT state machine indefinitely.',
			severity: 'warning',
			migrationImpact:
				'CANopen CiA 301 §9.2.4 requires SDO client timeout handling. A blocking SDO will stall the NMT ' +
				'heartbeat consumer and may trigger node guarding timeout errors across the network. ' +
				'Add SDO_TIMEOUT_MS and error recovery to all SDO transactions in the migration target.',
		});
	}
}

function detectMQTTSparkplugBirthCertificate(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	// MQTT SparkplugB publisher without NBIRTH/DBIRTH publication
	const spbPublishRe = /\b(?:NDEATH|DDEATH|NDATA|DDATA|sparkplug|SparkplugB|spB)\b/i;
	const birthRe = /\b(?:NBIRTH|DBIRTH)\b/;
	const hasSpbPublish = lines.some(l => spbPublishRe.test(l));
	const hasBirth = lines.some(l => birthRe.test(l));
	if (hasSpbPublish && !hasBirth) {
		items.push({
			unitId, category: 'missing-error-handling',
			description: 'MQTT SparkplugB publisher sends NDATA/DDATA without NBIRTH/DBIRTH \u2014 violates SparkplugB v3.0 §4.2.',
			severity: 'error',
			migrationImpact:
				'SparkplugB v3.0 §4.2 requires every Node/Device to publish a BIRTH certificate (NBIRTH/DBIRTH) ' +
				'immediately after connecting. Without it, Host Applications cannot build the live metric dictionary. ' +
				'The migration target must publish NBIRTH with all metric definitions on session establishment.',
		});
	}
}

function detectOPCUANodeWithoutSecurity(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	// OPC-UA client/server without security policy \u2014 IEC 62443 / IEC 62541-6
	const opcuaRe = /\b(?:OpcUa_|UA_Client|UA_Server|open62541|opcua_client|opcua_server|EndpointUrl|opcua\.Client)\b/i;
	const securityPolicyRe = /\b(?:SecurityPolicy|BASIC256SHA256|AES128_SHA256|AES256_SHA256|Sign_and_Encrypt|MessageSecurity)\b/i;
	const noneRe = /(?:SecurityPolicy\.None|SecurityMode\.None|None_|security_policy\s*=\s*["']None["'])/i;
	const hasOpcua = lines.some(l => opcuaRe.test(l));
	const hasSecPolicy = lines.some(l => securityPolicyRe.test(l));
	const hasNone = lines.some(l => noneRe.test(l));
	if (hasOpcua && (!hasSecPolicy || hasNone)) {
		items.push({
			unitId, category: 'hardcoded-credential',
			description: 'OPC-UA endpoint using SecurityPolicy.None or missing security configuration \u2014 IEC 62443 / IEC 62541-6 violation.',
			severity: 'error',
			migrationImpact:
				'IEC 62443-3-3 SR 3.1 and IEC 62541-6 §6.7 require OPC-UA connections in industrial networks to use ' +
				'at least Basic256Sha256 (Sign & Encrypt). SecurityPolicy.None is prohibited except for discovery endpoints. ' +
				'Migration target must configure certificate-based authentication + message encryption.',
		});
	}
}

function detectTSNGateScheduleViolation(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	// TSN Qbv gate schedule reference without IEEE 802.1AS time synchronisation
	const tsnQbvRe = /\b(?:qbv|Qbv|GateControlList|GateState|TAPRIO|tc_taprio|ieee_8021qbv|tsn_schedule)\b/i;
	const ptpSyncRe = /\b(?:ptp|PTP|IEEE1588|ptpd|linuxptp|PTPD|gptp|gPTP|802\.1AS)\b/i;
	const hasQbv = lines.some(l => tsnQbvRe.test(l));
	const hasSync = lines.some(l => ptpSyncRe.test(l));
	if (hasQbv && !hasSync) {
		items.push({
			unitId, category: 'hardware-dependency',
			description: 'IEEE 802.1Qbv gate schedule configured without IEEE 802.1AS (gPTP) time synchronisation.',
			severity: 'error',
			migrationImpact:
				'IEEE 802.1Qbv Scheduled Traffic requires all talkers and listeners to be synchronised to < 1 µs ' +
				'via IEEE 802.1AS-2020 (gPTP). Without time sync the gate schedule is meaningless and real-time ' +
				'traffic will miss its transmission window. Migration target must initialise linuxptp/ptpd2 ' +
				'before applying the taprio qdisc gate schedule.',
		});
	}
}

function detectPROFINETDeviceNameHardcoded(unitId: string, lines: string[], items: ITechDebtItem[]): void {
	// Hardcoded PROFINET station name / IP \u2014 must be configurable per IEC 61158 / PN spec
	const pnRe = /\b(?:pn_dev|PN_Device|profinet_|PNIO_|PnDev_|pndv_)\b/i;
	const hardcodedNameRe = /(?:station_name|device_name|pnio_dev_name)\s*=\s*["'][^"']{3,}["']/i;
	const hasPn = lines.some(l => pnRe.test(l));
	const hasHardcodedName = lines.some(l => hardcodedNameRe.test(l));
	if (hasPn && hasHardcodedName) {
		items.push({
			unitId, category: 'hardware-dependency',
			description: 'PROFINET station name hardcoded in source \u2014 must be DCP-assignable per IEC 61158-6-10.',
			severity: 'warning',
			migrationImpact:
				'PROFINET IEC 61158-6-10 requires the station name to be assignable via DCP (Discovery and basic Configuration Protocol). ' +
				'Hardcoding it prevents correct deployment in PLC project engineering tools (TIA Portal / STEP7). ' +
				'Store in non-volatile memory or flash and implement DCP Set/Identify handlers.',
		});
	}
}


// \u2500\u2500\u2500 Comment Detection Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function isCommentLine(line: string, lang: string): boolean {
	const t = line.trim();
	if (!t) { return false; }
	if (['java', 'kotlin', 'scala', 'csharp', 'typescript', 'javascript', 'go', 'rust', 'swift', 'dart', 'php', 'groovy', 'c', 'cpp'].includes(lang)) {
		return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
	}
	if (lang === 'python' || lang === 'ruby' || lang === 'shell' || lang === 'elixir') { return t.startsWith('#'); }
	if (lang === 'cobol') { return line.length >= 7 && (line[6] === '*' || line[6] === '/'); }
	if (lang === 'sql' || lang === 'plsql') { return t.startsWith('--'); }
	if (lang === 'haskell' || lang === 'lua') { return t.startsWith('--'); }
	return false;
}

function isCommentContent(line: string, lang: string): boolean {
	const t = line.trim();
	if (t.startsWith('//') || t.startsWith('#') || t.startsWith('--') || t.startsWith('*')) { return true; }
	if (lang === 'cobol' && line.length >= 7 && (line[6] === '*' || line[6] === '/')) { return true; }
	return false;
}


// \u2500\u2500\u2500 Clone Detection Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function normaliseForClone(content: string, lang: string): string {
	let s = content
		.replace(/"(?:[^"\\]|\\.)*"/g, '"S"')
		.replace(/'(?:[^'\\]|\\.)*'/g, "'S'")
		.replace(/\d+/g, 'N')
		.replace(/\s+/g, ' ')
		.trim();
	// Remove identifiers (leave keywords for structure comparison)
	return s.slice(0, 2000); // cap at 2KB for performance
}

function buildTrigrams(text: string): Set<string> {
	const result = new Set<string>();
	for (let i = 0; i + 3 <= text.length; i++) {
		result.add(text.slice(i, i + 3));
	}
	return result;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) { return 1; }
	if (a.size === 0 || b.size === 0) { return 0; }
	let intersection = 0;
	for (const t of a) { if (b.has(t)) { intersection++; } }
	return intersection / (a.size + b.size - intersection);
}

function normaliseCOBOL(content: string): string {
	return content
		.split('\n')
		.map(l => l.length >= 7 ? l.slice(6) : l)
		.map(l => l.trim())
		.filter(l => l && !l.startsWith('*'))
		.join(' ')
		.replace(/\s+/g, ' ')
		.toUpperCase();
}
