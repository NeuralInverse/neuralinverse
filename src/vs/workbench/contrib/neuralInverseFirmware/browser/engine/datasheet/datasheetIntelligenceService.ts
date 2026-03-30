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


// ─── Implementation ───────────────────────────────────────────────────────────

class DatasheetIntelligenceService extends Disposable implements IDatasheetIntelligenceService {
	readonly _serviceBrand: undefined;

	private readonly _onProgress = this._register(new Emitter<IExtractionProgress>());
	readonly onProgress: Event<IExtractionProgress> = this._onProgress.event;

	constructor(
		@IFileService          private readonly _fileService: IFileService,
		@ILLMMessageService    private readonly _llmMessageService: ILLMMessageService,
		@IVoidSettingsService  private readonly _voidSettingsService: IVoidSettingsService,
		@IDatasheetKBService   private readonly _kbService: IDatasheetKBService,
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
		const rawPages = this._extractPagesFromPDFBytes(buffer);
		const totalPages = rawPages.length;
		const datasheetTitle = this._extractTitle(rawPages[0]?.text ?? '');
		const datasheetId = 'ds-' + contentHash;

		// ── Tier 2: Heuristic classify ALL pages (no LLM) ─────────────────
		this._emit('classifying-pages', totalPages, 0);
		const classifiedPages: IExtractedPage[] = rawPages.map(p => this._heuristicClassify(p.text, p.pageNumber));

		// ── Tier 3a: LLM re-classify only ambiguous pages ─────────────────
		const modelSelection = this._pickModel();
		if (modelSelection) {
			const ambiguous = classifiedPages
				.filter(p => p.pageType === 'other')
				.filter(p => p.text.length > 200);  // skip truly empty pages

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

		// ── Tier 3b: Extract registers (batched) ──────────────────────────
		this._emit('extracting-registers', totalPages, totalPages);
		const registerPages = classifiedPages.filter(p => p.pageType === 'register-description');
		const allExtracted: Array<{ peripheral: string; register: IRegister; citation: ICitation }> = [];

		for (let i = 0; i < registerPages.length; i += BATCH_SIZE) {
			const batch = registerPages.slice(i, i + BATCH_SIZE);
			const regs = modelSelection
				? await this._llmExtractRegisterBatch(batch, mcuFamily, datasheetId, modelSelection)
				: batch.flatMap(p => this._heuristicExtractRegisters(p, mcuFamily, datasheetId));
			allExtracted.push(...regs);
			this._emit('extracting-registers', totalPages, totalPages, allExtracted.length);
			if (modelSelection && i + BATCH_SIZE < registerPages.length) { await this._delay(BATCH_DELAY_MS); }
		}

		// ── Tier 3c: Extract timing (batched) ────────────────────────────
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

		// ── Tier 3d: Extract errata (batched) ────────────────────────────
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
		const registerMaps = this._assembleRegisterMaps(allExtracted);
		const info: IDatasheetInfo = {
			id: datasheetId,
			fileName: datasheetTitle,
			title: datasheetTitle,
			mcuFamily,
			partNumbers: this._extractPartNumbers(classifiedPages),
			pageCount: totalPages,
			parsedAt: Date.now(),
			peripheralCount: registerMaps.length,
			registerCount: allExtracted.length,
			errataCount: errata.length,
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


	// ─── PDF text extractor ───────────────────────────────────────────────

	private _extractPagesFromPDFBytes(buffer: ArrayBufferLike): Array<{ pageNumber: number; text: string }> {
		const decoder = new TextDecoder('utf-8', { fatal: false });
		const raw = decoder.decode(buffer);
		const blocks: string[] = [];

		const btEtRegex = /BT\s*([\s\S]*?)\s*ET/g;
		let m: RegExpExecArray | null;
		while ((m = btEtRegex.exec(raw)) !== null) {
			const blockText: string[] = [];
			const tjRe  = /\(([^)]*)\)\s*Tj/g;
			const tjArrRe = /\[([^\]]*)\]\s*TJ/g;
			let tj: RegExpExecArray | null;
			while ((tj = tjRe.exec(m[1]))    !== null) { blockText.push(tj[1]); }
			while ((tj = tjArrRe.exec(m[1])) !== null) {
				const parts = tj[1].match(/\(([^)]*)\)/g);
				if (parts) { parts.forEach(p => blockText.push(p.slice(1, -1))); }
			}
			if (blockText.length > 0) { blocks.push(blockText.join(' ')); }
		}

		if (blocks.length === 0) {
			// Plain-text fallback
			const lines = raw.split('\n');
			const pageSize = 80;
			return Array.from({ length: Math.ceil(lines.length / pageSize) }, (_, i) => ({
				pageNumber: i + 1,
				text: lines.slice(i * pageSize, (i + 1) * pageSize).join('\n').trim(),
			})).filter(p => p.text.length > 0);
		}

		const blocksPerPage = 60;
		return Array.from({ length: Math.ceil(blocks.length / blocksPerPage) }, (_, i) => ({
			pageNumber: i + 1,
			text: blocks.slice(i * blocksPerPage, (i + 1) * blocksPerPage).join('\n'),
		}));
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
		if (pageNumber <= 2 && /reference manual|datasheet|data sheet/i.test(text)) {
			pageType = 'cover';
		} else if (/table\s+of\s+contents/i.test(text)) {
			pageType = 'table-of-contents';
		} else if (this._registerScore(lower) >= 3) {
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
		return ['address offset','offset:','reset value','bit 31','bit 0',
			'bits [','read/write','read-only','write-only','register map',
			'register description','bit field'].filter(k => lower.includes(k)).length;
	}

	private _timingScore(lower: string): number {
		return ['setup time','hold time','propagation delay','rise time','fall time',
			'min typ max','t_setup','t_hold','clock period'].filter(k => lower.includes(k)).length;
	}


	// ─── Heuristic extractors (fallback when no model configured) ─────────

	private _heuristicExtractRegisters(
		page: IExtractedPage, _mcuFamily: string, datasheetId: string,
	): Array<{ peripheral: string; register: IRegister; citation: ICitation }> {
		const out: Array<{ peripheral: string; register: IRegister; citation: ICitation }> = [];
		const re = /(\w+)_(\w+)\s*(?:\(|offset[:\s]*)(0x[0-9A-Fa-f]+)/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(page.text)) !== null) {
			const rstMatch = page.text.slice(m.index, m.index + 500).match(/reset[:\s]*(0x[0-9A-Fa-f]+)/i);
			out.push({
				peripheral: m[1].toUpperCase(),
				register: {
					name: m[2].toUpperCase(),
					addressOffset: parseInt(m[3], 16),
					size: 32, access: 'read-write',
					resetValue: rstMatch ? parseInt(rstMatch[1], 16) : 0,
					description: `${m[1]} ${m[2]} register`,
					fields: [],
				},
				citation: { datasheetId, pageNumber: page.pageNumber, sectionTitle: page.sectionTitle ?? m[1], confidence: 0.6 },
			});
		}
		return out;
	}

