/*--------------------------------------------------------------------------------------
 *  Copyright (c) NeuralInverse. All rights reserved.
 *  Terminal Command Classifier — categorizes commands to set appropriate timeouts.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export type CommandCategory = 'build' | 'test' | 'install' | 'server' | 'lint' | 'generic';

export interface ICommandClassification {
	category: CommandCategory;
	timeoutMs: number; // 0 = no timeout (streaming only)
	isLongRunning: boolean;
}

const TIMEOUT_BY_CATEGORY: Record<CommandCategory, number> = {
	// Inactivity ceilings, not total-runtime limits — a command that keeps
	// producing output runs as long as it needs. Raised from 60-600s so
	// long-running agent tasks don't die mid-run.
	build: 1_800_000,
	test: 1_800_000,
	install: 900_000,
	server: 0,
	lint: 300_000,
	generic: 900_000,
};

const PATTERNS: { category: CommandCategory; patterns: RegExp[] }[] = [
	{
		category: 'build',
		patterns: [
			/\b(npm|yarn|pnpm)\s+run\s+build\b/,
			/\bcargo\s+build\b/,
			/\b(make|cmake|ninja)\b/,
			/\bgradle\b.*\b(build|assemble)\b/,
			/\bmvn\b.*\b(compile|package|install)\b/,
			/\bgo\s+build\b/,
			/\btsc\b/,
			/\bwebpack\b/,
			/\bvite\s+build\b/,
			/\bdocker\s+build\b/,
		],
	},
	{
		category: 'test',
		patterns: [
			/\b(npm|yarn|pnpm)\s+(run\s+)?test\b/,
			/\b(jest|vitest|mocha|ava)\b/,
			/\bpytest\b/,
			/\bcargo\s+test\b/,
			/\bgo\s+test\b/,
			/\bdotnet\s+test\b/,
			/\brspec\b/,
			/\bphpunit\b/,
		],
	},
	{
		category: 'install',
		patterns: [
			/\b(npm|yarn|pnpm)\s+install\b/,
			/\bpip\s+install\b/,
			/\bcargo\s+(fetch|update)\b/,
			/\bbrew\s+install\b/,
			/\bapt(-get)?\s+install\b/,
			/\bdotnet\s+restore\b/,
			/\bcomposer\s+install\b/,
			/\bbundle\s+install\b/,
			/\bgo\s+mod\s+(download|tidy)\b/,
		],
	},
	{
		category: 'server',
		patterns: [
			/\b(npm|yarn|pnpm)\s+(run\s+)?(start|dev|serve)\b/,
			/\bnode\s+\./,
			/\bpython\s+-m\b/,
			/\bcargo\s+run\b/,
			/\bgo\s+run\b/,
			/\bdocker\s+(run|compose\s+up)\b/,
			/\brails\s+s(erver)?\b/,
			/\bflask\s+run\b/,
			/\buvicorn\b/,
			/\bnext\s+dev\b/,
		],
	},
	{
		category: 'lint',
		patterns: [
			/\b(eslint|prettier|biome)\b/,
			/\bcargo\s+clippy\b/,
			/\bpylint\b/,
			/\brubocop\b/,
			/\bgolangci-lint\b/,
			/\b(npm|yarn|pnpm)\s+run\s+lint\b/,
		],
	},
];

export interface ITerminalCommandClassifier {
	readonly _serviceBrand: undefined;
	classify(command: string): ICommandClassification;
	getTimeoutMs(command: string): number;
}

export const ITerminalCommandClassifier = createDecorator<ITerminalCommandClassifier>('terminalCommandClassifier');

class TerminalCommandClassifier implements ITerminalCommandClassifier {
	readonly _serviceBrand: undefined;

	classify(command: string): ICommandClassification {
		const normalized = command.toLowerCase().trim();

		for (const { category, patterns } of PATTERNS) {
			for (const pattern of patterns) {
				if (pattern.test(normalized)) {
					return {
						category,
						timeoutMs: TIMEOUT_BY_CATEGORY[category],
						isLongRunning: category === 'server' || category === 'build' || category === 'test',
					};
				}
			}
		}

		return {
			category: 'generic',
			timeoutMs: TIMEOUT_BY_CATEGORY.generic,
			isLongRunning: false,
		};
	}

	getTimeoutMs(command: string): number {
		return this.classify(command).timeoutMs;
	}
}

registerSingleton(ITerminalCommandClassifier, TerminalCommandClassifier, InstantiationType.Delayed);
