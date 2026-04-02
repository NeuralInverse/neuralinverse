/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

/**
 * Power Mode contribution — registers the Power Mode service and commands.
 *
 * Two opening modes (Cmd+Alt+P cycles, or via Command Palette):
 *   - "Neural Inverse: Open Power Mode"        Cmd+Alt+P → floating window
 *   - "Neural Inverse: Open Power Mode in Tab"           → editor tab
 */

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IEnterprisePolicyService } from '../../void/common/enterprisePolicyService.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IAccessibilitySignalService, AccessibilitySignal } from '../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { IPowerModeService } from './powerModeService.js';
import { PowerModeTerminalHost } from './powerModeTerminalHost.js';
import { IWebviewWorkbenchService } from '../../webviewPanel/browser/webviewWorkbenchService.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { openPowerModeFloating, openPowerModeInTab, IPMSidebarSection, getActivePowerModeTerminal } from './powerModeWebviewTerminal.js';
import { IFileChange } from './powerModeChangeTracker.js';
import { IFileService } from '../../../../platform/files/common/files.js';

// Side-effect imports: register DI singletons
import './powerBusService.js';
import './powerModeService.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const POWER_MODE_STORAGE_KEY = 'neuralInverse.powerMode.v3.state';

// ─── Policy guard helper ──────────────────────────────────────────────────────

function _isPolicyBlocked(policyService: IEnterprisePolicyService): boolean {
	return policyService.policy?.powerModePolicy?.enabled === false;
}

function _notifyBlocked(accessor: ServicesAccessor): void {
	accessor.get(INotificationService).notify({
		severity: Severity.Warning,
		message: 'Power Mode is disabled by your organization\'s policy.',
	});
	accessor.get(IAccessibilitySignalService).playSignal(AccessibilitySignal.neuralInversePolicyBlocked, { userGesture: true });
}

// ─── Contribution (restore on reload) ────────────────────────────────────────

export class PowerModeContribution extends Disposable implements IWorkbenchContribution {

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IPowerModeService private readonly powerModeService: IPowerModeService,
		@IEnterprisePolicyService private readonly enterprisePolicyService: IEnterprisePolicyService,
		@IWebviewWorkbenchService private readonly webviewWorkbenchService: IWebviewWorkbenchService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
		this._restoreOnReload();

