/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Discovery Service — Stage 1
 *
 * Orchestrates the full Stage 1 discovery pipeline across all source and target
 * projects in a modernisation session. Delegates each concern to its own module:
 *
 * ```
 *  DiscoveryService
 *    ├─ fileWalker          \u2192 walk directory tree, binary detection
 *    ├─ projectMetadataReader \u2192 build system, frameworks, CI, Docker
 *    ├─ languageDetector    \u2192 ext + shebang + content heuristics
 *    ├─ unitDecomposer      \u2192 per-language sub-file unit extraction
 *    ├─ dependencyExtractor \u2192 import/COPY parsing + graph resolution
 *    ├─ grcSnapshotBuilder  \u2192 GRC violation aggregation + risk scoring
 *    └─ fingerprintExtractor (Layer 1) — from deterministicExtractor.ts
 * ```
 *
 * ## Concurrency Model
 *
 * - Both sides (sources and targets) are scanned in parallel.
 * - Within a project, files are processed in batches of `SCAN_CONCURRENCY` (8).
 * - Each file batch is `Promise.all()`-resolved so fingerprinting and GRC scanning
 *   run concurrently within the batch.
 *
 * ## Cancellation
 *
 * Call `cancel()` at any time. The service checks `_cancelled` between batches
 * and at the start of each project scan, so cancellation is near-immediate.
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { URI } from '../../../../../../base/common/uri.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IGRCEngineService } from '../../../../neuralInverseChecks/browser/engine/services/grcEngineService.js';
import { ICheckResult } from '../../../../neuralInverseChecks/browser/engine/types/grcTypes.js';
import { IFrameworkRegistry } from '../../../../neuralInverseChecks/browser/engine/framework/frameworkRegistry.js';
import { extractDeterministicFingerprint } from '../fingerprint/deterministicExtractor.js';
import { IComplianceFingerprint, IMigrationUnit, MigrationRiskLevel } from '../../../common/modernisationTypes.js';
import { IProjectTarget } from '../../modernisationSessionService.js';

import {
	IDiscoveryProgress,
	IDiscoveryResult,
	IProjectScanResult,
	IDiscoveryStats,
	IFileProcessResult,
	IDecomposedUnit,
} from './discoveryTypes.js';
import { walkFiles, isBinary, stripBOM, MAX_DECOMPOSE_BYTES } from './fileWalker.js';
import { detectLanguage } from './languageDetector.js';
import { decomposeFile, fileUnit } from './unitDecomposer.js';
import { extractRawImports, buildDependencyGraph } from './dependencyExtractor.js';
import { readProjectMetadata } from './projectMetadataReader.js';
import { buildGRCSnapshot, riskFromGRC } from './grcSnapshotBuilder.js';
import { buildCallGraph, IRawCallEntry } from './callGraphExtractor.js';
import { detectAPIEndpoints } from './apiSurfaceDetector.js';
import { extractDataSchemas } from './dataSchemaExtractor.js';
import { analyzeUnitDebt, detectCopyPasteCobol } from './techDebtAnalyzer.js';
import { scanForRegulatedData, PATTERN_TAGS, IPatternFrameworkMap } from './regulatedDataScanner.js';
import { estimateMigrationEffort, summariseEffort } from './migrationEffortEstimator.js';
import { pairProjects } from './crossProjectPairer.js';
import { IncrementalScanCache, fnv1aHash } from './incrementalScanCache.js';
import { analyzeComplexity } from './complexityAnalyzer.js';


// ─── Constants ────────────────────────────────────────────────────────────────

/** Number of files to process concurrently within a single project. */
const SCAN_CONCURRENCY = 8;


// ─── Service Interface ────────────────────────────────────────────────────────

export const IDiscoveryService = createDecorator<IDiscoveryService>('modernisationDiscoveryService');

export interface IDiscoveryService {
	readonly _serviceBrand: undefined;

	/** Fires with granular progress updates during an active scan. */
	readonly onDidProgress: Event<IDiscoveryProgress>;

	/**
	 * Scan all source and target projects in parallel.
	 * Returns the full `IDiscoveryResult` when all projects have been scanned.
	 *
	 * @param sources  Source (legacy) project definitions
	 * @param targets  Target (modern) project definitions
	 */
	scan(sources: IProjectTarget[], targets: IProjectTarget[]): Promise<IDiscoveryResult>;

