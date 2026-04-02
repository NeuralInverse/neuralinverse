/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

/**
 * PowerModeTerminalHost — xterm.js terminal for Power Mode.
 *
 * Creates a raw xterm Terminal directly (no ITerminalService / pty needed)
 * so it works in auxiliary windows where Electron IPC is not available.
 *
 * Renders a Claude Code-style TUI with:
 * - Top status bar (model, session, cost)
 * - Streaming output area
 * - Bottom prompt with slash commands
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IPowerModeService } from './powerModeService.js';
import { PowerModeUIEvent, IPermissionRequest, ISkillInfo, ITextPart, ISubAgentInfo } from '../common/powerModeTypes.js';
import type { Terminal as XTermTerminal, IDisposable as XTermDisposable } from '@xterm/xterm';
import { importAMDNodeModule } from '../../../../amdX.js';
import { ITerminalTransport } from './powerModeWebviewTerminal.js';

// ─── XTermAdapter — wraps real xterm.js Terminal with our minimal API ─────────
//
// Loads @xterm/xterm via ES dynamic import() — required because VS Code's
// renderer uses ES modules (no CommonJS require).
//
// createTerminal() is now async: it awaits the xterm import, opens the terminal,
// then draws the welcome screen. A DomTerminal is mounted synchronously as a
// placeholder while xterm loads, then replaced once xterm is ready.
//
// If xterm fails to open for any reason, silently keeps the DomTerminal.
//
class XTermAdapter {
	private _xterm: XTermTerminal | undefined;
	private _fallback: DomTerminal;
	private _useXterm = false;
	private _pendingWrites: string[] = [];

	cols = 120;
	rows = 40;

	// Listeners registered before xterm is ready — replayed once it opens
	private _dataListeners: Array<(data: string) => void> = [];

	constructor(private readonly _container: HTMLElement) {
		// Mount DomTerminal immediately so the UI isn't blank while xterm loads
		this._fallback = new DomTerminal(_container);
	}

	/** Must be called after construction. Tries to upgrade to real xterm.js. */
	async tryUpgrade(): Promise<void> {
		try {
			const { Terminal } = await importAMDNodeModule<typeof import('@xterm/xterm')>('@xterm/xterm', 'lib/xterm.js');
			this._xterm = new Terminal({
				cols: this.cols,
				rows: this.rows,
				scrollback: 5000,
				fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace',
				fontSize: 13,
				theme: {
					background:    '#1e1e1e',
					foreground:    '#cccccc',
					cursor:        '#cccccc',
					black:         '#000000', red:           '#cd3131',
					green:         '#0dbc79', yellow:        '#e5e510',
					blue:          '#2472c8', magenta:       '#bc3fbc',
					cyan:          '#11a8cd', white:         '#e5e5e5',
					brightBlack:   '#666666', brightRed:     '#f14c4c',
					brightGreen:   '#23d18b', brightYellow:  '#f5f543',
					brightBlue:    '#3b8eea', brightMagenta: '#d670d6',
					brightCyan:    '#29b8db', brightWhite:   '#e5e5e5',
				},
				allowProposedApi: true,
				cursorBlink: true,
				cursorStyle: 'block',
				convertEol: true,
			});

			// Clear the DomTerminal content and mount xterm in the same container
			while (this._container.firstChild) { this._container.removeChild(this._container.firstChild); }
			this._container.style.cssText = 'position:absolute;inset:0;overflow:hidden;';
			this._xterm.open(this._container);

			this._useXterm = true;

			// Wire up any data listeners registered before upgrade
			for (const cb of this._dataListeners) {
				this._xterm.onData(cb);
			}

			// Replay buffered writes
			for (const chunk of this._pendingWrites) {
				this._xterm.write(chunk);
			}
			this._pendingWrites = [];

			console.log('[PowerMode] xterm.js terminal active');
		} catch (err) {
			console.warn('[PowerMode] xterm.js failed, keeping DomTerminal:', err);
		}
	}

	write(data: string): void {
		if (this._useXterm) { this._xterm!.write(data); }
		else { this._fallback.write(data); this._pendingWrites.push(data); }
	}

	onData(callback: (data: string) => void): { dispose: () => void } {
		this._dataListeners.push(callback);
		const fallbackDispose = this._fallback.onData(callback);
		// If xterm is already active, also wire it directly
		let xtermDispose: XTermDisposable | undefined;
		if (this._useXterm) { xtermDispose = this._xterm!.onData(callback); }
		return {
			dispose: () => {
				fallbackDispose.dispose();
				xtermDispose?.dispose();
				this._dataListeners = this._dataListeners.filter(l => l !== callback);
			}
		};
	}

	resize(cols: number, rows: number): void {
		this.cols = cols; this.rows = rows;
		this._fallback.resize(cols, rows);
		if (this._useXterm) { try { this._xterm!.resize(cols, rows); } catch { /* ignore */ } }
	}

	focus(): void {
		if (this._useXterm) { this._xterm!.focus(); }
		else { this._fallback.focus(); }
	}

	dispose(): void {
		this._xterm?.dispose();
		this._fallback.dispose();
	}

	get isRealTerminal(): boolean { return this._useXterm; }
}

// ─── DomTerminal — pure DOM fallback (kept for safety) ────────────────────────
//
// Used automatically when xterm.js fails to open (canvas crash in aux windows).
// Kept identical to the previous implementation so rollback is instant.
//
class DomTerminal {
	private readonly _scroller: HTMLElement;
	private readonly _lines: HTMLElement[] = [];
	private _cursor = 0;
	private _fg = '';
	private _bold = false;
	private _dim = false;
	private _italic = false;
	private _esc = '';
	private _inEsc = false;
	private _spanBuf = '';
	private _spanStyle = '';
	cols = 120;
	rows = 40;

	private static readonly FG: Record<number, string> = {
		30: 'var(--vscode-terminal-ansiBlack)',
		31: 'var(--vscode-terminal-ansiRed)',
		32: 'var(--vscode-terminal-ansiGreen)',
		33: 'var(--vscode-terminal-ansiYellow)',
		34: 'var(--vscode-terminal-ansiBlue)',
		35: 'var(--vscode-terminal-ansiMagenta)',
		36: 'var(--vscode-terminal-ansiCyan)',
		37: 'var(--vscode-terminal-ansiWhite)',
		90: 'var(--vscode-terminal-ansiBrightBlack)',
		91: 'var(--vscode-terminal-ansiBrightRed)',
		92: 'var(--vscode-terminal-ansiBrightGreen)',
		93: 'var(--vscode-terminal-ansiBrightYellow)',
		94: 'var(--vscode-terminal-ansiBrightBlue)',
		95: 'var(--vscode-terminal-ansiBrightMagenta)',
		96: 'var(--vscode-terminal-ansiBrightCyan)',
		97: 'var(--vscode-terminal-ansiBrightWhite)',
	};

	private readonly _input: HTMLInputElement;

	constructor(container: HTMLElement) {
		container.style.cssText = [
			'background:var(--vscode-terminal-background,var(--vscode-editor-background))',
			'color:var(--vscode-terminal-foreground,var(--vscode-editor-foreground))',
			'font-family:var(--vscode-editor-font-family,monospace)',
			'font-size:var(--vscode-editor-font-size,13px)',
			'line-height:1.5',
			'position:absolute', 'inset:0', 'overflow:hidden', 'cursor:text',
		].join(';');
		this._scroller = document.createElement('div');
		this._scroller.style.cssText = ['position:absolute', 'inset:0', 'overflow-y:auto', 'overflow-x:hidden', 'padding:6px 10px', 'box-sizing:border-box'].join(';');
		container.appendChild(this._scroller);
		this._input = document.createElement('input');
		this._input.style.cssText = 'position:absolute;opacity:0;width:1px;height:1px;top:0;left:0;border:none;outline:none;padding:0;';
		container.appendChild(this._input);
		container.addEventListener('click', () => this._input.focus());
		this._scroller.addEventListener('click', () => this._input.focus());
		this._input.addEventListener('focus', () => { container.style.outline = '1px solid var(--vscode-focusBorder, var(--vscode-terminal-ansiCyan))'; container.style.outlineOffset = '-1px'; });
		this._input.addEventListener('blur', () => { container.style.outline = 'none'; });
		setTimeout(() => this._input.focus(), 50);
		this._pushLine();
	}

	private _pushLine(): HTMLElement { const el = document.createElement('div'); el.style.cssText = 'min-height:1.5em;white-space:pre;'; this._lines.push(el); this._scroller.appendChild(el); return el; }
	private _line(): HTMLElement { while (this._cursor >= this._lines.length) { this._pushLine(); } return this._lines[this._cursor]!; }

	write(data: string): void {
		const normalized = data.replace(/\r\n/g, '\n');
		for (let i = 0; i < normalized.length; i++) {
			const ch = normalized[i]!;
			if (this._inEsc) {
				this._esc += ch;
				const done = this._esc.startsWith('[') ? /[a-zA-Z]$/.test(this._esc) : true;
				if (done) { this._flushSpan(); this._applyEsc(this._esc); this._esc = ''; this._inEsc = false; }
				continue;
			}
			if (ch === '\x1b') { this._inEsc = true; this._esc = ''; continue; }
			if (ch === '\b') { this._flushSpan(); const lineEl = this._line(); const last = lineEl.lastChild; if (last) { const txt = last.textContent || ''; if (txt.length > 1) { last.textContent = txt.slice(0, -1); } else { lineEl.removeChild(last); } } continue; }
			if (ch === '\r') { this._flushSpan(); this._clearLine(this._line()); continue; }
			if (ch === '\n') { this._flushSpan(); this._cursor++; if (this._cursor >= this._lines.length) { this._pushLine(); } continue; }
			const newStyle = this._currentStyle();
			if (newStyle !== this._spanStyle) { this._flushSpan(); this._spanStyle = newStyle; }
			this._spanBuf += ch;
		}
		this._flushSpan();
		this._scroller.scrollTop = this._scroller.scrollHeight;
	}

	private _flushSpan(): void { if (!this._spanBuf) { return; } const lineEl = this._line(); if (this._spanStyle) { const span = document.createElement('span'); span.style.cssText = this._spanStyle; span.textContent = this._spanBuf; lineEl.appendChild(span); } else { lineEl.appendChild(document.createTextNode(this._spanBuf)); } this._spanBuf = ''; }
	private _clearLine(el: HTMLElement): void { while (el.firstChild) { el.removeChild(el.firstChild); } }
	private _currentStyle(): string { const s: string[] = []; if (this._fg) { s.push(`color:${this._fg}`); } if (this._bold) { s.push('font-weight:bold'); } if (this._dim) { s.push('opacity:0.5'); } if (this._italic) { s.push('font-style:italic'); } return s.join(';'); }

	private _applyEsc(esc: string): void {
		if (!esc.startsWith('[')) { return; }
		const body = esc.slice(1, -1);
		const cmd = esc[esc.length - 1]!;
		if (cmd === 'm') { const codes = body === '' ? [0] : body.split(';').map(Number); for (const c of codes) { this._applySGR(c); } }
		else if (cmd === 'A') { const n = parseInt(body) || 1; this._cursor = Math.max(0, this._cursor - n); }
		else if (cmd === 'K') { this._clearLine(this._line()); }
	}

	private _applySGR(code: number): void {
		if (code === 0) { this._fg = ''; this._bold = false; this._dim = false; this._italic = false; }
		else if (code === 1) { this._bold = true; } else if (code === 2) { this._dim = true; } else if (code === 3) { this._italic = true; }
		else if (code === 22) { this._bold = false; this._dim = false; } else if (code === 23) { this._italic = false; }
		else if (DomTerminal.FG[code]) { this._fg = DomTerminal.FG[code]!; } else if (code === 39) { this._fg = ''; }
	}

	onData(callback: (data: string) => void): { dispose: () => void } {
		const handler = (e: KeyboardEvent) => {
			let seq = '';
			if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { seq = e.key; }
			else if (e.key === 'Enter') { seq = '\r'; } else if (e.key === 'Backspace') { seq = '\x7f'; }
			else if (e.key === 'ArrowUp') { seq = '\x1b[A'; } else if (e.key === 'ArrowDown') { seq = '\x1b[B'; }
			else if (e.key === 'ArrowRight') { seq = '\x1b[C'; } else if (e.key === 'ArrowLeft') { seq = '\x1b[D'; }
			else if (e.ctrlKey && e.key === 'c') { seq = '\x03'; } else if (e.ctrlKey && e.key === 'l') { seq = '\f'; }
			if (seq) { e.preventDefault(); callback(seq); }
		};
		this._input.addEventListener('keydown', handler);
		return { dispose: () => this._input.removeEventListener('keydown', handler) };
	}

	resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows; }
	focus(): void { this._input.focus(); }
	dispose(): void { /* scroller removed with container */ }
}

// ── ANSI escape helpers ─────────────────────────────────────────────────
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;

// Colors (ANSI standard - inherits from VS Code terminal theme)
const CYAN = `${ESC}36m`;        // terminal.ansiCyan
const GREEN = `${ESC}32m`;       // terminal.ansiGreen
const RED = `${ESC}31m`;         // terminal.ansiRed
const MAGENTA = `${ESC}35m`;     // terminal.ansiMagenta
const YELLOW = `${ESC}33m`;      // terminal.ansiYellow
const WHITE = `${ESC}97m`;       // terminal.ansiBrightWhite
const GRAY = `${ESC}90m`;        // terminal.ansiBrightBlack (gray)
const DARK = `${ESC}90m`;        // terminal.ansiBrightBlack
const BLUE_LIGHT = `${ESC}94m`;  // terminal.ansiBrightBlue

// ── Claude Code visual constants (from figures.ts) ───────────────────────
// Prompt pointer (PromptInputModeIndicator.tsx)
const POINTER = '❯';
// Thinking / "therefore" symbol (AssistantThinkingMessage.tsx)
const THEREFORE = '∴';
// Teardrop asterisk — used in CC welcome header (figures.ts)
const TEARDROP = '✻';
// Arrow — ↓ responding/tool-use (SpinnerAnimationRow.tsx)
const ARROW_DOWN = '↓';
// Divider char — CC uses HEAVY_HORIZONTAL (━) from figures.ts
const HR = '━';

