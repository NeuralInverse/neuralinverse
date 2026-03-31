/*---------------------------------------------------------------------------------------------
 *  NeuralInverseCC — Bundled Skill Loader
 *
 *  Bridges CC's bundled skill registry into INeuralInverseCCService.
 *  Called once at startup from neuralInverseCC.contribution.ts.
 *
 *  CC skills use:  getPromptForCommand(args, context) → Promise<ContentBlockParam[]>
 *  Our service has: getPromptText(args, context)       → Promise<string>
 *
 *  The adapter extracts `.text` from each ContentBlockParam and joins them.
 *--------------------------------------------------------------------------------------------*/

import type { INeuralInverseCCService } from '../neuralInverseCCService.js';
import type { SkillDefinition, SkillInvocationContext } from '../../common/neuralInverseCCTypes.js';

// ─── CC context adapter ───────────────────────────────────────────────────────

/**
 * Minimal ToolUseContext that CC skill prompts expect.
 * We supply what's safe from VS Code — omit Ink/process-specific fields.
 */
function makeCCContext(ctx: SkillInvocationContext): Record<string, unknown> {
	return {
		workingDirectory: ctx.workingDirectory,
		sessionId: ctx.sessionId,
		agentId: ctx.agentId,
		// Stub fields CC context may access
		options: {},
		abortController: new AbortController(),
	};
}

// ─── ContentBlockParam → string ───────────────────────────────────────────────

function blocksToText(blocks: unknown[]): string {
	return blocks
		.map((b: unknown) => {
			if (typeof b === 'string') { return b; }
			const block = b as Record<string, unknown>;
			if (block.type === 'text' && typeof block.text === 'string') { return block.text; }
			return '';
		})
		.filter(Boolean)
		.join('\n\n');
}

// ─── Individual skill wrappers ────────────────────────────────────────────────

/**
 * Wraps a CC BundledSkillDefinition into our SkillDefinition.
 * Falls back to the description string if getPromptForCommand throws
 * (e.g. because it needs a live filesystem that isn't available).
 */
function wrapCCSkill(cc: {
	name: string;
	description: string;
	aliases?: string[];
	whenToUse?: string;
	argumentHint?: string;
	allowedTools?: string[];
	userInvocable?: boolean;
	getPromptForCommand(args: string, ctx: unknown): Promise<unknown[]>;
}): SkillDefinition {
	return {
		name: cc.name,
		description: cc.description,
		aliases: cc.aliases,
		whenToUse: cc.whenToUse,
		argumentHint: cc.argumentHint,
		allowedTools: cc.allowedTools,
		userInvocable: cc.userInvocable ?? false,
		async getPromptText(args: string, ctx: SkillInvocationContext): Promise<string> {
			try {
				const blocks = await cc.getPromptForCommand(args, makeCCContext(ctx));
				return blocksToText(blocks as unknown[]);
			} catch {
				// Skill has runtime deps unavailable in this context — return description
				return cc.description;
			}
		},
	};
}

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Imports each CC bundled skill individually (avoiding `bun:bundle` feature()
 * calls in the index.ts barrel) and registers them with the service.
 *
 * Skills that are ant-internal (check process.env.USER_TYPE === 'ant') will
 * simply return their description as the prompt — safe to register regardless.
 */
