/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { AgentExecutor, ICancellationToken } from '../../../browser/executor/agentExecutor.js';
import { ToolRegistry } from '../../../browser/tools/toolRegistry.js';
import { IAgentDefinition, IWorkflowStep, IStepRun } from '../../../common/workflowTypes.js';
import { IContextPackerService } from '../../../browser/context/packer/contextPacker.js';
import { IToolExecutionContext } from '../../../common/workflowTypes.js';
import { URI } from '../../../../../../base/common/uri.js';

// ─── Stubs ────────────────────────────────────────────────────────────────────

function makeLLMService(response = 'done'): any {
	return {
		sendLLMMessage: (opts: any) => {
			setTimeout(() => opts.onFinalMessage({ fullText: response }), 0);
		},
	};
}

function makeSettingsService(model = { providerName: 'openai', modelName: 'gpt-4' }): any {
	return {
		state: {
			modelSelectionOfFeature: { Chat: model },
		},
	};
}

function makeStepRun(stepId = 'step-1'): IStepRun {
	return {
		stepId,
		agentId: 'test-agent',
		role: 'executor',
		status: 'pending',
		toolCalls: [],
		outputLog: [],
		iterationsUsed: 0,
	};
}

function makeAgent(opts: Partial<IAgentDefinition> = {}): IAgentDefinition {
	return {
		id: 'test-agent',
		name: 'Test Agent',
		model: { providerName: 'openai', modelName: 'gpt-4' },
		systemInstructions: 'You are a helpful assistant.',
		allowedTools: [],
		...opts,
	};
}

function makeStep(opts: Partial<IWorkflowStep> = {}): IWorkflowStep {
	return {
		id: 'step-1',
		agentId: 'test-agent',
		role: 'executor',
		allowedTools: [],
		...opts,
	};
}

function makeCtx(): IToolExecutionContext {
	return {
		workspaceUri: URI.parse('file:///workspace'),
		fileService: {} as any,
		log: () => {},
	};
}

function makeNotCancelled(): ICancellationToken {
	return { cancelled: false };
}

function makePacker(context: string, throws = false): IContextPackerService {
	return {
		_serviceBrand: undefined as any,
		pack: async () => ({ sections: [], totalTokens: 0, budgetUsed: 0, budgetTotal: 0, truncated: false, filesIncluded: [], filesSkipped: [] }),
		packToString: async () => {
			if (throws) { throw new Error('packer error'); }
			return context;
		},
		estimateTokens: (t) => Math.ceil(t.length / 3.5),
		getDefaultBudget: () => 16384,
	};
}

function makeScopedTools(toolNames: string[] = []): ToolRegistry {
	const registry = new ToolRegistry();
	for (const name of toolNames) {
		registry.register({
			name,
			description: `Tool ${name}`,
			parameters: {},
			execute: async () => ({ success: true, output: `${name} result` }),
		});
	}
	return registry;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

suite('AgentExecutor — context pre-injection (default ON)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('context packer is called and result is included in system prompt', async () => {
		let packerCalled = false;
		const packer: IContextPackerService = {
			...makePacker('INJECTED_WORKSPACE_CONTEXT'),
			packToString: async () => { packerCalled = true; return 'INJECTED_WORKSPACE_CONTEXT'; },
		};

		let capturedSystemPrompt = '';
		const llm = {
			sendLLMMessage: (opts: any) => {
				const systemMsg = opts.messages.find((m: any) => m.role === 'system');
				capturedSystemPrompt = systemMsg?.content ?? '';
				setTimeout(() => opts.onFinalMessage({ fullText: 'done' }), 0);
			},
		};

		const registry = makeScopedTools();
		const executor = new AgentExecutor(
			llm as any,
			makeSettingsService(),
			registry.scope([]),
			packer,
		);

		const stepRun = makeStepRun();
		await executor.execute(
			makeAgent(),
			makeStep(),
			stepRun,
			[],
			makeCtx(),
			'What does this code do?',
			makeNotCancelled(),
		);

		assert.ok(packerCalled, 'context packer should be called by default');
		assert.ok(capturedSystemPrompt.includes('INJECTED_WORKSPACE_CONTEXT'), 'system prompt should include injected context');
	});

	test('context packer is called with query type "message"', async () => {
		let capturedRequest: any;
		const packer: IContextPackerService = {
			...makePacker('ctx'),
			packToString: async (req) => { capturedRequest = req; return 'ctx'; },
		};

		const executor = new AgentExecutor(
			makeLLMService() as any,
			makeSettingsService(),
			makeScopedTools().scope([]),
			packer,
		);

		await executor.execute(makeAgent(), makeStep(), makeStepRun(), [], makeCtx(), 'my input', makeNotCancelled());

		assert.ok(capturedRequest);
		assert.strictEqual(capturedRequest.query.type, 'message');
		assert.strictEqual(capturedRequest.query.text, 'my input');
	});

	test('context packer uses "agent" mode by default', async () => {
		let capturedMode: string | undefined;
		const packer: IContextPackerService = {
			...makePacker('ctx'),
			packToString: async (req) => { capturedMode = req.mode; return 'ctx'; },
		};

		const executor = new AgentExecutor(
			makeLLMService() as any,
			makeSettingsService(),
			makeScopedTools().scope([]),
			packer,
		);

		await executor.execute(makeAgent(), makeStep(), makeStepRun(), [], makeCtx(), 'input', makeNotCancelled());
		assert.strictEqual(capturedMode, 'agent');
	});
});

