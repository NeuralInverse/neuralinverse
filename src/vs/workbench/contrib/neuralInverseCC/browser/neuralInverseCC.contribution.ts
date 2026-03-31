/*---------------------------------------------------------------------------------------------
 *  NeuralInverseCC contribution — registers the shared CC capability service.
 *
 *  Import this file as a side-effect from void.contribution.ts (or the relevant
 *  workbench contribution entry point) to make INeuralInverseCCService available
 *  for injection across all AI systems in the IDE.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { INeuralInverseCCService, NeuralInverseCCService } from './neuralInverseCCService.js';

registerSingleton(INeuralInverseCCService, NeuralInverseCCService, InstantiationType.Delayed);
