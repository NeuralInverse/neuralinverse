# Phase 12 — Agent Autonomy

## Overview

Phase 12 adds an autonomous migration loop controller to the Neural Inverse Modernisation engine. It drives the full pipeline — Resolve → Translate → Validate → Commit — without requiring human input per unit. Humans retain ownership of every critical gate: plan approval, high-risk unit review, equivalence divergence overrides, and final cutover.

The system is built in two layers:

1. **Standalone background service** (`IAutonomyService`) — a DI singleton that runs independently of any chat session, survives window focus changes, and can be started headlessly from the Progress tab.
2. **Agent tool layer** (`autonomyTools.ts`) — six MCP-compatible tools that expose the service to Void, Power Mode, and sub-agents. Built in a second pass after the standalone service is stable.

---

## Consuming systems

Three systems can drive the autonomy loop through the same tool interface:

| System | Role | Notes |
|--------|------|-------|
| **Void** (agentic layer) | Programmatic orchestrator | Calls tools automatically; injects migration context into working memory; routes escalations to human |
| **Power Mode** | Natural language interface | Human says "migrate the foundation phase" → Power Mode calls `start_autonomy_batch`, monitors via `get_autonomy_status`, presents escalations conversationally |
| **Sub-agents** (optional) | Scoped delegation | A `migration` sub-agent role with a restricted tool whitelist; explorer reads KB state, editor drives the loop, verifier spot-checks results |

All three consume identical tool definitions. No special-casing per system.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│               IAutonomyService  (background singleton)    │
│                                                           │
│  startBatch(options)   stopBatch()   getStatus()          │
│  readonly escalatedUnits: IEscalatedUnit[]                │
│  onProgress: Event<IAutonomyProgress>                     │
│  onUnitEscalated: Event<IEscalatedUnit>                   │
└───────────────────────────┬──────────────────────────────┘
                            │  orchestrates
          ┌─────────────────┼──────────────────┐
          ▼                 ▼                  ▼
 ISourceResolution   ITranslation       IValidation
 Service             EngineService      EngineService
                                              │
                                       ICutoverService
                                       .commitBatch()

┌──────────────────────────────────────────────────────────┐
│         IModernisationAgentToolService                    │
│         + autonomyTools.ts  (6 new tools)                 │
└───────────────────────────┬──────────────────────────────┘
                            │  consumed by
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
          Void          Power Mode      Sub-agents
         (auto)        (NL interface)   (optional)

┌──────────────────────────────────────────────────────────┐
│         Progress Tab — section 12 (headless fallback)     │
│  Status tile · Stage bar · Escalation list · Start/Stop   │
└──────────────────────────────────────────────────────────┘
```

---

## File structure

```
browser/engine/autonomy/
  impl/
    autonomyTypes.ts          — all shared types and defaults
    autonomyScheduler.ts      — unit selection and priority ordering
    autoApprovalPolicy.ts     — gate logic: auto-approve or escalate
    autonomyLoop.ts           — single-unit state machine
    batchAutonomyEngine.ts    — pool-of-promises batch runner
    autonomyMetrics.ts        — metrics collection and formatting
  service.ts                  — IAutonomyService DI interface
  AutonomyServiceImpl.ts      — full implementation
  index.ts                    — DI registration + public re-exports

browser/engine/agentTools/impl/
  autonomyTools.ts             — 6 agent tools (second pass)
```

---

## Data types

### `AutonomyStage`

```typescript
type AutonomyStage = 'resolve' | 'translate' | 'validate' | 'commit';
```

Each stage maps to one downstream service call:

| Stage | Service called | Unit status transition |
|-------|---------------|----------------------|
| `resolve` | `ISourceResolutionService.resolveUnit()` | `pending` → `ready` |
| `translate` | `ITranslationEngineService.translateUnit()` | `ready` → `review` |
| `validate` | `IValidationEngineService.validateUnit()` | `approved` → `validated` |
| `commit` | `ICutoverService.commitBatch({ unitIds })` | `validated` → `committed` |

Note: the `review → approved` transition is handled internally by `autoApprovalPolicy`, not by an external service.

---

### `IAutonomyOptions`

```typescript
interface IAutonomyOptions {
  /** Which stages to run. Default: all four. */
  stages:            AutonomyStage[];
  /** Max parallel units. Default: 2. */
  maxConcurrency:    number;
  /** Stall threshold — escalate after N consecutive errors. Default: 3. */
  maxRetriesPerUnit: number;
  /**
   * When true: low/medium-risk units that pass all auto-approval checks
   * are transitioned to 'approved' automatically.
   * When false (default): all units are escalated at the review stage.
   */
  autoApprove:       boolean;
  /** Only process units in these domains. Undefined = all domains. */
  domainFilter?:     string[];
  /** When true, domainFilter becomes an exclusion list. */
  excludeDomains?:   boolean;
  /** Only process units assigned to these phaseIds. */
  phaseFilter?:      string[];
}

