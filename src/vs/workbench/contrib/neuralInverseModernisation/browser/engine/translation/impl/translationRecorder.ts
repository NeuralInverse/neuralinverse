/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Translation Recorder
 *
 * Writes the result of one translation attempt back into the Knowledge Base.
 *
 * ## Responsibilities
 *
 * 1. **Status management** \u2014 transitions the unit through the correct status
 *    sequence: `translating` \u2192 `review` | `blocked` | back to `ready` (on error).
 *
 * 2. **Translation recording** \u2014 calls `kb.recordTranslation()` to persist the
 *    translated code and suggested target file path.
 *
 * 3. **Interface recording** \u2014 after every successful translation, extracts the
 *    public interface (method/class signatures in the target language) from the
 *    translated code and records it via `kb.recordInterface()`.
 *    This is CRITICAL for the pipeline: downstream units receive the correct
 *    `calledInterfaces` context when they are translated later.
 *
 * 4. **Decision recording** \u2014 promotes `IPendingDecision` objects from the
 *    translation result into the KB pending queue:
 *    - **Blocking** decisions: `kb.flagBlocked()` (unit parked until resolved)
 *    - **Non-blocking** decisions: `kb.addPendingDecision()` (unit goes to review)
 *
 * 5. **Error handling** \u2014 on transient errors the unit is returned to `ready`
 *    for retry. When `permanentlyFailed = true` (all retries exhausted), the
 *    unit is moved to `blocked` status with the error reason, preventing
 *    the scheduler from repeatedly retrying an unresolvable failure.
 *
 * ## Status Flow
 *
 * ```
 * translating \u2500\u2500\u25BA review    (success \u2014 human review required before approval)
 *             \u2500\u2500\u25BA blocked   (AI raised a blocking decision)
 *             \u2500\u2500\u25BA ready     (transient error \u2014 eligible for retry in next batch)
 *             \u2500\u2500\u25BA blocked   (permanentlyFailed=true \u2014 max retries exhausted)
 * ```
 *
 * ## Target File Path Generation
 *
 * Because the KB unit only knows the *source* file path, the recorder must
 * suggest a target file path. `suggestTargetFilePath()` derives it from:
 *   - The source file's directory structure (preserved under `targetRoot`)
 *   - The unit name (PascalCase normalised) and type
 *   - The target language file extension (from `getTargetFileExtension()`)
 */

import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';
import { IPendingDecision } from '../../../../common/knowledgeBaseTypes.js';
import { ITranslationResult } from './translationTypes.js';
import { getTargetFileExtension } from './languagePairRegistry.js';
import { getBlockingDecisions, getNonBlockingDecisions } from './decisionExtractor.js';
import { extractTranslatedInterface } from './translationInterfaceExtractor.js';
import { ILLMMessageService } from '../../../../../void/common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../../../../../void/common/voidSettingsService.js';


// \u2500\u2500\u2500 Main entry point \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Record the final result of a translation attempt into the Knowledge Base.
 *
 * @param result             Completed ITranslationResult from runTranslationLoop()
 * @param kb                 Knowledge Base service instance
 * @param sourceRoot         Root path of the source project
 * @param targetRoot         Root path where translated output files will be placed
 * @param llm                LLM service (used for interface extraction fallback)
 * @param settings           Void settings (model selection for interface extraction)
 * @param permanentlyFailed  If true, errors set unit to 'blocked' instead of 'ready'
 */
export async function recordTranslationResult(
	result: ITranslationResult,
	kb: IKnowledgeBaseService,
	sourceRoot: string,
	targetRoot: string,
	llm: ILLMMessageService,
	settings: IVoidSettingsService,
	permanentlyFailed = false,
): Promise<void> {
	switch (result.outcome) {
		case 'translated':
		case 'partial':
			return recordSuccess(result, kb, sourceRoot, targetRoot, llm, settings);

		case 'blocked':
			return recordBlocked(result, kb);

		case 'error':
			return recordError(result, kb, permanentlyFailed);

		case 'skipped':
			// Nothing to write \u2014 unit was intentionally skipped
			return;
	}
}


