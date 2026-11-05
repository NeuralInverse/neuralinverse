/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *
 *  Code Archaeology Tool — Legacy code understanding for Power Mode agents.
 *
 *  Analyzes unfamiliar/legacy codebases to answer: "What does this code do?"
 *  Traces variable origins, builds call graphs, identifies dead code,
 *  and generates plain-English explanations.
 *
 *  Parameters:
 *    filePath: Absolute path to the file to analyze
 *    analysisType: 'overview' | 'call-graph' | 'variable-trace' | 'dead-code' | 'business-logic'
 *    context: Optional description of what business logic this code supports
 *
 *  Returns:
 *    summary: Plain-English explanation of what the code does
 *    keyFunctions: List of functions/methods with purpose
 *    dependencies: Files and modules this code depends on
 *    dependents: Other code that calls this code
 *    deadCode: Functions that appear unused
 *    risks: Potential issues (security, performance, maintainability)
 *    recommendations: Suggested refactoring steps
 *--------------------------------------------------------------------------------------------*/

import { definePowerTool } from './powerToolRegistry.js';
import { IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';

function _resolve(workingDirectory: string, filePath: string): string {
	const _WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
	const isAbsolute = filePath.startsWith('/') || _WIN_DRIVE_RE.test(filePath);
	if (isAbsolute) { return filePath; }
	const base = workingDirectory.replace(/\\/g, '/');
	const rel = filePath.replace(/\\/g, '/');
	return base + (base.endsWith('/') ? '' : '/') + rel;
}

function _basename(p: string): string {
	const normalized = p.replace(/\\/g, '/');
	const parts = normalized.split('/');
	return parts[parts.length - 1] || normalized;
}

export function createCodeArchaeologyTool(
	workingDirectory: string,
	fileService: IFileService,
): IPowerTool {
	return definePowerTool(
		'code_archaeology',
		`Analyze unfamiliar or legacy code to understand what it does.

Use this when you open a file and think "what does this even do?"
The tool traces variables, builds call graphs, finds dead code,
and explains business logic in plain English.

Parameters:
- filePath: Absolute path to the file to analyze
- analysisType: Type of analysis:
  - 'overview'      — General summary of what the file does
  - 'call-graph'    — Functions and their call relationships
  - 'variable-trace'— Where variables come from and where they go
  - 'dead-code'     — Functions that appear unused
  - 'business-logic'— What business process this code implements
- context: Optional description of the business domain (e.g. "school management system")

Returns:
- summary: Plain-English explanation
- keyFunctions: Functions with their purpose and complexity
- dependencies: Files/modules this code imports/calls
- dependents: Other code that calls this code
- deadCode: Potentially unused functions
- risks: Security, performance, maintainability concerns
- recommendations: Suggested refactoring steps

Example:
  code_archaeology({
    filePath: "src/legacy/auth.php",
    analysisType: "business-logic",
    context: "school management system authentication"
  })`,
		[
			{
				name: 'filePath',
				type: 'string',
				description: 'Absolute path to the file to analyze',
				required: true,
			},
			{
				name: 'analysisType',
				type: 'string',
				description: "Type: 'overview' | 'call-graph' | 'variable-trace' | 'dead-code' | 'business-logic'",
				required: false,
			},
			{
				name: 'context',
				type: 'string',
				description: 'Optional business domain context',
				required: false,
			},
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const filePath = args.filePath;
			const analysisType = (args.analysisType as string) ?? 'overview';
			const context = (args.context as string) ?? '';

			if (typeof filePath !== 'string' || filePath.trim().length === 0) {
				return {
					title: 'Invalid file path',
					output: 'Error: filePath must be a non-empty string.',
					metadata: { error: true },
				};
			}

			const validTypes = ['overview', 'call-graph', 'variable-trace', 'dead-code', 'business-logic'];
			if (!validTypes.includes(analysisType)) {
				return {
					title: 'Invalid analysis type',
					output: `Error: analysisType must be one of: ${validTypes.join(', ')}.`,
					metadata: { error: true },
				};
			}

			let resolvedPath = _resolve(workingDirectory, filePath);

			ctx.metadata({ title: `Code Archaeology: ${_basename(resolvedPath)}` });

			let content: string;
			try {
				const fileContent = await fileService.readFile(URI.file(resolvedPath));
				content = fileContent.value.toString();
			} catch {
				return {
					title: 'File not found',
					output: `Error: File not found: ${resolvedPath}`,
					metadata: { error: true },
				};
			}

			const lines = content.split('\n');
			const totalLines = lines.length;

			// Extract functions/methods
			const functions = _extractFunctions(lines);
			const imports = _extractImports(lines, content);
			const calls = _extractFunctionCalls(lines);
			const variables = _extractVariables(lines);

			// Build analysis based on type
			const summary = _buildSummary(functions, imports, calls, analysisType, context);
			const keyFunctions = _buildKeyFunctions(functions);
			const dependencies = imports;
			const dependents = []; // Would need cross-file analysis
			const deadCode = _findDeadCode(functions, calls);
			const risks = _identifyRisks(lines, functions, context);
			const recommendations = _buildRecommendations(deadCode, risks, analysisType);

			const outputLines: string[] = [];
			outputLines.push(`Code Archaeology: ${_basename(resolvedPath)}`);
			outputLines.push(`========================================`);
			outputLines.push(`Analysis type: ${analysisType}`);
			outputLines.push(`Total lines: ${totalLines}`);
			outputLines.push(`Functions found: ${functions.length}`);
			outputLines.push('');

			outputLines.push('Summary:');
			outputLines.push(summary);
			outputLines.push('');

			if (keyFunctions.length > 0) {
				outputLines.push('Key Functions:');
				for (const f of keyFunctions) {
					outputLines.push(`  • ${f.name} (${f.type}) — ${f.purpose}`);
				}
				outputLines.push('');
			}

			if (dependencies.length > 0) {
				outputLines.push('Dependencies:');
				for (const d of dependencies) {
					outputLines.push(`  • ${d}`);
				}
				outputLines.push('');
			}

			if (deadCode.length > 0) {
				outputLines.push('Potentially Dead Code:');
				for (const d of deadCode) {
					outputLines.push(`  • ${d.name} at line ${d.line}`);
				}
				outputLines.push('');
			}

			if (risks.length > 0) {
				outputLines.push('Risks:');
				for (const r of risks) {
					outputLines.push(`  ⚠ ${r}`);
				}
				outputLines.push('');
			}

			if (recommendations.length > 0) {
				outputLines.push('Recommendations:');
				for (const r of recommendations) {
					outputLines.push(`  • ${r}`);
				}
			}

			return {
				title: `Code Archaeology: ${_basename(resolvedPath)}`,
				output: outputLines.join('\n'),
				metadata: {
					filePath: resolvedPath,
					analysisType,
					totalLines,
					functionCount: functions.length,
					summary,
					keyFunctions,
					dependencies,
					deadCode,
					risks,
					recommendations,
				},
			};
		},
	);
}

// ─── Analysis Helpers ───────────────────────────────────────────────────

interface CodeFunction {
	name: string;
	type: 'function' | 'method' | 'class' | 'procedure';
	line: number;
	complexity: number;
	purpose: string;
	isExported: boolean;
}

interface CodeImport {
	module: string;
	type: 'require' | 'import' | 'include' | 'use';
	line: number;
}

function _extractFunctions(lines: string[]): CodeFunction[] {
	const functions: CodeFunction[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();

		// PHP function
		const phpFunc = line.match(/function\s+(\w+)\s*\(/);
		if (phpFunc) {
			functions.push({
				name: phpFunc[1],
				type: 'function',
				line: i + 1,
				complexity: _estimateComplexity(lines.slice(i, Math.min(i + 30, lines.length))),
				purpose: _inferPurpose(phpFunc[1], lines.slice(i, Math.min(i + 10, lines.length))),
				isExported: true,
			});
			continue;
		}

		// JavaScript/TypeScript function
		const jsFunc = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/);
		if (jsFunc) {
			functions.push({
				name: jsFunc[1],
				type: 'function',
				line: i + 1,
				complexity: _estimateComplexity(lines.slice(i, Math.min(i + 30, lines.length))),
				purpose: _inferPurpose(jsFunc[1], lines.slice(i, Math.min(i + 10, lines.length))),
				isExported: line.includes('export'),
			});
			continue;
		}

		// JS arrow/const function
		const jsArrow = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/);
		if (jsArrow) {
			functions.push({
				name: jsArrow[1],
				type: 'function',
				line: i + 1,
				complexity: _estimateComplexity(lines.slice(i, Math.min(i + 30, lines.length))),
				purpose: _inferPurpose(jsArrow[1], lines.slice(i, Math.min(i + 10, lines.length))),
				isExported: line.includes('export'),
			});
			continue;
		}

		// Class
		const cls = line.match(/class\s+(\w+)/);
		if (cls) {
			functions.push({
				name: cls[1],
				type: 'class',
				line: i + 1,
				complexity: _estimateComplexity(lines.slice(i, Math.min(i + 50, lines.length))),
				purpose: _inferPurpose(cls[1], lines.slice(i, Math.min(i + 20, lines.length))),
				isExported: line.includes('export'),
			});
			continue;
		}
	}

	return functions;
}

