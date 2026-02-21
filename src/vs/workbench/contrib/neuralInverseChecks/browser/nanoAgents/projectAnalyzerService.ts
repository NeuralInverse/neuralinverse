/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Project Analyzer Service
 *
 * DI-injectable bridge between the nano agents (ProjectAnalyzer) and the
 * GRC engine. Provides:
 *
 * 1. **Real-time analysis** — watches file changes and editor switches,
 *    re-analyzes affected files automatically (no manual trigger needed)
 * 2. **In-memory cache** — analysis results are kept in memory for fast
 *    access by the GRC engine, alongside the encrypted disk storage
 * 3. **INanoAgentContext** — structured context object passed to GRC
 *    analyzers so framework rules can leverage nano agent intelligence
 *
 * ## How the GRC Engine Uses This
 *
 * When evaluating a document, the engine calls:
 * ```typescript
 * const context = projectAnalyzerService.getContextForFile(fileUri);
 * analyzer.evaluate(rule, model, fileUri, timestamp, context);
 * ```
 *
 * Framework rules can then use constraints like:
 * - `hasCrypto && !hasTryCatch` (AST constraint using capabilities)
 * - `complexity > 10` (metrics-based constraint)
 * - `hasNetwork && !hasAuth` (capabilities-based constraint)
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { URI } from '../../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { isCodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ProjectAnalyzer, IDashboardState } from './projectAnalyzer.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';


// ─── Nano Agent Context (passed to GRC analyzers) ────────────────────────────

/**
 * Per-file context from nano agent analysis.
 * This is what GRC analyzers receive to make intelligent decisions.
 */
export interface INanoAgentContext {
	/** Metrics: lineCount, symbolCount, classes, functions, maxDepth, avgParams */
	metrics?: {
		lineCount?: number;
		textSize?: number;
		symbolCount?: number;
		classes?: number;
		functions?: number;
		maxDepth?: number;
		avgParams?: number;
		languageId?: string;
	};

	/** Capabilities: what patterns exist in this file */
	capabilities?: {
		hasAsync?: boolean;
		hasAwait?: boolean;
		isTestFile?: boolean;
		hasClasses?: boolean;
		hasFunctions?: boolean;
		hasInterfaces?: boolean;
		hasNetwork?: boolean;
		hasFileSystem?: boolean;
		hasCrypto?: boolean;
		hasAuth?: boolean;
		hasDatabase?: boolean;
		hasEnv?: boolean;
	};

	/** Call hierarchy: function name → { incoming, outgoing } */
	callHierarchy?: Record<string, {
		incoming?: Array<{ from: string; range: any }>;
		outgoing?: Array<{ to: string; range: any }>;
	}>;

	/** LSP document symbols (flattened) */
	symbols?: any[];

	/** Whether analysis has been completed for this file */
	analyzed: boolean;
}


// ─── Service Interface ───────────────────────────────────────────────────────

export const IProjectAnalyzerService = createDecorator<IProjectAnalyzerService>('projectAnalyzerService');

export interface IProjectAnalyzerService {
	readonly _serviceBrand: undefined;

	/**
	 * Get nano agent context for a specific file.
	 * Returns cached context if available, or a stub with analyzed=false.
	 */
	getContextForFile(fileUri: URI): INanoAgentContext;

	/**
	 * Get the workspace-wide dashboard state.
	 */
	getDashboardState(): IDashboardState;

	/**
	 * Force re-analysis of a specific file. Results are cached.
	 */
	analyzeFile(fileUri: URI): Promise<void>;

	/**
	 * Force full workspace re-analysis.
	 */
	analyzeWorkspace(): Promise<void>;

	/**
	 * Fires when analysis completes for any file.
	 * The GRC engine listens to this to re-evaluate affected files.
	 */
	readonly onDidAnalysisComplete: Event<URI>;
}


// ─── Service Implementation ──────────────────────────────────────────────────

/** Directories to skip when watching for file changes */
const SKIP_DIRS = new Set([
	'node_modules', '.git', '.inverse', 'dist', 'out', 'build',
	'.next', '.nuxt', '__pycache__', '.venv', 'venv', 'vendor',
]);

/** File extensions the nano agents can analyze */
const ANALYZABLE_EXTENSIONS = new Set([
	'ts', 'tsx', 'js', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'cs',
	'go', 'rs', 'php', 'html', 'css', 'json',
]);

const DEBOUNCE_MS = 1000;

export class ProjectAnalyzerServiceImpl extends Disposable implements IProjectAnalyzerService {

	declare readonly _serviceBrand: undefined;

	private readonly _projectAnalyzer: ProjectAnalyzer;
	private readonly _contextCache = new Map<string, INanoAgentContext>();
	private _fileChangeTimer: any;
	private _pendingFileChanges = new Set<string>();
	private _isInitialized = false;

	private readonly _onDidAnalysisComplete = this._register(new Emitter<URI>());
	public readonly onDidAnalysisComplete: Event<URI> = this._onDidAnalysisComplete.event;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();

		// Create the underlying ProjectAnalyzer
		this._projectAnalyzer = this._register(
			this.instantiationService.createInstance(ProjectAnalyzer)
		);

