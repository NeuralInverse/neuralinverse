/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IMarkerService } from '../../../../../platform/markers/common/markers.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { relativePath, dirname } from '../../../../../base/common/resources.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { isWindows } from '../../../../../base/common/platform.js';

import { LSPCollector } from './lsp/lspCollector.js';
import { ASTCollector } from './ast/astCollector.js';
import { CallHierarchyCollector } from './callHierarchy/callHierarchyCollector.js';
import { MetricsCollector } from './metrics/metricsCollector.js';
import { CapabilitiesCollector } from './capabilities/capabilitiesCollector.js';
import { HoverCollector } from './hover/hoverCollector.js';
import { ReferenceCollector } from './references/referenceCollector.js';
import { InlayHintCollector } from './inlayHints/inlayHintCollector.js';
import { DefinitionCollector } from './definitions/definitionCollector.js';
import { EncryptionService } from './encryptionService.js';
import { HistoryService } from './historyService.js';
import { withInverseWriteAccess } from '../engine/utils/inverseFs.js';

export interface IDashboardState {
	metrics: {
		totalLines: number;
		totalSymbols: number;
		avgComplexity: number;
	};
	capabilities: Set<string>;
	stats: {
		filesAnalyzed: number;
		functions: number;
		classes: number;
	};
	lastScan: string;
}

export class ProjectAnalyzer extends Disposable {
	public readonly inverseDir: URI;
	public readonly encryptionService: EncryptionService;
	public readonly historyService: HistoryService;
	private readonly lspCollector: LSPCollector;
	private readonly astCollector: ASTCollector;
	private readonly callHierarchyCollector: CallHierarchyCollector;
	private readonly metricsCollector: MetricsCollector;
	private readonly capabilitiesCollector: CapabilitiesCollector;
	private readonly hoverCollector: HoverCollector;
	private readonly referenceCollector: ReferenceCollector;
	private readonly inlayHintCollector: InlayHintCollector;
	private readonly definitionCollector: DefinitionCollector;

	private dashboardState: IDashboardState = {
		metrics: { totalLines: 0, totalSymbols: 0, avgComplexity: 0 },
		capabilities: new Set<string>(),
		stats: { filesAnalyzed: 0, functions: 0, classes: 0 },
		lastScan: 'Never'
	};

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IMarkerService private readonly markerService: IMarkerService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super();
		const workspaceFolder = this.workspaceContextService.getWorkspace().folders[0];
		if (!workspaceFolder) {
			throw new Error('No workspace folder found');
		}
		this.inverseDir = URI.joinPath(workspaceFolder.uri, '.inverse');
		this.encryptionService = new EncryptionService(this.inverseDir, fileService);
		this.historyService = new HistoryService(this.inverseDir, fileService, terminalService, this.encryptionService);

