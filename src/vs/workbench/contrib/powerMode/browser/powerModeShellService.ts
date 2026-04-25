/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * PowerModeShellService \u2014 persistent interactive shell for Power Mode.
 *
 * Creates a single hidden ITerminalInstance (backed by node-pty in the
 * extension host / pty service) and exposes a clean event-based API:
 *
 *   onData  \u2014 raw pty output (VT100/ANSI sequences) \u2192 forward to xterm webview
 *   write   \u2014 send keystrokes / text from xterm webview \u2192 pty stdin
 *   resize  \u2014 propagate terminal size changes from xterm \u2192 pty
 *
 * Cross-platform: ITerminalService handles macOS/Linux/Windows differences
 * (ConPTY on Win10+, Unix PTY on macOS/Linux). No direct node-pty import needed.
 *
 * The AI agent's bash tool can also call write() to run commands in this
 * same shell \u2014 the user sees commands executing live in the xterm display.
 *
 * Usage:
 *   const shell = accessor.get(IPowerModeShellService);
 *   await shell.start(workingDirectory);
 *   shell.onData(data => webview.postMessage({ type: 'write', data }));
 *   webview.onMessage(e => { if (e.type === 'data') shell.write(e.data); });
 */

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ITerminalService, ITerminalInstance } from '../../terminal/browser/terminal.js';
import { isWindows, isMacintosh } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';

// \u2500\u2500\u2500 Service interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const IPowerModeShellService = createDecorator<IPowerModeShellService>('powerModeShellService');

export interface IPowerModeShellService {
	readonly _serviceBrand: undefined;

	/** Fired whenever the pty produces output (raw VT100/ANSI). */
	readonly onData: Event<string>;

	/** Fired when the shell process exits. */
	readonly onExit: Event<number>;

	/** True once start() has been called and the shell is running. */
	readonly isRunning: boolean;

	/**
	 * Spawn the shell in the given working directory.
	 * No-op if already running (returns the existing instance).
	 */
	start(cwd: string): Promise<void>;

	/** Send raw input to the shell (keystrokes, commands). */
	write(data: string): void;

	/** Notify the pty of a terminal resize. */
	resize(cols: number, rows: number): void;

	/** Kill the shell and release all resources. */
	kill(): void;
}

// \u2500\u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class PowerModeShellServiceImpl extends Disposable implements IPowerModeShellService {

	declare readonly _serviceBrand: undefined;

	private readonly _onData = this._register(new Emitter<string>());
	readonly onData: Event<string> = this._onData.event;

	private readonly _onExit = this._register(new Emitter<number>());
	readonly onExit: Event<number> = this._onExit.event;

	private _instance: ITerminalInstance | undefined;
	private readonly _instanceListeners = this._register(new DisposableStore());
	private _cols = 120;
	private _rows = 40;

	constructor(
		@ITerminalService private readonly _terminalService: ITerminalService,
	) {
		super();
	}

	get isRunning(): boolean {
		return !!this._instance && !this._instance.isDisposed;
	}

	async start(cwd: string): Promise<void> {
		if (this.isRunning) { return; }

		// Clean up any stale listeners
		this._instanceListeners.clear();

		const shell = _defaultShell();

		const instance = await this._terminalService.createTerminal({
			config: {
				name: 'Power Mode',
				executable: shell.path,
				args: shell.args,
				cwd: URI.file(cwd).fsPath,
				// Hide from the VS Code terminal panel \u2014 Power Mode manages display
				hideFromUser: true,
				isTransient: true,
			},
		});

		this._instance = instance;

		// Forward pty output to listeners
		this._instanceListeners.add(
			instance.onData(data => this._onData.fire(data))
		);

		// Forward exit (onExit fires number | ITerminalLaunchError | undefined)
		this._instanceListeners.add(
			instance.onExit(e => {
				const code = typeof e === 'number' ? e : (e as { code?: number } | undefined)?.code ?? 0;
				this._onExit.fire(code);
				this._instance = undefined;
				this._instanceListeners.clear();
			})
		);

		// Apply current size once the pty is ready
		instance.onProcessIdReady(() => {
			this.resize(this._cols, this._rows);
		});
	}

	write(data: string): void {
		if (!this._instance || this._instance.isDisposed) { return; }
		// sendText with shouldExecute=false passes raw bytes (keystrokes) to the pty
		this._instance.sendText(data, false);
	}

	resize(cols: number, rows: number): void {
		this._cols = cols;
		this._rows = rows;
		if (this._instance && !this._instance.isDisposed) {
			try {
				(this._instance as any).resize(cols, rows);
			} catch {
				// Pty may not be ready yet \u2014 size will be applied via onProcessIdReady
			}
		}
	}

	kill(): void {
		this._instance?.dispose();
		this._instance = undefined;
		this._instanceListeners.clear();
	}

	override dispose(): void {
		this.kill();
		super.dispose();
	}
}

// \u2500\u2500\u2500 Platform shell helper \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface IShellConfig {
	path: string;
	args: string[];
}

function _defaultShell(): IShellConfig {
	if (isWindows) {
		return { path: 'pwsh.exe', args: ['-NoLogo'] };
	}
	if (isMacintosh) {
		return { path: process.env['SHELL'] ?? '/bin/zsh', args: ['-l'] };
	}
	return { path: process.env['SHELL'] ?? '/bin/bash', args: ['--login'] };
}

// \u2500\u2500\u2500 Registration \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

registerSingleton(IPowerModeShellService, PowerModeShellServiceImpl, InstantiationType.Delayed);
