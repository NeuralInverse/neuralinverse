import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IWebviewService, IWebviewElement } from '../../../webview/browser/webview.js';
import { getWindow } from '../../../../../base/browser/dom.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { URI } from '../../../../../base/common/uri.js';
import { ProjectAnalyzer } from './projectAnalyzer.js';

export class NanoAgentsControl extends Disposable {
	private readonly container: HTMLElement;
	private webviewElement: IWebviewElement | undefined;
	private projectAnalyzer: ProjectAnalyzer;

	constructor(
		parent: HTMLElement,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
		@IModelService private readonly modelService: IModelService,
		@IFileService private readonly fileService: IFileService
	) {
		super();
		this.container = document.createElement('div');
		this.container.style.width = '100%';
		this.container.style.height = '100%';
		this.container.style.display = 'none'; // Hidden by default
		parent.appendChild(this.container);

		this.projectAnalyzer = this.instantiationService.createInstance(ProjectAnalyzer);

		this.initWebview();
	}

	private initWebview() {
		this.webviewElement = this.webviewService.createWebviewElement({
			title: 'Nano Agents',
			options: {
				enableFindWidget: true,
				tryRestoreScrollPosition: true,
				retainContextWhenHidden: true,
			},
			contentOptions: {
				allowScripts: true,
			},
			extension: undefined
		});

		this.webviewElement.mountTo(this.container, getWindow(this.container));
		this.webviewElement.setHtml(this.getHtml());

		this._register(this.webviewService.onDidChangeActiveWebview(() => {
			// Optional: react to visibility
		}));

		// Auto-start analysis
		setTimeout(() => {
			this.projectAnalyzer.analyzeProject();
		}, 1000); // Small delay to allow workspace to settle

		this._register(this.webviewElement.onMessage(async e => {
			switch (e.message.command) {
				case 'analyzeProject':
					await this.runAnalysis();
					break;
				case 'getHistory':
					const checkpoints = await this.projectAnalyzer.historyService.getCheckpoints();
					this.webviewElement?.postMessage({ command: 'historyData', data: checkpoints });
					break;
				case 'getChangedFiles':
					const files = await this.projectAnalyzer.historyService.getChangedFiles(e.message.hash);
					this.webviewElement?.postMessage({ command: 'changedFiles', hash: e.message.hash, data: files });
					break;
				case 'openDiff':
					await this.openDiff(e.message.hash, e.message.file);
					break;
			}
		}));

		this._register(this.webviewElement);
	}

	private async runAnalysis() {
		console.log('Starting workspace analysis...');
		await this.projectAnalyzer.analyzeProject();
		await this.projectAnalyzer.createCheckpoint();
		console.log('Workspace analysis & checkpoint complete.');
		this.webviewElement?.postMessage({ command: 'analysisComplete' });

		// Verification Step
		console.log('--- Verifying Secure History ---');
		const checkpoints = await this.projectAnalyzer.historyService.getCheckpoints();
		console.log('Checkpoints found:', checkpoints);

		if (checkpoints.length > 0) {
			const latest = checkpoints[0];
			const files = await this.projectAnalyzer.historyService.getChangedFiles(latest.hash);
			if (files.length > 0) {
				const sampleFile = files[0];
				console.log(`Attempting to decrypt content for: ${sampleFile} from checkpoint ${latest.hash}`);

				const content = await this.projectAnalyzer.historyService.getFileContent(latest.hash, sampleFile);
				if (content) {
					console.log('SUCCESS: Decrypted content retrieved!');
					console.log('Preview:', content.substring(0, 50) + '...');
				} else {
					console.log('Verification Note: Could not decrypt sample file.');
				}
			} else {
				console.log('Checkpoint has no files.');
			}
		} else {
			console.log('WARNING: No checkpoints found after creation.');
		}
		console.log('--- Verification Complete ---');
	}

