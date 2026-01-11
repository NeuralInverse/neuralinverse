/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';

export interface IChatMessage {
	role: 'user' | 'agent' | 'system';
	content: string;
	timestamp?: number;
}

export class NeuralInverseChat extends Disposable {

	constructor() {
		super();
	}

	public getCss(): string {
		return `
			:root {
				--chat-bg: var(--vscode-editor-background);
				--chat-fg: var(--vscode-editor-foreground);
				--user-bubble-bg: var(--vscode-button-background);
				--user-bubble-fg: var(--vscode-button-foreground);
				--agent-bubble-bg: var(--vscode-editor-inactiveSelectionBackground);
				--agent-bubble-fg: var(--vscode-editor-foreground);
				--input-bg: var(--vscode-input-background);
				--input-fg: var(--vscode-input-foreground);
				--input-border: var(--vscode-input-border);
			}

			.chat-container {
				display: flex;
				flex-direction: column;
				height: 100%;
				font-family: var(--vscode-font-family);
				font-size: var(--vscode-font-size);
				background-color: var(--chat-bg);
				color: var(--chat-fg);
			}

			.chat-history {
				flex: 1;
				overflow-y: auto;
				padding: 20px;
				display: flex;
				flex-direction: column;
				gap: 16px;
			}

			.message {
				display: flex;
				flex-direction: column;
				max-width: 85%;
				animation: fadeIn 0.3s ease;
			}

			.message.user {
				align-self: flex-end;
				align-items: flex-end;
			}

			.message.agent {
				align-self: flex-start;
				align-items: flex-start;
			}

			.bubble {
				padding: 10px 16px;
				border-radius: 12px;
				line-height: 1.5;
				position: relative;
				word-wrap: break-word;
				font-size: 13px;
			}

			.message.user .bubble {
				background-color: var(--user-bubble-bg);
				color: var(--user-bubble-fg);
				border-bottom-right-radius: 2px;
			}

			.message.agent .bubble {
				background-color: var(--agent-bubble-bg);
				color: var(--agent-bubble-fg);
				border-bottom-left-radius: 2px;
				border: 1px solid var(--vscode-widget-border);
			}

			.sender-name {
				font-size: 11px;
				margin-bottom: 4px;
				opacity: 0.6;
				margin-left: 4px;
			}

			.message.user .sender-name {
				margin-right: 4px;
			}

			.input-area {
				padding: 16px;
				border-top: 1px solid var(--vscode-panel-border);
				background: var(--chat-bg);
			}

			.input-wrapper {
				position: relative;
				display: flex;
				gap: 8px;
				align-items: flex-end;
				background: var(--input-bg);
				border: 1px solid var(--input-border);
				border-radius: 6px;
				padding: 8px;
			}

			.input-wrapper:focus-within {
				border-color: var(--vscode-focusBorder);
			}

			textarea {
				flex: 1;
				background: transparent;
				border: none;
				color: var(--input-fg);
				font-family: inherit;
				font-size: inherit;
				resize: none;
				outline: none;
				min-height: 24px;
				max-height: 200px;
				padding: 0;
				line-height: 1.5;
			}

			.send-btn {
				background: var(--vscode-button-background);
				color: var(--vscode-button-foreground);
				border: none;
				border-radius: 4px;
				width: 28px;
				height: 28px;
				display: flex;
				align-items: center;
				justify-content: center;
				cursor: pointer;
				transition: opacity 0.2s;
				padding: 0;
			}

			.send-btn:hover {
				opacity: 0.9;
			}

			.send-btn svg {
				width: 16px;
				height: 16px;
				fill: currentColor;
			}

			@keyframes fadeIn {
				from { opacity: 0; transform: translateY(5px); }
				to { opacity: 1; transform: translateY(0); }
			}

			/* Markdown Rendering Basics */
			.bubble pre {
				background: rgba(0,0,0,0.2);
				padding: 8px;
				border-radius: 4px;
				overflow-x: auto;
				margin: 8px 0;
			}

			.bubble code {
				font-family: var(--vscode-editor-font-family);
				font-size: 0.9em;
			}
		`;
	}

	public getHtmlContainer(): string {
		return `
			<div class="chat-container">
				<div id="chat-history" class="chat-history">
					<!-- Messages injected here -->
					<div class="message agent">
						<div class="sender-name">Nano Agent</div>
						<div class="bubble">Hello! I'm your Nano Agent. How can I help you improve your code today?</div>
					</div>
				</div>
				<div class="input-area">
					<div class="input-wrapper">
						<textarea id="chat-input" placeholder="Ask anything..." rows="1" oninput="this.style.height = ''; this.style.height = this.scrollHeight + 'px'"></textarea>
						<button class="send-btn" onclick="sendChat()">
							<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
						</button>
					</div>
				</div>
			</div>
		`;
	}

	public getJs(): string {
		return `
			const chatHistory = document.getElementById('chat-history');
			const chatInput = document.getElementById('chat-input');
			let isProcessing = false;

			function scrollToBottom() {
				chatHistory.scrollTop = chatHistory.scrollHeight;
			}

			function appendMessage(role, text) {
				const msgDiv = document.createElement('div');
				msgDiv.className = 'message ' + role;

				const sender = role === 'user' ? 'You' : 'Nano Agent';

				msgDiv.innerHTML = \`
					<div class="sender-name">\${sender}</div>
					<div class="bubble">\${text}</div>
				\`; // Note: text should be escaped or sanitized in production!

				chatHistory.appendChild(msgDiv);
				scrollToBottom();
				return msgDiv.querySelector('.bubble');
			}

			function sendChat() {
				const text = chatInput.value.trim();
				if (!text) return;

				appendMessage('user', text);
				chatInput.value = '';
				chatInput.style.height = 'auto';

				// Send to host
				vscode.postMessage({ command: 'askAgent', text: text });

				// Optional: Add loading state
				// appendMessage('agent', 'Thinking...');
			}

			chatInput.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					sendChat();
				}
			});

			window.addEventListener('message', event => {
				const message = event.data;

				if (message.command === 'chatToken') {
					// Handle streaming token ... logic needed to append to last agent message
					const lastMsg = chatHistory.lastElementChild;
					if (lastMsg && lastMsg.classList.contains('agent')) {
						const bubble = lastMsg.querySelector('.bubble');
						// simple append for now
						bubble.innerText = message.text; // Text from backend is accumulation or delta? Backend sends full text usually in this setup.
					} else {
						appendMessage('agent', message.text);
					}
					scrollToBottom();
				}
				else if (message.command === 'chatComplete') {
					// Finalize
				}
				else if (message.command === 'chatError') {
					appendMessage('agent', 'Error: ' + message.text).style.color = 'var(--vscode-errorForeground)';
				}
			});
		`;
	}
}
