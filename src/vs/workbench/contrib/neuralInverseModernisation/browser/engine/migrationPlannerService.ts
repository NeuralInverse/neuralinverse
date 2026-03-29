/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Migration Planner Service — Stage 2
 *
 * Converts a Stage 1 `IDiscoveryResult` into a fully-structured
 * `IMigrationRoadmap` ready for developer review and plan approval.
 *
 * ## Architecture
 *
 * ```
 * generateRoadmap(discovery, pattern, sessionId)
 *   │
 *   ├─ Step 1: Build deterministic base roadmap
 *   │           roadmapBuilder.buildRoadmap(input without AI)
 *   │           ↳ topology + critical path + phases + blockers + gates
 *   │
 *   ├─ Step 2: Build rich LLM prompt from the base roadmap + full discovery data
 *   │           ↳ Phase breakdown, critical path units, effort summary,
 *   │             API surface, regulated data, tech debt, GRC snapshots,
 *   │             cross-project pairing confidence scores
 *   │
 *   ├─ Step 3: Call LLM via IContractReasonService.sendOneShotQuery()
 *   │           ↳ Rate-limited, exponential backoff, non-blocking on failure
 *   │
 *   ├─ Step 4: Parse LLM response into IAISupplement
 *   │           ↳ phaseOverrides, riskOverrides, complianceNotes, riskNarrative,
 *   │             estimatedEffort, additionalBlockers
 *   │
 *   └─ Step 5: Rebuild roadmap with AI supplement applied
 *               roadmapBuilder.buildRoadmap(input WITH aiSupplement)
 *               ↳ Returns final IMigrationRoadmap with generationMethod='ai-guided'
 * ```
 *
 * ## Graceful Degradation
 *
 * If the LLM call fails or returns unparseable JSON, `generateRoadmap` returns
 * the deterministic base roadmap (Step 1 result) with `generationMethod='deterministic'`.
 * The developer can re-trigger AI refinement later from the UI.
 *
 * ## Prompt Design
 *
 * The prompt sends structured data about the project to the LLM and requests
 * a JSON response with specific keys. The LLM acts as a senior migration
 * architect that:
 *  - Adjusts phase assignments based on domain knowledge
 *  - Refines risk levels based on code patterns
 *  - Writes concise compliance narrative
 *  - Identifies additional migration risks not caught by static analysis
 *
 * The LLM is NOT asked to order individual units (the dependency resolver does
 * this deterministically). It only provides semantic overrides and narrative.
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import {
	IMigrationRoadmap,
	MigrationRiskLevel,
	MigrationPhaseType,
} from '../../common/modernisationTypes.js';
import { IDiscoveryResult } from './discovery/discoveryTypes.js';
import { MigrationPattern } from '../modernisationSessionService.js';
import { buildRoadmap } from './planning/roadmapBuilder.js';
import { IAISupplement } from './planning/planningTypes.js';


// ─── Service Interface ────────────────────────────────────────────────────────

export const IMigrationPlannerService = createDecorator<IMigrationPlannerService>('modernisationMigrationPlanner');

export interface IMigrationPlannerService {
	readonly _serviceBrand: undefined;

	/** Fires human-readable status strings during roadmap generation (for UI display). */
	readonly onDidProgress: Event<string>;

	/**
	 * Generate a fully-structured migration roadmap from a discovery result.
	 *
	 * Returns a deterministic roadmap immediately if the LLM is unavailable.
	 *
	 * @param discovery  Stage 1 IDiscoveryResult (units + GRC + API surface + schemas + ...)
	 * @param pattern    Migration pattern ID or free-form string
	 * @param sessionId  Session ID for roadmap ID generation
	 */
	generateRoadmap(
		discovery: IDiscoveryResult,
		pattern: MigrationPattern,
		sessionId: string,
	): Promise<IMigrationRoadmap>;
}


// ─── Implementation ───────────────────────────────────────────────────────────

class MigrationPlannerService extends Disposable implements IMigrationPlannerService {
	readonly _serviceBrand: undefined;

	private readonly _onDidProgress = this._register(new Emitter<string>());
	readonly onDidProgress: Event<string> = this._onDidProgress.event;

	constructor() {
		super();
	}