const DEFAULT_AUTONOMY_OPTIONS: Required<IAutonomyOptions> = {
  stages:            ['resolve', 'translate', 'validate', 'commit'],
  maxConcurrency:    2,
  maxRetriesPerUnit: 3,
  autoApprove:       false,
  domainFilter:      [],
  excludeDomains:    false,
  phaseFilter:       [],
};
```

---

### `IAutonomyUnitResult`

```typescript
interface IAutonomyUnitResult {
  unitId:             string;
  unitName:           string;
  stageCompleted:     AutonomyStage | null;   // null if skipped
  outcome:            'advanced' | 'escalated' | 'error' | 'skipped';
  durationMs:         number;
  errorMsg?:          string;
  escalationReason?:  string;
}
```

---

### `IEscalatedUnit`

```typescript
interface IEscalatedUnit {
  unitId:       string;
  unitName:     string;
  riskLevel:    string;
  domain?:      string;
  reason:       string;   // human-readable explanation
  escalatedAt:  number;
}
```

---

### `IAutonomyBatchMetrics`

```typescript
interface IAutonomyBatchMetrics {
  totalProcessed: number;
  advanced:       number;   // units that moved to next stage
  escalated:      number;   // units that need human decision
  errors:         number;   // units that hit an engine error
  skipped:        number;   // units already in terminal state or locked
  byStage:        Record<AutonomyStage, number>;   // completions per stage
  startedAt:      number;
  completedAt:    number;
  durationMs:     number;
}
```

---

## The unit state machine (`autonomyLoop.ts`)

For each unit the loop reads `unit.status` and dispatches:

```
status = 'pending'
  → lock unit
  → ISourceResolutionService.resolveUnit(unitId)
  → on success: unit transitions to 'ready' (service handles KB write)
  → outcome: 'advanced'

status = 'ready'
  → lock unit
  → ITranslationEngineService.translateUnit(unitId)
  → on success: unit transitions to 'review'
  → outcome: 'advanced'

status = 'review'
  → run autoApprovalPolicy(unit)
  → if 'approved' AND options.autoApprove:
      kb.setUnitStatus(unitId, 'approved')
      outcome: 'advanced'
  → if 'escalate':
      record IEscalatedUnit with reason
      emit onUnitEscalated
      outcome: 'escalated'  (unit stays in 'review')

status = 'approved'
  → lock unit
  → IValidationEngineService.validateUnit(unitId)
  → on success: unit transitions to 'validated' or 'flagged'
  → if 'flagged': escalate (divergence — needs human override)
  → outcome: 'advanced' | 'escalated'

status = 'validated'
  → ICutoverService.commitBatch({ eligibleStatuses: ['validated'], unitIds: [unitId] })
  → on success: unit transitions to 'committed'
  → outcome: 'advanced'

status = 'flagged'
  → escalate immediately (divergence needs override before proceeding)
  → outcome: 'escalated'

status = 'committed' | 'complete' | 'skipped' | 'blocked'
  → nothing to do
  → outcome: 'skipped'

any other status (resolving, translating, validating)
  → unit is mid-flight in another process; skip
  → outcome: 'skipped'
