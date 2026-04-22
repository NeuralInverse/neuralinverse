/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Translation Context Builder
 *
 * Assembles the `IBuiltTranslationContext` that `translationPromptBuilder` needs
 * to produce an LLM prompt. All inputs come from:
 *
 *   - `IKnowledgeBaseService.getResolvedContext(unitId)` — pre-assembled KB context
 *   - `ILanguagePairProfile`  — idiom map + conventions from the language pair registry
 *   - `ITranslationOptions`   — target language, budget, framework overrides
 *
 * ## Budget Management
 *
 * Each context section is assigned a priority. When the total estimated token
 * count exceeds `options.maxTokensPerUnit`, sections are trimmed or dropped in
 * reverse-priority order:
 *
 *   Priority 1 (always kept) : resolved source, unit identity, language pair
 *   Priority 2               : type-mapping decisions, naming decisions
 *   Priority 3               : called interfaces (translated dependency signatures)
 *   Priority 4               : rule interpretations, pattern overrides
 *   Priority 5               : business rules, glossary terms
 *   Priority 6 (trimmed last): context annotations
 *
 * Token budget is estimated at 4 characters per token (conservative approximation).
 */

import {
	ITypeMappingDecision,
	INamingDecision,
	IRuleInterpretation,
	IPatternOverride,
	IUnitInterface,
	IBusinessRule,
	IBusinessTerm,
	IUnitAnnotation,
	IPendingDecision,
	IKnowledgeUnit,
} from '../../../../common/knowledgeBaseTypes.js';
import { IResolvedUnitContext } from '../../../knowledgeBase/types.js';
import { ITranslationOptions, IBuiltTranslationContext } from './translationTypes.js';
import { getLanguagePairProfile, ILanguagePairProfile } from './languagePairRegistry.js';
import { ITechDebtItem } from '../../discovery/discoveryTypes.js';
import { getSectorProfile } from '../../sectorRegistry.js';


// ─── Token budget constants ───────────────────────────────────────────────────

/** Conservative: 1 token ≈ 4 characters */
const CHARS_PER_TOKEN = 4;

/** Minimum source characters to keep even under extreme budget pressure */
const MIN_SOURCE_CHARS = 2_000;

/** Minimum budget reserved for the output (translated code) */
const OUTPUT_BUDGET_TOKENS = 4_000;


// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Build the full context package for a translation prompt.
 *
 * @param resolvedCtx       Context assembled by IKnowledgeBaseService.getResolvedContext()
 * @param options           Translation run options (target language, budget, frameworks)
 * @param techDebtItems     Optional tech debt items for the source unit (from techDebtAnalyzer)
 * @param blockingDecisions Optional already-locked decisions for this unit
 * @param calledUnits       Optional map of unitId → unit record for dependency health annotation
 * @param migrationPatternId Optional pattern ID from the session — used to inject sector aiGuidance
 * @returns                 IBuiltTranslationContext ready for translationPromptBuilder
 */
