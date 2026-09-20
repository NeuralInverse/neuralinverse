/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { OnText } from './sendLLMMessageTypes.js';

type RequestOutcome<T> = { type: 'completed'; value: T } | { type: 'failed'; error: Error } | { type: 'stalled' } | { type: 'cancelled' };

/**
 * Owns one request's deadline and terminal result independently of provider
 * callbacks. Empty/repeated snapshots cannot keep a dead stream alive.
 * The caller owns this guard and must dispose it when the request settles.
 *
 * K-1 (2026-09-17): the idle timer alone cannot bound a stream that keeps
 * producing FRESH text forever (router fallback churn re-streaming content) —
 * progress resets the idle deadline by design. The optional `totalTimeoutMs`
 * arms a second, non-resettable ceiling: when it fires the request settles
 * `stalled` no matter how healthy the per-chunk progress looked.
 */
export class ChatRequestGuard<T> {

	private readonly startedAt = Date.now();
	private lastProgressAt = this.startedAt;
	private callbackCount = 0;
	private progressCount = 0;
	private lastText = '';
	private lastReasoning = '';
	private lastTools = '[]';
	private providerOutputCharacters = 0;
	private settled = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private totalTimer: ReturnType<typeof setTimeout> | undefined;
	private resolve!: (outcome: RequestOutcome<T>) => void;
	readonly result = new Promise<RequestOutcome<T>>(resolve => { this.resolve = resolve; });

	constructor(private readonly timeoutMs: number, totalTimeoutMs?: number) {
		this.arm();
		if (totalTimeoutMs !== undefined && totalTimeoutMs > 0) {
			this.totalTimer = setTimeout(() => this.finish({ type: 'stalled' }), totalTimeoutMs);
		}
	}

	private arm(): void {
		if (this.timer !== undefined) { clearTimeout(this.timer); }
		this.timer = setTimeout(() => this.finish({ type: 'stalled' }), this.timeoutMs);
	}

	private finish(outcome: RequestOutcome<T>): boolean {
		if (this.settled) { return false; }
		this.settled = true;
		if (this.timer !== undefined) { clearTimeout(this.timer); }
		this.timer = undefined;
		if (this.totalTimer !== undefined) { clearTimeout(this.totalTimer); }
		this.totalTimer = undefined;
		this.resolve(outcome);
		return true;
	}

	/** Accept fresh text, reasoning or tool arguments; reject keepalives and late events. */
	progress(snapshot: Parameters<OnText>[0]): boolean {
		if (this.settled) { return false; }
		this.callbackCount++;
		const tools = JSON.stringify(snapshot.toolCalls ?? []);
		const providerOutputCharacters = snapshot.providerOutputCharacters ?? 0;
		if (snapshot.fullText === this.lastText && snapshot.fullReasoning === this.lastReasoning
			&& tools === this.lastTools && providerOutputCharacters === this.providerOutputCharacters) {
			return false;
		}
		this.lastText = snapshot.fullText;
		this.lastReasoning = snapshot.fullReasoning;
		this.lastTools = tools;
		this.providerOutputCharacters = providerOutputCharacters;
		this.lastProgressAt = Date.now();
		this.progressCount++;
		this.arm();
		return true;
	}

	complete(value: T): boolean { return this.finish({ type: 'completed', value }); }
	fail(error: Error): boolean { return this.finish({ type: 'failed', error }); }
	cancel(): boolean { return this.finish({ type: 'cancelled' }); }
	dispose(): void { this.cancel(); }
	get isSettled(): boolean { return this.settled; }

	/** Timing and counts only: never log prompts, generated text or tool arguments. */
	get diagnostics() {
		return {
			elapsedMs: Date.now() - this.startedAt,
			idleMs: Date.now() - this.lastProgressAt,
			callbackCount: this.callbackCount,
			progressCount: this.progressCount,
			textCharacters: this.lastText.length,
			reasoningCharacters: this.lastReasoning.length,
			providerOutputCharacters: this.providerOutputCharacters,
		};
	}
}
