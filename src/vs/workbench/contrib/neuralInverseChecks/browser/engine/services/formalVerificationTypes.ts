/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Formal Verification Types
 *
 * Shared types for the formal verification layer — proof obligation tracking,
 * FV tool session management, and per-sector presets.
 *
 * Supported tools:
 *   CBMC · Frama-C · SPARK Ada (GNATprove) · Dafny · TLA+ · Alloy
 *   Z3 / SMT-LIB · Spin / Promela · Coq · Isabelle · Why3 · Custom
 */

// ─── Tool kinds ───────────────────────────────────────────────────────────────

export type FVToolKind =
	| 'cbmc'          // CBMC — C Bounded Model Checker (memory safety, overflow, assert)
	| 'frama-c'       // Frama-C — C static analysis (WP, EVA, Value, AstraVer)
	| 'spark-ada'     // GNATprove — SPARK Ada formal proof (contracts, ASIL)
	| 'dafny'         // Microsoft Dafny — contract-based verification (.dfy)
	| 'tlaplus'       // TLA+ Toolbox / TLAPS — distributed systems, protocols
	| 'alloy'         // Alloy Analyzer — relational model checking
	| 'z3'            // Z3 SMT solver — direct SMT-LIB queries
	| 'spin'          // Spin / Promela — concurrent protocol model checker
	| 'coq'           // Coq proof assistant — interactive theorem proving
	| 'isabelle'      // Isabelle/HOL — interactive theorem proving
	| 'why3'          // Why3 — deductive program verification
	| 'polyspace-cp'  // Polyspace Code Prover — formal proof, ISO 26262 ASIL-D
	| 'custom';       // Any CLI formal verification tool


// ─── Session status ───────────────────────────────────────────────────────────

export type FVSessionStatus =
	| 'idle'
	| 'running'
	| 'complete'
	| 'failed'
	| 'cancelled';


// ─── Property kind ────────────────────────────────────────────────────────────

export type FVPropertyKind =
	| 'safety'          // system never reaches a bad state
	| 'liveness'        // system eventually reaches a good state
	| 'reachability'    // a state is / is not reachable
	| 'invariant'       // invariant holds throughout execution
	| 'assertion'       // explicit assert() in source
	| 'precondition'    // function contract precondition
	| 'postcondition'   // function contract postcondition
	| 'frame'           // memory frame condition (what doesn't change)
	| 'termination'     // program / function terminates
	| 'overflow'        // arithmetic does not overflow
	| 'memory-safety'   // no null-deref, buffer-overflow, use-after-free
	| 'data-race'       // no concurrent data races
	| 'deadlock-free'   // no deadlock in concurrent model
	| 'refinement'      // implementation refines specification
	| 'custom';


// ─── Verification status ──────────────────────────────────────────────────────

export type FVVerificationStatus =
	| 'proved'      // fully discharged — no counterexample possible
	| 'failed'      // counterexample found / property violated
	| 'unknown'     // solver timed out or gave up
	| 'timeout'     // explicit timeout
	| 'error';      // tool error (parsing / compilation)


// ─── Proof obligation ─────────────────────────────────────────────────────────

export interface IFVProofObligation {
	/** Unique ID within session, e.g. "cbmc-PO-42" */
	id: string;
	/** Human-readable property description */
	property: string;
	kind: FVPropertyKind;
	status: FVVerificationStatus;
	tool: FVToolKind;
	/** Source file if known */
	file?: string;
	/** Source line if known */
	line?: number;
	/** Tool-specific message (error description or proof summary) */
	message: string;
	/** Counter-example trace if available */
	counterExample?: string;
	/** Raw log line that produced this obligation */
	rawLine: string;
	timestamp: number;
}


// ─── Tool configuration ───────────────────────────────────────────────────────

export interface IFVToolConfig {
	/** Unique session ID */
	id: string;
	/** Human-readable session name */
	name: string;
	kind: FVToolKind;
	/** Shell command to build before verification — supports ${workspace} */
	buildCommand?: string;
	/** Full verification command — supports ${workspace}, ${file} */
	verifyCommand: string;
	/** Max runtime in ms before force-kill */
	timeoutMs: number;
	/** Extra env vars */
	env?: Record<string, string>;
	/** Whether to persist config to .inverse/fv/{id}.json */
	persist?: boolean;
}


