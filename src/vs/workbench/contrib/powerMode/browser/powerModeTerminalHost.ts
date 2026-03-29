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
import { PowerModeUIEvent, IPermissionRequest } from '../common/powerModeTypes.js';
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
	{ name: '/review', description: 'Review recent file changes' },
	{ name: '/rollback [file]', description: 'Rollback all changes or specific file' },
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
		const modelStr = modelInfo ? `${modelInfo.model}` : 'no model selected';
		const providerStr = modelInfo ? `(${modelInfo.provider})` : '';

		const sessionsCount = this.powerModeService.sessions.length;
		const recentStr = sessionsCount > 0 ? `${sessionsCount} session${sessionsCount !== 1 ? 's' : ''}` : 'No recent activity';

		this._write(line());
		this._write(line(`  ${BLUE_LIGHT}✦${RESET} ${WHITE}${BOLD}Neural Inverse Power Mode${RESET}  ${DARK}•${RESET}  ${CYAN}${modelStr}${RESET} ${DARK}${providerStr}${RESET}  ${DARK}•${RESET}  ${DARK}~/workspace${RESET}`));
		this._write(line(`  ${DARK}Run ${WHITE}/help${DARK} for commands  •  ${recentStr}${RESET}`));
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
		this._streamingCursor = false;

		// ── Structured prompt ────────────────────────────────────
		this._write(line());
		this._write(line(`${BLUE_LIGHT}╭─${RESET}`));
		this._write(`${BLUE_LIGHT}│${RESET} ${CYAN}${BOLD}❯ ${RESET}`);
	}

	// ── Slash Command Menu ──────────────────────────────────────────────

	private _showSlashMenu(filter: string): void {
		const query = filter.toLowerCase().slice(1);
		this._slashFilteredCommands = SLASH_COMMANDS.filter(
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
					this._write(line(`  ${CYAN}${c.name.padEnd(12)}${RESET} ${DARK}${c.description}${RESET}`));
				}
				this._write(line());
				this._write(line(`  ${WHITE}${BOLD}Shortcuts:${RESET}`));
				this._write(line(`  ${CYAN}${'Ctrl+C'.padEnd(12)}${RESET} ${DARK}Cancel current response / clear input${RESET}`));
				this._write(line(`  ${CYAN}${'Escape'.padEnd(12)}${RESET} ${DARK}Stop response${RESET}`));
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

	private _showPermissionPrompt(request: IPermissionRequest): void {
		this._stopThinking();
		this._inPermissionPrompt = true;
		this._pendingPermissionRequest = request;
		this._inputActive = false;

		const pad = '  ';
		this._write(line());
		this._write(line(`${pad}${YELLOW}╭─ Tool Approval Required${RESET}`));
		this._write(line(`${pad}${YELLOW}│${RESET} ${MAGENTA}${BOLD}${request.toolName}${RESET}`));

		const lines = String(request.preview || '').split('\n');
		for (const l of lines) {
			this._write(line(`${pad}${YELLOW}│${RESET} ${DARK}${l}${RESET}`));
		}

		this._write(line(`${pad}${YELLOW}╰─${RESET}`));
		this._write(`${pad}${DARK}Press: [${GREEN}y${DARK}] yes  [${GREEN}a${DARK}] yes all  [${RED}n${DARK}] no  ${CYAN}❯ ${RESET}`);
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
		// Erase the '╭─ Inquire' line above the prompt
		this._write(`${ESC}A${ESC}2K\r`);
		this._write(line(`${BLUE_LIGHT}╭─ User${RESET}`));
		const msgLines = text.split('\n');
		for (const l of msgLines) {
			this._write(line(`${BLUE_LIGHT}│${RESET} ${WHITE}${l}${RESET}`));
		}
		this._write(line(`${BLUE_LIGHT}╰─${RESET}`));
	}

	private readonly _thinkingVerbs = [
		'Cogitated', 'Orchestrating', 'Synthesizing', 'Validating',
		'Analyzing', 'Reconciling', 'Queued', 'Indexing', 'Persisting'
	];
	private readonly _spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

	private _drawThinking(): void {
		this._inputActive = false;
		this._stopThinking();

		const start = Date.now();
		const verb = this._thinkingVerbs[Math.floor(Math.random() * this._thinkingVerbs.length)];

		// NO trailing \r\n — cursor stays parked on this line for in-place updates
		this._write(`  ${MAGENTA}⠋${RESET} ${DARK}${verb} for 0.0s...${RESET}`);

		let frameIdx = 0;
		this._runningTimeInterval = setInterval(() => {
			const elapsedStr = ((Date.now() - start) / 1000).toFixed(1);
			frameIdx = (frameIdx + 1) % this._spinnerFrames.length;
			const frame = this._spinnerFrames[frameIdx];
			// \r rewinds to the start of the CURRENT line to overwrite
			this._write(`\r${ESC}K  ${MAGENTA}${frame}${RESET} ${DARK}${verb} for ${elapsedStr}s...${RESET}`);
		}, 100);
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
			this._write(line());
			this._isStreaming = false;
			this._streamingPartId = undefined;
			this._streamCol = 2; // reset column tracker
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
		const lines = text.split('\n');
		for (const l of lines) {
			if (l.trim()) {
				const wrapped = this._wrapText(l, 100);
				for (const w of wrapped) {
					this._write(line(`${DIM}${ITALIC}${DARK}${w}${RESET}`));
				}
			} else {
				this._write(line());
			}
		}
	}

	private readonly _activeToolTimers = new Map<string, ReturnType<typeof setInterval>>();

	private _drawToolStart(partId: string, toolName: string, title?: string): void {
		if (this._drawnRunningTools.has(partId) || !title) { return; }
		this._drawnRunningTools.add(partId);
		this._stopThinking();
		this._endStreaming();
		// NO trailing \r\n — cursor stays parked on this line for in-place updates
		this._write(`  ${CYAN}⠋${RESET}  ${toolName} ${GRAY}${title}${RESET}`);
		this._lastDrawnToolPartId = partId;

		const start = Date.now();
		let frameIdx = 0;
		const interval = setInterval(() => {
			if (!this._drawnRunningTools.has(partId) || this._lastDrawnToolPartId !== partId) {
				clearInterval(interval);
				return;
			}
			const elapsed = ((Date.now() - start) / 1000).toFixed(1);
			frameIdx = (frameIdx + 1) % this._spinnerFrames.length;
			const frame = this._spinnerFrames[frameIdx];
			// \r rewinds to the start of the CURRENT line to overwrite
			this._write(`\r${ESC}K  ${CYAN}${frame}${RESET}  ${toolName} ${GRAY}${title} · ${elapsed}s${RESET}`);
		}, 100);
		this._activeToolTimers.set(partId, interval);
	}

	private _drawToolComplete(partId: string, toolName: string, title: string | undefined, duration: string): void {
		const timer = this._activeToolTimers.get(partId);
		if (timer) {
			clearInterval(timer);
			this._activeToolTimers.delete(partId);
		}

		if (this._lastDrawnToolPartId === partId) {
			// Overwrite the in-place spinner line, then commit with newline
			this._write(`\r${ESC}K  ${GREEN}✓${RESET}  ${toolName} ${GRAY}${title || ''}${RESET} ${DARK}${duration}${RESET}\r\n`);
		} else {
			this._write(line(`  ${GREEN}✓${RESET}  ${toolName} ${GRAY}${title || ''}${RESET} ${DARK}${duration}${RESET}`));
		}
		this._lastDrawnToolPartId = undefined;
	}

	private _drawToolError(partId: string, toolName: string, error: string): void {
		const timer = this._activeToolTimers.get(partId);
		if (timer) {
			clearInterval(timer);
			this._activeToolTimers.delete(partId);
		}
		if (this._lastDrawnToolPartId === partId) {
			this._write(`\r${ESC}K  ${RED}✗${RESET}  ${toolName} ${RED}${error}${RESET}\r\n`);
		} else {
			this._write(line(`  ${RED}✗${RESET}  ${toolName} ${RED}${error}${RESET}`));
		}
		this._lastDrawnToolPartId = undefined;
	}

	private _drawToolOutput(output: string): void {
		const MAX_LINES = 15;
		const allLines = output.split('\n');
		const showLines = allLines.slice(0, MAX_LINES);

		const pad = '    ';
		this._write(line(`${pad}${DARK}╭─ output${RESET}`));

		for (const l of showLines) {
			const formatted = this._formatMarkdownLine(l);
			// Output formatted line - let terminal wrap naturally to preserve markdown
			this._write(line(`${pad}${DARK}│${RESET} ${formatted.colored}`));
		}

		if (allLines.length > MAX_LINES) {
			this._write(line(`${pad}${DARK}│${RESET} ${DARK}... ${allLines.length - MAX_LINES} omitted${RESET}`));
		}

		this._write(line(`${pad}${DARK}╰─${RESET}`));
	}

	private _formatMarkdownLine(line: string): { colored: string; plain: string } {
		let plain = line;
		let colored = line;

		// Strip code blocks
		plain = plain.replace(/```[\w]*$/g, '');
		colored = colored.replace(/```[\w]*$/g, '');

		// Headers: ## Text -> Text (bold/colored)
		if (plain.match(/^\s*#{1,6}\s+/)) {
			plain = plain.replace(/^\s*#{1,6}\s+/, '');
			colored = `${CYAN}${BOLD}${plain}${RESET}`;
			return { colored, plain };
		}

		// Horizontal rules
		if (plain.match(/^\s*[-\u2500]{3,}\s*$/)) {
			colored = `${DARK}${plain}${RESET}`;
			return { colored, plain };
		}

		// Bold: **text** -> text (bold) - re-apply WHITE after RESET
		colored = colored.replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${RESET}${WHITE}`);
		plain = plain.replace(/\*\*([^*]+)\*\*/g, '$1');

		// Special prefix patterns like **+** or ☑
		colored = colored.replace(/^(\s*)(\*\*[+*\u2611\u2713\u2717\u2500\u2192\u2190]+\*\*)/g, `$1${CYAN}${BOLD}$2${RESET}${WHITE}`);

		// Inline code: `text` -> text (highlighted) - re-apply WHITE after RESET
		colored = colored.replace(/`([^`]+)`/g, `${YELLOW}$1${RESET}${WHITE}`);
		plain = plain.replace(/`([^`]+)`/g, '$1');

		// Links: [text](url) -> text - re-apply WHITE after RESET
		colored = colored.replace(/\[([^\]]+)\]\([^)]+\)/g, `${CYAN}$1${RESET}${WHITE}`);
		plain = plain.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

		// Bullets: - text or • text
		if (plain.match(/^\s*[-*\u2022]\s+/)) {
			plain = plain.replace(/^\s*[-*\u2022]\s+/, '\u2022 ');
			colored = `${WHITE}${plain}${RESET}`;
			return { colored, plain };
		}

		// Default: use white for normal text
		colored = `${WHITE}${colored}${RESET}`;
		return { colored, plain };
	}

	private _drawEditDiff(oldStr: string, newStr: string): void {
		const MAX = 8;
		const oldLines = oldStr.split('\n');
		const newLines = newStr.split('\n');
		const oldShow = oldLines.slice(0, MAX);
		const newShow = newLines.slice(0, MAX);

		const pad = '    ';
		this._write(line(`${pad}${DARK}╭─ diff preview${RESET}`));

		for (const l of oldShow) { this._write(line(`${pad}${DARK}│${RESET} ${RED}-${RESET} ${l}`)); }
		if (oldLines.length > MAX) { this._write(line(`${pad}${DARK}│${RESET} ${DARK}... ${oldLines.length - MAX} omitted${RESET}`)); }

		for (const l of newShow) { this._write(line(`${pad}${DARK}│${RESET} ${GREEN}+${RESET} ${l}`)); }
		if (newLines.length > MAX) { this._write(line(`${pad}${DARK}│${RESET} ${DARK}... ${newLines.length - MAX} omitted${RESET}`)); }

		this._write(line(`${pad}${DARK}╰─${RESET}`));
	}

	private _drawWriteContent(content: string): void {
		const MAX = 12;
		const lines = content.split('\n');
		const show = lines.slice(0, MAX);

		const pad = '    ';
		this._write(line(`${pad}${DARK}╭─ write preview${RESET}`));

		for (const l of show) { this._write(line(`${pad}${DARK}│${RESET} ${GREEN}+${RESET} ${l}`)); }

		if (lines.length > MAX) {
			this._write(line(`${pad}${DARK}│${RESET} ${DARK}... ${lines.length - MAX} omitted${RESET}`));
		}
		this._write(line(`${pad}${DARK}╰─${RESET}`));
	}

	private _drawStepFinish(tokens?: { input: number; output: number }, cost?: number): void {
		this._endStreaming();
		let info = '';
		if (tokens) { info += `${tokens.input} in / ${tokens.output} out`; }
		if (cost) { info += ` $${cost.toFixed(4)}`; }
		if (info) {
			this._write(line(`${DARK}${info}${RESET}`));
		}
	}

	private _drawError(error: string): void {
		this._endStreaming();
		this._write(line());
		this._write(line(`  ${RED}${BOLD}error:${RESET} ${RED}${error}${RESET}`));
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
				break;

			case 'session-updated':
				this._isBusy = event.status === 'busy';
				if (event.status === 'busy') {
					this._drawThinking();
				} else if (event.status === 'idle' || event.status === 'error') {
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
							this._drawToolStart(part.id, part.toolName, st.title);
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

				// Word-wrap the delta at 90 cols with a 2-space left indent
				const MAX_COL = 90;
				const INDENT = '  ';
				const raw = event.delta;
				let out = '';
				let col = this._streamCol;

				for (let i = 0; i < raw.length; i++) {
					const ch = raw[i];
					if (ch === '\n') {
						out += '\r\n' + INDENT;
						col = INDENT.length;
					} else if (ch === '\r') {
						// skip bare CR
					} else {
						// If adding this char would overflow, break at the last space
						if (col >= MAX_COL && ch === ' ') {
							out += '\r\n' + INDENT;
							col = INDENT.length;
						} else {
							out += ch;
							col++;
						}
					}
				}

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
	}

	layout(_width?: number, _height?: number): void {
		this._fitTerminal();
	}

	override dispose(): void {
		super.dispose();
	}
}
