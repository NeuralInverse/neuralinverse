/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Framework Brief Service
 *
 * On framework import, generates a compact compliance brief in intent language
 * ("when writing X, do Y") and stores it at .inverse/frameworks/{id}.brief.md
 *
 * The brief is injected into every AI code generation prompt so the model
 * writes compliant code on the first attempt instead of writing → scanning → fixing.
 *
 * Uses Chat model only (not Checks model) — brief generation is a one-time
 * synthesis task, not a compliance analysis task.
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IVoidSettingsService } from '../../../../void/common/voidSettingsService.js';
import { ModelSelection } from '../../../../void/common/voidSettingsTypes.js';
import { ILLMMessageService } from '../../../../void/common/sendLLMMessageService.js';
import { IFrameworkRegistry, ILoadedFramework } from './frameworkRegistry.js';
import { LLMChatMessage } from '../../../../void/common/sendLLMMessageTypes.js';
import { withInverseWriteAccess } from '../utils/inverseFs.js';

export const IFrameworkBriefService = createDecorator<IFrameworkBriefService>('frameworkBriefService');

export interface IFrameworkBriefService {
	readonly _serviceBrand: undefined;

	/** Returns the combined compliance brief for all active frameworks, ready to inject into prompts */
	getActiveBrief(): string;

	/** Force regenerate the brief for a specific framework (e.g. after manual rule changes) */
	regenerateBrief(frameworkId: string): Promise<void>;

	/**
	 * Record that an external tool confirmed a violation for this rule.
	 * Enriches the brief context — these patterns are flagged as confirmed-in-codebase.
	 */
	recordExternalHit(ruleId: string, toolName: string, count: number): void;

	/**
	 * Returns a summary of patterns external tools have actually found,
	 * for injecting into Layer 1 (brief) context as highest-priority signals.
	 */
	getExternalHitsSummary(): string;
}

class FrameworkBriefService extends Disposable implements IFrameworkBriefService {
	declare readonly _serviceBrand: undefined;

	/** In-memory cache: frameworkId → brief text */
	private readonly _briefs = new Map<string, string>();

	/** External tool confirmed hits: ruleId → { toolName, totalCount } */
	private readonly _externalHits = new Map<string, { toolName: string; count: number }>();

	constructor(
		@IFrameworkRegistry private readonly frameworkRegistry: IFrameworkRegistry,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
	) {
		super();

		// Load existing briefs + generate missing ones whenever frameworks change
		this._register(this.frameworkRegistry.onDidFrameworksChange(() => {
			this._syncBriefs();
		}));

		// Delay initial sync — frameworkRegistry._initialize() is async, give it time to finish
		setTimeout(() => this._syncBriefs(), 5000);
	}

	// ─── Public API ──────────────────────────────────────────────────────────

	public getActiveBrief(): string {
		const frameworks = this.frameworkRegistry.getActiveFrameworks()
			.filter(fw => fw.validation.valid && fw.definition.framework.id !== 'neural-inverse-builtin');

		const parts: string[] = [];
		for (const fw of frameworks) {
			const brief = this._briefs.get(fw.definition.framework.id);
			if (brief) parts.push(brief);
		}

		if (parts.length === 0) return '';

		return [
			'COMPLIANCE CONSTRAINTS (follow these when writing code — violations block commits):',
			...parts
		].join('\n\n');
	}

	public async regenerateBrief(frameworkId: string): Promise<void> {
		const fw = this.frameworkRegistry.getFrameworkById(frameworkId);
		if (!fw || !fw.validation.valid) return;
		this._briefs.delete(frameworkId);
		await this._generateAndStoreBrief(fw);
	}

	public recordExternalHit(ruleId: string, toolName: string, count: number): void {
		const existing = this._externalHits.get(ruleId);
		if (existing) {
			existing.count += count;
		} else {
			this._externalHits.set(ruleId, { toolName, count });
		}
	}

	public getExternalHitsSummary(): string {
		if (this._externalHits.size === 0) return '';

		// Resolve rule messages from active frameworks
		const ruleMessages = new Map<string, string>();
		for (const fw of this.frameworkRegistry.getActiveFrameworks()) {
			for (const rule of fw.rules) {
				if (!ruleMessages.has(rule.id)) ruleMessages.set(rule.id, rule.message);
			}
		}

		// Sort by hit count descending, take top 8
		const entries = [...this._externalHits.entries()]
			.sort((a, b) => b[1].count - a[1].count)
			.slice(0, 8);

		const lines = entries.map(([ruleId, { toolName, count }]) => {
			const msg = ruleMessages.get(ruleId) ?? ruleId;
			return `• [${ruleId}] ${msg} — found ${count}x by ${toolName}`;
		});

		return `PATTERNS CONFIRMED IN THIS CODEBASE BY EXTERNAL TOOLS (must fix — these are real violations, not theoretical):\n${lines.join('\n')}`;
	}

	// ─── Sync ────────────────────────────────────────────────────────────────

