/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { URI } from '../../../../../../base/common/uri.js';
import { CancellationTokenSource, CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Limiter, RunOnceScheduler } from '../../../../../../base/common/async.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IFileService, FileOperationError, FileOperationResult } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { ITreeSitterLibraryService } from '../../../../../../editor/common/services/treeSitter/treeSitterLibraryService.js';
import { SymbolKind } from '../../../../../../editor/common/languages.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IWorkspaceBM25Service } from '../search/bm25Index.js';
import { ITrigramIndexService } from '../search/trigramIndex.js';
import { IPersistentContextStore, IStoredFileIndex } from '../search/persistentStore.js';

export const IWorkspaceSymbolIndexService = createDecorator<IWorkspaceSymbolIndexService>('neuralInverseWorkspaceSymbolIndex');

export interface IIndexedSymbol {
	name: string;
	kind: SymbolKind;
	filePath: string;
	range: { startLine: number; startCol: number; endLine: number; endCol: number };
	containerName?: string;
	exportedAs?: string;
	isDefault?: boolean;
	references: string[];
}

export type IndexRejectionReason = 'tooLarge' | 'generated' | 'unreadable' | 'gitignored' | 'capped';

/** Counters for the most recent full-index run. `rejected` explains every
 *  discovered file that did not reach the lexical feed, so a silent gap in
 *  search coverage can be told apart from an actually complete index.
 *
 *  Reconciliation invariant (asserted by tests):
 *    discovered == indexed + unchanged + rejected.tooLarge + rejected.generated + rejected.unreadable
 *  (`gitignored`/`capped` are pre-admission: those files were seen by the walk
 *  but never entered `discovered`.)
 *
 *  `canceled`/`unreadableDirs` separate a COMPLETE walk from a partial one:
 *  only a completed, uncanceled walk with no unreadable directories proves a
 *  missing file was really deleted, which is what the stale cleanup relies on. */
export interface IIndexRunStats {
	discovered: number;
	indexed: number;
	unchanged: number;
	rejected: Partial<Record<IndexRejectionReason, number>>;
	/** true when the run ended by cancellation — the walk is partial; its file set proves nothing about deletions. */
	canceled: boolean;
	/** directories the walk could not read; files under them are exempt from stale cleanup. */
	unreadableDirs: number;
	failed: boolean;
	error: string | undefined;
}

export interface IFileIndex {
	uri: string;
	symbols: IIndexedSymbol[];
	imports: Set<string>;
	lastIndexedAt: number;
	contentHash: number;
}

export interface IWorkspaceSymbolIndexService {
	readonly _serviceBrand: undefined;
	readonly onDidReindex: Event<string[]>;
	readonly onDidRemoveFiles: Event<string[]>;
	readonly onDidStartFullIndex: Event<void>;
	readonly onDidFinishFullIndex: Event<void>;
	getSymbolsByName(name: string): IIndexedSymbol[];
	getSymbolsInFile(uri: string): IIndexedSymbol[];
	getImporters(uri: string): string[];
	getImports(uri: string): string[];
	getTransitiveDependents(uri: string, maxDepth?: number): string[];
	getTransitiveImports(uri: string, maxDepth?: number): string[];
	getFileIndex(uri: string): IFileIndex | undefined;
	isReady(): boolean;
	getStats(): { totalFiles: number; totalSymbols: number; indexingInProgress: boolean; indexCapped?: boolean; lastRun?: IIndexRunStats };
	forceReindex(uri?: string): Promise<void>;
}

/** Minimal shape of a Tree-sitter syntax node (untyped by the parser). */
interface TreeSitterNode {
	type: string;
	namedChildren?: TreeSitterNode[];
	namedChildCount?: number;
	namedChild(index: number): TreeSitterNode | null | undefined;
	childForFieldName?(field: string): TreeSitterNode | null | undefined;
	startPosition?: { row: number; column: number };
	endPosition?: { row: number; column: number };
	text?: string;
	parent?: TreeSitterNode | null;
}

const BATCH_SIZE = 30;
const BATCH_YIELD_MS = 16;
const MAX_FILE_SIZE_BYTES = 1_048_576; // 1MB
const INDEX_CONCURRENCY = 4;
const DEBOUNCE_FILE_CHANGE_MS = 300;
const WORKSPACE_RESCAN_DEBOUNCE_MS = 2_000;
const MAX_TRANSITIVE_DEPTH = 6;
const MAX_TRANSITIVE_RESULTS = 200;
// Full-index cap: huge workspaces (200k+ source files) would otherwise read+parse for
// HOURS, saturating IO and making the whole editor feel frozen (session 20260906T164055:
// the walk alone found 235,985 files). The first 25k files cover normal projects entirely.
const MAX_INDEX_FILES = 25_000;

const SOURCE_EXTENSIONS = new Set([
	// Text retrieval also covers project assets without a symbol parser.
	'.html', '.htm', '.css', '.scss', '.less', '.json', '.jsonc', '.md', '.mdx', '.yaml', '.yml', '.toml',
	'.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs',
	'.py', '.pyi', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cc', '.hh',
	'.cs', '.java', '.kt', '.kts', '.scala', '.vue', '.svelte',
	'.rb', '.php', '.swift', '.m', '.mm', '.zig', '.nim', '.ex', '.exs',
	'.lua', '.dart', '.r', '.R', '.jl', '.hs', '.elm', '.clj', '.cljs',
]);

const IGNORED_DIRS = new Set([
	'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
	'__pycache__', '.venv', 'venv', 'env', 'target', 'vendor',
	'.cache', '.turbo', 'coverage', '.nyc_output', '.pytest_cache',
	'bower_components', 'jspm_packages', '.gradle', '.idea', '.vs',
	'bin', 'obj', 'pkg', 'Pods', '.dart_tool', '.pub-cache',
]);

const TREESITTER_SUPPORTED = new Set(['typescript', 'javascript', 'css', 'ini', 'regex']);

function emptyRunStats(): IIndexRunStats {
	return { discovered: 0, indexed: 0, unchanged: 0, rejected: {}, canceled: false, unreadableDirs: 0, failed: false, error: undefined };
}

