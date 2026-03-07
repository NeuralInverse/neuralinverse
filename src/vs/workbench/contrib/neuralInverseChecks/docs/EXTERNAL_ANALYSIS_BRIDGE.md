# External Analysis Bridge — Technical Plan

**Status:** Planned — Ready to implement
**Owner:** Neural Inverse Platform
**Context:** Replaces `ExternalCheckRunner` with a production-grade external analysis bridge

---

## Why This Exists

The regulated sectors Neural Inverse targets (healthcare, finance, automotive, aerospace) already have
external analysis toolchains they are contractually or legally required to use:

| Sector | Tool | Standard |
|--------|------|----------|
| Automotive | MATLAB/Simulink, Polyspace | ISO 26262 |
| Aerospace | SCADE, MATLAB Coder | DO-178C |
| Medical | Polyspace, custom validators | IEC 62304 |
| Finance | Semgrep, CodeQL, Snyk | SOC 2, PCI-DSS |
| General | ESLint, Checkstyle, PMD | Internal policy |

These teams do NOT want to replace their tools — they want Neural Inverse to be the IDE layer that
**calls their tools, surfaces results, and captures audit evidence** without context switching.

SARIF (Static Analysis Results Interchange Format) is the industry-standard output format that
CodeQL, Semgrep, Snyk, and GitHub Advanced Security all emit. One parser works across all of them.

---

## Current State — What Exists and What's Broken

### `ExternalCheckRunner` (exists, inadequate)

Location: `browser/engine/services/externalCheckRunner.ts`

**What works:**
- Per-file rule evaluation dispatch
- Basic JSON / line-per-violation / SARIF (partial) parsing
- 60-second time-based result cache

**What's broken:**

| Problem | Impact |
|---------|--------|
| `child_process` via `globalThis.require` — broken in sandboxed Electron renderer | Commands never run |
| Per-file design — calls tool once per file | 100+ CodeQL invocations per workspace scan |
| Time-based cache (60s) — re-runs even when nothing changed | Wastes minutes on Polyspace re-runs |
| SARIF parser doesn't map multi-file results to correct file URIs | All violations attributed to wrong file |
| No tool availability check | Silent failure when binary not installed |
| No job lifecycle | No progress, no cancellation, no status in UI |

---

## Architecture

```
GRCEngineService.scanWorkspace()
        │
        ├── Static scan (regex / AST / dataflow / import-graph) ← unchanged
        │
        └── IExternalToolService.runWorkspaceScans(workspaceScopedRules)
                  │
                  ├── ExternalToolDetector  — is 'semgrep' in PATH?
                  ├── ExternalResultCache   — workspace fingerprint hash match? (skip if yes)
                  ├── ExternalCommandExecutor — terminal redirect → temp file → poll → read
                  ├── ExternalOutputParsers — SARIF / Polyspace / MATLAB / ESLint / Checkstyle
                  └── grcEngine.setExternalResults(fileUri, ruleId, results)
                                                └── fires onDidCheckComplete per file


GRCEngineService.evaluateFileContent(fileUri, content)  [file-scope external rules]
        │
        └── IExternalToolService.runFileScans(fileRules, fileUri, content)
                  │  (fire-and-forget — results injected async)
                  └── same pipeline as above, scoped to single file
```

---

## Part 1 — Schema Extension

**File:** `browser/engine/framework/frameworkSchema.ts`

Extend `IExternalCheck` with:

```typescript
export interface IExternalCheck {
    type: 'external';
    command: string;

    // NEW: run once per workspace or once per file
    // workspace = CodeQL, Semgrep, Polyspace (analyze entire project at once)
    // file      = MATLAB mlint, fast per-file linters
    scope?: 'file' | 'workspace';                       // default: 'file'

    // Extended vendor formats (in addition to existing json/line-per-violation/sarif)
    parseOutput: 'json'
               | 'line-per-violation'
               | 'sarif'                                 // full v2.1
               | 'polyspace-csv'
               | 'polyspace-xml'
               | 'matlab-mlint'
               | 'eslint-json'
               | 'checkstyle-xml';

    // NEW: check binary exists before running, skip gracefully if not found
    toolBinary?: string;                                 // e.g. 'semgrep', 'matlab'
    toolVersionCommand?: string;                         // e.g. 'semgrep --version'

    // NEW: hash-based cache — only re-run if files changed since last run
    cacheStrategy?: 'content-hash' | 'time' | 'never';  // default: 'content-hash'

    // NEW: extra environment variables (license servers, API keys via ${env:VAR})
    env?: Record<string, string>;

    // NEW: where to run the command
    workingDirectory?: 'workspace' | 'file-dir';        // default: 'workspace'

    resultMapping?: {
        line?: string;
        column?: string;
        endLine?: string;
        endColumn?: string;
        message?: string;
        severity?: string;
    };

    timeoutMs?: number;                                  // default: 30000
    maxOutputBytes?: number;                             // default: 5MB (5_242_880)
}
```

