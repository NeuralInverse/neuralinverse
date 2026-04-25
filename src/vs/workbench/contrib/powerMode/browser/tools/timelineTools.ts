/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * Timeline Tools \u2014 Power Mode
 *
 * Two agent tools that expose VS Code's local history (Timeline) so the
 * agent can inspect and revert its own file edits without leaving the session.
 *
 *   timeline_list   \u2014 list history snapshots for a file
 *   timeline_revert \u2014 restore the file to the state before a given source wrote it
 */

import { URI } from '../../../../../base/common/uri.js';
import { basename, isAbsolute, join } from '../../../../../base/common/path.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkingCopyHistoryService } from '../../../../services/workingCopy/common/workingCopyHistory.js';
import { IPowerTool } from '../../common/powerModeTypes.js';
import { definePowerTool } from './powerToolRegistry.js';

// \u2500\u2500\u2500 timeline_list \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function createTimelineListTool(
	workingDirectory: string,
	historyService: IWorkingCopyHistoryService,
): IPowerTool {
	return definePowerTool(
		'timeline_list',
		'List the local history snapshots for a file as recorded in the Timeline panel. ' +
		'Returns each entry\'s source label (e.g. "Power Mode", "File Saved") and timestamp.',
		[
			{ name: 'filePath', type: 'string', description: 'Absolute path to the file', required: true },
		],
		async (args, _ctx) => {
			let filePath = (args.filePath as string) || '';
			if (!filePath) return { title: 'timeline_list', output: 'filePath is required', metadata: { error: true } };
			if (!isAbsolute(filePath)) filePath = join(workingDirectory, filePath);

			try {
				const uri = URI.file(filePath);
				const entries = await historyService.getEntries(uri, CancellationToken.None);

				if (entries.length === 0) {
					return { title: 'timeline_list', output: 'No history entries found for this file.', metadata: {} };
				}

				const lines = entries
					.slice()
					.sort((a, b) => b.timestamp - a.timestamp)
					.map((e, i) => {
						const date = new Date(e.timestamp).toLocaleString();
						return `[${i}]  ${date}  source="${e.source}"  id=${e.id}`;
					});

				return { title: `timeline_list: ${basename(filePath)}`, output: lines.join('\n'), metadata: { count: entries.length } };
			} catch (e: any) {
				return { title: 'timeline_list', output: `Error: ${e.message}`, metadata: { error: true } };
			}
		},
	);
}

// \u2500\u2500\u2500 timeline_revert \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function createTimelineRevertTool(
	workingDirectory: string,
	historyService: IWorkingCopyHistoryService,
	fileService: IFileService,
): IPowerTool {
	return definePowerTool(
		'timeline_revert',
		'Revert a file to the snapshot that existed just before the most recent write by a given ' +
		'source. Defaults to "neuralInverse.powerMode.source" (Power Mode). ' +
		'Use "neuralInverse.workerAgent.source" for worker-agent writes or ' +
		'"neuralInverse.agent.source" for chat-agent writes.',
		[
			{ name: 'filePath', type: 'string', description: 'Absolute path to the file to revert', required: true },
			{ name: 'source', type: 'string', description: 'Save-source ID to undo. Defaults to "neuralInverse.powerMode.source"', required: false },
		],
		async (args, _ctx) => {
			let filePath = (args.filePath as string) || '';
			const sourceId = (args.source as string | undefined) ?? 'neuralInverse.powerMode.source';

			if (!filePath) return { title: 'timeline_revert', output: 'filePath is required', metadata: { error: true } };
			if (!isAbsolute(filePath)) filePath = join(workingDirectory, filePath);

			try {
				const uri = URI.file(filePath);
				const entries = await historyService.getEntries(uri, CancellationToken.None);

				// Oldest \u2192 newest
				const sorted = entries.slice().sort((a, b) => a.timestamp - b.timestamp);

				// Find the most recent entry from the target source
				let targetIdx = -1;
				for (let i = sorted.length - 1; i >= 0; i--) {
					if (sorted[i].source === sourceId) { targetIdx = i; break; }
				}

				if (targetIdx === -1) {
					return { title: 'timeline_revert', output: `No history entry with source "${sourceId}" found for this file.`, metadata: { error: true } };
				}

				if (targetIdx === 0) {
					return { title: 'timeline_revert', output: `The "${sourceId}" entry is the oldest snapshot \u2014 no prior state to revert to.`, metadata: { error: true } };
				}

				const beforeEntry = sorted[targetIdx - 1];
				const snapshot = await fileService.readFile(beforeEntry.location);
				await fileService.writeFile(uri, VSBuffer.fromString(snapshot.value.toString()));

				const date = new Date(beforeEntry.timestamp).toLocaleString();
				return {
					title: `timeline_revert: ${basename(filePath)}`,
					output: `Reverted to snapshot from ${date} (source: ${beforeEntry.source})`,
					metadata: { restoredTimestamp: beforeEntry.timestamp, restoredSource: beforeEntry.source },
				};
			} catch (e: any) {
				return { title: 'timeline_revert', output: `Error: ${e.message}`, metadata: { error: true } };
			}
		},
	);
}

// \u2500\u2500\u2500 Export \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function buildTimelineTools(
	workingDirectory: string,
	historyService: IWorkingCopyHistoryService,
	fileService: IFileService,
): IPowerTool[] {
	return [
		createTimelineListTool(workingDirectory, historyService),
		createTimelineRevertTool(workingDirectory, historyService, fileService),
	];
}