// ── CC spinner verbs (from spinnerVerbs.ts) ──────────────────────────────
const SPINNER_VERBS = [
	'Analyzing', 'Thinking', 'Writing', 'Reasoning', 'Searching',
	'Considering', 'Processing', 'Working', 'Reading', 'Planning',
	'Reviewing', 'Crafting', 'Exploring', 'Evaluating', 'Generating',
] as const;

function randomSpinnerVerb(): string {
	return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]!;
}

/**
 * Shimmer effect: sweeps a bright highlight across the verb text (CC-style).
 * Returns the verb string with one "highlighted" character at position `frame`.
 * Uses bright white for the lit char, dim for surrounding chars.
 */
function shimmerVerb(verb: string, frame: number): string {
	const pos = frame % (verb.length + 4); // extra pause frames at ends
	if (pos >= verb.length) { return `${DIM}${verb}${RESET}`; }
	const before = verb.slice(0, pos);
	const lit = verb[pos]!;
	const after = verb.slice(pos + 1);
	return `${DIM}${before}${RESET}${WHITE}${BOLD}${lit}${RESET}${DIM}${after}${RESET}`;
}

function line(text: string = ''): string {
	return text + '\r\n';
}


// ── Slash commands ──────────────────────────────────────────────────────
interface SlashCommand {
	name: string;
	description: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
	{ name: '/clear', description: 'Clear conversation' },
	{ name: '/new', description: 'New session' },
	{ name: '/sessions', description: 'List all sessions' },
	{ name: '/switch <id>', description: 'Switch to a session' },
	{ name: '/stop', description: 'Stop current response' },
	{ name: '/model', description: 'Show current model' },
	{ name: '/agents', description: 'Show connected agents on PowerBus' },
	{ name: '/tasks', description: 'List tracked tasks' },
	{ name: '/memory', description: 'List persistent memory entries' },
	{ name: '/review', description: 'Review recent file changes' },
	{ name: '/rollback [file]', description: 'Rollback all changes or specific file' },
	{ name: '/plan', description: 'Enter read-only plan mode (blocks write tools)' },
	{ name: '/exit-plan', description: 'Exit plan mode and resume editing' },
	{ name: '/worktree', description: 'Show active worktree info' },
	{ name: '/crons', description: 'List scheduled cron jobs' },
	{ name: '/tools', description: 'List all available tools' },
	{ name: '/status', description: 'Show session status (model, plan mode, worktree, tokens)' },
	{ name: '/compact', description: 'Summarize and compress conversation history' },
	{ name: '/spawn <role> <goal>', description: 'Spawn a parallel sub-agent (cc:explore/cc:plan/cc:general/cc:verify | editor/verifier/debugger/tester | compliance/reviewer/architect)' },
	{ name: '/agents', description: 'Show sub-agents + PowerBus agents' },
	{ name: '/cancel-agent <id>', description: 'Cancel a running sub-agent by ID' },
	{ name: '/security [mode]', description: 'Show or set permission mode (default / accept-edits / dont-ask / bypass)' },
	{ name: '/help', description: 'Show available commands' },
];

export class PowerModeTerminalHost extends Disposable {

	private _domTerm: ITerminalTransport | undefined;
	private _container: HTMLElement | undefined;
	private _currentSessionId: string | undefined;
	private _isBusy = false;
	private _inputBuffer = '';
	private _inputActive = true;
	private _isStreaming = false;
	private _streamingPartId: string | undefined;
	private readonly _streamedPartIds = new Set<string>();
	private _streamTimeout: any = undefined;
	private _showingSlashMenu = false;
	private _slashFilteredCommands: SlashCommand[] = [];
	private _menuLineCount = 0;

	// Model picker state
	private _inModelPicker = false;
	private _modelPickerOptions: { name: string; provider: string; model: string }[] = [];
	private _modelPickerBuffer = '';

	// Permission prompt state
	private _inPermissionPrompt = false;
	private _pendingPermissionRequest: IPermissionRequest | undefined;

	// Question prompt state (ask_user tool)
	private _inQuestionPrompt = false;
	private _pendingQuestion: { questionId: string; question: string } | undefined;
	private _questionBuffer = '';

	// Tool dedup — track which tool part IDs have been drawn as running
	private readonly _drawnRunningTools = new Set<string>();
	private _lastDrawnToolPartId: string | undefined;
	// Live label per tool part — updated when ctx.metadata({title}) fires during execution
	private readonly _activeToolLabels = new Map<string, string>();

	// Alert deduplication - track last blocking violation alert
	private _lastBlockingAlertHash: string | undefined;

	// Animated thinking dots
	private _thinkingInterval: ReturnType<typeof setInterval> | undefined;

	// Streaming cursor (▋ appended at end of active line)
	private _streamingCursor = false;

	// Running time display
	private _runningTimeInterval: ReturnType<typeof setInterval> | undefined;

	// Thinking duration tracking — for "thought for Xs" after reasoning parts
	private _reasoningStartTime: number | undefined;
	private _lastReasoningDuration: number | undefined;

	// Column tracker for streaming word-wrap
	private _streamCol = 2; // starts at 2 (after the 2-space indent)

	// Terminal width — updated on every resize, used for dynamic HR dividers
	private _cols = 120;

	// Line-buffer for markdown formatting during streaming
	private _streamLineBuffer = '';

	// Track compact request: session ID being compacted (awaiting LLM response)
	private _compactingSessionId: string | undefined;

	// CC bundled skills — populated from 'skill-list' event
	private _ccSkills: ISkillInfo[] = [];

	// Session cost/token counters — updated from 'session-cost' event
	private _sessionCostUSD = 0;
	private _sessionInputTokens = 0;
	private _sessionOutputTokens = 0;

	// Token warning state — set from 'token-warning' event
	private _tokenWarningActive = false;
	private _tokenWarningBlocking = false;
	private _tokenPctLeft = 100;

	// Auto-compact running (triggered by service, not /compact command)
	private _serviceCompactActive = false;

	// Input cursor blink
	private _inputCursorInterval: ReturnType<typeof setInterval> | undefined;
	private _inputCursorOn = false;

	// Live sub-agent progress — agentId → { role, goal, startMs, interval }
	private readonly _liveAgents = new Map<string, {
		role: string; goal: string; startMs: number;
		interval: ReturnType<typeof setInterval>;
	}>();

	constructor(
		private readonly powerModeService: IPowerModeService,
	) {
		super();
		this._register(this.powerModeService.onDidEmitUIEvent(e => this._handleUIEvent(e)));
	}

	createTerminal(container: HTMLElement): void {
		this._container = container;

		// XTermAdapter mounts DomTerminal synchronously as a placeholder,
		// then upgrades to real xterm.js asynchronously.
		this._domTerm = new XTermAdapter(container);

		// Wire input before upgrade — XTermAdapter queues listeners and replays them
		this._register(this._domTerm.onData((data: string) => this._handleInput(data)));

		// Fit cols to container width and draw initial screen immediately
		// (DomTerminal is already visible while xterm loads)
		this._fitTerminal();
		this._drawWelcome();
		this._drawPrompt();

		// Attempt upgrade to real xterm.js — if it succeeds the terminal swaps in-place
		this._domTerm.tryUpgrade().then(() => {
			if (this._domTerm?.isRealTerminal) {
				console.log('[PowerMode] xterm.js terminal active');
				// Re-fit and re-draw after xterm takes over
				this._fitTerminal();
				this._drawWelcome();
				this._drawPrompt();
			} else {
				console.log('[PowerMode] DomTerminal fallback active');
			}
		});
	}

	/**
	 * Mount the terminal host onto an externally-created transport (e.g. WebviewTerminal).
	 * Use this instead of createTerminal() when the display layer lives in a webview.
	 */
	mountWithTransport(transport: ITerminalTransport): void {
		this._domTerm = transport;
		this._register(this._domTerm.onData((data: string) => this._handleInput(data)));
		// No _fitTerminal() here — the webview auto-fits its own xterm instance
		this._cols = transport.cols;
		this._drawWelcome();
		this._drawPrompt();
	}

	/** Switch the terminal display to an existing session (called from sidebar click). */
	switchToSession(sessionId: string): void {
		const session = this.powerModeService.getSession(sessionId);
		if (!session) { return; }
		this._currentSessionId = session.id;
		this.powerModeService.switchSession(session.id);

		// Clear screen + scrollback, redraw header
		this._write(`${ESC}3J${ESC}2J${ESC}H`);
		this._drawWelcome();

		if (session.messages.length === 0) {
			this._write(line(`  ${GRAY}── empty session${RESET}`));
			this._write(line());
			this._drawPrompt();
			return;
		}

		// Replay messages
		for (const msg of session.messages as any[]) {
			if (msg.role === 'user') {
				// Render user turn
				const textParts = (msg.parts ?? []).filter((p: any) => p.type === 'text');
				const text = textParts.map((p: any) => p.text).join('').trim();
				if (text) {
					this._write(line(`${BLUE_LIGHT}│${RESET} ${CYAN}${BOLD}❯ ${RESET}${WHITE}${text}${RESET}`));
					this._write(line());
				}
			} else if (msg.role === 'assistant') {
				for (const part of (msg.parts ?? []) as any[]) {
					if (part.type === 'text' && part.text?.trim()) {
						this._drawText(part.text);
						this._write(line());
					} else if (part.type === 'tool' && part.toolName) {
						const st = part.state ?? {};
						const icon = st.status === 'completed' ? `${GREEN}✓${RESET}` : st.status === 'error' ? `${RED}✗${RESET}` : `${GRAY}○${RESET}`;
						const fp: string = st.input?.filePath ?? st.input?.file_path ?? st.input?.command ?? '';
						const label = fp ? `  ${DIM}${fp}${RESET}` : '';
						this._write(line(`  ${icon}  ${DARK}${part.toolName}${RESET}${label ? `  ${GRAY}${fp}${RESET}` : ''}`));
					}
				}
			}
		}

		this._write(line());
		this._drawPrompt();
	}

	// ── Top Bar ─────────────────────────────────────────────────────────

	private _drawTopBar(): void {
		// Intentionally minimal — model info lives in the welcome box
	}

	private _drawWelcome(): void {
		const modelInfo = this.powerModeService.getModelInfo();
		const modelStr = modelInfo ? modelInfo.model : 'no model';
		const providerStr = modelInfo ? modelInfo.provider : '';

		const sessionsCount = this.powerModeService.sessions.length;
		const sessionHint = sessionsCount > 0 ? `${sessionsCount} session${sessionsCount !== 1 ? 's' : ''}` : '';

		// Active session status badges (CC-style inline)
		const activeSession = this._currentSessionId
			? this.powerModeService.getSession(this._currentSessionId)
			: this.powerModeService.activeSession;
		const planBadge = activeSession?.planMode ? `  ${YELLOW}plan mode${RESET}` : '';
		const worktreeBadge = activeSession?.worktree ? `  ${MAGENTA}${activeSession.worktree.branch}${RESET}` : '';

		this._write(line());
		this._write(line(`  ${CYAN}${TEARDROP}${RESET} ${WHITE}${BOLD}Neural Inverse${RESET}  ${DARK}${modelStr}${providerStr ? ` · ${providerStr}` : ''}${RESET}${planBadge}${worktreeBadge}`));
		this._write(line(`  ${DARK}/help for commands${sessionHint ? `  ·  ${sessionHint}` : ''}${RESET}`));
		this._write(line());
	}

	// ── Sub-agent live progress ─────────────────────────────────────────

	private _startAgentProgress(agentId: string, role: string, goal: string): void {
		if (this._liveAgents.has(agentId)) { return; }
		const startMs = Date.now();
		const shortId = agentId.substring(0, 8);
		const goalPreview = goal.length > 50 ? goal.substring(0, 47) + '…' : goal;
		let blinkOn = true;

		// Print initial line (newline so it doesn't clobber the prompt)
		this._write(line());
		this._write(`  ${CYAN}◈${RESET}  ${BOLD}${role}${RESET}  ${DARK}${shortId}${RESET}  ${GRAY}${goalPreview}${RESET}`);

		const interval = setInterval(() => {
			blinkOn = !blinkOn;
			const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
			const dot = blinkOn ? `${CYAN}◈${RESET}` : `${DARK}◈${RESET}`;
			this._write(`\r${ESC}K  ${dot}  ${BOLD}${role}${RESET}  ${DARK}${shortId}${RESET}  ${GRAY}${goalPreview}${RESET}  ${DARK}${elapsed}s${RESET}`);
		}, 600);

		this._liveAgents.set(agentId, { role, goal, startMs, interval });
	}

	private _stopAgentProgress(agentId: string, status: ISubAgentInfo['status'], result?: string, error?: string): void {
		const entry = this._liveAgents.get(agentId);
		if (!entry) { return; }
		clearInterval(entry.interval);
		this._liveAgents.delete(agentId);

		const shortId = agentId.substring(0, 8);
		const elapsed = ((Date.now() - entry.startMs) / 1000).toFixed(1);
		const goalPreview = entry.goal.length > 50 ? entry.goal.substring(0, 47) + '…' : entry.goal;

		let icon: string;
		let color: string;
		if (status === 'completed') { icon = '✓'; color = GREEN; }
		else if (status === 'failed') { icon = '✗'; color = RED; }
		else { icon = '○'; color = DARK; }

		// Overwrite the running line
		this._write(`\r${ESC}K  ${color}${icon}${RESET}  ${BOLD}${entry.role}${RESET}  ${DARK}${shortId}${RESET}  ${GRAY}${goalPreview}${RESET}  ${DARK}${elapsed}s${RESET}\r\n`);

		// Show result/error snippet
		if (status === 'completed' && result) {
			const snippet = result.split('\n').filter(l => l.trim()).slice(0, 3);
			for (const l of snippet) {
				const truncated = l.length > 90 ? l.substring(0, 87) + '…' : l;
				this._write(line(`     ${DARK}${truncated}${RESET}`));
			}
		} else if (status === 'failed' && error) {
			const errSnippet = error.length > 80 ? error.substring(0, 77) + '…' : error;
			this._write(line(`     ${RED}${errSnippet}${RESET}`));
		}
	}

	// ── Input cursor blink ──────────────────────────────────────────────

