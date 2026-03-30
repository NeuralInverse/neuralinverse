/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VoidFirmwareToolsContrib
 *
 * Workbench contribution that registers firmware agent tools with the
 * VoidInternalToolService, making them available to:
 *   - Void agent (agent mode)
 *   - Void copilot / validate modes
 *   - Power Mode terminal
 *
 * Tools are registered when a firmware session becomes active and
 * unregistered when it ends, so the LLM never sees tools it cannot use.
 *
 * Pattern mirrors VoidDiscoveryToolsContrib in neuralInverseModernisation.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVoidInternalToolService } from '../../void/browser/voidInternalToolService.js';
import { IFirmwareSessionService } from './firmwareSessionService.js';
import { IFirmwareAgentToolService } from './engine/agentTools/firmwareAgentToolService.js';


// Track registered tool names for cleanup
const FW_TOOL_NAMES: string[] = [];


export class VoidFirmwareToolsContrib extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.neuralInverseFirmware.voidFirmwareTools';

	constructor(
		@IVoidInternalToolService       private readonly _internalTools: IVoidInternalToolService,
		@IFirmwareSessionService        private readonly _sessionService: IFirmwareSessionService,
		@IFirmwareAgentToolService      private readonly _agentTools: IFirmwareAgentToolService,
	) {
		super();

		// Cache tool names
		const tools = this._agentTools.getTools();
		FW_TOOL_NAMES.length = 0;
		FW_TOOL_NAMES.push(...tools.map(t => t.name));

		// Register tools if session is already active (e.g. restored from storage)
		if (this._sessionService.session.isActive) {
			this._registerFirmwareTools();
		}

		// React to session lifecycle
		this._register(this._sessionService.onDidChangeSession(s => {
			if (s.isActive) {
				this._registerFirmwareTools();
			} else {
				this._internalTools.unregisterMany(FW_TOOL_NAMES);
			}
		}));
	}

	private _registerFirmwareTools(): void {
		this._internalTools.registerMany(this._agentTools.getTools());
	}
}

registerWorkbenchContribution2(VoidFirmwareToolsContrib.ID, VoidFirmwareToolsContrib, WorkbenchPhase.AfterRestored);
