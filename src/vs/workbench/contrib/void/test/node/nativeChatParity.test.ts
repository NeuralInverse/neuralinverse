/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Capability parity between the sidebar chat path and the native chat bridge
// (task A8, after the E1 and Q12 precedents).
//
// The native chat bridge (voidModelProvider) builds its system message and
// tool list SEPARATELY from the sidebar pipeline (convertToLLMMessageService
// + chatThreadService). Every capability that only the sidebar wires up is
// silently absent in native chat — this happened twice already (E1: workspace
// rules; A8: hybrid memory + ledger recall tools, both caught by the owner's
// live test, not by any automated check).
//
// This test parses the SOURCE of both paths and pins the wiring points as
// anchors, the same approach as sendLLMMessageParity.test.ts (Q12): if a
// future change drops or renames one of these wiring points, the suite goes
// red HERE instead of shipping and waiting for a manual test to notice.
//
// Each anchor names the capability it guards; keep failure messages
// self-explanatory because the fixer may not know this history.

import assert from 'assert';
import * as fs from 'fs';
import { dirname, join } from '../../../../../base/common/path.js';
import { fileURLToPath } from 'url';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const BRIDGE = 'src/vs/workbench/contrib/void/browser/voidModelProvider.ts';
const CONVERT = 'src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts';

/** Repo root walked up from this file; sentinel is .git (decoy package.json files in the standalone runner's temp tree would resolve one level too low). */
function findRepoRoot(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (true) {
		if (fs.existsSync(join(dir, '.git'))) { return dir; }
		const parent = dirname(dir);
		if (parent === dir) { break; }
		dir = parent;
	}
	throw new Error('Could not locate repo root (.git) above ' + dir);
}

function readSource(relPath: string): string {
	return fs.readFileSync(join(findRepoRoot(), relPath), 'utf-8');
}

suite('native chat parity — sidebar ↔ bridge capabilities (A8)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const bridge = readSource(BRIDGE);
	const convert = readSource(CONVERT);

	test('hybrid memory instructions reach the native chat bridge', () => {
		// The sidebar injects aiInstructions (incl. the Agent Memory block) via
		// prepareLLMChatMessages; the bridge must fetch the same content and
		// append it to its own system message.
		assert.ok(
			bridge.includes('getAIInstructionsForChat('),
			`${BRIDGE} must call _convertService.getAIInstructionsForChat(...) and append the result to its system message — otherwise the Agent Memory block exists only in the sidebar (task A8 gap 1)`
		);
		assert.ok(
			bridge.includes('systemMessage = `${systemMessage}\\n\\n${aiInstructions}`'),
			`${BRIDGE} must append the fetched AI instructions to systemMessage, not compute and drop them`
		);
	});

	test('the sidebar memory path is seeded with the user message (fresh chats)', () => {
		// recallForPrompt keys off workflow-agent state; without the user's
		// message as seed, a fresh chat (no agent running) never recalls.
		assert.ok(
			convert.includes('_getCombinedAIInstructionsForChat(lastUserContent)'),
			`${CONVERT} prepareLLMChatMessages must pass the last user message into _getCombinedAIInstructionsForChat — otherwise hybrid memory only surfaces while a workflow agent is running`
		);
		assert.ok(
			convert.includes('getChatMemoryContext(querySeed)'),
			`${CONVERT} must fall back to getChatMemoryContext(querySeed) when the agent context is empty — the fresh-chat recall path (task A8)`
		);
	});

	test('the bridge offers the internal tools it advertises', () => {
		// generateSystemMessage (chatMode 'agent') includes internal tool
		// schemas in the system message; extractXMLToolsWrapper only extracts
		// XML for tools present in ITS list. If the bridge does not merge
		// internalToolService.getToolInfos() into the tools it passes down,
		// the model is advertised recall_history but its calls never parse.
		assert.ok(
			bridge.includes('this._internalToolService.getToolInfos()'),
			`${BRIDGE} must merge internalToolService.getToolInfos() into its tool list (like chatThreadService does for the sidebar)`
		);
		assert.ok(
			/allBridgeTools,\s*systemMessage,\s*token/.test(bridge),
			`${BRIDGE} must pass the merged tool list (internal + copilot) to _callLLM — a list the XML extractor and native tool schemas both see`
		);
	});

	test('the bridge executes internal tool calls instead of rejecting them', () => {
		// Before A8 the routing fell through to `Tool "..." is not available.`
		// for every internal tool name — the exact failure the owner saw.
		assert.ok(
			bridge.includes('this._internalToolService.execute('),
			`${BRIDGE} must route internal tool names to internalToolService.execute — otherwise recall_history answers "not available" (task A8 gap 2)`
		);
		assert.ok(
			bridge.includes('this._internalToolService.has(toolName)'),
			`${BRIDGE} must branch on internalToolService.has(toolName) before the not-available fallback`
		);
	});

	test('the shared system-message builder keeps internal tools for agent chat modes', () => {
		// The bridge relies on generateSystemMessage('agent', ...) advertising
		// the internal tool schemas; dropping 'agent' from this condition
		// would silently hide them from native chat again.
		const idx = convert.indexOf('internalToolService.getToolInfos()');
		assert.ok(idx !== -1, `${CONVERT} generateSystemMessage must keep merging internalToolService.getToolInfos() into the advertised tool schemas`);
		const conditionWindow = convert.slice(Math.max(0, idx - 400), idx);
		assert.ok(
			conditionWindow.includes(`'agent'`),
			`${CONVERT} generateSystemMessage must include internal tool infos for chatMode 'agent' — the native chat bridge calls it with exactly that mode`
		);
	});
});

