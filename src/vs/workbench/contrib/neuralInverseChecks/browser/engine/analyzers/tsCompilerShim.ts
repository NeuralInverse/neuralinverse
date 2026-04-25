/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # TypeScript Compiler API Shim
 *
 * Re-exports the TypeScript compiler API types and functions
 * needed by the GRC analyzers (AST, DataFlow, ImportGraph).
 *
 * VS Code bundles the TypeScript compiler, so we don't need an
 * additional dependency. This shim provides a clean import path
 * and type-safe interfaces.
 *
 * ## Node Types Covered
 *
 * - Declarations: Function, Method, Arrow, Class, Variable, Import, Export
 * - Expressions: Call, New, PropertyAccess, Binary, Template, Await, Yield, Conditional
 * - Statements: Try, If, For, While, Return, Throw, Block
 * - Literals: String, Numeric, NoSubstitutionTemplate
 * - Patterns: ObjectBindingPattern, ArrayBindingPattern, SpreadElement
 */

declare const globalThis: any;


// \u2500\u2500\u2500 SyntaxKind Enum \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const enum SyntaxKind {
	// \u2500\u2500 Literals \u2500\u2500
	NumericLiteral = 9,
	StringLiteral = 11,
	NoSubstitutionTemplateLiteral = 15,
	TemplateHead = 16,
	TemplateMiddle = 17,
	TemplateTail = 18,

	// \u2500\u2500 Identifiers & Keywords \u2500\u2500
	Identifier = 80,
	AsyncKeyword = 134,

	// \u2500\u2500 Tokens \u2500\u2500
	EqualsToken = 63,
	PlusToken = 40,
	MinusToken = 41,
	MinusMinusToken = 46,
	PlusPlusToken = 45,
	MinusEqualsToken = 68,
	PlusEqualsToken = 64,
	AsteriskEqualsToken = 67,
	SlashEqualsToken = 69,
	AmpersandAmpersandToken = 56,
	BarBarToken = 57,

	// \u2500\u2500 Keywords \u2500\u2500
	TrueKeyword = 112,
	FalseKeyword = 97,
	NullKeyword = 104,

	// \u2500\u2500 Object/Array Patterns \u2500\u2500
	ObjectBindingPattern = 206,
	ArrayBindingPattern = 207,
	BindingElement = 208,

	// \u2500\u2500 Literal Expressions \u2500\u2500
	ArrayLiteralExpression = 209,
	ObjectLiteralExpression = 210,

	// \u2500\u2500 Expressions \u2500\u2500
	PropertyAccessExpression = 211,
	ElementAccessExpression = 212,
	CallExpression = 213,
	NewExpression = 214,
	TaggedTemplateExpression = 215,
	ParenthesizedExpression = 217,
	FunctionExpression = 218,
	ArrowFunction = 219,
	AwaitExpression = 223,
	ConditionalExpression = 227,
	TemplateExpression = 228,
	YieldExpression = 229,
	SpreadElement = 230,
	ClassExpression = 231,
	BinaryExpression = 226,
	PrefixUnaryExpression = 224,
	PostfixUnaryExpression = 225,

	// \u2500\u2500 Statements \u2500\u2500
	Block = 241,
	VariableStatement = 243,
	ExpressionStatement = 244,
	IfStatement = 245,
	DoStatement = 246,
	WhileStatement = 247,
	ForStatement = 248,
	ForInStatement = 249,
	ForOfStatement = 250,
	ReturnStatement = 253,
	ThrowStatement = 257,
	TryStatement = 258,
	SwitchStatement = 255,

	// \u2500\u2500 Declarations \u2500\u2500
	VariableDeclaration = 260,
	VariableDeclarationList = 261,
	FunctionDeclaration = 262,
	ClassDeclaration = 263,
	ImportDeclaration = 272,
	ExportDeclaration = 278,
	ExportAssignment = 277,

	// \u2500\u2500 Class Members \u2500\u2500
	PropertyDeclaration = 172,
	MethodDeclaration = 174,
	Constructor = 176,
	GetAccessor = 177,
	SetAccessor = 178,

	// \u2500\u2500 Property \u2500\u2500
	PropertyAssignment = 303,
	ShorthandPropertyAssignment = 304,
	SpreadAssignment = 305,

	// \u2500\u2500 Type \u2500\u2500
	TypeReference = 183,

	// \u2500\u2500 Source \u2500\u2500
	SourceFile = 312,

	// \u2500\u2500 Additional declarations (for breaking change detection) \u2500\u2500
	InterfaceDeclaration = 264,
	TypeAliasDeclaration = 265,
	EnumDeclaration = 266,

	// \u2500\u2500 Modifiers \u2500\u2500
	ExportKeyword = 93,
	DefaultKeyword = 88,
	AbstractKeyword = 128,
	ReadonlyKeyword = 146,
	PublicKeyword = 123,
	PrivateKeyword = 122,
	ProtectedKeyword = 124,
	StaticKeyword = 126,
	OverrideKeyword = 162,

	// \u2500\u2500 Keywords \u2500\u2500
	UndefinedKeyword = 156,

	// \u2500\u2500 Type nodes \u2500\u2500
	AsExpression = 232,
	NonNullExpression = 233,
	TypeAssertionExpression = 216,
	AnyKeyword = 131,
}