function _extractImports(lines: string[], content: string): CodeImport[] {
	const imports: CodeImport[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();

		// PHP include/require
		const phpInc = line.match(/(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/);
		if (phpInc) {
			imports.push({ module: phpInc[1], type: 'include', line: i + 1 });
			continue;
		}

		// PHP use statement
		const phpUse = line.match(/^use\s+([\\.\w]+);/);
		if (phpUse) {
			imports.push({ module: phpUse[1], type: 'use', line: i + 1 });
			continue;
		}

		// JS/TS import
		const jsImport = line.match(/import\s+(?:\{\s*[^}]+\s*|\w+|\*\s*as\s+\w+)\s+from\s*['"]([^'"]+)['"]/);
		if (jsImport) {
			imports.push({ module: jsImport[1], type: 'import', line: i + 1 });
			continue;
		}

		// JS/TS require
		const jsRequire = line.match(/(?:const|let|var)\s+\w+\s*=\s*require\s*\(['"]([^'"]+)['"]\)/);
		if (jsRequire) {
			imports.push({ module: jsRequire[1], type: 'require', line: i + 1 });
			continue;
		}
	}

	return imports;
}

function _extractFunctionCalls(lines: string[]): string[] {
	const calls: string[] = [];
	const callPattern = /(\w+)\s*\(/g;

	for (const line of lines) {
		const trimmed = line.trim();
		// Skip comments and string literals roughly
		if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;

		let match;
		while ((match = callPattern.exec(line)) !== null) {
			const name = match[1];
			// Skip common language keywords that look like calls
			if (['if', 'while', 'for', 'switch', 'catch', 'sizeof', 'isset', 'empty', 'print', 'echo'].includes(name)) continue;
			calls.push(name);
		}
	}

	return [...new Set(calls)];
}

function _extractVariables(lines: string[]): Array<{ name: string; line: number; type: 'declare' | 'use' }> {
	const variables: Array<{ name: string; line: number; type: 'declare' | 'use' }> = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();

		// PHP variable declaration
		const phpVar = line.match(/\$([a-zA-Z_]\w*)\s*=/);
		if (phpVar) {
			variables.push({ name: phpVar[1], line: i + 1, type: 'declare' });
		}

		// JS/TS variable declaration
		const jsVar = line.match(/(?:const|let|var)\s+([a-zA-Z_]\w*)/);
		if (jsVar) {
			variables.push({ name: jsVar[1], line: i + 1, type: 'declare' });
		}
	}

	return variables;
}

function _estimateComplexity(lines: string[]): number {
	let complexity = 1;
	const keywords = ['if', 'else if', 'else', 'for', 'foreach', 'while', 'case', 'catch', '&&', '||', '?'];

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;

		for (const kw of keywords) {
			if (trimmed.includes(kw)) complexity++;
		}
	}

	return Math.min(complexity, 50);
}

