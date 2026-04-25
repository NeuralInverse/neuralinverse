/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

/**
 * PowerModeContextBuilder — gathers workspace context for the agent system prompt.
 *
 * Reads from the filesystem (via IFileService) on each new session run:
 *   - AGENTS.md  \u2192 user-authored agent instructions
 *   - package.json \u2192 project name, description, available scripts
 *   - tsconfig.json \u2192 confirms TypeScript project
 *   - .git presence \u2192 isGitRepo flag
 *   - Top-level directory structure \u2192 workspace orientation
 *
 * Results are cached per directory with a TTL so repeated sendMessage calls
 * in the same session don't hit the filesystem every time.
 */

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';

const CACHE_TTL_MS = 60_000; // 1 minute

export interface IWorkspaceContext {
	isGitRepo: boolean;
	projectName: string;
	/** Formatted block injected as <custom_instructions> in the system prompt */
	customInstructions: string;
}

interface ICacheEntry {
	context: IWorkspaceContext;
	expiresAt: number;
}

export class PowerModeContextBuilder {

	private readonly _cache = new Map<string, ICacheEntry>();

	constructor(private readonly fileService: IFileService) { }

	/** Build (or return cached) workspace context for the given directory. */
	async build(directory: string): Promise<IWorkspaceContext> {
		const cached = this._cache.get(directory);
		if (cached && Date.now() < cached.expiresAt) {
			return cached.context;
		}

		const context = await this._gather(directory);
		this._cache.set(directory, { context, expiresAt: Date.now() + CACHE_TTL_MS });
		return context;
	}

	/** Invalidate cache for a directory (e.g. after framework changes). */
	invalidate(directory: string): void {
		this._cache.delete(directory);
	}

	// ─── Private ─────────────────────────────────────────────────────────────

	private async _gather(directory: string): Promise<IWorkspaceContext> {
		const [isGitRepo, agentsMd, packageJsonRaw, hasTsConfig, topLevel] = await Promise.all([
			this._exists(directory + '/.git'),
			this._readFile(directory + '/AGENTS.md'),
			this._readFile(directory + '/package.json'),
			this._exists(directory + '/tsconfig.json'),
			this._listTopLevel(directory),
		]);

		const sections: string[] = [];
		let projectName = directory.split('/').pop() ?? 'project';

		// ── package.json ──────────────────────────────────────────────────
		if (packageJsonRaw) {
			try {
				const pkg = JSON.parse(packageJsonRaw) as Record<string, any>;
				if (pkg.name) { projectName = String(pkg.name); }

				const lines: string[] = ['<project>'];
				if (pkg.name) { lines.push(`  name: ${pkg.name}`); }
				if (pkg.description) { lines.push(`  description: ${pkg.description}`); }
				if (pkg.version) { lines.push(`  version: ${pkg.version}`); }
				if (hasTsConfig) { lines.push(`  language: TypeScript`); }
				if (pkg.scripts && typeof pkg.scripts === 'object') {
					const scriptNames = Object.keys(pkg.scripts).slice(0, 12).join(', ');
					lines.push(`  scripts: ${scriptNames}`);
				}
				if (pkg.dependencies) {
					const deps = Object.keys(pkg.dependencies).slice(0, 15).join(', ');
					lines.push(`  dependencies: ${deps}`);
				}
				lines.push('</project>');
				sections.push(lines.join('\n'));
			} catch { /* malformed package.json — skip */ }
		}

		// ── Workspace structure ───────────────────────────────────────────
		if (topLevel.length > 0) {
			sections.push(`<workspace_structure>\n${topLevel.join('\n')}\n</workspace_structure>`);
		}

		// ── AGENTS.md ─────────────────────────────────────────────────────
		if (agentsMd) {
			// Truncate to 8KB to avoid bloating the prompt
			const truncated = agentsMd.length > 8192
				? agentsMd.substring(0, 8192) + '\n[AGENTS.md truncated]'
				: agentsMd;
			sections.push(`<agents_md>\n${truncated}\n</agents_md>`);
		}

		return {
			isGitRepo,
			projectName,
			customInstructions: sections.join('\n\n'),
		};
	}

	private async _exists(path: string): Promise<boolean> {
		try {
			await this.fileService.stat(URI.file(path));
			return true;
		} catch {
			return false;
		}
	}

	private async _readFile(path: string): Promise<string | undefined> {
		try {
			const content = await this.fileService.readFile(URI.file(path));
			return content.value.toString();
		} catch {
			return undefined;
		}
	}

	private async _listTopLevel(directory: string): Promise<string[]> {
		try {
			const resolved = await this.fileService.resolve(URI.file(directory));
			const IGNORE = new Set([
				'node_modules', '.git', '.next', 'dist', 'build', 'out',
				'.cache', 'coverage', '.nyc_output', '__pycache__',
			]);
			return (resolved.children ?? [])
				.filter(c => !IGNORE.has(c.name))
				.sort((a, b) => {
					// Directories first, then files
					if (a.isDirectory !== b.isDirectory) { return a.isDirectory ? -1 : 1; }
					return a.name.localeCompare(b.name);
				})
				.slice(0, 40)
				.map(c => `${c.isDirectory ? 'd' : '-'} ${c.name}`);
		} catch {
			return [];
		}
	}
}
