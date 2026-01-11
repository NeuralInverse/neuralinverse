
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { ProjectAnalyzer } from '../projectAnalyzer.js';
import { ILLMMessageService } from '../../../../void/common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../../../../void/common/voidSettingsService.js';
import { LLMChatMessage } from '../../../../void/common/sendLLMMessageTypes.js';

export class NanoAgentService extends Disposable {
	private conversationHistory: LLMChatMessage[] = [];

	constructor(
		private readonly projectAnalyzer: ProjectAnalyzer,
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
	) {
		super();
	}

	public async askAgent(
		userMessage: string,
		onToken: (text: string) => void,
		onComplete: (text: string) => void,
		onError: (error: string) => void
	): Promise<void> {

		// 1. Get Context
		const analysisState = this.projectAnalyzer.getAnalysisState();
		const stateStr = JSON.stringify(analysisState, null, 2);

		// 2. Build Messages
		if (this.conversationHistory.length === 0) {
			const systemPrompt = `You are a Nano Agent, an advanced AI integrated into the IDE.
Your goal is to help the user understand and improve their codebase.
You have access to a deep static analysis of the project.

Analysis Context:
${stateStr}

Rules:
- Be concise and technical.
- Reference specific file stats or capabilities if relevant.
- You are strictly helpful and safe.`;

			this.conversationHistory.push({ role: 'system', content: systemPrompt });
		}

		this.conversationHistory.push({ role: 'user', content: userMessage });

		// 3. Send to LLM
		// Check global settings first, then feature-specific settings
		// In previous code `globalSettings.modelSelectionOfFeature` was accessed but it might not exist on globalSettings directly depending on version.
		// Let's use `modelSelectionOfFeature` from state directly as it's the standard way.
		const modelSelection = this.voidSettingsService.state.modelSelectionOfFeature['Chat'];

		if (!modelSelection) {
			onError('No model selected for Chat.');
			return;
		}

		try {
			this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages: this.conversationHistory,
				modelSelection: modelSelection,
				modelSelectionOptions: undefined,
				overridesOfModel: undefined,
				separateSystemMessage: undefined,
				chatMode: 'agent', // Custom mode or 'agent'
				onText: (p) => {
					onToken(p.fullText);
				},
				onFinalMessage: (p) => {
					this.conversationHistory.push({ role: 'assistant', content: p.fullText });
					onComplete(p.fullText);
				},
				onError: (p) => {
					const msg = p.message || (p.fullError ? p.fullError.message : 'Unknown error');
					onError(msg);
				},
				onAbort: () => {
					onError('Aborted.');
				},
				logging: { loggingName: 'NanoAgent' },
				allowedToolNames: [] // No tools yet in Phase 1
			});
		} catch (e: any) {
			console.error('Agent Error:', e);
			onError('Failed to start agent: ' + e.message);
		}
	}

	public clearHistory() {
		this.conversationHistory = [];
	}
}
