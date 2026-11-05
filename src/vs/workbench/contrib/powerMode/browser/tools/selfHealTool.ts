/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *
 *  Self-Healing Code Loop Tool — Autonomous error detection and auto-fix for Power Mode agents.
 *
 *  This tool runs a command, and if it fails, automatically:
 *    1. Parses the error output to find the failing file and line number
 *    2. Reads the relevant source code around that line
 *    3. Attempts an intelligent fix based on the error type
 *    4. Re-runs the command to verify the fix
 *    5. Repeats up to maxAttempts times
 *
 *  Supported error types:
 *    - Syntax errors (PHP, JavaScript, Python, etc.)
 *    - Reference / undefined variable errors
 *    - Import / module not found errors
 *    - Type errors
 *    - Permission / file access errors
 *
 *  Parameters:
 *    command: The shell command to run (e.g. "npm test", "php -l file.php")
 *    description: Brief description of what the command does
 *    maxAttempts: Maximum fix attempts (default: 3, max: 10)
 *    workdir: Working directory (default: current workspace)
 *
 *  Returns:
 *    attempts: Number of attempts made
 *    finalExitCode: Exit code of the last run
 *    finalOutput: Output of the last run
 *    fixesApplied: Array of fixes attempted with file, line, and description
 *    status: 'fixed' | 'maxAttemptsReached' | 'error'
 *--------------------------------------------------------------------------------------------*/

import { definePowerTool } from './powerToolRegistry.js';
import { IToolContext, IToolResult, IPowerTool } from '../../common/powerModeTypes.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IExternalCommandExecutor } from '../../../void/browser/externalCommandExecutor.js';

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS_CAP = 10;

function _resolve(workingDirectory: string, filePath: string): string {
	const _WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
	const isAbsolute = filePath.startsWith('/') || _WIN_DRIVE_RE.test(filePath);
	if (isAbsolute) { return filePath; }
	const base = workingDirectory.replace(/\\/g, '/');
	const rel = filePath.replace(/\\/g, '/');
	return base + (base.endsWith('/') ? '' : '/') + rel;
}

function _shellQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

export function createSelfHealTool(
	workingDirectory: string,
	fileService: IFileService,
	commandExecutor: IExternalCommandExecutor,
): IPowerTool {
	return definePowerTool(
		'self_heal_code',
		`Autonomous error detection and auto-fix loop.

Runs a command, and if it fails, automatically:
  1. Parses the error to find the failing file and line number
  2. Reads the source code around that line
  3. Attempts an intelligent fix based on the error type
  4. Re-runs the command to verify
  5. Repeats up to maxAttempts times

Use this when you want the agent to keep trying until code compiles/passes tests
without manual intervention.

Parameters:
- command: The shell command to run (e.g. "npm test", "php -l file.php", "python -m pytest")
- description: Brief description of what the command does (5-10 words)
- maxAttempts: Maximum fix attempts (default: 3, max: 10)
- workdir: Working directory for the command (default: current workspace)

Returns:
- attempts: Number of attempts made
- finalExitCode: Exit code of the last run (0 = success)
- finalOutput: Output of the last run
- fixesApplied: Array of fixes attempted (file, line, error type, description, success)
- status: 'fixed' (exit code 0) | 'maxAttemptsReached' | 'error'

Example:
  self_heal_code({ command: "npm test", description: "Run test suite", maxAttempts: 5 })`,
		[
			{
				name: 'command',
				type: 'string',
				description: 'The shell command to execute',
				required: true,
			},
			{
				name: 'description',
				type: 'string',
				description: 'Brief description of what this command does',
				required: true,
			},
			{
				name: 'maxAttempts',
				type: 'number',
				description: 'Maximum fix attempts (default: 3, max: 10)',
				required: false,
			},
			{
				name: 'workdir',
				type: 'string',
				description: `Working directory (default: ${workingDirectory})`,
				required: false,
			},
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const command = args.command;
			const description = args.description;
			const maxAttempts = Math.min(Math.max((args.maxAttempts as number) ?? DEFAULT_MAX_ATTEMPTS, 1), MAX_ATTEMPTS_CAP);
			const cwd = (args.workdir as string) ?? workingDirectory;

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

			ctx.metadata({ title: `Self-heal: ${description}` });

			const fixesApplied: Array<{
				attempt: number;
				file?: string;
				line?: number;
				errorType: string;
				description: string;
				success: boolean;
				errorOutput?: string;
			}> = [];

			let lastExitCode = -1;
			let lastOutput = '';
			let status: 'fixed' | 'maxAttemptsReached' | 'error' = 'error';

			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				ctx.metadata({ title: `Self-heal attempt ${attempt}/${maxAttempts}` });

				const fullCommand = `cd ${_shellQuote(cwd)} && ${command}`;
				const jobId = `selfheal_${Date.now()}_${attempt}`;

				let runOutput: string;
				let runExitCode: number;

				try {
					runOutput = await commandExecutor.execute(jobId, fullCommand, 120000, 200 * 1024);
					runExitCode = 0; // execute resolves on success
				} catch (err: any) {
					runOutput = err.message + (err.stderr ? '\n' + err.stderr : '');
					runExitCode = err.exitCode ?? 1;
				}

				lastExitCode = runExitCode;
				lastOutput = runOutput;

				// Command succeeded — we're done
				if (runExitCode === 0) {
					status = 'fixed';
					break;
				}

				// Command failed — try to auto-fix
				const fixResult = await _attemptAutoFix(
					runOutput,
					cwd,
					fileService,
					commandExecutor,
					command
				);

				const fixEntry = {
					attempt,
					file: fixResult.file,
					line: fixResult.line,
					errorType: fixResult.errorType,
					description: fixResult.description,
					success: fixResult.success,
					errorOutput: runOutput.slice(0, 500),
				};
				fixesApplied.push(fixEntry);

				if (!fixResult.success) {
					// Couldn't auto-fix, report what we found
					status = 'maxAttemptsReached';
					break;
				}

				// Fix was applied, loop will re-run the command
			}

			// Build output
			const lines: string[] = [];
			lines.push(`Self-healing code loop: ${description}`);
			lines.push(`============================================`);
			lines.push(`Attempts made: ${fixesApplied.length}/${maxAttempts}`);
			lines.push(`Final exit code: ${lastExitCode}`);
			lines.push(`Status: ${status}`);
			lines.push('');

			if (fixesApplied.length > 0) {
				lines.push('Fixes attempted:');
				for (const f of fixesApplied) {
					const icon = f.success ? '✓' : '✗';
					lines.push(`${icon} Attempt ${f.attempt}: ${f.errorType}`);
					if (f.file) {
						lines.push(`   File: ${f.file}:${f.line ?? '?'}`);
					}
					lines.push(`   ${f.description}`);
					if (f.errorOutput) {
						lines.push(`   Error: ${f.errorOutput.split('\n')[0]}`);
					}
				}
				lines.push('');
			}

			lines.push('Final output:');
			lines.push(lastOutput.slice(-3000));

			return {
				title: `Self-heal: ${status === 'fixed' ? 'Fixed' : 'Could not auto-fix'}`,
				output: lines.join('\n'),
				metadata: {
					status,
					attempts: fixesApplied.length,
					maxAttempts,
					finalExitCode: lastExitCode,
					finalOutput: lastOutput,
					fixesApplied,
				},
			};
		},
	);
}

