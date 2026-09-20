/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVoidModelService } from '../common/voidModelService.js';
import { AGENT_CONFIG_FILENAME } from '../common/neuralInverseAgentConfigTypes.js';
import { WORKSPACE_RULE_FILENAMES } from '../common/workspaceRuleFiles.js';

class ConvertContribWorkbenchContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.void.convertcontrib';
	_serviceBrand: undefined;

	constructor(
		@IVoidModelService private readonly voidModelService: IVoidModelService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
	) {
		super();

		const initializeURI = (uri: URI) => {
			this.workspaceContext.getWorkspace();

			// F09: pre-load ALL rule files, not just .neuralinverserules — the
			// sync rules reader (Ctrl+K / FIM paths) can only see initialized
			// models, and AGENTS.md / CLAUDE.md were silently dropped in fresh
			// workspaces until something opened them. The chat and native-chat
			// paths additionally read from disk (async), so unsaved edits still
			// win wherever they can exist.
			for (const fileName of WORKSPACE_RULE_FILENAMES) {
				this.voidModelService.initializeModel(URI.joinPath(uri, fileName));
			}

			// Pre-load .neuralinverseagent config so it's available for agent mode
			const agentConfigURI = URI.joinPath(uri, AGENT_CONFIG_FILENAME);
			this.voidModelService.initializeModel(agentConfigURI);
		};

		// call
		this._register(this.workspaceContext.onDidChangeWorkspaceFolders((e) => {
			[...e.changed, ...e.added].forEach(w => { initializeURI(w.uri); });
		}));
		this.workspaceContext.getWorkspace().folders.forEach(w => { initializeURI(w.uri); });
	}
}


registerWorkbenchContribution2(ConvertContribWorkbenchContribution.ID, ConvertContribWorkbenchContribution, WorkbenchPhase.BlockRestore);
