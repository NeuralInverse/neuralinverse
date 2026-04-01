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
import { PowerModeUIEvent, PowerModeUICommand } from '../common/powerModeTypes.js';
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
				break;
			}

			case 'invoke-skill': {
				this.powerModeService.invokeSkill(cmd.sessionId, cmd.skillName, cmd.args)
					.catch(() => { /* non-fatal */ });
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