```

### Error handling

On any engine error:
1. Check the unit's retry annotation counter (stored as a KB annotation by the loop)
2. If counter < `maxRetriesPerUnit`: increment counter, leave unit in current status for retry on next iteration
3. If counter >= `maxRetriesPerUnit`: escalate — add KB annotation explaining all attempts, emit `onUnitEscalated`, set `outcome: 'escalated'`

The loop never throws. Every error path returns an `IAutonomyUnitResult`.

---

## Auto-approval policy (`autoApprovalPolicy.ts`)

Returns `'approved'` or `'escalate'`. Evaluated at the `review` stage only.

### Always escalate (hard gates — not configurable)

| Condition | Reason |
|-----------|--------|
| `unit.riskLevel === 'critical'` | Highest-risk units always require human sign-off |
| `unit.riskLevel === 'high'` | High-risk units always require human sign-off |
| Domain matches regulated pattern (PII / PCI / PHI / GDPR / HIPAA / SOX) | Regulatory compliance requires human approval |
| `unit.fingerprintComparison?.overallResult === 'blocked'` | Regulatory logic changed — compliance officer approval required |
| `unit.pendingDecisionId` is set | Unresolved question blocks auto-approval |

### Configurable gates (checked when `autoApprove: true`)

| Condition | Result |
|-----------|--------|
| `fingerprintComparison.overallResult === 'warning'` | `escalate` |
| Any `preservationRequired: true` business rule absent from modern fingerprint | `escalate` |
| All checks pass | `approved` |

### When `autoApprove: false` (default)

All units that reach the `review` stage are escalated regardless of check results. The agent never self-approves when the option is off.

---

## Batch engine (`batchAutonomyEngine.ts`)

Same pool-of-promises pattern as `batchTranslationEngine` and `batchValidationEngine`:

```typescript
const inFlight = new Set<Promise<void>>();

for (const unit of scheduler.getUnits()) {
  if (signal.aborted) { break; }

  while (inFlight.size >= options.maxConcurrency) {
    await Promise.race(inFlight);
  }

  const job = runAutonomyLoop(unit.id, ...).then(result => {
    inFlight.delete(job);
    metrics.record(result);
    onProgress({ type: 'unit-completed', result });
  });

  inFlight.add(job);
  onProgress({ type: 'unit-started', unitId: unit.id });
}

await Promise.all(inFlight);
onProgress({ type: 'batch-completed', metrics: metrics.snapshot() });
```

---

## Service interface (`service.ts`)

```typescript
export const IAutonomyService = createDecorator<IAutonomyService>('autonomyService');

export interface IAutonomyService {
  readonly _serviceBrand: undefined;

  // State
  readonly isRunning:         boolean;
  readonly lastBatchMetrics:  IAutonomyBatchMetrics | null;
  readonly escalatedUnits:    IEscalatedUnit[];

  // Events
  readonly onProgress:       Event<IAutonomyProgress>;
  readonly onUnitEscalated:  Event<IEscalatedUnit>;

  // API
  startBatch(options?: IAutonomyOptions): Promise<IAutonomyBatchMetrics>;
  stopBatch(): void;
  clearEscalations(): void;
}

export class AutonomyBatchAlreadyRunningError extends Error { ... }
```

---

## Service implementation (`AutonomyServiceImpl.ts`)

Constructor DI:

```typescript
constructor(
  @IKnowledgeBaseService       private readonly _kb:         IKnowledgeBaseService,
  @ISourceResolutionService    private readonly _resolution: ISourceResolutionService,
  @ITranslationEngineService   private readonly _translation: ITranslationEngineService,
  @IValidationEngineService    private readonly _validation:  IValidationEngineService,
  @ICutoverService             private readonly _cutover:     ICutoverService,
) {}
```

---

## Agent tools — second pass (`autonomyTools.ts`)

Six MCP-compatible tools registered with `IModernisationAgentToolService`. Available to Void, Power Mode, and sub-agents.

### `start_autonomy_batch`
Start the autonomy loop.

**Parameters:**
```
stages?:          string[]   // 'resolve' | 'translate' | 'validate' | 'commit'
maxConcurrency?:  number     // default 2
autoApprove?:     boolean    // default false
domainFilter?:    string[]   // domain names to include (or exclude)
excludeDomains?:  boolean    // invert domainFilter to exclusion list
phaseFilter?:     string[]   // phaseIds to restrict to
```

**Returns:** confirmation message + count of eligible units found.

---

### `stop_autonomy_batch`
Cancel the running batch gracefully.

**Parameters:** none

**Returns:** final metrics snapshot from the interrupted batch.

---

### `get_autonomy_status`
Read current loop state.

**Returns:**
```
status:           'running' | 'idle'
isRunning:        boolean
escalatedCount:   number
lastBatchMetrics: IAutonomyBatchMetrics | null   // null if never run
```

---

### `get_escalated_units`
List all units that need a human decision.

**Returns:** `IEscalatedUnit[]` with `unitId`, `unitName`, `riskLevel`, `domain`, `reason`, `escalatedAt`.

Power Mode presents this list to the human and asks for decisions.

---

### `resolve_escalation`
Provide a human decision for an escalated unit.

**Parameters:**
```
unitId:   string
decision: 'approve'           // manually approve → sets status to 'approved'
        | 'skip'              // mark as 'skipped'
        | 'revert-to-pending' // reset to 'pending' for a fresh attempt
        | 'block'             // mark as 'blocked' with reason