	private _startInputCursor(): void {
		this._stopInputCursor();
		this._inputCursorOn = true;
		this._inputCursorInterval = setInterval(() => {
			if (!this._inputActive || this._showingSlashMenu || this._inModelPicker || this._inPermissionPrompt || this._inQuestionPrompt) { return; }
			this._inputCursorOn = !this._inputCursorOn;
			const cur = this._inputCursorOn ? `${CYAN}▋${RESET}` : ' ';
			this._write(`\r${ESC}K${BLUE_LIGHT}│${RESET} ${CYAN}${BOLD}${POINTER} ${RESET}${WHITE}${this._inputBuffer}${RESET}${cur}`);
		}, 530);
	}

	private _stopInputCursor(): void {
		if (this._inputCursorInterval !== undefined) {
			clearInterval(this._inputCursorInterval);
			this._inputCursorInterval = undefined;
		}
		this._inputCursorOn = false;
	}

	// ── Bottom bar (drawn inline before prompt) ─────────────────────────

	private _drawPrompt(): void {
		this._stopInputCursor();
		this._inputActive = true;
		this._inputBuffer = '';
		this._isStreaming = false;
		this._streamingPartId = undefined;
		this._streamedPartIds.clear();
		this._showingSlashMenu = false;
		this._menuLineCount = 0;
		this._inModelPicker = false;
		this._modelPickerBuffer = '';
		this._inPermissionPrompt = false;
		this._pendingPermissionRequest = undefined;
		this._drawnRunningTools.clear();
		this._activeToolLabels.clear();
		this._streamingCursor = false;
		this._streamLineBuffer = '';

		// ── Structured prompt (CC ❯ style) ──────────────────────
		this._write(line());
		this._write(line(`${BLUE_LIGHT}╭─${RESET}`));
		this._write(`${BLUE_LIGHT}│${RESET} ${CYAN}${BOLD}${POINTER} ${RESET}`);

		this._startInputCursor();
	}

	// ── Slash Command Menu ──────────────────────────────────────────────

	/** Returns all available slash commands including CC skills */
	private _allSlashCommands(): SlashCommand[] {
		const skillCmds: SlashCommand[] = this._ccSkills.map(s => ({
			name: `/${s.name}`,
			description: s.description + (s.argumentHint ? `  ${DARK}${s.argumentHint}${RESET}` : ''),
		}));
		return [...SLASH_COMMANDS, ...skillCmds];
	}

	private _showSlashMenu(filter: string): void {
		const query = filter.toLowerCase().slice(1);
		this._slashFilteredCommands = this._allSlashCommands().filter(
			c => !query || c.name.slice(1).startsWith(query)
		);

		// Clear current prompt line + any previously drawn menu lines
		this._write(`\r${ESC}K`); // clear current line
		for (let i = 0; i < this._menuLineCount; i++) {
			this._write(`${ESC}A${ESC}K`); // cursor up + clear line
		}

		if (this._slashFilteredCommands.length === 0) {
			this._menuLineCount = 0;
			this._showingSlashMenu = false;
			this._write(`${BLUE_LIGHT}│${RESET} ${CYAN}${BOLD}❯ ${RESET}${WHITE}${this._inputBuffer}${RESET}`);
			return;
		}

		// Draw menu lines
		for (const cmd of this._slashFilteredCommands) {
			this._write(line(`  ${WHITE}${BOLD}${cmd.name}${RESET}  ${DARK}${cmd.description}${RESET}`));
		}
		this._menuLineCount = this._slashFilteredCommands.length;

		// Reprint prompt with current input
		this._write(`${BLUE_LIGHT}│${RESET} ${CYAN}${BOLD}❯ ${RESET}${WHITE}${this._inputBuffer}${RESET}`);
		this._showingSlashMenu = true;
	}

	private _hideSlashMenu(): void {
		if (!this._showingSlashMenu && this._menuLineCount === 0) { return; }
		// Clear prompt line + all menu lines
		this._write(`\r${ESC}K`);
		for (let i = 0; i < this._menuLineCount; i++) {
			this._write(`${ESC}A${ESC}K`);
		}
		this._menuLineCount = 0;
		this._showingSlashMenu = false;
		// Reprint prompt
		this._write(`${BLUE_LIGHT}│${RESET} ${CYAN}${BOLD}❯ ${RESET}${WHITE}${this._inputBuffer}${RESET}`);
	}