// \u2500\u2500\u2500 Script Targets \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const enum ScriptTarget {
	Latest = 99,
	ES2022 = 9,
	ESNext = 99,
}

export const enum ScriptKind {
	JS = 1,
	JSX = 2,
	TS = 3,
	TSX = 4,
}


// \u2500\u2500\u2500 Node Interfaces \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface Node {
	kind: SyntaxKind | number;
	parent: Node;
	getStart(sourceFile?: SourceFile): number;
	getEnd(): number;
	getText(sourceFile?: SourceFile): string;
	modifiers?: readonly Modifier[];
	forEachChild(cbNode: (node: Node) => void): void;
}

export interface Modifier extends Node { }

export interface SourceFile extends Node {
	fileName: string;
	text: string;
	getLineAndCharacterOfPosition(pos: number): { line: number; character: number };
}

export interface Identifier extends Node {
	text: string;
}

export interface StringLiteral extends Node {
	text: string;
}

export interface NumericLiteral extends Node {
	text: string;
}

export interface TemplateExpression extends Node {
	head: Node;
	templateSpans: readonly TemplateSpan[];
}

export interface TemplateSpan extends Node {
	expression: Node;
	literal: Node;
}

export interface TaggedTemplateExpression extends Node {
	tag: Node;
	template: Node;
}

export interface CallExpression extends Node {
	expression: Node;
	arguments: readonly Node[];
	typeArguments?: readonly Node[];
}

export interface NewExpression extends Node {
	expression: Node;
	arguments?: readonly Node[];
}

export interface PropertyAccessExpression extends Node {
	expression: Node;
	name: Identifier;
}

export interface ElementAccessExpression extends Node {
	expression: Node;
	argumentExpression: Node;
}

export interface VariableDeclaration extends Node {
	name: Node;
	initializer?: Node;
	type?: Node;
}

export interface VariableDeclarationList extends Node {
	declarations: readonly VariableDeclaration[];
}

export interface BinaryExpression extends Node {
	left: Node;
	operatorToken: Node;
	right: Node;
}

export interface ConditionalExpression extends Node {
	condition: Node;
	whenTrue: Node;
	whenFalse: Node;
}

export interface AwaitExpression extends Node {
	expression: Node;
}

export interface SpreadElement extends Node {
	expression: Node;
}

export interface ImportDeclaration extends Node {
	moduleSpecifier: Node;
	importClause?: Node;
}

export interface ExportDeclaration extends Node {
	moduleSpecifier?: Node;
	exportClause?: Node;
}

export interface FunctionLikeDeclaration extends Node {
	name?: Identifier;
	parameters: readonly Node[];
	body?: Node;
	type?: Node;
}