	private _heuristicExtractTiming(page: IExtractedPage): ITimingConstraint[] {
		const out: ITimingConstraint[] = [];
		const re = /([a-zA-Z_]\w+)\s+([\d.]+|[-–])\s+([\d.]+|[-–])\s+([\d.]+|[-–])\s*(ns|μs|us|ms|s|MHz|kHz|Hz)/gi;
		let m: RegExpExecArray | null;
		const v = (s: string) => (s === '-' || s === '–') ? undefined : parseFloat(s);
		while ((m = re.exec(page.text)) !== null) {
			out.push({ peripheral: page.peripheralReferences[0] ?? 'SYSTEM', name: m[1], minValue: v(m[2]), typValue: v(m[3]), maxValue: v(m[4]), unit: m[5].replace('us','μs'), datasheetPage: page.pageNumber });
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

	private _extractTitle(text: string): string {
		for (const line of text.split('\n').filter(l => l.trim().length > 5).slice(0, 10)) {
			const t = line.trim();
			if (t.length > 10 && t.length < 100 && /Reference Manual|Datasheet|Data Sheet|^[A-Z]/.test(t)) {
				return t;
			}
		}
		return 'Unknown Datasheet';
	}

	private _extractPartNumbers(pages: IExtractedPage[]): string[] {
		const out: string[] = [];
		const RE = /\b(STM32[A-Z]\d{3}[A-Z]{1,3}\d?|nRF\d{4,5}\w*|ESP32[\w\-]*|RP\d{4}\w*|MIMXRT\d{4}\w*|ATSAM\w+|ATmega\w+)\b/gi;
		for (const page of pages.filter(p => ['cover','features-overview','ordering-info'].includes(p.pageType)).slice(0, 3)) {
			let m: RegExpExecArray | null;
			while ((m = RE.exec(page.text)) !== null) {
				const u = m[0].toUpperCase();
				if (!out.includes(u)) { out.push(u); }
			}
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
		this._onProgress.fire({ status, totalPages, processedPages, registersExtracted, timingValuesExtracted, errataExtracted, errorMessage });
	}
}


registerSingleton(IDatasheetIntelligenceService, DatasheetIntelligenceService, InstantiationType.Delayed);
