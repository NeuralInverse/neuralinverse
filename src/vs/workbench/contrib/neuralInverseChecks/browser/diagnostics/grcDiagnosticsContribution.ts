/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # GRC Diagnostics Contribution
 *
 * Bridges the GRC engine to the editor's marker system for real-time
 * diagnostics across the **entire workspace**, not just the active editor.
 *
 * ## How It Works
 *
 * ### Workspace-Wide Scanning (background)
 *
 * 1. On startup, crawls all workspace files (skipping node_modules, .git, .inverse, etc.)
 * 2. Reads each file's content via IFileService and evaluates against all GRC rules
 * 3. Uses a concurrency-limited queue to avoid freezing the UI
 * 4. Watches for file changes (create/modify/delete) and re-evaluates affected files
 * 5. When rules change (framework import, config edit), triggers a full workspace re-scan
 *
 * ### Active Editor (real-time typing)
 *
 * 1. Listens for editor changes (active editor switch + content changes)
 * 2. Debounces evaluation to avoid thrashing on rapid typing
 * 3. Calls `grcEngine.evaluateDocument()` on the ITextModel for full rule coverage
 *    (including AST/dataflow analyzers that require a model)
 *
 * ## Severity Mapping
 *
 * Framework rules may use custom severities (e.g. "blocker", "critical").
 * These are mapped to VS Code's marker severity via `toDisplaySeverity()`:
 * - error/blocker/critical \u2192 red squiggly
 * - warning/major \u2192 yellow squiggly
 * - info/minor \u2192 blue hint
 */