export interface ClassDeclaration extends Node {
	name?: Identifier;
	members: readonly Node[];
	heritageClauses?: readonly Node[];
}

export interface ClassExpression extends Node {
	name?: Identifier;
	members: readonly Node[];
	heritageClauses?: readonly Node[];
}

export interface FunctionExpression extends FunctionLikeDeclaration { }

export interface ReturnStatement extends Node {
	expression?: Node;
}

export interface ThrowStatement extends Node {
	expression: Node;
}

export interface TryStatement extends Node {
	tryBlock: Node;
	catchClause?: Node;
	finallyBlock?: Node;
}

export interface IfStatement extends Node {
	expression: Node;
	thenStatement: Node;
	elseStatement?: Node;
}

export interface ForStatement extends Node {
	initializer?: Node;
	condition?: Node;
	incrementor?: Node;
	statement: Node;
}

export interface ForInStatement extends Node {
	initializer: Node;
	expression: Node;
	statement: Node;
}

export interface ForOfStatement extends Node {
	initializer: Node;
	expression: Node;
	statement: Node;
}

export interface WhileStatement extends Node {
	expression: Node;
	statement: Node;
}

export interface DoStatement extends Node {
	statement: Node;
	expression: Node;
}

export interface SwitchStatement extends Node {
	expression: Node;
	caseBlock: Node;
}

export interface ObjectBindingPattern extends Node {
	elements: readonly BindingElement[];
}

export interface ArrayBindingPattern extends Node {
	elements: readonly Node[];
}

export interface BindingElement extends Node {
	propertyName?: Identifier;
	name: Node;
	initializer?: Node;
}

export interface PropertyAssignment extends Node {
	name: Node;
	initializer: Node;
}

export interface ObjectLiteralExpression extends Node {
	properties: readonly Node[];
}

export interface ArrayLiteralExpression extends Node {
	elements: readonly Node[];
}

export interface ExpressionStatement extends Node {
	expression: Node;
}

export interface Block extends Node {
	statements: readonly Node[];
}

export interface ParenthesizedExpression extends Node {
	expression: Node;
}

export interface PrefixUnaryExpression extends Node {
	operator: number;
	operand: Node;
}

export interface PostfixUnaryExpression extends Node {
	operand: Node;
	operator: number;
}

export interface AsExpression extends Node {
	expression: Node;
	type: Node;
}

export interface NonNullExpression extends Node {
	expression: Node;
}

export interface TypeAssertion extends Node {
	type: Node;
	expression: Node;
}

// \u2500\u2500\u2500 TypeChecker Interfaces \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface TypeChecker {
	getTypeAtLocation(node: Node): Type;
	typeToString(type: Type): string;
	getSymbolAtLocation(node: Node): Symbol | undefined;
	getDeclaredTypeOfSymbol(symbol: Symbol): Type;
	getReturnTypeOfSignature(signature: Signature): Type;
	getSignaturesOfType(type: Type, kind: number): Signature[];
}

export interface Type {
	flags: number;
}

export interface Symbol {
	name: string;
	flags: number;
}

export interface Signature {
	declaration?: Node;
}

export interface SingleFileProgram {
	sourceFile: SourceFile;
	typeChecker: TypeChecker;
}


// \u2500\u2500\u2500 Type Guards \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

// Identifiers & Literals
export function isIdentifier(node: Node): node is Identifier {
	return node.kind === SyntaxKind.Identifier;
}

export function isStringLiteral(node: Node): node is StringLiteral {
	return node.kind === SyntaxKind.StringLiteral;
}

export function isNumericLiteral(node: Node): node is NumericLiteral {
	return node.kind === SyntaxKind.NumericLiteral;
}

export function isNoSubstitutionTemplateLiteral(node: Node): node is StringLiteral {
	return node.kind === SyntaxKind.NoSubstitutionTemplateLiteral;
}

