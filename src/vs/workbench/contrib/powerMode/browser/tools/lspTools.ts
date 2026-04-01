/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * VS Code-native LSP tools for Power Mode.
 *
 * Uses VS Code's built-in language services directly — no external LSP server,
 * no sub-agent, no extra tokens. The LLM calls these directly to navigate code.
 *
 * Operations:
 *   definition    — go to definition of symbol at line:col
 *   references    — find all references to symbol at line:col
 *   hover         — get type info / docs for symbol at line:col
 *   symbols       — list all symbols (functions, classes, vars) in a file
 *   implementation — go to implementation of interface / abstract method
 *   incoming_calls — what functions call this function
 *   outgoing_calls — what functions this function calls
 */

import { URI } from '../../../../../base/common/uri.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { DocumentSymbol, SymbolKind } from '../../../../../editor/common/languages.js';
import { CallHierarchyProviderRegistry } from '../../../callHierarchy/common/callHierarchy.js';
import { IPowerTool, IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import { definePowerTool } from './powerToolRegistry.js';

// ─── Symbol kind labels ───────────────────────────────────────────────────────

const SYMBOL_KIND_LABELS: Record<number, string> = {
	[SymbolKind.File]: 'file',
	[SymbolKind.Module]: 'module',
	[SymbolKind.Namespace]: 'namespace',
	[SymbolKind.Package]: 'package',
	[SymbolKind.Class]: 'class',
	[SymbolKind.Method]: 'method',
	[SymbolKind.Property]: 'property',
	[SymbolKind.Field]: 'field',
	[SymbolKind.Constructor]: 'constructor',
	[SymbolKind.Enum]: 'enum',
	[SymbolKind.Interface]: 'interface',
	[SymbolKind.Function]: 'function',
	[SymbolKind.Variable]: 'variable',
	[SymbolKind.Constant]: 'constant',
	[SymbolKind.String]: 'string',
	[SymbolKind.Number]: 'number',
	[SymbolKind.Boolean]: 'boolean',
	[SymbolKind.Array]: 'array',
	[SymbolKind.Object]: 'object',
	[SymbolKind.Key]: 'key',
	[SymbolKind.Null]: 'null',
	[SymbolKind.EnumMember]: 'enum-member',
	[SymbolKind.Struct]: 'struct',
	[SymbolKind.Event]: 'event',
	[SymbolKind.Operator]: 'operator',
	[SymbolKind.TypeParameter]: 'type-param',
};

function kindLabel(k: SymbolKind): string {
	return SYMBOL_KIND_LABELS[k] ?? 'symbol';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Flatten DocumentSymbol tree into indented lines */
function flattenSymbols(symbols: DocumentSymbol[], indent = 0): string[] {
	const lines: string[] = [];
	for (const s of symbols) {
		const pad = '  '.repeat(indent);
		const line = s.selectionRange.startLineNumber;
		const col = s.selectionRange.startColumn;
		lines.push(`${pad}${kindLabel(s.kind)}  ${s.name}  L${line}:${col}`);
		if (s.children?.length) {
			lines.push(...flattenSymbols(s.children, indent + 1));
		}
	}
	return lines;
}

/** Convert a file path (absolute or workspace-relative) to a URI */
function toUri(filePath: string): URI {
	return filePath.startsWith('/') || /^[A-Za-z]:\\/.test(filePath)
		? URI.file(filePath)
		: URI.parse(filePath);
}

/** Get a text model from the model service, with auto-dispose */
async function withModel<T>(
	textModelService: ITextModelService,
	uri: URI,
	fn: (model: import('../../../../../editor/common/model.js').ITextModel) => Promise<T>
): Promise<T> {
	const ref = await textModelService.createModelReference(uri);
	try {
		return await fn(ref.object.textEditorModel);
	} finally {
		ref.dispose();
	}
}

// ─── Tool factory ─────────────────────────────────────────────────────────────

export function buildLSPTools(
	languageFeatures: ILanguageFeaturesService,
	textModelService: ITextModelService,
): IPowerTool[] {
	return [createLSPTool(languageFeatures, textModelService)];
}

function createLSPTool(
	languageFeatures: ILanguageFeaturesService,
	textModelService: ITextModelService,
): IPowerTool {
	return definePowerTool(
		'lsp',
		`VS Code language intelligence — go-to-definition, find-references, hover types, list symbols, find implementations, call hierarchy.

Faster and cheaper than grep/glob for navigating code: use this when you know WHAT you're looking for but not WHERE (grep is better when you don't know the symbol name).

**Operations:**
- \`definition\`    — jump to the definition of the symbol at line:col
- \`references\`    — find every place a symbol is used across the workspace
- \`hover\`         — get the TypeScript type signature / JSDoc for a symbol
- \`symbols\`       — list all symbols (functions, classes, vars) in a file with line numbers
- \`implementation\`— go to implementation of an interface or abstract method
- \`incoming_calls\`— which functions call this function (reverse call graph)
- \`outgoing_calls\`— which functions this function calls (forward call graph)

**Input for position-based ops (definition/references/hover/implementation/incoming_calls/outgoing_calls):**
- \`filePath\`   — absolute path to the file
- \`line\`       — 1-based line number (as shown in editors)
- \`character\`  — 1-based column number

**Input for symbols:**
- \`filePath\`   — absolute path to the file (no line/character needed)

**Tips:**
- Run \`symbols\` first on a file to get exact line numbers, then use \`definition\` or \`references\` with those coordinates.
- \`references\` returns all call sites — use this to understand blast radius before refactoring.
- \`hover\` returns the TypeScript type — great for understanding what a value actually is without reading the whole file.`,
		[
			{
				name: 'operation',
				type: 'string',
				description: 'One of: definition, references, hover, symbols, implementation, incoming_calls, outgoing_calls',
				required: true,
			},
			{
				name: 'filePath',
				type: 'string',
				description: 'Absolute path to the source file',
				required: true,
			},
			{
				name: 'line',
				type: 'number',
				description: '1-based line number (required for all ops except symbols)',
				required: false,
			},
			{
				name: 'character',
				type: 'number',
				description: '1-based character offset (required for all ops except symbols)',
				required: false,
			},
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const operation = (args.operation as string)?.toLowerCase();
			const filePath = args.filePath as string;
			const line = (args.line as number) ?? 1;
			const character = (args.character as number) ?? 1;

			if (!operation) {
				return err('Missing required argument: operation');
			}
			if (!filePath) {
				return err('Missing required argument: filePath');
			}

			ctx.metadata({ title: `lsp:${operation} ${_basename(filePath)}:${line}` });

			const uri = toUri(filePath);
			// VS Code Position is 0-based internally; LSP/editor UI is 1-based
			const pos = new Position(line, character);

			try {
				switch (operation) {
					// ── definition ──────────────────────────────────────────────
					case 'definition': {
						return await withModel(textModelService, uri, async (model) => {
							const providers = languageFeatures.definitionProvider.ordered(model);
							if (providers.length === 0) {
								return warn('No definition provider available for this file type.');
							}
							const results = await providers[0].provideDefinition(model, pos, CancellationToken.None);
							if (!results) return warn('No definition found.');
							const locs = Array.isArray(results) ? results : [results];
							const lines = locs.map(loc => {
								const r = 'range' in loc ? loc.range : (loc as any);
								const u = 'uri' in loc ? (loc as any).uri : uri;
								return `${u.fsPath}:${r.startLineNumber}:${r.startColumn}`;
							});
							return ok(`definition`, lines.join('\n'));
						});
					}

					// ── references ──────────────────────────────────────────────
					case 'references': {
						return await withModel(textModelService, uri, async (model) => {
							const providers = languageFeatures.referenceProvider.ordered(model);
							if (providers.length === 0) {
								return warn('No reference provider available for this file type.');
							}
							const refs = await providers[0].provideReferences(
								model, pos, { includeDeclaration: true }, CancellationToken.None
							);
							if (!refs?.length) return warn('No references found.');
							const lines = refs.map(r => `${r.uri.fsPath}:${r.range.startLineNumber}:${r.range.startColumn}`);
							return ok(`${lines.length} reference(s)`, lines.join('\n'));
						});
					}

					// ── hover ────────────────────────────────────────────────────
					case 'hover': {
						return await withModel(textModelService, uri, async (model) => {
							const providers = languageFeatures.hoverProvider.ordered(model);
							if (providers.length === 0) {
								return warn('No hover provider available for this file type.');
							}
							const hover = await providers[0].provideHover(model, pos, CancellationToken.None, undefined as any);
							if (!hover) return warn('No hover information available.');
							const text = hover.contents
								.map(c => typeof c === 'string' ? c : c.value)
								.filter(Boolean)
								.join('\n\n');
							return ok(`hover`, text);
						});
					}

					// ── symbols ──────────────────────────────────────────────────
					case 'symbols': {
						return await withModel(textModelService, uri, async (model) => {
							const providers = languageFeatures.documentSymbolProvider.ordered(model);
							if (providers.length === 0) {
								return warn('No document symbol provider available for this file type.');
							}
							const symbols = await providers[0].provideDocumentSymbols(model, CancellationToken.None);
							if (!symbols?.length) return warn('No symbols found in this file.');
							const lines = flattenSymbols(symbols as DocumentSymbol[]);
							return ok(`${lines.length} symbol(s) in ${_basename(filePath)}`, lines.join('\n'));
						});
					}

					// ── implementation ───────────────────────────────────────────
					case 'implementation': {
						return await withModel(textModelService, uri, async (model) => {
							const providers = languageFeatures.implementationProvider.ordered(model);
							if (providers.length === 0) {
								return warn('No implementation provider available for this file type.');
							}
							const results = await providers[0].provideImplementation(model, pos, CancellationToken.None);
							if (!results) return warn('No implementation found.');
							const locs = Array.isArray(results) ? results : [results];
							const lines = locs.map(loc => {
								const r = 'range' in loc ? loc.range : (loc as any);
								const u = 'uri' in loc ? (loc as any).uri : uri;
								return `${u.fsPath}:${r.startLineNumber}:${r.startColumn}`;
							});
							return ok(`implementation`, lines.join('\n'));
						});
					}

					// ── call hierarchy ───────────────────────────────────────────
					case 'incoming_calls':
					case 'outgoing_calls': {
						return await withModel(textModelService, uri, async (model) => {
							const providers = CallHierarchyProviderRegistry.ordered(model);
							if (providers.length === 0) {
								return warn('No call hierarchy provider available for this file type.');
							}
							const provider = providers[0];
							const session = await provider.prepareCallHierarchy(model, pos, CancellationToken.None);
							if (!session) return warn('Could not prepare call hierarchy at this position.');

							const root = session.roots[0];
							if (!root) { session.dispose(); return warn('No call hierarchy root found.'); }

							try {
								if (operation === 'incoming_calls') {
									const calls = await provider.provideIncomingCalls(root, CancellationToken.None);
									if (!calls?.length) return ok('incoming_calls', '(no callers found)');
									const lines = calls.map(c => {
										const loc = `${c.from.uri.fsPath}:${c.from.range.startLineNumber}`;
										return `${c.from.name}  ←  ${loc}`;
									});
									return ok(`${lines.length} caller(s)`, lines.join('\n'));
								} else {
									const calls = await provider.provideOutgoingCalls(root, CancellationToken.None);
									if (!calls?.length) return ok('outgoing_calls', '(no callees found)');
									const lines = calls.map(c => {
										const loc = `${c.to.uri.fsPath}:${c.to.range.startLineNumber}`;
										return `${c.to.name}  →  ${loc}`;
									});
									return ok(`${lines.length} callee(s)`, lines.join('\n'));
								}
							} finally {
								session.dispose();
							}
						});
					}

					default:
						return err(`Unknown operation: "${operation}". Valid: definition, references, hover, symbols, implementation, incoming_calls, outgoing_calls`);
				}
			} catch (e: any) {
				const msg = e?.message ?? String(e);
				// Model not found means file isn't open — suggest opening it first
				if (msg.includes('model not found') || msg.includes('ENOENT') || msg.includes('not found')) {
					return err(`File not found or not indexed: ${filePath}\nTip: The file must exist on disk. For definition/references to work, VS Code must have the language extension active.`);
				}
				return err(`LSP error (${operation}): ${msg}`);
			}
		},
	);
}

// ─── Tiny utility tools ───────────────────────────────────────────────────────

/** sleep — pause for N ms (useful in retry loops) */
export function createSleepTool(): IPowerTool {
	return definePowerTool(
		'sleep',
		'Pause execution for a specified number of milliseconds. Useful in retry loops or when waiting for async operations to settle.',
		[
			{ name: 'ms', type: 'number', description: 'Duration to sleep in milliseconds (max 30000)', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const ms = Math.min(Math.max(0, (args.ms as number) ?? 1000), 30_000);
			ctx.metadata({ title: `sleep ${ms}ms` });
			await new Promise(resolve => setTimeout(resolve, ms));
			return { title: `slept ${ms}ms`, output: `Waited ${ms}ms.`, metadata: {} };
		},
	);
}

/** todo_write — record a list of todos for the current task */
export function createTodoWriteTool(todos: Map<string, string[]>): IPowerTool {
	return definePowerTool(
		'todo_write',
		`Record a checklist of remaining steps for the current task.
Use before context compaction so you can resume exactly where you left off.
Each line = one action item. Replaces any previous list for this session.
Read back with todo_read.`,
		[
			{ name: 'todos', type: 'string', description: 'Newline-separated list of todo items (one per line)', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const raw = (args.todos as string) || '';
			const items = raw.split('\n').map(s => s.trim()).filter(Boolean);
			todos.set(ctx.sessionId, items);
			ctx.metadata({ title: `todo_write: ${items.length} item(s)` });
			return {
				title: `${items.length} todo(s) saved`,
				output: items.map((t, i) => `${i + 1}. ${t}`).join('\n'),
				metadata: { count: items.length },
			};
		},
	);
}

/** todo_read — read todos back for the current session */
export function createTodoReadTool(todos: Map<string, string[]>): IPowerTool {
	return definePowerTool(
		'todo_read',
		'Read the current todo checklist for this session. Call after compaction to know exactly what still needs to be done.',
		[],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const items = todos.get(ctx.sessionId) ?? [];
			ctx.metadata({ title: 'todo_read' });
			if (!items.length) {
				return { title: 'no todos', output: 'No todos recorded for this session.', metadata: {} };
			}
			return {
				title: `${items.length} todo(s)`,
				output: items.map((t, i) => `${i + 1}. ${t}`).join('\n'),
				metadata: { count: items.length },
			};
		},
	);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(title: string, output: string): IToolResult {
	return { title, output, metadata: {} };
}

function warn(msg: string): IToolResult {
	return { title: 'no result', output: msg, metadata: {} };
}

function err(msg: string): IToolResult {
	return { title: 'error', output: msg, metadata: { error: true } };
}

function _basename(path: string): string {
	return path.split('/').pop() ?? path;
}