	private _executeSlashCommand(cmd: string): void {
		const command = cmd.trim().toLowerCase();

		switch (command) {
			case '/clear': {
				if (this._currentSessionId) {
					this.powerModeService.clearSession(this._currentSessionId);
				}
				// Clear the terminal screen
				this._write(`${ESC}2J${ESC}H`); // clear screen + move to top
				this._drawTopBar();
				this._write(line());
				this._write(line(`  ${GRAY}Conversation cleared${RESET}`));
				this._write(line());
				this._drawPrompt();
				break;
			}

			case '/new': {
				const session = this.powerModeService.createSession();
				this._currentSessionId = session.id;
				this._write(`${ESC}2J${ESC}H`);
				this._drawTopBar();
				this._write(line());
				this._write(line(`  ${GRAY}New session created${RESET}`));
				this._write(line());
				this._drawPrompt();
				break;
			}

			case '/stop': {
				if (this._isBusy && this._currentSessionId) {
					this.powerModeService.cancel(this._currentSessionId);
					this._write(line(`  ${GRAY}Response stopped${RESET}`));
				} else {
					this._write(line(`  ${DARK}Nothing to stop${RESET}`));
				}
				this._drawPrompt();
				break;
			}

			case '/model': {
				this._enterModelPicker();
				break;
			}

			case '/agents': {
				// ── Sub-agents (spawned via spawn_agent tool or /spawn) ────────
				const subAgents = this.powerModeService.getSubAgents();
				this._write(line());
				this._write(line(`  ${WHITE}${BOLD}Sub-agents (${subAgents.length}):${RESET}`));
				this._write(line());
				if (subAgents.length === 0) {
					this._write(line(`  ${DARK}None yet. Use ${WHITE}/spawn <role> <goal>${DARK} to start one.${RESET}`));
				} else {
					const statusIcon: Record<string, string> = {
						pending: `${DARK}○${RESET}`,
						running: `${CYAN}◈${RESET}`,
						completed: `${GREEN}✓${RESET}`,
						failed: `${RED}✗${RESET}`,
						cancelled: `${DARK}○${RESET}`,
					};
					const formatElapsed = (created: string, done?: string) => {
						const ms = (done ? new Date(done).getTime() : Date.now()) - new Date(created).getTime();
						const s = Math.floor(ms / 1000);
						return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
					};
					for (const sa of subAgents) {
						const ic = statusIcon[sa.status] ?? `${DARK}?${RESET}`;
						const elapsed = formatElapsed(sa.createdAt, sa.completedAt);
						const goalPreview = sa.goal.length > 55 ? sa.goal.substring(0, 52) + '…' : sa.goal;
						this._write(line(`  ${ic}  ${BOLD}${sa.role.padEnd(12)}${RESET}  ${DARK}${sa.id.substring(0, 8)}${RESET}  ${DARK}${elapsed}${RESET}`));
						this._write(line(`     ${GRAY}${goalPreview}${RESET}`));
					}
				}
				this._write(line());

				// ── PowerBus agents ────────────────────────────────────────────
				const busAgents = this.powerModeService.getAgentsOnBus();
				const history = this.powerModeService.getBusHistory(10);
				this._write(line(`  ${WHITE}${BOLD}PowerBus agents (${busAgents.length}):${RESET}`));
				this._write(line());
				if (busAgents.length === 0) {
					this._write(line(`  ${DARK}No agents registered on bus${RESET}`));
				} else {
					for (const a of busAgents) {
						const caps = a.capabilities.join(', ');
						const uptime = Math.round((Date.now() - a.registeredAt) / 1000);
						this._write(line(`  ${CYAN}${BOLD}${(a.displayName ?? a.agentId).padEnd(18)}${RESET}  ${DARK}${caps}${RESET}  ${DARK}${uptime}s${RESET}`));
					}
				}
				if (history.length > 0) {
					this._write(line());
					this._write(line(`  ${WHITE}${BOLD}Recent bus messages:${RESET}`));
					this._write(line());
					for (const m of history.slice(-8)) {
						const ts = new Date(m.timestamp).toLocaleTimeString();
						const preview = m.content.length > 60 ? m.content.substring(0, 60) + '…' : m.content;
						this._write(line(`  ${DARK}${ts}${RESET}  ${CYAN}${m.from}${RESET} ${DARK}→${RESET} ${MAGENTA}${m.to}${RESET}  ${DARK}[${m.type}]${RESET}  ${GRAY}${preview}${RESET}`));
					}
				}
				this._write(line());
				this._drawPrompt();
				break;
			}

			case '/review': {
				const changeGroup = this.powerModeService.getLatestChanges();
				this._write(line());
				if (!changeGroup || changeGroup.changes.length === 0) {
					this._write(line(`  ${DARK}No recent changes to review${RESET}`));
				} else {
					this._write(line(`  ${WHITE}${BOLD}Recent Changes${RESET}  ${DARK}${changeGroup.changes.length} files${RESET}`));
					this._write(line());

					for (const change of changeGroup.changes) {
						const fileName = change.filePath.split('/').pop() || change.filePath;
						const changeType = change.contentBefore === null ? `${GREEN}NEW${RESET}` : `${YELLOW}MODIFIED${RESET}`;
						const canRollback = !change.superseded ? `${GREEN}✓${RESET}` : `${DARK}✗${RESET}`;

						this._write(line(`  ${canRollback} ${changeType}  ${CYAN}${fileName}${RESET}`));
						this._write(line(`     ${DARK}+${change.linesAdded} -${change.linesRemoved}  ${change.filePath}${RESET}`));

						// Show a preview of changes (first 3 lines)
						if (change.contentAfter) {
							const afterLines = change.contentAfter.split('\n').slice(0, 3);
							for (const l of afterLines) {
								const preview = l.length > 80 ? l.substring(0, 77) + '...' : l;
								this._write(line(`     ${DARK}${preview}${RESET}`));
							}
							if (change.contentAfter.split('\n').length > 3) {
								this._write(line(`     ${DARK}... ${change.contentAfter.split('\n').length - 3} more lines${RESET}`));
							}
						}
						this._write(line());
					}

					// Show rollback options
					const rollbackableCount = changeGroup.changes.filter(c => !c.superseded).length;
					if (rollbackableCount > 0) {
						this._write(line(`  ${WHITE}${BOLD}Rollback:${RESET}`));
						this._write(line(`     ${DARK}Type ${WHITE}/rollback${DARK} to undo all ${rollbackableCount} changes${RESET}`));
					} else {
						this._write(line(`  ${DARK}These changes have been superseded (cannot rollback)${RESET}`));
					}
				}
				this._write(line());
				this._drawPrompt();
				break;
			}

			case '/tasks': {
				const tasks = this.powerModeService.getTasks();
				this._write(line());
				this._write(line(`  ${WHITE}${BOLD}Tasks (${tasks.length}):${RESET}`));
				this._write(line());
				if (tasks.length === 0) {
					this._write(line(`  ${DARK}No tasks yet. The agent creates tasks for multi-step workflows.${RESET}`));
				} else {
					const statusIcon: Record<string, string> = {
						pending: `${DARK}·${RESET}`,
						in_progress: `${CYAN}⟳${RESET}`,
						completed: `${GREEN}✓${RESET}`,
						blocked: `${RED}✗${RESET}`,
					};
					const statusColor: Record<string, string> = {
						pending: DARK,
						in_progress: CYAN,
						completed: GREEN,
						blocked: RED,
					};
					for (const t of tasks) {
						const ic = statusIcon[t.status] ?? '·';
						const sc = statusColor[t.status] ?? DARK;
						const title = t.title.length > 52 ? t.title.substring(0, 49) + '...' : t.title;
						this._write(line(`  ${ic}  ${WHITE}${t.id.padEnd(12)}${RESET}  ${sc}${t.status.padEnd(11)}${RESET}  ${title}`));
						if (t.description) {
							const desc = t.description.length > 70 ? t.description.substring(0, 67) + '...' : t.description;
							this._write(line(`     ${DARK}${desc}${RESET}`));
						}
					}
				}
				this._write(line());
				this._drawPrompt();
				break;
			}

			case '/memory': {
				this._write(line());
				this._write(line(`  ${WHITE}${BOLD}Memory entries:${RESET}  ${DARK}(loading...)${RESET}`));
				this.powerModeService.listMemoryFiles().then(keys => {
					// Overwrite loading line
					this._write(`\r${ESC}A${ESC}2K\r`);
					this._write(line(`  ${WHITE}${BOLD}Memory entries (${keys.length}):${RESET}`));
					this._write(line());
					if (keys.length === 0) {
						this._write(line(`  ${DARK}No memory files. The agent writes memories via memory_write.${RESET}`));
					} else {
						for (const key of keys) {
							this._write(line(`  ${CYAN}•${RESET}  ${WHITE}${key}${RESET}`));
						}
					}
					this._write(line());
					this._drawPrompt();
				}).catch(() => {
					this._write(`\r${ESC}A${ESC}2K\r`);
					this._write(line(`  ${DARK}Could not read memory directory.${RESET}`));
					this._write(line());
					this._drawPrompt();
				});
				break;
			}

			case '/status': {
				const statusSession = this._currentSessionId
					? this.powerModeService.getSession(this._currentSessionId)
					: this.powerModeService.activeSession;
				const modelInfo = this.powerModeService.getModelInfo();
				const tasks = this.powerModeService.getTasks();
				const pendingTasks = tasks.filter(t => t.status === 'pending' || t.status === 'in_progress');

				this._write(line());
				this._write(line(`  ${WHITE}${BOLD}Power Mode Status${RESET}`));
				this._write(line());

				// Model
				if (modelInfo) {
					this._write(line(`  ${CYAN}Model:${RESET}      ${modelInfo.model}  ${DARK}${modelInfo.provider}${RESET}`));
				} else {
					this._write(line(`  ${CYAN}Model:${RESET}      ${RED}none selected${RESET}  ${DARK}(/model to configure)${RESET}`));
				}

				// Session
				if (statusSession) {
					const msgCount = statusSession.messages.length;
					const userCount = statusSession.messages.filter(m => m.role === 'user').length;
					const age = Math.round((Date.now() - statusSession.updatedAt) / 1000);
					const ageStr = age < 60 ? `${age}s ago` : age < 3600 ? `${Math.round(age / 60)}m ago` : `${Math.round(age / 3600)}h ago`;
					this._write(line(`  ${CYAN}Session:${RESET}    ${statusSession.title.substring(0, 40)}`));
					this._write(line(`  ${CYAN}Messages:${RESET}   ${userCount} user / ${msgCount - userCount} assistant  ${DARK}(updated ${ageStr})${RESET}`));
					this._write(line(`  ${CYAN}Status:${RESET}     ${statusSession.status === 'busy' ? `${YELLOW}busy${RESET}` : `${GREEN}idle${RESET}`}`));

					// Plan mode
					if (statusSession.planMode) {
						this._write(line(`  ${CYAN}Plan mode:${RESET}  ${YELLOW}active${RESET}  ${DARK}(write tools blocked — /exit-plan to resume)${RESET}`));
					}

					// Permission mode
					const secMode = this.powerModeService.getPermissionMode(statusSession.id);
					if (secMode !== 'default') {
						const secColor = secMode === 'bypass' ? RED : secMode === 'dont-ask' ? CYAN : GREEN;
						this._write(line(`  ${CYAN}Security:${RESET}   ${secColor}${secMode}${RESET}  ${DARK}(/security to change)${RESET}`));
					}

					// Worktree
					if (statusSession.worktree) {
						this._write(line(`  ${CYAN}Worktree:${RESET}   ${MAGENTA}${statusSession.worktree.branch}${RESET}  ${DARK}${statusSession.worktree.path}${RESET}`));
					}
				} else {
					this._write(line(`  ${CYAN}Session:${RESET}    ${DARK}none${RESET}`));
				}

				// Tasks summary
				if (pendingTasks.length > 0) {
					this._write(line(`  ${CYAN}Tasks:${RESET}      ${pendingTasks.length} active  ${DARK}(/tasks for full list)${RESET}`));
				}

				// Agents
				const agentCount = this.powerModeService.getAgentsOnBus().length;
				if (agentCount > 0) {
					this._write(line(`  ${CYAN}Bus agents:${RESET} ${agentCount}  ${DARK}(/agents for details)${RESET}`));
				}

				// Context window info (from CC getContextWindowForModel / getAutoCompactThreshold)
				const ctxInfo = this.powerModeService.getContextWindowInfo();
				if (ctxInfo) {
					const usedTokens = this._sessionInputTokens + this._sessionOutputTokens;
					const usedPct = ctxInfo.contextWindow > 0 ? Math.round((usedTokens / ctxInfo.contextWindow) * 100) : 0;
					const ctxColor = usedPct > 80 ? RED : usedPct > 60 ? YELLOW : CYAN;
					this._write(line(`  ${ctxColor}Context:${RESET}    ${usedTokens.toLocaleString()} / ${ctxInfo.contextWindow.toLocaleString()} tokens  ${DARK}(${usedPct}% used, compact at ${Math.round((ctxInfo.threshold / ctxInfo.contextWindow) * 100)}%)${RESET}`));
				}

				// Session cost — use CC's formatted cost string
				if (this._currentSessionId && (this._sessionCostUSD > 0 || this._sessionInputTokens > 0)) {
					const formatted = this.powerModeService.getFormattedSessionCost(this._currentSessionId);
					if (formatted) {
						this._write(line(`  ${CYAN}Session cost:${RESET} ${WHITE}${formatted}${RESET}`));
					}
				}

				// Permission rules active for this session
				if (this._currentSessionId) {
					const rules = this.powerModeService.getPermissionRules(this._currentSessionId);
					if (rules.length > 0) {
						this._write(line(`  ${CYAN}Allow rules:${RESET}  ${rules.length}  ${DARK}(session-level bash allow rules active)${RESET}`));
					}
				}

				// Token warning if active
				if (this._tokenWarningActive) {
					const warningColor = this._tokenWarningBlocking ? RED : YELLOW;
					const warningMsg = this._tokenWarningBlocking
						? `Context nearly full (${this._tokenPctLeft}% left) — /compact required`
						: `Context ${100 - this._tokenPctLeft}% used (${this._tokenPctLeft}% left) — /compact recommended`;
					this._write(line(`  ${warningColor}⚠  ${warningMsg}${RESET}`));
				}

				this._write(line());
				this._drawPrompt();
				break;
			}

			case '/compact': {
				if (!this._currentSessionId) {
					this._write(line());
					this._write(line(`  ${DARK}No active session.${RESET}`));
					this._write(line());
					this._drawPrompt();
					break;
				}
				const compactSess = this.powerModeService.getSession(this._currentSessionId);
				if (!compactSess) { this._drawPrompt(); break; }
				const msgCount = compactSess.messages.length;
				if (msgCount < 4) {
					this._write(line());
					this._write(line(`  ${DARK}Conversation too short to compact (${msgCount} messages).${RESET}`));
					this._write(line());
					this._drawPrompt();
					break;
				}
				// Mark this session as being compacted — on next idle, we'll replace history
				this._compactingSessionId = this._currentSessionId;
				this._write(line());
				this._write(line(`  ${CYAN}${ARROW_DOWN}${RESET} ${DARK}Compacting ${msgCount} messages…${RESET}`));
				const compactPrompt = `Please summarize this conversation into a concise working-context block. Include: the goal, key decisions, files changed, and any open tasks. Reply ONLY with the summary — no preamble, no explanation.`;
				this.powerModeService.sendMessage(this._currentSessionId, compactPrompt).catch(() => { });
				break;
			}

			case '/plan': {
				if (!this._currentSessionId) { this._drawPrompt(); break; }
				const planSession = this.powerModeService.getSession(this._currentSessionId);
				if (planSession?.planMode) {
					this._write(line());
					this._write(line(`  ${YELLOW}Already in plan mode.${RESET} Use ${WHITE}/exit-plan${RESET} to resume editing.`));
					this._write(line());
				} else {
					// Send enter_plan_mode trigger as a user message
					this.powerModeService.sendMessage(this._currentSessionId, '/enter_plan_mode').catch(() => { });
				}
				this._drawPrompt();
				break;
			}

			case '/exit-plan': {
				if (!this._currentSessionId) { this._drawPrompt(); break; }
				const exitPlanSession = this.powerModeService.getSession(this._currentSessionId);
				if (!exitPlanSession?.planMode) {
					this._write(line());
					this._write(line(`  ${DARK}Not in plan mode.${RESET}`));
					this._write(line());
				} else {
					this.powerModeService.sendMessage(this._currentSessionId, '/exit_plan_mode').catch(() => { });
				}
				this._drawPrompt();
				break;
			}

			case '/worktree': {
				if (!this._currentSessionId) { this._drawPrompt(); break; }
				const wtSession = this.powerModeService.getSession(this._currentSessionId);
				this._write(line());
				if (wtSession?.worktree) {
					this._write(line(`  ${WHITE}${BOLD}Active worktree${RESET}`));
					this._write(line(`  ${CYAN}Path:${RESET}     ${wtSession.worktree.path}`));
					this._write(line(`  ${CYAN}Branch:${RESET}   ${wtSession.worktree.branch}`));
					this._write(line(`  ${CYAN}Original:${RESET} ${wtSession.worktree.originalDirectory}`));
					this._write(line(`  ${DARK}Use exit_worktree tool to return${RESET}`));
				} else {
					this._write(line(`  ${DARK}No active worktree. Use enter_worktree tool to create one.${RESET}`));
				}
				this._write(line());
				this._drawPrompt();
				break;
			}

			case '/crons': {
				if (!this._currentSessionId) { this._drawPrompt(); break; }
				this.powerModeService.sendMessage(this._currentSessionId, 'cron_list').catch(() => { });
				this._drawPrompt();
				break;
			}

			case '/tools': {
				this._write(line());
				this._write(line(`  ${WHITE}${BOLD}Tools${RESET}  ${DARK}· 85+ available${RESET}`));
				this._write(line());

				const sections: [string, string][] = [
					['Files', 'read  write  edit  multi_edit  list  glob  grep  notebook_edit'],
					['Shell', 'bash'],
					['Git', 'git_status  git_diff  git_log  git_add  git_commit  git_branch  git_stash  git_push  git_pull'],
					['Search', 'web_search  web_fetch'],
					['Memory', 'memory_read  memory_write  memory_list  memory_delete  memory_search'],
					['Tasks', 'tasks_create  tasks_list  tasks_update  tasks_get  tasks_delete'],
					['Agents', 'spawn_agent  get_agent_status  wait_for_agent  list_agents  send_message'],
					['Workflow', 'enter_plan_mode  exit_plan_mode  enter_worktree  exit_worktree'],
					['Schedule', 'cron_create  cron_list  cron_delete'],
					['Run', 'run_tests  ask_user'],
				];
				for (const [label, tools] of sections) {
					this._write(line(`  ${CYAN}${label.padEnd(10)}${RESET}  ${DARK}${tools}${RESET}`));
				}
				this._write(line());
				this._write(line(`  ${WHITE}${BOLD}Live views${RESET}  ${DARK}(slash commands)${RESET}`));
				this._write(line());
				const views: [string, string][] = [
					['/status', 'session, model, plan mode, worktree, tasks'],
					['/tasks', 'tracked tasks with status'],
					['/memory', 'persistent memory entries'],
					['/compact', 'summarize and compress conversation history'],
					['/sessions', 'all sessions with message counts'],
					['/agents', 'PowerBus agents + recent messages'],
					['/review', 'recent file changes with rollback'],
					['/crons', 'scheduled jobs'],
				];
				for (const [cmd, desc] of views) {
					this._write(line(`  ${CYAN}${cmd.padEnd(12)}${RESET}  ${DARK}${desc}${RESET}`));
				}
				this._write(line());
				this._drawPrompt();
				break;
			}

			default: {
				// Check for /rollback with optional filename or "all"
				if (command.startsWith('/rollback')) {
					const args = cmd.trim().split(/\s+/);
					const target = args[1]; // filename or "all" or undefined

					const changeGroup = this.powerModeService.getLatestChanges();
					if (!changeGroup) {
						this._write(line());
						this._write(line(`  ${DARK}No changes to rollback${RESET}`));
						this._write(line());
						this._drawPrompt();
						break;
					}

					const rollbackableChanges = changeGroup.changes.filter(c => !c.superseded);
					if (rollbackableChanges.length === 0) {
						this._write(line());
						this._write(line(`  ${DARK}No rollbackable changes (all superseded)${RESET}`));
						this._write(line());
						this._drawPrompt();
						break;
					}

					const tracker = this.powerModeService.getChangeTracker();

					// /rollback all - rollback everything
					if (target === 'all' || !target) {
						this._write(line());
						this._write(line(`  ${YELLOW}⚠${RESET}  ${WHITE}Rolling back ${rollbackableChanges.length} files...${RESET}`));

						tracker.rollbackGroup(changeGroup.sessionId, changeGroup.agentId).then(count => {
							this._write(line(`  ${GREEN}✓${RESET}  Rolled back ${count} files`));
							this._write(line());
							this._drawPrompt();
						}).catch(err => {
							this._write(line(`  ${RED}✗${RESET}  Rollback failed: ${err.message}`));
							this._write(line());
							this._drawPrompt();
						});
						break;
					}

					// /rollback <filename> - rollback specific file
					const targetChange = rollbackableChanges.find(c => {
						const fileName = c.filePath.split('/').pop() || '';
						return fileName === target || c.filePath.endsWith(target);
					});

					if (!targetChange) {
						this._write(line());
						this._write(line(`  ${RED}✗${RESET}  File not found: ${target}`));
						this._write(line());
						this._write(line(`  ${DARK}Available files:${RESET}`));
						for (const c of rollbackableChanges) {
							const fileName = c.filePath.split('/').pop() || c.filePath;
							this._write(line(`    ${fileName}`));
						}
						this._write(line());
						this._drawPrompt();
						break;
					}

					this._write(line());
					this._write(line(`  ${YELLOW}⚠${RESET}  ${WHITE}Rolling back ${target}...${RESET}`));

					tracker.rollbackChange(targetChange.id).then(success => {
						if (success) {
							this._write(line(`  ${GREEN}✓${RESET}  Rolled back ${target}`));
						} else {
							this._write(line(`  ${RED}✗${RESET}  Rollback failed (file may have been modified)`));
						}
						this._write(line());
						this._drawPrompt();
					}).catch(err => {
						this._write(line(`  ${RED}✗${RESET}  Rollback failed: ${err.message}`));
						this._write(line());
						this._drawPrompt();
					});
					break;
				}

				// Handle /switch command with dynamic argument
				if (command.startsWith('/switch ')) {
					const arg = cmd.trim().substring(8).trim(); // remove "/switch "
					const allSessions = this.powerModeService.sessions;

					// Try to parse as a number (1-indexed)
					const num = parseInt(arg, 10);
					if (!isNaN(num) && num >= 1 && num <= allSessions.length) {
						const targetSession = allSessions[num - 1];
						this._currentSessionId = targetSession.id;
						this.powerModeService.switchSession(targetSession.id);

						// Clear and redraw
						this._write(`${ESC}2J${ESC}H`);
						this._drawTopBar();
						this._write(line());
						this._write(line(`  ${GRAY}Switched to session: ${CYAN}${targetSession.title}${RESET}`));
						this._write(line());

						// Show message count
						if (targetSession.messages.length > 0) {
							const userCount = targetSession.messages.filter(m => m.role === 'user').length;
							this._write(line(`  ${GRAY}── ${userCount} message${userCount !== 1 ? 's' : ''} in session history  ${DARK}(/clear to reset)${RESET}`));
							this._write(line());
						}

						this._drawPrompt();
						break;
					}

					// Try direct session ID match
					const session = this.powerModeService.getSession(arg);
					if (session) {
						this._currentSessionId = session.id;
						this.powerModeService.switchSession(session.id);

						this._write(`${ESC}2J${ESC}H`);
						this._drawTopBar();
						this._write(line());
						this._write(line(`  ${GRAY}Switched to session: ${CYAN}${session.title}${RESET}`));
						this._write(line());
						this._drawPrompt();
						break;
					}

					// Not found
					this._write(line(`  ${RED}Session not found: ${arg}${RESET} ${DARK}— type /sessions to list all${RESET}`));
					this._drawPrompt();
					break;
				}

				// Check if it's a CC skill invocation: /skillname [args]
				const slashParts = cmd.trim().split(/\s+/);
				const potentialSkillName = slashParts[0]!.slice(1); // remove leading /
				const skillArgs = slashParts.slice(1).join(' ');
				const matchedSkill = this._ccSkills.find(
					s => s.name === potentialSkillName || (s.aliases && s.aliases.includes(potentialSkillName))
				);
				if (matchedSkill && this._currentSessionId) {
					this._write(line());
					this._write(line(`  ${MAGENTA}⏺${RESET}  ${BOLD}${matchedSkill.name}${RESET}  ${DARK}${matchedSkill.description}${RESET}`));
					this._write(line());
					this.powerModeService.invokeSkill(this._currentSessionId, matchedSkill.name, skillArgs)
						.then(ok => {
							if (!ok) {
								this._write(line(`  ${RED}Skill '${matchedSkill.name}' failed to invoke.${RESET}`));
								this._drawPrompt();
							}
							// if ok — the skill sends a message, agent loop will draw the response
						})
						.catch(() => {
							this._write(line(`  ${RED}Skill invocation error.${RESET}`));
							this._drawPrompt();
						});
					break;
				}

				// /security [mode]
				if (command.startsWith('/security')) {
					const secArg = cmd.trim().substring(9).trim().toLowerCase();
					const validSecModes = ['default', 'accept-edits', 'dont-ask', 'bypass'];
					this._write(line());
					if (!this._currentSessionId) {
						this._write(line(`  ${DARK}No active session.${RESET}`));
						this._write(line());
						this._drawPrompt();
						break;
					}
					if (secArg && validSecModes.includes(secArg)) {
						this.powerModeService.setPermissionMode(
							this._currentSessionId,
							secArg as import('../common/powerModeTypes.js').PowerPermissionMode
						);
						const modeDescriptions: Record<string, string> = {
							'default':       'prompt for every write/edit/bash operation',
							'accept-edits':  'auto-allow file edits inside working dir (bash still prompts)',
							'dont-ask':      'silently deny all write/edit/bash (read-only)',
							'bypass':        'allow everything — no prompts, no guards',
						};
						const modeColor = secArg === 'bypass' ? RED : secArg === 'dont-ask' ? CYAN : secArg === 'accept-edits' ? GREEN : WHITE;
						this._write(line(`  ${modeColor}${BOLD}Permission mode set: ${secArg}${RESET}`));
						this._write(line(`  ${DARK}${modeDescriptions[secArg] ?? ''}${RESET}`));
					} else if (secArg && !validSecModes.includes(secArg)) {
						this._write(line(`  ${RED}Unknown mode: ${secArg}${RESET}`));
						this._write(line(`  ${DARK}Valid modes: default  accept-edits  dont-ask  bypass${RESET}`));
					} else {
						const currentSecMode = this.powerModeService.getPermissionMode(this._currentSessionId);
						this._write(line(`  ${WHITE}${BOLD}Security / Permission Mode${RESET}`));
						this._write(line());
						const secModes: Array<[string, string]> = [
							['default',      'prompt for every write/edit/bash operation'],
							['accept-edits', 'auto-allow file edits inside working dir (bash still prompts)'],
							['dont-ask',     'silently deny all write/edit/bash (read-only)'],
							['bypass',       'allow everything — no prompts, no guards'],
						];
						for (const [m, desc] of secModes) {
							const active = m === currentSecMode;
							const bullet = active ? `${GREEN}>${RESET}` : ' ';
							const nameStyle = active ? `${WHITE}${BOLD}` : DARK;
							this._write(line(`  ${bullet} ${nameStyle}${m.padEnd(14)}${RESET}  ${DARK}${desc}${RESET}`));
						}
						this._write(line());
						this._write(line(`  ${DARK}Usage: /security <mode>   e.g. /security accept-edits${RESET}`));
						this._write(line());
						this._write(line(`  ${WHITE}${BOLD}Always-protected files (always flagged dangerous):${RESET}`));
						this._write(line(`  ${DARK}.gitconfig  .bashrc  .zshrc  .profile  .mcp.json  .claude.json${RESET}`));
						this._write(line(`  ${DARK}directories: .git  .vscode  .idea  .claude${RESET}`));
					}
					this._write(line());
					this._drawPrompt();
					break;
				}

				// /spawn <role> <goal>
				if (command.startsWith('/spawn')) {
					const spawnRaw = cmd.trim().substring(6).trim(); // remove "/spawn"
					const spawnParts = spawnRaw.split(/\s+/);
					const spawnRole = spawnParts[0]?.toLowerCase();
					const spawnGoal = spawnParts.slice(1).join(' ').trim();

					const validRoles = [
						'cc:explore', 'cc:plan', 'cc:general', 'cc:verify',
						'editor', 'verifier', 'debugger', 'tester',
						'compliance', 'reviewer', 'architect', 'documenter',
						'checks-agent', 'power-mode',
					];

					if (!spawnRole || !validRoles.includes(spawnRole)) {
						this._write(line());
						this._write(line(`  ${RED}Usage: /spawn <role> <goal>${RESET}`));
						this._write(line());
						this._write(line(`  ${WHITE}${BOLD}CC-backed agents (fast):${RESET}`));
						this._write(line(`  ${CYAN}cc:explore${RESET}  ${DARK}fast read-only search (haiku model)${RESET}`));
						this._write(line(`  ${CYAN}cc:plan${RESET}     ${DARK}architecture & implementation planning${RESET}`));
						this._write(line(`  ${CYAN}cc:general${RESET}  ${DARK}general research & multi-step tasks${RESET}`));
						this._write(line(`  ${CYAN}cc:verify${RESET}   ${DARK}adversarial verification — PASS/FAIL verdict (needs approval)${RESET}`));
						this._write(line());
						this._write(line(`  ${WHITE}${BOLD}Classic roles:${RESET}`));
						this._write(line(`  ${CYAN}editor  verifier  debugger  tester${RESET}  ${DARK}(write access — need approval)${RESET}`));
						this._write(line(`  ${CYAN}compliance  reviewer  architect  documenter${RESET}  ${DARK}(read-only)${RESET}`));
						this._write(line());
						this._drawPrompt();
						break;
					}

					if (!spawnGoal) {
						this._write(line());
						this._write(line(`  ${RED}Usage: /spawn ${spawnRole} <goal>${RESET}`));
						this._write(line(`  ${DARK}Example: /spawn cc:explore find all authentication-related files${RESET}`));
						this._write(line());
						this._drawPrompt();
						break;
					}

					this._write(line());
					this._write(line(`  ${CYAN}◈${RESET}  Spawning ${WHITE}${BOLD}${spawnRole}${RESET} agent…`));

					const task = this.powerModeService.spawnSubAgent(spawnRole, spawnGoal);
					if (!task) {
						this._write(line(`  ${RED}✗  Failed to spawn — sub-agent service unavailable or limit reached${RESET}`));
					} else {
						const shortId = task.id.substring(0, 8);
						this._write(line(`  ${GREEN}✓${RESET}  Spawned ${WHITE}${BOLD}${spawnRole}${RESET}  ${DARK}${shortId}${RESET}`));
						this._write(line(`     ${GRAY}${spawnGoal}${RESET}`));
						this._write(line(`  ${DARK}Live progress will appear automatically. /agents to view all.${RESET}`));
					}
					this._write(line());
					this._drawPrompt();
					break;
				}

				// /cancel-agent <id>
				if (command.startsWith('/cancel-agent')) {
					const cancelId = cmd.trim().substring(13).trim();
					if (!cancelId) {
						this._write(line());
						this._write(line(`  ${RED}Usage: /cancel-agent <id>${RESET}`));
						this._write(line(`  ${DARK}Use /agents to see agent IDs${RESET}`));
						this._write(line());
						this._drawPrompt();
						break;
					}
					// Support short IDs
					const allAgents = this.powerModeService.getSubAgents();
					const match = allAgents.find(a => a.id === cancelId || a.id.startsWith(cancelId));
					if (!match) {
						this._write(line());
						this._write(line(`  ${RED}Agent not found: ${cancelId}${RESET}`));
					} else {
						this.powerModeService.cancelSubAgent(match.id);
						this._write(line());
						this._write(line(`  ${YELLOW}○${RESET}  Cancelled ${match.role} agent ${DARK}${match.id.substring(0, 8)}${RESET}`));
					}
					this._write(line());
					this._drawPrompt();
					break;
				}

				// Unknown command
				this._write(line());
				this._write(line(`  ${RED}Unknown command: ${command}${RESET}`));
				this._write(line(`  ${DARK}Type /help for available commands${RESET}`));
				this._write(line());
				this._drawPrompt();
				break;
			}

			case '/help': {
				this._write(line());
				this._write(line(`  ${WHITE}${BOLD}Available commands:${RESET}`));
				this._write(line());
				for (const c of SLASH_COMMANDS) {
					this._write(line(`  ${CYAN}${c.name.padEnd(16)}${RESET} ${DARK}${c.description}${RESET}`));
				}
				if (this._ccSkills.length > 0) {
					this._write(line());
					this._write(line(`  ${WHITE}${BOLD}CC bundled skills:${RESET}`));
					this._write(line());
					for (const s of this._ccSkills) {
						const hint = s.argumentHint ? ` ${DARK}${s.argumentHint}${RESET}` : '';
						this._write(line(`  ${MAGENTA}/${s.name.padEnd(14)}${RESET}${hint} ${DARK}${s.description}${RESET}`));
						if (s.aliases && s.aliases.length > 0) {
							this._write(line(`  ${DARK}  aliases: ${s.aliases.map(a => `/${a}`).join(', ')}${RESET}`));
						}
					}
				}
				this._write(line());
				this._write(line(`  ${WHITE}${BOLD}Shortcuts:${RESET}`));
				this._write(line(`  ${CYAN}${'Ctrl+C'.padEnd(16)}${RESET} ${DARK}Cancel current response / clear input${RESET}`));
				this._write(line(`  ${CYAN}${'Escape'.padEnd(16)}${RESET} ${DARK}Stop response${RESET}`));
				this._write(line());
				this._drawPrompt();
				break;
			}

			case '/sessions': {
				const allSessions = this.powerModeService.sessions;
				this._write(line());
				this._write(line(`  ${WHITE}${BOLD}All sessions (${allSessions.length}):${RESET}`));
				this._write(line());
				if (allSessions.length === 0) {
					this._write(line(`  ${DARK}No sessions found${RESET}`));
				} else {
					for (let i = 0; i < allSessions.length; i++) {
						const s = allSessions[i];
						const isCurrent = s.id === this._currentSessionId;
						const marker = isCurrent ? `${GREEN}●${RESET}` : `${DARK}○${RESET}`;
						const age = Math.round((Date.now() - s.updatedAt) / 1000 / 60); // minutes ago
						const ageStr = age < 1 ? 'just now' : age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
						const msgCount = s.messages.length;
						const title = s.title.length > 40 ? s.title.substring(0, 37) + '...' : s.title;
						this._write(line(`  ${marker} ${WHITE}${String(i + 1).padStart(2)}.${RESET} ${CYAN}${title}${RESET}  ${DARK}(${msgCount} msgs, ${ageStr})${RESET}`));
						this._write(line(`     ${DARK}${s.id}${RESET}`));
					}
				}
				this._write(line());
				this._write(line(`  ${DARK}Type ${WHITE}/switch <number>${DARK} to resume a session${RESET}`));
				this._write(line());
				this._drawPrompt();
				break;
			}
		}
	}

