/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Datasheet Knowledge Base — Hardware KB Persistence Layer
 *
 * Mirrors the role of KnowledgeBaseImpl in Modernisation: a persistent,
 * disk-backed store of structured hardware intelligence extracted from PDFs.
 *
 * Storage layout (inside workspace):
 *   .inverse/
 *   └── hardware-kb/
 *       ├── index.json           — index of all ingested datasheets
 *       └── <contentHash>.json   — one file per unique PDF (hash-deduped)
 *
 * Benefits:
 *   - Re-opening the same PDF costs ZERO LLM calls (loaded from KB)
 *   - KB can be committed to git alongside Firmware.inverse for team sharing
 *   - Survives IDE restarts
 *   - Content-hash dedup: renamed copies of the same PDF share one KB entry
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { URI } from '../../../../../../base/common/uri.js';
import { withInverseWriteAccess } from '../../../../neuralInverseChecks/browser/engine/utils/inverseFs.js';
import {
	IDatasheetInfo,
	IPeripheralRegisterMap,
	ITimingConstraint,
	IErrata,
	IExtractedPage,
} from '../../../common/firmwareTypes.js';
import { IDatasheetExtractionResult } from './datasheetIntelligenceService.js';


// ─── KB directory constants ─────────────────────────────────────────────────

/** Sub-path inside the workspace root where the Hardware KB lives. */
const KB_DIR        = '.inverse/hardware-kb';
const KB_SCHEMA_VER = 1;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IKBDatasheetEntry {
	/** SHA-256-like content hash of the PDF bytes (first 64KB). */
	contentHash: string;
	/** Original file name(s) this hash was seen in. */
	fileNames: string[];
	/** When this entry was last updated. */
	updatedAt: number;
	/** Version of the KB schema used to generate this entry. */
	schemaVersion: number;
	info: IDatasheetInfo;
	registerMaps: IPeripheralRegisterMap[];
	timingConstraints: ITimingConstraint[];
	errata: IErrata[];
	/** Page classification results (used to skip re-classification on re-open). */
	pageClassifications: Array<{ pageNumber: number; pageType: string; sectionTitle?: string; peripheralReferences: string[] }>;
}

export interface IKBIndex {
	schemaVersion: number;
	entries: Array<{ contentHash: string; fileName: string; parsedAt: number }>;
}


// ─── Service interface ────────────────────────────────────────────────────────

export const IDatasheetKBService = createDecorator<IDatasheetKBService>('datasheetKBService');

export interface IDatasheetKBService {
	readonly _serviceBrand: undefined;

	/**
	 * Compute a lightweight content hash for a PDF buffer.
	 * Used as the cache key — same content = same hash = KB hit.
	 */
	hashBuffer(buffer: ArrayBufferLike): string;

	/**
	 * Check if a KB entry exists for this content hash.
	 * Returns the stored result or undefined (cache miss).
	 */
	lookup(contentHash: string): Promise<IDatasheetExtractionResult | undefined>;

	/**
	 * Store an extraction result in the Hardware KB.
	 * Overwrites any existing entry with the same content hash.
	 */
	store(contentHash: string, result: IDatasheetExtractionResult): Promise<void>;

	/**
	 * List all ingested datasheets in this workspace's KB.
	 */
	listEntries(): Promise<IKBIndex['entries']>;

	/**
	 * Remove an entry from the KB by content hash.
	 */
	remove(contentHash: string): Promise<void>;
}


// ─── Implementation ───────────────────────────────────────────────────────────

class DatasheetKBService extends Disposable implements IDatasheetKBService {
	readonly _serviceBrand: undefined;

	constructor(
		@IFileService             private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
	) {
		super();
	}


	// ─── Public API ───────────────────────────────────────────────────────

	hashBuffer(buffer: ArrayBufferLike): string {
		// Lightweight FNV-1a on first 64KB + last 8KB + total size
		// Not cryptographic but collision-resistant enough for a file cache key.
		const bytes = new Uint8Array(buffer);
		const sampleSize = Math.min(bytes.length, 64 * 1024);
		const tailSize   = Math.min(bytes.length, 8  * 1024);
		let hash = 2166136261; // FNV offset basis
		for (let i = 0; i < sampleSize; i++) {
			hash ^= bytes[i];
			hash = (hash * 16777619) >>> 0; // FNV prime, keep 32-bit
		}
		// Mix in tail bytes to distinguish files that share a common header
		for (let i = bytes.length - tailSize; i < bytes.length; i++) {
			hash ^= bytes[i];
			hash = (hash * 16777619) >>> 0;
		}
		// Mix in total size
		hash ^= bytes.length;
		hash = (hash * 16777619) >>> 0;
		return hash.toString(16).padStart(8, '0') + '_' + bytes.length.toString(36);
	}

	async lookup(contentHash: string): Promise<IDatasheetExtractionResult | undefined> {
		const baseUri = this._kbBaseUri();
		if (!baseUri) { return undefined; }

		const entryUri = URI.joinPath(baseUri, `${contentHash}.json`);
		try {
			const content = await this._fileService.readFile(entryUri);
			const entry = JSON.parse(content.value.toString()) as IKBDatasheetEntry;
			if (entry.schemaVersion !== KB_SCHEMA_VER) { return undefined; } // schema changed

			// Reconstruct IExtractedPage[] from stored classifications
			const pages: IExtractedPage[] = entry.pageClassifications.map(pc => ({
				pageNumber: pc.pageNumber,
				text:        '',   // raw text not stored (too large); re-extracted if needed
				pageType:    pc.pageType as IExtractedPage['pageType'],
				sectionTitle: pc.sectionTitle,
				processed:   true,
				peripheralReferences: pc.peripheralReferences,
			}));

			return {
				info:                entry.info,
				registerMaps:        entry.registerMaps,
				timingConstraints:   entry.timingConstraints,
				errata:              entry.errata,
				pages,
				extractionTimeMs:    0,
			};
		} catch {
			return undefined;
		}
	}