// \u2500\u2500\u2500 Success path \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

async function recordSuccess(
	result: ITranslationResult,
	kb: IKnowledgeBaseService,
	sourceRoot: string,
	targetRoot: string,
	llm: ILLMMessageService,
	settings: IVoidSettingsService,
): Promise<void> {
	const unit = kb.getUnit(result.unitId);
	if (!unit) { return; }

	// \u2500\u2500 Step 1: Determine target file path \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// Prefer the unit's existing targetFile (may have been set by a prior attempt).
	// Otherwise derive a new path from the source file's location.
	const targetFile = unit.targetFile
		?? suggestTargetFilePath(unit.sourceFile, unit.name, result.targetLang, unit.unitType, sourceRoot, targetRoot);

	// \u2500\u2500 Step 2: Write translated code + target file to KB \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	kb.recordTranslation(result.unitId, result.translatedCode, targetFile);

	// \u2500\u2500 Step 3: Extract and record public interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// This populates calledInterfaces context for downstream units that call this one.
	// Run asynchronously but awaited before returning \u2014 we don't want to miss this.
	try {
		const iface = await extractTranslatedInterface(
			unit.id,
			unit.name,
			unit.domain,
			result.translatedCode,
			result.targetLang,
			llm,
			settings,
		);
		// Only record if we extracted meaningful content
		if (iface.signatures.length > 0 || iface.summary.length > 0) {
			kb.recordInterface(unit.id, iface);
		}
	} catch {
		// Interface extraction failure is non-fatal \u2014 translation is still recorded
	}

	// \u2500\u2500 Step 4: Record pending decisions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const blocking    = getBlockingDecisions(result.decisionsRaised);
	const nonBlocking = getNonBlockingDecisions(result.decisionsRaised);

	// Non-blocking decisions go into the pending queue (human reviews them
	// but the unit can still progress to 'review')
	for (const decision of nonBlocking) {
		kb.addPendingDecision(decision);
	}

	// \u2500\u2500 Step 5: Set final status \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (blocking.length > 0) {
		// Even though translation succeeded, a blocking question was raised.
		// Unit goes to 'blocked' \u2014 it cannot be approved until the question is answered.
		const primary = blocking[0];
		const reason  = buildBlockedReason(primary, blocking.length);
		kb.flagBlocked(result.unitId, reason, primary);
		// Add any additional blocking decisions to the pending queue
		for (let i = 1; i < blocking.length; i++) {
			kb.addPendingDecision(blocking[i]);
		}
	} else {
		// Clean translation (or partial with only non-blocking decisions):
		// move to 'review' for human approval.
		kb.setUnitStatus(result.unitId, 'review', undefined, 'translation-engine');
	}
}


// \u2500\u2500\u2500 Blocked path \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function recordBlocked(
	result: ITranslationResult,
	kb: IKnowledgeBaseService,
): void {
	const blocking = getBlockingDecisions(result.decisionsRaised);

	if (blocking.length > 0) {
		const primary = blocking[0];
		const reason  = buildBlockedReason(primary, blocking.length);
		kb.flagBlocked(result.unitId, reason, primary);
		for (let i = 1; i < blocking.length; i++) {
			kb.addPendingDecision(blocking[i]);
		}
	} else {
		const reason = result.error ?? 'Translation blocked \u2014 see pending decisions';
		kb.setUnitStatus(result.unitId, 'blocked', reason, 'translation-engine');
	}

	// If any translated code was produced, still record it for human inspection
	if (result.translatedCode.trim().length > 0) {
		kb.recordTranslation(result.unitId, result.translatedCode, '');
	}
}