// Expressions
export function isCallExpression(node: Node): node is CallExpression {
	return node.kind === SyntaxKind.CallExpression;
}

export function isNewExpression(node: Node): node is NewExpression {
	return node.kind === SyntaxKind.NewExpression;
}

export function isPropertyAccessExpression(node: Node): node is PropertyAccessExpression {
	return node.kind === SyntaxKind.PropertyAccessExpression;
}

export function isElementAccessExpression(node: Node): node is ElementAccessExpression {
	return node.kind === SyntaxKind.ElementAccessExpression;
}

export function isBinaryExpression(node: Node): node is BinaryExpression {
	return node.kind === SyntaxKind.BinaryExpression;
}

export function isConditionalExpression(node: Node): node is ConditionalExpression {
	return node.kind === SyntaxKind.ConditionalExpression;
}

export function isTemplateExpression(node: Node): node is TemplateExpression {
	return node.kind === SyntaxKind.TemplateExpression;
}

export function isTaggedTemplateExpression(node: Node): node is TaggedTemplateExpression {
	return node.kind === SyntaxKind.TaggedTemplateExpression;
}

export function isAwaitExpression(node: Node): node is AwaitExpression {
	return node.kind === SyntaxKind.AwaitExpression;
}

export function isSpreadElement(node: Node): node is SpreadElement {
	return node.kind === SyntaxKind.SpreadElement;
}

export function isPrefixUnaryExpression(node: Node): node is PrefixUnaryExpression {
	return node.kind === SyntaxKind.PrefixUnaryExpression;
}

export function isPostfixUnaryExpression(node: Node): node is PostfixUnaryExpression {
	return node.kind === SyntaxKind.PostfixUnaryExpression;
}

export function isSourceFile(node: Node): node is SourceFile {
	return node.kind === SyntaxKind.SourceFile;
}

export function isParenthesizedExpression(node: Node): node is ParenthesizedExpression {
	return node.kind === SyntaxKind.ParenthesizedExpression;
}

export function isObjectLiteralExpression(node: Node): node is ObjectLiteralExpression {
	return node.kind === SyntaxKind.ObjectLiteralExpression;
}

export function isArrayLiteralExpression(node: Node): node is ArrayLiteralExpression {
	return node.kind === SyntaxKind.ArrayLiteralExpression;
}

// Declarations
export function isFunctionDeclaration(node: Node): node is FunctionLikeDeclaration {
	return node.kind === SyntaxKind.FunctionDeclaration;
}

export function isMethodDeclaration(node: Node): node is FunctionLikeDeclaration {
	return node.kind === SyntaxKind.MethodDeclaration;
}

export function isArrowFunction(node: Node): node is FunctionLikeDeclaration {
	return node.kind === SyntaxKind.ArrowFunction;
}

export function isClassDeclaration(node: Node): node is ClassDeclaration {
	return node.kind === SyntaxKind.ClassDeclaration;
}

export function isClassExpression(node: Node): node is ClassExpression {
	return node.kind === SyntaxKind.ClassExpression;
}

export function isFunctionExpression(node: Node): node is FunctionExpression {
	return node.kind === SyntaxKind.FunctionExpression;
}

export function isVariableDeclaration(node: Node): node is VariableDeclaration {
	return node.kind === SyntaxKind.VariableDeclaration;
}

export function isVariableDeclarationList(node: Node): node is VariableDeclarationList {
	return node.kind === SyntaxKind.VariableDeclarationList;
}

export function isImportDeclaration(node: Node): node is ImportDeclaration {
	return node.kind === SyntaxKind.ImportDeclaration;
}

export function isExportDeclaration(node: Node): node is ExportDeclaration {
	return node.kind === SyntaxKind.ExportDeclaration;
}

// Statements
export function isTryStatement(node: Node): node is TryStatement {
	return node.kind === SyntaxKind.TryStatement;
}

export function isReturnStatement(node: Node): node is ReturnStatement {
	return node.kind === SyntaxKind.ReturnStatement;
}