		// Initialize modular collectors
		this.lspCollector = new LSPCollector(languageFeaturesService);
		this.astCollector = new ASTCollector(languageFeaturesService);
		this.callHierarchyCollector = new CallHierarchyCollector(languageFeaturesService);
		this.metricsCollector = new MetricsCollector();
		this.capabilitiesCollector = new CapabilitiesCollector();
		this.hoverCollector = new HoverCollector(languageFeaturesService);
		this.referenceCollector = new ReferenceCollector(languageFeaturesService);
		this.inlayHintCollector = new InlayHintCollector(languageFeaturesService);
		this.definitionCollector = new DefinitionCollector(languageFeaturesService);
	}

	public async analyzeProject(): Promise<void> {
		await this.analyzeWorkspace();
	}

	public async analyzeWorkspace(): Promise<void> {
		console.log('Starting full workspace analysis...');

		// Reset Dashboard State
		this.dashboardState = {
			metrics: { totalLines: 0, totalSymbols: 0, avgComplexity: 0 },
			capabilities: new Set<string>(),
			stats: { filesAnalyzed: 0, functions: 0, classes: 0 },
			lastScan: new Date().toISOString()
		};

		try {
			// Protection: Hide folder and Unlock for writing
			await this.hideInverseFolder();
			await this.setReadOnly(false);

			await this.ensureDirectories();
			await this.ensureGitIgnore();
			await this.encryptionService.init();

			const folders = this.workspaceContextService.getWorkspace().folders;
			const allFiles: URI[] = [];

			for (const folder of folders) {
				const files = await this.crawl(folder.uri);
				allFiles.push(...files);
			}

			console.log(`Found ${allFiles.length} files to analyze.`);
			await this.processQueue(allFiles);
			console.log('Workspace analysis complete.');
		} finally {
			// Protection: Re-lock files
			await this.setReadOnly(true);
		}
	}

	public getAnalysisState(): any {
		return {
			...this.dashboardState,
			capabilities: Array.from(this.dashboardState.capabilities) // Convert Set to Array for messaging
		};
	}

	public async getDetailedAnalysis(resource: URI): Promise<any> {
		// 1. Fetch Cached Data
		const metrics = await this.readData('metrics', resource);
		const capabilities = await this.readData('capabilities', resource);
		const lsp = await this.readData('lsp', resource);
		const callHierarchy = await this.readData('call_hierarchy', resource);
		const ast = await this.readData('ast', resource);
		const audit = await this.readData('audit', resource);
		const hover = await this.readData('hover', resource);
		const references = await this.readData('references', resource);
		const inlayHints = await this.readData('inlay_hints', resource);
		const definitions = await this.readData('definitions', resource);

		// 2. Diagnostics \u2014 read TS compiler markers (MarkerSeverity: Error=8, Warning=4)
		const markers = this.markerService.read({ resource });
		const tsMarkers = markers.filter(m => m.owner === 'typescript');
		const diagnostics = {
			errorCount: tsMarkers.filter(m => m.severity === 8).length,
			warningCount: tsMarkers.filter(m => m.severity === 4).length,
		};
		// Raw markers passed through for INanoAgentContext.diagnostics.errors[] population
		const rawMarkers = tsMarkers.map(m => ({
			severity: m.severity,
			message: m.message,
			startLineNumber: m.startLineNumber,
		}));

		// 3. File Stats (Change Surface)
		let fileStat: any = {};
		try {
			const stat = await this.fileService.resolve(resource);
			fileStat = {
				size: stat.size,
				mtime: stat.mtime
			};
		} catch (e) { }

		return {
			resource: resource.toString(),
			metrics,
			capabilities,
			lsp,
			callHierarchy,
			ast,
			audit,
			hover,
			references,
			inlayHints,
			definitions,
			diagnostics,
			rawMarkers,
			fileStat
		};
	}

	private async readData(category: string, resource: URI): Promise<any | undefined> {
		const folder = this.workspaceContextService.getWorkspaceFolder(resource);
		let relativePathStr = '';
		if (folder) {
			const rel = relativePath(folder.uri, resource);
			if (rel) relativePathStr = rel;
		} else {
			relativePathStr = resource.path.split('/').pop() || 'unknown';
		}

		const targetUri = URI.joinPath(this.inverseDir, category, relativePathStr + '.json');
		try {
			if (await this.fileService.exists(targetUri)) {
				const content = await this.fileService.readFile(targetUri);
				const encrypted = content.value.toString();
				const decrypted = await this.encryptionService.decrypt(encrypted);
				return JSON.parse(decrypted);
			}
		} catch (e) { }
		return undefined;
	}

	private async crawl(dir: URI): Promise<URI[]> {
		const result: URI[] = [];
		try {
			const stat = await this.fileService.resolve(dir, { resolveMetadata: true });
			if (stat.children) {
				for (const child of stat.children) {
					if (child.isDirectory) {
						if (['node_modules', '.git', '.inverse', 'dist', 'out', 'build'].includes(child.name)) {
							continue;
						}
						result.push(...await this.crawl(child.resource));
					} else if (child.isFile) {
						const ext = child.name.split('.').pop()?.toLowerCase();
						if (['ts', 'js', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'php', 'html', 'css', 'json'].includes(ext || '')) {
							result.push(child.resource);
						}
					}
				}
			}
		} catch (e) {
			// console.warn('Failed to resolve directory:', dir.toString(), e);
		}
		return result;
	}

	private async processQueue(files: URI[], concurrency: number = 5): Promise<void> {
		const queue = [...files];
		let activeCount = 0;
		let index = 0;

		return new Promise((resolve) => {
			const worker = async () => {
				while (activeCount < concurrency && index < files.length) {
					const file = queue[index++];
					activeCount++;
					this.analyzeFile(file).finally(() => {
						activeCount--;
						worker();
					});
				}
				if (activeCount === 0 && index === files.length) {
					resolve();
				}
			};

			for (let i = 0; i < concurrency && i < files.length; i++) {
				worker();
			}
			if (files.length === 0) {
				resolve();
			}
		});
	}

	public async analyzeFile(resource: URI): Promise<void> {
		if (this.relativePathHasInverse(resource)) return;

		try {
			const ref = await this.textModelService.createModelReference(resource);
			const model = ref.object.textEditorModel;

			// Delegate to modular collectors
			const lspData = await this.lspCollector.collect(model);

			const [astData, callHierarchyData, metricsData, capabilitiesData] = await Promise.all([
				this.astCollector.collect(model),
				this.callHierarchyCollector.collect(model),
				this.metricsCollector.collect(model, lspData),
				this.capabilitiesCollector.collect(model, lspData)
			]);

			// New: rich language server data collectors (hover types, references, inlay hints, definitions)
			// These run after the base collectors so they can reuse lspData symbols.
			// They're best-effort \u2014 failure is non-fatal.
			const symbolsForRich = lspData ?? [];
			const [hoverData, referenceData, inlayHintData, definitionData] = await Promise.all([
				this.hoverCollector.collect(model, symbolsForRich).catch(() => []),
				this.referenceCollector.collect(model, symbolsForRich).catch(() => []),
				this.inlayHintCollector.collect(model).catch(() => []),
				this.definitionCollector.collect(model, symbolsForRich).catch(() => []),
			]);

			// Save results if they exist
			if (lspData) await this.saveData('lsp', resource, lspData);
			if (astData) await this.saveData('ast', resource, astData);
			if (callHierarchyData) await this.saveData('call_hierarchy', resource, callHierarchyData);
			if (metricsData) await this.saveData('metrics', resource, metricsData);
			if (capabilitiesData) await this.saveData('capabilities', resource, capabilitiesData);
			if (hoverData?.length) await this.saveData('hover', resource, hoverData);
			if (referenceData?.length) await this.saveData('references', resource, referenceData);
			if (inlayHintData?.length) await this.saveData('inlay_hints', resource, inlayHintData);
			if (definitionData?.length) await this.saveData('definitions', resource, definitionData);
			// Audit data is saved separately by the intelligence service, so we don't overwrite it here.

			// Aggregate Dashboard State
			this.dashboardState.stats.filesAnalyzed++;
			if (metricsData) {
				this.dashboardState.metrics.totalLines += metricsData.lineCount || 0;
				this.dashboardState.metrics.totalSymbols += metricsData.symbolCount || 0;
				this.dashboardState.stats.functions += metricsData.functions || 0;
				this.dashboardState.stats.classes += metricsData.classes || 0;
				this.dashboardState.metrics.avgComplexity = 0; // Placeholder until complexity logic is added
			}
			if (capabilitiesData) {
				if (capabilitiesData.hasAsync) this.dashboardState.capabilities.add('Async/Await');
				if (capabilitiesData.hasClasses) this.dashboardState.capabilities.add('Object Oriented');
				if (capabilitiesData.isTestFile) this.dashboardState.capabilities.add('Testing');
				if (capabilitiesData.hasInterfaces) this.dashboardState.capabilities.add('TypeScript Interfaces');
			}

			ref.dispose();
		} catch (error) {
			// console.error('Error analyzing file:', resource.toString(), error);
		}
	}

	private relativePathHasInverse(resource: URI): boolean {
		const folder = this.workspaceContextService.getWorkspaceFolder(resource);
		if (folder) {
			const rel = relativePath(folder.uri, resource);
			return rel?.startsWith('.inverse/') || false;
		}
		return false;
	}

	private async ensureDirectories(): Promise<void> {
		const dirs = ['lsp', 'ast', 'call_hierarchy', 'metrics', 'capabilities', 'frameworks', 'audit', 'hover', 'references', 'inlay_hints', 'definitions'];
		try {
			await this.fileService.createFolder(this.inverseDir);
		} catch (e) { /* ignore if exists */ }

		for (const dir of dirs) {
			try {
				await this.fileService.createFolder(URI.joinPath(this.inverseDir, dir));
			} catch (e) { /* ignore if exists */ }
		}
	}

	private async saveData(category: string, resource: URI, data: any): Promise<void> {
		const folder = this.workspaceContextService.getWorkspaceFolder(resource);
		let relativePathStr = '';

		if (folder) {
			const rel = relativePath(folder.uri, resource);
			if (rel) {
				relativePathStr = rel;
			}
		} else {
			relativePathStr = resource.path.split('/').pop() || 'unknown';
		}

		// internal path structure: category/path/to/file.json
		// e.g. .inverse/lsp/src/vs/workbench/foo.ts.json
		const targetUri = URI.joinPath(this.inverseDir, category, relativePathStr + '.json');
		const targetDir = dirname(targetUri);

		await this.createDirectoryRecursively(targetDir);

		const content = JSON.stringify(data, null, 2);

		// Optimization: Check if content has actually changed before writing
		// Since encryption uses random IV, distinct writes of the same data produce different files on disk,
		// triggering unnecessary git commits.
		try {
			const exists = await this.fileService.exists(targetUri);
			if (exists) {
				const existingBuffer = await this.fileService.readFile(targetUri);
				const existingEncrypted = existingBuffer.value.toString();
				const existingDecrypted = await this.encryptionService.decrypt(existingEncrypted);
				if (existingDecrypted === content) {
					// No changes in semantic content, skip write to preserve disk file (and git status)
					return;
				}
			}
		} catch (e) {
			// verification failed, proceed to write just in case
		}

		const encryptedContent = await this.encryptionService.encrypt(content);
		try {
			await this.fileService.writeFile(targetUri, VSBuffer.fromString(encryptedContent));
		} catch (writeErr: any) {
			// EACCES: .inverse dir may still be locked \u2014 re-chmod and retry once
			const isPermError = writeErr?.code === 'EACCES' || writeErr?.code === 'NoPermissions'
				|| (writeErr?.message && writeErr.message.includes('EACCES'));
			if (isPermError) {
				console.warn(`[ProjectAnalyzer] EACCES writing ${targetUri.path} \u2014 re-chmod and retry`);
				await withInverseWriteAccess(this.inverseDir.fsPath, async () => {
					await this.fileService.writeFile(targetUri, VSBuffer.fromString(encryptedContent));
				});
			} else {
				throw writeErr;
			}
		}
	}

	public async loadAuditData(resource: URI): Promise<any[]> {
		const folder = this.workspaceContextService.getWorkspaceFolder(resource);
		const relativePathStr = folder
			? (relativePath(folder.uri, resource) || '')
			: (resource.path.split('/').pop() || 'unknown');
		const targetUri = URI.joinPath(this.inverseDir, 'audit', relativePathStr + '.json');

		try {
			if (!(await this.fileService.exists(targetUri))) {
				return [];
			}
			const buffer = await this.fileService.readFile(targetUri);
			const decrypted = await this.encryptionService.decrypt(buffer.value.toString());
			const data = JSON.parse(decrypted);
			return Array.isArray(data) ? data : [];
		} catch (e) {
			return [];
		}
	}

	public async saveAuditData(resource: URI, violations: any[]): Promise<void> {
		if (violations.length === 0) {
			await this.clearAuditData(resource);
			return;
		}

		await withInverseWriteAccess(this.inverseDir.fsPath, async () => {
			await this.saveData('audit', resource, violations);
		});
	}

	public async clearAuditData(resource: URI): Promise<void> {
		const folder = this.workspaceContextService.getWorkspaceFolder(resource);
		let relativePathStr = folder ? (relativePath(folder.uri, resource) || '') : (resource.path.split('/').pop() || 'unknown');
		const targetUri = URI.joinPath(this.inverseDir, 'audit', relativePathStr + '.json');

		await withInverseWriteAccess(this.inverseDir.fsPath, async () => {
			if (await this.fileService.exists(targetUri)) {
				await this.fileService.del(targetUri);
			}
		});
	}

	private async createDirectoryRecursively(dir: URI): Promise<void> {
		try {
			await this.fileService.createFolder(dir);
			return; // Success
		} catch (error: any) {
			// If it already exists, we are good.
			try {
				const stat = await this.fileService.resolve(dir);
				if (stat.isDirectory) return;
			} catch (_e) {
				// Doesn't exist \u2014 continue
			}

			// EACCES: .inverse is write-locked. Re-chmod and retry.
			const isPermError = error?.code === 'EACCES' || error?.code === 'NoPermissions'
				|| (error?.message && error.message.includes('EACCES'));
			if (isPermError) {
				console.warn(`[ProjectAnalyzer] EACCES creating dir ${dir.path} \u2014 re-chmod and retry`);
				await withInverseWriteAccess(this.inverseDir.fsPath, async () => {
					// After chmod, create parent chain then target
					const parent = dirname(dir);
					if (parent.path !== dir.path) {
						try { await this.fileService.createFolder(parent); } catch (_e) { /* may exist */ }
					}
					await this.fileService.createFolder(dir);
				});
				return;
			}

			// Parent might be missing (non-perm error)
			const parent = dirname(dir);
			if (parent.path !== dir.path) {
				await this.createDirectoryRecursively(parent);

				// Retry creation
				try {
					await this.fileService.createFolder(dir);
				} catch (_e) {
					// Ignore if it races and exists now
				}
			}
		}
	}

	// Shadow Git Implementation

	private async ensureGitIgnore(): Promise<void> {
		const workspaceFolder = this.workspaceContextService.getWorkspace().folders[0];
		if (!workspaceFolder) return;

		const gitIgnoreFile = URI.joinPath(workspaceFolder.uri, '.gitignore');
		try {
			const content = await this.fileService.readFile(gitIgnoreFile);
			const text = content.value.toString();
			if (!text.includes('.inverse')) {
				const newText = text + '\n.inverse\n';
				await this.fileService.writeFile(gitIgnoreFile, VSBuffer.fromString(newText));
				console.log('Added .inverse to .gitignore');
			}
		} catch (e) {
			try {
				await this.fileService.writeFile(gitIgnoreFile, VSBuffer.fromString('.inverse\n'));
			} catch (err) { }
		}

		// Ensure .inverse/.gitignore exists and ignores .key
		const inverseGitIgnore = URI.joinPath(this.inverseDir, '.gitignore');
		try {
			const content = await this.fileService.readFile(inverseGitIgnore);
			if (!content.value.toString().includes('.key')) {
				await this.fileService.writeFile(inverseGitIgnore, VSBuffer.fromString(content.value.toString() + '\n.key\n'));
			}
		} catch (e) {
			try {
				await this.fileService.writeFile(inverseGitIgnore, VSBuffer.fromString('.key\n'));
			} catch (e) { }
		}
	}

	private async getTerminal() {
		const terminalName = 'Nano Agent Ops';
		let terminal = this.terminalService.instances.find(t => t.title === terminalName);
		if (!terminal) {
			terminal = await this.terminalService.createTerminal({ config: { name: terminalName, isTransient: true, hideFromUser: true } });
		}
		return terminal;
	}

	private async runGitCommand(args: string): Promise<void> {
		const terminal = await this.getTerminal();
		const inversePath = this.inverseDir.fsPath;
		// CD to .inverse and run
		// Use set +e to ensure we don't exit on error (though usually fine)
		terminal.sendText(`cd "${inversePath}" && ${args}`, true);
	}

	// Data Protection Methods

	private async hideInverseFolder(): Promise<void> {
		const config = this.configurationService.inspect<{ [key: string]: boolean }>('files.exclude');
		const workspaceValue = config.workspaceValue || {};

		if (!workspaceValue['**/.inverse']) {
			console.log('Hiding .inverse folder...');
			const newValue = { ...workspaceValue, '**/.inverse': true };
			await this.configurationService.updateValue('files.exclude', newValue, ConfigurationTarget.WORKSPACE);
		}
	}

	private async setReadOnly(readonly: boolean): Promise<void> {
		const inversePath = this.inverseDir.fsPath;
		let cmd = '';

		if (isWindows) {
			// Windows: attrib +r (readonly) / -r (writable) /s (recursive)
			cmd = readonly ? `attrib +r "${inversePath}\\*" /s` : `attrib -r "${inversePath}\\*" /s`;
		} else {
			// Mac/Linux: chmod -R a-w (all no write) / u+w (user write)
			cmd = readonly ? `chmod -R a-w "${inversePath}"` : `chmod -R u+w "${inversePath}"`;
		}

		// console.log(`Setting ${readonly ? 'READ-ONLY' : 'WRITABLE'} permissions on .inverse...`);
		const terminal = await this.getTerminal();
		terminal.sendText(cmd, true);
	}

	public async createCheckpoint(): Promise<void> {
		try {
			// 1. Unlock to allow writing (Git needs to write to .git)
			// This is critical to prevent "No checkpoints found" / failed git operations
			await this.setReadOnly(false);

			// Save Analysis Snapshot before git operations
			await this.saveAnalysisSnapshot();

			// 2. Ensure shadow git init
			try {
				const gitDir = URI.joinPath(this.inverseDir, '.git');
				await this.fileService.resolve(gitDir);
			} catch (e) {
				// .git missing, init it
				console.log('Initializing Shadow Git...');
				// Use strict isolation even for init/config
				await this.runGitCommand('git init && git --git-dir=.git config user.email "nano@agent.ai" && git --git-dir=.git config user.name "Nano Agent"');
			}

			// 3. Add and Commit
			const timestamp = new Date().toISOString();
			console.log(`Creating Shadow Git Checkpoint at ${timestamp}...`);

			// Use strict isolation flags: --git-dir=.git --work-tree=.
			await this.runGitCommand(`git --git-dir=.git --work-tree=. add -A && git --git-dir=.git --work-tree=. commit -m "Checkpoint: ${timestamp}"`);

		} catch (e) {
			console.error('Checkpoint creation failed', e);
		} finally {
			// 4. Re-lock
			await this.setReadOnly(true);
		}
	}

	private async saveAnalysisSnapshot(): Promise<void> {
		const snapshot = {
			timestamp: new Date().toISOString(),
			dashboard: this.getAnalysisState(), // Use getter to handle Set->Array conversion
		};
		const content = JSON.stringify(snapshot, null, 2);
		const encryptedContent = await this.encryptionService.encrypt(content);
		const snapshotUri = URI.joinPath(this.inverseDir, 'analysis_snapshot.json');
		try {
			await this.fileService.writeFile(snapshotUri, VSBuffer.fromString(encryptedContent));
		} catch (e) {
			console.error('Failed to save analysis snapshot', e);
		}
	}
}
