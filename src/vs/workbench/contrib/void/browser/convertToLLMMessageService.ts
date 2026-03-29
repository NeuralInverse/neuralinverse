import { Disposable } from '../../../../base/common/lifecycle.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ChatMessage } from '../common/chatThreadServiceTypes.js';
import { getIsReasoningEnabledState, getReservedOutputTokenSpace, getModelCapabilities } from '../common/modelCapabilities.js';
import { reParsedToolXMLString, chat_systemMessage } from '../common/prompt/prompts.js';
import { AnthropicLLMChatMessage, AnthropicReasoning, GeminiLLMChatMessage, LLMChatMessage, LLMFIMMessage, OpenAILLMChatMessage, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { ChatMode, FeatureName, ModelSelection, ProviderName } from '../common/voidSettingsTypes.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { ITerminalToolService } from './terminalToolService.js';
import { IVoidModelService } from '../common/voidModelService.js';
import { URI } from '../../../../base/common/uri.js';
import { EndOfLinePreference } from '../../../../editor/common/model.js';
import { ToolName } from '../common/toolsServiceTypes.js';
import { IMCPService } from '../common/mcpService.js';
import { IVoidInternalToolService } from './voidInternalToolService.js';
import { INeuralInverseAgentService } from './neuralInverseAgentService.js';
import { IModernisationSessionService } from '../../neuralInverseModernisation/browser/modernisationSessionService.js';
import { IKnowledgeBaseService } from '../../neuralInverseModernisation/browser/knowledgeBase/service.js';

export const EMPTY_MESSAGE = '(empty message)'



type SimpleLLMMessage = {
	role: 'tool';
	content: string;
	id: string;
	name: ToolName;
	rawParams: RawToolParamsObj;
} | {
	role: 'user';
	content: string;
	images?: { data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/bmp'; fileName?: string }[]; // base64 encoded images
} | {
	role: 'assistant';
	content: string;
	anthropicReasoning: AnthropicReasoning[] | null;
}



const CHARS_PER_TOKEN = 4 // assume abysmal chars per token
const TRIM_TO_LEN = 120




// convert messages as if about to send to openai
/*
reference - https://platform.openai.com/docs/guides/function-calling#function-calling-steps
openai MESSAGE (role=assistant):
"tool_calls":[{
	"type": "function",
	"id": "call_12345xyz",
	"function": {
	"name": "get_weather",
	"arguments": "{\"latitude\":48.8566,\"longitude\":2.3522}"
}]

openai RESPONSE (role=user):
{   "role": "tool",
	"tool_call_id": tool_call.id,
	"content": str(result)    }

also see
openai on prompting - https://platform.openai.com/docs/guides/reasoning#advice-on-prompting
openai on developer system message - https://cdn.openai.com/spec/model-spec-2024-05-08.html#follow-the-chain-of-command
*/


const prepareMessages_openai_tools = (messages: SimpleLLMMessage[]): AnthropicOrOpenAILLMMessage[] => {

	const newMessages: OpenAILLMChatMessage[] = [];

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		if (currMsg.role === 'user') {
			// Handle images for OpenAI format
			if (currMsg.images && currMsg.images.length > 0) {
				const contentParts: ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'auto' } })[] = [];
				if (currMsg.content) {
					contentParts.push({ type: 'text', text: currMsg.content });
				}
				for (const img of currMsg.images) {
					contentParts.push({
						type: 'image_url',
						image_url: {
							url: `data:${img.mimeType};base64,${img.data}`,
							detail: 'auto'
						}
					});
				}
				newMessages.push({
					role: 'user',
					content: contentParts
				});
			} else {
				newMessages.push(currMsg);
			}
			continue
		}

		if (currMsg.role !== 'tool') {
			newMessages.push(currMsg)
			continue
		}

		// Find the last assistant message in the already-built output and append the tool_call.
		// Using [...].reverse().find() because newMessages is built sequentially and multiple
		// tool messages in one turn must all attach to the same assistant entry.
		let lastAssistantMsg = [...newMessages].reverse().find(m => m.role === 'assistant') as OpenAILLMChatMessage | undefined;

		// If no preceding assistant message exists, inject a synthetic one so the
		// tool result has a valid tool_calls parent (OpenAI requires this).
		if (!lastAssistantMsg || lastAssistantMsg.role !== 'assistant') {
			lastAssistantMsg = { role: 'assistant', content: '' };
			newMessages.push(lastAssistantMsg);
		}

		if (!lastAssistantMsg.tool_calls) lastAssistantMsg.tool_calls = [];
		lastAssistantMsg.tool_calls.push({
			type: 'function',
			id: currMsg.id,
			function: {
				name: currMsg.name,
				arguments: JSON.stringify(currMsg.rawParams)
			}
		});

		// add the tool result
		newMessages.push({
			role: 'tool',
			tool_call_id: currMsg.id,
			content: currMsg.content,
		})
	}
	return newMessages

}