export function isThrowStatement(node: Node): node is ThrowStatement {
	return node.kind === SyntaxKind.ThrowStatement;
}

export function isIfStatement(node: Node): node is IfStatement {
	return node.kind === SyntaxKind.IfStatement;
}

export function isForStatement(node: Node): node is ForStatement {
	return node.kind === SyntaxKind.ForStatement;
}

export function isForInStatement(node: Node): node is ForInStatement {
	return node.kind === SyntaxKind.ForInStatement;
}

export function isForOfStatement(node: Node): node is ForOfStatement {
	return node.kind === SyntaxKind.ForOfStatement;
}

export function isWhileStatement(node: Node): node is WhileStatement {
	return node.kind === SyntaxKind.WhileStatement;
}

export function isDoStatement(node: Node): node is DoStatement {
	return node.kind === SyntaxKind.DoStatement;
}

export function isSwitchStatement(node: Node): node is SwitchStatement {
	return node.kind === SyntaxKind.SwitchStatement;
}

export function isExpressionStatement(node: Node): node is ExpressionStatement {
	return node.kind === SyntaxKind.ExpressionStatement;
}

export function isBlock(node: Node): node is Block {
	return node.kind === SyntaxKind.Block;
}

// Patterns
export function isObjectBindingPattern(node: Node): node is ObjectBindingPattern {
	return node.kind === SyntaxKind.ObjectBindingPattern;
}

export function isArrayBindingPattern(node: Node): node is ArrayBindingPattern {
	return node.kind === SyntaxKind.ArrayBindingPattern;
}

export function isBindingElement(node: Node): node is BindingElement {
	return node.kind === SyntaxKind.BindingElement;
}

export function isPropertyAssignment(node: Node): node is PropertyAssignment {
	return node.kind === SyntaxKind.PropertyAssignment;
}

export function isSpreadAssignment(node: Node): node is Node {
	return node.kind === SyntaxKind.SpreadAssignment;
}

export function isAsExpression(node: Node): node is AsExpression {
	return node.kind === SyntaxKind.AsExpression;
}

export function isNonNullExpression(node: Node): node is NonNullExpression {
	return node.kind === SyntaxKind.NonNullExpression;
}

export function isTypeAssertion(node: Node): node is TypeAssertion {
	return node.kind === SyntaxKind.TypeAssertionExpression;
}


// \u2500\u2500\u2500 Utility \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function forEachChild(node: Node, cbNode: (node: Node) => void): void {
	node.forEachChild(cbNode);
}

/**
 * Check if a node is any function-like declaration.
 */
export function isFunctionLike(node: Node): node is FunctionLikeDeclaration {
	return node.kind === SyntaxKind.FunctionDeclaration
		|| node.kind === SyntaxKind.FunctionExpression
		|| node.kind === SyntaxKind.MethodDeclaration
		|| node.kind === SyntaxKind.ArrowFunction
		|| node.kind === SyntaxKind.Constructor
		|| node.kind === SyntaxKind.GetAccessor
		|| node.kind === SyntaxKind.SetAccessor;
}


// \u2500\u2500\u2500 TypeScript Compiler Access \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Cached reference to the TypeScript compiler library.
 * Loaded eagerly on module initialization.
 */
let _cachedTsLib: any = undefined;
let _tsLoadAttempted = false;
let _tsLoadFailed = false;

/**
 * Eagerly load TypeScript compiler on module initialization.
 *
 * Uses multiple fallback strategies to find the TypeScript compiler:
 * 1. globalThis.require('typescript') \u2014 works in Electron without sandbox
 * 2. Dynamic import('typescript') \u2014 works in ESM/sandboxed contexts
 * 3. process.mainModule.require('typescript') \u2014 Electron main module path
 * 4. Direct path require \u2014 explicit node_modules path
 *
 * The result is cached so createSourceFile() can use it synchronously.
 */