		this._register(this.enterprisePolicyService.onDidChangePolicy(() => {
			if (_isPolicyBlocked(this.enterprisePolicyService)) {
				this.storageService.store(POWER_MODE_STORAGE_KEY, JSON.stringify({ isOpen: false }), StorageScope.WORKSPACE, 1);
			}
		}));
	}

	private _restoreOnReload(): void {
		if (_isPolicyBlocked(this.enterprisePolicyService)) { return; }
		const raw = this.storageService.get(POWER_MODE_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) { return; }
		try {
			const state = JSON.parse(raw);
			if (state.isOpen) {
				if (state.mode === 'tab') {
					this._openInTab(false);
				} else {
					this._openFloating();
				}
			}
		} catch { /* stale */ }
	}

	private _workingDirectory(): string {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders[0]?.uri.fsPath ?? (process.env['HOME'] ?? '/');
	}

	private _buildSidebarSections(switchFn: (sessionId: string) => void, viewFileFn?: (c: IFileChange) => void, viewedSessionId?: string): IPMSidebarSection[] {
		const sessions = this.powerModeService.sessions;
		const folders = this.workspaceContextService.getWorkspace().folders;
		const workspacePath = folders[0]?.uri.fsPath ?? null;

		const _sessionMeta = (s: any) => {
			const date = new Date(s.updatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
			const msgCount = (s.messages?.length ?? 0);
			const cost = (s.messages ?? []).filter((m: any) => m.role === 'assistant').reduce((sum: number, m: any) => sum + (m.cost ?? 0), 0);
			const costStr = cost >= 0.0001 ? ` · $${cost.toFixed(3)}` : '';
			const msgStr = msgCount > 0 ? ` · ${msgCount}msg` : '';
			return `${date}${msgStr}${costStr}`;
		};

		const _sessionDesc = (s: any, fallback?: string) => {
			const badges: string[] = [];
			if (s.planMode) { badges.push('plan'); }
			if (s.worktree?.branch) { badges.push(`⎇ ${s.worktree.branch}`); }
			if (s.permissionMode && s.permissionMode !== 'default') { badges.push(s.permissionMode); }
			return badges.length ? badges.join(' · ') : fallback;
		};

		const wsItems = sessions
			.filter(s => !workspacePath || s.directory === workspacePath || s.directory?.startsWith(workspacePath ?? ''))
			.map(s => ({
				label: s.title || 'Untitled session',
				description: _sessionDesc(s, s.agentId !== 'build' ? s.agentId : undefined),
				meta: _sessionMeta(s),
				onClick: () => switchFn(s.id),
				onDelete: () => this.powerModeService.deleteSession(s.id),
			}));

		const otherItems = sessions
			.filter(s => workspacePath && !s.directory?.startsWith(workspacePath))
			.map(s => ({
				label: s.title || 'Untitled session',
				description: _sessionDesc(s, s.directory?.split('/').pop()),
				meta: _sessionMeta(s),
				onClick: () => switchFn(s.id),
				onDelete: () => this.powerModeService.deleteSession(s.id),
			}));

		const sections: IPMSidebarSection[] = [
			{ title: 'This Workspace', collapsed: false, maxHeight: '280px', items: wsItems.length ? wsItems : [{ label: 'No sessions yet' }] },
		];
		if (otherItems.length) {
			sections.push({ title: 'Other Workspaces', collapsed: true, items: otherItems });
		}

		// Modified files for the viewed (or active) session
		const sessionId = viewedSessionId ?? this.powerModeService.activeSession?.id;
		const tracker = this.powerModeService.getChangeTracker();
		let fileChanges: IFileChange[] = sessionId ? tracker.getChangesForSession(sessionId) : [];

		// Fallback: extract from message tool calls when tracker has no data (e.g. after restart)
		if (fileChanges.length === 0 && sessionId) {
			const sess = this.powerModeService.getSession(sessionId);
			if (sess) {
				const seen = new Set<string>();
				for (const msg of sess.messages) {
					for (const part of msg.parts as any[]) {
						if (part.type === 'tool' && part.state?.status === 'completed') {
							const fp: string | undefined = part.state.input?.filePath ?? part.state.input?.file_path;
							const tool: string = part.toolName ?? '';
							if (fp && (tool === 'write' || tool === 'edit' || tool === 'multi_edit' || tool === 'notebook_edit') && !seen.has(fp)) {
								seen.add(fp);
								fileChanges.push({
									id: `msg-${part.id}`,
									filePath: fp,
									fileUri: null as any,
									changeType: tool === 'write' ? 'write' : 'edit',
									sessionId: sessionId,
									agentId: msg.agentId,
									timestamp: msg.createdAt,
									contentBefore: null,
									contentAfter: '',
									linesAdded: 0,
									linesRemoved: 0,
									superseded: false,
								});
							}
						}
					}
				}
			}
		}

		const latestByFile = new Map<string, IFileChange>();
		for (const c of fileChanges) {
			const ex = latestByFile.get(c.filePath);
			if (!ex || c.timestamp > ex.timestamp) { latestByFile.set(c.filePath, c); }
		}
		const fileItems = [...latestByFile.values()]
			.sort((a, b) => b.timestamp - a.timestamp)
			.map(c => ({
				label: c.filePath.split('/').pop() ?? c.filePath,
				description: workspacePath && c.filePath.startsWith(workspacePath)
					? c.filePath.slice(workspacePath.length + 1)
					: c.filePath,
				meta: (c.linesAdded || c.linesRemoved) ? `+${c.linesAdded} \u2212${c.linesRemoved}` : c.changeType,
				onClick: viewFileFn ? () => viewFileFn(c) : undefined,
			}));

		const viewedSession = sessionId ? this.powerModeService.getSession(sessionId) : undefined;

		// SESSION INFO section
		if (viewedSession) {
			const msgs = viewedSession.messages as any[];
			const userCount = msgs.filter(m => m.role === 'user').length;
			const asstCount = msgs.filter(m => m.role === 'assistant').length;
			const toolCount = msgs.flatMap(m => (m.parts ?? []).filter((p: any) => p.type === 'tool' && p.state?.status === 'completed')).length;
			const totalCost = msgs.filter(m => m.role === 'assistant').reduce((s: number, m: any) => s + (m.cost ?? 0), 0);
			const totalTokens = msgs.filter(m => m.role === 'assistant').reduce((s: number, m: any) => s + ((m.tokens?.input ?? 0) + (m.tokens?.output ?? 0)), 0);

			const infoItems: IPMSidebarSection['items'] = [];
			infoItems.push({ label: 'Messages', description: `${userCount} user  ·  ${asstCount} assistant` });
			if (toolCount > 0) { infoItems.push({ label: 'Tools called', description: String(toolCount) }); }
			if (totalCost >= 0.0001) { infoItems.push({ label: 'Cost', description: `$${totalCost.toFixed(4)}` }); }
			if (totalTokens > 0) { infoItems.push({ label: 'Tokens', description: totalTokens.toLocaleString() }); }
			if (viewedSession.planMode) { infoItems.push({ label: 'Plan mode', description: 'active' }); }
			if (viewedSession.worktree?.branch) { infoItems.push({ label: 'Worktree', description: `⎇ ${viewedSession.worktree.branch}` }); }
			if (viewedSession.permissionMode && viewedSession.permissionMode !== 'default') {
				infoItems.push({ label: 'Permission', description: viewedSession.permissionMode });
			}
			if (fileChanges.length > 0) { infoItems.push({ label: 'Files changed', description: String(latestByFile.size) }); }

			sections.push({ title: 'Session Info', collapsed: true, items: infoItems });
		}

		const modTitle = viewedSession ? `Modified Files \u2014 ${viewedSession.title}` : 'Modified Files';
		sections.push({
			title: modTitle,
			collapsed: false,
			items: fileItems.length ? fileItems : [{ label: 'No files modified yet' }],
		});

		return sections;
	}

	async _openFloating(): Promise<void> {
		const result = await openPowerModeFloating(this.webviewWorkbenchService, this.environmentService, this.editorGroupsService, this._workingDirectory(), this.fileService);
		const host = this._register(new PowerModeTerminalHost(this.powerModeService));
		host.mountWithTransport(result.terminal);

		let _viewedSessionId: string | undefined;
		const viewFileFn = (c: IFileChange) => result.terminal.showFileDiff({
			changeId: c.id,
			filePath: c.filePath,
			contentBefore: c.contentBefore,
			contentAfter: c.contentAfter,
			changeType: c.changeType,
		});
		const rebuild = () => result.setSidebarSections(this._buildSidebarSections(switchFn, viewFileFn, _viewedSessionId));
		const switchFn = (id: string) => { _viewedSessionId = id; host.switchToSession(id); rebuild(); };
		rebuild();
		this._register(this.powerModeService.onDidChangeSession(() => rebuild()));
		this._register(this.powerModeService.getChangeTracker().onDidChange(() => rebuild()));
		this._register(result.terminal.onRevertChange((changeId) => {
			this.powerModeService.getChangeTracker().rollbackChange(changeId).catch(() => { });
		}));

		this.storageService.store(POWER_MODE_STORAGE_KEY, JSON.stringify({ isOpen: true, mode: 'floating' }), StorageScope.WORKSPACE, 1);
		result.webviewInput.onWillDispose(() => {
			result.dispose();
			host.dispose();
			this.storageService.store(POWER_MODE_STORAGE_KEY, JSON.stringify({ isOpen: false }), StorageScope.WORKSPACE, 1);
		});
	}

	async _openInTab(floatingWindow: boolean): Promise<void> {
		const result = await openPowerModeInTab(this.webviewWorkbenchService, this.environmentService, this.editorGroupsService, this._workingDirectory(), floatingWindow, this.fileService);
		const host = this._register(new PowerModeTerminalHost(this.powerModeService));
		host.mountWithTransport(result.terminal);
		this.storageService.store(POWER_MODE_STORAGE_KEY, JSON.stringify({ isOpen: true, mode: floatingWindow ? 'floating-tab' : 'tab' }), StorageScope.WORKSPACE, 1);
		result.webviewInput.onWillDispose(() => {
			result.disposeShell();
			host.dispose();
			this.storageService.store(POWER_MODE_STORAGE_KEY, JSON.stringify({ isOpen: false }), StorageScope.WORKSPACE, 1);
		});
	}
}

