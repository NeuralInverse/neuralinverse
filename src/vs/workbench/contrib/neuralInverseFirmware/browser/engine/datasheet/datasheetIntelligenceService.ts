/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Datasheet Intelligence Service — Hardware KB Extraction Engine
 *
 * The firmware engine's Knowledge Base ingestion pipeline.
 * Mirrors what Modernisation's translation engine does for source code,
 * but for MCU datasheets: extracts register maps, timing, and errata from PDFs.
 *
 * ## Rate-Limiting Strategy
 * A 400-page ST reference manual would generate 400 LLM calls if we classified
 * every page with AI. We avoid this with a 3-tier approach:
 *
 *   Tier 1 — KB cache check (0 LLM calls if already seen this PDF)
 *   Tier 2 — Heuristic classify ALL pages (0 LLM calls, instant)
 *   Tier 3 — LLM only for:
 *     a) Ambiguous pages heuristics can't confidently classify (~10-20%)
 *     b) Register/timing/errata extraction (batched: 5 pages per call)
 *
 * For a 400-page doc: ~20 classification calls + ~15 extraction batches = ~35 total.
 * With 200ms between batches: completes in under 10 seconds for most docs.
 *
 * ## Result Storage
 * On completion, results are written to .inverse/hardware-kb/<contentHash>.json
 * so future opens of the same PDF are instantaneous (no LLM, no re-parsing).
 */

import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ILLMMessageService } from '../../../../void/common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../../../../void/common/voidSettingsService.js';
import { LLMChatMessage } from '../../../../void/common/sendLLMMessageTypes.js';

import {
	IDatasheetInfo,
	IPeripheralRegisterMap,
	IRegister,
	IBitField,
	ITimingConstraint,
	IErrata,
	ICitation,
	IExtractedPage,
	IExtractionProgress,
	ExtractionStatus,
	DatasheetPageType,
	RegisterAccess,
} from '../../../common/firmwareTypes.js';
import { IDatasheetKBService } from './datasheetKBService.js';
import { ISvdFetchService } from './svdFetchService.js';


// ─── Service interface ────────────────────────────────────────────────────────

export const IDatasheetIntelligenceService = createDecorator<IDatasheetIntelligenceService>('datasheetIntelligenceService');

export interface IDatasheetIntelligenceService {
	readonly _serviceBrand: undefined;

	/** Fires on extraction progress updates. */
	readonly onProgress: Event<IExtractionProgress>;

	/**
	 * Parse a PDF datasheet and extract structured hardware data via BYOLLM.
	 *
	 * First checks the Hardware KB cache — if this PDF was already processed,
	 * returns the stored result instantly with zero LLM calls.
	 */
	extractFromPDF(filePath: string, mcuFamily: string): Promise<IDatasheetExtractionResult>;
}

/** Complete result of datasheet extraction — what goes into the Hardware KB. */
export interface IDatasheetExtractionResult {
	info: IDatasheetInfo;
	registerMaps: IPeripheralRegisterMap[];
	timingConstraints: ITimingConstraint[];
	errata: IErrata[];
	pages: IExtractedPage[];
	extractionTimeMs: number;
}

/** Batch size: number of same-type pages sent to LLM per call. */
const BATCH_SIZE = 5;
/** Delay between LLM batch calls to avoid rate limiting (ms). */
const BATCH_DELAY_MS = 250;
/**
 * Hard cap on how many ambiguous-page classification batches we'll send.
 * Heuristics handle ~80% of pages correctly; LLM reclassification of the
 * ambiguous tail is best-effort. 30 batches × 5 pages = 150 pages max.
 * This keeps worst-case LLM calls bounded even for 1000-page reference manuals.
 */
const MAX_AMBIGUOUS_BATCHES = 30;


// ─── Implementation ───────────────────────────────────────────────────────────

class DatasheetIntelligenceService extends Disposable implements IDatasheetIntelligenceService {
	readonly _serviceBrand: undefined;

	private readonly _onProgress = this._register(new Emitter<IExtractionProgress>());
	readonly onProgress: Event<IExtractionProgress> = this._onProgress.event;

	/** Track the filename of whichever PDF is currently being processed, for progress events. */
	private _currentFileName = '';

	constructor(
		@IFileService          private readonly _fileService: IFileService,
		@ILLMMessageService    private readonly _llmMessageService: ILLMMessageService,
		@IVoidSettingsService  private readonly _voidSettingsService: IVoidSettingsService,
		@IDatasheetKBService   private readonly _kbService: IDatasheetKBService,
		@ISvdFetchService      private readonly _svdFetchService: ISvdFetchService,
	) {
		super();
	}


	// ─── Entry point ──────────────────────────────────────────────────────

