/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ModernisationPart \u2014 dedicated auxiliary window console for Modernisation Mode.
 *
 * Opened via Cmd+Alt+M. Fully standalone \u2014 no sidebar.
 * Inherits the active VS Code colour theme via CSS custom properties.
 *
 * Screens:
 *  IDLE    \u2014 Create or open a Modernisation Project.
 *  WIZARD  \u2014 Step 1: Legacy folder · Step 2: Modern folder · Step 3: Migration pattern.
 *  ACTIVE  \u2014 Left: workflow stages + config · Right: compliance analysis pane.
 *            Stage 2 (Planning) has an explicit approval gate before Stage 3 unlocks.
 */

import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { Part } from '../../../../browser/part.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IFingerprintComparisonService } from '../stage3-migration/fingerprintComparisonService.js';
import { ILLMSemanticExtractorService } from '../engine/fingerprint/llmSemanticExtractor.js';
import { extractDeterministicFingerprint } from '../engine/fingerprint/deterministicExtractor.js';
import {
	IComplianceFingerprint, IFingerprintComparison, IFingerprintDivergence,
	IMigrationRoadmap, MigrationRiskLevel,
} from '../../common/modernisationTypes.js';
import {
	IModernisationSessionService,
	IModernisationSessionData,
	IProjectTarget,
	IPatternTopology,
	STAGES,
	STAGE_LABELS,
	ModernisationStage,
	MigrationPattern,
	MIGRATION_PATTERN_PRESETS,
	MIGRATION_PATTERN_LABELS,
	MIGRATION_PATTERN_DESCRIPTIONS,
} from '../modernisationSessionService.js';
import { IDiscoveryService } from '../engine/discovery/discoveryService.js';
import { IDiscoveryResult, IProjectScanResult } from '../engine/discovery/discoveryTypes.js';
import { complianceScoreFromSnapshot, primaryFrameworkFromSnapshot, SAFETY_CRITICAL_DOMAINS, mergeGRCSnapshots } from '../engine/discovery/grcSnapshotBuilder.js';
import { IKnowledgeUnit, IKnowledgeFile, ITypeMappingDecision, INamingDecision } from '../../common/knowledgeBaseTypes.js';
import { IMigrationPlannerService } from '../engine/migrationPlannerService.js';
import { IKnowledgeBaseService } from '../knowledgeBase/service.js';
import { IModernisationAgentToolService } from '../engine/agentTools/service.js';
import { IValidationEngineService } from '../engine/validation/service.js';
import { ICutoverService } from '../engine/cutover/service.js';
import { IAutonomyService } from '../engine/autonomy/service.js';
import { ModernisationConsole } from './console/modernisationConsole.js';
import { IFirmwareSessionService } from '../../../neuralInverseFirmware/browser/firmwareSessionService.js';
import { IMCUDatabaseService } from '../../../neuralInverseFirmware/browser/mcuDatabaseService.js';
import { IFirmwareModuleConfig } from '../modernisationSessionService.js';

// \u2500\u2500\u2500 Stage metadata \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const STAGE_DESCRIPTIONS: Record<ModernisationStage, string> = {
	discovery:  'Scan the legacy codebase. Identify and fingerprint all migration units.',
	planning:   'AI generates migration roadmap. Review and approve before migration begins.',
	migration:  'Translate each unit. Run compliance fingerprint comparison per unit.',
	validation: 'Run equivalence tests. Verify compliance invariants hold.',
	cutover:    'Final approval gate. Commit translated code to production branch.',
};


// \u2500\u2500\u2500 Storage keys \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const DISCOVERY_STORAGE_KEY = 'neuralInverse.modernisation.discoveryResult.v1';
const ROADMAP_STORAGE_KEY   = 'neuralInverse.modernisation.roadmap.v1';

// \u2500\u2500\u2500 DOM helpers (no innerHTML \u2014 Trusted Types compliant) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function $e<K extends keyof HTMLElementTagNameMap>(tag: K, css?: string): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	if (css) { el.style.cssText = css; }
	return el;
}

function $t<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, css?: string): HTMLElementTagNameMap[K] {
	const el = $e(tag, css);
	el.textContent = text;
	return el;
}

