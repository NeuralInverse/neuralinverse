/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * One-time import of legacy `.void-memory/*.md` files (task M7)
 *
 * Before M7 unified memory on agentMemoryService, the memory_write tool was
 * the only store the model could write to and it wrote loose
 * `.void-memory/<key>.md` files — invisible to hybrid semantic recall, so the
 * M2 engine ran on an empty store (owner live test, 2026-09-09). This
 * contribution imports those files once per workspace, non-destructively:
 * files stay on disk, the storage flag only records that a scan of an
 * existing directory happened. A missing directory is not flagged — the scan
 * is one cheap resolve per startup and keeps late-dropped files importable.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAgentMemoryService } from './agentMemoryService.js';

const LEGACY_IMPORT_FLAG = 'ni.agent.memory.legacyImported';

class AgentMemoryLegacyImportContribution extends Disposable {

	constructor(
		@IAgentMemoryService memoryService: IAgentMemoryService,
		@IFileService fileService: IFileService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IStorageService storageService: IStorageService,
	) {
		super();

		const root = workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!root) { return; }
		if (storageService.get(LEGACY_IMPORT_FLAG, StorageScope.WORKSPACE)) { return; }

		const dir = URI.joinPath(root, '.void-memory');
		// Fire-and-forget: import failure must never block startup, and an
		// unflagged failed scan simply retries on the next launch.
		fileService.resolve(dir).then(async entries => {
			const files = (entries.children ?? []).filter(e => e.isFile && e.name.endsWith('.md'));
			for (const file of files) {
				const key = file.name.replace(/\.md$/, '');
				// Never clobber newer tool-written data on a re-scan.
				if (memoryService.findByTag(key)) { continue; }
				const content = await fileService.readFile(file.resource);
				const text = content.value.toString().trim();
				if (!text) { continue; }
				memoryService.upsertByKey(key, text, 'preference');
			}
			storageService.store(LEGACY_IMPORT_FLAG, String(Date.now()), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}).catch(() => { /* no legacy directory yet — retry next startup */ });
	}
}

registerWorkbenchContribution2('agentMemoryLegacyImportContrib', AgentMemoryLegacyImportContribution, WorkbenchPhase.Eventually);

export { AgentMemoryLegacyImportContribution };
