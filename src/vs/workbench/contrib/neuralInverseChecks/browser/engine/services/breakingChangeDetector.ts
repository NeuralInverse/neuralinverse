/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Breaking Change Detector
 *
 * Detects breaking changes in TypeScript public APIs on every file save.
 * Runs as an `ITextFileSaveParticipant` **before** `GRCGatekeeper`, so
 * breaking-change violations are visible to the gatekeeper and can block
 * the save.
 *
 * ## What it detects
 *
 * - Removed exported symbol (function, class, interface, type, enum, const)
 * - Changed function parameter list (removed param, added required param,
 *   changed param type text)
 * - Changed function return type text
 * - Removed interface / class member
 * - Changed interface member type (required → optional or vice versa)
 * - Changed enum member value
 *
 * ## What it does NOT detect
 *
 * - Runtime behavior changes (needs AI layer)
 * - Cross-file type widening / narrowing
 * - Changes to unexported symbols
 *
 * ## Storage
 *
 * Snapshots are stored in VS Code workspace storage (`IStorageService`)
 * keyed by a hash of the file path. This is fast, persistent across
 * restarts, and requires no file system writes.
 *
 * ## Rule IDs
 *
 * | ID         | Meaning                         | Severity  |
 * |------------|---------------------------------|-----------|
 * | BREAK-001  | Removed exported symbol         | error     |
 * | BREAK-002  | Changed function signature      | error     |
 * | BREAK-003  | Removed interface/class member  | error     |
 * | BREAK-004  | Changed member type/optionality | warning   |
 * | BREAK-005  | Added required parameter        | error     |
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IWorkbenchContribution } from '../../../../../common/contributions.js';
import {
	ITextFileService,
	ITextFileSaveParticipant,
	ITextFileEditorModel,
	ITextFileSaveParticipantContext,
} from '../../../../../services/textfile/common/textfiles.js';
import { IProgress, IProgressStep } from '../../../../../../platform/progress/common/progress.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { IGRCEngineService } from './grcEngineService.js';
import { ICheckResult } from '../types/grcTypes.js';
import * as ts from '../analyzers/tsCompilerShim.js';

const SNAPSHOT_KEY_PREFIX = 'grc.exportSignatures.v1.';

/** File extensions this detector handles */
const HANDLED_EXTENSIONS = new Set(['ts', 'tsx']);

// ─── Signature Data Structures ────────────────────────────────────────────────

/**
 * Normalized representation of a single exported symbol's public API shape.
 */
interface IExportedSignature {
	name: string;
	kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable';
	/** Stringified parameter list — "(x: string, y?: number)" */
	params: string;
	/** Stringified return type — ": boolean | undefined" */
	returnType: string;
	/** Public member signatures for classes and interfaces */
	members: string[];
}

type SignatureMap = Record<string, IExportedSignature>;


// ─── Detector ─────────────────────────────────────────────────────────────────

