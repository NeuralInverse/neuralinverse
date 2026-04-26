/*---------------------------------------------------------------------------------------------
 *  NeuralInverseCC contribution \u2014 registers the shared CC capability service
 *  and loads all bundled skills from the CC source tree.
 *
 *  Import this file as a side-effect from void.contribution.ts (or the relevant
 *  workbench contribution entry point) to make INeuralInverseCCService available
 *  for injection across all AI systems in the IDE.
 *--------------------------------------------------------------------------------------------*/

// Shim Node.js `process` global for CC source files running in the VS Code renderer sandbox.
// CC source files use process.env/stdout/stdin \u2014 provide safe stubs for the renderer sandbox.
if (typeof (globalThis as any).process === 'undefined') {
	(globalThis as any).process = { env: {} };
}
const _proc = (globalThis as any).process;
if (!_proc.stdout) { _proc.stdout = { write: () => true, isTTY: false, columns: 80, rows: 24, on: () => _proc.stdout, once: () => _proc.stdout, removeListener: () => _proc.stdout }; }
if (!_proc.stderr) { _proc.stderr = { write: () => true, isTTY: false, on: () => _proc.stderr, once: () => _proc.stderr, removeListener: () => _proc.stderr }; }
if (!_proc.stdin)  { _proc.stdin  = { on: () => _proc.stdin, once: () => _proc.stdin, removeListener: () => _proc.stdin, resume: () => {}, pause: () => {}, isTTY: false }; }
if (!_proc.exit)   { _proc.exit = () => {}; }
if (!_proc.platform) { _proc.platform = 'linux'; }
if (!_proc.version)  { _proc.version = 'v20.0.0'; }

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { INeuralInverseCCService, NeuralInverseCCService } from './neuralInverseCCService.js';
import { loadCCBundledSkills } from './skills/neuralInverseCCSkillLoader.js';
import './tools/neuralInverseCCToolBridge.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

registerSingleton(INeuralInverseCCService, NeuralInverseCCService, InstantiationType.Delayed);

// \u2500\u2500 Load CC bundled skills once the service is instantiated \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

class NeuralInverseCCSkillContribution implements IWorkbenchContribution {
	static readonly ID = 'neuralInverseCC.skillContribution';
	constructor(
		@INeuralInverseCCService private readonly _ccService: INeuralInverseCCService,
	) {
		// Load additional skills asynchronously (basic skills already registered in service constructor)
		loadCCBundledSkills(this._ccService).catch(() => { /* non-fatal */ });
	}
}

registerWorkbenchContribution2(
	NeuralInverseCCSkillContribution.ID,
	NeuralInverseCCSkillContribution,
	WorkbenchPhase.Eventually,
);
