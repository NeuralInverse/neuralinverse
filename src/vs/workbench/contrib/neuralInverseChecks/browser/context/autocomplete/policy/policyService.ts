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
 * # Policy Service
 *
 * Central policy gateway for the NeuralInverse Checks contribution.
 *
 * ## Responsibilities
 *
 * 1. **FIM Firewall** — Exposes the enterprise-configured inline-completion
 *    (FIM) policy so that `INeuralInverseFIMService` can enforce:
 *      - Whether FIM completions are permitted at all (`isFIMEnabled`)
 *      - Tokens that must never appear in output (`forbiddenTokens`)
 *      - Stop tokens injected into every completion request (`stopTokens`)
 *      - Model-level caps: `maxTokens` and `temperature`
 *      - Whether developers may override these settings (`lockFIMSettings`)
 *
 * 2. **Checks Agent Policy** — Surfaces the enterprise-configured GRC
 *    enforcement rules so that the Checks Agent and commit-gate can enforce:
 *      - Whether the Checks Agent is enabled at all (`isChecksAgentEnabled`)
 *      - Whether auto-scan on save is active (`autoScanOnSave`)
 *      - Whether violations block git commits (`blockCommitsOnViolations`)
 *      - Which framework IDs are mandatory across the org (`enforcedFrameworkIds`)
 *      - Whether developers may change Checks Agent settings (`lockSettings`)
 *
 * 3. **Live policy updates** — Reacts to `IEnterprisePolicyService.onDidChangePolicy`
 *    and fires `onDidChangePolicy` so downstream consumers (FIM provider, commit
 *    gate, Checks Agent) can refresh their behaviour without an IDE restart.
 *
 * ## Architecture position
 *
 * This service sits at the boundary between the enterprise policy layer
 * (`void/common/enterprisePolicyService`) and the NeuralInverse Checks
 * enforcement layer.  It intentionally has **no imports from other
 * neuralInverseChecks services** to avoid circular dependencies.
 *
 * ## Registration
 *
 * Registered as an `Eager` singleton.  The contribution entry point
 * (`neuralInverseChecks.contribution.ts`) imports this file as a pure
 * side-effect, which triggers `registerSingleton()` at workbench startup —
 * the same pattern used by `inverseAccessService.ts`,
 * `externalCommandExecutor.ts`, `externalResultCache.ts`, and
 * `checksSocketService.ts`.
 *
 * ## OSS / community behaviour
 *
 * `IEnterprisePolicyService` always returns `policy = null` in the OSS build
 * (no enterprise auth).  All getters fall back to permissive defaults so that
 * the IDE behaves exactly as before enterprise policy existed:
 *   - FIM enabled
 *   - No forbidden tokens
 *   - No forced stop tokens
 *   - No token / temperature cap
 *   - Checks Agent enabled, autoScanOnSave developer-controlled
 *   - No enforced framework IDs
 *   - No commit blocking
 */

import { Emitter, Event } from '../../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../../platform/instantiation/common/extensions.js';
import { IEnterprisePolicyService } from '../../../../../void/common/enterprisePolicyService.js';
import type { FIMPolicy, ChecksAgentPolicy } from '../../../../../void/common/enterprisePolicyTypes.js';


// ─── Service Interface ────────────────────────────────────────────────────────

export const IPolicyService = createDecorator<IPolicyService>('neuralInversePolicyService');

export interface IPolicyService {
	readonly _serviceBrand: undefined;

	// ── FIM / inline-completion policy ──────────────────────────────────────

	/**
	 * Whether FIM inline completions are permitted under the current enterprise
	 * policy.  Returns `true` when no enterprise policy is active (OSS default).
	 */
	readonly isFIMEnabled: boolean;

	/**
	 * Tokens that must be scrubbed from every completion before it is shown to
	 * the developer.  Empty in the OSS build (no policy).
	 */
	readonly forbiddenTokens: readonly string[];

	/**
	 * Stop tokens injected into every FIM request.  The completion model halts
	 * generation when it produces any of these tokens.  Empty in the OSS build.
	 */
	readonly stopTokens: readonly string[];

	/**
	 * Maximum tokens per completion, or `undefined` when not constrained.
	 */
	readonly maxTokens: number | undefined;

	/**
	 * Sampling temperature, or `undefined` when not constrained.
	 */
	readonly temperature: number | undefined;

	/**
	 * When `true`, the developer's local FIM settings are read-only.
	 * Always `false` in the OSS build.
	 */
	readonly lockFIMSettings: boolean;

	// ── Checks Agent policy ──────────────────────────────────────────────────

	/**
	 * Whether the Checks Agent is permitted to run under the current enterprise
	 * policy.  Returns `true` when no enterprise policy is active (OSS default).
	 */
	readonly isChecksAgentEnabled: boolean;

	/**
	 * Whether the Checks Agent should automatically scan on every file save.
	 * Returns `null` when the enterprise has not set this (developer decides).
	 */
	readonly autoScanOnSave: boolean | null;

