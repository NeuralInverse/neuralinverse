/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ChecksAgentTerminalHost — real xterm.js terminal for the Checks Agent.
 *
 * Adapted from PowerModeTerminalHost. Uses VS Code's ITerminalService.createDetachedTerminal()
 * to render a real xterm instance in the Checks Manager window.
 *
 * Color palette:
 *   Brand (blue):  #64b4ff   — accent/success
 *   Tool (amber):  #e6aa50   — enforcement/audit trail
 *   Error (red):   #f06464
 *   Text (white):  #d2dae6
 *   Muted (gray):  #8291a5
 *   Dark:          #465264
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Color } from '../../../../../base/common/color.js';
import { IColorTheme } from '../../../../../platform/theme/common/themeService.js';
import { ITerminalService, IDetachedTerminalInstance, IXtermColorProvider } from '../../../terminal/browser/terminal.js';
import { DetachedProcessInfo } from '../../../terminal/browser/detachedTerminal.js';
import { IChecksAgentService } from './checksAgentService.js';
import { ChecksAgentUIEvent } from './checksAgentTypes.js';
import { TERMINAL_BACKGROUND_COLOR } from '../../../terminal/common/terminalColorRegistry.js';
import { PANEL_BACKGROUND } from '../../../../common/theme.js';

// ── ANSI helpers ───────────────────────────────────────────────────────
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;

// Checks Agent palette (ANSI standard - inherits from VS Code terminal theme)
const TEAL   = `${ESC}36m`;      // terminal.ansiCyan
const AMBER  = `${ESC}33m`;      // terminal.ansiYellow
const RED    = `${ESC}31m`;      // terminal.ansiRed
const WHITE  = `${ESC}97m`;      // terminal.ansiBrightWhite
const GRAY   = `${ESC}90m`;      // terminal.ansiBrightBlack
const DARK   = `${ESC}90m`;      // terminal.ansiBrightBlack
const BLUE   = `${ESC}34m`;      // terminal.ansiBlue

function line(text: string = ''): string { return text + '\r\n'; }

// ── ASCII Logo ─────────────────────────────────────────────────────────
const ICON_LINES = [
	'         10110        ',
	'      10001101        ',
	'   11011010001        ',
	' 1011101101000 1101   ',
	'11011010001101 1101101',
	'00011011101101 0001101',
	'11011010001101 1101101',
	'00011011101101 0001101',
	'1101101000110     1110',
	'11010001101           ',
	'11011010              ',
	'0011                  ',
];

const LOGO_LINES = [
	'   ██████╗██╗  ██╗███████╗ ██████╗██╗  ██╗███████╗',
	'  ██╔════╝██║  ██║██╔════╝██╔════╝██║ ██╔╝██╔════╝',
	'  ██║     ███████║█████╗  ██║     █████╔╝ ███████╗',
	'  ██║     ██╔══██║██╔══╝  ██║     ██╔═██╗ ╚════██║',
	'  ╚██████╗██║  ██║███████╗╚██████╗██║  ██╗███████║',
	'   ╚═════╝╚═╝  ╚═╝╚══════╝ ╚═════╝╚═╝  ╚═╝╚══════╝',
	'   █████╗  ██████╗ ███████╗███╗   ██╗████████╗',
	'  ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝',
	'  ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║',
	'  ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║',
	'  ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║',
	'  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝',
];

// ── Slash commands ─────────────────────────────────────────────────────
interface SlashCommand { name: string; description: string; }

const SLASH_COMMANDS: SlashCommand[] = [
	{ name: '/violations',  description: 'Show violations [domain]' },
	{ name: '/blocking',    description: 'Show commit-blocking violations' },
	{ name: '/scan',        description: 'Run full workspace scan' },
	{ name: '/frameworks',  description: 'List active frameworks' },
	{ name: '/draft-rule',  description: 'Generate rule with AI <description>' },
	{ name: '/model',       description: 'Show / switch model' },
	{ name: '/new',         description: 'Start a new session' },
	{ name: '/stop',        description: 'Stop current response' },
	{ name: '/clear',       description: 'Clear conversation' },
	{ name: '/help',        description: 'Show all commands' },
];

export class ChecksAgentTerminalHost extends Disposable {