(async () => {
	_cachedTsLib = _tryLoadTypeScriptSync();

	if (!_cachedTsLib) {
		// Try async dynamic import as fallback
		try {
			_cachedTsLib = await import('typescript');
			// Handle default export wrapping
			if (_cachedTsLib && _cachedTsLib.default && _cachedTsLib.default.createSourceFile) {
				_cachedTsLib = _cachedTsLib.default;
			}
		} catch { /* Dynamic import not available */ }
	}

	_tsLoadAttempted = true;

	if (_cachedTsLib && typeof _cachedTsLib.createSourceFile === 'function') {
		console.log('[tsCompilerShim] \u2713 TypeScript compiler loaded successfully');
	} else {
		_tsLoadFailed = true;
		console.error(
			'[tsCompilerShim] \u2717 CRITICAL: TypeScript compiler not available. ' +
			'AST, DataFlow, and ImportGraph analysis will NOT work. ' +
			'Only regex and file-level checks will fire.'
		);
	}
})();

/**
 * Synchronous attempts to load TypeScript.
 * Called first during module init before falling back to async import.
 */
function _tryLoadTypeScriptSync(): any {
	// Strategy 1: globalThis.require (Electron without sandbox)
	if (typeof globalThis !== 'undefined' && typeof globalThis.require === 'function') {
		try {
			const ts = globalThis.require('typescript');
			if (ts && typeof ts.createSourceFile === 'function') {
				return ts;
			}
		} catch { /* Not available */ }
	}

	// Strategy 2: process.mainModule.require (Electron main module)
	if (typeof process !== 'undefined' && (process as any).mainModule) {
		try {
			const ts = (process as any).mainModule.require('typescript');
			if (ts && typeof ts.createSourceFile === 'function') {
				return ts;
			}
		} catch { /* Not available */ }
	}

	// Strategy 3: Module._load bypass (Node.js internals)
	if (typeof process !== 'undefined' && typeof (process as any).type !== 'undefined') {
		try {
			const Module = globalThis.require?.('module');
			if (Module && Module._load) {
				const ts = Module._load('typescript');
				if (ts && typeof ts.createSourceFile === 'function') {
					return ts;
				}
			}
		} catch { /* Not available */ }
	}

	// Strategy 4: Check if already loaded in AMD context
	if (typeof (globalThis as any).define !== 'undefined') {
		try {
			const tsModule = (globalThis as any).require?.('vs/language/typescript/tsMode');
			if (tsModule?.typescript) {
				return tsModule.typescript;
			}
		} catch { /* Not available via AMD */ }
	}

	return undefined;
}


// \u2500\u2500\u2500 Raw TypeScript Library Access \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Get the raw loaded TypeScript compiler library.
 *
 * Returns the actual `typescript` npm package object, or undefined if loading
 * failed. Use this when you need to access SyntaxKind values at runtime
 * (e.g. for node types not defined in this shim), or to call APIs like
 * `ts.createProgram()` directly.
 *
 * ```typescript
 * const ts = getTsLib();
 * if (ts) {
 *   const isInterface = node.kind === ts.SyntaxKind.InterfaceDeclaration;
 * }
 * ```
 */
export function getTsLib(): any {
	return _cachedTsLib;
}


// \u2500\u2500\u2500 Single-File TypeChecker \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Create a single-file TypeScript program with an in-memory compiler host.
 *
 * Returns a TypeChecker for type-aware analysis of a single file.
 * No file system access is needed \u2014 the file content is provided as a string.
 *
 * **Limitations** (by design):
 * - Single file only \u2014 imports are not resolved
 * - No standard library (`lib.d.ts`) \u2014 external types are `any`
 * - Use `typeChecker.typeToString(typeChecker.getTypeAtLocation(node))`
 *   to get type names; they will be `any` for unresolved external types
 *
 * **What works:**
 * - Detecting implicit `any` parameters (no type annotation)
 * - Detecting `as any` / `as unknown` type assertions
 * - Detecting missing return type annotations
 * - Getting inferred types for locally-defined variables
 *
 * @returns `{ sourceFile, typeChecker }` or `undefined` if TS compiler unavailable
 */
