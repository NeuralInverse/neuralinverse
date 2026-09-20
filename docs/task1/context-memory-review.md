# Task 1: context, memory, and conversation persistence

This is an integration proposal for maintainer review, **not a release-ready durability claim**.
The change imports the completed Task 1 work into upstream's existing product identity and
configuration. Task 2, installers, generated UI bundles, private history, and local service
configuration are outside this proposal.

## Problem and intended behavior

Long tool-heavy conversations can exceed the provider request budget, repeatedly serialize
large application-scoped chat histories, and lose useful context when the visible request is
compacted. Retrieval also needs to distinguish embedding models and workspaces; a vector
from a different model is not evidence of relevance.

The proposal separates the current provider request, durable conversational records, recall
indexes, and the UI's persisted representation. A large archived message is replaced in the
persisted UI store only after its exact serialized body has been written and verified. If
archiving fails, the original content stays in the UI store, even when this exceeds its
configured size target. Opening a thread restores verified archived content.

## Reviewer map

All paths below are relative to `src/vs/workbench/contrib/` unless specified otherwise.

| Review area | Entry points | Intended invariant / relevant tests |
| --- | --- | --- |
| Journal, coverage, and compaction | `void/common/ledger*.ts`, `void/common/episodeSummarizer.ts`, `void/common/workingBriefBuilder.ts`, `void/browser/contextLedgerService.ts` | Track completed turns and pending/durable coverage separately; see `ledgerTurnCoverage`, `ledgerReadTail`, `ledgerTurns`, `ledgerJournal`, `episodeSummarizer` tests. |
| Request assembly and admission | `void/common/contextAssembler.ts`, `void/common/chatRequestGuard.ts`, `void/browser/convertToLLMMessageService.ts`, both `sendLLMMessage.impl.ts` implementations | Count overhead before sending, preserve structural tool turns, report why a request cannot fit; see `contextAssembler`, `contextBudgetSendPath`, `overheadAwareShed`, `sendLLMMessageParity`. |
| Archive and UI persistence | `void/common/threadStorageBound.ts`, `void/common/threadArchiveCore.ts`, `void/browser/threadArchiveService.ts`, `void/browser/chatThreadService.ts` | Persisted stubs must resolve to a verified exact body; unavailable archives retain original content. See `threadArchiveCore`, `threadStorageBound`. |
| Retrieval and learned memory | `neuralInverse/browser/context/search/`, `void/browser/ledgerRecallIndexer.ts`, `void/browser/agentMemoryService.ts` | Keep workspace and embedding-space boundaries; handle cold starts, BM25 fallback, backfill, invalid vectors, and secret-like memory candidates. See context search tests and `agentMemoryIsolation`, `agentMemoryHybrid`, `agentMemoryConsolidation`. |
| Pins and workspace instructions | `void/browser/pinnedContextService.ts`, `void/common/workspaceRuleFiles.ts`, `void/common/workingBriefBuilder.ts` | Materialize pinned context deliberately and include applicable workspace instructions. See `pinnedContextMaterialization`, `pinnedContextService`, `workspaceRuleFiles`, `workingBrief`. |
| Stop, retry, and streaming | `void/common/streamIntegrity.ts`, `void/common/agentLoopProgress.ts`, `void/common/loopBudget.ts`, provider send paths, terminal services | Preserve complete tool protocol boundaries, stop non-progress loops, and separate cancellation from completion; see `streamIntegrity`, `agentTurnTermination`, `ossRetryGuard`, `agentLoopProgress`. |
| Agent integration | `neuralInverse/browser/executor/`, `neuralInverse/browser/orchestrator/`, `powerMode/`, `void/browser/react/src/sidebar-tsx/` | Register context tools and expose context/compaction state across the existing entry points. |
| Checkpoint and search support | `neuralInverseFirmware/browser/engine/projectConfig/checkpointSnapshot.ts`, `void/browser/checkpointRestoreActions.ts`, `src/vs/workbench/services/search/node/` | Explicit snapshot restoration and actionable ripgrep spawn diagnostics. |

## Configuration, data, and compatibility

- `contextLedgerEnabled` defaults to **false**, including migration of an absent setting.
  Enabling it is opt-in. Other request, archive, and search changes are not all gated by this flag.
- The journal stores conversational text and tool output under the first workspace folder's
  `.inverse/ledger/<threadId>/`. This is plaintext user data; it is not a database to commit
  or attach to bug reports. Blob, episode, and brief files are part of the same data set.
- The UI history archive is application-scoped under the user-data directory's
  `threadHistoryArchive/`, so older threads can be restored when their original workspace
  journal is unavailable. Hash verification checks content integrity, not authenticity
  against a malicious local filesystem writer.
