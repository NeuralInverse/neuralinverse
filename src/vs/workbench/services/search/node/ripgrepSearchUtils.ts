/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { ILogService } from '../../../../platform/log/common/log.js';
import { SearchRange } from '../common/search.js';
import * as searchExtTypes from '../common/searchExtTypes.js';

export type Maybe<T> = T | null | undefined;

export function anchorGlob(glob: string): string {
	return glob.startsWith('**') || glob.startsWith('/') ? glob : `/${glob}`;
}

/** Pre-spawn sanity check for a ripgrep invocation. Returns a precise,
 *  actionable message when the executable or the working directory is not
 *  present, or undefined when both exist. Node's raw `spawn <exe> ENOENT`
 *  names only the command — it cannot tell a deleted rg.exe from a vanished
 *  cwd, and callers used to misreport both as "search succeeded, no hits". */
export function ripgrepSpawnPreflightProblem(exePath: string, cwd: string, outputChannel: IOutputChannel): string | undefined {
	try {
		if (!fs.existsSync(exePath)) {
			const message = `ripgrep executable not found at ${exePath}. The search backend cannot run in this installation; reinstalling or repairing the application should restore it.`;
			outputChannel.appendLine(message);
			return message;
		}
	} catch (e) {
		outputChannel.appendLine(`ripgrep preflight could not stat the executable (${e instanceof Error ? e.message : String(e)}); continuing to spawn ${exePath}`);
		return undefined;
	}
	try {
		if (!fs.existsSync(cwd)) {
			const message = `search working directory does not exist: ${cwd}. Search was requested in a folder that is not on disk.`;
			outputChannel.appendLine(message);
			return message;
		}
	} catch (e) {
		outputChannel.appendLine(`ripgrep preflight could not stat the working directory (${e instanceof Error ? e.message : String(e)}); continuing with cwd ${cwd}`);
	}
	return undefined;
}

/** Post-spawn ENOENT diagnosis: re-stat both paths at failure time and say
 *  which one is missing, instead of the opaque `spawn <exe> ENOENT`. */
export function diagnoseRipgrepSpawnError(exePath: string, cwd: string, err: Error): string {
	const isENOENT = (err as NodeJS.ErrnoException).code === 'ENOENT';
	if (!isENOENT) { return err.message; }
	let exeExists = false;
	let cwdExists = false;
	try { exeExists = fs.existsSync(exePath); } catch { /* stat failure — report as inconclusive below */ }
	try { cwdExists = fs.existsSync(cwd); } catch { /* same */ }
	if (!exeExists) {
		return `ripgrep executable not found at ${exePath} (spawn ENOENT). The search backend cannot run in this installation.`;
	}
	if (!cwdExists) {
		return `search working directory does not exist: ${cwd} (spawn ENOENT names only the command).`;
	}
	return `spawn ${exePath} ENOENT although both the executable and the working directory ${cwd} exist at failure time — a transient blocker (for example antivirus holding the executable) is likely; retrying the search usually succeeds.`;
}

export function rangeToSearchRange(range: searchExtTypes.Range): SearchRange {
	return new SearchRange(range.start.line, range.start.character, range.end.line, range.end.character);
}

export function searchRangeToRange(range: SearchRange): searchExtTypes.Range {
	return new searchExtTypes.Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn);
}

export interface IOutputChannel {
	appendLine(msg: string): void;
}

export class OutputChannel implements IOutputChannel {
	constructor(private prefix: string, @ILogService private readonly logService: ILogService) { }

	appendLine(msg: string): void {
		this.logService.debug(`${this.prefix}#search`, msg);
	}
}