	/**
	 * When `true`, git commits must be blocked when blocker/critical GRC
	 * violations are present.  Always `false` in the OSS build.
	 */
	readonly blockCommitsOnViolations: boolean;

	/**
	 * Framework IDs that are mandatory for every project in the org.
	 * Empty in the OSS build.
	 */
	readonly enforcedFrameworkIds: readonly string[];

	/**
	 * When `true`, the developer's local Checks Agent settings are read-only.
	 * Always `false` in the OSS build.
	 */
	readonly lockChecksAgentSettings: boolean;

	// ── Events ───────────────────────────────────────────────────────────────

	/**
	 * Fires whenever the enterprise policy refreshes (either from server poll
	 * or after `IEnterprisePolicyService.refreshPolicy()`).  Consumers should
	 * re-read all getters and update their behaviour accordingly.
	 */
	readonly onDidChangePolicy: Event<void>;

	// ── Utilities ────────────────────────────────────────────────────────────

	/**
	 * Filter `completion` by stripping any forbidden tokens defined by the
	 * current FIM policy.  Returns the completion unchanged when no policy is
	 * active or no forbidden tokens are configured.
	 *
	 * This is a pure convenience method — callers are free to apply the
	 * `forbiddenTokens` list themselves.
	 */
	filterCompletion(completion: string): string;

	/**
	 * Validate a proposed completion against the current FIM policy.
	 *
	 * @returns `null` when the completion passes all policy checks, or a
	 *          human-readable rejection reason when it fails.
	 */
	validateCompletion(completion: string): string | null;
}


// ─── Default values (OSS / no-policy fallback) ───────────────────────────────

const DEFAULT_FIM_ENABLED           = true;
const DEFAULT_FORBIDDEN_TOKENS: readonly string[] = Object.freeze([]);
const DEFAULT_STOP_TOKENS:      readonly string[] = Object.freeze([]);
const DEFAULT_MAX_TOKENS: undefined                = undefined;
const DEFAULT_TEMPERATURE: undefined               = undefined;
const DEFAULT_LOCK_FIM              = false;

const DEFAULT_CHECKS_AGENT_ENABLED  = true;
const DEFAULT_AUTO_SCAN_ON_SAVE: null               = null;
const DEFAULT_BLOCK_COMMITS         = false;
const DEFAULT_ENFORCED_FRAMEWORKS: readonly string[] = Object.freeze([]);
const DEFAULT_LOCK_CHECKS_AGENT     = false;


// ─── Implementation ───────────────────────────────────────────────────────────

