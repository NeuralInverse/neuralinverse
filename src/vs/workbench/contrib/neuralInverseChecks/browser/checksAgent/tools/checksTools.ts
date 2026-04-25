/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * GRC Tools for the Checks Agent.
 *
 * All 10 built-in tools that give the Checks Agent real-time access to the
 * GRC engine, frameworks, external tools, and AI rule drafting.
 *
 * All tools are READ-ONLY except `run_workspace_scan` which triggers evaluation.
 */

import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ISearchService, ITextQuery, QueryType, IFileQuery } from '../../../../../services/search/common/search.js';
import { IGRCEngineService } from '../../engine/services/grcEngineService.js';
import { IExternalToolService } from '../../engine/services/externalToolService.js';
import { IContractReasonService } from '../../engine/services/contractReasonService.js';
import { IChecksAgentService } from '../checksAgentService.js';
import { IInvariantDefinition } from '../../engine/types/invariantTypes.js';
import { defineChecksTool } from '../checksToolRegistry.js';
import { IChecksTool } from '../checksAgentTypes.js';
import {
	createWebFetchTool,
	createMemoryWriteTool,
	createMemoryReadTool,
	createTaskCreateTool,
	createTaskListTool,
	createTaskUpdateTool,
	createTaskGetTool,
} from '../../../../powerMode/browser/tools/advancedTools.js';

/**
 * Build and return all GRC + file access tools, each bound to the live engine instances.
 */
