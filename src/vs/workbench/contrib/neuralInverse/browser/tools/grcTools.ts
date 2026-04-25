/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # GRC Tools for neuralInverse workflow agents
 *
 * IAgentTool implementations that expose GRC Engine capabilities to
 * workflow agents running inside WorkflowAgentService. These are the
 * same GRC capabilities available to the Void coding agent, surfaced
 * as native IAgentTool instances so neuralInverse agents can evaluate
 * compliance, trigger rescans, and gate on blocking violations.
 *
 * Usage: call createGRCTools(grcEngine) and registerMany() the result.
 */

import { URI } from '../../../../../base/common/uri.js';
import { IAgentTool, IToolExecutionContext, IToolResult } from '../../common/workflowTypes.js';
import { IGRCEngineService } from '../../../neuralInverseChecks/browser/engine/services/grcEngineService.js';

// ─── grcViolations ────────────────────────────────────────────────────────────

class GRCViolationsTool implements IAgentTool {
	readonly name = 'grcViolations';
	readonly description = 'Get GRC violations from the in-memory cache. Optionally filter by domain, severity, or file path. Returns a formatted list of violations with rule IDs, messages, and file locations.';
	readonly parameters = {
		domain: { type: 'string' as const, description: 'Optional. Filter by GRC domain (e.g. "security", "privacy"). Leave empty for all domains.', required: false },
		severity: { type: 'string' as const, description: 'Optional. Filter by severity: "error", "warning", or "info".', required: false },
		file: { type: 'string' as const, description: 'Optional. Filter to violations in a specific file path substring.', required: false },
	};

	constructor(private readonly grcEngine: IGRCEngineService) {}

	async execute(args: Record<string, unknown>, _ctx: IToolExecutionContext): Promise<IToolResult> {
		const domain = args['domain'] as string | undefined;
		const severity = args['severity'] as string | undefined;
		const file = args['file'] as string | undefined;

		let results = this.grcEngine.getAllResults();

		if (domain) results = results.filter(r => r.domain?.toLowerCase() === domain.toLowerCase());
		if (severity) results = results.filter(r => r.severity === severity);
		if (file) results = results.filter(r => r.fileUri?.fsPath?.includes(file));

		if (results.length === 0) {
			return { success: true, output: 'No GRC violations found matching the given filters.' };
		}

		const lines = results.slice(0, 50).map(r =>
			`[${r.severity?.toUpperCase() ?? 'INFO'}] ${r.fileUri?.fsPath?.split('/').slice(-2).join('/') ?? 'unknown'}: ${r.message} (rule: ${r.ruleId ?? 'n/a'})`
		);
		if (results.length > 50) lines.push(`... and ${results.length - 50} more violations.`);

		return { success: true, output: `${results.length} violation(s):\n${lines.join('\n')}` };
	}
}

// ─── grcBlockingViolations ────────────────────────────────────────────────────

class GRCBlockingViolationsTool implements IAgentTool {
	readonly name = 'grcBlockingViolations';
	readonly description = 'Get only the blocking GRC violations — those that must be fixed before committing. Returns an empty list when it is safe to proceed.';
	readonly parameters = {};

	constructor(private readonly grcEngine: IGRCEngineService) {}

	async execute(_args: Record<string, unknown>, _ctx: IToolExecutionContext): Promise<IToolResult> {
		const blocking = this.grcEngine.getBlockingViolations();
		if (blocking.length === 0) {
			return { success: true, output: 'No blocking GRC violations. Safe to proceed.' };
		}
		const lines = blocking.map(r =>
			`[BLOCKING] ${r.fileUri?.fsPath?.split('/').slice(-2).join('/') ?? 'unknown'}: ${r.message} (rule: ${r.ruleId ?? 'n/a'})`
		);
		return { success: false, output: `${blocking.length} blocking violation(s) found — must fix before commit:\n${lines.join('\n')}` };
	}
}

// ─── grcDomainSummary ─────────────────────────────────────────────────────────

class GRCDomainSummaryTool implements IAgentTool {
	readonly name = 'grcDomainSummary';
	readonly description = 'Get a high-level compliance summary grouped by GRC domain. Shows total violations, blocking count, and worst severity per domain.';
	readonly parameters = {};

	constructor(private readonly grcEngine: IGRCEngineService) {}