	private async openDiff(commitHash: string, relativePath: string) {
		try {
			// 1. Get Historic Content (Decrypted)
			const originalContent = await this.projectAnalyzer.historyService.getFileContent(commitHash, relativePath);

			// 2. Get Current Content (Decrypted)
			// projectAnalyzer.inverseDir + relativePath is the full path
			// Note: relativePath here is likely relative to .inverse root?
			// The history service works within .inverse.
			// e.g. "metrics/foo.ts.json"
			const fullPath = URI.joinPath(this.projectAnalyzer['inverseDir'], relativePath); // accessing private prop via workaround or assume inverseDir is public?
			// HistoryService takes inverseDir in constructor. Let's assume relativePath is relative to inverseDir.

			let modifiedContent = '';
			if (await this.fileService.exists(fullPath)) {
				const encryptedFile = await this.fileService.readFile(fullPath);
				modifiedContent = await this.projectAnalyzer.encryptionService.decrypt(encryptedFile.value.toString());
			} else {
				modifiedContent = '// File does not exist currently';
			}

			// 3. Create In-Memory Models
			// We use untitled scheme with a unique path component so they don't conflict
			const originalUri = URI.from({ scheme: 'untitled', path: `ORIGINAL_${commitHash}_${relativePath}` });
			const modifiedUri = URI.from({ scheme: 'untitled', path: `MODIFIED_CURRENT_${relativePath}` });

			// Create or update models
			let originalModel = this.modelService.getModel(originalUri);
			if (originalModel) {
				originalModel.setValue(originalContent || '');
			} else {
				originalModel = this.modelService.createModel(originalContent || '', null, originalUri);
			}

			let modifiedModel = this.modelService.getModel(modifiedUri);
			if (modifiedModel) {
				modifiedModel.setValue(modifiedContent);
			} else {
				modifiedModel = this.modelService.createModel(modifiedContent, null, modifiedUri);
			}

			// 4. Open Diff Editor
			await this.editorService.openEditor({
				original: { resource: originalUri },
				modified: { resource: modifiedUri },
				label: `${relativePath} (Diff)`,
				description: `Comparing ${commitHash.substring(0, 7)} vs Current`
			});

		} catch (e) {
			console.error('Failed to open diff', e);
		}
	}

	private getHtml(): string {
		return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Nano Agents</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    padding: 0;
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    margin: 0;
                }
				.tabs {
					display: flex;
					border-bottom: 1px solid var(--vscode-panel-border);
					background: var(--vscode-sideBar-background);
				}
				.tab {
					padding: 10px 20px;
					cursor: pointer;
					opacity: 0.7;
					border-bottom: 2px solid transparent;
				}
				.tab.active {
					opacity: 1;
					border-bottom-color: var(--vscode-progressBar-background);
					font-weight: bold;
				}
				.content {
					padding: 20px;
					display: none;
				}
				.content.active {
					display: block;
				}
                h1 { font-size: 1.2em; font-weight: 500; margin-bottom: 10px; }
                .card {
                    background: var(--vscode-sideBar-background);
                    border: 1px solid var(--vscode-panel-border);
                    padding: 15px;
                    border-radius: 6px;
                    margin-bottom: 15px;
                    max-width: 400px;
                }
                button {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 8px 12px;
                    border-radius: 2px;
                    cursor: pointer;
                }
                button:hover {
                    background: var(--vscode-button-hoverBackground);
                }
				.checkpoint {
					padding: 8px;
					border-bottom: 1px solid var(--vscode-panel-border);
					cursor: pointer;
				}
				.checkpoint:hover {
					background: var(--vscode-list-hoverBackground);
				}
				.checkpoint-header {
					display: flex;
					justify-content: space-between;
					font-size: 0.9em;
					font-weight: bold;
				}
				.checkpoint-date {
					font-weight: normal;
					opacity: 0.7;
					font-size: 0.8em;
				}
				.file-list {
					margin-top: 5px;
					padding-left: 10px;
					font-size: 0.85em;
					display: none;
					background: rgba(0,0,0,0.1);
					border-radius: 4px;
				}
				.file-item {
					padding: 4px;
					cursor: pointer;
					color: var(--vscode-textLink-foreground);
				}
				.file-item:hover {
					text-decoration: underline;
				}
            </style>
        </head>
        <body>
			<div class="tabs">
				<div class="tab active" onclick="showTab('control')">Control</div>
				<div class="tab" onclick="showTab('history')">History</div>
			</div>

