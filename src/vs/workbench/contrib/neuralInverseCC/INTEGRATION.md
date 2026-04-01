# NeuralInverseCC — Integration Plan

Claude Code (CC) source (1,399 files) lives in this directory. All files are
compiled alongside the VS Code build and carry `// @ts-nocheck` so they don't
enforce VS Code's strict rules. Our 8 adapted files are the public surface —
they expose CC logic through VS Code's DI system.

---

## Status

| Layer | Files | Status |
|---|---|---|
| Build compiles cleanly | 1,399 CC + 8 adapted | ✅ Done |
| DI service (`INeuralInverseCCService`) | auto-compact, cost, permissions, skills | ✅ Done |
| Bundled skill loader | `browser/skills/neuralInverseCCSkillLoader.ts` | ✅ Done |
| Tool bridge | `browser/tools/neuralInverseCCToolBridge.ts` | ✅ Done |
| Hooks (Power Mode) | `hooks/` → Power Mode webview | 🔲 Tier 2 |
| Component port (Power Mode) | `components/` Ink → HTML | 🔲 Tier 2 |

---

## Tier 1 — Wire existing CC logic into running services

### 1a. Bundled Skills → `INeuralInverseCCService`

**File:** `browser/skills/neuralInverseCCSkillLoader.ts`

The service already has `registerSkill(skill: SkillDefinition)`.
CC has 11 bundled skills in `skills/bundled/`:

| Skill | Description | Ant-only |
|---|---|---|
| `batch` | Parallel work orchestration across agents | No |
| `stuck` | Diagnose frozen/slow sessions | No |
| `debug` | Enable debug logging + read session log | No |
| `simplify` | Review and clean up code changes | No |
| `remember` | Store facts for later recall | No |
| `skillify` | Convert a workflow into a reusable skill | No |
| `verify` | Verify a code change works | Yes (`USER_TYPE=ant`) |
| `keybindings` | Show/edit keybindings | No |
| `updateConfig` | Update claude settings | No |
| `loremIpsum` | Insert lorem ipsum placeholder text | No |

**Bridge contract:**
- CC: `getPromptForCommand(args, context) → Promise<ContentBlockParam[]>`
- Ours: `getPromptText(args, context) → Promise<string>`
- Adapter: extract `.text` from each `ContentBlockParam`, join with `\n`

### 1b. Tool Bridge → void's `IVoidInternalToolService`

**File:** `browser/tools/neuralInverseCCToolBridge.ts`

CC tools live in `tools/`. Each tool folder has:
- `prompt.ts` — system prompt fragment describing the tool
- `BashTool.tsx` / `FileEditTool.tsx` etc — execute logic
- `toolName.ts` / `constants.ts` — the tool name string

Immediate value: pull CC's **tool prompts** into void's tool descriptions so
the LLM gets the same battle-tested instructions CC ships with.

| CC Tool | void equivalent | Bridge action |
|---|---|---|
| `BashTool` | `terminalToolService` | Use CC's prompt + permission logic |
| `FileEditTool` / `FileReadTool` / `FileWriteTool` | `toolsService` | Use CC's prompts |
| `GlobTool` / `GrepTool` | `toolsService` | Use CC's prompts |
| `WebFetchTool` | `toolsService` | Use CC's full impl |
| `TodoWriteTool` | `toolsService` | Use CC's full impl |
| `AgentTool` | sub-agent system | Reference |
| `TaskCreateTool` etc | `IChecksAgentService` | Reference |

---

## Tier 2 — Port terminal UI to Power Mode webview

### 2a. Hooks → Power Mode

`hooks/` has 76 pure React hooks. Since Power Mode is a React webview these
can be imported with minimal adaptation:

| Hook | Use in Power Mode |
|---|---|
| `useVirtualScroll.ts` | Virtualised message list |
| `useTextInput.ts` | Input field logic |
| `useArrowKeyHistory.tsx` | ↑/↓ command history |
| `useTypeahead.tsx` | `/skill`, `@file` completions |
| `useVimInput.ts` | Vim mode for input |
| `useElapsedTime.ts` | Tool execution timer |
| `useLogMessages.ts` | Stream log display |
| `useDiffData.ts` | Inline diff rendering |
| `useCanUseTool.tsx` | Permission prompt logic |
| `useSettings.ts` | Settings read/write |

### 2b. Components → Power Mode

`components/` has 43 Ink components. Port by swapping Ink primitives:

```
Ink                      HTML equivalent
────────────────────     ──────────────────────────────
<Box flexDirection="…">  <div style={{display:'flex', flexDirection:'…'}}>
<Text color="green">     <span style={{color:'green'}}>
useInput(handler)        onKeyDown={handler}
useApp().exit()          window.close() / VS Code API
```

Key components to port first:
- `ToolResultMessage` — tool call + result display
- `AssistantMessage` — streaming text + thinking blocks
- `PermissionRequest` — allow/deny tool prompt
- `CostDisplay` — token cost summary

---

## Tier 3 — Deep integration (future)

- **`utils/`** helpers available to all AI systems via `INeuralInverseCCService`
  method expansion (currently exposes auto-compact, cost, permissions)
- **`services/apiService`** — CC's full Anthropic API client with retry,
  streaming, cache, fallback; could replace/augment `sendLLMMessageService`
- **`vim/`** — vim mode state machine → Power Mode input handler opt-in
- **`query/`** — CC's full query engine → Power Mode / Checks Agent backend

---

## Key facts

- CC internal imports were `src/X` style — all 657 rewritten to relative paths ✅
- `// @ts-nocheck` on 1,391 CC raw files — they compile but don't error ✅
- `shims.d.ts` stubs `bun:bundle`, `@ant/*`, private Anthropic packages ✅
- 30 npm packages installed (`ink`, `lodash-es`, `zod`, `@opentelemetry/*`, etc.) ✅
- Node.js built-ins covered by `@types/node` ✅