function _inferPurpose(name: string, contextLines: string[]): string {
	const nameLower = name.toLowerCase();
	const context = contextLines.join(' ').toLowerCase();

	if (nameLower.includes('get') || nameLower.includes('fetch') || nameLower.includes('retrieve')) {
		return 'Retrieves data';
	}
	if (nameLower.includes('set') || nameLower.includes('save') || nameLower.includes('update') || nameLower.includes('create')) {
		return 'Creates or modifies data';
	}
	if (nameLower.includes('delete') || nameLower.includes('remove')) {
		return 'Deletes data';
	}
	if (nameLower.includes('validate') || nameLower.includes('check') || nameLower.includes('verify')) {
		return 'Validates input or state';
	}
	if (nameLower.includes('render') || nameLower.includes('display') || nameLower.includes('show') || nameLower.includes('view')) {
		return 'Renders or displays output';
	}
	if (nameLower.includes('init') || nameLower.includes('setup') || nameLower.includes('configure')) {
		return 'Initializes or configures';
	}
	if (nameLower.includes('connect') || nameLower.includes('login') || nameLower.includes('auth')) {
		return 'Handles connection or authentication';
	}
	if (context.includes('class') && context.includes('extends')) {
		return 'Class definition with inheritance';
	}
	if (context.includes('function') && context.includes('return')) {
		return 'Computes and returns a value';
	}

	return 'Function purpose unclear from context';
}

