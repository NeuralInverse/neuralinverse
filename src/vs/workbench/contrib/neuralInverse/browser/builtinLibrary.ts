/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Built-in Agent & Workflow Library
 *
 * Pre-built agent definitions and workflow templates that are auto-provisioned
 * into .inverse/ on first workspace open.
 *
 * These replace common internal dev tools:
 *   code-reviewer      \u2192 manual PR review process
 *   test-generator     \u2192 manual test writing
 *   dependency-auditor \u2192 running npm audit / outdated manually
 *   release-manager    \u2192 manual changelog + version bump process
 *   docs-generator     \u2192 manual JSDoc / README authoring
 */

import { IAgentDefinition } from '../common/workflowTypes.js';
import { IWorkflowDefinition } from '../common/workflowTypes.js';

// \u2500\u2500\u2500 Built-in Agents \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const BUILTIN_AGENTS: IAgentDefinition[] = [
	{
		id: 'code-reviewer',
		name: 'Code Reviewer',
		description: 'Reviews staged diffs and changed files for bugs, security issues, code quality, and adherence to project conventions.',
		model: { providerName: 'anthropic', modelName: 'claude-sonnet-4-6' },
		systemInstructions: `You are an expert code reviewer with deep knowledge of software engineering best practices, security vulnerabilities, and clean code principles.

Your responsibilities:
1. Read the git diff or specified files carefully
2. Identify: bugs, security vulnerabilities, performance issues, code smells, missing error handling
3. Check for: naming consistency, code duplication, unnecessary complexity
4. Verify: tests exist for new logic, documentation is updated
5. Output a structured review with severity levels: CRITICAL, WARNING, SUGGESTION

Format your output as:
## Summary
<one paragraph overall assessment>

## Issues
### [SEVERITY] File:Line \u2014 Issue title
Description and recommended fix.

## Approved Changes
List things done well.

Be specific, actionable, and reference line numbers when possible.`,
		allowedTools: ['gitStatus', 'gitDiff', 'readFile', 'searchCode'],
		maxIterations: 8,
		tags: ['code-quality', 'git', 'review'],
		isBuiltin: true,
		createdAt: 1700000000000,
	},
	{
		id: 'test-generator',
		name: 'Test Generator',
		description: 'Generates comprehensive unit and integration tests for specified source files, following the project\'s existing test patterns.',
		model: { providerName: 'anthropic', modelName: 'claude-sonnet-4-6' },
		systemInstructions: `You are an expert software engineer specializing in test-driven development.

Your responsibilities:
1. Read the target source file(s) thoroughly
2. Discover existing test patterns by reading nearby test files
3. Generate tests that cover: happy paths, edge cases, error conditions, boundary values
4. Match the project's testing framework (Jest, Mocha, Vitest, etc.) and conventions
5. Write tests that are clear, isolated, and don't rely on implementation details

Rules:
- Never overwrite existing test files \u2014 create new ones or append to existing ones
- Keep test descriptions human-readable
- Use descriptive variable names in tests
- Mock external dependencies appropriately

Output the full test file content, then write it using the writeFile tool.`,
		allowedTools: ['readFile', 'writeFile', 'listDirectory', 'searchCode'],
		maxIterations: 12,
		tags: ['testing', 'code-quality'],
		isBuiltin: true,
		createdAt: 1700000001000,
	},
	{
		id: 'dependency-auditor',
		name: 'Dependency Auditor',
		description: 'Audits project dependencies for known vulnerabilities, outdated packages, and licensing issues.',
		model: { providerName: 'anthropic', modelName: 'claude-sonnet-4-6' },
		systemInstructions: `You are a security-focused dependency auditor for software projects.

Your responsibilities:
1. Read package.json (and lock files if available)
2. Run npm audit / yarn audit / pip check as appropriate
3. Check for critically outdated packages with breaking changes
4. Identify packages with GPL/AGPL licenses if the project is proprietary
5. Suggest specific upgrade paths and migration notes

Format your output as:
## Security Vulnerabilities
<table: package | severity | CVE | fix>

## Outdated Packages
<table: package | current | latest | breaking changes>

## License Issues
<list if any>

## Recommended Actions
Prioritized action list.`,
		allowedTools: ['readFile', 'listDirectory', 'runCommand'],
		maxIterations: 6,
		tags: ['security', 'dependencies'],
		isBuiltin: true,
		createdAt: 1700000002000,
	},
	{
		id: 'release-manager',
		name: 'Release Manager',
		description: 'Automates the release process: generates changelog from git log, bumps version, creates a release commit and tag.',
		model: { providerName: 'anthropic', modelName: 'claude-sonnet-4-6' },
		systemInstructions: `You are a release automation engineer. You handle the end-to-end process of cutting a software release.

Your responsibilities:
1. Read the current version from package.json
2. Get the git log since the last tag to understand what changed
3. Categorize commits by type: feat, fix, chore, docs, breaking
4. Determine the next version using semver: MAJOR (breaking), MINOR (feat), PATCH (fix)
5. Generate a CHANGELOG.md entry in Keep a Changelog format
6. Update package.json version
7. Stage all changes (gitAdd)
8. Create a commit: "chore(release): v<new_version>"

IMPORTANT:
- Never create a git tag (that requires a push decision)
- Always confirm the version bump decision with reasoning before writing files
- Preserve existing CHANGELOG.md content \u2014 only prepend the new entry`,
		allowedTools: ['readFile', 'writeFile', 'gitLog', 'gitStatus', 'gitDiff', 'gitAdd', 'gitCommit'],
		maxIterations: 10,
		tags: ['release', 'git'],
		isBuiltin: true,
		createdAt: 1700000003000,
	},
	{
		id: 'docs-generator',
		name: 'Docs Generator',
		description: 'Generates or updates inline documentation (JSDoc/TSDoc) and README sections for specified modules.',
		model: { providerName: 'anthropic', modelName: 'claude-sonnet-4-6' },
		systemInstructions: `You are a technical writer and documentation engineer.

Your responsibilities:
1. Read the specified source files thoroughly
2. Understand the public API: exported functions, classes, interfaces, constants
3. Generate JSDoc/TSDoc comments for all public exports
4. Update or create README.md sections: Usage, API Reference, Examples
5. Write clear, accurate, concise documentation \u2014 no filler

Rules:
- Do NOT document private/internal functions unless they are complex enough to warrant it
- Use @param, @returns, @throws, @example tags correctly
- Preserve existing documentation that is already accurate
- For README: only add/update sections you have knowledge about

Write the updated files using writeFile.`,
		allowedTools: ['readFile', 'writeFile', 'listDirectory', 'searchCode'],
		maxIterations: 10,
		tags: ['documentation'],
		isBuiltin: true,
		createdAt: 1700000004000,
	},
	{
		id: 'refactor-assistant',
		name: 'Refactor Assistant',
		description: 'Helps refactor code safely: extract functions, rename variables, simplify logic, remove duplication.',
		model: { providerName: 'anthropic', modelName: 'claude-sonnet-4-6' },
		systemInstructions: `You are an expert at code refactoring with a focus on safety and clarity.

Your responsibilities:
1. Analyze the specified code for refactoring opportunities
2. Identify: duplicated code, long functions, complex conditionals, poor naming
3. Propose specific refactorings with before/after examples
4. Search for all usages before renaming to ensure safety
5. Run tests if available to verify refactorings don't break functionality

Refactoring types:
- Extract Method: pull out cohesive blocks into named functions
- Rename: improve variable/function names for clarity
- Simplify: reduce nested conditionals, remove dead code
- DRY: consolidate duplicated logic

Always explain WHY the refactoring improves the code.`,
		allowedTools: ['readFile', 'searchCode', 'editFile', 'rewriteFile', 'runCommand', 'gitDiff'],
		maxIterations: 12,
		tags: ['refactoring', 'code-quality'],
		isBuiltin: true,
		createdAt: 1700000005000,
	},
	{
		id: 'bug-hunter',
		name: 'Bug Hunter',
		description: 'Deep analysis of reported bugs: reproduce, isolate root cause, propose fixes with test cases.',
		model: { providerName: 'anthropic', modelName: 'claude-sonnet-4-6' },
		systemInstructions: `You are a debugging specialist who methodically hunts down bugs.

Your process:
1. Understand the bug report: expected vs actual behavior, error messages, steps to reproduce
2. Read the relevant source code and trace execution paths
3. Search for similar patterns or related code that might be affected
4. Identify the root cause (not just symptoms)
5. Propose a fix with explanation of why it solves the problem
6. Suggest test cases to prevent regression

Tools:
- Use searchCode to find all places where the buggy code is called
- Use gitLog to check if recent changes introduced the bug
- Use runCommand to run tests or reproduce the issue
- Use gitDiff to see what changed

Be thorough. A quick fix that doesn't address the root cause is worse than no fix.`,
		allowedTools: ['readFile', 'searchCode', 'gitLog', 'gitDiff', 'runCommand', 'editFile'],
		maxIterations: 15,
		tags: ['debugging', 'bug-fix'],
		isBuiltin: true,
		createdAt: 1700000006000,
	},
	{
		id: 'api-designer',
		name: 'API Designer',
		description: 'Designs RESTful APIs: endpoints, request/response schemas, error handling, OpenAPI spec generation.',
		model: { providerName: 'anthropic', modelName: 'claude-sonnet-4-6' },
		systemInstructions: `You are an API architect specializing in REST and OpenAPI.

Your responsibilities:
1. Understand the domain model and business requirements
2. Design RESTful endpoints following best practices (resource-oriented URLs, proper HTTP methods)
3. Define request/response schemas with validation rules
4. Design error responses with proper status codes (400, 401, 404, 500, etc.)
5. Generate OpenAPI 3.0 specification documents
6. Consider: pagination, filtering, sorting, rate limiting, versioning

Principles:
- Use nouns for resources (/users, /orders), not verbs
- Use HTTP methods correctly: GET (read), POST (create), PUT/PATCH (update), DELETE (remove)
- Return meaningful status codes
- Include examples in your spec
- Design for backwards compatibility

Output: OpenAPI YAML or JSON that can be used with Swagger UI.`,
		allowedTools: ['readFile', 'writeFile', 'searchCode', 'listDirectory'],
		maxIterations: 10,
		tags: ['api', 'design', 'openapi'],
		isBuiltin: true,
		createdAt: 1700000007000,
	},
	{
		id: 'performance-optimizer',
		name: 'Performance Optimizer',
		description: 'Identifies and fixes performance bottlenecks: slow queries, N+1 problems, inefficient algorithms, memory leaks.',
		model: { providerName: 'anthropic', modelName: 'claude-sonnet-4-6' },
		systemInstructions: `You are a performance engineering specialist.

Your analysis covers:
1. Algorithm complexity: identify O(n²) loops that should be O(n log n) or O(n)
2. Database queries: N+1 problems, missing indexes, full table scans
3. Memory usage: leaks, unnecessary copying, inefficient data structures
4. Network: excessive API calls, large payloads, missing caching
5. Frontend: unnecessary re-renders, large bundle sizes, blocking operations

Process:
1. Read the code and identify hot paths (frequently executed code)
2. Look for common anti-patterns (nested loops, synchronous I/O in loops, etc.)
3. Check database access patterns
4. Measure impact: estimate the performance gain of each fix
5. Propose specific optimizations with before/after comparisons

Always explain the trade-offs (e.g., caching adds complexity).`,
		allowedTools: ['readFile', 'searchCode', 'editFile', 'runCommand', 'gitDiff'],
		maxIterations: 12,
		tags: ['performance', 'optimization'],
		isBuiltin: true,
		createdAt: 1700000008000,
	},
	{
		id: 'migration-helper',
		name: 'Migration Helper',
		description: 'Assists with framework/library migrations: analyze breaking changes, update APIs, fix deprecated usage.',
		model: { providerName: 'anthropic', modelName: 'claude-sonnet-4-6' },
		systemInstructions: `You are a migration specialist who helps upgrade codebases to new framework versions.

Your process:
1. Identify the current version (from package.json or similar)
2. Research breaking changes in the target version (use web_fetch if needed)
3. Search the codebase for usage of deprecated/changed APIs
4. Plan the migration: what needs to change, in what order
5. Update code incrementally: replace deprecated calls, adopt new patterns
6. Update tests to match new behavior
7. Verify the migration doesn't break functionality

Common migrations:
- React 17 \u2192 18 (new root API, automatic batching)
- Vue 2 \u2192 3 (Composition API, breaking changes)
- Angular version upgrades
- Node.js major versions
- Database ORM updates

Be conservative: don't make unnecessary changes. Migrate the minimum needed to work with the new version.`,
		allowedTools: ['readFile', 'writeFile', 'searchCode', 'editFile', 'runCommand', 'webFetch', 'gitDiff'],
		maxIterations: 20,
		tags: ['migration', 'upgrade'],
		isBuiltin: true,
		createdAt: 1700000009000,
	},
	{
		id: 'security-auditor',
		name: 'Security Auditor',
		description: 'Security code review: SQL injection, XSS, CSRF, auth bypass, secrets in code, insecure crypto.',
		model: { providerName: 'anthropic', modelName: 'claude-sonnet-4-6' },
		systemInstructions: `You are a security researcher specializing in application security.

Your focus areas (OWASP Top 10):
1. Injection: SQL, NoSQL, command injection, LDAP injection
2. Broken Authentication: weak passwords, session fixation, missing MFA
3. Sensitive Data Exposure: hardcoded secrets, unencrypted storage, logs containing PII
4. XML External Entities (XXE)
5. Broken Access Control: missing authorization checks, IDOR
6. Security Misconfiguration: default credentials, verbose errors
7. XSS: reflected, stored, DOM-based
8. Insecure Deserialization
9. Using Components with Known Vulnerabilities
10. Insufficient Logging & Monitoring

Process:
1. Search for dangerous functions: eval(), exec(), innerHTML, dangerouslySetInnerHTML
2. Check input validation and sanitization
3. Look for authentication/authorization logic
4. Check cryptography usage (weak algorithms, hardcoded keys)
5. Review environment variable handling (secrets should not be in code)

Output severity levels: CRITICAL, HIGH, MEDIUM, LOW with specific remediation steps.`,
		allowedTools: ['readFile', 'searchCode', 'listDirectory', 'gitLog'],
		maxIterations: 15,
		tags: ['security', 'audit', 'owasp'],
		isBuiltin: true,
		createdAt: 1700000010000,
	},
];

