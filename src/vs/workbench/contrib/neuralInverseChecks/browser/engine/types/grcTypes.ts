/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # GRC Core Types
 *
 * Central type definitions for the Neural Inverse GRC engine.
 *
 * ## Design Principles
 *
 * 1. **Framework-agnostic**: Domains and severities are strings, not fixed enums.
 *    Enterprises define their own via imported frameworks.
 *
 * 2. **Backward compatible**: The built-in domain aliases (`GRC_BUILTIN_DOMAINS`)
 *    and default severity type (`GRCSeverity`) are preserved so existing code
 *    continues to work without changes.
 *
 * 3. **Extensible rule types**: Rules can use `regex`, `ast`, `dataflow`,
 *    `import-graph`, `external`, or `file-level` checks. The engine routes
 *    each rule to the appropriate analyzer.
 */

import { URI } from '../../../../../../base/common/uri.js';
import { ICheckDefinition } from '../framework/frameworkSchema.js';


// ─── Domains ─────────────────────────────────────────────────────────────────

/**
 * GRC Domain — the category a rule belongs to.
 *
 * ## IMPORTANT: This is now a `string`, not a fixed union type.
 *
 * Frameworks can define ANY domain/category they want. The built-in domains
 * below are the defaults that ship with the IDE, but enterprises can add
 * their own (e.g. "hipaa", "gdpr", "internal-audit", "soc2", etc.).
 *
 * The `GRC_BUILTIN_DOMAINS` constant lists the built-in domains for
 * code that needs to reference them directly.
 */
export type GRCDomain = string;

/**
 * Built-in domain identifiers.
 *
 * These map to the default subsystem views in the Checks Manager.
 * Kept as constants so existing code that references specific domains
 * continues to compile and work.
 */
export const GRC_BUILTIN_DOMAINS = {
	SECURITY: 'security' as GRCDomain,
	COMPLIANCE: 'compliance' as GRCDomain,
	DATA_INTEGRITY: 'data-integrity' as GRCDomain,
	ARCHITECTURE: 'architecture' as GRCDomain,
	FAIL_SAFE: 'fail-safe' as GRCDomain,
	POLICY: 'policy' as GRCDomain,
} as const;

/**
 * All built-in domain values as an array, useful for iteration.
 */
export const GRC_BUILTIN_DOMAIN_LIST: GRCDomain[] = Object.values(GRC_BUILTIN_DOMAINS);


// ─── Severity ────────────────────────────────────────────────────────────────

/**
 * Severity levels for GRC rules.
 *
 * The IDE natively understands these three display severities:
 * - error: Shown as red squiggle in editor.
 * - warning: Shown as yellow squiggle.
 * - info: Shown as blue hint.
 *
 * Frameworks can define custom severity names (e.g. "blocker", "critical",
 * "major", "minor") which are mapped to one of these display severities
 * via the framework's `severityLevels` definition.
 */
export type GRCSeverity = 'error' | 'warning' | 'info';

/**
 * Maps a custom severity string to a display severity.
 *
 * If the severity is already a standard one ("error", "warning", "info"),
 * returns it directly. Otherwise, defaults to "warning".
 *
 * This is used when framework-defined rules have custom severity names
 * and we need to determine the squiggly underline color.
 */
export function toDisplaySeverity(severity: string): GRCSeverity {
	switch (severity) {
		case 'error': return 'error';
		case 'warning': return 'warning';
		case 'info': return 'info';
		// Common custom severities mapped to reasonable defaults
		case 'blocker': return 'error';
		case 'critical': return 'error';
		case 'major': return 'warning';
		case 'minor': return 'info';
		default: return 'warning';
	}
}


// ─── Rule Types ──────────────────────────────────────────────────────────────

/**
 * All supported rule check types.
 *
 * - 'regex'        — match pattern against each line (existing, fast)
 * - 'file-level'   — evaluate at file level (e.g. max lines)
 * - 'ast'          — TypeScript AST structural analysis
 * - 'dataflow'     — taint tracking (source \u2192 sink)
 * - 'import-graph' — architecture-level import analysis
 * - 'external'     — delegate to any CLI tool
 */