	// ── Model Picker ────────────────────────────────────────────────────

	private _enterModelPicker(): void {
		const options = this.powerModeService.getAvailableModels();
		const current = this.powerModeService.getModelInfo();

		if (options.length === 0) {
			this._write(line());
			this._write(line(`  ${YELLOW}No models configured${RESET} ${DARK}— add a provider in Void Settings${RESET}`));
			this._write(line());
			this._drawPrompt();
			return;
		}

		this._modelPickerOptions = options.map(o => ({
			name: o.name,
			provider: o.selection.providerName,
			model: o.selection.modelName,
		}));
		this._modelPickerBuffer = '';
		this._inModelPicker = true;
		this._inputActive = false;

		this._write(line());
		this._write(line(`  ${WHITE}${BOLD}Select model:${RESET}  ${DARK}(current: ${CYAN}${current?.model ?? 'none'}${DARK})${RESET}`));
		this._write(line());
		this._modelPickerOptions.forEach((o, i) => {
			const isCurrent = o.model === current?.model && o.provider === current?.provider;
			const marker = isCurrent ? `${GREEN}●${RESET}` : `${DARK}○${RESET}`;
			this._write(line(`  ${marker} ${WHITE}${String(i + 1).padStart(2)}.${RESET} ${CYAN}${o.model}${RESET}  ${DARK}${o.provider}${RESET}`));
		});
		this._write(line());
		this._write(`  ${DARK}Enter number to select, ${WHITE}Esc${DARK} to cancel: ${RESET}`);
	}

	private _handleModelPickerInput(data: string): void {
		for (const ch of data) {
			if (ch === '\r' || ch === '\n') {
				const idx = parseInt(this._modelPickerBuffer, 10) - 1;
				if (!isNaN(idx) && idx >= 0 && idx < this._modelPickerOptions.length) {
					const chosen = this._modelPickerOptions[idx];
					const allOptions = this.powerModeService.getAvailableModels();
					const sel = allOptions[idx]?.selection;
					if (sel) {
						this.powerModeService.setModel(sel);
						this._write(line());
						this._write(line());
						this._write(line(`  Model set to ${CYAN}${chosen.model}${RESET}  ${DARK}${chosen.provider}${RESET}`));
					}
				} else if (this._modelPickerBuffer.trim()) {
					this._write(line());
					this._write(line(`  ${RED}Invalid selection${RESET}`));
				}
				this._inModelPicker = false;
				this._modelPickerBuffer = '';
				this._write(line());
				this._drawPrompt();

			} else if (ch === '\x1b' || ch === '\x03') {
				// Escape / Ctrl+C — cancel picker
				this._write(line());
				this._write(line(`  ${DARK}Cancelled${RESET}`));
				this._inModelPicker = false;
				this._modelPickerBuffer = '';
				this._write(line());
				this._drawPrompt();

			} else if (ch === '\x7f' || ch === '\b') {
				if (this._modelPickerBuffer.length > 0) {
					this._modelPickerBuffer = this._modelPickerBuffer.slice(0, -1);
					this._write('\b \b');
				}
			} else if (ch >= '0' && ch <= '9') {
				this._modelPickerBuffer += ch;
				this._write(`${WHITE}${ch}${RESET}`);
			}
		}
	}

	// ── Permission Prompt ───────────────────────────────────────────────