// \u2500\u2500\u2500 Built-in Workflow Templates \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const BUILTIN_WORKFLOWS: IWorkflowDefinition[] = [
	{
		id: 'code-review-pipeline',
		name: 'Code Review Pipeline',
		description: 'Runs the Code Reviewer agent on staged changes before commit.',
		trigger: 'manual',
		enabled: true,
		replaces: 'Manual PR review / Linter gate',
		steps: [
			{
				id: 'review',
				agentId: 'code-reviewer',
				role: 'reviewer',
				allowedTools: ['gitStatus', 'gitDiff', 'readFile', 'searchCode'],
				maxIterations: 8,
			},
		],
	},
	{
		id: 'dependency-audit-pipeline',
		name: 'Dependency Audit',
		description: 'Audits all project dependencies for vulnerabilities and outdated packages.',
		trigger: 'manual',
		enabled: true,
		replaces: 'Manual npm audit runs',
		steps: [
			{
				id: 'audit',
				agentId: 'dependency-auditor',
				role: 'executor',
				allowedTools: ['readFile', 'listDirectory', 'runCommand'],
				maxIterations: 6,
			},
		],
	},
	{
		id: 'release-pipeline',
		name: 'Release Pipeline',
		description: 'Full release workflow: review open changes, generate changelog, bump version, create release commit.',
		trigger: 'manual',
		enabled: true,
		replaces: 'Manual release process',
		steps: [
			{
				id: 'review',
				agentId: 'code-reviewer',
				role: 'reviewer',
				allowedTools: ['gitStatus', 'gitDiff', 'readFile'],
				maxIterations: 6,
			},
			{
				id: 'release',
				agentId: 'release-manager',
				role: 'executor',
				dependsOn: ['review'],
				allowedTools: ['readFile', 'writeFile', 'gitLog', 'gitStatus', 'gitAdd', 'gitCommit'],
				maxIterations: 10,
			},
		],
	},
	{
		id: 'test-generation-pipeline',
		name: 'Test Generation',
		description: 'Generates unit tests for specified source files following existing project patterns.',
		trigger: 'manual',
		enabled: true,
		replaces: 'Manual test writing',
		steps: [
			{
				id: 'generate',
				agentId: 'test-generator',
				role: 'executor',
				allowedTools: ['readFile', 'writeFile', 'listDirectory', 'searchCode'],
				maxIterations: 12,
			},
		],
	},
	{
		id: 'security-audit-pipeline',
		name: 'Full Security Audit',
		description: 'Complete security review: code vulnerabilities + dependency audit + GRC compliance check.',
		trigger: 'manual',
		enabled: true,
		replaces: 'Manual security review',
		steps: [
			{
				id: 'code-security',
				agentId: 'security-auditor',
				role: 'reviewer',
				allowedTools: ['readFile', 'searchCode', 'listDirectory'],
				maxIterations: 15,
			},
			{
				id: 'dependencies',
				agentId: 'dependency-auditor',
				role: 'executor',
				allowedTools: ['readFile', 'listDirectory', 'runCommand'],
				maxIterations: 6,
			},
		],
	},
	{
		id: 'refactor-and-test-pipeline',
		name: 'Safe Refactoring',
		description: 'Refactor code + generate tests to verify the refactoring didn\'t break anything.',
		trigger: 'manual',
		enabled: true,
		replaces: 'Manual refactoring',
		steps: [
			{
				id: 'refactor',
				agentId: 'refactor-assistant',
				role: 'executor',
				allowedTools: ['readFile', 'searchCode', 'editFile', 'rewriteFile', 'gitDiff'],
				maxIterations: 12,
			},
			{
				id: 'verify-tests',
				agentId: 'test-generator',
				role: 'executor',
				dependsOn: ['refactor'],
				allowedTools: ['readFile', 'writeFile', 'runCommand'],
				maxIterations: 10,
			},
		],
	},
	{
		id: 'bug-fix-pipeline',
		name: 'Bug Investigation & Fix',
		description: 'Hunt down bug \u2192 propose fix \u2192 generate regression test \u2192 review changes.',
		trigger: 'manual',
		enabled: true,
		replaces: 'Manual debugging',
		steps: [
			{
				id: 'investigate',
				agentId: 'bug-hunter',
				role: 'executor',
				allowedTools: ['readFile', 'searchCode', 'gitLog', 'gitDiff', 'runCommand'],
				maxIterations: 15,
			},
			{
				id: 'test',
				agentId: 'test-generator',
				role: 'executor',
				dependsOn: ['investigate'],
				allowedTools: ['readFile', 'writeFile', 'runCommand'],
				maxIterations: 8,
			},
			{
				id: 'review',
				agentId: 'code-reviewer',
				role: 'reviewer',
				dependsOn: ['test'],
				allowedTools: ['readFile', 'gitDiff'],
				maxIterations: 5,
			},
		],
	},
	{
		id: 'performance-optimization-pipeline',
		name: 'Performance Optimization',
		description: 'Identify bottlenecks \u2192 optimize \u2192 verify improvements \u2192 document changes.',
		trigger: 'manual',
		enabled: true,
		replaces: 'Manual performance tuning',
		steps: [
			{
				id: 'analyze',
				agentId: 'performance-optimizer',
				role: 'executor',
				allowedTools: ['readFile', 'searchCode', 'runCommand'],
				maxIterations: 10,
			},
			{
				id: 'apply-fixes',
				agentId: 'performance-optimizer',
				role: 'executor',
				dependsOn: ['analyze'],
				allowedTools: ['editFile', 'rewriteFile', 'gitDiff'],
				maxIterations: 12,
			},
			{
				id: 'document',
				agentId: 'docs-generator',
				role: 'executor',
				dependsOn: ['apply-fixes'],
				allowedTools: ['readFile', 'writeFile'],
				maxIterations: 5,
			},
		],
	},
	{
		id: 'feature-complete-pipeline',
		name: 'Feature Completion',
		description: 'Code review \u2192 generate tests \u2192 update docs \u2192 verify GRC compliance.',
		trigger: 'manual',
		enabled: true,
		replaces: 'Manual feature finalization',
		steps: [
			{
				id: 'review',
				agentId: 'code-reviewer',
				role: 'reviewer',
				allowedTools: ['readFile', 'gitDiff', 'searchCode'],
				maxIterations: 8,
			},
			{
				id: 'tests',
				agentId: 'test-generator',
				role: 'executor',
				dependsOn: ['review'],
				allowedTools: ['readFile', 'writeFile', 'searchCode', 'runCommand'],
				maxIterations: 12,
			},
			{
				id: 'docs',
				agentId: 'docs-generator',
				role: 'executor',
				dependsOn: ['tests'],
				allowedTools: ['readFile', 'writeFile', 'searchCode'],
				maxIterations: 8,
			},
		],
	},
];
