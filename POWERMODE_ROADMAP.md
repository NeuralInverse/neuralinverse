# Power Mode → Claude Code Parity Roadmap

Source reference: `/Users/sanjaysenthilkumar/Downloads/src`
Goal: Make Power Mode TUI as capable as Claude Code without breaking existing connections.

---

## Phase 1 — System Prompt & Context (Highest Impact, No UI Risk)

### 1.1 Dynamic System Prompt (copy from `src/constants/prompts.ts`)

CC assembles the prompt in two halves separated by a static/dynamic boundary:

```
static (cacheable) ──────────────────────────────────────────
  • Identity + capabilities paragraph
  • Tool usage rules (dedicate tool > bash)
  • Security guidance (OWASP top 10)
  • Doing tasks rules (don't add unrequested features, no dead code)
  • Tone/style rules (no emoji, file:line refs, GitHub issue format)
  • Output efficiency rules

__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__

dynamic (per-session) ────────────────────────────────────────
  • Environment block  (date, OS, shell, working dir, model name)
  • Git block          (branch, main branch, status snapshot, recent 5 commits)
  • CLAUDE.md block    (loaded memory files — see §1.3)
  • Active session info (plan mode, worktree, etc.)
```

**File to edit:** `powerModeService.ts` → `_buildSystemPrompt()`

**What to add (directly copyable from CC):**
```typescript
// === STATIC SECTION ===
const STATIC_PROMPT = `
You are an interactive agent that helps users with software engineering tasks.
Use the instructions below and the tools available to you to assist the user.

IMPORTANT: Do NOT use bash when a dedicated tool exists (read, write, edit, glob, grep).
Dedicated tools let the user review your work. Only use bash for system operations
that have no dedicated equivalent.

Be careful not to introduce security vulnerabilities (command injection, XSS, SQL injection,
OWASP top 10). Fix insecure code immediately if you write it.

Don't add features, refactor, or make improvements beyond what was asked.
Don't add docstrings/comments/types to code you didn't change.
Don't add error handling for impossible scenarios — trust framework guarantees.
Don't create helpers for one-time operations. No speculative abstractions.

Keep responses short and direct. Lead with the action, not the reasoning.
When referencing code, include file_path:line_number.
Only use emojis if the user explicitly asks.
`.trim();

// === DYNAMIC SECTION ===
const buildDynamicPrompt = async (session, workingDir) => {
  const parts = [];

  // Date
  parts.push(`# Environment\nToday's date is ${new Date().toISOString().split('T')[0]}.`);
  parts.push(`Working directory: ${workingDir}`);
  parts.push(`Platform: ${process.platform}, Shell: ${process.env.SHELL}`);
  parts.push(`Model: ${session.modelName}`);

  // Git
  const git = await getGitContext(workingDir);
  if (git) {
    parts.push(`\n# gitStatus\n${git}`);
  }

  // CLAUDE.md
  const memory = await loadClaudeMdFiles(workingDir);
  if (memory) {
    parts.push(`\n# claudeMd\n${memory}`);
  }

  return parts.join('\n');
};
```

---

### 1.2 Git Context Injection (copy from `src/context.ts`)

CC captures at conversation start, never updates mid-session:

```typescript
// src/vs/workbench/contrib/powerMode/browser/powerModeService.ts
// Add to _buildSystemPrompt():

