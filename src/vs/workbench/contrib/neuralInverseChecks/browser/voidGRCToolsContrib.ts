/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VoidGRCToolsContrib
 *
 * Registers GRC/compliance tools with VoidInternalToolService so the Void agent
 * (and Power Mode) can call them directly instead of guessing at rules.
 *
 * Tools registered:
 *   - search_compliance_rules  : keyword search across all active framework rules
 *   - get_rule_detail          : get full detail for a specific rule by ID
 *   - list_frameworks          : list all active frameworks with rule counts
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVoidInternalToolService, IVoidInternalTool } from '../../void/browser/voidInternalToolService.js';
import { IFrameworkRuleIndexService } from './engine/framework/frameworkRuleIndexService.js';
import { IFrameworkRegistry } from './engine/framework/frameworkRegistry.js';

// ─── Tool implementations ────────────────────────────────────────────────────

function buildGRCTools(
	ruleIndex: IFrameworkRuleIndexService,
	registry: IFrameworkRegistry,
): IVoidInternalTool[] {

	const searchRulesTool: IVoidInternalTool = {
		name: 'search_compliance_rules',
		description: 'Search across all active compliance framework rules by keyword. Returns matching rules with severity, description, and fix guidance. Use this when you need to know what compliance rules apply to a specific coding pattern, function, or concept.',
		params: {
			query: { description: 'Keywords to search for, e.g. "interrupt volatile", "memcpy type pun", "hardcoded password", "watchdog timeout"' },
			max_results: { description: 'Maximum number of rules to return (default: 10, max: 30)' },
		},
		async execute(args: Record<string, unknown>) {
			const query = String(args['query'] ?? '').trim();
			if (!query) return 'Error: query is required.';

			const maxResults = Math.min(parseInt(String(args['max_results'] ?? '10'), 10) || 10, 30);
			const results = ruleIndex.searchRules(query, maxResults);

			if (results.length === 0) {
				return `No compliance rules found matching "${query}". Try broader keywords or use list_frameworks to see what frameworks are active.`;
			}

			const lines: string[] = [`Found ${results.length} rule(s) matching "${query}":\n`];
			for (const r of results) {
				lines.push(`[${r.id}] ${r.message}`);
				lines.push(`  Framework: ${r.frameworkName}`);
				lines.push(`  Severity:  ${r.severity}`);
				if (r.description) lines.push(`  Detail:    ${r.description}`);
				if (r.fix) lines.push(`  Fix:       ${r.fix}`);
				lines.push('');
			}
			return lines.join('\n');
		},
	};

	const getRuleDetailTool: IVoidInternalTool = {
		name: 'get_rule_detail',
		description: 'Get the full detail for a specific compliance rule by its ID (e.g. "MISRA-C-001", "SEC-042"). Returns severity, description, fix guidance, and which framework it belongs to.',
		params: {
			rule_id: { description: 'The rule ID to look up, e.g. "MISRA-C-001" or "ICS-SEC-003"' },
		},
		async execute(args: Record<string, unknown>) {
			const ruleId = String(args['rule_id'] ?? '').trim().toUpperCase();
			if (!ruleId) return 'Error: rule_id is required.';

			const frameworks = registry.getActiveFrameworks()
				.filter(fw => fw.validation.valid);

			for (const fw of frameworks) {
				const rule = fw.rules.find(r => r.id.toUpperCase() === ruleId);
				if (rule) {
					const lines: string[] = [
						`Rule: ${rule.id}`,
						`Framework: ${fw.definition.framework.name} v${fw.definition.framework.version}`,
						`Severity: ${rule.severity}`,
						`Domain: ${rule.domain}`,
						`Message: ${rule.message}`,
					];
					if (rule.description) lines.push(`Description: ${rule.description}`);
					if (rule.fix) lines.push(`Fix: ${rule.fix}`);
					lines.push(`Enabled: ${rule.enabled}`);
					return lines.join('\n');
				}
			}

			return `Rule "${ruleId}" not found in any active framework. Use search_compliance_rules to find rules by keyword, or list_frameworks to see what is loaded.`;
		},
	};

	const listFrameworksTool: IVoidInternalTool = {
		name: 'list_frameworks',
		description: 'List all active compliance frameworks with their rule counts, version, and description. Use this to understand what compliance standards are being enforced in this project.',
		params: {},
		async execute(_args: Record<string, unknown>) {
			const frameworks = registry.getActiveFrameworks()
				.filter(fw => fw.validation.valid && fw.definition.framework.id !== 'neural-inverse-builtin');

			if (frameworks.length === 0) {
				return 'No compliance frameworks are currently active. Import a framework via the Checks panel.';
			}

			const lines: string[] = [`Active compliance frameworks (${frameworks.length}):\n`];
			for (const fw of frameworks) {
				const meta = fw.definition.framework;
				const enabledRules = fw.rules.filter(r => r.enabled !== false).length;
				const totalRules = fw.rules.length;
				lines.push(`${meta.name} v${meta.version}`);
				lines.push(`  ID:    ${meta.id}`);
				if (meta.description) lines.push(`  About: ${meta.description}`);
				lines.push(`  Rules: ${enabledRules} enabled / ${totalRules} total`);
				const domains = [...new Set(fw.rules.map(r => r.domain))].filter(Boolean);
				if (domains.length > 0) lines.push(`  Domains: ${domains.join(', ')}`);
				lines.push('');
			}
			return lines.join('\n');
		},
	};

	return [searchRulesTool, getRuleDetailTool, listFrameworksTool];
}

// ─── Workbench contribution ───────────────────────────────────────────────────

export class VoidGRCToolsContrib extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voidGRCTools';

	constructor(
		@IVoidInternalToolService private readonly _internalTools: IVoidInternalToolService,
		@IFrameworkRuleIndexService private readonly _ruleIndex: IFrameworkRuleIndexService,
		@IFrameworkRegistry private readonly _registry: IFrameworkRegistry,
	) {
		super();
		this._internalTools.registerMany(buildGRCTools(this._ruleIndex, this._registry));
		console.log('[VoidGRCTools] Registered search_compliance_rules, get_rule_detail, list_frameworks');
	}
}

registerWorkbenchContribution2(VoidGRCToolsContrib.ID, VoidGRCToolsContrib, WorkbenchPhase.AfterRestored);
