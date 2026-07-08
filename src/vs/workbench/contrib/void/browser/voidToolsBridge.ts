/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVoidInternalToolService, IVoidInternalTool } from './voidInternalToolService.js';
import { ILanguageModelToolsService, IToolImpl, IToolData, IToolResult, ToolDataSource } from '../../chat/common/tools/languageModelToolsService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';

/**
 * Bridges void's IVoidInternalToolService into VS Code's ILanguageModelToolsService,
 * making firmware/modernisation tools available in Copilot's agent mode.
 */
class VoidToolsBridge extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voidToolsBridge';

	private readonly _registrations = this._register(new DisposableMap<string>());

	constructor(
		@IVoidInternalToolService private readonly _voidToolService: IVoidInternalToolService,
		@ILanguageModelToolsService private readonly _lmToolsService: ILanguageModelToolsService,
	) {
		super();
		this._syncTools();
		this._register(this._voidToolService.onDidChangeTools(() => this._syncTools()));
	}

	private _syncTools(): void {
		const currentTools = new Set<string>();

		for (const toolInfo of this._voidToolService.getToolInfos()) {
			currentTools.add(toolInfo.name);
			if (!this._registrations.has(toolInfo.name)) {
				this._registerTool(toolInfo.name);
			}
		}

		// Remove tools that are no longer registered
		for (const name of this._registrations.keys()) {
			if (!currentTools.has(name)) {
				this._registrations.deleteAndDispose(name);
			}
		}
	}

	private _registerTool(name: string): void {
		const tool = this._voidToolService.getTool(name);
		if (!tool) {
			return;
		}

		const toolData: IToolData = {
			id: `ni_${name}`,
			source: ToolDataSource.Internal,
			displayName: name,
			modelDescription: tool.description,
			inputSchema: this._buildSchema(tool),
			canBeReferencedInPrompt: true,
		};

		const toolImpl: IToolImpl = {
			invoke: async (_invocation, _countTokens, _progress, _token: CancellationToken): Promise<IToolResult> => {
				const currentTool = this._voidToolService.getTool(name);
				if (!currentTool) {
					return { content: [{ kind: 'text', value: `Tool "${name}" is no longer available.` }] };
				}
				const args = _invocation.parameters ?? {};
				const result = await currentTool.execute(args);
				return { content: [{ kind: 'text', value: result }] };
			}
		};

		this._registrations.set(name, this._lmToolsService.registerTool(toolData, toolImpl));
	}

	private _buildSchema(tool: IVoidInternalTool): object {
		const properties: Record<string, object> = {};
		for (const [paramName, paramDef] of Object.entries(tool.params)) {
			properties[paramName] = {
				type: 'string',
				description: paramDef.description,
			};
		}
		return {
			type: 'object',
			properties,
		};
	}
}

registerWorkbenchContribution2(VoidToolsBridge.ID, VoidToolsBridge, WorkbenchPhase.AfterRestored);