export type GRCRuleType = 'regex' | 'file-level' | 'ast' | 'dataflow' | 'import-graph' | 'external' | 'universal' | 'invariant' | 'svd-c' | 'c-structural' | 'ics-security' | 'telecom-security' | 'iot-ot';


// ─── Rule Definition ─────────────────────────────────────────────────────────

/**
 * A single GRC rule definition.
 *
 * Rules can come from three sources:
 * 1. **Built-in** — shipped with the IDE (builtinRules.ts)
 * 2. **User-defined** — from .inverse/grc-rules.json
 * 3. **Framework-sourced** — from .inverse/frameworks/*.json
 *
 * The `frameworkId` field indicates which framework the rule came from
 * (undefined for built-in and user-defined rules).
 */
export interface IGRCRule {
	/** Unique identifier, e.g. "SEC-001" or "ACME-SEC-001" */
	id: string;

	/**
	 * Which domain/category this rule belongs to.
	 *
	 * Now a string (not a fixed union) — frameworks define their own categories.
	 * Built-in domains: "security", "compliance", "data-integrity",
	 * "architecture", "fail-safe", "policy".
	 */
	domain: GRCDomain;

	/**
	 * Severity of a violation.
	 *
	 * Can be a standard severity ("error", "warning", "info") or a
	 * custom severity defined by the source framework (e.g. "blocker",
	 * "critical", "major"). Use `toDisplaySeverity()` to convert
	 * to a display severity for editor squiggles.
	 */
	severity: string;

	/**
	 * Regex pattern string for regex-type rules.
	 *
	 * @deprecated For new rules, use the `check` field with a structured
	 * check definition. This field is retained for backward compatibility
	 * with existing built-in rules and user configs.
	 */
	pattern: string;

	/** Human-readable description shown in diagnostics and dashboard */
	message: string;

	/** Optional suggested fix text */
	fix?: string;

	/**
	 * Detailed description from the framework definition (separate from the
	 * one-line `message`).  Used by analyzers to append richer context to
	 * violation messages and by the AI feedback loop to supply background
	 * knowledge about why a rule exists.
	 */
	description?: string;

	/** Whether this rule is active */
	enabled: boolean;

	/** Whether this is a built-in rule (cannot be deleted, only disabled) */
	builtin?: boolean;

	/**
	 * Rule check type. Determines which analyzer evaluates this rule.
	 *
	 * - 'regex' (default): match `pattern` against each line
	 * - 'file-level': evaluate at file level (e.g. max lines, missing header)
	 * - 'ast': TypeScript AST structural analysis
	 * - 'dataflow': taint tracking (source \u2192 sanitizer \u2192 sink)
	 * - 'import-graph': architecture-level import graph analysis
	 * - 'external': delegate to an external CLI tool
	 */
	type?: GRCRuleType;

	/**
	 * For file-level rules, a threshold value (e.g. max line count).
	 */
	threshold?: number;

	// ─── Framework-specific fields (new) ─────────────────────────────

	/**
	 * Structured check definition from a framework.
	 *
	 * When present, this takes precedence over the `pattern` field.
	 * The `type` field determines how this check is executed.
	 *
	 * For framework-sourced rules, this contains the full check specification
	 * (regex pattern, AST match, taint sources/sinks, etc.).
	 */
	check?: ICheckDefinition;

	/**
	 * ID of the framework this rule came from.
	 * undefined for built-in and user-defined rules.
	 */
	frameworkId?: string;

	/**
	 * External references for traceability.
	 * e.g. ["CWE-94", "OWASP A03:2021", "DO-178C Table A-5"]
	 */
	references?: string[];

	/**
	 * Searchable tags for filtering/grouping.
	 * e.g. ["injection", "xss", "owasp-top-10"]
	 */
	tags?: string[];

	/**
	 * Blocking behavior for this rule's violations.
	 * Defined by the framework's severity levels.
	 */
	blockingBehavior?: {
		/** Whether violations block git commit (via pre-commit hook) */
		blocksCommit: boolean;
		/** Whether violations block deployment (via CI/CD gate) */
		blocksDeploy: boolean;
	};

