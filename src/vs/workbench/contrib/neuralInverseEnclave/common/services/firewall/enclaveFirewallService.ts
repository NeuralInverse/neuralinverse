/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IEnclaveEnvironmentService } from '../environment/enclaveEnvironmentService.js';

export const IEnclaveFirewallService = createDecorator<IEnclaveFirewallService>('enclaveFirewallService');

export type FirewallSeverity = 'critical' | 'sensitive' | 'suspicious';

export interface IFirewallBlockEvent {
	id: string;
	timestamp: number;
	reason: string;
	snippet: string;
	severity: FirewallSeverity;
	wasBlocked: boolean; // false = logged only (open mode)
}

export interface IEnclaveFirewallService {
	readonly _serviceBrand: undefined;

	/**
	 * Validates a prompt text against the Context Firewall rules.
	 * Returns an object indicating if the request should be blocked.
	 */
	validatePrompt(text: string): { blocked: boolean; reason?: string; snippet?: string; severity?: FirewallSeverity };

	/** Emitted when a request is blocked or flagged by the firewall */
	readonly onDidBlockRequest: Event<IFirewallBlockEvent>;

	/** Get recent block/flag events */
	getRecentBlocks(): IFirewallBlockEvent[];

	/** Get the total number of prompts scanned */
	getScannedCount(): number;

	/** Get the total number of blocked prompts */
	getBlockedCount(): number;

	/** Get the total number of flagged (but not blocked) prompts */
	getFlaggedCount(): number;
}

interface IFirewallPattern {
	name: string;
	regex: RegExp;
	severity: FirewallSeverity;
}

export class EnclaveFirewallService extends Disposable implements IEnclaveFirewallService {
	declare readonly _serviceBrand: undefined;

	private _scannedCount = 0;
	private _blockedCount = 0;
	private _flaggedCount = 0;
	private _recentBlocks: IFirewallBlockEvent[] = [];
	private readonly MAX_RECENT_BLOCKS = 200;

	private readonly _onDidBlockRequest = this._register(new Emitter<IFirewallBlockEvent>());
	public readonly onDidBlockRequest = this._onDidBlockRequest.event;

	// --- Pattern Library ---