// convert messages as if about to send to anthropic
/*
https://docs.anthropic.com/en/docs/build-with-claude/tool-use#tool-use-examples
anthropic MESSAGE (role=assistant):
"content": [{
	"type": "text",
	"text": "<thinking>I need to call the get_weather function, and the user wants SF, which is likely San Francisco, CA.</thinking>"
}, {
	"type": "tool_use",
	"id": "toolu_01A09q90qw90lq917835lq9",
	"name": "get_weather",
	"input": { "location": "San Francisco, CA", "unit": "celsius" }
}]
anthropic RESPONSE (role=user):
"content": [{
	"type": "tool_result",
	"tool_use_id": "toolu_01A09q90qw90lq917835lq9",
	"content": "15 degrees"
}]


Converts:
assistant: ...content
tool: (id, name, params)
->
assistant: ...content, call(name, id, params)
user: ...content, result(id, content)
*/

type AnthropicOrOpenAILLMMessage = AnthropicLLMChatMessage | OpenAILLMChatMessage

const prepareMessages_anthropic_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean): AnthropicOrOpenAILLMMessage[] => {
	const newMessages: (AnthropicLLMChatMessage | (SimpleLLMMessage & { role: 'tool' }))[] = messages;

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		// add anthropic reasoning
		if (currMsg.role === 'assistant') {
			if (currMsg.anthropicReasoning && supportsAnthropicReasoning) {
				const content = currMsg.content
				newMessages[i] = {
					role: 'assistant',
					content: content ? [...currMsg.anthropicReasoning, { type: 'text' as const, text: content }] : currMsg.anthropicReasoning
				}
			}
			else {
				newMessages[i] = {
					role: 'assistant',
					content: currMsg.content,
					// strip away anthropicReasoning
				}
			}
			continue
		}

		if (currMsg.role === 'user') {
			// Handle images for Anthropic format
			if (currMsg.images && currMsg.images.length > 0) {
				const contentParts: ({ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string } })[] = [];
				if (currMsg.content) {
					contentParts.push({ type: 'text', text: currMsg.content });
				}
				for (const img of currMsg.images) {
					// Anthropic only supports png, jpeg, gif, webp - skip BMP
					if (img.mimeType === 'image/bmp') {
						console.warn('[Anthropic] BMP images not supported, skipping');
						continue;
					}
					contentParts.push({
						type: 'image',
						source: {
							type: 'base64',
							media_type: img.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
							data: img.data
						}
					});
				}
				newMessages[i] = {
					role: 'user',
					content: contentParts
				};
			} else {
				newMessages[i] = {
					role: 'user',
					content: currMsg.content,
				};
			}
			continue
		}

		if (currMsg.role === 'tool') {
			// Scan backwards through the ORIGINAL messages[] to find the last assistant message.
			// We cannot use newMessages[i-1] because a prior tool in the same batch already
			// rewrote that slot to a user/tool_result message.
			let lastAssistantIdx = -1;
			for (let j = i - 1; j >= 0; j--) {
				if (messages[j].role === 'assistant') { lastAssistantIdx = j; break; }
			}

			// make it so the assistant called the tool
			const prevAssistantMsg = lastAssistantIdx >= 0 ? newMessages[lastAssistantIdx] as AnthropicLLMChatMessage : undefined;
			if (prevAssistantMsg?.role === 'assistant') {
				if (typeof prevAssistantMsg.content === 'string') prevAssistantMsg.content = prevAssistantMsg.content ? [{ type: 'text' as const, text: prevAssistantMsg.content }] : [];
				(prevAssistantMsg.content as any[]).push({ type: 'tool_use', id: currMsg.id, name: currMsg.name, input: currMsg.rawParams });
			}

			// turn each tool into a user message with tool results at the end
			newMessages[i] = {
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: currMsg.id, content: currMsg.content }]
			}
			continue
		}

	}

	// Merge consecutive tool_result user messages into one user message.
	// Anthropic/Bedrock require all tool_results from the same turn to be in a single user message.
	const merged: AnthropicOrOpenAILLMMessage[] = [];
	for (let i = 0; i < newMessages.length; i++) {
		const msg = newMessages[i] as AnthropicLLMChatMessage;
		if (msg?.role === 'user' && Array.isArray(msg.content) && (msg.content as any[])[0]?.type === 'tool_result') {
			const toolResults: any[] = [...(msg.content as any[])];
			while (i + 1 < newMessages.length) {
				const next = newMessages[i + 1] as AnthropicLLMChatMessage;
				if (next?.role === 'user' && Array.isArray(next.content) && (next.content as any[])[0]?.type === 'tool_result') {
					toolResults.push(...(next.content as any[]));
					i++;
				} else break;
			}
			merged.push({ role: 'user', content: toolResults } as AnthropicLLMChatMessage);
		} else {
			merged.push(msg);
		}
	}
	return merged as AnthropicLLMChatMessage[]
}


