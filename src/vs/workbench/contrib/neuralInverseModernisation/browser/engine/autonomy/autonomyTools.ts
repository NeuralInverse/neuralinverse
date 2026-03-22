/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Autonomy Tools
 *
 * 10 tools that expose `IAutonomyService` to Power Mode agents and sub-agents via
 * tool-calling. All tools are safe to use from any agent context (Power Mode, Checks
 * Agent, Sub-Agents) — they go through the same DI-registered service.
 *
 * ## Tool list
 *
 *  1. autonomy_get_batch_status     — current state, run ID, live metrics snapshot
 *  2. autonomy_preview_schedule     — ordered unit list + aggregate counts (dry-run)
 *  3. autonomy_start_batch          — start the autonomy pipeline
 *  4. autonomy_pause_batch          — pause a running batch (resumable)
 *  5. autonomy_resume_batch         — resume a paused batch from where it left off
 *  6. autonomy_stop_batch           — abort a running batch (not resumable)
 *  7. autonomy_run_single_unit      — advance a single unit one pipeline step
 *  8. autonomy_get_escalations      — list units awaiting human review
 *  9. autonomy_resolve_escalation   — record a human decision on an escalated unit
 * 10. autonomy_get_run_history      — persisted history of completed batch runs
 *
 * ## Usage
 *
 * ```typescript
 * import { buildAutonomyTools } from '.../autonomy/autonomyTools.js';
 *
 * const tools = buildAutonomyTools(this._autonomyService);
 * // Register tools into the agent's tool registry.
 * ```
 */

import {
	IAutonomyService,
	IRunSingleUnitOptions,
	AutonomyBatchAlreadyRunningError,
	NoPausedBatchError,
	MissingEscalationReasonError,
} from './service.js';
import {
	type IAutonomyOptions,
	type AutonomyStage,
	type EscalationDecision,
	ALL_AUTONOMY_STAGES,
} from './impl/autonomyTypes.js';


// ─── Tool interface (mirrors IChecksTool for registry compatibility) ───────────

export interface IAutonomyToolParam {
	readonly name:        string;
	readonly type:        'string' | 'number' | 'boolean';
	readonly description: string;
	readonly required:    boolean;
}

export interface IAutonomyTool {
	readonly id:          string;
	readonly description: string;
	readonly parameters:  IAutonomyToolParam[];
	execute(args: Record<string, unknown>): Promise<string>;
}


// ─── Helper ────────────────────────────────────────────────────────────────────

function _tool(
	id:          string,
	description: string,
	parameters:  IAutonomyToolParam[],
	execute:     (args: Record<string, unknown>) => Promise<string>,
): IAutonomyTool {
	return { id, description, parameters, execute };
}

function _ok(data: unknown): string {
	return JSON.stringify({ ok: true, data }, null, 2);
}

function _err(message: string): string {
	return JSON.stringify({ ok: false, error: message }, null, 2);
}

function _str(args: Record<string, unknown>, key: string): string | undefined {
	const v = args[key];
	return typeof v === 'string' ? v : undefined;
}

function _num(args: Record<string, unknown>, key: string): number | undefined {
	const v = args[key];
	return typeof v === 'number' ? v : undefined;
}

function _bool(args: Record<string, unknown>, key: string): boolean | undefined {
	const v = args[key];
	return typeof v === 'boolean' ? v : undefined;
}

/** Parse a comma-separated stage string into an AutonomyStage[] with validation. */
function _parseStages(raw: string | undefined): AutonomyStage[] | undefined {
	if (!raw) { return undefined; }
	const parts = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
	const valid: AutonomyStage[] = [];
	for (const p of parts) {
		if (ALL_AUTONOMY_STAGES.includes(p as AutonomyStage)) {
			valid.push(p as AutonomyStage);
		}
	}
	return valid.length > 0 ? valid : undefined;
}


// ─── Tool builder ──────────────────────────────────────────────────────────────