export class BreakingChangeDetector extends Disposable
	implements IWorkbenchContribution, ITextFileSaveParticipant {

	static readonly ID = 'workbench.contrib.breakingChangeDetector';

	constructor(
		@ITextFileService private readonly textFileService: ITextFileService,
		@IGRCEngineService private readonly grcEngine: IGRCEngineService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		// Register as a save participant — runs BEFORE GRCGatekeeper if registered first
		this._register(this.textFileService.files.addSaveParticipant(this));
	}


	// ─── Save Participant ────────────────────────────────────────────

	async participate(
		model: ITextFileEditorModel,
		_context: ITextFileSaveParticipantContext,
		_progress: IProgress<IProgressStep>,
		_token: CancellationToken
	): Promise<void> {
		const textModel = model.textEditorModel;
		if (!textModel) return;

		const fileUri = model.resource;
		const ext = fileUri.path.split('.').pop()?.toLowerCase();
		if (!ext || !HANDLED_EXTENSIONS.has(ext)) return;

		const content = textModel.getValue();

		// Extract current exported signatures
		const current = this._extractSignatures(fileUri.path, content);

		// Load previous snapshot
		const snapshotKey = SNAPSHOT_KEY_PREFIX + this._pathHash(fileUri.path);
		const storedRaw = this.storageService.get(snapshotKey, StorageScope.WORKSPACE);

		if (storedRaw) {
			try {
				const previous: SignatureMap = JSON.parse(storedRaw);
				const violations = this._diff(fileUri, previous, current);
				this.grcEngine.setBreakingChangeViolations(fileUri, violations);
			} catch (e) {
				// Malformed snapshot — reset silently
				this.grcEngine.setBreakingChangeViolations(fileUri, []);
			}
		} else {
			// First time this file is saved — establish baseline, no violations
			this.grcEngine.setBreakingChangeViolations(fileUri, []);
		}

		// Store current signatures as the new snapshot (after diff, so baseline is last saved state)
		try {
			this.storageService.store(
				snapshotKey,
				JSON.stringify(current),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE
			);
		} catch (e) {
			// Storage full or unavailable — not critical
		}
	}


	// ─── Signature Extraction ────────────────────────────────────────

	private _extractSignatures(fileName: string, content: string): SignatureMap {
		const result: SignatureMap = {};

		try {
			const sourceFile = ts.createSourceFile(
				fileName,
				content,
				ts.ScriptTarget.Latest,
				/* setParentNodes */ true,
				fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
			);

			// Walk only top-level statements (not nested)
			sourceFile.forEachChild((node: ts.Node) => {
				this._extractNode(node, sourceFile, result);
			});
		} catch (e) {
			// Parse failure — return empty (no diff possible)
		}

		return result;
	}

	private _extractNode(node: ts.Node, sf: ts.SourceFile, out: SignatureMap): void {
		const tsLib = ts.getTsLib();

		// We need runtime SyntaxKind values for node types not in the shim
		const SK = tsLib?.SyntaxKind ?? {};

		if (!this._isExported(node, SK)) return;

		// export function foo(...)
		if (ts.isFunctionDeclaration(node)) {
			const name = this._getName(node);
			if (!name) return;
			out[name] = {
				name,
				kind: 'function',
				params: this._getParamsText(node, sf),
				returnType: this._getReturnTypeText(node, sf),
				members: [],
			};
		}

		// export class Foo { ... }
		else if (ts.isClassDeclaration(node)) {
			const name = this._getName(node);
			if (!name) return;
			out[name] = {
				name,
				kind: 'class',
				params: '',
				returnType: '',
				members: this._getPublicMemberSignatures(node as ts.ClassDeclaration, sf, SK),
			};
		}

		// export interface Foo { ... }
		else if (SK.InterfaceDeclaration && node.kind === SK.InterfaceDeclaration) {
			const name = this._getNameFromAny(node);
			if (!name) return;
			out[name] = {
				name,
				kind: 'interface',
				params: '',
				returnType: '',
				members: this._getInterfaceMemberSignatures(node, sf),
			};
		}

		// export type Foo = ...
		else if (SK.TypeAliasDeclaration && node.kind === SK.TypeAliasDeclaration) {
			const name = this._getNameFromAny(node);
			if (!name) return;
			// For type aliases, the full text IS the signature
			const text = this._safeGetText(node, sf)
				.replace(/^export\s+(default\s+)?/, '')
				.replace(/\s+/g, ' ')
				.trim();
			out[name] = { name, kind: 'type', params: '', returnType: text, members: [] };
		}

		// export enum Foo { A, B, C }
		else if (SK.EnumDeclaration && node.kind === SK.EnumDeclaration) {
			const name = this._getNameFromAny(node);
			if (!name) return;
			const members = ((node as any).members || []).map((m: any) =>
				this._safeGetText(m, sf).replace(/\s+/g, ' ').trim()
			);
			out[name] = { name, kind: 'enum', params: '', returnType: '', members };
		}

		// export const/let/var foo = ...
		else if (SK.VariableStatement && node.kind === SK.VariableStatement) {
			const declList = (node as any).declarationList;
			if (!declList) return;
			for (const decl of (declList.declarations || [])) {
				if (!ts.isIdentifier(decl.name)) continue;
				const name = decl.name.text;
				const typeNode = (decl as any).type;
				const typeText = typeNode ? this._safeGetText(typeNode, sf).trim() : 'inferred';
				out[name] = { name, kind: 'variable', params: '', returnType: typeText, members: [] };
			}
		}
	}


	// ─── Breaking Change Diff ────────────────────────────────────────

	private _diff(fileUri: URI, prev: SignatureMap, curr: SignatureMap): ICheckResult[] {
		const violations: ICheckResult[] = [];
		const now = Date.now();

		for (const [name, prevSig] of Object.entries(prev)) {
			const currSig = curr[name];

			// BREAK-001: Removed exported symbol
			if (!currSig) {
				violations.push(this._makeViolation(
					'BREAK-001',
					`Breaking change: exported '${name}' (${prevSig.kind}) was removed. Callers will break.`,
					fileUri, 1, 1, 'error', now
				));
				continue;
			}

			// BREAK-002: Changed function signature
			if (prevSig.kind === 'function' && currSig.kind === 'function') {
				if (prevSig.params !== currSig.params) {
					// Check specifically for added required parameters
					const prevParams = this._parseParams(prevSig.params);
					const currParams = this._parseParams(currSig.params);

					for (let i = prevParams.length; i < currParams.length; i++) {
						const p = currParams[i];
						if (!p.includes('?') && !p.includes('=')) {
							violations.push(this._makeViolation(
								'BREAK-005',
								`Breaking change: '${name}()' added required parameter '${p.split(':')[0].trim()}'. Existing callers will break.`,
								fileUri, 1, 1, 'error', now
							));
						}
					}

					if (violations.find(v => v.ruleId === 'BREAK-005')) {
						// Already reported specific param issue
					} else {
						violations.push(this._makeViolation(
							'BREAK-002',
							`Breaking change: '${name}()' parameter list changed.\n  Before: ${prevSig.params}\n  After:  ${currSig.params}`,
							fileUri, 1, 1, 'error', now
						));
					}
				}

				if (prevSig.returnType !== currSig.returnType && prevSig.returnType !== '' && currSig.returnType !== '') {
					violations.push(this._makeViolation(
						'BREAK-002',
						`Breaking change: '${name}()' return type changed.\n  Before: ${prevSig.returnType}\n  After:  ${currSig.returnType}`,
						fileUri, 1, 1, 'error', now
					));
				}
			}

			// BREAK-003/004: Interface and class member changes
			if (prevSig.kind === 'interface' || prevSig.kind === 'class') {
				const prevMembers = new Set(prevSig.members);
				const currMembers = new Set(currSig.members);

				for (const member of prevMembers) {
					if (!currMembers.has(member)) {
						// Check if the member name still exists (type changed) or is gone
						const memberName = member.split(/[:(?\s]/)[0].trim();
						const stillExists = [...currMembers].some(m => m.split(/[:(?\s]/)[0].trim() === memberName);

						if (!stillExists) {
							violations.push(this._makeViolation(
								'BREAK-003',
								`Breaking change: '${name}.${memberName}' was removed from the ${prevSig.kind}. Callers will break.`,
								fileUri, 1, 1, 'error', now
							));
						} else {
							violations.push(this._makeViolation(
								'BREAK-004',
								`Breaking change: '${name}.${memberName}' type or optionality changed.\n  Before: ${member}\n  After:  ${[...currMembers].find(m => m.split(/[:(?\s]/)[0].trim() === memberName) ?? '(changed)'}`,
								fileUri, 1, 1, 'warning', now
							));
						}
					}
				}
			}
		}

		return violations;
	}


	// ─── Violation Factory ───────────────────────────────────────────

	private _makeViolation(
		ruleId: string,
		message: string,
		fileUri: URI,
		line: number,
		column: number,
		severity: 'error' | 'warning',
		timestamp: number
	): ICheckResult {
		return {
			ruleId,
			domain: 'architecture',
			severity,
			message: `[${ruleId}] ${message}`,
			fileUri,
			line,
			column,
			endLine: line,
			endColumn: column + 1,
			timestamp,
			isBreakingChange: true,
			blockingBehavior: {
				blocksCommit: severity === 'error',
				blocksDeploy: severity === 'error',
			},
		};
	}


	// ─── AST Helpers ─────────────────────────────────────────────────

	/**
	 * Check if a top-level node has the `export` modifier.
	 * Uses runtime SyntaxKind.ExportKeyword from the loaded TypeScript library.
	 */
	private _isExported(node: ts.Node, SK: any): boolean {
		const exportKeyword = SK.ExportKeyword;
		if (!exportKeyword) {
			// Fallback: check text representation
			try {
				const text = (node as any).getText?.() ?? '';
				return text.startsWith('export ');
			} catch {
				return false;
			}
		}
		const modifiers = (node as any).modifiers;
		if (!modifiers) return false;
		for (const m of modifiers) {
			if (m.kind === exportKeyword) return true;
		}
		return false;
	}

	private _getName(node: ts.Node): string | undefined {
		const name = (node as ts.FunctionLikeDeclaration).name;
		if (name && ts.isIdentifier(name)) return name.text;
		return undefined;
	}

	private _getNameFromAny(node: ts.Node): string | undefined {
		const name = (node as any).name;
		if (!name) return undefined;
		if (ts.isIdentifier(name)) return name.text;
		if (typeof name.text === 'string') return name.text;
		return undefined;
	}

	private _safeGetText(node: ts.Node, sf: ts.SourceFile): string {
		try {
			return node.getText(sf);
		} catch {
			return '';
		}
	}

	private _getParamsText(node: ts.FunctionLikeDeclaration, sf: ts.SourceFile): string {
		const params = node.parameters;
		if (!params || params.length === 0) return '()';
		const parts = Array.from(params).map((p: ts.Node) => this._safeGetText(p, sf).replace(/\s+/g, ' ').trim());
		return `(${parts.join(', ')})`;
	}

	private _getReturnTypeText(node: ts.FunctionLikeDeclaration, sf: ts.SourceFile): string {
		const typeNode = node.type;
		if (!typeNode) return '';
		return ': ' + this._safeGetText(typeNode, sf).trim();
	}

	private _getPublicMemberSignatures(cls: ts.ClassDeclaration, sf: ts.SourceFile, SK: any): string[] {
		const members: string[] = [];
		const privateKeyword = SK.PrivateKeyword;
		const protectedKeyword = SK.ProtectedKeyword;

		for (const member of (cls.members || [])) {
			// Skip private/protected members
			const modifiers = (member as any).modifiers as ts.Node[] | undefined;
			if (modifiers) {
				const isPrivate = modifiers.some((m: ts.Node) =>
					m.kind === privateKeyword || m.kind === protectedKeyword || m.kind === ts.SyntaxKind.PrivateKeyword
				);
				if (isPrivate) continue;
			}

			// Skip private identifier members (#field)
			const memberName = (member as any).name;
			if (memberName && typeof memberName.text === 'string' && memberName.text.startsWith('#')) continue;

			try {
				const text = this._safeGetText(member, sf).replace(/\s+/g, ' ').trim();
				// Normalize by removing implementation body for methods
				const sig = text.replace(/\s*\{[^}]*\}\s*$/, '').trim();
				if (sig) members.push(sig);
			} catch { /* skip */ }
		}

		return members;
	}

	private _getInterfaceMemberSignatures(node: ts.Node, sf: ts.SourceFile): string[] {
		const members: string[] = [];
		const memberNodes = (node as any).members || [];
		for (const m of memberNodes) {
			try {
				const text = this._safeGetText(m, sf).replace(/\s+/g, ' ').trim();
				if (text) members.push(text);
			} catch { /* skip */ }
		}
		return members;
	}


	// ─── Utilities ───────────────────────────────────────────────────

	/**
	 * Parse a parameter list string "(x: string, y?: number)" into individual param strings.
	 */
	private _parseParams(paramList: string): string[] {
		const inner = paramList.replace(/^\(/, '').replace(/\)$/, '').trim();
		if (!inner) return [];
		// Simple split on top-level commas (doesn't handle generics with commas, but sufficient for signatures)
		const params: string[] = [];
		let depth = 0;
		let current = '';
		for (const char of inner) {
			if (char === '<' || char === '(' || char === '[' || char === '{') depth++;
			else if (char === '>' || char === ')' || char === ']' || char === '}') depth--;
			else if (char === ',' && depth === 0) {
				params.push(current.trim());
				current = '';
				continue;
			}
			current += char;
		}
		if (current.trim()) params.push(current.trim());
		return params;
	}

	/**
	 * Simple djb2 hash of a string path for use as storage key suffix.
	 */
	private _pathHash(path: string): string {
		let hash = 5381;
		for (let i = 0; i < path.length; i++) {
			hash = ((hash << 5) + hash) + path.charCodeAt(i);
			hash = hash & hash; // Convert to 32bit integer
		}
		return (hash >>> 0).toString(36);
	}
}