// \u2500\u2500\u2500 Part \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class ModernisationPart extends Part {

	static readonly ID = 'workbench.parts.neuralInverseModernisation';

	minimumWidth  = 860;
	maximumWidth  = Infinity;
	minimumHeight = 580;
	maximumHeight = Infinity;

	override toJSON(): object { return { id: ModernisationPart.ID }; }

	private readonly _disposables = new DisposableStore();

	// Wizard state
	private _wizardMode    = false;
	private _wizardStep: 1 | 2 = 1; // 1 = project/pattern picker, 2 = firmware config
	private _wizardSources: Array<{ uri: URI; label: string }> = [];
	private _wizardTargets: Array<{ uri: URI; label: string }> = [];
	private _wizardPattern: MigrationPattern | undefined;
	private _wizardBusy    = false;
	/** Firmware config captured in wizard step 2 \u2014 saved to session on Initialise. */
	private _wizardFirmware: IFirmwareModuleConfig = { complianceFrameworks: [] };
	/** Last MCU search query \u2014 preserved across step 1 \u2194 step 2 navigation. */
	private _wizardMcuQuery = '';

	// Analysis result area
	private _resultsEl!: HTMLElement;

	// Stage 1 discovery state
	private _discoveryResult:  IDiscoveryResult | undefined;
	private _discoveryRunning: boolean = false;
	private _discoveryLog:     string[] = [];
	private _discoveryLogEl:   HTMLElement | undefined;

	// Stage 2 planning state
	private _roadmap:        IMigrationRoadmap | undefined;
	private _plannerRunning: boolean = false;
	private _plannerLog:     string[] = [];
	private _plannerLogEl:   HTMLElement | undefined;

	private _root!: HTMLElement;

	// The 4-tab console shown in migration and validation stages
	private _console: ModernisationConsole | undefined;

	constructor(
		@IThemeService           themeService: IThemeService,
		@IStorageService         private readonly _storage: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IModernisationSessionService private readonly sessionService: IModernisationSessionService,
		@IFileDialogService      private readonly fileDialogService: IFileDialogService,
		@IFileService            private readonly fileService: IFileService,
		@ICommandService         private readonly commandService: ICommandService,
		@IFingerprintComparisonService private readonly comparisonService: IFingerprintComparisonService,
		@ILLMSemanticExtractorService  private readonly semanticExtractor: ILLMSemanticExtractorService,
		@IDiscoveryService       private readonly discoveryService: IDiscoveryService,
		@IMigrationPlannerService private readonly plannerService: IMigrationPlannerService,
		@IKnowledgeBaseService          private readonly kbService:         IKnowledgeBaseService,
		@IModernisationAgentToolService private readonly agentToolsService: IModernisationAgentToolService,
		@IValidationEngineService       private readonly validationService: IValidationEngineService,
		@ICutoverService                private readonly cutoverService:    ICutoverService,
		@IAutonomyService               private readonly autonomyService:   IAutonomyService,
		@IFirmwareSessionService        private readonly _fwSession:        IFirmwareSessionService,
		@IMCUDatabaseService            private readonly _mcuDb:            IMCUDatabaseService,
	) {
		super(ModernisationPart.ID, { hasTitle: false }, themeService, _storage, layoutService);
		this._tryRestoreFromStorage();

		// Initialise the KB as soon as a session becomes active so the console
		// shows units rather than "Knowledge base not active".
		// kb.init() is idempotent when called with the same sessionId \u2014 safe to
		// call on every onDidChangeSession fire while the session is active.
		const initKBIfNeeded = (s: IModernisationSessionData) => {
			if (!s.isActive || kbService.isActive) { return; }
			// Prefer the sessionId stored in the .inverse file.  For sessions that
			// were created before the sessionId field was added (or loaded from
			// storage before the field existed) fall back to a deterministic key
			// derived from the first source folder so the KB storage key is stable
			// across IDE restarts.
			const sid = s.sessionId
				?? (s.sources[0]?.folderUri
					? `ni-kb-${s.sources[0].folderUri.replace(/[^a-zA-Z0-9_.-]/g, '-')}`
					: `ni-kb-default`);
			kbService.init(sid).then(() => {
				// Seed KB with any already-completed discovery units so the console
				// shows units immediately rather than waiting for a re-scan.
				if (this._discoveryResult) {
					this._seedKBFromDiscovery(this._discoveryResult);
				}
			}).catch(() => { /* storage error \u2014 non-fatal */ });
		};

		// Initialise immediately if a session is already active at construction time
		initKBIfNeeded(sessionService.session);

		this._disposables.add(sessionService.onDidChangeSession(s => {
			if (!s.isActive) {
				// Session ended \u2014 close KB and clear persisted results
				kbService.close();
				this._discoveryResult = undefined;
				this._roadmap         = undefined;
				this._persistDiscovery();
				this._persistRoadmap();
			} else {
				initKBIfNeeded(s);
			}
			this._render();
		}));
	}

	// \u2500\u2500\u2500 Storage persistence \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _tryRestoreFromStorage(): void {
		const rawDiscovery = this._storage.get(DISCOVERY_STORAGE_KEY, StorageScope.WORKSPACE);
		if (rawDiscovery) {
			try { this._discoveryResult = JSON.parse(rawDiscovery); } catch { /* corrupt \u2014 ignore */ }
		}
		const rawRoadmap = this._storage.get(ROADMAP_STORAGE_KEY, StorageScope.WORKSPACE);
		if (rawRoadmap) {
			try { this._roadmap = JSON.parse(rawRoadmap); } catch { /* corrupt \u2014 ignore */ }
		}
	}

	private _persistDiscovery(): void {
		if (this._discoveryResult) {
			this._storage.store(DISCOVERY_STORAGE_KEY, JSON.stringify(this._discoveryResult), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this._storage.remove(DISCOVERY_STORAGE_KEY, StorageScope.WORKSPACE);
		}
	}

	private _persistRoadmap(): void {
		if (this._roadmap) {
			this._storage.store(ROADMAP_STORAGE_KEY, JSON.stringify(this._roadmap), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this._storage.remove(ROADMAP_STORAGE_KEY, StorageScope.WORKSPACE);
		}
	}

	/**
	 * Seed the KB with units from a discovery result.
	 *
	 * Only source units are seeded \u2014 target units are the output of migration and
	 * do not need to be tracked as migration atoms in the KB.
	 *
	 * Already-migrated services are detected via crossProjectPairings: if a source
	 * unit already has a paired target unit on disk, it is seeded as 'committed'
	 * with targetFile populated so the Unit Index reflects real progress.
	 *
	 * Idempotent \u2014 safe to call multiple times (e.g. on reload).
	 */
	private _seedKBFromDiscovery(discovery: IDiscoveryResult): void {
		if (!this.kbService.isActive) { return; }
		const now = Date.now();

		// Build lookup: targetUnitId \u2192 { filePath, language } for all target units
		const targetUnitMap = new Map<string, { filePath: string; lang: string }>();
		for (const targetScan of discovery.targets) {
			for (const unit of targetScan.units) {
				targetUnitMap.set(unit.id, { filePath: unit.legacyFilePath, lang: targetScan.dominantLanguage });
			}
		}

		// Build lookup: sourceUnitId \u2192 best pairing (highest confidence wins)
		// Any valid pairing (confidence \u2265 0.20, the global filter threshold) means
		// the source unit already has a mapped counterpart in the target \u2014 mark committed.
		const sourceToTarget = new Map<string, { targetFile: string; confidence: number }>();
		for (const pairing of discovery.crossProjectPairings) {
			const tgt = targetUnitMap.get(pairing.targetUnitId);
			if (tgt) {
				const existing = sourceToTarget.get(pairing.sourceUnitId);
				if (!existing || pairing.confidenceScore > existing.confidence) {
					sourceToTarget.set(pairing.sourceUnitId, { targetFile: tgt.filePath, confidence: pairing.confidenceScore });
				}
			}
		}

		const toAdd: IKnowledgeUnit[] = [];
		const toUpdate: Array<{ id: string; patch: Partial<IKnowledgeUnit> }> = [];

		// \u2500\u2500 Source units \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		for (const scan of discovery.sources) {
			for (const unit of scan.units) {
				const pairing    = sourceToTarget.get(unit.id);
				const targetFile = pairing?.targetFile;
				// Any cross-project pairing means a target implementation exists \u2192 committed
				// No pairing means nothing has been written yet \u2192 pending
				const newStatus: IKnowledgeUnit['status'] = targetFile ? 'committed' : 'pending';

				if (this.kbService.hasUnit(unit.id)) {
					const existing = this.kbService.getUnit(unit.id)!;
					// Only auto-adjust status if no real translation work has been done yet
					// (i.e. unit hasn't been manually moved past committed, has no targetText
					// from an actual translation run, and has no approvals).
					const isUntouched = !existing.targetText && (!existing.approvals || existing.approvals.length === 0);
					const statusChanged = existing.status !== newStatus;
					if (isUntouched && statusChanged) {
						toUpdate.push({ id: unit.id, patch: { status: newStatus, targetFile: targetFile ?? existing.targetFile, updatedAt: now } });
					} else if (targetFile && !existing.targetFile) {
						toUpdate.push({ id: unit.id, patch: { targetFile, updatedAt: now } });
					}
					continue;
				}
				toAdd.push({
					id:             unit.id,
					sourceFile:     unit.legacyFilePath,
					sourceRange:    unit.legacyRange,
					sourceLang:     scan.dominantLanguage,
					sourceText:     '',
					resolvedSource: '',
					name:           unit.unitName,
					unitType:       unit.unitType as IKnowledgeUnit['unitType'],
					riskLevel:      unit.riskLevel,
					dependsOn:      unit.dependencies,
					usedBy:         unit.dependents,
					businessRules:  [],
					status:         newStatus,
					targetFile,
					approvals:      [],
					createdAt:      now,
					updatedAt:      now,
				});
			}
		}

		// \u2500\u2500 Target units \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		// Add ALL target units to the KB so total = source + target (294, not 256).
		// Target units that are paired with a source unit are already committed.
		// Unpaired target units (new architecture not yet linked to source) are also committed
		// since they physically exist in the target project.
		for (const scan of discovery.targets) {
			for (const unit of scan.units) {
				if (this.kbService.hasUnit(unit.id)) { continue; }
				toAdd.push({
					id:             unit.id,
					sourceFile:     unit.legacyFilePath,
					sourceRange:    unit.legacyRange,
					sourceLang:     scan.dominantLanguage,
					sourceText:     '',
					resolvedSource: '',
					name:           unit.unitName,
					unitType:       unit.unitType as IKnowledgeUnit['unitType'],
					riskLevel:      unit.riskLevel,
					dependsOn:      unit.dependencies,
					usedBy:         unit.dependents,
					businessRules:  [],
					// Target units already exist in the target project \u2014 always committed
					status:         'committed',
					targetFile:     unit.legacyFilePath,
					approvals:      [],
					createdAt:      now,
					updatedAt:      now,
				});
			}
		}

		// \u2500\u2500 File registry \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const fileMap = new Map<string, IKnowledgeFile>();
		for (const scan of [...discovery.sources, ...discovery.targets]) {
			for (const unit of scan.units) {
				if (!fileMap.has(unit.legacyFilePath)) {
					fileMap.set(unit.legacyFilePath, {
						path:         unit.legacyFilePath,
						language:     scan.dominantLanguage,
						unitIds:      [],
						lineCount:    unit.legacyRange ? (unit.legacyRange.endLine - unit.legacyRange.startLine + 1) : 0,
						sizeBytes:    0,
						decomposed:   true,
						discoveredAt: now,
					});
				}
				fileMap.get(unit.legacyFilePath)!.unitIds.push(unit.id);
			}
		}

		if (toAdd.length === 0 && toUpdate.length === 0 && fileMap.size === 0) { return; }
		this.kbService.batchBegin();
		if (fileMap.size > 0)    { this.kbService.addFiles([...fileMap.values()]); }
		if (toAdd.length > 0)    { this.kbService.addUnits(toAdd); }
		if (toUpdate.length > 0) { this.kbService.updateUnits(toUpdate); }
		this.kbService.batchEnd();

		// Pre-seed decision log with standard type mappings for the detected language pair.
		// Only do this once \u2014 if there are already decisions recorded, skip.
		const existingDecisions = this.kbService.getDecisions();
		const hasDecisions = existingDecisions.typeMapping.length > 0 || existingDecisions.naming.length > 0;
		if (!hasDecisions) {
			const srcLang = discovery.sources[0]?.dominantLanguage ?? '';
			const tgtLang = discovery.targets[0]?.dominantLanguage ?? '';
			this._seedDecisionLog(srcLang, tgtLang, now);
		}
	}

	private _seedDecisionLog(srcLang: string, tgtLang: string, now: number): void {
		const pair = `${srcLang}\u2192${tgtLang}`;
		type TypeMapping = [string, string, string]; // [sourceType, targetType, rationale]
		const typeMappings: TypeMapping[] = [];
		const namingDecisions: Array<[string, string, string]> = []; // [sourceName, targetName, domain]

		if (pair === 'javascript\u2192java' || pair === 'typescript\u2192java') {
			typeMappings.push(
				['string',              'String',                      'JS string is immutable, maps to Java String'],
				['number',              'int / long / double',          'JS number is float64; use int/long for integers, double for decimals'],
				['boolean',             'boolean',                     'Direct equivalent'],
				['any',                 'Object',                      'Untyped JS value maps to Java Object'],
				['Array<T>',            'List<T>',                     'JS Array maps to java.util.List'],
				['object',              'Map<String, Object>',         'Generic JS object maps to java.util.Map'],
				['null / undefined',    'null / Optional<T>',          'JS null/undefined; prefer Optional<T> for return types'],
				['Promise<T>',          'CompletableFuture<T>',        'JS async/await maps to Java CompletableFuture'],
				['Error',               'Exception / RuntimeException','JS Error hierarchy maps to Java Exception hierarchy'],
				['Date',                'LocalDateTime / Instant',     'JS Date maps to java.time.LocalDateTime or Instant'],
				['Buffer',              'byte[]',                      'Node.js Buffer maps to Java byte array'],
				['Map<K,V>',            'HashMap<K,V>',                'JS Map maps to java.util.HashMap'],
				['Set<T>',              'HashSet<T>',                  'JS Set maps to java.util.HashSet'],
				['RegExp',              'Pattern',                     'JS RegExp maps to java.util.regex.Pattern'],
				['number (currency)',   'BigDecimal',                  'Monetary values must use BigDecimal to avoid float precision loss'],
			);
			namingDecisions.push(
				['camelCase functions',  'camelCase methods',          'naming'],
				['PascalCase classes',   'PascalCase classes',         'naming'],
				['UPPER_SNAKE constants','UPPER_SNAKE static final',   'naming'],
				['get*/set* accessors',  'getX()/setX() JavaBeans',    'naming'],
				['handler functions',    'doHandle() / process()',     'naming'],
			);
		} else if (pair === 'javascript\u2192typescript' || pair === 'typescript\u2192typescript') {
			typeMappings.push(
				['any',    'unknown',  'Prefer unknown over any for type safety'],
				['object', 'Record<string, unknown>', 'Typed object literal'],
			);
		} else if (pair === 'cobol\u2192java' || pair === 'cobol\u2192typescript') {
			typeMappings.push(
				['PIC 9(n)',        'int / long',      'COBOL fixed integer maps to Java int/long'],
				['PIC 9(n)V9(m)',   'BigDecimal',      'COBOL decimal maps to BigDecimal for precision'],
				['PIC X(n)',        'String',          'COBOL alphanumeric maps to String'],
				['PIC A(n)',        'String',          'COBOL alphabetic maps to String'],
				['COMP-3',          'BigDecimal',      'Packed decimal maps to BigDecimal'],
				['COMP / BINARY',   'int / long',      'Binary integer maps to Java int/long'],
				['88 level',        'boolean / enum',  'Condition names map to boolean flags or enum values'],
			);
		}

		for (const [sourceType, targetType, rationale] of typeMappings) {
			const decision: ITypeMappingDecision = {
				id:         `seed-${srcLang}-${targetType.replace(/[^a-zA-Z0-9]/g, '_')}-${now}`,
				sourceType,
				targetType,
				rationale,
				appliesTo:  [],
				decidedBy:  'system',
				decidedAt:  now,
				confidence: 0.9,
			};
			this.kbService.recordTypeMappingDecision(decision);
		}

		for (const [sourceName, targetName, domain] of namingDecisions) {
			const decision: INamingDecision = {
				id:         `seed-naming-${sourceName.replace(/[^a-zA-Z0-9]/g, '_')}-${now}`,
				sourceName,
				targetName,
				domain,
				decidedBy:  'system',
				decidedAt:  now,
			};
			this.kbService.recordNamingDecision(decision);
		}
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this._root = $e('div', [
			'display:flex', 'flex-direction:column',
			'width:100%', 'height:100%', 'overflow:hidden',
			'background:var(--vscode-editor-background)',
			'color:var(--vscode-editor-foreground)',
			'font-family:var(--vscode-font-family,system-ui,sans-serif)',
			'font-size:13px',
		].join(';'));
		parent.appendChild(this._root);
		this._render();
		return parent;
	}

	// \u2500\u2500\u2500 Render dispatcher \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _render(): void {
		while (this._root.firstChild) { this._root.removeChild(this._root.firstChild); }
		const session = this.sessionService.session;

		// Dispose the console when the session is no longer active
		if (!session.isActive && this._console) {
			this._console.dispose();
			this._console = undefined;
		}

		this._root.appendChild(this._buildTopBar(session));
		const body = $e('div', 'flex:1;overflow:hidden;display:flex;flex-direction:column;');
		this._root.appendChild(body);
		if (session.isActive) {
			this._wizardMode = false;
			this._renderActive(body, session);
		} else if (this._wizardMode) {
			this._renderWizard(body);
		} else {
			this._renderIdle(body);
		}
	}

	// \u2500\u2500\u2500 Top bar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _buildTopBar(session: IModernisationSessionData): HTMLElement {
		const bar = $e('div', [
			'display:flex', 'align-items:center', 'gap:12px',
			'height:36px', 'min-height:36px', 'padding:0 16px',
			'background:var(--vscode-titleBar-activeBackground,var(--vscode-sideBarSectionHeader-background))',
			'border-bottom:1px solid var(--vscode-panel-border,var(--vscode-widget-border))',
			'flex-shrink:0',
		].join(';'));

		const brand = $t('span', '\u2297 Neural Inverse  \u00b7  Modernisation Console',
			'color:var(--vscode-titleBar-activeForeground,var(--vscode-foreground));font-weight:700;font-size:12px;letter-spacing:0.04em;flex:1;');
		bar.appendChild(brand);

		if (session.isActive) {
			const stageEl = $t('span', STAGE_LABELS[session.currentStage], [
				'font-size:11px', 'font-weight:600',
				'background:var(--vscode-badge-background)',
				'color:var(--vscode-badge-foreground)',
				'border-radius:3px', 'padding:2px 8px', 'letter-spacing:0.03em',
			].join(';'));
			bar.appendChild(stageEl);

			if (session.migrationPattern) {
				const patternEl = $t('span', MIGRATION_PATTERN_LABELS[session.migrationPattern], [
					'font-size:10px', 'color:var(--vscode-descriptionForeground)',
					'border:1px solid var(--vscode-widget-border)',
					'border-radius:3px', 'padding:1px 7px',
				].join(';'));
				bar.appendChild(patternEl);
			}

			// \u2500\u2500 Firmware hardware context badges \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
			// Prefer the firmware config stored on the modernisation session.
			// Fall back to the live firmware session if a sibling Firmware Console
			// is open and has an active MCU configured.
			const fwCfg    = session.firmwareConfig;
			const fwLive   = this._fwSession.session;
			const mcuLabel = fwCfg?.mcuVariant ?? fwLive.mcuConfig?.variant;
			const rtosLabel = fwCfg?.rtos ?? fwLive.rtos;
			const buildLabel = fwCfg?.buildSystem ?? fwLive.buildSystem;

			const _badge = (text: string, primary: boolean) => $t('span', text, [
				'font-size:10px',
				primary
					? 'background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-weight:600;'
					: 'color:var(--vscode-descriptionForeground)',
				'border:1px solid var(--vscode-widget-border)',
				'border-radius:3px', 'padding:1px 7px',
			].join(';'));

			if (mcuLabel)   { bar.appendChild(_badge(mcuLabel, true)); }
			if (rtosLabel)  { bar.appendChild(_badge(rtosLabel, false)); }
			if (buildLabel) { bar.appendChild(_badge(buildLabel, false)); }

			bar.appendChild(this._btn('End Session', false, () => this.sessionService.endSession(),
				'font-size:11px;padding:3px 10px;'));
		}

		bar.appendChild($t('span', 'Cmd+Alt+M', 'color:var(--vscode-descriptionForeground);font-size:10px;opacity:0.5;'));
		return bar;
	}

	// \u2500\u2500\u2500 IDLE screen \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _renderIdle(root: HTMLElement): void {
		const wrap = $e('div', [
			'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center',
			'flex:1', 'padding:40px 32px', 'gap:0',
		].join(';'));

		wrap.appendChild($t('div', '\u2297',
			'font-size:52px;color:var(--vscode-descriptionForeground);opacity:0.2;margin-bottom:16px;line-height:1;'));
		wrap.appendChild($t('h2', 'Modernisation Mode',
			'font-size:20px;font-weight:700;color:var(--vscode-editor-foreground);margin:0 0 8px;'));
		wrap.appendChild($t('p', 'Pair a legacy codebase with its modern translation target. Fingerprint, compare, and validate compliance across every migration unit.',
			'font-size:12px;color:var(--vscode-descriptionForeground);text-align:center;max-width:460px;line-height:1.7;margin:0 0 36px;'));

		const createCard = this._idleCard();
		createCard.appendChild($t('div', 'New Modernisation Project',
			'font-size:14px;font-weight:700;color:var(--vscode-editor-foreground);margin-bottom:6px;'));
		createCard.appendChild($t('div', 'Pair a legacy codebase with a modern translation target. Choose your migration architecture pattern and initialise the workspace.',
			'font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.6;margin-bottom:16px;'));
		createCard.appendChild(this._btn('Create Modernisation Project \u2192', true, () => {
			this._wizardMode    = true;
			this._wizardStep    = 1;
			this._wizardSources = [];
			this._wizardTargets = [];
			this._wizardPattern = undefined;
			this._wizardFirmware = { complianceFrameworks: [] };
			this._render();
		}));
		wrap.appendChild(createCard);

		wrap.appendChild($e('div', 'height:12px;'));

		const openCard = this._idleCard();
		openCard.appendChild($t('div', 'Open Existing Project',
			'font-size:14px;font-weight:700;color:var(--vscode-editor-foreground);margin-bottom:6px;'));
		openCard.appendChild($t('div', 'Restore a session from a folder that already contains a Modernisation.inverse file.',
			'font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.6;margin-bottom:16px;'));
		openCard.appendChild(this._btn('Open Existing Project', false, async () => {
			const uris = await this.fileDialogService.showOpenDialog({
				title: 'Open Modernisation Project \u2014 select a folder with Modernisation.inverse',
				canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
			});
			if (!uris?.[0]) { return; }
			const ok = await this.sessionService.openExistingProject(uris[0]);
			if (!ok) {
				this._wizardMode    = true;
				this._wizardStep    = 1;
				this._wizardSources = [{ uri: uris[0], label: this._basename(uris[0].path) }];
				this._wizardTargets = [];
				this._wizardPattern = undefined;
				this._wizardFirmware = { complianceFrameworks: [] };
				this._render();
			}
		}));
		wrap.appendChild(openCard);

		root.appendChild(wrap);
	}

	private _idleCard(): HTMLElement {
		return $e('div', [
			'border:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
			'border-radius:8px', 'padding:20px 22px',
			'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
			'width:100%', 'max-width:500px', 'box-sizing:border-box',
		].join(';'));
	}

	// \u2500\u2500\u2500 WIZARD screen \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _renderWizard(root: HTMLElement): void {
		if (this._wizardStep === 2) {
			this._renderWizardStep2(root);
			return;
		}
		this._renderWizardStep1(root);
	}

	/** Step 1 \u2014 project folder pickers + migration pattern selector (untouched from original). */
	private _renderWizardStep1(root: HTMLElement): void {
		// Derive topology from selected pattern (if any)
		const preset = MIGRATION_PATTERN_PRESETS.find(p => p.id === this._wizardPattern);
		const topology: IPatternTopology = preset?.topology ?? {
			sourceCount: 'flexible', targetCount: 'flexible',
			sourceLabel: 'Source Project', targetLabel: 'Target Project',
		};

		// Top bar with title + cancel
		const topBar = $e('div', [
			'display:flex', 'align-items:center', 'gap:12px',
			'padding:16px 24px', 'border-bottom:1px solid var(--vscode-panel-border,var(--vscode-widget-border))',
			'flex-shrink:0',
		].join(';'));
		topBar.appendChild($t('h2', 'New Modernisation Project',
			'font-size:15px;font-weight:700;color:var(--vscode-editor-foreground);margin:0;flex:1;'));
		topBar.appendChild(this._btn('Cancel', false, () => { this._wizardMode = false; this._render(); },
			'font-size:11px;padding:4px 12px;'));
		root.appendChild(topBar);

		// Two-panel layout: left = project pickers + note + init, right = pattern picker
		const body = $e('div', 'flex:1;display:flex;overflow:hidden;');
		root.appendChild(body);

		// \u2500\u2500 Left panel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const left = $e('div', [
			'width:340px', 'min-width:280px', 'flex-shrink:0',
			'display:flex', 'flex-direction:column', 'gap:10px',
			'padding:20px', 'overflow-y:auto',
			'border-right:1px solid var(--vscode-panel-border,var(--vscode-widget-border))',
		].join(';'));

		// Source projects
		left.appendChild($t('div', `Sources \u2014 ${topology.sourceLabel}`,
			'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-descriptionForeground);margin-bottom:2px;'));
		for (let i = 0; i < Math.max(1, this._wizardSources.length); i++) {
			const src = this._wizardSources[i];
			const idx = i;
			left.appendChild(this._folderStep(
				String(i + 1),
				src?.label ?? topology.sourceLabel,
				i === 0 ? 'The legacy firmware or industrial codebase to be modernised (Bare-metal C, Assembly, Ladder Logic, FreeRTOS, etc.)' : `Additional ${topology.sourceLabel}`,
				src?.uri,
				`Select ${topology.sourceLabel} Folder`,
				async () => {
					const uris = await this.fileDialogService.showOpenDialog({
						title: `Select ${topology.sourceLabel} Folder`,
						canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
					});
					if (uris?.[0]) {
						const label = this._basename(uris[0].path);
						if (idx < this._wizardSources.length) {
							this._wizardSources[idx] = { uri: uris[0], label };
						} else {
							this._wizardSources.push({ uri: uris[0], label });
						}
						this._render();
					}
				},
				src ? () => { this._wizardSources.splice(idx, 1); this._render(); } : undefined,
			));
		}
		if (topology.sourceCount === 'many' || topology.sourceCount === 'flexible') {
			const addSrc = this._btn(`+ Add ${topology.sourceLabel}`, false, () => {
				this._wizardSources.push({ uri: URI.parse(''), label: '' });
				this._render();
			}, 'font-size:11px;padding:3px 10px;width:100%;text-align:center;margin-top:2px;');
			left.appendChild(addSrc);
		}

		left.appendChild($e('div', 'height:6px;border-bottom:1px solid var(--vscode-widget-border);'));

		// Target projects
		left.appendChild($t('div', `Targets \u2014 ${topology.targetLabel}`,
			'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-descriptionForeground);margin-top:6px;margin-bottom:2px;'));
		for (let i = 0; i < Math.max(1, this._wizardTargets.length); i++) {
			const tgt = this._wizardTargets[i];
			const idx = i;
			left.appendChild(this._folderStep(
				String(i + 1),
				tgt?.label ?? topology.targetLabel,
				i === 0 ? 'New or existing target for the translated code (FreeRTOS C, Zephyr, MISRA-C++, Structured Text, OPC-UA, etc.)' : `Additional ${topology.targetLabel}`,
				tgt?.uri,
				`Select ${topology.targetLabel} Folder`,
				async () => {
					const uris = await this.fileDialogService.showOpenDialog({
						title: `Select ${topology.targetLabel} Folder`,
						canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
					});
					if (uris?.[0]) {
						const label = this._basename(uris[0].path);
						if (idx < this._wizardTargets.length) {
							this._wizardTargets[idx] = { uri: uris[0], label };
						} else {
							this._wizardTargets.push({ uri: uris[0], label });
						}
						this._render();
					}
				},
				tgt ? () => { this._wizardTargets.splice(idx, 1); this._render(); } : undefined,
			));
		}
		if (topology.targetCount === 'many' || topology.targetCount === 'flexible') {
			const addTgt = this._btn(`+ Add ${topology.targetLabel}`, false, () => {
				this._wizardTargets.push({ uri: URI.parse(''), label: '' });
				this._render();
			}, 'font-size:11px;padding:3px 10px;width:100%;text-align:center;margin-top:2px;');
			left.appendChild(addTgt);
		}

		// Modernisation.inverse note
		const note = $e('div', [
			'padding:10px 12px', 'margin-top:8px',
			'background:var(--vscode-input-background)',
			'border:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
			'border-left:3px solid var(--vscode-button-background)',
			'border-radius:0 4px 4px 0',
		].join(';'));
		note.appendChild($t('div', 'Modernisation.inverse',
			'font-size:10px;font-weight:700;color:var(--vscode-button-background);letter-spacing:0.07em;margin-bottom:4px;'));
		note.appendChild($t('div',
			'Written to every project root. Links all paired projects without modifying source files.',
			'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5;'));
		left.appendChild(note);

		// Spacer + Next button
		left.appendChild($e('div', 'flex:1;min-height:12px;'));

		const validSources = this._wizardSources.filter(s => s.uri.path);
		const validTargets = this._wizardTargets.filter(t => t.uri.path);
		const canNext = validSources.length > 0 && validTargets.length > 0 && !!this._wizardPattern;

		// Dummy init button reference passed to _patternPanel so it can toggle the canNext state
		const nextBtn = this._btn(
			'Next \u2192 Firmware Config',
			true,
			() => {
				if (!canNext) { return; }
				this._wizardStep = 2;
				this._render();
			},
			'width:100%;text-align:center;padding:8px 14px;font-size:13px;',
		);
		if (!canNext) {
			(nextBtn as HTMLButtonElement).disabled = true;
			nextBtn.style.opacity = '0.4';
			nextBtn.style.cursor  = 'not-allowed';
		}
		left.appendChild(nextBtn);

		body.appendChild(left);

		// \u2500\u2500 Right panel \u2014 pattern picker \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		body.appendChild(this._patternPanel(nextBtn as HTMLButtonElement));
	}

	/** Step 2 \u2014 Market Vertical Config. Content adapts to the selected pattern category. */
	private _renderWizardStep2(root: HTMLElement): void {
		// Determine pattern category
		const preset    = MIGRATION_PATTERN_PRESETS.find(p => p.id === this._wizardPattern);
		const category  = preset?.category ?? '';
		const isFirmware  = ['Firmware Modernisation', 'Architecture', 'Safety & Compliance'].includes(category);
		const isAutosar   = category === 'Automotive' || this._wizardPattern === 'autosar-classic-to-adaptive' || this._wizardPattern === 'autosar-cp-to-ap';
		const isEnergy    = category === 'Critical Infrastructure';
		const isTelecom   = category === 'Telecom & 5G';
		const isIIoT      = category === 'Industrial IoT & OT' || category === 'Industrial & OT';
		const isAnyVertical = isFirmware || isAutosar || isEnergy || isTelecom || isIIoT;

		// Section title per vertical
		const stepTitle = isEnergy   ? 'Step 2 of 2  \u2014  Energy / Critical Infrastructure Config'
			: isTelecom  ? 'Step 2 of 2  \u2014  Telecom & 5G Config'
			: isIIoT     ? 'Step 2 of 2  \u2014  Industrial IoT / OT Config'
			: isAutosar  ? 'Step 2 of 2  \u2014  Automotive / AUTOSAR Config'
			: 'Step 2 of 2  \u2014  Project Config';

		// Top bar
		const topBar = $e('div', [
			'display:flex', 'align-items:center', 'gap:12px',
			'padding:16px 24px', 'border-bottom:1px solid var(--vscode-panel-border,var(--vscode-widget-border))',
			'flex-shrink:0',
		].join(';'));
		topBar.appendChild($t('span', 'Step 1 of 2  \u2014  Projects \u0026 Pattern',
			'font-size:11px;color:var(--vscode-descriptionForeground);opacity:0.7;'));
		topBar.appendChild($t('span', '\u203a', 'font-size:14px;color:var(--vscode-descriptionForeground);opacity:0.5;'));
		topBar.appendChild($t('h2', stepTitle,
			'font-size:15px;font-weight:700;color:var(--vscode-editor-foreground);margin:0;flex:1;'));
		topBar.appendChild(this._btn('\u2190 Back', false, () => { this._wizardStep = 1; this._render(); },
			'font-size:11px;padding:4px 10px;'));
		topBar.appendChild(this._btn('Cancel', false, () => { this._wizardMode = false; this._render(); },
			'font-size:11px;padding:4px 12px;'));
		root.appendChild(topBar);

		// Two-column layout: left = vertical config, right = compliance frameworks
		const layout = $e('div', 'flex:1;display:flex;overflow:hidden;');
		root.appendChild(layout);

		// \u2500\u2500 Left panel \u2014 vertical-specific fields \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const left = $e('div', 'flex:1;overflow-y:auto;padding:24px;display:flex;flex-direction:column;gap:14px;border-right:1px solid var(--vscode-panel-border,var(--vscode-widget-border));');
		layout.appendChild(left);

		// Helper builders
		const css = 'height:28px;padding:0 10px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-widget-border));border-radius:3px;font-size:12px;font-family:inherit;box-sizing:border-box;width:100%;';
		const _row = (label: string, el: HTMLElement, hint?: string): HTMLElement => {
			const r = $e('div', 'display:flex;flex-direction:column;gap:4px;');
			r.appendChild($t('span', label, 'font-size:11px;font-weight:700;color:var(--vscode-foreground);'));
			r.appendChild(el);
			if (hint) { r.appendChild($t('span', hint, 'font-size:10px;color:var(--vscode-descriptionForeground);')); }
			return r;
		};
		const _col2 = (a: HTMLElement, b: HTMLElement): HTMLElement => {
			const g = $e('div', 'display:grid;grid-template-columns:1fr 1fr;gap:14px;');
			g.appendChild(a); g.appendChild(b); return g;
		};
		const _sel = (opts: Array<[string, string]>, val: string | undefined): HTMLSelectElement => {
			const s = $e('select', css) as HTMLSelectElement;
			for (const [v, l] of opts) { const o = $e('option'); o.value = v; o.textContent = l; if ((val ?? '') === v) { o.selected = true; } s.appendChild(o); }
			return s;
		};
		const _inp = (placeholder: string, val?: string): HTMLInputElement => {
			const i = $e('input', css) as HTMLInputElement; i.placeholder = placeholder; i.value = val ?? ''; return i;
		};
		const _toggle = (label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement => {
			const wrap = $e('div', 'display:flex;align-items:center;gap:8px;cursor:pointer;');
			const cb = $e('input') as HTMLInputElement; cb.type = 'checkbox'; cb.checked = checked; cb.style.cursor = 'pointer';
			const lbl = $t('span', label, 'font-size:12px;color:var(--vscode-foreground);cursor:pointer;');
			cb.addEventListener('change', () => onChange(cb.checked));
			lbl.addEventListener('click', () => { cb.checked = !cb.checked; onChange(cb.checked); });
			wrap.appendChild(cb); wrap.appendChild(lbl); return wrap;
		};
		const _sectionHdr = (title: string, icon: string): HTMLElement => {
			const h = $e('div', [
				'display:flex', 'align-items:center', 'gap:8px',
				'padding:6px 10px', 'border-radius:4px',
				'background:var(--vscode-sideBarSectionHeader-background)',
				'border:1px solid var(--vscode-widget-border)',
				'margin-top:4px',
			].join(';'));
			h.appendChild($t('span', icon, 'font-size:14px;'));
			h.appendChild($t('span', title, 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-sideBarSectionHeader-foreground);'));
			return h;
		};

		// \u2500\u2500 FIRMWARE / EMBEDDED \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		if (isFirmware || isAnyVertical) {
			left.appendChild($t('div',
				isFirmware ? 'Configure the hardware and build context for the firmware being modernised.' :
				isAutosar  ? 'Configure AUTOSAR schema, ASIL target, and migration mapping options.' :
				isEnergy   ? 'Configure IEC 61850, SIL target, OPC-UA namespace, and SCADA protocol details.' :
				isTelecom  ? 'Configure 3GPP release, O-RAN split, RAT, and security parameters.' :
				'Configure EtherCAT, Profinet, MQTT, and industrial safety parameters.',
				'font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.6;'));
		}

		if (isFirmware) {
			left.appendChild(_sectionHdr('Hardware Context', '\u1F4BB'));

			const mcuWrap = $e('div', 'position:relative;');
			const mcuInput = _inp('e.g. STM32F407VGT6, nRF52840, RP2040\u2026', this._wizardFirmware.mcuVariant ?? this._wizardMcuQuery);
			const mcuDrop = $e('div', [
				'position:absolute', 'top:100%', 'left:0', 'right:0', 'z-index:200',
				'background:var(--vscode-input-background)', 'border:1px solid var(--vscode-widget-border)',
				'border-top:none', 'border-radius:0 0 4px 4px',
				'max-height:180px', 'overflow-y:auto', 'display:none', 'box-shadow:0 4px 12px rgba(0,0,0,0.2)',
			].join(';'));
			const refreshDrop = (q: string): void => {
				while (mcuDrop.firstChild) { mcuDrop.removeChild(mcuDrop.firstChild); }
				if (!q || q.length < 2) { mcuDrop.style.display = 'none'; return; }
				const hits = this._mcuDb.search(q, 10);
				if (!hits.length) { mcuDrop.style.display = 'none'; return; }
				mcuDrop.style.display = 'block';
				for (const hit of hits) {
					const r = $e('div', 'display:flex;gap:10px;align-items:baseline;padding:6px 12px;cursor:pointer;font-size:12px;');
					r.appendChild($t('span', hit.variant, 'font-weight:600;flex:1;color:var(--vscode-editor-foreground);'));
					r.appendChild($t('span', `${hit.core.toUpperCase()} · ${hit.clockMHz}MHz · ${hit.manufacturer}`, 'font-size:10px;color:var(--vscode-descriptionForeground);'));
					r.addEventListener('mouseenter', () => { r.style.background = 'var(--vscode-list-hoverBackground)'; });
					r.addEventListener('mouseleave', () => { r.style.background = ''; });
					r.addEventListener('mousedown', (e) => {
						e.preventDefault();
						const cfg = this._mcuDb.toMCUConfig(hit);
						mcuInput.value = cfg.variant;
						mcuDrop.style.display = 'none';
						this._wizardMcuQuery = cfg.variant;
						this._wizardFirmware = { ...this._wizardFirmware, mcuVariant: cfg.variant, mcuFamily: cfg.family, core: cfg.core, flashSize: cfg.flashSize, ramSize: cfg.ramSize, clockMHz: cfg.clockMHz };
					});
					mcuDrop.appendChild(r);
				}
			};
			mcuInput.addEventListener('input', () => { this._wizardMcuQuery = mcuInput.value; this._wizardFirmware = { ...this._wizardFirmware, mcuVariant: mcuInput.value || undefined }; refreshDrop(mcuInput.value); });
			mcuInput.addEventListener('focus', () => refreshDrop(mcuInput.value));
			mcuInput.addEventListener('blur', () => { setTimeout(() => { mcuDrop.style.display = 'none'; }, 150); });
			mcuWrap.appendChild(mcuInput); mcuWrap.appendChild(mcuDrop);
			left.appendChild(_row(`Source MCU  \u2014  ${this._mcuDb.count} devices in registry`, mcuWrap, 'Type 2+ characters. Selecting auto-fills core, flash, RAM, clock.'));

			const archEl = _sel([['', '\u2014 auto-detect \u2014'], ['arm-cortex-m', 'ARM Cortex-M (bare-metal)'], ['arm-cortex-a', 'ARM Cortex-A (Linux capable)'], ['arm-cortex-r', 'ARM Cortex-R (real-time)'], ['risc-v', 'RISC-V'], ['xtensa', 'Xtensa (ESP32)'], ['avr', 'AVR (8-bit)'], ['pic', 'PIC (Microchip)'], ['mips', 'MIPS'], ['ppc', 'PowerPC / e200']], this._wizardFirmware.cpuArchitecture);
			archEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, cpuArchitecture: archEl.value || undefined }; });
			const fpuEl = _sel([['', '\u2014 select \u2014'], ['hardfp', 'Hard FPU (hardfp)'], ['softfp', 'Software FPU (softfp)'], ['none', 'No FPU']], this._wizardFirmware.fpuUsage);
			fpuEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, fpuUsage: fpuEl.value || undefined }; });
			left.appendChild(_col2(_row('CPU Architecture', archEl), _row('FPU Usage', fpuEl)));

			left.appendChild(_sectionHdr('Build & Toolchain', '\u1F527'));
			const rtosEl = _sel([['', '\u2014 none \u2014'], ['FreeRTOS', 'FreeRTOS'], ['Zephyr RTOS', 'Zephyr RTOS'], ['RTEMS', 'RTEMS'], ['ThreadX / Azure RTOS', 'ThreadX / Azure RTOS'], ['Mbed OS', 'Mbed OS'], ['NuttX', 'NuttX'], ['VxWorks', 'VxWorks'], ['QNX', 'QNX'], ['INTEGRITY', 'INTEGRITY (GreenHills)'], ['LynxOS', 'LynxOS'], ['Bare-metal', 'Bare-metal'], ['Other', 'Other']], this._wizardFirmware.rtos);
			rtosEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, rtos: rtosEl.value || undefined }; });
			const buildEl = _sel([['', '\u2014 none \u2014'], ['cmake', 'CMake'], ['make', 'GNU Make'], ['platformio', 'PlatformIO'], ['esp-idf', 'ESP-IDF'], ['stm32cubeide', 'STM32CubeIDE'], ['keil-mdk', 'Keil MDK (µVision)'], ['iar-ewb', 'IAR Embedded Workbench'], ['mbed-cli', 'Mbed CLI'], ['west', 'West (Zephyr)'], ['s32-design-studio', 'NXP S32 Design Studio'], ['codesys', 'CoDeSys'], ['Other', 'Other']], this._wizardFirmware.buildSystem);
			buildEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, buildSystem: buildEl.value || undefined }; });
			left.appendChild(_col2(_row('Source RTOS', rtosEl), _row('Build System', buildEl)));

			const compilerEl = _sel([['', '\u2014 auto \u2014'], ['gcc-arm-none-eabi', 'GCC arm-none-eabi'], ['llvm-clang', 'LLVM Clang'], ['iar', 'IAR C/C++ Compiler'], ['keil-armcc', 'Keil armcc (AC5/AC6)'], ['green-hills', 'Green Hills MULTI'], ['ti-cgt', 'TI Code Generation Tools'], ['xc32', 'Microchip XC32 (PIC32)']], this._wizardFirmware.compiler);
			compilerEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, compiler: compilerEl.value || undefined }; });
			const halEl = _sel([['', '\u2014 none \u2014'], ['stm32-hal', 'STM32 HAL (CubeMX)'], ['libopencm3', 'libopencm3'], ['esp-idf', 'ESP-IDF HAL'], ['arduino', 'Arduino'], ['cmsis-only', 'CMSIS-only'], ['zephyr-drivers', 'Zephyr device drivers'], ['nxp-mcuxpresso', 'NXP MCUXpresso SDK'], ['ti-driverlib', 'TI DriverLib'], ['nordic-nrfx', 'Nordic nrfx'], ['atmel-start', 'Atmel START (SAM)'], ['Other', 'Other']], this._wizardFirmware.hal);
			halEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, hal: halEl.value || undefined }; });
			left.appendChild(_col2(_row('Compiler / Toolchain', compilerEl), _row('HAL / Framework', halEl)));

			const freertosHeapEl = _sel([['', '\u2014 n/a \u2014'], ['heap_1', 'heap_1 (no free)'], ['heap_2', 'heap_2 (best fit)'], ['heap_3', 'heap_3 (libc malloc)'], ['heap_4', 'heap_4 (coalescing)'], ['heap_5', 'heap_5 (multi-region)']], this._wizardFirmware.freertosHeapModel);
			freertosHeapEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, freertosHeapModel: freertosHeapEl.value || undefined }; });
			const powerEl = _sel([['', '\u2014 not specified \u2014'], ['low-power', 'Low-power (run modes, WFI/WFE)'], ['normal', 'Normal'], ['performance', 'Performance (max clock)']], this._wizardFirmware.powerProfile);
			powerEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, powerProfile: powerEl.value || undefined }; });
			left.appendChild(_col2(_row('FreeRTOS Heap Model', freertosHeapEl), _row('Power Profile', powerEl)));

			left.appendChild(_sectionHdr('Safety / MISRA Compliance', '\u1F6E1\uFE0F'));
			const misraEl = _sel([['', '\u2014 none \u2014'], ['misra-c-2012', 'MISRA-C:2012'], ['misra-c-2023', 'MISRA-C:2023 (latest)'], ['misra-cpp-2008', 'MISRA-C++:2008'], ['cert-c', 'CERT-C (SEI)'], ['cert-cpp', 'CERT-C++ (SEI)']], this._wizardFirmware.misraVersion);
			misraEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, misraVersion: misraEl.value || undefined }; });
			const svdEl = _inp('e.g. STM32F407.svd (relative to source root)', this._wizardFirmware.sourceSvdPath);
			svdEl.addEventListener('input', () => { this._wizardFirmware = { ...this._wizardFirmware, sourceSvdPath: svdEl.value || undefined }; });
			left.appendChild(_col2(_row('MISRA / Safety Standard', misraEl), _row('Source SVD File (optional)', svdEl)));

			const linkerEl = _inp('e.g. STM32F407VGTx_FLASH.ld', this._wizardFirmware.linkerScriptPath);
			linkerEl.addEventListener('input', () => { this._wizardFirmware = { ...this._wizardFirmware, linkerScriptPath: linkerEl.value || undefined }; });
			const debugEl = _sel([['', '\u2014 any \u2014'], ['j-link', 'SEGGER J-Link'], ['st-link', 'ST-Link v2/v3'], ['cmsis-dap', 'CMSIS-DAP / DAPLink'], ['openocd', 'OpenOCD'], ['pyocd', 'pyOCD'], ['custom', 'Custom']], this._wizardFirmware.debugProbe);
			debugEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, debugProbe: debugEl.value || undefined }; });
			left.appendChild(_col2(_row('Linker Script (optional)', linkerEl), _row('Debug Probe', debugEl)));

			const bootloaderEl = _sel([['', '\u2014 none / unknown \u2014'], ['mcuboot', 'MCUboot'], ['u-boot', 'U-Boot'], ['dfu', 'USB DFU (built-in)'], ['custom', 'Custom bootloader'], ['none', 'No bootloader']], this._wizardFirmware.bootloader);
			bootloaderEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, bootloader: bootloaderEl.value || undefined }; });
			const bootProtoEl = _sel([['', '\u2014 any \u2014'], ['swd', 'SWD'], ['jtag', 'JTAG'], ['uart-isp', 'UART ISP'], ['usb-dfu', 'USB DFU'], ['ota', 'OTA (FOTA)']], this._wizardFirmware.bootProtocol);
			bootProtoEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, bootProtocol: bootProtoEl.value || undefined }; });
			left.appendChild(_col2(_row('Bootloader', bootloaderEl), _row('Boot Protocol', bootProtoEl)));

			left.appendChild(_sectionHdr('Target Platform (Migration)', '\u1F3AF'));
			const tgtMcuEl = _inp('e.g. STM32H743VIT6 (leave blank if same family)', this._wizardFirmware.targetMcuVariant);
			tgtMcuEl.addEventListener('input', () => { this._wizardFirmware = { ...this._wizardFirmware, targetMcuVariant: tgtMcuEl.value || undefined }; });
			const tgtRtosEl = _sel([['', '\u2014 same as source \u2014'], ['FreeRTOS', 'FreeRTOS'], ['Zephyr RTOS', 'Zephyr RTOS'], ['RTEMS', 'RTEMS'], ['ThreadX / Azure RTOS', 'ThreadX / Azure RTOS'], ['Mbed OS', 'Mbed OS'], ['NuttX', 'NuttX'], ['VxWorks', 'VxWorks'], ['QNX', 'QNX'], ['INTEGRITY', 'INTEGRITY'], ['Bare-metal', 'Bare-metal'], ['Other', 'Other']], this._wizardFirmware.targetRtos);
			tgtRtosEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, targetRtos: tgtRtosEl.value || undefined }; });
			left.appendChild(_col2(_row('Target MCU Variant', tgtMcuEl), _row('Target RTOS', tgtRtosEl)));

			const tgtBuildEl = _sel([['', '\u2014 same as source \u2014'], ['cmake', 'CMake'], ['make', 'GNU Make'], ['platformio', 'PlatformIO'], ['esp-idf', 'ESP-IDF'], ['west', 'West (Zephyr)'], ['keil-mdk', 'Keil MDK'], ['iar-ewb', 'IAR Embedded Workbench'], ['Other', 'Other']], this._wizardFirmware.targetBuildSystem);
			tgtBuildEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, targetBuildSystem: tgtBuildEl.value || undefined }; });
			const tgtHalEl = _sel([['', '\u2014 same as source \u2014'], ['stm32-hal', 'STM32 HAL'], ['libopencm3', 'libopencm3'], ['esp-idf', 'ESP-IDF HAL'], ['cmsis-only', 'CMSIS-only'], ['zephyr-drivers', 'Zephyr device drivers'], ['nxp-mcuxpresso', 'NXP MCUXpresso SDK'], ['ti-driverlib', 'TI DriverLib'], ['nordic-nrfx', 'Nordic nrfx'], ['Other', 'Other']], this._wizardFirmware.targetHal);
			tgtHalEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, targetHal: tgtHalEl.value || undefined }; });
			left.appendChild(_col2(_row('Target Build System', tgtBuildEl), _row('Target HAL', tgtHalEl)));

			const tgtCompilerEl = _sel([['', '\u2014 same as source \u2014'], ['gcc-arm-none-eabi', 'GCC arm-none-eabi'], ['llvm-clang', 'LLVM Clang'], ['iar', 'IAR Compiler'], ['keil-armcc', 'Keil armcc'], ['green-hills', 'Green Hills MULTI']], this._wizardFirmware.targetCompiler);
			tgtCompilerEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, targetCompiler: tgtCompilerEl.value || undefined }; });
			left.appendChild(_row('Target Compiler', tgtCompilerEl));
		}

		// \u2500\u2500 AUTOMOTIVE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		if (isAutosar) {
			left.appendChild(_sectionHdr('AUTOSAR Configuration', '\u1F697'));

			const schemaEl = _sel([['', '\u2014 select \u2014'], ['R22-11', 'R22-11 (Adaptive, latest)'], ['R21-11', 'R21-11 (Adaptive)'], ['R20-11', 'R20-11 (Adaptive)'], ['R19-11', 'R19-11 (Adaptive)'], ['Classic-4.4', 'Classic 4.4'], ['Classic-4.3', 'Classic 4.3'], ['Classic-4.2', 'Classic 4.2'], ['Classic-4.0', 'Classic 4.0'], ['Classic-3.x', 'Classic 3.x (legacy)']], this._wizardFirmware.autosarSchemaVersion);
			schemaEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, autosarSchemaVersion: schemaEl.value || undefined }; });
			const asilEl = _sel([['', '\u2014 select \u2014'], ['QM', 'QM (not safety-critical)'], ['ASIL-A', 'ASIL-A'], ['ASIL-B', 'ASIL-B'], ['ASIL-C', 'ASIL-C'], ['ASIL-D', 'ASIL-D (highest)'], ['ASIL-D/D', 'ASIL-D/D (decomposition)']], this._wizardFirmware.asilTarget);
			asilEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, asilTarget: asilEl.value || undefined }; });
			left.appendChild(_col2(_row('Source AUTOSAR Schema', schemaEl), _row('ASIL Target Level', asilEl)));

			const ecuSrcEl = _inp('e.g. Infineon AURIX TC397, NXP S32K344', this._wizardFirmware.ecuSourceVariant);
			ecuSrcEl.addEventListener('input', () => { this._wizardFirmware = { ...this._wizardFirmware, ecuSourceVariant: ecuSrcEl.value || undefined }; });
			const ecuTgtEl = _inp('e.g. Renesas RH850/U2B, TI TDA4VM', this._wizardFirmware.ecuTargetVariant);
			ecuTgtEl.addEventListener('input', () => { this._wizardFirmware = { ...this._wizardFirmware, ecuTargetVariant: ecuTgtEl.value || undefined }; });
			left.appendChild(_col2(_row('Source ECU Variant', ecuSrcEl), _row('Target ECU Variant', ecuTgtEl)));

			const tgtOsEl = _sel([['', '\u2014 select \u2014'], ['AUTOSAR OS', 'AUTOSAR OS (Classic)'], ['QNX', 'QNX Neutrino'], ['INTEGRITY', 'INTEGRITY (GreenHills)'], ['Linux PREEMPT_RT', 'Linux PREEMPT_RT'], ['VxWorks 653', 'VxWorks 653 ARINC'], ['PikeOS', 'PikeOS (SYSGO)']], this._wizardFirmware.targetAutomotiveOS);
			tgtOsEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, targetAutomotiveOS: tgtOsEl.value || undefined }; });
			const testFwEl = _sel([['', '\u2014 none \u2014'], ['VectorCAST', 'VectorCAST'], ['TESSY', 'TESSY (Razorcat)'], ['Polyspace', 'Polyspace (MathWorks)'], ['TargetLink', 'TargetLink (dSPACE)'], ['MATLAB/Simulink', 'MATLAB / Simulink'], ['CANoe', 'Vector CANoe'], ['ETAS ECU-TEST', 'ETAS ECU-TEST'], ['Piketec TPT', 'Piketec TPT']], this._wizardFirmware.automotiveTestFramework);
			testFwEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, automotiveTestFramework: testFwEl.value || undefined }; });
			left.appendChild(_col2(_row('Target Automotive OS', tgtOsEl), _row('Test Framework', testFwEl)));

			left.appendChild(_sectionHdr('Network Topology', '\u1F310'));
			const someIpEl = _sel([['', '\u2014 none \u2014'], ['multicast', 'Multicast SD'], ['unicast', 'Unicast SD'], ['hybrid', 'Hybrid']], this._wizardFirmware.someIpMode);
			someIpEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, someIpMode: someIpEl.value || undefined }; });
			const someIpToolEl = _sel([['', '\u2014 none \u2014'], ['Vector SystemDesk', 'Vector SystemDesk'], ['EB Tresos', 'EB Tresos / Autocore'], ['DaVinci Configurator', 'DaVinci Configurator (Vector)'], ['COVESA/GENIVI', 'COVESA / GENIVI vsomeip'], ['Custom', 'Custom']], this._wizardFirmware.someIpConfigTool);
			someIpToolEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, someIpConfigTool: someIpToolEl.value || undefined }; });
			left.appendChild(_col2(_row('SOME/IP Service Discovery', someIpEl), _row('SOME/IP Config Tool', someIpToolEl)));

			const dbcEl = _inp('e.g. Vector CANdb++ 11.0', this._wizardFirmware.dbcToolVersion);
			dbcEl.addEventListener('input', () => { this._wizardFirmware = { ...this._wizardFirmware, dbcToolVersion: dbcEl.value || undefined }; });
			const linEl = _sel([['', '\u2014 none \u2014'], ['LIN 2.0', 'LIN 2.0'], ['LIN 2.1', 'LIN 2.1'], ['LIN 2.2', 'LIN 2.2'], ['LIN 2.2A', 'LIN 2.2A (latest)']], this._wizardFirmware.linProtocolVersion);
			linEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, linProtocolVersion: linEl.value || undefined }; });
			left.appendChild(_col2(_row('CAN DBC Tool (source)', dbcEl), _row('LIN Protocol Version', linEl)));

			const automotiveEthEl = _sel([['', '\u2014 none \u2014'], ['10BASE-T1S', '10BASE-T1S (multidrop)'], ['100BASE-T1', '100BASE-T1 (BroadR-Reach)'], ['1000BASE-T1', '1000BASE-T1 (OABR)'], ['100BASE-TX', '100BASE-TX (standard)']], this._wizardFirmware.automotiveEthernetStandard);
			automotiveEthEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, automotiveEthernetStandard: automotiveEthEl.value || undefined }; });
			const tgtMiddlewareEl = _sel([['', '\u2014 AUTOSAR COM \u2014'], ['DDS/ROS2', 'DDS / ROS 2'], ['SOME/IP', 'SOME/IP (native)'], ['Zenoh', 'Zenoh (Eclipse)'], ['AUTOSAR COM', 'AUTOSAR COM stack']], this._wizardFirmware.targetMiddleware);
			tgtMiddlewareEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, targetMiddleware: tgtMiddlewareEl.value || undefined }; });
			left.appendChild(_col2(_row('Automotive Ethernet Standard', automotiveEthEl), _row('Target Middleware', tgtMiddlewareEl)));

			const calToolEl = _sel([['', '\u2014 none \u2014'], ['Vector CANape', 'Vector CANape'], ['ETAS INCA', 'ETAS INCA'], ['ASAP2/a2l', 'ASAP2 / a2l file'], ['Piketec TPT', 'Piketec TPT']], this._wizardFirmware.calibrationTool);
			calToolEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, calibrationTool: calToolEl.value || undefined }; });
			const diagEl = _sel([['', '\u2014 none \u2014'], ['UDS ISO 14229', 'UDS ISO 14229-1'], ['OBD-II', 'OBD-II (SAE J1979)'], ['KWP2000', 'KWP2000 (ISO 14230)'], ['XCP', 'XCP (ASAM MCD-1)'], ['DoIP', 'DoIP (ISO 13400)']], this._wizardFirmware.diagnosticProtocol);
			diagEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, diagnosticProtocol: diagEl.value || undefined }; });
			left.appendChild(_col2(_row('Calibration Tool', calToolEl), _row('Diagnostic Protocol', diagEl)));

			const networkToggles = $e('div', 'display:flex;flex-wrap:wrap;gap:12px 24px;padding:10px 12px;border:1px solid var(--vscode-widget-border);border-radius:4px;background:var(--vscode-input-background);');
			networkToggles.appendChild($t('div', 'Network Capabilities', 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-descriptionForeground);width:100%;margin-bottom:2px;'));
			networkToggles.appendChild(_toggle('CAN-FD (ISO 11898-1:2015)', !!this._wizardFirmware.canFdEnabled, v => { this._wizardFirmware = { ...this._wizardFirmware, canFdEnabled: v }; }));
			networkToggles.appendChild(_toggle('FlexRay (ISO 17458)', !!this._wizardFirmware.flexRayEnabled, v => { this._wizardFirmware = { ...this._wizardFirmware, flexRayEnabled: v }; }));
			left.appendChild(_row('Network Capabilities', networkToggles));

			left.appendChild(_sectionHdr('Target Adaptive Platform APIs', '\u2699\uFE0F'));
			const araToggles = $e('div', 'display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--vscode-widget-border);border-radius:4px;background:var(--vscode-input-background);');
			araToggles.appendChild($t('div', 'ara:: API Mapping Required', 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-descriptionForeground);margin-bottom:2px;'));
			araToggles.appendChild(_toggle('ara::com  \u2014 service-oriented communication (SOME/IP)', !!this._wizardFirmware.targetAraComEnabled, v => { this._wizardFirmware = { ...this._wizardFirmware, targetAraComEnabled: v }; }));
			araToggles.appendChild(_toggle('ara::diag \u2014 UDS / diagnostic event manager', !!this._wizardFirmware.targetAraDiagEnabled, v => { this._wizardFirmware = { ...this._wizardFirmware, targetAraDiagEnabled: v }; }));
			araToggles.appendChild(_toggle('ara::per  \u2014 persistent key-value storage (NvM)', !!this._wizardFirmware.targetAraPerEnabled, v => { this._wizardFirmware = { ...this._wizardFirmware, targetAraPerEnabled: v }; }));
			araToggles.appendChild(_toggle('ara::exec \u2014 execution management (process lifecycle)', !!this._wizardFirmware.targetAraExecEnabled, v => { this._wizardFirmware = { ...this._wizardFirmware, targetAraExecEnabled: v }; }));
			araToggles.appendChild(_toggle('ara::nm   \u2014 network management (group coordination)', !!this._wizardFirmware.targetAraNmEnabled, v => { this._wizardFirmware = { ...this._wizardFirmware, targetAraNmEnabled: v }; }));
			araToggles.appendChild(_toggle('ara::crypto \u2014 cryptographic service (Crypto Provider)', !!this._wizardFirmware.targetAraCryptoEnabled, v => { this._wizardFirmware = { ...this._wizardFirmware, targetAraCryptoEnabled: v }; }));
			araToggles.appendChild(_toggle('ara::tsync  \u2014 time synchronisation (PTP / global time)', !!this._wizardFirmware.targetAraTsyncEnabled, v => { this._wizardFirmware = { ...this._wizardFirmware, targetAraTsyncEnabled: v }; }));
			left.appendChild(araToggles);
		}

		// \u2500\u2500 CRITICAL INFRASTRUCTURE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		if (isEnergy) {
			left.appendChild(_sectionHdr('IEC 61850 Substation Configuration', '\u26A1'));

			const iecEdEl = _sel([['', '\u2014 select \u2014'], ['Edition 2.1', 'IEC 61850 Edition 2.1 (latest)'], ['Edition 2', 'IEC 61850 Edition 2'], ['Edition 1', 'IEC 61850 Edition 1 (legacy)']], this._wizardFirmware.iec61850Edition);
			iecEdEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, iec61850Edition: iecEdEl.value || undefined }; });
			const iec61850ModelEl = _sel([['', '\u2014 select \u2014'], ['GOOSE', 'GOOSE (fast protection)'], ['SV', 'Sampled Values (SV)'], ['MMS', 'MMS (monitoring/control)'], ['XMPP', 'XMPP (R2 publish/subscribe)'], ['mixed', 'Mixed (GOOSE + SV + MMS)']], this._wizardFirmware.iec61850CommunicationModel);
			iec61850ModelEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, iec61850CommunicationModel: iec61850ModelEl.value || undefined }; });
			left.appendChild(_col2(_row('IEC 61850 Edition', iecEdEl), _row('Communication Model', iec61850ModelEl)));

			const sclEl = _inp('e.g. substation.scd (relative to source root)', this._wizardFirmware.sclFilePath);
			sclEl.addEventListener('input', () => { this._wizardFirmware = { ...this._wizardFirmware, sclFilePath: sclEl.value || undefined }; });
			const relayProtoEl = _sel([['', '\u2014 none \u2014'], ['IEC 60870-5-101', 'IEC 60870-5-101 (serial)'], ['IEC 60870-5-104', 'IEC 60870-5-104 (TCP/IP)'], ['DNP3', 'DNP3'], ['Modbus RTU', 'Modbus RTU'], ['Modbus TCP', 'Modbus TCP'], ['IEC 61968/61970', 'IEC 61968/61970 (CIM)']], this._wizardFirmware.protectionRelayProtocol);
			relayProtoEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, protectionRelayProtocol: relayProtoEl.value || undefined }; });
			left.appendChild(_col2(_row('SCL File (.ssd/.scd/.icd)', sclEl), _row('Protection Relay Legacy Protocol', relayProtoEl)));

			const gooseEl = _inp('e.g. XCBR1/LLN0$GO$goose1, trip-dataset', this._wizardFirmware.gooseDatasets);
			gooseEl.addEventListener('input', () => { this._wizardFirmware = { ...this._wizardFirmware, gooseDatasets: gooseEl.value || undefined }; });
			const svEl = _inp('e.g. MU01/LLN0$MS$sv1 (comma-separated)', this._wizardFirmware.svStreams);
			svEl.addEventListener('input', () => { this._wizardFirmware = { ...this._wizardFirmware, svStreams: svEl.value || undefined }; });
			left.appendChild(_col2(_row('GOOSE Datasets in Scope', gooseEl, 'Protection-relay paths; class P5/P6 ordering enforced'), _row('Sampled Values (SV) Streams', svEl)));

			left.appendChild(_sectionHdr('Safety Instrumented System (SIS)', '\u1F530'));
			const silEl = _sel([['', '\u2014 none \u2014'], ['SIL 1', 'SIL 1 (IEC 61508)'], ['SIL 2', 'SIL 2 (IEC 61508)'], ['SIL 3', 'SIL 3 (IEC 61508)'], ['SIL 4', 'SIL 4 \u2014 highest (IEC 61508)'], ['IEC 61511 SIL 1', 'IEC 61511 SIL 1 (process)'], ['IEC 61511 SIL 2', 'IEC 61511 SIL 2 (process)'], ['IEC 61511 SIL 3', 'IEC 61511 SIL 3 (process)']], this._wizardFirmware.silTarget);
			silEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, silTarget: silEl.value || undefined }; });
			const silToolEl = _sel([['', '\u2014 select \u2014'], ['LOPA', 'LOPA (Layers of Protection)'], ['FTA', 'Fault Tree Analysis (FTA)'], ['FMEA', 'FMEA / FMEDA'], ['SILver', 'SILver (exida)'], ['exida SILSuite', 'exida SILSuite'], ['SERH', 'SERH (Schneider)'], ['Custom', 'Custom tool']], this._wizardFirmware.silVerificationTool);
			silToolEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, silVerificationTool: silToolEl.value || undefined }; });
			left.appendChild(_col2(_row('SIL Target', silEl), _row('SIL Verification Methodology', silToolEl)));

			const safetyPlcEl = _sel([['', '\u2014 select \u2014'], ['Siemens SIMATIC Safety', 'Siemens SIMATIC Safety (S7-300F/1500F)'], ['Rockwell GuardLogix', 'Rockwell GuardLogix 5580'], ['Pilz PSS', 'Pilz PSS 4000'], ['ABB AC 800M HI', 'ABB AC 800M HI'], ['Emerson DeltaV SIS', 'Emerson DeltaV SIS'], ['Triconex', 'Triconex (Schneider)'], ['Hima HIMax', 'Hima HIMax / HIMatrix']], this._wizardFirmware.safetyPlcTarget);
			safetyPlcEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, safetyPlcTarget: safetyPlcEl.value || undefined }; });
			const plcVendorEl = _sel([['', '\u2014 select \u2014'], ['Siemens', 'Siemens (TIA Portal / SIMATIC)'], ['Rockwell', 'Rockwell Automation (Studio 5000)'], ['Schneider', 'Schneider Electric (EcoStruxure)'], ['ABB', 'ABB (Automation Builder)'], ['GE', 'GE Digital (PACSystems)'], ['Emerson', 'Emerson (DeltaV / PACEdge)'], ['Beckhoff', 'Beckhoff (TwinCAT 3)']], this._wizardFirmware.plcVendor);
			plcVendorEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, plcVendor: plcVendorEl.value || undefined }; });
			left.appendChild(_col2(_row('Target Safety PLC', safetyPlcEl), _row('Source PLC Vendor', plcVendorEl)));

			left.appendChild(_sectionHdr('SCADA / HMI & Communication', '\u1F5A5\uFE0F'));
			const scadaEl = _sel([['', '\u2014 none / custom \u2014'], ['Ignition', 'Ignition (Inductive Automation)'], ['WinCC', 'Siemens WinCC / WinCC Unified'], ['iFIX', 'GE iFIX / CIMPLICITY'], ['Wonderware/AVEVA', 'AVEVA Wonderware InTouch'], ['OSIsoft PI', 'AVEVA PI System'], ['Inductive Automation', 'Inductive Automation Ignition'], ['Custom', 'Custom SCADA']], this._wizardFirmware.scadaPlatform);
			scadaEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, scadaPlatform: scadaEl.value || undefined }; });
			const historianEl = _sel([['', '\u2014 none \u2014'], ['OSIsoft PI', 'AVEVA PI Historian'], ['AspenTech IP21', 'AspenTech IP.21'], ['AVEVA Historian', 'AVEVA Historian'], ['InfluxDB', 'InfluxDB (OSS)'], ['TimescaleDB', 'TimescaleDB'], ['Custom', 'Custom historian']], this._wizardFirmware.processHistorian);
			historianEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, processHistorian: historianEl.value || undefined }; });
			left.appendChild(_col2(_row('SCADA / HMI Platform', scadaEl), _row('Process Historian / TSDB', historianEl)));

			const rtuEl = _sel([['', '\u2014 none \u2014'], ['ABB RTU500', 'ABB RTU500 series'], ['Schneider Saitel', 'Schneider Saitel DR'], ['GE D20', 'GE D20 / D200'], ['Siemens SICAM RTU', 'Siemens SICAM RTU'], ['SEL', 'SEL (Schweitzer Engineering)'], ['Custom', 'Custom RTU']], this._wizardFirmware.rtuVendor);
			rtuEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, rtuVendor: rtuEl.value || undefined }; });
			const redEl = _sel([['', '\u2014 none \u2014'], ['HSR', 'HSR (IEC 62439-3 Ch. 5)'], ['PRP', 'PRP (IEC 62439-3 Ch. 4)'], ['RSTP', 'RSTP (IEEE 802.1D)'], ['MRP', 'MRP (IEC 62439-2)'], ['none', 'No redundancy']], this._wizardFirmware.communicationRedundancy);
			redEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, communicationRedundancy: redEl.value || undefined }; });
			left.appendChild(_col2(_row('RTU / IED Vendor', rtuEl), _row('Communication Redundancy', redEl)));

			const opcuaNsEl = _inp('e.g. urn:company:substation:model', this._wizardFirmware.opcuaNamespaceUri);
			opcuaNsEl.addEventListener('input', () => { this._wizardFirmware = { ...this._wizardFirmware, opcuaNamespaceUri: opcuaNsEl.value || undefined }; });
			const opcuaProfileEl = _sel([['', '\u2014 none \u2014'], ['Micro', 'OPC-UA Micro Profile'], ['Nano', 'OPC-UA Nano Profile'], ['Embedded', 'OPC-UA Embedded Profile'], ['Full', 'OPC-UA Full Profile']], this._wizardFirmware.opcuaProfile);
			opcuaProfileEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, opcuaProfile: opcuaProfileEl.value || undefined }; });
			left.appendChild(_col2(_row('OPC-UA Namespace URI', opcuaNsEl), _row('OPC-UA Profile', opcuaProfileEl)));

			const sl62443El = _sel([['', '\u2014 none \u2014'], ['SL 1', 'SL 1 \u2014 Basic'], ['SL 2', 'SL 2 \u2014 Enhanced'], ['SL 3', 'SL 3 \u2014 Medium'], ['SL 4', 'SL 4 \u2014 High']], this._wizardFirmware.iec62443SecurityLevel);
			sl62443El.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, iec62443SecurityLevel: sl62443El.value || undefined }; });
			const dnp3El = _sel([['', '\u2014 none \u2014'], ['Level 1', 'DNP3 Level 1 (minimum)'], ['Level 2', 'DNP3 Level 2 (standard)'], ['Level 3', 'DNP3 Level 3 (enhanced)'], ['Level 4', 'DNP3 Level 4 (full)']], this._wizardFirmware.dnp3Level);
			dnp3El.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, dnp3Level: dnp3El.value || undefined }; });
			left.appendChild(_col2(_row('IEC 62443 Security Level Target', sl62443El), _row('DNP3 Level', dnp3El)));

			const oilGasEl = _sel([['', '\u2014 none \u2014'], ['HART 7', 'HART 7 (wired)'], ['WirelessHART', 'WirelessHART (IEC 62591)'], ['FF H1', 'Foundation Fieldbus H1 (31.25 kbps)'], ['FF HSE', 'Foundation Fieldbus HSE (100 Mbps)'], ['ISA-100.11a', 'ISA-100.11a Wireless'], ['PROFIBUS PA', 'PROFIBUS PA']], this._wizardFirmware.oilGasFieldProtocol);
			oilGasEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, oilGasFieldProtocol: oilGasEl.value || undefined }; });
			const nercEl = _sel([['', '\u2014 none \u2014'], ['CIP-013-2', 'NERC CIP-013-2 (supply chain)'], ['CIP-014-3', 'NERC CIP-014-3 (physical security)'], ['CIP-007-6', 'NERC CIP-007-6 (system security mgmt)'], ['CIP-010-4', 'NERC CIP-010-4 (config mgmt)']], this._wizardFirmware.nercCipVersion);
			nercEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, nercCipVersion: nercEl.value || undefined }; });
			left.appendChild(_col2(_row('Oil & Gas Field Protocol', oilGasEl), _row('NERC CIP Version', nercEl)));
		}

		// \u2500\u2500 TELECOM & 5G \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		if (isTelecom) {
			left.appendChild(_sectionHdr('3GPP / Radio Configuration', '\u1F4E1'));

			const relEl = _sel([['', '\u2014 select \u2014'], ['Rel-18', '3GPP Rel-18 (5G-Advanced)'], ['Rel-17', '3GPP Rel-17'], ['Rel-16', '3GPP Rel-16'], ['Rel-15', '3GPP Rel-15 (5G baseline)'], ['Rel-14', '3GPP Rel-14 (LTE-M / NB-IoT)'], ['Rel-13', '3GPP Rel-13 (LTE-A Pro)'], ['Rel-12', '3GPP Rel-12']], this._wizardFirmware.release3gpp);
			relEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, release3gpp: relEl.value || undefined }; });
			const ratEl = _sel([['', '\u2014 select \u2014'], ['NR', '5G NR (FR1 + FR2)'], ['NR-RedCap', '5G NR RedCap (IoT)'], ['LTE', 'LTE (4G)'], ['LTE-M', 'LTE-M (Cat-M1)'], ['NB-IoT', 'NB-IoT (Cat-NB1/NB2)'], ['NR-U', '5G NR-U (unlicensed)'], ['NTN', 'NTN (satellite / HAPS)']], this._wizardFirmware.rat);
			ratEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, rat: ratEl.value || undefined }; });
			left.appendChild(_col2(_row('3GPP Release', relEl), _row('Radio Access Technology', ratEl)));

			const bandEl = _sel([['', '\u2014 not specified \u2014'], ['Sub-6GHz (FR1)', 'Sub-6 GHz (FR1: n1/n3/n7/n28/n41/n77/n78/n79)'], ['Mid-band (n41/n77/n78)', 'Mid-band (n41 / n77 / n78 \u2014 C-band)'], ['mmWave (FR2)', 'mmWave (FR2: n257/n258/n260/n261)'], ['Multi-band', 'Multi-band (FR1 + FR2)']], this._wizardFirmware.frequencyBand);
			bandEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, frequencyBand: bandEl.value || undefined }; });
			const oranEl = _sel([['', '\u2014 none \u2014'], ['Option 7-2x', 'Option 7-2x (Split MAC-PHY, Open Fronthaul)'], ['Option 6', 'Option 6 (Split RLC/PDCP)'], ['Option 8', 'Option 8 (Fronthaul full \u2014 CPRI)'], ['Option 2', 'Option 2 (Split RRC/PDCP \u2014 F1 interface)'], ['None', 'Monolithic (no split)']], this._wizardFirmware.oranSplitOption);
			oranEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, oranSplitOption: oranEl.value || undefined }; });
			left.appendChild(_col2(_row('Frequency Band', bandEl), _row('O-RAN Functional Split', oranEl)));

			const fhTransportEl = _sel([['', '\u2014 select \u2014'], ['eCPRI v2.0', 'eCPRI v2.0 (CPRI forum)'], ['eCPRI v1.2', 'eCPRI v1.2'], ['IEEE 1914.3', 'IEEE 1914.3 (RoE)'], ['CPRI', 'CPRI (legacy)'], ['Raw IQ', 'Raw IQ (custom)']], this._wizardFirmware.frontHaulTransport);
			fhTransportEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, frontHaulTransport: fhTransportEl.value || undefined }; });
			const fhTimingEl = _sel([['', '\u2014 n/a \u2014'], ['Class A', 'Class A (LLS-C1/C2, ±25ns)'], ['Class B', 'Class B (LLS-C3, ±100ns)'], ['Class C', 'Class C (LLS-C4, ±2µs)']], this._wizardFirmware.frontHaulTimingClass);
			fhTimingEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, frontHaulTimingClass: fhTimingEl.value || undefined }; });
			left.appendChild(_col2(_row('Fronthaul Transport', fhTransportEl), _row('Fronthaul Timing Class (O-RAN)', fhTimingEl)));

			const syncEl = _sel([['', '\u2014 select \u2014'], ['GNSS/GPS', 'GNSS / GPS'], ['SyncE', 'Synchronous Ethernet (SyncE, G.8261)'], ['IEEE 1588-2019 PTP', 'IEEE 1588-2019 PTP (G.8275.1)'], ['BDS', 'BeiDou Navigation System (BDS)'], ['E-UTRAN timing', 'E-UTRAN timing reference (LTE)']], this._wizardFirmware.synchronisationSource);
			syncEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, synchronisationSource: syncEl.value || undefined }; });
			const coreEl = _sel([['', '\u2014 select \u2014'], ['5GC (5G SA)', '5GC \u2014 5G Standalone (SBA)'], ['EPC (4G)', 'EPC \u2014 4G LTE core'], ['NSA', 'NSA \u2014 Non-Standalone (EPC + NR)']], this._wizardFirmware.coreNetworkMode);
			coreEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, coreNetworkMode: coreEl.value || undefined }; });
			left.appendChild(_col2(_row('Synchronisation Source', syncEl), _row('Core Network Mode', coreEl)));

			left.appendChild(_sectionHdr('Network Function & Deployment', '\u1F3D7\uFE0F'));
			const nfTypeEl = _sel([['', '\u2014 select \u2014'], ['gNB', 'gNB (base station, monolithic)'], ['DU', 'DU (Distributed Unit)'], ['CU-CP', 'CU-CP (Control Plane)'], ['CU-UP', 'CU-UP (User Plane)'], ['AMF', 'AMF (Access & Mobility)'], ['SMF', 'SMF (Session Management)'], ['UPF', 'UPF (User Plane Function)'], ['PCF', 'PCF (Policy Control)'], ['UDM', 'UDM (Unified Data Management)'], ['AUSF', 'AUSF (Authentication Server)'], ['NRF', 'NRF (Network Repository)'], ['NSSF', 'NSSF (Network Slice Selection)'], ['NEF', 'NEF (Network Exposure)'], ['Custom', 'Custom NF']], this._wizardFirmware.networkFunctionType);
			nfTypeEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, networkFunctionType: nfTypeEl.value || undefined }; });
			const deployEl = _sel([['', '\u2014 select \u2014'], ['Bare Metal', 'Bare Metal (DPDK)'], ['VM (KVM)', 'VM \u2014 KVM / QEMU'], ['Container/K8s', 'Container / Kubernetes (Helm)'], ['Cloud Native (CNTT)', 'Cloud Native (CNTT / ETSI)']], this._wizardFirmware.deploymentModel);
			deployEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, deploymentModel: deployEl.value || undefined }; });
			left.appendChild(_col2(_row('Network Function Type', nfTypeEl), _row('Deployment Model', deployEl)));

			const sbiEl = _sel([['', '\u2014 HTTP/2 + JSON \u2014'], ['HTTP/2 + JSON', 'HTTP/2 + JSON (SBA standard)'], ['HTTP/2 + CBOR', 'HTTP/2 + CBOR (compact)'], ['gRPC', 'gRPC (internal NFs)']], this._wizardFirmware.sbiInterface);
			sbiEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, sbiInterface: sbiEl.value || undefined }; });
			const ricEl = _sel([['', '\u2014 none \u2014'], ['Near-RT RIC', 'Near-RT RIC (< 10ms loop, xApps)'], ['Non-RT RIC', 'Non-RT RIC (> 1s loop, rApps)'], ['both', 'Both Near-RT + Non-RT RIC'], ['none', 'No RIC integration']], this._wizardFirmware.ricIntegration);
			ricEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, ricIntegration: ricEl.value || undefined }; });
			left.appendChild(_col2(_row('SBI Interface', sbiEl), _row('O-RAN RIC Integration', ricEl)));

			const voiceEl = _sel([['', '\u2014 none \u2014'], ['VoNR', 'VoNR (5G native)'], ['VoLTE', 'VoLTE (IMS over LTE)'], ['VoWiFi', 'VoWiFi / Wi-Fi Calling'], ['none', 'Data-only (no voice)']], this._wizardFirmware.voiceProtocol);
			voiceEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, voiceProtocol: voiceEl.value || undefined }; });
			const fiveGSecEl = _inp('e.g. SUCI, AUSF, SEAF, AKMA (comma-separated)', this._wizardFirmware.fiveGSecurityFeatures);
			fiveGSecEl.addEventListener('input', () => { this._wizardFirmware = { ...this._wizardFirmware, fiveGSecurityFeatures: fiveGSecEl.value || undefined }; });
			left.appendChild(_col2(_row('Voice Protocol', voiceEl), _row('5G Security Features Required', fiveGSecEl)));

			const featureToggles = $e('div', 'display:flex;flex-wrap:wrap;gap:12px 24px;padding:10px 12px;border:1px solid var(--vscode-widget-border);border-radius:4px;background:var(--vscode-input-background);');
			featureToggles.appendChild($t('div', 'Feature Enablement', 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-descriptionForeground);width:100%;margin-bottom:2px;'));
			featureToggles.appendChild(_toggle('Network Slicing (3GPP TS 28.530)', !!this._wizardFirmware.networkSlicingEnabled, v => { this._wizardFirmware = { ...this._wizardFirmware, networkSlicingEnabled: v }; }));
			featureToggles.appendChild(_toggle('MEC Integration (ETSI GS MEC 003)', !!this._wizardFirmware.mecEnabled, v => { this._wizardFirmware = { ...this._wizardFirmware, mecEnabled: v }; }));
			featureToggles.appendChild(_toggle('Security key material \u2192 HSM/TEE (TS 33.501 §6.2)', !!this._wizardFirmware.keyMaterialExternalised, v => { this._wizardFirmware = { ...this._wizardFirmware, keyMaterialExternalised: v }; }));
			left.appendChild(_row('Feature Enablement', featureToggles));

			left.appendChild(_sectionHdr('Legacy SS7 / SIGTRAN Migration', '\u1F4DE'));
			const ss7VarEl = _sel([['', '\u2014 none \u2014'], ['ISUP', 'ISUP (ISDN User Part)'], ['MAP', 'MAP (Mobile Application Part)'], ['SCCP', 'SCCP'], ['TCAP', 'TCAP'], ['SIGTRAN (M3UA)', 'SIGTRAN M3UA'], ['SIGTRAN (M2UA)', 'SIGTRAN M2UA'], ['BICC', 'BICC (Bearer Independent CC)']], this._wizardFirmware.ss7Variant);
			ss7VarEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, ss7Variant: ss7VarEl.value || undefined }; });
			const ss7TgtEl = _sel([['', '\u2014 none \u2014'], ['Diameter', 'Diameter (EPC Cx/Sh/S6a/Gx)'], ['SIP/IMS', 'SIP / IMS'], ['SIP-I', 'SIP-I (ISUP encapsulation)'], ['HTTP/2 SBI', 'HTTP/2 SBI (5GC direct)']], this._wizardFirmware.ss7TargetProtocol);
			ss7TgtEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, ss7TargetProtocol: ss7TgtEl.value || undefined }; });
			left.appendChild(_col2(_row('SS7 Variant (source)', ss7VarEl), _row('Target Protocol', ss7TgtEl)));

			left.appendChild(_sectionHdr('Test & Conformance', '\u1F9EA'));
			const ttcn3El = _sel([['', '\u2014 none \u2014'], ['Eclipse Titan', 'Eclipse Titan (ETSI open-source)'], ['OpenTTCN', 'OpenTTCN'], ['Nokia TTCN-3', 'Nokia TTCN-3 Testworks'], ['Spirent TTCN-3', 'Spirent TestCenter TTCN-3']], this._wizardFirmware.ttcn3TestSystem);
			ttcn3El.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, ttcn3TestSystem: ttcn3El.value || undefined }; });
			const protoTestEl = _sel([['', '\u2014 none \u2014'], ['IXIA', 'Keysight IXIA IxNetwork'], ['Spirent TestCenter', 'Spirent TestCenter'], ['Keysight IXIA', 'Keysight IXIA (BreakingPoint)'], ['Custom', 'Custom / scripted']], this._wizardFirmware.protocolTestEquipment);
			protoTestEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, protocolTestEquipment: protoTestEl.value || undefined }; });
			left.appendChild(_col2(_row('TTCN-3 Test System', ttcn3El), _row('Protocol Test Equipment', protoTestEl)));
		}

		// \u2500\u2500 INDUSTRIAL IoT & OT \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		if (isIIoT) {
			left.appendChild(_sectionHdr('Industrial Fieldbus \u2014 Hard-Real-Time', '\u1F3ED'));

			const ecMasterEl = _sel([['', '\u2014 none \u2014'], ['SOEM', 'SOEM (Simple Open EtherCAT Master)'], ['EtherLab IgH', 'EtherLab IgH Master (Linux)'], ['Acontis EC-Master', 'Acontis EC-Master'], ['Beckhoff TwinCAT', 'Beckhoff TwinCAT 3'], ['Hilscher cifX', 'Hilscher cifX / netX'], ['Other', 'Other']], this._wizardFirmware.ethercatMasterStack);
			ecMasterEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, ethercatMasterStack: ecMasterEl.value || undefined }; });
			const ecEsiEl = _inp('e.g. slave_device.xml (ESI file path)', this._wizardFirmware.ethercatSlaveEsiPath);
			ecEsiEl.addEventListener('input', () => { this._wizardFirmware = { ...this._wizardFirmware, ethercatSlaveEsiPath: ecEsiEl.value || undefined }; });
			left.appendChild(_col2(_row('EtherCAT Master Stack', ecMasterEl), _row('EtherCAT Slave ESI File', ecEsiEl)));

			const pfnCcEl = _sel([['', '\u2014 none \u2014'], ['CC-A', 'CC-A (basic, NRT)'], ['CC-B', 'CC-B (standard, RT)'], ['CC-C', 'CC-C (IRT, hardware sync)']], this._wizardFirmware.profinetConformanceClass);
			pfnCcEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, profinetConformanceClass: pfnCcEl.value || undefined }; });
			const pfnVerEl = _sel([['', '\u2014 select \u2014'], ['v2.2', 'PROFINET v2.2'], ['v2.3', 'PROFINET v2.3'], ['v2.4', 'PROFINET v2.4 (MRP-I, latest)']], this._wizardFirmware.profinetVersion);
			pfnVerEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, profinetVersion: pfnVerEl.value || undefined }; });
			left.appendChild(_col2(_row('Profinet Conformance Class', pfnCcEl), _row('Profinet Version', pfnVerEl)));

			const canopenEl = _sel([['', '\u2014 none \u2014'], ['CiA 301', 'CiA 301 (application layer)'], ['CiA 402', 'CiA 402 (drives & motion)'], ['CiA 404', 'CiA 404 (measuring / I/O)'], ['CiA 406', 'CiA 406 (encoders)'], ['CiA 417', 'CiA 417 (lift systems)'], ['CiA 444', 'CiA 444 (hydraulics)']], this._wizardFirmware.canopenProfile);
			canopenEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, canopenProfile: canopenEl.value || undefined }; });
			const hartVerEl = _sel([['', '\u2014 none \u2014'], ['HART 5', 'HART 5 (legacy)'], ['HART 6', 'HART 6'], ['HART 7', 'HART 7 (current)'], ['WirelessHART', 'WirelessHART (IEC 62591)']], this._wizardFirmware.hartVersion);
			hartVerEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, hartVersion: hartVerEl.value || undefined }; });
			left.appendChild(_col2(_row('CANopen Device Profile', canopenEl), _row('HART Version', hartVerEl)));

			const fieldbusToggles = $e('div', 'display:flex;flex-wrap:wrap;gap:12px 24px;padding:10px 12px;border:1px solid var(--vscode-widget-border);border-radius:4px;background:var(--vscode-input-background);');
			fieldbusToggles.appendChild($t('div', 'Additional Fieldbus Protocols', 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-descriptionForeground);width:100%;margin-bottom:2px;'));
			fieldbusToggles.appendChild(_toggle('EtherNet/IP + CIP (ODVA)', !!this._wizardFirmware.ethernetIpEnabled, v => { this._wizardFirmware = { ...this._wizardFirmware, ethernetIpEnabled: v }; }));
			fieldbusToggles.appendChild(_toggle('IO-Link (IEC 61131-9) master/port', !!this._wizardFirmware.ioLinkEnabled, v => { this._wizardFirmware = { ...this._wizardFirmware, ioLinkEnabled: v }; }));
			fieldbusToggles.appendChild(_toggle('CC-Link IE Field Basic (Mitsubishi)', !!this._wizardFirmware.ccLinkEnabled, v => { this._wizardFirmware = { ...this._wizardFirmware, ccLinkEnabled: v }; }));
			fieldbusToggles.appendChild(_toggle('Powerlink (B&R / EPSG)', !!this._wizardFirmware.powerlinkEnabled, v => { this._wizardFirmware = { ...this._wizardFirmware, powerlinkEnabled: v }; }));
			fieldbusToggles.appendChild(_toggle('Sercos III (motion control)', !!this._wizardFirmware.sercosEnabled, v => { this._wizardFirmware = { ...this._wizardFirmware, sercosEnabled: v }; }));
			fieldbusToggles.appendChild(_toggle('WirelessHART / ISA-100.11a', !!this._wizardFirmware.wirelessFieldbusEnabled, v => { this._wizardFirmware = { ...this._wizardFirmware, wirelessFieldbusEnabled: v }; }));
			fieldbusToggles.appendChild(_toggle('Foundation Fieldbus H1 / HSE', !!this._wizardFirmware.foundationFieldbusEnabled, v => { this._wizardFirmware = { ...this._wizardFirmware, foundationFieldbusEnabled: v }; }));
			left.appendChild(fieldbusToggles);

			left.appendChild(_sectionHdr('OPC-UA & Time-Sensitive Networking', '\u1F517'));
			const opcuaIiotEl = _sel([['', '\u2014 none \u2014'], ['Micro', 'OPC-UA Micro Profile'], ['Nano', 'OPC-UA Nano Profile'], ['Embedded', 'OPC-UA Embedded Profile'], ['Full', 'OPC-UA Full Profile']], this._wizardFirmware.opcuaIiotProfile);
			opcuaIiotEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, opcuaIiotProfile: opcuaIiotEl.value || undefined }; });
			const opcuaNodeMgrEl = _sel([['', '\u2014 none \u2014'], ['open62541', 'open62541 (C, MIT)'], ['FreeOpcUa', 'FreeOpcUa (Python/C++)'], ['Prosys OPC UA', 'Prosys OPC UA SDK (Java)'], ['UA-.NETStandard', 'OPC Foundation UA-.NETStandard'], ['Custom', 'Custom implementation']], this._wizardFirmware.opcuaNodeManager);
			opcuaNodeMgrEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, opcuaNodeManager: opcuaNodeMgrEl.value || undefined }; });
			left.appendChild(_col2(_row('OPC-UA Profile', opcuaIiotEl), _row('OPC-UA Node Manager Library', opcuaNodeMgrEl)));

			const tsnStdEl = _inp('e.g. IEEE 802.1AS, IEEE 802.1Qbv, IEC/IEEE 60802', this._wizardFirmware.tsnStandards);
			tsnStdEl.addEventListener('input', () => { this._wizardFirmware = { ...this._wizardFirmware, tsnStandards: tsnStdEl.value || undefined }; });
			const tsnToggle = $e('div', 'display:flex;align-items:center;gap:8px;cursor:pointer;padding:8px 12px;border:1px solid var(--vscode-widget-border);border-radius:4px;background:var(--vscode-input-background);');
			const tsnCb = $e('input') as HTMLInputElement; tsnCb.type = 'checkbox'; tsnCb.checked = !!this._wizardFirmware.tsnEnabled; tsnCb.style.cursor = 'pointer';
			const tsnLbl = $t('span', 'Time-Sensitive Networking (TSN) required \u2014 IEEE 802.1Qbv/CB', 'font-size:12px;color:var(--vscode-foreground);cursor:pointer;');
			tsnCb.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, tsnEnabled: tsnCb.checked }; });
			tsnLbl.addEventListener('click', () => { tsnCb.checked = !tsnCb.checked; this._wizardFirmware = { ...this._wizardFirmware, tsnEnabled: tsnCb.checked }; });
			tsnToggle.appendChild(tsnCb); tsnToggle.appendChild(tsnLbl);
			const opcuaPsToggle = $e('div', 'display:flex;align-items:center;gap:8px;cursor:pointer;padding:8px 12px;border:1px solid var(--vscode-widget-border);border-radius:4px;background:var(--vscode-input-background);');
			const opcuaPsCb = $e('input') as HTMLInputElement; opcuaPsCb.type = 'checkbox'; opcuaPsCb.checked = !!this._wizardFirmware.opcuaPubSubEnabled; opcuaPsCb.style.cursor = 'pointer';
			const opcuaPsLbl = $t('span', 'OPC-UA PubSub (MQTT/UADP) over TSN backbone', 'font-size:12px;color:var(--vscode-foreground);cursor:pointer;');
			opcuaPsCb.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, opcuaPubSubEnabled: opcuaPsCb.checked }; });
			opcuaPsLbl.addEventListener('click', () => { opcuaPsCb.checked = !opcuaPsCb.checked; this._wizardFirmware = { ...this._wizardFirmware, opcuaPubSubEnabled: opcuaPsCb.checked }; });
			opcuaPsToggle.appendChild(opcuaPsCb); opcuaPsToggle.appendChild(opcuaPsLbl);
			left.appendChild(_col2(_row('TSN', tsnToggle), _row('OPC-UA PubSub', opcuaPsToggle)));
			left.appendChild(_row('TSN Standards in Scope', tsnStdEl, 'Comma-separated IEEE / IEC/IEEE standards.'));

			left.appendChild(_sectionHdr('Edge, Cloud & Safety', '\u2601\uFE0F'));
			const mqttEl = _sel([['', '\u2014 none \u2014'], ['SparkplugB v3', 'MQTT SparkplugB v3.0'], ['MQTT 5.0', 'MQTT 5.0'], ['MQTT 3.1.1', 'MQTT 3.1.1'], ['DDS', 'DDS (OMG, ROS2)']], this._wizardFirmware.mqttVersion);
			mqttEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, mqttVersion: mqttEl.value || undefined }; });
			const cloudEl = _sel([['', '\u2014 none \u2014'], ['AWS IoT Core', 'AWS IoT Core + Greengrass'], ['Azure IoT Hub', 'Azure IoT Hub + IoT Edge'], ['GCP IoT Core', 'GCP IoT Core'], ['Custom', 'Custom Broker']], this._wizardFirmware.cloudIotPlatform);
			cloudEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, cloudIotPlatform: cloudEl.value || undefined }; });
			left.appendChild(_col2(_row('MQTT / Messaging Protocol', mqttEl), _row('Cloud IoT Platform', cloudEl)));

			const edgePlatformEl = _sel([['', '\u2014 none \u2014'], ['Azure IoT Edge', 'Azure IoT Edge (modules)'], ['AWS Greengrass v2', 'AWS Greengrass v2'], ['GCP Edge TPU', 'GCP Edge TPU + Coral'], ['EdgeX Foundry', 'EdgeX Foundry (LF Edge)'], ['Custom', 'Custom edge stack']], this._wizardFirmware.edgePlatform);
			edgePlatformEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, edgePlatform: edgePlatformEl.value || undefined }; });
			const localHistEl = _sel([['', '\u2014 none \u2014'], ['Kepware', 'Kepware KEPServerEX'], ['OSIsoft PI', 'AVEVA PI System (local)'], ['InfluxDB', 'InfluxDB OSS'], ['TimescaleDB', 'TimescaleDB'], ['Custom', 'Custom TSDB']], this._wizardFirmware.localHistorian);
			localHistEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, localHistorian: localHistEl.value || undefined }; });
			left.appendChild(_col2(_row('Edge Computing Platform', edgePlatformEl), _row('Local Data Historian / TSDB', localHistEl)));

			const iec62061El = _sel([['', '\u2014 none \u2014'], ['SIL 1 / PLc', 'SIL 1 / PLc'], ['SIL 2 / PLd', 'SIL 2 / PLd'], ['SIL 3 / PLe', 'SIL 3 / PLe (highest)']], this._wizardFirmware.iec62061Target);
			iec62061El.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, iec62061Target: iec62061El.value || undefined }; });
			const safetyStdEl = _sel([['', '\u2014 none \u2014'], ['IEC 62061', 'IEC 62061 (machinery electrics)'], ['ISO 13849', 'ISO 13849-1 (PLa\u2013PLe)'], ['IEC 61784-3', 'IEC 61784-3 (functional safety fieldbus)'], ['EN ISO 10218', 'EN ISO 10218 (industrial robots)']], this._wizardFirmware.functionalSafetyStandard);
			safetyStdEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, functionalSafetyStandard: safetyStdEl.value || undefined }; });
			left.appendChild(_col2(_row('IEC 62061 / ISO 13849 Target', iec62061El), _row('Functional Safety Standard', safetyStdEl)));

			const zoneEl = _sel([['', '\u2014 none \u2014'], ['Zone 0', 'Zone 0 \u2014 Untrusted external'], ['Zone 1', 'Zone 1 \u2014 Enterprise/IT'], ['Zone 2', 'Zone 2 \u2014 Supervisory/SCADA'], ['Zone 3', 'Zone 3 \u2014 Control'], ['Zone 4', 'Zone 4 \u2014 Field devices']], this._wizardFirmware.zoneSeparationLevel);
			zoneEl.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, zoneSeparationLevel: zoneEl.value || undefined }; });
			const idmzWrap = $e('div', 'display:flex;align-items:center;gap:8px;cursor:pointer;padding:8px 12px;border:1px solid var(--vscode-widget-border);border-radius:4px;background:var(--vscode-input-background);');
			const idmzCb = $e('input') as HTMLInputElement; idmzCb.type = 'checkbox'; idmzCb.checked = !!this._wizardFirmware.idmzRequired; idmzCb.style.cursor = 'pointer';
			const idmzLbl = $t('span', 'IDMZ / data diode required for OT-to-IT boundary (IEC 62443-3-3)', 'font-size:12px;color:var(--vscode-foreground);cursor:pointer;');
			idmzCb.addEventListener('change', () => { this._wizardFirmware = { ...this._wizardFirmware, idmzRequired: idmzCb.checked }; });
			idmzLbl.addEventListener('click', () => { idmzCb.checked = !idmzCb.checked; this._wizardFirmware = { ...this._wizardFirmware, idmzRequired: idmzCb.checked }; });
			idmzWrap.appendChild(idmzCb); idmzWrap.appendChild(idmzLbl);
			left.appendChild(_col2(_row('IEC 62443 Zone Level', zoneEl), _row('OT/IT Boundary IDMZ', idmzWrap)));
		}

		// \u2500\u2500 INIT BUTTON \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		left.appendChild($e('div', 'height:8px;'));
		const initBtn = this._btn(
			this._wizardBusy ? 'Initialising\u2026' : 'Initialise Project \u2192',
			true,
			async () => {
				if (this._wizardBusy) { return; }
				const vs = this._wizardSources.filter(s => s.uri.path);
				const vt = this._wizardTargets.filter(t => t.uri.path);
				if (!vs.length || !vt.length || !this._wizardPattern) { return; }
				this._wizardBusy = true;
				this._render();
				try {
					await this.sessionService.createProject(vs, vt, this._wizardPattern);
					this.sessionService.setFirmwareConfig(this._wizardFirmware);
					await this.commandService.executeCommand('neuralInverse.openModernisationSourceWindows');
					await this.commandService.executeCommand('neuralInverse.openModernisationTargetWindows');
				} finally {
					this._wizardBusy = false;
				}
			},
			'padding:9px 20px;font-size:13px;font-weight:600;width:100%;text-align:center;',
		);
		left.appendChild(initBtn);
		left.appendChild($t('div', 'All fields are optional \u2014 config can be updated from the active session panel.',
			'font-size:10px;color:var(--vscode-descriptionForeground);opacity:0.7;'));

		// \u2500\u2500 Right panel \u2014 Compliance Frameworks (all verticals) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const right = $e('div', 'width:280px;min-width:240px;flex-shrink:0;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:8px;background:var(--vscode-sideBar-background,var(--vscode-editor-background));');
		layout.appendChild(right);

		right.appendChild($t('div', 'Compliance Frameworks',
			'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-descriptionForeground);margin-bottom:4px;'));
		right.appendChild($t('div', 'Select all frameworks that apply to this project. These gate requirements and phase ordering.',
			'font-size:10px;color:var(--vscode-descriptionForeground);line-height:1.5;margin-bottom:8px;'));

		// Per-category framework groups
		const frameworkGroups: Array<{ group: string; icon: string; opts: Array<[string, string]> }> = [
			{
				group: 'Embedded / Firmware', icon: '\u1F4BB',
				opts: [
					['misra-c-2012', 'MISRA-C:2012'],
					['misra-c-2023', 'MISRA-C:2023 (latest)'],
					['misra-cpp-2008', 'MISRA-C++:2008'],
					['cert-c', 'CERT-C (SEI Carnegie Mellon)'],
					['cert-cpp', 'CERT-C++ (SEI)'],
					['iec-61508', 'IEC 61508 (Functional Safety SW)'],
					['iec-62304', 'IEC 62304 (Medical Device SW)'],
					['do-178c', 'DO-178C (Avionics SW)'],
					['do-254', 'DO-254 (Avionics HW)'],
					['en-50128', 'EN 50128 (Railway SW)'],
					['arinc-653', 'ARINC 653 (APEX partitioning)'],
				],
			},
			{
				group: 'Automotive', icon: '\u1F697',
				opts: [
					['iso-26262', 'ISO 26262 (Road Vehicles \u2014 ASIL)'],
					['autosar', 'AUTOSAR Classic / Adaptive'],
					['iso-21434', 'ISO/SAE 21434 (Automotive Cybersecurity)'],
					['sae-j3061', 'SAE J3061 (Cybersecurity Guidebook)'],
					['un-r155', 'UN Regulation 155 (CSMS)'],
					['un-r156', 'UN Regulation 156 (SUMS \u2014 OTA)'],
					['iatf-16949', 'IATF 16949 (QMS Automotive)'],
					['aspice', 'Automotive SPICE (A-SPICE v3.1)'],
				],
			},
			{
				group: 'Critical Infrastructure (Energy / O&G)', icon: '\u26A1',
				opts: [
					['iec-61511', 'IEC 61511 (SIS / ESD \u2014 Process Safety)'],
					['iec-61850', 'IEC 61850 (Substation Automation)'],
					['iec-60870', 'IEC 60870-5 (Telecontrol)'],
					['iec-61508-hw', 'IEC 61508 (Hardware / SIL)'],
					['nerc-cip', 'NERC CIP (Critical Infrastructure)'],
					['iec-62443', 'IEC 62443 (OT Security \u2014 all parts)'],
					['iec-62351', 'IEC 62351 (Power System Comms Security)'],
					['nist-sp-800-82', 'NIST SP 800-82 (ICS Security Guide)'],
					['api-std-1164', 'API Std 1164 (Pipeline SCADA Security)'],
					['isa-99', 'ISA/IEC 99 (IACS Security)'],
				],
			},
			{
				group: 'Telecom & 5G', icon: '\u1F4E1',
				opts: [
					['3gpp-security', '3GPP Security (TS 33.501 / TS 33.310)'],
					['3gpp-ran', '3GPP RAN (TS 38.xxx / TS 36.xxx)'],
					['gsma-nesas', 'GSMA NESAS (Network Equipment Security)'],
					['gsma-prd-fs13', 'GSMA PRD FS.13 (Test Evidence Format)'],
					['etsi-nfv', 'ETSI NFV-SEC (Network Function Security)'],
					['etsi-mec', 'ETSI MEC (Multi-access Edge Computing)'],
					['o-ran-security', 'O-RAN Security (O-RAN Alliance)'],
					['itu-t-x805', 'ITU-T X.805 (Telecom Network Security)'],
					['fips-140-3', 'FIPS 140-3 (Cryptographic Modules)'],
				],
			},
			{
				group: 'Industrial IoT / OT', icon: '\u1F3ED',
				opts: [
					['iec-62061', 'IEC 62061 / ISO 13849 (Machine Safety)'],
					['iec-61784-3', 'IEC 61784-3 (Functional Safety Fieldbus)'],
					['iec-62443-iiot', 'IEC 62443 (Zone/Conduit \u2014 IIoT)'],
					['iec-61131-3', 'IEC 61131-3 (PLC Programming)'],
					['iso-10218', 'EN ISO 10218 (Industrial Robots)'],
					['en-62061', 'EN 62061 (Machinery \u2014 SIL)'],
					['odva-cip', 'ODVA CIP / EtherNet/IP'],
					['profibus-profinet', 'PROFIBUS / PROFINET (PI)'],
					['opc-ua-spec', 'OPC-UA (IEC 62541 \u2014 all parts)'],
					['tsn-iec60802', 'IEC/IEEE 60802 TSN Industrial Profile'],
				],
			},
		];

		const compCBs: HTMLInputElement[] = [];

		for (const grp of frameworkGroups) {
			const grpHdr = $e('div', [
				'display:flex', 'align-items:center', 'gap:6px',
				'padding:5px 8px', 'border-radius:3px',
				'background:var(--vscode-sideBarSectionHeader-background)',
				'margin-top:4px', 'margin-bottom:2px',
			].join(';'));
			grpHdr.appendChild($t('span', grp.icon, 'font-size:12px;'));
			grpHdr.appendChild($t('span', grp.group, 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-sideBarSectionHeader-foreground);'));
			right.appendChild(grpHdr);

			// De-duplicate within group
			const seen = new Set<string>();
			for (const [value, label] of grp.opts) {
				if (seen.has(value)) { continue; }
				seen.add(value);
				const lbl = $e('label', 'display:flex;align-items:center;gap:7px;font-size:12px;cursor:pointer;padding:3px 4px;border-radius:3px;');
				const cb = $e('input') as HTMLInputElement; cb.type = 'checkbox'; cb.value = value; cb.style.cursor = 'pointer';
				cb.checked = this._wizardFirmware.complianceFrameworks.includes(value as never);
				cb.addEventListener('change', () => {
					const active = compCBs.filter(c => c.checked).map(c => c.value);
					this._wizardFirmware = { ...this._wizardFirmware, complianceFrameworks: active as never[] };
				});
				compCBs.push(cb);
				lbl.appendChild(cb);
				lbl.appendChild(document.createTextNode(label));
				lbl.addEventListener('mouseenter', () => { lbl.style.background = 'var(--vscode-list-hoverBackground)'; });
				lbl.addEventListener('mouseleave', () => { lbl.style.background = ''; });
				right.appendChild(lbl);
			}
		}
	}

	private _folderStep(
		num: string, title: string, desc: string,
		selected: URI | undefined, btnLabel: string,
		onPick: () => void,
		onRemove?: () => void,
	): HTMLElement {
		const isDone = !!selected && !!selected.path;
		const card = $e('div', [
			'border-radius:6px', 'overflow:hidden',
			'border:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
			isDone ? 'border-left:3px solid var(--vscode-terminal-ansiGreen,#4caf50);' : '',
			'background:var(--vscode-input-background)',
		].join(';'));

		// Header
		const hdr = $e('div', [
			'display:flex', 'align-items:center', 'gap:10px',
			'padding:10px 12px',
			'background:var(--vscode-sideBarSectionHeader-background)',
			'border-bottom:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
		].join(';'));
		const badge = $t('div', isDone ? '\u2713' : num, [
			'width:20px', 'height:20px', 'border-radius:50%', 'flex-shrink:0',
			'font-size:10px', 'font-weight:700',
			'display:flex', 'align-items:center', 'justify-content:center',
			isDone
				? 'background:var(--vscode-terminal-ansiGreen,#4caf50);color:#fff;'
				: 'border:1.5px solid var(--vscode-descriptionForeground);color:var(--vscode-descriptionForeground);',
		].join(';'));
		hdr.appendChild(badge);
		hdr.appendChild($t('span', title, 'font-size:12px;font-weight:600;color:var(--vscode-foreground);flex:1;'));
		if (onRemove) {
			const removeBtn = this._btn('\u00d7', false, onRemove, 'font-size:12px;padding:1px 5px;opacity:0.6;');
			removeBtn.title = 'Remove';
			hdr.appendChild(removeBtn);
		}
		card.appendChild(hdr);

		// Body
		const bodyEl = $e('div', 'padding:10px 12px;');
		bodyEl.appendChild($t('div', desc, 'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5;margin-bottom:10px;'));

		if (isDone) {
			const pathRow = $e('div', 'display:flex;align-items:center;gap:8px;');
			const pathEl = $t('div', selected!.fsPath, [
				'flex:1', 'font-size:11px',
				'font-family:var(--vscode-editor-font-family,monospace)',
				'color:var(--vscode-foreground)',
				'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap',
				'background:var(--vscode-editor-background)',
				'padding:4px 8px', 'border-radius:3px',
				'border:1px solid var(--vscode-input-border,var(--vscode-widget-border))',
			].join(';'));
			pathEl.title = selected!.toString();
			pathRow.appendChild(pathEl);
			pathRow.appendChild(this._btn('Change', false, onPick, 'font-size:11px;padding:3px 8px;flex-shrink:0;'));
			bodyEl.appendChild(pathRow);
		} else {
			bodyEl.appendChild(this._btn(btnLabel, false, onPick, 'width:100%;text-align:center;padding:6px;'));
		}
		card.appendChild(bodyEl);
		return card;
	}

	private _patternPanel(initBtn: HTMLButtonElement): HTMLElement {
		const panel = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;');

		// Panel header
		const hdr = $e('div', [
			'padding:14px 20px 10px',
			'border-bottom:1px solid var(--vscode-panel-border,var(--vscode-widget-border))',
			'flex-shrink:0',
		].join(';'));
		const patternSelected = this._wizardPattern
			? (MIGRATION_PATTERN_LABELS[this._wizardPattern] ?? this._wizardPattern)
			: null;
		hdr.appendChild($t('div', 'Migration Pattern',
			'font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-foreground);margin-bottom:4px;'));
		if (patternSelected) {
			hdr.appendChild($t('div', `\u2713  ${patternSelected}`,
				'font-size:11px;color:var(--vscode-terminal-ansiGreen,#4caf50);'));
		} else {
			hdr.appendChild($t('div', 'Choose a preset or type a custom pattern below.',
				'font-size:11px;color:var(--vscode-descriptionForeground);'));
		}
		panel.appendChild(hdr);

		// Scrollable list
		const list = $e('div', 'flex:1;overflow-y:auto;padding:8px 16px;');

		const categories = [...new Set(MIGRATION_PATTERN_PRESETS.map(p => p.category))];
		for (const cat of categories) {
			list.appendChild($t('div', cat, [
				'font-size:10px', 'font-weight:700', 'text-transform:uppercase',
				'letter-spacing:0.07em', 'color:var(--vscode-descriptionForeground)',
				'margin:12px 0 4px', 'padding:0 2px',
			].join(';')));

			for (const preset of MIGRATION_PATTERN_PRESETS.filter(p => p.category === cat)) {
				const isSelected = this._wizardPattern === preset.id;
				const row = $e('div', [
					'display:flex', 'align-items:flex-start', 'gap:10px',
					'padding:7px 10px', 'border-radius:4px', 'cursor:pointer',
					'border:1px solid transparent',
					isSelected
						? 'background:var(--vscode-list-activeSelectionBackground);border-color:var(--vscode-focusBorder,transparent);'
						: '',
				].join(';'));

				const dot = $e('div', [
					'width:13px', 'height:13px', 'border-radius:50%', 'flex-shrink:0', 'margin-top:3px',
					'border:1.5px solid var(--vscode-descriptionForeground)',
					isSelected ? 'background:var(--vscode-button-background);border-color:var(--vscode-button-background);' : '',
				].join(';'));
				row.appendChild(dot);

				const txt = $e('div', 'flex:1;min-width:0;');
				txt.appendChild($t('div', MIGRATION_PATTERN_LABELS[preset.id], [
					'font-size:12px', 'font-weight:600', 'margin-bottom:1px',
					`color:${isSelected ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)'}`,
				].join(';')));
				txt.appendChild($t('div', MIGRATION_PATTERN_DESCRIPTIONS[preset.id], [
					'font-size:10px', 'line-height:1.4',
					`color:${isSelected ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-descriptionForeground)'}`,
				].join(';')));
				row.appendChild(txt);

				row.addEventListener('click', () => { this._wizardPattern = preset.id; this._render(); });
				row.addEventListener('mouseenter', () => { if (!isSelected) { row.style.background = 'var(--vscode-list-hoverBackground)'; } });
				row.addEventListener('mouseleave', () => { if (!isSelected) { row.style.background = 'transparent'; } });
				list.appendChild(row);
			}
		}
		panel.appendChild(list);

		// Custom / universal text input \u2014 fixed at bottom
		const customBar = $e('div', [
			'flex-shrink:0', 'padding:12px 16px',
			'border-top:1px solid var(--vscode-panel-border,var(--vscode-widget-border))',
			'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
		].join(';'));
		customBar.appendChild($t('div', 'Or define your own pattern:',
			'font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:6px;'));
		const inputRow = $e('div', 'display:flex;gap:8px;align-items:center;');
		const customInput = $e('input', [
			'flex:1', 'padding:5px 10px',
			'background:var(--vscode-input-background)',
			'color:var(--vscode-input-foreground)',
			'border:1px solid var(--vscode-input-border,var(--vscode-widget-border))',
			'border-radius:3px', 'font-size:12px', 'font-family:inherit',
		].join(';'));
		(customInput as HTMLInputElement).placeholder = 'e.g. PL/1 \u2192 Node.js, EJB consolidation\u2026';
		// Pre-fill if the current pattern is not a preset
		const isCustom = this._wizardPattern && !MIGRATION_PATTERN_PRESETS.find(p => p.id === this._wizardPattern);
		if (isCustom) { (customInput as HTMLInputElement).value = this._wizardPattern!; }
		customInput.addEventListener('input', () => {
			const val = (customInput as HTMLInputElement).value.trim();
			this._wizardPattern = val || undefined;
			// Update the header without a full re-render (avoid losing focus)
			const tick = hdr.children[1] as HTMLElement | undefined;
			if (tick) {
				tick.textContent = val ? `\u2713  ${val}` : 'Choose a preset or type a custom pattern below.';
				tick.style.color = val ? 'var(--vscode-terminal-ansiGreen,#4caf50)' : 'var(--vscode-descriptionForeground)';
			}
			// Deselect any preset radio dots
			const allDots = list.querySelectorAll<HTMLElement>('div[style*="border-radius:50%"]');
			allDots.forEach(d => {
				d.style.background = '';
				d.style.borderColor = 'var(--vscode-descriptionForeground)';
			});
			// Update init button state
			const canNow = this._wizardSources.some(s => s.uri.path) && this._wizardTargets.some(t => t.uri.path) && !!val;
			(initBtn as HTMLButtonElement).disabled = !canNow;
			initBtn.style.opacity = canNow ? '1' : '0.4';
			initBtn.style.cursor  = canNow ? 'pointer' : 'not-allowed';
		});
		inputRow.appendChild(customInput);
		customBar.appendChild(inputRow);
		panel.appendChild(customBar);

		return panel;
	}

	// \u2500\u2500\u2500 ACTIVE screen \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _renderActive(root: HTMLElement, session: IModernisationSessionData): void {
		const layout = $e('div', 'flex:1;display:flex;overflow:hidden;');
		root.appendChild(layout);
		layout.appendChild(this._buildWorkflowPanel(session));
		layout.appendChild($e('div', 'width:1px;background:var(--vscode-panel-border,var(--vscode-widget-border));flex-shrink:0;'));
		layout.appendChild(this._buildCompliancePanel(session));
	}

	// Left panel: project info + pattern + workflow + config
	private _buildWorkflowPanel(session: IModernisationSessionData): HTMLElement {
		const panel = $e('div', 'width:300px;min-width:280px;flex-shrink:0;display:flex;flex-direction:column;overflow-y:auto;background:var(--vscode-sideBar-background,var(--vscode-editor-background));');

		// Project section \u2014 sources + targets
		const projSec = this._section('Projects');
		for (const pt of session.sources) {
			projSec.appendChild(this._projectRow('SRC', pt, 'neuralInverse.openModernisationSourceWindows'));
		}
		for (const pt of session.targets) {
			projSec.appendChild(this._projectRow('TGT', pt, 'neuralInverse.openModernisationTargetWindows'));
		}
		const inv = $e('div', 'display:flex;align-items:center;gap:6px;margin-top:4px;');
		inv.appendChild($t('span', '\u25cf', 'color:var(--vscode-activityBarBadge-background,var(--vscode-button-background));font-size:8px;'));
		inv.appendChild($t('span', 'Modernisation.inverse  paired',
			'font-size:10px;color:var(--vscode-descriptionForeground);'));
		projSec.appendChild(inv);
		panel.appendChild(projSec);

		// Migration pattern section
		if (session.migrationPattern) {
			const patSec = this._section('Migration Pattern');
			const tile = $e('div', 'padding:8px 10px;border-radius:4px;background:var(--vscode-input-background);border:1px solid var(--vscode-widget-border);');
			tile.appendChild($t('div', MIGRATION_PATTERN_LABELS[session.migrationPattern],
				'font-size:12px;font-weight:600;color:var(--vscode-editor-foreground);margin-bottom:3px;'));
			tile.appendChild($t('div', MIGRATION_PATTERN_DESCRIPTIONS[session.migrationPattern],
				'font-size:10px;color:var(--vscode-descriptionForeground);line-height:1.4;'));

			const changeBtn = this._btn('Change Pattern', false, () => {
				// Re-enter wizard step 1 (pattern picker) with current projects pre-filled
				this._wizardMode    = true;
				this._wizardStep    = 1;
				this._wizardSources = session.sources.map(s => ({ uri: URI.parse(s.folderUri), label: s.label }));
				this._wizardTargets = session.targets.map(t => ({ uri: URI.parse(t.folderUri), label: t.label }));
				this._wizardPattern = session.migrationPattern;
				this.sessionService.endSession();
			}, 'font-size:10px;padding:3px 8px;margin-top:8px;');
			tile.appendChild(changeBtn);
			patSec.appendChild(tile);
			panel.appendChild(patSec);
		}

		// \u2500\u2500 Vertical Config section \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		// Adapts title + displayed fields based on the active migration pattern
		// category. Falls back to firmware fields if no vertical is detected.
		{
			const fwCfg  = session.firmwareConfig;
			const fwLive = this._fwSession.session;

			// Detect vertical from the migration pattern
			const activePreset = MIGRATION_PATTERN_PRESETS.find(p => p.id === session.migrationPattern);
			const category     = activePreset?.category ?? '';
			const isAutosar    = category === 'Automotive' || session.migrationPattern === 'autosar-classic-to-adaptive' || session.migrationPattern === 'autosar-cp-to-ap';
			const isEnergy     = category === 'Critical Infrastructure';
			const isTelecom    = category === 'Telecom & 5G';
			const isIIoT       = category === 'Industrial IoT & OT' || category === 'Industrial & OT';
			const isFirmware   = !isAutosar && !isEnergy && !isTelecom && !isIIoT &&
				['Firmware Modernisation', 'Architecture', 'Safety & Compliance', ''].includes(category);

			// Section title adapts to vertical
			const sectionTitle =
				isAutosar  ? 'Automotive / AUTOSAR Config' :
				isEnergy   ? 'Energy / Critical Infrastructure Config' :
				isTelecom  ? 'Telecom & 5G Config' :
				isIIoT     ? 'Industrial IoT / OT Config' :
				'Firmware Target Config';

			// Determine whether any config has been set (used to choose button label)
			const hasConfig = !!(
				fwCfg?.mcuVariant || fwCfg?.rtos || fwLive.isActive ||
				fwCfg?.autosarSchemaVersion || fwCfg?.asilTarget ||
				fwCfg?.iec61850Edition || fwCfg?.silTarget ||
				fwCfg?.release3gpp || fwCfg?.rat ||
				fwCfg?.ethercatMasterStack || fwCfg?.profinetConformanceClass
			);

			const cfgSec = this._section(sectionTitle);
			const rows: Array<[string, string]> = [];

			// \u2500\u2500 Firmware fields \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
			if (isFirmware || (!isAutosar && !isEnergy && !isTelecom && !isIIoT)) {
				const mcuVariant = fwCfg?.mcuVariant ?? fwLive.mcuConfig?.variant;
				const mcuFamily  = fwCfg?.mcuFamily  ?? fwLive.mcuConfig?.family;
				if (mcuVariant)  { rows.push(['MCU Variant',   mcuVariant]); }
				if (mcuFamily && mcuFamily !== mcuVariant) { rows.push(['MCU Family', mcuFamily]); }
				const core = fwCfg?.core ?? fwLive.mcuConfig?.core;
				if (core)        { rows.push(['Core', core.toUpperCase()]); }
				const flash = fwCfg?.flashSize ?? fwLive.mcuConfig?.flashSize;
				if (flash)       { rows.push(['Flash', `${Math.round(flash / 1024)} KB`]); }
				const ram = fwCfg?.ramSize ?? fwLive.mcuConfig?.ramSize;
				if (ram)         { rows.push(['RAM', `${Math.round(ram / 1024)} KB`]); }
				const clk = fwCfg?.clockMHz ?? fwLive.mcuConfig?.clockMHz;
				if (clk)         { rows.push(['Clock', `${clk} MHz`]); }
				const rtos = fwCfg?.rtos ?? fwLive.rtos;
				if (rtos)        { rows.push(['RTOS', rtos]); }
				const build = fwCfg?.buildSystem ?? fwLive.buildSystem;
				if (build)       { rows.push(['Build System', build]); }
				if (fwCfg?.hal)  { rows.push(['HAL', fwCfg.hal]); }
				if (fwCfg?.targetMcuVariant) { rows.push(['Target MCU', fwCfg.targetMcuVariant]); }
				if (fwCfg?.targetRtos)       { rows.push(['Target RTOS', fwCfg.targetRtos]); }
				if (fwCfg?.targetBuildSystem){ rows.push(['Target Build', fwCfg.targetBuildSystem]); }
				if (fwCfg?.targetHal)        { rows.push(['Target HAL', fwCfg.targetHal]); }
			}

			// \u2500\u2500 Automotive / AUTOSAR fields \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
			if (isAutosar) {
				if (fwCfg?.autosarSchemaVersion) { rows.push(['AUTOSAR Schema', fwCfg.autosarSchemaVersion]); }
				if (fwCfg?.asilTarget)            { rows.push(['ASIL Target', fwCfg.asilTarget]); }
				if (fwCfg?.someIpMode)            { rows.push(['SOME/IP Mode', fwCfg.someIpMode]); }
				if (fwCfg?.dbcToolVersion)        { rows.push(['DBC Tool', fwCfg.dbcToolVersion]); }
				if (fwCfg?.targetAraComEnabled)   { rows.push(['ara::com', 'Enabled']); }
				if (fwCfg?.targetAraDiagEnabled)  { rows.push(['ara::diag', 'Enabled']); }
				if (fwCfg?.targetAraPerEnabled)   { rows.push(['ara::per', 'Enabled']); }
			}

			// \u2500\u2500 Energy / Critical Infrastructure fields \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
			if (isEnergy) {
				if (fwCfg?.iec61850Edition)       { rows.push(['IEC 61850 Edition', fwCfg.iec61850Edition]); }
				if (fwCfg?.gooseDatasets)         { rows.push(['GOOSE Datasets', fwCfg.gooseDatasets]); }
				if (fwCfg?.svStreams)              { rows.push(['SV Streams', fwCfg.svStreams]); }
				if (fwCfg?.sclFilePath)           { rows.push(['SCL File', fwCfg.sclFilePath.split('/').pop() ?? fwCfg.sclFilePath]); }
				if (fwCfg?.dnp3Level)             { rows.push(['DNP3 Level', fwCfg.dnp3Level]); }
				if (fwCfg?.silTarget)             { rows.push(['SIL Target', fwCfg.silTarget]); }
				if (fwCfg?.opcuaNamespaceUri)     { rows.push(['OPC-UA Namespace', fwCfg.opcuaNamespaceUri]); }
				if (fwCfg?.iec62443SecurityLevel) { rows.push(['IEC 62443 SL', fwCfg.iec62443SecurityLevel]); }
			}

			// \u2500\u2500 Telecom & 5G fields \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
			if (isTelecom) {
				if (fwCfg?.release3gpp)           { rows.push(['3GPP Release', fwCfg.release3gpp]); }
				if (fwCfg?.oranSplitOption)       { rows.push(['O-RAN Split', fwCfg.oranSplitOption]); }
				if (fwCfg?.rat)                   { rows.push(['RAT', fwCfg.rat]); }
				if (fwCfg?.coreNetworkMode)       { rows.push(['Core Network', fwCfg.coreNetworkMode]); }
				if (fwCfg?.keyMaterialExternalised !== undefined) {
					rows.push(['Key Material', fwCfg.keyMaterialExternalised ? 'HSM/TEE \u2713' : 'Not Externalised']);
				}
				if (fwCfg?.ss7Variant)            { rows.push(['SS7 Variant', fwCfg.ss7Variant]); }
				if (fwCfg?.ss7TargetProtocol)     { rows.push(['SS7 Target', fwCfg.ss7TargetProtocol]); }
			}

			// \u2500\u2500 Industrial IoT / OT fields \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
			if (isIIoT) {
				if (fwCfg?.ethercatMasterStack)       { rows.push(['EtherCAT Stack', fwCfg.ethercatMasterStack]); }
				if (fwCfg?.profinetConformanceClass)  { rows.push(['PROFINET Class', fwCfg.profinetConformanceClass]); }
				if (fwCfg?.mqttVersion)               { rows.push(['MQTT Version', fwCfg.mqttVersion]); }
				if (fwCfg?.cloudIotPlatform)          { rows.push(['Cloud IoT', fwCfg.cloudIotPlatform]); }
				if (fwCfg?.iec62061Target)            { rows.push(['IEC 62061 SIL', fwCfg.iec62061Target]); }
				if (fwCfg?.canopenProfile)            { rows.push(['CANopen Profile', fwCfg.canopenProfile]); }
				if (fwCfg?.idmzRequired !== undefined){ rows.push(['IDMZ Required', fwCfg.idmzRequired ? 'Yes' : 'No']); }
			}

			// \u2500\u2500 Compliance frameworks (all verticals) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
			const compliance = fwCfg?.complianceFrameworks ?? fwLive.complianceFrameworks;
			if (compliance?.length) { rows.push(['Compliance', compliance.join(', ')]); }

			// \u2500\u2500 Render rows \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
			if (hasConfig && rows.length > 0) {
				for (const [key, val] of rows) {
					const r = $e('div', [
						'display:flex', 'justify-content:space-between', 'align-items:baseline',
						'padding:3px 0',
						'border-bottom:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
						'font-size:12px',
					].join(';'));
					r.appendChild($t('span', key, 'color:var(--vscode-descriptionForeground);'));
					r.appendChild($t('span', val,
						'font-weight:600;font-family:var(--vscode-editor-font-family,monospace);font-size:11px;text-align:right;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'));
					cfgSec.appendChild(r);
				}
			} else {
				const placeholder =
					isAutosar  ? 'Configure AUTOSAR schema version, ASIL target, and ara:: migration options.' :
					isEnergy   ? 'Configure IEC 61850 edition, SIL target, DNP3 level, and SCADA protocol details.' :
					isTelecom  ? 'Configure 3GPP release, O-RAN split option, RAT, and security key parameters.' :
					isIIoT     ? 'Configure EtherCAT/PROFINET stack, MQTT version, IoT platform, and zone isolation.' :
					'Configure source MCU, RTOS, and compliance targets for this modernisation.';
				cfgSec.appendChild($t('div', placeholder,
					'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5;'));
			}

			// Configure / Update button \u2014 jumps to step 2 with projects pre-filled
			const btnLabel =
				hasConfig
					? 'Update Config'
					: isAutosar  ? 'Configure AUTOSAR \u2192'
					: isEnergy   ? 'Configure Energy Config \u2192'
					: isTelecom  ? 'Configure Telecom Config \u2192'
					: isIIoT     ? 'Configure IIoT/OT Config \u2192'
					: 'Configure Firmware \u2192';

			const cfgBtn = this._btn(btnLabel, false, () => {
				this._wizardMode     = true;
				this._wizardStep     = 2;
				this._wizardSources  = session.sources.map(s => ({ uri: URI.parse(s.folderUri), label: s.label }));
				this._wizardTargets  = session.targets.map(t => ({ uri: URI.parse(t.folderUri), label: t.label }));
				this._wizardPattern  = session.migrationPattern;
				this._wizardFirmware = session.firmwareConfig ?? { complianceFrameworks: [] };
				this.sessionService.endSession();
			}, 'font-size:10px;padding:3px 8px;margin-top:8px;');
			cfgSec.appendChild(cfgBtn);
			panel.appendChild(cfgSec);
		}

		// Workflow stages
		const wfSec = this._section('Workflow');
		const currentIdx = STAGES.indexOf(session.currentStage);

		for (const stage of STAGES) {
			const idx   = STAGES.indexOf(stage);
			const isCur = idx === currentIdx;
			const isDone = idx < currentIdx;
			// Stage 3 locked unless plan approved
			const isLocked = stage === 'migration' && !session.planApproved && currentIdx <= STAGES.indexOf('planning');

			const row = $e('div', [
				'display:flex', 'align-items:flex-start', 'gap:10px',
				'padding:8px 10px', 'border-radius:4px', 'margin-bottom:2px',
				isLocked ? 'cursor:default;opacity:0.45;' : 'cursor:pointer;',
				isCur
					? 'background:var(--vscode-list-activeSelectionBackground);border:1px solid var(--vscode-focusBorder,transparent);'
					: 'border:1px solid transparent;',
			].join(';'));

			const dot = $t('div', isDone ? '\u2713' : isLocked ? '\u{1F512}' : String(idx + 1), [
				'width:18px', 'height:18px', 'border-radius:50%', 'flex-shrink:0', 'margin-top:1px',
				'font-size:9px', 'font-weight:700',
				'display:flex', 'align-items:center', 'justify-content:center',
				isDone
					? 'background:var(--vscode-terminal-ansiGreen,#4caf50);color:var(--vscode-editor-background);'
					: isCur
						? 'background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);border:1.5px solid var(--vscode-focusBorder,var(--vscode-button-background));'
						: 'border:1.5px solid var(--vscode-descriptionForeground);color:var(--vscode-descriptionForeground);',
			].join(';'));
			row.appendChild(dot);

			const info = $e('div', 'flex:1;min-width:0;');
			info.appendChild($t('div', STAGE_LABELS[stage], [
				'font-size:12px',
				`font-weight:${isCur ? '600' : '400'}`,
				`color:${isCur ? 'var(--vscode-list-activeSelectionForeground)' : isDone ? 'var(--vscode-editor-foreground)' : 'var(--vscode-descriptionForeground)'}`,
			].join(';')));
			if (isCur) {
				info.appendChild($t('div', STAGE_DESCRIPTIONS[stage],
					'font-size:10px;color:var(--vscode-descriptionForeground);margin-top:3px;line-height:1.4;'));
			}
			if (isLocked) {
				info.appendChild($t('div', 'Requires plan approval',
					'font-size:10px;color:var(--vscode-inputValidation-warningBorder,#e0a84e);margin-top:2px;'));
			}
			row.appendChild(info);

			if (!isLocked) {
				row.addEventListener('click', () => this.sessionService.setStage(stage));
				row.addEventListener('mouseenter', () => { if (!isCur) { row.style.background = 'var(--vscode-list-hoverBackground)'; } });
				row.addEventListener('mouseleave', () => { if (!isCur) { row.style.background = 'transparent'; } });
			}
			wfSec.appendChild(row);
		}

		// Advance button (only if next stage is not locked)
		if (currentIdx < STAGES.length - 1) {
			const nextStage  = STAGES[currentIdx + 1];
			const nextLocked = nextStage === 'migration' && !session.planApproved;
			if (!nextLocked) {
				const advWrap = $e('div', 'margin-top:8px;');
				advWrap.appendChild(this._btn(
					`Advance to ${STAGE_LABELS[nextStage]} \u2192`, false,
					() => this.sessionService.setStage(nextStage),
				));
				wfSec.appendChild(advWrap);
			}
		}
		panel.appendChild(wfSec);

		// Session configuration \u2014 always visible at bottom of sidebar
		panel.appendChild($e('div', 'height:8px;border-top:1px solid var(--vscode-widget-border);margin-top:4px;'));
		panel.appendChild(this._buildConfigPanel(session));

		return panel;
	}

	// Right panel: stage-appropriate content
	private _buildCompliancePanel(session: IModernisationSessionData): HTMLElement {
		const panel = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;');

		if (session.currentStage === 'discovery') {
			panel.appendChild(this._buildDiscoveryPane(session));
		} else if (session.currentStage === 'planning') {
			panel.appendChild(this._buildPlanningPane(session));
		} else if (session.currentStage === 'migration') {
			panel.appendChild(this._buildMigrationPane(session));
		} else if (session.currentStage === 'validation') {
			panel.appendChild(this._buildValidationPane(session));
		} else if (session.currentStage === 'cutover') {
			panel.appendChild(this._buildCutoverPane(session));
		} else {
			// Fallback \u2014 should never reach here with a valid stage
			panel.appendChild(this._buildFilePickers(session));
			panel.appendChild(this._buildAnalyseRow());
			this._resultsEl = $e('div', 'flex:1;overflow-y:auto;padding:20px;');
			const hasFiles = session.activeSourceFileUri && session.activeTargetFileUri;
			this._resultsEl.appendChild($t('div',
				hasFiles ? 'Ready \u2014 click Analyse Compliance to run.' : 'Pick a file from each project then click Analyse Compliance.',
				'color:var(--vscode-descriptionForeground);font-style:italic;'));
			panel.appendChild(this._resultsEl);
		}

		return panel;
	}

	// \u2500\u2500\u2500 Discovery pane (Stage 1) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _buildDiscoveryPane(session: IModernisationSessionData): HTMLElement {
		const pane = $e('div', 'flex:1;overflow-y:auto;padding:24px 28px;');

		pane.appendChild($t('h3', 'Codebase Discovery',
			'font-size:15px;font-weight:700;color:var(--vscode-editor-foreground);margin:0 0 4px;'));
		pane.appendChild($t('p',
			'Scan all source and target projects to extract migration units, build dependency graphs, detect regulated data, and assess technical complexity before planning.',
			'font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.6;margin:0 0 20px;'));

		// Run button row
		const ctrlRow = $e('div', 'display:flex;align-items:center;gap:10px;margin-bottom:20px;flex-wrap:wrap;');
		const runBtn = this._btn(
			this._discoveryRunning
				? 'Scanning\u2026'
				: this._discoveryResult ? '\u21ba Re-run Discovery' : '\u25b6 Run Discovery Scan',
			!this._discoveryResult,
			async () => { await this._runDiscoveryScan(session); },
			'white-space:nowrap;',
		);
		if (this._discoveryRunning) {
			(runBtn as HTMLButtonElement).disabled = true;
			runBtn.style.opacity = '0.5';
			runBtn.style.cursor  = 'not-allowed';
		}
		ctrlRow.appendChild(runBtn);
		if (this._discoveryResult && !this._discoveryRunning) {
			ctrlRow.appendChild(this._btn('Advance to Planning \u2192', true,
				() => this.sessionService.setStage('planning'),
				'white-space:nowrap;'));
		}
		pane.appendChild(ctrlRow);

		// Progress log
		if (this._discoveryRunning || this._discoveryLog.length > 0) {
			const logWrap = $e('div', [
				'border:1px solid var(--vscode-widget-border)',
				'border-radius:5px', 'overflow:hidden', 'margin-bottom:20px',
			].join(';'));
			const logHdr = $e('div', [
				'padding:6px 12px',
				'background:var(--vscode-sideBarSectionHeader-background)',
				'border-bottom:1px solid var(--vscode-panel-border)',
				'display:flex', 'align-items:center', 'gap:8px',
			].join(';'));
			if (this._discoveryRunning) {
				logHdr.appendChild($t('span', '\u25cf', 'color:var(--vscode-terminal-ansiGreen,#4caf50);font-size:10px;'));
			}
			logHdr.appendChild($t('span', 'Scan Progress',
				'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-sideBarSectionHeader-foreground);'));
			logWrap.appendChild(logHdr);
			this._discoveryLogEl = $e('div', [
				'padding:10px 12px', 'font-family:var(--vscode-editor-font-family,monospace)',
				'font-size:11px', 'line-height:1.7',
				'color:var(--vscode-descriptionForeground)',
				'max-height:160px', 'overflow-y:auto',
			].join(';'));
			for (const line of this._discoveryLog) {
				this._discoveryLogEl.appendChild($t('div', line));
			}
			logWrap.appendChild(this._discoveryLogEl);
			pane.appendChild(logWrap);
		}

		// Results
		if (this._discoveryResult) {
			const r = this._discoveryResult;
			const allProjects     = [...r.sources, ...r.targets];
			const scannedProjects = allProjects.filter(p => p.fileCount > 0 || p.units.length > 0);
			const totalUnits   = allProjects.reduce((n, p) => n + p.units.length, 0);
			const totalFiles   = allProjects.reduce((n, p) => n + p.fileCount, 0);
			const totalHits    = allProjects.reduce((n, p) => n + p.regulatedDataHits.length, 0);
			const totalViol    = allProjects.reduce((n, p) => n + (p.grcSnapshot.violations?.length ?? 0), 0);
			const elapsedSec   = (r.totalElapsedMs / 1000).toFixed(1);

			// Summary bar
			const bar = $e('div', [
				'display:flex', 'flex-wrap:wrap', 'gap:10px',
				'padding:14px 16px', 'border-radius:6px', 'margin-bottom:16px',
				'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
				'border:1px solid var(--vscode-widget-border)',
			].join(';'));
			const stat = (label: string, value: string, accent?: string) => {
				const cell = $e('div', 'text-align:center;min-width:80px;');
				cell.appendChild($t('div', value, `font-size:22px;font-weight:700;line-height:1;color:${accent ?? 'var(--vscode-editor-foreground)'};`));
				cell.appendChild($t('div', label, 'font-size:10px;color:var(--vscode-descriptionForeground);margin-top:3px;'));
				return cell;
			};
			bar.appendChild(stat('Files', String(totalFiles)));
			bar.appendChild(this._divider());
			bar.appendChild(stat('Units', String(totalUnits)));
			bar.appendChild(this._divider());
			bar.appendChild(stat('Regulated Data', String(totalHits),
				totalHits > 0 ? 'var(--vscode-inputValidation-warningBorder,#e0a84e)' : undefined));
			bar.appendChild(this._divider());
			bar.appendChild(stat('GRC Violations', String(totalViol),
				totalViol > 0 ? 'var(--vscode-inputValidation-errorBorder,#f44336)' : undefined));
			bar.appendChild(this._divider());
			bar.appendChild(stat('Scan Time', `${elapsedSec}s`));
			pane.appendChild(bar);

			// Per-project cards
			const projWrap = $e('div', [
				'border:1px solid var(--vscode-widget-border)',
				'border-radius:6px', 'overflow:hidden',
			].join(';'));
			const projHdr = $e('div', [
				'padding:8px 13px',
				'background:var(--vscode-sideBarSectionHeader-background)',
				'border-bottom:1px solid var(--vscode-panel-border)',
			].join(';'));
			projHdr.appendChild($t('span', 'Projects Scanned',
				'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-sideBarSectionHeader-foreground);'));
			projWrap.appendChild(projHdr);

			const projBody = $e('div', 'padding:8px 12px;display:flex;flex-direction:column;gap:8px;');
			for (const proj of allProjects) {
				const isNewProject = proj.fileCount === 0 && proj.units.length === 0;
				const isTarget = r.targets.includes(proj);
				const card = $e('div', [
					'padding:10px 12px', 'border-radius:4px',
					isNewProject
						? 'background:var(--vscode-editor-background);border:1px dashed var(--vscode-widget-border);opacity:0.75;'
						: 'background:var(--vscode-input-background);border:1px solid var(--vscode-widget-border);',
				].join(';'));
				const cardTop = $e('div', 'display:flex;align-items:center;gap:8px;margin-bottom:6px;');
				const roleBadge = $t('span', isTarget ? 'TGT' : 'SRC', [
					'font-size:9px', 'font-weight:700', 'letter-spacing:0.06em',
					'background:var(--vscode-badge-background)',
					'color:var(--vscode-badge-foreground)',
					'border-radius:2px', 'padding:1px 5px', 'flex-shrink:0',
				].join(';'));
				cardTop.appendChild(roleBadge);
				cardTop.appendChild($t('span', proj.projectLabel,
					'font-size:12px;font-weight:600;color:var(--vscode-editor-foreground);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'));
				const langLabel = isNewProject ? 'New Project' : proj.dominantLanguage.toUpperCase();
				cardTop.appendChild($t('span', langLabel,
					'font-size:10px;color:var(--vscode-descriptionForeground);'));
				card.appendChild(cardTop);

				const chips = $e('div', 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;');
				const chip = (label: string, accent?: string) => $t('span', label, [
					'font-size:10px', 'padding:2px 7px', 'border-radius:10px',
					`background:${accent ? accent + '22' : 'var(--vscode-badge-background)'}`,
					`color:${accent ?? 'var(--vscode-badge-foreground)'}`,
					`border:1px solid ${accent ? accent + '55' : 'transparent'}`,
				].join(';'));

				if (isNewProject) {
					// Empty target \u2014 will be created during migration
					chips.appendChild($t('span',
						isTarget
							? '\u2014 Empty target directory. Will be populated during migration.'
							: '\u2014 Empty source directory.',
						'font-size:10px;color:var(--vscode-descriptionForeground);font-style:italic;'));
				} else {
					chips.appendChild(chip(`${proj.fileCount} files`));
					chips.appendChild(chip(`${proj.units.length} units`));
					if (proj.stats.totalUnitsExtracted > 0) {
						chips.appendChild(chip(`${proj.stats.criticalUnitCount} critical`, proj.stats.criticalUnitCount > 0 ? '#f44336' : undefined));
					}
					if (proj.regulatedDataHits.length > 0) {
						chips.appendChild(chip(`${proj.regulatedDataHits.length} regulated data hits`, '#e0a84e'));
					}
					if (proj.metadata.buildSystem) {
						chips.appendChild(chip(proj.metadata.buildSystem));
					}
				}
				card.appendChild(chips);
				projBody.appendChild(card);
			}
			projWrap.appendChild(projBody);
			pane.appendChild(projWrap);
			pane.appendChild($e('div', 'height:16px;'));

			// \u2500\u2500 Compliance Score Panel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
			// Show per-project GRC compliance scores derived from discovery snapshot.
			const projectsWithViolations = allProjects.filter(p =>
				(p.grcSnapshot?.totalViolations ?? 0) > 0,
			);
			if (projectsWithViolations.length > 0) {
				pane.appendChild(this._buildDiscoveryCompliancePanel(projectsWithViolations));
				pane.appendChild($e('div', 'height:16px;'));
			}

			// Advance banner
			const advBanner = $e('div', [
				'padding:14px 16px', 'border-radius:6px',
				'background:var(--vscode-inputValidation-infoBackground,rgba(100,150,250,0.07))',
				'border:1px solid var(--vscode-focusBorder,rgba(100,150,250,0.4))',
				'display:flex', 'align-items:center', 'gap:16px',
			].join(';'));
			const advText = $e('div', 'flex:1;');
			advText.appendChild($t('div', '\u2713  Discovery Complete',
				'font-size:13px;font-weight:700;color:var(--vscode-focusBorder,#6496fa);margin-bottom:4px;'));
			advText.appendChild($t('div',
				`Found ${totalUnits} migration units across ${scannedProjects.length} scanned project(s)${scannedProjects.length < allProjects.length ? ` (${allProjects.length - scannedProjects.length} new/empty target project(s) will be created during migration)` : ''}. Proceed to Planning to generate the AI-refined migration roadmap.`,
				'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5;'));
			advBanner.appendChild(advText);
			advBanner.appendChild(this._btn('Go to Planning \u2192', true,
				() => this.sessionService.setStage('planning'),
				'white-space:nowrap;flex-shrink:0;padding:7px 16px;font-size:13px;'));
			pane.appendChild(advBanner);
			pane.appendChild($e('div', 'height:20px;'));
		} else if (!this._discoveryRunning) {
			// Empty state
			const empty = $e('div', [
				'border:1px dashed var(--vscode-widget-border)',
				'border-radius:6px', 'padding:40px 20px', 'text-align:center',
			].join(';'));
			empty.appendChild($t('div', '\u{1F50D}', 'font-size:36px;margin-bottom:12px;opacity:0.25;'));
			empty.appendChild($t('div', 'No scan results yet.',
				'font-size:13px;font-weight:600;color:var(--vscode-editor-foreground);margin-bottom:6px;'));
			empty.appendChild($t('div',
				'Click "Run Discovery Scan" to analyse all source and target projects. Results will guide the AI migration planner in Stage 2.',
				'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.6;max-width:400px;margin:0 auto;'));
			pane.appendChild(empty);
		}

		return pane;
	}

	private async _runDiscoveryScan(session: IModernisationSessionData): Promise<void> {
		if (this._discoveryRunning) { return; }
		this._discoveryRunning = true;
		this._discoveryLog     = [];
		this._discoveryResult  = undefined;
		this._render();

		const log = (msg: string) => {
			this._discoveryLog.push(msg);
			if (this._discoveryLogEl) {
				this._discoveryLogEl.appendChild($t('div', msg));
				this._discoveryLogEl.scrollTop = this._discoveryLogEl.scrollHeight;
			}
		};

		try {
			const sub = this.discoveryService.onDidProgress(e => {
				log(`${e.phase}${e.currentFile ? ' \u2014 ' + e.currentFile : ''}${e.projectLabel ? ' (' + e.projectLabel + ')' : ''}`);
			});
			log('Starting discovery scan\u2026');
			const result = await this.discoveryService.scan(session.sources, session.targets);
			sub.dispose();
			const totalUnits = [...result.sources, ...result.targets].reduce((n, p) => n + p.units.length, 0);
			log(`\u2713 Scan complete \u2014 ${totalUnits} units in ${(result.totalElapsedMs / 1000).toFixed(1)}s`);
			this._discoveryResult = result;
			this._persistDiscovery();
			// Immediately seed KB so the console shows units without a page reload
			this._seedKBFromDiscovery(result);
			// Push merged GRC snapshot to the progress dashboard if console is open
			if (this._console) {
				const merged = mergeGRCSnapshots([
					...result.sources.map(p => p.grcSnapshot),
					...result.targets.map(p => p.grcSnapshot),
				]);
				this._console.setGRCSnapshot(merged);
			}
		} catch (err) {
			log(`\u2717 Error: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this._discoveryRunning = false;
			this._render();
		}
	}

	// \u2500\u2500\u2500 Planning pane \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _buildPlanningPane(session: IModernisationSessionData): HTMLElement {
		const pane = $e('div', 'flex:1;overflow-y:auto;padding:24px 28px;');

		// Title
		pane.appendChild($t('h3', 'Migration Planning Workspace',
			'font-size:15px;font-weight:700;color:var(--vscode-editor-foreground);margin:0 0 4px;'));
		pane.appendChild($t('p',
			'Scan the legacy codebase, generate an AI-refined migration roadmap, review every phase and blocker, then approve to unlock Stage 3.',
			'font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.6;margin:0 0 20px;'));

		// \u2500\u2500 Run / regenerate button \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const hasStage1 = !!this._discoveryResult;
		const ctrlRow = $e('div', 'display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap;');
		const runBtn = this._btn(
			this._plannerRunning
				? 'Generating\u2026'
				: this._roadmap
					? '\u21ba Regenerate Roadmap'
					: hasStage1
						? '\u25b6 Generate Roadmap'
						: '\u25b6 Run Discovery + Generate Roadmap',
			!this._roadmap,
			async () => { await this._runDiscoveryAndPlan(session, hasStage1 && !this._roadmap); },
			'white-space:nowrap;',
		);
		if (this._plannerRunning) {
			(runBtn as HTMLButtonElement).disabled = true;
			runBtn.style.opacity = '0.5';
			runBtn.style.cursor  = 'not-allowed';
		}
		ctrlRow.appendChild(runBtn);

		if (this._roadmap) {
			const methodBadge = $t('span',
				this._roadmap.generationMethod === 'ai-guided' ? '\u2728 AI-guided' : '\u2699 Deterministic',
				[
					'font-size:10px', 'border-radius:3px', 'padding:2px 8px',
					'border:1px solid var(--vscode-widget-border)',
					'color:var(--vscode-descriptionForeground)',
				].join(';'));
			ctrlRow.appendChild(methodBadge);
		}
		pane.appendChild(ctrlRow);

		// Stage 1 hint row
		if (!this._plannerRunning && !this._roadmap) {
			const hintRow = $e('div', 'display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap;');
			if (hasStage1) {
				const totalUnits = [...this._discoveryResult!.sources, ...this._discoveryResult!.targets]
					.reduce((n, p) => n + p.units.length, 0);
				hintRow.appendChild($t('span',
					`\u2713 Using Stage 1 results \u2014 ${totalUnits} units`,
					'font-size:10px;color:var(--vscode-terminal-ansiGreen,#4caf50);'));
				hintRow.appendChild(this._btn('Re-run with fresh discovery', false,
					async () => { await this._runDiscoveryAndPlan(session, false); },
					'font-size:10px;padding:2px 8px;opacity:0.7;'));
			} else {
				hintRow.appendChild($t('span',
					'Tip: complete Stage 1 Discovery first to speed this up.',
					'font-size:10px;color:var(--vscode-descriptionForeground);font-style:italic;'));
			}
			pane.appendChild(hintRow);
		} else {
			pane.appendChild($e('div', 'height:12px;'));
		}

		// \u2500\u2500 Progress log (visible while running, or if log has entries) \u2500\u2500
		if (this._plannerRunning || this._plannerLog.length > 0) {
			const logWrap = $e('div', [
				'border:1px solid var(--vscode-widget-border)',
				'border-radius:5px', 'overflow:hidden', 'margin-bottom:20px',
			].join(';'));
			const logHdr = $e('div', [
				'padding:6px 12px',
				'background:var(--vscode-sideBarSectionHeader-background)',
				'border-bottom:1px solid var(--vscode-panel-border)',
				'display:flex', 'align-items:center', 'gap:8px',
			].join(';'));
			if (this._plannerRunning) {
				logHdr.appendChild($t('span', '\u25cf', 'color:var(--vscode-terminal-ansiGreen,#4caf50);font-size:10px;'));
			}
			logHdr.appendChild($t('span', 'Progress',
				'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-sideBarSectionHeader-foreground);'));
			logWrap.appendChild(logHdr);

			this._plannerLogEl = $e('div', [
				'padding:10px 12px', 'font-family:var(--vscode-editor-font-family,monospace)',
				'font-size:11px', 'line-height:1.7',
				'color:var(--vscode-descriptionForeground)',
				'max-height:160px', 'overflow-y:auto',
			].join(';'));
			for (const line of this._plannerLog) {
				this._plannerLogEl.appendChild($t('div', line));
			}
			logWrap.appendChild(this._plannerLogEl);
			pane.appendChild(logWrap);
		}

		// \u2500\u2500 Roadmap content \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		if (this._roadmap) {
			// Summary stats bar
			pane.appendChild(this._buildRoadmapSummary(this._roadmap));
			pane.appendChild($e('div', 'height:16px;'));

			// Phases
			if (this._roadmap.phases && this._roadmap.phases.length > 0) {
				pane.appendChild(this._buildSection('Migration Phases', this._buildPhasesView(this._roadmap)));
				pane.appendChild($e('div', 'height:16px;'));
			}

			// Critical path
			if (this._roadmap.criticalPath && this._roadmap.criticalPath.length > 0) {
				pane.appendChild(this._buildSection('Critical Path', this._buildCriticalPathView(this._roadmap)));
				pane.appendChild($e('div', 'height:16px;'));
			}

			// Blockers
			if (this._roadmap.migrationBlockers && this._roadmap.migrationBlockers.length > 0) {
				pane.appendChild(this._buildSection('Migration Blockers', this._buildBlockersView(this._roadmap)));
				pane.appendChild($e('div', 'height:16px;'));
			}

			// AI notes
			if (this._roadmap.complianceNotes || this._roadmap.riskNarrative) {
				pane.appendChild(this._buildSection('AI Analysis Notes', this._buildAINotes(this._roadmap)));
				pane.appendChild($e('div', 'height:16px;'));
			}

			// Approve gate (or approved state)
			pane.appendChild(this._buildApprovalGate(session));
			pane.appendChild($e('div', 'height:20px;'));
		} else if (!this._plannerRunning) {
			// Empty state
			const empty = $e('div', [
				'border:1px dashed var(--vscode-widget-border)',
				'border-radius:6px', 'padding:40px 20px', 'text-align:center',
			].join(';'));
			empty.appendChild($t('div', '\u{1F5FA}', 'font-size:36px;margin-bottom:12px;opacity:0.25;'));
			empty.appendChild($t('div', 'No roadmap yet.',
				'font-size:13px;font-weight:600;color:var(--vscode-editor-foreground);margin-bottom:6px;'));
			empty.appendChild($t('div',
				'Click "Run Discovery + Generate Roadmap" above. The discovery engine will scan all source and target projects, then the AI planner will produce a structured migration roadmap for your review.',
				'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.6;max-width:400px;margin:0 auto;'));
			pane.appendChild(empty);
			pane.appendChild($e('div', 'height:20px;'));
		}

		return pane;
	}

	private async _runDiscoveryAndPlan(session: IModernisationSessionData, useExistingDiscovery = false): Promise<void> {
		if (this._plannerRunning) { return; }
		this._plannerRunning = true;
		this._plannerLog     = [];
		this._roadmap        = undefined;
		this._reRenderPlanningPane(session);

		const log = (msg: string) => {
			this._plannerLog.push(msg);
			if (this._plannerLogEl) {
				this._plannerLogEl.appendChild($t('div', msg));
				this._plannerLogEl.scrollTop = this._plannerLogEl.scrollHeight;
			}
		};

		try {
			let discovery = useExistingDiscovery && this._discoveryResult ? this._discoveryResult : undefined;

			if (discovery) {
				const totalUnits = [...discovery.sources, ...discovery.targets].reduce((n, p) => n + p.units.length, 0);
				log(`Using Stage 1 discovery results \u2014 ${totalUnits} units across ${discovery.sources.length + discovery.targets.length} project(s).`);
			} else {
				// Run discovery from scratch
				const discSub = this.discoveryService.onDidProgress(e => {
					log(`[discovery] ${e.phase}${e.currentFile ? ' \u2014 ' + e.currentFile : ''}${e.projectLabel ? ' (' + e.projectLabel + ')' : ''}`);
				});
				log('Running discovery\u2026');
				discovery = await this.discoveryService.scan(session.sources, session.targets);
				discSub.dispose();
				// Cache and persist for future use from Stage 2
				this._discoveryResult = discovery;
				this._persistDiscovery();
				const totalUnits = discovery.sources.reduce((n, s) => n + s.units.length, 0);
				log(`Discovery complete: ${discovery.sources.length} source project(s), ${totalUnits} units found.`);
			// Re-seed KB so any stale committed units get reset to pending
			this._seedKBFromDiscovery(discovery);
			}

			// Planner progress
			const planSub = this.plannerService.onDidProgress(msg => log(`[planner] ${msg}`));
			log('Generating migration roadmap\u2026');
			const roadmap = await this.plannerService.generateRoadmap(
				discovery,
				session.migrationPattern ?? 'custom',
				session.sources[0]?.id ?? 'session',
			);
			planSub.dispose();

			this._roadmap = roadmap;
			this._persistRoadmap();
			log(`\u2713 Roadmap complete \u2014 ${roadmap.totalUnits} units, ${roadmap.phases?.length ?? 0} phases.`);
		} catch (err) {
			log(`\u2717 Error: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this._plannerRunning = false;
			this._reRenderPlanningPane(session);
		}
	}

	/** Re-render only the right-panel pane without a full root re-render (avoids flicker). */
	private _reRenderPlanningPane(session: IModernisationSessionData): void {
		// Full re-render is safe here \u2014 the planning pane is stateful via class fields
		this._render();
	}

	// \u2500\u2500\u2500 Stage 3 + 4: Migration & Validation (parallel progress dashboard) \u2500\u2500\u2500\u2500\u2500\u2500

	private _buildMigrationPane(session: IModernisationSessionData): HTMLElement {
		return this._buildMigrationValidationDashboard(session, 'migration');
	}

	private _buildValidationPane(session: IModernisationSessionData): HTMLElement {
		return this._buildMigrationValidationDashboard(session, 'validation');
	}

	/**
	 * Shared dashboard shown for both Stage 3 and Stage 4.
	 * Renders the 4-tab ModernisationConsole (Unit Index, Pending Decisions,
	 * Decision Log, Progress) \u2014 or a plan-not-approved guard if needed.
	 */
	private _buildMigrationValidationDashboard(session: IModernisationSessionData, _activeView: 'migration' | 'validation'): HTMLElement {
		const pane = $e('div', 'flex:1;overflow:hidden;display:flex;flex-direction:column;');

		// \u2500\u2500 Plan not approved guard \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		if (!session.planApproved) {
			const warn = $e('div', [
				'padding:14px 16px', 'border-radius:6px',
				'background:var(--vscode-inputValidation-warningBackground,rgba(224,168,78,0.07))',
				'border:1px solid var(--vscode-inputValidation-warningBorder,rgba(224,168,78,0.4))',
				'display:flex', 'align-items:center', 'gap:12px',
			].join(';'));
			warn.appendChild($t('span', '\u26a0', 'font-size:18px;color:#e0a84e;flex-shrink:0;'));
			const warnText = $e('div', 'flex:1;');
			warnText.appendChild($t('div', 'Migration is locked',
				'font-size:13px;font-weight:700;color:#e0a84e;margin-bottom:3px;'));
			warnText.appendChild($t('div', 'Approve the migration plan in Stage 2 to unlock this stage.',
				'font-size:11px;color:var(--vscode-descriptionForeground);'));
			warn.appendChild(warnText);
			warn.appendChild(this._btn('Go to Planning \u2192', false,
				() => this.sessionService.setStage('planning'),
				'white-space:nowrap;flex-shrink:0;padding:6px 14px;font-size:12px;'));
			pane.appendChild(warn);
			return pane;
		}

		// \u2500\u2500 4-tab Modernisation Console \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		// Create once and reuse across re-renders to preserve filter/tab state
		if (!this._console) {
			const mergedSnapshot = this._discoveryResult
				? mergeGRCSnapshots([
						...this._discoveryResult.sources.map(p => p.grcSnapshot),
						...this._discoveryResult.targets.map(p => p.grcSnapshot),
					])
				: undefined;
			this._console = new ModernisationConsole(
				this.kbService, this.agentToolsService,
				this.validationService, this.cutoverService, this.autonomyService,
				// onResyncDiscovery: re-sync KB statuses when user clicks Refresh
				() => { if (this._discoveryResult) { this._seedKBFromDiscovery(this._discoveryResult); } },
				mergedSnapshot,
			);
		}
		pane.appendChild(this._console.domNode);
		return pane;

	}

	// \u2500\u2500\u2500 Stage 5: Cutover pane \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _buildCutoverPane(_session: IModernisationSessionData): HTMLElement {
		const pane = $e('div', 'flex:1;overflow-y:auto;padding:24px 28px;');

		pane.appendChild($t('h3', 'Cutover',
			'font-size:15px;font-weight:700;color:var(--vscode-editor-foreground);margin:0 0 4px;'));
		pane.appendChild($t('p',
			'Final steps to switch production traffic to the modernised system. Complete each item before ending the session.',
			'font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.6;margin:0 0 20px;'));

		const items = [
			'All migration units marked pass or warning-accepted',
			'Validation scan shows no new critical GRC violations',
			'CI/CD pipeline updated to point at target project',
			'Compliance officer sign-off on regulated data handling',
			'Rollback plan documented and tested',
			'Monitoring and alerting configured for target system',
		];

		const checklist = $e('div', [
			'border:1px solid var(--vscode-widget-border)',
			'border-radius:6px', 'overflow:hidden', 'margin-bottom:20px',
		].join(';'));
		const clHdr = $e('div', [
			'padding:8px 13px',
			'background:var(--vscode-sideBarSectionHeader-background)',
			'border-bottom:1px solid var(--vscode-panel-border)',
		].join(';'));
		clHdr.appendChild($t('span', 'Pre-Cutover Checklist',
			'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-sideBarSectionHeader-foreground);'));
		checklist.appendChild(clHdr);

		const clBody = $e('div', 'padding:8px 12px;display:flex;flex-direction:column;gap:4px;');
		for (const item of items) {
			const row = $e('div', [
				'display:flex', 'align-items:flex-start', 'gap:8px',
				'padding:7px 10px', 'border-radius:4px',
				'background:var(--vscode-input-background)',
				'border:1px solid var(--vscode-widget-border)',
			].join(';'));
			row.appendChild($t('span', '\u25a1',
				'font-size:12px;color:var(--vscode-descriptionForeground);flex-shrink:0;margin-top:1px;'));
			row.appendChild($t('span', item,
				'font-size:11px;color:var(--vscode-editor-foreground);line-height:1.5;'));
			clBody.appendChild(row);
		}
		checklist.appendChild(clBody);
		pane.appendChild(checklist);

		// Summary from roadmap (if available)
		if (this._roadmap) {
			const summary = $e('div', [
				'padding:12px 16px', 'border-radius:6px', 'margin-bottom:16px',
				'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
				'border:1px solid var(--vscode-widget-border)',
			].join(';'));
			summary.appendChild($t('div', 'Session Summary',
				'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-descriptionForeground);margin-bottom:8px;'));
			const summaryGrid = $e('div', 'display:flex;gap:20px;flex-wrap:wrap;');
			const sCell = (label: string, value: string) => {
				const c = $e('div', '');
				c.appendChild($t('div', value, 'font-size:18px;font-weight:700;color:var(--vscode-editor-foreground);line-height:1;'));
				c.appendChild($t('div', label, 'font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px;'));
				return c;
			};
			summaryGrid.appendChild(sCell('Total Units', String(this._roadmap.totalUnits)));
			summaryGrid.appendChild(sCell('Phases', String(this._roadmap.phases?.length ?? 0)));
			if (this._roadmap.estimatedHoursLow && this._roadmap.estimatedHoursHigh) {
				summaryGrid.appendChild(sCell('Est. Hours', `${this._roadmap.estimatedHoursLow}\u2013${this._roadmap.estimatedHoursHigh}`));
			}
			summary.appendChild(summaryGrid);
			pane.appendChild(summary);
		}

		// End session CTA row
		const endRow = $e('div', 'display:flex;justify-content:space-between;align-items:center;gap:10px;');
		endRow.appendChild($t('span',
			'Complete all checklist items before ending the session.',
			'font-size:11px;color:var(--vscode-descriptionForeground);font-style:italic;flex:1;'));
		endRow.appendChild(this._btn('End Session', false,
			() => this.sessionService.endSession(),
			'padding:8px 20px;font-size:13px;'));
		pane.appendChild(endRow);

		return pane;
	}

	// \u2500\u2500\u2500 Roadmap sub-views \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _buildRoadmapSummary(roadmap: IMigrationRoadmap): HTMLElement {
		const bar = $e('div', [
			'display:flex', 'flex-wrap:wrap', 'gap:10px',
			'padding:14px 16px', 'border-radius:6px',
			'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
			'border:1px solid var(--vscode-widget-border)',
		].join(';'));

		const stat = (label: string, value: string, accent?: string) => {
			const cell = $e('div', 'text-align:center;min-width:80px;');
			cell.appendChild($t('div', value, `font-size:22px;font-weight:700;line-height:1;color:${accent ?? 'var(--vscode-editor-foreground)'};`));
			cell.appendChild($t('div', label, 'font-size:10px;color:var(--vscode-descriptionForeground);margin-top:3px;'));
			return cell;
		};

		bar.appendChild(stat('Units', String(roadmap.totalUnits)));
		bar.appendChild(this._divider());
		bar.appendChild(stat('Phases', String(roadmap.phases?.length ?? 0)));
		bar.appendChild(this._divider());
		bar.appendChild(stat('Critical Path', String(roadmap.criticalPath?.length ?? 0),
			'var(--vscode-inputValidation-warningBorder,#e0a84e)'));
		bar.appendChild(this._divider());

		const blockingCount = roadmap.migrationBlockers?.filter(b => b.severity === 'blocking').length ?? 0;
		bar.appendChild(stat('Blockers',
			String(blockingCount),
			blockingCount > 0 ? 'var(--vscode-inputValidation-errorBorder,#f44336)' : 'var(--vscode-editor-foreground)'));
		bar.appendChild(this._divider());

		const effortLow  = roadmap.estimatedHoursLow  ?? 0;
		const effortHigh = roadmap.estimatedHoursHigh ?? 0;
		bar.appendChild(stat('Est. Effort', effortHigh > 0 ? `${effortLow}\u2013${effortHigh}h` : '\u2014'));

		if (roadmap.aiEstimatedEffort) {
			bar.appendChild(this._divider());
			bar.appendChild(stat('AI Effort Band', roadmap.aiEstimatedEffort.toUpperCase(),
				'var(--vscode-button-background)'));
		}

		return bar;
	}

	private _buildPhasesView(roadmap: IMigrationRoadmap): HTMLElement {
		const container = $e('div', 'display:flex;flex-direction:column;gap:6px;');

		for (const phase of roadmap.phases ?? []) {
			const blockingHere = roadmap.migrationBlockers?.filter(b => b.resolveByPhaseIndex === phase.index && b.severity === 'blocking').length ?? 0;

			// Collapsible phase card
			const card = $e('div', [
				'border:1px solid var(--vscode-widget-border)',
				'border-radius:5px', 'overflow:hidden',
			].join(';'));

			const hdr = $e('div', [
				'display:flex', 'align-items:center', 'gap:10px',
				'padding:9px 13px', 'cursor:pointer',
				'background:var(--vscode-sideBarSectionHeader-background)',
				'user-select:none',
			].join(';'));

			// Phase index badge
			hdr.appendChild($t('span', `P${phase.index}`, [
				'font-size:9px', 'font-weight:700', 'padding:1px 5px',
				'border-radius:2px', 'flex-shrink:0',
				'background:var(--vscode-badge-background)',
				'color:var(--vscode-badge-foreground)',
			].join(';')));

			hdr.appendChild($t('span', phase.label,
				'font-size:12px;font-weight:600;flex:1;color:var(--vscode-editor-foreground);'));

			// Unit count
			hdr.appendChild($t('span', `${phase.unitIds.length} units`,
				'font-size:10px;color:var(--vscode-descriptionForeground);'));
			// Effort
			hdr.appendChild($t('span', `${phase.estimatedHoursLow}\u2013${phase.estimatedHoursHigh}h`,
				'font-size:10px;color:var(--vscode-descriptionForeground);'));

			// Gate badges
			if (phase.hasComplianceGate) {
				hdr.appendChild($t('span', '\u26a0 Compliance Gate', [
					'font-size:9px', 'padding:1px 5px', 'border-radius:2px',
					'background:rgba(224,168,78,0.15)',
					'color:var(--vscode-inputValidation-warningBorder,#e0a84e)',
					'border:1px solid var(--vscode-inputValidation-warningBorder,rgba(224,168,78,0.4))',
				].join(';')));
			}
			if (phase.hasAPICompatibilityGate) {
				hdr.appendChild($t('span', '\u{1F517} API Gate', [
					'font-size:9px', 'padding:1px 5px', 'border-radius:2px',
					'background:rgba(100,150,250,0.1)',
					'color:var(--vscode-focusBorder,#6496fa)',
					'border:1px solid var(--vscode-focusBorder,rgba(100,150,250,0.4))',
				].join(';')));
			}
			if (blockingHere > 0) {
				hdr.appendChild($t('span', `\u2715 ${blockingHere} blocking`, [
					'font-size:9px', 'padding:1px 5px', 'border-radius:2px',
					'background:rgba(244,67,54,0.1)',
					'color:var(--vscode-inputValidation-errorBorder,#f44336)',
					'border:1px solid rgba(244,67,54,0.3)',
				].join(';')));
			}

			const chevron = $t('span', '\u203a', 'font-size:14px;color:var(--vscode-descriptionForeground);transition:transform 0.15s;display:inline-block;');
			hdr.appendChild(chevron);
			card.appendChild(hdr);

			// Collapsible body
			const body = $e('div', 'padding:12px 14px;display:none;');

			// Description
			body.appendChild($t('div', phase.description,
				'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5;margin-bottom:10px;'));

			// Risk distribution chips
			const riskRow = $e('div', 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;');
			const riskColors: Record<MigrationRiskLevel, string> = {
				critical: '#f44336', high: '#e0a84e', medium: '#64b5f6', low: '#81c784',
			};
			for (const level of ['critical', 'high', 'medium', 'low'] as MigrationRiskLevel[]) {
				const count = phase.riskDistribution[level];
				if (count === 0) { continue; }
				riskRow.appendChild($t('span', `${count} ${level}`, [
					'font-size:10px', 'padding:2px 7px', 'border-radius:10px',
					`background:${riskColors[level]}22`,
					`color:${riskColors[level]}`,
					`border:1px solid ${riskColors[level]}55`,
				].join(';')));
			}
			body.appendChild(riskRow);

			// Compliance notes
			if (phase.complianceNotes) {
				const note = $e('div', [
					'padding:8px 10px', 'border-radius:4px', 'margin-bottom:10px',
					'background:rgba(224,168,78,0.07)',
					'border-left:3px solid var(--vscode-inputValidation-warningBorder,#e0a84e)',
				].join(';'));
				note.appendChild($t('div', phase.complianceNotes,
					'font-size:11px;color:var(--vscode-editor-foreground);line-height:1.5;'));
				body.appendChild(note);
			}

			card.appendChild(body);

			// Toggle expand
			let expanded = false;
			hdr.addEventListener('click', () => {
				expanded = !expanded;
				body.style.display = expanded ? 'block' : 'none';
				chevron.style.transform = expanded ? 'rotate(90deg)' : '';
			});

			container.appendChild(card);
		}

		return container;
	}

	private _buildCriticalPathView(roadmap: IMigrationRoadmap): HTMLElement {
		const container = $e('div', '');
		const nodes = (roadmap.criticalPath ?? []).slice(0, 20);

		const table = $e('div', 'display:grid;grid-template-columns:1fr auto auto auto;gap:0;');

		// Header
		for (const h of ['Unit', 'Phase', 'Effort', 'Slack']) {
			table.appendChild($t('div', h, [
				'font-size:10px', 'font-weight:700', 'text-transform:uppercase',
				'letter-spacing:0.06em', 'padding:5px 8px',
				'color:var(--vscode-descriptionForeground)',
				'border-bottom:1px solid var(--vscode-widget-border)',
			].join(';')));
		}

		for (const node of nodes) {
			const rowCss = 'padding:6px 8px;border-bottom:1px solid var(--vscode-widget-border,rgba(0,0,0,0.05));font-size:11px;';
			const nameCss = rowCss + 'color:var(--vscode-editor-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
			const nameEl = $t('div', node.unitName, nameCss);
			nameEl.title = node.unitName;
			table.appendChild(nameEl);
			table.appendChild($t('div', node.phaseType, rowCss + 'color:var(--vscode-descriptionForeground);'));
			table.appendChild($t('div', `${node.effortHoursHigh}h`, rowCss + 'color:var(--vscode-editor-foreground);text-align:right;'));
			table.appendChild($t('div', `${node.slack}h`, rowCss + (node.slack === 0 ? 'color:var(--vscode-inputValidation-errorBorder,#f44336);font-weight:600;' : 'color:var(--vscode-descriptionForeground);') + 'text-align:right;'));
		}

		container.appendChild(table);

		if ((roadmap.criticalPath?.length ?? 0) > 20) {
			container.appendChild($t('div',
				`\u2026 and ${(roadmap.criticalPath!.length) - 20} more zero-slack units`,
				'font-size:10px;color:var(--vscode-descriptionForeground);padding:6px 8px;'));
		}
		return container;
	}

	private _buildBlockersView(roadmap: IMigrationRoadmap): HTMLElement {
		const container = $e('div', 'display:flex;flex-direction:column;gap:6px;');
		const blockers = roadmap.migrationBlockers ?? [];
		const blocking = blockers.filter(b => b.severity === 'blocking');
		const warnings = blockers.filter(b => b.severity === 'warning');

		// \u2500\u2500 Market Vertical Constraint Callouts \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const VERTICAL_BLOCKER_TYPES: Array<{
			types: string[];
			icon: string;
			label: string;
			detail: string;
			color: string;
		}> = [
			{
				types: ['goose-protection-relay'],
				icon: '\u26a1',
				label: 'IEC 61850 GOOSE Protection Path',
				detail: 'Protection relay trip paths must remain on native IEC 61850 GOOSE. Bridging to OPC-UA or MQTT cannot meet the < 4 ms Class P5/P6 latency requirement. Retain native GOOSE for all protection trip paths.',
				color: '#f44336',
			},
			{
				types: ['asil-decomposition-break', 'e2e-protection-gap'],
				icon: '\u{1F697}',
				label: 'AUTOSAR / ISO 26262 Integrity',
				detail: 'ASIL decomposition must be maintained across the CP \u2192 AP migration. All Rte_Read/Rte_Write signals require matching E2E profiles (CRC + counter) in the ara::com manifest per AUTOSAR SWS_E2ELibrary §7.3.',
				color: '#e0a84e',
			},
			{
				types: ['sis-sil-downgrade'],
				icon: '\u{1F6E2}',
				label: 'IEC 61511 SIL Verification',
				detail: 'SIS / ESD function blocks must maintain their SIL rating after modernisation. A SIL verification calculation is required per IEC 61511-1 §11 before cutover.',
				color: '#e0a84e',
			},
			{
				types: ['security-key-material'],
				icon: '\u{1F4F6}',
				label: '3GPP / GSMA Key Material',
				detail: 'All kNAS / kRRC / kAMF key arrays must be externalised to an HSM or TEE. No key derivation material may appear in source code or configuration files per 3GPP TS 33.501 §6.2.',
				color: '#f44336',
			},
			{
				types: ['ttcn3-verdict-suppression'],
				icon: '\u{1F4E1}',
				label: 'TTCN-3 Verdict Traceability',
				detail: 'Every INCONC verdict in the source TTCN-3 suite must map to an explicit pytest.skip() or Robot Framework SKIP with a documented 3GPP TS clause reference per GSMA PRD FS.13.',
				color: '#e0a84e',
			},
			{
				types: ['dnp3-secure-auth-gap'],
				icon: '\u{1F3ED}',
				label: 'IEC 62443 OT Zone / Conduit',
				detail: 'All OT-to-IT data flows must pass through a documented IEC 62443-3-3 Security Level conduit (IDMZ or unidirectional data diode). Direct OT-to-cloud paths without conduit control are prohibited.',
				color: '#e0a84e',
			},
		];

		const activeVerticals = VERTICAL_BLOCKER_TYPES.filter(v =>
			v.types.some(t => blockers.some(b => b.blockerType === t)),
		);

		if (activeVerticals.length > 0) {
			const callout = $e('div', [
				'border-radius:5px', 'overflow:hidden',
				'border:1px solid var(--vscode-widget-border)',
				'margin-bottom:4px',
			].join(';'));
			const calloutHdr = $e('div', [
				'padding:7px 11px',
				'background:rgba(100,150,250,0.07)',
				'border-bottom:1px solid var(--vscode-widget-border)',
				'display:flex', 'align-items:center', 'gap:8px',
			].join(';'));
			calloutHdr.appendChild($t('span', '\u26a0', 'font-size:13px;color:var(--vscode-focusBorder,#6496fa);'));
			calloutHdr.appendChild($t('span', 'Market Vertical Constraints Detected', [
				'font-size:11px', 'font-weight:700',
				'color:var(--vscode-focusBorder,#6496fa)',
			].join(';')));
			callout.appendChild(calloutHdr);

			const calloutBody = $e('div', 'padding:8px 11px;display:flex;flex-direction:column;gap:6px;');
			for (const v of activeVerticals) {
				const row = $e('div', 'display:flex;gap:8px;align-items:flex-start;');
				row.appendChild($t('span', v.icon, `font-size:14px;flex-shrink:0;margin-top:1px;color:${v.color};`));
				const rowText = $e('div', 'flex:1;');
				rowText.appendChild($t('div', v.label, `font-size:11px;font-weight:700;color:${v.color};margin-bottom:2px;`));
				rowText.appendChild($t('div', v.detail,
					'font-size:10px;color:var(--vscode-editor-foreground);line-height:1.5;'));
				row.appendChild(rowText);
				calloutBody.appendChild(row);
			}
			callout.appendChild(calloutBody);
			container.appendChild(callout);
		}

		const renderGroup = (items: typeof blockers, color: string, label: string) => {
			if (items.length === 0) { return; }
			container.appendChild($t('div', `${label} (${items.length})`, [
				'font-size:10px', 'font-weight:700', 'text-transform:uppercase',
				'letter-spacing:0.06em', `color:${color}`, 'margin-top:4px',
			].join(';')));

			for (const b of items) {
				const card = $e('div', [
					'border:1px solid var(--vscode-widget-border)',
					'border-radius:4px', 'overflow:hidden', 'margin-bottom:4px',
				].join(';'));

				const hdr = $e('div', [
					'display:flex', 'align-items:center', 'gap:8px',
					'padding:7px 11px', 'cursor:pointer',
					'background:var(--vscode-input-background)',
					'user-select:none',
				].join(';'));

				hdr.appendChild($t('span', b.blockerType.replace(/-/g, ' '), [
					'font-size:9px', 'font-weight:700', 'text-transform:uppercase',
					'letter-spacing:0.05em', 'padding:1px 5px', 'border-radius:2px', 'flex-shrink:0',
					`background:${color}18`, `color:${color}`,
					`border:1px solid ${color}44`,
				].join(';')));
				hdr.appendChild($t('span', b.title,
					'font-size:12px;font-weight:500;flex:1;color:var(--vscode-editor-foreground);'));
				hdr.appendChild($t('span', `resolve by phase ${b.resolveByPhaseIndex}`,
					'font-size:10px;color:var(--vscode-descriptionForeground);white-space:nowrap;'));
				const ch = $t('span', '\u203a', 'font-size:14px;color:var(--vscode-descriptionForeground);display:inline-block;');
				hdr.appendChild(ch);
				card.appendChild(hdr);

				const body = $e('div', 'padding:10px 12px;display:none;');
				body.appendChild($t('div', b.description,
					'font-size:11px;color:var(--vscode-editor-foreground);line-height:1.5;margin-bottom:8px;'));
				const actionWrap = $e('div', [
					'padding:8px 10px', 'border-radius:3px',
					'background:var(--vscode-textBlockQuote-background,rgba(100,100,100,0.1))',
					'border-left:3px solid var(--vscode-button-background)',
				].join(';'));
				actionWrap.appendChild($t('div', '\u{1F527} Recommended Action',
					'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-button-background);margin-bottom:4px;'));
				actionWrap.appendChild($t('div', b.recommendedAction,
					'font-size:11px;line-height:1.5;color:var(--vscode-editor-foreground);'));
				body.appendChild(actionWrap);
				card.appendChild(body);

				let open = false;
				hdr.addEventListener('click', () => {
					open = !open;
					body.style.display = open ? 'block' : 'none';
					ch.style.transform = open ? 'rotate(90deg)' : '';
				});
				container.appendChild(card);
			}
		};

		renderGroup(blocking, 'var(--vscode-inputValidation-errorBorder,#f44336)', 'Blocking');
		renderGroup(warnings,  'var(--vscode-inputValidation-warningBorder,#e0a84e)', 'Warnings');

		return container;
	}

	private _buildAINotes(roadmap: IMigrationRoadmap): HTMLElement {
		const container = $e('div', 'display:flex;flex-direction:column;gap:10px;');

		if (roadmap.riskNarrative) {
			const block = $e('div', [
				'padding:10px 12px', 'border-radius:4px',
				'background:rgba(244,67,54,0.05)',
				'border-left:3px solid var(--vscode-inputValidation-errorBorder,#f44336)',
			].join(';'));
			block.appendChild($t('div', '\u26a0 Risk Narrative',
				'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-inputValidation-errorBorder,#f44336);margin-bottom:5px;'));
			block.appendChild($t('div', roadmap.riskNarrative,
				'font-size:12px;line-height:1.6;color:var(--vscode-editor-foreground);'));
			container.appendChild(block);
		}

		if (roadmap.complianceNotes) {
			const block = $e('div', [
				'padding:10px 12px', 'border-radius:4px',
				'background:rgba(224,168,78,0.05)',
				'border-left:3px solid var(--vscode-inputValidation-warningBorder,#e0a84e)',
			].join(';'));
			block.appendChild($t('div', '\u{1F4CB} Compliance Notes',
				'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-inputValidation-warningBorder,#e0a84e);margin-bottom:5px;'));
			block.appendChild($t('div', roadmap.complianceNotes,
				'font-size:12px;line-height:1.6;color:var(--vscode-editor-foreground);'));
			container.appendChild(block);
		}

		return container;
	}

	private _buildApprovalGate(session: IModernisationSessionData): HTMLElement {
		if (session.planApproved) {
			// Already approved \u2014 show status + navigation
			const banner = $e('div', [
				'padding:14px 16px', 'border-radius:6px',
				'background:var(--vscode-inputValidation-infoBackground,rgba(100,200,100,0.07))',
				'border:1px solid rgba(100,200,100,0.4)',
				'display:flex', 'align-items:center', 'gap:16px',
			].join(';'));
			const text = $e('div', 'flex:1;');
			text.appendChild($t('div', '\u2713  Plan Approved',
				'font-size:13px;font-weight:700;color:rgba(100,200,100,1);margin-bottom:4px;'));
			text.appendChild($t('div',
				'This migration plan has been approved. Stage 3 (Migration) is unlocked.',
				'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5;'));
			banner.appendChild(text);
			banner.appendChild(this._btn('Go to Migration \u2192', true,
				() => this.sessionService.setStage('migration'),
				'white-space:nowrap;flex-shrink:0;padding:7px 16px;font-size:13px;'));
			return banner;
		}

		// Not yet approved
		const banner = $e('div', [
			'padding:14px 16px', 'border-radius:6px',
			'background:var(--vscode-inputValidation-warningBackground,rgba(224,168,78,0.07))',
			'border:1px solid var(--vscode-inputValidation-warningBorder,rgba(224,168,78,0.4))',
			'display:flex', 'align-items:center', 'gap:16px',
		].join(';'));
		const text = $e('div', 'flex:1;');
		text.appendChild($t('div', '\u26a0  Awaiting Plan Approval',
			'font-size:13px;font-weight:700;color:var(--vscode-inputValidation-warningBorder,#e0a84e);margin-bottom:4px;'));
		text.appendChild($t('div',
			'Review all phases and blockers above. Once you approve, Stage 3 (Migration) will unlock and translation can begin.',
			'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5;'));
		banner.appendChild(text);
		banner.appendChild(this._btn('Approve Plan \u2192', true, () => {
			this.sessionService.approvePlan();
			this.sessionService.setStage('migration');
		}, 'white-space:nowrap;flex-shrink:0;padding:7px 16px;font-size:13px;'));
		return banner;
	}

	// \u2500\u2500\u2500 Helpers shared by planning view \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _buildSection(title: string, content: HTMLElement): HTMLElement {
		const wrap = $e('div', [
			'border:1px solid var(--vscode-widget-border)',
			'border-radius:6px', 'overflow:hidden',
		].join(';'));
		const hdr = $e('div', [
			'padding:8px 13px',
			'background:var(--vscode-sideBarSectionHeader-background)',
			'border-bottom:1px solid var(--vscode-panel-border)',
		].join(';'));
		hdr.appendChild($t('span', title,
			'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-sideBarSectionHeader-foreground);'));
		wrap.appendChild(hdr);
		content.style.cssText += ';padding:12px;';
		wrap.appendChild(content);
		return wrap;
	}

	private _divider(): HTMLElement {
		return $e('div', 'width:1px;background:var(--vscode-widget-border);align-self:stretch;margin:4px 0;');
	}

	// In-console reconfiguration
	private _buildConfigPanel(session: IModernisationSessionData): HTMLElement {
		const sec = $e('div', [
			'border:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
			'border-radius:6px', 'overflow:hidden',
		].join(';'));
		const hdr = $e('div', [
			'padding:10px 14px',
			'background:var(--vscode-sideBarSectionHeader-background)',
			'border-bottom:1px solid var(--vscode-panel-border)',
		].join(';'));
		hdr.appendChild($t('span', 'Session Configuration',
			'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-sideBarSectionHeader-foreground);'));
		sec.appendChild(hdr);

		const body = $e('div', 'padding:14px;display:flex;flex-direction:column;gap:10px;');

		// Migration pattern selector
		const row1 = $e('div', 'display:flex;align-items:center;gap:10px;');
		row1.appendChild($t('span', 'Migration Pattern',
			'font-size:12px;color:var(--vscode-editor-foreground);min-width:140px;'));
		const select = $e('select', [
			'flex:1', 'padding:4px 8px',
			'background:var(--vscode-input-background)',
			'color:var(--vscode-input-foreground)',
			'border:1px solid var(--vscode-input-border,var(--vscode-widget-border))',
			'border-radius:3px', 'font-size:12px', 'font-family:inherit',
		].join(';'));
		const patterns: MigrationPattern[] = MIGRATION_PATTERN_PRESETS.map(p => p.id);
		for (const p of patterns) {
			const opt = $t('option', MIGRATION_PATTERN_LABELS[p]);
			opt.value = p;
			if (p === session.migrationPattern) { (opt as HTMLOptionElement).selected = true; }
			select.appendChild(opt);
		}
		select.addEventListener('change', () => {
			this.sessionService.setMigrationPattern((select as HTMLSelectElement).value as MigrationPattern);
		});
		row1.appendChild(select);
		body.appendChild(row1);

		// Stage reset
		const row2 = $e('div', 'display:flex;align-items:center;gap:10px;');
		row2.appendChild($t('span', 'Current Stage',
			'font-size:12px;color:var(--vscode-editor-foreground);min-width:140px;'));
		const stageSelect = $e('select', [
			'flex:1', 'padding:4px 8px',
			'background:var(--vscode-input-background)',
			'color:var(--vscode-input-foreground)',
			'border:1px solid var(--vscode-input-border,var(--vscode-widget-border))',
			'border-radius:3px', 'font-size:12px', 'font-family:inherit',
		].join(';'));
		for (const s of STAGES) {
			const opt = $t('option', STAGE_LABELS[s]);
			opt.value = s;
			if (s === session.currentStage) { (opt as HTMLOptionElement).selected = true; }
			stageSelect.appendChild(opt);
		}
		stageSelect.addEventListener('change', () => {
			this.sessionService.setStage((stageSelect as HTMLSelectElement).value as ModernisationStage);
		});
		row2.appendChild(stageSelect);
		body.appendChild(row2);

		sec.appendChild(body);
		return sec;
	}

	private _buildFilePickers(session: IModernisationSessionData): HTMLElement {
		const row = $e('div', 'display:flex;border-bottom:1px solid var(--vscode-panel-border,var(--vscode-widget-border));flex-shrink:0;');
		// Use first source and first target for file-level compliance analysis
		const src = session.sources[0];
		const tgt = session.targets[0];
		row.appendChild(this._filePicker('SOURCE', src?.folderUri, session.activeSourceFileUri, 'source'));
		row.appendChild($e('div', 'width:1px;background:var(--vscode-panel-border,var(--vscode-widget-border));flex-shrink:0;'));
		row.appendChild(this._filePicker('TARGET', tgt?.folderUri, session.activeTargetFileUri, 'target'));
		return row;
	}

	private _filePicker(label: string, folderUri: string | undefined, fileUri: string | undefined, side: 'source' | 'target'): HTMLElement {
		const pane = $e('div', 'flex:1;padding:12px 16px;min-width:0;');
		pane.appendChild($t('div', label,
			'font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--vscode-descriptionForeground);margin-bottom:8px;'));
		const folder = $t('div', folderUri ? this._basename(folderUri) : 'No project',
			'font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
		folder.title = folderUri ?? '';
		pane.appendChild(folder);
		const fileRow = $e('div', 'display:flex;align-items:center;gap:6px;');
		const fname = $t('span', fileUri ? this._basename(fileUri) : 'No file selected',
			'font-size:11px;color:var(--vscode-descriptionForeground);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
		fname.title = fileUri ?? '';
		fileRow.appendChild(fname);
		fileRow.appendChild(this._btn('Pick', false, async () => {
			const defaultUri = folderUri ? URI.parse(folderUri) : undefined;
			const uris = await this.fileDialogService.showOpenDialog({
				title: `Select ${label} Source File`, defaultUri,
				canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
			});
			if (!uris?.[0]) { return; }
			const cur = this.sessionService.session;
			this.sessionService.setFilePair(
				side === 'source' ? uris[0].toString() : cur.activeSourceFileUri,
				side === 'target' ? uris[0].toString() : cur.activeTargetFileUri,
			);
		}, 'font-size:10px;padding:2px 8px;'));
		pane.appendChild(fileRow);
		return pane;
	}

	// \u2500\u2500\u2500 Compliance score panel (Discovery pane) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _buildDiscoveryCompliancePanel(
		projects: IProjectScanResult[],
	): HTMLElement {
		const VERTICAL_SHORT: Record<string, string> = {
			'iec-61508': 'IEC 61508', 'iec-62061': 'IEC 62061', 'iec-61511': 'IEC 61511',
			'iso-26262': 'ISO 26262', 'autosar': 'AUTOSAR', 'misra-c': 'MISRA-C',
			'misra-c++': 'MISRA-C++', 'iec-62443': 'IEC 62443', 'nerc-cip': 'NERC CIP',
			'3gpp-security': '3GPP Sec', 'gsma-nesas': 'GSMA NESAS',
			'certc': 'CERT-C', 'cert-c++': 'CERT-C++', 'iso-21434': 'ISO 21434',
		};

		const wrap = $e('div', [
			'border:1px solid var(--vscode-widget-border)',
			'border-radius:6px', 'overflow:hidden',
		].join(';'));

		const hdr = $e('div', [
			'padding:8px 13px',
			'background:var(--vscode-sideBarSectionHeader-background)',
			'border-bottom:1px solid var(--vscode-panel-border)',
		].join(';'));
		hdr.appendChild($t('span', 'GRC COMPLIANCE SCORES',
			'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-sideBarSectionHeader-foreground);'));
		wrap.appendChild(hdr);

		const body = $e('div', 'padding:10px 12px;display:flex;flex-direction:column;gap:10px;');

		for (const proj of projects) {
			const snap  = proj.grcSnapshot;
			const score = complianceScoreFromSnapshot(snap);
			const primary = primaryFrameworkFromSnapshot(snap);
			const scoreColor = score >= 80 ? 'var(--vscode-terminal-ansiGreen,#4caf50)'
				: score >= 50 ? '#e0a84e'
				: 'var(--vscode-inputValidation-errorBorder,#f44336)';
			const scoreLabel = score >= 80 ? 'COMPLIANT' : score >= 50 ? 'AT RISK' : 'NON-COMPLIANT';

			const card = $e('div', [
				'padding:10px 12px', 'border-radius:4px',
				'background:var(--vscode-input-background)',
				'border:1px solid var(--vscode-widget-border)',
			].join(';'));

			// Header row: project label + score badge
			const cardTop = $e('div', 'display:flex;align-items:center;gap:8px;margin-bottom:8px;');
			const roleBadge = $t('span', proj.projectLabel,
				'font-size:12px;font-weight:600;color:var(--vscode-editor-foreground);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
			cardTop.appendChild(roleBadge);
			cardTop.appendChild($t('span', `${score} \u2014 ${scoreLabel}`, [
				'font-size:10px', 'font-weight:700',
				`background:${scoreColor}22`, `color:${scoreColor}`,
				`border:1px solid ${scoreColor}55`,
				'padding:2px 8px', 'border-radius:8px', 'white-space:nowrap', 'flex-shrink:0',
			].join(';')));
			card.appendChild(cardTop);

			// Progress bar
			const bar = $e('div', 'background:var(--vscode-widget-border);border-radius:3px;height:6px;overflow:hidden;margin-bottom:8px;');
			const fill = $e('div', `height:100%;width:${score}%;background:${scoreColor};border-radius:3px;`);
			bar.appendChild(fill);
			card.appendChild(bar);

			// Stats row: violations + framework + safety domains
			const statsRow = $e('div', 'display:flex;gap:10px;flex-wrap:wrap;font-size:10px;color:var(--vscode-descriptionForeground);align-items:center;');
			statsRow.appendChild($t('span', `${snap.totalViolations} violations`, ''));
			if (snap.blockingCount > 0) {
				statsRow.appendChild($t('span', `${snap.blockingCount} blocking`, [
					'background:rgba(244,67,54,0.1)', 'color:#f44336',
					'border:1px solid rgba(244,67,54,0.3)',
					'padding:1px 5px', 'border-radius:8px',
				].join(';')));
			}
			statsRow.appendChild($t('span', `Primary: ${VERTICAL_SHORT[primary] ?? primary.toUpperCase()}`, ''));

			// List any safety-critical domains with hits
			const safetyHits = Object.entries(snap.byDomain)
				.filter(([d]) => SAFETY_CRITICAL_DOMAINS.has(d.toLowerCase()))
				.sort((a, b) => b[1] - a[1])
				.slice(0, 4);
			for (const [domain, count] of safetyHits) {
				statsRow.appendChild($t('span', `${VERTICAL_SHORT[domain] ?? domain}: ${count}`, [
					'background:rgba(224,168,78,0.12)', 'color:#e0a84e',
					'border:1px solid rgba(224,168,78,0.3)',
					'padding:1px 5px', 'border-radius:8px',
				].join(';')));
			}
			card.appendChild(statsRow);
			body.appendChild(card);
		}

		wrap.appendChild(body);
		return wrap;
	}

	private _buildAnalyseRow(): HTMLElement {
		const row = $e('div', 'padding:10px 16px;border-bottom:1px solid var(--vscode-panel-border,var(--vscode-widget-border));display:flex;justify-content:center;flex-shrink:0;');
		row.appendChild(this._btn('Analyse Compliance', true, () => this._runAnalysis()));
		return row;
	}

	// \u2500\u2500\u2500 Analysis \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _runAnalysis(): Promise<void> {
		const session = this.sessionService.session;
		if (!session.activeSourceFileUri || !session.activeTargetFileUri) {
			this._msg('Select both a source file and a target file before analysing.', 'error');
			return;
		}
		this._msg('Extracting Layer 1 fingerprints\u2026', 'status');
		try {
			const legacyUri  = URI.parse(session.activeSourceFileUri);
			const modernUri  = URI.parse(session.activeTargetFileUri);
			const [legacyRaw, modernRaw] = await Promise.all([
				this.fileService.readFile(legacyUri),
				this.fileService.readFile(modernUri),
			]);
			const legacySrc  = legacyRaw.value.toString();
			const modernSrc  = modernRaw.value.toString();
			const legacyLang = this._detectLang(legacyUri.path);
			const modernLang = this._detectLang(modernUri.path);
			const unitName   = this._basename(session.activeSourceFileUri).replace(/\.[^.]+$/, '');

			const legacyDet  = extractDeterministicFingerprint(legacySrc, legacyLang, unitName);
			const modernDet  = extractDeterministicFingerprint(modernSrc, modernLang, unitName + '-modern');

			this._msg('Running LLM semantic extraction (Layer 2)\u2026', 'status');
			const [legacySem, modernSem] = await Promise.all([
				this.semanticExtractor.extractSemantics(unitName, legacySrc, legacyLang, legacyDet.regulatedFields),
				this.semanticExtractor.extractSemantics(unitName + '-modern', modernSrc, modernLang, modernDet.regulatedFields),
			]);

			const legacyFP: IComplianceFingerprint = {
				unitId: unitName, extractedAt: Date.now(), sourceLanguage: legacyLang,
				regulatedFields: legacyDet.regulatedFields,
				invariants: [...legacyDet.invariants, ...legacySem.additionalInvariants],
				semanticRules: legacySem.semanticRules, complianceDomains: legacySem.complianceDomains,
				llmExtractionComplete: true,
			};
			const modernFP: IComplianceFingerprint = {
				unitId: unitName + '-modern', extractedAt: Date.now(), sourceLanguage: modernLang,
				regulatedFields: modernDet.regulatedFields,
				invariants: [...modernDet.invariants, ...modernSem.additionalInvariants],
				semanticRules: modernSem.semanticRules, complianceDomains: modernSem.complianceDomains,
				llmExtractionComplete: true,
			};

			this._msg('Comparing fingerprints\u2026', 'status');
			const cmp = this.comparisonService.compare(unitName, legacyFP, modernFP);
			this._renderComparison(cmp, legacyUri.path, modernUri.path);
		} catch (err) {
			this._msg(`Analysis failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
		}
	}

	private _renderComparison(cmp: IFingerprintComparison, legacyPath: string, modernPath: string): void {
		while (this._resultsEl.firstChild) { this._resultsEl.removeChild(this._resultsEl.firstChild); }

		const pct     = Math.round(cmp.matchPercentage);
		const color   = cmp.overallResult === 'pass'
			? 'var(--vscode-terminal-ansiGreen,#4caf50)'
			: cmp.overallResult === 'warning'
				? 'var(--vscode-inputValidation-warningBorder,#e0a84e)'
				: 'var(--vscode-inputValidation-errorBorder,#f44336)';
		const blocking = cmp.divergences.filter(d => d.severity === 'blocking');
		const warnings = cmp.divergences.filter(d => d.severity === 'warning');

		const header = $e('div', 'display:flex;align-items:center;gap:16px;margin-bottom:16px;flex-wrap:wrap;');
		header.appendChild($t('div', `${this._basename(legacyPath)} \u2192 ${this._basename(modernPath)}`,
			'font-size:11px;color:var(--vscode-descriptionForeground);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'));
		const score = $e('div', 'display:flex;align-items:baseline;gap:8px;flex-shrink:0;');
		score.appendChild($t('span', `${pct}%`, `font-size:40px;font-weight:700;line-height:1;color:${color};`));
		score.appendChild($t('span', cmp.overallResult.toUpperCase(), `font-size:13px;font-weight:700;color:${color};letter-spacing:0.05em;`));
		header.appendChild(score);
		this._resultsEl.appendChild(header);

		const track = $e('div', 'background:var(--vscode-input-background);border-radius:3px;height:6px;margin-bottom:20px;overflow:hidden;');
		track.appendChild($e('div', `height:100%;width:${pct}%;background:${color};`));
		this._resultsEl.appendChild(track);

		if (blocking.length > 0) { this._resultsEl.appendChild(this._divSection('Blocking', 'var(--vscode-inputValidation-errorBorder,#f44336)', blocking)); }
		if (warnings.length  > 0) { this._resultsEl.appendChild(this._divSection('Warnings', 'var(--vscode-inputValidation-warningBorder,#e0a84e)', warnings)); }
		if (blocking.length === 0 && warnings.length === 0) {
			this._resultsEl.appendChild($t('div', '\u2713  All compliance checks passed \u2014 translation is equivalent.',
				'color:var(--vscode-terminal-ansiGreen,#4caf50);font-size:13px;'));
		}
	}

	private _divSection(title: string, color: string, items: IFingerprintDivergence[]): HTMLElement {
		const sec = $e('div', 'margin-bottom:16px;');
		sec.appendChild($t('div', `${title} (${items.length})`,
			`font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${color};margin-bottom:8px;`));
		for (const d of items) {
			const row = $e('div', 'display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--vscode-widget-border,var(--vscode-panel-border));');
			row.appendChild($t('code', d.type.replace(/-/g, ' '),
				'font-size:10px;font-weight:600;text-transform:uppercase;opacity:0.6;min-width:100px;flex-shrink:0;word-break:break-all;'));
			row.appendChild($t('span', d.description, 'flex:1;font-size:12px;line-height:1.5;'));
			sec.appendChild(row);
		}
		return sec;
	}

	// \u2500\u2500\u2500 Shared helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _projectRow(badge: string, pt: IProjectTarget, openCmd: string): HTMLElement {
		const row = $e('div', 'display:flex;align-items:center;gap:8px;margin-bottom:6px;');
		row.appendChild($t('span', badge,
			'font-size:9px;font-weight:700;letter-spacing:0.06em;color:var(--vscode-badge-foreground);background:var(--vscode-badge-background);border-radius:2px;padding:1px 5px;flex-shrink:0;'));
		const name = $t('div', pt.label || this._basename(pt.folderUri),
			'font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
		name.title = pt.folderUri;
		row.appendChild(name);
		const openBtn = this._btn('\u2197', false, () => this.commandService.executeCommand(openCmd, pt.folderUri),
			'font-size:11px;padding:1px 6px;');
		openBtn.title = `Open in VS Code window`;
		row.appendChild(openBtn);
		return row;
	}

	private _section(title: string): HTMLElement {
		const s = $e('div', 'padding:12px 14px 8px;border-bottom:1px solid var(--vscode-panel-border,var(--vscode-widget-border));');
		s.appendChild($t('div', title,
			'font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--vscode-sideBarSectionHeader-foreground,var(--vscode-descriptionForeground));margin-bottom:10px;'));
		return s;
	}

	private _btn(label: string, primary: boolean, onClick: () => void, extraCss = ''): HTMLButtonElement {
		const btn = $t('button', label, [
			'padding:5px 14px', 'border-radius:3px', 'cursor:pointer',
			'font-size:12px', 'font-family:inherit',
			primary
				? 'background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:1px solid var(--vscode-button-border,transparent);'
				: 'background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-widget-border,transparent);',
			extraCss,
		].join(';')) as HTMLButtonElement;
		btn.addEventListener('click', onClick);
		this._disposables.add({ dispose: () => btn.removeEventListener('click', onClick) });
		return btn;
	}

	private _msg(text: string, kind: 'status' | 'error'): void {
		while (this._resultsEl.firstChild) { this._resultsEl.removeChild(this._resultsEl.firstChild); }
		this._resultsEl.appendChild($t('div', text,
			kind === 'error'
				? 'color:var(--vscode-inputValidation-errorBorder,#f44336);'
				: 'color:var(--vscode-descriptionForeground);font-style:italic;'));
	}

	private _basename(p: string): string {
		return p.split(/[/\\]/).filter(Boolean).pop() ?? p;
	}

	private _detectLang(filePath: string): string {
		const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
		const map: Record<string, string> = {
			cob: 'cobol', cbl: 'cobol', cobol: 'cobol',
			ts: 'typescript', tsx: 'typescript',
			js: 'javascript', jsx: 'javascript',
			java: 'java',
			sql: 'plsql', pls: 'plsql', pkb: 'plsql', pks: 'plsql',
			py: 'python', rpg: 'rpg', rpgle: 'rpg',
			nat: 'natural', vb: 'vb6', bas: 'vb6',
		};
		return map[ext] ?? ext;
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);
	}

	override dispose(): void {
		this._console?.dispose();
		this._disposables.dispose();
		super.dispose();
	}
}