**Variable substitutions in `command`:**
- `${file}` — absolute path to the file (file-scope only)
- `${workspace}` — absolute path to workspace root
- `${relativeFile}` — file path relative to workspace root
- `${env:VAR}` — value of environment variable VAR

**Framework rule examples:**

```json
{
  "id": "SEMGREP-OWASP-001",
  "title": "OWASP Top 10 — Semgrep",
  "severity": "error",
  "category": "security",
  "check": {
    "type": "external",
    "scope": "workspace",
    "command": "semgrep --config=p/owasp-top-ten --sarif ${workspace}",
    "parseOutput": "sarif",
    "toolBinary": "semgrep",
    "cacheStrategy": "content-hash",
    "timeoutMs": 120000
  }
}
```

```json
{
  "id": "POLYSPACE-001",
  "title": "Polyspace — Runtime Errors",
  "severity": "blocker",
  "category": "reliability",
  "check": {
    "type": "external",
    "scope": "workspace",
    "command": "polyspace-bug-finder -sources ${workspace}/src -results-dir ${workspace}/.polyspace",
    "parseOutput": "polyspace-xml",
    "toolBinary": "polyspace-bug-finder",
    "cacheStrategy": "content-hash",
    "timeoutMs": 1800000
  }
}
```

```json
{
  "id": "MATLAB-MLINT-001",
  "title": "MATLAB Code Analyzer",
  "severity": "warning",
  "category": "reliability",
  "check": {
    "type": "external",
    "scope": "file",
    "command": "matlab -batch \"mlint -id '${file}'\"",
    "parseOutput": "matlab-mlint",
    "toolBinary": "matlab",
    "cacheStrategy": "content-hash",
    "timeoutMs": 30000
  }
}
```

---

## Part 2 — New Types

**File:** `browser/engine/types/externalJobTypes.ts` (NEW)

```typescript
export type ExternalJobStatus =
    | 'queued'
    | 'running'
    | 'complete'
    | 'failed'
    | 'cancelled'
    | 'skipped';

export type ExternalJobSkipReason =
    | 'tool-not-found'    // binary not in PATH
    | 'cache-hit'         // content hash unchanged since last run
    | 'no-workspace'      // no workspace folder open
    | 'license-error';    // tool found but license check failed

export interface IExternalJob {
    id: string;                          // unique: `${ruleId}:${scope}:${targetUri ?? 'ws'}`
    ruleId: string;
    toolName: string;                    // from toolBinary, or parsed from first token of command
    scope: 'file' | 'workspace';
    targetUri?: URI;                     // only for file-scope
    status: ExternalJobStatus;
    queuedAt: number;
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
    error?: string;
    resultCount: number;
    cacheHit: boolean;
    skipReason?: ExternalJobSkipReason;
}
```

---

## Part 3 — Tool Detection

**File:** `browser/engine/services/externalToolDetector.ts` (NEW)

Static class (no DI required). Checks whether a binary is available in PATH.

```
ExternalToolDetector
├── isAvailable(binaryName, execFn): Promise<boolean>
│     ├── Unix:    which semgrep        → exit 0 = found
│     ├── Windows: where semgrep.cmd   → exit 0 = found
│     └── Cache: 60s TTL per binary name
│
└── getVersion(binaryName, versionCommand, execFn): Promise<string | undefined>
      └── e.g. 'semgrep --version' → '1.45.0'
```

**Why static class not DI service:** Tool detection is a pure utility. It needs an exec function
passed in (not hardwired), making it trivially testable and reusable by both
`ExternalToolService` and any future component.

