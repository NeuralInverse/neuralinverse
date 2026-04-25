/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ChecksContextBuilder \u2014 gathers workspace context for the Checks Agent system prompt.
 *
 * Modeled after Power Mode's PowerModeContextBuilder. Reads from the filesystem
 * (via IFileService) on each new session run:
 *   - CHECKS.md       \u2192 user-authored compliance agent instructions (like AGENTS.md)
 *   - .inverse/       \u2192 GRC config presence and framework count
 *   - package.json    \u2192 project name for posture labeling
 *   - .git presence   \u2192 isGitRepo flag
 *   - Top-level dirs  \u2192 workspace orientation
 *
 * Results are cached per directory with a 60s TTL.
 */

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';

const CACHE_TTL_MS = 60_000;

export interface IChecksContext {
	isGitRepo: boolean;
	projectName: string;
	workingDirectory: string;
	/** Injected as <custom_instructions> in the system prompt */
	customInstructions: string;
}

interface ICacheEntry {
	context: IChecksContext;
	expiresAt: number;
}

export class ChecksContextBuilder {

	private readonly _cache = new Map<string, ICacheEntry>();

	constructor(private readonly fileService: IFileService) { }

	async build(directory: string): Promise<IChecksContext> {
		const cached = this._cache.get(directory);
		if (cached && Date.now() < cached.expiresAt) {
			return cached.context;
		}
		const context = await this._gather(directory);
		this._cache.set(directory, { context, expiresAt: Date.now() + CACHE_TTL_MS });
		return context;
	}

	invalidate(directory: string): void {
		this._cache.delete(directory);
	}

	// \u2500\u2500\u2500 Private \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _gather(directory: string): Promise<IChecksContext> {
		const [isGitRepo, checksMd, packageJsonRaw, hasInverse, topLevel] = await Promise.all([
			this._exists(directory + '/.git'),
			this._readFile(directory + '/CHECKS.md'),
			this._readFile(directory + '/package.json'),
			this._exists(directory + '/.inverse'),
			this._listTopLevel(directory),
		]);

		const sections: string[] = [];
		let projectName = directory.split('/').pop() ?? 'project';

		// \u2500\u2500 package.json \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		if (packageJsonRaw) {
			try {
				const pkg = JSON.parse(packageJsonRaw) as Record<string, any>;
				if (pkg.name) { projectName = String(pkg.name); }

				const lines: string[] = ['<project>'];
				if (pkg.name) { lines.push(`  name: ${pkg.name}`); }
				if (pkg.description) { lines.push(`  description: ${pkg.description}`); }
				if (pkg.version) { lines.push(`  version: ${pkg.version}`); }
				lines.push('</project>');
				sections.push(lines.join('\n'));
			} catch { /* malformed \u2014 skip */ }
		}

		// \u2500\u2500 .inverse presence \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		if (hasInverse) {
			const inverseFiles = await this._listDir(directory + '/.inverse');
			if (inverseFiles.length > 0) {
				sections.push(`<inverse_config>\n  .inverse/ files: ${inverseFiles.join(', ')}\n</inverse_config>`);
			}
		}

		// \u2500\u2500 Workspace structure \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		if (topLevel.length > 0) {
			sections.push(`<workspace_structure>\n${topLevel.join('\n')}\n</workspace_structure>`);
		}

		// \u2500\u2500 CHECKS.md \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		if (checksMd) {
			const truncated = checksMd.length > 8192
				? checksMd.substring(0, 8192) + '\n[CHECKS.md truncated]'
				: checksMd;
			sections.push(`<checks_md>\n${truncated}\n</checks_md>`);
		}

		return {
			isGitRepo,
			projectName,
			workingDirectory: directory,
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
				'.cache', 'coverage', '__pycache__',
			]);
			return (resolved.children ?? [])
				.filter(c => !IGNORE.has(c.name))
				.sort((a, b) => {
					if (a.isDirectory !== b.isDirectory) { return a.isDirectory ? -1 : 1; }
					return a.name.localeCompare(b.name);
				})
				.slice(0, 30)
				.map(c => `${c.isDirectory ? 'd' : '-'} ${c.name}`);
		} catch {
			return [];
		}
	}

	private async _listDir(path: string): Promise<string[]> {
		try {
			const resolved = await this.fileService.resolve(URI.file(path));
			return (resolved.children ?? []).map(c => c.name).slice(0, 20);
		} catch {
			return [];
		}
	}
}