	private async _syncBriefs(): Promise<void> {
		const frameworks = this.frameworkRegistry.getActiveFrameworks()
			.filter(fw => fw.validation.valid && fw.definition.framework.id !== 'neural-inverse-builtin');

		console.log(`[FrameworkBrief] Syncing briefs for ${frameworks.length} framework(s)`);

		for (const fw of frameworks) {
			const id = fw.definition.framework.id;

			// Already in memory this session — skip
			if (this._briefs.has(id)) continue;

			// Try loading from disk first (covers existing frameworks on restart)
			const stored = await this._loadBriefFromDisk(id);
			if (stored) {
				this._briefs.set(id, stored);
				console.log(`[FrameworkBrief] Loaded brief from disk for ${id}`);
				continue;
			}

			// Not on disk — generate it (new framework imported or brief deleted)
			console.log(`[FrameworkBrief] No brief found for ${id} — generating via Chat model`);
			this._generateAndStoreBrief(fw).catch(e => {
				console.warn(`[FrameworkBrief] Failed to generate brief for ${id}:`, e);
			});
		}
	}

	// ─── Disk I/O ────────────────────────────────────────────────────────────

	private _getBriefUri(frameworkId: string): URI | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) return undefined;
		return URI.joinPath(folders[0].uri, '.inverse', 'frameworks', `${frameworkId}.brief.md`);
	}

	private async _loadBriefFromDisk(frameworkId: string): Promise<string | undefined> {
		try {
			const uri = this._getBriefUri(frameworkId);
			if (!uri) return undefined;
			if (!(await this.fileService.exists(uri))) return undefined;
			const content = await this.fileService.readFile(uri);
			const text = content.value.toString().trim();
			return text.length > 0 ? text : undefined;
		} catch {
			return undefined;
		}
	}

	private async _writeBriefToDisk(frameworkId: string, brief: string): Promise<void> {
		try {
			const uri = this._getBriefUri(frameworkId);
			if (!uri) return;
			const folders = this.workspaceContextService.getWorkspace().folders;
			if (folders.length === 0) return;
			const inverseDir = URI.joinPath(folders[0].uri, '.inverse').fsPath;
			await withInverseWriteAccess(inverseDir, async () => {
				await this.fileService.writeFile(uri, VSBuffer.fromString(brief));
			});
		} catch (e) {
			console.warn('[FrameworkBrief] Failed to write brief to disk:', e);
		}
	}

	// ─── Brief Generation ────────────────────────────────────────────────────

	private async _generateAndStoreBrief(fw: ILoadedFramework): Promise<void> {
		// Use Chat model only — brief generation is synthesis, not compliance analysis
		const modelSelection = this.voidSettingsService.state.modelSelectionOfFeature['Chat'];
		if (!modelSelection) {
			console.warn('[FrameworkBrief] No Chat model configured — cannot generate brief');
			return;
		}

		const id = fw.definition.framework.id;
		const meta = fw.definition.framework;
		const rules = fw.rules.filter(r => r.enabled !== false);

		if (rules.length === 0) return;

		// Build compact rule list for the prompt
		const ruleLines = rules.map(r => {
			let line = `[${r.id}] ${r.severity.toUpperCase()} — ${r.message}`;
			if (r.description) line += ` | Detail: ${r.description}`;
			if (r.fix) line += ` | Fix: ${r.fix}`;
			return line;
		}).join('\n');

		const prompt = `You are a compliance expert. Convert these GRC rules into a compact developer brief.

FRAMEWORK: ${meta.name} v${meta.version}
${meta.description ? `DESCRIPTION: ${meta.description}` : ''}
LANGUAGES: ${(meta as any).appliesTo?.join(', ') ?? 'C, C++, embedded'}

RULES:
${ruleLines}

Write a brief in this EXACT format — grouped by coding scenario, max 25 lines total:

## ${meta.name} Compliance Brief

When writing [scenario]:
→ [constraint — what NOT to do or what IS required]
→ [fix pattern — exact code idiom to use]

When writing [next scenario]:
→ [constraint]
→ [fix pattern]

Rules:
- Use "When writing X" groupings — map multiple rules to the same scenario if they apply
- One line per constraint, one line per fix
- Write concrete code patterns, not prose (e.g. "use BSRR not |=" not "use atomic access")
- Do NOT include rule IDs, severities, or references — just the actionable constraints
- Max 25 lines total — be ruthlessly concise`;

		try {
			const brief = await this._callChatModel(modelSelection, prompt, id);
			if (!brief || brief.trim().length < 50) {
				console.warn(`[FrameworkBrief] Generated brief too short for ${id}, skipping`);
				return;
			}

			this._briefs.set(id, brief.trim());
			await this._writeBriefToDisk(id, brief.trim());
			console.log(`[FrameworkBrief] Generated and stored brief for ${id} (${brief.length} chars)`);
		} catch (e) {
			console.warn(`[FrameworkBrief] LLM call failed for ${id}:`, e);
		}
	}

	// ─── LLM Call ────────────────────────────────────────────────────────────

	private _callChatModel(
		modelSelection: ModelSelection,
		prompt: string,
		frameworkId: string
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('Brief generation timed out')), 60_000);

			this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages: [{ role: 'user', content: prompt }] as LLMChatMessage[],
				separateSystemMessage: undefined,
				chatMode: null,
				modelSelection: modelSelection as any,
				modelSelectionOptions: undefined,
				overridesOfModel: undefined,
				onText: () => { },
				onFinalMessage: (params: { fullText: string }) => {
					clearTimeout(timeout);
					resolve(params.fullText);
				},
				onError: (err: { message: string }) => {
					clearTimeout(timeout);
					reject(new Error(err.message));
				},
				onAbort: () => {
					clearTimeout(timeout);
					reject(new Error('Aborted'));
				},
				logging: { loggingName: `GRC-Brief-${frameworkId}` },
			});
		});
	}
}

registerSingleton(IFrameworkBriefService, FrameworkBriefService, InstantiationType.Eager);