**Cache strategy:** Module-level `Map<string, {available: boolean, checkedAt: number}>`.
Re-checks after 60s (covers cases where tool is installed mid-session).

---

## Part 4 — Output Parsers

**File:** `browser/engine/services/externalOutputParsers.ts` (NEW)

All parser functions return `Map<fileUriString, ICheckResult[]>` to support multi-file output
from a single tool run (CodeQL, Semgrep, Polyspace all report across multiple files).

### SarifParser — Full SARIF v2.1

The key parser. Handles output from CodeQL, Semgrep, Snyk, GitHub Advanced Security.

**What the current basic parser misses:**
- `result.locations[].physicalLocation.artifactLocation.uri` — which file the violation is in
- `run.tool.driver.rules[]` — rule metadata (full description, help URI, tags)
- `result.fixes[]` — suggested fix text
- `result.fingerprints` — deduplication across runs
- `run.artifacts[]` — resolves relative URIs to absolute paths

**Implementation:**
```
SarifParser.parse(sarifJson, defaultRule, workspaceRoot, timestamp)
    → Map<fileUri, ICheckResult[]>

Steps:
1. Parse JSON
2. For each run in runs[]:
   a. Build ruleMap: run.tool.driver.rules[] indexed by ruleId
   b. Build artifactMap: run.artifacts[] for URI resolution
   c. For each result in run.results[]:
      - ruleId = result.ruleId
      - message = result.message.text (or markdown)
      - severity = sarifLevelToSeverity(result.level)
                   override with ruleMap[ruleId].defaultConfiguration.level
      - fix = result.fixes[0].description.text (if present)
      - for each location in result.locations[]:
          * resolve artifactLocation.uri → absolute file path
          * region = physicalLocation.region
          * create ICheckResult for that file
3. Return Map<fileUri, results[]>
```

**Severity mapping:**
```
SARIF level    → Neural Inverse severity
'error'        → 'error'
'warning'      → 'warning'
'note'         → 'info'
'none'         → 'info'
(unset)        → use rule's defaultConfiguration.level or 'warning'
```

### PolyspaceParser

Polyspace Bug Finder and Code Prover output.

**CSV format** (Polyspace 2018 and earlier):
```
File,Function,Check,Category,Color,Line,Col,Comment
src/ctrl.c,PID_Control,Overflow,Numerical,Red,142,8,""
```
Color → severity: `Red=error`, `Orange=warning`, `Green=info`

**XML format** (Polyspace 2019+):
```xml
<polyspace-results>
  <defect file="src/ctrl.c" line="142" col="8" category="Numerical"
          check="Overflow" color="red" function="PID_Control" />
</polyspace-results>
```

### MatlabMlintParser

MATLAB Code Analyzer (`mlint`) output. Single-file only (file-scope).

**Format:**
```
L 42 (C 1-8): FNDEF: Missing function definition end.
L 67 (C 12): AGROW: Variable 'data' appears to change size on every loop iteration.
```

**Regex:** `/^L (\d+) \(C (\d+)(?:-(\d+))?\): (\w+): (.+)$/`

Groups: `line`, `colStart`, `colEnd`, `mlintId`, `message`

### EslintJsonParser

ESLint `--format=json` output. Multi-file.

```json
[
  {
    "filePath": "/abs/path/to/file.js",
    "messages": [
      { "line": 10, "column": 5, "severity": 2, "message": "...", "ruleId": "no-eval" }
    ]
  }
]
```

ESLint severity: `2=error`, `1=warning`

### CheckstyleXmlParser

Checkstyle XML output. Used by Java Checkstyle, PMD, SpotBugs. Multi-file.

```xml
<checkstyle>
  <file name="/abs/path/File.java">
    <error line="10" column="5" severity="error" message="..." source="CheckName"/>
  </file>
</checkstyle>
```

---

## Part 5 — Command Executor

**File:** `browser/engine/services/externalCommandExecutor.ts` (NEW)

**The core problem:** `child_process` is not available in VS Code's sandboxed Electron renderer.
`ITerminalService.sendText()` works but is fire-and-forget — no stdout capture.

**Solution: Terminal redirect → temp file → poll → read**

