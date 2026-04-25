/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Invariant Analyzer  (Universal Formal Verification)
 *
 * Evaluates `type: "invariant"` rules defined in `.inverse/invariants.json`.
 *
 * Three stacked analysis backends:
 *
 *   Layer 1 — Pattern backend   works on every language via regex
 *   Layer 2 — AST backend       deep TypeScript / JavaScript analysis
 *   Layer 3 — AI backend        async, any language, uses contractReasonService
 *
 * All eight scopes are supported:
 *   value, precondition, postcondition, class-invariant,
 *   resource-pair, state-machine, temporal, loop-invariant
 *
 * Legacy scope aliases (always \u2192 value, before-call \u2192 precondition,
 * after-call \u2192 postcondition) are handled by `normaliseScope`.
 */

import { ITextModel } from '../../../../../../editor/common/model.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IGRCRule, ICheckResult } from '../types/grcTypes.js';
import type { InvariantScope, ExpressionNode } from '../types/invariantTypes.js';
import {
	IInvariantDefinition,
	IParsedExpression,
	parseExpression,
	collectVariables,
	atomViolates,
	normaliseScope,
} from '../types/invariantTypes.js';
import { IRuleAnalyzer } from '../services/grcEngineService.js';
import { IContractReasonService } from '../services/contractReasonService.js';
import * as ts from './tsCompilerShim.js';

export class InvariantAnalyzer implements IRuleAnalyzer {
	readonly supportedTypes = ['invariant'];

	private _sourceFileCache = new Map<string, { version: number; sourceFile: ts.SourceFile }>();

	/** AI result cache: `${fileUri}:${invId}:${contentHash}` \u2192 results */
	private readonly _aiResultCache = new Map<string, ICheckResult[]>();
	/** Keys for which an AI query is already in-flight */
	private readonly _aiInFlight = new Set<string>();

	constructor(private readonly _contractReasonService: IContractReasonService) { }


	// ═══════════════════════════════════════════════════════════════════
	// Public interface
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Evaluate against an open ITextModel (called by GRC engine for open files).
	 * Runs the pattern backend for all languages and the AST backend for TS/JS.
	 */
	evaluate(rule: IGRCRule, model: ITextModel, fileUri: URI, timestamp: number): ICheckResult[] {
		const inv = rule.check as unknown as IInvariantDefinition;
		if (!inv || !this._hasRequiredFields(inv)) { return []; }

		const scope = normaliseScope(inv.scope);
		const content = model.getValue();
		const langId = model.getLanguageId();
		const aiKey = `${fileUri}:${inv.id}:${this._hash(content)}`;

		const results: ICheckResult[] = [];

		// Layer 1 — Pattern backend (all languages)
		if (inv.backend !== 'ast' && inv.backend !== 'ai') {
			results.push(...this._patternBackend(inv, scope, content, fileUri, langId, rule, timestamp));
		}

		// Layer 2 — AST backend (TS/JS only)
		if (inv.backend !== 'pattern' && inv.backend !== 'ai' && this._isTsJs(langId)) {
			const sf = this._getSourceFile(model);
			if (sf) {
				results.push(...this._astBackend(inv, scope, sf, fileUri, rule, timestamp));
			}
		}

		// Layer 3 — AI backend trigger (async; cached results from previous run included)
		const aiCached = this._aiResultCache.get(aiKey) ?? [];
		if (this._shouldUseAI(inv, langId)) {
			this._triggerAI(inv, scope, content, fileUri, langId, rule, aiKey, timestamp);
		}

		return this._dedup([...results, ...aiCached]);
	}

	/**
	 * Evaluate against raw file content (called during workspace scan).
	 * Runs all applicable backends.
	 */
	evaluateContent(rule: IGRCRule, content: string, fileUri: URI, languageId: string, timestamp: number): ICheckResult[] {
		const inv = rule.check as unknown as IInvariantDefinition;
		if (!inv || !this._hasRequiredFields(inv)) { return []; }

		const scope = normaliseScope(inv.scope);
		const aiKey = `${fileUri}:${inv.id}:${this._hash(content)}`;

		const results: ICheckResult[] = [];

		// Layer 1 — Pattern backend
		if (inv.backend !== 'ast' && inv.backend !== 'ai') {
			results.push(...this._patternBackend(inv, scope, content, fileUri, languageId, rule, timestamp));
		}

		// Layer 2 — AST backend (TS/JS only)
		if (inv.backend !== 'pattern' && inv.backend !== 'ai' && this._isTsJs(languageId)) {
			try {
				const sf = ts.createSourceFile(fileUri.path, content, ts.ScriptTarget.Latest, true);
				results.push(...this._astBackend(inv, scope, sf, fileUri, rule, timestamp));
			} catch { /* malformed source — skip AST */ }
		}

		// Layer 3 — AI backend trigger
		const aiCached = this._aiResultCache.get(aiKey) ?? [];
		if (this._shouldUseAI(inv, languageId)) {
			this._triggerAI(inv, scope, content, fileUri, languageId, rule, aiKey, timestamp);
		}

		return this._dedup([...results, ...aiCached]);
	}


	// ═══════════════════════════════════════════════════════════════════
	// Layer 1 — Pattern backend (universal, all languages)
	// ═══════════════════════════════════════════════════════════════════

	private _patternBackend(
		inv: IInvariantDefinition, scope: InvariantScope,
		content: string, fileUri: URI, languageId: string,
		rule: IGRCRule, timestamp: number
	): ICheckResult[] {
		const lines = content.split('\n');
		switch (scope) {
			case 'value':          return this._patternValue(inv, lines, fileUri, rule, timestamp);
			case 'precondition':   return this._patternPrecondition(inv, lines, fileUri, rule, timestamp);
			case 'postcondition':  return this._patternPostcondition(inv, lines, fileUri, rule, timestamp);
			case 'resource-pair':  return this._patternResourcePair(inv, lines, fileUri, rule, timestamp);
			case 'state-machine':  return this._patternStateMachine(inv, lines, fileUri, rule, timestamp);
			case 'temporal':       return this._patternTemporal(inv, lines, fileUri, rule, timestamp);
			case 'loop-invariant': return this._patternLoopInvariant(inv, lines, fileUri, rule, timestamp, languageId);
			case 'class-invariant': return []; // requires class structure — handled by AST / AI
			default: return [];
		}
	}

