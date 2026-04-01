/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

/**
 * PowerModeWebviewHost — bridges the PowerModeService to the webview UI.
 *
 * Responsibilities:
 * - Creates and manages the webview element
 * - Forwards service events to webview as postMessage
 * - Handles webview commands (send-message, create-session, etc.)
 * - Manages the webview lifecycle
 */

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { getWindow } from '../../../../base/browser/dom.js';
import { IWebviewService, IWebviewElement } from '../../webview/browser/webview.js';
import { IPowerModeService } from './powerModeService.js';
import { PowerModeUIEvent, PowerModeUICommand, IModelOption, ITaskInfo, IChangeInfo, IAgentInfo, IBusMessageInfo } from '../common/powerModeTypes.js';
import { getPowerModeHTML } from './ui/powerModePanel.js';

export class PowerModeWebviewHost extends Disposable {

	private _webview: IWebviewElement | undefined;
	private readonly _webviewListeners = this._register(new DisposableStore());

	constructor(
		private readonly powerModeService: IPowerModeService,
		private readonly webviewService: IWebviewService,
	) {
		super();
	}

	/**
	 * Create the webview and mount it into the given container element.
	 * Returns the webview element for layout management.
	 */
	createWebview(container: HTMLElement): IWebviewElement {
		// Clean up previous
		this._webviewListeners.clear();
		this._webview?.dispose();

		const webview = this.webviewService.createWebviewElement({
			providedViewType: 'powerMode',
			title: 'Neural Inverse Power Mode',
			options: {
				enableFindWidget: false,
				retainContextWhenHidden: true,
			},
			contentOptions: {
				allowScripts: true,
				localResourceRoots: [],
			},
			extension: undefined,
		});

		this._webview = webview;

		// Generate HTML with nonce for CSP
		const nonce = generateNonce();
		webview.setHtml(getPowerModeHTML(nonce));

		// Mount into container
		webview.mountTo(container, getWindow(container));

		// ─── Forward service events to webview ───────────────────
		this._webviewListeners.add(
			this.powerModeService.onDidEmitUIEvent((event: PowerModeUIEvent) => {
				webview.postMessage(event);
			})
		);

		// ─── Handle webview commands ─────────────────────────────
		this._webviewListeners.add(
			webview.onMessage((e: { message: PowerModeUICommand }) => {
				this._handleCommand(e.message);
			})
		);

		return webview;
	}