const prepareMessages_XML_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean): AnthropicOrOpenAILLMMessage[] => {

	const llmChatMessages: AnthropicOrOpenAILLMMessage[] = [];
	for (let i = 0; i < messages.length; i += 1) {

		const c = messages[i]
		const next = 0 <= i + 1 && i + 1 <= messages.length - 1 ? messages[i + 1] : null

		if (c.role === 'assistant') {
			// if called a tool (message after it), re-add its XML to the message
			// alternatively, could just hold onto the original output, but this way requires less piping raw strings everywhere
			let content: AnthropicOrOpenAILLMMessage['content'] = c.content
			if (next?.role === 'tool') {
				content = `${content}\n\n${reParsedToolXMLString(next.name, next.rawParams)}`
			}

			// anthropic reasoning
			if (c.anthropicReasoning && supportsAnthropicReasoning) {
				content = content ? [...c.anthropicReasoning, { type: 'text' as const, text: content }] : c.anthropicReasoning
			}
			llmChatMessages.push({
				role: 'assistant',
				content
			})
		}
		// add user or tool to the previous user message
		else if (c.role === 'user' || c.role === 'tool') {
			let contentToAdd = c.content;

			// Handle images for XML format (convert to text description)
			if (c.role === 'user' && c.images && c.images.length > 0) {
				const imageDescriptions = c.images.map((img, idx) =>
					`[Image ${idx + 1}: ${img.fileName || 'image'} (${img.mimeType})]`
				).join('\n');
				contentToAdd = c.content ? `${c.content}\n\n${imageDescriptions}` : imageDescriptions;
			}

			if (c.role === 'tool')
				contentToAdd = `<${c.name}_result>\n${contentToAdd}\n</${c.name}_result>`

			if (llmChatMessages.length === 0 || llmChatMessages[llmChatMessages.length - 1].role !== 'user')
				llmChatMessages.push({
					role: 'user',
					content: contentToAdd
				})
			else
				llmChatMessages[llmChatMessages.length - 1].content += '\n\n' + contentToAdd
		}
	}
	return llmChatMessages
}


// --- CHAT ---