	// CC permission color: rgb(87,105,247) ≈ ANSI bright blue (94m)
	private _showPermissionPrompt(request: IPermissionRequest): void {
		this._stopThinking();
		this._inPermissionPrompt = true;
		this._pendingPermissionRequest = request;
		this._inputActive = false;

		this._write(line());
		// CC-style: bold tool name in permission color, then preview, then key hints
		this._write(line(`  ${BLUE_LIGHT}${BOLD}${request.toolName}${RESET}`));

		const previewLines = String(request.preview || '').split('\n').filter(Boolean);
		for (const l of previewLines) {
			const truncated = l.length > 90 ? l.substring(0, 87) + '…' : l;
			this._write(line(`  ${DARK}${truncated}${RESET}`));
		}

		this._write(line());
		this._write(`  ${DARK}Allow? [${WHITE}y${DARK}]es  [${WHITE}a${DARK}]lways  [${WHITE}n${DARK}]o  ${CYAN}${POINTER} ${RESET}`);
	}

	private _handlePermissionInput(data: string): void {
		const ch = data[0]?.toLowerCase();

		if (ch === 'y') {
			this._write(line(`${WHITE}y${RESET}`));
			this._resolvePermission('allow');
		} else if (ch === 'a') {
			this._write(line(`${WHITE}a${RESET}`));
			this._write(line(`  ${GRAY}All tools approved for this session${RESET}`));
			this._resolvePermission('allow-all');
		} else if (ch === 'n' || ch === '\x1b' || ch === '\x03') {
			this._write(line(`${WHITE}n${RESET}`));
			this._resolvePermission('deny');
		}
		// any other key — re-prompt
	}

	private _resolvePermission(decision: 'allow' | 'allow-all' | 'deny'): void {
		const req = this._pendingPermissionRequest;
		this._inPermissionPrompt = false;
		this._pendingPermissionRequest = undefined;
		if (req) {
			this.powerModeService.resolvePermission(req.requestId, decision);
		}
		// Don't call _drawPrompt here — agent loop will fire session-updated when done
	}

	// ── Question Prompt (ask_user tool) ─────────────────────────────────

	private _showQuestionPrompt(questionId: string, question: string): void {
		this._stopThinking();
		this._inQuestionPrompt = true;
		this._pendingQuestion = { questionId, question };
		this._questionBuffer = '';
		this._inputActive = false;
		this._lastDrawnToolPartId = undefined; // Prevent tool timers from overwriting this prompt

		this._write(line());

		// Parse question - check if it has numbered options
		const lines = question.split('\n').map(l => l.trim()).filter(l => l.length > 0);

		if (lines.length === 1) {
			// Simple single-line question
			this._write(line(`  ${BLUE_LIGHT}?${RESET}  ${WHITE}${BOLD}${question}${RESET}`));
		} else {
			// Multi-line question with options
			const firstLine = lines[0];
			const hasNumberedList = lines.some(l => /^\d+\./.test(l));

			if (hasNumberedList) {
				// Question with numbered options - format nicely
				this._write(line(`  ${BLUE_LIGHT}?${RESET}  ${WHITE}${BOLD}${firstLine}${RESET}`));
				this._write(line());

				for (let i = 1; i < lines.length; i++) {
					const l = lines[i];
					const isOption = /^(\d+)\.\s*(.+)/.exec(l);

					if (isOption) {
						const num = isOption[1];
						const text = isOption[2];
						this._write(line(`     ${CYAN}${num}.${RESET} ${WHITE}${text}${RESET}`));
					} else if (l.toLowerCase().includes('which') || l.toLowerCase().includes('what') || l.toLowerCase().includes('select')) {
						// Prompt line like "Which would you like?"
						this._write(line());
						this._write(line(`     ${DARK}${l}${RESET}`));
					} else {
						// Other text
						this._write(line(`     ${DARK}${l}${RESET}`));
					}
				}
				this._write(line());
			} else {
				// Multi-line but not a list - show all lines
				for (const l of lines) {
					this._write(line(`  ${BLUE_LIGHT}?${RESET}  ${WHITE}${l}${RESET}`));
				}
			}
		}

		this._write(`  ${CYAN}${BOLD}> ${RESET}`);
	}

	private _handleQuestionInput(data: string): void {
		for (const ch of data) {
			if (ch === '\r' || ch === '\n') {
				// Enter pressed
				const answer = this._questionBuffer.trim();
				if (!answer) { return; } // require non-empty answer

				this._write(line());
				this._resolveQuestion(answer);

			} else if (ch === '\x7f' || ch === '\b') {
				// Backspace
				if (this._questionBuffer.length > 0) {
					this._questionBuffer = this._questionBuffer.slice(0, -1);
					this._write('\b \b');
				}

			} else if (ch === '\x1b' || ch === '\x03') {
				// Escape or Ctrl+C — cancel
				this._write(line(`${RED}^C${RESET}`));
				this._resolveQuestion('[Cancelled]');

			} else if (ch >= ' ') {
				// Regular character
				this._questionBuffer += ch;
				this._write(`${WHITE}${ch}${RESET}`);
			}
		}
	}

	private _resolveQuestion(answer: string): void {
		const pending = this._pendingQuestion;
		this._inQuestionPrompt = false;
		this._pendingQuestion = undefined;
		this._questionBuffer = '';

		if (pending) {
			this.powerModeService.resolveQuestion(pending.questionId, answer);
		}
		// Don't call _drawPrompt here — agent loop will continue automatically
	}

	// ── Drawing ──────────────────────────────────────────────────────────

	private _write(data: string): void {
		this._domTerm?.write(data);
	}

	private _drawUserMessage(text: string): void {
		this._write(`\r${ESC}2K`);
		// Erase the '╭─' prompt box line above
		this._write(`${ESC}A${ESC}2K\r`);

		// CC style: ❯ pointer + message text (no box)
		const msgLines = text.split('\n');
		for (let i = 0; i < msgLines.length; i++) {
			const prefix = i === 0 ? `${CYAN}${BOLD}${POINTER}${RESET} ` : '  ';
			this._write(line(`${prefix}${WHITE}${msgLines[i]}${RESET}`));
		}
	}

	// ── CC-style: ↓ responding  3.2s ────────────────────────────────────────
	// Track cumulative token count for the ↓ N tokens display
	private _sessionTokens = 0;

	private _drawThinking(): void {
		this._inputActive = false;
		this._stopThinking();

		const start = Date.now();
		const verb = randomSpinnerVerb();
		const tokStr = () => this._sessionTokens > 0 ? ` · ${this._sessionTokens.toLocaleString()} tokens` : '';

		// Initial render
		this._write(`  ${CYAN}${ARROW_DOWN}${RESET} ${DIM}${verb}${RESET}${tokStr()}  ${DIM}esc to interrupt${RESET}`);

		let shimmerFrame = 0;
		this._runningTimeInterval = setInterval(() => {
			shimmerFrame++;
			const elapsedStr = ((Date.now() - start) / 1000).toFixed(1);
			const arrow = (shimmerFrame % 2 === 0) ? `${CYAN}${ARROW_DOWN}${RESET}` : `${DARK}${ARROW_DOWN}${RESET}`;
			const shimmered = shimmerVerb(verb, shimmerFrame);
			this._write(`\r${ESC}K  ${arrow} ${shimmered}${tokStr()}  ${DARK}${elapsedStr}s${RESET}  ${DIM}esc to interrupt${RESET}`);
		}, 160);
	}

	private _stopThinking(): void {
		if (this._thinkingInterval !== undefined) {
			clearInterval(this._thinkingInterval);
			this._thinkingInterval = undefined;
		}
		let wasRunning = false;
		if (this._runningTimeInterval !== undefined) {
			clearInterval(this._runningTimeInterval);
			this._runningTimeInterval = undefined;
			wasRunning = true;
		}
		if (wasRunning) {
			this._write(`\r${ESC}2K\r`); // only clear the line if the thinking timer was actively on it
		}
		this._inputActive = true;
	}

	private _endStreaming(): void {
		if (this._isStreaming) {
			if (this._streamTimeout) {
				clearTimeout(this._streamTimeout);
				this._streamTimeout = undefined;
			}
			if (this._streamingCursor) {
				this._write(' '); // erase ▋
				this._streamingCursor = false;
			}
			// Flush remaining line buffer with markdown formatting
			if (this._streamLineBuffer.trim()) {
				const fmt = this._formatMarkdownLine(this._streamLineBuffer);
				this._write(`\r${ESC}2K  ${fmt.colored}`);
			}
			this._streamLineBuffer = '';
			this._write(line());
			this._isStreaming = false;
			this._streamingPartId = undefined;
			this._streamCol = 2;
		}
	}

	private _drawText(text: string): void {
		this._endStreaming();

		// Skip empty or whitespace-only text parts
		if (!text || text.trim().length === 0) {
			return;
		}

		const lines = text.split('\n');
		for (const l of lines) {
			if (l.trim()) {
				const formatted = this._formatMarkdownLine(l);
				// For long lines, just output formatted version without wrapping to preserve markdown
				this._write(line(`  ${formatted.colored}`));
			} else {
				this._write(line());
			}
		}
	}

	private _wrapText(text: string, width: number): string[] {
		if (text.length <= width) { return [text]; }
		const words = text.split(' ');
		const result: string[] = [];
		let current = '';
		for (const word of words) {
			if (current.length + word.length + 1 <= width) {
				current += (current ? ' ' : '') + word;
			} else {
				if (current) { result.push(current); }
				current = word;
			}
		}
		if (current) { result.push(current); }
		return result;
	}

	private _drawReasoning(text: string): void {
		this._endStreaming();
		if (!text || !text.trim()) { return; }

		// Track duration: if this is the first reasoning block, start timer
		if (this._reasoningStartTime === undefined) {
			this._reasoningStartTime = Date.now();
		}
		const durationSec = ((Date.now() - this._reasoningStartTime) / 1000).toFixed(1);
		this._lastReasoningDuration = Date.now() - this._reasoningStartTime;

		// CC style: "∴ Thinking" header with elapsed, content dim + italic
		const durLabel = parseFloat(durationSec) >= 2 ? `  ${DARK}${durationSec}s${RESET}` : '';
		this._write(line(`  ${DIM}${ITALIC}${THEREFORE} Thinking${RESET}${durLabel}`));

		const lines = text.split('\n');
		for (const l of lines) {
			if (l.trim()) {
				const wrapped = this._wrapText(l, 96);
				for (const w of wrapped) {
					this._write(line(`    ${DIM}${ITALIC}${DARK}${w}${RESET}`));
				}
			} else {
				this._write(line());
			}
		}
	}

	private readonly _activeToolTimers = new Map<string, ReturnType<typeof setInterval>>();

	/** Build a concise inline arg preview for a tool call — matches Claude Code's ToolName(arg) style */
	private _toolInputPreview(toolName: string, input: Record<string, any>): string {
		const short = (s: string | undefined, max = 48) =>
			s ? (s.length > max ? s.substring(0, max - 1) + '…' : s) : '';
		const filename = (p: string | undefined) => p ? p.split('/').slice(-2).join('/') : '';

		switch (toolName) {
			case 'bash': return short(String(input.command ?? ''), 52);
			case 'read': return filename(input.filePath);
			case 'write': return filename(input.filePath);
			case 'edit': return filename(input.filePath);
			case 'multi_edit': return filename(input.filePath);
			case 'glob': return short(input.pattern);
			case 'grep': return short(input.pattern);
			case 'list': return filename(input.path);
			case 'web_fetch': return short(input.url, 52);
			case 'web_search': return short(input.query);
			case 'git_commit': return short(input.message);
			case 'git_diff': return input.staged ? 'staged' : '';
			case 'git_branch': return short(input.branchName ?? input.name);
			case 'git_push': return short(input.remote ?? '');
			case 'memory_write': return short(input.key);
			case 'memory_read': return short(input.key);
			case 'memory_delete': return short(input.key);
			case 'memory_search': return short(input.query);
			case 'tasks_create': return short(input.title);
			case 'tasks_update': return short(input.taskId);
			case 'tasks_get': return short(input.taskId);
			case 'tasks_delete': return short(input.taskId);
			case 'spawn_agent': return short(`${input.role ?? ''}: ${input.goal ?? ''}`, 52);
			case 'send_message': return short(`→ ${input.toAgentId ?? input.to ?? ''}`);
			case 'notebook_edit': return filename(input.filePath);
			case 'cron_create': return short(input.cron ?? input.schedule);
			default: return '';
		}
	}

	private _drawToolStart(partId: string, toolName: string, title?: string, input?: Record<string, any>): void {
		// If already animated, just update the live label (timer will re-render it)
		if (this._drawnRunningTools.has(partId)) {
			if (title) { this._activeToolLabels.set(partId, title); }
			return;
		}

		// Build display label: prefer tool-set title, fall back to input preview
		const label = title || (input ? this._toolInputPreview(toolName, input) : '');

		this._drawnRunningTools.add(partId);
		this._activeToolLabels.set(partId, label);
		this._stopThinking();
		this._endStreaming();

		// Use ⏺ (Claude Code style) — cursor stays on line for in-place updates
		this._write(`  ${CYAN}⏺${RESET}  ${BOLD}${toolName}${RESET}${label ? ` ${GRAY}${label}${RESET}` : ''}`);
		this._lastDrawnToolPartId = partId;

		const start = Date.now();
		let blinkOn = true;
		const interval = setInterval(() => {
			if (!this._drawnRunningTools.has(partId) || this._lastDrawnToolPartId !== partId) {
				clearInterval(interval);
				return;
			}
			blinkOn = !blinkOn;
			const elapsed = ((Date.now() - start) / 1000).toFixed(1);
			const dot = blinkOn ? `${CYAN}⏺${RESET}` : `${DARK}⏺${RESET}`;
			const currentLabel = this._activeToolLabels.get(partId) || label;
			const labelStr = currentLabel ? ` ${GRAY}${currentLabel}${RESET}` : '';
			this._write(`\r${ESC}K  ${dot}  ${BOLD}${toolName}${RESET}${labelStr} ${DARK}${elapsed}s${RESET}`);
		}, 500);
		this._activeToolTimers.set(partId, interval);
	}