	private _handleCommand(cmd: PowerModeUICommand): void {
		switch (cmd.type) {
			case 'create-session': {
				this.powerModeService.createSession(cmd.agentId);
				// Session created event is fired by the service
				break;
			}

			case 'send-message': {
				this.powerModeService.sendMessage(cmd.sessionId, cmd.text);
				break;
			}

			case 'switch-session': {
				this.powerModeService.switchSession(cmd.sessionId);
				// Re-send the full session state to the webview
				const session = this.powerModeService.getSession(cmd.sessionId);
				if (session) {
					this._webview?.postMessage({
						type: 'session-created',
						session,
					} satisfies PowerModeUIEvent);

					// Replay all messages
					for (const msg of session.messages) {
						this._webview?.postMessage({
							type: 'message-created',
							message: msg,
						} satisfies PowerModeUIEvent);
						// Replay parts
						for (const part of msg.parts) {
							this._webview?.postMessage({
								type: 'part-updated',
								sessionId: session.id,
								messageId: msg.id,
								part,
							} satisfies PowerModeUIEvent);
						}
					}

					this._webview?.postMessage({
						type: 'session-updated',
						sessionId: session.id,
						status: session.status,
					} satisfies PowerModeUIEvent);
				}
				break;
			}

			case 'cancel': {
				this.powerModeService.cancel(cmd.sessionId);
				break;
			}

			case 'list-sessions': {
				this._webview?.postMessage({
					type: 'sessions-list',
					sessions: [...this.powerModeService.sessions],
				} satisfies PowerModeUIEvent);
				break;
			}

			case 'compact': {
				this.powerModeService.triggerCompact(cmd.sessionId).catch(() => { /* non-fatal */ });
				break;
			}

			case 'permission-response': {
				this.powerModeService.resolvePermission(cmd.requestId, cmd.decision);
				break;
			}

			case 'question-response': {
				this.powerModeService.resolveQuestion(cmd.questionId, cmd.answer);
				break;
			}

			case 'ready': {
				// Webview is ready — send current state
				const active = this.powerModeService.activeSession;
				if (active) {
					this._webview?.postMessage({
						type: 'session-created',
						session: active,
					} satisfies PowerModeUIEvent);

					for (const msg of active.messages) {
						this._webview?.postMessage({
							type: 'message-created',
							message: msg,
						} satisfies PowerModeUIEvent);
						for (const part of msg.parts) {
							this._webview?.postMessage({
								type: 'part-updated',
								sessionId: active.id,
								messageId: msg.id,
								part,
							} satisfies PowerModeUIEvent);
						}
					}
				}

				this._webview?.postMessage({
					type: 'sessions-list',
					sessions: [...this.powerModeService.sessions],
				} satisfies PowerModeUIEvent);

				// Send CC bundled skills for typeahead
				this._webview?.postMessage({
					type: 'skill-list',
					skills: this.powerModeService.getSkillsList(),
				} satisfies PowerModeUIEvent);

				// Send current model info
				const readyModelInfo = this.powerModeService.getModelInfo();
				this._webview?.postMessage({
					type: 'model-info',
					model: readyModelInfo?.model ?? null,
					provider: readyModelInfo?.provider ?? null,
				} satisfies PowerModeUIEvent);
				break;
			}

			case 'invoke-skill': {
				this.powerModeService.invokeSkill(cmd.sessionId, cmd.skillName, cmd.args)
					.catch(() => { /* non-fatal */ });
				break;
			}

			case 'clear-session': {
				this.powerModeService.clearSession(cmd.sessionId);
				break;
			}

			case 'get-models': {
				const allModels = this.powerModeService.getAvailableModels();
				const current = this.powerModeService.getModelInfo();
				this._webview?.postMessage({
					type: 'models-info',
					models: allModels.map((o): IModelOption => ({
						name: o.name,
						providerName: o.selection.providerName,
						modelName: o.selection.modelName,
					})),
					current: current ? { model: current.model, provider: current.provider } : null,
				} satisfies PowerModeUIEvent);
				break;
			}

			case 'set-model': {
				const allModels = this.powerModeService.getAvailableModels();
				const match = allModels.find(
					o => o.selection.providerName === cmd.providerName && o.selection.modelName === cmd.modelName
				);
				if (match) {
					this.powerModeService.setModel(match.selection);
					const updated = this.powerModeService.getModelInfo();
					this._webview?.postMessage({
						type: 'model-info',
						model: updated?.model ?? null,
						provider: updated?.provider ?? null,
					} satisfies PowerModeUIEvent);
				}
				break;
			}

			case 'get-tasks': {
				const tasks = this.powerModeService.getTasks();
				this._webview?.postMessage({
					type: 'tasks-info',
					tasks: tasks.map((t): ITaskInfo => ({
						id: String(t.id),
						title: t.title,
						description: t.description,
						status: t.status,
					})),
				} satisfies PowerModeUIEvent);
				break;
			}

			case 'get-memory': {
				this.powerModeService.listMemoryFiles().then(keys => {
					this._webview?.postMessage({
						type: 'memory-info',
						keys,
					} satisfies PowerModeUIEvent);
				}).catch(() => {
					this._webview?.postMessage({ type: 'memory-info', keys: [] } satisfies PowerModeUIEvent);
				});
				break;
			}

			case 'get-changes': {
				const group = this.powerModeService.getLatestChanges();
				this._webview?.postMessage({
					type: 'changes-info',
					changeGroup: group ? {
						sessionId: group.sessionId,
						agentId: group.agentId ?? '',
						changes: group.changes.map((c): IChangeInfo => ({
							id: c.id,
							filePath: c.filePath,
							linesAdded: c.linesAdded,
							linesRemoved: c.linesRemoved,
							superseded: c.superseded,
							contentBefore: c.contentBefore,
							contentAfter: c.contentAfter,
						})),
					} : null,
				} satisfies PowerModeUIEvent);
				break;
			}

			case 'rollback': {
				const group = this.powerModeService.getLatestChanges();
				if (!group) {
					this._webview?.postMessage({ type: 'rollback-result', success: false, error: 'No changes to roll back' } satisfies PowerModeUIEvent);
					break;
				}
				const tracker = this.powerModeService.getChangeTracker();
				if (cmd.target === 'all') {
					tracker.rollbackGroup(group.sessionId, group.agentId).then(count => {
						this._webview?.postMessage({ type: 'rollback-result', success: true, count } satisfies PowerModeUIEvent);
					}).catch((err: any) => {
						this._webview?.postMessage({ type: 'rollback-result', success: false, error: String(err?.message ?? err) } satisfies PowerModeUIEvent);
					});
				} else {
					const change = group.changes.find(c => {
						const fname = c.filePath.split('/').pop() || '';
						return fname === cmd.target || c.filePath.endsWith(cmd.target);
					});
					if (!change) {
						this._webview?.postMessage({ type: 'rollback-result', success: false, error: 'File not found: ' + cmd.target } satisfies PowerModeUIEvent);
						break;
					}
					tracker.rollbackChange(change.id).then(ok => {
						this._webview?.postMessage({ type: 'rollback-result', success: ok, count: ok ? 1 : 0 } satisfies PowerModeUIEvent);
					}).catch((err: any) => {
						this._webview?.postMessage({ type: 'rollback-result', success: false, error: String(err?.message ?? err) } satisfies PowerModeUIEvent);
					});
				}
				break;
			}

			case 'get-agents': {
				const agents = this.powerModeService.getAgentsOnBus();
				const history = this.powerModeService.getBusHistory(20);
				this._webview?.postMessage({
					type: 'agents-info',
					agents: agents.map((a): IAgentInfo => ({
						agentId: a.agentId,
						displayName: a.displayName,
						capabilities: a.capabilities,
						registeredAt: a.registeredAt,
					})),
					history: history.map((m): IBusMessageInfo => ({
						from: m.from,
						to: m.to,
						type: m.type,
						content: m.content,
						timestamp: m.timestamp,
					})),
				} satisfies PowerModeUIEvent);
				break;
			}
		}
	}

	get webview(): IWebviewElement | undefined {
		return this._webview;
	}

	override dispose(): void {
		this._webview?.dispose();
		super.dispose();
	}
}

function generateNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let result = '';
	for (let i = 0; i < 32; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return result;
}
