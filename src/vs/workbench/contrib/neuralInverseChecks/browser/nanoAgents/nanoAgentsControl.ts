import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IWebviewService, IWebviewElement } from '../../../webview/browser/webview.js';
import { getWindow } from '../../../../../base/browser/dom.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { URI } from '../../../../../base/common/uri.js';
import { ProjectAnalyzer } from './projectAnalyzer.js';
import { NanoAgentService } from './ai/nanoAgentService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IVoidSettingsService } from '../../../void/common/voidSettingsService.js';
import { NeuralInverseChat } from '../../../neuralInverseChat/browser/neuralInverseChat.js';
import { IGRCEngineService } from '../engine/services/grcEngineService.js';
import { IContractReasonService } from '../engine/services/contractReasonService.js';

export class NanoAgentsControl extends Disposable {
	private readonly container: HTMLElement;
	private webviewElement: IWebviewElement | undefined;
	private projectAnalyzer: ProjectAnalyzer;
	private nanoAgentService: NanoAgentService;
	private chatUI: NeuralInverseChat;

	public layout(width: number, height: number) {
		this.container.style.width = `${width}px`;
		this.container.style.height = `${height}px`;
	}

	public show() {
		this.container.style.display = 'block';
	}

	public hide() {
		this.container.style.display = 'none';
	}

	public askWithPrefill(question: string): void {
		this.webviewElement?.postMessage({ command: 'prefillQuestion', question });
	}