	/** Abort an in-progress scan. No-op if nothing is running. */
	cancel(): void;
}

// Re-export all types from this module's entry point so callers only need one import
export type {
	IDiscoveryProgress,
	IDiscoveryResult,
	IProjectScanResult,
	IDiscoveryStats,
	IDependencyEdge,
} from './discoveryTypes.js';
export type {
	IGRCSnapshot,
	IGRCMiniViolation,
	IFileScanError,
	IProjectMetadata,
} from './discoveryTypes.js';


// ─── Implementation ───────────────────────────────────────────────────────────

class DiscoveryService extends Disposable implements IDiscoveryService {
	readonly _serviceBrand: undefined;

	private readonly _onDidProgress = this._register(new Emitter<IDiscoveryProgress>());
	readonly onDidProgress: Event<IDiscoveryProgress> = this._onDidProgress.event;

	private _cancelled = false;

	constructor(
		@IFileService           private readonly fileService: IFileService,
		@IGRCEngineService      private readonly grcEngine: IGRCEngineService,
		@IFrameworkRegistry     private readonly frameworkRegistry: IFrameworkRegistry,
	) {
		super();
	}

	cancel(): void { this._cancelled = true; }

	// ─── scan() ─────────────────────────────────────────────────────────────

	async scan(sources: IProjectTarget[], targets: IProjectTarget[]): Promise<IDiscoveryResult> {
		this._cancelled = false;
		const wallStart = Date.now();

		// Build the pattern\u2192framework map once per scan from the currently loaded
		// enterprise frameworks. Passed down to every file's regulated data scanner.
		const patternFrameworkMap = this._buildPatternFrameworkMap();

		const scanAll = async (projects: IProjectTarget[]): Promise<IProjectScanResult[]> => {
			const results: IProjectScanResult[] = [];
			for (const project of projects) {
				if (this._cancelled) { break; }
				results.push(await this._scanProject(project, patternFrameworkMap));
			}
			return results;
		};

		// Scan both sides in parallel
		const [scannedSources, scannedTargets] = await Promise.all([
			scanAll(sources),
			scanAll(targets),
		]);

		this._progress('pairing', 0, 0, 0, 'Cross-matching source ↔ target units…', '');
		const crossProjectPairings = pairProjects(scannedSources, scannedTargets);

		this._progress('complete', 0, 0, 0, '', '');

		return {
			discoveredAt:        Date.now(),
			sources:             scannedSources,
			targets:             scannedTargets,
			crossProjectPairings,
			totalElapsedMs:      Date.now() - wallStart,
		};
	}

	// ─── _scanProject() ──────────────────────────────────────────────────────

