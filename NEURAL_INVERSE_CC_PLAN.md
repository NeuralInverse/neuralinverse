# NeuralInverseCC — Shared AI Service Architecture

**Goal:** Port the best of Claude Code's 512K-line production codebase into a single shared VS Code DI service
(`INeuralInverseCCService`) that all Neural Inverse AI systems consume.

---

## Why

Every AI system (Power Mode, Checks Agent, Modernisation, Firmware, Sub-Agents) currently duplicates:
- Agent loop logic
- Context building
- System prompt construction
- LLM type definitions (`ILLMRequest`, `ILLMMessage`, etc. — defined verbatim in both `powerModeProcessor.ts` and `checksAgentProcessor.ts`)

Meanwhile, CC has 512K lines of battle-tested production code for bash security, permission tiers,
auto-compact, file history, cost tracking, and skills — none of which we have.

`neuralInverseCC` absorbs the portable CC pieces and exposes them as a shared service.

---

## What NOT to do

- Do NOT merge agent loops — `runAgentLoop` (Power Mode) and the Checks Agent loop are domain-specific. Keep them separate.
- Do NOT merge context builders — they read different marker files (`AGENTS.md` vs `CHECKS.md`).
- Do NOT touch `sendLLMMessage.impl.ts` — the LLM connection layer works and is fragile.
- Do NOT port CC files with `bun:bundle`, `feature()`, `logEvent()`, or `src/bootstrap` deps — those are Anthropic-internal.
- Do NOT merge TUI rendering — Power Mode keeps its xterm TUI.

---

## File Structure

```
src/vs/workbench/contrib/neuralInverseCC/
│
├── neuralInverseCC.contribution.ts          # DI registration
│
├── common/
│   └── neuralInverseCCTypes.ts              # All shared types (no browser deps)
│
└── browser/
    ├── neuralInverseCCService.ts            # INeuralInverseCCService interface + impl
    │
    ├── security/
    │   ├── bashSecurityChecker.ts           # Port of CC bashSecurity.ts (23-category scanner)
    │   └── bashSecurityTypes.ts
    │
    ├── permissions/
    │   ├── permissionEngine.ts              # Permission check entry point
    │   ├── permissionTierStore.ts           # Per-session rule storage (IStorageService-backed)
    │   ├── shellRuleMatching.ts             # Port of CC shellRuleMatching.ts (near-verbatim)
    │   ├── denialTracker.ts                 # Port of CC denialTracking.ts (near-verbatim)
    │   └── permissionTypes.ts              # PermissionBehavior, PermissionRule, PermissionResult
    │
    ├── compact/
    │   ├── conversationCompactor.ts         # LLM-based summary via ILLMMessageService
    │   ├── autoCompactController.ts         # Port of CC autoCompact.ts thresholds + circuit breaker
    │   └── compactTypes.ts
    │
    ├── fileHistory/
    │   ├── fileHistoryManager.ts            # Port of CC fileHistory.ts — IFileService-backed
    │   └── fileHistoryTypes.ts
    │
    ├── cost/
    │   ├── tokenCostTracker.ts              # Port of CC cost-tracker.ts — per-session map
    │   ├── tokenEstimator.ts                # Port of CC tokenEstimation.ts — heuristic only
    │   └── costTypes.ts
    │
    └── skills/
        ├── skillRegistry.ts                 # Port of CC bundledSkills.ts registration mechanism
        ├── builtinSkills.ts                 # 7 skills: verify, debug, stuck, loop, batch, remember, simplify
        └── skillTypes.ts
```

---

## CC Source → New File Mapping