export function buildChecksTools(
	grcEngine: IGRCEngineService,
	externalToolService: IExternalToolService,
	contractReasonService: IContractReasonService,
	checksAgentService: IChecksAgentService,
	fileService: IFileService,
	searchService: ISearchService,
	workingDirectory: string,
): IChecksTool[] {
	return [

		// \u2500\u2500 1. get_violations \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		defineChecksTool(
			'get_violations',
			'Get current GRC violations from the engine. Filter by domain and/or severity. Returns up to `limit` violations (default 30).',
			[
				{ name: 'domain', type: 'string', description: 'Domain to filter by (e.g. "security", "compliance", "architecture"). Omit for all domains.', required: false },
				{ name: 'severity', type: 'string', description: 'Severity filter: "error", "warning", or "info". Omit for all severities.', required: false },
				{ name: 'limit', type: 'number', description: 'Maximum number of violations to return (default 30, max 100).', required: false },
			],
			async (args) => {
				const { domain, severity, limit = 30 } = args as { domain?: string; severity?: string; limit?: number };
				let results = grcEngine.getAllResults();

				if (domain) {
					results = results.filter(r => r.domain === domain);
				}
				if (severity) {
					results = results.filter(r => {
						const s = r.severity?.toLowerCase() ?? '';
						return s === severity.toLowerCase() || s.startsWith(severity.toLowerCase());
					});
				}

				const capped = results.slice(0, Math.min(limit, 100));
				if (capped.length === 0) {
					return `No violations found${domain ? ` in domain "${domain}"` : ''}${severity ? ` with severity "${severity}"` : ''}.`;
				}

				const rows = capped.map(r => ({
					ruleId: r.ruleId,
					domain: r.domain ?? 'unknown',
					severity: r.severity ?? 'info',
					file: r.fileUri?.path.split('/').pop() ?? 'unknown',
					line: r.line ?? 0,
					message: r.message,
					blocking: r.isBreakingChange ? true : undefined,
				}));

				return JSON.stringify(rows, null, 2);
			}
		),

		// \u2500\u2500 2. get_domain_summary \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		defineChecksTool(
			'get_domain_summary',
			'Get a summary of violations grouped by domain. Shows error, warning, and info counts per domain.',
			[],
			async (_args) => {
				const summary = grcEngine.getDomainSummary();
				if (summary.length === 0) {
					return 'No violations found in any domain.';
				}
				const rows = summary.map(d => ({
					domain: d.domain,
					errors: d.errorCount,
					warnings: d.warningCount,
					info: d.infoCount,
					total: d.errorCount + d.warningCount + d.infoCount,
				}));
				return JSON.stringify(rows, null, 2);
			}
		),

		// \u2500\u2500 3. get_rule_details \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		defineChecksTool(
			'get_rule_details',
			'Get the full definition of a GRC rule by its ID. Returns name, description, type, severity, domain, tags, and check pattern.',
			[
				{ name: 'ruleId', type: 'string', description: 'The rule ID to look up (e.g. "SEC-001", "ARCH-003").', required: true },
			],
			async (args) => {
				const { ruleId } = args as { ruleId: string };
				const rules = grcEngine.getRules();
				const rule = rules.find(r => r.id === ruleId);
				if (!rule) {
					return `Rule "${ruleId}" not found. Use get_framework_rules to list all available rules.`;
				}
				const details = {
					id: rule.id,
					message: rule.message,
					type: rule.type ?? 'regex',
					severity: rule.severity,
					domain: rule.domain,
					tags: rule.tags ?? [],
					enabled: rule.enabled !== false,
					blockingBehavior: rule.blockingBehavior,
				check: rule.check ? '[structured check]' : (rule.pattern || 'none'),
				};
				return JSON.stringify(details, null, 2);
			}
		),

		// \u2500\u2500 4. get_blocking_violations \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		defineChecksTool(
			'get_blocking_violations',
			'Get all violations that block commits or saves. These are critical violations that must be resolved before code can be committed.',
			[],
			async (_args) => {
				const violations = grcEngine.getBlockingViolations();
				if (violations.length === 0) {
					return 'No blocking violations found. All commits are currently permitted.';
				}
				const rows = violations.map(r => ({
					ruleId: r.ruleId,
					domain: r.domain ?? 'unknown',
					severity: r.severity ?? 'error',
					file: r.fileUri?.path.split('/').pop() ?? 'unknown',
					filePath: r.fileUri?.path ?? 'unknown',
					line: r.line ?? 0,
					message: r.message,
				}));
				return JSON.stringify({ count: rows.length, violations: rows }, null, 2);
			}
		),

		// \u2500\u2500 5. get_impact_chain \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		defineChecksTool(
			'get_impact_chain',
			'Get the cross-file impact tree for a file. Shows which other files depend on (import) this file, recursively. Useful for understanding blast radius of a change.',
			[
				{ name: 'file', type: 'string', description: 'File path or basename to analyze (e.g. "authService.ts", "auth-token-validator.js", or a full path).', required: true },
			],
			async (args) => {
				const { file } = args as { file: string };

				// The import map stores keys WITHOUT extensions (e.g. "/path/auth-token-validator").
				// Normalize the input the same way so lookups work regardless of whether the
				// caller passes "auth-token-validator.js", "auth-token-validator", or a full path.
				const fileNoExt = file.replace(/\.[^/.]+$/, '');
				const fileBasename = fileNoExt.split('/').pop() ?? '';
				const fileBasenameWithExt = file.split('/').pop() ?? '';

				const importedByMap = grcEngine.getImportedByMap();
				let matchedKey: string | undefined;

				for (const key of importedByMap.keys()) {
					const keyBasename = key.split('/').pop() ?? '';
					if (
						key === file ||
						key === fileNoExt ||
						keyBasename === fileBasename ||
						keyBasename === fileBasenameWithExt.replace(/\.[^/.]+$/, '') ||
						key.endsWith('/' + fileNoExt) ||
						key.endsWith('/' + file)
					) {
						matchedKey = key;
						break;
					}
				}

				if (!matchedKey) {
					const mapSize = importedByMap.size;
					if (mapSize === 0) {
						return `Import graph is empty \u2014 workspace has not been scanned yet. Run /scan first, then retry.`;
					}
					return `"${file}" is not imported by any other file in the workspace (checked ${mapSize} tracked dependencies). It may be a top-level entry point, or the workspace scan hasn't run yet.`;
				}

				// Reconstruct a URI for getImpactChain \u2014 use the importedBy importer paths
				// to find a concrete file URI we can pass to the engine.
				const importers = importedByMap.get(matchedKey) ?? [];
				let targetUri: URI | undefined;

				// Try to get a URI from results cache (most reliable)
				const allResults = grcEngine.getAllResults();
				const fromResults = allResults.find(r => {
					const p = r.fileUri?.path ?? '';
					return p.replace(/\.[^/.]+$/, '').endsWith(matchedKey!.split('/').slice(-2).join('/'));
				});
				if (fromResults?.fileUri) {
					targetUri = fromResults.fileUri;
				}

				// Fallback: build URI directly from the matched key (may not have extension)
				if (!targetUri) {
					targetUri = URI.file(matchedKey);
				}

				const chain = grcEngine.getImpactChain(targetUri);
				if (chain && (chain.dependents.length > 0 || importers.length > 0)) {
					// Enrich with raw importer count in case chain is shallower than reality
					return JSON.stringify({
						...chain,
						totalImporters: importers.length,
						note: importers.length > (chain.dependents?.length ?? 0)
							? `${importers.length} files import this module (showing top ${chain.dependents?.length ?? 0} in tree)`
							: undefined,
					}, null, 2);
				}

				// Fallback: return raw importedBy data when getImpactChain returns nothing
				return JSON.stringify({
					file: matchedKey,
					importedByCount: importers.length,
					importedBy: importers.slice(0, 30).map(u => {
						try { return URI.parse(u).path; } catch { return u; }
					}),
				}, null, 2);
			}
		),

		// \u2500\u2500 6. explain_violation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		defineChecksTool(
			'explain_violation',
			'Explain a specific violation in context. Retrieves the violation details and surrounding code context to help understand why it was flagged.',
			[
				{ name: 'ruleId', type: 'string', description: 'The rule ID of the violation (e.g. "SEC-001").', required: true },
				{ name: 'file', type: 'string', description: 'File path or basename where the violation occurs.', required: true },
				{ name: 'line', type: 'number', description: 'Line number of the violation (optional, uses first match if omitted).', required: false },
			],
			async (args) => {
				const { ruleId, file, line } = args as { ruleId: string; file: string; line?: number };
				const allResults = grcEngine.getAllResults();

				const matches = allResults.filter(r =>
					r.ruleId === ruleId &&
					(r.fileUri?.path === file || r.fileUri?.path.split('/').pop() === file || r.fileUri?.path.endsWith('/' + file))
				);

				if (matches.length === 0) {
					return `No violation found for rule "${ruleId}" in file "${file}". Check that the file has been scanned recently.`;
				}

				const violation = line !== undefined
					? (matches.find(r => r.line === line) ?? matches[0])
					: matches[0];

				const rules = grcEngine.getRules();
				const rule = rules.find(r => r.id === ruleId);

				const explanation = {
					violation: {
						ruleId: violation.ruleId,
						domain: violation.domain,
						severity: violation.severity,
						file: violation.fileUri?.path ?? file,
						line: violation.line,
						column: violation.column,
						message: violation.message,
						isBreakingChange: violation.isBreakingChange ?? false,
					},
					rule: rule ? {
						message: rule.message,
						type: rule.type ?? 'regex',
						tags: rule.tags ?? [],
						blocksCommit: rule.blockingBehavior?.blocksCommit ?? false,
					} : { message: 'Rule definition not found.' },
					context: violation.traceInfo ?? 'No trace information available.',
					otherMatchesInFile: matches.length - 1,
				};

				return JSON.stringify(explanation, null, 2);
			}
		),

		// \u2500\u2500 7. get_framework_rules \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		defineChecksTool(
			'get_framework_rules',
			'List GRC rules, optionally filtered to a specific framework. Returns rules grouped by domain with enabled/disabled status.',
			[
				{ name: 'frameworkId', type: 'string', description: 'Framework ID to filter by (e.g. "iso26262", "soc2"). Omit to list all rules.', required: false },
			],
			async (args) => {
				const { frameworkId } = args as { frameworkId?: string };
				let rules = grcEngine.getRules();

				if (frameworkId) {
					rules = rules.filter(r => r.frameworkId === frameworkId || r.tags?.includes(frameworkId));
				}

				if (rules.length === 0) {
					const frameworks = grcEngine.getActiveFrameworks();
					return `No rules found${frameworkId ? ` for framework "${frameworkId}"` : ''}.\nActive frameworks: ${frameworks.map(f => f.id).join(', ') || 'none'}.`;
				}

				// Group by domain
				const byDomain = new Map<string, typeof rules>();
				for (const rule of rules) {
					const d = rule.domain ?? 'unknown';
					if (!byDomain.has(d)) { byDomain.set(d, []); }
					byDomain.get(d)!.push(rule);
				}

				const grouped: Record<string, any[]> = {};
				for (const [domain, domainRules] of byDomain) {
					grouped[domain] = domainRules.map(r => ({
						id: r.id,
						type: r.type ?? 'regex',
						severity: r.severity,
						enabled: r.enabled !== false,
						blocksCommit: r.blockingBehavior?.blocksCommit ?? false,
					}));
				}

				return JSON.stringify({
					totalRules: rules.length,
					enabledCount: rules.filter(r => r.enabled !== false).length,
					byDomain: grouped,
				}, null, 2);
			}
		),

		// \u2500\u2500 8. get_external_tool_status \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		defineChecksTool(
			'get_external_tool_status',
			'Get the current status of external analysis tools (CodeQL, Semgrep, Polyspace, etc.). Shows last run time, hit count, and any errors.',
			[],
			async (_args) => {
				const jobs = externalToolService.getJobs();
				if (jobs.length === 0) {
					return 'No external tool jobs found. External tools may not be configured or have not been run yet.';
				}

				const rows = jobs.map(j => ({
					ruleId: j.ruleId,
					scope: j.scope,
					status: j.status,
					startedAt: j.startedAt ? new Date(j.startedAt).toISOString() : null,
					durationMs: j.durationMs ?? null,
					resultCount: j.resultCount ?? 0,
					error: j.error ?? null,
				}));

				return JSON.stringify(rows, null, 2);
			}
		),

		// \u2500\u2500 9. run_workspace_scan \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		defineChecksTool(
			'run_workspace_scan',
			'Trigger a full workspace scan. This re-evaluates all files against all enabled rules and updates the violation list. May take a few moments for large workspaces.',
			[],
			async (_args) => {
				try {
					// Fire and don't await \u2014 scan runs in background
					grcEngine.scanWorkspace().catch(e => {
						console.error('[ChecksAgent] Workspace scan error:', e);
					});
					return 'Workspace scan started. Results will update in the Checks Manager dashboard. Use get_violations to query results after a moment.';
				} catch (e: any) {
					return `Failed to start workspace scan: ${e.message}`;
				}
			}
		),

		// \u2500\u2500 10. draft_rule \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		defineChecksTool(
			'draft_rule',
			'Draft a new GRC rule from a natural language description using AI. Returns a JSON rule definition ready to add to .inverse/rules.json.',
			[
				{ name: 'description', type: 'string', description: 'Natural language description of what the rule should enforce (e.g. "no use of eval() in auth modules").', required: true },
				{ name: 'type', type: 'string', description: 'Rule type hint: "regex", "ast", "file-level", or "universal". Defaults to "regex".', required: false },
				{ name: 'domain', type: 'string', description: 'Domain hint for the rule (e.g. "security", "compliance"). Defaults to best guess.', required: false },
			],
			async (args) => {
				const { description, type = 'regex', domain } = args as { description: string; type?: string; domain?: string };

				const frameworks = grcEngine.getActiveFrameworks();
				const frameworkContext = frameworks.length > 0
					? `Active frameworks: ${frameworks.map(f => f.name).join(', ')}.`
					: 'No frameworks currently active.';

				const prompt = [
					`You are a GRC rule author for the Neural Inverse compliance platform.`,
					``,
					`Generate a GRC rule JSON object for the following requirement:`,
					`"${description}"`,
					``,
					`Hints:`,
					`- Rule type: ${type}`,
					domain ? `- Domain: ${domain}` : `- Choose the most appropriate domain.`,
					frameworkContext,
					``,
					`Return ONLY valid JSON matching this schema (no markdown, no explanation):`,
					`{`,
					`  "id": "DOMAIN-XXX",`,
					`  "name": "Short rule name",`,
					`  "description": "What this rule enforces and why",`,
					`  "type": "${type}",`,
					`  "severity": "error" | "warning" | "info",`,
					`  "domain": "domain-name",`,
					`  "check": "regex-pattern-or-ast-selector",`,
					`  "message": "Violation message shown to developer",`,
					`  "tags": ["tag1", "tag2"],`,
					`  "enabled": true`,
					`}`,
				].join('\n');

				try {
					const result = await contractReasonService.sendOneShotQuery(prompt);
					if (!result) {
						return 'AI did not return a rule. Try again with a more specific description.';
					}
					// Extract JSON if wrapped in code block
					const jsonMatch = result.match(/```(?:json)?\n?([\s\S]*?)\n?```/) ?? result.match(/(\{[\s\S]*\})/);
					const jsonStr = jsonMatch ? jsonMatch[1] : result;
					try {
						JSON.parse(jsonStr); // validate
						return `Generated rule (add to .inverse/rules.json):\n\n${jsonStr}`;
					} catch {
						return `AI generated a rule but it may need minor edits:\n\n${result}`;
					}
				} catch (e: any) {
					return `Failed to generate rule: ${e.message}`;
				}
			}
		),

		// \u2500\u2500 11. read \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		defineChecksTool(
			'read',
			'Read a source file directly. Use this before asking Power Mode \u2014 you can read code yourself. Returns contents with line numbers.',
			[
				{ name: 'filePath', type: 'string', description: 'Absolute file path. If relative, resolved against workspace root.', required: true },
				{ name: 'offset', type: 'number', description: 'Line to start from (1-indexed). Omit to start from beginning.', required: false },
				{ name: 'limit', type: 'number', description: 'Max lines to return (default 200).', required: false },
			],
			async (args) => {
				let filePath = (args.filePath as string) || '';
				if (!filePath.startsWith('/')) { filePath = workingDirectory + '/' + filePath; }
				const offset = Math.max(1, (args.offset as number) ?? 1);
				const limit = Math.min(500, (args.limit as number) ?? 200);
				try {
					const content = await fileService.readFile(URI.file(filePath));
					const lines = content.value.toString().split('\n');
					const slice = lines.slice(offset - 1, offset - 1 + limit);
					const out = slice.map((l, i) => `${offset + i}: ${l}`).join('\n');
					const truncated = lines.length > offset - 1 + limit ? `\n[... ${lines.length - (offset - 1 + limit)} more lines]` : '';
					return out + truncated || '(empty file)';
				} catch (e: any) {
					return `Error reading file: ${e.message}`;
				}
			}
		),

		// \u2500\u2500 12. grep \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		defineChecksTool(
			'grep',
			'Search for a pattern across workspace files. Returns file paths with matching lines. Use this to find all imports of a module, all usages of a function, etc. Supports regex.',
			[
				{ name: 'pattern', type: 'string', description: 'Text or regex pattern to search for.', required: true },
				{ name: 'include', type: 'string', description: 'File glob to limit search (e.g. "**/*.ts", "src/**/*.js"). Omit to search all files.', required: false },
				{ name: 'path', type: 'string', description: 'Directory to search in. Defaults to workspace root.', required: false },
			],
			async (args) => {
				const pattern = (args.pattern as string) || '';
				const include = (args.include as string) || undefined;
				const searchPath = (args.path as string) || workingDirectory;
				if (!pattern) { return 'pattern is required.'; }
				try {
					const query: ITextQuery = {
						type: QueryType.Text,
						contentPattern: { pattern, isRegExp: true, isCaseSensitive: false },
						folderQueries: [{ folder: URI.file(searchPath) }],
						includePattern: include ? { [include]: true } : undefined,
						excludePattern: { '**/node_modules': true, '**/.git': true },
						maxResults: 100,
					};
					const matches: string[] = [];
					await searchService.textSearch(query, undefined, (item) => {
						if ('resource' in item) {
							const fileMatch = item as { resource: { fsPath: string }; results?: Array<{ rangeLocations?: Array<{ source: { startLineNumber: number } }>; previewText?: string }> };
							const file = fileMatch.resource.fsPath;
							for (const result of (fileMatch.results ?? [])) {
								const line = (result.rangeLocations?.[0]?.source.startLineNumber ?? 0) + 1;
								const preview = (result.previewText ?? '').trim().substring(0, 120);
								matches.push(`${file}:${line}: ${preview}`);
							}
						}
					});
					return matches.length > 0
						? `${matches.length} match(es):\n${matches.join('\n')}`
						: 'No matches found.';
				} catch (e: any) {
					return `Search error: ${e.message}`;
				}
			}
		),

		// \u2500\u2500 13. glob \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		defineChecksTool(
			'glob',
			'Find files by name or glob pattern. Use to locate files before reading them.',
			[
				{ name: 'pattern', type: 'string', description: 'Glob pattern (e.g. "**/*.js", "src/auth/**", "**/auth*").', required: true },
				{ name: 'path', type: 'string', description: 'Directory to search in. Defaults to workspace root.', required: false },
			],
			async (args) => {
				const pattern = (args.pattern as string) || '';
				const searchPath = (args.path as string) || workingDirectory;
				if (!pattern) { return 'pattern is required.'; }
				try {
					const query: IFileQuery = {
						type: QueryType.File,
						folderQueries: [{ folder: URI.file(searchPath) }],
						filePattern: pattern,
						maxResults: 100,
					};
					const results = await searchService.fileSearch(query);
					const files = results.results.map((r: any) => r.resource.fsPath);
					return files.length > 0
						? `${files.length} file(s):\n${files.join('\n')}`
						: 'No files matched.';
				} catch (e: any) {
					return `Glob error: ${e.message}`;
				}
			}
		),

		// \u2500\u2500 15. list_invariants \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		defineChecksTool(
			'list_invariants',
			'List all formal invariants defined in .inverse/invariants.json. Shows each invariant\'s ID, name, expression, scope, severity, and current pass/fail status.',
			[],
			async (_args) => {
				const invariants = grcEngine.getInvariants();
				if (invariants.length === 0) {
					return 'No invariants defined. Use add_invariant to create one, or create .inverse/invariants.json manually.';
				}
				const violations = grcEngine.getResultsForDomain('formal-verification');
				const rows = invariants.map(inv => {
					const invViolations = violations.filter(v => v.ruleId === inv.id);
					return {
						id: inv.id,
						name: inv.name,
						expression: inv.expression,
						scope: inv.scope,
						severity: inv.severity,
						enabled: inv.enabled !== false,
						variables: inv.variables ?? [],
						targetCalls: inv.targetCalls ?? [],
						status: invViolations.length === 0 ? 'passing' : `${invViolations.length} violation(s)`,
					};
				});
				return JSON.stringify({ count: rows.length, invariants: rows }, null, 2);
			}
		),

		// \u2500\u2500 16. add_invariant \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		defineChecksTool(
			'add_invariant',
			'Add a new formal invariant to .inverse/invariants.json. Invariants are statically checked against TypeScript/JavaScript code. Scope "always" tracks variable assignments, "before-call" requires a guard before target function calls, "after-call" requires a check after target calls.',
			[
				{ name: 'id', type: 'string', description: 'Unique invariant ID, e.g. "INV-001". Must be unique across all invariants.', required: true },
				{ name: 'name', type: 'string', description: 'Human-readable name, e.g. "Non-negative balance".', required: true },
				{ name: 'expression', type: 'string', description: 'The invariant expression, e.g. "balance >= 0", "isAuthenticated == true", "retryCount <= 3". Format: <variable> <op> <value> where op is >=, <=, ==, !=, >, <.', required: true },
				{ name: 'scope', type: 'string', description: 'When the invariant must hold: "always" (track all assignments), "before-call" (guard must be true before target calls), "after-call" (condition checked after target calls).', required: true },
				{ name: 'severity', type: 'string', description: 'Violation severity: "error", "warning", or "info". Default "warning".', required: false },
				{ name: 'variables', type: 'string', description: 'Comma-separated variable names to track (for "always" scope). Leave blank to use the variable in expression.', required: false },
				{ name: 'targetCalls', type: 'string', description: 'Comma-separated function names to guard (for "before-call"/"after-call" scope).', required: false },
			],
			async (args) => {
				const { id, name, expression, scope, severity = 'warning', variables, targetCalls } = args as {
					id: string; name: string; expression: string;
					scope: string; severity?: string;
					variables?: string; targetCalls?: string;
				};

				if (!id || !name || !expression || !scope) {
					return 'Invalid args: id, name, expression, and scope are all required.';
				}
				if (!['always', 'before-call', 'after-call'].includes(scope)) {
					return 'Invalid scope. Must be "always", "before-call", or "after-call".';
				}

				// Check for duplicate ID
				const existing = grcEngine.getInvariants().find(i => i.id === id);
				if (existing) {
					return `Invariant "${id}" already exists. Use delete_invariant first if you want to replace it.`;
				}

				const invariant: IInvariantDefinition = {
					id,
					name,
					expression,
					scope: scope as IInvariantDefinition['scope'],
					severity,
					enabled: true,
					variables: variables ? variables.split(',').map(s => s.trim()).filter(Boolean) : undefined,
					targetCalls: targetCalls ? targetCalls.split(',').map(s => s.trim()).filter(Boolean) : undefined,
				};

				try {
					await grcEngine.saveInvariant(invariant);
					return `Invariant "${id}" (${name}) added. Expression: "${expression}", Scope: ${scope}. The engine will check this on the next file evaluation.`;
				} catch (e: any) {
					return `Failed to save invariant: ${e.message}`;
				}
			}
		),

		// \u2500\u2500 17. delete_invariant \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		defineChecksTool(
			'delete_invariant',
			'Delete a formal invariant by ID from .inverse/invariants.json.',
			[
				{ name: 'id', type: 'string', description: 'The invariant ID to delete (e.g. "INV-001").', required: true },
			],
			async (args) => {
				const { id } = args as { id: string };
				if (!id) { return 'Invalid args: id is required.'; }
				const existing = grcEngine.getInvariants().find(i => i.id === id);
				if (!existing) {
					return `Invariant "${id}" not found. Use list_invariants to see available invariants.`;
				}
				try {
					await grcEngine.deleteInvariant(id);
					return `Invariant "${id}" (${existing.name}) deleted.`;
				} catch (e: any) {
					return `Failed to delete invariant: ${e.message}`;
				}
			}
		),

		// \u2500\u2500 18. toggle_invariant \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		defineChecksTool(
			'toggle_invariant',
			'Enable or disable a formal invariant by ID without deleting it.',
			[
				{ name: 'id', type: 'string', description: 'The invariant ID to toggle (e.g. "INV-001").', required: true },
				{ name: 'enabled', type: 'boolean', description: 'true to enable, false to disable.', required: true },
			],
			async (args) => {
				const { id, enabled } = args as { id: string; enabled: boolean };
				if (!id || enabled === undefined) { return 'Invalid args: id and enabled are required.'; }
				const existing = grcEngine.getInvariants().find(i => i.id === id);
				if (!existing) {
					return `Invariant "${id}" not found. Use list_invariants to see available invariants.`;
				}
				try {
					await grcEngine.toggleInvariant(id, enabled);
					return `Invariant "${id}" (${existing.name}) ${enabled ? 'enabled' : 'disabled'}.`;
				} catch (e: any) {
					return `Failed to toggle invariant: ${e.message}`;
				}
			}
		),

		// \u2500\u2500 14. ask_power_mode \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		defineChecksTool(
			'ask_power_mode',
			'Ask Power Mode (the coding agent) a reasoning question about code. Use this when you need Power Mode\'s judgment \u2014 e.g. "does this pattern create a race condition?" or "is this a real CSRF risk given the context?". Do NOT use this just to read files or search \u2014 use read/grep/glob for that.',
			[
				{ name: 'question', type: 'string', description: 'The question to ask Power Mode. Be specific \u2014 include file names, violation IDs, or line numbers when relevant.', required: true },
			],
			async (args) => {
				const { question } = args as { question: string };
				if (!question) { return 'Invalid args: question (string) is required.'; }
				try {
					const result = await checksAgentService.askPowerMode(question);
					return result || 'Power Mode returned no answer.';
				} catch (e: any) {
					return `Failed to reach Power Mode: ${e.message}`;
				}
			}
		),

		// \u2500\u2500 General workflow tools (shared with Power Mode) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

		// web_fetch - Fetch external documentation
		...[createWebFetchTool()].map(tool => defineChecksTool(
			tool.id,
			tool.description,
			tool.parameters.map(p => ({ name: p.name, type: p.type as any, description: p.description, required: p.required })),
			async (args) => {
				const result = await tool.execute(args, {} as any);
				return result.output;
			}
		)),

		// memory_write - Write compliance decisions
		...[createMemoryWriteTool(workingDirectory, fileService)].map(tool => defineChecksTool(
			tool.id,
			tool.description,
			tool.parameters.map(p => ({ name: p.name, type: p.type as any, description: p.description, required: p.required })),
			async (args) => {
				const result = await tool.execute(args, {} as any);
				return result.output;
			}
		)),

		// memory_read - Read compliance decisions
		...[createMemoryReadTool(workingDirectory, fileService)].map(tool => defineChecksTool(
			tool.id,
			tool.description,
			tool.parameters.map(p => ({ name: p.name, type: p.type as any, description: p.description, required: p.required })),
			async (args) => {
				const result = await tool.execute(args, {} as any);
				return result.output;
			}
		)),

		// Task management tools
		...[
			createTaskCreateTool(),
			createTaskListTool(),
			createTaskUpdateTool(),
			createTaskGetTool(),
		].map(tool => defineChecksTool(
			tool.id,
			tool.description,
			tool.parameters.map(p => ({ name: p.name, type: p.type as any, description: p.description, required: p.required })),
			async (args) => {
				const result = await tool.execute(args, {} as any);
				return result.output;
			}
		)),

	];
}