	private _drawToolComplete(partId: string, toolName: string, title: string | undefined, duration: string): void {
		const timer = this._activeToolTimers.get(partId);
		if (timer) {
			clearInterval(timer);
			this._activeToolTimers.delete(partId);
		}

		const label = title || this._activeToolLabels.get(partId) || '';
		this._activeToolLabels.delete(partId);
		const labelStr = label ? ` ${GRAY}${label}${RESET}` : '';

		if (this._lastDrawnToolPartId === partId) {
			this._write(`\r${ESC}K  ${GREEN}⏺${RESET}  ${BOLD}${toolName}${RESET}${labelStr} ${DARK}${duration}${RESET}\r\n`);
		} else {
			this._write(line(`  ${GREEN}⏺${RESET}  ${BOLD}${toolName}${RESET}${labelStr} ${DARK}${duration}${RESET}`));
		}
		this._lastDrawnToolPartId = undefined;
	}

	private _drawToolError(partId: string, toolName: string, error: string): void {
		const timer = this._activeToolTimers.get(partId);
		if (timer) {
			clearInterval(timer);
			this._activeToolTimers.delete(partId);
		}
		const label = this._activeToolLabels.get(partId) || '';
		this._activeToolLabels.delete(partId);
		const labelStr = label ? ` ${GRAY}${label}${RESET}` : '';

		// Truncate long error messages (e.g. "Unknown tool: X. Available: A, B, C...")
		// to just the first sentence — the tool list is noise in the TUI
		const shortError = error.length > 80 ? error.split(/[.!]\s/)[0]! + '.' : error;

		if (this._lastDrawnToolPartId === partId) {
			this._write(`\r${ESC}K  ${RED}⏺${RESET}  ${BOLD}${toolName}${RESET}${labelStr} ${RED}${shortError}${RESET}\r\n`);
		} else {
			this._write(line(`  ${RED}⏺${RESET}  ${BOLD}${toolName}${RESET}${labelStr} ${RED}${shortError}${RESET}`));
		}
		this._lastDrawnToolPartId = undefined;
	}

	private _hrWidth(): number {
		// Content-width rule: match terminal width minus margins, capped at 80
		return Math.min(Math.max(this._cols - 6, 20), 80);
	}

	/**
	 * Re-render a single line from tool output.
	 * Handles the common case of tab-separated numbered file content:
	 *   "   1\t/** ..."  →  "    1  /** ..."  (dim number, no tab)
	 * Falls back to 2-space-indented plain text.
	 */
	private _formatOutputLine(l: string): string {
		// Strip trailing whitespace / carriage returns
		const raw = l.replace(/[\r]+$/, '');

		// Numbered file content: optional leading spaces, digits, then tab/spaces/→ separator
		// CC uses two formats: compact "N\tcontent" or padded "     N→content"
		const m = raw.match(/^\s{0,8}(\d+)(?:[\t ][ \t]*|\u2192)(.*)$/);
		if (m) {
			const num = m[1].padStart(4, ' ');
			const content = m[2];
			return `  ${DARK}${num}${RESET}  ${WHITE}${content}${RESET}`;
		}

		// Key-value output (e.g. "Language:    c, unknown")
		const kv = raw.match(/^(\s{0,4}[\w ]+):\s{2,}(.+)$/);
		if (kv) {
			return `  ${DARK}${kv[1]}:${RESET}  ${kv[2]}`;
		}

		return `  ${raw}`;
	}

	private _drawToolOutput(output: string): void {
		// CC-style: dim top rule, then reformatted lines with consistent 2-space indent
		const MAX_LINES = 20;
		const allLines = output.split('\n');
		const nonEmpty = allLines.filter(l => l.trim());
		const showLines = nonEmpty.slice(0, MAX_LINES);

		this._write(line(`  ${DARK}${HR.repeat(this._hrWidth())}${RESET}`));

		for (const l of showLines) {
			this._write(line(this._formatOutputLine(l)));
		}

		if (nonEmpty.length > MAX_LINES) {
			this._write(line(`  ${DARK}… ${nonEmpty.length - MAX_LINES} more lines${RESET}`));
		}
	}

