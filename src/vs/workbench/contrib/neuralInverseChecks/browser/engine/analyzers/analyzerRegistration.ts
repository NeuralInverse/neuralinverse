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
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IContractReasonService } from '../services/contractReasonService.js';
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
		@IContractReasonService contractReasonService: IContractReasonService
	) {
		// Register Universal Analyzer (for type: "universal" rules — all languages)
		grcEngine.registerAnalyzer(new UniversalAnalyzer());

		// Register AST Analyzer (for type: "ast" rules)
		grcEngine.registerAnalyzer(new AstAnalyzer());

		// NOTE: External rules (type: "external") are now handled by IExternalToolService,
		// not a synchronous analyzer. ExternalCheckRunner has been removed.

		// Register Data Flow Analyzer (for type: "dataflow" rules)
		grcEngine.registerAnalyzer(new DataFlowAnalyzer());

		// Register Import Graph Analyzer (for type: "import-graph" rules)
		grcEngine.registerAnalyzer(new ImportGraphAnalyzer(workspaceContextService));

		// Register Invariant Analyzer (for type: "invariant" rules — formal verification)
		grcEngine.registerAnalyzer(new InvariantAnalyzer(contractReasonService));

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
