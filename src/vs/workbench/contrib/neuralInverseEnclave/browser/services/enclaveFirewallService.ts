/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';

export const IEnclaveFirewallService = createDecorator<IEnclaveFirewallService>('enclaveFirewallService');

export interface IFirewallBlockEvent {
	id: string;
	timestamp: number;
	reason: string;
	snippet: string;
}

export interface IEnclaveFirewallService {
	readonly _serviceBrand: undefined;

	/**
	 * Validates a prompt text against the Context Firewall rules.
	 * Returns an object indicating if the request should be blocked.
	 */
	validatePrompt(text: string): { blocked: boolean; reason?: string; snippet?: string };

	/** Emitted when a request is blocked by the firewall */
	readonly onDidBlockRequest: Event<IFirewallBlockEvent>;

	/** Get recent block events */
	getRecentBlocks(): IFirewallBlockEvent[];

	/** Get the total number of prompts scanned */
	getScannedCount(): number;

	/** Get the total number of blocked prompts */
	getBlockedCount(): number;
}

export class EnclaveFirewallService extends Disposable implements IEnclaveFirewallService {
	declare readonly _serviceBrand: undefined;

	private _scannedCount = 0;
	private _blockedCount = 0;
	private _recentBlocks: IFirewallBlockEvent[] = [];
	private readonly MAX_RECENT_BLOCKS = 100;

	private readonly _onDidBlockRequest = this._register(new Emitter<IFirewallBlockEvent>());
	public readonly onDidBlockRequest = this._onDidBlockRequest.event;

	// Basic regex patterns for common secrets
	private readonly patterns = [
		{ name: 'AWS Access Key', regex: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/ },
		{ name: 'RSA Private Key', regex: /-----BEGIN RSA PRIVATE KEY-----/ },
		{ name: 'Generic Secret / API Key', regex: /(?:api_key|apikey|secret|token|password)[\s:=]+["'][a-zA-Z0-9\-_]{16,}["']/i },
		{ name: 'GitHub Token', regex: /(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36}/ }
	];

	constructor() {
		super();
		console.log('[Enclave] Firewall Service initialized.');
	}

	public validatePrompt(text: string): { blocked: boolean; reason?: string; snippet?: string } {
		this._scannedCount++;

		if (!text) {
			return { blocked: false };
		}

		// Check against static regex patterns
		for (const pattern of this.patterns) {
			const match = text.match(pattern.regex);
			if (match) {
				return this._block(pattern.name, match[0]);
			}
		}

		// Simple entropy check for long, random-looking strings (could be keys)
		// This is a naive implementation; a real one would calculate Shannon entropy
		const words = text.split(/[\s,;=\(\)\[\]\{\}]+/);
		for (const word of words) {
			if (word.length > 32 && /^[a-zA-Z0-9\-_]+$/.test(word)) {
				// Check character variety (rough entropy proxy)
				const uniqueChars = new Set(word).size;
				if (uniqueChars > 15) {
					return this._block('High Entropy String Detected', word.substring(0, 10) + '...');
				}
			}
		}

		return { blocked: false };
	}

	private _block(reason: string, snippet: string) {
		this._blockedCount++;
		const event: IFirewallBlockEvent = {
			id: crypto.randomUUID(),
			timestamp: Date.now(),
			reason,
			snippet: this._maskSnippet(snippet)
		};

		this._recentBlocks.unshift(event);
		if (this._recentBlocks.length > this.MAX_RECENT_BLOCKS) {
			this._recentBlocks.pop();
		}

		this._onDidBlockRequest.fire(event);
		console.warn(`[Enclave Firewall] BLOCKED request: ${reason}`);

		return { blocked: true, reason, snippet: event.snippet };
	}

	private _maskSnippet(snippet: string): string {
		if (snippet.length <= 4) return '****';
		return snippet.substring(0, 4) + '... (redacted) ...' + snippet.substring(snippet.length - 2);
	}

	public getRecentBlocks(): IFirewallBlockEvent[] {
		return [...this._recentBlocks];
	}

	public getScannedCount(): number {
		return this._scannedCount;
	}

	public getBlockedCount(): number {
		return this._blockedCount;
	}
}

registerSingleton(IEnclaveFirewallService, EnclaveFirewallService, InstantiationType.Delayed);