suite('AgentExecutor — disableAutoContext skips injection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('packer is NOT called when contextConfig.disableAutoContext is true', async () => {
		let packerCalled = false;
		const packer: IContextPackerService = {
			...makePacker('ctx'),
			packToString: async () => { packerCalled = true; return 'ctx'; },
		};

		const executor = new AgentExecutor(
			makeLLMService() as any,
			makeSettingsService(),
			makeScopedTools().scope([]),
			packer,
		);

		const step = makeStep({ contextConfig: { mode: 'agent', disableAutoContext: true } });
		await executor.execute(makeAgent(), step, makeStepRun(), [], makeCtx(), 'input', makeNotCancelled());

		assert.ok(!packerCalled, 'packer should not be called when disableAutoContext=true');
	});

	test('system prompt does not include workspace context section when disabled', async () => {
		let capturedSystemPrompt = '';
		const llm = {
			sendLLMMessage: (opts: any) => {
				const msg = opts.messages.find((m: any) => m.role === 'system');
				capturedSystemPrompt = msg?.content ?? '';
				setTimeout(() => opts.onFinalMessage({ fullText: 'done' }), 0);
			},
		};

		const executor = new AgentExecutor(
			llm as any,
			makeSettingsService(),
			makeScopedTools().scope([]),
			makePacker('SHOULD_NOT_APPEAR'),
		);

		const step = makeStep({ contextConfig: { mode: 'agent', disableAutoContext: true } });
		await executor.execute(makeAgent(), step, makeStepRun(), [], makeCtx(), 'input', makeNotCancelled());

		assert.ok(!capturedSystemPrompt.includes('SHOULD_NOT_APPEAR'), 'disabled context should not appear in prompt');
		assert.ok(!capturedSystemPrompt.includes('Workspace Context'), 'workspace context section should not be present when disabled');
	});
});

suite('AgentExecutor — priorityFiles passed through', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('priorityFiles from contextConfig are forwarded to packer', async () => {
		let capturedPriorityFiles: string[] | undefined;
		const packer: IContextPackerService = {
			...makePacker('ctx'),
			packToString: async (req) => { capturedPriorityFiles = req.priorityFiles; return 'ctx'; },
		};

		const executor = new AgentExecutor(
			makeLLMService() as any,
			makeSettingsService(),
			makeScopedTools().scope([]),
			packer,
		);

		const priorityFiles = ['src/auth.ts', 'src/service.ts'];
		const step = makeStep({ contextConfig: { mode: 'agent', priorityFiles } });
		await executor.execute(makeAgent(), step, makeStepRun(), [], makeCtx(), 'input', makeNotCancelled());

		assert.deepStrictEqual(capturedPriorityFiles, priorityFiles);
	});
});

suite('AgentExecutor — packer failure is non-fatal', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('step still completes when context packer throws', async () => {
		const throwingPacker = makePacker('', true);

		const executor = new AgentExecutor(
			makeLLMService('all done') as any,
			makeSettingsService(),
			makeScopedTools().scope([]),
			throwingPacker,
		);

		const stepRun = makeStepRun();
		await executor.execute(makeAgent(), makeStep(), stepRun, [], makeCtx(), 'input', makeNotCancelled());

		assert.strictEqual(stepRun.status, 'done', 'step should still complete when packer fails');
		assert.strictEqual(stepRun.finalOutput, 'all done');
	});

	test('system prompt does not have workspace context section when packer throws', async () => {
		let capturedSystemPrompt = '';
		const llm = {
			sendLLMMessage: (opts: any) => {
				const msg = opts.messages.find((m: any) => m.role === 'system');
				capturedSystemPrompt = msg?.content ?? '';
				setTimeout(() => opts.onFinalMessage({ fullText: 'done' }), 0);
			},
		};

		const executor = new AgentExecutor(
			llm as any,
			makeSettingsService(),
			makeScopedTools().scope([]),
			makePacker('', true),
		);

		await executor.execute(makeAgent(), makeStep(), makeStepRun(), [], makeCtx(), 'input', makeNotCancelled());

		assert.ok(!capturedSystemPrompt.includes('Workspace Context'), 'packer failure: workspace context section should not appear');
	});

	test('no context packer provided: step executes without workspace context', async () => {
		const executor = new AgentExecutor(
			makeLLMService('response') as any,
			makeSettingsService(),
			makeScopedTools().scope([]),
			// no context packer
		);

		const stepRun = makeStepRun();
		await executor.execute(makeAgent(), makeStep(), stepRun, [], makeCtx(), 'input', makeNotCancelled());

		assert.strictEqual(stepRun.status, 'done');
	});
});

suite('AgentExecutor — contextConfig.budget forwarded', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('contextConfig.budget overrides default packer budget', async () => {
		let capturedBudget: number | undefined;
		const packer: IContextPackerService = {
			...makePacker('ctx'),
			packToString: async (req) => { capturedBudget = req.budget; return 'ctx'; },
			getDefaultBudget: () => 16384,
		};

		const executor = new AgentExecutor(
			makeLLMService() as any,
			makeSettingsService(),
			makeScopedTools().scope([]),
			packer,
		);

		const step = makeStep({ contextConfig: { mode: 'agent', budget: 4096 } });
		await executor.execute(makeAgent(), step, makeStepRun(), [], makeCtx(), 'input', makeNotCancelled());

		assert.strictEqual(capturedBudget, 4096);
	});
});
