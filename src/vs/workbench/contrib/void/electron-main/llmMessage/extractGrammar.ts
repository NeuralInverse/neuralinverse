/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../../base/common/uuid.js'
import { endsWithAnyPrefixOf, SurroundingsRemover } from '../../common/helpers/extractCodeFromResult.js'
import { availableTools, InternalToolInfo } from '../../common/prompt/prompts.js'
import { OnFinalMessage, OnText, RawToolCallObj, RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolName, ToolParamName } from '../../common/toolsServiceTypes.js'
import { ChatMode } from '../../common/voidSettingsTypes.js'


// =============== reasoning ===============

// could simplify this - this assumes we can never add a tag without committing it to the user's screen, but that's not true
// could simplify this - this assumes we can never add a tag without committing it to the user's screen, but that's not true
export const extractReasoningWrapper = (
	onText: OnText, onFinalMessage: OnFinalMessage, thinkTags: [string, string]
): { newOnText: OnText, newOnFinalMessage: OnFinalMessage } => {

	if (!thinkTags[0] || !thinkTags[1]) throw new Error(`thinkTags must not be empty if provided. Got ${JSON.stringify(thinkTags)}.`)

	let fullText = ''
	let fullReasoning = ''

	const [openTag, closeTag] = thinkTags

	const newOnText: OnText = (params) => {
		const trueFullText = params.fullText

		let currentIdx = 0;
		let extractedText = '';
		let extractedReasoning = params.fullReasoning || ''; // incorporate existing reasoning if any

		let isInsideThought = false;

		while (currentIdx < trueFullText.length) {
			const remainingText = trueFullText.substring(currentIdx);

			if (!isInsideThought) {
				const openIdx = remainingText.indexOf(openTag);
				if (openIdx !== -1) {
					extractedText += remainingText.substring(0, openIdx);
					isInsideThought = true;
					currentIdx += openIdx + openTag.length;
				} else {
					// Check for partial open tag at the end
					const partialOpen = endsWithAnyPrefixOf(remainingText, openTag);
					if (partialOpen) {
						extractedText += remainingText.substring(0, remainingText.length - partialOpen.length);
						break; // Wait for more text
					} else {
						extractedText += remainingText;
						currentIdx += remainingText.length;
					}
				}
			} else {
				const closeIdx = remainingText.indexOf(closeTag);
				if (closeIdx !== -1) {
					extractedReasoning += remainingText.substring(0, closeIdx);
					isInsideThought = false;
					currentIdx += closeIdx + closeTag.length;
				} else {
					// Check for partial close tag at the end
					const partialClose = endsWithAnyPrefixOf(remainingText, closeTag);
					if (partialClose) {
						extractedReasoning += remainingText.substring(0, remainingText.length - partialClose.length);
						break; // Wait for more text
					} else {
						extractedReasoning += remainingText;
						currentIdx += remainingText.length;
					}
				}
			}
		}

		fullText = extractedText;
		fullReasoning = extractedReasoning;

		onText({ ...params, fullText, fullReasoning })
	}

	const newOnFinalMessage: OnFinalMessage = (params) => {
		newOnText({ ...params })
		onFinalMessage({ ...params, fullText, fullReasoning })
	}

	return { newOnText, newOnFinalMessage }
}


// =============== tools (XML) ===============



const findPartiallyWrittenToolTagAtEnd = (fullText: string, toolTags: string[]) => {
	for (const toolTag of toolTags) {
		const foundPrefix = endsWithAnyPrefixOf(fullText, toolTag)
		if (foundPrefix) {
			return [foundPrefix, toolTag] as const
		}
	}
	return false
}

const findIndexOfAny = (fullText: string, matches: string[]) => {
	for (const str of matches) {
		const idx = fullText.indexOf(str);
		if (idx !== -1) {
			return [idx, str] as const
		}
	}
	return null
}


