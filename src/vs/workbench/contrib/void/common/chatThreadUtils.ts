/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ChatThreads } from '../browser/chatThreadServiceInterface.js';

/**
 * Returns the subset of allThreads that should be visible for the given workspace URI.
 *
 * Rules:
 *  - Threads without workspaceUri are legacy/global and shown in every workspace.
 *  - When no workspace is open (currentUri === undefined), only global threads are shown.
 *  - Threads with a workspaceUri are shown only when it exactly matches currentUri.
 */
export function workspaceFilteredThreads(allThreads: ChatThreads, currentUri: string | undefined): ChatThreads {
	const filtered: ChatThreads = {};
	for (const id in allThreads) {
		const t = allThreads[id];
		if (!t) continue;
		if (!t.workspaceUri) { filtered[id] = t; continue; } // legacy/global — show everywhere
		if (!currentUri) continue;                             // no workspace open — only global threads
		if (t.workspaceUri === currentUri) { filtered[id] = t; }
	}
	return filtered;
}