export function buildTranslationContext(
	resolvedCtx: IResolvedUnitContext,
	options: ITranslationOptions,
	techDebtItems?: ITechDebtItem[],
	blockingDecisions?: IPendingDecision[],
	calledUnits?: Map<string, IKnowledgeUnit>,
	migrationPatternId?: string,
): IBuiltTranslationContext {
	const unit = resolvedCtx.unit;
	const langPair = getLanguagePairProfile(unit.sourceLang, options.targetLanguage);

	// Apply any per-call overrides to the language pair profile
	const effectiveProfile: ILanguagePairProfile = {
		...langPair,
		targetFramework:     options.targetFramework     ?? langPair.targetFramework,
		targetTestFramework: options.targetTestFramework ?? langPair.targetTestFramework,
	};

	// ── Format new enrichment sections ───────────────────────────────────────
	const techDebtSummary         = techDebtItems && techDebtItems.length > 0
		? formatTechDebt(techDebtItems)
		: undefined;
	const blockingDecisionsContext = blockingDecisions && blockingDecisions.length > 0
		? formatBlockingDecisions(blockingDecisions)
		: undefined;
	const calledUnitHealthContext  = calledUnits && calledUnits.size > 0
		? formatCalledUnitHealth(resolvedCtx.calledInterfaces, calledUnits)
		: undefined;
	const sectorGuidance = migrationPatternId
		? getSectorProfile(migrationPatternId)?.aiGuidance
		: undefined;

	// ── Format all context sections into strings ──────────────────────────────

	const typeMappingContext      = formatTypeMappings(resolvedCtx.applicableTypeMappings);
	const namingContext           = formatNamingDecisions(resolvedCtx.applicableNamingDecisions);
	const ruleInterpretContext    = formatRuleInterpretations(resolvedCtx.ruleInterpretations);
	const patternOverrideContext  = formatPatternOverrides(resolvedCtx.patternOverrides);
	const calledInterfacesContext = formatCalledInterfaces(resolvedCtx.calledInterfaces);
	const businessRulesContext    = formatBusinessRules(resolvedCtx.relatedRules);
	const glossaryContext         = formatGlossary(resolvedCtx.relevantGlossaryTerms);
	const annotationContext       = formatAnnotations(resolvedCtx.contextAnnotations);
	const idiomMapSummary         = formatIdiomMap(effectiveProfile);
	const conventionNotes         = formatBulletList(effectiveProfile.conventionNotes);
	const warningPatternNotes     = formatBulletList(effectiveProfile.warningPatterns);

	// ── Budget management ──────────────────────────────────────────────────────

	// Token budget available for context (subtract output budget)
	const contextBudgetTokens = options.maxTokensPerUnit - OUTPUT_BUDGET_TOKENS;
	const contextBudgetChars  = contextBudgetTokens * CHARS_PER_TOKEN;

	// Fixed overhead: identity + language pair profile
	const fixedOverhead =
		unit.name.length + unit.sourceLang.length + unit.unitType.length +
		effectiveProfile.label.length +
		(effectiveProfile.systemPersona?.length ?? 0) +
		idiomMapSummary.length + conventionNotes.length + warningPatternNotes.length +
		(options.migrationPatternLabel?.length ?? 0) +
		(options.targetConventions?.length ?? 0);

	const remainingChars = contextBudgetChars - fixedOverhead;

	// Trim sections in reverse-priority order until we fit
	const sections: Array<{ name: string; content: string; mutable: true } |
	                       { name: string; content: string; mutable: false }> = [
		// Priority 1 — always preserved (source may be truncated but not dropped)
		{ name: 'source',              content: resolvedCtx.resolvedSource,    mutable: true  },
		// Priority 2
		{ name: 'type-mappings',       content: typeMappingContext,            mutable: true  },
		{ name: 'naming',              content: namingContext,                 mutable: true  },
		// Priority 3
		{ name: 'called-interfaces',   content: calledInterfacesContext,       mutable: true  },
		// Priority 4
		{ name: 'rule-interpret',      content: ruleInterpretContext,          mutable: true  },
		{ name: 'pattern-overrides',   content: patternOverrideContext,        mutable: true  },
		// Priority 5
		{ name: 'business-rules',      content: businessRulesContext,          mutable: true  },
		{ name: 'glossary',            content: glossaryContext,               mutable: true  },
		// Priority 6 — trimmed first
		{ name: 'annotations',         content: annotationContext,             mutable: true  },
	];

	const trimmedSections: string[] = [];
	let totalChars = sections.reduce((s, sec) => s + sec.content.length, 0);

	// Trim from lowest to highest priority until we fit
	for (let i = sections.length - 1; i >= 0 && totalChars > remainingChars; i--) {
		const sec = sections[i];
		if (!sec.mutable) { continue; }

		const excess = totalChars - remainingChars;
		if (sec.content.length <= excess) {
			// Drop entire section
			trimmedSections.push(sec.name);
			totalChars -= sec.content.length;
			(sec as { name: string; content: string; mutable: true }).content = '';
		} else {
			// Trim the section
			const keep = sec.content.length - excess;
			(sec as { name: string; content: string; mutable: true }).content =
				sec.content.slice(0, keep) +
				`\n... [truncated for token budget] ...`;
			totalChars = remainingChars;
			trimmedSections.push(`${sec.name} (partial)`);
		}
	}

	// Special case: source must have at least MIN_SOURCE_CHARS
	const sourceSection = sections.find(s => s.name === 'source')!;
	if (sourceSection.content.length < MIN_SOURCE_CHARS && resolvedCtx.resolvedSource.length >= MIN_SOURCE_CHARS) {
		sourceSection.content = resolvedCtx.resolvedSource.slice(0, MIN_SOURCE_CHARS) +
			'\n... [source truncated — file too large for token budget] ...';
	}

	const contentMap = Object.fromEntries(sections.map(s => [s.name, s.content]));

	const estimatedTokens = Math.ceil(
		(fixedOverhead + sections.reduce((s, sec) => s + sec.content.length, 0)) / CHARS_PER_TOKEN
	);

	const finalSource = contentMap['source'] ?? resolvedCtx.resolvedSource;
	const isSourceTruncated =
		trimmedSections.some(s => s === 'source' || s === 'source (partial)') ||
		finalSource.includes('[truncated for token budget]') ||
		finalSource.includes('[source truncated');

	return {
		unitId:     unit.id,
		unitName:   unit.name,
		unitType:   unit.unitType,
		sourceLang: unit.sourceLang,
		targetLang: options.targetLanguage,
		riskLevel:  unit.riskLevel,
		domain:     unit.domain,

		resolvedSource: finalSource,

		languagePairLabel:    effectiveProfile.label,
		targetFramework:      effectiveProfile.targetFramework,
		targetTestFramework:  effectiveProfile.targetTestFramework,
		systemPersona:        effectiveProfile.systemPersona ?? GENERIC_PERSONA,
		idiomMapSummary,
		conventionNotes,
		warningPatternNotes,

		typeMappingContext:         contentMap['type-mappings']     ?? '',
		namingContext:              contentMap['naming']             ?? '',
		ruleInterpretationContext:  contentMap['rule-interpret']     ?? '',
		patternOverrideContext:     contentMap['pattern-overrides']  ?? '',
		calledInterfacesContext:    contentMap['called-interfaces']  ?? '',
		businessRulesContext:       contentMap['business-rules']     ?? '',
		glossaryContext:            contentMap['glossary']           ?? '',
		annotationContext:          contentMap['annotations']        ?? '',
		migrationPatternLabel:      options.migrationPatternLabel,
		targetConventions:          options.targetConventions,

		estimatedTokens,
		wasBudgetTrimmed: trimmedSections.length > 0,
		trimmedSections,
		isSourceTruncated,

		techDebtSummary,
		blockingDecisionsContext,
		calledUnitHealthContext,
		sectorGuidance,
	};
}


