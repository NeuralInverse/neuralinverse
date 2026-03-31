/*---------------------------------------------------------------------------------------------
 *  NeuralInverseCC contribution — registers the shared CC capability service
 *  and loads all bundled skills from the CC source tree.
 *
 *  Import this file as a side-effect from void.contribution.ts (or the relevant
 *  workbench contribution entry point) to make INeuralInverseCCService available
 *  for injection across all AI systems in the IDE.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { INeuralInverseCCService, NeuralInverseCCService } from './neuralInverseCCService.js';
import { loadCCBundledSkills } from './skills/neuralInverseCCSkillLoader.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

registerSingleton(INeuralInverseCCService, NeuralInverseCCService, InstantiationType.Delayed);

// ── Load CC bundled skills once the service is instantiated ──────────────────

class NeuralInverseCCSkillContribution implements IWorkbenchContribution {
	static readonly ID = 'neuralInverseCC.skillContribution';
	constructor(
		@INeuralInverseCCService private readonly _ccService: INeuralInverseCCService,
	) {
		loadCCBundledSkills(this._ccService).catch(() => { /* non-fatal */ });
	}
}

registerWorkbenchContribution2(
	NeuralInverseCCSkillContribution.ID,
	NeuralInverseCCSkillContribution,
	WorkbenchPhase.Eventually,
);
