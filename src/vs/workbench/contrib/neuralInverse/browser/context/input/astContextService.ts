/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ITextModel } from '../../../../../../editor/common/model.js';
import { Position } from '../../../../../../editor/common/core/position.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { ITreeSitterParserService } from '../../../../../../editor/common/services/treeSitterParserService.js';
import type * as Parser from '@vscode/tree-sitter-wasm';

export const IASTContextService = createDecorator<IASTContextService>('neuralInverseASTContextService');

export interface IASTContext {
    currentNode: string;
    nodeType: string;
    parentNode: string;
    parentType: string;
    siblings: string[];
    kind: string;
    // \u2500\u2500 Enriched scope context \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    language: string;           // e.g. 'typescript', 'python'
    fileName: string;           // basename of the file, e.g. 'authService.ts'
    enclosingFunction?: string; // name of the function/method cursor is inside
    enclosingClass?: string;    // name of the class cursor is inside
    functionSignature?: string; // first line of enclosing function (params + return type)
}

export interface IASTContextService {
    readonly _serviceBrand: undefined;
    getASTContext(model: ITextModel, position: Position): Promise<IASTContext | undefined>;
}

export class ASTContextService extends Disposable implements IASTContextService {
    _serviceBrand: undefined;

    constructor(
        @ITreeSitterParserService private readonly treeSitterService: ITreeSitterParserService
    ) {
        super();
    }

    // \u2500\u2500 AST helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

    private _findEnclosing(node: any, types: Set<string>): any {
        let cur = node.parent;
        while (cur) {
            if (types.has(cur.type)) return cur;
            cur = cur.parent;
        }
        return null;
    }

    private _nodeName(node: any): string {
        if (!node) return '(anonymous)';
        for (let i = 0; i < node.namedChildCount; i++) {
            const c = node.namedChild(i);
            if (c && (c.type === 'identifier' || c.type === 'property_identifier' || c.type === 'type_identifier')) {
                return c.text;
            }
        }
        // Arrow / function expression assigned to variable: const foo = () => {}
        if (node.type === 'arrow_function' || node.type === 'function_expression') {
            const vd = node.parent;
            if (vd?.type === 'variable_declarator') {
                const id = vd.namedChild(0);
                if (id?.type === 'identifier') return id.text;
            }
        }
        return '(anonymous)';
    }

    private _functionSignature(node: any): string {
        // Grab everything from the node start up to the opening brace or arrow
        const firstLine = node.text.split('\n')[0]
            .replace(/\s*\{.*$/, '')   // strip trailing {
            .replace(/\s*=>.*$/, '')   // strip trailing =>
            .trim();
        return firstLine.length > 100 ? firstLine.slice(0, 100) + '\u2026' : firstLine;
    }

    // \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

    public async getASTContext(model: ITextModel, position: Position): Promise<IASTContext | undefined> {
        const language = model.getLanguageId();
        const fileName = model.uri.path.split('/').pop() ?? model.uri.path;

        const treeSitterModel = await this.treeSitterService.getTextModelTreeSitter(model, true);
        if (!treeSitterModel) {
            console.warn('[ASTContextService] TreeSitter model not available for language:', language);
            return undefined;
        }

        const parseResult = treeSitterModel.parseResult;
        if (!parseResult?.tree) {
            console.warn('[ASTContextService] Parse result or tree missing.');
            return undefined;
        }

        const targetPoint: Parser.Point = {
            row: position.lineNumber - 1,
            column: position.column - 1
        };

        const node = parseResult.tree.rootNode.descendantForPosition(targetPoint);
        if (!node) return undefined;

        const parent = node.parent;

        // Siblings
        const siblings: string[] = [];
        if (parent) {
            for (let i = 0; i < parent.namedChildCount; i++) {
                const child = parent.namedChild(i);
                if (child && child.id !== node.id &&
                    (child.type.includes('identifier') || child.type === 'name')) {
                    siblings.push(child.text);
                }
                if (siblings.length >= 5) break;
            }
        }

        // Enclosing function / class
        const FUNCTION_TYPES = new Set([
            'function_declaration', 'method_definition', 'arrow_function',
            'function_expression', 'generator_function_declaration', 'generator_function',
        ]);
        const CLASS_TYPES = new Set(['class_declaration', 'abstract_class_declaration', 'class']);

        const enclosingFnNode = this._findEnclosing(node, FUNCTION_TYPES);
        const enclosingClassNode = this._findEnclosing(node, CLASS_TYPES);

        return {
            currentNode: node.text.slice(0, 60),
            nodeType: node.type,
            parentNode: parent ? parent.text.slice(0, 80) : 'ROOT',
            parentType: parent ? parent.type : 'ROOT',
            siblings,
            kind: node.type,
            language,
            fileName,
            enclosingFunction: enclosingFnNode ? this._nodeName(enclosingFnNode) : undefined,
            enclosingClass: enclosingClassNode ? this._nodeName(enclosingClassNode) : undefined,
            functionSignature: enclosingFnNode ? this._functionSignature(enclosingFnNode) : undefined,
        };
    }
}

registerSingleton(IASTContextService, ASTContextService, InstantiationType.Eager);
