/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * GRC tools for Power Mode agents.
 *
 * Provides 5 direct data tools (no LLM round-trip) and one ask_checksagent
 * tool that delegates natural-language compliance questions to the Checks Agent.
 */

import { URI } from '../../../../../base/common/uri.js';
import { IPowerTool, IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import { IGRCEngineService } from '../../../neuralInverseChecks/browser/engine/services/grcEngineService.js';
import { IFrameworkRuleIndexService } from '../../../neuralInverseChecks/browser/engine/framework/frameworkRuleIndexService.js';
import { IFrameworkRegistry } from '../../../neuralInverseChecks/browser/engine/framework/frameworkRegistry.js';
import { definePowerTool } from './powerToolRegistry.js';

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build all GRC tools for Power Mode.
 *
 * @param grcEngine  Live GRC engine for direct data access.
 * @param queryChecksAgent  Callback that sends a natural-language question to the
 *   Checks Agent via the PowerBus and returns the answer. Provided by
 *   PowerModeService so grcTools.ts stays free of PowerBus imports.
 * @param ruleIndex  Rule index service for keyword-based rule search.
 * @param registry   Framework registry for full rule detail lookup.
 */
export function buildGRCTools(
	grcEngine: IGRCEngineService,
	queryChecksAgent: (question: string) => Promise<string>,
	ruleIndex?: IFrameworkRuleIndexService,
	registry?: IFrameworkRegistry,
): IPowerTool[] {
	return [
		_buildViolationsTool(grcEngine),
		_buildDomainSummaryTool(grcEngine),
		_buildBlockingViolationsTool(grcEngine),
		_buildFrameworkRulesTool(grcEngine),
		_buildImpactChainTool(grcEngine),
		_buildAskChecksAgentTool(queryChecksAgent),
		...(ruleIndex ? [_buildSearchRulesTool(ruleIndex)] : []),
		...(registry ? [_buildGetRuleDetailTool(registry), _buildListFrameworksTool(registry)] : []),
	];
}

// ─── grc_violations ──────────────────────────────────────────────────────────

function _buildViolationsTool(grcEngine: IGRCEngineService): IPowerTool {
	return definePowerTool(
		'grc_violations',
		`Returns current GRC violations from the live compliance engine.
Use this to inspect what rules are being violated before making changes.
Filter by domain (e.g. 'security', 'privacy', 'data-integrity') or severity ('error', 'warning').`,
		[
			{ name: 'domain', type: 'string', description: 'Optional. Filter by compliance domain (e.g. security, privacy, data-integrity).', required: false },
			{ name: 'severity', type: 'string', description: 'Optional. Filter by severity: error or warning.', required: false },
			{ name: 'file', type: 'string', description: 'Optional. Filter by file path substring.', required: false },
			{ name: 'limit', type: 'number', description: 'Optional. Maximum violations to return (default 30).', required: false },
		],
		async (args: Record<string, any>, _ctx: IToolContext): Promise<IToolResult> => {
			const domain = args.domain as string | undefined;
			const severity = args.severity as string | undefined;
			const file = args.file as string | undefined;
			const limit = typeof args.limit === 'number' ? args.limit : 30;

			let results = grcEngine.getAllResults();
			if (domain) { results = results.filter(r => r.domain === domain); }
			if (severity) { results = results.filter(r => (r.severity ?? '').toLowerCase() === severity.toLowerCase()); }
			if (file) { results = results.filter(r => r.fileUri.path.includes(file)); }
			results = results.slice(0, limit);

			if (results.length === 0) {
				return { title: 'GRC Violations', output: 'No violations found matching the specified filters.', metadata: {} };
			}

			const lines = results.map(r => {
				const loc = `${r.fileUri.path.split('/').slice(-2).join('/')}:${r.line ?? '?'}`;
				return `[${(r.severity ?? 'info').toUpperCase()}] ${r.ruleId} — ${r.message}\n  File: ${loc}\n  Domain: ${r.domain ?? 'general'}`;
			});

			return { title: 'GRC Violations', output: `${results.length} violation(s):\n\n${lines.join('\n\n')}`, metadata: { count: results.length } };
		},
	);
}

// ─── grc_domain_summary ───────────────────────────────────────────────────────

function _buildDomainSummaryTool(grcEngine: IGRCEngineService): IPowerTool {
	return definePowerTool(
		'grc_domain_summary',
		`Returns a per-domain breakdown of violation counts.
Use this for a high-level compliance health overview before starting work.`,
		[],
		async (_args: Record<string, any>, _ctx: IToolContext): Promise<IToolResult> => {
			const summary = grcEngine.getDomainSummary();

			if (summary.length === 0) {
				return { title: 'Domain Summary', output: 'No domains with violations. Compliance posture is clean.', metadata: {} };
			}

			const total = summary.reduce((acc, d) => acc + d.errorCount + d.warningCount, 0);
			const lines = summary.map(d =>
				`  ${d.domain.padEnd(20)} errors: ${d.errorCount}, warnings: ${d.warningCount}`
			);

			return { title: 'Domain Summary', output: `Domain summary (${total} total violations):\n\n${lines.join('\n')}`, metadata: { total } };
		},
	);
}

// ─── grc_blocking_violations ─────────────────────────────────────────────────

function _buildBlockingViolationsTool(grcEngine: IGRCEngineService): IPowerTool {
	return definePowerTool(
		'grc_blocking_violations',
		`Returns violations that block commits.
Always check this before preparing a commit or merge request.
If any blocking violations exist, they must be resolved before code can be committed.`,
		[],
		async (_args: Record<string, any>, _ctx: IToolContext): Promise<IToolResult> => {
			const blocking = grcEngine.getBlockingViolations();

			if (blocking.length === 0) {
				return { title: 'Blocking Violations', output: 'No blocking violations. Commits are not gated.', metadata: {} };
			}

			const lines = blocking.map(r => {
				const loc = `${r.fileUri.path.split('/').slice(-2).join('/')}:${r.line ?? '?'}`;
				return `[BLOCKING] ${r.ruleId} — ${r.message}\n  File: ${loc}\n  Domain: ${r.domain ?? 'general'}`;
			});

			return { title: 'Blocking Violations', output: `COMMIT IS GATED — ${blocking.length} blocking violation(s):\n\n${lines.join('\n\n')}`, metadata: { count: blocking.length } };
		},
	);
}

// ─── grc_framework_rules ─────────────────────────────────────────────────────

function _buildFrameworkRulesTool(grcEngine: IGRCEngineService): IPowerTool {
	return definePowerTool(
		'grc_framework_rules',
		`Returns the compliance rules loaded from active frameworks (SOC2, HIPAA, custom, etc.).
Use this to understand what the compliance requirements are before writing code.
Optionally filter by framework ID to see rules from a specific framework.`,
		[
			{ name: 'framework_id', type: 'string', description: 'Optional. Filter rules by framework ID.', required: false },
			{ name: 'domain', type: 'string', description: 'Optional. Filter rules by domain.', required: false },
		],
		async (args: Record<string, any>, _ctx: IToolContext): Promise<IToolResult> => {
			const frameworkId = args.framework_id as string | undefined;
			const domain = args.domain as string | undefined;

			const frameworks = grcEngine.getActiveFrameworks();
			let rules = grcEngine.getRules();

			if (frameworkId) { rules = rules.filter(r => r.frameworkId === frameworkId); }
			if (domain) { rules = rules.filter(r => r.domain === domain); }

			const frameworkList = frameworks.map(f => `  ${f.id}: ${f.name} (v${f.version})`).join('\n');

			if (rules.length === 0) {
				return { title: 'Framework Rules', output: `Active frameworks:\n${frameworkList}\n\nNo rules found for the specified filters.`, metadata: {} };
			}

			const ruleLines = rules.slice(0, 50).map(r =>
				`  [${r.domain ?? 'general'}] ${r.id}: ${r.message}${r.blockingBehavior?.blocksCommit ? ' (BLOCKING)' : ''}`
			);

			const header = frameworks.length > 0 ? `Active frameworks:\n${frameworkList}\n\n` : '';
			return { title: 'Framework Rules', output: `${header}Rules (${rules.length} total, showing up to 50):\n\n${ruleLines.join('\n')}`, metadata: { total: rules.length } };
		},
	);
}

// ─── grc_impact_chain ────────────────────────────────────────────────────────

function _buildImpactChainTool(grcEngine: IGRCEngineService): IPowerTool {
	return definePowerTool(
		'grc_impact_chain',
		`Returns the cross-file impact tree for a given file.
Shows which files import (depend on) this file, and their importers, recursively.
Use before refactoring shared modules to understand the blast radius of your change.`,
		[
			{ name: 'file', type: 'string', description: 'Full path to the file to analyze.', required: true },
			{ name: 'max_depth', type: 'number', description: 'Optional. Maximum depth of the impact tree (default 3).', required: false },
		],
		async (args: Record<string, any>, _ctx: IToolContext): Promise<IToolResult> => {
			const filePath = args.file as string;
			const maxDepth = typeof args.max_depth === 'number' ? args.max_depth : 3;

			const fileUri = filePath.includes('://') ? URI.parse(filePath) : URI.file(filePath);
			const impact = grcEngine.getImpactChain(fileUri, maxDepth);

			if (!impact) {
				return { title: 'Impact Chain', output: `No impact chain found for: ${filePath}\nThis file may not be tracked in the import graph yet. Try saving it or running a workspace scan.`, metadata: {} };
			}

			const renderTree = (node: typeof impact, indent = 0): string => {
				const prefix = '  '.repeat(indent);
				const label = node.fileUri.split('/').slice(-2).join('/');
				let out = `${prefix}${label}`;
				if (node.dependents.length > 0) {
					out += ` (imported by ${node.dependents.length} file${node.dependents.length !== 1 ? 's' : ''})`;
					for (const dep of node.dependents) {
						out += '\n' + renderTree(dep, indent + 1);
					}
				}
				return out;
			};

			const tree = renderTree(impact);
			const totalDeps = _countDescendants(impact);

			return { title: 'Impact Chain', output: `Impact chain for ${filePath.split('/').slice(-2).join('/')} (${totalDeps} dependent file(s) affected):\n\n${tree}`, metadata: { totalDeps } };
		},
	);
}

function _countDescendants(node: { dependents: typeof node[] }): number {
	let count = node.dependents.length;
	for (const dep of node.dependents) { count += _countDescendants(dep); }
	return count;
}

// ─── ask_checksagent ─────────────────────────────────────────────────────────

function _buildAskChecksAgentTool(
	queryChecksAgent: (question: string) => Promise<string>,
): IPowerTool {
	return definePowerTool(
		'ask_checksagent',
		`Ask the Checks Agent a natural-language compliance question.
The Checks Agent is a dedicated GRC specialist with full access to all compliance tools.

Use this when you need:
- Interpretation of a violation ("what does this rule mean for my code?")
- Cross-domain compliance feedback ("does this change affect SOC2 and HIPAA?")
- Remediation guidance ("how should I fix this blocking violation?")
- Confirmation that a planned change is compliant before making it
- Any reasoning about GRC frameworks, risk, or policy

Use the direct grc_* tools instead when you just need raw data (violations list, domain counts, etc.).`,
		[
			{ name: 'question', type: 'string', description: 'The compliance question to ask the Checks Agent.', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const question = args.question as string;
			ctx.metadata({ title: `Asking Checks Agent: ${question.substring(0, 60)}` });
			const answer = await queryChecksAgent(question);
			return { title: 'Checks Agent', output: answer, metadata: {} };
		},
	);
}

// ─── search_compliance_rules ─────────────────────────────────────────────────

function _buildSearchRulesTool(ruleIndex: IFrameworkRuleIndexService): IPowerTool {
	return definePowerTool(
		'search_compliance_rules',
		`Search across all active compliance framework rules by keyword.
Returns matching rules with severity, description, and fix guidance.
Use this when you need to know what compliance rules apply to a specific coding
pattern, function, or concept before writing or reviewing code.
Examples: "interrupt volatile", "memcpy type pun", "hardcoded password", "watchdog".`,
		[
			{ name: 'query', type: 'string', description: 'Keywords to search for, e.g. "interrupt volatile" or "hardcoded credential"', required: true },
			{ name: 'max_results', type: 'number', description: 'Maximum rules to return (default 10, max 30)', required: false },
		],
		async (args: Record<string, any>, _ctx: IToolContext): Promise<IToolResult> => {
			const query = String(args.query ?? '').trim();
			if (!query) return { title: 'Rule Search', output: 'Error: query is required.', metadata: {} };

			const maxResults = Math.min(typeof args.max_results === 'number' ? args.max_results : 10, 30);
			const results = ruleIndex.searchRules(query, maxResults);

			if (results.length === 0) {
				return { title: 'Rule Search', output: `No rules found matching "${query}". Try broader keywords or use list_frameworks to see what is active.`, metadata: {} };
			}

			const lines: string[] = [`Found ${results.length} rule(s) matching "${query}":\n`];
			for (const r of results) {
				lines.push(`[${r.id}] ${r.message}`);
				lines.push(`  Framework: ${r.frameworkName} | Severity: ${r.severity}`);
				if (r.description) lines.push(`  Detail: ${r.description}`);
				if (r.fix) lines.push(`  Fix:    ${r.fix}`);
				lines.push('');
			}
			return { title: 'Rule Search', output: lines.join('\n'), metadata: { count: results.length } };
		},
	);
}

// ─── get_rule_detail ─────────────────────────────────────────────────────────

function _buildGetRuleDetailTool(registry: IFrameworkRegistry): IPowerTool {
	return definePowerTool(
		'get_rule_detail',
		`Get full detail for a specific compliance rule by its ID.
Returns severity, description, fix guidance, and which framework it belongs to.
Use this after seeing a violation or rule ID to understand exactly what is required.`,
		[
			{ name: 'rule_id', type: 'string', description: 'The rule ID to look up, e.g. "MISRA-C-001" or "ICS-SEC-003"', required: true },
		],
		async (args: Record<string, any>, _ctx: IToolContext): Promise<IToolResult> => {
			const ruleId = String(args.rule_id ?? '').trim().toUpperCase();
			if (!ruleId) return { title: 'Rule Detail', output: 'Error: rule_id is required.', metadata: {} };

			for (const fw of registry.getActiveFrameworks().filter(f => f.validation.valid)) {
				const rule = fw.rules.find(r => r.id.toUpperCase() === ruleId);
				if (rule) {
					const lines = [
						`Rule:        ${rule.id}`,
						`Framework:   ${fw.definition.framework.name} v${fw.definition.framework.version}`,
						`Severity:    ${rule.severity}`,
						`Domain:      ${rule.domain}`,
						`Message:     ${rule.message}`,
					];
					if (rule.description) lines.push(`Description: ${rule.description}`);
					if (rule.fix) lines.push(`Fix:         ${rule.fix}`);
					lines.push(`Enabled:     ${rule.enabled}`);
					return { title: `Rule ${rule.id}`, output: lines.join('\n'), metadata: {} };
				}
			}
			return { title: 'Rule Detail', output: `Rule "${ruleId}" not found. Use search_compliance_rules to find rules by keyword.`, metadata: {} };
		},
	);
}

// ─── list_frameworks ─────────────────────────────────────────────────────────

function _buildListFrameworksTool(registry: IFrameworkRegistry): IPowerTool {
	return definePowerTool(
		'list_frameworks',
		`List all active compliance frameworks with rule counts, version, and description.
Use this to understand what compliance standards are being enforced in this project
before writing code or when planning a compliance review.`,
		[],
		async (_args: Record<string, any>, _ctx: IToolContext): Promise<IToolResult> => {
			const frameworks = registry.getActiveFrameworks()
				.filter(fw => fw.validation.valid && fw.definition.framework.id !== 'neural-inverse-builtin');

			if (frameworks.length === 0) {
				return { title: 'Frameworks', output: 'No compliance frameworks active. Import one via the Checks panel.', metadata: {} };
			}

			const lines: string[] = [`Active compliance frameworks (${frameworks.length}):\n`];
			for (const fw of frameworks) {
				const meta = fw.definition.framework;
				const enabled = fw.rules.filter(r => r.enabled !== false).length;
				lines.push(`${meta.name} v${meta.version}  [${meta.id}]`);
				if (meta.description) lines.push(`  ${meta.description}`);
				lines.push(`  Rules: ${enabled} enabled / ${fw.rules.length} total`);
				const domains = [...new Set(fw.rules.map(r => r.domain))].filter(Boolean);
				if (domains.length) lines.push(`  Domains: ${domains.join(', ')}`);
				lines.push('');
			}
			return { title: 'Frameworks', output: lines.join('\n'), metadata: { count: frameworks.length } };
		},
	);
}
