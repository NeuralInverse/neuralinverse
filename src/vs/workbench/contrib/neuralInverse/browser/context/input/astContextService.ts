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
    siblings: string[]; // Names of sibling nodes if identifiers
    kind: string; // Simplified kind for prompt
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

    public async getASTContext(model: ITextModel, position: Position): Promise<IASTContext | undefined> {
        // 1. Get Parse Result (may trigger parse if not fresh)
        // We use getTextModelTreeSitter to get the wrapper, then its parse result
        const treeSitterModel = await this.treeSitterService.getTextModelTreeSitter(model, true); // true = ensure parsed

        if (!treeSitterModel) {
            console.warn('[ASTContextService] TreeSitter model not available for language:', model.getLanguageId());
            return undefined;
        }

        const parseResult = treeSitterModel.parseResult;
        if (!parseResult || !parseResult.tree) {
            console.warn('[ASTContextService] Parse result or tree missing.');
            return undefined;
        }

        const tree = parseResult.tree;

        // 2. Find Node at Cursor
        // Position is 1-based, TreeSitter is 0-based
        const targetPoint: Parser.Point = {
            row: position.lineNumber - 1,
            column: position.column - 1
        };

        const node = tree.rootNode.descendantForPosition(targetPoint);

        if (!node) {
            return undefined;
        }

        // 3. Extract Context
        const parent = node.parent;

        // Get Siblings (named children of parent, excluding self)
        const siblings: string[] = [];
        if (parent) {
            // Limit to modest number of close siblings
            for (let i = 0; i < parent.namedChildCount; i++) {
                const child = parent.namedChild(i);
                if (child && child.id !== node.id) {
                    // Try to get text if it looks like an identifier/name
                    if (child.type.includes('identifier') || child.type === 'name') {
                        siblings.push(child.text);
                    }
                }
                if (siblings.length >= 5) break;
            }
        }

        return {
            currentNode: node.text,
            nodeType: node.type,
            parentNode: parent ? parent.text.substring(0, 50) + '...' : 'ROOT', // Truncate parent text
            parentType: parent ? parent.type : 'ROOT',
            siblings: siblings,
            kind: node.type // Simplify mapping later
        };
    }
}

registerSingleton(IASTContextService, ASTContextService, InstantiationType.Eager);
