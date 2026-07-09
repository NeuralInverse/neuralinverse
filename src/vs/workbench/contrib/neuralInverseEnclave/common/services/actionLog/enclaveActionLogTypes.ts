/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *
 *  Licensed under the Business Source License 1.1 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at https://mariadb.com/bsl11
 *
 *  Change Date: 2029-07-14
 *  Change License: GNU Affero General Public License v3.0
 *
 *  Use of this software in production requires a commercial license from Neural Inverse Inc.
 *  Contact (code): github@neuralinverse.com | Contact (sales): sales@neuralinverse.com
 *--------------------------------------------------------------------------------------------*/

/**
 * Action categories that cover every IDE event surface.
 */
export type ActionCategory =
	| 'command'          // Any VS Code command execution
	| 'editor'           // Editor open, close, focus, selection changes
	| 'file'             // File create, delete, rename, save, move
	| 'terminal'         // Terminal create, input, output, dispose
	| 'debug'            // Debug session start, stop, breakpoint hit
	| 'scm'              // Git/SCM operations (commit, push, pull, branch)
	| 'search'           // Search & replace across files
	| 'extension'        // Extension install, uninstall, activate, deactivate
	| 'window'           // Window focus, blur, open, close, zoom
	| 'configuration'    // Settings changed
	| 'keyboard'         // Keybinding-triggered actions
	| 'ai'               // AI/LLM actions (chat, autocomplete, agent)
	| 'agent'            // NeuralInverse agent + sub-agent lifecycle
	| 'checks'           // GRC engine, violations, compliance scans
	| 'powermode'        // Power Mode sessions, tool calls, agent bus
	| 'enclave'          // Enclave-internal events (mode change, firewall, sandbox)
	| 'lifecycle';       // IDE startup, shutdown, reload

/**
 * Severity for filtering and prioritization.
 */
export type ActionSeverity = 'trace' | 'info' | 'warning' | 'error' | 'critical';

/**
 * Who/what caused the action.
 */
export type ActionSource = 'user' | 'agent' | 'system' | 'extension';

/**
 * A single logged action entry.
 */
export interface IActionLogEntry {
	/** Unique entry ID */
	id: string;
	/** Unix timestamp (ms) */
	timestamp: number;
	/** Category of the action */
	category: ActionCategory;
	/** A short stable identifier (e.g. 'editor.open', 'file.save', 'command.workbench.action.files.save') */
	action: string;
	/** Human-readable label */
	label: string;
	/** Who triggered this */
	source: ActionSource;
	/** Severity level */
	severity: ActionSeverity;
	/** The target resource (file path, command id, etc.) */
	target?: string;
	/** Structured metadata — varies per category */
	metadata?: Record<string, unknown>;
	/** Duration in ms (for actions that have measurable duration) */
	durationMs?: number;
	/** Session ID — stable across a single IDE window lifecycle */
	sessionId: string;
}

/**
 * Filter criteria for querying the log.
 */
export interface IActionLogFilter {
	categories?: ActionCategory[];
	sources?: ActionSource[];
	severities?: ActionSeverity[];
	since?: number;       // Unix timestamp
	until?: number;       // Unix timestamp
	search?: string;      // Free-text search in label/action/target
	limit?: number;       // Max entries to return
}

/**
 * Summary stats for the action log.
 */
export interface IActionLogStats {
	totalEntries: number;
	entriesByCategory: Partial<Record<ActionCategory, number>>;
	entriesBySource: Partial<Record<ActionSource, number>>;
	sessionStartedAt: number;
	oldestEntryTimestamp: number;
	newestEntryTimestamp: number;
}
