/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Universal Analyzer
 *
 * Executes `type: "universal"` rules against ANY language.
 *
 * ## How it works
 *
 * The universal analyzer bridges the gap between TypeScript-specific AST
 * analysis and pure text-based regex. It knows about:
 *
 * 1. **Language identity** — detects the language from VS Code's language ID
 *    or from the file extension, and skips files not in the rule's `languages` list.
 *
 * 2. **Per-language pattern variants** — a single rule can specify different
 *    patterns per language via `check.languagePatterns`. The correct pattern
 *    is selected automatically.
 *
 * 3. **Context stripping** — same `excludeContexts` support as regex rules:
 *    removes comments/strings/template-literals before matching so patterns
 *    don't fire inside comments.
 *
 * ## Why this matters for multi-language projects
 *
 * Without universal rules, a team writing C + Python + TypeScript needs
 * THREE separate rules for the same concern (e.g. hardcoded credentials).
 * Universal rules allow ONE rule definition covering all languages.
 *
 * ## Background scanning
 *
 * Implements `evaluateContent()` so background workspace scanning works
 * for ALL languages, not just open files. The language ID is inferred
 * from the file extension.
 *
 * ## Example framework rule
 *
 * ```json
 * {
 *   "id": "SEC-CRED-001",
 *   "title": "Hardcoded credential",
 *   "severity": "blocker",
 *   "category": "security",
 *   "check": {
 *     "type": "universal",
 *     "pattern": "(password|secret|api_key|token)\\s*[=:]\\s*[\"'][^\"']{4,}[\"']",
 *     "excludeContexts": ["comment"],
 *     "languagePatterns": {
 *       "java":   "(?:String|final)\\s+(?:password|secret|apiKey|token)\\s*=\\s*\"[^\"]+\"",
 *       "c":      "(?:char|const char)\\s*\\*?\\s*(?:password|secret|api_key)\\s*=\\s*\"[^\"]+\"",
 *       "python": "(?:PASSWORD|SECRET|API_KEY|TOKEN)\\s*=\\s*[\"'][^\"']{4,}[\"']"
 *     }
 *   }
 * }
 * ```
 */

import { ITextModel } from '../../../../../../editor/common/model.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IGRCRule, ICheckResult, toDisplaySeverity } from '../types/grcTypes.js';
import { IUniversalCheck } from '../framework/frameworkSchema.js';
import { IRuleAnalyzer } from '../services/grcEngineService.js';
import { INanoAgentContext } from '../../nanoAgents/projectAnalyzerService.js';


// ─── Universal Analyzer ───────────────────────────────────────────────────────

export class UniversalAnalyzer implements IRuleAnalyzer {
	readonly supportedTypes = ['universal'];

	/** Compiled regex cache: ruleId + langId \u2192 RegExp */
	private readonly _regexCache = new Map<string, RegExp | null>();


	// ─── IRuleAnalyzer: evaluate with open model ─────────────────────

	public evaluate(
		rule: IGRCRule,
		model: ITextModel,
		fileUri: URI,
		timestamp: number,
		_context?: INanoAgentContext
	): ICheckResult[] {
		const languageId = model.getLanguageId();
		const lines = model.getLinesContent();
		return this._run(rule, lines, fileUri, languageId, timestamp);
	}


	// ─── IRuleAnalyzer: evaluateContent for background scanning ──────

	public evaluateContent(
		rule: IGRCRule,
		content: string,
		fileUri: URI,
		languageId: string,
		timestamp: number
	): ICheckResult[] {
		const lines = content.split('\n');
		return this._run(rule, lines, fileUri, languageId, timestamp);
	}


	// ─── Core Evaluation ─────────────────────────────────────────────

	private _run(
		rule: IGRCRule,
		lines: string[],
		fileUri: URI,
		languageId: string,
		timestamp: number
	): ICheckResult[] {
		const check = rule.check as IUniversalCheck | undefined;
		if (!check) return [];

		// Language filter — skip if this file's language is not in the list
		if (check.languages && check.languages.length > 0) {
			const langLower = languageId.toLowerCase();
			const matches = check.languages.some(l => l.toLowerCase() === langLower);
			if (!matches) return [];
		}

		// Pick the correct pattern for this language
		const pattern = this._selectPattern(check, languageId);
		if (!pattern) return [];

		const regex = this._getRegex(rule.id, languageId, pattern, check.flags);
		if (!regex) return [];

		const results: ICheckResult[] = [];
		const excludeContexts = check.excludeContexts;

		if (check.multiline) {
			// ── Multi-line mode ──
			const fullContent = lines.join('\n');
			const cleaned = excludeContexts
				? this._stripContexts(fullContent, excludeContexts)
				: fullContent;

			const globalRegex = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
			globalRegex.lastIndex = 0;
			let match: RegExpExecArray | null;

			while ((match = globalRegex.exec(cleaned)) !== null) {
				const { line, col } = this._posToLineCol(fullContent, match.index);
				const end = this._posToLineCol(fullContent, match.index + match[0].length);
				results.push(this._makeResult(rule, fileUri, line, col, end.line, end.col, match[0], timestamp));
				if (match[0].length === 0) globalRegex.lastIndex++;
			}
		} else {
			// ── Line-by-line mode ──
			for (let i = 0; i < lines.length; i++) {
				let line = lines[i];

				if (excludeContexts) {
					line = this._stripLine(line, excludeContexts);
				} else {
					// Default: skip comment-only lines
					const t = line.trim();
					if (t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('--')) {
						continue;
					}
				}

				regex.lastIndex = 0;
				const match = regex.exec(line);
				if (match) {
					results.push(this._makeResult(rule, fileUri, i + 1, match.index + 1, i + 1, match.index + match[0].length + 1, match[0], timestamp));
				}
			}
		}

		return results;
	}