	/**
	 * Language IDs (or file extensions) where this rule must NOT fire.
	 *
	 * Use this when a regex pattern would produce false positives in certain
	 * languages because a dedicated structural analyzer (c-structural, iot-ot,
	 * etc.) already handles that language with context awareness.
	 *
	 * Example: FS-002 infinite-loop regex fires on `while(1)` in C startup code
	 * (intentional fault-trap), so we skip c / cpp / embedded-c here and let
	 * CStructuralAnalyzer + IndustrialIotAnalyzer handle those files instead.
	 */
	skipLanguages?: string[];
}


// ─── Check Result ────────────────────────────────────────────────────────────

/**
 * Result of evaluating a single rule against code.
 *
 * Produced by the GRC engine when a rule violation is detected.
 * Contains all information needed for:
 * - Editor diagnostics (squiggly underlines)
 * - Checks panel display
 * - Audit trail logging
 * - Compliance reporting
 */
export interface ICheckResult {
	/** The rule that was violated */
	ruleId: string;

	/** Domain/category of the rule */
	domain: GRCDomain;

	/**
	 * Original severity from the rule (may be custom, e.g. "blocker").
	 * Use `toDisplaySeverity()` to get a display severity.
	 */
	severity: string;

	/** Human-readable violation message */
	message: string;

	/** File where the violation was found */
	fileUri: URI;

	/** 1-based line number */
	line: number;

	/** 1-based column (start of match) */
	column: number;

	/** 1-based end line */
	endLine: number;

	/** 1-based end column */
	endColumn: number;

	/** The matched code snippet */
	codeSnippet?: string;

	/** Suggested fix (from rule definition) */
	fix?: string;

	/** Timestamp of when this check was performed */
	timestamp: number;

	// ─── Framework-specific fields (new) ─────────────────────────────

	/**
	 * ID of the framework this violation came from.
	 * undefined for built-in rule violations.
	 */
	frameworkId?: string;

	/**
	 * External references from the rule definition.
	 * Carried through from IGRCRule.references for the UI.
	 */
	references?: string[];

	/**
	 * For data flow violations: trace info showing how tainted data
	 * propagated from source to sink.
	 *
	 * e.g. [{line: 5, label: "tainted: req.body"}, {line: 8, label: "passed to query()"}]
	 */
	traceInfo?: Array<{ line: number; column?: number; label: string }>;

	/**
	 * Blocking behavior inherited from the rule.
	 */
	blockingBehavior?: {
		blocksCommit: boolean;
		blocksDeploy: boolean;
	};

	// ─── Intelligence-enhanced fields ────────────────────────────────

	/**
	 * AI-generated explanation of why this violation matters
	 * in the specific context of this code.
	 *
	 * Unlike the static `fix` text from rule definitions, this is
	 * generated per-violation by the Framework Intelligence Service.
	 * Shows up in hover tooltips and the Checks panel.
	 *
	 * e.g. "This eval() receives data from the `userScript` variable
	 *       which is assigned from an API response on line 12.
	 *       An attacker controlling the API could execute arbitrary code."
	 */
	aiExplanation?: string;

	/**
	 * AI confidence that this is a true positive.
	 * - 'high': Almost certainly a real issue
	 * - 'medium': Likely an issue, review recommended
	 * - 'low': Might be a false positive
	 */
	aiConfidence?: 'high' | 'medium' | 'low';

	/**
	 * Which analysis layer produced this violation.
	 * - 'static'   — deterministic (regex, AST, dataflow, universal pattern)
	 * - 'ai'       — AI semantic reasoning
	 * - 'breaking' — breaking change detection
	 */
	checkSource?: 'static' | 'ai' | 'breaking';

	/**
	 * True when this violation was detected by the Breaking Change Detector.
	 *
	 * Breaking change violations are preserved across re-evaluations just like
	 * AI violations, and are cleared when the breaking change is resolved.
	 */
	isBreakingChange?: boolean;

	// ─── Deep analysis fields (cross-file, logic flow) ───────────────

	/**
	 * Data flow trace showing how tainted data reaches the violation point.
	 * Each step represents a point in the flow from source to sink.
	 */
	dataFlowTrace?: Array<{
		file: string;
		line: number;
		description: string;
	}>;

	/**
	 * Related violations in other files (cross-file chain).
	 * Links violations that are part of the same data flow or logic path.
	 */
	relatedViolations?: Array<{
		fileUri: string;
		line: number;
		ruleId: string;
		relationship: 'upstream' | 'downstream' | 'same-flow';
	}>;

