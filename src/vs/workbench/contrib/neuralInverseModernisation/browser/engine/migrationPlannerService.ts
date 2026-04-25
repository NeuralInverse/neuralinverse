/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Migration Planner Service \u2014 Stage 2
 *
 * Converts a Stage 1 `IDiscoveryResult` into a fully-structured
 * `IMigrationRoadmap` ready for developer review and plan approval.
 *
 * ## Architecture
 *
 * ```
 * generateRoadmap(discovery, pattern, sessionId)
 *   \u2502
 *   \u251C\u2500 Step 1: Build deterministic base roadmap
 *   \u2502           roadmapBuilder.buildRoadmap(input without AI)
 *   \u2502           \u21B3 topology + critical path + phases + blockers + gates
 *   \u2502
 *   \u251C\u2500 Step 2: Build rich LLM prompt from the base roadmap + full discovery data
 *   \u2502           \u21B3 Phase breakdown, critical path units, effort summary,
 *   \u2502             API surface, regulated data, tech debt, GRC snapshots,
 *   \u2502             cross-project pairing confidence scores
 *   \u2502
 *   \u251C\u2500 Step 3: Call LLM via IContractReasonService.sendOneShotQuery()
 *   \u2502           \u21B3 Rate-limited, exponential backoff, non-blocking on failure
 *   \u2502
 *   \u251C\u2500 Step 4: Parse LLM response into IAISupplement
 *   \u2502           \u21B3 phaseOverrides, riskOverrides, complianceNotes, riskNarrative,
 *   \u2502             estimatedEffort, additionalBlockers
 *   \u2502
 *   \u2514\u2500 Step 5: Rebuild roadmap with AI supplement applied
 *               roadmapBuilder.buildRoadmap(input WITH aiSupplement)
 *               \u21B3 Returns final IMigrationRoadmap with generationMethod='ai-guided'
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
import { IContractReasonService } from '../../../neuralInverseChecks/browser/engine/services/contractReasonService.js';
import { IFrameworkRegistry } from '../../../neuralInverseChecks/browser/engine/framework/frameworkRegistry.js';
import {
	IMigrationRoadmap,
	MigrationRiskLevel,
	MigrationPhaseType,
} from '../../common/modernisationTypes.js';
import { IDiscoveryResult, IProjectScanResult, IGRCSnapshot } from './discovery/discoveryTypes.js';
import { MigrationPattern, MIGRATION_PATTERN_LABELS } from '../modernisationSessionService.js';
import { buildRoadmap } from './planning/roadmapBuilder.js';
import { IAISupplement } from './planning/planningTypes.js';


// \u2500\u2500\u2500 Service Interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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


// \u2500\u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

class MigrationPlannerService extends Disposable implements IMigrationPlannerService {
	readonly _serviceBrand: undefined;

	private readonly _onDidProgress = this._register(new Emitter<string>());
	readonly onDidProgress: Event<string> = this._onDidProgress.event;

	constructor(
		@IContractReasonService private readonly contractReason: IContractReasonService,
		@IFrameworkRegistry     private readonly frameworkRegistry: IFrameworkRegistry,
	) {
		super();
	}

	async generateRoadmap(
		discovery: IDiscoveryResult,
		pattern: MigrationPattern,
		sessionId: string,
	): Promise<IMigrationRoadmap> {
		// \u2500\u2500 Step 1: Deterministic base roadmap \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		this._fire('Analysing discovery results and building dependency graph\u2026');
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
			`Sending to AI for semantic refinement\u2026`
		);

		// \u2500\u2500 Step 2: Build rich LLM prompt \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const prompt = this._buildPrompt(discovery, pattern, baseRoadmap);

		// \u2500\u2500 Step 3: LLM call \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		this._fire('Generating AI-refined migration roadmap\u2026');
		let aiResponse: string | undefined;
		try {
			aiResponse = await this.contractReason.sendOneShotQuery(prompt);
		} catch {
			aiResponse = undefined;
		}

		if (!aiResponse) {
			this._fire('AI call failed \u2014 returning deterministic roadmap.');
			return baseRoadmap;
		}

		// \u2500\u2500 Step 4: Parse AI response \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		this._fire('Parsing AI supplement and applying overrides\u2026');
		const aiSupplement = this._parseAISupplement(aiResponse);

		if (!aiSupplement) {
			this._fire('AI response could not be parsed \u2014 returning deterministic roadmap.');
			return baseRoadmap;
		}

		// \u2500\u2500 Step 5: Rebuild with AI supplement \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		this._fire('Rebuilding roadmap with AI refinements\u2026');
		const finalRoadmap = buildRoadmap({ discovery, pattern, sessionId, aiSupplement });

		this._fire(
			`Roadmap complete: ${finalRoadmap.totalUnits} units, ` +
			`${finalRoadmap.phases?.length ?? 0} phases, ` +
			`generation method: ${finalRoadmap.generationMethod}.`
		);

		return finalRoadmap;
	}


	// \u2500\u2500\u2500 Prompt Builder \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _buildPrompt(
		discovery: IDiscoveryResult,
		pattern: MigrationPattern,
		baseRoadmap: IMigrationRoadmap,
	): string {
		const patternLabel = MIGRATION_PATTERN_LABELS[pattern] ?? pattern;

		// Loaded enterprise frameworks from the Checks engine \u2014 used in the prompt
		// so the AI references the actual frameworks this organisation has configured,
		// not generic hardcoded standard names.
		const activeFrameworks = this.frameworkRegistry.getActiveFrameworks();
		const frameworkNames   = activeFrameworks.map(f => f.definition.framework.name);

		const srcSummaries = discovery.sources.map(s => this._summariseProject(s)).join('\n');
		const tgtSummaries = discovery.targets.map(t => this._summariseProject(t)).join('\n');

		// Phase breakdown (compact)
		const phaseSummary = (baseRoadmap.phases ?? []).map(p =>
			`  Phase ${p.index} [${p.phaseType}]: ${p.unitIds.length} units, ` +
			`${p.estimatedHoursLow}\u2013${p.estimatedHoursHigh}h, ` +
			`${p.riskDistribution.critical} critical, ${p.riskDistribution.high} high risk` +
			(p.hasComplianceGate ? ', COMPLIANCE GATE' : '') +
			(p.hasAPICompatibilityGate ? ', API GATE' : '')
		).join('\n');

		// Critical path (max 20 units)
		const critPathStr = (baseRoadmap.criticalPath ?? [])
			.slice(0, 20)
			.map(n => `  "${n.unitName}" [${n.phaseType}] \u2014 ${n.effortHoursHigh}h, slack=${n.slack}h`)
			.join('\n');

		// Migration blockers (max 15)
		const blockerStr = (baseRoadmap.migrationBlockers ?? [])
			.filter(b => b.severity === 'blocking')
			.slice(0, 15)
			.map(b => `  [${b.severity.toUpperCase()}] ${b.blockerType}: "${b.title}"`)
			.join('\n');

		// Top tech debt across all source projects
		const topDebt = discovery.sources
			.flatMap(s => s.techDebtItems)
			.filter(t => t.severity === 'error')
			.slice(0, 20)
			.map(t => `  ${t.category}: "${t.description.slice(0, 80)}"`)
			.join('\n');

		// API surface summary
		const apiSummary = discovery.sources.flatMap(s => s.apiEndpoints)
			.reduce((acc, e) => {
				acc[e.kind] = (acc[e.kind] ?? 0) + 1;
				return acc;
			}, {} as Record<string, number>);
		const apiStr = Object.entries(apiSummary)
			.sort((a, b) => b[1] - a[1])
			.map(([k, c]) => `  ${k}: ${c}`)
			.join('\n');

		// Regulated data summary
		const regSummary = discovery.sources.flatMap(s => s.regulatedDataHits)
			.reduce((acc, h) => {
				acc[h.pattern] = (acc[h.pattern] ?? 0) + 1;
				return acc;
			}, {} as Record<string, number>);
		const regStr = Object.entries(regSummary)
			.sort((a, b) => b[1] - a[1])
			.map(([p, c]) => `  ${p}: ${c} hits`)
			.join('\n');

		// Cross-project pairing confidence distribution
		const pairingDist = discovery.crossProjectPairings.reduce(
			(acc, p) => {
				const bucket = p.confidenceScore >= 0.85 ? 'high (\u226585%)' :
				              p.confidenceScore >= 0.60 ? 'medium (60\u201384%)' : 'low (<60%)';
				acc[bucket] = (acc[bucket] ?? 0) + 1;
				return acc;
			}, {} as Record<string, number>
		);
		const pairingStr = Object.entries(pairingDist)
			.map(([b, c]) => `  ${b}: ${c} pairings`)
			.join('\n');

		// Sample of high-risk units (max 30)
		const highRiskUnits = discovery.sources
			.flatMap(s => s.units)
			.filter(u => u.riskLevel === 'critical' || u.riskLevel === 'high')
			.slice(0, 30)
			.map(u => {
				const effort = discovery.sources
					.flatMap(s => s.effortEstimates)
					.find(e => e.unitId === u.id);
				return `  { "id": "${u.id}", "name": "${u.unitName}", "risk": "${u.riskLevel}", ` +
				       `"type": "${u.unitType}", "effortBand": "${effort?.effortBand ?? 'unknown'}" }`;
			})
			.join('\n');

		// GRC cross-mapping
		const grcBaggage  = this._summariseGRC(discovery.sources.map(s => s.grcSnapshot));
		const grcDebt     = this._summariseGRC(discovery.targets.map(t => t.grcSnapshot));
		const effortDist  = discovery.sources
			.flatMap(s => s.effortEstimates)
			.reduce((acc, e) => { acc[e.effortBand] = (acc[e.effortBand] ?? 0) + 1; return acc; }, {} as Record<string, number>);
		const effortStr   = Object.entries(effortDist)
			.map(([b, c]) => `  ${b}: ${c} units`)
			.join('\n');

		const frameworkSection = frameworkNames.length > 0
			? frameworkNames.map(n => `  - ${n}`).join('\n')
			: '  (none loaded \u2014 enterprise frameworks are imported via .inverse/frameworks/)';

		const complianceNotesRule = frameworkNames.length > 0
			? `- complianceNotes: Focus on actionable compliance requirements. Reference the loaded frameworks listed above ` +
			  `where relevant to the detected data patterns. Do not invent framework names that are not in the list.`
			: `- complianceNotes: Focus on actionable compliance requirements based on the GRC violations detected. ` +
			  `No enterprise frameworks are currently loaded.`;

		return `You are a principal migration architect with deep expertise in legacy modernisation.