// ─── Command: Open Power Mode (floating window) ───────────────────────────────

registerAction2(class OpenPowerModeAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.openPowerMode',
			title: localize2('neuralInverse.openPowerMode', 'Neural Inverse: Open Power Mode'),
			f1: true,
			keybinding: {
				weight: 200,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyP,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		if (_isPolicyBlocked(accessor.get(IEnterprisePolicyService))) { _notifyBlocked(accessor); return; }
		const webviewWorkbenchService = accessor.get(IWebviewWorkbenchService);
		const environmentService = accessor.get(INativeEnvironmentService);
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const powerModeService = accessor.get(IPowerModeService);
		const workspaceContextService = accessor.get(IWorkspaceContextService);
		const fileService = accessor.get(IFileService);

		const folders = workspaceContextService.getWorkspace().folders;
		const cwd = folders[0]?.uri.fsPath ?? (process.env['HOME'] ?? '/');

		const result = await openPowerModeFloating(webviewWorkbenchService, environmentService, editorGroupsService, cwd, fileService);
		const host = new PowerModeTerminalHost(powerModeService);
		host.mountWithTransport(result.terminal);

		let _viewedSessionId: string | undefined;
		const buildSections = (): IPMSidebarSection[] => {
			const sessions = powerModeService.sessions;

			const _sMeta = (s: any) => {
				const date = new Date(s.updatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
				const msgCount = (s.messages?.length ?? 0);
				const cost = (s.messages ?? []).filter((m: any) => m.role === 'assistant').reduce((sum: number, m: any) => sum + (m.cost ?? 0), 0);
				return `${date}${msgCount > 0 ? ` · ${msgCount}msg` : ''}${cost >= 0.0001 ? ` · $${cost.toFixed(3)}` : ''}`;
			};
			const _sDesc = (s: any, fallback?: string) => {
				const b: string[] = [];
				if (s.planMode) { b.push('plan'); }
				if (s.worktree?.branch) { b.push(`⎇ ${s.worktree.branch}`); }
				if (s.permissionMode && s.permissionMode !== 'default') { b.push(s.permissionMode); }
				return b.length ? b.join(' · ') : fallback;
			};

			const wsItems = sessions
				.filter(s => !cwd || s.directory === cwd || s.directory?.startsWith(cwd))
				.map(s => ({
					label: s.title || 'Untitled session',
					description: _sDesc(s, s.agentId !== 'build' ? s.agentId : undefined),
					meta: _sMeta(s),
					onClick: () => { _viewedSessionId = s.id; host.switchToSession(s.id); result.setSidebarSections(buildSections()); },
					onDelete: () => powerModeService.deleteSession(s.id),
				}));
			const otherItems = sessions
				.filter(s => cwd && !s.directory?.startsWith(cwd))
				.map(s => ({
					label: s.title || 'Untitled session',
					description: _sDesc(s, s.directory?.split('/').pop()),
					meta: _sMeta(s),
					onClick: () => { _viewedSessionId = s.id; host.switchToSession(s.id); result.setSidebarSections(buildSections()); },
					onDelete: () => powerModeService.deleteSession(s.id),
				}));
			const sections: IPMSidebarSection[] = [
				{ title: 'This Workspace', collapsed: false, maxHeight: '280px', items: wsItems.length ? wsItems : [{ label: 'No sessions yet' }] },
			];
			if (otherItems.length) { sections.push({ title: 'Other Workspaces', collapsed: true, items: otherItems }); }

			const sessionId = _viewedSessionId ?? powerModeService.activeSession?.id;
			const tracker = powerModeService.getChangeTracker();
			let fileChanges = sessionId ? tracker.getChangesForSession(sessionId) : [];

			// Fallback: scan message tool-call parts when the change tracker has no data
			if (fileChanges.length === 0 && sessionId) {
				const sess = powerModeService.getSession(sessionId);
				if (sess) {
					const seen = new Set<string>();
					for (const msg of sess.messages) {
						for (const part of msg.parts as any[]) {
							if (part.type === 'tool' && part.state?.status === 'completed') {
								const fp: string | undefined = part.state.input?.filePath ?? part.state.input?.file_path;
								const tool: string = part.toolName ?? '';
								if (fp && (tool === 'write' || tool === 'edit' || tool === 'multi_edit' || tool === 'notebook_edit') && !seen.has(fp)) {
									seen.add(fp);
									fileChanges.push({
										id: `msg-${part.id}`,
										filePath: fp,
										fileUri: null as any,
										changeType: tool === 'write' ? 'write' : 'edit',
										sessionId,
										agentId: msg.agentId,
										timestamp: msg.createdAt,
										contentBefore: null,
										contentAfter: '',
										linesAdded: 0,
										linesRemoved: 0,
										superseded: false,
									});
								}
							}
						}
					}
				}
			}

			const latestByFile = new Map<string, typeof fileChanges[0]>();
			for (const c of fileChanges) {
				const ex = latestByFile.get(c.filePath);
				if (!ex || c.timestamp > ex.timestamp) { latestByFile.set(c.filePath, c); }
			}
			const viewedSession = sessionId ? powerModeService.getSession(sessionId) : undefined;

			// SESSION INFO section
			if (viewedSession) {
				const msgs = viewedSession.messages as any[];
				const userCount = msgs.filter(m => m.role === 'user').length;
				const asstCount = msgs.filter(m => m.role === 'assistant').length;
				const toolCount = msgs.flatMap(m => (m.parts ?? []).filter((p: any) => p.type === 'tool' && p.state?.status === 'completed')).length;
				const totalCost = msgs.filter(m => m.role === 'assistant').reduce((s: number, m: any) => s + (m.cost ?? 0), 0);
				const totalTokens = msgs.filter(m => m.role === 'assistant').reduce((s: number, m: any) => s + ((m.tokens?.input ?? 0) + (m.tokens?.output ?? 0)), 0);
				const infoItems: IPMSidebarSection['items'] = [];
				infoItems.push({ label: 'Messages', description: `${userCount} user  ·  ${asstCount} assistant` });
				if (toolCount > 0) { infoItems.push({ label: 'Tools called', description: String(toolCount) }); }
				if (totalCost >= 0.0001) { infoItems.push({ label: 'Cost', description: `$${totalCost.toFixed(4)}` }); }
				if (totalTokens > 0) { infoItems.push({ label: 'Tokens', description: totalTokens.toLocaleString() }); }
				if (viewedSession.planMode) { infoItems.push({ label: 'Plan mode', description: 'active' }); }
				if ((viewedSession as any).worktree?.branch) { infoItems.push({ label: 'Worktree', description: `⎇ ${(viewedSession as any).worktree.branch}` }); }
				if ((viewedSession as any).permissionMode && (viewedSession as any).permissionMode !== 'default') {
					infoItems.push({ label: 'Permission', description: (viewedSession as any).permissionMode });
				}
				if (fileChanges.length > 0) { infoItems.push({ label: 'Files changed', description: String(latestByFile.size) }); }
				sections.push({ title: 'Session Info', collapsed: true, items: infoItems });
			}

			const fileItems = [...latestByFile.values()]
				.sort((a, b) => b.timestamp - a.timestamp)
				.map(c => ({
					label: c.filePath.split('/').pop() ?? c.filePath,
					description: cwd && c.filePath.startsWith(cwd) ? c.filePath.slice(cwd.length + 1) : c.filePath,
					meta: (c.linesAdded || c.linesRemoved) ? `+${c.linesAdded} \u2212${c.linesRemoved}` : c.changeType,
				}));
			const modTitle = viewedSession ? `Modified Files \u2014 ${viewedSession.title}` : 'Modified Files';
			sections.push({ title: modTitle, collapsed: false, items: fileItems.length ? fileItems : [{ label: 'No files modified yet' }] });
			return sections;
		};
		result.setSidebarSections(buildSections());
		powerModeService.onDidChangeSession(() => result.setSidebarSections(buildSections()));
		powerModeService.getChangeTracker().onDidChange(() => result.setSidebarSections(buildSections()));
	}
});

