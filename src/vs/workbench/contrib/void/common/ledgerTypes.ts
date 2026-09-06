/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Context Ledger — shared contracts (task M5)
 *
 * The ledger is the backbone of long-conversation memory:
 *
 *   L0  Journal    — append-only transcript on disk, never rewritten
 *   L1  Episodes   — one summary per closed segment, frozen forever (D1)
 *   L2  Brief      — working memory merged deterministically from episodes (D3)
 *   L3  Recall     — search tools over journal + episodes
 *   L4  Assembler  — budget-aware request assembly with a cache-stable prefix (D5)
 *
 * This file is dependency-free on purpose: every layer codes against these
 * shapes so they can be built and unit-tested independently.
 */

// ─── Schema ──────────────────────────────────────────────────────────────────

export const LEDGER_SCHEMA_VERSION = 1;

export type LedgerRole = 'user' | 'assistant' | 'tool' | 'system' | 'note';

/** Input to a journal append (the service assigns id/seq/ts/tokens). */
export interface ILedgerAppendInput {
	role: LedgerRole;
	content: string;
	/** tool name, for role='tool' */
	name?: string;
	meta?: ILedgerEntryMeta;
}

export interface ILedgerEntryMeta {
	toolCallId?: string;
	filePaths?: string[];
	exitCode?: number;
	errorKind?: string;
	model?: string;
	usage?: { input: number; output: number; costUsd?: number };
}

/** One immutable record in the journal. `seq` is gapless and ascending per thread. */
export interface ILedgerEntry {
	id: string;          // le_<threadId>_<seq>
	seq: number;
	threadId: string;
	role: LedgerRole;
	name?: string;
	/** when content exceeds policy INLINE_MAX_CHARS: head+tail plus a blobRef */
	content: string;
	blobRef?: string;
	ts: number;
	/** measured at write time */
	tokens: number;
	meta?: ILedgerEntryMeta;
}

/** The engineered episode body that replaces free prose. */
export interface IEpisodeBody {
	goal: string;
	decisions: { what: string; why: string; alternatives?: string[]; sourceIds: number[] }[];
	/** the heart of this task: approaches that were tried and rejected */
	rejected: { approach: string; reason: string; evidence?: string; sourceIds: number[] }[];
	failures: { attempt: string; error: string; resolution: 'fixed' | 'abandoned' | 'open'; sourceIds: number[] }[];
	corrections: { userSaid: string; ruleDerived?: string; sourceIds: number[] }[];
	/** permanent user rules ("always pnpm", "never force-push") */
	invariants: string[];
	artifacts: { files: string[]; symbols: string[]; commands: string[]; configs: string[] };
	state: { done: string[]; inProgress: string[]; verified: string[] };
	next: string[];
	openQuestions: string[];
}

/** Summary of one episode — never mutated after it is written (D1). */
export interface IEpisodeSummary {
	id: string;                  // ep_<threadId>_<ordinal>
	threadId: string;
	ordinal: number;
	range: { fromSeq: number; toSeq: number };
	createdAt: number;
	producedBy: 'llm' | 'deterministic';
	model?: string;
	frozen: true;
	body: IEpisodeBody;
}

/** The sendable working memory, built by deterministic merge of episodes. */
export interface IWorkingBrief {
	threadId: string;
	/** bumps only at episode boundaries / pin changes (D5) */
	revision: number;
	builtFromEpisodes: number[];  // ordinals
	builtAtSeq: number;
	tokens: number;
	/** the rendered <working_memory> block */
	text: string;
	/** structured form for UI and debugging */
	merged: IEpisodeBody;
}

// ─── Journal service contract (L0) ───────────────────────────────────────────

export interface ILedgerStats {
	entryCount: number;
	totalTokens: number;
	/** tokens after the last closed episode — drives boundary decisions */
	unsummarizedTokens: number;
	lastSeq: number;
	episodeCount: number;
	journalBytes: number;
	lastEntryTs: number;
}

export interface IContextLedgerService {
	readonly _serviceBrand: undefined;

	/** Append one entry; assigns id/seq/ts/tokens. Never throws for callers — degrades to no-op. */
	append(threadId: string, input: ILedgerAppendInput): Promise<ILedgerEntry | null>;

	/** Entries with fromSeq <= seq <= toSeq, ascending. Blob-backed content is spliced back in. */
	readRange(threadId: string, fromSeq: number, toSeq: number): Promise<ILedgerEntry[]>;

	/** The most recent `maxEntries` entries, ascending. */
	readTail(threadId: string, maxEntries: number): Promise<ILedgerEntry[]>;

	stats(threadId: string): Promise<ILedgerStats | null>;

	// ── episode + brief storage (L1/L2) ──

	listEpisodes(threadId: string): Promise<IEpisodeSummary[]>;
	/** write-once: throws if an episode with this ordinal already exists */
	saveEpisode(episode: IEpisodeSummary): Promise<void>;
	getBrief(threadId: string): Promise<IWorkingBrief | null>;
	saveBrief(brief: IWorkingBrief): Promise<void>;
	invalidateCaches(threadId: string): void;
}

// ─── Assembly contract (L4) ──────────────────────────────────────────────────

export interface IContextUsageSection {
	name: 'system' | 'brief' | 'pinned' | 'recalled' | 'notice' | 'tail' | 'reserved-output';
	tokens: number;
}

export interface IContextUsageReport {
	totalTokens: number;
	contextWindow: number;
	availableInputTokens: number;
	sections: IContextUsageSection[];
	/** true when the assembled prefix changed without a brief revision (D5 violation) */
	cacheStable: boolean;
}

export interface IAssembleResult<T> {
	/** the messages to send (raw message objects pass through untouched) */
	messages: T[];
	/** index into the original raws where the verbatim tail starts; 0 = nothing folded */
	keepFromIdx: number;
	report: IContextUsageReport;
}