// ─── Session record ───────────────────────────────────────────────────────────

export interface IFVSession {
	config: IFVToolConfig;
	status: FVSessionStatus;
	startedAt?: number;
	completedAt?: number;
	/** Raw output lines captured from tool stdout/stderr */
	outputLines: string[];
	/** Proof obligations parsed from output */
	proofObligations: IFVProofObligation[];
	/** How many GRC results were injected into the engine for this run */
	injectedCount?: number;
	/** Error message if status === 'failed' */
	error?: string;
}


// ─── Preset ───────────────────────────────────────────────────────────────────

export interface IFVPreset {
	id: string;
	name: string;
	sector: string;
	targetLanguage: string;
	kind: FVToolKind;
	description: string;
	tags: string[];
	verifyCommand: string;
	buildCommand?: string;
	timeoutMs: number;
	env?: Record<string, string>;
}


// ─── Invariant preset template ────────────────────────────────────────────────

export interface IInvariantPresetTemplate {
	id: string;
	name: string;
	category: string;
	description: string;
	scope: string;
	expression?: string;
	variables?: string[];
	targetCalls?: string[];
	trackedClass?: string;
	acquirePattern?: string;
	releasePattern?: string;
	stateVariable?: string;
	validTransitions?: Array<{ from: string; to: string }>;
	precedesCall?: string;
	severity: string;
	backend?: 'auto' | 'pattern' | 'ast' | 'ai';
	tags: string[];
}