```
execute(command, options: { timeoutMs, maxOutputBytes, env, workingDir, jobId })
    → Promise<string>  (stdout content)

Steps:
1. Generate temp paths:
       /tmp/ni_ext_${jobId}.out    ← stdout
       /tmp/ni_ext_${jobId}.err    ← stderr
       /tmp/ni_ext_${jobId}.exit   ← exit code sentinel

2. Build wrapped command:
       cd "${workingDir}" && \
       export KEY=VALUE && \           ← from env
       (${original_command}) \
         > /tmp/ni_ext_${jobId}.out \
         2> /tmp/ni_ext_${jobId}.err; \
       echo $? > /tmp/ni_ext_${jobId}.exit

3. Get or create "Neural Inverse Ops" terminal (reuse from IInverseAccessService)
   terminal.sendText(wrappedCommand, true)

4. Poll IFileService.exists(/tmp/ni_ext_${jobId}.exit) every 500ms
   Stop polling when: file exists OR elapsed > timeoutMs

5. On timeout: send 'kill %1' to terminal (best-effort), throw TimeoutError

6. Read /tmp/ni_ext_${jobId}.exit → exit code
   Read /tmp/ni_ext_${jobId}.out  → stdout

7. Validate: stdout.length <= maxOutputBytes (trim with warning if exceeded)

8. Delete all three temp files via IFileService

9. Return stdout (even on non-zero exit — linters return non-zero when violations found)
```

**Why this works:**
- Terminal has full shell access, not subject to Electron sandbox restrictions
- IFileService reads local disk (always available)
- Exit code sentinel file is atomic (written after command completes)
- Works for any command: Semgrep, MATLAB, Polyspace, custom scripts

**Cancellation:**
- Track `jobId → terminalPid` mapping
- On cancel: `terminal.sendText('kill %1', true)` + delete temp files

---

## Part 6 — Content-Hash Cache

**File:** `browser/engine/services/externalResultCache.ts` (NEW)

Replaces the naive 60-second time-based cache with content-aware caching.

**Storage:** `IStorageService` (WORKSPACE scope, MACHINE target)

```
Key pattern:
  grc.extcache.v1.{ruleId}.hash     → string (SHA-256 hex)
  grc.extcache.v1.{ruleId}.results  → string (JSON)
  grc.extcache.v1.{ruleId}.ts       → string (ISO timestamp of last run)
```

**File-scope hash:**
- SHA-256 of file content
- Recomputed each time `runFileScans()` is called
- If hash matches stored hash → return cached results, skip tool invocation

**Workspace-scope fingerprint:**
- Recursively stat all scannable files (js/ts/py/c/java etc.)
- Build sorted array of `{ relPath: string, mtime: number }`
- SHA-256 of JSON string of that array
- **Fast:** uses `IFileStat` (mtime only), not file content reads
- If fingerprint matches → return cached results, skip tool invocation

**Implementation:**
```typescript
class ExternalResultCache {
    get(ruleId: string, currentHash: string): ICheckResult[] | undefined
    set(ruleId: string, hash: string, results: ICheckResult[]): void
    clear(ruleId?: string): void
    computeFileHash(content: string): string
    computeWorkspaceFingerprint(workspaceUri: URI, fileService: IFileService): Promise<string>
}
```

**Serialisation:** `ICheckResult[]` serialised as JSON. `URI` fields serialised as strings,
deserialised via `URI.parse()` on read.

---

## Part 7 — External Tool Service

**File:** `browser/engine/services/externalToolService.ts` (NEW)

The orchestration layer. Manages job queue, dispatches to executor, injects results into engine.

**DI:**
```
@IGRCEngineService
@ITerminalService
@IFileService
@IStorageService
@IWorkspaceContextService
```

**Interface:**
```typescript
export const IExternalToolService = createDecorator<IExternalToolService>('neuralInverseExternalToolService');

export interface IExternalToolService {
    readonly _serviceBrand: undefined;

    // Fires on every job state change (queued → running → complete/failed/skipped)
    readonly onDidJobUpdate: Event<IExternalJob>;

    // Current job list (all statuses)
    getJobs(): IExternalJob[];

    // Called by GRCEngineService.scanWorkspace() for workspace-scoped rules
    runWorkspaceScans(rules: IGRCRule[]): Promise<void>;

    // Called by GRCEngineService.evaluateFileContent() for file-scoped rules
    // Fire-and-forget: results arrive via grcEngine.setExternalResults()
    runFileScans(rules: IGRCRule[], fileUri: URI, content: string): void;

    cancelAll(): Promise<void>;
    isToolAvailable(binary: string): Promise<boolean>;
}
```