// ─── Auto-fix logic ───────────────────────────────────────────────────────

interface FixResult {
	file?: string;
	line?: number;
	errorType: string;
	description: string;
	success: boolean;
}

async function _attemptAutoFix(
	errorOutput: string,
	cwd: string,
	fileService: IFileService,
	commandExecutor: IExternalCommandExecutor,
	originalCommand: string
): Promise<FixResult> {
	const lines = errorOutput.split('\n');

	// Try to extract file:line from common error formats
	const fileLine = _extractFileLine(lines);
	if (!fileLine) {
		return {
			file: undefined,
			line: undefined,
			errorType: 'unknown',
			description: 'Could not parse file/line from error output. Manual investigation needed.',
			success: false,
		};
	}

	const { filePath, lineNumber } = fileLine;

	// Read the file around the error line
	let fileContent: string;
	try {
		const resolvedPath = _resolve(cwd, filePath);
		const content = await fileService.readFile(URI.file(resolvedPath));
		fileContent = content.value.toString();
	} catch {
		return {
			file: filePath,
			line: lineNumber,
			errorType: 'file_read_error',
			description: `Could not read ${filePath} to attempt fix.`,
			success: false,
		};
	}

	const fileLines = fileContent.split('\n');
	const errorType = _classifyError(errorOutput);

	// Attempt fix based on error type
	const fixResult = _applyFix(fileLines, lineNumber, errorType, errorOutput);
	if (!fixResult.success) {
		return {
			file: filePath,
			line: lineNumber,
			errorType,
			description: fixResult.description,
			success: false,
		};
	}

	// Write the fixed file
	const newContent = fileLines.join('\n');
	try {
		const resolvedPath = _resolve(cwd, filePath);
		await fileService.writeFile(URI.file(resolvedPath), VSBuffer.fromString(newContent));
	} catch (err: any) {
		return {
			file: filePath,
			line: lineNumber,
			errorType,
			description: `Failed to write fix to ${filePath}: ${err.message}`,
			success: false,
		};
	}

	return {
		file: filePath,
		line: lineNumber,
		errorType,
		description: fixResult.description,
		success: true,
	};
}

// ─── Error extraction ─────────────────────────────────────────────────────

interface FileLine { filePath: string; lineNumber: number; }