const prepareOpenAIOrAnthropicMessages = ({
	messages: messages_,
	systemMessage,
	aiInstructions,
	supportsSystemMessage,
	specialToolFormat,
	supportsAnthropicReasoning,
	contextWindow,
	reservedOutputTokenSpace,
}: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	aiInstructions: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | 'anthropic-style' | undefined,
	supportsAnthropicReasoning: boolean,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
}): { messages: AnthropicOrOpenAILLMMessage[], separateSystemMessage: string | undefined } => {

	reservedOutputTokenSpace = Math.max(
		contextWindow * 1 / 2, // reserve at least 1/4 of the token window length
		reservedOutputTokenSpace ?? 4_096 // defaults to 4096
	)
	let messages: (SimpleLLMMessage | { role: 'system', content: string })[] = deepClone(messages_)

	// ================ system message ================
	// A COMPLETE HACK: last message is system message for context purposes

	const sysMsgParts: string[] = []
	if (aiInstructions) sysMsgParts.push(`GUIDELINES (from the user's .neuralinverserules file):\n${aiInstructions}`)
	if (systemMessage) sysMsgParts.push(systemMessage)
	const combinedSystemMessage = sysMsgParts.join('\n\n')

	messages.unshift({ role: 'system', content: combinedSystemMessage })

	// ================ trim ================
	messages = messages.map(m => ({ ...m, content: m.role !== 'tool' ? m.content.trim() : m.content }))

	type MesType = (typeof messages)[0]

	// ================ fit into context ================

	// the higher the weight, the higher the desire to truncate - TRIM HIGHEST WEIGHT MESSAGES
	const alreadyTrimmedIdxes = new Set<number>()
	const weight = (message: MesType, messages: MesType[], idx: number) => {
		const base = message.content.length

		let multiplier: number
		multiplier = 1 + (messages.length - 1 - idx) / messages.length // slow rampdown from 2 to 1 as index increases
		if (message.role === 'user') {
			multiplier *= 1
		}
		else if (message.role === 'system') {
			multiplier *= .01 // very low weight
		}
		else {
			multiplier *= 10 // llm tokens are far less valuable than user tokens
		}

		// any already modified message should not be trimmed again
		if (alreadyTrimmedIdxes.has(idx)) {
			multiplier = 0
		}
		// 1st and last messages should be very low weight
		if (idx <= 1 || idx >= messages.length - 1 - 3) {
			multiplier *= .05
		}
		return base * multiplier
	}

	const _findLargestByWeight = (messages_: MesType[]) => {
		let largestIndex = -1
		let largestWeight = -Infinity
		for (let i = 0; i < messages.length; i += 1) {
			const m = messages[i]
			const w = weight(m, messages_, i)
			if (w > largestWeight) {
				largestWeight = w
				largestIndex = i
			}
		}
		return largestIndex
	}

	let totalLen = 0
	for (const m of messages) { totalLen += m.content.length }
	const charsNeedToTrim = totalLen - Math.max(
		(contextWindow - reservedOutputTokenSpace) * CHARS_PER_TOKEN, // can be 0, in which case charsNeedToTrim=everything, bad
		5_000 // ensure we don't trim at least 5k chars (just a random small value)
	)


	// <----------------------------------------->
	// 0                      |    |             |
	//                        |    contextWindow |
	//                     contextWindow - maxOut|putTokens
	//                                          totalLen
	let remainingCharsToTrim = charsNeedToTrim
	let i = 0

	while (remainingCharsToTrim > 0) {
		i += 1
		if (i > 100) break

		const trimIdx = _findLargestByWeight(messages)
		const m = messages[trimIdx]

		// if can finish here, do
		const numCharsWillTrim = m.content.length - TRIM_TO_LEN
		if (numCharsWillTrim > remainingCharsToTrim) {
			// trim remainingCharsToTrim + '...'.length chars
			m.content = m.content.slice(0, m.content.length - remainingCharsToTrim - '...'.length).trim() + '...'
			break
		}

		remainingCharsToTrim -= numCharsWillTrim
		m.content = m.content.substring(0, TRIM_TO_LEN - '...'.length) + '...'
		alreadyTrimmedIdxes.add(trimIdx)
	}

	// ================ system message hack ================
	const newSysMsg = messages.shift()!.content


	// ================ tools and anthropicReasoning ================
	// SYSTEM MESSAGE HACK: we shifted (removed) the system message role, so now SimpleLLMMessage[] is valid

	let llmChatMessages: AnthropicOrOpenAILLMMessage[] = []
	if (!specialToolFormat) { // XML tool behavior
		llmChatMessages = prepareMessages_XML_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning)
	}
	else if (specialToolFormat === 'anthropic-style') {
		llmChatMessages = prepareMessages_anthropic_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning)
	}
	else if (specialToolFormat === 'openai-style') {
		llmChatMessages = prepareMessages_openai_tools(messages as SimpleLLMMessage[])
	}
	const llmMessages = llmChatMessages


	// ================ system message add as first llmMessage ================

	let separateSystemMessageStr: string | undefined = undefined

	// if supports system message
	if (supportsSystemMessage) {
		if (supportsSystemMessage === 'separated')
			separateSystemMessageStr = newSysMsg
		else if (supportsSystemMessage === 'system-role')
			llmMessages.unshift({ role: 'system', content: newSysMsg }) // add new first message
		else if (supportsSystemMessage === 'developer-role')
			llmMessages.unshift({ role: 'developer', content: newSysMsg }) // add new first message
	}
	// if does not support system message
	else {
		const newFirstMessage = {
			role: 'user',
			content: `<SYSTEM_MESSAGE>\n${newSysMsg}\n</SYSTEM_MESSAGE>\n${llmMessages[0].content}`
		} as const
		llmMessages.splice(0, 1) // delete first message
		llmMessages.unshift(newFirstMessage) // add new first message
	}


	// ================ no empty message ================
	for (let i = 0; i < llmMessages.length; i += 1) {
		const currMsg: AnthropicOrOpenAILLMMessage = llmMessages[i]
		const nextMsg: AnthropicOrOpenAILLMMessage | undefined = llmMessages[i + 1]

		if (currMsg.role === 'tool') continue

		// if content is a string, replace string with empty msg
		if (typeof currMsg.content === 'string') {
			// Do not inject (empty message). Keep it empty.
		}
		else {
			// allowed to be empty if has a tool in it or following it
			if (currMsg.content.find(c => c.type === 'tool_result' || c.type === 'tool_use')) {
				currMsg.content = currMsg.content.filter(c => !(c.type === 'text' && !c.text)) as any
				continue
			}
			if (nextMsg?.role === 'tool') continue

			// remove any empty text entries without injecting (empty message)
			for (const c of currMsg.content) {
				if (c.type === 'text' && !c.text) c.text = ''
			}
			if (currMsg.content.length === 0) currMsg.content = [{ type: 'text', text: '' }]
		}
	}

	return {
		messages: llmMessages,
		separateSystemMessage: separateSystemMessageStr,
	} as const
}




