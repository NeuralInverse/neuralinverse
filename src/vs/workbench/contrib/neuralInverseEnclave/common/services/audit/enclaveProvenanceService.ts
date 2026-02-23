/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IEnclaveEnvironmentService } from '../environment/enclaveEnvironmentService.js';

export const IEnclaveProvenanceService = createDecorator<IEnclaveProvenanceService>('enclaveProvenanceService');

export interface IProvenanceMeta {
	agentId: string;
	sessionId: string;
	entryHash: string;
}

export interface IEnclaveProvenanceService {
	readonly _serviceBrand: undefined;

	/**
	 * Watermarks a block of AI-generated code with a provenance comment.
	 * Returns the original code with a trailing watermark comment appended.
	 *
	 * In `open` mode, watermarking is skipped (returns code unchanged).
	 * In `standard` mode, watermarking is optional (a lightweight comment).
	 * In `locked_down` mode, watermarking is mandatory with full hash reference.
	 */
	watermarkCode(code: string, meta: IProvenanceMeta): string;

	/**
	 * Extracts provenance metadata from an already-watermarked code block.
	 * Returns null if no watermark is found.
	 */
	extractProvenance(code: string): IProvenanceMeta | null;

	/**
	 * Checks if a code block contains a valid Neural Inverse provenance watermark.
	 */
	hasWatermark(code: string): boolean;
}

export class EnclaveProvenanceService extends Disposable implements IEnclaveProvenanceService {
	declare readonly _serviceBrand: undefined;

	private static readonly WATERMARK_PREFIX = '// [NI-ENCLAVE]';
	private static readonly WATERMARK_REGEX = /\/\/ \[NI-ENCLAVE\] AI-Generated \| Agent: ([^\|]+) \| Session: ([^\|]+) \| Mode: ([^\|]+) \| Hash: (.+)/;

	constructor(
		@IEnclaveEnvironmentService private readonly enclaveEnv: IEnclaveEnvironmentService
	) {
		super();
		console.log('[Enclave] Provenance Service initialized.');
	}

	public watermarkCode(code: string, meta: IProvenanceMeta): string {
		const mode = this.enclaveEnv.mode;

		// Open mode: no watermarking
		if (mode === 'open') {
			return code;
		}

		// Standard mode: lightweight watermark (no hash)
		if (mode === 'standard') {
			const comment = `${EnclaveProvenanceService.WATERMARK_PREFIX} AI-Generated | Agent: ${meta.agentId} | Session: ${meta.sessionId} | Mode: ${mode} | Hash: -`;
			return this._appendWatermark(code, comment);
		}

		// Locked Down mode: full watermark with hash chain reference
		const comment = `${EnclaveProvenanceService.WATERMARK_PREFIX} AI-Generated | Agent: ${meta.agentId} | Session: ${meta.sessionId} | Mode: ${mode} | Hash: ${meta.entryHash}`;
		return this._appendWatermark(code, comment);
	}

	public extractProvenance(code: string): IProvenanceMeta | null {
		const match = code.match(EnclaveProvenanceService.WATERMARK_REGEX);
		if (!match) {
			return null;
		}

		return {
			agentId: match[1].trim(),
			sessionId: match[2].trim(),
			entryHash: match[4].trim()
		};
	}

	public hasWatermark(code: string): boolean {
		return code.includes(EnclaveProvenanceService.WATERMARK_PREFIX);
	}

	// --- Private Helpers ---

	private _appendWatermark(code: string, comment: string): string {
		const trimmed = code.trimEnd();
		// Detect comment style based on code content
		const commentLine = this._detectAndFormatComment(code, comment);

		return trimmed + '\n' + commentLine + '\n';
	}

	private _detectAndFormatComment(code: string, comment: string): string {
		// For CSS/HTML-like content, adapt the comment style
		// Default is // style (JS/TS/C/C++/Java/Go/Rust)
		if (code.includes('</') || code.includes('/>')) {
			// HTML/XML — use <!-- -->
			return `<!-- ${comment.replace('// ', '')} -->`;
		}
		if (code.trimStart().startsWith('.') || code.includes('{') && code.includes(':') && code.includes(';')) {
			// Potentially CSS — check more specifically
			if (code.includes('color:') || code.includes('margin:') || code.includes('display:')) {
				return `/* ${comment.replace('// ', '')} */`;
			}
		}
		if (code.trimStart().startsWith('#') && !code.includes('//')) {
			// Python/Ruby/Bash — use #
			return comment.replace('//', '#');
		}

		// Default: JS/TS-style comment
		return comment;
	}
}

registerSingleton(IEnclaveProvenanceService, EnclaveProvenanceService, InstantiationType.Delayed);