suite('native chat parity — ledger payload guarantees (phase-1 review R1/R2/R7)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	ensureNoDisposablesAreLeakedInTestSuite();

	const bridge = readSource(BRIDGE);

	test('a durable coverage note is written after every journaled turn, claiming only CONFIRMED coverage (S2/T3/U1)', () => {
		// the note proves archived turns independently of any bounded tail —
		// long tool runs cannot make migration re-append them. T3/U1: the
		// value is the migration receipt over COMPLETED turns only — the
		// current turn is deliberately NOT certified (its assistant answer
		// does not exist yet; certifying it would make a failed answer write
		// permanently unrecoverable). T4/U2: the same value is persisted as
		// the meta.json watermark, durably and only with its proving flush.
		assert.ok(
			bridge.includes('content: \'turn-coverage-v2\''),
			`${BRIDGE} must journal the v2 coverage note — v1 notes certified the not-yet-answered current turn and are ignored on read`
		);
		assert.ok(
			bridge.includes('meta: { coveredThrough: migratedThrough }'),
			`${BRIDGE} must claim exactly the migration receipt — never history.length, which includes the unfinished current turn (U1)`
		);
		assert.ok(
			bridge.includes('recordTurnCoverage('),
			`${BRIDGE} must persist the confirmed watermark via recordTurnCoverage so coverage survives any bounded journal window (T4)`
		);
		assert.ok(
			bridge.includes('migrateLegacyTurns('),
			`${BRIDGE} must run the shared migration core — coverage discovery reads the meta watermark, the windowed reads and the full archive (U3)`
		);
		assert.ok(
			/role:\s*'assistant',[\s\S]{0,400}turn:\s*history\.length/.test(bridge),
			`${BRIDGE} must stamp the assistant record with the current turn marker — the next migration then repairs a failed answer write instead of certifying its absence (U1)`
		);
	});

	test('legacy session turns are migrated into the journal BEFORE the current message', () => {
		// R2: a nonempty ledger used to REPLACE the session rebuild wholesale,
		// losing every turn the journal never saw
		const migrateIdx = bridge.indexOf('_migrateLegacyTurns(ledgerThreadId, history)');
		const appendIdx = bridge.indexOf('const appendedEntry = await this._journal(ledgerThreadId, {');
		assert.ok(migrateIdx !== -1, `${BRIDGE} must call _migrateLegacyTurns before journaling the current request`);
		assert.ok(appendIdx !== -1 && appendIdx > migrateIdx,
			`${BRIDGE} must journal the current user message AFTER the legacy migration so journal order stays chronological`);
	});

	test('the payload carries the current request by its JOURNAL SEQ, exactly once (S1/S3)', () => {
		// S3: a boolean journaled flag + last-message content check
		// re-appended the request after tool activity; the seq receipt pins
		// its identity wherever it sits
		assert.ok(
			bridge.includes('appendedEntry.seq'),
			`${BRIDGE} must pass the append receipt's seq into the assembly — the current request is identified by journal identity, not content sniffing`
		);
		assert.ok(
			bridge.includes('currentRequestIdx'),
			`${BRIDGE} must thread the assembly's currentRequestIdx into the budget — mandatory selection never guesses from message text (S1)`
		);
		assert.ok(
			bridge.includes('{ currentRequestIdx: currentUserIdx }'),
			`${BRIDGE} applyLoopBudget must receive the explicit current-request index on every loop send`
		);
		assert.ok(
			bridge.includes('currentUserIdx = budgeted.currentRequestIdx'),
			`${BRIDGE} must adopt the budget's REMAPPED index after the array replacement — the input-side index goes stale when trimming shifts positions (T1)`
		);
	});

	test('the trim boundary uses contiguous EPISODE coverage', () => {
		// owner condition الف + R2: the covered boundary comes from the
		// episodes the brief was actually built from, and a GAP in episode
		// coverage keeps its entries verbatim in the payload
		assert.ok(
			bridge.includes('contiguousCoverage('),
			`${BRIDGE} must derive coveredSeq via contiguousCoverage(...) over the brief's builtFromEpisodes ranges`
		);
		assert.ok(
			bridge.includes('brief.builtFromEpisodes.includes(ep.ordinal)'),
			`${BRIDGE} must filter the episode ranges by brief.builtFromEpisodes — the owner condition (coverage from frozen episodes, not a build watermark)`
		);
	});

	test('the tool loop budget keeps the brief and the current request mandatory', () => {
		// R1: the first cut could send a notice-only payload
		assert.ok(
			bridge.includes('applyLoopBudget('),
			`${BRIDGE} must route every loop send through the shared applyLoopBudget core`
		);
		assert.ok(
			bridge.includes('budgeted.infeasible'),
			`${BRIDGE} must stop the turn when the budget result is infeasible instead of sending a payload without the user's request`
		);
		assert.ok(
			/toolDefTokens/.test(bridge),
			`${BRIDGE} must measure the tool-definition tokens in the window accounting (F10) — the schemas reach the provider separately from the system message`
		);
		assert.ok(
			bridge.includes('assembleLedgerPayload('),
			`${BRIDGE} must build the payload through the shared assembleLedgerPayload core — only tool results merge into user messages, never a genuine user turn (S1)`
		);
	});

	test('assistant tool calls are journaled and reconstructed with their ids', () => {
		// R7: payload reconstruction must show the tool-call side, and the
		// tool_result blocks must carry the original tool-call id
		assert.ok(
			bridge.includes('toolCalls: issuedCalls'),
			`${BRIDGE} must journal the assistant's issued tool calls (meta.toolCalls)`
		);
		const payloadCore = readSource('src/vs/workbench/contrib/void/common/ledgerPayload.ts');
		assert.ok(
			payloadCore.includes('<tool_call id="${c.id}" name="${c.name}" />'),
			'common/ledgerPayload.ts must render journaled tool calls as <tool_call id=... name=.../> lines in the rebuilt payload'
		);
		assert.ok(
			payloadCore.includes('id="${callId}"'),
			'common/ledgerPayload.ts must render <tool_result ... id="..."> with the journaled tool-call id'
		);
	});

	test('a DUE episode closes on the normal send path, not only on /compact', () => {
		// R7: the send path must run the same close routine without force
		const closeIdx = bridge.indexOf('this._closeLedgerEpisode(ledgerThreadId, modelSelection, {})');
		assert.ok(closeIdx !== -1,
			`${BRIDGE} must call _closeLedgerEpisode(...) with NO force on the send path — auto-close at the policy threshold (F01 lifecycle)`);
		assert.ok(
			bridge.includes('{ force: true }'),
			`${BRIDGE} /compact must remain the force path of the shared close routine`
		);
	});
});