	// ── value scope ───────────────────────────────────────────────────

	private _patternValue(
		inv: IInvariantDefinition, lines: string[],
		fileUri: URI, rule: IGRCRule, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		const expr = parseExpression(inv.expression);
		if (!expr) { return results; }

		const atoms = this._collectAtoms(expr);

		for (const atom of atoms) {
			const rawVar = atom.variable;
			// Escape dots so 'this.balance' becomes 'this\.balance' in regex
			const escapedVar = rawVar.replace(/\./g, '\\.');
			// Also match C++ pointer syntax (this->balance) and Python self
			const varPatterns = [escapedVar];
			if (rawVar.startsWith('this.')) {
				const field = rawVar.slice(5).replace(/\./g, '\\.');
				varPatterns.push(`this\\s*->\\s*${field}`, `self\\.${field}`);
			}
			const varAlt = varPatterns.join('|');

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (this._isCommentLine(line)) { continue; }

				// ── Direct literal assignment: var = -5 or var := -5 ──
				const assignRe = new RegExp(`(?:${varAlt})\\s*:?=\\s*(-?\\d+\\.?\\d*)\\b`);
				const assignMatch = assignRe.exec(line);
				if (assignMatch) {
					const val = Number(assignMatch[1]);
					const violated = atomViolates(atom, val);
					if (violated === true) {
						results.push(this._makePatternResult(
							inv, rule, fileUri, i + 1, line, timestamp,
							`${rawVar} assigned to ${val} — violates ${inv.expression}`, 'high'
						));
					}
				}

				// ── Null assignment for != null invariants ──
				if (atom.operator === '!=' && this._isNullLike(String(atom.value))) {
					if (new RegExp(`(?:${varAlt})\\s*:?=\\s*(?:null|nullptr|NULL|None|nil|0)\\b`).test(line)) {
						results.push(this._makePatternResult(
							inv, rule, fileUri, i + 1, line, timestamp,
							`${rawVar} set to null — violates ${inv.expression}`, 'high'
						));
					}
				}

				// ── Subtraction / decrement for >= N (N >= 0) ──
				if (atom.operator === '>=' && typeof atom.value === 'number' && atom.value >= 0) {
					if (new RegExp(`(?:${varAlt})\\s*-=`).test(line)) {
						results.push(this._makePatternResult(
							inv, rule, fileUri, i + 1, line, timestamp,
							`${rawVar} -= ... — may violate ${inv.expression}`, 'medium'
						));
					}
					if (new RegExp(`(?:--|\\-\\-)\\s*(?:${varAlt})\\b|\\b(?:${varAlt})\\s*(?:--)`).test(line)) {
						results.push(this._makePatternResult(
							inv, rule, fileUri, i + 1, line, timestamp,
							`${rawVar}-- — may violate ${inv.expression}`, 'medium'
						));
					}
				}

				// ── Addition / increment for <= N ──
				if (atom.operator === '<=' && typeof atom.value === 'number') {
					if (new RegExp(`(?:${varAlt})\\s*\\+=`).test(line)) {
						results.push(this._makePatternResult(
							inv, rule, fileUri, i + 1, line, timestamp,
							`${rawVar} += ... — may violate ${inv.expression}`, 'medium'
						));
					}
					if (new RegExp(`(?:\\+\\+)\\s*(?:${varAlt})\\b|\\b(?:${varAlt})\\s*(?:\\+\\+)`).test(line)) {
						results.push(this._makePatternResult(
							inv, rule, fileUri, i + 1, line, timestamp,
							`${rawVar}++ — may violate ${inv.expression}`, 'medium'
						));
					}
				}
			}
		}