| CC File | New Void File | Adaptation |
|---------|-------------|------------|
| `tools/BashTool/bashSecurity.ts` | `security/bashSecurityChecker.ts` | Strip `logEvent`, keep all 23 pattern arrays verbatim |
| `utils/permissions/shellRuleMatching.ts` | `permissions/shellRuleMatching.ts` | Zero external deps — near-verbatim |
| `utils/permissions/denialTracking.ts` | `permissions/denialTracker.ts` | Fully self-contained — near-verbatim |
| `utils/permissions/PermissionRule.ts` + `PermissionResult.ts` | `permissions/permissionTypes.ts` | Merge, remove zod, plain TS interfaces |
| `services/compact/autoCompact.ts` | `compact/autoCompactController.ts` | Port threshold logic, replace `bun:bundle`/`process.env` with settings |
| `services/compact/compact.ts` | `compact/conversationCompactor.ts` | Implement only essential LLM summary via `ILLMMessageService` — skip CC's `forkedAgent` machinery |
| `utils/fileHistory.ts` | `fileHistory/fileHistoryManager.ts` | Replace `fs/promises` with `IFileService`, strip analytics |
| `cost-tracker.ts` | `cost/tokenCostTracker.ts` | Port accumulator + `calculateUSDCost`, strip analytics/chalk |
| `services/tokenEstimation.ts` | `cost/tokenEstimator.ts` | Port heuristic formula only (not API-based counting) |
| `constants/cyberRiskInstruction.ts` | Inline constant in `neuralInverseCCService.ts` | Single line |
| `skills/bundledSkills.ts` | `skills/skillRegistry.ts` | Port mechanism, remove `bun:bundle`/Ink deps |
| `skills/bundled/{verify,debug,stuck,loop,batch,remember,simplify}.ts` | `skills/builtinSkills.ts` | Port 7 domain-agnostic skills; skip Anthropic-internal ones |
| `tools/BashTool/bashPermissions.ts` | NOT ported (2622 lines, has deep `feature()` + SDK deps) | Types + matching logic come from `shellRuleMatching.ts` instead |

---

## INeuralInverseCCService Interface (summary)

```typescript
export interface INeuralInverseCCService {
  // 1. Bash Security
  checkBashSecurity(command: string): SecurityCheckResult;
  readonly CYBER_RISK_INSTRUCTION: string;

  // 2. Permission Tiers (deny/ask/allow/always, per session)
  checkToolPermission(sessionId: string, toolName: string, commandOrArg?: string): PermissionResult;
  addPermissionRule(sessionId: string, rule: PermissionRule, scope: 'session' | 'workspace'): void;
  removePermissionRule(sessionId: string, ruleValue: string): void;
  getPermissionRules(sessionId: string): PermissionRule[];
  recordDenial(sessionId: string): void;
  shouldFallbackToPrompting(sessionId: string): boolean;
  clearSessionPermissions(sessionId: string): void;

  // 3. Auto-Compact
  readonly onAutoCompactThresholdExceeded: Event<{ sessionId: string; currentTokens: number; threshold: number }>;
  reportSessionTokenCount(sessionId: string, tokenCount: number, model: string): void;
  compactConversation(sessionId: string, messages: IConversationMessage[], model: string, signal: AbortSignal): Promise<CompactionResult>;
  getAutoCompactThreshold(model: string): number;
  getAutoCompactState(sessionId: string): AutoCompactState;
  updateAutoCompactState(sessionId: string, state: AutoCompactState): void;

  // 4. File History
  trackFileEdit(sessionId: string, messageId: string, filePath: string): Promise<void>;
  makeSnapshot(sessionId: string, messageId: string): Promise<void>;
  restoreToSnapshot(sessionId: string, snapshotIndex: number): Promise<{ restoredCount: number; errors: string[] }>;
  getFileHistoryState(sessionId: string): FileHistoryState | undefined;
  clearFileHistory(sessionId: string): void;
  readonly isFileHistoryEnabled: boolean;

  // 5. Token / Cost Tracking
  recordTokenUsage(params: { sessionId: string; model: string; inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }): void;
  getSessionCost(sessionId: string): SessionCostSummary;
  getAggregateCost(): SessionCostSummary;
  resetSessionCost(sessionId: string): void;
  estimateTokens(text: string): number;
  calculateCostUSD(params: { model: string; inputTokens: number; outputTokens: number }): number;

  // 6. Skills
  registerSkill(skill: SkillDefinition): void;
  getSkill(nameOrAlias: string): SkillDefinition | undefined;
  listSkills(): SkillDefinition[];
  invokeSkill(name: string, args: string, context: SkillInvocationContext): Promise<SkillInvocationResult>;
}
```

---