	private async _scanProject(project: IProjectTarget, patternFrameworkMap: IPatternFrameworkMap): Promise<IProjectScanResult> {
		const projectStart = Date.now();
		const folderUri    = URI.parse(project.folderUri);

		// ── Phase 1: walk ──────────────────────────────────────────────────
		this._progress('walking', 0, 0, 0, '', project.label);
		const fileUris = await walkFiles(folderUri, this.fileService, dir => {
			this._progress('walking', 0, 0, 0, this._basename(dir), project.label);
		});

		// ── Phase 2: project metadata ──────────────────────────────────────
		this._progress('metadata', 0, fileUris.length, 0, 'Reading project metadata…', project.label);
		const metadata = await readProjectMetadata(folderUri, fileUris, this.fileService);

		// ── Incremental cache ──────────────────────────────────────────────
		const cache = new IncrementalScanCache(folderUri, this.fileService);
		await cache.load();

		// ── Phase 3: concurrent file processing ────────────────────────────
		const allUnits:           IMigrationUnit[]  = [];
		const allGRCViolations:   ICheckResult[]    = [];
		const allAPIEndpoints:    IFileProcessResult['apiEndpoints'] = [];
		const allDataSchemas:     IFileProcessResult['dataSchemas']  = [];
		const allTechDebtItems:   IFileProcessResult['techDebtItems'] = [];
		const allRegulatedHits:   IFileProcessResult['regulatedDataHits'] = [];
		const allEffortEstimates: IFileProcessResult['effortEstimates'] = [];
		const rawCallEntries:     IRawCallEntry[] = [];
		const langCounts:         Record<string, number> = {};
		const scanErrors:         IFileProcessResult['error'][]  = [];
		const rawDepEdges:        Array<{ fromUnitId: string; rawImport: string }> = [];
		let totalLines = 0;
		let largestLines = 0;
		let largestFileUri = '';
		let filesProcessed = 0;

		for (let batchStart = 0; batchStart < fileUris.length; batchStart += SCAN_CONCURRENCY) {
			if (this._cancelled) { break; }

			const batch = fileUris.slice(batchStart, batchStart + SCAN_CONCURRENCY);
			const batchResults = await Promise.all(
				batch.map(uri => this._processFile(uri, project.id, folderUri, patternFrameworkMap, cache)),
			);

			for (const res of batchResults) {
				filesProcessed++;
				if (res.error) {
					scanErrors.push(res.error);
				} else {
					allUnits.push(...res.units);
					allGRCViolations.push(...res.grcViolations);
					allAPIEndpoints.push(...res.apiEndpoints);
					allDataSchemas.push(...res.dataSchemas);
					allTechDebtItems.push(...res.techDebtItems);
					allRegulatedHits.push(...res.regulatedDataHits);
					allEffortEstimates.push(...res.effortEstimates);
					langCounts[res.lang] = (langCounts[res.lang] ?? 0) + 1;
					totalLines += res.lineCount;
					if (res.lineCount > largestLines) {
						largestLines   = res.lineCount;
						largestFileUri = res.units[0]?.legacyFilePath ?? '';
					}
					rawDepEdges.push(...res.dependencyEdges);
					rawCallEntries.push(...res.callEdges.map(e => ({ ...e, lang: res.lang })));
				}

				this._progress('fingerprinting', filesProcessed, fileUris.length, allUnits.length,
					this._basename(batch[0].path), project.label);
			}
		}

		// ── Phase 4: dependency graph ──────────────────────────────────────
		this._progress('graph', filesProcessed, fileUris.length, allUnits.length, 'Resolving dependency graph…', project.label);
		const dependencyEdges = buildDependencyGraph(allUnits, rawDepEdges);
		for (const edge of dependencyEdges) {
			if (!edge.resolved) { continue; }
			const from = allUnits.find(u => u.id === edge.fromId);
			const to   = allUnits.find(u => u.id === edge.toId);
			if (from && !from.dependencies.includes(edge.toId)) { from.dependencies.push(edge.toId); }
			if (to   && !to.dependents.includes(edge.fromId))   { to.dependents.push(edge.fromId);   }
		}

		// ── Phase 5: call graph ────────────────────────────────────────────
		this._progress('call-graph', filesProcessed, fileUris.length, allUnits.length, 'Building call graph…', project.label);
		const unitNames = new Map(allUnits.map(u => [u.id, u.unitName]));
		const callGraphEdges = buildCallGraph(
			rawCallEntries,
			allUnits.map(u => u.id),
			unitNames,
		);

		// ── Phase 6: tech debt (cross-unit: clones + COBOL copy-paste) ─────
		this._progress('tech-debt', filesProcessed, fileUris.length, allUnits.length, 'Analysing tech debt…', project.label);
		const dominated = this._topLangs(langCounts);
		const dominantLang = dominated[0] ?? 'unknown';
		// Note: cross-unit clone detection needs per-unit content which is not retained
		// in memory after file processing (bounded memory model). COBOL copy-paste
		// detection is deferred — empty content produces no results.
		const cloneDebt = dominantLang === 'cobol'
			? detectCopyPasteCobol(allUnits.map(u => ({ unitId: u.id, content: '' })))
			: [];
		allTechDebtItems.push(...cloneDebt);

		// ── Aggregate ──────────────────────────────────────────────────────
		const grcSnapshot  = buildGRCSnapshot(allGRCViolations);
		const riskDist     = this._riskDist(allUnits);
		const scannedCount = filesProcessed - scanErrors.length;
		const effortDist   = summariseEffort(allEffortEstimates);

		// Compute most complex unit — use critical units as proxy (CC not retained in memory)
		let mostComplexUnitId = '';
		const mostComplexUnitCC = 0;
		const criticalUnits = allUnits.filter(u => u.riskLevel === 'critical');
		if (criticalUnits.length > 0) { mostComplexUnitId = criticalUnits[0].id; }

		const stats: IDiscoveryStats = {
			totalFilesWalked:      fileUris.length,
			totalFilesScanned:     scannedCount,
			totalFilesSkipped:     scanErrors.length,
			totalUnitsExtracted:   allUnits.length,
			languageDistribution:  langCounts,
			riskDistribution:      riskDist,
			effortDistribution:    effortDist,
			avgFileLines:          scannedCount > 0 ? Math.round(totalLines / scannedCount) : 0,
			avgUnitComplexity:     0,
			largestFileLines:      largestLines,
			largestFileUri,
			mostComplexUnitId,
			mostComplexUnitCC,
			criticalUnitCount:     allUnits.filter(u => u.riskLevel === 'critical').length,
			deadCodeUnitCount:     allTechDebtItems.filter(t => t.category === 'dead-code').length,
			techDebtItemCount:     allTechDebtItems.length,
			regulatedDataHitCount: allRegulatedHits.length,
			externalDependencyCount: metadata.detectedFrameworks.length,
			scanErrors:            scanErrors.filter((e): e is NonNullable<typeof e> => !!e),
			elapsedMs:             Date.now() - projectStart,
		};

		// Flush incremental cache
		await cache.flush();

		return {
			projectId:           project.id,
			projectLabel:        project.label,
			folderUri:           project.folderUri,
			dominantLanguage:    dominated[0] ?? 'unknown',
			secondaryLanguage:   dominated[1] !== dominated[0] ? dominated[1] : undefined,
			fileCount:           fileUris.length,
			units:               allUnits,
			grcSnapshot,
			metadata,
			dependencyEdges,
			callGraphEdges,
			apiEndpoints:        allAPIEndpoints,
			dataSchemas:         allDataSchemas,
			techDebtItems:       allTechDebtItems,
			regulatedDataHits:   allRegulatedHits,
			effortEstimates:     allEffortEstimates,
			externalDependencies: [],
			stats,
		};
	}