	private _terminal: IDetachedTerminalInstance | undefined;
	private _container: HTMLElement | undefined;
	private _currentSessionId: string | undefined;
	private _isBusy = false;
	private _inputBuffer = '';
	private _inputActive = true;
	private _isStreaming = false;
	private _streamingPartId: string | undefined;
	private _streamTimeout: any = undefined;
	private readonly _streamedPartIds = new Set<string>();
	private _cols = 120;
	private _showingSlashMenu = false;
	private _slashFilteredCommands: SlashCommand[] = [];
	private _menuLineCount = 0;
	private _thinkingInterval: ReturnType<typeof setInterval> | undefined;
	private _thinkingFrame = 0;
	private _streamingCursor = false;
	private _streamingLineBuffer = '';
	private readonly _drawnRunningTools = new Set<string>();
	// Agent-link animation (for ask_power_mode — queries to Power Mode)
	private _agentLinkInterval: ReturnType<typeof setInterval> | undefined;
	private _agentLinkFrame = 0;

	// Model picker state
	private _inModelPicker = false;
	private _modelPickerOptions: { name: string; provider: string; model: string }[] = [];
	private _modelPickerBuffer = '';

	constructor(
		private readonly terminalService: ITerminalService,
		private readonly checksAgentService: IChecksAgentService,
	) {
		super();
		this._register(this.checksAgentService.onDidEmitUIEvent(e => this._handleUIEvent(e)));
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

		this._terminal.attachToElement(container);

		container.style.width = '100%';
		container.style.height = '100%';
		container.style.overflow = 'hidden';
		container.style.position = 'absolute';
		container.style.top = '0';
		container.style.left = '0';
		container.style.right = '0';
		container.style.bottom = '0';

		const rawXterm = (this._terminal.xterm as any).raw;
		if (rawXterm?.onData) {
			rawXterm.onData((data: string) => { this._handleInput(data); });
		}

		setTimeout(() => this._fitTerminal(), 50);

		const resizeObserver = new ResizeObserver(() => this._fitTerminal());
		resizeObserver.observe(container);
		this._register({ dispose: () => resizeObserver.disconnect() });

		// Draw welcome and prompt
		this._drawWelcome();
		this._drawPrompt();

		// Create or restore session
		let session = this.checksAgentService.getActiveSession();
		if (!session) {
			session = this.checksAgentService.createSession();
		}
		this._currentSessionId = session.id;

		// Show a compact restore indicator if there is prior history (don't replay the full conversation)
		if (session.messages.length > 0) {
			const userCount = session.messages.filter(m => m.role === 'user').length;
			this._write(line(`  ${GRAY}── ${userCount} message${userCount !== 1 ? 's' : ''} in session history  ${DARK}(/clear to reset)${RESET}`));
			this._write(line());
		}
	}

	// ── Welcome screen ─────────────────────────────────────────────────