export function createSingleFileProgram(fileName: string, sourceText: string): SingleFileProgram | undefined {
	if (!_cachedTsLib || typeof _cachedTsLib.createProgram !== 'function') {
		return undefined;
	}

	try {
		const ts = _cachedTsLib;
		const isJsx = fileName.endsWith('.tsx') || fileName.endsWith('.jsx');

		const sourceFile = ts.createSourceFile(
			fileName,
			sourceText,
			ts.ScriptTarget.Latest,
			/* setParentNodes */ true,
			isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
		);

		const compilerOptions = {
			noEmit: true,
			strict: true,
			target: ts.ScriptTarget.Latest,
			module: ts.ModuleKind.CommonJS,
			skipLibCheck: true,
			noResolve: true, // Don't try to resolve imports \u2014 in-memory only
			noLib: true,     // No lib.d.ts \u2014 avoids file system lookups
		};

		const host: any = {
			getSourceFile: (name: string) => name === fileName ? sourceFile : undefined,
			writeFile: () => { },
			getDefaultLibFileName: () => '',
			useCaseSensitiveFileNames: () => true,
			getCanonicalFileName: (f: string) => f,
			getCurrentDirectory: () => '/',
			getNewLine: () => '\n',
			fileExists: (name: string) => name === fileName,
			readFile: () => undefined,
			directoryExists: () => false,
			getDirectories: () => [],
		};

		const program = ts.createProgram([fileName], compilerOptions, host);
		const typeChecker = program.getTypeChecker();

		return { sourceFile, typeChecker };
	} catch (e) {
		// createProgram may fail in some environments
		return undefined;
	}
}


// \u2500\u2500\u2500 SourceFile Creation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Creates a SourceFile from source text.
 *
 * Uses the eagerly-loaded TypeScript compiler. If the compiler failed
 * to load, returns a minimal stub and logs a warning.
 */
export function createSourceFile(
	fileName: string,
	sourceText: string,
	languageVersion: ScriptTarget,
	setParentNodes?: boolean,
	scriptKind?: ScriptKind
): SourceFile {
	// Use cached TypeScript compiler
	if (_cachedTsLib && typeof _cachedTsLib.createSourceFile === 'function') {
		try {
			return _cachedTsLib.createSourceFile(fileName, sourceText, languageVersion, setParentNodes, scriptKind);
		} catch (e) {
			console.error('[tsCompilerShim] Failed to parse source file:', e);
		}
	}

	// If async loading hasn't completed yet, try sync one more time
	if (!_tsLoadAttempted && !_cachedTsLib) {
		_cachedTsLib = _tryLoadTypeScriptSync();
		if (_cachedTsLib && typeof _cachedTsLib.createSourceFile === 'function') {
			try {
				return _cachedTsLib.createSourceFile(fileName, sourceText, languageVersion, setParentNodes, scriptKind);
			} catch (e) {
				console.error('[tsCompilerShim] Failed to parse source file:', e);
			}
		}
	}

	// Log warning (but don't spam \u2014 only on first fallback use per session)
	if (!_tsLoadFailed) {
		_tsLoadFailed = true;
		console.warn(
			'[tsCompilerShim] TypeScript compiler not loaded. ' +
			'AST analysis will be skipped for: ' + fileName
		);
	}

	// Fallback: return a minimal source file that won't match anything
	return {
		kind: SyntaxKind.SourceFile,
		fileName: fileName,
		text: sourceText,
		parent: null as any,
		modifiers: undefined,
		getStart: () => 0,
		getEnd: () => sourceText.length,
		getText: () => sourceText,
		getLineAndCharacterOfPosition: (pos: number) => {
			let line = 0;
			let character = 0;
			for (let i = 0; i < pos && i < sourceText.length; i++) {
				if (sourceText[i] === '\n') {
					line++;
					character = 0;
				} else {
					character++;
				}
			}
			return { line, character };
		},
		forEachChild: () => { },
	};
}
