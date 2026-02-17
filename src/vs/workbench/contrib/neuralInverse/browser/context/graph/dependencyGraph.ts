/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ITextModel } from '../../../../../../editor/common/model.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';

export const IDependencyGraphService = createDecorator<IDependencyGraphService>('neuralInverseDependencyGraphService');

export interface IDependencyGraphService {
    readonly _serviceBrand: undefined;
    getAllowedCalls(model: ITextModel): Promise<string[]>;
}

export class DependencyGraphService extends Disposable implements IDependencyGraphService {
    _serviceBrand: undefined;

    constructor() {
        super();
    }

    public async getAllowedCalls(model: ITextModel): Promise<string[]> {
        // Simple Regex-based import scanner for MVP
        // Matches: import { Foo, Bar } from 'module'; OR import * as Foo from 'module';
        // TODO: Use TreeSitter for robust parsing in Phase 4.5

        const allowed: Set<string> = new Set();
        const text = model.getValue();

        // 1. Match named imports: import { A, B }
        const namedImportRegex = /import\s*{([^}]+)}\s*from/g;
        let match;
        while ((match = namedImportRegex.exec(text)) !== null) {
            const imports = match[1].split(',').map(s => s.trim());
            imports.forEach(i => {
                if (i) allowed.add(i);
            });
        }

        // 2. Match namespace imports: import * as X
        const namespaceImportRegex = /import\s*\*\s*as\s+(\w+)\s*from/g;
        while ((match = namespaceImportRegex.exec(text)) !== null) {
            allowed.add(match[1]);
        }

        // 3. Match default imports: import X from
        const defaultImportRegex = /import\s+(\w+)\s*from/g;
        while ((match = defaultImportRegex.exec(text)) !== null) {
            // Avoid "import { }" false positive
            if (match[1] !== '{') {
                allowed.add(match[1]);
            }
        }

        // Always allow standard built-ins if not explicitly forbidden by policy (handled elsewhere)
        allowed.add('console');
        allowed.add('Math');
        allowed.add('JSON');
        allowed.add('Promise');

        return Array.from(allowed);
    }
}

registerSingleton(IDependencyGraphService, DependencyGraphService, InstantiationType.Eager);