	async extractFromPDF(filePath: string, mcuFamily: string): Promise<IDatasheetExtractionResult> {
		const startTime = Date.now();
		this._emit('reading-pdf', 0, 0);

		let buffer: ArrayBufferLike;
		try {
			const fileUri = URI.file(filePath);
			const content = await this._fileService.readFile(fileUri);
			buffer = content.value.buffer;
			this._currentFileName = filePath.split('/').pop() ?? filePath;
		} catch (err) {
			this._emit('error', 0, 0, 0, 0, 0, `Cannot read file: ${err}`);
			throw new Error(`Cannot read PDF: ${filePath}`);
		}

		// ── Tier 1: KB cache check ────────────────────────────────────────
		const contentHash = this._kbService.hashBuffer(buffer);
		this._emit('checking-cache', 0, 0);
		const cached = await this._kbService.lookup(contentHash);
		if (cached) {
			this._emit('complete', cached.pages.length, cached.pages.length,
				cached.registerMaps.reduce((n, m) => n + m.registers.length, 0),
				cached.timingConstraints.length,
				cached.errata.length,
			);
			return cached; // Zero LLM calls for a known PDF
		}

		// ── Tier 2: Extract raw text pages from PDF bytes ─────────────────
		// Get real page count FIRST so _extractPagesFromPDFBytes can adapt
		// blocksPerPage to match document size (fixes the hardcoded 300-block grouping
		// that only produced ~100 synthetic pages for a 992-page reference manual).
		const realPageCount = this._extractPdfPageCount(buffer);
		const rawPages = await this._extractPagesFromPDFBytes(buffer, realPageCount);
		// For progress reporting use the synthetic page count (what we actually iterate).
		// info.pageCount carries the real page count for display in the UI.
		const totalPages = rawPages.length;
		const datasheetPageCount = realPageCount || rawPages.length;
		// Pass filePath so title extractor can fall back to the filename
		const datasheetTitle = this._extractTitle(
			(rawPages[0]?.text ?? '') + '\n' + (rawPages[1]?.text ?? ''),
			filePath,
		);
		const datasheetId = 'ds-' + contentHash;

		// ── Tier 2: Heuristic classify ALL pages (no LLM) ─────────────────
		this._emit('classifying-pages', totalPages, 0);
		const classifiedPages: IExtractedPage[] = rawPages.map(p => this._heuristicClassify(p.text, p.pageNumber));

		// ── Tier 3a: LLM re-classify only ambiguous pages ─────────────────
		const modelSelection = this._pickModel();
		if (modelSelection) {
			const ambiguous = classifiedPages
				.filter(p => p.pageType === 'other')
				.filter(p => p.text.length > 200)  // skip truly empty pages
				.slice(0, MAX_AMBIGUOUS_BATCHES * BATCH_SIZE); // ← hard cap: max 150 pages

			for (let i = 0; i < ambiguous.length; i += BATCH_SIZE) {
				const batch = ambiguous.slice(i, i + BATCH_SIZE);
				const reclassified = await this._llmClassifyBatch(batch, mcuFamily, modelSelection);
				for (const r of reclassified) {
					const idx = classifiedPages.findIndex(p => p.pageNumber === r.pageNumber);
					if (idx >= 0) { classifiedPages[idx] = r; }
				}
				this._emit('classifying-pages', totalPages, i + batch.length);
				if (i + BATCH_SIZE < ambiguous.length) { await this._delay(BATCH_DELAY_MS); }
			}
		}

		// ── SVD Tier 1: Fetch authoritative register data ─────────────────
		// The heuristic regex gets ~28% of registers; SVD gives 100% with
		// full bit fields, base addresses, and interrupt info.
		// Extract part numbers from the filename first — most reliable source for
		// large ST reference manuals where the filename encodes the full part list
		// (e.g. "rm0360-stm32f030x4x6x8xc-and-stm32f070x6xb-...pdf").
		const filenamePartNumbers = this._extractPartNumbersFromPath(filePath);
		const pagePartNumbers = this._extractPartNumbers(classifiedPages);
		// Filename-derived parts come first (highest confidence for SVD lookup)
		const partNumbers = [...filenamePartNumbers, ...pagePartNumbers.filter(p => !filenamePartNumbers.includes(p))];
		let svdRegisterMaps: IPeripheralRegisterMap[] | undefined;
		let svdSource: string | undefined;

		if (partNumbers.length > 0) {
			this._emit('extracting-registers', totalPages, totalPages);
			try {
				const svdResult = await this._svdFetchService.fetchForParts(partNumbers);
				if (svdResult) {
					// Tag each peripheral with its SVD source for provenance in the Registers tab
					svdRegisterMaps = svdResult.peripherals.map(p => ({ ...p, source: svdResult.svdFile }));
					svdSource = svdResult.svdFile;
					console.info(`[Datasheet] SVD loaded: ${svdResult.svdFile} — ${svdResult.peripherals.length} peripherals, ${svdResult.peripherals.reduce((n, p) => n + p.registers.length, 0)} registers`);
				}
			} catch (e) {
				console.warn('[Datasheet] SVD fetch failed, falling back to heuristic:', e);
			}
		}

		// ── Tier 2: Extract registers (heuristic or LLM fallback) ─────────
		// Only runs if SVD was NOT found — SVD is the authoritative source.
		const allExtracted: Array<{ peripheral: string; register: IRegister; citation: ICitation }> = [];

		if (!svdRegisterMaps) {
			// No SVD available — fall back to heuristic/LLM extraction
			this._emit('extracting-registers', totalPages, totalPages);
			const registerPages = classifiedPages.filter(p => p.pageType === 'register-description');

			for (let i = 0; i < registerPages.length; i += BATCH_SIZE) {
				const batch = registerPages.slice(i, i + BATCH_SIZE);
				const regs = modelSelection
					? await this._llmExtractRegisterBatch(batch, mcuFamily, datasheetId, modelSelection)
					: batch.flatMap(p => this._heuristicExtractRegisters(p, mcuFamily, datasheetId));
				allExtracted.push(...regs);
				this._emit('extracting-registers', totalPages, totalPages, allExtracted.length);
				if (modelSelection && i + BATCH_SIZE < registerPages.length) { await this._delay(BATCH_DELAY_MS); }
			}
		} else {
			// SVD found — build allExtracted from SVD data for stats counting
			for (const periph of svdRegisterMaps) {
				for (const reg of periph.registers) {
					allExtracted.push({
						peripheral: periph.name,
						register: reg,
						citation: { datasheetId, pageNumber: 0, sectionTitle: periph.groupName, confidence: 1.0 },
					});
				}
			}
		}

		// ── Tier 3: Extract timing (batched) ─────────────────────────────
		this._emit('extracting-timing', totalPages, totalPages, allExtracted.length);
		const timingPages = classifiedPages.filter(p =>
			p.pageType === 'timing-table' || p.pageType === 'electrical-characteristics');
		const timingConstraints: ITimingConstraint[] = [];

		for (let i = 0; i < timingPages.length; i += BATCH_SIZE) {
			const batch = timingPages.slice(i, i + BATCH_SIZE);
			const timing = modelSelection
				? await this._llmExtractTimingBatch(batch, mcuFamily, modelSelection)
				: batch.flatMap(p => this._heuristicExtractTiming(p));
			timingConstraints.push(...timing);
			if (modelSelection && i + BATCH_SIZE < timingPages.length) { await this._delay(BATCH_DELAY_MS); }
		}

		// ── Tier 4: Extract errata (batched) ─────────────────────────────
		this._emit('extracting-errata', totalPages, totalPages, allExtracted.length, timingConstraints.length);
		const errataPages = classifiedPages.filter(p => p.pageType === 'errata');
		const errata: IErrata[] = [];

		for (let i = 0; i < errataPages.length; i += BATCH_SIZE) {
			const batch = errataPages.slice(i, i + BATCH_SIZE);
			const e = modelSelection
				? await this._llmExtractErrataBatch(batch, mcuFamily, modelSelection)
				: batch.flatMap(p => this._heuristicExtractErrata(p));
			errata.push(...e);
			if (modelSelection && i + BATCH_SIZE < errataPages.length) { await this._delay(BATCH_DELAY_MS); }
		}

		// ── Assemble register maps & build result ─────────────────────────
		const registerMaps = svdRegisterMaps ?? this._assembleRegisterMaps(allExtracted);
		const info: IDatasheetInfo = {
			id: datasheetId,
			fileName: datasheetTitle,
			title: datasheetTitle,
			mcuFamily,
			partNumbers,
			pageCount: datasheetPageCount,
			parsedAt: Date.now(),
			peripheralCount: registerMaps.length,
			registerCount: allExtracted.length,
			errataCount: errata.length,
			// Store SVD source for display in UI
			...(svdSource ? { svdSource } : {}),
		};

		const result: IDatasheetExtractionResult = {
			info, registerMaps, timingConstraints, errata,
			pages: classifiedPages,
			extractionTimeMs: Date.now() - startTime,
		};

		// ── Store in Hardware KB ─────────────────────────────────────────
		this._emit('saving-to-kb', totalPages, totalPages, allExtracted.length, timingConstraints.length, errata.length);
		await this._kbService.store(contentHash, result);

		this._emit('complete', totalPages, totalPages, allExtracted.length, timingConstraints.length, errata.length);
		return result;
	}


