/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Migration Blocker Detector
 *
 * Surfaces issues that will actively impede migration — either outright blocking
 * issues that must be resolved before a unit can be translated, or warnings that
 * require special attention and planning.
 *
 * ## Blocker Catalogue
 *
 * | Blocker Type              | Severity | Trigger Condition                              |
 * |---------------------------|----------|------------------------------------------------|
 * | god-unit                  | blocking | CC > 20 AND LOC > 300 (tech-debt category)     |
 * | no-target-equivalent      | warning* | Critical unit with no cross-project pairing    |
 * | hardcoded-credential      | blocking | Tech-debt category 'hardcoded-credential'      |
 * | goto-usage                | warning  | Tech-debt category 'goto-usage'                |
 * | circular-dependency       | blocking | Cycle edges returned by dependencyResolver     |
 * | xlarge-effort-critical    | warning  | Effort band 'xlarge' AND risk 'critical'       |
 * | unresolved-regulated-data | warning  | Regulated data with no target equivalent       |
 * | blocking-grc-violation    | blocking | Blocking GRC violation in the GRC snapshot     |
 * | missing-schema-mapping    | warning  | Source schema has regulated fields, no pairing |
 * | unbounded-loop            | warning  | Tech-debt category 'unbounded-loop'            |
 * | deep-nesting              | warning  | Tech-debt category 'deep-nesting' severity err |
 * | implicit-type-coercion    | warning  | Tech-debt category 'implicit-type-coercion'    |
 *
 * * `no-target-equivalent` becomes `blocking` when unit risk is 'critical'.
 *
 * ## Phase Assignment
 *
 * Each blocker carries `resolveByPhaseIndex` — the phase index by which the
 * blocker must be resolved. This is used by the UI to show a blocker count per
 * phase header and to gate phase start.
 */

import {
	IMigrationUnit,
	MigrationBlockerType,
	IMigrationBlocker,
	MigrationPhaseType,
} from '../../../common/modernisationTypes.js';
import {
	ITechDebtItem,
	IRegulatedDataHit,
	IDataSchema,
	ICrossProjectPairing,
	IGRCSnapshot,
	IMigrationEffortEstimate,
} from '../discovery/discoveryTypes.js';
import { ICycleEdge, IUnitPhaseAssignment } from './planningTypes.js';
import { toDisplaySeverity } from '../../../../neuralInverseChecks/browser/engine/types/grcTypes.js';


// ─── Phase ordering lookup ─────────────────────────────────────────────────────

const PHASE_INDEX: Record<MigrationPhaseType, number> = {
	'foundation': 1, 'bsp': 2, 'schema': 3, 'core-logic': 4,
	'hal-layer': 5, 'api-layer': 6, 'integration': 7,
	'compliance': 8, 'safety-critical': 9, 'cutover': 10,
};


// ─── Public API ───────────────────────────────────────────────────────────────

export interface IBlockerDetectionInput {
	units:           IMigrationUnit[];
	techDebtItems:   ITechDebtItem[];
	regulatedHits:   IRegulatedDataHit[];
	dataSchemas:     IDataSchema[];
	pairings:        ICrossProjectPairing[];
	grcSnapshot:     IGRCSnapshot;
	effortEstimates: IMigrationEffortEstimate[];
	cycleEdges:      ICycleEdge[];
	phaseAssignments: Map<string, IUnitPhaseAssignment>;
}

/**
 * Detect all migration blockers across all source units.
 */
