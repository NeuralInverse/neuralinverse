/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IWorkbenchContribution } from '../../../../../common/contributions.js';
import { IGRCEngineService } from '../services/grcEngineService.js';
import { AstAnalyzer } from './astAnalyzer.js';
import { DataFlowAnalyzer } from './dataFlowAnalyzer.js';
import { ImportGraphAnalyzer } from './importGraphAnalyzer.js';
import { UniversalAnalyzer } from './universalAnalyzer.js';
import { InvariantAnalyzer } from './invariantAnalyzer.js';
import { PythonStructuralAnalyzer } from './pythonStructuralAnalyzer.js';
import { CStructuralAnalyzer } from './cStructuralAnalyzer.js';
import { ICSSecurityAnalyzer } from './icsSecurityAnalyzer.js';
import { TelecomSecurityAnalyzer } from './telecomSecurityAnalyzer.js';
import { IndustrialIotAnalyzer } from './industrialIotAnalyzer.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IContractReasonService } from '../services/contractReasonService.js';
import { ICodebaseContextService } from '../services/codebaseContextService.js';
import { IFirmwareSessionService } from '../../../../neuralInverseFirmware/browser/firmwareSessionService.js';
import { SvdRegisterWriteAnalyzer } from './svdRegisterWriteAnalyzer.js';
import { IMarkerService } from '../../../../../../platform/markers/common/markers.js';
import * as ts from './tsCompilerShim.js';

/**
 * Registers default analyzers with the GRC engine.
 *
 * This contribution runs on startup and plugs the core analyzers
 * (AST, External, Data Flow, Import Graph) into the engine service.
 */
export class GRCAnalyzerRegistration implements IWorkbenchContribution {

	constructor(
		@IGRCEngineService grcEngine: IGRCEngineService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IContractReasonService contractReasonService: IContractReasonService,
		@IFirmwareSessionService firmwareSession: IFirmwareSessionService,
		@ICodebaseContextService codebaseContextService: ICodebaseContextService,
		@IMarkerService markerService: IMarkerService,
	) {
		// Register SVD Firmware Analyzer (for type: "svd-c" rules)
		grcEngine.registerAnalyzer(new SvdRegisterWriteAnalyzer(firmwareSession));

		// Register Universal Analyzer (for type: "universal" rules — all languages)
		grcEngine.registerAnalyzer(new UniversalAnalyzer());

		// Register AST Analyzer (for type: "ast" rules)
		// Inject IMarkerService so constraints like hasTypeError/hasTypeWarning can query
		// live TS compiler diagnostics — catches cross-file type errors the in-process
		// tsCompilerShim misses.
		const astAnalyzer = new AstAnalyzer();
		astAnalyzer.markerService = markerService;
		grcEngine.registerAnalyzer(astAnalyzer);

		// NOTE: External rules (type: "external") are now handled by IExternalToolService,
		// not a synchronous analyzer. ExternalCheckRunner has been removed.

		// Register Data Flow Analyzer (for type: "dataflow" rules)
		grcEngine.registerAnalyzer(new DataFlowAnalyzer());

		// Register Import Graph Analyzer (for type: "import-graph" rules)
		grcEngine.registerAnalyzer(new ImportGraphAnalyzer(workspaceContextService));

		// Register Invariant Analyzer (for type: "invariant" rules — formal verification)
		grcEngine.registerAnalyzer(new InvariantAnalyzer(contractReasonService));

		// Register Python Structural Analyzer (for type: "ast" and "dataflow" rules on Python files)
		grcEngine.registerAnalyzer(new PythonStructuralAnalyzer());
		console.log('[GRCAnalyzerRegistration] Registered Python structural analyzer (ast + dataflow for .py files)');

		// Register C/C++ Structural Analyzer (MISRA C, AUTOSAR, ISO 26262, ISR safety)
		grcEngine.registerAnalyzer(new CStructuralAnalyzer());
		console.log('[GRCAnalyzerRegistration] Registered C/C++ structural analyzer (c-structural rules)');

		// Register ICS/SCADA Security Analyzer (Critical Infrastructure — Energy/Oil/Gas)
		grcEngine.registerAnalyzer(new ICSSecurityAnalyzer());
		console.log('[GRCAnalyzerRegistration] Registered ICS security analyzer (ics-security rules)');

		// Register Telecom Security Analyzer (Telecom & 5G — SIP/GTP/NAS/Diameter/SS7)
		grcEngine.registerAnalyzer(new TelecomSecurityAnalyzer());
		console.log('[GRCAnalyzerRegistration] Registered Telecom security analyzer (telecom-security rules)');

		// Register Industrial IoT/OT Analyzer (IIoT/OT — real-time, PLC, SCADA determinism)
		grcEngine.registerAnalyzer(new IndustrialIotAnalyzer());
		console.log('[GRCAnalyzerRegistration] Registered Industrial IoT/OT analyzer (iot-ot rules)');

		// Trigger codebase context detection on startup
		codebaseContextService.detect().catch(() => { /* non-fatal */ });

		console.log('[GRCAnalyzerRegistration] Registered core analyzers (AST, DataFlow, ImportGraph, Invariant). External rules handled by ExternalToolService.');

		// Smoke test: verify TypeScript compiler is actually loaded
		// This runs after a short delay to give the async loader time to complete
		setTimeout(() => {
			try {
				const testFile = ts.createSourceFile('__smoke_test__.ts', 'const x = 1;', ts.ScriptTarget.Latest, true);
				let foundNode = false;
				testFile.forEachChild(() => { foundNode = true; });
				if (foundNode) {
					console.log('[GRCAnalyzerRegistration] ✓ AST parsing smoke test passed — TypeScript compiler is working');
				} else {
					console.error(
						'[GRCAnalyzerRegistration] ✗ AST parsing smoke test FAILED — TypeScript compiler returned empty AST. ' +
						'AST, DataFlow, and ImportGraph rules will NOT fire. Only regex/file-level checks are active.'
					);
				}
			} catch (e) {
				console.error('[GRCAnalyzerRegistration] ✗ AST smoke test threw error:', e);
			}
		}, 2000);
	}
}