	// ─── LLM batch: classify ──────────────────────────────────────────────

	private _llmClassifyBatch(
		pages: IExtractedPage[],
		mcuFamily: string,
		modelSelection: ReturnType<DatasheetIntelligenceService['_pickModel']> & {},
	): Promise<IExtractedPage[]> {
		const pageBlocks = pages.map(p =>
			`--- Page ${p.pageNumber} ---\n${p.text.slice(0, 1200)}`
		).join('\n\n');

		const prompt: LLMChatMessage[] = [{
			role: 'user',
			content: `You are a firmware documentation analyst. Classify each page below.
MCU family: ${mcuFamily}

${pageBlocks}

Respond ONLY with a JSON array (one entry per page, same order):
[
  {
    "pageNumber": 12,
    "pageType": "register-description",
    "sectionTitle": "16.5 DMA Configuration",
    "peripheralReferences": ["DMA1", "DMA2"]
  }
]

Valid pageType values: "register-description", "timing-table", "errata", "pinout",
"memory-map", "features-overview", "electrical-characteristics", "cover",
"table-of-contents", "ordering-info", "mechanical", "other"`,
		}];

		return new Promise<IExtractedPage[]>((resolve) => {
			this._llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages', messages: prompt,
				separateSystemMessage: undefined, chatMode: null,
				modelSelection,
				logging: { loggingName: 'FirmwareDatasheetClassifier' },
				modelSelectionOptions: undefined, overridesOfModel: undefined,
				onText: () => {},
				onFinalMessage: ({ fullText }) => {
					resolve(this._parseClassifyBatchResponse(fullText, pages));
				},
				onError: () => { resolve(pages); },
				onAbort: () => { resolve(pages); },
			});
		});
	}


	// ─── LLM batch: registers ─────────────────────────────────────────────

	private _llmExtractRegisterBatch(
		pages: IExtractedPage[],
		mcuFamily: string,
		datasheetId: string,
		modelSelection: ReturnType<DatasheetIntelligenceService['_pickModel']> & {},
	): Promise<Array<{ peripheral: string; register: IRegister; citation: ICitation }>> {
		const pageBlocks = pages.map(p =>
			`--- Page ${p.pageNumber} (${p.sectionTitle ?? 'Unknown'}) ---\n${p.text.slice(0, 2500)}`
		).join('\n\n');

		const prompt: LLMChatMessage[] = [{
			role: 'user',
			content: `You are a firmware register map expert. Extract ALL registers from these pages.
MCU: ${mcuFamily}

${pageBlocks}

Respond ONLY with a JSON array:
[
  {
    "peripheral": "USART1",
    "pageNumber": 42,
    "name": "CR1",
    "addressOffset": "0x00",
    "size": 32,
    "access": "read-write",
    "resetValue": "0x00000000",
    "description": "Control register 1",
    "fields": [
      { "name": "UE", "bitOffset": 0, "bitWidth": 1, "access": "read-write", "description": "USART enable" }
    ]
  }
]

Rules:
- addressOffset and resetValue are hex strings ("0x04")
- Extract EVERY register visible, even partial ones
- If no registers, return []`,
		}];

		return new Promise((resolve) => {
			this._llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages', messages: prompt,
				separateSystemMessage: undefined, chatMode: null,
				modelSelection,
				logging: { loggingName: 'FirmwareRegisterExtractor' },
				modelSelectionOptions: undefined, overridesOfModel: undefined,
				onText: () => {},
				onFinalMessage: ({ fullText }) => {
					resolve(this._parseRegisterBatchResponse(fullText, pages, datasheetId));
				},
				onError: () => {
					resolve(pages.flatMap(p => this._heuristicExtractRegisters(p, mcuFamily, datasheetId)));
				},
				onAbort: () => {
					resolve(pages.flatMap(p => this._heuristicExtractRegisters(p, mcuFamily, datasheetId)));
				},
			});
		});
	}


	// ─── LLM batch: timing ────────────────────────────────────────────────

	private _llmExtractTimingBatch(
		pages: IExtractedPage[],
		mcuFamily: string,
		modelSelection: ReturnType<DatasheetIntelligenceService['_pickModel']> & {},
	): Promise<ITimingConstraint[]> {
		const pageBlocks = pages.map(p =>
			`--- Page ${p.pageNumber} ---\n${p.text.slice(0, 2000)}`
		).join('\n\n');

		const prompt: LLMChatMessage[] = [{
			role: 'user',
			content: `You are a firmware timing analysis expert. Extract ALL timing constraints.
MCU: ${mcuFamily}

${pageBlocks}

Respond ONLY with a JSON array:
[
  {
    "peripheral": "SPI1",
    "name": "t_setup",
    "minValue": 10,
    "typValue": null,
    "maxValue": 50,
    "unit": "ns",
    "conditions": "VDD = 3.3V"
  }
]

Units: "ns", "μs", "ms", "s", "MHz", "kHz", "Hz". Use null for missing values. Return [] if none.`,
		}];

		return new Promise<ITimingConstraint[]>((resolve) => {
			this._llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages', messages: prompt,
				separateSystemMessage: undefined, chatMode: null,
				modelSelection,
				logging: { loggingName: 'FirmwareTimingExtractor' },
				modelSelectionOptions: undefined, overridesOfModel: undefined,
				onText: () => {},
				onFinalMessage: ({ fullText }) => { resolve(this._parseTimingResponse(fullText, pages)); },
				onError: () => { resolve(pages.flatMap(p => this._heuristicExtractTiming(p))); },
				onAbort: () => { resolve(pages.flatMap(p => this._heuristicExtractTiming(p))); },
			});
		});
	}


	// ─── LLM batch: errata ───────────────────────────────────────────────

	private _llmExtractErrataBatch(
		pages: IExtractedPage[],
		mcuFamily: string,
		modelSelection: ReturnType<DatasheetIntelligenceService['_pickModel']> & {},
	): Promise<IErrata[]> {
		const pageBlocks = pages.map(p =>
			`--- Page ${p.pageNumber} ---\n${p.text.slice(0, 2000)}`
		).join('\n\n');

		const prompt: LLMChatMessage[] = [{
			role: 'user',
			content: `You are a silicon errata analyst. Extract ALL errata entries.
MCU: ${mcuFamily}

${pageBlocks}

Respond ONLY with a JSON array:
[
  {
    "id": "ES0182/2.3.1",
    "title": "DMA transfers to USART may fail in half-duplex mode",
    "affectedPeripheral": "USART",
    "description": "When USART is configured in half-duplex mode...",
    "workaround": "Use interrupt-driven transfers instead.",
    "severity": "major",
    "affectedRevisions": ["Rev A"],
    "fixedInRevision": "Rev C",
    "documentPage": 47
  }
]

severity: "info" | "minor" | "major" | "critical". Return [] if none.`,
		}];

		return new Promise<IErrata[]>((resolve) => {
			this._llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages', messages: prompt,
				separateSystemMessage: undefined, chatMode: null,
				modelSelection,
				logging: { loggingName: 'FirmwareErrataExtractor' },
				modelSelectionOptions: undefined, overridesOfModel: undefined,
				onText: () => {},
				onFinalMessage: ({ fullText }) => { resolve(this._parseErrataResponse(fullText, pages)); },
				onError: () => { resolve(pages.flatMap(p => this._heuristicExtractErrata(p))); },
				onAbort: () => { resolve(pages.flatMap(p => this._heuristicExtractErrata(p))); },
			});
		});
	}


	// ─── Response parsers ─────────────────────────────────────────────────

	private _parseClassifyBatchResponse(llmResponse: string, original: IExtractedPage[]): IExtractedPage[] {
		try {
			const arr = JSON.parse(this._extractJSON(llmResponse));
			if (!Array.isArray(arr)) { return original; }
			return original.map(orig => {
				const match = arr.find((a: any) => a.pageNumber === orig.pageNumber);
				if (!match) { return orig; }
				return {
					...orig,
					pageType: (match.pageType ?? 'other') as DatasheetPageType,
					sectionTitle: match.sectionTitle ?? orig.sectionTitle,
					peripheralReferences: Array.isArray(match.peripheralReferences) ? match.peripheralReferences : orig.peripheralReferences,
					processed: true,
				};
			});
		} catch {
			return original;
		}
	}

	private _parseRegisterBatchResponse(
		llmResponse: string,
		pages: IExtractedPage[],
		datasheetId: string,
	): Array<{ peripheral: string; register: IRegister; citation: ICitation }> {
		try {
			const arr = JSON.parse(this._extractJSON(llmResponse));
			if (!Array.isArray(arr)) { return []; }
			return arr.filter((item: any) => item.peripheral && item.name).map((item: any) => {
				const sourcePage = pages.find(p => p.pageNumber === item.pageNumber) ?? pages[0];
				const fields: IBitField[] = (item.fields ?? []).map((f: any) => ({
					name: String(f.name ?? '').toUpperCase(),
					bitOffset: Number(f.bitOffset ?? 0),
					bitWidth: Number(f.bitWidth ?? 1),
					access: (f.access ?? 'read-write') as RegisterAccess,
					description: String(f.description ?? ''),
				}));
				return {
					peripheral: String(item.peripheral).toUpperCase(),
					register: {
						name: String(item.name).toUpperCase(),
						addressOffset: typeof item.addressOffset === 'string' ? parseInt(item.addressOffset, 16) : Number(item.addressOffset ?? 0),
						size: Number(item.size ?? 32),
						access: (item.access ?? 'read-write') as RegisterAccess,
						resetValue: typeof item.resetValue === 'string' ? parseInt(item.resetValue, 16) : Number(item.resetValue ?? 0),
						description: String(item.description ?? ''),
						fields,
					},
					citation: {
						datasheetId,
						pageNumber: sourcePage?.pageNumber ?? 0,
						sectionTitle: sourcePage?.sectionTitle ?? `${item.peripheral}_${item.name}`,
						confidence: 0.92,
					},
				};
			});
		} catch {
			return [];
		}
	}

	private _parseTimingResponse(llmResponse: string, pages: IExtractedPage[]): ITimingConstraint[] {
		try {
			const arr = JSON.parse(this._extractJSON(llmResponse));
			if (!Array.isArray(arr)) { return []; }
			return arr.map((item: any) => ({
				peripheral: String(item.peripheral ?? 'SYSTEM'),
				name: String(item.name ?? ''),
				minValue: item.minValue === null ? undefined : Number(item.minValue),
				typValue: item.typValue === null ? undefined : Number(item.typValue),
				maxValue: item.maxValue === null ? undefined : Number(item.maxValue),
				unit: String(item.unit ?? 'ns'),
				conditions: item.conditions,
				datasheetPage: item.datasheetPage ?? pages[0]?.pageNumber,
			})).filter((t: ITimingConstraint) => t.name);
		} catch { return []; }
	}

	private _parseErrataResponse(llmResponse: string, _pages: IExtractedPage[]): IErrata[] {
		try {
			const arr = JSON.parse(this._extractJSON(llmResponse));
			if (!Array.isArray(arr)) { return []; }
			return arr.map((item: any) => ({
				id: String(item.id ?? `errata-${Math.random().toString(36).slice(2, 8)}`),
				title: String(item.title ?? ''),
				affectedPeripheral: String(item.affectedPeripheral ?? 'Unknown'),
				description: String(item.description ?? item.title ?? ''),
				workaround: item.workaround ? String(item.workaround) : undefined,
				severity: (['info', 'minor', 'major', 'critical'].includes(item.severity) ? item.severity : 'info') as IErrata['severity'],
				affectedRevisions: Array.isArray(item.affectedRevisions) ? item.affectedRevisions : ['All'],
				fixedInRevision: item.fixedInRevision,
				documentPage: item.documentPage,
			})).filter((e: IErrata) => e.title);
		} catch { return []; }
	}

	private _extractJSON(text: string): string {
		const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (fence) { return fence[1].trim(); }
		const startArr = text.indexOf('[');
		const startObj = text.indexOf('{');
		if (startArr !== -1 && (startObj === -1 || startArr < startObj)) {
			const end = text.lastIndexOf(']');
			return end !== -1 ? text.slice(startArr, end + 1) : text;
		}
		if (startObj !== -1) {
			const end = text.lastIndexOf('}');
			return end !== -1 ? text.slice(startObj, end + 1) : text;
		}
		return text;
	}


	// ─── PDF text extractor (FlateDecode-aware) ──────────────────────────

	/**
	 * Reads the real PDF page count from the /Count entry in the Pages catalog.
	 * This is always in plain text in the PDF cross-reference/catalog, never compressed.
	 * Fast: reads just the raw bytes without decompression.
	 */
	private _extractPdfPageCount(buffer: ArrayBufferLike): number {
		try {
			const raw = new TextDecoder('latin1').decode(buffer);
			// PDF spec: /Pages object contains /Count <N>
			// Get the LARGEST /Count value (the root Pages tree node has the total)
			const matches = [...raw.matchAll(/\/Count\s+(\d+)/g)];
			if (matches.length === 0) { return 0; }
			return Math.max(...matches.map(m => parseInt(m[1], 10)));
		} catch { return 0; }
	}

	private async _extractPagesFromPDFBytes(buffer: ArrayBufferLike, targetPageCount = 0): Promise<Array<{ pageNumber: number; text: string }>> {
		const bytes = new Uint8Array(buffer);
		const blocks: string[] = [];

		// ── Pass 1: decompress FlateDecode streams ──────────────────
		// ST and most modern PDF tools emit compressed content streams.
		// BT/ET operators only appear INSIDE the decompressed data.
		const STREAM  = new TextEncoder().encode('stream');
		const ENDSTRM = new TextEncoder().encode('endstream');

		const findSeq = (haystack: Uint8Array, needle: Uint8Array, from = 0): number => {
			outer: for (let i = from; i <= haystack.length - needle.length; i++) {
				for (let j = 0; j < needle.length; j++) { if (haystack[i+j] !== needle[j]) { continue outer; } }
				return i;
			}
			return -1;
		};

		let pos = 0;
		while (pos < bytes.length) {
			const sPos = findSeq(bytes, STREAM, pos);
			if (sPos === -1) { break; }

			// Check if this stream is FlateDecode by scanning back ~400 bytes
			const ctxStart = Math.max(0, sPos - 400);
			const ctx = new TextDecoder('latin1').decode(bytes.slice(ctxStart, sPos));
			if (!ctx.includes('FlateDecode')) { pos = sPos + 6; continue; }

			// Skip \r?\n after 'stream'
			let dataStart = sPos + 6;
			if (bytes[dataStart] === 13) { dataStart++; }
			if (bytes[dataStart] === 10) { dataStart++; }

			const ePos = findSeq(bytes, ENDSTRM, dataStart);
			if (ePos === -1 || ePos <= dataStart) { pos = sPos + 6; continue; }

			// Trim trailing \r?\n before endstream
			let dataEnd = ePos;
			if (bytes[dataEnd - 1] === 10) { dataEnd--; }
			if (bytes[dataEnd - 1] === 13) { dataEnd--; }

			const streamData = bytes.slice(dataStart, dataEnd);
			if (streamData.length > 4_000_000) { pos = ePos + 9; continue; } // skip giant streams

			try {
				const decompressed = await this._inflateStream(streamData);
				const text = new TextDecoder('utf-8', { fatal: false }).decode(decompressed);
				// Extract BT/ET text blocks from decompressed stream
				const btRe = /BT\s*([\s\S]*?)\s*ET/g;
				let bt: RegExpExecArray | null;
				while ((bt = btRe.exec(text)) !== null) {
					const blockText: string[] = [];
					const tjRe    = /\(([^)]*)\)\s*Tj/g;
					const tjArrRe = /\[([^\]]*)\]\s*TJ/g;
					let tj: RegExpExecArray | null;
					while ((tj = tjRe.exec(bt[1]))    !== null) { blockText.push(DatasheetIntelligenceService._decodePdfStr(tj[1])); }
					while ((tj = tjArrRe.exec(bt[1])) !== null) {
						const parts = tj[1].match(/\(([^)]*)\)/g);
						if (parts) { parts.forEach(p => blockText.push(DatasheetIntelligenceService._decodePdfStr(p.slice(1, -1)))); }
					}
					if (blockText.length > 0) { blocks.push(blockText.join('')); }
				}
			} catch { /* skip streams that fail to decompress */ }

			pos = ePos + 9;
		}

		// ── Pass 2: fall back to raw BT/ET if no FlateDecode blocks found ───
		if (blocks.length === 0) {
			const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
			const btRe = /BT\s*([\s\S]*?)\s*ET/g;
			let m: RegExpExecArray | null;
			while ((m = btRe.exec(raw)) !== null) {
				const blockText: string[] = [];
				const tjRe    = /\(([^)]*)\)\s*Tj/g;
				const tjArrRe = /\[([^\]]*)\]\s*TJ/g;
				let tj: RegExpExecArray | null;
				while ((tj = tjRe.exec(m[1]))    !== null) { blockText.push(DatasheetIntelligenceService._decodePdfStr(tj[1])); }
				while ((tj = tjArrRe.exec(m[1])) !== null) {
					const parts = tj[1].match(/\(([^)]*)\)/g);
					if (parts) { parts.forEach(p => blockText.push(DatasheetIntelligenceService._decodePdfStr(p.slice(1, -1)))); }
				}
				if (blockText.length > 0) { blocks.push(blockText.join('')); }
			}
		}

		// ── Pass 3: last resort — plain line split ───────────────────────
		if (blocks.length === 0) {
			const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
			const lines = raw.split('\n');
			const pageSize = 80;
			return Array.from({ length: Math.ceil(lines.length / pageSize) }, (_, i) => ({
				pageNumber: i + 1,
				text: lines.slice(i * pageSize, (i + 1) * pageSize).join('\n').trim(),
			})).filter(p => p.text.length > 0);
		}

		// Adaptive blocks-per-page: target ≈ 1 synthetic page per real PDF page so that
		// classification and extraction coverage spans the full document.
		// Floor at 50 (ensures enough text context per synthetic page for keyword matching).
		// Falls back to 300 if no real page count was provided (e.g. pages catalog not found).
		const blocksPerPage = targetPageCount > 0
			? Math.max(50, Math.ceil(blocks.length / targetPageCount))
			: 300;
		return Array.from({ length: Math.ceil(blocks.length / blocksPerPage) }, (_, i) => ({
			pageNumber: i + 1,
			text: blocks.slice(i * blocksPerPage, (i + 1) * blocksPerPage).join(' '),
		}));
	}

	/** Decompress a zlib/deflate stream using the Web DecompressionStream API (Chromium/Electron). */
	private async _inflateStream(data: Uint8Array): Promise<Uint8Array> {
		// PDF FlateDecode = zlib format (2-byte header 0x78 ...) → use 'deflate'
		// If the stream has no zlib header, try 'deflate-raw'
		const formats: CompressionFormat[] = data[0] === 0x78 ? ['deflate', 'deflate-raw'] : ['deflate-raw', 'deflate'];
		for (const fmt of formats) {
			try {
				const ds = new DecompressionStream(fmt);
				const writer = ds.writable.getWriter();
				const reader = ds.readable.getReader();
				writer.write(data);
				writer.close();
				const chunks: Uint8Array[] = [];
				while (true) {
					const { done, value } = await reader.read();
					if (done) { break; }
					chunks.push(value);
				}
				const total = chunks.reduce((n, c) => n + c.length, 0);
				const result = new Uint8Array(total);
				let offset = 0;
				for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
				return result;
			} catch { /* try next format */ }
		}
		throw new Error('Cannot decompress stream');
	}


	// ─── Heuristic classifier (Tier 2, no LLM) ───────────────────────────

	private _heuristicClassify(text: string, pageNumber: number): IExtractedPage {
		const lower = text.toLowerCase();
		const refs: string[] = [];
		const PERIPH = ['USART','UART','SPI','I2C','TIM','ADC','DAC','DMA','GPIO',
			'RCC','EXTI','NVIC','USB','CAN','FDCAN','SDIO','SAI','QUADSPI',
			'OCTOSPI','LTDC','FMC','RTC','IWDG','WWDG','FLASH','CRC','RNG',
			'TRNG','CRYPTO','AES','HASH','PWM','LPTIM','LPUART'];
		for (const p of PERIPH) {
			if (new RegExp(`\\b${p}\\d*\\b`, 'i').test(text)) {
				if (!refs.includes(p)) { refs.push(p); }
			}
		}

		const sectionMatch = text.match(/^(\d+\.\d+(?:\.\d+)?)\s+(.{4,60})$/m);
		const sectionTitle = sectionMatch ? `${sectionMatch[1]} ${sectionMatch[2].trim()}` : undefined;

		let pageType: DatasheetPageType = 'other';
		if (pageNumber <= 5 && /reference manual|datasheet|data sheet|product specification|preliminary/i.test(text)) {
			pageType = 'cover';
		} else if (/table\s+of\s+contents/i.test(text)) {
			pageType = 'table-of-contents';
		} else if (this._registerScore(lower) >= 2) {   // lowered from 3 → catches more register pages
			pageType = 'register-description';
		} else if (this._timingScore(lower) >= 2) {
			pageType = 'timing-table';
		} else if (/\berrata\b|silicon\s+bug|known\s+limitation/i.test(text)) {
			pageType = 'errata';
		} else if (/pinout|pin\s+diagram/i.test(text)) {
			pageType = 'pinout';
		} else if (/memory\s+map|address\s+map/i.test(text)) {
			pageType = 'memory-map';
		} else if (/electrical\s+characteristics|absolute\s+maximum/i.test(text)) {
			pageType = 'electrical-characteristics';
		} else if (/ordering\s+information|part\s+number/i.test(text)) {
			pageType = 'ordering-info';
		} else if (/mechanical|package\s+dimension/i.test(text)) {
			pageType = 'mechanical';
		} else if (/feature|overview|description/i.test(text) && pageNumber <= 10) {
			pageType = 'features-overview';
		}

		return { pageNumber, text, pageType, sectionTitle, processed: pageType !== 'other', peripheralReferences: refs };
	}

	private _registerScore(lower: string): number {
		// STM32 datasheets use: offset, Reset:, rw, r, w, Bits, Reset value, Address offset
		return [
			'address offset', 'offset:', 'reset value', 'reset:', 'reset :',
			'bit 31', 'bit 0', 'bits [', 'bits:',
			'read/write', 'read-only', 'write-only', 'register map', 'register description',
			'bit field', '\trw\t', '\tro\t', '\two\t', 'w1c', 'rc_w1',
			'0x0000', '0x0001',  // common reset values in register tables
		].filter(k => lower.includes(k)).length;
	}

	private _timingScore(lower: string): number {
		return [
			// Full phrases
			'setup time', 'hold time', 'propagation delay', 'rise time', 'fall time',
			'min typ max', 'min. typ.', 't_setup', 't_hold', 'clock period',
			// ST abbreviations in timing tables
			'symbol', 'parameter', 'conditions', 'unit',
			'ns', 'μs', 'µs', 'pf', 'mhz', 'khz',
			'f_master', 'f_pclk', 't_rise', 't_fall',
			'propagation', 'latency', 'conversion time',
			// RM0360 / ST reference manual electrical characteristics section keywords
			'electrical characteristics', 'operating conditions',
			'supply voltage', 'input voltage', 'output voltage',
			'min.', 'typ.', 'max.',
			'vdd', 'vdda', 'vbat',
		].filter(k => lower.includes(k)).length;
	}


	// ─── Heuristic extractors (fallback when no model configured) ─────────

	private _heuristicExtractRegisters(
		page: IExtractedPage, _mcuFamily: string, datasheetId: string,
	): Array<{ peripheral: string; register: IRegister; citation: ICitation }> {
		const out: Array<{ peripheral: string; register: IRegister; citation: ICitation }> = [];
		const seen = new Set<string>();
		const text = page.text;

		// ── Pattern A: inline PERIPH_REG(offset:0xNN) — uncompressed/simple PDFs ──
		const inlineRe = /(\w+)_(\w+)\s*(?:\(|offset[:\s]*)(0x[0-9A-Fa-f]+)/g;
		let m: RegExpExecArray | null;
		while ((m = inlineRe.exec(text)) !== null) {
			const key = `${m[1]}_${m[2]}`;
			if (seen.has(key)) { continue; }
			seen.add(key);
			const rstMatch = text.slice(m.index, m.index + 500).match(/reset[:\s]*(0x[0-9A-Fa-f]+)/i);
			out.push({
				peripheral: m[1].toUpperCase(),
				register: {
					name: m[2].toUpperCase(), addressOffset: parseInt(m[3], 16),
					size: 32, access: 'read-write',
					resetValue: rstMatch ? parseInt(rstMatch[1], 16) : 0,
					description: `${m[1]} ${m[2]} register`, fields: [],
				},
				citation: { datasheetId, pageNumber: page.pageNumber, sectionTitle: page.sectionTitle ?? m[1], confidence: 0.6 },
			});
		}

		// ── Pattern B: ST table layout — 'Address offset: 0xNN' with nearby PERIPH_REG ──
		// ST PDFs: "RCC_CR Address offset: 0x00 Reset value: 0x0000 0083"
		// Each is a BT fragment joined with spaces, so they appear on the same logical line.
		const addrOffsetRe = /([A-Z]{1,10}_[A-Z][A-Z0-9_]{1,20})\s+(?:Address\s+offset|Offset)[:\s]+(0x[0-9A-Fa-f]+)/gi;
		while ((m = addrOffsetRe.exec(text)) !== null) {
			const [, regFull, offsetStr] = m;
			const parts = regFull.split('_');
			if (parts.length < 2) { continue; }
			const periph = parts[0].toUpperCase();
			const regName = parts.slice(1).join('_').toUpperCase();
			const key = `${periph}_${regName}`;
			if (seen.has(key)) { continue; }
			seen.add(key);
			const rstMatch = text.slice(m.index, m.index + 300).match(/Reset\s+value[:\s]+(0x[0-9A-Fa-f]+)/i);
			out.push({
				peripheral: periph,
				register: {
					name: regName, addressOffset: parseInt(offsetStr, 16),
					size: 32, access: 'read-write',
					resetValue: rstMatch ? parseInt(rstMatch[1], 16) : 0,
					description: `${periph} ${regName} register`, fields: [],
				},
				citation: { datasheetId, pageNumber: page.pageNumber, sectionTitle: page.sectionTitle ?? periph, confidence: 0.8 },
			});
		}

		// ── Pattern C: nearest PERIPH_REG before each 'Address offset: 0xNN' ──
		// ST table format: section header has "Clock control register (RCC_CR)", then
		// the bit diagram fills 100-500 chars, THEN "Address offset: 0x00".
		// An 80-char lookback misses the name; scan all register positions up front
		// and find the closest one preceding each offset.

		// Step 1: collect all PERIPH_REG positions in this page
		const regPositions: Array<{ periph: string; name: string; index: number }> = [];
		const regScanRe = /\b([A-Z]{2,8})_([A-Z][A-Z0-9_]{1,20})\b/g;
		let rs: RegExpExecArray | null;
		while ((rs = regScanRe.exec(text)) !== null) {
			// Filter out obvious false positives like STM32F0, GPIO_A etc.
			if (/^(STM|ARM|CPU|MCU|USB|CAN|SPI|I2C)$/.test(rs[1]) && rs[2].length === 1) { continue; }
			regPositions.push({ periph: rs[1], name: rs[2], index: rs.index });
		}

		// Step 2: for each "Address offset: 0xNN", find closest preceding register (within 800 chars)
		const offsetScanRe = /(?:Address\s+offset|Offset)\s*[:\s]+(0x[0-9A-Fa-f]+)/gi;
		while ((m = offsetScanRe.exec(text)) !== null) {
			const offsetVal = m[1];
			const minIdx = Math.max(0, m.index - 800);
			// Binary-search to find closest preceding position
			let best: { periph: string; name: string; index: number } | undefined;
			for (let i = regPositions.length - 1; i >= 0; i--) {
				const rp = regPositions[i];
				if (rp.index >= m.index) { continue; }
				if (rp.index < minIdx) { break; }
				best = rp;
				break;
			}
			if (!best) { continue; }
			const key = `${best.periph}_${best.name}`;
			if (seen.has(key)) { continue; }
			seen.add(key);
			const rstMatch = text.slice(m.index, m.index + 300).match(/Reset\s+value\s*[:\s]+(0x[0-9A-Fa-f]+)/i);
			out.push({
				peripheral: best.periph,
				register: {
					name: best.name, addressOffset: parseInt(offsetVal, 16),
					size: 32, access: 'read-write',
					resetValue: rstMatch ? parseInt(rstMatch[1], 16) : 0,
					description: `${best.periph} ${best.name} register`, fields: [],
				},
				citation: { datasheetId, pageNumber: page.pageNumber, sectionTitle: page.sectionTitle ?? best.periph, confidence: 0.75 },
			});
		}

		return out;
	}

	private _heuristicExtractTiming(page: IExtractedPage): ITimingConstraint[] {
		const out: ITimingConstraint[] = [];
		const v = (s: string) => (s === '-' || s === '–') ? undefined : parseFloat(s);

		// Pattern A: compact — Symbol Min Typ Max Unit (e.g. Nordic/NXP datasheets)
		// t_SETUP 10 - 50 ns
		const reCompact = /([a-zA-Z_][\w().\/\-]{1,24})\s+([\d.]+|[-–])\s+([\d.]+|[-–])\s+([\d.]+|[-–])\s*(ns|μs|us|ms|s|MHz|kHz|Hz)\b/gi;

		// Pattern B: with description — Symbol Description Min Typ Max Unit
		// This is ST RM-style: t_su(SDA) SDA setup time 100 - - ns
		// The description is 3–60 non-numeric chars between symbol and the first numeric column.
		const reDesc = /([a-zA-Z_][\w().\/\-]{1,24})\s+[^0-9\-–\n]{3,60}\s+([\d.]+|[-–])\s+([\d.]+|[-–])\s+([\d.]+|[-–])\s*(ns|μs|us|ms|s|MHz|kHz|Hz)\b/gi;

		const seen = new Set<string>();
		let m: RegExpExecArray | null;

		while ((m = reDesc.exec(page.text)) !== null) {
			if (seen.has(m[0])) { continue; }
			seen.add(m[0]);
			out.push({ peripheral: page.peripheralReferences[0] ?? 'SYSTEM', name: m[1], minValue: v(m[2]), typValue: v(m[3]), maxValue: v(m[4]), unit: m[5].replace('us', 'μs'), datasheetPage: page.pageNumber });
		}
		while ((m = reCompact.exec(page.text)) !== null) {
			if (seen.has(m[0])) { continue; }
			seen.add(m[0]);
			out.push({ peripheral: page.peripheralReferences[0] ?? 'SYSTEM', name: m[1], minValue: v(m[2]), typValue: v(m[3]), maxValue: v(m[4]), unit: m[5].replace('us', 'μs'), datasheetPage: page.pageNumber });
		}
		return out;
	}

	private _heuristicExtractErrata(page: IExtractedPage): IErrata[] {
		const out: IErrata[] = [];
		const re = /(\d+\.\d+(?:\.\d+)?)\s+(.{15,200}?)(?:\n|$)/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(page.text)) !== null && out.length < 20) {
			const title = m[2].trim();
			if (!/fail|issue|error|incorrect|may not|should not/i.test(title)) { continue; }
			out.push({ id: `ES-${m[1]}`, title, affectedPeripheral: page.peripheralReferences[0] ?? 'Unknown', description: title, severity: 'info', affectedRevisions: ['All'], documentPage: page.pageNumber });
		}
		return out;
	}


	// ─── Assembly helpers ─────────────────────────────────────────────────

	private _assembleRegisterMaps(
		registers: Array<{ peripheral: string; register: IRegister; citation: ICitation }>,
	): IPeripheralRegisterMap[] {
		const byPeriph = new Map<string, IPeripheralRegisterMap>();
		for (const { peripheral, register } of registers) {
			if (!byPeriph.has(peripheral)) {
				byPeriph.set(peripheral, { name: peripheral, groupName: peripheral.replace(/\d+$/, ''), baseAddress: 0, description: `${peripheral} (from datasheet)`, registers: [], interrupts: [] });
			}
			const map = byPeriph.get(peripheral)!;
			if (!map.registers.find((r: IRegister) => r.name === register.name)) {
				map.registers.push(register);
			}
		}
		for (const m of byPeriph.values()) {
			(m.registers as IRegister[]).sort((a, b) => a.addressOffset - b.addressOffset);
		}
		return [...byPeriph.values()];
	}

	private _extractTitle(text: string, filePath?: string): string {
		// Strategy 1: look for explicit doc title keywords in first 30 lines
		const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 4);
		for (const line of lines.slice(0, 30)) {
			if (line.length > 8 && line.length < 120) {
				if (/reference manual|datasheet|data sheet|product specification|user manual|application note/i.test(line)) {
					return line;
				}
			}
		}
		// Strategy 2: first plausible title line (not a date or short number)
		for (const line of lines.slice(0, 15)) {
			if (line.length > 12 && line.length < 100 && /^[A-Z\d]/.test(line) && !/^\d{1,2}[\.\/\-]\d/.test(line)) {
				return line;
			}
		}
		// Strategy 3: use filename without extension
		if (filePath) {
			const base = filePath.split('/').pop()?.replace(/\.pdf$/i, '') ?? '';
			if (base.length > 0) { return base; }
		}
		return 'Unknown Datasheet';
	}

	private _extractPartNumbers(pages: IExtractedPage[]): string[] {
		const out: string[] = [];
		const RE = /\b(STM32[A-Z]\d{3}[A-Z]{1,3}\d?|nRF\d{4,5}\w*|ESP32[\w\-]*|RP\d{4}\w*|MIMXRT\d{4}\w*|ATSAM\w+|ATmega\w+)\b/gi;
		// Prioritise cover/overview pages; if none classified, scan first 10 pages
		const priority = pages.filter(p => ['cover','features-overview','ordering-info'].includes(p.pageType));
		const scanPages = priority.length > 0 ? priority.slice(0, 5) : pages.slice(0, 10);
		for (const page of scanPages) {
			let m: RegExpExecArray | null;
			while ((m = RE.exec(page.text)) !== null) {
				const u = m[0].toUpperCase();
				if (!out.includes(u)) { out.push(u); }
			}
		}
		return out;
	}

	/**
	 * Decode PDF string escape sequences found inside Tj/TJ operator strings:
	 *   - Octal:  \040 → space, \012 → newline
	 *   - Named:  \n \r \t \\ \( \)
	 * ST reference manuals frequently use \040 for spaces between word fragments,
	 * so without this decode "Address\040offset" stays garbled and heuristics fail.
	 */
	private static _decodePdfStr(s: string): string {
		return s.replace(
			/\\([0-7]{1,3}|[nrt\\()])/g,
			(_, esc: string) => {
				if (esc === 'n') { return '\n'; }
				if (esc === 'r') { return '\r'; }
				if (esc === 't') { return '\t'; }
				if (esc === '\\') { return '\\'; }
				if (esc === '(') { return '('; }
				if (esc === ')') { return ')'; }
				return String.fromCharCode(parseInt(esc, 8)); // octal \NNN
			},
		);
	}

	/**
	 * Extract MCU part numbers from the PDF file path / filename.
	 *
	 * More permissive than _extractPartNumbers because filenames often concatenate
	 * variants without separators (e.g. "stm32f030x4x6x8xc" as one token).
	 * The result is enough to trigger SVD catalogue lookup which uses substring matching.
	 *
	 * Example: "rm0360-stm32f030x4x6x8xc-and-stm32f070x6xb-...pdf"
	 *   → ['STM32F030X4X6X8XC', 'STM32F070X6XB']
	 *   Both hit /STM32F0[37]0/ in the SVD catalogue → STM32F0x0.svd fetched.
	 */
	private _extractPartNumbersFromPath(filePath: string): string[] {
		const out: string[] = [];
		const base = (filePath.split('/').pop() ?? filePath)
			.replace(/\.pdf$/i, '')
			.toUpperCase();
		// Match tokens bounded by non-alphanumeric characters or string edges.
		// {0,12} suffix range covers concatenated variants like "X4X6X8XC".
		const RE = /(?:^|[^A-Z0-9])(STM32[A-Z]\d{3}[A-Z0-9]{0,12}|NRF\d{4,5}[A-Z0-9]{0,8}|ESP32[A-Z0-9]{0,8}|RP\d{4}[A-Z0-9]{0,6}|MIMXRT\d{4}[A-Z0-9]{0,6}|ATSAM[A-Z0-9]{4,10}|ATMEGA[0-9]{1,4}[A-Z0-9]{0,6})(?=[^A-Z0-9]|$)/g;
		let m: RegExpExecArray | null;
		while ((m = RE.exec(base)) !== null) {
			const u = m[1]; // group 1 — excludes the leading non-alnum separator
			if (!out.includes(u)) { out.push(u); }
		}
		return out;
	}

	private _pickModel() {
		const s = this._voidSettingsService.state;
		return s.modelSelectionOfFeature['Checks'] ?? s.modelSelectionOfFeature['Chat'] ?? null;
	}

	private _delay(ms: number): Promise<void> {
		return new Promise(r => setTimeout(r, ms));
	}

	private _emit(
		status: ExtractionStatus, totalPages: number, processedPages: number,
		registersExtracted = 0, timingValuesExtracted = 0, errataExtracted = 0, errorMessage?: string,
	): void {
		this._onProgress.fire({
			status, fileName: this._currentFileName,
			totalPages, processedPages,
			registersExtracted, timingValuesExtracted, errataExtracted, errorMessage,
		});
	}
}


registerSingleton(IDatasheetIntelligenceService, DatasheetIntelligenceService, InstantiationType.Delayed);