// ─── Section formatters ───────────────────────────────────────────────────────

function formatTypeMappings(decisions: ITypeMappingDecision[]): string {
	if (decisions.length === 0) { return ''; }
	const lines = decisions.map(d =>
		`  ${d.sourceType} → ${d.targetType}${d.rationale ? `  // ${d.rationale}` : ''}`
	);
	return `## Established Type Mappings\n${lines.join('\n')}\n`;
}

function formatNamingDecisions(decisions: INamingDecision[]): string {
	if (decisions.length === 0) { return ''; }
	const lines = decisions.map(d =>
		`  ${d.sourceName} → ${d.targetName}${d.domain ? `  // domain: ${d.domain}` : ''}`
	);
	return `## Established Naming Decisions\n${lines.join('\n')}\n`;
}

function formatRuleInterpretations(interpretations: IRuleInterpretation[]): string {
	if (interpretations.length === 0) { return ''; }
	const lines = interpretations.map(d =>
		`  [${d.id}] ${d.meaning}` +
		(d.sourceText ? `\n    → in: ${d.sourceText.slice(0, 80)}` : '')
	);
	return `## Rule Interpretations\n${lines.join('\n')}\n`;
}

function formatPatternOverrides(overrides: IPatternOverride[]): string {
	if (overrides.length === 0) { return ''; }
	const lines = overrides.map(d =>
		`  ${d.pattern}: ${d.value}` +
		(d.rationale ? `  — ${d.rationale}` : '')
	);
	return `## Pattern Overrides\n${lines.join('\n')}\n`;
}

function formatCalledInterfaces(ifaces: IUnitInterface[]): string {
	if (ifaces.length === 0) { return ''; }
	const parts = ifaces.map(iface => {
		const sigLines = iface.signatures.map(sig => `    ${sig}`);
		const header = `  [unit:${iface.unitId}]${iface.summary ? `  // ${iface.summary}` : ''}`;
		return `${header}\n${sigLines.join('\n') || '    (no signatures recorded)'}`;
	});
	return `## Translated Interfaces of Called Units\n` +
		`// Use these exact signatures when calling these units from translated code\n` +
		parts.join('\n\n') + '\n';
}