	constructor(
		parent: HTMLElement,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
		@IModelService private readonly modelService: IModelService,
		@IFileService private readonly fileService: IFileService,
		@ICommandService private readonly commandService: ICommandService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IGRCEngineService private readonly grcEngine: IGRCEngineService,
		@IContractReasonService private readonly contractReasonService: IContractReasonService,
	) {
		super();
		this.container = document.createElement('div');
		this.container.style.width = '100%';
		this.container.style.height = '100%';
		this.container.style.display = 'none'; // Hidden by default
		parent.appendChild(this.container);

		this.projectAnalyzer = this.instantiationService.createInstance(ProjectAnalyzer);
		this.nanoAgentService = this.instantiationService.createInstance(NanoAgentService, this.projectAnalyzer, this.grcEngine);
		this.chatUI = new NeuralInverseChat();

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
				case 'getAnalysisState':
					const state = this.projectAnalyzer.getAnalysisState();
					this.webviewElement?.postMessage({ command: 'analysisState', state });
					break;
				case 'inspectCurrentFile':
					await this.inspectCurrentFile();
					break;
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
				case 'getSnapshot':
					const snapshot = await this.projectAnalyzer.historyService.getSnapshot(e.message.hash);
					this.webviewElement?.postMessage({ command: 'snapshotData', hash: e.message.hash, data: snapshot });
					break;
				case 'askAgent':
					// Delegate to NanoAgentService
					await this.nanoAgentService.askAgent(
						e.message.text,
						(text) => this.webviewElement?.postMessage({ command: 'chatToken', text }), // onToken
						(text) => this.webviewElement?.postMessage({ command: 'chatComplete', text }), // onComplete
						(error) => this.webviewElement?.postMessage({ command: 'chatError', text: error }) // onError
					);
					break;
				case 'openSidebar':
					// Set Chat Mode to 'agent' and open the sidebar
					this.voidSettingsService.setGlobalSetting('chatMode', 'agent');
					await this.commandService.executeCommand('void.openSidebar');
					break;
				case 'getScanTrackerState':
					this.webviewElement?.postMessage({
						command: 'scanTrackerState',
						state: this.contractReasonService.getScanTrackerState(),
					});
					break;
				case 'triggerAIScan':
					this.grcEngine.scanWorkspaceWithAI().catch(e =>
						console.error('[NanoAgentsControl] Manual AI scan failed:', e)
					);
					break;
				case 'startPeriodicScan':
					this.grcEngine.startPeriodicAIScan(e.message.intervalMs || 120_000);
					this.webviewElement?.postMessage({
						command: 'scanTrackerState',
						state: this.contractReasonService.getScanTrackerState(),
					});
					break;
				case 'stopPeriodicScan':
					this.grcEngine.stopPeriodicAIScan();
					this.webviewElement?.postMessage({
						command: 'scanTrackerState',
						state: this.contractReasonService.getScanTrackerState(),
					});
					break;
				case 'resetScanTracker':
					this.contractReasonService.scanTrackerReset();
					break;
			}
		}));

		// Forward scan tracker updates to the webview in real-time
		this._register(this.contractReasonService.onDidScanTrackerUpdate((state) => {
			this.webviewElement?.postMessage({ command: 'scanTrackerState', state });
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
			const fullPath = URI.joinPath(this.projectAnalyzer['inverseDir'], relativePath);

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

	private async inspectCurrentFile() {
		const editor = this.editorService.activeEditorPane;
		if (editor && editor.group.activeEditor) {
			const resource = editor.group.activeEditor.resource;
			if (resource) {
				const data = await this.projectAnalyzer.getDetailedAnalysis(resource);
				this.webviewElement?.postMessage({ command: 'deepAnalysis', data });
			}
		}
	}

	private getHtml(): string {
		const chatCss = this.chatUI.getCss();
		const chatHtml = this.chatUI.getHtmlContainer();
		const chatJs = this.chatUI.getJs();

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Nano Agents</title>
			<style>
				:root {
					--container-pading: 20px;
					--input-padding-vertical: 6px;
					--input-padding-horizontal: 4px;
					--input-margin-vertical: 4px;
					--input-margin-horizontal: 0;
				}

				body {
					font-family: var(--vscode-font-family);
					font-size: var(--vscode-font-size);
					padding: 0;
					background-color: var(--vscode-editor-background);
					color: var(--vscode-editor-foreground);
					margin: 0;
					overflow: hidden; /* Prevent body scroll if chat handles it */
				}

				.tabs {
					display: flex;
					border-bottom: 1px solid var(--vscode-panel-border);
					background: var(--vscode-sideBar-background);
					flex-shrink: 0;
				}

				.tab {
					padding: 10px 20px;
					cursor: pointer;
					opacity: 0.7;
					border-bottom: 2px solid transparent;
					transition: all 0.2s;
				}

				.tab:hover {
					opacity: 1;
					background-color: var(--vscode-list-hoverBackground);
				}

				.tab.active {
					opacity: 1;
					border-bottom-color: var(--vscode-progressBar-background);
					font-weight: bold;
					background-color: var(--vscode-editor-background);
				}

				.content {
					padding: 20px;
					display: none;
					animation: 0.2s ease-in-out fadein;
					height: calc(100vh - 42px); /* Adjust for tabs height approx */
					overflow-y: auto;
					box-sizing: border-box;
				}

				@keyframes fadein {
					from { opacity: 0; transform: translateY(5px); }
					to { opacity: 1; transform: translateY(0); }
				}

				.content.active {
					display: block;
				}

				/* Chat content specifics - zero padding to let chat component fill */
				#chat.content {
					padding: 0;
					overflow: hidden;
				}

				h1 {
					font-size: 1.1em;
					font-weight: 600;
					margin-bottom: 16px;
					color: var(--vscode-settings-headerForeground);
					text-transform: uppercase;
					letter-spacing: 0.05em;
				}

				.card {
					background: var(--vscode-editor-background);
					border: 1px solid var(--vscode-widget-border);
					padding: 16px;
					border-radius: 4px;
					margin-bottom: 16px;
					box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
				}

				button {
					background: var(--vscode-button-background);
					color: var(--vscode-button-foreground);
					border: none;
					padding: 8px 16px;
					border-radius: 2px;
					cursor: pointer;
					font-family: var(--vscode-font-family);
					font-size: var(--vscode-font-size);
				}

				button:hover {
					background: var(--vscode-button-hoverBackground);
				}

				/* ... Other stats CSS ... */
				.stat-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--vscode-panel-border); }
				.stat-label { opacity: 0.7; }
				.stat-value { font-weight: 600; font-family: var(--vscode-editor-font-family); }
				.tag { display: inline-block; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 3px 10px; border-radius: 12px; font-size: 0.85em; margin-right: 6px; margin-bottom: 6px; font-weight: 500; }
				.checkpoint { padding: 12px; border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer; transition: background-color 0.2s; }
				.checkpoint:hover { background: var(--vscode-list-hoverBackground); }
				.checkpoint-header { display: flex; justify-content: space-between; align-items: center; }
				.file-list { margin-top: 8px; padding-left: 12px; font-size: 0.9em; display: none; background: var(--vscode-textBlockQuote-background); border-radius: 4px; padding: 8px; }
				.file-item { padding: 4px 0; cursor: pointer; color: var(--vscode-textLink-foreground); display: flex; align-items: center; }
				.file-item:hover { text-decoration: underline; }

				/* AI Scan Tracker */
				.scan-filter {
					padding: 4px 10px;
					border-radius: 12px;
					font-size: 0.8em;
					cursor: pointer;
					background: var(--vscode-badge-background);
					color: var(--vscode-badge-foreground);
					opacity: 0.6;
					transition: opacity 0.2s;
				}
				.scan-filter:hover { opacity: 0.85; }
				.scan-filter.active { opacity: 1; font-weight: 600; }

				.scan-entry {
					display: flex;
					align-items: center;
					padding: 6px 8px;
					border-bottom: 1px solid var(--vscode-panel-border);
					font-size: 0.88em;
					gap: 8px;
				}
				.scan-entry:hover { background: var(--vscode-list-hoverBackground); }
				.scan-entry .se-icon { width: 16px; text-align: center; flex-shrink: 0; }
				.scan-entry .se-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family); }
				.scan-entry .se-detail { font-size: 0.82em; opacity: 0.6; flex-shrink: 0; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
				.scan-entry .se-risk { font-size: 0.74em; font-weight: 600; padding: 1px 5px; border-radius: 3px; flex-shrink: 0; min-width: 24px; text-align: center; }
				.scan-entry .se-time { font-size: 0.78em; opacity: 0.5; flex-shrink: 0; }

				.risk-high { background: rgba(244,71,71,0.2); color: #f44747; }
				.risk-med  { background: rgba(204,167,0,0.2); color: #cca700; }
				.risk-low  { background: rgba(137,209,133,0.15); color: #89d185; }

				.live-badge {
					display: inline-block;
					background: rgba(14,112,192,0.2);
					color: var(--vscode-progressBar-background, #0e70c0);
					padding: 1px 7px;
					border-radius: 8px;
					font-size: 0.76em;
					font-weight: 600;
					margin-left: 6px;
				}

				.se-status-scanned .se-icon { color: var(--vscode-charts-green, #89d185); }
				.se-status-skipped .se-icon { color: var(--vscode-charts-yellow, #cca700); }
				.se-status-error .se-icon { color: var(--vscode-errorForeground, #f48771); }
				.se-status-scanning .se-icon { color: var(--vscode-progressBar-background, #0e70c0); }
				.se-status-pending .se-icon { opacity: 0.4; }

				@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
				.se-status-scanning .se-icon { animation: pulse 1.2s ease-in-out infinite; }
				.live-badge { animation: pulse 1.8s ease-in-out infinite; }

				${chatCss}
			</style>
		</head>
		<body>
			<div class="tabs">
				<div class="tab active" onclick="showTab('dashboard')">Dashboard</div>
				<div class="tab" onclick="showTab('ai-scan')">AI Scan</div>
				<div class="tab" onclick="showTab('chat')">Chat</div>
				<div class="tab" onclick="showTab('inspect')">Inspect</div>
				<div class="tab" onclick="showTab('control')">Control</div>
				<div class="tab" onclick="showTab('history')">History</div>
			</div>

			<div id="inspect" class="content">
				<h1>Mission Critical Inspection</h1>
				<button onclick="inspectCurrent()" style="width:100%; margin-bottom:10px;">Inspect Active File</button>
				<div id="inspect-loading" style="display:none; text-align:center;">Analyzing...</div>
				<div id="inspect-result" style="display:none;">
				<!-- ... same as before but styled ... -->
					<div class="card">
						<div class="pillar-title">Analysis Result</div>
						<div id="p-structure"></div>
						<div id="p-calls"></div>
						<div id="p-capabilities"></div>
						<div id="p-diagnostics"></div>
						<div id="p-size"></div>
						<div id="p-change"></div>
					</div>
				</div>
			</div>

			<div id="dashboard" class="content active">
				<h1>Project Health</h1>
				<div class="card">
					<div class="stat-row">
						<span class="stat-label">Files Analyzed</span>
						<span class="stat-value" id="stat-files">-</span>
					</div>
					<div class="stat-row">
						<span class="stat-label">Total Lines</span>
						<span class="stat-value" id="stat-lines">-</span>
					</div>
					<div class="stat-row">
						<span class="stat-label">Functions</span>
						<span class="stat-value" id="stat-functions">-</span>
					</div>
					<div class="stat-row">
						<span class="stat-label">Classes</span>
						<span class="stat-value" id="stat-classes">-</span>
					</div>
					<div class="stat-row">
						<span class="stat-label">Last Scan</span>
						<span class="stat-value" id="stat-last">-</span>
					</div>
				</div>

				<h1>Capabilities Detected</h1>
				<div class="card" id="capabilities-list">
					Running analysis...
				</div>
			</div>

			<div id="ai-scan" class="content">
				<h1>AI Scan Tracker<span id="live-badge" class="live-badge" style="display:none;">Live</span></h1>

				<!-- Scan Controls -->
				<div class="card">
					<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
						<button onclick="triggerAIScan()" id="btn-scan">Scan Workspace</button>
						<button onclick="togglePeriodicScan()" id="btn-periodic" style="background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);">Start Periodic Scan</button>
						<button onclick="resetTracker()" style="background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);font-size:0.85em;">Reset</button>
					</div>
					<div id="periodic-info" style="margin-top:8px;font-size:0.85em;opacity:0.7;display:none;">
						Periodic scan active \u2014 interval: <span id="periodic-interval">2m</span>
					</div>
				</div>

				<!-- Progress Summary -->
				<div class="card" id="scan-summary">
					<div class="stat-row"><span class="stat-label">Status</span><span class="stat-value" id="scan-status">Idle</span></div>
					<div class="stat-row"><span class="stat-label">Total Files</span><span class="stat-value" id="scan-total">0</span></div>
					<div class="stat-row"><span class="stat-label">Scanned (AI)</span><span class="stat-value" id="scan-scanned" style="color:var(--vscode-charts-green)">0</span></div>
					<div class="stat-row"><span class="stat-label">Skipped (cached)</span><span class="stat-value" id="scan-skipped" style="color:var(--vscode-charts-yellow)">0</span></div>
					<div class="stat-row"><span class="stat-label">Errors</span><span class="stat-value" id="scan-errors" style="color:var(--vscode-errorForeground)">0</span></div>
					<div class="stat-row"><span class="stat-label">In-flight</span><span class="stat-value" id="scan-inflight">0</span></div>
					<div class="stat-row"><span class="stat-label">Last Completed</span><span class="stat-value" id="scan-last">\u2014</span></div>
				</div>

				<!-- Progress Bar -->
				<div style="margin-bottom:16px;">
					<div style="height:4px;background:var(--vscode-widget-border);border-radius:2px;overflow:hidden;">
						<div id="scan-progress-bar" style="height:100%;width:0%;background:var(--vscode-progressBar-background);transition:width 0.3s;"></div>
					</div>
				</div>

				<!-- Filter Tabs + Sort -->
				<div style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap;">
					<span class="scan-filter active" onclick="filterScanEntries('all')" data-filter="all">All</span>
					<span class="scan-filter" onclick="filterScanEntries('scanned')" data-filter="scanned">Scanned</span>
					<span class="scan-filter" onclick="filterScanEntries('skipped')" data-filter="skipped">Skipped</span>
					<span class="scan-filter" onclick="filterScanEntries('error')" data-filter="error">Errors</span>
					<span class="scan-filter" onclick="filterScanEntries('scanning')" data-filter="scanning">In-flight</span>
				</div>
				<div style="display:flex;gap:4px;margin-bottom:12px;align-items:center;">
					<span style="font-size:0.8em;opacity:0.6;">Sort:</span>
					<span class="scan-filter active" onclick="sortScanEntries('risk')" data-sort="risk">Risk</span>
					<span class="scan-filter" onclick="sortScanEntries('violations')" data-sort="violations">Violations</span>
					<span class="scan-filter" onclick="sortScanEntries('time')" data-sort="time">Recent</span>
					<span class="scan-filter" onclick="sortScanEntries('name')" data-sort="name">Name</span>
				</div>

				<!-- File List -->
				<div id="scan-file-list" style="max-height:400px;overflow-y:auto;"></div>
			</div>

			<div id="chat" class="content">
				${chatHtml}
			</div>

			<div id="control" class="content">
				<h1>Nano Agents Control</h1>
				<div class="card">
					<p>Nano Agents Registry initialized.</p>
					<button onclick="triggerAnalysis()">Create Checkpoint</button>
				</div>
			</div>

			<div id="history" class="content">
				<h1>Secure History</h1>
				<button onclick="refreshHistory()" style="margin-bottom: 10px;">Refresh</button>
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
					if (id === 'dashboard') refreshDashboard();
					if (id === 'ai-scan') refreshScanTracker();
				}

				// ... existing dashboard functions ...
				function refreshDashboard() { vscode.postMessage({ command: 'getAnalysisState' }); }
				function triggerAnalysis() { vscode.postMessage({ command: 'analyzeProject' }); }
				function refreshHistory() {	document.getElementById('history-list').innerText = 'Loading checkpoints...'; vscode.postMessage({ command: 'getHistory' }); }

				// \u2500\u2500\u2500 AI Scan Tracker \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				let _scanState = null;
				let _scanFilter = 'all';
				let _scanSort = 'risk';

				function triggerAIScan() { vscode.postMessage({ command: 'triggerAIScan' }); }
				function resetTracker() { vscode.postMessage({ command: 'resetScanTracker' }); }
				function refreshScanTracker() { vscode.postMessage({ command: 'getScanTrackerState' }); }

				function togglePeriodicScan() {
					if (_scanState && _scanState.periodicScanActive) {
						vscode.postMessage({ command: 'stopPeriodicScan' });
					} else {
						vscode.postMessage({ command: 'startPeriodicScan', intervalMs: 120000 });
					}
				}

				function filterScanEntries(filter) {
					_scanFilter = filter;
					document.querySelectorAll('[data-filter]').forEach(f => f.classList.toggle('active', f.dataset.filter === filter));
					renderScanFileList();
				}

				function sortScanEntries(sort) {
					_scanSort = sort;
					document.querySelectorAll('[data-sort]').forEach(f => f.classList.toggle('active', f.dataset.sort === sort));
					renderScanFileList();
				}

				function renderScanTracker(state) {
					_scanState = state;
					const isLive = state.isScanning && !state.periodicScanActive;
					const liveBadge = document.getElementById('live-badge');
					if (liveBadge) liveBadge.style.display = isLive ? 'inline-block' : 'none';

					document.getElementById('scan-status').textContent = state.isScanning ? 'Scanning...' : 'Idle';
					document.getElementById('scan-status').style.color = state.isScanning ? 'var(--vscode-progressBar-background)' : '';
					document.getElementById('scan-total').textContent = state.totalFiles;
					document.getElementById('scan-scanned').textContent = state.scannedCount;
					document.getElementById('scan-skipped').textContent = state.skippedCount;
					document.getElementById('scan-errors').textContent = state.errorCount;
					document.getElementById('scan-inflight').textContent = state.scanningCount;
					document.getElementById('scan-last').textContent = state.lastScanCompleted ? new Date(state.lastScanCompleted).toLocaleTimeString() : '\u2014';

					// Progress bar
					const done = state.scannedCount + state.skippedCount + state.errorCount;
					const pct = state.totalFiles > 0 ? Math.round((done / state.totalFiles) * 100) : 0;
					document.getElementById('scan-progress-bar').style.width = pct + '%';

					// Periodic scan button
					const btnP = document.getElementById('btn-periodic');
					const pInfo = document.getElementById('periodic-info');
					if (state.periodicScanActive) {
						btnP.textContent = 'Stop Periodic Scan';
						btnP.style.background = 'var(--vscode-inputValidation-warningBackground)';
						pInfo.style.display = 'block';
						document.getElementById('periodic-interval').textContent = (state.periodicScanIntervalMs / 1000) + 's';
					} else {
						btnP.textContent = 'Start Periodic Scan';
						btnP.style.background = 'var(--vscode-button-secondaryBackground)';
						pInfo.style.display = 'none';
					}

					// Disable scan button while scanning
					document.getElementById('btn-scan').disabled = state.isScanning;

					renderScanFileList();
				}

				function renderScanFileList() {
					const container = document.getElementById('scan-file-list');
					if (!_scanState || _scanState.entries.length === 0) {
						container.innerHTML = '<div style="padding:16px;text-align:center;opacity:0.5;">No files tracked yet. Click "Scan Workspace" to start.</div>';
						return;
					}

					const statusIcons = { scanned: '\u25CF', skipped: '\u25CB', error: '\u2715', scanning: '\u25C9', pending: '\u25CC' };
					let entries = _scanState.entries.slice();

					// Filter
					if (_scanFilter !== 'all') {
						entries = entries.filter(e => e.status === _scanFilter);
					}

					// Sort
					if (_scanSort === 'risk') {
						entries.sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0) || b.timestamp - a.timestamp);
					} else if (_scanSort === 'violations') {
						entries.sort((a, b) => (b.violationCount || 0) - (a.violationCount || 0) || b.timestamp - a.timestamp);
					} else if (_scanSort === 'time') {
						entries.sort((a, b) => b.timestamp - a.timestamp);
					} else if (_scanSort === 'name') {
						entries.sort((a, b) => a.fileName.localeCompare(b.fileName));
					} else {
						// Default: in-flight first
						const order = { scanning: 0, pending: 1, error: 2, scanned: 3, skipped: 4 };
						entries.sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5) || b.timestamp - a.timestamp);
					}

					let html = '';
					for (const e of entries) {
						const icon = statusIcons[e.status] || '?';
						let detail = '';
						if (e.status === 'scanned' && e.violationCount !== undefined) {
							detail = e.violationCount > 0 ? e.violationCount + ' violation(s)' : 'clean';
						} else if (e.status === 'skipped' && e.skipReason) {
							detail = e.skipReason;
						} else if (e.status === 'error' && e.errorMessage) {
							detail = e.errorMessage;
						} else if (e.status === 'scanning') {
							detail = 'analyzing...';
						}
						const rs = e.riskScore || 0;
						const riskCls = rs > 50 ? 'risk-high' : rs > 25 ? 'risk-med' : 'risk-low';
						const riskLabel = rs > 0 ? rs : '';
						const time = new Date(e.timestamp).toLocaleTimeString();
						html += '<div class="scan-entry se-status-' + e.status + '">'
							+ '<span class="se-icon">' + icon + '</span>'
							+ '<span class="se-name" title="' + e.fileUri + '">' + e.fileName + '</span>'
							+ '<span class="se-detail" title="' + detail + '">' + detail + '</span>'
							+ (riskLabel ? '<span class="se-risk ' + riskCls + '" title="Risk score: ' + rs + '">' + rs + '</span>' : '<span class="se-risk"></span>')
							+ '<span class="se-time">' + time + '</span>'
							+ '</div>';
					}
					container.innerHTML = html;
				}
				function toggleFiles(hash) {
					const el = document.getElementById('files-' + hash);
					if (el.style.display === 'block') { el.style.display = 'none'; }
					else { el.style.display = 'block';
						if (el.innerText === 'Loading files...') vscode.postMessage({ command: 'getChangedFiles', hash: hash });
					}
				}
				function openDiff(hash, file) { vscode.postMessage({ command: 'openDiff', hash: hash, file: file }); }
				function inspectCurrent() {
					document.getElementById('inspect-loading').style.display = 'block';
					document.getElementById('inspect-result').style.display = 'none';
					vscode.postMessage({ command: 'inspectCurrentFile' });
				}
				function viewSnapshot(hash) { vscode.postMessage({ command: 'getSnapshot', hash: hash }); }

				function renderDashboard(s) {
					document.getElementById('stat-files').innerText = s.stats.filesAnalyzed;
					document.getElementById('stat-functions').innerText = s.stats.functions;
					document.getElementById('stat-classes').innerText = s.stats.classes;
					document.getElementById('stat-lines').innerText = s.metrics.totalLines;
					const ts = s.lastScan || s.timestamp;
					document.getElementById('stat-last').innerText = ts ? new Date(ts).toLocaleTimeString() : '-';
					const capContainer = document.getElementById('capabilities-list');
					if (s.capabilities.length === 0) { capContainer.innerText = 'None detected yet.'; }
					else { capContainer.innerHTML = ''; s.capabilities.forEach(c => { const span = document.createElement('span'); span.className = 'tag'; span.innerText = c; capContainer.appendChild(span); }); }
				}

				// Global listener
				const handleMessage = (event) => {
					const message = event.data;

					// Delegate to Chat JS if chat commands?
					// Handled by injected JS listener if filtered properly.

					if (message.command === 'historyData') {
						const list = document.getElementById('history-list');
						list.innerHTML = '';
						if (message.data.length === 0) { list.innerText = 'No checkpoints found.'; return; }
						message.data.forEach(cp => {
							const div = document.createElement('div');
							div.className = 'checkpoint';
							div.innerHTML = '<div class="checkpoint-header" onclick="toggleFiles(\\'' + cp.hash + '\\')">' +
									'<span class="checkpoint-message">' + cp.message + '</span>' +
									'<span class="checkpoint-date">' + new Date(cp.date).toLocaleString() + '</span></div>' +
									'<div style="padding-top: 5px;"><button onclick="viewSnapshot(\\'' + cp.hash + '\\')" style="font-size: 0.8em; padding: 2px 8px;">View Snapshot</button></div>' +
									'<div id="files-' + cp.hash + '" class="file-list">Loading files...</div>';
							list.appendChild(div);
						});
					}
					else if (message.command === 'analysisState') { renderDashboard(message.state); }
					else if (message.command === 'snapshotData') {
						if (message.data && message.data.dashboard) { renderDashboard(message.data.dashboard); showTab('dashboard'); }
					}
					else if (message.command === 'changedFiles') {
						const container = document.getElementById('files-' + message.hash);
						container.innerHTML = '';
						if (message.data.length === 0) { container.innerText = 'No relevant files changed.'; }
						else { message.data.forEach(file => { const d = document.createElement('div'); d.className = 'file-item'; d.innerText = file; d.onclick = () => openDiff(message.hash, file); container.appendChild(d); }); }
					}
					else if (message.command === 'analysisComplete') { refreshDashboard(); }
					else if (message.command === 'scanTrackerState') { renderScanTracker(message.state); }
					else if (message.command === 'init') { refreshDashboard(); }
					else if (message.command === 'prefillQuestion') {
						// Switch to chat tab and fill the input
						showTab('chat');
						const chatInput = document.querySelector('#chat-input, .chat-input, textarea');
						if (chatInput) {
							chatInput.value = message.question;
							chatInput.focus();
							// Auto-submit after a short delay
							setTimeout(() => {
								const sendBtn = document.querySelector('#chat-send, .chat-send, button[onclick*="send"]');
								if (sendBtn) sendBtn.click();
							}, 100);
						}
					}
					else if (message.command === 'deepAnalysis') {
						document.getElementById('inspect-loading').style.display = 'none';
						document.getElementById('inspect-result').style.display = 'block';
						const d = message.data;
						if (d.metrics) {
							const symbols = d.lsp?.symbols?.map(s => s.name).join(', ') || 'None';
							document.getElementById('p-structure').innerHTML = '<strong>Structure:</strong> ' + symbols;
							document.getElementById('p-calls').innerHTML = '<strong>Calls:</strong> Incoming: - | Outgoing: - (Drill-down coming soon)';
							const caps = [];
							if (d.capabilities?.hasNetwork) caps.push('Network');
							if (d.capabilities?.hasFileSystem) caps.push('File System');
							if (d.capabilities?.hasCrypto) caps.push('Crypto');
							if (d.capabilities?.hasAuth) caps.push('Auth');
							if (d.capabilities?.hasDatabase) caps.push('Database');
							if (d.capabilities?.hasEnv) caps.push('Env');
							document.getElementById('p-capabilities').innerHTML = '<strong>Capabilities:</strong> ' + (caps.length ? caps.map(c => '<span class="tag">' + c + '</span>').join('') : 'None');
							document.getElementById('p-diagnostics').innerHTML = '<strong>Diagnostics:</strong> <span style="color:var(--vscode-errorForeground)">Errors: ' + d.diagnostics.errorCount + '</span> | Warnings: ' + d.diagnostics.warningCount;
							document.getElementById('p-size').innerHTML = '<strong>Size & Shape:</strong> Lines: ' + d.metrics.lineCount + ', Depth: ' + d.metrics.maxDepth + ', Avg Params: ' + d.metrics.avgParams;
							const mtime = d.fileStat?.mtime ? new Date(d.fileStat.mtime).toLocaleString() : 'Unknown';
							document.getElementById('p-change').innerHTML = '<strong>Change Surface:</strong> Last Modified: ' + mtime;
						}
					}
				};

				window.addEventListener('message', handleMessage);

				// Inject Chat JS
				${chatJs};
			</script>
		</body>
		</html>`;
	}
}