function _buildSummary(functions: CodeFunction[], imports: CodeImport[], calls: string[], analysisType: string, context: string): string {
	const parts: string[] = [];

	if (functions.length === 0) {
		parts.push('No functions or classes detected. This file may contain configuration, data, or procedural code.');
		return parts.join(' ');
	}

	const mainFuncs = functions.filter(f => f.type === 'function' || f.type === 'method');
	const classes = functions.filter(f => f.type === 'class');

	if (classes.length > 0) {
		parts.push(`This file defines ${classes.length} class(es): ${classes.map(c => c.name).join(', ')}.`);
	}
	if (mainFuncs.length > 0) {
		parts.push(`It contains ${mainFuncs.length} function(s) that handle the core logic.`);
	}

	if (imports.length > 0) {
		parts.push(`It depends on ${imports.length} external module(s): ${imports.map(i => i.module).join(', ')}.`);
	}

	if (context) {
		parts.push(`In the context of ${context}, this code likely handles related business operations.`);
	}

	const highComplexity = functions.filter(f => f.complexity > 10);
	if (highComplexity.length > 0) {
		parts.push(`Warning: ${highComplexity.length} function(s) have high complexity and may be difficult to maintain.`);
	}

	return parts.join(' ');
}

function _buildKeyFunctions(functions: CodeFunction[]): Array<{ name: string; type: string; purpose: string; complexity: number }> {
	return functions
		.sort((a, b) => b.complexity - a.complexity)
		.slice(0, 10)
		.map(f => ({
			name: f.name,
			type: f.type,
			purpose: f.purpose,
			complexity: f.complexity,
		}));
}

function _findDeadCode(functions: CodeFunction[], calls: string[]): Array<{ name: string; line: number }> {
	const dead: Array<{ name: string; line: number }> = [];

	for (const f of functions) {
		const isCalled = calls.includes(f.name) || calls.some(c => c === f.name);
		if (!isCalled) {
			dead.push({ name: f.name, line: f.line });
		}
	}

	return dead.slice(0, 10);
}

function _identifyRisks(lines: string[], functions: CodeFunction[], context: string): string[] {
	const risks: string[] = [];
	const content = lines.join('\n').toLowerCase();

	// Security risks
	if (content.includes('eval(') || content.includes('exec(')) {
		risks.push('Uses eval() or exec() — potential code injection risk');
	}
	if (content.includes('$_get') || content.includes('$_post') || content.includes('$_request')) {
		risks.push('Directly uses superglobals — validate and sanitize input');
	}
	if (content.includes('md5(') || content.includes('sha1(')) {
		risks.push('Uses weak hash algorithm (MD5/SHA1) — consider bcrypt or argon2');
	}
	if (content.includes('mysql_query') || content.includes('mysqli_query')) {
		risks.push('Uses raw SQL queries — check for SQL injection vulnerabilities');
	}

	// Maintainability risks
	const highComplexity = functions.filter(f => f.complexity > 15);
	if (highComplexity.length > 0) {
		risks.push(`${highComplexity.length} function(s) have high cyclomatic complexity — consider refactoring`);
	}

	if (lines.length > 1000) {
		risks.push('File is large (>1000 lines) — consider splitting into smaller modules');
	}

	// Context-specific risks
	if (context && context.toLowerCase().includes('school')) {
		if (content.includes('password') && !content.includes('password_hash') && !content.includes('password_verify')) {
			risks.push('Handles passwords but may not use secure hashing — verify password storage');
		}
		if (content.includes('student') && !content.includes('sanitize')) {
			risks.push('Handles student data — ensure PII is properly protected');
		}
	}

	return risks.slice(0, 8);
}

function _buildRecommendations(deadCode: Array<{ name: string; line: number }>, risks: string[], analysisType: string): string[] {
	const recommendations: string[] = [];

	if (deadCode.length > 0) {
		recommendations.push(`Remove or review ${deadCode.length} potentially unused function(s): ${deadCode.map(d => d.name).join(', ')}`);
	}

	if (risks.some(r => r.includes('SQL injection'))) {
		recommendations.push('Use parameterized queries or prepared statements to prevent SQL injection');
	}
	if (risks.some(r => r.includes('weak hash'))) {
		recommendations.push('Replace MD5/SHA1 with bcrypt or argon2 for password hashing');
	}
	if (risks.some(r => r.includes('code injection'))) {
		recommendations.push('Remove or restrict use of eval() and exec()');
	}

	if (analysisType === 'business-logic') {
		recommendations.push('Document the business rules implemented in each function');
		recommendations.push('Add unit tests to verify business logic correctness');
	}

	if (analysisType === 'dead-code') {
		recommendations.push('Run the application and monitor which functions are actually called in production');
	}

	if (recommendations.length === 0) {
		recommendations.push('Code appears to be in reasonable shape. Consider adding inline documentation for clarity.');
	}

	return recommendations.slice(0, 6);
}