**Job queue:**
```
Max concurrent: 2 (workspace-scope) + 2 (file-scope) = 4 total
Priority: file-scope > workspace-scope (user is actively editing)
Deduplication: one job per ruleId+scope+targetUri at a time
```

**Workspace scan flow:**
```
runWorkspaceScans(rules):
  workspaceRules = rules.filter(r => r.check.scope === 'workspace')
  for each rule:
    1. toolBinary check → skip if not found (status: skipped, skipReason: tool-not-found)
    2. compute workspace fingerprint
    3. cache check → skip if hash matches (status: skipped, skipReason: cache-hit)
    4. enqueue job
    5. (when dequeued):
       a. run ExternalCommandExecutor.execute(command, options)
       b. parse output with correct parser → Map<fileUri, ICheckResult[]>
       c. for each file: grcEngine.setExternalResults(uri, ruleId, results)
       d. cache.set(ruleId, fingerprint, flatResults)
       e. job.status = 'complete', fire onDidJobUpdate
```

**File scan flow:**
```
runFileScans(rules, fileUri, content):
  fileRules = rules.filter(r => r.check.scope !== 'workspace')  // default: 'file'
  for each rule:
    1. toolBinary check
    2. fileHash = cache.computeFileHash(content)
    3. cache check
    4. enqueue job (lower priority than workspace? No — file-scope IS higher priority)
    5. (when dequeued): same pipeline, but command uses ${file} substitution
```

**Result injection:**
```
grcEngine.setExternalResults(fileUri, ruleId, results):
  existing = _resultsByFile.get(fileUri) ?? []
  // Remove old results from this ruleId
  filtered = existing.filter(r => r.ruleId !== ruleId)
  merged = [...filtered, ...results]
  _resultsByFile.set(fileUri, merged)
  _onDidCheckComplete.fire(merged)   // diagnostics refreshes markers
```

---

## Part 8 — Engine Changes

**File:** `browser/engine/services/grcEngineService.ts`

### Add to interface:
```typescript
// Merge externally-produced results and notify consumers
setExternalResults(fileUri: URI, ruleId: string, results: ICheckResult[]): void;
```

### Change `evaluateDocument()`:
Skip `type: 'external'` rules — handled async by `IExternalToolService`:
```typescript
const rules = allRules.filter(r => r.enabled && (r.type ?? 'regex') !== 'external');
```

### Change `evaluateFileContent()`:
Same filter + after static evaluation, trigger file-scope external rules:
```typescript
const staticRules = allRules.filter(r => r.enabled && (r.type ?? 'regex') !== 'external');
// ... static evaluation ...

// Trigger async file-scope external checks
const externalRules = allRules.filter(r => r.enabled && r.type === 'external');
if (externalRules.length > 0) {
    this.externalToolService.runFileScans(externalRules, fileUri, content);
}
```

### Change `scanWorkspace()`:
After static scan, trigger workspace-scope external checks:
```typescript
const externalRules = this._configLoader.getRules()
    .filter(r => r.enabled && r.type === 'external' && r.check?.scope === 'workspace');
if (externalRules.length > 0) {
    this.externalToolService.runWorkspaceScans(externalRules);
    // runWorkspaceScans is async but we don't await — results arrive via setExternalResults
}
```

### Add `@IExternalToolService` to constructor DI.

---

## Part 9 — Analyzer Registration Cleanup

**File:** `browser/engine/analyzers/analyzerRegistration.ts`

Remove `ExternalCheckRunner` registration. `IExternalToolService` replaces it entirely.

**File:** `browser/engine/services/externalCheckRunner.ts`

Mark as deprecated (keep temporarily), then delete after `IExternalToolService` is verified.

---

## Part 10 — UI Jobs Panel

**File:** `checksManagerPart.ts`

Add "External Tools" section to dashboard injected below the domain summary.