export class WorkspaceSymbolIndexService extends Disposable implements IWorkspaceSymbolIndexService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidReindex = this._register(new Emitter<string[]>());
	readonly onDidReindex = this._onDidReindex.event;

	private readonly _onDidRemoveFiles = this._register(new Emitter<string[]>());
	/** Files dropped from the index (delete/rename/ignore) — downstream
	 *  stores (embeddings) use it for symmetric cleanup. */
	readonly onDidRemoveFiles = this._onDidRemoveFiles.event;

	private readonly _onDidStartFullIndex = this._register(new Emitter<void>());
	readonly onDidStartFullIndex = this._onDidStartFullIndex.event;

	private readonly _onDidFinishFullIndex = this._register(new Emitter<void>());
	readonly onDidFinishFullIndex = this._onDidFinishFullIndex.event;

	private readonly _symbolsByName = new Map<string, Set<IIndexedSymbol>>();
	private readonly _fileIndices = new Map<string, IFileIndex>();
	private readonly _reverseImportEdges = new Map<string, Set<string>>();

	private _ready = false;
	private _indexingInProgress = false;
	private _fullIndexCts: CancellationTokenSource | undefined;
	private _initialIndexTimeout: ReturnType<typeof setTimeout> | undefined;
	private _indexCapped = false;
	private _workspaceRescanScheduler: RunOnceScheduler;
	// Counters for the in-flight (or most recently settled) full-index run.
	private _run: IIndexRunStats = emptyRunStats();
	private readonly _limiter = new Limiter<void>(INDEX_CONCURRENCY);

	private readonly _pendingFileChanges = new Set<string>();
	private readonly _fileChangeDebouncer: RunOnceScheduler;

	// ─── Persistence (task D3) ─────────────────────────────────────────────────
	// Lazy store init — one attempt per workspace, fault-tolerant (same pattern
	// as bm25Index.ts).  If the store is unavailable we degrade to in-memory only.
	private _storeInit: Promise<boolean> | undefined;
	private _hydrated = false;

	// .gitignore patterns read at the start of a full index walk.  Simple
	// glob matching (no full gitignore spec) — covers the vast majority of
	// real-world .gitignore entries (path globs, * wildcards, directory
	// suffix).  Patterns are relative to the workspace root.
	private _gitignorePatterns: string[] = [];
	private _gitignoreLoaded = false;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IModelService private readonly _modelService: IModelService,
		@ITreeSitterLibraryService private readonly _treeSitterService: ITreeSitterLibraryService,
		@ILogService private readonly _logService: ILogService,
		@IWorkspaceBM25Service private readonly _bm25Index: IWorkspaceBM25Service,
		@ITrigramIndexService private readonly _trigramIndex: ITrigramIndexService,
		@IPersistentContextStore private readonly _contextStore: IPersistentContextStore,
	) {
		super();

		this._fileChangeDebouncer = this._register(new RunOnceScheduler(
			() => this._processFileChanges(), DEBOUNCE_FILE_CHANGE_MS
		));

		this._register(this._fileService.onDidFilesChange(e => {
			// .gitignore changes (F07): re-read the patterns and purge files
			// that just became ignored, so ignore edits apply without waiting
			// for the next full reindex. Containment check: the changed file
			// must be a root's `.gitignore` — the old `roots.includes(...)`
			// compared the .gitignore URI against the ROOT URIs and could
			// never fire, so ignore edits silently never applied.
			const roots = this._workspaceService.getWorkspace().folders.map(f => f.uri.toString());
			const gitignoreChanged = [...e.rawAdded, ...e.rawUpdated, ...e.rawDeleted]
				.some(r => r.path.endsWith('/.gitignore') && roots.some(root => r.toString().startsWith(root + '/')));
			if (gitignoreChanged) {
				this._gitignoreLoaded = false;
				void this._applyGitignoreChanges();
			}
			for (const resource of e.rawDeleted) {
				const ext = this._extname(resource.path);
				if (SOURCE_EXTENSIONS.has(ext)) {
					this._removeFile(resource.toString());
				}
			}
			for (const resource of [...e.rawAdded, ...e.rawUpdated]) {
				const ext = this._extname(resource.path);
				if (SOURCE_EXTENSIONS.has(ext)) {
					this._pendingFileChanges.add(resource.toString());
				}
			}
			if (this._pendingFileChanges.size > 0 && !this._fileChangeDebouncer.isScheduled()) {
				this._fileChangeDebouncer.schedule();
			}
		}));

		// Also track in-memory model saves for immediate feedback
		this._register(this._modelService.onModelAdded(model => {
			const uri = model.uri.toString();
			if (this._fileIndices.has(uri)) {
				this._register(model.onDidChangeContent(() => {
					this._pendingFileChanges.add(uri);
					if (!this._fileChangeDebouncer.isScheduled()) {
						this._fileChangeDebouncer.schedule();
					}
				}));
			}
		}));

		// Defer the initial index until the workbench settles: indexing 10k+ files
		// right at startup makes the first minute of every session feel frozen
		// (exthost unresponsive cycles + heavy IO churn alongside session restore).
		this._initialIndexTimeout = setTimeout(() => this._startFullIndex(), 20_000);

		// Workspace roots changed (root added/removed): a removed root's files
		// must be pruned and a new root must be walked. Debounced — folder
		// changes arrive in bursts; the persisted-hash fast path keeps the
		// re-walk cheap for unchanged files.
		this._workspaceRescanScheduler = this._register(new RunOnceScheduler(
			() => { this._gitignoreLoaded = false; void this._startFullIndex(); }, WORKSPACE_RESCAN_DEBOUNCE_MS
		));
		this._register(this._workspaceService.onDidChangeWorkspaceFolders(() => {
			if (!this._workspaceRescanScheduler.isScheduled()) { this._workspaceRescanScheduler.schedule(); }
		}));
	}

	isReady(): boolean { return this._ready; }

	getStats(): { totalFiles: number; totalSymbols: number; indexingInProgress: boolean; indexCapped: boolean; lastRun: IIndexRunStats } {
		let totalSymbols = 0;
		for (const fi of this._fileIndices.values()) {
			totalSymbols += fi.symbols.length;
		}
		return { totalFiles: this._fileIndices.size, totalSymbols, indexingInProgress: this._indexingInProgress, indexCapped: this._indexCapped, lastRun: this._run };
	}

	getSymbolsByName(name: string): IIndexedSymbol[] {
		const set = this._symbolsByName.get(name);
		return set ? Array.from(set) : [];
	}

	getSymbolsInFile(uri: string): IIndexedSymbol[] {
		return this._fileIndices.get(uri)?.symbols ?? [];
	}

	getImporters(uri: string): string[] {
		const set = this._reverseImportEdges.get(uri);
		return set ? Array.from(set) : [];
	}

	getImports(uri: string): string[] {
		const fi = this._fileIndices.get(uri);
		return fi ? Array.from(fi.imports) : [];
	}

	getTransitiveDependents(uri: string, maxDepth = MAX_TRANSITIVE_DEPTH): string[] {
		return this._bfs(uri, maxDepth, 'reverse');
	}

	getTransitiveImports(uri: string, maxDepth = MAX_TRANSITIVE_DEPTH): string[] {
		return this._bfs(uri, maxDepth, 'forward');
	}

	getFileIndex(uri: string): IFileIndex | undefined {
		return this._fileIndices.get(uri);
	}

	async forceReindex(uri?: string): Promise<void> {
		if (uri) {
			await this._indexFile(uri, CancellationToken.None);
			this._onDidReindex.fire([uri]);
		} else {
			if (this._initialIndexTimeout !== undefined) {
				clearTimeout(this._initialIndexTimeout);
				this._initialIndexTimeout = undefined;
			}
			this._cancelFullIndex();
			await this._startFullIndex();
		}
	}

	private _bfs(startUri: string, maxDepth: number, direction: 'forward' | 'reverse'): string[] {
		const visited = new Set<string>();
		const queue: Array<{ uri: string; depth: number }> = [{ uri: startUri, depth: 0 }];
		const results: string[] = [];

		while (queue.length > 0 && results.length < MAX_TRANSITIVE_RESULTS) {
			const { uri, depth } = queue.shift()!;
			if (visited.has(uri)) { continue; }
			visited.add(uri);

			if (uri !== startUri) { results.push(uri); }
			if (depth >= maxDepth) { continue; }

			const neighbors = direction === 'reverse'
				? this._reverseImportEdges.get(uri)
				: this._fileIndices.get(uri)?.imports;

			if (neighbors) {
				for (const n of neighbors) {
					if (!visited.has(n)) {
						queue.push({ uri: n, depth: depth + 1 });
					}
				}
			}
		}

		return results;
	}

	private _cancelFullIndex(): void {
		if (this._fullIndexCts) {
			this._fullIndexCts.cancel();
			this._fullIndexCts.dispose();
			this._fullIndexCts = undefined;
		}
	}

	private async _startFullIndex(): Promise<void> {
		if (this._indexingInProgress) {
			this._cancelFullIndex();
		}

		this._indexingInProgress = true;
		this._indexCapped = false;
		// Per-run stats object: a superseded (canceled) run keeps mutating ITS
		// OWN object and can never skew the replacement run's counters.
		const runStats = emptyRunStats();
		this._run = runStats;
		const run = new CancellationTokenSource();
		this._fullIndexCts = run;
		const token = run.token;
		const unreadableDirs: URI[] = [];
		this._onDidStartFullIndex.fire();

		try {
			// Load .gitignore BEFORE hydration: persisted entries that became
			// ignored since the last session must not be resurrected (F09/WI-1).
			await this._loadGitignore();

			// Hydrate from persistence before walking — if the store has data
			// from a previous session, in-memory maps are populated now so the
			// walk only re-indexes files whose content hash changed.
			await this._ensureStore();
			if (!this._hydrated) {
				await this._hydrate().catch(() => { /* best-effort — degrade to in-memory */ });
			}
			const persistedHashes = await this._getPersistedHashes();

			const folders = this._workspaceService.getWorkspace().folders;
			const allFiles: string[] = [];

			for (const folder of folders) {
				if (token.isCancellationRequested) { return; }
				await this._walkDirectory(folder.uri, allFiles, token, unreadableDirs, runStats);
			}
			runStats.discovered = allFiles.length;
			runStats.unreadableDirs = unreadableDirs.length;

			// Remove entries for files the completed walk did NOT see — deleted,
			// renamed, moved out, newly gitignored, or under a removed root.
			// The old `!_isUriGitignored(uri)` guard kept now-ignored entries
			// alive forever (WI-1: ~1.2k node_modules ghosts next to 92 real
			// files). Pruning is allowed ONLY when this walk is proof: not
			// canceled, not failed, and the file is not under a directory the
			// walk could not read (a missing file under an unreadable dir is
			// not evidence of deletion).
			const walkSettled = !token.isCancellationRequested && !runStats.failed;
			if (walkSettled) {
				const allFileSet = new Set(allFiles);
				const unreadablePrefixes = unreadableDirs.map(d => d.toString());
				let pruned = 0;
				for (const [uri] of this._fileIndices) {
					if (allFileSet.has(uri)) { continue; }
					if (unreadablePrefixes.some(p => uri.startsWith(p + '/') || uri === p)) { continue; }
					this._removeFile(uri);
					pruned++;
				}
				if (pruned > 0) {
					this._logService.info(`[SymbolIndex] Stale cleanup pruned ${pruned} entries absent from the completed walk`);
				}
			}

			this._logService.info(`[SymbolIndex] Indexing ${allFiles.length} files across ${folders.length} folders`);

			for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
				if (token.isCancellationRequested) { return; }

				const batch = allFiles.slice(i, i + BATCH_SIZE);
				const promises = batch.map(f => this._limiter.queue(() => this._indexFile(f, token, persistedHashes, runStats)));
				await Promise.all(promises);

				// Yield to event loop between batches
				await new Promise<void>(r => setTimeout(r, BATCH_YIELD_MS));
			}

			if (token.isCancellationRequested) { return; }
			this._ready = true;
			this._logService.info(`[SymbolIndex] Done. ${this._fileIndices.size} files, ${this.getStats().totalSymbols} symbols`);
		} catch (e) {
			if (!token.isCancellationRequested) {
				runStats.failed = true;
				runStats.error = e instanceof Error ? e.message : String(e);
				this._logService.error(`[SymbolIndex] Indexing failed:`, e);
			}
		} finally {
			runStats.canceled = token.isCancellationRequested;
			// Observers synchronously read getStats(). Publish the settled state
			// first; a superseded run must not clear a newer run's busy flag.
			if (this._fullIndexCts === run) {
				this._fullIndexCts = undefined;
				this._indexingInProgress = false;
				this._onDidFinishFullIndex.fire();
			}
			run.dispose();
		}
	}

	// ─── Persistence (task D3) ─────────────────────────────────────────────────

	private _ensureStore(): Promise<boolean> {
		if (!this._storeInit) {
			this._storeInit = (async () => {
				const ws = this._workspaceService.getWorkspace().folders[0]?.uri;
				if (!ws) { return false; }
				const id = ws.toString().replace(/[^a-zA-Z0-9]/g, '_').slice(-120) || 'default';
				await this._contextStore.initialize(id);
				if (!this._hydrated) {
					this._hydrated = true;
					await this._hydrate().catch(() => { /* best-effort — degrade to in-memory */ });
				}
				return true;
			})().catch(() => false);
		}
		return this._storeInit;
	}

	/** Rebuild in-memory maps from the persistent store. Called once after
	 *  _ensureStore() succeeds — mirrors the rebuild() pattern in bm25Index.ts. */
	/** Feed the (non-persistent) trigram index for a file whose symbols we
	 *  already know — used on hydration and unchanged fast paths so a warm
	 *  restart keeps fuzzy-name search working without re-parsing every file. */
	private _feedTrigram(uri: string, symbols: IIndexedSymbol[]): void {
		const resource = URI.parse(uri);
		const filePath = resource.fsPath;
		try { this._trigramIndex.addEntry(uri, filePath, resource.path); } catch { /* best-effort */ }
		for (const sym of symbols) {
			try { this._trigramIndex.addEntry(`${uri}:${sym.name}`, filePath, sym.name, sym.name); } catch { /* best-effort */ }
		}
	}

	private async _hydrate(): Promise<void> {
		const stored = await this._contextStore.getAllFileIndices();
		if (stored.length === 0) { return; }

		this._fileIndices.clear();
		this._symbolsByName.clear();
		this._reverseImportEdges.clear();

		let droppedIgnored = 0;
		for (const fi of stored) {
			// A persisted entry that is gitignored NOW must not be resurrected
			// (F09/WI-1): skip the in-memory feed, drop it from the store so it
			// cannot come back on the next restart either, and clean the
			// downstream search feeds (bm25 hydrates from its own store and
			// would otherwise keep serving the ghost text).
			if (this._isUriGitignored(fi.uri)) {
				droppedIgnored++;
				const resource = URI.parse(fi.uri);
				try { this._trigramIndex.removeEntriesForFile(resource.fsPath); } catch { /* best-effort */ }
				try { this._bm25Index.removeFile(resource.fsPath).catch(() => { }); } catch { /* best-effort */ }
				try { await this._contextStore.deleteFileIndexByUri(fi.uri).catch(() => { }); } catch { /* best-effort */ }
				continue;
			}

			// Deserialize: imports string[] → Set<string>, symbols stored as-is
			const symbols = fi.symbols;
			const imports = new Set(fi.imports);

			const fileIndex: IFileIndex = {
				uri: fi.uri,
				symbols,
				imports,
				lastIndexedAt: fi.lastIndexedAt,
				contentHash: fi.contentHash,
			};
			this._fileIndices.set(fi.uri, fileIndex);

			for (const sym of symbols) {
				let set = this._symbolsByName.get(sym.name);
				if (!set) {
					set = new Set();
					this._symbolsByName.set(sym.name, set);
				}
				set.add(sym);
			}

			for (const target of imports) {
				let rev = this._reverseImportEdges.get(target);
				if (!rev) {
					rev = new Set();
					this._reverseImportEdges.set(target, rev);
				}
				rev.add(fi.uri);
			}

			// Warm start (F07): trigram has no persistence of its own — feed
			// hydrated entries here, or fuzzy search is empty after restart
			// until every file happens to change.
			this._feedTrigram(fi.uri, symbols);
		}

		this._logService.info(`[SymbolIndex] Hydrated ${this._fileIndices.size} files from persistent store${droppedIgnored > 0 ? ` (dropped ${droppedIgnored} now-gitignored stale entries)` : ''}`);
	}

	/** Returns a map of uri → contentHash from the persistent store, so the
	 *  walk can skip files that haven't changed without reading their content. */
	private async _getPersistedHashes(): Promise<Map<string, number>> {
		try {
			return await this._contextStore.getSymbolFileHashes();
		} catch {
			return new Map();
		}
	}

	/** Serialize an in-memory IFileIndex to the IndexedDB-friendly IStoredFileIndex. */
	private _serializeFileIndex(fi: IFileIndex): IStoredFileIndex {
		return {
			uri: fi.uri,
			symbols: fi.symbols,
			imports: Array.from(fi.imports),
			lastIndexedAt: fi.lastIndexedAt,
			contentHash: fi.contentHash,
		};
	}

	// ─── .gitignore reading (task D3) ──────────────────────────────────────────

	/** Read .gitignore from each workspace root and collect glob patterns.
	 *  Simple matching: supports exact paths, * wildcards, and directory
	 *  suffix patterns (trailing /).  Negation (!) and nested .gitignore
	 *  files are not supported — covers the majority of real-world usage. */
	private async _loadGitignore(): Promise<void> {
		if (this._gitignoreLoaded) { return; }
		this._gitignoreLoaded = true;
		this._gitignorePatterns = [];

		const folders = this._workspaceService.getWorkspace().folders;
		for (const folder of folders) {
			const gitignoreUri = URI.joinPath(folder.uri, '.gitignore');
			try {
				const stat = await this._fileService.readFile(gitignoreUri);
				const text = stat.value.toString();
				for (const line of text.split(/\r?\n/)) {
					const trimmed = line.trim();
					if (!trimmed || trimmed.startsWith('#')) { continue; }
					this._gitignorePatterns.push(trimmed);
				}
			} catch {
				// no .gitignore in this folder — fine
			}
		}

		if (this._gitignorePatterns.length > 0) {
			this._logService.info(`[SymbolIndex] Loaded ${this._gitignorePatterns.length} .gitignore patterns`);
		}
	}

	/** Check if a file path matches any .gitignore pattern. */
	private _isGitignored(filePath: string): boolean {
		for (const pattern of this._gitignorePatterns) {
			if (this._matchGitignorePattern(filePath, pattern)) {
				return true;
			}
		}
		return false;
	}

	/** Check if a URI is gitignored (converts URI to path first). */
	private _isUriGitignored(uri: string): boolean {
		try {
			const resource = URI.parse(uri);
			return this._isGitignored(resource.fsPath);
		} catch {
			return false;
		}
	}

	/** Simple gitignore pattern matcher. Supports:
	 *  - exact path match (e.g. "secrets.txt")
	 *  - * wildcard (e.g. "*.log")
	 *  - directory suffix (e.g. "dist/")
	 *  - path globs (e.g. "src/generated/*") */
	private _matchGitignorePattern(filePath: string, pattern: string): boolean {
		// Normalize: use forward slashes consistently
		const normalizedPath = filePath.replace(/\\/g, '/');

		// Directory suffix pattern (e.g. "dist/")
		if (pattern.endsWith('/')) {
			const dir = pattern.slice(0, -1);
			// Match if any path segment equals the directory name
			const segments = normalizedPath.split('/');
			if (segments.some(s => s === dir)) { return true; }
			// Or if the path contains the directory as a path component
			if (normalizedPath.includes('/' + dir + '/')) { return true; }
			return false;
		}

		// Negation patterns (!) — not supported, treat as no-match
		if (pattern.startsWith('!')) { return false; }

		// Convert glob to regex
		// Escape regex special chars except * and /
		let regexStr = pattern
			.replace(/[.+^${}()|[\]\\]/g, '\\$&')
			.replace(/\*/g, '.*');

		// If pattern contains no /, match against any path segment (basename match)
		if (!pattern.includes('/')) {
			regexStr = '(^|/)' + regexStr + '(/|$)';
		}

		const regex = new RegExp(regexStr);
		return regex.test(normalizedPath);
	}

	private async _walkDirectory(dirUri: URI, results: string[], token: CancellationToken, unreadableDirs: URI[] = [], runStats: IIndexRunStats = this._run): Promise<void> {
		if (token.isCancellationRequested) { return; }

		try {
			const stat = await this._fileService.resolve(dirUri);
			if (!stat.children) { return; }

			for (const child of stat.children) {
				if (token.isCancellationRequested) { return; }

				if (child.isDirectory) {
					if (!IGNORED_DIRS.has(child.name) && !child.name.startsWith('.')) {
						await this._walkDirectory(child.resource, results, token, unreadableDirs, runStats);
					}
				} else {
					const ext = this._extname(child.name);
					if (SOURCE_EXTENSIONS.has(ext)) {
						// Skip files that match .gitignore patterns (task D3)
						if (this._isGitignored(child.resource.fsPath)) {
							this._countRejected(runStats, 'gitignored');
							continue;
						}
						if (results.length >= MAX_INDEX_FILES) {
							if (!this._indexCapped) {
								this._indexCapped = true;
								this._logService.warn(`[SymbolIndex] Capping full index at ${MAX_INDEX_FILES} files — the workspace has more; only the first ${MAX_INDEX_FILES} source files are indexed.`);
							}
							this._countRejected(runStats, 'capped');
							return;
						}
						results.push(child.resource.toString());
					}
				}
			}
		} catch {
			// Directory unreadable — its subtree is missing from this walk, so
			// stale cleanup must spare files under it (a missing file here is
			// not evidence of deletion).
			unreadableDirs.push(dirUri);
		}
	}

	/** Reload .gitignore patterns and apply them both ways:
	 *  - newly ignored files are dropped from every in-memory index + search
	 *    feed, and
	 *  - newly UNignored paths (a removed pattern) are re-discovered by a
	 *    debounced full re-walk — the persisted-hash fast path keeps it cheap.
	 *  Failures leave the previous patterns in place. */
	private async _applyGitignoreChanges(): Promise<void> {
		try {
			const previous = new Set(this._gitignorePatterns);
			await this._loadGitignore();
			const removed: string[] = [];
			for (const [uri] of this._fileIndices) {
				if (this._isUriGitignored(uri)) {
					this._removeFile(uri);
					removed.push(uri);
				}
			}
			if (removed.length > 0) {
				this._logService.info(`[SymbolIndex] .gitignore change removed ${removed.length} indexed files`);
			}
			const unignored = [...previous].some(p => !this._gitignorePatterns.includes(p));
			if (unignored && !this._workspaceRescanScheduler.isScheduled()) {
				this._workspaceRescanScheduler.schedule();
			}
		} catch (e) {
			this._logService.warn(`[SymbolIndex] failed to apply .gitignore change:`, e);
		}
	}

	private _countRejected(runStats: IIndexRunStats, reason: IndexRejectionReason): void {
		runStats.rejected[reason] = (runStats.rejected[reason] ?? 0) + 1;
	}

	private async _indexFile(uri: string, token: CancellationToken, persistedHashes?: Map<string, number>, runStats?: IIndexRunStats): Promise<void> {
		if (token.isCancellationRequested) { return; }
		const countsTowardRun = runStats !== undefined;

		try {
			const resource = URI.parse(uri);

			// Unified eligibility (F09): the watcher/incremental path applies the
			// SAME rules as the full walk — a gitignored file must not slip into
			// the index just because a file event mentioned it.
			if (this._isUriGitignored(uri)) {
				if (countsTowardRun) { this._countRejected(runStats, 'gitignored'); }
				return;
			}

			// Fast-path skip: if the persisted store already has this file
			// and we hydrated from it, the in-memory hash matches the stored
			// one.  We still need to verify the on-disk content hasn't changed
			// since the last session, but we can defer the file read until
			// after the cheap hash comparison.  If the persisted hash exists
			// and the in-memory index already has it, the file was hydrated
			// and we only need to re-read if the content changed.
			//
			// The existing hash-check at line 583 below already handles the
			// in-memory skip.  The persistedHashes map lets us skip even
			// reading the file: if the persisted hash matches the in-memory
			// one (from hydrate), and no model is open for this file, we
			// can trust the hydrated data without touching disk.
			const inMemory = this._fileIndices.get(uri);
			const persistedHash = persistedHashes?.get(uri);
			if (inMemory && persistedHash !== undefined && inMemory.contentHash === persistedHash) {
				// The file was hydrated from the store and hasn't been touched
				// in this session.  We still need to verify the on-disk content
				// hasn't changed since last session — but only if no editor
				// model is open (if one is open, its content is authoritative).
				const model = this._modelService.getModel(resource);
				if (!model) {
					// No editor model — read the file to check the hash.
					// This is still cheaper than full symbol extraction.
					const stat = await this._fileService.readFile(resource, { limits: { size: MAX_FILE_SIZE_BYTES } });
					const content = stat.value.toString();
					const hash = this._hashContent(content);
					if (hash === inMemory.contentHash) {
						// File unchanged — skip symbol extraction entirely, but
						// keep the trigram feed alive across warm restarts.
						if (countsTowardRun) { runStats.unchanged++; }
						this._feedTrigram(uri, inMemory.symbols);
						return;
					}
					// File changed on disk — fall through to full re-index.
					// (The code below will read content again, but the file
					// system cache makes this nearly free.)
				}
			}

			// Try in-memory model first (already open in editor)
			const model = this._modelService.getModel(resource);
			let content: string;

			if (model) {
				content = model.getValue();
			} else {
				const stat = await this._fileService.readFile(resource, { limits: { size: MAX_FILE_SIZE_BYTES } });
				content = stat.value.toString();
			}

			if (token.isCancellationRequested) { return; }

			// Skip minified/generated files — a 100KB+ file with under 10
			// newlines is almost certainly bundled/minified output, not
			// source. Indexing it wastes memory and pollutes search results.
			if (content.length > 50_000) {
				const newlineCount = (content.match(/\n/g) ?? []).length;
				if (newlineCount < 10) {
					if (countsTowardRun) { this._countRejected(runStats, 'generated'); }
					return;
				}
			}

			// Content hash for skip-if-unchanged
			const hash = this._hashContent(content);
			const existing = this._fileIndices.get(uri);
			if (existing && existing.contentHash === hash) {
				if (countsTowardRun) { runStats.unchanged++; }
				this._feedTrigram(uri, existing.symbols);
				return;
			}

			// Remove old data
			this._removeFile(uri);

			// Parse
			const symbols = await this._extractSymbols(uri, content, model ?? undefined);
			const imports = this._extractImports(uri, content);

			// Store
			const fileIndex: IFileIndex = {
				uri,
				symbols,
				imports,
				lastIndexedAt: Date.now(),
				contentHash: hash,
			};
			this._fileIndices.set(uri, fileIndex);

			// Update symbol name index
			for (const sym of symbols) {
				let set = this._symbolsByName.get(sym.name);
				if (!set) {
					set = new Set();
					this._symbolsByName.set(sym.name, set);
				}
				set.add(sym);
			}

			// Update import edges
			for (const target of imports) {
				let rev = this._reverseImportEdges.get(target);
				if (!rev) {
					rev = new Set();
					this._reverseImportEdges.set(target, rev);
				}
				rev.add(uri);
			}

			// Persist to IndexedDB (task D3) — fire-and-forget; a store
			// failure must never block the symbol index.
			try { await this._contextStore.putFileIndex(this._serializeFileIndex(fileIndex)); } catch { /* best-effort */ }

			// Feed search indexes (C8 bnd 1) — the file content is already
			// in memory; zero extra I/O.  bm25 indexes the full text for
			// keyword retrieval; trigram indexes file + symbol names for
			// fuzzy matching.  Both are fire-and-forget — a failure in the
			// search layer must never block the symbol index.
			const filePath = resource.fsPath;
			try { this._trigramIndex.addEntry(uri, filePath, resource.path); } catch { /* best-effort */ }
			for (const sym of symbols) {
				try { this._trigramIndex.addEntry(`${uri}:${sym.name}`, filePath, sym.name, sym.name); } catch { /* best-effort */ }
			}
			try { await this._bm25Index.indexFile(filePath, content, String(hash)); } catch { /* best-effort */ }
			if (countsTowardRun) { runStats.indexed++; }
		} catch (e) {
			// unreadable or too large — skip, but say why in the run stats so
			// the gap in search coverage stays visible instead of silent.
			if (countsTowardRun) {
				if (e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_TOO_LARGE) {
					this._countRejected(runStats, 'tooLarge');
				} else {
					this._countRejected(runStats, 'unreadable');
				}
			}
		}
	}

	private _removeFile(uri: string): void {
		const existing = this._fileIndices.get(uri);
		if (!existing) { return; }

		// Feed search indexes — symmetric removal (C8 bnd 1)
		const resource = URI.parse(uri);
		const filePath = resource.fsPath;
		try { this._trigramIndex.removeEntriesForFile(filePath); } catch { /* best-effort */ }
		try { this._bm25Index.removeFile(filePath).catch(() => { }); } catch { /* best-effort */ }

		// Remove from name index
		for (const sym of existing.symbols) {
			const set = this._symbolsByName.get(sym.name);
			if (set) {
				set.delete(sym);
				if (set.size === 0) { this._symbolsByName.delete(sym.name); }
			}
		}

		// Remove import edges
		for (const target of existing.imports) {
			const rev = this._reverseImportEdges.get(target);
			if (rev) {
				rev.delete(uri);
				if (rev.size === 0) { this._reverseImportEdges.delete(target); }
			}
		}

		this._fileIndices.delete(uri);

		// Remove from persistent store (task D3) — fire-and-forget
		try { this._contextStore.deleteFileIndexByUri(uri).catch(() => { }); } catch { /* best-effort */ }

		try { this._onDidRemoveFiles.fire([uri]); } catch { /* listener failures must not break removal */ }
	}

	private async _processFileChanges(): Promise<void> {
		const files = Array.from(this._pendingFileChanges);
		this._pendingFileChanges.clear();

		if (files.length === 0) { return; }

		const reindexed: string[] = [];
		for (const uri of files) {
			await this._indexFile(uri, CancellationToken.None);
			reindexed.push(uri);
		}

		if (reindexed.length > 0) {
			this._onDidReindex.fire(reindexed);
		}
	}

	// ─── Symbol Extraction ──────────────────────────────────────────────────────

	private async _extractSymbols(
		uri: string,
		content: string,
		model?: import('../../../../../../editor/common/model.js').ITextModel,
	): Promise<IIndexedSymbol[]> {
		// Attempt TreeSitter for supported languages
		if (model) {
			const langId = model.getLanguageId();
			if (TREESITTER_SUPPORTED.has(langId)) {
				const tsSymbols = await this._extractViaTreeSitter(uri, model);
				if (tsSymbols && tsSymbols.length > 0) { return tsSymbols; }
			}
		}

		// Regex fallback
		return this._extractViaRegex(uri, content);
	}

	private async _extractViaTreeSitter(
		uri: string,
		model: import('../../../../../../editor/common/model.js').ITextModel,
	): Promise<IIndexedSymbol[] | undefined> {
		try {
			const languageId = model.getLanguageId();
			const lang = this._treeSitterService.getLanguage(languageId, false, undefined);
			if (!lang) { return undefined; }

			const ParserClass = await this._treeSitterService.getParserClass();
			const parser = new ParserClass();
			parser.setLanguage(lang);
			const tree = parser.parse(model.getValue());
			if (!tree) { return undefined; }
			const root = tree.rootNode;
			const symbols: IIndexedSymbol[] = [];

			this._walkTreeSitterNode(root as unknown as TreeSitterNode, uri, symbols, undefined);
			return symbols;
		} catch {
			return undefined;
		}
	}

	private _walkTreeSitterNode(
		node: TreeSitterNode,
		uri: string,
		symbols: IIndexedSymbol[],
		containerName: string | undefined,
	): void {
		const type = node.type as string;

		// Exported declarations
		if (type === 'export_statement') {
			const declaration = node.namedChildren?.find((c: TreeSitterNode) =>
				c.type.includes('declaration') || c.type === 'class_declaration' ||
				c.type === 'function_declaration' || c.type === 'lexical_declaration' ||
				c.type === 'type_alias_declaration' || c.type === 'enum_declaration' ||
				c.type === 'interface_declaration'
			);
			if (declaration) {
				this._extractDeclarationSymbol(declaration, uri, symbols, containerName, true, node.text?.startsWith('export default') ?? false);
			}
			return;
		}

		// Top-level declarations
		if (this._isDeclarationNode(type) && !node.parent?.type?.includes('export')) {
			this._extractDeclarationSymbol(node, uri, symbols, containerName, false, false);
		}

		// Recurse into classes/namespaces for nested symbols
		if (type === 'class_declaration' || type === 'class' || type === 'abstract_class_declaration') {
			const name = this._getNodeName(node);
			const body = node.namedChildren?.find((c: TreeSitterNode) => c.type === 'class_body');
			if (body && name) {
				for (let i = 0; i < (body.namedChildCount ?? 0); i++) {
					const child = body.namedChild(i);
					if (child && (child.type === 'method_definition' || child.type === 'public_field_definition')) {
						this._extractDeclarationSymbol(child, uri, symbols, name, false, false);
					}
				}
			}
			return;
		}

		// Walk children
		for (let i = 0; i < (node.namedChildCount ?? 0); i++) {
			const child = node.namedChild(i);
			if (child) { this._walkTreeSitterNode(child, uri, symbols, containerName); }
		}
	}

	private _isDeclarationNode(type: string): boolean {
		return type === 'function_declaration' || type === 'class_declaration' ||
			type === 'interface_declaration' || type === 'type_alias_declaration' ||
			type === 'enum_declaration' || type === 'lexical_declaration' ||
			type === 'variable_declaration' || type === 'abstract_class_declaration';
	}

	private _extractDeclarationSymbol(
		node: TreeSitterNode,
		uri: string,
		symbols: IIndexedSymbol[],
		containerName: string | undefined,
		isExported: boolean,
		isDefault: boolean,
	): void {
		const name = this._getNodeName(node);
		if (!name) { return; }

		const kind = this._nodeTypeToSymbolKind(node.type);
		const startPos = node.startPosition;
		const endPos = node.endPosition;

		symbols.push({
			name,
			kind,
			filePath: uri,
			range: {
				startLine: (startPos?.row ?? 0) + 1,
				startCol: startPos?.column ?? 0,
				endLine: (endPos?.row ?? 0) + 1,
				endCol: endPos?.column ?? 0,
			},
			containerName,
			exportedAs: isExported ? name : undefined,
			isDefault,
			references: [],
		});
	}

	private _getNodeName(node: TreeSitterNode): string | undefined {
		// Try named children for identifier
		for (let i = 0; i < (node.namedChildCount ?? 0); i++) {
			const child = node.namedChild(i);
			if (!child) { continue; }
			if (child.type === 'identifier' || child.type === 'type_identifier' || child.type === 'property_identifier') {
				return child.text;
			}
		}
		// Variable declarators
		if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
			const declarator = node.namedChildren?.find((c: TreeSitterNode) => c.type === 'variable_declarator');
			if (declarator) {
				const id = declarator.namedChildren?.find((c: TreeSitterNode) => c.type === 'identifier');
				return id?.text;
			}
		}
		return undefined;
	}

	private _nodeTypeToSymbolKind(type: string): SymbolKind {
		switch (type) {
			case 'function_declaration': case 'method_definition': return SymbolKind.Function;
			case 'class_declaration': case 'abstract_class_declaration': return SymbolKind.Class;
			case 'interface_declaration': return SymbolKind.Interface;
			case 'type_alias_declaration': return SymbolKind.TypeParameter;
			case 'enum_declaration': return SymbolKind.Enum;
			default: return SymbolKind.Variable;
		}
	}

	// ─── Regex Fallback Extraction ──────────────────────────────────────────────

	private _extractViaRegex(uri: string, content: string): IIndexedSymbol[] {
		const ext = this._extname(uri);
		const lines = content.split('\n');
		const symbols: IIndexedSymbol[] = [];

		switch (ext) {
			case '.ts': case '.tsx': case '.mts': case '.cts':
			case '.js': case '.jsx': case '.mjs': case '.cjs':
				this._extractJSTSSymbols(uri, lines, symbols);
				break;
			case '.py': case '.pyi':
				this._extractPythonSymbols(uri, lines, symbols);
				break;
			case '.go':
				this._extractGoSymbols(uri, lines, symbols);
				break;
			case '.rs':
				this._extractRustSymbols(uri, lines, symbols);
				break;
			case '.c': case '.h': case '.cpp': case '.hpp': case '.cc': case '.hh':
				this._extractCSymbols(uri, lines, symbols);
				break;
			case '.java': case '.kt': case '.kts':
				this._extractJavaKotlinSymbols(uri, lines, symbols);
				break;
			case '.cs':
				this._extractCSharpSymbols(uri, lines, symbols);
				break;
			case '.rb':
				this._extractRubySymbols(uri, lines, symbols);
				break;
			case '.php':
				this._extractPHPSymbols(uri, lines, symbols);
				break;
			case '.swift':
				this._extractSwiftSymbols(uri, lines, symbols);
				break;
			default:
				this._extractGenericSymbols(uri, lines, symbols);
				break;
		}

		return symbols;
	}

	private _extractJSTSSymbols(uri: string, lines: string[], symbols: IIndexedSymbol[]): void {
		let currentClass: string | undefined;
		let braceDepth = 0;
		let classStartDepth = -1;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();

			// Track brace depth for class scope detection
			for (const ch of line) {
				if (ch === '{') { braceDepth++; }
				if (ch === '}') {
					braceDepth--;
					if (braceDepth <= classStartDepth) {
						currentClass = undefined;
						classStartDepth = -1;
					}
				}
			}

			if (trimmed.startsWith('//') || trimmed.startsWith('*')) { continue; }

			const isExport = /^export\s/.test(trimmed);
			const isDefault = /^export\s+default\s/.test(trimmed);

			// Function declarations
			let match = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/.exec(trimmed);
			if (match) {
				symbols.push(this._makeSymbol(match[1], SymbolKind.Function, uri, i, line, currentClass, isExport, isDefault));
				continue;
			}

			// Class declarations
			match = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/.exec(trimmed);
			if (match) {
				currentClass = match[1];
				classStartDepth = braceDepth - 1;
				symbols.push(this._makeSymbol(match[1], SymbolKind.Class, uri, i, line, undefined, isExport, isDefault));
				continue;
			}

			// Interface declarations
			match = /^(?:export\s+)?interface\s+(\w+)/.exec(trimmed);
			if (match) {
				symbols.push(this._makeSymbol(match[1], SymbolKind.Interface, uri, i, line, undefined, isExport, false));
				continue;
			}

			// Type alias
			match = /^(?:export\s+)?type\s+(\w+)\s*[=<]/.exec(trimmed);
			if (match) {
				symbols.push(this._makeSymbol(match[1], SymbolKind.TypeParameter, uri, i, line, undefined, isExport, false));
				continue;
			}

			// Enum
			match = /^(?:export\s+)?(?:const\s+)?enum\s+(\w+)/.exec(trimmed);
			if (match) {
				symbols.push(this._makeSymbol(match[1], SymbolKind.Enum, uri, i, line, undefined, isExport, false));
				continue;
			}

			// Const/let/var exports
			match = /^(?:export\s+)?(?:const|let|var)\s+(\w+)/.exec(trimmed);
			if (match && isExport) {
				symbols.push(this._makeSymbol(match[1], SymbolKind.Variable, uri, i, line, undefined, true, isDefault));
				continue;
			}

			// Method definitions inside class
			if (currentClass) {
				match = /^(?:(?:public|private|protected|static|async|get|set|override|readonly)\s+)*(\w+)\s*[(<]/.exec(trimmed);
				if (match && match[1] !== 'if' && match[1] !== 'for' && match[1] !== 'while' &&
					match[1] !== 'switch' && match[1] !== 'return' && match[1] !== 'new' &&
					match[1] !== 'const' && match[1] !== 'let' && match[1] !== 'var') {
					symbols.push(this._makeSymbol(match[1], SymbolKind.Method, uri, i, line, currentClass, false, false));
				}
			}
		}
	}

	private _extractPythonSymbols(uri: string, lines: string[], symbols: IIndexedSymbol[]): void {
		const classStack: Array<{ name: string; indent: number }> = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			if (trimmed.startsWith('#') || trimmed.length === 0) { continue; }

			const indent = line.length - line.trimStart().length;

			// Pop classes that are no longer in scope
			while (classStack.length > 0 && indent <= classStack[classStack.length - 1].indent) {
				classStack.pop();
			}

			const currentClass = classStack.length > 0 ? classStack[classStack.length - 1].name : undefined;

			let match = /^(\s*)class\s+(\w+)/.exec(line);
			if (match) {
				classStack.push({ name: match[2], indent });
				symbols.push(this._makeSymbol(match[2], SymbolKind.Class, uri, i, line, currentClass, true, false));
				continue;
			}

			match = /^(\s*)(?:async\s+)?def\s+(\w+)/.exec(line);
			if (match) {
				const kind = currentClass ? SymbolKind.Method : SymbolKind.Function;
				const isPrivate = match[2].startsWith('_') && !match[2].startsWith('__');
				symbols.push(this._makeSymbol(match[2], kind, uri, i, line, currentClass, !isPrivate, false));
			}
		}
	}

	private _extractGoSymbols(uri: string, lines: string[], symbols: IIndexedSymbol[]): void {
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			if (trimmed.startsWith('//')) { continue; }

			let match = /^func\s+(?:\((\w+)\s+\*?(\w+)\)\s+)?(\w+)/.exec(trimmed);
			if (match) {
				const receiver = match[2];
				const name = match[3];
				const isExported = name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase();
				symbols.push(this._makeSymbol(name, SymbolKind.Function, uri, i, line, receiver, isExported, false));
				continue;
			}

			match = /^type\s+(\w+)\s+(struct|interface|func)/.exec(trimmed);
			if (match) {
				const kind = match[2] === 'interface' ? SymbolKind.Interface :
					match[2] === 'struct' ? SymbolKind.Struct : SymbolKind.TypeParameter;
				const isExported = match[1][0] === match[1][0].toUpperCase() && match[1][0] !== match[1][0].toLowerCase();
				symbols.push(this._makeSymbol(match[1], kind, uri, i, line, undefined, isExported, false));
				continue;
			}

			match = /^(?:var|const)\s+(\w+)/.exec(trimmed);
			if (match) {
				const isExported = match[1][0] === match[1][0].toUpperCase() && match[1][0] !== match[1][0].toLowerCase();
				symbols.push(this._makeSymbol(match[1], SymbolKind.Variable, uri, i, line, undefined, isExported, false));
			}
		}
	}

	private _extractRustSymbols(uri: string, lines: string[], symbols: IIndexedSymbol[]): void {
		let currentImpl: string | undefined;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			if (trimmed.startsWith('//')) { continue; }

			let match = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/.exec(trimmed);
			if (match) {
				const isExported = trimmed.startsWith('pub');
				symbols.push(this._makeSymbol(match[1], SymbolKind.Function, uri, i, line, currentImpl, isExported, false));
				continue;
			}

			match = /^(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/.exec(trimmed);
			if (match) {
				symbols.push(this._makeSymbol(match[1], SymbolKind.Struct, uri, i, line, undefined, trimmed.startsWith('pub'), false));
				continue;
			}

			match = /^(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/.exec(trimmed);
			if (match) {
				symbols.push(this._makeSymbol(match[1], SymbolKind.Enum, uri, i, line, undefined, trimmed.startsWith('pub'), false));
				continue;
			}

			match = /^(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/.exec(trimmed);
			if (match) {
				symbols.push(this._makeSymbol(match[1], SymbolKind.Interface, uri, i, line, undefined, trimmed.startsWith('pub'), false));
				continue;
			}

			match = /^impl(?:<[^>]*>)?\s+(\w+)/.exec(trimmed);
			if (match) {
				currentImpl = match[1];
				continue;
			}

			if (trimmed === '}' && currentImpl) {
				currentImpl = undefined;
			}
		}
	}

	private _extractCSymbols(uri: string, lines: string[], symbols: IIndexedSymbol[]): void {
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*')) { continue; }

			// Function: return_type name(params) {
			const match = /^(?:(?:static|inline|extern|const|unsigned|signed|volatile|struct|enum)\s+)*(?:[\w*]+\s+)+(\w+)\s*\([^;]*\)\s*\{?\s*$/.exec(trimmed);
			if (match && !['if', 'for', 'while', 'switch', 'return', 'sizeof', 'typeof'].includes(match[1])) {
				const isStatic = trimmed.startsWith('static');
				symbols.push(this._makeSymbol(match[1], SymbolKind.Function, uri, i, line, undefined, !isStatic, false));
				continue;
			}

			// Typedef struct/enum
			const tdMatch = /^typedef\s+(?:struct|enum)\s*(?:\w+\s*)?\{/.exec(trimmed);
			if (tdMatch) {
				// Look ahead for closing } name;
				for (let j = i + 1; j < Math.min(i + 100, lines.length); j++) {
					const closingMatch = /^\}\s*(\w+)\s*;/.exec(lines[j].trim());
					if (closingMatch) {
						symbols.push(this._makeSymbol(closingMatch[1], SymbolKind.Struct, uri, i, line, undefined, true, false));
						break;
					}
				}
			}

			// #define macros
			const defMatch = /^#define\s+(\w+)/.exec(trimmed);
			if (defMatch) {
				symbols.push(this._makeSymbol(defMatch[1], SymbolKind.Constant, uri, i, line, undefined, true, false));
			}
		}
	}

	private _extractJavaKotlinSymbols(uri: string, lines: string[], symbols: IIndexedSymbol[]): void {
		let currentClass: string | undefined;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('@')) { continue; }

			let match = /^(?:(?:public|private|protected|static|final|abstract|sealed|open|data|internal)\s+)*(?:class|interface|enum|object)\s+(\w+)/.exec(trimmed);
			if (match) {
				currentClass = match[1];
				const kind = trimmed.includes('interface') ? SymbolKind.Interface :
					trimmed.includes('enum') ? SymbolKind.Enum : SymbolKind.Class;
				const isPublic = !trimmed.includes('private') && !trimmed.includes('protected');
				symbols.push(this._makeSymbol(match[1], kind, uri, i, line, undefined, isPublic, false));
				continue;
			}

			match = /^(?:(?:public|private|protected|static|final|abstract|override|suspend|open|internal)\s+)*(?:fun\s+)?(\w+)\s*\(/.exec(trimmed);
			if (match && currentClass && match[1] !== 'if' && match[1] !== 'for' && match[1] !== 'while') {
				symbols.push(this._makeSymbol(match[1], SymbolKind.Method, uri, i, line, currentClass, !trimmed.includes('private'), false));
			}
		}
	}

	private _extractCSharpSymbols(uri: string, lines: string[], symbols: IIndexedSymbol[]): void {
		let currentClass: string | undefined;
		let namespacePrefix = '';

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('[')) { continue; }

			let match = /^namespace\s+([\w.]+)/.exec(trimmed);
			if (match) { namespacePrefix = match[1]; continue; }

			match = /^(?:(?:public|private|protected|internal|static|sealed|abstract|partial)\s+)*(?:class|interface|struct|record|enum)\s+(\w+)/.exec(trimmed);
			if (match) {
				currentClass = match[1];
				const kind = trimmed.includes('interface') ? SymbolKind.Interface :
					trimmed.includes('enum') ? SymbolKind.Enum :
						trimmed.includes('struct') ? SymbolKind.Struct : SymbolKind.Class;
				symbols.push(this._makeSymbol(match[1], kind, uri, i, line, namespacePrefix || undefined, !trimmed.includes('private'), false));
				continue;
			}

			match = /^(?:(?:public|private|protected|internal|static|override|virtual|async|abstract)\s+)+\w+(?:<[^>]+>)?\s+(\w+)\s*\(/.exec(trimmed);
			if (match && currentClass) {
				symbols.push(this._makeSymbol(match[1], SymbolKind.Method, uri, i, line, currentClass, !trimmed.includes('private'), false));
			}
		}
	}

	private _extractRubySymbols(uri: string, lines: string[], symbols: IIndexedSymbol[]): void {
		const moduleStack: string[] = [];

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (trimmed.startsWith('#')) { continue; }

			let match = /^(?:class|module)\s+(\w+(?:::\w+)*)/.exec(trimmed);
			if (match) {
				moduleStack.push(match[1]);
				symbols.push(this._makeSymbol(match[1], SymbolKind.Class, uri, i, lines[i], moduleStack.length > 1 ? moduleStack[moduleStack.length - 2] : undefined, true, false));
				continue;
			}

			match = /^def\s+(self\.)?(\w+[?!=]?)/.exec(trimmed);
			if (match) {
				const container = moduleStack.length > 0 ? moduleStack[moduleStack.length - 1] : undefined;
				symbols.push(this._makeSymbol(match[2], SymbolKind.Method, uri, i, lines[i], container, !match[2].startsWith('_'), false));
				continue;
			}

			if (trimmed === 'end' && moduleStack.length > 0) {
				moduleStack.pop();
			}
		}
	}

	private _extractPHPSymbols(uri: string, lines: string[], symbols: IIndexedSymbol[]): void {
		let currentClass: string | undefined;

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) { continue; }

			let match = /^(?:abstract\s+|final\s+)?class\s+(\w+)/.exec(trimmed);
			if (match) {
				currentClass = match[1];
				symbols.push(this._makeSymbol(match[1], SymbolKind.Class, uri, i, lines[i], undefined, true, false));
				continue;
			}

			match = /^interface\s+(\w+)/.exec(trimmed);
			if (match) {
				symbols.push(this._makeSymbol(match[1], SymbolKind.Interface, uri, i, lines[i], undefined, true, false));
				continue;
			}

			match = /^(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+(\w+)/.exec(trimmed);
			if (match) {
				symbols.push(this._makeSymbol(match[1], currentClass ? SymbolKind.Method : SymbolKind.Function, uri, i, lines[i], currentClass, !trimmed.includes('private'), false));
			}
		}
	}

	private _extractSwiftSymbols(uri: string, lines: string[], symbols: IIndexedSymbol[]): void {
		let currentType: string | undefined;

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (trimmed.startsWith('//')) { continue; }

			let match = /^(?:(?:public|private|internal|open|fileprivate)\s+)?(?:final\s+)?(?:class|struct|enum|protocol|actor)\s+(\w+)/.exec(trimmed);
			if (match) {
				currentType = match[1];
				const kind = trimmed.includes('protocol') ? SymbolKind.Interface :
					trimmed.includes('enum') ? SymbolKind.Enum : SymbolKind.Class;
				symbols.push(this._makeSymbol(match[1], kind, uri, i, lines[i], undefined, !trimmed.includes('private') && !trimmed.includes('fileprivate'), false));
				continue;
			}

			match = /^(?:(?:public|private|internal|open|fileprivate|static|class|override|mutating)\s+)*func\s+(\w+)/.exec(trimmed);
			if (match) {
				symbols.push(this._makeSymbol(match[1], SymbolKind.Function, uri, i, lines[i], currentType, !trimmed.includes('private'), false));
			}
		}
	}

	private _extractGenericSymbols(uri: string, lines: string[], symbols: IIndexedSymbol[]): void {
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();

			// Generic function-like pattern
			const match = /^(?:(?:pub|public|export|def|fn|func|function|sub|proc)\s+)(\w+)/.exec(trimmed);
			if (match) {
				symbols.push(this._makeSymbol(match[1], SymbolKind.Function, uri, i, lines[i], undefined, true, false));
			}
		}
	}

	private _makeSymbol(
		name: string, kind: SymbolKind, uri: string, line: number,
		lineContent: string, container: string | undefined,
		isExported: boolean, isDefault: boolean,
	): IIndexedSymbol {
		return {
			name,
			kind,
			filePath: uri,
			range: { startLine: line + 1, startCol: 0, endLine: line + 1, endCol: lineContent.length },
			containerName: container,
			exportedAs: isExported ? name : undefined,
			isDefault,
			references: [],
		};
	}

	// ─── Import Extraction ──────────────────────────────────────────────────────

	private _extractImports(uri: string, content: string): Set<string> {
		const imports = new Set<string>();
		const ext = this._extname(uri);
		const dirPath = uri.substring(0, uri.lastIndexOf('/'));

		switch (ext) {
			case '.ts': case '.tsx': case '.js': case '.jsx':
			case '.mts': case '.cts': case '.mjs': case '.cjs':
			case '.vue': case '.svelte':
				this._extractJSImports(content, dirPath, imports);
				break;
			case '.py': case '.pyi':
				this._extractPythonImports(content, dirPath, imports);
				break;
			case '.go':
				this._extractGoImports(content, imports);
				break;
			case '.rs':
				this._extractRustImports(content, imports);
				break;
			case '.c': case '.h': case '.cpp': case '.hpp': case '.cc': case '.hh':
				this._extractCIncludes(content, dirPath, imports);
				break;
			case '.java': case '.kt': case '.kts':
				this._extractJavaImports(content, imports);
				break;
			case '.cs':
				this._extractCSharpUsings(content, imports);
				break;
			case '.rb':
				this._extractRubyRequires(content, dirPath, imports);
				break;
			case '.php':
				this._extractPHPUses(content, imports);
				break;
			case '.swift':
				this._extractSwiftImports(content, imports);
				break;
		}

		return imports;
	}

	private _extractJSImports(content: string, dirPath: string, imports: Set<string>): void {
		// Static imports/exports
		const staticImport = /(?:import|export)\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g;
		let match;
		while ((match = staticImport.exec(content)) !== null) {
			const resolved = this._resolveJSPath(dirPath, match[1]);
			if (resolved) { imports.add(resolved); }
		}

		// Dynamic imports
		const dynamicImport = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
		while ((match = dynamicImport.exec(content)) !== null) {
			const resolved = this._resolveJSPath(dirPath, match[1]);
			if (resolved) { imports.add(resolved); }
		}

		// Require
		const requireCall = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
		while ((match = requireCall.exec(content)) !== null) {
			const resolved = this._resolveJSPath(dirPath, match[1]);
			if (resolved) { imports.add(resolved); }
		}
	}

	private _extractPythonImports(content: string, dirPath: string, imports: Set<string>): void {
		const fromImport = /^from\s+(\S+)\s+import/gm;
		const plainImport = /^import\s+(\S+)/gm;
		let match;

		while ((match = fromImport.exec(content)) !== null) {
			if (match[1].startsWith('.')) {
				const resolved = this._resolvePythonRelative(dirPath, match[1]);
				if (resolved) { imports.add(resolved); }
			} else {
				imports.add(`python:${match[1]}`);
			}
		}

		while ((match = plainImport.exec(content)) !== null) {
			const mod = match[1].split(',')[0].trim();
			if (mod.startsWith('.')) {
				const resolved = this._resolvePythonRelative(dirPath, mod);
				if (resolved) { imports.add(resolved); }
			} else {
				imports.add(`python:${mod}`);
			}
		}
	}

	private _extractGoImports(content: string, imports: Set<string>): void {
		// Single import
		const single = /^import\s+"([^"]+)"/gm;
		let match;
		while ((match = single.exec(content)) !== null) {
			imports.add(`go:${match[1]}`);
		}

		// Import block
		const block = /import\s*\(([\s\S]*?)\)/g;
		while ((match = block.exec(content)) !== null) {
			const lines = match[1].split('\n');
			for (const line of lines) {
				const pathMatch = /"([^"]+)"/.exec(line.trim());
				if (pathMatch) { imports.add(`go:${pathMatch[1]}`); }
			}
		}
	}

	private _extractRustImports(content: string, imports: Set<string>): void {
		const useStmt = /^use\s+([\w:]+)/gm;
		let match;
		while ((match = useStmt.exec(content)) !== null) {
			imports.add(`rust:${match[1]}`);
		}

		const externCrate = /^extern\s+crate\s+(\w+)/gm;
		while ((match = externCrate.exec(content)) !== null) {
			imports.add(`rust:${match[1]}`);
		}
	}

	private _extractCIncludes(content: string, dirPath: string, imports: Set<string>): void {
		const localInclude = /^#include\s*"([^"]+)"/gm;
		const sysInclude = /^#include\s*<([^>]+)>/gm;
		let match;

		while ((match = localInclude.exec(content)) !== null) {
			imports.add(dirPath + '/' + match[1]);
		}
		while ((match = sysInclude.exec(content)) !== null) {
			imports.add(`system:${match[1]}`);
		}
	}

	private _extractJavaImports(content: string, imports: Set<string>): void {
		const importStmt = /^import\s+(?:static\s+)?([\w.]+)/gm;
		let match;
		while ((match = importStmt.exec(content)) !== null) {
			imports.add(`java:${match[1]}`);
		}
	}

	private _extractCSharpUsings(content: string, imports: Set<string>): void {
		const usingStmt = /^using\s+(?:static\s+)?([\w.]+)/gm;
		let match;
		while ((match = usingStmt.exec(content)) !== null) {
			imports.add(`csharp:${match[1]}`);
		}
	}

	private _extractRubyRequires(content: string, dirPath: string, imports: Set<string>): void {
		const req = /^(?:require|require_relative|load)\s+['"]([^'"]+)['"]/gm;
		let match;
		while ((match = req.exec(content)) !== null) {
			if (match[0].includes('require_relative')) {
				imports.add(dirPath + '/' + match[1] + '.rb');
			} else {
				imports.add(`ruby:${match[1]}`);
			}
		}
	}

	private _extractPHPUses(content: string, imports: Set<string>): void {
		const useStmt = /^use\s+([\w\\]+)/gm;
		let match;
		while ((match = useStmt.exec(content)) !== null) {
			imports.add(`php:${match[1]}`);
		}
	}

	private _extractSwiftImports(content: string, imports: Set<string>): void {
		const importStmt = /^import\s+(?:class|struct|enum|protocol|func|var|typealias)?\s*(\w+)/gm;
		let match;
		while ((match = importStmt.exec(content)) !== null) {
			imports.add(`swift:${match[1]}`);
		}
	}

	// ─── Path Resolution ────────────────────────────────────────────────────────

	private _resolveJSPath(dirPath: string, specifier: string): string | undefined {
		if (!specifier.startsWith('.') && !specifier.startsWith('/')) { return undefined; }

		// Strip query string and hash
		const cleanSpec = specifier.split('?')[0].split('#')[0];

		// Strip known extensions for normalization (we'll resolve without)
		const stripped = cleanSpec.replace(/\.(js|ts|tsx|jsx|mts|cts|mjs|cjs|vue|svelte|json)$/, '');
		return this._joinPath(dirPath, stripped);
	}

	private _resolvePythonRelative(dirPath: string, specifier: string): string | undefined {
		const dotsMatch = specifier.match(/^(\.+)/);
		if (!dotsMatch) { return undefined; }

		const dots = dotsMatch[1].length;
		let base = dirPath;
		for (let i = 1; i < dots; i++) {
			const lastSlash = base.lastIndexOf('/');
			if (lastSlash === -1) { return undefined; }
			base = base.substring(0, lastSlash);
		}

		const rest = specifier.slice(dots).replace(/\./g, '/');
		if (!rest) { return base + '/__init__.py'; }
		return base + '/' + rest + '.py';
	}

	private _joinPath(base: string, relative: string): string {
		const parts = base.split('/');
		const relParts = relative.split('/');

		for (const part of relParts) {
			if (part === '' || part === '.') { continue; }
			else if (part === '..') { if (parts.length > 1) { parts.pop(); } }
			else { parts.push(part); }
		}

		return parts.join('/');
	}

	// ─── Utilities ──────────────────────────────────────────────────────────────

	private _extname(pathOrUri: string): string {
		const lastSlash = pathOrUri.lastIndexOf('/');
		const basename = lastSlash >= 0 ? pathOrUri.slice(lastSlash + 1) : pathOrUri;
		const lastDot = basename.lastIndexOf('.');
		if (lastDot <= 0) { return ''; }
		return basename.slice(lastDot);
	}

	// FNV-1a 32-bit hash — fast, low collision for content-change detection
	private _hashContent(content: string): number {
		let hash = 0x811c9dc5;
		for (let i = 0; i < content.length; i++) {
			hash ^= content.charCodeAt(i);
			hash = Math.imul(hash, 0x01000193);
		}
		return hash >>> 0;
	}

	override dispose(): void {
		if (this._initialIndexTimeout) {
			clearTimeout(this._initialIndexTimeout);
			this._initialIndexTimeout = undefined;
		}
		this._cancelFullIndex();
		super.dispose();
	}
}

registerSingleton(IWorkspaceSymbolIndexService, WorkspaceSymbolIndexService, InstantiationType.Eager);