		// Initialize: workspace scan + watcher setup
		this._initialize();
	}

	private async _initialize(): Promise<void> {
		// Initial workspace scan (deferred to not block startup)
		setTimeout(() => this._runInitialScan(), 2000);

		// ── Real-time: watch file changes on disk ─────────────────────
		this._register(this.fileService.onDidFilesChange(e => {
			// Handle updated/added files → schedule re-analysis
			const toAnalyze = [...e.rawAdded, ...e.rawUpdated];
			for (const uri of toAnalyze) {
				if (uri.path.includes('/.inverse/')) {
					continue;
				}

				const ext = uri.path.split('.').pop()?.toLowerCase();
				if (!ext || !ANALYZABLE_EXTENSIONS.has(ext)) {
					continue;
				}

				const pathParts = uri.path.split('/');
				if (pathParts.some(p => SKIP_DIRS.has(p))) {
					continue;
				}

				this._pendingFileChanges.add(uri.toString());
			}

			// Handle deleted files → clear cache
			for (const uri of e.rawDeleted) {
				this._contextCache.delete(uri.toString());
			}

			if (this._pendingFileChanges.size > 0) {
				this._scheduleFileAnalysis();
			}
		}));

		// ── Real-time: re-analyze when active editor changes ─────────
		this._register(this.editorService.onDidActiveEditorChange(() => {
			const editor = this.editorService.activeTextEditorControl;
			if (editor && isCodeEditor(editor)) {
				const model = editor.getModel();
				if (model && !model.uri.path.includes('/.inverse/')) {
					this._pendingFileChanges.add(model.uri.toString());
					this._scheduleFileAnalysis();
				}
			}
		}));
	}

	/**
	 * Run the initial workspace scan.
	 * Analyzes all files and populates the in-memory cache.
	 */
	private async _runInitialScan(): Promise<void> {
		try {
			console.log('[ProjectAnalyzerService] Starting initial workspace scan...');
			await this._projectAnalyzer.analyzeWorkspace();
			this._isInitialized = true;
			console.log('[ProjectAnalyzerService] Initial scan complete');

			// Populate cache from the analyzer's results
			// (the analyzer saved to disk, we cache in memory)
			// We don't pre-load everything — it's done on-demand in getContextForFile()
		} catch (e) {
			console.error('[ProjectAnalyzerService] Initial scan failed:', e);
		}
	}

	/**
	 * Debounced file re-analysis for real-time updates.
	 */
	private _scheduleFileAnalysis(): void {
		if (this._fileChangeTimer) {
			clearTimeout(this._fileChangeTimer);
		}

		this._fileChangeTimer = setTimeout(async () => {
			const pending = Array.from(this._pendingFileChanges);
			this._pendingFileChanges.clear();

			for (const uriStr of pending) {
				const uri = URI.parse(uriStr);
				try {
					await this._analyzeAndCache(uri);
					this._onDidAnalysisComplete.fire(uri);
				} catch (e) {
					// File may have been deleted or be unreadable
				}
			}
		}, DEBOUNCE_MS);
	}

	/**
	 * Analyze a single file and cache the results in memory.
	 */
	private async _analyzeAndCache(uri: URI): Promise<void> {
		// Run the full nano agent analysis pipeline
		await this._projectAnalyzer.analyzeFile(uri);

		// Read back the analysis results into the in-memory cache
		const detailed = await this._projectAnalyzer.getDetailedAnalysis(uri);

		const context: INanoAgentContext = {
			metrics: detailed.metrics ?? undefined,
			capabilities: detailed.capabilities ?? undefined,
			callHierarchy: detailed.callHierarchy ?? undefined,
			symbols: detailed.lsp ?? undefined,
			analyzed: true,
		};

		this._contextCache.set(uri.toString(), context);
	}


	// ─── Public API ──────────────────────────────────────────────────

	public getContextForFile(fileUri: URI): INanoAgentContext {
		const cached = this._contextCache.get(fileUri.toString());
		if (cached) {
			return cached;
		}

		// If not cached, return a stub and trigger background analysis
		if (this._isInitialized) {
			// Trigger async analysis (will fire onDidAnalysisComplete when done)
			this._pendingFileChanges.add(fileUri.toString());
			this._scheduleFileAnalysis();
		}

		return { analyzed: false };
	}

	public getDashboardState(): IDashboardState {
		return this._projectAnalyzer.getAnalysisState();
	}

	public async analyzeFile(fileUri: URI): Promise<void> {
		await this._analyzeAndCache(fileUri);
		this._onDidAnalysisComplete.fire(fileUri);
	}

	public async analyzeWorkspace(): Promise<void> {
		await this._projectAnalyzer.analyzeWorkspace();
		this._contextCache.clear(); // Force re-read from disk
		this._isInitialized = true;
	}

	override dispose(): void {
		if (this._fileChangeTimer) {
			clearTimeout(this._fileChangeTimer);
		}
		this._contextCache.clear();
		super.dispose();
	}
}


// ─── Register as singleton ───────────────────────────────────────────────────

registerSingleton(IProjectAnalyzerService, ProjectAnalyzerServiceImpl, InstantiationType.Delayed);