type GeminiUserPart = (GeminiLLMChatMessage & { role: 'user' })['parts'][0]
type GeminiModelPart = (GeminiLLMChatMessage & { role: 'model' })['parts'][0]
const prepareGeminiMessages = (messages: AnthropicLLMChatMessage[]) => {
	let latestToolName: ToolName | undefined = undefined
	const messages2: GeminiLLMChatMessage[] = messages.map((m): GeminiLLMChatMessage | null => {
		if (m.role === 'assistant') {
			if (typeof m.content === 'string') {
				return { role: 'model', parts: [{ text: m.content }] }
			}
			else {
				const parts: GeminiModelPart[] = m.content.map((c): GeminiModelPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'tool_use') {
						latestToolName = c.name
						return { functionCall: { id: c.id, name: c.name, args: c.input } }
					}
					else return null
				}).filter(m => !!m)
				return { role: 'model', parts, }
			}
		}
		else if (m.role === 'user') {
			if (typeof m.content === 'string') {
				return { role: 'user', parts: [{ text: m.content }] } satisfies GeminiLLMChatMessage
			}
			else {
				const parts: GeminiUserPart[] = m.content.map((c): GeminiUserPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'image') {
						// Convert Anthropic image format to Gemini inlineData format
						// BMP already filtered out in Anthropic conversion above
						return { inlineData: { mimeType: c.source.media_type, data: c.source.data } }
					}
					else if (c.type === 'tool_result') {
						if (!latestToolName) return null
						return { functionResponse: { id: c.tool_use_id, name: latestToolName, response: { output: c.content } } }
					}
					else return null
				}).filter(m => !!m)
				return { role: 'user', parts, }
			}

		}
		else return null
	}).filter(m => !!m)

	return messages2
}


const prepareMessages = (params: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	aiInstructions: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined,
	supportsAnthropicReasoning: boolean,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
	providerName: ProviderName
}): { messages: LLMChatMessage[], separateSystemMessage: string | undefined } => {

	const specialFormat = params.specialToolFormat // this is just for ts stupidness

	// if need to convert to gemini style of messaes, do that (treat as anthropic style, then convert to gemini style)
	if (params.providerName === 'gemini' || specialFormat === 'gemini-style') {
		const res = prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat === 'gemini-style' ? 'anthropic-style' : undefined })
		const messages = res.messages as AnthropicLLMChatMessage[]
		const messages2 = prepareGeminiMessages(messages)
		return { messages: messages2, separateSystemMessage: res.separateSystemMessage }
	}

	return prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat })
}




export interface IConvertToLLMMessageService {
	readonly _serviceBrand: undefined;
	prepareLLMSimpleMessages: (opts: { simpleMessages: SimpleLLMMessage[], systemMessage: string, modelSelection: ModelSelection | null, featureName: FeatureName }) => { messages: LLMChatMessage[], separateSystemMessage: string | undefined }
	prepareLLMChatMessages: (opts: { chatMessages: ChatMessage[], chatMode: ChatMode, modelSelection: ModelSelection | null }) => Promise<{ messages: LLMChatMessage[], separateSystemMessage: string | undefined }>
	prepareFIMMessage(opts: { messages: LLMFIMMessage, }): { prefix: string, suffix: string, stopTokens: string[] }
	generateSystemMessage(chatMode: ChatMode, specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined, allowedToolNames?: string[]): Promise<string>
}

export const IConvertToLLMMessageService = createDecorator<IConvertToLLMMessageService>('ConvertToLLMMessageService');


class ConvertToLLMMessageService extends Disposable implements IConvertToLLMMessageService {
	_serviceBrand: undefined;

	constructor(
		@IModelService private readonly modelService: IModelService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IVoidModelService private readonly voidModelService: IVoidModelService,
		@IMCPService private readonly mcpService: IMCPService,
		@IVoidInternalToolService private readonly internalToolService: IVoidInternalToolService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super()
	}

	// Lazy-resolved to break cyclic dependency:
	// ConvertToLLMMessageService -> neuralInverseAgentService -> chatThreadService -> ConvertToLLMMessageService
	private _agentService: INeuralInverseAgentService | null | undefined
	private _getAgentService(): INeuralInverseAgentService | null {
		if (this._agentService === undefined) {
			try {
				this._agentService = this.instantiationService.invokeFunction(a => a.get(INeuralInverseAgentService))
			} catch {
				this._agentService = null
			}
		}
		return this._agentService
	}

	// Lazy-resolved modernisation services — only available when the module is loaded
	private _modernisationSession: IModernisationSessionService | null | undefined
	private _getModernisationSession(): IModernisationSessionService | null {
		if (this._modernisationSession === undefined) {
			try {
				this._modernisationSession = this.instantiationService.invokeFunction(a => a.get(IModernisationSessionService))
			} catch {
				this._modernisationSession = null
			}
		}
		return this._modernisationSession
	}