	async store(contentHash: string, result: IDatasheetExtractionResult): Promise<void> {
		const baseUri = this._kbBaseUri();
		if (!baseUri) { return; }

		// Must unlock PARENT .inverse/ dir (not the subdirectory) — same as _ensureKBDir and remove().
		const inversePath = `${this._workspaceRoot()}/.inverse`;

		const entry: IKBDatasheetEntry = {
			contentHash,
			fileNames: [result.info.fileName],
			updatedAt: Date.now(),
			schemaVersion: KB_SCHEMA_VER,
			info: result.info,
			registerMaps: result.registerMaps,
			timingConstraints: result.timingConstraints,
			errata: result.errata,
			pageClassifications: result.pages.map(p => ({
				pageNumber: p.pageNumber,
				pageType: p.pageType,
				sectionTitle: p.sectionTitle,
				peripheralReferences: p.peripheralReferences,
			})),
		};

		const entryUri  = URI.joinPath(baseUri, `${contentHash}.json`);
		const indexUri  = URI.joinPath(baseUri, 'index.json');
		const entryJson = JSON.stringify(entry, null, '\t');

		// Load existing index before the write-lock window
		let index: IKBIndex = { schemaVersion: KB_SCHEMA_VER, entries: [] };
		try {
			const raw = await this._fileService.readFile(indexUri);
			index = JSON.parse(raw.value.toString()) as IKBIndex;
		} catch { /* first write */ }

		index.entries = index.entries.filter(e => e.contentHash !== contentHash);
		index.entries.push({ contentHash, fileName: result.info.fileName, parsedAt: result.info.parsedAt });
		index.entries.sort((a, b) => b.parsedAt - a.parsedAt);
		const indexJson = JSON.stringify(index, null, '\t');

		// ── Write through withInverseWriteAccess ────────────────────────────────
		// .inverse/ is write-locked by the nano agent after each analysis cycle.
		// withInverseWriteAccess temporarily unlocks → writes → re-locks,
		// exactly as Checks does when writing its KB entries.
		await this._ensureKBDir(baseUri);
		await withInverseWriteAccess(inversePath, async () => {
			await this._fileService.writeFile(entryUri, VSBuffer.fromString(entryJson));
			await this._fileService.writeFile(indexUri, VSBuffer.fromString(indexJson));
		});
	}

	async listEntries(): Promise<IKBIndex['entries']> {
		const baseUri = this._kbBaseUri();
		if (!baseUri) { return []; }
		try {
			const indexUri = URI.joinPath(baseUri, 'index.json');
			const content = await this._fileService.readFile(indexUri);
			const index = JSON.parse(content.value.toString()) as IKBIndex;
			return index.entries ?? [];
		} catch {
			return [];
		}
	}

	async remove(contentHash: string): Promise<void> {
		const baseUri = this._kbBaseUri();
		if (!baseUri) { return; }
		// Must unlock the PARENT .inverse/ dir, same as _ensureKBDir.
		// Using .inverse/hardware-kb/ fails silently if .inverse/ itself is mode 555.
		const inverseRoot = `${this._workspaceRoot()}/.inverse`;
		const entryUri = URI.joinPath(baseUri, `${contentHash}.json`);
		await withInverseWriteAccess(inverseRoot, async () => {
			await this._fileService.del(entryUri);
			await this._removeFromIndex(baseUri, contentHash);
		});
	}


	// ─── Helpers ──────────────────────────────────────────────────────────

	private _kbBaseUri(): URI | undefined {
		const folders = this._workspace.getWorkspace().folders;
		if (folders.length === 0) { return undefined; }
		return URI.joinPath(folders[0].uri, KB_DIR);
	}

	private _workspaceRoot(): string {
		const folders = this._workspace.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri.fsPath : '';
	}

	private async _ensureKBDir(baseUri: URI): Promise<void> {
		// The parent .inverse/ dir is write-locked by the nano agent.
		// We must unlock it before we can create the hardware-kb/ subdirectory.
		// Use the .inverse/ parent path (one level up from KB_DIR) for the chmod.
		const inverseRoot = `${this._workspaceRoot()}/.inverse`;
		await withInverseWriteAccess(inverseRoot, async () => {
			try {
				await this._fileService.createFolder(baseUri);
			} catch { /* already exists — fine */ }
		});
	}


	private async _removeFromIndex(baseUri: URI, contentHash: string): Promise<void> {
		// Called from within a withInverseWriteAccess window — write directly.
		const indexUri = URI.joinPath(baseUri, 'index.json');
		try {
			const content = await this._fileService.readFile(indexUri);
			const index = JSON.parse(content.value.toString()) as IKBIndex;
			index.entries = index.entries.filter(e => e.contentHash !== contentHash);
			await this._fileService.writeFile(indexUri, VSBuffer.fromString(JSON.stringify(index, null, '\t')));
		} catch { /* index may not exist yet — fine */ }
	}
}


registerSingleton(IDatasheetKBService, DatasheetKBService, InstantiationType.Delayed);
