/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

import { definePowerTool } from './powerToolRegistry.js';
import { IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import * as cp from 'child_process';

const DEFAULT_TIMEOUT = 2 * 60 * 1000; // 2 minutes
const MAX_OUTPUT = 50 * 1024; // 50KB

export function createBashTool(workingDirectory: string) {
	return definePowerTool(
		'bash',
		`Execute a bash command in the working directory (${workingDirectory}).

Rules:
- Always provide a clear description of what the command does
- For long-running commands, set an appropriate timeout
- Use workdir parameter instead of cd commands
- Commands run in a non-interactive shell
- Output is capped at 50KB`,
		[
			{ name: 'command', type: 'string', description: 'The bash command to execute', required: true },
			{ name: 'description', type: 'string', description: 'Brief description of what this command does (5-10 words)', required: true },
			{ name: 'timeout', type: 'number', description: 'Optional timeout in milliseconds (default: 120000)', required: false },
			{ name: 'workdir', type: 'string', description: `Working directory (default: ${workingDirectory})`, required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const command = (args.command as string) || '';
			if (!command.trim()) {
				return { title: 'bash: missing command', output: 'Required argument "command" was not provided.', metadata: { error: true } };
			}
			const description = (args.description as string) || command.substring(0, 60);
			const timeout = (args.timeout as number) ?? DEFAULT_TIMEOUT;
			const cwd = (args.workdir as string) ?? workingDirectory;

			if (timeout < 0) {
				throw new Error(`Invalid timeout: ${timeout}. Must be positive.`);
			}

			ctx.metadata({ title: description, metadata: { output: '', description } });

			return new Promise<IToolResult>((resolve, reject) => {
				let output = '';
				let timedOut = false;
				let aborted = false;

				const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
				const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command];

				const proc = cp.spawn(shell, shellArgs, {
					cwd,
					env: { ...process.env },
					stdio: ['ignore', 'pipe', 'pipe'],
				});

				const append = (chunk: Buffer) => {
					const text = chunk.toString();
					output += text;
					if (output.length <= MAX_OUTPUT) {
						ctx.metadata({ metadata: { output, description } });
					}
				};

				proc.stdout?.on('data', append);
				proc.stderr?.on('data', append);

				const timer = setTimeout(() => {
					timedOut = true;
					proc.kill('SIGTERM');
					setTimeout(() => proc.kill('SIGKILL'), 5000);
				}, timeout);

				const abortHandler = () => {
					aborted = true;
					proc.kill('SIGTERM');
				};
				ctx.abort.addEventListener('abort', abortHandler, { once: true });

				proc.once('exit', (code) => {
					clearTimeout(timer);
					ctx.abort.removeEventListener('abort', abortHandler);

					if (timedOut) {
						output += `\n\n[Command timed out after ${timeout}ms]`;
					}
					if (aborted) {
						output += '\n\n[Command aborted by user]';
					}

					// Truncate if too long
					if (output.length > MAX_OUTPUT) {
						output = output.substring(0, MAX_OUTPUT) + '\n\n[Output truncated at 50KB]';
					}

					resolve({
						title: description,
						output,
						metadata: {
							exit: code,
							description,
							output: output.substring(0, 30000),
						},
					});
				});

				proc.once('error', (err) => {
					clearTimeout(timer);
					ctx.abort.removeEventListener('abort', abortHandler);
					reject(err);
				});
			});
		},
	);
}