class PolicyService extends Disposable implements IPolicyService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangePolicy = this._register(new Emitter<void>());
	readonly onDidChangePolicy: Event<void> = this._onDidChangePolicy.event;

	// Cached derived state — recomputed on every policy change
	private _isFIMEnabled:              boolean            = DEFAULT_FIM_ENABLED;
	private _forbiddenTokens:           readonly string[]  = DEFAULT_FORBIDDEN_TOKENS;
	private _stopTokens:                readonly string[]  = DEFAULT_STOP_TOKENS;
	private _maxTokens:                 number | undefined = DEFAULT_MAX_TOKENS;
	private _temperature:               number | undefined = DEFAULT_TEMPERATURE;
	private _lockFIMSettings:           boolean            = DEFAULT_LOCK_FIM;

	private _isChecksAgentEnabled:      boolean            = DEFAULT_CHECKS_AGENT_ENABLED;
	private _autoScanOnSave:            boolean | null     = DEFAULT_AUTO_SCAN_ON_SAVE;
	private _blockCommitsOnViolations:  boolean            = DEFAULT_BLOCK_COMMITS;
	private _enforcedFrameworkIds:      readonly string[]  = DEFAULT_ENFORCED_FRAMEWORKS;
	private _lockChecksAgentSettings:   boolean            = DEFAULT_LOCK_CHECKS_AGENT;

	constructor(
		@IEnterprisePolicyService private readonly _enterprisePolicyService: IEnterprisePolicyService,
	) {
		super();

		// Apply whatever policy is already in memory (may be a cached offline copy)
		this._applyPolicy();

		// Re-apply on every subsequent policy refresh
		this._register(this._enterprisePolicyService.onDidChangePolicy(() => {
			this._applyPolicy();
			this._onDidChangePolicy.fire();
		}));

		console.log('[PolicyService] Initialized (neuralInversePolicyService)');
	}

	// ── FIM getters ──────────────────────────────────────────────────────────

	get isFIMEnabled():     boolean            { return this._isFIMEnabled; }
	get forbiddenTokens():  readonly string[]  { return this._forbiddenTokens; }
	get stopTokens():       readonly string[]  { return this._stopTokens; }
	get maxTokens():        number | undefined  { return this._maxTokens; }
	get temperature():      number | undefined  { return this._temperature; }
	get lockFIMSettings():  boolean            { return this._lockFIMSettings; }

	// ── Checks Agent getters ─────────────────────────────────────────────────

	get isChecksAgentEnabled():    boolean            { return this._isChecksAgentEnabled; }
	get autoScanOnSave():          boolean | null     { return this._autoScanOnSave; }
	get blockCommitsOnViolations():boolean            { return this._blockCommitsOnViolations; }
	get enforcedFrameworkIds():    readonly string[]  { return this._enforcedFrameworkIds; }
	get lockChecksAgentSettings(): boolean            { return this._lockChecksAgentSettings; }

	// ── Utilities ────────────────────────────────────────────────────────────

	filterCompletion(completion: string): string {
		if (this._forbiddenTokens.length === 0) {
			return completion;
		}
		let result = completion;
		for (const token of this._forbiddenTokens) {
			if (token.length > 0) {
				// Replace all occurrences (the token may appear more than once)
				result = result.split(token).join('');
			}
		}
		return result;
	}

	validateCompletion(completion: string): string | null {
		if (!this._isFIMEnabled) {
			return 'FIM completions are disabled by enterprise policy.';
		}
		for (const token of this._forbiddenTokens) {
			if (token.length > 0 && completion.includes(token)) {
				return `Completion contains a token forbidden by enterprise policy.`;
			}
		}
		return null;
	}

	// ── Private ──────────────────────────────────────────────────────────────

	/**
	 * Read the current `EnterpriseModelPolicy` from `IEnterprisePolicyService`
	 * and update all cached state.  Falls back to permissive OSS defaults when
	 * `policy` is `null` (OSS / community build, or no enterprise auth).
	 */
	private _applyPolicy(): void {
		const policy = this._enterprisePolicyService.policy;

		if (!policy) {
			// No enterprise policy — restore all defaults
			this._isFIMEnabled             = DEFAULT_FIM_ENABLED;
			this._forbiddenTokens          = DEFAULT_FORBIDDEN_TOKENS;
			this._stopTokens               = DEFAULT_STOP_TOKENS;
			this._maxTokens                = DEFAULT_MAX_TOKENS;
			this._temperature              = DEFAULT_TEMPERATURE;
			this._lockFIMSettings          = DEFAULT_LOCK_FIM;
			this._isChecksAgentEnabled     = DEFAULT_CHECKS_AGENT_ENABLED;
			this._autoScanOnSave           = DEFAULT_AUTO_SCAN_ON_SAVE;
			this._blockCommitsOnViolations = DEFAULT_BLOCK_COMMITS;
			this._enforcedFrameworkIds     = DEFAULT_ENFORCED_FRAMEWORKS;
			this._lockChecksAgentSettings  = DEFAULT_LOCK_CHECKS_AGENT;
			return;
		}

		// ── FIM policy ───────────────────────────────────────────────────────
		const fim: FIMPolicy | undefined = policy.fimPolicy;

		// FIMPolicy.enabled: false = force off; true = force on;
		// null/undefined = developer decides (permissive default: enabled).
		this._isFIMEnabled = fim?.enabled !== false;

		this._forbiddenTokens = Object.freeze(
			Array.isArray(fim?.forbiddenTokens) ? [...fim.forbiddenTokens] : DEFAULT_FORBIDDEN_TOKENS
		);
		this._stopTokens = Object.freeze(
			Array.isArray(fim?.stopTokens) ? [...fim.stopTokens] : DEFAULT_STOP_TOKENS
		);
		this._maxTokens    = typeof fim?.maxTokens   === 'number' ? fim.maxTokens   : undefined;
		this._temperature  = typeof fim?.temperature === 'number' ? fim.temperature : undefined;
		this._lockFIMSettings = fim?.lockFIMSettings === true;

		// ── Checks Agent policy ──────────────────────────────────────────────
		const ca: ChecksAgentPolicy | undefined = policy.checksAgentPolicy;

		// ChecksAgentPolicy.enabled: false = force off; true = force on;
		// null/undefined = developer decides (permissive default: enabled).
		this._isChecksAgentEnabled     = ca?.enabled !== false;
		this._autoScanOnSave           = ca?.autoScanOnSave   ?? null;
		this._blockCommitsOnViolations = ca?.blockCommitsOnViolations === true;
		this._enforcedFrameworkIds     = Object.freeze(
			Array.isArray(ca?.enforcedFrameworkIds) ? [...ca.enforcedFrameworkIds] : DEFAULT_ENFORCED_FRAMEWORKS
		);
		this._lockChecksAgentSettings  = ca?.lockSettings === true;

		console.log(
			`[PolicyService] Applied enterprise policy — ` +
			`FIM: ${this._isFIMEnabled ? 'enabled' : 'DISABLED'}, ` +
			`forbiddenTokens: ${this._forbiddenTokens.length}, ` +
			`blockCommits: ${this._blockCommitsOnViolations}, ` +
			`enforcedFrameworks: ${this._enforcedFrameworkIds.join(', ') || 'none'}`
		);
	}
}


// ─── Registration ─────────────────────────────────────────────────────────────

// Eager: the contribution file imports this module as a side-effect, which
// registers the singleton at workbench startup — before any FIM or Checks
// Agent service tries to read policy state.
registerSingleton(IPolicyService, PolicyService, InstantiationType.Eager);