	/**
	 * The logic assumption that is violated, if applicable.
	 * e.g. "Assumes req.body.email is always a string, but no type check exists"
	 */
	brokenAssumption?: string;

	/**
	 * Risk score assigned during AI scan prioritization (0-100+).
	 * Higher scores indicate higher-risk files.
	 */
	riskScore?: number;

	/**
	 * Structured reasoning chain from AI analysis.
	 * Each step explains WHY the AI flagged this as a violation.
	 * Machine-readable — used for deduplication, ranking, and feedback quality.
	 */
	reasoningChain?: Array<{
		/** Step number (1-based) */
		step: number;
		/** What the AI observed in the code at this step */
		observation: string;
		/** What the observation implies for compliance */
		implication: string;
		/** Why this observation maps to the specific rule being violated */
		ruleRelevance: string;
	}>;
}


// ─── Ignore Suggestions ──────────────────────────────────────────────────────

/**
 * AI-generated suggestion for an ignore or context-only pattern.
 * Produced by analyzing the project structure.
 */
export interface IIgnoreSuggestion {
	/** Glob pattern to add */
	pattern: string;
	/** Human-readable reason for the suggestion */
	reason: string;
	/** Whether to fully ignore or keep as context */
	mode: 'ignore' | 'context-only';
	/** AI confidence in this suggestion */
	confidence: 'high' | 'medium' | 'low';
	/** Category of the suggestion */
	category: 'build-output' | 'test-files' | 'config' | 'generated' | 'vendor' | 'other';
}


// ─── Impact Node ─────────────────────────────────────────────────────────────

/**
 * Node in a cross-file impact tree.
 * Shows how violations in one file affect its dependents.
 */
export interface IImpactNode {
	/** URI string of the file */
	fileUri: string;
	/** Basename of the file */
	fileName: string;
	/** Relative path for display */
	filePath: string;
	/** Count of violations in this file */
	violations: number;
	/** Whether this file has breaking change violations */
	hasBreakingChanges: boolean;
	/** Files that import this file */
	dependents: IImpactNode[];
}


// ─── Domain Summary ──────────────────────────────────────────────────────────

/**
 * Summary counts for a single domain.
 *
 * Used by the Checks Manager dashboard to show per-domain statistics.
 */
export interface IDomainSummary {
	domain: GRCDomain;
	errorCount: number;
	warningCount: number;
	infoCount: number;
	totalRules: number;
	enabledRules: number;

	/**
	 * Which frameworks contribute rules to this domain.
	 */
	frameworkIds?: string[];
}


// ─── User Config ─────────────────────────────────────────────────────────────

/**
 * Shape of the user's .inverse/grc-rules.json file.
 *
 * This file contains:
 * 1. User-defined rules (custom rules not from any framework)
 * 2. Overrides for built-in or framework rules (e.g. disable a rule, change severity)
 * 3. Global settings (diagnostics, audit, exclusions)
 */
export interface IGRCConfig {
	version: string;
	rules: IGRCRule[];
	settings: {
		showDiagnostics: boolean;
		auditEnabled: boolean;
		/** File glob patterns to exclude from scanning */
		excludePatterns?: string[];
	};

	/**
	 * Per-framework overrides.
	 *
	 * Keys are framework IDs. Values contain rule-level overrides
	 * (e.g. disable specific rules, change severity).
	 *
	 * Example:
	 * ```json
	 * {
	 *   "frameworkOverrides": {
	 *     "acme-security-v2": {
	 *       "disabledRules": ["ACME-SEC-003"],
	 *       "severityOverrides": { "ACME-SEC-005": "info" }
	 *     }
	 *   }
	 * }
	 * ```
	 */
	frameworkOverrides?: Record<string, {
		disabledRules?: string[];
		severityOverrides?: Record<string, string>;
	}>;
}

/**
 * Default GRC config created for new workspaces.
 */
export const DEFAULT_GRC_CONFIG: IGRCConfig = {
	version: '1.0',
	rules: [],
	settings: {
		showDiagnostics: true,
		auditEnabled: true,
		excludePatterns: ['**/node_modules/**', '**/dist/**', '**/.inverse/**']
	}
};