	// ─── _processFile() ──────────────────────────────────────────────────────

	/**
	 * Full processing pipeline for a single file:
	 * read \u2192 binary check \u2192 language detect \u2192 decompose \u2192 fingerprint \u2192 GRC scan
	 * \u2192 API surface \u2192 schema \u2192 regulated data \u2192 effort estimation
	 */
	private async _processFile(
		fileUri: URI,
		projectId: string,
		projectRoot: URI,
		patternFrameworkMap: IPatternFrameworkMap,
		cache?: IncrementalScanCache,
	): Promise<IFileProcessResult> {
		const fileName = this._basename(fileUri.path);
		const ext      = fileName.split('.').pop()?.toLowerCase() ?? '';

		// ── Read ──────────────────────────────────────────────────────────
		let content: string;
		let rawBytes: Uint8Array;
		try {
			const buf   = await this.fileService.readFile(fileUri);
			const value = buf.value;
			rawBytes = value.buffer instanceof ArrayBuffer
				? new Uint8Array(value.buffer)
				: new Uint8Array(value.buffer.buffer ?? new ArrayBuffer(0));
			content  = value.toString();
		} catch (e) {
			return {
				units: [], grcViolations: [], lang: 'unknown', lineCount: 0,
				dependencyEdges: [], callEdges: [], apiEndpoints: [],
				dataSchemas: [], techDebtItems: [], regulatedDataHits: [], effortEstimates: [],
				error: { fileUri: fileUri.toString(), reason: String(e), phase: 'read' },
			};
		}

		// ── Binary guard ─────────────────────────────────────────────────
		if (isBinary(rawBytes)) {
			return {
				units: [], grcViolations: [], lang: 'unknown', lineCount: 0,
				dependencyEdges: [], callEdges: [], apiEndpoints: [],
				dataSchemas: [], techDebtItems: [], regulatedDataHits: [], effortEstimates: [],
			};
		}

		// ── Incremental cache check ───────────────────────────────────────
		const contentHash = fnv1aHash(content);
		if (cache) {
			const cached = cache.get(fileUri, contentHash);
			if (cached) { return cached; }
		}

		content = stripBOM(content);

		// ── Language detection ───────────────────────────────────────────
		const lang  = detectLanguage(ext, content);
		const lines = content.split('\n');

		// ── Unit decomposition ───────────────────────────────────────────
		let decomposed: IDecomposedUnit[];
		try {
			decomposed = content.length <= MAX_DECOMPOSE_BYTES
				? decomposeFile(content, lang, fileName, lines)
				: [fileUnit(fileName, lines.length)];
		} catch {
			decomposed = [fileUnit(fileName, lines.length)];
		}

		// ── File-level dependency extraction ─────────────────────────────
		const fileImports = extractRawImports(content, lang);

		// ── GRC scan (whole file) ────────────────────────────────────────
		let grcViolations: ICheckResult[] = [];
		try {
			grcViolations = this.grcEngine.evaluateFileContent(fileUri, content);
		} catch { /* GRC engine may have no rules for this language — non-fatal */ }

		// ── Build IMigrationUnit per decomposed unit ──────────────────────
		const relPath = this._relativePath(fileUri.path, projectRoot.path);
		const units:     IMigrationUnit[] = [];
		const depEdges:  Array<{ fromUnitId: string; rawImport: string }> = [];

		for (const du of decomposed) {
			const unitViolations = grcViolations.filter(
				v => v.line >= du.range.startLine && v.line <= du.range.endLine,
			);

			// Layer 1 fingerprint on the unit's source slice
			const unitContent = lines.slice(du.range.startLine - 1, du.range.endLine).join('\n');
			let fingerprint: IComplianceFingerprint | undefined;
			let riskLevel: MigrationRiskLevel = riskFromGRC(unitViolations, 0);

			try {
				const det  = extractDeterministicFingerprint(unitContent, lang, du.name);
				riskLevel  = riskFromGRC(unitViolations, det.regulatedFields.length);
				fingerprint = {
					unitId:               du.name,
					extractedAt:          Date.now(),
					sourceLanguage:       lang,
					regulatedFields:      det.regulatedFields,
					invariants:           det.invariants,
					semanticRules:        [],
					complianceDomains:    [],
					llmExtractionComplete: false,
				};
			} catch { /* fingerprint failure — unit still emitted with raw risk */ }

			const unitId = `${projectId}::${relPath}::${du.name}`;
			units.push({
				id:             unitId,
				legacyFilePath: fileUri.toString(),
				legacyRange:    du.range,
				unitName:       du.name,
				unitType:       du.type,
				riskLevel,
				status:         'pending',
				dependencies:   [],
				dependents:     [],
				legacyFingerprint: fingerprint,
				approvals:      [],
			});

			// Import edges: use unit's own rawImports (from decomposer), plus file-level ones
			const unitImports = du.rawImports.length > 0 ? du.rawImports : fileImports;
			for (const rawImport of unitImports) {
				depEdges.push({ fromUnitId: unitId, rawImport });
			}
		}

		// ── Per-unit: API surface, schemas, regulated data, effort ───────────
		const allCallEdges:      IFileProcessResult['callEdges']          = [];
		const allAPIEndpoints:   IFileProcessResult['apiEndpoints']       = [];
		const allDataSchemas:    IFileProcessResult['dataSchemas']        = [];
		const allTechDebt:       IFileProcessResult['techDebtItems']      = [];
		const allRegulated:      IFileProcessResult['regulatedDataHits']  = [];
		const allEffort:         IFileProcessResult['effortEstimates']    = [];

		for (const unit of units) {
			const unitContent = lines.slice(unit.legacyRange.startLine - 1, unit.legacyRange.endLine).join('\n');
			const du = decomposed.find(d => `${projectId}::${this._relativePath(fileUri.path, projectRoot.path)}::${d.name}` === unit.id);

			// Call edges from decomposed unit rawCalls
			for (const call of (du?.rawCalls ?? [])) {
				allCallEdges.push({ fromUnitId: unit.id, callExpression: call });
			}

			// API surface
			allAPIEndpoints.push(...detectAPIEndpoints(unitContent, unit.id, lang, fileName));

			// Data schemas
			allDataSchemas.push(...extractDataSchemas(unitContent, unit.id, lang, fileName));

			// Regulated data scan — framework names come from loaded enterprise frameworks
			allRegulated.push(...scanForRegulatedData(unitContent, unit.id, fileUri.toString(), lang, patternFrameworkMap));

			// Complexity metrics
			const complexity = analyzeComplexity(unitContent, lang);

			// Tech debt
			const unitGRCViolations = grcViolations.filter(
				v => v.line >= unit.legacyRange.startLine && v.line <= unit.legacyRange.endLine,
			);
			allTechDebt.push(...analyzeUnitDebt({
				unitId:             unit.id,
				unitName:           unit.unitName,
				content:            unitContent,
				lang,
				complexity,
				allUnitIds:         units.map(u => u.id),
				allCallExpressions: du?.rawCalls ?? [],
				testUnitIds:        [],
			}));

			// Effort estimate
			allEffort.push(estimateMigrationEffort({
				unitId:              unit.id,
				lang,
				complexity,
				regulatedFieldCount: unit.legacyFingerprint?.regulatedFields.length ?? 0,
				grcViolationCount:   unitGRCViolations.length,
				techDebtItemCount:   allTechDebt.filter(t => t.unitId === unit.id).length,
			}));
		}

		const result: IFileProcessResult = {
			units,
			grcViolations,
			lang,
			lineCount:       lines.length,
			dependencyEdges: depEdges,
			callEdges:       allCallEdges,
			apiEndpoints:    allAPIEndpoints,
			dataSchemas:     allDataSchemas,
			techDebtItems:   allTechDebt,
			regulatedDataHits: allRegulated,
			effortEstimates: allEffort,
		};

		// Store in incremental cache
		if (cache) { cache.set(fileUri, contentHash, result); }

		return result;
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────

	private _topLangs(counts: Record<string, number>): [string, string] {
		const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
		return [sorted[0]?.[0] ?? 'unknown', sorted[1]?.[0] ?? 'unknown'];
	}

	private _riskDist(units: IMigrationUnit[]): Record<MigrationRiskLevel, number> {
		const d: Record<MigrationRiskLevel, number> = { critical: 0, high: 0, medium: 0, low: 0 };
		for (const u of units) { d[u.riskLevel]++; }
		return d;
	}

	private _relativePath(filePath: string, rootPath: string): string {
		const f = filePath.replace(/\\/g, '/');
		const r = rootPath.replace(/\\/g, '/');
		return f.startsWith(r) ? f.slice(r.length).replace(/^\//, '') : this._basename(filePath);
	}

	private _basename(path: string): string {
		return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path;
	}

	/**
	 * Build the pattern \u2192 framework names map from whatever enterprise frameworks
	 * the user has loaded into the Checks engine at this point in time.
	 *
	 * For each RegulatedDataPattern, scans every loaded framework's rules for
	 * matching tags (from PATTERN_TAGS). If a framework has at least one rule
	 * whose tags overlap the pattern's tag set, that framework's name is included
	 * in the applicable-frameworks list for that pattern.
	 *
	 * This means 'HIPAA', 'GDPR', 'PCI-DSS', etc. are NEVER hardcoded — they come
	 * from the actual framework.framework.name values the enterprise has imported.
	 */
	private _buildPatternFrameworkMap(): IPatternFrameworkMap {
		const frameworks = this.frameworkRegistry.getActiveFrameworks();
		if (frameworks.length === 0) { return {}; }

		const map: IPatternFrameworkMap = {};

		for (const [pattern, tags] of Object.entries(PATTERN_TAGS)) {
			const tagSet = new Set(tags.map(t => t.toLowerCase()));
			const names: string[] = [];

			for (const fw of frameworks) {
				const hasMatch = fw.definition.rules.some(
					rule => rule.tags?.some(t => tagSet.has(t.toLowerCase())),
				);
				if (hasMatch) {
					names.push(fw.definition.framework.name);
				}
			}

			if (names.length > 0) {
				map[pattern as keyof IPatternFrameworkMap] = names;
			}
		}

		return map;
	}

	private _progress(
		phase: IDiscoveryProgress['phase'],
		filesScanned: number,
		totalFiles: number,
		unitsFound: number,
		currentFile: string,
		projectLabel: string,
	): void {
		this._onDidProgress.fire({ phase, filesScanned, totalFiles, unitsFound, currentFile, projectLabel });
	}
}


registerSingleton(IDiscoveryService, DiscoveryService, InstantiationType.Delayed);
