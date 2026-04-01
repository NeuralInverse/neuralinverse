/*---------------------------------------------------------------------------------------------
 *  NeuralInverseCC contribution — registers the shared CC capability service
 *  and loads all bundled skills from the CC source tree.
 *
 *  Import this file as a side-effect from void.contribution.ts (or the relevant
 *  workbench contribution entry point) to make INeuralInverseCCService available
 *  for injection across all AI systems in the IDE.
 *--------------------------------------------------------------------------------------------*/

// Shim Node.js `process` global for CC source files running in the VS Code renderer sandbox.
// CC source files use process.env.* for feature flags — all default to undefined (falsy) here.
if (typeof (globalThis as any).process === 'undefined') {
	(globalThis as any).process = { env: {} };
}

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { INeuralInverseCCService, NeuralInverseCCService } from './neuralInverseCCService.js';
import { loadCCBundledSkills } from './skills/neuralInverseCCSkillLoader.js';
import './tools/neuralInverseCCToolBridge.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

registerSingleton(INeuralInverseCCService, NeuralInverseCCService, InstantiationType.Delayed);

// ── Load CC bundled skills once the service is instantiated ──────────────────

class NeuralInverseCCSkillContribution implements IWorkbenchContribution {
	static readonly ID = 'neuralInverseCC.skillContribution';
	constructor(
		@INeuralInverseCCService private readonly _ccService: INeuralInverseCCService,
	) {
		console.log('[NeuralInverseCCSkillContribution] Loading skills...');
		loadCCBundledSkills(this._ccService).then(() => {
			console.log('[NeuralInverseCCSkillContribution] Skills loaded successfully');
		}).catch((err) => {
			console.error('[NeuralInverseCCSkillContribution] Failed to load skills:', err);
		});
	}
}

registerWorkbenchContribution2(
	NeuralInverseCCSkillContribution.ID,
	NeuralInverseCCSkillContribution,
	WorkbenchPhase.BlockRestore, // Load skills early, before UI is shown
);