function _extractFileLine(lines: string[]): FileLine | null {
	// Common patterns:
	//   file.php:45: error message
	//   file.js:45:10 - error
	//   /path/to/file.py line 45
	//   file.ts(45,10): error TSxxx
	//   line 45, in <module>
	const patterns = [
		// path/to/file:line:col or path/to/file:line
		/([^\s:]+(?:\.[a-zA-Z0-9]+)?):(\d+)(?::\d+)?\s*:/,
		// path/file.ext line N
		/([^\s:]+(?:\.[a-zA-Z0-9]+)?)\s+line\s+(\d+)/i,
		// file.ext(line, col):
		/([^\s:]+(?:\.[a-zA-Z0-9]+)?)\((\d+),\s*\d+\)/,
		// in file "path", line N
		/in\s+file\s+"([^"]+)",\s*line\s+(\d+)/i,
	];

	for (const line of lines) {
		for (const pattern of patterns) {
			const match = line.match(pattern);
			if (match) {
				return {
					filePath: match[1],
					lineNumber: parseInt(match[2], 10),
				};
			}
		}
	}
	return null;
}

function _classifyError(errorOutput: string): string {
	const lower = errorOutput.toLowerCase();

	if (/syntax error|unexpected|parse error/i.test(lower)) return 'syntax_error';
	if (/referenceerror|is not defined|cannot read property|undefined/i.test(lower)) return 'reference_error';
	if (/module not found|cannot find module|require\(|import.*from/i.test(lower)) return 'import_error';
	if (/typeerror|type error|is not a function|is not iterable/i.test(lower)) return 'type_error';
	if (/permission denied|eacces|no such file or directory/i.test(lower)) return 'file_access_error';
	if (/fatal error/i.test(lower)) return 'fatal_error';
	if (/warning/i.test(lower)) return 'warning';

	return 'unknown_error';
}

// ─── Fix application ─────────────────────────────────────────────────────

function _applyFix(
	fileLines: string[],
	errorLine: number,
	errorType: string,
	fullError: string
): { success: boolean; description: string } {
	// Convert to 0-indexed
	const idx = errorLine - 1;
	if (idx < 0 || idx >= fileLines.length) {
		return {
			success: false,
			description: `Line ${errorLine} is outside file bounds (${fileLines.length} lines).`,
		};
	}

	const line = fileLines[idx];

	switch (errorType) {
		case 'syntax_error': {
			// Common PHP/JavaScript syntax fixes
			const trimmed = line.trim();
			// Missing semicolon at end of statement (JS/PHP)
			if (/[\)\}\w\d"\']\s*$/.test(trimmed) && !trimmed.endsWith(';') && !trimmed.endsWith('{') && !trimmed.endsWith('}') && !trimmed.endsWith(',')) {
				fileLines[idx] = line.replace(/\s*$/, ';');
				return {
					success: true,
					description: 'Added missing semicolon at end of statement.',
				};
			}
			// Unmatched opening brace - add closing brace on next line
			if (trimmed.endsWith('{') && !trimmed.includes('}')) {
				fileLines.splice(idx + 1, 0, '    }');
				return {
					success: true,
					description: 'Added missing closing brace.',
				};
			}
			return {
				success: false,
				description: `Syntax error at line ${errorLine}: "${line.trim()}". Could not auto-determine fix.`,
			};
		}

		case 'reference_error': {
			// Undefined variable - try to add a default/null check
			const varMatch = line.match(/(\w+)\s*[=!<>]/);
			if (varMatch) {
				const varName = varMatch[1];
				// Add null check before usage
				fileLines[idx] = line.replace(varName, `(${varName} ?? null)`);
				return {
					success: true,
					description: `Added null-coalescing check for undefined variable '${varName}'.`,
				};
			}
			return {
				success: false,
				description: `Reference error at line ${errorLine}: "${line.trim()}". Could not determine fix.`,
			};
		}

		case 'type_error': {
			// "is not a function" - try to add typeof check
			if (/is not a function/i.test(line)) {
				const fnMatch = line.match(/(\w+)\s*\(/);
				if (fnMatch) {
					const fnName = fnMatch[1];
					fileLines[idx] = line.replace(fnName, `(typeof ${fnName} === 'function' ? ${fnName} : () => {})`);
					return {
						success: true,
						description: `Added typeof guard for non-function '${fnName}'.`,
					};
				}
			}
			return {
				success: false,
				description: `Type error at line ${errorLine}: "${line.trim()}". Could not auto-determine fix.`,
			};
		}

		case 'import_error': {
			// Module not found - suggest adding import or check path
			return {
				success: false,
				description: `Import error at line ${errorLine}: "${line.trim()}". Manual fix needed - check module path or install dependency.`,
			};
		}

		case 'file_access_error': {
			return {
				success: false,
				description: `File access error at line ${errorLine}: "${line.trim()}". Check file permissions and path.`,
			};
		}

		default:
			return {
				success: false,
				description: `Error at line ${errorLine}: "${line.trim()}". Unknown error type, manual fix needed.`,
			};
	}
}