export function detectMigrationBlockers(
	input: IBlockerDetectionInput,
): IMigrationBlocker[] {
	const {
		units, techDebtItems, regulatedHits, dataSchemas, pairings,
		grcSnapshot, effortEstimates, cycleEdges, phaseAssignments,
	} = input;

	const blockers: IMigrationBlocker[] = [];
	const seen = new Set<string>(); // deduplicate by `unitId:blockerType`

	const add = (b: IMigrationBlocker) => {
		const key = `${b.unitId}:${b.blockerType}`;
		if (!seen.has(key)) { seen.add(key); blockers.push(b); }
	};

	const unitMap    = new Map(units.map(u => [u.id, u]));
	const effortMap  = new Map<string, IMigrationEffortEstimate>();
	for (const e of effortEstimates) { effortMap.set(e.unitId, e); }

	// Best pairing per source unit
	const bestPairing = new Map<string, ICrossProjectPairing>();
	for (const p of pairings) {
		const existing = bestPairing.get(p.sourceUnitId);
		if (!existing || p.confidenceScore > existing.confidenceScore) {
			bestPairing.set(p.sourceUnitId, p);
		}
	}

	// Regulated hits per unit
	const regulatedByUnit = new Map<string, number>();
	for (const r of regulatedHits) {
		regulatedByUnit.set(r.unitId, (regulatedByUnit.get(r.unitId) ?? 0) + 1);
	}

	// Data schemas with regulated fields, per unit
	const regulatedSchemaUnits = new Set(
		dataSchemas.filter(s => s.hasRegulatedFields).map(s => s.unitId),
	);

	// Blocking GRC by file URI — uses toDisplaySeverity() from the Checks engine
	// so custom framework severities ('blocker', 'critical', etc.) are handled correctly.
	const blockingFiles = new Set(
		grcSnapshot.violations
			.filter(v => toDisplaySeverity(v.severity) === 'error')
			.map(v => v.fileUri),
	);

	// ── 1. God units ──────────────────────────────────────────────────────────
	const godUnitIds = new Set(
		techDebtItems.filter(t => t.category === 'god-unit').map(t => t.unitId),
	);
	for (const id of godUnitIds) {
		const unit = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'core-logic';
		add(makeBlocker(
			id, 'god-unit', 'blocking',
			'God unit — must be decomposed before migration',
			`This unit has extremely high cyclomatic complexity and line count. ` +
			`Attempting to translate it as a single unit will produce unmaintainable code in the target language.`,
			'Decompose the unit into smaller, single-responsibility sub-units (≤ 200 LOC, CC ≤ 10). ' +
			'For COBOL programs: extract paragraphs into separate subprograms or Java service methods. ' +
			'For Java/Python classes: apply the Single Responsibility Principle.',
			Math.max(1, PHASE_INDEX[phase] - 1),
		));
	}

	// ── 2. No target equivalent for critical / high-risk units ────────────────
	for (const unit of units) {
		if (unit.riskLevel !== 'critical' && unit.riskLevel !== 'high') { continue; }
		const pairing = bestPairing.get(unit.id);
		if (!pairing) {
			const phase   = phaseAssignments.get(unit.id)?.phaseType ?? 'core-logic';
			const severity = unit.riskLevel === 'critical' ? 'blocking' : 'warning';
			add(makeBlocker(
				unit.id, 'no-target-equivalent', severity,
				`No target equivalent for ${unit.riskLevel}-risk unit`,
				`Unit "${unit.unitName}" has ${unit.riskLevel} risk but no target-side counterpart was ` +
				`found during cross-project pairing. Without a target unit, the translation has no destination.`,
				'Manually create a skeleton target unit and re-run discovery, or review the target project ' +
				'to confirm whether a matching class/function already exists under a different name.',
				PHASE_INDEX[phase],
			));
		} else if (pairing.confidenceScore < 0.40) {
			const phase = phaseAssignments.get(unit.id)?.phaseType ?? 'core-logic';
			add(makeBlocker(
				unit.id, 'no-target-equivalent', 'warning',
				`Low-confidence pairing for ${unit.riskLevel}-risk unit`,
				`Unit "${unit.unitName}" was paired with target unit "${pairing.targetUnitId}" with only ` +
				`${Math.round(pairing.confidenceScore * 100)}% confidence. ` +
				`The pairing may be incorrect — verify manually before starting migration.`,
				'Review the pairing in the cross-project pairing view and confirm or correct it.',
				PHASE_INDEX[phase],
			));
		}
	}

	// ── 3. Hardcoded credentials ──────────────────────────────────────────────
	const credUnitIds = new Set(
		techDebtItems.filter(t => t.category === 'hardcoded-credential').map(t => t.unitId),
	);
	for (const id of credUnitIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'core-logic';
		add(makeBlocker(
			id, 'hardcoded-credential', 'blocking',
			'Hardcoded credentials detected',
			`This unit contains hardcoded passwords, API keys, or connection strings. ` +
			`Translating these directly into the target codebase would embed credentials in version control.`,
			'Move all credentials to environment variables or a secrets manager (Vault, AWS Secrets Manager, etc.) ' +
			'BEFORE the migration begins. Treat this as a prerequisite security remediation.',
			Math.max(1, PHASE_INDEX[phase] - 1),
		));
	}

	// ── 4. GOTO usage ─────────────────────────────────────────────────────────
	const gotoUnitIds = new Set(
		techDebtItems.filter(t => t.category === 'goto-usage').map(t => t.unitId),
	);
	for (const id of gotoUnitIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'core-logic';
		add(makeBlocker(
			id, 'goto-usage', 'warning',
			'GOTO usage — restructuring required',
			`This unit uses GOTO statements. Structured languages (Java, Python, TypeScript, Go, C#) ` +
			`do not support GOTO, so the control flow must be refactored before the unit can be translated.`,
			'Refactor all GOTO paths into structured loops, conditionals, or early returns. ' +
			'For COBOL: convert GOTO paragraphs to PERFORM loops with EXIT conditions. ' +
			'Use control-flow analysis to identify all GOTO targets and reachability.',
			PHASE_INDEX[phase],
		));
	}

	// ── 5. Circular dependencies ──────────────────────────────────────────────
	for (const cycle of cycleEdges) {
		const unit  = unitMap.get(cycle.fromId);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(cycle.fromId)?.phaseType ?? 'core-logic';
		add(makeBlocker(
			cycle.fromId, 'circular-dependency', 'blocking',
			`Circular dependency: "${unit.unitName}" ↔ "${unitMap.get(cycle.toId)?.unitName ?? cycle.toId}"`,
			`A cyclic dependency was detected between "${unit.unitName}" and ` +
			`"${unitMap.get(cycle.toId)?.unitName ?? cycle.toId}". ` +
			`This prevents clean topological ordering and will cause compilation errors in strongly-typed target languages.`,
			'Break the cycle by extracting shared state or shared behaviour into a third unit that both can depend on. ' +
			'Apply the Dependency Inversion Principle: depend on abstractions, not concretions.',
			Math.max(1, PHASE_INDEX[phase] - 1),
		));
	}

	// ── 6. Unbounded loops ─────────────────────────────────────────────────────
	const unboundedIds = new Set(
		techDebtItems
			.filter(t => t.category === 'unbounded-loop' && t.severity === 'error')
			.map(t => t.unitId),
	);
	for (const id of unboundedIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'core-logic';
		add(makeBlocker(
			id, 'unbounded-loop', 'warning',
			'Unbounded loop — potential infinite loop risk',
			`This unit contains a loop with no detectable termination condition. ` +
			`In the source language this may be intentional (e.g. a daemon loop), but must be ` +
			`explicitly handled in the target language to avoid CPU spinning or thread starvation.`,
			'Add an explicit termination condition (timeout, cancellation token, maximum iteration count) ' +
			'and document the expected lifetime of the loop in comments.',
			PHASE_INDEX[phase],
		));
	}

	// ── 7. Deep nesting ────────────────────────────────────────────────────────
	const deepNestIds = new Set(
		techDebtItems
			.filter(t => t.category === 'deep-nesting' && t.severity === 'error')
			.map(t => t.unitId),
	);
	for (const id of deepNestIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'core-logic';
		add(makeBlocker(
			id, 'deep-nesting', 'warning',
			'Extreme nesting depth — structural refactoring recommended',
			`This unit has nesting depth > 7. Such code is extremely difficult to translate reliably ` +
			`and will produce unreadable code in the target language.`,
			'Apply "extract method" refactoring to reduce nesting to ≤ 4 levels before translating. ' +
			'Replace nested conditionals with guard clauses (early returns). ' +
			'Consider breaking deeply nested blocks into helper functions.',
			PHASE_INDEX[phase],
		));
	}

	// ── 8. Implicit type coercion ──────────────────────────────────────────────
	const coercionIds = new Set(
		techDebtItems
			.filter(t => t.category === 'implicit-type-coercion')
			.map(t => t.unitId),
	);
	for (const id of coercionIds) {
		const unit = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'core-logic';
		add(makeBlocker(
			id, 'implicit-type-coercion', 'warning',
			'Implicit type coercion — precision risk',
			`This unit uses implicit type coercion (e.g. == vs ===, Python integer division, ` +
			`COBOL COMP-3 to floating-point). ` +
			`The target language may handle these differently, causing precision or type errors.`,
			'Audit all arithmetic operations and equality comparisons. ' +
			'Use explicit type conversions in the target language. ' +
			'For financial calculations: prefer fixed-point arithmetic or BigDecimal.',
			PHASE_INDEX[phase],
		));
	}

	// ── 9. Missing schema mapping for regulated schemas ────────────────────────
	for (const unitId of regulatedSchemaUnits) {
		const unit    = unitMap.get(unitId);
		if (!unit) { continue; }
		const pairing = bestPairing.get(unitId);
		if (!pairing) {
			const phase = phaseAssignments.get(unitId)?.phaseType ?? 'schema';
			add(makeBlocker(
				unitId, 'missing-schema-mapping', 'warning',
				'Regulated schema with no target mapping',
				`This unit contains a regulated-field data schema (table / FD / entity) but no ` +
				`target-side equivalent was found during cross-project pairing.`,
				'Create the target data schema (migration script, ORM entity, etc.) and ensure ' +
				'all regulated field names and types are correctly mapped. ' +
				'Document the field mapping for compliance purposes.',
				PHASE_INDEX[phase],
			));
		}
	}

	// ── 10. Blocking GRC violations (not already handled by compliance orderer) ─
	for (const unit of units) {
		if (!blockingFiles.has(unit.legacyFilePath)) { continue; }
		const phase = phaseAssignments.get(unit.id)?.phaseType ?? 'compliance';
		const key = `${unit.id}:blocking-grc-violation`;
		if (!seen.has(key)) {
			add(makeBlocker(
				unit.id, 'blocking-grc-violation',
				unit.riskLevel === 'critical' ? 'blocking' : 'warning',
				'Blocking GRC violation',
				`This unit's source file has one or more blocking-severity GRC violations. ` +
				`Migration cannot proceed until these violations are resolved or formally waived.`,
				'Fix the GRC violation(s) in the source code, re-run the GRC engine to clear them, ' +
				'then re-run Stage 1 discovery before resuming migration.',
				PHASE_INDEX[phase],
			));
		}
	}

	return blockers;
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBlocker(
	unitId: string,
	blockerType: MigrationBlockerType,
	severity: 'warning' | 'blocking',
	title: string,
	description: string,
	recommendedAction: string,
	resolveByPhaseIndex: number,
): IMigrationBlocker {
	return { unitId, blockerType, severity, title, description, recommendedAction, resolveByPhaseIndex };
}