	private _kbService: IKnowledgeBaseService | null | undefined
	private _getKBService(): IKnowledgeBaseService | null {
		if (this._kbService === undefined) {
			try {
				this._kbService = this.instantiationService.invokeFunction(a => a.get(IKnowledgeBaseService))
			} catch {
				this._kbService = null
			}
		}
		return this._kbService
	}

	/**
	 * Build a compact modernisation context block for injection into the system prompt.
	 * Returns undefined when no session is active — keeps prompt clean for normal coding tasks.
	 *
	 * Tells the agent:
	 *   - It is working inside an active migration project
	 *   - The current workflow stage and what it means
	 *   - Source (legacy) and target (modern) folder paths for direct file access
	 *   - KB progress summary so it can prioritise which units to work on
	 *   - Active file pair currently under analysis (if set)
	 */
	private _buildModernisationContext(): string | undefined {
		const session = this._getModernisationSession()?.session
		if (!session?.isActive) { return undefined }

		const kb = this._getKBService()
		const progress = kb?.isActive ? kb.getProgress() : null

		const lines: string[] = [
			'## Active Modernisation Session',
			`Stage: ${session.currentStage}  |  Pattern: ${session.migrationPattern ?? 'custom'}  |  Plan approved: ${session.planApproved ? 'yes' : 'no'}`,
		]

		// Source and target project paths — agents use these to open/read files directly
		if (session.sources.length > 0) {
			lines.push('Source (legacy) projects:')
			for (const s of session.sources) {
				lines.push(`  ${s.label}: ${s.folderUri}`)
			}
		}
		if (session.targets.length > 0) {
			lines.push('Target (modern) projects:')
			for (const t of session.targets) {
				lines.push(`  ${t.label}: ${t.folderUri}`)
			}
		}

		// Active file pair — the specific files currently under human review
		if (session.activeSourceFileUri) { lines.push(`Active source file: ${session.activeSourceFileUri}`) }
		if (session.activeTargetFileUri) { lines.push(`Active target file: ${session.activeTargetFileUri}`) }

		// KB progress summary + unit-level spotlight
		if (kb && kb.isActive && progress) {
			const p = progress
			const bs = p.byStatus
			const statusCounts: string[] = []
			if ((bs['pending']   ?? 0) > 0) { statusCounts.push(`${bs['pending']} pending`) }
			if ((bs['ready']     ?? 0) > 0) { statusCounts.push(`${bs['ready']} ready`) }
			if ((bs['translating'] ?? 0) > 0) { statusCounts.push(`${bs['translating']} translating`) }
			if ((bs['review']    ?? 0) > 0) { statusCounts.push(`${bs['review']} in review`) }
			if ((bs['approved']  ?? 0) > 0) { statusCounts.push(`${bs['approved']} approved`) }
			if ((bs['committing'] ?? 0) > 0) { statusCounts.push(`${bs['committing']} committing`) }
			if ((bs['committed'] ?? 0) > 0) { statusCounts.push(`${bs['committed']} committed`) }
			if ((bs['validated'] ?? 0) > 0) { statusCounts.push(`${bs['validated']} validated`) }
			if (p.blockedUnits.length  > 0) { statusCounts.push(`${p.blockedUnits.length} blocked`) }
			if ((bs['skipped']   ?? 0) > 0) { statusCounts.push(`${bs['skipped']} skipped`) }
			if (statusCounts.length > 0) {
				const doneCount = (bs['complete'] ?? 0) + (bs['committed'] ?? 0) + (bs['validated'] ?? 0) + (bs['committing'] ?? 0)
				const pct = p.totalUnits > 0 ? Math.round(doneCount / p.totalUnits * 100) : 0
				lines.push(`KB: ${p.totalUnits} total — ${statusCounts.join(', ')}  (${pct}% done)`)
			}
			if (p.pendingDecisions.length > 0) {
				lines.push(`Pending decisions: ${p.pendingDecisions.length} — resolve with answer_decision tool`)
			}

			// Spotlight: blocked units (top 5) — most urgent for the agent to address
			const blocked = kb.getBlockedUnits().slice(0, 5)
			if (blocked.length > 0) {
				lines.push('Blocked units (need human decision):')
				for (const u of blocked) {
					const decision = kb.getPendingDecisionForUnit(u.id)
					const reason = decision ? `${decision.type}: ${decision.question.slice(0, 80)}` : (u.blockedReason ?? 'unknown reason')
					lines.push(`  • ${u.name} [${u.sourceLang}] — ${reason}`)
				}
			}

			// Spotlight: next ready unit — what the agent should translate next
			const nextUnit = kb.getNextUnit()
			if (nextUnit) {
				lines.push(`Next unit ready to translate: ${nextUnit.name} (${nextUnit.sourceLang}, risk: ${nextUnit.riskLevel}) — use get_unit_context("${nextUnit.id}") then record_translation`)
			}

			// Spotlight: units in review — awaiting human approval
			const inReview = kb.getUnitsByStatus('review').slice(0, 5)
			if (inReview.length > 0) {
				lines.push(`In review (${inReview.length} units): ${inReview.map(u => u.name).join(', ')}${inReview.length > 5 ? ' …' : ''}`)
			}
		}

		// Tool reference — so the agent knows exactly which tools are available and when to use them
		lines.push('')
		lines.push('## Modernisation Tools Available')
		lines.push('These tools give you full read/write access to the migration Knowledge Base (KB):')
		lines.push('  Unit read:    list_units, get_unit, get_next_unit, get_unit_context, search_units, get_unit_history, get_unit_dependencies, get_impact_chain, get_dependency_tree')
		lines.push('  Translation:  record_translation (saves translated code + transitions unit to review), flag_ready (mark pending→ready), flag_blocked (raise decision), revert_unit')
		lines.push('  Decisions:    get_pending_decisions, answer_decision, get_decision_log, record_type_mapping, record_naming_decision, record_rule_interpretation, record_pattern_override')
		lines.push('  Progress:     get_progress, get_workspace_summary, get_units_by_phase, check_compliance_gate')
		lines.push('  Glossary:     get_glossary, add_glossary_term, get_business_rules')
		lines.push('  Autonomy:     autonomy_start_batch, autonomy_run_single_unit, autonomy_preview_schedule, autonomy_get_escalations, autonomy_resolve_escalation')
		lines.push('  Management:   lock_unit, unlock_unit, create_tag, add_tag_to_unit, create_work_package, create_checkpoint, restore_checkpoint, split_unit, merge_units')
		lines.push('')
		lines.push('## Unit Lifecycle')
		lines.push('pending → (flag_ready) → ready → (translation engine) → translating → review → (human approves) → approved → (commit) → committing → committed → (validate) → validating → validated → complete')
		lines.push('Any unit can be blocked (needs a decision) or skipped (excluded from migration).')
		lines.push('Use get_unit_context(unitId) to get the full source + decisions context before translating. Use record_translation to save the result.')

		return lines.join('\n')
	}