	private _drawWelcome(): void {
		const modelInfo = this.checksAgentService.getModelInfo();
		const [modelName, providerName] = modelInfo.includes('·')
			? modelInfo.split('·').map(s => s.trim())
			: [modelInfo, ''];

		this._write(line());
		for (let i = 0; i < LOGO_LINES.length; i++) {
			const icon = ICON_LINES[i] ?? '                      ';
			this._write(line(`${TEAL}${icon}  ${LOGO_LINES[i]}${RESET}`));
		}
		this._write(line());

		const boxWidth = Math.min(this._cols - 4, 100);
		const leftW = 28;
		const hLine = '─'.repeat(boxWidth);
		const titleLabel = ' Checks Agent ';
		const titlePad = Math.floor((boxWidth - titleLabel.length) / 2);

		this._write(line(`  ${BLUE}┌${'─'.repeat(titlePad)}${RESET}${WHITE}${BOLD}${titleLabel}${RESET}${BLUE}${'─'.repeat(Math.max(0, boxWidth - titlePad - titleLabel.length))}┐${RESET}`));
		this._write(line(`  ${BLUE}│${RESET}  ${WHITE}${BOLD}GRC Compliance Specialist${RESET}${''.padEnd(leftW - 25)}  ${BLUE}│${RESET}  ${DARK}ISO 26262 · DO-178C · IEC 62304 · SOC 2${RESET}`));
		this._write(line(`  ${BLUE}│${RESET}  ${''.padEnd(leftW)}  ${BLUE}│${RESET}  ${DARK}Run ${WHITE}/help${DARK} to see all commands${RESET}`));
		this._write(line(`  ${BLUE}│${RESET}  ${TEAL}${modelName}${RESET}${''.padEnd(Math.max(0, leftW - modelName.length))}  ${BLUE}│${RESET}  ${DARK}Run ${WHITE}/model${DARK} to show current model${RESET}`));
		this._write(line(`  ${BLUE}│${RESET}  ${DARK}${providerName}${RESET}${''.padEnd(Math.max(0, leftW - providerName.length))}  ${BLUE}│${RESET}`));
		this._write(line(`  ${BLUE}├${'─'.repeat(leftW + 2)}┼${'─'.repeat(boxWidth - leftW - 3)}┤${RESET}`));

		// Posture row
		try {
			const allResults = this.checksAgentService.queryViolations();
			const blocking = this.checksAgentService.getBlockingViolations();
			const errCount = allResults.filter(r => (r.severity ?? '').toLowerCase() === 'error').length;
			const postureStr = allResults.length === 0 ? `${TEAL} Clean${RESET}` : `${RED}${errCount} errors${RESET} ${GRAY}/ ${allResults.length} total${RESET}`;
			const blockStr = blocking.length > 0 ? `${RED}${blocking.length} blocking${RESET}` : `${TEAL}none blocking${RESET}`;
			this._write(line(`  ${BLUE}│${RESET}  ${DARK}Posture${RESET}${''.padEnd(leftW - 7)}  ${BLUE}│${RESET}  ${postureStr}  ${DARK}·${RESET}  ${blockStr}`));
		} catch { /* engine not ready */ }

		this._write(line(`  ${BLUE}└${hLine}┘${RESET}`));
		this._write(line());
	}

	// ── Prompt ─────────────────────────────────────────────────────────

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
		this._drawnRunningTools.clear();
		this._streamingCursor = false;