type ToolOfToolName = { [toolName: string]: InternalToolInfo | undefined }
const parseXMLPrefixToToolCall = <T extends ToolName,>(toolName: T | 'tool_call', toolId: string, str: string, toolOfToolName: ToolOfToolName): { toolCall: RawToolCallObj, parsedLen: number } => {
	const paramsObj: RawToolParamsObj = {}
	const doneParams: ToolParamName<T>[] = []
	let isDone = false
	let finalToolName: string = toolName

	const getAnswer = (parsedLen: number): { toolCall: RawToolCallObj, parsedLen: number } => {
		// trim off all whitespace at and before first \n and after last \n for each param
		for (const p in paramsObj) {
			const paramName = p as ToolParamName<T>
			const orig = paramsObj[paramName]
			if (orig === undefined) continue
			paramsObj[paramName] = trimBeforeAndAfterNewLines(orig)
		}

		const ans: RawToolCallObj = {
			name: finalToolName as ToolName,
			rawParams: paramsObj,
			doneParams: doneParams,
			isDone: isDone,
			id: toolId,
		}
		return { toolCall: ans, parsedLen }
	}

	const openToolTag = `<${toolName}>`
	let i = str.indexOf(openToolTag)
	if (i === -1) return getAnswer(0)

	const closeTag = `</${toolName}>`
	let j = str.indexOf(closeTag, i + openToolTag.length)
	let parsedLen = 0
	if (j === -1) {
		j = Infinity
		parsedLen = str.length // consumed entire string so far
	} else {
		isDone = true
		parsedLen = j + closeTag.length // consumed up to closing tag
	}

	str = str.substring(i + openToolTag.length, j)

	const trimmedStr = str.trim()
	if (trimmedStr.startsWith('{') && trimmedStr.endsWith('}')) {
		try {
			const parsedJson = JSON.parse(trimmedStr)

			// handle Litellm's generic <tool_call> wrapper
			if (toolName === 'tool_call' && parsedJson.name) {
				finalToolName = parsedJson.name;
				let parsedArgs = parsedJson.arguments || parsedJson.parameters || parsedJson;
				if (typeof parsedArgs === 'string') {
					try { parsedArgs = JSON.parse(parsedArgs) } catch (e) { }
				}
				for (const key of Object.keys(parsedArgs)) {
					let val = parsedArgs[key]
					if (typeof val === 'object') val = JSON.stringify(val, null, 2)
					paramsObj[key as ToolParamName<T>] = val + ''
					if (!doneParams.includes(key as ToolParamName<T>)) {
						doneParams.push(key as ToolParamName<T>)
					}
				}
				return getAnswer(parsedLen)
			}

			for (const key of Object.keys(parsedJson)) {
				let val = parsedJson[key]
				if (typeof val === 'object') val = JSON.stringify(val, null, 2)
				paramsObj[key as ToolParamName<T>] = val + ''
				if (!doneParams.includes(key as ToolParamName<T>)) {
					doneParams.push(key as ToolParamName<T>)
				}
			}
			return getAnswer(parsedLen)
		} catch (e) {
			// fall through to XML parsing
		}
	}

	const pm = new SurroundingsRemover(str)

	// If we're in a proxy <tool_call> wrapper but couldn't parse the JSON yet (e.g. partial stream),
	// return an incomplete placeholder rather than falling through to XML param parsing which will crash
	if (toolName === 'tool_call' && (finalToolName === 'tool_call' || finalToolName === toolName)) {
		return { toolCall: { name: 'tool_call' as ToolName, rawParams: {}, doneParams: [], isDone: false, id: toolId }, parsedLen: 0 }
	}

	const allowedParams = Object.keys(toolOfToolName[toolName]?.params ?? {}) as ToolParamName<T>[]
	if (allowedParams.length === 0) return getAnswer(parsedLen)
	let latestMatchedOpenParam: null | ToolParamName<T> = null
	let n = 0
	while (true) {
		n += 1
		if (n > 10) return getAnswer(parsedLen) // just for good measure as this code is early

		// find the param name opening tag
		let matchedOpenParam: null | ToolParamName<T> = null
		for (const paramName of allowedParams) {
			const removed = pm.removeFromStartUntilFullMatch(`<${paramName}>`, true)
			if (removed) {
				matchedOpenParam = paramName
				break
			}
		}
		// if did not find a new param, stop
		if (matchedOpenParam === null) {
			if (latestMatchedOpenParam !== null) {
				paramsObj[latestMatchedOpenParam] += pm.value()
			}
			return getAnswer(parsedLen)
		}
		else {
			latestMatchedOpenParam = matchedOpenParam
		}

		paramsObj[latestMatchedOpenParam] = ''

		// find the param name closing tag
		let matchedCloseParam: boolean = false
		let paramContents = ''
		for (const paramName of allowedParams) {
			const i = pm.i
			const closeTag = `</${paramName}>`
			const removed = pm.removeFromStartUntilFullMatch(closeTag, true)
			if (removed) {
				const i2 = pm.i
				paramContents = pm.originalS.substring(i, i2 - closeTag.length)
				matchedCloseParam = true
				break
			}
		}
		// if did not find a new close tag, stop
		if (!matchedCloseParam) {
			paramsObj[latestMatchedOpenParam] += pm.value()
			return getAnswer(parsedLen)
		}
		else {
			doneParams.push(latestMatchedOpenParam)
		}

		paramsObj[latestMatchedOpenParam] += paramContents
	}
}

