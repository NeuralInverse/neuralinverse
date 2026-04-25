/*---------------------------------------------------------------------------------------------
 *  Void IDE Skills Adapter \u2014 bridges CC skills to Void's IDE environment
 *
 *  Adapts CC's bundled skills to work in VSCode's DI system and chat context.
 *  Copyright (c) Neural Inverse Corporation. MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { SkillDefinition } from '../../common/neuralInverseCCTypes.js';

/**
 * Initialize built-in skills for Void IDE.
 * Called from neuralInverseCC.contribution.ts to register IDE-appropriate skills.
 */
export function initializeVoidSkills(): SkillDefinition[] {
	const skills: SkillDefinition[] = [];

	// Note: stuck, debug, simplify, remember are provided by CC bundled skills
	// We only add IDE-specific skills that CC doesn't have

	// \u2500\u2500 /verify \u2014 verify changes work as expected \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	skills.push({
		name: 'verify',
		description: 'Verify code changes work correctly',
		aliases: ['test', 'check'],
		argumentHint: '[what to verify]',
		userInvocable: true,
		async getPromptText(args: string, context: { workingDirectory: string; agentId: string; sessionId: string }) {
			const prompt = `Verification checklist for code changes:

## What to Verify
${args || 'General verification'}

## Verification Steps
1. **Run tests**: Execute relevant test suites
2. **Manual testing**: Test the changed functionality manually
3. **Edge cases**: Test boundary conditions and error handling
4. **Integration**: Ensure changes work with existing code
5. **Performance**: Check for performance regressions
6. **Documentation**: Update docs if behavior changed

Report what you verified and any issues found.`;
			return prompt;
		}
	});

	// \u2500\u2500 /explain \u2014 explain code or concepts \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	skills.push({
		name: 'explain',
		description: 'Explain code, concepts, or architectural decisions',
		aliases: ['doc', 'document', 'why'],
		argumentHint: '[what to explain]',
		async getPromptText(args: string, context: { workingDirectory: string; agentId: string; sessionId: string }) {
			const prompt = `Explanation request:

## Topic
${args || 'Please specify what you want explained'}

## Explanation Structure
1. **Overview**: High-level summary
2. **Purpose**: Why does this exist?
3. **How it works**: Key mechanisms and flow
4. **Key concepts**: Important terms and patterns
5. **Gotchas**: Common misunderstandings or pitfalls
6. **Examples**: Concrete usage examples

Provide a clear, structured explanation suitable for the reader's level.`;
			return prompt;
		}
	});

	// \u2500\u2500 /review \u2014 code review checklist \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	skills.push({
		name: 'review',
		description: 'Comprehensive code review with checklist',
		aliases: ['lint', 'check-code'],
		argumentHint: '[file or changeset]',
		async getPromptText(args: string, context: { workingDirectory: string; agentId: string; sessionId: string }) {
			const prompt = `Code review checklist:

## Target
${args || 'Current changes'}

## Review Criteria
1. **Correctness**: Does it solve the problem correctly?
2. **Style**: Follows project conventions?
3. **Performance**: Any obvious inefficiencies?
4. **Security**: Any security concerns?
5. **Testing**: Adequate test coverage?
6. **Documentation**: Clear comments and docs?
7. **Maintainability**: Easy to understand and modify?

Provide specific feedback with line numbers where applicable.`;
			return prompt;
		}
	});

	// \u2500\u2500 /commit \u2014 help with git commit message \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	skills.push({
		name: 'commit',
		description: 'Generate a clear git commit message',
		aliases: ['commit-msg'],
		argumentHint: '',
		async getPromptText(args: string, context: { workingDirectory: string; agentId: string; sessionId: string }) {
			const prompt = `Generate a clear commit message for the current changes.

## Commit Message Format
\`\`\`
<type>: <short summary>

<optional detailed description>

<optional footer>
\`\`\`

## Types
- feat: New feature
- fix: Bug fix
- refactor: Code restructuring
- docs: Documentation changes
- test: Test additions/changes
- chore: Maintenance tasks

Review the git diff and recent commits to maintain consistency with the project's style.`;
			return prompt;
		}
	});

	// \u2500\u2500 /search \u2014 help with codebase search strategy \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	skills.push({
		name: 'search',
		description: 'Help find code or information in the codebase',
		aliases: ['find', 'locate'],
		argumentHint: '<what to search for>',
		async getPromptText(args: string, context: { workingDirectory: string; agentId: string; sessionId: string }) {
			const prompt = `Search strategy for finding:

${args || 'Please specify what you\'re looking for'}

## Search Approach
1. **Grep**: Search for specific text/patterns in files
2. **Glob**: Find files by name/path patterns
3. **Symbol search**: Look for class/function definitions
4. **References**: Find where something is used
5. **Git history**: Search commit messages/diffs

I'll use appropriate tools to locate what you need.`;
			return prompt;
		}
	});

	// \u2500\u2500 /plan \u2014 create implementation plan \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	skills.push({
		name: 'plan',
		description: 'Create a detailed implementation plan',
		aliases: ['design', 'approach'],
		argumentHint: '<feature or task>',
		async getPromptText(args: string, context: { workingDirectory: string; agentId: string; sessionId: string }) {
			const prompt = `Implementation plan for:

${args || 'Please specify the feature or task'}

## Planning Steps
1. **Requirements**: What needs to be accomplished?
2. **Architecture**: How will it fit into existing code?
3. **Dependencies**: What existing code/APIs are involved?
4. **Risks**: What could go wrong?
5. **Tasks**: Break down into sequential steps
6. **Testing**: How will we verify it works?

Create a clear, actionable plan before starting implementation.`;
			return prompt;
		}
	});

	// \u2500\u2500 /optimize \u2014 performance optimization guidance \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	skills.push({
		name: 'optimize',
		description: 'Analyze and improve code performance',
		aliases: ['perf', 'performance'],
		argumentHint: '[code section]',
		async getPromptText(args: string, context: { workingDirectory: string; agentId: string; sessionId: string }) {
			const prompt = `Performance optimization analysis:

## Target
${args || 'Current code'}

## Optimization Checklist
1. **Profile first**: Measure before optimizing
2. **Hotspots**: Identify bottlenecks
3. **Algorithm complexity**: Can we use better algorithms?
4. **Memory usage**: Reduce allocations/copies
5. **Caching**: Can we cache expensive operations?
6. **Lazy loading**: Defer work until needed
7. **Trade-offs**: Balance speed vs. readability

Focus on significant wins, avoid premature optimization.`;
			return prompt;
		}
	});

	return skills;
}
