/*--------------------------------------------------------------------------------------
 *  Copyright (c) NeuralInverse. All rights reserved.
 *--------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SubAgentTask, SubAgentStatus, SubAgentSpawnRequest, SubAgentRole, SubAgentParentContext } from './subAgentTypes.js';

export interface INeuralInverseSubAgentService {
	readonly _serviceBrand: undefined;
	readonly subAgents: ReadonlyMap<string, SubAgentTask>;
	readonly onDidChangeSubAgent: Event<{ subAgentId: string; status: SubAgentStatus }>;
	readonly runningCount: number;

	setParentContext(context: SubAgentParentContext | null): void;
	getParentContext(): SubAgentParentContext | null;
	spawn(request: SubAgentSpawnRequest): SubAgentTask | null;
	cancel(subAgentId: string): void;
	cancelAll(): void;
	getAllowedToolNames(role: SubAgentRole): string[];
	getResult(subAgentId: string): string | undefined;
}

export const INeuralInverseSubAgentService = createDecorator<INeuralInverseSubAgentService>('neuralInverseSubAgentService');