async _getGitContext(workingDir: string): Promise<string | null> {
  try {
    const { exec } = require('child_process');
    const run = (cmd: string) => new Promise<string>((res, rej) =>
      exec(cmd, { cwd: workingDir }, (e, out) => e ? rej(e) : res(out.trim()))
    );

    const [branch, mainBranch, status, log, user] = await Promise.allSettled([
      run('git rev-parse --abbrev-ref HEAD'),
      run('git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed "s@^refs/remotes/origin/@@"').catch(() => run('git branch -r | grep origin/HEAD | sed "s/.*->//" | sed "s/origin\\///"')),
      run('git status --short'),
      run('git log --oneline -n 5'),
      run('git config user.name'),
    ]);

    const branchStr = branch.status === 'fulfilled' ? branch.value : 'unknown';
    const mainStr = mainBranch.status === 'fulfilled' ? mainBranch.value : 'main';
    const statusStr = status.status === 'fulfilled'
      ? (status.value.length > 2000 ? status.value.substring(0, 2000) + '\n...(truncated)' : status.value || '(clean)')
      : '(unavailable)';
    const logStr = log.status === 'fulfilled' ? log.value : '';
    const userStr = user.status === 'fulfilled' ? user.value : null;

    return [
      `Current branch: ${branchStr}`,
      `Main branch (for PRs): ${mainStr}`,
      userStr ? `Git user: ${userStr}` : null,
      `Status:\n${statusStr}`,
      logStr ? `Recent commits:\n${logStr}` : null,
    ].filter(Boolean).join('\n');
  } catch {
    return null;
  }
}
```

**Show branch in welcome screen:**
```typescript
// _drawWelcome() — add git branch
const branch = this._gitBranch; // cached from session init
const branchBadge = branch ? `  ${DARK}${branch}${RESET}` : '';
this._write(line(`  ${CYAN}✻${RESET} ${WHITE}${BOLD}Neural Inverse${RESET}  ${DARK}${modelStr}${RESET}${branchBadge}`));
```

---

### 1.3 CLAUDE.md Hierarchy (copy from `src/utils/claudemd.ts`)

Load order (lowest → highest priority):

1. `/etc/claude-code/CLAUDE.md` — managed global policies
2. `~/.claude/CLAUDE.md` — user's private global
3. Walk CWD upward to `/`:
   - `CLAUDE.md`
   - `.claude/CLAUDE.md`
   - `.claude/rules/*.md`
   - `CLAUDE.local.md` (private, git-ignored)

```typescript
// src/vs/workbench/contrib/powerMode/browser/powerModeService.ts

async _loadClaudeMdFiles(workingDir: string): Promise<string> {
  const fs = require('fs').promises;
  const path = require('path');
  const os = require('os');

  const readSafe = async (p: string) => {
    try {
      const text = await fs.readFile(p, 'utf8');
      return text.length > 40000 ? text.substring(0, 40000) + '\n[truncated]' : text;
    } catch { return null; }
  };

  const sections: { path: string; content: string }[] = [];

  // 1. Managed
  const managed = await readSafe('/etc/claude-code/CLAUDE.md');
  if (managed) { sections.push({ path: '/etc/claude-code/CLAUDE.md', content: managed }); }

  // 2. User global
  const userFile = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  const user = await readSafe(userFile);
  if (user) { sections.push({ path: userFile, content: user }); }

  // 3. Walk upward from CWD
  let dir = workingDir;
  const dirs: string[] = [];
  while (true) {
    dirs.unshift(dir); // collect root→cwd order
    const parent = path.dirname(dir);
    if (parent === dir) { break; }
    dir = parent;
  }

  for (const d of dirs) {
    const candidates = [
      path.join(d, 'CLAUDE.md'),
      path.join(d, '.claude', 'CLAUDE.md'),
      path.join(d, 'CLAUDE.local.md'),
    ];
    // Also pick up .claude/rules/*.md
    try {
      const rulesDir = path.join(d, '.claude', 'rules');
      const entries = await fs.readdir(rulesDir);
      for (const e of entries) {
        if (e.endsWith('.md')) { candidates.push(path.join(rulesDir, e)); }
      }
    } catch { /* no rules dir */ }

    for (const p of candidates) {
      const content = await readSafe(p);
      if (content) { sections.push({ path: p, content }); }
    }
  }

  if (sections.length === 0) { return ''; }

  return sections.map(s =>
    `## ${s.path}\n${s.content}`
  ).join('\n\n---\n\n');
}
```

---

## Phase 2 — TUI Layout & Rendering Improvements

### 2.1 Fix Double-Prompt After Compact
After `/compact` fires `_drawPrompt()` inside the compact handler AND `_drawDone()` fires separately.
The `return` statement in the compact path already prevents the second `_drawPrompt`. Confirm this is working; if there's still a blank `>` line before the summary, add `\r${ESC}2K` after the screen clear.

### 2.2 Prompt Input — CC Single-Line Style
CC uses: `❯ ` (just the pointer, no box) — already done.

Remove the `╭─ / │` two-line prompt box:
```typescript
// Current (remove):
this._write(line(`${BLUE_LIGHT}╭─${RESET}`));
this._write(`${BLUE_LIGHT}│${RESET} ${CYAN}${BOLD}${POINTER} ${RESET}`);

