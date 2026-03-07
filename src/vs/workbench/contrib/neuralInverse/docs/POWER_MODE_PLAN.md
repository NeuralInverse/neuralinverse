# Void Power Mode — OpenCode Integration Plan

## Background

We evaluated all major open source agentic coding tools for integration into Void IDE:

| Tool       | Stars | LLM Agnostic | License    | Notes                              |
|------------|-------|--------------|------------|------------------------------------|
| Claude Code | 74k  | No           | Check repo | Anthropic-only LLM                 |
| OpenHands  | 68k   | Yes          | MIT        | Python-based, SWEBench 77.6%       |
| Cline      | 58k   | Yes          | Apache 2.0 | VS Code extension, good fit        |
| Goose      | 32k   | Yes          | Apache 2.0 | MCP support, extensible            |
| Plandex    | 15k   | Yes          | MIT        | Terminal, large multi-file tasks   |
| **OpenCode** | **117k** | **Yes** | **MIT** | **Selected — see reasoning below** |

## Why OpenCode

- Largest community (117k stars, beats Claude Code)
- MIT license — commercially safe to fork and rebrand
- TypeScript 53% — same stack as Void
- Client/server architecture — agent runs as background process, UI is just a client (naturally detachable)
- 75+ LLM providers via Models.dev — plugs directly into Void's BYOLLM story
- Built-in LSP support — understands codebase structure
- Two built-in agents: `build` (full access) + `plan` (read-only) — maps to regulated environments
- Multi-session parallel agents — maps to Workflow orchestration
- Already has IDE extension path in their roadmap

## Architecture Overview

OpenCode uses a client/server model:

```
opencode server (Node.js)       <- Agent brain, LLM calls, tools
- Runs as background process
- Exposes local HTTP/WS API
- Manages sessions

Clients (all connect to same server):
  TUI (ink)    Desktop (Tauri)    IDE Extension (coming)
```

The server is detachable by design. The TUI is just a client.
In Void, we replace the TUI client with a webview panel inside Agent Manager.

## Target UI Layout

```
Agent Manager
[Agents]  [Workflows]  [Power Mode]
--------------------------------------------
Left Panel          |  Right Panel
                    |
Sessions            |  Terminal-style output stream
---------           |  (monospace, ANSI colors)
> Session 1         |
> Session 2         |  > Reading src/auth.ts...
                    |  > Running: tsc --noEmit
Files Changed       |  > 0 errors
---------           |  > Writing fix to auth.ts
auth.ts (edited)    |  > Done
index.ts            |
                    |  [ Type your instruction... ]
Tool Calls          |
---------           |  [Stop]  [Detach]  [New Session]
> read_file         |
> bash              |
> write_file        |
--------------------------------------------
```

Detach button opens an auxiliary VS Code window.
Session continues running when the panel is closed.
Status bar entry: "Power Mode running" — click to reconnect.

## Build Phases

### Phase 0 — Research (Before Writing Code)
- Dig into OpenCode source: server API surface, provider interface, tool execution pipeline
- Identify exact integration points for LLM provider swap and tool interception
- Validate that the server can be embedded as a Node.js child process inside VS Code extension host

### Phase 1 — Fork and Strip
- Fork `sst/opencode` into Void monorepo under:
  `src/vs/workbench/contrib/powerMode/`
- Remove Tauri desktop build
- Keep: `packages/opencode` (server core), TypeScript provider abstraction
- Rename package names: `opencode` -> `void-power-mode`
- Preserve all MIT license headers
- Verify standalone build works

### Phase 2 — Wire ILLMMessageService (Critical Path)
Replace OpenCode's provider layer with Void's existing LLM stack:

```
OpenCode provider interface
        |
VoidProviderAdapter
        |
ILLMMessageService  (existing Void service)
        |
User's configured LLM (Anthropic / OpenAI / Azure / Ollama / etc.)
```

- Map OpenCode's provider config schema to IVoidSettingsService
- Write VoidProviderAdapter implementing OpenCode's model interface
- Inject at server startup — no opencode.json config needed
- BYOLLM works automatically

### Phase 3 — Embed in Agent Manager (Power Mode Tab)
- Add [Power Mode] tab to Agent Manager sidebar
- Webview connects to void-power-mode server via local WebSocket
- Left panel: session list, file change tracker, tool call log
- Right panel: streaming output with ANSI color support
- Input bar at bottom
- Detach button opens auxiliary window (session keeps running)

### Phase 4 — GRC Gates (Core Differentiator)
Intercept destructive tool calls and check against active compliance frameworks:

```
Tool call request
      |
VoidToolGate.check(toolName, args)
      |
neuralInverseChecks GRC engine
      |
   Allow          Block / Require Approval
     |                    |
  Execute         Approval dialog in panel
                  [Allow once] [Allow always] [Deny]
```

- Hook into OpenCode's tool execution pipeline
- `bash`, `write_file`, `git_commit` route through GRC engine
- Inline approval cards shown in output stream
- Every approved/denied tool call logged for audit trail

### Phase 5 — Detachable Window + Status Bar
- On Detach: open auxiliary VS Code window connected to same WS session
- Status bar: `$(sync~spin) Power Mode running` — click to reopen panel
- Session state lives in server process, not the webview
- Reconnect: panel re-subscribes to existing session stream

### Phase 6 — AGENTS.md + Void Context Injection
OpenCode uses `AGENTS.md` for project context. Enhance with Void's GRC knowledge:
- Auto-generate `AGENTS.md` including:
  - Active compliance frameworks from neuralInverseChecks
  - Blocked patterns / restricted APIs for the project
  - Workspace structure summary
- Regenerate on framework changes

## Why This Is the Right Product for Regulated/Critical Software

Claude Code and every other agentic tool gives you NO:
- Audit trail of agent actions
- Approval gates before destructive operations
- Compliance framework awareness
- Air-gap / custom LLM routing

Void Power Mode has ALL of these because the GRC engine is already built.
This is the moat. No one else is building agentic execution for regulated enterprises.

## Key Files to Reference
- GRC Engine: `neuralInverseChecks/browser/engine/services/grcEngineService.ts`
- Contract Reason: `neuralInverseChecks/browser/engine/services/contractReasonService.ts`
- LLM Service: `void/common/sendLLMMessageService.ts`
- Settings Service: `void/common/voidSettingsService.ts`
- Agent Manager UI: `neuralInverse/browser/agentManagerPart.ts`
- Workflow Agent Service: `neuralInverse/browser/workflowAgentService.ts`
- Agentic Mode Service: `neuralInverse/browser/agenticModeService.ts`