/**
 * Build and return all 10 autonomy tools bound to the given service instance.
 *
 * @param autonomy  The live `IAutonomyService` instance (DI-injected by caller)
 */
export function buildAutonomyTools(autonomy: IAutonomyService): IAutonomyTool[] {
	return [

		// ── 1. autonomy_get_batch_status ─────────────────────────────────────
		_tool(
			'autonomy_get_batch_status',
			'Get the current state of the autonomy batch: lifecycle state, active run ID, live metrics snapshot, and counts of escalated units. Call this before starting a batch to understand what is queued.',
			[],
			async () => {
				const metrics = autonomy.lastBatchMetrics;
				return _ok({
					batchState:      autonomy.batchState,
					isRunning:       autonomy.isRunning,
					isPaused:        autonomy.isPaused,
					currentRunId:    autonomy.currentRunId,
					escalatedCount:  autonomy.escalatedUnits.length,
					lastMetrics:     metrics ? {
						runId:            metrics.runId,
						totalProcessed:   metrics.totalProcessed,
						advanced:         metrics.advanced,
						escalated:        metrics.escalated,
						errors:           metrics.errors,
						skipped:          metrics.skipped,
						durationMs:       metrics.durationMs,
						unitsPerMinute:   metrics.unitsPerMinute,
						wasAborted:       metrics.wasAborted,
					} : null,
				});
			},
		),


		// ── 2. autonomy_preview_schedule ─────────────────────────────────────
		_tool(
			'autonomy_preview_schedule',
			'Preview the autonomy schedule without running any pipeline stages. Returns the ordered list of eligible units with their depth groups, risk levels, and aggregate counts per stage. Use this to understand scope before starting a batch.',
			[
				{ name: 'stages',          type: 'string',  description: 'Comma-separated pipeline stages to include: resolve, translate, validate, commit. Defaults to all stages.', required: false },
				{ name: 'maxConcurrency',  type: 'number',  description: 'Concurrency limit to apply when building the schedule preview (1-10). Default: 3.', required: false },
				{ name: 'autoApprove',     type: 'boolean', description: 'Whether auto-approve is enabled in the preview (affects escalation counts). Default: false.', required: false },
			],
			async (args) => {
				const options: IAutonomyOptions = {};
				const stages = _parseStages(_str(args, 'stages'));
				if (stages) { options.stages = stages; }
				const concurrency = _num(args, 'maxConcurrency');
				if (concurrency !== undefined) { options.maxConcurrency = Math.max(1, Math.min(10, concurrency)); }
				const autoApprove = _bool(args, 'autoApprove');
				if (autoApprove !== undefined) { options.autoApprove = autoApprove; }

				const preview = autonomy.previewSchedule(options);
				return _ok({
					totalUnits:  preview.totalUnits,
					byStage:     preview.byStage,
					depthGroups: preview.depthGroups.slice(0, 20).map(g => ({
						depth:     g.depth,
						unitCount: g.units.length,
						units:     g.units.slice(0, 5).map(u => ({
							unitId:    u.unitId,
							name:      u.unitName,
							status:    u.status,
							riskLevel: u.riskLevel,
						})),
						hasMore: g.units.length > 5,
					})),
					hasMoreGroups: preview.depthGroups.length > 20,
				});
			},
		),


		// ── 3. autonomy_start_batch ───────────────────────────────────────────
		_tool(
			'autonomy_start_batch',
			'Start the autonomy pipeline batch. Drives all eligible units through the requested stages: resolve → translate → [auto-approve policy] → validate → commit. High-risk and regulated-domain units always escalate for human review regardless of autoApprove. Returns final batch metrics when complete.',
			[
				{ name: 'stages',           type: 'string',  description: 'Comma-separated stages to run: resolve, translate, validate, commit. Default: all stages.', required: false },
				{ name: 'maxConcurrency',   type: 'number',  description: 'Number of units to process in parallel (1-10). Default: 3.', required: false },
				{ name: 'autoApprove',      type: 'boolean', description: 'If true, low/medium risk units in non-regulated domains are auto-approved without human review. Default: false.', required: false },
				{ name: 'stageTimeoutMs',   type: 'number',  description: 'Per-stage timeout in milliseconds before a unit is marked as timed out. Default: 120000 (2 min).', required: false },
				{ name: 'maxRetriesPerUnit', type: 'number',  description: 'Maximum retry attempts per unit before escalating. Default: 3.', required: false },
			],
			async (args) => {
				const options: IAutonomyOptions = {};
				const stages = _parseStages(_str(args, 'stages'));
				if (stages) { options.stages = stages; }
				const concurrency = _num(args, 'maxConcurrency');
				if (concurrency !== undefined) { options.maxConcurrency = Math.max(1, Math.min(10, concurrency)); }
				const autoApprove = _bool(args, 'autoApprove');
				if (autoApprove !== undefined) { options.autoApprove = autoApprove; }
				const timeout = _num(args, 'stageTimeoutMs');
				if (timeout !== undefined) { options.stageTimeoutMs = Math.max(5000, timeout); }
				const retries = _num(args, 'maxRetriesPerUnit');
				if (retries !== undefined) { options.maxRetriesPerUnit = Math.max(0, Math.min(5, retries)); }

				try {
					const metrics = await autonomy.startBatch(options);
					return _ok({
						runId:            metrics.runId,
						totalProcessed:   metrics.totalProcessed,
						advanced:         metrics.advanced,
						escalated:        metrics.escalated,
						errors:           metrics.errors,
						skipped:          metrics.skipped,
						durationMs:       metrics.durationMs,
						unitsPerMinute:   metrics.unitsPerMinute,
						wasAborted:       metrics.wasAborted,
						byStage:          metrics.byStage,
					});
				} catch (e) {
					if (e instanceof AutonomyBatchAlreadyRunningError) {
						return _err(`Batch already running (runId: ${autonomy.currentRunId}). Call autonomy_pause_batch or autonomy_stop_batch first.`);
					}
					return _err(e instanceof Error ? e.message : String(e));
				}
			},
		),


		// ── 4. autonomy_pause_batch ───────────────────────────────────────────
		_tool(
			'autonomy_pause_batch',
			'Pause a running autonomy batch. In-flight unit jobs drain to completion before the pause takes effect. The batch can be resumed from where it left off with autonomy_resume_batch. Units remain at their current pipeline status.',
			[],
			async () => {
				if (!autonomy.isRunning) {
					return _err(`No batch is running. Current state: ${autonomy.batchState}.`);
				}
				autonomy.pauseBatch();
				return _ok({ message: 'Pause signal sent. Batch is draining in-flight jobs.', batchState: autonomy.batchState });
			},
		),


		// ── 5. autonomy_resume_batch ──────────────────────────────────────────
		_tool(
			'autonomy_resume_batch',
			'Resume a previously paused autonomy batch. Restarts the scheduler, excluding units already processed in the prior run. Uses the same options as the original startBatch call.',
			[],
			async () => {
				if (!autonomy.isPaused) {
					return _err(`No paused batch to resume. Current state: ${autonomy.batchState}.`);
				}
				try {
					const metrics = await autonomy.resumeBatch();
					return _ok({
						runId:            metrics.runId,
						totalProcessed:   metrics.totalProcessed,
						advanced:         metrics.advanced,
						escalated:        metrics.escalated,
						errors:           metrics.errors,
						skipped:          metrics.skipped,
						durationMs:       metrics.durationMs,
						unitsPerMinute:   metrics.unitsPerMinute,
						wasAborted:       metrics.wasAborted,
					});
				} catch (e) {
					if (e instanceof AutonomyBatchAlreadyRunningError) {
						return _err(`Batch already running (runId: ${autonomy.currentRunId}).`);
					}
					if (e instanceof NoPausedBatchError) {
						return _err('No paused batch available. The batch may have been stopped or never started.');
					}
					return _err(e instanceof Error ? e.message : String(e));
				}
			},
		),


		// ── 6. autonomy_stop_batch ────────────────────────────────────────────
		_tool(
			'autonomy_stop_batch',
			'Stop (abort) the running or pausing autonomy batch. In-flight jobs drain gracefully. Unlike pause, this does NOT persist processed unit IDs — the batch cannot be resumed. Use autonomy_pause_batch if you want to resume later.',
			[],
			async () => {
				if (!autonomy.isRunning && autonomy.batchState !== 'pausing' && autonomy.batchState !== 'stopping') {
					return _err(`No active batch to stop. Current state: ${autonomy.batchState}.`);
				}
				autonomy.stopBatch();
				return _ok({ message: 'Stop signal sent. Batch is draining in-flight jobs.', batchState: autonomy.batchState });
			},
		),


		// ── 7. autonomy_run_single_unit ───────────────────────────────────────
		_tool(
			'autonomy_run_single_unit',
			'Execute the next pipeline step for a single unit immediately, bypassing the scheduler. Useful for targeted retry, human-driven progression, or testing a specific unit. Safe to call while a batch is running.',
			[
				{ name: 'unitId',      type: 'string',  description: 'The KB unit ID to advance (required).', required: true },
				{ name: 'forceStage',  type: 'string',  description: 'Force a specific stage regardless of unit status: resolve, translate, validate, or commit.', required: false },
				{ name: 'autoApprove', type: 'boolean', description: 'Override auto-approve for this unit only.', required: false },
				{ name: 'timeoutMs',   type: 'number',  description: 'Override stage timeout for this unit only (ms). Default: 120000.', required: false },
			],
			async (args) => {
				const unitId = _str(args, 'unitId');
				if (!unitId) {
					return _err('unitId is required.');
				}

				const opts: IRunSingleUnitOptions = {};
				const forceStage = _str(args, 'forceStage');
				if (forceStage && ALL_AUTONOMY_STAGES.includes(forceStage as AutonomyStage)) {
					opts.forceStage = forceStage as AutonomyStage;
				}
				const autoApprove = _bool(args, 'autoApprove');
				if (autoApprove !== undefined) { opts.autoApprove = autoApprove; }
				const timeout = _num(args, 'timeoutMs');
				if (timeout !== undefined) { opts.timeoutMs = Math.max(5000, timeout); }

				try {
					const result = await autonomy.runSingleUnit(unitId, opts);
					return _ok({
						unitId:         result.unitId,
						unitName:       result.unitName,
						outcome:        result.outcome,
						stageCompleted: result.stageCompleted,
						durationMs:     result.durationMs,
						attemptIndex:   result.attemptIndex,
						errorMsg:       result.errorMsg ?? null,
						errorCategory:  result.errorCategory ?? null,
					});
				} catch (e) {
					return _err(e instanceof Error ? e.message : String(e));
				}
			},
		),


		// ── 8. autonomy_get_escalations ───────────────────────────────────────
		_tool(
			'autonomy_get_escalations',
			'List all units currently awaiting human review. Each escalation includes the unit name, risk level, domain, stage at which it was escalated, the escalation reason, and how long ago it was escalated.',
			[
				{ name: 'limit', type: 'number', description: 'Maximum number of escalations to return (default 20, max 100).', required: false },
			],
			async (args) => {
				const limit = Math.min(100, Math.max(1, _num(args, 'limit') ?? 20));
				const all   = autonomy.escalatedUnits;
				const items = all.slice(0, limit);
				const now   = Date.now();

				return _ok({
					total: all.length,
					items: items.map(e => ({
						unitId:      e.unitId,
						unitName:    e.unitName,
						riskLevel:   e.riskLevel,
						domain:      e.domain,
						stage:       e.stage,
						reason:      e.reason,
						ageSec:      Math.round((now - e.escalatedAt) / 1000),
					})),
					hasMore: all.length > limit,
				});
			},
		),


		// ── 9. autonomy_resolve_escalation ────────────────────────────────────
		_tool(
			'autonomy_resolve_escalation',
			'Record a human decision for an escalated unit and apply it to the knowledge base. Decisions: "approve" sets status to approved (requires reason), "skip" sets to skipped, "revert-to-pending" sends back for a fresh attempt, "block" marks as permanently blocked (requires reason). The unit is removed from the escalations list after resolution.',
			[
				{ name: 'unitId',     type: 'string', description: 'The KB unit ID to resolve (required).', required: true },
				{ name: 'decision',   type: 'string', description: 'The resolution decision: approve, skip, revert-to-pending, or block (required).', required: true },
				{ name: 'resolvedBy', type: 'string', description: 'Identity of the person resolving (e.g. email or username, required).', required: true },
				{ name: 'reason',     type: 'string', description: 'Documented rationale. Required for "approve" and "block" decisions.', required: false },
			],
			async (args) => {
				const unitId     = _str(args, 'unitId');
				const decision   = _str(args, 'decision') as EscalationDecision | undefined;
				const resolvedBy = _str(args, 'resolvedBy');
				const reason     = _str(args, 'reason');

				if (!unitId)     { return _err('unitId is required.'); }
				if (!decision)   { return _err('decision is required (approve | skip | revert-to-pending | block).'); }
				if (!resolvedBy) { return _err('resolvedBy is required.'); }

				const validDecisions: EscalationDecision[] = ['approve', 'skip', 'revert-to-pending', 'block'];
				if (!validDecisions.includes(decision)) {
					return _err(`Invalid decision "${decision}". Must be one of: ${validDecisions.join(', ')}.`);
				}

				const isEscalated = autonomy.escalatedUnits.some(e => e.unitId === unitId);
				if (!isEscalated) {
					return _err(`Unit "${unitId}" is not in the escalation queue. It may have already been resolved or does not exist.`);
				}

				try {
					await autonomy.resolveEscalation(unitId, decision, resolvedBy, reason);
					return _ok({
						unitId,
						decision,
						resolvedBy,
						reason:              reason ?? null,
						remainingEscalations: autonomy.escalatedUnits.length,
					});
				} catch (e) {
					if (e instanceof MissingEscalationReasonError) {
						return _err(`A reason is required for the "${decision}" decision. Provide one via the reason parameter.`);
					}
					return _err(e instanceof Error ? e.message : String(e));
				}
			},
		),


		// ── 10. autonomy_get_run_history ──────────────────────────────────────
		_tool(
			'autonomy_get_run_history',
			'Return the history of completed autonomy batch runs, most recent first. Each entry includes run ID, start time, state, final metrics, stage breakdown, and count of escalated units. Persisted across IDE restarts.',
			[
				{ name: 'limit', type: 'number', description: 'Maximum number of history entries to return (default 10, max 20).', required: false },
			],
			async (args) => {
				const limit   = Math.min(20, Math.max(1, _num(args, 'limit') ?? 10));
				const history = autonomy.getRunHistory().slice(0, limit);
				const now     = Date.now();

				return _ok({
					total: autonomy.getRunHistory().length,
					runs: history.map(r => ({
						runId:            r.runId,
						state:            r.state,
						startedAt:        new Date(r.startedAt).toISOString(),
						ageSec:           Math.round((now - r.startedAt) / 1000),
						totalProcessed:   r.metrics.totalProcessed,
						advanced:         r.metrics.advanced,
						escalated:        r.metrics.escalated,
						errors:           r.metrics.errors,
						skipped:          r.metrics.skipped,
						durationMs:       r.metrics.durationMs,
						unitsPerMinute:   r.metrics.unitsPerMinute,
						wasAborted:       r.metrics.wasAborted,
						byStage:          r.metrics.byStage,
						escalations:      r.escalations.length,
					})),
				});
			},
		),

	];
}