// ─── Command: Open Power Mode in Tab ─────────────────────────────────────────

registerAction2(class OpenPowerModeInTabAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.openPowerModeInTab',
			title: localize2('neuralInverse.openPowerModeInTab', 'Neural Inverse: Open Power Mode in Tab'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		if (_isPolicyBlocked(accessor.get(IEnterprisePolicyService))) { _notifyBlocked(accessor); return; }
		const webviewWorkbenchService = accessor.get(IWebviewWorkbenchService);
		const environmentService = accessor.get(INativeEnvironmentService);
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const powerModeService = accessor.get(IPowerModeService);
		const workspaceContextService = accessor.get(IWorkspaceContextService);
		const fileService = accessor.get(IFileService);

		const folders = workspaceContextService.getWorkspace().folders;
		const cwd = folders[0]?.uri.fsPath ?? (process.env['HOME'] ?? '/');

		const result = await openPowerModeInTab(webviewWorkbenchService, environmentService, editorGroupsService, cwd, false, fileService);
		const host = new PowerModeTerminalHost(powerModeService);
		host.mountWithTransport(result.terminal);
		result.webviewInput.onWillDispose(() => { result.disposeShell(); host.dispose(); });
	}
});

// ─── Command: Toggle Sessions sidebar (called from Power Mode titlebar) ───────

registerAction2(class TogglePowerModeSidebarAction extends Action2 {
	constructor() {
		super({ id: 'neuralInverse.powerMode.toggleSidebar', title: localize2('neuralInverse.powerMode.toggleSidebar', 'Toggle Sessions Sidebar'), f1: false });
	}
	run(): void { getActivePowerModeTerminal()?.toggleSidebar(); }
});

// ─── Register contribution ────────────────────────────────────────────────────

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(PowerModeContribution, LifecyclePhase.Restored);