	// Read .neuralinverserules files from workspace folders
	private _getVoidRulesFileContents(): string {
		try {
			const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
			let voidRules = '';
			for (const folder of workspaceFolders) {
				const uri = URI.joinPath(folder.uri, '.neuralinverserules')
				// Check existence implicitly via try-catch or use specific error handling
				try {
					const { model } = this.voidModelService.getModel(uri)
					if (!model) continue
					voidRules += model.getValue(EndOfLinePreference.LF) + '\n\n';
				} catch (e) {
					// Ignore missing files or read errors
					continue;
				}
			}
			return voidRules.trim();
		}
		catch (e) {
			return ''
		}
	}

	// Get combined AI instructions from settings and .neuralinverserules files
	private _getCombinedAIInstructions(): string {
		const globalAIInstructions = this.voidSettingsService.state.globalSettings.aiInstructions;
		const voidRulesFileContent = this._getVoidRulesFileContents();

		const ans: string[] = []
		if (globalAIInstructions) ans.push(globalAIInstructions)
		if (voidRulesFileContent) ans.push(voidRulesFileContent)

		// Inject active modernisation session context (stage, folder paths, KB progress)
		// Only present when a modernisation session is running — keeps prompt clean otherwise
		const modernisationContext = this._buildModernisationContext()
		if (modernisationContext) ans.push(modernisationContext)

		// Inject NeuralInverse Agent working memory context when a task is active
		const agentContext = this._getAgentService()?.getContextSummary()
		if (agentContext) ans.push(agentContext)

		return ans.join('\n\n')
	}


	public generateSystemMessage = async (chatMode: ChatMode, specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined, allowedToolNames?: string[]) => {
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath)

		const openedURIs = this.modelService.getModels().filter(m => m.isAttachedToEditor()).map(m => m.uri.fsPath) || [];
		const activeURI = this.editorService.activeEditor?.resource?.fsPath;

		const directoryStr = await this.directoryStrService.getAllDirectoriesStr({
			cutOffMessage: chatMode === 'copilot' || chatMode === 'validate' || chatMode === 'ask' || chatMode === 'reason' || chatMode === 'agent' || chatMode === 'gather' ?
				`...Directories string cut off, use tools to read more...`
				: `...Directories string cut off, ask user for more if necessary...`
		})

		const includeXMLToolDefinitions = !specialToolFormat

		const mcpTools = this.mcpService.getMCPTools()