	// ─── Pattern Selection ───────────────────────────────────────────

	/**
	 * Select the most specific pattern for the current language.
	 * Priority: languagePatterns[langId] > pattern > null (no-op)
	 */
	private _selectPattern(check: IUniversalCheck, languageId: string): string | null {
		if (check.languagePatterns) {
			const langLower = languageId.toLowerCase();
			// Exact match first
			if (check.languagePatterns[langLower]) {
				return check.languagePatterns[langLower];
			}
			// Prefix match (e.g. "typescriptreact" matches "typescript")
			for (const [key, pat] of Object.entries(check.languagePatterns)) {
				if (langLower.startsWith(key.toLowerCase())) {
					return pat;
				}
			}
		}
		return check.pattern ?? null;
	}


	// ─── Regex Compilation ───────────────────────────────────────────

	private _getRegex(ruleId: string, languageId: string, pattern: string, flags?: string): RegExp | null {
		const cacheKey = `${ruleId}:${languageId}:${pattern}`;
		const cached = this._regexCache.get(cacheKey);
		if (cached !== undefined) return cached;

		try {
			const f = flags ?? 'gi';
			const regex = new RegExp(pattern, f.includes('g') ? f : f + 'g');
			this._regexCache.set(cacheKey, regex);
			return regex;
		} catch (e) {
			console.error(`[UniversalAnalyzer] Invalid pattern for rule ${ruleId} (${languageId}):`, pattern, e);
			this._regexCache.set(cacheKey, null);
			return null;
		}
	}


	// ─── Result Factory ──────────────────────────────────────────────

	private _makeResult(
		rule: IGRCRule,
		fileUri: URI,
		line: number, column: number,
		endLine: number, endColumn: number,
		snippet: string,
		timestamp: number
	): ICheckResult {
		return {
			ruleId: rule.id,
			domain: rule.domain,
			severity: toDisplaySeverity(rule.severity),
			message: `[${rule.id}] ${rule.message}`,
			fileUri,
			line,
			column,
			endLine,
			endColumn,
			codeSnippet: snippet.substring(0, 120),
			fix: rule.fix,
			timestamp,
			frameworkId: rule.frameworkId,
			references: rule.references,
			blockingBehavior: rule.blockingBehavior,
			checkSource: 'static',
		};
	}


	// ─── Context Stripping ───────────────────────────────────────────
	// Adapted from grcEngineService.ts — same logic, kept self-contained.

	private _posToLineCol(content: string, pos: number): { line: number; col: number } {
		let line = 1, col = 1;
		for (let i = 0; i < pos && i < content.length; i++) {
			if (content[i] === '\n') { line++; col = 1; } else { col++; }
		}
		return { line, col };
	}

	private _stripContexts(content: string, contexts: ('comment' | 'string' | 'template-literal')[]): string {
		const chars = content.split('');
		const len = chars.length;
		let i = 0;
		while (i < len) {
			if (contexts.includes('comment') && chars[i] === '/' && chars[i + 1] === '/') {
				while (i < len && chars[i] !== '\n') { chars[i] = ' '; i++; }
				continue;
			}
			if (contexts.includes('comment') && chars[i] === '/' && chars[i + 1] === '*') {
				chars[i] = ' '; chars[i + 1] = ' '; i += 2;
				while (i < len && !(chars[i] === '*' && chars[i + 1] === '/')) {
					if (chars[i] !== '\n') chars[i] = ' ';
					i++;
				}
				if (i < len) { chars[i] = ' '; chars[i + 1] = ' '; i += 2; }
				continue;
			}
			// Hash comments (Python, Ruby, shell, YAML)
			if (contexts.includes('comment') && chars[i] === '#') {
				while (i < len && chars[i] !== '\n') { chars[i] = ' '; i++; }
				continue;
			}
			// SQL/Lua double-dash comments
			if (contexts.includes('comment') && chars[i] === '-' && chars[i + 1] === '-') {
				while (i < len && chars[i] !== '\n') { chars[i] = ' '; i++; }
				continue;
			}
			if (contexts.includes('string') && (chars[i] === '"' || chars[i] === "'")) {
				const q = chars[i]; chars[i] = ' '; i++;
				while (i < len && chars[i] !== q && chars[i] !== '\n') {
					if (chars[i] === '\\') { chars[i] = ' '; i++; }
					if (i < len) { chars[i] = ' '; i++; }
				}
				if (i < len) { chars[i] = ' '; i++; }
				continue;
			}
			if (contexts.includes('template-literal') && chars[i] === '`') {
				chars[i] = ' '; i++;
				while (i < len) {
					if (chars[i] === '\\') { chars[i] = ' '; i++; if (i < len) { chars[i] = ' '; i++; } continue; }
					if (chars[i] === '`') { chars[i] = ' '; i++; break; }
					if (chars[i] !== '\n') chars[i] = ' ';
					i++;
				}
				continue;
			}
			i++;
		}
		return chars.join('');
	}

	private _stripLine(line: string, contexts: ('comment' | 'string' | 'template-literal')[]): string {
		let result = line;
		if (contexts.includes('comment')) {
			result = result.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, ' ').replace(/#.*$/, '').replace(/--.*$/, '');
		}
		if (contexts.includes('string')) {
			result = result.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
		}
		if (contexts.includes('template-literal')) {
			result = result.replace(/`(?:[^`\\]|\\.)*`/g, '``');
		}
		return result;
	}
}
