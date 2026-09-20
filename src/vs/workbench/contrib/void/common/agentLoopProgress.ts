/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

const explorationTools = new Set([
	'read', 'read_file', 'grep', 'glob', 'list', 'ls_dir', 'get_dir_tree',
	'search_in_file', 'search_for_files', 'context_semantic_search', 'context_search_symbols',
]);

const searchTools = new Set(['grep', 'glob', 'search_in_file', 'search_for_files', 'context_semantic_search']);

/** Count successful exploration rounds, not failed calls or unexecuted requests. */
export function advanceExplorationRounds(previous: number, tools: readonly { name: string; success: boolean }[]): number {
	return tools.length > 0 && tools.every(t => t.success && explorationTools.has(t.name)) ? previous + 1 : 0;
}

/** Fold this round's read calls into the run-wide per-range counter and report
 *  how many reads landed on ranges already read earlier in this run. Useful
 *  reads of NEW files/ranges never count as repetition. */
export function countRepeatedReads(
	priorCounts: ReadonlyMap<string, number>,
	reads: readonly { file: string; range: string }[],
): { counts: Map<string, number>; repeatedThisRound: number; totalRepeats: number } {
	const counts = new Map(priorCounts);
	let repeatedThisRound = 0;
	for (const r of reads) {
		const key = `${r.file}#${r.range}`;
		const seen = counts.get(key) ?? 0;
		if (seen > 0) { repeatedThisRound++; }
		counts.set(key, seen + 1);
	}
	let totalRepeats = 0;
	for (const n of counts.values()) {
		if (n > 1) { totalRepeats += n - 1; }
	}
	return { counts, repeatedThisRound, totalRepeats };
}

/** A round counts as fruitless search only when every call was a search that
 *  succeeded yet produced no hits. Any write, read, or failed call resets the
 *  streak — a failing search backend is an error path, not "no evidence". */
export function advanceFruitlessSearchRounds(previous: number, tools: readonly { name: string; success: boolean; emptyResult: boolean }[]): number {
	if (tools.length === 0) { return 0; }
	const onlySearches = tools.every(t => searchTools.has(t.name));
	if (!onlySearches) { return 0; }
	return tools.every(t => t.success && t.emptyResult) ? previous + 1 : 0;
}

export interface AgentLoopSignals {
	explorationRounds: number;
	repeatedReads: number;
	fruitlessSearchRounds: number;
}

/** A planning checkpoint, not a command to modify files or extend the request cap. */
export function getAgentLoopReminder(completedRequests: number, requestLimit: number, signals: AgentLoopSignals | number): string | undefined {
	// `number` accepted for the pre-signal callers (exploration rounds only).
	const s: AgentLoopSignals = typeof signals === 'number' ? { explorationRounds: signals, repeatedReads: 0, fruitlessSearchRounds: 0 } : signals;
	const remaining = Math.max(0, requestLimit - completedRequests);
	if (remaining <= 5) {
		return `Execution checkpoint: ${remaining} model requests remain in this run. Review the user's goal and the evidence already gathered. Complete and verify the requested work if feasible; otherwise clearly report what remains and any blocker. Do not restart broad exploration or claim unperformed work is complete.`;
	}
	if (s.repeatedReads >= 3) {
		return `Execution checkpoint: the same file ranges have been read again ${s.repeatedReads} times in this run without new information. The earlier tool results in this conversation already contain those ranges. Identify what is still missing as a concrete question, use the existing evidence, and proceed to the requested change or answer instead of rereading.`;
	}
	if (s.fruitlessSearchRounds >= 3) {
		return `Execution checkpoint: the last ${s.fruitlessSearchRounds} search rounds returned no results. The sought terms or files likely do not exist under those paths. Stop repeating the same search shape; either widen or change the search terms once, or work from the files and evidence already collected.`;
	}
	if (s.explorationRounds >= 8) {
		return `Execution checkpoint: ${s.explorationRounds} consecutive rounds have only read or searched files. Reuse the evidence already gathered and identify the smallest remaining information gap. If the user requested changes and the evidence is sufficient, implement the requested change and verify it. If the user requested analysis, provide the supported answer. Read additional narrow ranges only when they resolve a concrete gap; do not reread broad sections without a reason.`;
	}
	return undefined;
}
