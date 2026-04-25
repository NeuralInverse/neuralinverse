/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Formatters for modernisation and KB tools to display human-readable summaries
 * instead of raw JSON output.
 */

import React from 'react';

// \u2500\u2500\u2500 Tool Type Detection \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const KB_UNIT_TOOLS = new Set([
	'get_unit', 'list_units', 'get_next_unit', 'get_unit_context', 'get_unit_dependencies',
	'get_impact_chain', 'get_dependency_tree', 'search_units', 'get_unit_history'
]);

const KB_TRANSLATION_TOOLS = new Set([
	'record_translation', 'flag_ready', 'flag_blocked', 'revert_unit'
]);

const KB_DECISION_TOOLS = new Set([
	'get_pending_decisions', 'answer_decision', 'get_decision_log',
	'record_type_mapping', 'record_naming_decision', 'record_rule_interpretation', 'record_pattern_override'
]);

const KB_PROGRESS_TOOLS = new Set([
	'get_progress', 'get_workspace_summary', 'get_units_by_phase', 'check_compliance_gate'
]);

const KB_GLOSSARY_TOOLS = new Set([
	'get_glossary', 'add_glossary_term', 'get_business_rules'
]);

const AUTONOMY_TOOLS = new Set([
	'autonomy_start_batch', 'autonomy_pause_batch', 'autonomy_resume_batch', 'autonomy_stop_batch',
	'autonomy_run_single_unit', 'autonomy_preview_schedule', 'autonomy_get_escalations', 'autonomy_resolve_escalation', 'autonomy_get_history'
]);

const DISCOVERY_TOOLS = new Set([
	'discover_project', 'scan_workspace', 'detect_languages', 'extract_metadata'
]);

const PLANNING_TOOLS = new Set([
	'build_roadmap', 'get_migration_plan', 'get_session_info'
]);

export type ModernisationToolCategory = 'kb-unit' | 'kb-translation' | 'kb-decision' | 'kb-progress' | 'kb-glossary' | 'autonomy' | 'discovery' | 'planning' | 'unknown';

export function getToolCategory(toolName: string): ModernisationToolCategory {
	if (KB_UNIT_TOOLS.has(toolName)) return 'kb-unit';
	if (KB_TRANSLATION_TOOLS.has(toolName)) return 'kb-translation';
	if (KB_DECISION_TOOLS.has(toolName)) return 'kb-decision';
	if (KB_PROGRESS_TOOLS.has(toolName)) return 'kb-progress';
	if (KB_GLOSSARY_TOOLS.has(toolName)) return 'kb-glossary';
	if (AUTONOMY_TOOLS.has(toolName)) return 'autonomy';
	if (DISCOVERY_TOOLS.has(toolName)) return 'discovery';
	if (PLANNING_TOOLS.has(toolName)) return 'planning';
	return 'unknown';
}

export function getCategoryLabel(category: ModernisationToolCategory): string {
	switch (category) {
		case 'kb-unit': return 'KB Tool';
		case 'kb-translation': return 'Translation Tool';
		case 'kb-decision': return 'Decision Tool';
		case 'kb-progress': return 'Progress Tool';
		case 'kb-glossary': return 'Glossary Tool';
		case 'autonomy': return 'Autonomy Tool';
		case 'discovery': return 'Discovery Tool';
		case 'planning': return 'Planning Tool';
		case 'unknown': return 'Internal Tool';
	}
}

// \u2500\u2500\u2500 Summary Formatters \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface ToolSummary {
	title: string;
	description: string;
	details?: React.ReactNode;
}

function parseJSONSafely(str: string): any {
	try {
		return JSON.parse(str);
	} catch {
		return null;
	}
}