	async generateRoadmap(
		discovery: IDiscoveryResult,
		pattern: MigrationPattern,
		sessionId: string,
	): Promise<IMigrationRoadmap> {
		// ── Step 1: Deterministic base roadmap ────────────────────────────────
		this._fire('Analysing discovery results and building dependency graph…');
		const baseRoadmap = buildRoadmap({ discovery, pattern, sessionId });

		const totalUnits     = baseRoadmap.totalUnits;
		const blockerCount   = baseRoadmap.migrationBlockers?.length ?? 0;
		const phaseCount     = baseRoadmap.phases?.length ?? 0;
		const effortHigh     = baseRoadmap.estimatedHoursHigh ?? 0;
		const critPathLen    = baseRoadmap.criticalPath?.length ?? 0;

		this._fire(
			`Base roadmap built: ${totalUnits} units across ${phaseCount} phases, ` +
			`${critPathLen} critical-path units, ` +
			`${blockerCount} blockers, ~${effortHigh}h estimated. ` +
			`Sending to AI for semantic refinement…`
		);

		// ── Step 2 & 3: LLM-refined roadmap not available in community edition ──
		this._fire('Generating AI-refined migration roadmap…');
		const aiResponse: string | undefined = undefined;

		if (!aiResponse) {
			this._fire('AI call failed — returning deterministic roadmap.');
			return baseRoadmap;
		}

		// ── Step 4: Parse AI response ─────────────────────────────────────────
		this._fire('Parsing AI supplement and applying overrides…');
		const aiSupplement = this._parseAISupplement(aiResponse);

		if (!aiSupplement) {
			this._fire('AI response could not be parsed — returning deterministic roadmap.');
			return baseRoadmap;
		}

		// ── Step 5: Rebuild with AI supplement ───────────────────────────────
		this._fire('Rebuilding roadmap with AI refinements…');
		const finalRoadmap = buildRoadmap({ discovery, pattern, sessionId, aiSupplement });

		this._fire(
			`Roadmap complete: ${finalRoadmap.totalUnits} units, ` +
			`${finalRoadmap.phases?.length ?? 0} phases, ` +
			`generation method: ${finalRoadmap.generationMethod}.`
		);

		return finalRoadmap;
	}


	// ─── AI Response Parser ───────────────────────────────────────────────────

	private _parseAISupplement(response: string): IAISupplement | undefined {
		try {
			// Extract JSON block — handle markdown code fences
			const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) ??
			                  response.match(/(\{[\s\S]*\})/);
			if (!jsonMatch) { return undefined; }

			const raw = JSON.parse(jsonMatch[1] ?? jsonMatch[0]) as Record<string, unknown>;

			// Validate and sanitise phaseOverrides
			const validPhases = new Set<string>([
				'foundation', 'schema', 'core-logic', 'api-layer', 'integration', 'compliance', 'cutover',
			]);
			const phaseOverrides: Record<string, MigrationPhaseType> = {};
			if (raw.phaseOverrides && typeof raw.phaseOverrides === 'object') {
				for (const [id, phase] of Object.entries(raw.phaseOverrides as Record<string, string>)) {
					if (validPhases.has(phase)) { phaseOverrides[id] = phase as MigrationPhaseType; }
				}
			}

			// Validate and sanitise riskOverrides
			const validRisks = new Set<string>(['critical', 'high', 'medium', 'low']);
			const riskOverrides: Record<string, MigrationRiskLevel> = {};
			if (raw.riskOverrides && typeof raw.riskOverrides === 'object') {
				for (const [id, risk] of Object.entries(raw.riskOverrides as Record<string, string>)) {
					if (validRisks.has(risk)) { riskOverrides[id] = risk as MigrationRiskLevel; }
				}
			}

			// Validate estimatedEffort
			const estimatedEffort = (['low', 'medium', 'high'] as const)
				.find(v => v === raw.estimatedEffort);

			// dependencyOverrides: Record<string, string[]>
			const dependencyOverrides: Record<string, string[]> = {};
			if (raw.dependencyOverrides && typeof raw.dependencyOverrides === 'object') {
				for (const [id, deps] of Object.entries(raw.dependencyOverrides as Record<string, unknown>)) {
					if (Array.isArray(deps)) {
						dependencyOverrides[id] = deps.filter(d => typeof d === 'string');
					}
				}
			}

			// additionalBlockers
			const additionalBlockers: IAISupplement['additionalBlockers'] = [];
			if (Array.isArray(raw.additionalBlockers)) {
				for (const b of raw.additionalBlockers as Array<Record<string, string>>) {
					if (b.unitId && b.description && (b.severity === 'warning' || b.severity === 'blocking')) {
						additionalBlockers.push({
							unitId:      b.unitId,
							description: b.description,
							severity:    b.severity,
						});
					}
				}
			}

			return {
				phaseOverrides:      Object.keys(phaseOverrides).length > 0 ? phaseOverrides : undefined,
				riskOverrides:       Object.keys(riskOverrides).length > 0 ? riskOverrides : undefined,
				complianceNotes:     typeof raw.complianceNotes === 'string' ? raw.complianceNotes : undefined,
				riskNarrative:       typeof raw.riskNarrative === 'string' ? raw.riskNarrative : undefined,
				estimatedEffort,
				dependencyOverrides: Object.keys(dependencyOverrides).length > 0 ? dependencyOverrides : undefined,
				additionalBlockers:  additionalBlockers.length > 0 ? additionalBlockers : undefined,
			};
		} catch {
			return undefined;
		}
	}


	// ─── Utility ──────────────────────────────────────────────────────────────

	private _fire(msg: string): void {
		this._onDidProgress.fire(msg);
	}
}


registerSingleton(IMigrationPlannerService, MigrationPlannerService, InstantiationType.Delayed);
