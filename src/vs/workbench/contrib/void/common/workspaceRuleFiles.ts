/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Workspace rule files (task E1): every repo configured for Claude Code
 * (CLAUDE.md), Codex/agents (AGENTS.md) or Neural Inverse
 * (.neuralinverserules) works without any extra setup.
 *
 * The FILE NAMES are single-sourced from the core prompt config
 * (promptFileLocations.ts) so the native chat's instruction collector and the
 * void/power-mode/workflow readers can never drift apart. The formatting is
 * pure so it is unit-testable in the standalone runner.
 */

import { AGENT_MD_FILENAME, CLAUDE_MD_FILENAME } from '../../chat/common/promptSyntax/config/promptFileLocations.js';

/** Neural Inverse's own rules file — always kept for backward compatibility. */
export const NEURAL_INVERSE_RULES_FILENAME = '.neuralinverserules';

/** Rule file names in injection order (task E1 precedence decision). */
export const WORKSPACE_RULE_FILENAMES: readonly string[] = [
	AGENT_MD_FILENAME,
	CLAUDE_MD_FILENAME,
	NEURAL_INVERSE_RULES_FILENAME,
];

/** Total cap across all rule files, in lines (task E1 plan item 2). */
export const MAX_WORKSPACE_RULES_LINES = 300;

export interface IWorkspaceRuleFile {
	fileName: string;
	content: string;
}

/**
 * Render collected rule files into one guidelines block: each file under its
 * own header, identical contents deduplicated (repos commonly copy AGENTS.md
 * to CLAUDE.md — injecting the same text twice only burns tokens), and the
 * total truncated at {@link MAX_WORKSPACE_RULES_LINES} lines with a marker.
 */
export function formatWorkspaceRuleFiles(files: readonly IWorkspaceRuleFile[]): string {
	const parts: string[] = [];
	const seenContents = new Set<string>();

	for (const { fileName, content } of files) {
		const trimmed = content.trim();
		if (!trimmed) { continue; }
		if (seenContents.has(trimmed)) { continue; }
		seenContents.add(trimmed);
		parts.push(`--- Rules from ${fileName} ---\n${trimmed}`);
	}

	const joined = parts.join('\n\n');
	if (!joined) { return ''; }

	const lines = joined.split('\n');
	if (lines.length <= MAX_WORKSPACE_RULES_LINES) { return joined; }
	return `${lines.slice(0, MAX_WORKSPACE_RULES_LINES).join('\n')}\n[... rules truncated at ${MAX_WORKSPACE_RULES_LINES} lines]`;
}