Subscribe to `IExternalToolService.onDidJobUpdate` (injected via new DI param).

**Visual design:**
```
EXTERNAL TOOLS                                    [2 running · 1 cached]

  ● semgrep (OWASP Top 10)     running    42s ...          [Cancel]
  ● codeql (security)          running    1m 12s ...       [Cancel]
  ✓ polyspace (reliability)    complete   2m 14s · 7 hits  [cached]
  ○ matlab (mlint)             skipped    tool not found
  ✗ eslint (policy)            failed     timeout 30s       [Retry]
```

Status dot colours: `●=blue (running)`, `✓=green`, `✗=red`, `○=muted (skipped)`

No webview re-render on job update — update only the external tools section DOM node
using `postMessage` to the running webview, preserving interaction lock.

---

## File Summary

| File | Action | Priority |
|------|--------|----------|
| `engine/framework/frameworkSchema.ts` | Extend `IExternalCheck` | 1 |
| `engine/types/externalJobTypes.ts` | **NEW** — job types | 1 |
| `engine/services/externalToolDetector.ts` | **NEW** — binary availability | 2 |
| `engine/services/externalOutputParsers.ts` | **NEW** — SARIF/Polyspace/MATLAB/ESLint/Checkstyle | 2 |
| `engine/services/externalCommandExecutor.ts` | **NEW** — terminal redirect + polling | 3 |
| `engine/services/externalResultCache.ts` | **NEW** — content-hash cache | 3 |
| `engine/services/externalToolService.ts` | **NEW** — orchestration, job queue | 4 |
| `engine/services/grcEngineService.ts` | Add `setExternalResults()`, filter external rules, call service in scan | 4 |
| `engine/analyzers/analyzerRegistration.ts` | Remove `ExternalCheckRunner` | 5 |
| `engine/services/externalCheckRunner.ts` | Delete (replaced) | 5 |
| `neuralInverseChecks.contribution.ts` | Import `externalToolService.js` | 5 |
| `checksManagerPart.ts` | Subscribe to job updates, render jobs panel | 6 |

---

## Implementation Order

```
Step 1  frameworkSchema.ts extension          — schema only, no logic
Step 2  externalJobTypes.ts                   — types only
Step 3  externalToolDetector.ts               — isolated utility, no DI
Step 4  externalOutputParsers.ts              — pure functions, largest file
Step 5  externalCommandExecutor.ts            — needs ITerminalService + IFileService
Step 6  externalResultCache.ts                — needs IStorageService
Step 7  externalToolService.ts                — orchestrates everything above
Step 8  grcEngineService.ts changes           — integration point
Step 9  analyzerRegistration.ts cleanup       — remove old runner
Step 10 UI jobs panel                         — checksManagerPart.ts
```

---

## Key Design Decisions

**Why terminal-redirect for output capture (not IPC to main process)?**

VS Code's main process IPC requires registering a custom channel in `src/main.js` — this touches
the host IDE's core entry point outside our contribution scope. The terminal-redirect approach
(`command > /tmp/file; echo $? > /tmp/file.exit`) is self-contained within our contribution,
uses the same terminal the nano agents already use, and works for any command including those
that take minutes (Polyspace).

**Why workspace-scope by default for CodeQL/Semgrep?**

These tools have 2-10s JVM/Python startup time. Calling per-file = 100x overhead.
They also need cross-file context to detect multi-file vulnerabilities (e.g. SQL injection
where taint source and sink are in different files).

**Why content-hash cache over time-based?**

For a 30-minute Polyspace run, time-based caching (60s stale) re-runs every 60 seconds
whether or not anything changed. Content-hash caching re-runs only when files actually change.
This is critical for long-running tools and respects developer focus time.

**Why `setExternalResults()` instead of re-running `evaluateDocument()`?**

External tool results arrive asynchronously. Calling `evaluateDocument()` again would
re-run ALL static rules, overwriting existing results. `setExternalResults()` surgically
merges only the results from one ruleId, preserving all other violations.

**Why not persist running jobs across IDE restarts?**

Jobs are ephemeral. Results are what matter — they're persisted in `_resultsByFile` and
in `ExternalResultCache`. On restart, the workspace fingerprint check determines whether
to re-run or serve from cache.
