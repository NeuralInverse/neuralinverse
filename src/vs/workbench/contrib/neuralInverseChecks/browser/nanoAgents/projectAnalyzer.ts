
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { relativePath, dirname } from '../../../../../base/common/resources.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { LSPCollector } from './lsp/lspCollector.js';
import { ASTCollector } from './ast/astCollector.js';
import { CallHierarchyCollector } from './callHierarchy/callHierarchyCollector.js';
import { MetricsCollector } from './metrics/metricsCollector.js';
import { CapabilitiesCollector } from './capabilities/capabilitiesCollector.js';

export class ProjectAnalyzer extends Disposable {
	private readonly inverseDir: URI;
	private readonly lspCollector: LSPCollector;
	private readonly astCollector: ASTCollector;
	private readonly callHierarchyCollector: CallHierarchyCollector;
	private readonly metricsCollector: MetricsCollector;
	private readonly capabilitiesCollector: CapabilitiesCollector;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@ITerminalService private readonly terminalService: ITerminalService
	) {
		super();
		const workspaceFolder = this.workspaceContextService.getWorkspace().folders[0];
		if (!workspaceFolder) {
			throw new Error('No workspace folder found');
		}
		this.inverseDir = URI.joinPath(workspaceFolder.uri, '.inverse');

		// Initialize modular collectors
		this.lspCollector = new LSPCollector(languageFeaturesService);
		this.astCollector = new ASTCollector(languageFeaturesService);
		this.callHierarchyCollector = new CallHierarchyCollector(languageFeaturesService);
		this.metricsCollector = new MetricsCollector();
		this.capabilitiesCollector = new CapabilitiesCollector();
	}

	public async analyzeProject(): Promise<void> {
		await this.analyzeWorkspace();
	}

	public async analyzeWorkspace(): Promise<void> {
		console.log('Starting full workspace analysis...');
		await this.ensureDirectories();
		await this.ensureGitIgnore();

		const folders = this.workspaceContextService.getWorkspace().folders;
		const allFiles: URI[] = [];

		for (const folder of folders) {
			const files = await this.crawl(folder.uri);
			allFiles.push(...files);
		}

		console.log(`Found ${allFiles.length} files to analyze.`);
		await this.processQueue(allFiles);
		console.log('Workspace analysis complete.');
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

			const lspData = await this.lspCollector.collect(model);

			const [astData, callHierarchyData, metricsData, capabilitiesData] = await Promise.all([
				this.astCollector.collect(model),
				this.callHierarchyCollector.collect(model),
				this.metricsCollector.collect(model, lspData),
				this.capabilitiesCollector.collect(model, lspData)
			]);

			if (lspData) await this.saveData('lsp', resource, lspData);
			if (astData) await this.saveData('ast', resource, astData);
			if (callHierarchyData) await this.saveData('call_hierarchy', resource, callHierarchyData);
			if (metricsData) await this.saveData('metrics', resource, metricsData);
			if (capabilitiesData) await this.saveData('capabilities', resource, capabilitiesData);

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
		const dirs = ['lsp', 'ast', 'call_hierarchy', 'metrics', 'capabilities'];
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

		const targetUri = URI.joinPath(this.inverseDir, category, relativePathStr + '.json');
		const targetDir = dirname(targetUri);

		await this.createDirectoryRecursively(targetDir);

		const content = JSON.stringify(data, null, 2);
		await this.fileService.writeFile(targetUri, VSBuffer.fromString(content));
	}

	private async createDirectoryRecursively(dir: URI): Promise<void> {
		try {
			await this.fileService.createFolder(dir);
			return;
		} catch (error: any) {
			try {
				const stat = await this.fileService.resolve(dir);
				if (stat.isDirectory) return;
			} catch (e) {
				// Doesn't exist
			}

			const parent = dirname(dir);
			if (parent.path !== dir.path) {
				await this.createDirectoryRecursively(parent);
				try {
					await this.fileService.createFolder(dir);
				} catch (e) { /* ignore */ }
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
			// If .gitignore doesn't exist, create it
			try {
				await this.fileService.writeFile(gitIgnoreFile, VSBuffer.fromString('.inverse\n'));
				console.log('Created .gitignore with .inverse');
			} catch (err) { }
		}
	}

	private async runGitCommand(args: string): Promise<void> {
		// Use a dedicated terminal
		const terminalName = 'Nano Agent Shadow Git';
		let terminal = this.terminalService.instances.find(t => t.title === terminalName);

		if (!terminal) {
			terminal = await this.terminalService.createTerminal({ config: { name: terminalName, isTransient: true } });
		}

		const inversePath = this.inverseDir.fsPath;
		const date = new Date().toISOString();

		// Send command: cd to .inverse and run git args
		terminal.sendText(`cd "${inversePath}" && ${args} && echo "Git Command Done: ${date}"`, true);
	}

	public async createCheckpoint(): Promise<void> {
		// 1. Ensure shadow git init
		try {
			const gitDir = URI.joinPath(this.inverseDir, '.git');
			await this.fileService.resolve(gitDir);
		} catch (e) {
			// .git missing, init it
			console.log('Initializing Shadow Git...');
			await this.runGitCommand('git init && git config user.email "nano@agent.ai" && git config user.name "Nano Agent"');
		}

		// 2. Add and Commit
		const timestamp = new Date().toISOString();
		console.log(`Creating Shadow Git Checkpoint at ${timestamp}...`);
		// We add -A to handle deletions too
		await this.runGitCommand(`git add -A && git commit -m "Checkpoint: ${timestamp}"`);
	}
}
