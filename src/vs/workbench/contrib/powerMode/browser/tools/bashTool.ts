/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

import { definePowerTool } from './powerToolRegistry.js';
import { IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import * as cp from 'child_process';

const DEFAULT_TIMEOUT = 2 * 60 * 1000; // 2 minutes
const MAX_OUTPUT = 50 * 1024; // 50KB

export function createBashTool(workingDirectory: string, getModelInfo?: () => { provider: string; model: string } | undefined) {
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
			const command = args.command;
			const description = args.description;
			if (typeof command !== 'string' || command.trim().length === 0) {
				return {
					title: 'Invalid command',
					output: 'Error: command must be a non-empty string.',
					metadata: { error: true },
				};
			}
			if (typeof description !== 'string' || description.trim().length === 0) {
				return {
					title: 'Invalid description',
					output: 'Error: description must be a non-empty string.',
					metadata: { error: true },
				};
			}
			const timeout = (args.timeout as number) ?? DEFAULT_TIMEOUT;
			const cwd = (args.workdir as string) ?? workingDirectory;

			// Auto-inject co-author trailers when bash is used for git commit
			command = _injectCoAuthorIfGitCommit(command, getModelInfo?.());

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

function _getCoAuthorTrailers(modelInfo?: { provider: string; model: string }): string {
	const platform = 'Co-authored-by: neuralinverse-dev <noreply@neuralinverse.com>';
	let llmTrailer: string;
	const provider = (modelInfo?.provider ?? '').toLowerCase();
	const model = (modelInfo?.model ?? '').toLowerCase();
	if (provider.includes('openai') || model.includes('gpt') || model.includes('chatgpt') || model.includes('o1') || model.includes('o3') || model.includes('o4')) {
		llmTrailer = 'Co-authored-by: ChatGPT <noreply@openai.com>';
	} else if (provider.includes('google') || model.includes('gemini') || model.includes('gemma')) {
		llmTrailer = 'Co-authored-by: Gemini <noreply@google.com>';
	} else if (provider.includes('deepseek') || model.includes('deepseek')) {
		llmTrailer = 'Co-authored-by: DeepSeek <noreply@deepseek.com>';
	} else if (provider.includes('mistral') || model.includes('mistral') || model.includes('codestral')) {
		llmTrailer = 'Co-authored-by: Mistral <noreply@mistral.ai>';
	} else if (provider.includes('meta') || model.includes('llama')) {
		llmTrailer = 'Co-authored-by: Meta AI <noreply@meta.com>';
	} else {
		llmTrailer = 'Co-authored-by: Claude <noreply@anthropic.com>';
	}
	return `\n\n${platform}\n${llmTrailer}`;
}

function _injectCoAuthorIfGitCommit(command: string, modelInfo?: { provider: string; model: string }): string {
	if (command.includes('Co-authored-by:')) { return command; }

	// Match: git commit -m "message" or git commit -m 'message'
	const pattern = /(git\s+commit\s+(?:[^-]*\s+)?-m\s+)(["'])([\s\S]*?)\2/;
	const match = command.match(pattern);
	if (!match) { return command; }

	const trailers = _getCoAuthorTrailers(modelInfo);
	const newMsg = match[3] + trailers;
	return command.replace(pattern, `$1$2${newMsg}$2`);
}