		// Augment with internal tools (discovery, modernisation) for agentic modes.
		// Include 'power' so that Power Mode agents can call KB tools directly instead
		// of falling back to shell commands when a modernisation session is active.
		const internalToolInfos = (chatMode === 'agent' || chatMode === 'copilot' || chatMode === 'validate' || chatMode === 'power')
			? this.internalToolService.getToolInfos()
			: [];
		// Deduplicate and limit to API maximum
		const allMcpTools = (() => {
			if (!mcpTools && internalToolInfos.length === 0) return undefined;
			const seen = new Set<string>();
			const merged = [...(mcpTools ?? []), ...internalToolInfos].filter(t => {
				if (seen.has(t.name)) return false;
				seen.add(t.name);
				return true;
			});
			return merged.slice(0, 128); // API hard limit
		})();

		const persistentTerminalIDs = this.terminalToolService.listPersistentTerminalIds()
		const systemMessage = chat_systemMessage({ workspaceFolders, openedURIs, directoryStr, activeURI, persistentTerminalIDs, chatMode, mcpTools: allMcpTools, includeXMLToolDefinitions, allowedToolNames, grcPosture: undefined })
		return systemMessage
	}

	// system message
	private _generateChatMessagesSystemMessage = async (chatMode: ChatMode, specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined) => {
		return this.generateSystemMessage(chatMode, specialToolFormat);
	}




	// --- LLM Chat messages ---

	private _chatMessagesToSimpleMessages(chatMessages: ChatMessage[]): SimpleLLMMessage[] {
		const simpleLLMMessages: SimpleLLMMessage[] = []

		for (const m of chatMessages) {
			if (m.role === 'checkpoint') continue
			if (m.role === 'interrupted_streaming_tool') continue
			if (m.role === 'assistant') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.displayContent,
					anthropicReasoning: m.anthropicReasoning,
				})
			}
			else if (m.role === 'tool') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.content,
					name: m.name,
					id: m.id,
					rawParams: m.rawParams,
				})
			}
			else if (m.role === 'user') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.content,
					images: m.images,
				})
			}
		}
		return simpleLLMMessages
	}

	prepareLLMSimpleMessages: IConvertToLLMMessageService['prepareLLMSimpleMessages'] = ({ simpleMessages, systemMessage, modelSelection, featureName }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined }

		const { overridesOfModel } = this.voidSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const modelSelectionOptions = this.voidSettingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]

		// Get combined AI instructions
		const aiInstructions = this._getCombinedAIInstructions();

		const isReasoningEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })

		const { messages, separateSystemMessage } = prepareMessages({
			messages: simpleMessages,
			systemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: providerName === 'anthropic',
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
		})
		return { messages, separateSystemMessage };
	}
	prepareLLMChatMessages: IConvertToLLMMessageService['prepareLLMChatMessages'] = async ({ chatMessages, chatMode, modelSelection }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined }

		const { overridesOfModel } = this.voidSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const { disableSystemMessage } = this.voidSettingsService.state.globalSettings;
		const fullSystemMessage = await this._generateChatMessagesSystemMessage(chatMode, specialToolFormat)
		const systemMessage = disableSystemMessage ? '' : fullSystemMessage;

		const modelSelectionOptions = this.voidSettingsService.state.optionsOfModelSelection['Chat'][modelSelection.providerName]?.[modelSelection.modelName]

		// Get combined AI instructions
		const aiInstructions = this._getCombinedAIInstructions();
		const isReasoningEnabled = getIsReasoningEnabledState('Chat', providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })
		const llmMessages = this._chatMessagesToSimpleMessages(chatMessages)

		const { messages, separateSystemMessage } = prepareMessages({
			messages: llmMessages,
			systemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: providerName === 'anthropic',
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
		})
		return { messages, separateSystemMessage };
	}


	// --- FIM ---

	prepareFIMMessage: IConvertToLLMMessageService['prepareFIMMessage'] = ({ messages }) => {
		// Get combined AI instructions with the provided aiInstructions as the base
		const combinedInstructions = this._getCombinedAIInstructions();

		let prefix = `\
${!combinedInstructions ? '' : `\
// Instructions:
// Do not output an explanation. Try to avoid outputting comments. Only output the middle code.
${combinedInstructions.split('\n').map(line => `//${line}`).join('\n')}`}

${messages.prefix}`

		const suffix = messages.suffix
		const stopTokens = messages.stopTokens
		return { prefix, suffix, stopTokens }
	}


}


registerSingleton(IConvertToLLMMessageService, ConvertToLLMMessageService, InstantiationType.Eager);








/*
Gemini has this, but they're openai-compat so we don't need to implement this
gemini request:
{   "role": "assistant",
	"content": null,
	"function_call": {
		"name": "get_weather",
		"arguments": {
			"latitude": 48.8566,
			"longitude": 2.3522
		}
	}
}

gemini response:
{   "role": "assistant",
	"function_response": {
		"name": "get_weather",
			"response": {
			"temperature": "15°C",
				"condition": "Cloudy"
		}
	}
}
*/
