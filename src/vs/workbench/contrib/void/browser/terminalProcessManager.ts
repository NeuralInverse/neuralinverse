/*--------------------------------------------------------------------------------------
 *  Copyright (c) NeuralInverse. All rights reserved.
 *  Terminal Process Manager — tracks active processes, detects hangs, provides kill.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export interface ITrackedProcess {
	id: string;
	terminalId: string;
	command: string;
	startedAt: number;
	lastOutputAt: number;
	isAlive: boolean;
	outputBytes: number;
}

export interface ITerminalProcessManager {
	readonly _serviceBrand: undefined;

	readonly onDidProcessHang: Event<ITrackedProcess>;
	readonly onDidProcessEnd: Event<{ id: string; exitCode: number | null }>;

	trackProcess(terminalId: string, command: string): string;
	recordOutput(processId: string, bytes: number): void;
	markEnded(processId: string, exitCode: number | null): void;
	killProcess(processId: string): void;
	isHanging(processId: string, hangThresholdMs: number): boolean;
	getProcess(processId: string): ITrackedProcess | undefined;
	getActiveProcesses(): ITrackedProcess[];
}

export const ITerminalProcessManager = createDecorator<ITerminalProcessManager>('terminalProcessManager');

class TerminalProcessManager extends Disposable implements ITerminalProcessManager {
	readonly _serviceBrand: undefined;

	private _processes = new Map<string, ITrackedProcess>();
	private _nextId = 0;
	private _hangCheckInterval: ReturnType<typeof setInterval> | undefined;

	private readonly _onDidProcessHang = this._register(new Emitter<ITrackedProcess>());
	readonly onDidProcessHang = this._onDidProcessHang.event;

	private readonly _onDidProcessEnd = this._register(new Emitter<{ id: string; exitCode: number | null }>());
	readonly onDidProcessEnd = this._onDidProcessEnd.event;

	constructor() {
		super();
		this._hangCheckInterval = setInterval(() => this._checkForHangs(), 10_000);
	}

	trackProcess(terminalId: string, command: string): string {
		const id = `proc_${this._nextId++}`;
		const now = Date.now();
		this._processes.set(id, {
			id,
			terminalId,
			command,
			startedAt: now,
			lastOutputAt: now,
			isAlive: true,
			outputBytes: 0,
		});
		return id;
	}

	recordOutput(processId: string, bytes: number): void {
		const proc = this._processes.get(processId);
		if (proc && proc.isAlive) {
			proc.lastOutputAt = Date.now();
			proc.outputBytes += bytes;
		}
	}

	markEnded(processId: string, exitCode: number | null): void {
		const proc = this._processes.get(processId);
		if (proc) {
			proc.isAlive = false;
			this._onDidProcessEnd.fire({ id: processId, exitCode });
			this._processes.delete(processId);
		}
	}

	killProcess(processId: string): void {
		const proc = this._processes.get(processId);
		if (proc && proc.isAlive) {
			proc.isAlive = false;
			this._onDidProcessEnd.fire({ id: processId, exitCode: null });
			this._processes.delete(processId);
		}
	}

	isHanging(processId: string, hangThresholdMs: number): boolean {
		const proc = this._processes.get(processId);
		if (!proc || !proc.isAlive) { return false; }
		return (Date.now() - proc.lastOutputAt) > hangThresholdMs;
	}

	getProcess(processId: string): ITrackedProcess | undefined {
		return this._processes.get(processId);
	}

	getActiveProcesses(): ITrackedProcess[] {
		return [...this._processes.values()].filter(p => p.isAlive);
	}

	private _checkForHangs(): void {
		const HANG_THRESHOLD_MS = 60_000;
		for (const proc of this._processes.values()) {
			if (proc.isAlive && this.isHanging(proc.id, HANG_THRESHOLD_MS)) {
				this._onDidProcessHang.fire(proc);
			}
		}
	}

	override dispose(): void {
		if (this._hangCheckInterval) {
			clearInterval(this._hangCheckInterval);
		}
		super.dispose();
	}
}

registerSingleton(ITerminalProcessManager, TerminalProcessManager, InstantiationType.Delayed);