- Archive filenames accept only the expected hash format. Thread-directory identifiers
  reject special `.` and `..` segments, and ledger blob references accept only direct
  children of `blobs/`; malformed references retain the inline excerpt without reading
  outside the thread directory. Regression tests cover these boundaries.
- Existing `niFreeModels` defaults and cloud-session handling are retained. Optional Omni
  routing has an empty endpoint and no personal model/combination catalogue. It must be
  configured explicitly. Selected embedding providers may receive indexed source text;
  the memory feature does not make an external provider local or private.
- Task 1 observation buffers are exposed on the renderer global only when
  `__niTask1DiagnosticsEnabled` is explicitly set before initialization. Diagnostics can
  contain query text and must not be uploaded without inspection.
- The 4,000,000-character per-thread and 48,000,000-character aggregate persistence values
  are **targets**, not unconditional memory or disk limits. Failed archives and exempt
  structural records can exceed them. Character counts are not heap measurements.

## Current verification (this upstream proposal)

Base: `NeuralInverse/neuralinverse` main at
`2d68ded2f2b7d4ba540855119433be86ed87bd84`.

`node_modules/.bin/tsgo --noEmit -p src/tsconfig.json` reports **157 errors** on both the
clean upstream baseline and this proposal. Comparing diagnostic paths, codes, and text
(disregarding line/column offsets) found no additional or removed errors. Existing errors
are in the Checks/Enclave implementations. Neither their contribution imports nor their
TypeScript inclusion was removed to manufacture a passing build.

The repository's Copilot instructions prohibit running tests while compilation errors
remain. Therefore **the tests added here have not been executed on this proposal**, and no
build, live-UI, performance, or cross-platform pass is claimed. `git diff --check` passed.
The root package does not currently expose the documented `typecheck-client` script;
`tsgo` was invoked directly. The prohibited `npm run compile` was not used.

## Historical evidence and its limits

The prior installed Task 1 acceptance run used source revision
`a69ef3643ce6558ff33cdfd6a3af213a8bd57ab6` on 2026-09-19. The imported source/test snapshot
is `b8b58b56959`, before Task 2 began. Those revisions belong to the prior development
history; they are provenance identifiers, not ancestors required to review this PR.

The retained acceptance summary reports 17 ladders: 16 initially passed, none failed,
and one embedding-model scoring ladder required a supplemental observation. The same
installed revision's supplement recorded a foreign-model score of 0 and current-model
score of 1. The recorded persisted store was 24,398,246 bytes against a 48,000,000-byte
acceptance threshold. These are historical measurements, not benchmarks of this branch.

An older standalone harness also reported 473 passes and 2 skips. That harness replaced
suite setup/teardown and disposable-leak tracking with no-ops, so that count is **not**
presented as equivalent to the project's real test runner. The harness is not included.
Private databases, machine paths, credentials, raw telemetry, and screenshots of private
conversations are not published as evidence.

## Merge blockers and required follow-up

1. Resolve or obtain maintainer guidance on the upstream compilation failures, then run
   the real project test runner with its lifecycle hooks and disposable checks intact.
2. Replace staged-write-then-final-write journal persistence with provider-aware atomic
   replacement and recovery. The current temporary copy does not prevent a torn final
   file. Exercise crash points around journal, blob, and metadata writes.
3. Establish an exclusive writer or genuine cross-process transaction for each ledger.
   Re-reading `meta.lastSeq` detects completed competing writes; it cannot prevent two
   simultaneous windows from passing the same check and overwriting each other.
4. Exercise workspace changes and multi-root workspaces. The current journal root uses
   the first folder; cross-window and root-switch lifecycle needs explicit integration
   coverage before enabling this feature broadly.
5. Repeat restart/rehydration, archive-write failure, budget pressure, cancellation,
   provider parity, and embedding-model-switch scenarios on the exact PR revision.
6. Review UI localization, CE/module boundaries, and browser/desktop behavior with the
   maintainers. New non-ASCII user-visible strings remain in the imported implementation;
   the PR template's corresponding checkbox is deliberately not marked complete.

Keep the PR in draft until these gates are resolved. In particular, passing the prior
installed-version acceptance matrix does not waive these findings.

## Rollout and rollback

Start with disposable test workspaces and keep ledger opt-in. Disabling the flag stops
using the ledger path but does not erase its files or undo the UI history format.
Before reverting to an older build, restore archived thread content and back up the
application user-data directory and workspace ledger together. Never delete the archive
while persisted messages still reference it. Automated downgrade migration is not
provided by this proposal.

The local pre-commit runner could not start because `gulp-merge-json` was absent from the
available dependency installation (`build/lib/gulp/facade.ts`). The draft commit therefore
skips that local hook; no hygiene/lint pass is claimed. Restore the full dependency set and
run the repository checks before promoting this draft.