reason?:  string              // documented rationale (required for 'approve' and 'block')
```

**Returns:** updated unit status.

---

### `run_single_unit`
Run one specific unit through its next stage immediately, bypassing the scheduler.

**Parameters:**
```
unitId:       string
stage?:       AutonomyStage   // force a specific stage; default: inferred from status
autoApprove?: boolean         // override the batch setting for this unit only
```

**Returns:** `IAutonomyUnitResult`.

---

## Sub-agent integration (optional, second pass)

A new `'migration'` role added to `neuralInverseSubAgentService`:

**Tool whitelist for migration sub-agent:**
- `start_autonomy_batch`
- `stop_autonomy_batch`
- `get_autonomy_status`
- `get_escalated_units`
- `run_single_unit`
- Read-only KB tools: `get_unit_context`, `get_next_unit`, `get_decisions`, `get_progress`

The verifier sub-agent role gets `run_single_unit` + `get_autonomy_status` only — it can spot-check specific units but cannot start or stop the full batch.

All sub-agent activity flows through the same `IAutonomyService` singleton — no duplicate KB writes, no lock conflicts.

---

## Progress tab — section 12

Added to `buildProgressView()` as the final section:

```
┌─ Autonomous Migration ───────────────────────────────────┐
│  Status: [Idle / Running]                                 │
│                                                           │
│  Advanced  Escalated  Errors  Skipped                     │
│  [  42  ]  [   3   ]  [  1 ] [  12 ]                     │
│                                                           │
│  Stages:  ██████░░░░ Resolve 18  Translate 14             │
│           ░░░░░░░░░░ Validate 8   Commit 2                │
│                                                           │
│  Escalations:                                             │
│  ⚠ CALC-LATE-FEE   high risk — auto-approval not eligible │
│  ⚠ PCI-ENCRYPT     regulated domain                       │
│  ⚠ PROCESS-CLAIM   3 retries exhausted                    │
│                                                           │
│  [ Start Autonomy ]  [ Stop ]                             │
└──────────────────────────────────────────────────────────┘
```

---

## Wiring changes

| File | Change |
|------|--------|
| `neuralInverseModernisation.contribution.ts` | `import './engine/autonomy/index.js'` |
| `engine/agentTools/impl/autonomyTools.ts` | New file — 6 tools (second pass) |
| `engine/agentTools/mcpToolDefinitions.ts` | Register 6 tool definitions (second pass) |
| `ui/console/progressView.ts` | Section 12: status tiles, stage bar, escalation list, Start/Stop |
| `ui/console/modernisationConsole.ts` | 5th constructor arg `_autonomy: IAutonomyService \| undefined` |
| `ui/modernisationPart.ts` | `@IAutonomyService` injection, pass to console |

---

## Hard constraints

1. `critical` and `high` risk units are **never auto-approved** — always escalated to human review regardless of fingerprint result or `autoApprove` setting.
2. Regulated domain units (PII/PCI/PHI/GDPR/HIPAA/SOX) are **never auto-approved**.
3. `autoApprove` defaults to **`false`** — must be explicitly enabled. The agent advances units to `'approved'` only when the option is on and all checks pass.
4. Final `approveCutover()` is **always human-triggered** — the autonomy loop runs `commitBatch()` for individual validated units but never calls `approveCutover()`.
5. One batch at a time — `AutonomyBatchAlreadyRunningError` if already running.
6. Sub-agent integration is **additive only** — no changes to existing `neuralInverseSubAgentService` contract; new role added via extension.

---

## Build order

### Pass 1 — Standalone service (this session)
1. `impl/autonomyTypes.ts`
2. `impl/autonomyScheduler.ts`
3. `impl/autoApprovalPolicy.ts`
4. `impl/autonomyLoop.ts`
5. `impl/batchAutonomyEngine.ts`
6. `impl/autonomyMetrics.ts`
7. `service.ts`
8. `AutonomyServiceImpl.ts`
9. `index.ts`
10. Wire: `contribution.ts`, `progressView.ts`, `modernisationConsole.ts`, `modernisationPart.ts`

### Pass 2 — Agent tool integration
1. `engine/agentTools/impl/autonomyTools.ts` (6 tools)
2. `engine/agentTools/mcpToolDefinitions.ts` (register tools)
3. Sub-agent `'migration'` role (optional)