export function formatToolSummary(toolName: string, params: any, result: string): ToolSummary {
	const category = getToolCategory(toolName);
	const data = parseJSONSafely(result);

	// Default fallback
	const defaultSummary: ToolSummary = {
		title: toolName.replace(/_/g, ' '),
		description: 'Executed successfully',
	};

	if (!data) return defaultSummary;

	// \u2500\u2500 KB Unit Tools \u2500\u2500
	if (toolName === 'get_unit' && data.unit) {
		const u = data.unit;

		const statusColors: Record<string, string> = {
			'ready': 'bg-green-500/20 text-green-400 border-green-500/30',
			'pending': 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
			'blocked': 'bg-red-500/20 text-red-400 border-red-500/30',
			'translating': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
			'complete': 'bg-green-600/20 text-green-300 border-green-600/30',
		};

		const riskColors: Record<string, string> = {
			'critical': 'text-red-400',
			'high': 'text-orange-400',
			'medium': 'text-yellow-400',
			'low': 'text-green-400',
		};

		const statusColor = statusColors[u.status] || 'bg-void-bg-3 text-void-fg-3 border-void-border';
		const riskColor = riskColors[u.riskLevel] || 'text-void-fg-3';

		return {
			title: 'Unit Details',
			description: u.name,
			details: (
				<div className="space-y-3 text-xs">
					{/* Status and risk badges */}
					<div className="flex items-center gap-2">
						<span className={`px-2 py-0.5 rounded border capitalize ${statusColor}`}>
							{u.status}
						</span>
						<span className={`px-2 py-0.5 rounded border border-void-border bg-void-bg-2 capitalize ${riskColor}`}>
							{u.riskLevel} risk
						</span>
						<span className="px-2 py-0.5 rounded border border-void-border bg-void-bg-2 text-void-fg-3">
							{u.sourceLang}
						</span>
					</div>

					{/* Files */}
					<div className="space-y-1 pt-2 border-t border-void-border">
						<div className="flex items-start gap-2">
							<span className="text-void-fg-4 min-w-[4rem]">Source:</span>
							<span className="text-void-fg-2 font-mono text-[11px] break-all">{u.sourceFile}</span>
						</div>
						{u.targetFile && (
							<div className="flex items-start gap-2">
								<span className="text-void-fg-4 min-w-[4rem]">Target:</span>
								<span className="text-void-fg-2 font-mono text-[11px] break-all">{u.targetFile}</span>
							</div>
						)}
					</div>

					{/* Dependencies */}
					<div className="flex items-center gap-4 pt-2 border-t border-void-border">
						<div className="flex items-center gap-2">
							<span className="text-void-fg-4">Upstream:</span>
							<span className="font-semibold text-void-fg-2">{u.dependsOnCount || 0}</span>
						</div>
						<div className="flex items-center gap-2">
							<span className="text-void-fg-4">Downstream:</span>
							<span className="font-semibold text-void-fg-2">{u.usedByCount || 0}</span>
						</div>
					</div>
				</div>
			),
		};
	}

	if (toolName === 'list_units' && data.units) {
		const units = data.units;
		const total = data.total ?? units.length;

		return {
			title: 'Unit List',
			description: `${units.length} units${total > units.length ? ` of ${total} total` : ''}`,
			details: units.length > 0 ? (
				<div className="space-y-2 text-xs">
					{units.slice(0, 8).map((u: any, i: number) => {
						const riskColors: Record<string, string> = {
							'critical': 'text-red-400',
							'high': 'text-orange-400',
							'medium': 'text-yellow-400',
							'low': 'text-green-400',
						};
						const riskColor = riskColors[u.riskLevel] || 'text-void-fg-3';

						return (
							<div key={i} className="flex items-center gap-2 px-2 py-1.5 bg-void-bg-2 rounded border border-void-border hover:bg-void-bg-3 transition-colors">
								<span className="text-void-fg-4 min-w-[1.5rem]">{i + 1}.</span>
								<span className="flex-1 text-void-fg-2 font-mono text-[11px] truncate">{u.name}</span>
								<span className={`capitalize ${riskColor} min-w-[4rem] text-right`}>{u.riskLevel}</span>
							</div>
						);
					})}
					{units.length > 8 && (
						<div className="text-center text-void-fg-4 py-1">
							... {units.length - 8} more units
						</div>
					)}
				</div>
			) : (
				<div className="text-xs text-void-fg-4 py-2 text-center">No units found</div>
			),
		};
	}

	if (toolName === 'get_next_unit') {
		const u = data.unit;

		if (!u) {
			return {
				title: 'Next Unit',
				description: 'No units available',
				details: (
					<div className="px-3 py-2 bg-green-500/10 border border-green-500/30 rounded text-xs text-green-400">
						Translation queue is empty \u2014 all units have been processed!
					</div>
				),
			};
		}

		const riskColors: Record<string, string> = {
			'critical': 'text-red-400 bg-red-500/20 border-red-500/30',
			'high': 'text-orange-400 bg-orange-500/20 border-orange-500/30',
			'medium': 'text-yellow-400 bg-yellow-500/20 border-yellow-500/30',
			'low': 'text-green-400 bg-green-500/20 border-green-500/30',
		};
		const riskColor = riskColors[u.riskLevel] || 'text-void-fg-3 bg-void-bg-3 border-void-border';

		return {
			title: 'Next Unit Ready',
			description: u.name,
			details: (
				<div className="space-y-2 text-xs">
					{/* Priority indicators */}
					<div className="flex items-center gap-2">
						<span className={`px-3 py-1 rounded border capitalize font-medium ${riskColor}`}>
							{u.riskLevel} risk
						</span>
						<span className="px-3 py-1 bg-void-bg-2 border border-void-border rounded text-void-fg-3">
							{u.sourceLang}
						</span>
					</div>

					{/* Stats */}
					<div className="grid grid-cols-2 gap-2 pt-2 border-t border-void-border">
						<div className="px-3 py-1.5 bg-void-bg-2 border border-void-border rounded">
							<div className="text-void-fg-4 mb-0.5">Dependents</div>
							<div className="text-void-fg-1 font-semibold">{u.dependentCount || 0}</div>
						</div>
						<div className="px-3 py-1.5 bg-void-bg-2 border border-void-border rounded">
							<div className="text-void-fg-4 mb-0.5">Dependencies</div>
							<div className="text-void-fg-1 font-semibold">{u.dependsOnCount || 0}</div>
						</div>
					</div>

					{/* File path */}
					{u.sourceFile && (
						<div className="pt-2 border-t border-void-border">
							<div className="text-void-fg-4 mb-1">Source File</div>
							<div className="px-2 py-1 bg-void-bg-3 rounded border border-void-border text-void-fg-2 font-mono text-[10px] break-all">
								{u.sourceFile}
							</div>
						</div>
					)}
				</div>
			),
		};
	}

	if (toolName === 'get_unit_context' && data.context) {
		const ctx = data.context;

		const contextItems = [
			{ label: 'Type Mappings', count: ctx.typeMappings?.length || 0, color: 'text-purple-400' },
			{ label: 'Naming Decisions', count: ctx.namingDecisions?.length || 0, color: 'text-blue-400' },
			{ label: 'Business Rules', count: ctx.businessRules?.length || 0, color: 'text-yellow-400' },
			{ label: 'Glossary Terms', count: ctx.glossaryTerms?.length || 0, color: 'text-green-400' },
			{ label: 'Interface Stubs', count: ctx.interfaces?.length || 0, color: 'text-orange-400' },
		];

		const totalItems = contextItems.reduce((sum, item) => sum + item.count, 0);

		return {
			title: 'Unit Context',
			description: params.unitId || 'Translation context assembled',
			details: (
				<div className="space-y-3 text-xs">
					{/* Total summary */}
					<div className="px-3 py-2 bg-void-bg-2 rounded border border-void-border">
						<div className="flex items-center justify-between">
							<span className="text-void-fg-4">Total Context Items</span>
							<span className="font-semibold text-void-fg-1 text-lg">{totalItems}</span>
						</div>
					</div>

					{/* Breakdown */}
					<div className="space-y-1.5">
						{contextItems.map((item, i) => (
							item.count > 0 && (
								<div key={i} className="flex items-center justify-between px-3 py-1.5 bg-void-bg-2 rounded border border-void-border">
									<span className="text-void-fg-3">{item.label}</span>
									<span className={`font-semibold ${item.color}`}>{item.count}</span>
								</div>
							)
						))}
					</div>

					{/* Token budget info */}
					{ctx.tokenCount && (
						<div className="pt-2 border-t border-void-border">
							<div className="flex items-center justify-between px-3 py-1.5 bg-void-bg-3 rounded">
								<span className="text-void-fg-4">Token Budget</span>
								<span className="text-void-fg-2 font-mono">{ctx.tokenCount.toLocaleString()} tokens</span>
							</div>
						</div>
					)}
				</div>
			),
		};
	}

	// \u2500\u2500 KB Progress Tools \u2500\u2500
	if (toolName === 'get_progress') {
		// Handle both nested data.progress and flat data structures
		const p = data.progress || data;
		const summary = data.summary || data._summary;

		// Try to extract values from various possible structures
		const totalUnits = p.totalUnits ?? summary?.totalUnits ?? 0;
		const committedUnits = p.committedUnits ?? summary?.committedUnits ?? 0;
		const byStatus = p.byStatus ?? summary?.byStatus ?? data.data?.byStatus;
		const percentComplete = summary?.percentComplete ?? (totalUnits > 0 ? Math.round((committedUnits / totalUnits) * 100) : 0);

		return {
			title: 'Migration Progress',
			description: `${percentComplete}% complete \u2014 ${committedUnits} of ${totalUnits} units committed`,
			details: (
				<div className="space-y-3 text-xs">
					{/* Progress bar */}
					<div className="flex items-center gap-3">
						<div className="flex-1 bg-void-bg-2 rounded-full h-3 overflow-hidden border border-void-border">
							<div
								className="bg-gradient-to-r from-green-600 to-green-500 h-full transition-all duration-300"
								style={{ width: `${percentComplete}%` }}
							/>
						</div>
						<span className="font-semibold text-void-fg-2 min-w-[3rem] text-right">{percentComplete}%</span>
					</div>

					{/* Status breakdown */}
					{byStatus && (
						<div className="grid grid-cols-2 gap-2 pt-2 border-t border-void-border">
							{Object.entries(byStatus).map(([status, count]: [string, any]) => {
								if (count === 0) return null;

								const statusColors: Record<string, string> = {
									'committed': 'text-green-500',
									'pending': 'text-yellow-500',
									'blocked': 'text-red-500',
									'translating': 'text-blue-500',
									'review': 'text-purple-500',
									'approved': 'text-green-400',
								};

								const color = statusColors[status] || 'text-void-fg-3';

								return (
									<div key={status} className="flex items-center justify-between px-2 py-1 bg-void-bg-2 rounded border border-void-border">
										<span className="capitalize text-void-fg-3">{status}</span>
										<span className={`font-semibold ${color}`}>{count}</span>
									</div>
								);
							})}
						</div>
					)}
				</div>
			),
		};
	}

	if (toolName === 'get_workspace_summary') {
		const s = data.summary || data;
		const totalFiles = s.totalFiles || 0;
		const totalLines = s.totalLines || 0;
		const languages = s.languages || [];

		return {
			title: 'Workspace Summary',
			description: `${totalFiles.toLocaleString()} files · ${totalLines.toLocaleString()} lines of code`,
			details: (
				<div className="space-y-3 text-xs">
					{/* Stats grid */}
					<div className="grid grid-cols-2 gap-2">
						<div className="px-3 py-2 bg-void-bg-2 rounded border border-void-border">
							<div className="text-void-fg-4 text-[10px] uppercase tracking-wide mb-1">Files</div>
							<div className="text-void-fg-1 font-semibold text-lg">{totalFiles.toLocaleString()}</div>
						</div>
						<div className="px-3 py-2 bg-void-bg-2 rounded border border-void-border">
							<div className="text-void-fg-4 text-[10px] uppercase tracking-wide mb-1">Lines</div>
							<div className="text-void-fg-1 font-semibold text-lg">{totalLines.toLocaleString()}</div>
						</div>
					</div>

					{/* Languages */}
					{languages.length > 0 && (
						<div className="pt-2 border-t border-void-border">
							<div className="text-void-fg-4 mb-2">Languages Detected</div>
							<div className="flex flex-wrap gap-1.5">
								{languages.map((lang: string, i: number) => (
									<span key={i} className="px-2 py-0.5 bg-void-bg-3 text-void-fg-2 rounded border border-void-border text-[11px]">
										{lang}
									</span>
								))}
							</div>
						</div>
					)}
				</div>
			),
		};
	}

	// \u2500\u2500 KB Translation Tools \u2500\u2500
	if (toolName === 'record_translation') {
		const unit = data.unit;
		return {
			title: 'Translation Recorded',
			description: params.unitId || 'Translation saved successfully',
			details: unit ? (
				<div className="space-y-2 text-xs">
					<div className="flex items-center gap-2 px-3 py-2 bg-void-bg-2 rounded border border-void-border">
						<span className="text-void-fg-4">Status:</span>
						<span className="px-2 py-0.5 bg-green-500/20 text-green-400 border border-green-500/30 rounded capitalize">
							{unit.status}
						</span>
					</div>
					{unit.targetFile && (
						<div className="px-3 py-2 bg-void-bg-2 rounded border border-void-border">
							<div className="text-void-fg-4 mb-1">Target File</div>
							<div className="text-void-fg-2 font-mono text-[11px] break-all">{unit.targetFile}</div>
						</div>
					)}
				</div>
			) : (
				<div className="px-3 py-2 bg-green-500/10 border border-green-500/30 rounded text-xs text-green-400">
					Translation saved successfully
				</div>
			),
		};
	}

	if (toolName === 'flag_ready') {
		return {
			title: 'Flagged Ready',
			description: params.unitId || 'Unit marked as ready',
			details: (
				<div className="px-3 py-2 bg-blue-500/10 border border-blue-500/30 rounded text-xs">
					<div className="text-blue-400 font-medium">Unit is now ready for translation</div>
					<div className="text-void-fg-4 mt-1">The unit has been moved to the ready queue and can be picked up by the translation engine.</div>
				</div>
			),
		};
	}

	if (toolName === 'flag_blocked') {
		const reason = params.reason || 'No reason provided';
		return {
			title: 'Flagged Blocked',
			description: params.unitId || 'Unit blocked',
			details: (
				<div className="space-y-2 text-xs">
					<div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded">
						<div className="text-red-400 font-medium mb-1">Unit blocked</div>
						<div className="text-void-fg-3">{reason}</div>
					</div>
					<div className="px-3 py-2 bg-void-bg-2 border border-void-border rounded text-void-fg-4">
						This unit requires a decision before it can proceed. Use get_pending_decisions to review.
					</div>
				</div>
			),
		};
	}

	// \u2500\u2500 KB Decision Tools \u2500\u2500
	if (toolName === 'get_pending_decisions' && data.decisions) {
		const decisions = data.decisions;
		return {
			title: 'Pending Decisions',
			description: `${decisions.length} decision${decisions.length !== 1 ? 's' : ''} requiring attention`,
			details: decisions.length > 0 ? (
				<div className="space-y-2 text-xs">
					{decisions.slice(0, 5).map((d: any, i: number) => {
						const typeColors: Record<string, string> = {
							'type_mapping': 'bg-purple-500/20 text-purple-400 border-purple-500/30',
							'naming': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
							'rule_interpretation': 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
							'pattern_override': 'bg-orange-500/20 text-orange-400 border-orange-500/30',
						};
						const typeColor = typeColors[d.type] || 'bg-void-bg-3 text-void-fg-3 border-void-border';

						return (
							<div key={i} className="px-3 py-2 bg-void-bg-2 rounded border border-void-border hover:bg-void-bg-3 transition-colors">
								<div className="flex items-center gap-2 mb-1.5">
									<span className="text-void-fg-4 min-w-[1.5rem]">{i + 1}.</span>
									<span className={`px-2 py-0.5 rounded border text-[10px] uppercase tracking-wide ${typeColor}`}>
										{d.type.replace(/_/g, ' ')}
									</span>
								</div>
								<div className="text-void-fg-2 ml-6">{d.question || d.description || 'No description'}</div>
								{d.unitId && (
									<div className="text-void-fg-4 ml-6 mt-1 font-mono text-[10px]">Unit: {d.unitId}</div>
								)}
							</div>
						);
					})}
					{decisions.length > 5 && (
						<div className="text-center text-void-fg-4 py-1">
							... {decisions.length - 5} more decisions
						</div>
					)}
				</div>
			) : (
				<div className="px-3 py-2 bg-green-500/10 border border-green-500/30 rounded text-xs text-green-400">
					No pending decisions \u2014 all clear!
				</div>
			),
		};
	}

	if (toolName === 'answer_decision') {
		return {
			title: 'Decision Resolved',
			description: `Decision ${params.decisionId} has been answered`,
			details: (
				<div className="space-y-2 text-xs">
					<div className="px-3 py-2 bg-green-500/10 border border-green-500/30 rounded text-green-400">
						Decision successfully resolved
					</div>
					{params.answer && (
						<div className="px-3 py-2 bg-void-bg-2 border border-void-border rounded">
							<div className="text-void-fg-4 mb-1">Answer Provided</div>
							<div className="text-void-fg-2">{JSON.stringify(params.answer, null, 2)}</div>
						</div>
					)}
				</div>
			),
		};
	}

	// \u2500\u2500 Autonomy Tools \u2500\u2500
	if (toolName === 'autonomy_start_batch') {
		const batchId = data.batchId || data.id;
		const unitsQueued = data.unitsQueued || data.queueSize || 0;

		return {
			title: 'Autonomous Batch Started',
			description: batchId ? `Batch ${batchId}` : 'Translation batch initiated',
			details: (
				<div className="space-y-2 text-xs">
					<div className="px-3 py-2 bg-blue-500/10 border border-blue-500/30 rounded">
						<div className="text-blue-400 font-medium mb-1">Batch processing started</div>
						<div className="text-void-fg-3">The autonomous translation engine is now running.</div>
					</div>
					{unitsQueued > 0 && (
						<div className="px-3 py-2 bg-void-bg-2 border border-void-border rounded">
							<div className="flex items-center justify-between">
								<span className="text-void-fg-4">Units Queued</span>
								<span className="font-semibold text-void-fg-1 text-lg">{unitsQueued}</span>
							</div>
						</div>
					)}
				</div>
			),
		};
	}

	if (toolName === 'autonomy_run_single_unit') {
		const outcome = data.outcome || data.result?.outcome;
		const confidence = data.confidence || data.result?.confidence;

		const outcomeColors: Record<string, string> = {
			'success': 'bg-green-500/20 text-green-400 border-green-500/30',
			'partial': 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
			'failed': 'bg-red-500/20 text-red-400 border-red-500/30',
			'escalated': 'bg-orange-500/20 text-orange-400 border-orange-500/30',
		};

		const outcomeColor = outcomeColors[outcome] || 'bg-void-bg-3 text-void-fg-3 border-void-border';

		return {
			title: 'Single Unit Translation',
			description: params.unitId || 'Unit translation complete',
			details: (
				<div className="space-y-2 text-xs">
					<div className="flex items-center gap-2">
						<span className={`px-3 py-1.5 rounded border capitalize font-medium ${outcomeColor}`}>
							{outcome || 'completed'}
						</span>
						{confidence && (
							<div className="px-3 py-1.5 bg-void-bg-2 border border-void-border rounded">
								<span className="text-void-fg-4">Confidence: </span>
								<span className="text-void-fg-2 font-semibold">{confidence}</span>
							</div>
						)}
					</div>
					{data.details && (
						<div className="px-3 py-2 bg-void-bg-2 border border-void-border rounded text-void-fg-3">
							{data.details}
						</div>
					)}
				</div>
			),
		};
	}

	if (toolName === 'autonomy_get_escalations' && data.escalations) {
		const escalations = data.escalations;
		return {
			title: 'Escalations',
			description: `${escalations.length} issue${escalations.length !== 1 ? 's' : ''} requiring human review`,
			details: escalations.length > 0 ? (
				<div className="space-y-2 text-xs">
					{escalations.slice(0, 5).map((esc: any, i: number) => (
						<div key={i} className="px-3 py-2 bg-void-bg-2 rounded border border-void-border hover:bg-void-bg-3 transition-colors">
							<div className="flex items-center gap-2 mb-1">
								<span className="text-void-fg-4">{i + 1}.</span>
								<span className="px-2 py-0.5 bg-orange-500/20 text-orange-400 border border-orange-500/30 rounded text-[10px] uppercase">
									{esc.type || 'escalation'}
								</span>
							</div>
							<div className="text-void-fg-2 ml-6">{esc.reason || esc.message || 'No details provided'}</div>
							{esc.unitId && (
								<div className="text-void-fg-4 ml-6 mt-1 font-mono text-[10px]">Unit: {esc.unitId}</div>
							)}
						</div>
					))}
					{escalations.length > 5 && (
						<div className="text-center text-void-fg-4 py-1">
							... {escalations.length - 5} more escalations
						</div>
					)}
				</div>
			) : (
				<div className="px-3 py-2 bg-green-500/10 border border-green-500/30 rounded text-green-400">
					No escalations \u2014 autonomous processing running smoothly
				</div>
			),
		};
	}

	// \u2500\u2500 Discovery Tools \u2500\u2500
	if (toolName === 'discover_project') {
		const r = data.result || data;
		const filesScanned = r.filesScanned || r.totalFiles || 0;
		const projectPath = r.projectPath || params.projectPath;
		const languages = r.languages || r.detectedLanguages;

		return {
			title: 'Project Discovery',
			description: projectPath || 'Project scan complete',
			details: (
				<div className="space-y-3 text-xs">
					{/* Scan stats */}
					<div className="grid grid-cols-2 gap-2">
						<div className="px-3 py-2 bg-void-bg-2 rounded border border-void-border">
							<div className="text-void-fg-4 text-[10px] uppercase tracking-wide mb-1">Files Scanned</div>
							<div className="text-void-fg-1 font-semibold text-lg">{filesScanned.toLocaleString()}</div>
						</div>
						{r.totalLines && (
							<div className="px-3 py-2 bg-void-bg-2 rounded border border-void-border">
								<div className="text-void-fg-4 text-[10px] uppercase tracking-wide mb-1">Lines of Code</div>
								<div className="text-void-fg-1 font-semibold text-lg">{r.totalLines.toLocaleString()}</div>
							</div>
						)}
					</div>

					{/* Languages */}
					{languages && Object.keys(languages).length > 0 && (
						<div className="pt-2 border-t border-void-border">
							<div className="text-void-fg-4 mb-2">Languages Detected</div>
							<div className="flex flex-wrap gap-1.5">
								{Object.entries(languages).map(([lang, count]: [string, any]) => (
									<span key={lang} className="px-2 py-1 bg-void-bg-3 text-void-fg-2 rounded border border-void-border text-[11px]">
										{lang} <span className="text-void-fg-4">({count})</span>
									</span>
								))}
							</div>
						</div>
					)}

					{/* Path */}
					{projectPath && (
						<div className="pt-2 border-t border-void-border">
							<div className="text-void-fg-4 mb-1">Project Path</div>
							<div className="px-2 py-1.5 bg-void-bg-3 rounded border border-void-border text-void-fg-2 font-mono text-[10px] break-all">
								{projectPath}
							</div>
						</div>
					)}
				</div>
			),
		};
	}

	// Fallback with parsed data size
	if (typeof data === 'object') {
		const keys = Object.keys(data);
		return {
			title: toolName.replace(/_/g, ' '),
			description: `Returned ${keys.length} field${keys.length !== 1 ? 's' : ''}`,
		};
	}

	return defaultSummary;
}