		this._write(`${TEAL}${BOLD}> ${RESET}`);
	}

	// ── Slash menu ─────────────────────────────────────────────────────

	private _showSlashMenu(filter: string): void {
		const query = filter.toLowerCase().slice(1).split(' ')[0];
		this._slashFilteredCommands = SLASH_COMMANDS.filter(
			c => !query || c.name.slice(1).startsWith(query)
		);

		this._write(`\r${ESC}K`);
		for (let i = 0; i < this._menuLineCount; i++) {
			this._write(`${ESC}A${ESC}K`);
		}

		if (this._slashFilteredCommands.length === 0) {
			this._menuLineCount = 0;
			this._showingSlashMenu = false;
			this._write(`${TEAL}${BOLD}> ${RESET}${WHITE}${this._inputBuffer}${RESET}`);
			return;
		}

		for (const cmd of this._slashFilteredCommands) {
			this._write(line(`  ${WHITE}${BOLD}${cmd.name}${RESET}  ${DARK}${cmd.description}${RESET}`));
		}
		this._menuLineCount = this._slashFilteredCommands.length;
		this._write(`${TEAL}${BOLD}> ${RESET}${WHITE}${this._inputBuffer}${RESET}`);
		this._showingSlashMenu = true;
	}

	private _hideSlashMenu(): void {
		if (!this._showingSlashMenu && this._menuLineCount === 0) { return; }
		this._write(`\r${ESC}K`);
		for (let i = 0; i < this._menuLineCount; i++) {
			this._write(`${ESC}A${ESC}K`);
		}
		this._menuLineCount = 0;
		this._showingSlashMenu = false;
		this._write(`${TEAL}${BOLD}> ${RESET}${WHITE}${this._inputBuffer}${RESET}`);
	}

	// ── Slash command execution ─────────────────────────────────────────

	private _executeSlashCommand(cmd: string): void {
		const parts = cmd.trim().split(/\s+/);
		const command = parts[0].toLowerCase();
		const rest = parts.slice(1).join(' ');

		switch (command) {
			case '/new': {
				const session = this.checksAgentService.createSession();
				this._currentSessionId = session.id;
				this._write(`${ESC}2J${ESC}H`);
				this._drawWelcome();
				this._write(line());
				this._write(line(`  ${TEAL}${RESET} ${GRAY}New session started${RESET}`));
				this._write(line());
				this._drawPrompt();
				break;
			}

			case '/stop': {
				if (this._isBusy && this._currentSessionId) {
					this.checksAgentService.cancel(this._currentSessionId);
					this._write(line(`  ${RED}■${RESET} ${GRAY}Response stopped${RESET}`));
				} else {
					this._write(line(`  ${DARK}Nothing to stop${RESET}`));
				}
				this._drawPrompt();
				break;
			}

			case '/clear': {
				if (this._currentSessionId) {
					this.checksAgentService.clearSession(this._currentSessionId);
					const newSession = this.checksAgentService.createSession();
					this._currentSessionId = newSession.id;
				}
				this._write(`${ESC}2J${ESC}H`);
				this._drawWelcome();
				this._write(line());
				this._write(line(`  ${TEAL}${RESET} ${GRAY}Conversation cleared${RESET}`));
				this._write(line());
				this._drawPrompt();
				break;
			}

			case '/help': {
				this._write(line());
				this._write(line(`  ${WHITE}${BOLD}Checks Agent commands:${RESET}`));
				this._write(line());
				for (const c of SLASH_COMMANDS) {
					this._write(line(`  ${TEAL}${c.name.padEnd(14)}${RESET} ${DARK}${c.description}${RESET}`));
				}
				this._write(line());
				this._write(line(`  ${WHITE}${BOLD}Shortcuts:${RESET}`));
				this._write(line(`  ${TEAL}${'Ctrl+C'.padEnd(14)}${RESET} ${DARK}Cancel / clear input${RESET}`));
				this._write(line(`  ${TEAL}${'Escape'.padEnd(14)}${RESET} ${DARK}Stop response${RESET}`));
				this._write(line());
				this._drawPrompt();
				break;
			}

			case '/model': {
				this._enterModelPicker();
				break;
			}

			case '/violations': {
				const domain = rest.trim();
				const text = domain ? `Show violations in domain "${domain}"` : 'Show all current violations grouped by domain with counts';
				this._sendText(text);
				break;
			}

			case '/blocking': {
				this._sendText('Show all commit-blocking violations with file paths and line numbers');
				break;
			}

			case '/scan': {
				this._sendText('Run a full workspace scan and report the results');
				break;
			}

			case '/frameworks': {
				this._sendText('List all active compliance frameworks and their rule counts by domain');
				break;
			}

			case '/draft-rule': {
				if (!rest) {
					this._write(line());
					this._write(line(`  ${AMBER}Usage: /draft-rule <description of what to enforce>${RESET}`));
					this._write(line());
					this._drawPrompt();
				} else {
					this._sendText(`Draft a GRC rule for: ${rest}`);
				}
				break;
			}

			default: {
				this._write(line(`  ${RED}Unknown command: ${command}${RESET} ${DARK}— type /help${RESET}`));
				this._drawPrompt();
				break;
			}
		}
	}

	private _sendText(text: string): void {
		this._drawUserMessage(text);
		if (!this._currentSessionId) {
			const session = this.checksAgentService.createSession();
			this._currentSessionId = session.id;
		}
		this.checksAgentService.sendMessage(this._currentSessionId, text);
	}

	// ── Model picker ────────────────────────────────────────────────────

	private _enterModelPicker(): void {
		const options = this.checksAgentService.getAvailableModels();
		const currentInfo = this.checksAgentService.getModelInfo();
		const currentModel = currentInfo.includes(' · ') ? currentInfo.split(' · ')[0] : currentInfo;

		if (options.length === 0) {
			this._write(line());
			this._write(line(`  ${AMBER}No models configured${RESET} ${DARK}— add a provider in Void Settings${RESET}`));
			this._write(line());
			this._drawPrompt();
			return;
		}

		this._modelPickerOptions = options.map(o => ({
			name: o.selection.modelName,
			provider: o.selection.providerName,
			model: o.selection.modelName,
		}));
		this._modelPickerBuffer = '';
		this._inModelPicker = true;
		this._inputActive = false;

		this._write(line());
		this._write(line(`  ${WHITE}${BOLD}Select model:${RESET}  ${DARK}(current: ${TEAL}${currentModel}${DARK})${RESET}`));
		this._write(line());
		this._modelPickerOptions.forEach((o, i) => {
			const isCurrent = o.model === currentModel;
			const marker = isCurrent ? `${TEAL}●${RESET}` : `${DARK}○${RESET}`;
			this._write(line(`  ${marker} ${WHITE}${String(i + 1).padStart(2)}.${RESET} ${TEAL}${o.model}${RESET}  ${DARK}${o.provider}${RESET}`));
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
					const allOptions = this.checksAgentService.getAvailableModels();
					const sel = allOptions[idx]?.selection;
					if (sel) {
						this.checksAgentService.setModel(sel);
						this._write(line());
						this._write(line());
						this._write(line(`  ${TEAL}${RESET} Model set to ${TEAL}${chosen.model}${RESET}  ${DARK}${chosen.provider}${RESET}`));
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

	// ── Prefill (called from dashboard "Ask Agent" buttons) ─────────────

	prefill(text: string): void {
		if (!this._inputActive) { return; }
		// Clear current input
		if (this._inputBuffer.length > 0) {
			this._write('\b \b'.repeat(this._inputBuffer.length));
		}
		this._inputBuffer = text;
		this._write(`${WHITE}${text}${RESET}`);
	}

	// ── Drawing ─────────────────────────────────────────────────────────

	private _write(data: string): void {
		this._terminal?.xterm.write(data);
	}

	private _drawUserMessage(text: string): void {
		this._write(`\r${ESC}2K`);
		this._write(line()); // spacing above
		for (const l of text.split('\n')) {
			this._write(line(`  ${TEAL}>${RESET} ${WHITE}${l}${RESET}`));
		}
		this._write(line()); // spacing below
	}

	private _drawThinking(): void {
		this._thinkingFrame = 0;
		this._write(`  ${DARK}·${RESET}`);
		this._thinkingInterval = setInterval(() => {
			this._thinkingFrame = (this._thinkingFrame + 1) % 3;
			const dots = '·'.repeat(this._thinkingFrame + 1);
			this._write(`\r  ${DARK}${dots}${RESET}${ESC}K`);
		}, 400);
	}

	private _stopThinking(): void {
		if (this._thinkingInterval !== undefined) {
			clearInterval(this._thinkingInterval);
			this._thinkingInterval = undefined;
			this._write(`\r${ESC}2K\r`); // clear the dots line and return to start
		}
	}

	// ── Agent-link animation (cross-agent bus communication) ────────────

	private _drawAgentLink(targetAgent: string, file?: string): void {
		this._stopAgentLink();
		this._endStreaming();
		const fileHint = file ? ` ${String(file).split('/').pop()}` : '';
		// Static header line showing the agent-to-agent channel
		this._write(line(`  ${BLUE}◈ agent-bus${RESET}  ${TEAL}checks-agent${RESET} ${DARK}⟶${RESET} ${AMBER}${targetAgent}${RESET}${DARK}${fileHint}${RESET}`));
		// Animated "signal" line
		this._agentLinkFrame = 0;
		const frames = [
			`${DARK}  ·  ·  ·  →${RESET}`,
			`${DARK}  ·  ·  ·${RESET}${TEAL}  →${RESET}`,
			`${AMBER}  ·  ·  ·  →${RESET}`,
		];
		this._write(`  ${frames[0]}`);
		this._agentLinkInterval = setInterval(() => {
			this._agentLinkFrame = (this._agentLinkFrame + 1) % frames.length;
			this._write(`\r  ${frames[this._agentLinkFrame]}${ESC}K`);
		}, 280);
	}

	// ── Agent-link response preview ─────────────────────────────────────

	private _drawAgentLinkOutput(output: string): void {
		const MAX_PREVIEW = 25;
		const allLines = output.split('\n');
		const isTimeout = output.startsWith('[Code context request timed out');
		const isDenied = output.startsWith('[Error]') || output.includes('denied');

		if (isTimeout || isDenied) {
			this._write(line(`  ${DARK}  └ ${RED}${output.substring(0, 80)}${RESET}`));
			return;
		}

		const boxW = Math.min(this._cols - 6, 80);
		const label = ' power-mode → checks ';
		const fillLen = Math.max(4, boxW - label.length);
		const fill = '─'.repeat(fillLen);
		const bottom = '─'.repeat(fillLen + label.length);
		this._write(line(`  ${BLUE}└─${RESET}${DARK}${label}${BLUE}${fill}┐${RESET}`));

		const show = allLines.slice(0, MAX_PREVIEW);
		for (const l of show) {
			const truncated = l.length > boxW - 2 ? l.substring(0, boxW - 5) + '…' : l;
			this._write(line(`  ${BLUE}│${RESET} ${DARK}${truncated}${RESET}`));
		}
		if (allLines.length > MAX_PREVIEW) {
			this._write(line(`  ${BLUE}│${RESET} ${DARK}⋯ +${allLines.length - MAX_PREVIEW} lines${RESET}`));
		}
		this._write(line(`  ${BLUE}└${bottom}┘${RESET}`));
	}
	private _stopAgentLink(): void {
		if (this._agentLinkInterval !== undefined) {
			clearInterval(this._agentLinkInterval);
			this._agentLinkInterval = undefined;
			this._write(`\r${ESC}2K`);
		}
	}

	private _endStreaming(): void {
		if (this._isStreaming) {
			if (this._streamTimeout) {
				clearTimeout(this._streamTimeout);
				this._streamTimeout = undefined;
			}
			if (this._streamingCursor) {
				this._write('\b \b');
				this._streamingCursor = false;
			}
			// Flush any remaining buffered text
			if (this._streamingLineBuffer) {
				const formatted = this._formatMarkdownLine(this._streamingLineBuffer);
				// Clear current line and rewrite with formatting
				this._write(`\r${ESC}K`);
				this._write(formatted.colored);
				this._streamingLineBuffer = '';
			}
			this._write(line());
			this._isStreaming = false;
			this._streamingPartId = undefined;
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
				this._write(line(formatted.colored));
			} else {
				this._write(line());
			}
		}
	}

	private _drawToolStart(partId: string, toolName: string, title?: string): void {
		if (this._drawnRunningTools.has(partId) || !title) { return; }
		this._drawnRunningTools.add(partId);
		this._stopThinking();
		this._endStreaming();
		this._write(line(`${AMBER}${BOLD}${toolName}${RESET} ${GRAY}${title}${RESET}`));
	}

	private _drawToolComplete(toolName: string, title: string | undefined, duration: string): void {
		this._write(line(`${AMBER}${toolName}${RESET} ${GRAY}${title ?? ''}${RESET} ${DARK}${duration}${RESET}`));
	}

	private _drawToolError(toolName: string, error: string): void {
		this._write(line(`${AMBER}${toolName}${RESET} ${RED}${error}${RESET}`));
	}

	private _drawToolOutput(output: string): void {
		const MAX = 20;
		const allLines = output.split('\n');
		const show = allLines.slice(0, MAX);

		// Draw top border
		this._write(line(`${DARK}┌─ output${RESET}`));

		for (const l of show) {
			const formatted = this._formatMarkdownLine(l);
			// Output formatted line - let terminal wrap naturally to preserve markdown
			this._write(line(`${DARK}│${RESET} ${formatted.colored}`));
		}

		if (allLines.length > MAX) {
			this._write(line(`${DARK}│${RESET} ${DARK}... +${allLines.length - MAX} lines${RESET}`));
		}

		// Draw bottom border
		this._write(line(`${DARK}└─${RESET}`));
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
			colored = `${TEAL}${BOLD}${plain}${RESET}`;
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
		colored = colored.replace(/^(\s*)(\*\*[+*\u2611\u2713\u2717\u2500\u2192\u2190]+\*\*)/g, `$1${TEAL}${BOLD}$2${RESET}${WHITE}`);

		// Inline code: `text` -> text (highlighted) - re-apply WHITE after RESET
		colored = colored.replace(/`([^`]+)`/g, `${AMBER}$1${RESET}${WHITE}`);
		plain = plain.replace(/`([^`]+)`/g, '$1');

		// Links: [text](url) -> text - re-apply WHITE after RESET
		colored = colored.replace(/\[([^\]]+)\]\([^)]+\)/g, `${TEAL}$1${RESET}${WHITE}`);
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

	private _drawStepFinish(tokens?: { input: number; output: number }): void {
		this._endStreaming();
		if (tokens) {
			this._write(line(`${DARK}${tokens.input} in / ${tokens.output} out${RESET}`));
		}
	}

	private _drawError(error: string): void {
		this._endStreaming();
		this._write(line());
		this._write(line(`${RED}error: ${error}${RESET}`));
	}

	private _drawDone(): void {
		this._stopThinking();
		this._stopAgentLink();
		this._endStreaming();
	}

	// ── Input handling ─────────────────────────────────────────────────

	private _handleInput(data: string): void {
		if (this._inModelPicker) {
			this._handleModelPickerInput(data);
			return;
		}

		if (!this._inputActive) {
			if (data === '\x1b' || data === '\x03') {
				if (this._isBusy && this._currentSessionId) {
					this.checksAgentService.cancel(this._currentSessionId);
					this._write(line(`\r\n${RED}  ■ stopped${RESET}`));
				}
			}
			return;
		}

		for (const ch of data) {
			if (ch === '\r' || ch === '\n') {
				const text = this._inputBuffer.trim();
				if (!text) { return; }

				this._hideSlashMenu();
				this._inputActive = false;

				if (text.startsWith('/')) {
					this._write(line());
					this._executeSlashCommand(text);
					return;
				}

				this._drawUserMessage(text);

				if (!this._currentSessionId) {
					const session = this.checksAgentService.createSession();
					this._currentSessionId = session.id;
				}
				this.checksAgentService.sendMessage(this._currentSessionId, text);

			} else if (ch === '\x7f' || ch === '\b') {
				if (this._inputBuffer.length > 0) {
					this._inputBuffer = this._inputBuffer.slice(0, -1);
					this._write('\b \b');
					if (this._inputBuffer.startsWith('/')) {
						this._showSlashMenu(this._inputBuffer);
					} else if (this._showingSlashMenu) {
						this._hideSlashMenu();
					}
				}

			} else if (ch === '\x1b') {
				if (this._isBusy && this._currentSessionId) {
					this.checksAgentService.cancel(this._currentSessionId);
					this._write(line(`\r\n${RED}  ■ stopped${RESET}`));
				}

			} else if (ch === '\x03') {
				if (this._isBusy && this._currentSessionId) {
					this.checksAgentService.cancel(this._currentSessionId);
					this._write(line(`${RED}^C${RESET}`));
				} else {
					this._inputBuffer = '';
					this._hideSlashMenu();
					this._write(line(`${RED}^C${RESET}`));
					this._drawPrompt();
				}

			} else if (ch === '\t') {
				if (this._inputBuffer.startsWith('/') && this._slashFilteredCommands.length === 1) {
					const completed = this._slashFilteredCommands[0].name;
					this._write('\b \b'.repeat(this._inputBuffer.length));
					this._inputBuffer = completed;
					this._write(`${WHITE}${completed}${RESET}`);
					this._hideSlashMenu();
				}

			} else if (ch >= ' ') {
				this._inputBuffer += ch;
				this._write(`${WHITE}${ch}${RESET}`);
				if (this._inputBuffer.startsWith('/')) {
					this._showSlashMenu(this._inputBuffer);
				}
			}
		}
	}

	// ── Service event handler ───────────────────────────────────────────

	private _handleUIEvent(event: ChecksAgentUIEvent): void {
		switch (event.type) {
			case 'session-created':
				this._currentSessionId = (event as any).session?.id ?? this._currentSessionId;
				break;

			case 'session-updated':
				this._isBusy = (event as any).status === 'busy';
				if ((event as any).status === 'busy') {
					this._drawThinking();
				} else {
					this._drawDone();
					this._drawPrompt();
				}
				break;

			case 'message-created':
				if ((event as any).message?.role === 'assistant') {
					this._write(`\r${ESC}2K\r`);
				}
				break;

			case 'part-updated': {
				const part = (event as any).part;
				if (!part) { break; }
				switch (part.type) {
					case 'text':
						if (part.text && !this._streamedPartIds.has(part.id)) {
							this._drawText(part.text);
						}
						break;
					case 'tool': {
						const st = part.state;
						const isBusTool = part.toolName === 'ask_power_mode';
						if (st.status === 'running') {
							if (isBusTool) {
								this._drawAgentLink('power-mode', st.input?.question);
							} else {
								this._drawToolStart(part.id, part.toolName, st.title || part.toolName);
							}
						} else if (st.status === 'completed') {
							if (isBusTool) {
								this._stopAgentLink();
								const dur = st.time?.end && st.time?.start
									? ((st.time.end - st.time.start) / 1000).toFixed(2) + 's' : '';
								this._write(line(`  ${TEAL} agent-bus${RESET} ${AMBER}power-mode${RESET} ${DARK}→ checks-agent${RESET}  ${DARK}${dur}${RESET}`));
								if (st.output) { this._drawAgentLinkOutput(st.output); }
							} else {
								const dur = st.time?.end && st.time?.start
									? ((st.time.end - st.time.start) / 1000).toFixed(2) + 's' : '';
								this._drawToolComplete(part.toolName, st.title, dur);
								if (st.output) { this._drawToolOutput(st.output); }
							}
						} else if (st.status === 'error') {
							if (isBusTool) {
								this._stopAgentLink();
								this._write(line(`  ${RED} agent-bus${RESET} ${AMBER}power-mode${RESET} ${RED}${st.error || 'timed out'}${RESET}`));
							} else {
								this._drawToolError(part.toolName, st.error || 'unknown error');
							}
						}
						break;
					}
					case 'step-start':
						this._write(`\r${ESC}2K`);
						break;
					case 'step-finish':
						this._drawStepFinish(part.tokens);
						break;
				}
				break;
			}

			case 'part-delta': {
				const ev = event as any;
				this._streamedPartIds.add(ev.partId);
				if (!this._isStreaming || this._streamingPartId !== ev.partId) {
					this._endStreaming();
					this._isStreaming = true;
					this._streamingPartId = ev.partId;
					this._streamingLineBuffer = '';
					// Start on a new line
					this._write(`\r\n`);
				}

				// Reset stream timeout (30s)
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
				}, 30000);

				// Remove cursor before writing
				if (this._streamingCursor) {
					this._write('\b \b');
					this._streamingCursor = false;
				}

				// Just append the delta and let terminal handle wrapping
				const delta = ev.delta;

				// Check if delta contains newlines
				if (delta.includes('\n')) {
					const lines = delta.split('\n');
					for (let i = 0; i < lines.length; i++) {
						if (i > 0) {
							// Complete the previous line with formatting
							if (this._streamingLineBuffer.trim()) {
								const formatted = this._formatMarkdownLine(this._streamingLineBuffer);
								// Clear line, write formatted, newline
								this._write(`\r${ESC}K  ${formatted.colored}\r\n`);
							} else {
								this._write(`\r\n`);
							}
							this._streamingLineBuffer = '';
						}
						this._streamingLineBuffer += lines[i];
					}
				} else {
					// No newline - just accumulate
					this._streamingLineBuffer += delta;
				}

				// Show current unformatted buffer (raw text flows naturally)
				if (this._streamingLineBuffer) {
					// For very long lines, let xterm wrap naturally
					this._write(`\r${ESC}K  ${WHITE}${this._streamingLineBuffer}${RESET}${TEAL}▋${RESET}`);
					this._streamingCursor = true;
				} else {
					this._write(`\r${ESC}K  ${TEAL}▋${RESET}`);
					this._streamingCursor = true;
				}
				break;
			}

			case 'error':
				this._drawError((event as any).error ?? 'unknown error');
				this._drawPrompt();
				break;
		}
	}

	// ── Resize ─────────────────────────────────────────────────────────

	private _fitTerminal(): void {
		if (!this._terminal || !this._container) { return; }
		const rawXterm = (this._terminal.xterm as any).raw;
		if (!rawXterm) { return; }

		const fitAddon = (this._terminal.xterm as any)._fitAddon;
		if (fitAddon?.fit) {
			fitAddon.fit();
			this._cols = rawXterm.cols || 120;
			return;
		}

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