	/** Apply inline markdown: bold+italic, bold, italic, code, links */
	private _applyInlineMarkdown(text: string): string {
		let s = text;
		// Bold+italic: ***text***
		s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, `${BOLD}${ITALIC}$1${RESET}${WHITE}`);
		// Bold: **text**
		s = s.replace(/\*\*([^*\n]+)\*\*/g, `${BOLD}$1${RESET}${WHITE}`);
		// Italic: *text* (not bold)
		s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, `${ITALIC}$1${RESET}${WHITE}`);
		// Italic: _text_ (not __bold__)
		s = s.replace(/(?<!_)_([^_\n]+)_(?!_)/g, `${ITALIC}$1${RESET}${WHITE}`);
		// Inline code: `text`
		s = s.replace(/`([^`\n]+)`/g, `${YELLOW}$1${RESET}${WHITE}`);
		// Links: [text](url) → text (cyan)
		s = s.replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, `${CYAN}$1${RESET}${WHITE}`);
		return s;
	}

	private _formatMarkdownLine(input: string): { colored: string; plain: string } {
		const raw = input.replace(/\r$/, '');

		// 1. Horizontal rules: ---, ----, ─────, ***, ___
		if (raw.match(/^\s*(?:[-─]{3,}|[*]{3,}|[_]{3,})\s*$/)) {
			const ruleLen = this._hrWidth();
			return { colored: `${DARK}${HR.repeat(ruleLen)}${RESET}`, plain: HR.repeat(ruleLen) };
		}

		// 2. Headers (H1–H6)
		const headerMatch = raw.match(/^(\s*)(#{1,6})\s+(.+)$/);
		if (headerMatch) {
			const level = headerMatch[2]!.length;
			const text = headerMatch[3]!;
			const style = level === 1 ? `${BOLD}${WHITE}` : level === 2 ? `${BOLD}${CYAN}` : `${CYAN}`;
			const inlined = this._applyInlineMarkdown(text);
			return { colored: `${style}${inlined}${RESET}`, plain: text };
		}

		// 3. Code block delimiters: ``` or ~~~
		if (raw.match(/^\s*(?:```|~~~)/)) {
			return { colored: `${DARK}${raw}${RESET}`, plain: raw };
		}

		// 4. Blockquote: > text
		const bqMatch = raw.match(/^(\s*)>\s?(.*)$/);
		if (bqMatch) {
			const text = bqMatch[2]!;
			return { colored: `${DARK}▎${RESET} ${DIM}${ITALIC}${this._applyInlineMarkdown(text)}${RESET}`, plain: text };
		}

		// 5. Table separator row: |---|---| or :---: etc.
		if (raw.match(/^\s*\|?[\s:|-]{3,}\|/)) {
			return { colored: `${DARK}${raw}${RESET}`, plain: raw };
		}

		// 6. Table row: | col | col |
		if (raw.match(/^\s*\|.+\|/)) {
			const colored = raw.replace(/\|/g, `${DARK}|${RESET}${WHITE}`);
			return { colored: `${WHITE}${colored}${RESET}`, plain: raw };
		}

		// 7. Ordered list: 1. text
		const orderedMatch = raw.match(/^(\s*)(\d+)\.\s+(.*)$/);
		if (orderedMatch) {
			const indent = orderedMatch[1]!;
			const num = orderedMatch[2]!;
			const text = orderedMatch[3]!;
			return {
				colored: `${indent}${DARK}${num}.${RESET} ${WHITE}${this._applyInlineMarkdown(text)}${RESET}`,
				plain: `${indent}${num}. ${text}`,
			};
		}

		// 8. Unordered list: - / * / • item
		const bulletMatch = raw.match(/^(\s*)[-*•]\s+(.*)$/);
		if (bulletMatch) {
			const indent = bulletMatch[1]!;
			const text = bulletMatch[2]!;
			return {
				colored: `${indent}${DARK}•${RESET} ${WHITE}${this._applyInlineMarkdown(text)}${RESET}`,
				plain: `${indent}• ${text}`,
			};
		}

		// 9. Default: white text with inline formatting
		const plain = raw.replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1')
			.replace(/\*\*([^*\n]+)\*\*/g, '$1')
			.replace(/`([^`\n]+)`/g, '$1')
			.replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1');
		const colored = `${WHITE}${this._applyInlineMarkdown(raw)}${RESET}`;
		return { colored, plain };
	}

	private _drawEditDiff(oldStr: string, newStr: string): void {
		// CC-style compact diff: no box, just +/- lines with dim rule
		const MAX = 6;
		const oldLines = oldStr.split('\n').filter(l => l.trim());
		const newLines = newStr.split('\n').filter(l => l.trim());

		this._write(line(`  ${DARK}${HR.repeat(this._hrWidth())}${RESET}`));

		for (const l of oldLines.slice(0, MAX)) {
			const preview = l.length > 88 ? l.substring(0, 85) + '…' : l;
			this._write(line(`  ${RED}-${RESET} ${DARK}${preview}${RESET}`));
		}
		if (oldLines.length > MAX) { this._write(line(`  ${DARK}… ${oldLines.length - MAX} more${RESET}`)); }

		for (const l of newLines.slice(0, MAX)) {
			const preview = l.length > 88 ? l.substring(0, 85) + '…' : l;
			this._write(line(`  ${GREEN}+${RESET} ${preview}`));
		}
		if (newLines.length > MAX) { this._write(line(`  ${DARK}… ${newLines.length - MAX} more${RESET}`)); }
	}

	private _drawWriteContent(content: string): void {
		// CC-style: new file lines, dim rule separator, max 10 shown
		const MAX = 10;
		const allLines = content.split('\n').filter(l => l.trim());

		this._write(line(`  ${DARK}${HR.repeat(this._hrWidth())}${RESET}`));

		for (const l of allLines.slice(0, MAX)) {
			this._write(line(`  ${GREEN}+${RESET} ${l}`));
		}
		if (allLines.length > MAX) {
			this._write(line(`  ${DARK}… ${allLines.length - MAX} more lines${RESET}`));
		}
	}

	private _drawStepFinish(tokens?: { input: number; output: number }, cost?: number): void {
		this._endStreaming();
		// Update cumulative token count (used by ↓ indicator)
		if (tokens) { this._sessionTokens += tokens.output; }

		// CC-style: dim footer with token/cost info inline
		const parts: string[] = [];

		// Show "thought for Xs" if reasoning was part of this step (CC pattern)
		if (this._lastReasoningDuration !== undefined && this._lastReasoningDuration >= 500) {
			const thoughtSec = (this._lastReasoningDuration / 1000).toFixed(1);
			parts.push(`${THEREFORE} thought for ${thoughtSec}s`);
		}

		if (tokens) {
			parts.push(`${ARROW_DOWN} ${(tokens.input + tokens.output).toLocaleString()} tokens`);
		}
		if (cost && cost > 0) { parts.push(`$${cost.toFixed(4)}`); }
		// Show session total cost if > 0
		if (this._sessionCostUSD > 0) {
			const sessionCostStr = this._sessionCostUSD > 0.5
				? `$${this._sessionCostUSD.toFixed(2)} total`
				: `$${this._sessionCostUSD.toFixed(4)} total`;
			parts.push(sessionCostStr);
		}

		if (parts.length > 0) {
			this._write(line(`  ${DARK}${parts.join(' · ')}${RESET}`));
		}

		// Reset reasoning timer for next step
		this._lastReasoningDuration = undefined;
	}

	private _drawError(error: string): void {
		this._endStreaming();
		this._write(line());
		// CC-style error: just the message, no box
		this._write(line(`  ${RED}✗ ${error}${RESET}`));
	}

	private _drawBusMessage(from: string, to: string | '*', msgType: string, content: string): void {
		const preview = content.length > 80 ? content.substring(0, 80) + '…' : content;
		const toStr = to === '*' ? `${MAGENTA}broadcast${RESET}` : `${MAGENTA}${to}${RESET}`;
		if (msgType === 'tool-request') {
			// Animate: show a pulsing "agent knock" with 3 frames then settle
			const frames = [
				`  ${BLUE_LIGHT}[agent-bus]${RESET}  ${CYAN}${from}${RESET} ${DARK}--->${RESET} ${toStr}`,
				`  ${BLUE_LIGHT}[agent-bus]${RESET}  ${CYAN}${from}${RESET} ${YELLOW}--->${RESET} ${toStr}`,
				`  ${BLUE_LIGHT}[agent-bus]${RESET}  ${CYAN}${from}${RESET} ${GREEN}--->${RESET} ${toStr}`,
			];
			let frame = 0;
			this._write(line());
			this._write(`${frames[0]}${ESC}K`);
			const iv = setInterval(() => {
				frame++;
				if (frame < frames.length) {
					this._write(`
${frames[frame]}${ESC}K`);
				} else {
					clearInterval(iv);
					this._write(line());
					this._write(line(`  ${DARK}  > ${preview}${RESET}`));
				}
			}, 160);
		} else if (msgType === 'tool-result') {
			this._write(line());
			this._write(line(`  ${BLUE_LIGHT}[agent-bus]${RESET}  ${toStr} ${GREEN}<---${RESET} ${CYAN}${from}${RESET}  ${DARK}[result]${RESET}`));
			this._write(line(`  ${DARK}  > ${preview}${RESET}`));
		} else if (msgType === 'broadcast') {
			// Show blocking violation alerts prominently; suppress routine posture pings
			try {
				const data = JSON.parse(content);
				if (data.type === 'blocking-violations-alert' && data.blockingCount > 0) {
					// Deduplicate - only show if count or violations changed
					const alertHash = `${data.blockingCount}:${data.topViolations || ''}`;
					if (this._lastBlockingAlertHash === alertHash) {
						return; // Skip duplicate
					}
					this._lastBlockingAlertHash = alertHash;

					this._write(line());
					this._write(line(`${RED}[checks-agent]${RESET} ${data.blockingCount} blocking violation${data.blockingCount > 1 ? 's' : ''}${RESET} ${DARK}(commit gated)${RESET}`));
					if (data.topViolations) {
						for (const v of String(data.topViolations).split('\n').slice(0, 3)) {
							// Truncate long paths
							const truncated = v.length > 80 ? v.substring(0, 77) + '...' : v;
							this._write(line(`  ${DARK}${truncated}${RESET}`));
						}
					}
				}
				// Routine grc-posture-update broadcasts are silently ignored
			} catch { /* not JSON */ }
		} else {
			this._write(line());
			this._write(line(`  ${BLUE_LIGHT}[bus]${RESET}  ${CYAN}${from}${RESET} ${DARK}-->${RESET} ${toStr}  ${DARK}[${msgType}]${RESET}`));
			this._write(line(`  ${DARK}  ${preview}${RESET}`));
		}
	}

	private _drawDone(): void {
		this._stopThinking();
		this._endStreaming();
		// Per-turn separator — thin dim ─ rule between conversation turns (CC style)
		this._write(line());
		this._write(line(`  ${DARK}${HR.repeat(this._hrWidth())}${RESET}`));
	}

	// ── Input handling ──────────────────────────────────────────────────

	private _handleInput(data: string): void {
		if (this._inPermissionPrompt) {
			this._handlePermissionInput(data);
			return;
		}

		if (this._inQuestionPrompt) {
			this._handleQuestionInput(data);
			return;
		}

		if (this._inModelPicker) {
			this._handleModelPickerInput(data);
			return;
		}

		if (!this._inputActive) {
			// Even when not active, handle Escape and Ctrl+C to stop
			if (data === '\x1b' || data === '\x03') {
				if (this._isBusy && this._currentSessionId) {
					this.powerModeService.cancel(this._currentSessionId);
					this._write(line(`\r\n${RED}  ■ stopped${RESET}`));
				}
			}
			return;
		}

		for (const ch of data) {
			if (ch === '\r' || ch === '\n') {
				// Enter pressed
				const text = this._inputBuffer.trim();
				if (!text) { return; }

				this._stopInputCursor();
				this._hideSlashMenu();
				this._inputActive = false;

				// Check for slash commands
				if (text.startsWith('/')) {
					this._write(line()); // newline after input
					this._executeSlashCommand(text);
					return;
				}

				this._drawUserMessage(text);

				// Token estimate — show a hint for large inputs (>500 estimated tokens)
				const estTokens = this.powerModeService.estimateTokens(text);
				if (estTokens > 500) {
					this._write(line(`  ${DARK}~${estTokens.toLocaleString()} tokens${RESET}`));
				}

				// Send to service
				if (!this._currentSessionId) {
					const session = this.powerModeService.createSession();
					this._currentSessionId = session.id;
				}
				this.powerModeService.sendMessage(this._currentSessionId, text);

			} else if (ch === '\x7f' || ch === '\b') {
				// Backspace
				if (this._inputBuffer.length > 0) {
					this._stopInputCursor();
					this._inputBuffer = this._inputBuffer.slice(0, -1);
					this._write('\b \b');

					// Update slash menu on backspace
					if (this._inputBuffer.startsWith('/')) {
						this._showSlashMenu(this._inputBuffer);
					} else if (this._showingSlashMenu) {
						this._hideSlashMenu();
					}
					this._startInputCursor();
				}

			} else if (ch === '\x1b') {
				// Escape — stop response
				if (this._isBusy && this._currentSessionId) {
					this.powerModeService.cancel(this._currentSessionId);
					this._write(line(`\r\n${RED}  ■ stopped${RESET}`));
				}

			} else if (ch === '\x03') {
				// Ctrl+C
				if (this._isBusy && this._currentSessionId) {
					this.powerModeService.cancel(this._currentSessionId);
					this._write(line(`${RED}^C${RESET}`));
				} else {
					this._inputBuffer = '';
					this._hideSlashMenu();
					this._write(line(`${RED}^C${RESET}`));
					this._drawPrompt();
				}

			} else if (ch === '\t') {
				// Tab — autocomplete slash command
				if (this._inputBuffer.startsWith('/') && this._slashFilteredCommands.length === 1) {
					const completed = this._slashFilteredCommands[0].name;
					// Clear current input display
					const backspaces = this._inputBuffer.length;
					this._write('\b \b'.repeat(backspaces));
					this._inputBuffer = completed;
					this._write(`${WHITE}${completed}${RESET}`);
					this._hideSlashMenu();
				}

			} else if (ch >= ' ') {
				// Regular character
				this._stopInputCursor();
				this._inputBuffer += ch;
				this._write(`${WHITE}${ch}${RESET}`);

				// Show slash menu when typing /
				if (this._inputBuffer.startsWith('/')) {
					this._showSlashMenu(this._inputBuffer);
				} else {
					this._startInputCursor();
				}
			}
		}
	}

	// ── Service events ──────────────────────────────────────────────────

	private _handleUIEvent(event: PowerModeUIEvent): void {
		switch (event.type) {
			case 'session-created':
				this._currentSessionId = event.session.id;
				this._sessionTokens = 0;
				this._sessionCostUSD = 0;
				this._sessionInputTokens = 0;
				this._sessionOutputTokens = 0;
				this._tokenWarningActive = false;
				this._tokenWarningBlocking = false;
				this._tokenPctLeft = 100;
				this._serviceCompactActive = false;
				this._reasoningStartTime = undefined;
				this._lastReasoningDuration = undefined;
				break;

			case 'session-updated':
				this._isBusy = event.status === 'busy';
				if (event.status === 'busy') {
					this._drawThinking();
				} else if (event.status === 'idle' || event.status === 'error') {
					// If this session was being compacted, extract the summary from the
					// last assistant message and replace history with it
					if (event.status === 'idle' && this._compactingSessionId && this._compactingSessionId === event.sessionId) {
						const compactSess = this.powerModeService.getSession(event.sessionId);
						if (compactSess) {
							// Find the last assistant message text (the summary the LLM just generated)
							const lastAsst = [...compactSess.messages].reverse().find(m => m.role === 'assistant');
							const summaryText = lastAsst?.parts
								.filter((p): p is ITextPart => p.type === 'text')
								.map(p => p.text)
								.join('\n')
								.trim() ?? '';
							if (summaryText) {
								const prevCount = compactSess.messages.length;
								this.powerModeService.compactSession(event.sessionId, summaryText);

								// Clear entire screen + scrollback, then show only the summary
								this._write(`${ESC}3J${ESC}2J${ESC}H`); // clear scrollback + screen + home
								this._drawWelcome();
								this._write(line(`  ${GREEN}⏺${RESET} ${DARK}Compacted ${prevCount} messages${RESET}`));
								this._write(line());
								// Render the summary inline with markdown
								for (const l of summaryText.split('\n')) {
									const fmt = this._formatMarkdownLine(l);
									this._write(line(`  ${fmt.colored}`));
								}
								this._write(line());
								this._drawPrompt();
								this._compactingSessionId = undefined;
								return; // skip the normal _drawDone + _drawPrompt below
							}
						}
						this._compactingSessionId = undefined;
					}
					this._drawDone();
					this._drawPrompt();
				}
				break;

			case 'message-created':
				// User messages already drawn by _handleInput
				// For assistant messages, clear the "thinking..." text
				if (event.message.role === 'assistant') {
					// Clear the thinking line and stay on same line for streaming
					this._write(`\r${ESC}2K\r`);
					// Reset per-turn reasoning timer
					this._reasoningStartTime = undefined;
					this._lastReasoningDuration = undefined;
				}
				break;

			case 'part-updated': {
				const part = event.part;
				switch (part.type) {
					case 'text':
						// Only draw if not already rendered via part-delta streaming
						if (part.text && !this._streamedPartIds.has(part.id)) {
							this._drawText(part.text);
						}
						break;
					case 'reasoning':
						if (part.text && !this._streamedPartIds.has(part.id)) {
							this._drawReasoning(part.text);
						}
						break;
					case 'tool': {
						const st = part.state;
						if (st.status === 'running') {
							this._drawToolStart(part.id, part.toolName, st.title, st.input);
						} else if (st.status === 'completed') {
							const dur = st.time?.end && st.time?.start
								? ((st.time.end - st.time.start) / 1000).toFixed(1) + 's'
								: '';
							this._drawToolComplete(part.id, part.toolName, st.title, dur);
							if (part.toolName === 'edit' && st.input?.old_string && st.input?.new_string) {
								this._drawEditDiff(String(st.input.old_string), String(st.input.new_string));
							} else if (part.toolName === 'write' && (st.input?.content || st.input?.file_contents)) {
								this._drawWriteContent(String(st.input.content || st.input.file_contents));
							} else if (st.output) {
								this._drawToolOutput(st.output);
							}
							// Resume thinking indicator while LLM decides next action
							this._drawThinking();
						} else if (st.status === 'error') {
							this._drawToolError(part.id, part.toolName, st.error || 'unknown error');
						}
						break;
					}
					case 'step-start':
						// Step start — clear thinking indicator
						this._write(`\r${ESC}2K`);
						break;
					case 'step-finish':
						this._drawStepFinish(part.tokens, part.cost);
						break;
				}
				break;
			}

			case 'part-delta': {
				this._stopThinking();
				this._streamedPartIds.add(event.partId);

				if (!this._isStreaming || this._streamingPartId !== event.partId) {
					this._endStreaming();
					this._isStreaming = true;
					this._streamingPartId = event.partId;
					this._streamCol = 2;
					this._write(`\r\n  ${WHITE}`);
				}

				// Reset stream timeout (120s - reasoning models need more time)
				if (this._streamTimeout) {
					clearTimeout(this._streamTimeout);
				}
				this._streamTimeout = setTimeout(() => {
					if (this._isStreaming) {
						this._endStreaming();
						this._write(line());
						this._write(line(`${RED}[Stream timeout - response incomplete]${RESET}`));
						this._write(line());
						this._drawPrompt();
					}
				}, 120000);

				// Erase stale cursor before writing new delta
				if (this._streamingCursor) {
					this._write(' \b');
					this._streamingCursor = false;
				}

				// Line-buffered streaming with markdown formatting.
				// Buffer chars until \n, then re-render the complete line with
				// _formatMarkdownLine so bold/code/etc. are properly styled.
				const MAX_COL = Math.max(this._cols - 10, 60);
				const INDENT = '  ';
				const raw = event.delta;
				let out = '';
				let col = this._streamCol;
				let lineBuf = this._streamLineBuffer;

				for (let i = 0; i < raw.length; i++) {
					const ch = raw[i]!;
					if (ch === '\n') {
						// Complete logical line — re-render with markdown formatting
						const fmt = this._formatMarkdownLine(lineBuf);
						// Overwrite the raw partial line with formatted version, then newline
						out += `\r${ESC}2K${INDENT}${fmt.colored}`;
						out += `\r\n${INDENT}${WHITE}`;
						col = INDENT.length;
						lineBuf = '';
					} else if (ch === '\r') {
						// skip bare CR
					} else {
						lineBuf += ch;
						// Word-wrap: break at space boundary (logical line continues in buffer)
						if (col >= MAX_COL && ch === ' ') {
							out += `\r\n${INDENT}${WHITE}`;
							col = INDENT.length;
						} else {
							out += ch;
							col++;
						}
					}
				}

				this._streamLineBuffer = lineBuf;
				this._streamCol = col;
				this._write(out);

				// Show the non-destructive block cursor
				this._write(`${CYAN}▋${RESET}${WHITE}\b`);
				this._streamingCursor = true;

				break;
			}

			case 'permission-request':
				this._showPermissionPrompt(event.request);
				break;

			case 'user-question':
				this._showQuestionPrompt((event as any).questionId, (event as any).question);
				break;

			case 'bus-message':
				// Only display messages not originating from power-mode itself
				if (event.from !== 'power-mode') {
					this._drawBusMessage(event.from, event.to, event.messageType, event.content);
				}
				break;

			case 'error':
				this._drawError(event.error);
				this._drawPrompt();
				break;

			case 'skill-list':
				// CC bundled skills received — update dynamic slash commands
				this._ccSkills = event.skills;
				break;

			case 'token-warning': {
				this._tokenWarningActive = true;
				this._tokenWarningBlocking = event.isAtBlockingLimit;
				this._tokenPctLeft = event.percentLeft;
				// Show inline warning (only once per threshold crossing to avoid spam)
				const warningColor = event.isAtBlockingLimit ? RED : YELLOW;
				const warningIcon = event.isAtBlockingLimit ? '⚠' : '↑';
				const warningText = event.isAtBlockingLimit
					? `Context nearly full (${event.percentLeft}% left) — /compact now to continue`
					: `Context ${100 - event.percentLeft}% used (${event.percentLeft}% left) — /compact to free space`;
				this._write(line());
				this._write(line(`  ${warningColor}${warningIcon}  ${warningText}${RESET}`));
				break;
			}

			case 'compact-started':
				if (!this._compactingSessionId) {
					// Service-triggered auto-compact (not user /compact command)
					this._serviceCompactActive = true;
					this._write(line());
					this._write(line(`  ${CYAN}↓${RESET}  ${DARK}Auto-compacting context…${RESET}`));
				}
				break;

			case 'compact-done':
				if (this._serviceCompactActive) {
					this._serviceCompactActive = false;
					this._tokenWarningActive = false;
					this._tokenPctLeft = 100;
					this._write(line(`  ${GREEN}⏺${RESET}  ${DARK}Context compacted${RESET}`));
					this._write(line());
				}
				break;

			case 'session-cost':
				// Update local cost counters (used by /status)
				this._sessionCostUSD = event.cost.totalCostUSD;
				this._sessionInputTokens = event.cost.totalInputTokens;
				this._sessionOutputTokens = event.cost.totalOutputTokens;
				break;

			case 'sub-agent-updated': {
				const a = event.agent;
				if (a.status === 'running' || a.status === 'pending') {
					this._startAgentProgress(a.id, a.role, a.goal);
				} else {
					this._stopAgentProgress(a.id, a.status, a.result, a.error);
				}
				break;
			}
		}
	}

	// ── Resize ──────────────────────────────────────────────────────────

	private _fitTerminal(): void {
		if (!this._domTerm || !this._container) { return; }
		const rect = this._container.getBoundingClientRect();
		if (rect.width > 0) {
			// ~7.8px per character at 13px Cascadia Code
			const cols = Math.max(40, Math.floor(rect.width / 7.8));
			this._domTerm.resize(cols, this._domTerm.rows);
			this._cols = cols;
		}
	}

	layout(width?: number, _height?: number): void {
		if (width && width > 0) {
			const cols = Math.max(40, Math.floor(width / 7.8));
			this._domTerm?.resize(cols, this._domTerm.rows);
			this._cols = cols;
		} else {
			this._fitTerminal();
		}
	}

	override dispose(): void {
		this._stopInputCursor();
		for (const entry of this._liveAgents.values()) {
			clearInterval(entry.interval);
		}
		this._liveAgents.clear();
		super.dispose();
	}
}