		return results;
	}

	// ── precondition scope ────────────────────────────────────────────

	private _patternPrecondition(
		inv: IInvariantDefinition, lines: string[],
		fileUri: URI, rule: IGRCRule, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		const targetCalls = inv.targetCalls ?? [];
		if (targetCalls.length === 0) { return results; }

		const guardVars = this._guardVarsFromExpression(inv.expression);

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentLine(line)) { continue; }

			for (const call of targetCalls) {
				const callRe = new RegExp(`\\b${this._esc(call)}\\s*\\(`);
				if (!callRe.test(line)) { continue; }

				// Look back up to 40 lines within the same scope
				const lookback = Math.max(0, i - 40);
				const scope = this._extractScope(lines, lookback, i);
				if (!this._guardPresentInLines(guardVars, scope)) {
					results.push(this._makePatternResult(
						inv, rule, fileUri, i + 1, line, timestamp,
						`Guard "${inv.expression}" not verified before ${call}()`, 'medium'
					));
				}
			}
		}

		return results;
	}

	// ── postcondition scope ───────────────────────────────────────────

	private _patternPostcondition(
		inv: IInvariantDefinition, lines: string[],
		fileUri: URI, rule: IGRCRule, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		const targetCalls = inv.targetCalls ?? [];
		if (targetCalls.length === 0) { return results; }

		const guardVars = this._guardVarsFromExpression(inv.expression);

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentLine(line)) { continue; }

			for (const call of targetCalls) {
				if (!new RegExp(`\\b${this._esc(call)}\\s*\\(`).test(line)) { continue; }

				// Look ahead up to 30 lines within the same scope
				const lookahead = Math.min(lines.length, i + 31);
				const scope = this._extractScope(lines, i + 1, lookahead);
				if (!this._guardPresentInLines(guardVars, scope)) {
					results.push(this._makePatternResult(
						inv, rule, fileUri, i + 1, line, timestamp,
						`Condition "${inv.expression}" not verified after ${call}()`, 'medium'
					));
				}
			}
		}

		return results;
	}

	// ── resource-pair scope ───────────────────────────────────────────

	private _patternResourcePair(
		inv: IInvariantDefinition, lines: string[],
		fileUri: URI, rule: IGRCRule, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		if (!inv.acquirePattern || !inv.releasePattern) { return results; }

		let acquireRe: RegExp, releaseRe: RegExp;
		try {
			acquireRe = new RegExp(inv.acquirePattern, 'i');
			releaseRe = new RegExp(inv.releasePattern, 'i');
		} catch { return results; }

		// Find all acquire / release line numbers
		const acquireLines: number[] = [];
		const releaseLines: number[] = [];

		for (let i = 0; i < lines.length; i++) {
			if (this._isCommentLine(lines[i])) { continue; }
			if (acquireRe.test(lines[i])) { acquireLines.push(i); }
			if (releaseRe.test(lines[i])) { releaseLines.push(i); }
		}

		// For each acquire, look for a matching release in the same brace-scope
		for (const acqLine of acquireLines) {
			const scopeEnd = this._findScopeEnd(lines, acqLine);
			const hasRelease = releaseLines.some(r => r > acqLine && r <= scopeEnd);
			if (!hasRelease) {
				results.push(this._makePatternResult(
					inv, rule, fileUri, acqLine + 1, lines[acqLine], timestamp,
					`Resource acquired here but no matching release found before scope end (line ${scopeEnd + 1})`, 'high'
				));
			}
		}

		return results;
	}

	// ── state-machine scope ───────────────────────────────────────────

	private _patternStateMachine(
		inv: IInvariantDefinition, lines: string[],
		fileUri: URI, rule: IGRCRule, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		if (!inv.stateVariable || !inv.validTransitions?.length) { return results; }

		const validTo = new Set(inv.validTransitions.map(t => t.to));
		const stateVar = inv.stateVariable.replace(/\./g, '\\.').replace(/\->/g, '\\s*->\\s*');
		const assignRe = new RegExp(`\\b${stateVar}\\s*:?=\\s*([\\w"'.]+)`, 'g');

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentLine(line)) { continue; }

			assignRe.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = assignRe.exec(line)) !== null) {
				// Strip surrounding quotes from the state value
				const rawState = m[1].replace(/^['"]|['"]$/g, '');
				if (!validTo.has(rawState)) {
					results.push(this._makePatternResult(
						inv, rule, fileUri, i + 1, line, timestamp,
						`State "${rawState}" is not a valid transition target in ${inv.stateVariable} state machine`, 'high'
					));
				}
			}
		}

		return results;
	}

	// ── temporal scope ────────────────────────────────────────────────

	private _patternTemporal(
		inv: IInvariantDefinition, lines: string[],
		fileUri: URI, rule: IGRCRule, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		const targetCalls = inv.targetCalls ?? [];
		const precedesCall = inv.precedesCall;
		if (!precedesCall || targetCalls.length === 0) { return results; }

		const precedesRe = new RegExp(`\\b${this._esc(precedesCall)}\\s*\\(`);

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentLine(line)) { continue; }

			for (const call of targetCalls) {
				if (!new RegExp(`\\b${this._esc(call)}\\s*\\(`).test(line)) { continue; }

				// Walk back to the start of the enclosing function/block
				const fnStart = this._findFunctionStart(lines, i);
				const priorLines = lines.slice(fnStart, i);
				const precCallFound = priorLines.some(l => !this._isCommentLine(l) && precedesRe.test(l));

				if (!precCallFound) {
					results.push(this._makePatternResult(
						inv, rule, fileUri, i + 1, line, timestamp,
						`${call}() called without prior ${precedesCall}() in this scope — violates temporal ordering`, 'high'
					));
				}
			}
		}

		return results;
	}

	// ── loop-invariant scope ──────────────────────────────────────────

	private _patternLoopInvariant(
		inv: IInvariantDefinition, lines: string[],
		fileUri: URI, rule: IGRCRule, timestamp: number, _languageId: string
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		const expr = parseExpression(inv.expression);
		if (!expr) { return results; }

		const atoms = this._collectAtoms(expr);

		// Loop start patterns (covers C/C++/Java/JS/TS/Go/Rust/Ada/Python)
		const loopStartRe = /\b(?:for|while|do|loop|LOOP)\b/;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentLine(line)) { continue; }
			if (!loopStartRe.test(line)) { continue; }

			// Find the loop body (from { or : to matching })
			const bodyEnd = this._findScopeEnd(lines, i);
			const bodyLines = lines.slice(i + 1, bodyEnd + 1);

			for (const atom of atoms) {
				const varName = atom.variable.replace(/\./g, '\\.');
				const varAlt = [varName];
				if (atom.variable.startsWith('this.')) {
					const f = atom.variable.slice(5).replace(/\./g, '\\.');
					varAlt.push(`this\\s*->\\s*${f}`, `self\\.${f}`);
				}
				const varPattern = varAlt.join('|');

				for (let j = 0; j < bodyLines.length; j++) {
					const bodyLine = bodyLines[j];
					if (this._isCommentLine(bodyLine)) { continue; }

					// Flag: tracked var -= (could violate >= N)
					if (atom.operator === '>=' && typeof atom.value === 'number' && atom.value >= 0) {
						if (new RegExp(`(?:${varPattern})\\s*-=|--\\s*(?:${varPattern})|(?:${varPattern})\\s*--`).test(bodyLine)) {
							results.push(this._makePatternResult(
								inv, rule, fileUri, i + j + 2, bodyLine, timestamp,
								`Loop modifies ${atom.variable} with subtraction/decrement — may violate loop invariant ${inv.expression}`, 'medium'
							));
						}
					}
					// Flag: tracked var += (could violate <= N)
					if (atom.operator === '<=' && typeof atom.value === 'number') {
						if (new RegExp(`(?:${varPattern})\\s*\\+=|\\+\\+\\s*(?:${varPattern})|(?:${varPattern})\\s*\\+\\+`).test(bodyLine)) {
							results.push(this._makePatternResult(
								inv, rule, fileUri, i + j + 2, bodyLine, timestamp,
								`Loop modifies ${atom.variable} with addition/increment — may violate loop invariant ${inv.expression}`, 'medium'
							));
						}
					}
				}
			}
		}

		// Deduplicate by line before returning
		const seen = new Set<number>();
		return results.filter(r => {
			if (seen.has(r.line)) { return false; }
			seen.add(r.line);
			return true;
		});
	}


	// ═══════════════════════════════════════════════════════════════════
	// Layer 2 — AST backend (TypeScript / JavaScript)
	// ═══════════════════════════════════════════════════════════════════

	private _astBackend(
		inv: IInvariantDefinition, scope: InvariantScope,
		sf: ts.SourceFile, fileUri: URI,
		rule: IGRCRule, timestamp: number
	): ICheckResult[] {
		switch (scope) {
			case 'value':          return this._astValue(inv, sf, fileUri, rule, timestamp);
			case 'precondition':   return this._astPrecondition(inv, sf, fileUri, rule, timestamp);
			case 'postcondition':  return this._astPostcondition(inv, sf, fileUri, rule, timestamp);
			case 'class-invariant': return this._astClassInvariant(inv, sf, fileUri, rule, timestamp);
			case 'loop-invariant': return this._astLoopInvariant(inv, sf, fileUri, rule, timestamp);
			default: return [];
		}
	}

	// ── value (AST) ──────────────────────────────────────────────────

	private _astValue(
		inv: IInvariantDefinition, sf: ts.SourceFile,
		fileUri: URI, rule: IGRCRule, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		const expr = parseExpression(inv.expression);
		if (!expr) { return results; }

		const atoms = this._collectAtoms(expr);

		for (const atom of atoms) {
			const trackedVars = new Set(inv.variables ?? [atom.variable]);
			const visit = (node: ts.Node): void => {
				// Variable declarations: let x = VALUE  or  let obj = { field: VALUE }
				if (ts.isVariableDeclaration(node)) {
					const varName = this._getNodeText(node.name);
					if (varName && trackedVars.has(varName) && node.initializer) {
						const v = this._checkAssignmentViolation(atom, node.initializer, sf, fileUri, rule, timestamp, inv, `${varName} initialized`);
						if (v) { results.push(v); }
					}
				}

				// Assignments: x = VALUE  or  this.x = VALUE  or  obj.x = VALUE
				if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
					const lhsText = this._getNodeText(node.left);
					if (lhsText && trackedVars.has(lhsText)) {
						const v = this._checkAssignmentViolation(atom, node.right, sf, fileUri, rule, timestamp, inv, `${lhsText} assigned`);
						if (v) { results.push(v); }
					}
				}

				// Compound assignments: x -= N  (for >= 0),  x += N  (for <= N)
				if (ts.isBinaryExpression(node) && this._isCompoundOp(node.operatorToken.kind)) {
					const lhsText = this._getNodeText(node.left);
					if (lhsText && trackedVars.has(lhsText)) {
						const v = this._checkCompoundOp(atom, node, sf, fileUri, rule, timestamp, inv);
						if (v) { results.push(v); }
					}
				}

				// Prefix / postfix unary: x--  --x  x++  ++x
				if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
					const unary = node as ts.PrefixUnaryExpression | ts.PostfixUnaryExpression;
					const operandText = this._getNodeText(unary.operand);
					if (operandText && trackedVars.has(operandText) && this._unaryCouldViolate(atom, unary.operator)) {
						const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
						const isDecrement = unary.operator === ts.SyntaxKind.MinusMinusToken;
						results.push(this._makeASTResult(
							rule, fileUri, line + 1, character + 1, node, sf, timestamp, inv,
							[{ line: line + 1, label: `${operandText}${isDecrement ? '--' : '++'} — may violate ${inv.expression}` }]
						));
					}
				}

				ts.forEachChild(node, visit);
			};
			ts.forEachChild(sf, visit);
		}

		return results;
	}

	// ── precondition (AST) ───────────────────────────────────────────

	private _astPrecondition(
		inv: IInvariantDefinition, sf: ts.SourceFile,
		fileUri: URI, rule: IGRCRule, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		const targetCalls = new Set(inv.targetCalls ?? []);
		if (targetCalls.size === 0) { return results; }

		const expr = parseExpression(inv.expression);
		if (!expr) { return results; }

		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node)) {
				const name = this._getCalleeName(node);
				if (name && targetCalls.has(name)) {
					if (!this._findGuardBefore(node, expr, sf)) {
						const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
						results.push(this._makeASTResult(
							rule, fileUri, line + 1, character + 1, node, sf, timestamp, inv,
							[
								{ line: line + 1, label: `Call to ${name}()` },
								{ line: line + 1, label: `Guard "${inv.expression}" not verified before call` }
							]
						));
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		ts.forEachChild(sf, visit);
		return results;
	}

	// ── postcondition (AST) ──────────────────────────────────────────

	private _astPostcondition(
		inv: IInvariantDefinition, sf: ts.SourceFile,
		fileUri: URI, rule: IGRCRule, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		const targetCalls = new Set(inv.targetCalls ?? []);
		if (targetCalls.size === 0) { return results; }

		const expr = parseExpression(inv.expression);
		if (!expr) { return results; }

		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node)) {
				const name = this._getCalleeName(node);
				if (name && targetCalls.has(name)) {
					if (!this._findCheckAfter(node, expr, sf)) {
						const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
						results.push(this._makeASTResult(
							rule, fileUri, line + 1, character + 1, node, sf, timestamp, inv,
							[
								{ line: line + 1, label: `Call to ${name}()` },
								{ line: line + 1, label: `Condition "${inv.expression}" not verified after call` }
							]
						));
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		ts.forEachChild(sf, visit);
		return results;
	}

	// ── class-invariant (AST) ────────────────────────────────────────

	private _astClassInvariant(
		inv: IInvariantDefinition, sf: ts.SourceFile,
		fileUri: URI, rule: IGRCRule, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		const expr = parseExpression(inv.expression);
		if (!expr) { return results; }

		const trackedClasses = inv.trackedClass
			? (Array.isArray(inv.trackedClass) ? new Set(inv.trackedClass) : new Set([inv.trackedClass]))
			: null; // null = all classes

		const atoms = this._collectAtoms(expr);

		const visitClass = (classDecl: ts.ClassDeclaration | ts.ClassExpression): void => {
			const className = classDecl.name?.text ?? '<anonymous>';
			if (trackedClasses && !trackedClasses.has(className)) { return; }

			for (const member of classDecl.members) {
				// Only check public methods (including implicit public)
				const isPrivate = member.modifiers?.some((m: ts.Modifier) =>
					m.kind === ts.SyntaxKind.PrivateKeyword ||
					m.kind === ts.SyntaxKind.ProtectedKeyword
				);
				if (isPrivate) { continue; }
				if (!ts.isMethodDeclaration(member)) { continue; }

				const methodName = (member as ts.FunctionLikeDeclaration).name ? this._getNodeText((member as ts.FunctionLikeDeclaration).name!) : '<method>';
				const body = member.body;
				if (!body) { continue; }

				// Within each public method, look for assignments that could violate the invariant
				for (const atom of atoms) {
					const trackedFields = new Set(inv.variables ?? [atom.variable]);

					const visitMethod = (node: ts.Node): void => {
						// this.field = VALUE
						if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
							const lhsText = this._getNodeText(node.left);
							if (lhsText && trackedFields.has(lhsText)) {
								const v = this._checkAssignmentViolation(atom, node.right, sf, fileUri, rule, timestamp, inv,
									`${lhsText} assigned in ${className}.${methodName}()`);
								if (v) { results.push(v); }
							}
						}
						// this.field -= N
						if (ts.isBinaryExpression(node) && this._isCompoundOp(node.operatorToken.kind)) {
							const lhsText = this._getNodeText(node.left);
							if (lhsText && trackedFields.has(lhsText)) {
								const v = this._checkCompoundOp(atom, node, sf, fileUri, rule, timestamp, inv);
								if (v) { results.push(v); }
							}
						}
						ts.forEachChild(node, visitMethod);
					};
					ts.forEachChild(body, visitMethod);
				}
			}
		};

		const visitTop = (node: ts.Node): void => {
			if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
				visitClass(node as ts.ClassDeclaration | ts.ClassExpression);
			}
			ts.forEachChild(node, visitTop);
		};
		ts.forEachChild(sf, visitTop);
		return results;
	}

	// ── loop-invariant (AST) ─────────────────────────────────────────

	private _astLoopInvariant(
		inv: IInvariantDefinition, sf: ts.SourceFile,
		fileUri: URI, rule: IGRCRule, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		const expr = parseExpression(inv.expression);
		if (!expr) { return results; }

		const atoms = this._collectAtoms(expr);

		const visitNode = (node: ts.Node): void => {
			const isLoop =
				ts.isForStatement(node) || ts.isForInStatement(node) ||
				ts.isForOfStatement(node) || ts.isWhileStatement(node) ||
				ts.isDoStatement(node);

			if (isLoop) {
				const body = (node as ts.ForStatement).statement ?? (node as ts.WhileStatement).statement ?? (node as ts.DoStatement).statement;
				if (body) {
					for (const atom of atoms) {
						const trackedVars = new Set(inv.variables ?? [atom.variable]);
						const visitBody = (inner: ts.Node): void => {
							if (ts.isBinaryExpression(inner) && this._isCompoundOp(inner.operatorToken.kind)) {
								const lhsText = this._getNodeText(inner.left);
								if (lhsText && trackedVars.has(lhsText)) {
									const v = this._checkCompoundOp(atom, inner, sf, fileUri, rule, timestamp, inv);
									if (v) { results.push(v); }
								}
							}
							if (ts.isPrefixUnaryExpression(inner) || ts.isPostfixUnaryExpression(inner)) {
								const unary = inner as ts.PrefixUnaryExpression | ts.PostfixUnaryExpression;
								const operandText = this._getNodeText(unary.operand);
								if (operandText && trackedVars.has(operandText) && this._unaryCouldViolate(atom, unary.operator)) {
									const { line, character } = sf.getLineAndCharacterOfPosition(inner.getStart(sf));
									results.push(this._makeASTResult(
										rule, fileUri, line + 1, character + 1, inner, sf, timestamp, inv,
										[{ line: line + 1, label: `Loop modifies ${operandText} — may violate loop invariant ${inv.expression}` }]
									));
								}
							}
							ts.forEachChild(inner, visitBody);
						};
						ts.forEachChild(body, visitBody);
					}
				}
			}

			ts.forEachChild(node, visitNode);
		};
		ts.forEachChild(sf, visitNode);
		return results;
	}


	// ═══════════════════════════════════════════════════════════════════
	// Layer 3 — AI backend (async, any language)
	// ═══════════════════════════════════════════════════════════════════

	private _shouldUseAI(inv: IInvariantDefinition, languageId: string): boolean {
		if (!this._contractReasonService.isAvailable) { return false; }
		if (inv.backend === 'ai') { return true; }
		if (inv.backend === 'pattern' || inv.backend === 'ast') { return false; }
		// Auto: use AI for non-TS/JS languages or for complex scopes
		const complexScope = inv.scope === 'class-invariant' || inv.scope === 'resource-pair' || inv.scope === 'temporal';
		return !this._isTsJs(languageId) || complexScope;
	}

	private _triggerAI(
		inv: IInvariantDefinition, scope: InvariantScope,
		content: string, fileUri: URI, languageId: string,
		rule: IGRCRule, aiKey: string, timestamp: number
	): void {
		if (this._aiInFlight.has(aiKey)) { return; }
		if (this._aiResultCache.has(aiKey)) { return; }

		this._aiInFlight.add(aiKey);

		// Cap content at 4000 chars — send the most relevant section
		const snippet = content.length > 4000 ? content.slice(0, 4000) + '\n...(truncated)' : content;
		const prompt = this._buildAIPrompt(inv, scope, snippet, languageId, fileUri.path.split('/').pop() ?? fileUri.path);

		this._contractReasonService.sendOneShotQuery(prompt).then((response) => {
			this._aiInFlight.delete(aiKey);
			if (!response) { return; }

			const aiResults = this._parseAIResponse(response, inv, rule, fileUri, content.split('\n'), timestamp);
			if (aiResults.length > 0) {
				this._aiResultCache.set(aiKey, aiResults);
			}

			// Evict oldest AI cache entries beyond 50
			if (this._aiResultCache.size > 50) {
				const firstKey = this._aiResultCache.keys().next().value;
				if (firstKey) { this._aiResultCache.delete(firstKey); }
			}
		}).catch(() => {
			this._aiInFlight.delete(aiKey);
		});
	}

	private _buildAIPrompt(
		inv: IInvariantDefinition, scope: InvariantScope,
		snippet: string, languageId: string, fileName: string
	): string {
		const scopeDesc: Record<string, string> = {
			value: `The invariant "${inv.expression}" must hold at every assignment point.`,
			precondition: `"${inv.expression}" must hold BEFORE every call to: ${(inv.targetCalls ?? []).join(', ')}.`,
			postcondition: `"${inv.expression}" must hold AFTER every call to: ${(inv.targetCalls ?? []).join(', ')}.`,
			'class-invariant': `"${inv.expression}" must hold after every public method of class ${inv.trackedClass ?? '(any)'}.`,
			'resource-pair': `Every acquire (${inv.acquirePattern}) must have a matching release (${inv.releasePattern}) before the scope ends.`,
			'state-machine': `Only transitions in [${(inv.validTransitions ?? []).map(t => `${t.from}\u2192${t.to}`).join(', ')}] are valid for ${inv.stateVariable}.`,
			temporal: `${inv.precedesCall}() must be called BEFORE any of: ${(inv.targetCalls ?? []).join(', ')}.`,
			'loop-invariant': `"${inv.expression}" must hold at every loop iteration entry.`,
		};

		return [
			`Formal invariant check. Invariant: "${inv.name}"`,
			`Scope: ${scope}. Rule: ${scopeDesc[scope] ?? inv.expression}`,
			`File: ${fileName} (${languageId})`,
			'---',
			snippet,
			'---',
			'List ONLY definite violations in EXACTLY this format:',
			'VIOLATION: line N: <one-sentence description>',
			'If there are no violations, respond with a single word: NONE',
		].join('\n');
	}

	private _parseAIResponse(
		response: string, inv: IInvariantDefinition,
		rule: IGRCRule, fileUri: URI, lines: string[], timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		if (response.trim().toUpperCase() === 'NONE') { return results; }

		const re = /VIOLATION:\s*line\s*(\d+):\s*(.+)/gi;
		let m: RegExpExecArray | null;
		while ((m = re.exec(response)) !== null) {
			const lineNum = Math.max(1, Math.min(parseInt(m[1], 10), lines.length));
			const msg = m[2].trim();
			const codeLine = lines[lineNum - 1] ?? '';

			results.push({
				ruleId: rule.id,
				domain: rule.domain,
				severity: rule.severity,
				message: `[AI] Invariant "${inv.name}": ${msg}`,
				fileUri,
				line: lineNum,
				column: 1,
				endLine: lineNum,
				endColumn: codeLine.length + 1,
				codeSnippet: codeLine.trim().slice(0, 200),
				fix: `Ensure ${inv.expression} holds at this point`,
				timestamp,
				traceInfo: [{ line: lineNum, label: msg }],
				aiConfidence: 'high',
				checkSource: 'ai',
			});
		}

		return results;
	}


	// ═══════════════════════════════════════════════════════════════════
	// AST assignment-violation helpers
	// ═══════════════════════════════════════════════════════════════════

	private _checkAssignmentViolation(
		atom: IParsedExpression, rhs: ts.Node,
		sf: ts.SourceFile, fileUri: URI,
		rule: IGRCRule, timestamp: number, inv: IInvariantDefinition, action: string
	): ICheckResult | undefined {
		const literalValue = this._evaluateLiteral(rhs);
		if (literalValue !== undefined) {
			if (atomViolates(atom, literalValue) === true) {
				const { line, character } = sf.getLineAndCharacterOfPosition(rhs.getStart(sf));
				return this._makeASTResult(rule, fileUri, line + 1, character + 1, rhs, sf, timestamp, inv,
					[{ line: line + 1, label: `${action} to ${literalValue} — violates ${inv.expression}` }]);
			}
			return undefined;
		}

		// Subtraction expression for >= 0 invariants
		if (ts.isBinaryExpression(rhs) && rhs.operatorToken.kind === ts.SyntaxKind.MinusToken) {
			if (atom.operator === '>=' && atom.value === 0) {
				const { line, character } = sf.getLineAndCharacterOfPosition(rhs.getStart(sf));
				return this._makeASTResult(rule, fileUri, line + 1, character + 1, rhs, sf, timestamp, inv,
					[{ line: line + 1, label: `${action} via subtraction — may violate ${inv.expression}` }], 'medium');
			}
		}

		return undefined;
	}

	private _checkCompoundOp(
		atom: IParsedExpression, node: ts.BinaryExpression,
		sf: ts.SourceFile, fileUri: URI,
		rule: IGRCRule, timestamp: number, inv: IInvariantDefinition
	): ICheckResult | undefined {
		const opKind = node.operatorToken.kind;
		const varName = this._getNodeText(node.left) ?? '?';

		if (atom.operator === '>=' && atom.value === 0 && opKind === ts.SyntaxKind.MinusEqualsToken) {
			const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
			return this._makeASTResult(rule, fileUri, line + 1, character + 1, node, sf, timestamp, inv,
				[{ line: line + 1, label: `${varName} -= ... — may violate ${inv.expression}` }], 'medium');
		}

		if (atom.operator === '<=' && typeof atom.value === 'number' && opKind === ts.SyntaxKind.PlusEqualsToken) {
			const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
			return this._makeASTResult(rule, fileUri, line + 1, character + 1, node, sf, timestamp, inv,
				[{ line: line + 1, label: `${varName} += ... — may violate ${inv.expression}` }], 'medium');
		}

		return undefined;
	}


	// ═══════════════════════════════════════════════════════════════════
	// AST guard / check finding (improved: walks full scope chain)
	// ═══════════════════════════════════════════════════════════════════

	private _findGuardBefore(callNode: ts.Node, expr: ExpressionNode, sf: ts.SourceFile): boolean {
		const callStart = callNode.getStart(sf);
		const guardVarNames = collectVariables(expr);

		// Walk up through all enclosing blocks, not just the immediate one
		let current: ts.Node | undefined = callNode.parent;
		while (current) {
			if (ts.isBlock(current) || ts.isSourceFile(current) ||
				ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) ||
				ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {

				let found = false;
				const scan = (node: ts.Node): void => {
					if (found || node.getEnd() > callStart) { return; }

					// if (guardVar) or if (!guardVar) or if (guardVar == X)
					if (ts.isIfStatement(node)) {
						const exprText = node.expression.getText(sf);
						if (guardVarNames.some(v => exprText.includes(v))) { found = true; return; }
					}

					// throw / return before call acts as a guard
					if (ts.isThrowStatement(node) || ts.isReturnStatement(node)) {
						// Only if it's inside an if that checks the guard
						const parent = node.parent;
						if (ts.isBlock(parent) && ts.isIfStatement(parent.parent)) {
							const condText = (parent.parent as ts.IfStatement).expression.getText(sf);
							if (guardVarNames.some(v => condText.includes(v))) { found = true; return; }
						}
					}

					// Direct guard assignment: guardVar = true
					if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)) {
						const lhs = this._getNodeText(node.expression.left);
						if (lhs && guardVarNames.includes(lhs) &&
							node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
							const val = this._evaluateLiteral(node.expression.right);
							if (val === true) { found = true; return; }
						}
					}

					ts.forEachChild(node, scan);
				};
				ts.forEachChild(current, scan);
				if (found) { return true; }

				// Stop at function boundary
				if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) ||
					ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
					break;
				}
			}
			current = (current as ts.Node).parent;
		}

		return false;
	}

	private _findCheckAfter(callNode: ts.Node, expr: ExpressionNode, sf: ts.SourceFile): boolean {
		const callEnd = callNode.getEnd();
		const guardVarNames = collectVariables(expr);

		const parent = this._findContainingBlock(callNode);
		if (!parent) { return false; }

		let found = false;
		const scan = (node: ts.Node): void => {
			if (found || node.getStart(sf) <= callEnd) { return; }
			if (ts.isIfStatement(node)) {
				const exprText = node.expression.getText(sf);
				if (guardVarNames.some(v => exprText.includes(v))) { found = true; }
			}
			ts.forEachChild(node, scan);
		};
		ts.forEachChild(parent, scan);
		return found;
	}


	// ═══════════════════════════════════════════════════════════════════
	// Pattern backend helpers
	// ═══════════════════════════════════════════════════════════════════

	/** Extract guard variable names from an expression string */
	private _guardVarsFromExpression(expression: string): string[] {
		const expr = parseExpression(expression);
		if (!expr) { return []; }
		return [...new Set(collectVariables(expr))];
	}

	/** Check that at least one guard variable appears in an if/assert/check context */
	private _guardPresentInLines(guardVars: string[], scopeLines: string[]): boolean {
		for (const line of scopeLines) {
			if (this._isCommentLine(line)) { continue; }
			// Check for guard var inside if/assert/check/require/validate
			for (const gv of guardVars) {
				const gvEsc = this._esc(gv).replace(/\\\./g, '(?:\\.|->|::)');
				if (new RegExp(`\\b(?:if|assert|check|require|validate|ensure|ASSERT|CHECK)\\b.*\\b${gvEsc}\\b`).test(line)) {
					return true;
				}
				// Early return / throw guard: `if (!gv) return;` or `if (!gv) throw ...`
				if (new RegExp(`\\bif\\s*\\([^)]*\\b${gvEsc}\\b`).test(line)) {
					return true;
				}
			}
		}
		return false;
	}

	/** Lines from start to end (exclusive), stopping at a closing function boundary */
	private _extractScope(lines: string[], start: number, end: number): string[] {
		const result: string[] = [];
		let depth = 0;
		for (let i = start; i < end && i < lines.length; i++) {
			const l = lines[i];
			depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
			result.push(l);
			if (depth < 0) { break; } // left the enclosing scope
		}
		return result;
	}

	/** Find the end of the brace-scope that starts at or after `startLine`. */
	private _findScopeEnd(lines: string[], startLine: number): number {
		let depth = 0;
		let inScope = false;
		for (let i = startLine; i < lines.length; i++) {
			const l = lines[i];
			const open = (l.match(/\{/g) ?? []).length;
			const close = (l.match(/\}/g) ?? []).length;
			if (!inScope && open > 0) { inScope = true; }
			depth += open - close;
			if (inScope && depth <= 0) { return i; }
		}
		return lines.length - 1;
	}

	/** Walk backward to find the start of the enclosing function/method */
	private _findFunctionStart(lines: string[], fromLine: number): number {
		// Look for function/def/fn keyword above current line
		const fnRe = /\b(?:function|def|fn|func|sub|procedure|PROCEDURE|method)\b/i;
		for (let i = fromLine - 1; i >= 0; i--) {
			if (fnRe.test(lines[i])) { return i; }
		}
		return 0;
	}

	private _isCommentLine(line: string): boolean {
		const t = line.trim();
		return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') ||
			t.startsWith('#') || t.startsWith('--') || t.startsWith('!') || t === '';
	}

	private _isNullLike(val: string): boolean {
		return ['null', 'nullptr', 'NULL', 'None', 'nil', 'undefined'].includes(val);
	}

	private _isTsJs(languageId: string): boolean {
		return languageId === 'typescript' || languageId === 'javascript' ||
			languageId === 'typescriptreact' || languageId === 'javascriptreact';
	}

	/** Escape a string for use inside a RegExp */
	private _esc(s: string): string {
		return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	/** Collect all atom nodes from an expression tree */
	private _collectAtoms(node: ExpressionNode): IParsedExpression[] {
		if (node.type === 'atom') { return [node]; }
		return [...this._collectAtoms(node.left), ...this._collectAtoms(node.right)];
	}

	/** True if the invariant has the minimum fields required for its scope */
	private _hasRequiredFields(inv: IInvariantDefinition): boolean {
		const scope = normaliseScope(inv.scope);
		if (scope === 'resource-pair') { return !!(inv.acquirePattern && inv.releasePattern); }
		if (scope === 'state-machine') { return !!(inv.stateVariable && inv.validTransitions?.length); }
		return !!inv.expression;
	}

	/** Simple djb2-style content hash for cache keys */
	private _hash(s: string): string {
		let h = 5381;
		const len = Math.min(s.length, 50_000);
		for (let i = 0; i < len; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
		return (h >>> 0).toString(16);
	}

	/** Deduplicate by ruleId + line + column */
	private _dedup(results: ICheckResult[]): ICheckResult[] {
		const seen = new Set<string>();
		return results.filter(r => {
			const k = `${r.ruleId}:${r.line}:${r.column}`;
			if (seen.has(k)) { return false; }
			seen.add(k);
			return true;
		});
	}


	// ═══════════════════════════════════════════════════════════════════
	// Shared AST utilities
	// ═══════════════════════════════════════════════════════════════════

	private _getSourceFile(model: ITextModel): ts.SourceFile | undefined {
		const key = model.uri.toString();
		const version = model.getVersionId();
		const cached = this._sourceFileCache.get(key);
		if (cached && cached.version === version) { return cached.sourceFile; }

		try {
			const sf = ts.createSourceFile(model.uri.path, model.getValue(), ts.ScriptTarget.Latest, true);
			this._sourceFileCache.set(key, { version, sourceFile: sf });
			if (this._sourceFileCache.size > 20) {
				const firstKey = this._sourceFileCache.keys().next().value;
				if (firstKey) { this._sourceFileCache.delete(firstKey); }
			}
			return sf;
		} catch { return undefined; }
	}

	/** Get the text of a TS AST node — handles identifiers and property access expressions */
	private _getNodeText(node: ts.Node): string | undefined {
		if (ts.isIdentifier(node)) { return node.text; }
		if (ts.isPropertyAccessExpression(node)) { return node.getText(); }
		return undefined;
	}

	private _getCalleeName(node: ts.CallExpression): string | undefined {
		if (ts.isIdentifier(node.expression)) { return node.expression.text; }
		if (ts.isPropertyAccessExpression(node.expression)) { return node.expression.name.text; }
		return undefined;
	}

	private _evaluateLiteral(node: ts.Node): number | string | boolean | null | undefined {
		if (ts.isNumericLiteral(node)) { return Number(node.text); }
		if (ts.isStringLiteral(node)) { return node.text; }
		if (node.kind === ts.SyntaxKind.TrueKeyword) { return true; }
		if (node.kind === ts.SyntaxKind.FalseKeyword) { return false; }
		if (node.kind === ts.SyntaxKind.NullKeyword) { return null; }
		if (node.kind === ts.SyntaxKind.UndefinedKeyword) { return undefined; }
		if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
			return -Number(node.operand.text);
		}
		return undefined;
	}

	private _isCompoundOp(kind: ts.SyntaxKind): boolean {
		return kind === ts.SyntaxKind.PlusEqualsToken || kind === ts.SyntaxKind.MinusEqualsToken ||
			kind === ts.SyntaxKind.AsteriskEqualsToken || kind === ts.SyntaxKind.SlashEqualsToken;
	}

	private _unaryCouldViolate(atom: IParsedExpression, operator: ts.SyntaxKind): boolean {
		if (atom.operator === '>=' && atom.value === 0 && operator === ts.SyntaxKind.MinusMinusToken) { return true; }
		if (atom.operator === '<=' && typeof atom.value === 'number' && operator === ts.SyntaxKind.PlusPlusToken) { return true; }
		return false;
	}

	private _findContainingBlock(node: ts.Node): ts.Node | undefined {
		let current: ts.Node | undefined = node.parent;
		while (current) {
			if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isFunctionDeclaration(current) ||
				ts.isMethodDeclaration(current) || ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
				return current;
			}
			current = (current as ts.Node).parent;
		}
		return undefined;
	}

	private _makeASTResult(
		rule: IGRCRule, fileUri: URI, line: number, column: number,
		node: ts.Node, sf: ts.SourceFile,
		timestamp: number, inv: IInvariantDefinition,
		traceInfo: Array<{ line: number; column?: number; label: string }>,
		confidence: 'high' | 'medium' | 'low' = 'high'
	): ICheckResult {
		const endPos = sf.getLineAndCharacterOfPosition(node.getEnd());
		const snippet = node.getText(sf);
		return {
			ruleId: rule.id,
			domain: rule.domain,
			severity: rule.severity,
			message: `Invariant "${inv.name}" (${inv.expression}) may be violated`,
			fileUri,
			line,
			column,
			endLine: endPos.line + 1,
			endColumn: endPos.character + 1,
			codeSnippet: snippet.length > 200 ? snippet.slice(0, 200) + '...' : snippet,
			fix: `Ensure ${inv.expression} holds at this point`,
			timestamp,
			traceInfo,
			aiConfidence: confidence,
			checkSource: 'static',
		};
	}

	private _makePatternResult(
		inv: IInvariantDefinition, rule: IGRCRule,
		fileUri: URI, line: number, codeLine: string,
		timestamp: number, message: string,
		confidence: 'high' | 'medium' | 'low'
	): ICheckResult {
		const col = codeLine.search(/\S/) + 1;
		return {
			ruleId: rule.id,
			domain: rule.domain,
			severity: rule.severity,
			message: `Invariant "${inv.name}": ${message}`,
			fileUri,
			line,
			column: col > 0 ? col : 1,
			endLine: line,
			endColumn: codeLine.length + 1,
			codeSnippet: codeLine.trim().slice(0, 200),
			fix: `Ensure ${inv.expression} holds at this point`,
			timestamp,
			traceInfo: [{ line, label: message }],
			aiConfidence: confidence,
			checkSource: 'static',
		};
	}
}