	async execute(_args: Record<string, unknown>, _ctx: IToolExecutionContext): Promise<IToolResult> {
		const summary = this.grcEngine.getDomainSummary();
		if (summary.length === 0) {
			return { success: true, output: 'No GRC domains with violations. Workspace appears compliant.' };
		}
		const lines = summary.map(d =>
			`${d.domain}: ${d.errorCount} error(s), ${d.warningCount} warning(s), ${d.infoCount} info (${d.enabledRules}/${d.totalRules} rules active)`
		);
		return { success: true, output: `GRC Domain Summary:\n${lines.join('\n')}` };
	}
}

// ─── grcRescan ────────────────────────────────────────────────────────────────

class GRCRescanTool implements IAgentTool {
	readonly name = 'grcRescan';
	readonly description = 'Trigger a full static workspace rescan to refresh GRC violation data. Use after making code changes before checking blocking violations.';
	readonly parameters = {};

	constructor(private readonly grcEngine: IGRCEngineService) {}

	async execute(_args: Record<string, unknown>, _ctx: IToolExecutionContext): Promise<IToolResult> {
		try {
			await this.grcEngine.scanWorkspace();
			const blocking = this.grcEngine.getBlockingViolations();
			const total = this.grcEngine.getAllResults().length;
			return {
				success: true,
				output: `Rescan complete. ${total} total violation(s), ${blocking.length} blocking.`,
			};
		} catch (e: any) {
			return { success: false, output: '', error: `Rescan failed: ${e.message ?? e}` };
		}
	}
}

// ─── grcImpactChain ───────────────────────────────────────────────────────────

class GRCImpactChainTool implements IAgentTool {
	readonly name = 'grcImpactChain';
	readonly description = 'Get the cross-file impact chain for a given file — which files import it and would be affected by changes. Use before refactoring to understand blast radius.';
	readonly parameters = {
		file: { type: 'string' as const, description: 'Workspace-relative or absolute path to the file to analyze.', required: true },
		maxDepth: { type: 'number' as const, description: 'Max recursion depth for the dependency tree. Default: 3.', required: false },
	};

	constructor(private readonly grcEngine: IGRCEngineService) {}

	async execute(args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		const file = args['file'] as string;
		if (!file) return { success: false, output: '', error: 'file is required' };
		const maxDepth = (args['maxDepth'] as number) ?? 3;

		// Convert workspace-relative path to absolute URI
		const fileUri = file.startsWith('/')
			? URI.file(file)
			: URI.joinPath(ctx.workspaceUri, file);

		const impact = this.grcEngine.getImpactChain(fileUri, maxDepth);
		if (!impact) {
			return { success: true, output: `No impact chain data for "${file}". File may not be indexed yet — try grcRescan first.` };
		}

		type ImpactNode = { fileName: string; filePath: string; violations: number; dependents: ImpactNode[] };
		const renderTree = (node: ImpactNode, depth = 0): string => {
			const indent = '  '.repeat(depth);
			let out = `${indent}${depth === 0 ? '\u2192 ' : '↳ '}${node.filePath || node.fileName}${node.violations ? ` (${node.violations} violation(s))` : ''}`;
			for (const dep of node.dependents) {
				out += '\n' + renderTree(dep, depth + 1);
			}
			return out;
		};

		const countDescendants = (node: ImpactNode): number => {
			if (node.dependents.length === 0) return 0;
			let count = node.dependents.length;
			for (const dep of node.dependents) count += countDescendants(dep);
			return count;
		};

		const total = countDescendants(impact as ImpactNode);
		return {
			success: true,
			output: `Impact chain for ${impact.fileName} (${total} dependent file(s) affected):\n${renderTree(impact as ImpactNode)}`,
		};
	}
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create all GRC tools wired to the given engine instance.
 * Pass the result to ToolRegistry.registerMany().
 */
export function createGRCTools(grcEngine: IGRCEngineService): IAgentTool[] {
	return [
		new GRCViolationsTool(grcEngine),
		new GRCBlockingViolationsTool(grcEngine),
		new GRCDomainSummaryTool(grcEngine),
		new GRCRescanTool(grcEngine),
		new GRCImpactChainTool(grcEngine),
	];
}

/** Tool names for use in IWorkflowStep.allowedTools */
export const GRC_TOOL_NAMES = [
	'grcViolations',
	'grcBlockingViolations',
	'grcDomainSummary',
	'grcRescan',
	'grcImpactChain',
] as const;

export type GRCToolName = (typeof GRC_TOOL_NAMES)[number];
