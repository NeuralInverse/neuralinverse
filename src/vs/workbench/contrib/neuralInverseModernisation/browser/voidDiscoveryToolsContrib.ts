/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VoidDiscoveryToolsContrib
 *
 * Workbench contribution that registers discovery, modernisation, and autonomy
 * tools with the VoidInternalToolService, making them available to:
 *   - Void agent (agent mode)
 *   - Void copilot / validate modes
 *
 * ## Tool groups registered
 *
 *   Always active (any codebase):
 *     - Discovery tools        (scan, explore, detect languages, extract metadata)
 *     - Modernisation tools    (planning, roadmap, session info)
 *     - KB tools               (all 67 \u2014 units, decisions, glossary, progress, etc.)
 *     - Autonomy default tools (status, preview, escalations, resolve, run-single, history)
 *
 *   Session-active only (when a modernisation session with source+target is open):
 *     - Autonomy batch-control tools (start_batch, pause_batch, resume_batch, stop_batch)
 *
 * Session-only tools are registered when the session becomes active and
 * unregistered when it closes, so the LLM never sees tools it cannot meaningfully use.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVoidInternalToolService, IVoidInternalTool } from '../../void/browser/voidInternalToolService.js';
import { IDiscoveryService } from './engine/discovery/discoveryService.js';
import { IMigrationPlannerService } from './engine/migrationPlannerService.js';
import { IModernisationSessionService } from './modernisationSessionService.js';
import { IModernisationAgentToolService } from './engine/agentTools/service.js';
import { IAgentToolDefinition } from './engine/agentTools/agentToolTypes.js';
import { buildDiscoveryTools } from '../../powerMode/browser/tools/discoveryTools.js';
import { buildModernisationPowerTools } from '../../powerMode/browser/tools/modernisationTools.js';
import { IPowerTool, IToolContext } from '../../powerMode/common/powerModeTypes.js';


// \u2500\u2500\u2500 IPowerTool \u2192 IVoidInternalTool adapter \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const _dummyCtx: IToolContext = {
	sessionId: 'void-internal',
	messageId: 'void-internal',
	agentId:   'void-internal',
	abort:     new AbortController().signal,
	metadata:  () => {},
};

function _adaptPowerTool(tool: IPowerTool): IVoidInternalTool {
	const params: Record<string, { description: string }> = {};
	for (const p of tool.parameters) {
		params[p.name] = { description: p.description };
	}
	return {
		name:        tool.id,
		description: tool.description,
		params,
		async execute(args) {
			const result = await tool.execute(args, _dummyCtx);
			return result.output;
		},
	};
}


// \u2500\u2500\u2500 IAgentToolDefinition \u2192 IVoidInternalTool adapter \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _adaptAgentTool(def: IAgentToolDefinition, agentTools: IModernisationAgentToolService): IVoidInternalTool {
	const props = (def.inputSchema?.properties ?? {}) as Record<string, { description?: string }>;
	const params: Record<string, { description: string }> = {};
	for (const [key, val] of Object.entries(props)) {
		params[key] = { description: val.description ?? key };
	}
	return {
		name:        def.name,
		description: def.description,
		params,
		execute(args) {
			return agentTools.executeTool(def.name, args);
		},
	};
}


// \u2500\u2500\u2500 Session-only tool names \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

// Track KB + autonomy tool names for session-based registration/unregistration
let KB_AND_AUTONOMY_TOOL_NAMES: string[] = [];


// \u2500\u2500\u2500 Contribution \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class VoidDiscoveryToolsContrib extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.neuralInverseModernisation.voidDiscoveryTools';

	constructor(
		@IVoidInternalToolService       private readonly _internalTools: IVoidInternalToolService,
		@IDiscoveryService              discoveryService: IDiscoveryService,
		@IMigrationPlannerService       plannerService: IMigrationPlannerService,
		@IModernisationSessionService   sessionService: IModernisationSessionService,
		@IModernisationAgentToolService private readonly _agentTools: IModernisationAgentToolService,
	) {
		super();

		// \u2500\u2500 Always-on tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

		// Discovery tools (useful for any codebase \u2014 scan, explore, detect)
		_internalTools.registerMany(buildDiscoveryTools(discoveryService).map(_adaptPowerTool));

		// Migration planning tools (roadmap, session context)
		_internalTools.registerMany(
			buildModernisationPowerTools(discoveryService, plannerService, sessionService).map(_adaptPowerTool),
		);

		// \u2500\u2500 Session-reactive KB + autonomy tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

		// Store tool names for unregistration
		const kbAndAutonomyTools = _agentTools.getContextualToolDefinitions(true);
		KB_AND_AUTONOMY_TOOL_NAMES = kbAndAutonomyTools.map(d => d.name);

		// Only register KB + autonomy tools when session is active
		if (sessionService.session.isActive) {
			this._registerSessionKBTools();
		}

		this._register(sessionService.onDidChangeSession(s => {
			if (s.isActive) {
				this._registerSessionKBTools();
			} else {
				// Unregister all KB + autonomy tools when session closes
				_internalTools.unregisterMany(KB_AND_AUTONOMY_TOOL_NAMES);
			}
		}));
	}

	/**
	 * Register all KB tools + autonomy tools (67 KB tools + 10 autonomy tools).
	 * Only called when a modernisation session is active.
	 */
	private _registerSessionKBTools(): void {
		const allTools = this._agentTools.getContextualToolDefinitions(true);
		this._internalTools.registerMany(
			allTools.map(d => _adaptAgentTool(d, this._agentTools)),
		);
	}
}

registerWorkbenchContribution2(VoidDiscoveryToolsContrib.ID, VoidDiscoveryToolsContrib, WorkbenchPhase.AfterRestored);