export const extractXMLToolsWrapper = (
	onText: OnText,
	onFinalMessage: OnFinalMessage,
	chatMode: ChatMode | null,
	mcpTools: InternalToolInfo[] | undefined,
	allowedToolNames: string[] | undefined,
): { newOnText: OnText, newOnFinalMessage: OnFinalMessage } => {

	if (!chatMode) return { newOnText: onText, newOnFinalMessage: onFinalMessage }
	const tools = availableTools(chatMode, mcpTools, allowedToolNames)
	if (!tools) return { newOnText: onText, newOnFinalMessage: onFinalMessage }

	const toolOfToolName: ToolOfToolName = {}
	const toolOpenTags = tools.map(t => `<${t.name}>`)
	toolOpenTags.push('<tool_call>') // generic proxy tool wrapper

	for (const t of tools) { toolOfToolName[t.name] = t }

	let trueFullText = ''
	let latestFullText = ''
	let latestToolCalls: RawToolCallObj[] = []
	let toolIds: string[] = [] // maintain consistent IDs across stream re-parsing

	const newOnText: OnText = (params) => {
		try {
			trueFullText = params.fullText

			let currentIdx = 0;
			let finalFullText = '';
			let extractedToolCalls: RawToolCallObj[] = [];

			while (currentIdx < trueFullText.length) {
				const remainingText = trueFullText.substring(currentIdx);
				const foundOpenTag = findIndexOfAny(remainingText, toolOpenTags);

				if (foundOpenTag !== null) {
					const [idx, toolTag] = foundOpenTag;
					finalFullText += remainingText.substring(0, idx);

					const toolName = toolTag.substring(1, toolTag.length - 1) as ToolName;

					// allocate ID consistently
					if (toolIds.length <= extractedToolCalls.length) {
						toolIds.push(generateUuid())
					}
					const currentToolId = toolIds[extractedToolCalls.length]

					const { toolCall, parsedLen } = parseXMLPrefixToToolCall(
						toolName,
						currentToolId,
						remainingText.substring(idx),
						toolOfToolName
					);

					// Skip placeholders immediately — don't even add to extractedToolCalls
					if (toolCall.name && toolCall.name !== 'tool_call') {
						extractedToolCalls.push(toolCall);
					}

					if (toolCall.isDone) {
						currentIdx += idx + parsedLen;
					} else {
						break;
					}
				} else {
					const isPartial = findPartiallyWrittenToolTagAtEnd(remainingText, toolOpenTags);
					if (isPartial) {
						const partialStr = isPartial[0];
						finalFullText += remainingText.substring(0, remainingText.length - partialStr.length);
						break;
					} else {
						finalFullText += remainingText;
						currentIdx = trueFullText.length;
						break;
					}
				}
			}

			latestFullText = finalFullText;
			latestToolCalls = extractedToolCalls;

			onText({
				...params,
				fullText: latestFullText,
				toolCalls: (latestToolCalls.length > 0 ? latestToolCalls : undefined) || params.toolCalls,
			});
		} catch (e) {
			// Safety net: if ANY error occurs during XML tool parsing, fall through with raw text
			console.error('[extractXMLToolsWrapper] Error during tool call parsing — falling through with raw text:', e);
			trueFullText = params.fullText
			latestFullText = params.fullText
			latestToolCalls = []
			onText(params);
		}
	};


	const newOnFinalMessage: OnFinalMessage = (params) => {
		newOnText({ ...params, toolCalls: [] as any })

		latestFullText = latestFullText.trimEnd()

		// filter out any unresolved 'tool_call' placeholder names
		const resolvedFinalToolCalls = latestToolCalls.filter(tc => tc.name !== 'tool_call' as any)

		onFinalMessage({ ...params, fullText: latestFullText, toolCalls: (resolvedFinalToolCalls.length > 0 ? resolvedFinalToolCalls : undefined) || params.toolCalls })
	}
	return { newOnText, newOnFinalMessage };
}



// trim all whitespace up until the first newline, and all whitespace up until the last newline
const trimBeforeAndAfterNewLines = (s: string) => {
	if (!s) return s;

	const firstNewLineIndex = s.indexOf('\n');

	if (firstNewLineIndex !== -1 && s.substring(0, firstNewLineIndex).trim() === '') {
		s = s.substring(firstNewLineIndex + 1, Infinity)
	}

	const lastNewLineIndex = s.lastIndexOf('\n');
	if (lastNewLineIndex !== -1 && s.substring(lastNewLineIndex + 1, Infinity).trim() === '') {
		s = s.substring(0, lastNewLineIndex)
	}

	return s
}