export async function loadCCBundledSkills(service: INeuralInverseCCService): Promise<void> {

	const skillModules = await Promise.allSettled([
		import('../../skills/bundled/batch.js'),
		import('../../skills/bundled/stuck.js'),
		import('../../skills/bundled/debug.js'),
		import('../../skills/bundled/simplify.js'),
		import('../../skills/bundled/remember.js'),
		import('../../skills/bundled/skillify.js'),
		import('../../skills/bundled/keybindings.js'),
		import('../../skills/bundled/updateConfig.js'),
		import('../../skills/bundled/loremIpsum.js'),
	]);

	// Each CC register function mutates an internal registry.
	// We tap into it by temporarily monkey-patching registerBundledSkill.
	const { default: bundledSkillsModule } = await import('../../skills/bundledSkills.js') as unknown as {
		default: undefined;
		registerBundledSkill: (def: unknown) => void;
	};

	void bundledSkillsModule; // unused — see direct approach below
	void skillModules; // imported for side effects

	// ── Direct registration of skills with stable, pure prompts ──────────────
	// These skills have no ant-gating and their prompts don't need live FS.

	service.registerSkill({
		name: 'batch',
		description: 'Orchestrate a large, parallelizable change across the codebase using multiple parallel agents.',
		aliases: [],
		whenToUse: 'When a task can be decomposed into 5–30 independent units that can be worked on in parallel git worktrees.',
		argumentHint: '<instruction>',
		allowedTools: ['Agent', 'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion'],
		userInvocable: true,
		async getPromptText(args) {
			try {
				const mod = await import('../../skills/bundled/batch.js') as unknown as { registerBatchSkill?: () => void; [k: string]: unknown };
				void mod;
				// The prompt is built dynamically in batch.ts — invoke via CC's registry
				const { getBundledSkills } = await import('../../skills/bundledSkills.js') as unknown as { getBundledSkills?: () => unknown[]; [k: string]: unknown };
				const skills = getBundledSkills?.() ?? [];
				const batchSkill = (skills as Array<{ name: string; getPromptForCommand(a: string, c: unknown): Promise<unknown[]> }>)
					.find(s => s.name === 'batch');
				if (batchSkill) {
					const blocks = await batchSkill.getPromptForCommand(args, { workingDirectory: process.cwd(), options: {}, abortController: new AbortController() });
					return blocksToText(blocks as unknown[]);
				}
			} catch { /* fall through */ }
			return `Orchestrate parallel work across the codebase.\n\nInstruction: ${args}`;
		},
	});

	service.registerSkill({
		name: 'stuck',
		description: 'Diagnose a frozen or slow Claude Code / AI session on this machine.',
		aliases: [],
		whenToUse: 'When an AI session appears frozen, is consuming excessive CPU/memory, or is unresponsive.',
		userInvocable: true,
		async getPromptText() {
			try {
				const { getBundledSkills } = await import('../../skills/bundledSkills.js') as unknown as { getBundledSkills?: () => unknown[]; [k: string]: unknown };
				const skills = getBundledSkills?.() ?? [];
				const skill = (skills as Array<{ name: string; getPromptForCommand(a: string, c: unknown): Promise<unknown[]> }>)
					.find(s => s.name === 'stuck');
				if (skill) {
					const blocks = await skill.getPromptForCommand('', { workingDirectory: process.cwd(), options: {}, abortController: new AbortController() });
					return blocksToText(blocks as unknown[]);
				}
			} catch { /* fall through */ }
			return 'Diagnose frozen or slow AI sessions by inspecting running processes, CPU and memory usage.';
		},
	});

	service.registerSkill({
		name: 'debug',
		description: 'Enable debug logging for this session and help diagnose issues.',
		aliases: [],
		whenToUse: 'When the AI is behaving unexpectedly and you need to see detailed logs.',
		argumentHint: '[issue description]',
		allowedTools: ['Read', 'Grep', 'Glob'],
		userInvocable: true,
		async getPromptText(args) {
			try {
				const { getBundledSkills } = await import('../../skills/bundledSkills.js') as unknown as { getBundledSkills?: () => unknown[]; [k: string]: unknown };
				const skills = getBundledSkills?.() ?? [];
				const skill = (skills as Array<{ name: string; getPromptForCommand(a: string, c: unknown): Promise<unknown[]> }>)
					.find(s => s.name === 'debug');
				if (skill) {
					const blocks = await skill.getPromptForCommand(args, { workingDirectory: process.cwd(), options: {}, abortController: new AbortController() });
					return blocksToText(blocks as unknown[]);
				}
			} catch { /* fall through */ }
			return `Enable debug logging and diagnose session issues. Issue: ${args || '(none provided)'}`;
		},
	});

	service.registerSkill({
		name: 'simplify',
		description: 'Review and clean up code changes — remove unnecessary complexity, fix style issues.',
		aliases: [],
		whenToUse: 'After completing a feature or fix to polish the implementation.',
		userInvocable: true,
		async getPromptText() {
			try {
				const { getBundledSkills } = await import('../../skills/bundledSkills.js') as unknown as { getBundledSkills?: () => unknown[]; [k: string]: unknown };
				const skills = getBundledSkills?.() ?? [];
				const skill = (skills as Array<{ name: string; getPromptForCommand(a: string, c: unknown): Promise<unknown[]> }>)
					.find(s => s.name === 'simplify');
				if (skill) {
					const blocks = await skill.getPromptForCommand('', { workingDirectory: process.cwd(), options: {}, abortController: new AbortController() });
					return blocksToText(blocks as unknown[]);
				}
			} catch { /* fall through */ }
			return 'Review recent code changes. Remove unnecessary complexity, dead code, over-engineering. Follow project conventions.';
		},
	});

	service.registerSkill({
		name: 'remember',
		description: 'Store a fact or instruction for recall later in this session or in CLAUDE.md.',
		aliases: [],
		whenToUse: 'When the user wants the AI to remember something for later.',
		argumentHint: '<thing to remember>',
		userInvocable: true,
		async getPromptText(args) {
			return `Store the following for future reference in this session and/or CLAUDE.md:\n\n${args}`;
		},
	});

	// Register the CC skill wrappers for remaining skills using the generic adapter
	const toWrap: Array<{ name: string; description: string; userInvocable?: boolean; argumentHint?: string }> = [
		{ name: 'skillify', description: 'Convert a repeated workflow into a reusable skill.', userInvocable: true, argumentHint: '<workflow description>' },
		{ name: 'keybindings', description: 'Show or update keyboard shortcuts for this IDE.', userInvocable: true },
		{ name: 'updateConfig', description: 'Update AI assistant configuration settings.', userInvocable: true, argumentHint: '<setting> <value>' },
	];

	for (const meta of toWrap) {
		service.registerSkill(wrapCCSkill({
			...meta,
			getPromptForCommand: async (args: string) => [{ type: 'text', text: `${meta.description}\n\nArgs: ${args}` }],
		}));
	}
}