// \u2500\u2500\u2500 Error path \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function recordError(
	result: ITranslationResult,
	kb: IKnowledgeBaseService,
	permanentlyFailed: boolean,
): void {
	const reason = result.error ?? 'Translation failed';
	if (permanentlyFailed) {
		// All retries exhausted \u2014 permanently block the unit so the scheduler
		// doesn't keep wasting LLM budget on an unresolvable failure.
		// A human must review and either fix the source, resolve a decision,
		// or manually revert to 'ready' to allow another attempt.
		kb.setUnitStatus(result.unitId, 'blocked',
			`[MAX RETRIES EXHAUSTED] ${reason}`,
			'translation-engine');
	} else {
		// Transient error \u2014 return to 'ready' for future retry
		kb.setUnitStatus(result.unitId, 'ready', reason, 'translation-engine');
	}
}


// \u2500\u2500\u2500 Target file path suggestion \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Derive a suggested target file path from the source file's location.
 *
 * Strategy:
 * 1. Strip `sourceRoot` from `sourceFile` to get the relative path.
 * 2. Replace the source root prefix with `targetRoot`.
 * 3. Replace the file extension with the target language extension.
 * 4. For class/program/module units \u2192 use the unit name (PascalCase) as the file name.
 * 5. For paragraph/function/procedure units \u2192 keep source file name, change extension.
 *
 * Example:
 *   sourceFile = '/legacy/src/billing/CALCFEE.cbl'
 *   sourceRoot = '/legacy'
 *   targetRoot = '/modern'
 *   targetLang = 'java'
 *   unitName   = 'CalcFeeService'   unitType   = 'class'
 *   \u2192 '/modern/src/billing/CalcFeeService.java'
 */
export function suggestTargetFilePath(
	sourceFile: string,
	unitName:   string,
	targetLang: string,
	unitType:   string,
	sourceRoot: string,
	targetRoot: string,
): string {
	const ext = getTargetFileExtension(targetLang);

	// Normalise paths
	const normalSource = normalisePath(sourceFile);
	const normalRoot   = normalisePath(sourceRoot).replace(/\/$/, '');
	const relativePath = normalSource.startsWith(normalRoot + '/')
		? normalSource.slice(normalRoot.length + 1)
		: normalSource;

	// Directory portion of the relative path
	const lastSlash   = relativePath.lastIndexOf('/');
	const relativeDir = lastSlash >= 0 ? relativePath.slice(0, lastSlash) : '';

	// File name:
	// - File-per-unit types (class, program, module, service, interface): use unit name
	// - Sub-unit types (paragraph, function, procedure): use source file name
	let fileName: string;
	if (isFilePerUnitType(unitType)) {
		fileName = toPascalCase(unitName) + ext;
	} else {
		const sourceName = relativePath.slice(lastSlash + 1);
		const dotIdx     = sourceName.lastIndexOf('.');
		const baseName   = dotIdx >= 0 ? sourceName.slice(0, dotIdx) : sourceName;
		fileName = toPascalCase(baseName) + ext;
	}

	const normalTarget = normalisePath(targetRoot).replace(/\/$/, '');
	return relativeDir
		? `${normalTarget}/${relativeDir}/${fileName}`
		: `${normalTarget}/${fileName}`;
}


// \u2500\u2500\u2500 Utilities \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function isFilePerUnitType(unitType: string): boolean {
	return ['class', 'interface', 'program', 'module', 'service', 'component', 'controller', 'repository'].includes(unitType);
}

function toPascalCase(name: string): string {
	return name
		.replace(/[-_]+/g, ' ')
		.replace(/\s+(\w)/g, (_, c: string) => c.toUpperCase())
		.replace(/^\w/, c => c.toUpperCase());
}

function normalisePath(p: string): string {
	return p.replace(/\\/g, '/');
}

function buildBlockedReason(primary: IPendingDecision, totalBlocking: number): string {
	const extra = totalBlocking > 1 ? ` (+${totalBlocking - 1} more)` : '';
	return `[${primary.type}] ${primary.question}${extra}`;
}