            <div id="control" class="content active">
                <h1>Nano Agents</h1>
                <div class="card">
                    <p>Nano Agents Registry initialized.</p>
                    <p style="opacity: 0.7; font-size: 0.9em;">Ready to Create nano-agents checkpoint.</p>
                    <div style="margin-top: 10px;">
                        <button onclick="triggerAnalysis()">Create Nano-Agent Checkpoint</button>
                    </div>
                </div>
            </div>

			<div id="history" class="content">
				<h1>Secure History</h1>
				<button onclick="refreshHistory()" style="margin-bottom: 10px; font-size: 0.8em;">Refresh</button>
				<div id="history-list">Loading...</div>
			</div>

            <script>
                const vscode = acquireVsCodeApi();

				function showTab(id) {
					document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
					document.querySelectorAll('.content').forEach(c => c.classList.remove('active'));
					document.querySelector('.tab[onclick="showTab(\\'' + id + '\\')"]').classList.add('active');
					document.getElementById(id).classList.add('active');

					if (id === 'history') refreshHistory();
				}

                function triggerAnalysis() {
                    vscode.postMessage({ command: 'analyzeProject' });
                }

				function refreshHistory() {
					document.getElementById('history-list').innerText = 'Loading checkpoints...';
					vscode.postMessage({ command: 'getHistory' });
				}

				function toggleFiles(hash) {
					const el = document.getElementById('files-' + hash);
					if (el.style.display === 'block') {
						el.style.display = 'none';
					} else {
						el.style.display = 'block';
						// Load files if empty
						if (el.innerText === 'Loading files...') {
							vscode.postMessage({ command: 'getChangedFiles', hash: hash });
						}
					}
				}

				function openDiff(hash, file) {
					vscode.postMessage({ command: 'openDiff', hash: hash, file: file });
				}

				window.addEventListener('message', event => {
					const message = event.data;
					if (message.command === 'historyData') {
						const list = document.getElementById('history-list');
						list.innerHTML = '';
						if (message.data.length === 0) {
							list.innerText = 'No checkpoints found.';
							return;
						}
						message.data.forEach(cp => {
							const div = document.createElement('div');
							div.className = 'checkpoint';
							div.innerHTML = \`
								<div class="checkpoint-header" onclick="toggleFiles('\${cp.hash}')">
									<span>\${cp.message}</span>
									<span class="checkpoint-date">\${new Date(cp.date).toLocaleString()}</span>
								</div>
								<div id="files-\${cp.hash}" class="file-list">Loading files...</div>
							\`;
							list.appendChild(div);
						});
					} else if (message.command === 'changedFiles') {
						const container = document.getElementById('files-' + message.hash);
						container.innerHTML = '';
						if (message.data.length === 0) {
							container.innerText = 'No relevant files changed.';
						} else {
							message.data.forEach(file => {
								const d = document.createElement('div');
								d.className = 'file-item';
								d.innerText = file;
								d.onclick = () => openDiff(message.hash, file);
								container.appendChild(d);
							});
						}
					} else if (message.command === 'analysisComplete') {
						// Maybe verify history automatically?
						// refreshHistory();
					}
				});
            </script>
        </body>
        </html>`;
	}

	public show() {
		this.container.style.display = 'block';
	}

	public hide() {
		this.container.style.display = 'none';
	}

	public layout(width: number, height: number) {
		// Pass layout calls if needed, mostly for webview resizing
	}
}
