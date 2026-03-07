/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # External Job Types
 *
 * Type definitions for the External Analysis Bridge job lifecycle.
 * Used by IExternalToolService, the UI jobs panel, and the GRC engine.
 *
 * See: docs/EXTERNAL_ANALYSIS_BRIDGE.md
 */

import { URI } from '../../../../../../base/common/uri.js';


// ─── Job Status ───────────────────────────────────────────────────────────────

export type ExternalJobStatus =
	| 'queued'      // waiting in queue
	| 'running'     // command executing
	| 'complete'    // finished, results injected into engine
	| 'failed'      // command error or parse error
	| 'cancelled'   // cancelled by user or cancelAll()
	| 'skipped';    // tool not found, cache hit, or no workspace


export type ExternalJobSkipReason =
	| 'tool-not-found'   // toolBinary specified but not in PATH
	| 'cache-hit'        // content hash unchanged since last run
	| 'no-workspace'     // no workspace folder open
	| 'license-error';   // tool found but reported a license failure


// ─── Job Record ───────────────────────────────────────────────────────────────

/**
 * Represents a single external tool invocation.
 *
 * Jobs are tracked in memory by IExternalToolService and
 * surfaced in the UI External Tools panel via onDidJobUpdate.
 */
export interface IExternalJob {
	/** Unique ID — format: `${ruleId}:${scope}:${targetUri ?? 'workspace'}` */
	id: string;

	/** Rule that triggered this job */
	ruleId: string;

	/**
	 * Human-readable tool name.
	 * Derived from check.toolBinary, or parsed from the first token of check.command.
	 */
	toolName: string;

	/** Whether this job targets a single file or the whole workspace */
	scope: 'file' | 'workspace';

	/** Set only for file-scope jobs */
	targetUri?: URI;

	status: ExternalJobStatus;

	queuedAt: number;
	startedAt?: number;
	completedAt?: number;

	/** Computed from startedAt and completedAt */
	durationMs?: number;

	/** Error message for failed jobs */
	error?: string;

	/** Number of violations produced (0 for skipped/failed) */
	resultCount: number;

	/** True when results were served from cache without running the tool */
	cacheHit: boolean;

	/** Reason for skipping (only set when status === 'skipped') */
	skipReason?: ExternalJobSkipReason;

	/** Tool version string (if toolVersionCommand was specified and succeeded) */
	toolVersion?: string;
}


// ─── Job Event ───────────────────────────────────────────────────────────────

/** Fired by IExternalToolService.onDidJobUpdate on every state change */
export interface IExternalJobEvent {
	job: IExternalJob;
}