	// Critical: secrets and credentials that must never leave the machine
	private readonly criticalPatterns: IFirewallPattern[] = [
		{ name: 'AWS Access Key', severity: 'critical', regex: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/ },
		{ name: 'RSA Private Key', severity: 'critical', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
		{ name: 'GitHub Token', severity: 'critical', regex: /(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36}/ },
		{ name: 'Generic Secret', severity: 'critical', regex: /(?:api_key|apikey|secret_key|secret|access_token|auth_token|password)[\s]*[:=][\s]*["'][a-zA-Z0-9\-_.]{16,}["']/i },
		{ name: 'Slack Token', severity: 'critical', regex: /xox[baprs]-[0-9a-zA-Z]{10,}/ },
		{ name: 'Azure Connection String', severity: 'critical', regex: /DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[^;]+/ },
		{ name: 'JWT Token', severity: 'critical', regex: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/ },
	];

	// Sensitive: PII/PHI that may violate HIPAA, GDPR, etc.
	private readonly sensitivePatterns: IFirewallPattern[] = [
		{ name: 'SSN (US)', severity: 'sensitive', regex: /\b\d{3}-\d{2}-\d{4}\b/ },
		{ name: 'Credit Card (Visa/MC)', severity: 'sensitive', regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/ },
		{ name: 'Internal Network IP', severity: 'sensitive', regex: /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3})\b/ },
		{ name: 'Email + Password Co-occurrence', severity: 'sensitive', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[\s\S]{0,50}(?:password|passwd|pwd)[\s]*[:=]/i },
	];

	// All patterns combined
	private readonly allPatterns: IFirewallPattern[];

	// Shannon entropy threshold for high-entropy string detection
	private readonly ENTROPY_THRESHOLD = 4.0; // bits per character
	private readonly MIN_ENTROPY_WORD_LENGTH = 24;

	constructor(
		@IEnclaveEnvironmentService private readonly enclaveEnv: IEnclaveEnvironmentService
	) {
		super();
		this.allPatterns = [...this.criticalPatterns, ...this.sensitivePatterns];
		console.log(`[Enclave] Firewall Service initialized. Mode: ${this.enclaveEnv.mode}. Patterns loaded: ${this.allPatterns.length}`);
	}

	public validatePrompt(text: string): { blocked: boolean; reason?: string; snippet?: string; severity?: FirewallSeverity } {
		this._scannedCount++;

		if (!text) {
			return { blocked: false };
		}

		const mode = this.enclaveEnv.mode;

		// 1. Check all regex patterns
		for (const pattern of this.allPatterns) {
			const match = text.match(pattern.regex);
			if (match) {
				return this._handleDetection(pattern.name, match[0], pattern.severity, mode);
			}
		}

		// 2. Shannon entropy check for long high-entropy strings (potential leaked keys)
		const entropyResult = this._checkEntropy(text);
		if (entropyResult) {
			return this._handleDetection('High Entropy String', entropyResult, 'suspicious', mode);
		}

		return { blocked: false };
	}

	// --- Entropy Analysis ---

	private _checkEntropy(text: string): string | null {
		const words = text.split(/[\s,;=\(\)\[\]\{\}"'<>]+/);
		for (const word of words) {
			if (word.length >= this.MIN_ENTROPY_WORD_LENGTH && /^[a-zA-Z0-9\-_/+=.]+$/.test(word)) {
				const entropy = this._shannonEntropy(word);
				if (entropy >= this.ENTROPY_THRESHOLD) {
					return word.substring(0, 12) + '...';
				}
			}
		}
		return null;
	}

	private _shannonEntropy(str: string): number {
		const freq = new Map<string, number>();
		for (const ch of str) {
			freq.set(ch, (freq.get(ch) ?? 0) + 1);
		}
		let entropy = 0;
		for (const count of freq.values()) {
			const p = count / str.length;
			entropy -= p * Math.log2(p);
		}
		return entropy;
	}

	// --- Mode-Aware Enforcement ---

	private _handleDetection(
		reason: string,
		rawSnippet: string,
		severity: FirewallSeverity,
		mode: 'open' | 'standard' | 'locked_down'
	): { blocked: boolean; reason?: string; snippet?: string; severity?: FirewallSeverity } {

		const shouldBlock = this._shouldBlock(severity, mode);
		const maskedSnippet = this._maskSnippet(rawSnippet);

		if (shouldBlock) {
			this._blockedCount++;
		} else {
			this._flaggedCount++;
		}

		const event: IFirewallBlockEvent = {
			id: this._generateId(),
			timestamp: Date.now(),
			reason: `[${severity.toUpperCase()}] ${reason}`,
			snippet: maskedSnippet,
			severity,
			wasBlocked: shouldBlock
		};

		this._recentBlocks.unshift(event);
		if (this._recentBlocks.length > this.MAX_RECENT_BLOCKS) {
			this._recentBlocks.pop();
		}

		this._onDidBlockRequest.fire(event);

		if (shouldBlock) {
			console.warn(`[Enclave Firewall] BLOCKED (${mode}/${severity}): ${reason}`);
		} else {
			console.log(`[Enclave Firewall] FLAGGED (${mode}/${severity}): ${reason} — not blocking in ${mode} mode`);
		}

		return { blocked: shouldBlock, reason, snippet: maskedSnippet, severity };
	}

	private _shouldBlock(severity: FirewallSeverity, mode: 'open' | 'standard' | 'locked_down'): boolean {
		// Open: never block, only log
		if (mode === 'open') { return false; }

		// Standard: block critical, flag sensitive and suspicious
		if (mode === 'standard') { return severity === 'critical'; }

		// Locked Down: block everything
		return true;
	}

	// --- Utilities ---

	private _maskSnippet(snippet: string): string {
		if (snippet.length <= 4) { return '****'; }
		if (snippet.length <= 8) { return snippet.substring(0, 2) + '****' + snippet.substring(snippet.length - 1); }
		return snippet.substring(0, 4) + '...(redacted)...' + snippet.substring(snippet.length - 2);
	}

	private _generateId(): string {
		try {
			return crypto.randomUUID();
		} catch {
			return `fw-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
		}
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

	public getFlaggedCount(): number {
		return this._flaggedCount;
	}
}

registerSingleton(IEnclaveFirewallService, EnclaveFirewallService, InstantiationType.Delayed);