import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IMarkerService, IMarkerData, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IGRCEngineService } from '../engine/services/grcEngineService.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ICheckResult, toDisplaySeverity } from '../engine/types/grcTypes.js';
import { isCodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { URI } from '../../../../../base/common/uri.js';
import { IProjectAnalyzerService } from '../nanoAgents/projectAnalyzerService.js';

const GRC_MARKER_OWNER = 'neuralInverse.grc';
const DEBOUNCE_MS = 300;
const AI_DEBOUNCE_MS = 3_000;

/** File extensions to scan */
const SUPPORTED_EXTENSIONS = new Set([
	'ts', 'tsx', 'js', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'cs',
	'go', 'rs', 'php', 'rb', 'swift', 'kt', 'scala', 'html', 'css',
	'scss', 'json', 'yaml', 'yml', 'xml', 'sql', 'sh', 'bash',
	'dockerfile', 'tf', 'hcl'
]);

/** Directories to skip during workspace crawl */
const SKIP_DIRS = new Set([
	'node_modules', '.git', '.inverse', 'dist', 'out', 'build',
	'.next', '.nuxt', '__pycache__', '.venv', 'venv', 'vendor',
	'.cache', 'coverage', '.nyc_output'
]);

/** Max concurrent file evaluations during background scan */
const SCAN_CONCURRENCY = 5;

export class GRCDiagnosticsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.grcDiagnostics';

	private _debounceTimer: any;
	private _aiDebounceTimer: any;
	private _modelListeners = this._register(new DisposableStore());
	private _isScanning = false;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IGRCEngineService private readonly grcEngine: IGRCEngineService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IProjectAnalyzerService private readonly projectAnalyzerService: IProjectAnalyzerService,
	) {
		super();

		// \u2500\u2500 Active Editor: real-time typing detection \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		this._register(this.editorService.onDidActiveEditorChange(() => {
			this._onEditorChange();
		}));

		// \u2500\u2500 Rules changed: full workspace re-scan \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		this._register(this.grcEngine.onDidRulesChange(() => {
			this._runActiveEditorCheck();
			this._scanWorkspace();
		}));

		// \u2500\u2500 Intelligence results: re-render markers with AI enrichments \u2500\u2500
		this._register(this.grcEngine.onDidCheckComplete((results) => {
			if (!this.grcEngine.inlineDiagnosticsEnabled) return;
			if (results.length > 0 && results[0]?.fileUri) {
				this._setMarkersForFile(results[0].fileUri, results);
			}
		}));

		// \u2500\u2500 Inline diagnostics toggle: clear or restore all markers \u2500\u2500\u2500\u2500\u2500\u2500
		this._register(this.grcEngine.onDidInlineDiagnosticsChange((enabled) => {
			if (!enabled) {
				// Clear all GRC markers across all files
				this.markerService.read({ owner: GRC_MARKER_OWNER })
					.forEach(m => this.markerService.changeOne(GRC_MARKER_OWNER, m.resource, []));
			} else {
				// Restore markers from cached results
				const model = this._getActiveModel();
				if (model) {
					const results = this.grcEngine.evaluateDocument(model);
					this._setMarkersForFile(model.uri, results);
				}
				// Re-run workspace scan to repopulate all files
				this._scanWorkspace();
			}
		}));

		// \u2500\u2500 File system watcher: real-time file change detection \u2500\u2500\u2500\u2500\u2500\u2500
		this._register(this.fileService.onDidFilesChange(e => {
			this._onFilesChanged(e);
		}));

		// \u2500\u2500 Startup: scan + check active editor \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		this._onEditorChange();
		this._scanWorkspace();
	}


	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
	// Active Editor \u2014 real-time typing (unchanged from original)
	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

	private _onEditorChange(): void {
		this._modelListeners.clear();

		const model = this._getActiveModel();
		if (!model) { return; }

		this._modelListeners.add(model.onDidChangeContent(() => {
			this._scheduleActiveEditorCheck();
			this._scheduleAICheck();
		}));

		this._runActiveEditorCheck();
	}

	private _scheduleActiveEditorCheck(): void {
		if (this._debounceTimer) { clearTimeout(this._debounceTimer); }
		this._debounceTimer = setTimeout(() => this._runActiveEditorCheck(), DEBOUNCE_MS);
	}

	private _runActiveEditorCheck(): void {
		const model = this._getActiveModel();
		if (!model) { return; }

		const results = this.grcEngine.evaluateDocument(model);
		if (this.grcEngine.inlineDiagnosticsEnabled) {
			this._setMarkersForFile(model.uri, results);
		}

		// Restore persisted AI violations for the file currently being viewed.
		// This ensures AI findings appear immediately on open without waiting for
		// a new LLM call \u2014 the workspace scan covers background files, but we
		// need this for the active editor which doesn't go through that path.
		this.projectAnalyzerService.loadAuditData(model.uri).then(aiViolations => {
			if (aiViolations.length > 0) {
				this.grcEngine.restoreAIViolations(model.uri, aiViolations);
			}
		});
	}


	private _scheduleAICheck(): void {
		if (this._aiDebounceTimer) { clearTimeout(this._aiDebounceTimer); }
		this._aiDebounceTimer = setTimeout(() => this._runAICheck(), AI_DEBOUNCE_MS);
	}

	private _runAICheck(): void {
		const model = this._getActiveModel();
		if (!model) { return; }
		this.grcEngine.triggerAIAnalysis(model.uri, model.getValue());
	}


	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
	// Workspace-Wide Scanning \u2014 background evaluation
	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

	/**
	 * Crawl all workspace files and evaluate them against GRC rules.
	 * Uses concurrency-limited queue to avoid UI freezing.
	 */
	private async _scanWorkspace(): Promise<void> {
		if (this._isScanning) {
			return; // Avoid overlapping scans
		}
		this._isScanning = true;

		try {
			const folders = this.workspaceContextService.getWorkspace().folders;
			const allFiles: URI[] = [];

			for (const folder of folders) {
				const files = await this._crawlDirectory(folder.uri);
				allFiles.push(...files);
			}

			console.log(`[GRC Scanner] Found ${allFiles.length} files to scan`);
			await this._evaluateFilesInBatches(allFiles);
			console.log('[GRC Scanner] Workspace scan complete');
		} catch (e) {
			console.error('[GRC Scanner] Workspace scan failed:', e);
		} finally {
			this._isScanning = false;
		}
	}

	/**
	 * Recursively crawl a directory for scannable files.
	 */
	private async _crawlDirectory(dir: URI): Promise<URI[]> {
		const result: URI[] = [];

		try {
			const stat = await this.fileService.resolve(dir, { resolveMetadata: false });
			if (!stat.children) { return result; }

			for (const child of stat.children) {
				if (child.isDirectory) {
					if (SKIP_DIRS.has(child.name)) {
						continue;
					}
					result.push(...await this._crawlDirectory(child.resource));
				} else if (child.isFile) {
					const ext = child.name.split('.').pop()?.toLowerCase();
					if (ext && SUPPORTED_EXTENSIONS.has(ext)) {
						result.push(child.resource);
					}
				}
			}
		} catch (e) {
			// Directory may not be accessible
		}

		return result;
	}

	/**
	 * Evaluate a list of files with concurrency limiting.
	 * Processes SCAN_CONCURRENCY files at a time.
	 */
	private async _evaluateFilesInBatches(files: URI[]): Promise<void> {
		let index = 0;

		const processNext = async (): Promise<void> => {
			while (index < files.length) {
				const file = files[index++];
				await this._evaluateSingleFile(file);
			}
		};

		// Launch concurrent workers
		const workers: Promise<void>[] = [];
		for (let i = 0; i < Math.min(SCAN_CONCURRENCY, files.length); i++) {
			workers.push(processNext());
		}

		await Promise.all(workers);
	}

	/**
	 * Read a file and evaluate it against GRC rules.
	 * Uses the engine's evaluateFileContent() for raw-text evaluation.
	 */
	private async _evaluateSingleFile(fileUri: URI): Promise<void> {
		// Skip .inverse files
		if (fileUri.path.includes('/.inverse/')) {
			return;
		}

		try {
			const content = await this.fileService.readFile(fileUri);
			const text = content.value.toString();
			const results = this.grcEngine.evaluateFileContent(fileUri, text);
			if (this.grcEngine.inlineDiagnosticsEnabled) {
				this._setMarkersForFile(fileUri, results);
			}

			// Restore persisted AI violations from previous session.
			// This runs on every startup scan so AI findings survive IDE restarts
			// without needing to re-run LLM analysis.
			const aiViolations = await this.projectAnalyzerService.loadAuditData(fileUri);
			if (aiViolations.length > 0) {
				this.grcEngine.restoreAIViolations(fileUri, aiViolations);
			}
		} catch (e) {
			// File may have been deleted between crawl and read
		}
	}


	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
	// File Change Watcher \u2014 real-time reactions to disk changes
	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

	/**
	 * React to file system changes.
	 * Re-evaluates modified/created files and clears markers for deleted files.
	 */
	private _onFilesChanged(e: any): void {
		// Process creates and updates
		const relevantChanges: URI[] = [];

		// FileChangeType: UPDATED = 0, ADDED = 1, DELETED = 2
		// The event has `rawChanges` or we can use `.contains()` / `.getAdded()` etc.
		// IFileChangesEvent exposes: added, updated, deleted as arrays of IFileChange
		if (e.rawChanges) {
			for (const change of e.rawChanges) {
				const uri = change.resource as URI;
				if (!uri) { continue; }

				// Skip .inverse files
				if (uri.path.includes('/.inverse/')) {
					continue;
				}

				// Check if it's a supported file type
				const ext = uri.path.split('.').pop()?.toLowerCase();
				if (!ext || !SUPPORTED_EXTENSIONS.has(ext)) {
					continue;
				}

				if (change.type === 2) {
					// DELETED \u2014 clear markers
					this.markerService.changeOne(GRC_MARKER_OWNER, uri, []);
					this.grcEngine.clearResultsForFile(uri);
				} else {
					// ADDED or UPDATED \u2014 schedule evaluation
					relevantChanges.push(uri);
				}
			}
		}

		// Debounced: evaluate changed files
		if (relevantChanges.length > 0) {
			// Use a small delay to batch rapid saves
			setTimeout(() => {
				for (const uri of relevantChanges) {
					this._evaluateSingleFile(uri);
				}
			}, 300);
		}
	}


	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
	// Shared Helpers
	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

	/**
	 * Convert ICheckResult[] to IMarkerData[] and set markers for a file.
	 *
	 * When intelligence enrichments are available, the hover tooltip shows:
	 * - AI confidence level (HIGH / MEDIUM / LOW)
	 * - AI-generated context-specific explanation
	 * - AI-generated concrete fix code
	 */
	private _setMarkersForFile(fileUri: URI, results: ICheckResult[]): void {
		const markers: IMarkerData[] = results.map(r => {
			let message = r.message;

			// AI intelligence section
			if (r.aiExplanation) {
				const confidence = (r.aiConfidence || 'medium').toUpperCase();
				message += `\n\nAI Analysis [${confidence}]: ${r.aiExplanation}`;
			}
			// Static fix from rule definition
			if (r.fix) {
				message += `\nFix: ${r.fix}`;
			}
			if (r.references && r.references.length > 0) {
				message += `\nRef: ${r.references.join(', ')}`;
			}

			return {
				severity: this._toMarkerSeverity(r.severity),
				message,
				startLineNumber: r.line,
				startColumn: r.column,
				endLineNumber: r.endLine,
				endColumn: r.endColumn,
				source: r.aiExplanation
					? (r.frameworkId
						? `Neural Inverse GRC [AI] [${r.frameworkId}]`
						: 'Neural Inverse GRC [AI]')
					: (r.frameworkId
						? `Neural Inverse GRC [${r.frameworkId}]`
						: 'Neural Inverse GRC'),
				code: r.ruleId
			};
		});

		this.markerService.changeOne(GRC_MARKER_OWNER, fileUri, markers);
	}

	/**
	 * Maps a severity string to VS Code's MarkerSeverity enum.
	 */
	private _toMarkerSeverity(severity: string): MarkerSeverity {
		const displaySeverity = toDisplaySeverity(severity);
		switch (displaySeverity) {
			case 'error': return MarkerSeverity.Error;
			case 'warning': return MarkerSeverity.Warning;
			case 'info': return MarkerSeverity.Info;
		}
	}

	private _getActiveModel(): ITextModel | undefined {
		const editor = this.editorService.activeTextEditorControl;
		if (editor && isCodeEditor(editor)) {
			return editor.getModel() ?? undefined;
		}
		return undefined;
	}

	override dispose(): void {
		if (this._debounceTimer) { clearTimeout(this._debounceTimer); }
		if (this._aiDebounceTimer) { clearTimeout(this._aiDebounceTimer); }
		super.dispose();
	}
}