// Target (CC style):
this._write(`\r\n${CYAN}${BOLD}${POINTER}${RESET} `);
```

### 2.3 Tool Output — CC Compact Format
Currently implemented. Remaining gap: show elapsed time right-aligned.
```
⏺ read  src/main.c                                    0.3s
  ──────────────────────────────────────────────────
     1  /**
     2   * Main application
```

### 2.4 Permission Prompt — CC Style
Currently showing `Allow? [y]es [a]lways [n]o`. CC format:
```
  ⚠  bash
  cat /etc/hosts

  Allow this command? (y/n/a)
  ❯
```

### 2.5 Thinking Spinner — Match CC Exactly
CC uses exactly: `↓ thinking...  3.2s  esc to interrupt`
- `↓` blinks between cyan and dim
- `esc to interrupt` in dim (not italic, not bold)
- Already implemented; just verify dim vs italic

---

## Phase 3 — Missing Slash Commands (Directly Implementable)

| Command | CC Behavior | Implementation |
|---------|-------------|----------------|
| `/cost` | Show session cost (input + output tokens, estimated $) | Track tokens in `_sessionTokens`, compute at `$3/1M input, $15/1M output` |
| `/context` | Show context window usage % | Count chars in messages, show bar |
| `/commit` | AI-generated git commit message | `bash git diff --cached`, send to LLM for message, `git commit -m` |
| `/rename <name>` | Rename current session | `session.title = name` |
| `/export` | Export conversation to markdown file | Join messages, write to `~/claude-export-{date}.md` |
| `/doctor` | Health check (model, git, tools) | Test bash, list tool counts, show model |
| `/stats` | Session statistics | Message counts, token totals, tool call counts |
| `/diff` | Show git diff | `bash git diff` with syntax highlighting |

---

## Phase 4 — Keyboard Shortcuts (Matching CC)

```typescript
// Add to _handleInput():

// Ctrl+R — history search
case '\x12':
  this._startHistorySearch();
  break;

// Ctrl+L — clear screen (like /clear)
case '\x0c':
  this._clearScreen();
  break;

// Ctrl+W — delete word backward
case '\x17':
  this._deleteWordBackward();
  break;

// Ctrl+A — move to start of line
case '\x01':
  this._moveCursorToStart();
  break;

// Ctrl+E — move to end of line
case '\x05':
  this._moveCursorToEnd();
  break;

// Alt+Backspace — delete word
case '\x1b\x7f':
  this._deleteWordBackward();
  break;

// Shift+Enter — insert newline in input
case '\x1b[27;2;13~':  // xterm modifyOtherKeys
case '\x1b\r':          // alt-enter fallback
  this._inputBuffer += '\n';
  this._write('\r\n  ');
  break;
```

---

## Phase 5 — Memory System (CLAUDE.md Style)

CC's memory writes go to `~/.claude/MEMORY.md` index + individual files.
Our current Power Mode memory is `.powermode-memory/*.md`.

**Keep existing system but add:**
1. Load `CLAUDE.md` files into system prompt (Phase 1.3 above)
2. `/memory` command opens the memory file in VS Code editor
3. Auto-save key decisions to `.powermode-memory/` at session end

---

## Phase 6 — System Prompt Copy-Paste from CC

The following sections from `src/constants/prompts.ts` can be **directly used**:

```
"This is a reminder that your context window is getting long..."
"Carefully consider the reversibility and blast radius of actions..."
"Do not create files unless they're absolutely necessary for achieving your goal..."
"Avoid backwards-compatibility hacks like renaming unused _vars..."
"When working with tool results, write down any important information you might need later..."
```

**File to update:** `powerModeService.ts` → the `SYSTEM_PROMPT` constant at the top.

---

## What Can Be Directly Copied from `/Downloads/src`

| File | What to copy | Where to put it |
|------|-------------|-----------------|
| `src/constants/prompts.ts` | Static system prompt text sections | `powerModeService.ts` SYSTEM_PROMPT const |
| `src/context.ts` | `getGitStatus()` logic | `powerModeService.ts` `_getGitContext()` |
| `src/utils/claudemd.ts` | CLAUDE.md walk + @include logic | `powerModeService.ts` `_loadClaudeMdFiles()` |
| `src/utils/markdown.ts` | `applyMarkdown()` token-by-token logic | `powerModeTerminalHost.ts` `_formatMarkdownLine()` |
| `src/commands.ts` | Slash command list | SLASH_COMMANDS array |
| `src/keybindings/schema.ts` | Action names + key formats | `_handleInput()` |
| `src/ink/parse-keypress.ts` | Kitty + xterm key protocol parsing | `_handleInput()` |

---

## Priority Order (What to do next)

1. **[P0] System prompt rewrite** — biggest impact, zero risk to connections
2. **[P0] Git context injection** — adds branch/status to every response
3. **[P0] CLAUDE.md loading** — per-project instructions work immediately
4. **[P1] Prompt box → single line** — visual parity with CC
5. **[P1] `/cost` command** — users need to track usage
6. **[P1] `/commit` command** — high-value feature
7. **[P2] Ctrl+R history search** — quality-of-life
8. **[P2] Multi-line input (Shift+Enter)** — important for code
9. **[P2] `/diff`, `/stats`, `/context`** — completeness
10. **[P3] @include in CLAUDE.md** — power user feature

---

## What NOT to Change

- `sendLLMMessage.impl.ts` — LLM connection layer (working, fragile)
- `powerModeProcessor.ts` — agent loop (solid)
- `powerToolRegistry.ts` — tool registration (stable)
- Existing tool implementations (bash, read, write, edit, grep, glob)
- `powerModeTypes.ts` — shared types
- Sub-agent service connections
- Power Bus connections
- The DI registration order in contribution files

---

## Current Status

| Feature | Status |
|---------|--------|
| `⏺ tool indicators` | ✅ Done |
| `❯ prompt pointer` | ✅ Done |
| `↓ responding + esc to interrupt` | ✅ Done |
| Line-buffered markdown in streaming | ✅ Done |
| Per-turn HR separator | ✅ Done |
| `/compact` with screen clear | ✅ Done |
| Dynamic terminal-width HR rules | ✅ Done |
| Tool error truncation | ✅ Done |
| `spawn_agent` arg guards | ✅ Done |
| System prompt rewrite | ⬜ TODO |
| Git context injection | ⬜ TODO |
| CLAUDE.md loading | ⬜ TODO |
| Single-line prompt (remove box) | ⬜ TODO |
| `/cost` command | ⬜ TODO |
| `/commit` command | ⬜ TODO |
| Ctrl+R history | ⬜ TODO |
| Shift+Enter multiline | ⬜ TODO |
| Branch in welcome | ⬜ TODO |
