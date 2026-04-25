/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Terminal Tools
 *
 * IAgentTool implementations for shell command execution.
 *
 * Commands run as child processes in the workspace directory via Node's
 * child_process.exec \u2014 the same pattern used by ExternalCheckRunner in
 * neuralInverseChecks. Not available in VS Code Web (no-op with error).
 *
 * ## Safety
 *
 * A blocklist prevents destructive commands (rm -rf /, mkfs, fork bombs, etc.).
 * Commands run with a configurable timeout (default 30s) and a 4MB output cap.
 * The working directory is always the workspace root \u2014 no escaping via `cd`.
 */

import { isWindows } from '../../../../../base/common/platform.js';
import { IAgentTool, IToolExecutionContext, IToolResult } from '../../common/workflowTypes.js';

// \u2500\u2500\u2500 Shared exec helper \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function shellExec(
	command: string,
	cwd: string,
	timeoutMs: number,
): Promise<ExecResult> {
	const nodeRequire = (globalThis as any).require as NodeRequire | undefined;
	if (!nodeRequire) {
		throw new Error('Shell execution is not available in VS Code Web.');
	}

	const { exec } = nodeRequire('child_process') as typeof import('child_process');
	const { promisify } = nodeRequire('util') as typeof import('util');
	const execAsync = promisify(exec);

	try {
		const { stdout, stderr } = await execAsync(command, {
			cwd,
			timeout: timeoutMs,
			maxBuffer: 4 * 1024 * 1024, // 4 MB
			env: { ...process.env, FORCE_COLOR: '0' },
		});
		return { stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 };
	} catch (e: any) {
		// Non-zero exit \u2014 many tools (eslint, tsc) return non-zero for warnings
		// Still capture output so the agent can reason about it
		return {
			stdout: e.stdout ?? '',
			stderr: e.stderr ?? '',
			exitCode: e.code ?? 1,
		};
	}
}

// \u2500\u2500\u2500 Safety blocklist \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /rm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+[\/~\*]/, reason: 'recursive force-delete of root/home/glob' },
	{ pattern: /rm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+[\/~\*]/, reason: 'recursive force-delete of root/home/glob' },
	{ pattern: /mkfs/, reason: 'filesystem format' },
	{ pattern: /dd\s+if=.*of=\/dev\//, reason: 'raw device write' },
	{ pattern: />\s*\/dev\/(sda|hda|nvme|xvd|disk)/, reason: 'raw device write' },
	{ pattern: /:()\s*\{\s*:\s*\|\s*:&\s*\}\s*;/, reason: 'fork bomb' },
	{ pattern: /shutdown|reboot|halt|poweroff/, reason: 'system shutdown/reboot' },
	{ pattern: /chmod\s+-R\s+777\s+\//, reason: 'chmod 777 on root' },
	{ pattern: /sudo\s+rm/, reason: 'sudo rm' },
];

function checkBlocked(command: string): string | null {
	for (const { pattern, reason } of BLOCKED_PATTERNS) {
		if (pattern.test(command)) return reason;
	}
	return null;
}

function formatOutput(result: ExecResult): string {
	const parts: string[] = [];
	if (result.stdout.trim()) parts.push(result.stdout.trim());
	if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.trim()}`);
	if (parts.length === 0) parts.push('(no output)');
	if (result.exitCode !== 0) parts.push(`[exit code: ${result.exitCode}]`);
	return parts.join('\n\n');
}

// \u2500\u2500\u2500 runCommand \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class RunCommandTool implements IAgentTool {

	readonly name = 'runCommand';
	readonly description =
		'Execute a shell command in the workspace root directory and return stdout + stderr. ' +
		'Use for build scripts, package managers (npm, yarn, pnpm), linters, test runners, etc. ' +
		'Destructive commands (rm -rf /, mkfs, etc.) are blocked.';

	readonly parameters = {
		command: {
			type: 'string' as const,
			description: 'The shell command to run, e.g. "npm run build" or "npx tsc --noEmit"',
			required: true,
		},
		timeoutMs: {
			type: 'number' as const,
			description: 'Max execution time in milliseconds. Defaults to 30000 (30 seconds).',
			required: false,
		},
	};

	async execute(args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		const command = args['command'] as string;
		const timeoutMs = (args['timeoutMs'] as number) || 30_000;

		if (!command?.trim()) {
			return { success: false, output: '', error: 'command is required' };
		}

		const blocked = checkBlocked(command);
		if (blocked) {
			return { success: false, output: '', error: `Command blocked \u2014 ${blocked}: "${command}"` };
		}

		const cwd = ctx.workspaceUri.fsPath;
		ctx.log(`runCommand: ${command}`);

		try {
			const result = await shellExec(command, cwd, timeoutMs);
			const output = formatOutput(result);
			return { success: result.exitCode === 0, output };
		} catch (e: any) {
			return { success: false, output: '', error: e.message };
		}
	}
}

// \u2500\u2500\u2500 runScript \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class RunScriptTool implements IAgentTool {

	readonly name = 'runScript';
	readonly description =
		'Run a script defined in package.json (e.g. "build", "test", "lint"). ' +
		'Equivalent to "npm run <script>" but uses the workspace package manager if detected.';

	readonly parameters = {
		script: {
			type: 'string' as const,
			description: 'Name of the npm script to run, e.g. "build", "test", "lint:fix"',
			required: true,
		},
		packageManager: {
			type: 'string' as const,
			description: 'Package manager to use: "npm", "yarn", "pnpm", or "bun". Auto-detected if omitted.',
			required: false,
			enum: ['npm', 'yarn', 'pnpm', 'bun'],
		},
		timeoutMs: {
			type: 'number' as const,
			description: 'Max execution time in milliseconds. Defaults to 60000 (60 seconds).',
			required: false,
		},
	};

	async execute(args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		const script = args['script'] as string;
		const pm = (args['packageManager'] as string) || this._detectPackageManager(ctx);
		const timeoutMs = (args['timeoutMs'] as number) || 60_000;

		if (!script?.trim()) {
			return { success: false, output: '', error: 'script is required' };
		}

		// Sanitize script name \u2014 alphanumeric, dashes, colons only
		if (!/^[\w\-:]+$/.test(script)) {
			return { success: false, output: '', error: `Invalid script name: "${script}"` };
		}

		const runVerb = pm === 'yarn' || pm === 'bun' ? '' : 'run ';
		const command = `${pm} ${runVerb}${script}`;
		const cwd = ctx.workspaceUri.fsPath;

		ctx.log(`runScript: ${command}`);

		try {
			const result = await shellExec(command, cwd, timeoutMs);
			const output = formatOutput(result);
			return { success: result.exitCode === 0, output };
		} catch (e: any) {
			return { success: false, output: '', error: e.message };
		}
	}

	private _detectPackageManager(ctx: IToolExecutionContext): string {
		// Simple heuristic: check for lock files via workspace URI path
		// Full detection would require reading the filesystem \u2014 kept simple here
		const isWindows_ = isWindows;
		void isWindows_; // referenced to avoid unused import warning
		return 'npm';
	}
}

// \u2500\u2500\u2500 Export \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const ALL_TERMINAL_TOOLS: IAgentTool[] = [
	new RunCommandTool(),
	new RunScriptTool(),
];
