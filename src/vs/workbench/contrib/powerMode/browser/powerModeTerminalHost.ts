/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

/**
 * PowerModeTerminalHost — real xterm.js terminal for Power Mode.
 *
 * Uses VS Code's ITerminalService.createDetachedTerminal() to get a real
 * xterm instance that renders in a DOM container.
 *
 * Renders a Claude Code-style TUI with:
 * - Top status bar (model, session, cost)
 * - Streaming output area
 * - Bottom prompt with slash commands
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Color } from '../../../../base/common/color.js';
import { IColorTheme } from '../../../../platform/theme/common/themeService.js';
import { ITerminalService, IDetachedTerminalInstance, IXtermColorProvider } from '../../terminal/browser/terminal.js';
import { DetachedProcessInfo } from '../../terminal/browser/detachedTerminal.js';
import { IPowerModeService } from './powerModeService.js';
import { PowerModeUIEvent, IPermissionRequest, ISkillInfo, ITextPart } from '../common/powerModeTypes.js';
import { TERMINAL_BACKGROUND_COLOR } from '../../terminal/common/terminalColorRegistry.js';
import { PANEL_BACKGROUND } from '../../../common/theme.js';

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
// Divider char (Divider.tsx)
const HR = '─';

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
	{ name: '/help', description: 'Show available commands' },
];

export class PowerModeTerminalHost extends Disposable {

	private _terminal: IDetachedTerminalInstance | undefined;
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

	constructor(
		private readonly terminalService: ITerminalService,
		private readonly powerModeService: IPowerModeService,
	) {
		super();
		this._register(this.powerModeService.onDidEmitUIEvent(e => this._handleUIEvent(e)));
	}

	async createTerminal(container: HTMLElement): Promise<void> {
		this._container = container;

		const colorProvider: IXtermColorProvider = {
			getBackgroundColor(theme: IColorTheme): Color | undefined {
				return theme.getColor(TERMINAL_BACKGROUND_COLOR) || theme.getColor(PANEL_BACKGROUND);
			}
		};

		const processInfo = new DetachedProcessInfo({});

		this._terminal = await this.terminalService.createDetachedTerminal({
			cols: 120,
			rows: 40,
			colorProvider,
			readonly: false,
			processInfo,
		});

		this._register(this._terminal);

		// Attach to the DOM
		this._terminal.attachToElement(container);

		// Style the container to fill all available space
		container.style.width = '100%';
		container.style.height = '100%';
		container.style.overflow = 'hidden';
		container.style.position = 'absolute';
		container.style.top = '0';
		container.style.left = '0';
		container.style.right = '0';
		container.style.bottom = '0';

		// Handle keyboard input from the real terminal
		const rawXterm = (this._terminal.xterm as any).raw;
		if (rawXterm?.onData) {
			rawXterm.onData((data: string) => {
				this._handleInput(data);
			});
		}

		// Large scrollback so users can scroll up through full conversation history
		if (rawXterm) {
			rawXterm.options.scrollback = 10000;
		}

		// Fit terminal to container after a brief delay to allow layout
		setTimeout(() => this._fitTerminal(), 50);

		// Use ResizeObserver to auto-fit when container size changes
		const resizeObserver = new ResizeObserver(() => this._fitTerminal());
		resizeObserver.observe(container);
		this._register({ dispose: () => resizeObserver.disconnect() });

		// Draw initial screen
		this._drawTopBar();
		this._drawWelcome();
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

	// ── Bottom bar (drawn inline before prompt) ─────────────────────────

	private _drawPrompt(): void {
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
				const agents = this.powerModeService.getAgentsOnBus();
				const history = this.powerModeService.getBusHistory(10);
				this._write(line());
				this._write(line(`  ${WHITE}${BOLD}Connected agents (${agents.length}):${RESET}`));
				this._write(line());
				if (agents.length === 0) {
					this._write(line(`  ${DARK}No agents registered${RESET}`));
				} else {
					for (const a of agents) {
						const caps = a.capabilities.join(', ');
						const uptime = Math.round((Date.now() - a.registeredAt) / 1000);
						this._write(line(`  ${CYAN}${BOLD}${(a.displayName ?? a.agentId).padEnd(18)}${RESET}  ${DARK}${caps}${RESET}  ${DARK}${uptime}s${RESET}`));
					}
				}
				if (history.length > 0) {
					this._write(line());
					this._write(line(`  ${WHITE}${BOLD}Recent bus messages:${RESET}`));
					this._write(line());
					for (const m of history.slice(-10)) {
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
						pending:     `${DARK}·${RESET}`,
						in_progress: `${CYAN}⟳${RESET}`,
						completed:   `${GREEN}✓${RESET}`,
						blocked:     `${RED}✗${RESET}`,
					};
					const statusColor: Record<string, string> = {
						pending:     DARK,
						in_progress: CYAN,
						completed:   GREEN,
						blocked:     RED,
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

				// Session cost (from CC token tracker)
				if (this._sessionCostUSD > 0 || this._sessionInputTokens > 0) {
					const costStr = this._sessionCostUSD > 0
						? `$${this._sessionCostUSD > 0.5 ? this._sessionCostUSD.toFixed(2) : this._sessionCostUSD.toFixed(4)}`
						: '';
					const tokStr = `${(this._sessionInputTokens + this._sessionOutputTokens).toLocaleString()} tokens`;
					this._write(line(`  ${CYAN}Session cost:${RESET} ${WHITE}${costStr ? costStr + '  ' : ''}${tokStr}${RESET}`));
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
					['Files',     'read  write  edit  multi_edit  list  glob  grep  notebook_edit'],
					['Shell',     'bash'],
					['Git',       'git_status  git_diff  git_log  git_add  git_commit  git_branch  git_stash  git_push  git_pull'],
					['Search',    'web_search  web_fetch'],
					['Memory',    'memory_read  memory_write  memory_list  memory_delete  memory_search'],
					['Tasks',     'tasks_create  tasks_list  tasks_update  tasks_get  tasks_delete'],
					['Agents',    'spawn_agent  get_agent_status  wait_for_agent  list_agents  send_message'],
					['Workflow',  'enter_plan_mode  exit_plan_mode  enter_worktree  exit_worktree'],
					['Schedule',  'cron_create  cron_list  cron_delete'],
					['Run',       'run_tests  ask_user'],
				];
				for (const [label, tools] of sections) {
					this._write(line(`  ${CYAN}${label.padEnd(10)}${RESET}  ${DARK}${tools}${RESET}`));
				}
				this._write(line());
				this._write(line(`  ${WHITE}${BOLD}Live views${RESET}  ${DARK}(slash commands)${RESET}`));
				this._write(line());
				const views: [string, string][] = [
					['/status',   'session, model, plan mode, worktree, tasks'],
					['/tasks',    'tracked tasks with status'],
					['/memory',   'persistent memory entries'],
					['/compact',  'summarize and compress conversation history'],
					['/sessions', 'all sessions with message counts'],
					['/agents',   'PowerBus agents + recent messages'],
					['/review',   'recent file changes with rollback'],
					['/crons',    'scheduled jobs'],
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
		this._terminal?.xterm.write(data);
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

		// CC style: "↓ responding" with elapsed, no random verbs
		// Arrow blinks between ↓ and dim ↓ to signal activity
		let blinkOn = true;
		const tokStr = () => this._sessionTokens > 0 ? ` · ${this._sessionTokens.toLocaleString()} tokens` : '';

		this._write(`  ${CYAN}${ARROW_DOWN}${RESET} ${DARK}responding${tokStr()}  ${DIM}esc to interrupt${RESET}`);

		this._runningTimeInterval = setInterval(() => {
			blinkOn = !blinkOn;
			const elapsedStr = ((Date.now() - start) / 1000).toFixed(1);
			const arrow = blinkOn ? `${CYAN}${ARROW_DOWN}${RESET}` : `${DARK}${ARROW_DOWN}${RESET}`;
			this._write(`\r${ESC}K  ${arrow} ${DARK}responding${tokStr()}  ${elapsedStr}s  ${DIM}esc to interrupt${RESET}`);
		}, 600);
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

		// CC style: collapsed by default with ∴ Thinking header, content dim + italic
		this._write(line(`  ${DIM}${ITALIC}${THEREFORE} Thinking${RESET}`));

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
			case 'bash':         return short(String(input.command ?? ''), 52);
			case 'read':         return filename(input.filePath);
			case 'write':        return filename(input.filePath);
			case 'edit':         return filename(input.filePath);
			case 'multi_edit':   return filename(input.filePath);
			case 'glob':         return short(input.pattern);
			case 'grep':         return short(input.pattern);
			case 'list':         return filename(input.path);
			case 'web_fetch':    return short(input.url, 52);
			case 'web_search':   return short(input.query);
			case 'git_commit':   return short(input.message);
			case 'git_diff':     return input.staged ? 'staged' : '';
			case 'git_branch':   return short(input.branchName ?? input.name);
			case 'git_push':     return short(input.remote ?? '');
			case 'memory_write': return short(input.key);
			case 'memory_read':  return short(input.key);
			case 'memory_delete':return short(input.key);
			case 'memory_search':return short(input.query);
			case 'tasks_create': return short(input.title);
			case 'tasks_update': return short(input.taskId);
			case 'tasks_get':    return short(input.taskId);
			case 'tasks_delete': return short(input.taskId);
			case 'spawn_agent':  return short(`${input.role ?? ''}: ${input.goal ?? ''}`, 52);
			case 'send_message': return short(`→ ${input.toAgentId ?? input.to ?? ''}`);
			case 'notebook_edit':return filename(input.filePath);
			case 'cron_create':  return short(input.cron ?? input.schedule);
			default:             return '';
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

		// CC-style: thin ─ divider with token/cost info inline
		const parts: string[] = [];
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

				this._hideSlashMenu();
				this._inputActive = false;

				// Check for slash commands
				if (text.startsWith('/')) {
					this._write(line()); // newline after input
					this._executeSlashCommand(text);
					return;
				}

				this._drawUserMessage(text);

				// Send to service
				if (!this._currentSessionId) {
					const session = this.powerModeService.createSession();
					this._currentSessionId = session.id;
				}
				this.powerModeService.sendMessage(this._currentSessionId, text);

			} else if (ch === '\x7f' || ch === '\b') {
				// Backspace
				if (this._inputBuffer.length > 0) {
					this._inputBuffer = this._inputBuffer.slice(0, -1);
					this._write('\b \b');

					// Update slash menu on backspace
					if (this._inputBuffer.startsWith('/')) {
						this._showSlashMenu(this._inputBuffer);
					} else if (this._showingSlashMenu) {
						this._hideSlashMenu();
					}
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
				this._inputBuffer += ch;
				this._write(`${WHITE}${ch}${RESET}`);

				// Show slash menu when typing /
				if (this._inputBuffer.startsWith('/')) {
					this._showSlashMenu(this._inputBuffer);
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
		}
	}

	// ── Resize ──────────────────────────────────────────────────────────

	private _fitTerminal(): void {
		if (!this._terminal || !this._container) { return; }
		const rawXterm = (this._terminal.xterm as any).raw;
		if (!rawXterm) { return; }

		const fitAddon = (this._terminal.xterm as any)._fitAddon;
		if (fitAddon?.fit) {
			fitAddon.fit();
			this._cols = rawXterm.cols || this._cols;
			return;
		}

		// Manual fit: compute cols/rows from container dimensions
		const core = rawXterm._core;
		if (!core) { return; }
		const cellWidth = core._renderService?.dimensions?.css?.cell?.width;
		const cellHeight = core._renderService?.dimensions?.css?.cell?.height;
		if (!cellWidth || !cellHeight) { return; }

		const rect = this._container.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) { return; }

		const cols = Math.max(2, Math.floor(rect.width / cellWidth));
		const rows = Math.max(2, Math.floor(rect.height / cellHeight));
		rawXterm.resize(cols, rows);
		this._cols = cols;
	}

	layout(_width?: number, _height?: number): void {
		this._fitTerminal();
	}

	override dispose(): void {
		super.dispose();
	}
}