function formatBusinessRules(rules: IBusinessRule[]): string {
	if (rules.length === 0) { return ''; }
	const lines = rules
		.filter(r => r.preservationRequired)
		.slice(0, 20)
		.map(r => `  - [${r.domain}] ${r.description}${r.confidence < 0.8 ? ' (AI-inferred)' : ''}`);
	if (lines.length === 0) { return ''; }
	return `## Business Rules (must be preserved in translation)\n${lines.join('\n')}\n`;
}

function formatGlossary(terms: IBusinessTerm[]): string {
	if (terms.length === 0) { return ''; }
	const lines = terms.slice(0, 30).map(t =>
		`  ${t.term}: ${t.meaning}${t.domain ? ` (domain: ${t.domain})` : ''}`
	);
	return `## Domain Glossary\n${lines.join('\n')}\n`;
}

function formatAnnotations(annotations: IUnitAnnotation[]): string {
	const contextAnnotations = annotations.filter(a => a.kind === 'context-injection');
	if (contextAnnotations.length === 0) { return ''; }
	const lines = contextAnnotations.map(a => `  NOTE: ${a.content}`);
	return `## Context Notes (human-added)\n${lines.join('\n')}\n`;
}

function formatIdiomMap(profile: ILanguagePairProfile): string {
	if (profile.idiomMap.length === 0) { return ''; }
	const lines = profile.idiomMap.map(m =>
		`  ${m.sourceConstruct}\n    → ${m.targetConstruct}` +
		(m.notes ? `\n      Note: ${m.notes}` : '')
	);
	return `## Key Construct Mappings (${profile.label})\n${lines.join('\n')}\n`;
}

function formatBulletList(items: string[]): string {
	if (items.length === 0) { return ''; }
	return items.map(s => `  • ${s}`).join('\n');
}

const GENERIC_PERSONA = 'You are an expert software migration engineer with deep knowledge of both the source and target programming languages.';


// ─── Enrichment formatters ────────────────────────────────────────────────────

function formatTechDebt(items: ITechDebtItem[]): string {
	if (items.length === 0) { return ''; }
	const errors   = items.filter(i => i.severity === 'error');
	const warnings = items.filter(i => i.severity === 'warning');
	const infos    = items.filter(i => i.severity === 'info');
	const lines: string[] = [
		`## Source Tech Debt (${items.length} items — address during translation where possible)`,
	];
	for (const item of [...errors, ...warnings, ...infos].slice(0, 15)) {
		const badge = item.severity === 'error' ? '❌' : item.severity === 'warning' ? '⚠' : 'ℹ';
		const loc   = item.lineNumber ? ` (line ${item.lineNumber})` : '';
		lines.push(`  ${badge} [${item.category}]${loc} ${item.description}`);
		if (item.migrationImpact) {
			lines.push(`      Migration impact: ${item.migrationImpact}`);
		}
	}
	if (items.length > 15) {
		lines.push(`  … and ${items.length - 15} more items`);
	}
	return lines.join('\n') + '\n';
}

function formatBlockingDecisions(decisions: IPendingDecision[]): string {
	if (decisions.length === 0) { return ''; }
	const lines = [
		`## Locked Decisions (DO NOT re-raise — already resolved)`,
	];
	for (const d of decisions.slice(0, 10)) {
		const resolvedLabel = d.resolvedAt ? ' (resolved)' : '';
		lines.push(`  [${d.type}]${resolvedLabel} ${d.question.slice(0, 100)}`);
	}
	return lines.join('\n') + '\n';
}

function formatCalledUnitHealth(ifaces: IUnitInterface[], calledUnits: Map<string, IKnowledgeUnit>): string {
	const annotated = ifaces.map(iface => {
		const unit = calledUnits.get(iface.unitId);
		if (!unit) { return null; }
		let health = '✓ stable';
		if (unit.status === 'blocked' || unit.pendingDecisionId) {
			health = '✗ blocked';
		} else if (unit.status === 'pending' || unit.status === 'ready') {
			health = '⚠ not-yet-translated';
		}
		return `  [unit:${iface.unitId}] ${health}`;
	}).filter((l): l is string => l !== null);

	if (annotated.length === 0) { return ''; }
	return `## Dependency Health\n${annotated.join('\n')}\n`;
}