/** Built-in invariant template library — surfaced in the preset picker */
export const INVARIANT_PRESET_TEMPLATES: IInvariantPresetTemplate[] = [
	// ── Value invariants ─────────────────────────────────────────────────────
	{
		id: 'tmpl-value-nonneg-counter',
		name: 'Non-negative counter',
		category: 'Value',
		description: 'Counter or index must never go below zero',
		scope: 'value', expression: 'count >= 0', variables: ['count'], severity: 'error',
		tags: ['counter', 'bounds'],
	},
	{
		id: 'tmpl-value-null-guard',
		name: 'Null pointer guard',
		category: 'Value',
		description: 'Pointer / reference must never be null',
		scope: 'value', expression: 'ptr != null', variables: ['ptr'], severity: 'error',
		tags: ['null', 'pointer', 'memory-safety'],
	},
	{
		id: 'tmpl-value-balance',
		name: 'Balance never negative',
		category: 'Value',
		description: 'Account / resource balance must remain non-negative',
		scope: 'value', expression: 'balance >= 0', variables: ['balance'], severity: 'error',
		tags: ['finance', 'invariant'],
	},
	{
		id: 'tmpl-value-index-bounds',
		name: 'Array index in bounds',
		category: 'Value',
		description: 'Array index must be ≥ 0 and ≤ max size',
		scope: 'value', expression: 'index >= 0', variables: ['index'], severity: 'error',
		tags: ['bounds', 'array', 'memory-safety'],
	},
	{
		id: 'tmpl-value-retry-limit',
		name: 'Retry count bounded',
		category: 'Value',
		description: 'Retry / attempt counter must not exceed limit',
		scope: 'value', expression: 'retries <= 10', variables: ['retries'], severity: 'warning',
		tags: ['reliability', 'retry'],
	},
	{
		id: 'tmpl-value-fd-valid',
		name: 'File descriptor valid',
		category: 'Value',
		description: 'File descriptor must be ≥ 0 (non-negative means open)',
		scope: 'value', expression: 'fd >= 0', variables: ['fd'], severity: 'error',
		tags: ['resource', 'file'],
	},
	// ── Precondition invariants ───────────────────────────────────────────────
	{
		id: 'tmpl-pre-auth-before-access',
		name: 'Authenticate before access',
		category: 'Precondition',
		description: 'isAuthenticated must be true before any resource access call',
		scope: 'precondition', expression: 'isAuthenticated != null',
		targetCalls: ['accessResource', 'readData', 'writeData'], severity: 'error',
		tags: ['auth', 'security', 'access-control'],
	},
	{
		id: 'tmpl-pre-init-before-use',
		name: 'Initialise before use',
		category: 'Precondition',
		description: 'isInitialized must be true before calling start or connect',
		scope: 'precondition', expression: 'isInitialized != null',
		targetCalls: ['start', 'connect', 'begin'], severity: 'error',
		tags: ['lifecycle', 'init'],
	},
	{
		id: 'tmpl-pre-validate-before-write',
		name: 'Validate before write',
		category: 'Precondition',
		description: 'Input must be validated before writing to storage',
		scope: 'precondition', expression: 'isValid != null',
		targetCalls: ['write', 'writeFile', 'save', 'persist'], severity: 'warning',
		tags: ['input-validation', 'security'],
	},
	// ── Postcondition invariants ──────────────────────────────────────────────
	{
		id: 'tmpl-post-alloc-null-check',
		name: 'Check alloc result',
		category: 'Postcondition',
		description: 'malloc/calloc result must be checked for null',
		scope: 'postcondition', expression: 'ptr != null',
		targetCalls: ['malloc', 'calloc', 'realloc'], severity: 'error',
		tags: ['memory', 'null', 'C', 'C++'],
	},
	{
		id: 'tmpl-post-open-result',
		name: 'Check file open result',
		category: 'Postcondition',
		description: 'fopen result must be checked before use',
		scope: 'postcondition', expression: 'fp != null',
		targetCalls: ['fopen', 'open'], severity: 'error',
		tags: ['file', 'null', 'C'],
	},
	// ── Resource pair invariants ──────────────────────────────────────────────
	{
		id: 'tmpl-res-malloc-free',
		name: 'malloc / free pair',
		category: 'Resource Pair',
		description: 'Every malloc must have a matching free in the same scope',
		scope: 'resource-pair',
		acquirePattern: '\\b(?:malloc|calloc|realloc)\\s*\\(',
		releasePattern: '\\bfree\\s*\\(',
		severity: 'error',
		tags: ['memory', 'C', 'C++', 'MISRA'],
	},
	{
		id: 'tmpl-res-fopen-fclose',
		name: 'fopen / fclose pair',
		category: 'Resource Pair',
		description: 'Every fopen must have a matching fclose',
		scope: 'resource-pair',
		acquirePattern: '\\bfopen\\s*\\(',
		releasePattern: '\\bfclose\\s*\\(',
		severity: 'error',
		tags: ['file', 'resource', 'C'],
	},
	{
		id: 'tmpl-res-mutex-lock-unlock',
		name: 'Mutex lock / unlock pair',
		category: 'Resource Pair',
		description: 'Every mutex_lock must have a matching mutex_unlock in the same scope',
		scope: 'resource-pair',
		acquirePattern: '\\b(?:mutex_lock|pthread_mutex_lock|osMutexAcquire|xSemaphoreTake)\\s*\\(',
		releasePattern: '\\b(?:mutex_unlock|pthread_mutex_unlock|osMutexRelease|xSemaphoreGive)\\s*\\(',
		severity: 'error',
		tags: ['concurrency', 'RTOS', 'POSIX'],
	},
	{
		id: 'tmpl-res-sem-wait-post',
		name: 'Semaphore wait / post pair',
		category: 'Resource Pair',
		description: 'Every sem_wait must have a matching sem_post in the same scope',
		scope: 'resource-pair',
		acquirePattern: '\\b(?:sem_wait|sem_trywait)\\s*\\(',
		releasePattern: '\\b(?:sem_post)\\s*\\(',
		severity: 'error',
		tags: ['semaphore', 'concurrency', 'POSIX'],
	},
	{
		id: 'tmpl-res-new-delete',
		name: 'new / delete pair',
		category: 'Resource Pair',
		description: 'Every new must have a matching delete (C++ memory management)',
		scope: 'resource-pair',
		acquirePattern: '\\bnew\\b',
		releasePattern: '\\bdelete\\b',
		severity: 'error',
		tags: ['memory', 'C++'],
	},
	// ── State machine invariants ──────────────────────────────────────────────
	{
		id: 'tmpl-sm-tcp',
		name: 'TCP connection state machine',
		category: 'State Machine',
		description: 'TCP state transitions: only CLOSED\u2192SYN_SENT\u2192ESTABLISHED\u2192FIN_WAIT_1\u2192CLOSED',
		scope: 'state-machine', stateVariable: 'state',
		validTransitions: [
			{ from: 'CLOSED', to: 'SYN_SENT' }, { from: 'SYN_SENT', to: 'ESTABLISHED' },
			{ from: 'ESTABLISHED', to: 'FIN_WAIT_1' }, { from: 'FIN_WAIT_1', to: 'TIME_WAIT' },
			{ from: 'TIME_WAIT', to: 'CLOSED' },
		],
		severity: 'error', tags: ['state-machine', 'network', 'protocol'],
	},
	{
		id: 'tmpl-sm-order',
		name: 'Order lifecycle state machine',
		category: 'State Machine',
		description: 'Order states: PENDING \u2192 CONFIRMED \u2192 SHIPPED \u2192 DELIVERED or CANCELLED',
		scope: 'state-machine', stateVariable: 'orderState',
		validTransitions: [
			{ from: 'PENDING', to: 'CONFIRMED' }, { from: 'CONFIRMED', to: 'SHIPPED' },
			{ from: 'SHIPPED', to: 'DELIVERED' }, { from: 'PENDING', to: 'CANCELLED' },
			{ from: 'CONFIRMED', to: 'CANCELLED' },
		],
		severity: 'warning', tags: ['state-machine', 'business-logic'],
	},
	{
		id: 'tmpl-sm-rtos-task',
		name: 'RTOS task state machine',
		category: 'State Machine',
		description: 'FreeRTOS / Zephyr task states: READY \u2192 RUNNING \u2192 BLOCKED/SUSPENDED \u2192 DELETED',
		scope: 'state-machine', stateVariable: 'taskState',
		validTransitions: [
			{ from: 'READY', to: 'RUNNING' }, { from: 'RUNNING', to: 'BLOCKED' },
			{ from: 'RUNNING', to: 'SUSPENDED' }, { from: 'BLOCKED', to: 'READY' },
			{ from: 'SUSPENDED', to: 'READY' }, { from: 'RUNNING', to: 'DELETED' },
		],
		severity: 'error', tags: ['state-machine', 'RTOS', 'embedded'],
	},
	// ── Temporal invariants ───────────────────────────────────────────────────
	{
		id: 'tmpl-temporal-auth-resource',
		name: 'Authenticate before resource',
		category: 'Temporal',
		description: 'authenticate() must be called before accessResource()',
		scope: 'temporal', precedesCall: 'authenticate', targetCalls: ['accessResource'],
		severity: 'error', tags: ['auth', 'security', 'temporal'],
	},
	{
		id: 'tmpl-temporal-init-start',
		name: 'Init before start',
		category: 'Temporal',
		description: 'initialize() must precede start() / run()',
		scope: 'temporal', precedesCall: 'initialize', targetCalls: ['start', 'run'],
		severity: 'error', tags: ['lifecycle', 'temporal'],
	},
	// ── Class invariants ──────────────────────────────────────────────────────
	{
		id: 'tmpl-class-account-balance',
		name: 'Account balance invariant',
		category: 'Class Invariant',
		description: 'AccountService: balance must be >= 0 after every public method',
		scope: 'class-invariant', expression: 'this.balance >= 0',
		trackedClass: 'AccountService', severity: 'error',
		tags: ['finance', 'class-invariant'],
	},
	{
		id: 'tmpl-class-stack-bounds',
		name: 'Stack size bounds',
		category: 'Class Invariant',
		description: 'Stack: size must be between 0 and capacity',
		scope: 'class-invariant', expression: 'this.size >= 0',
		trackedClass: 'Stack', severity: 'error',
		tags: ['data-structure', 'class-invariant'],
	},
];