Analyse the following project discovery data and refine the deterministic migration roadmap.

## Migration Pattern
${patternLabel} (id: ${pattern})

## Loaded Enterprise Compliance Frameworks
${frameworkSection}

## Source Projects
${srcSummaries || '  (none)'}

## Target Projects
${tgtSummaries || '  (none)'}

## Deterministic Phase Breakdown
${phaseSummary || '  (none)'}

## Critical Path (zero-slack units \u2014 project duration drivers)
${critPathStr || '  (none identified)'}

## Migration Blockers (blocking severity)
${blockerStr || '  (none)'}

## Effort Distribution
${effortStr || '  (none)'}
Total estimated: ${baseRoadmap.estimatedHoursLow}\u2013${baseRoadmap.estimatedHoursHigh} hours

## API Surface (source)
${apiStr || '  (none detected)'}

## Regulated Data Hits (source)
${regStr || '  (none detected)'}

## Cross-Project Pairing Confidence
${pairingStr || '  (no pairings)'}

## Technical Debt (error-severity, source)
${topDebt || '  (none)'}

## Compliance Baggage (GRC violations in legacy code)
${grcBaggage || '  None detected'}

## Migration Debt (GRC violations already in target code)
${grcDebt || '  None detected'}

## High and Critical Risk Units (max 30)
${highRiskUnits || '  (none)'}