## Consumer Integration

### Power Mode (`powerModeService.ts` + `powerModeProcessor.ts`)
- Inject `@INeuralInverseCCService`
- `checkBashSecurity(cmd)` before every bash tool execution
- `checkToolPermission(sessionId, toolName)` replaces hardcoded `TOOLS_REQUIRING_APPROVAL`
- `trackFileEdit + makeSnapshot` on every write/edit tool call
- `recordTokenUsage` after each LLM turn (from stream finish event)
- Subscribe to `onAutoCompactThresholdExceeded` → call `compactConversation` → feed result to existing `compactSession()`
- `/cost` slash command → `getSessionCost(sessionId)`
- `/undo` slash command → `restoreToSnapshot(sessionId, index)`
- `/skills` slash command → `listSkills()`

### Checks Agent (`checksAgentService.ts`)
- Inject `@INeuralInverseCCService`
- `recordTokenUsage` after each turn
- `registerSkill(grcScanSkill)` at construction
- Append `CYBER_RISK_INSTRUCTION` to checks system prompt

### Sub-Agent Service (`neuralInverseSubAgentService.ts`)
- Inject `@INeuralInverseCCService`
- Inherit parent session permission rules into child sessions via `addPermissionRule`
- Roll sub-agent costs up to parent via `recordTokenUsage(parentSessionId, ...subAgentCost)`

### Firmware + Modernisation
- Register domain skills at construction time
- `CYBER_RISK_INSTRUCTION` injected into system prompts when bash tools are active
- `checkBashSecurity` before openocd / flash-write commands

---

## Implementation Order

### Phase 1 — Foundation (no consumer wiring yet)
1. `neuralInverseCCTypes.ts` — all shared types
2. `security/bashSecurityChecker.ts` — port CC bashSecurity.ts (strip analytics, keep patterns verbatim)
3. `permissions/shellRuleMatching.ts` + `denialTracker.ts` + `permissionTypes.ts`
4. `cost/tokenEstimator.ts` + `tokenCostTracker.ts`
5. `skills/skillRegistry.ts` + `builtinSkills.ts`
6. `neuralInverseCC.contribution.ts` + `neuralInverseCCService.ts` (stub, registers singleton)

### Phase 2 — File History + Compact
7. `fileHistory/fileHistoryManager.ts` — IFileService-backed snapshots
8. `compact/autoCompactController.ts` — threshold + circuit breaker
9. `compact/conversationCompactor.ts` — LLM summary call

### Phase 3 — Wire into Power Mode
10. Bash security check in processor
11. Token tracking + `/cost` command
12. Auto-compact subscription
13. File history on write/edit tools + `/undo` command

### Phase 4 — Wire into other systems
14. Checks Agent: token tracking + skills
15. Sub-Agent: permission inheritance + cost roll-up
16. Firmware + Modernisation: skills + CYBER_RISK_INSTRUCTION

### Phase 5 — Type deduplication
17. Move `ILLMRequest / ILLMMessage / ILLMToolCall / ILLMStreamEvent` from
    `powerModeProcessor.ts` + `checksAgentProcessor.ts` into `neuralInverseCCTypes.ts`

---

## What This Unlocks

Once built, every new AI system you add gets these for free by injecting one service:

| Feature | Before | After |
|---------|--------|-------|
| Bash command safety | None | 23-category injection detection |
| Permission tiers | Ad-hoc per agent | Unified deny/ask/allow/always |
| Auto-compact | None | Auto-triggers at token threshold |
| File undo | None | Snapshot restore per turn |
| Cost tracking | None | `/cost` shows real $ across all agents |
| Skills system | None | `/verify`, `/debug`, `/stuck`, etc. |
| Type definitions | Duplicated in each agent | Single source of truth |

---

## DO NOT CHANGE (existing working infrastructure)
- `sendLLMMessage.impl.ts` — LLM connection layer
- `powerBusService.ts` — Power Bus messaging
- `powerModeProcessor.ts` agent loop structure
- `powerToolRegistry.ts` — tool registration
- `checksAgentProcessor.ts` agent loop structure
- Sub-agent service spawn/queue mechanism
- DI registration order in contribution files