## Your Task

Return a JSON object with the following structure. Do NOT include any text outside the JSON block.

{
  "phaseOverrides": {
    "<unitId>": "<phaseType>"
  },
  "riskOverrides": {
    "<unitId>": "<riskLevel>"
  },
  "complianceNotes": "<1-3 sentences covering: regulated data risk, GRC baggage to carry forward, compliance-critical ordering>",
  "riskNarrative": "<1-3 sentences covering: top migration risks, API compatibility concerns, critical path risks>",
  "estimatedEffort": "low|medium|high",
  "dependencyOverrides": {
    "<unitId>": ["<depUnitId>", ...]
  },
  "additionalBlockers": [
    { "unitId": "<id>", "description": "<text>", "severity": "warning|blocking" }
  ]
}

## Rules

- phaseOverrides: Only override phase assignments where the deterministic result is clearly wrong based on domain knowledge. Use these phase types ONLY: foundation | schema | core-logic | api-layer | integration | compliance | cutover
- riskOverrides: Only override risk when the static analysis risk is demonstrably incorrect. Use: critical | high | medium | low
${complianceNotesRule}
- riskNarrative: Focus on migration-specific risks (API breakage, data loss, precision loss, compliance gaps), not general coding advice.
- estimatedEffort: Overall project effort classification, not per-unit.
- dependencyOverrides: Add ONLY where you have high confidence that a dependency is missing. Do NOT add speculative dependencies.
- additionalBlockers: Surface migration-specific issues not caught by static analysis (e.g., business-logic constraints, data migration complexity, integration contracts).
- Omit any field you have no confident input for \u2014 it is better to return fewer overrides than incorrect ones.`;
	}

	private _summariseProject(project: IProjectScanResult): string {
		const grc = project.grcSnapshot;
		const stats = project.stats;
		const dominant = project.dominantLanguage;
		const secondary = project.secondaryLanguage ? `, ${project.secondaryLanguage}` : '';
		const effortDist = project.effortEstimates.reduce(
			(acc, e) => { acc[e.effortBand] = (acc[e.effortBand] ?? 0) + 1; return acc; },
			{} as Record<string, number>,
		);
		const effortStr = Object.entries(effortDist).map(([b, c]) => `${b}:${c}`).join(', ');

		return (
			`  - "${project.projectLabel}" [${dominant}${secondary}]\n` +
			`    ${stats.totalFilesScanned} files, ${stats.totalUnitsExtracted} units, ` +
			`${stats.criticalUnitCount} critical\n` +
			`    GRC: ${grc.totalViolations} violations (${grc.blockingCount} blocking)\n` +
			`    Domains: ${Object.entries(grc.byDomain).map(([d, c]) => `${d}:${c}`).join(', ') || 'none'}\n` +
			`    Effort dist: ${effortStr || 'unknown'}\n` +
			`    API endpoints: ${project.apiEndpoints.length}, ` +
			`schemas: ${project.dataSchemas.length}, ` +
			`regulated hits: ${project.regulatedDataHits.length}, ` +
			`tech debt: ${project.techDebtItems.length}`
		);
	}

	private _summariseGRC(snapshots: IGRCSnapshot[]): string {
		const merged: Record<string, number> = {};
		let blocking = 0;
		let total = 0;
		for (const s of snapshots) {
			total += s.totalViolations;
			blocking += s.blockingCount;
			for (const [d, c] of Object.entries(s.byDomain)) {
				merged[d] = (merged[d] ?? 0) + c;
			}
		}
		if (total === 0) { return ''; }
		return (
			`  Total: ${total} violations, ${blocking} blocking\n` +
			`  Domains: ${Object.entries(merged).sort((a, b) => b[1] - a[1]).map(([d, c]) => `${d}: ${c}`).join(', ')}`
		);
	}


	// \u2500\u2500\u2500 AI Response Parser \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _parseAISupplement(response: string): IAISupplement | undefined {
		try {
			// Extract JSON block \u2014 handle markdown code fences
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


	// \u2500\u2500\u2500 Utility \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _fire(msg: string): void {
		this._onDidProgress.fire(msg);
	}
}


registerSingleton(IMigrationPlannerService, MigrationPlannerService, InstantiationType.Delayed);
