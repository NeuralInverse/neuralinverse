/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Translation Interface Extractor
 *
 * After a unit is successfully translated, its public interface (exported
 * method/class signatures in the target language) must be recorded in the KB
 * so that units which *call* this one can receive accurate `calledInterfaces`
 * context when they are translated.
 *
 * Without this step, every downstream unit would translate without knowing the
 * exact method signatures of its dependencies \u2014 causing incorrect call sites,
 * wrong parameter types, and mismatched return values in the final output.
 *
 * ## Extraction Strategy
 *
 * ### Layer 1 \u2014 Deterministic (regex per target language)
 * Fast, zero-cost, handles the common case (80\u201390% of units).
 * Extracts `public` / `export` declarations, class definitions, and function
 * signatures directly from the translated code text.
 *
 * Supported target languages:
 *   - Java/Kotlin      \u2014 `public class/interface/enum`, `public [static] T method(\u2026)`
 *   - TypeScript/JS    \u2014 `export [default] class/function/const/interface/type`
 *   - Python           \u2014 `class Foo:`, `def foo(\u2026) -> T:`  (module-level public)
 *   - Go               \u2014 exported identifiers (PascalCase functions/types/vars)
 *   - C#               \u2014 `public class/interface/record`, `public T Method(\u2026)`
 *   - Rust             \u2014 `pub fn`, `pub struct`, `pub trait`, `pub enum`
 *
 * ### Layer 2 \u2014 LLM-assisted (for ambiguous/complex cases)
 * Used when Layer 1 extracts zero signatures from translated code longer than
 * `MIN_CODE_FOR_LLM_FALLBACK` characters. The LLM is asked to list only the
 * public API signatures \u2014 a much shorter task than full translation.
 *
 * ### Summary generation
 * A one-sentence summary of what the unit does is derived from:
 *   1. The unit's `domain` field if set
 *   2. The first non-empty comment block in the translated code
 *   3. An LLM summary if neither of the above is available
 *
 * ## Output
 *
 * An `IUnitInterface` that is written to the KB via `kb.recordInterface(unitId, iface)`.
 * This then becomes available to callers via `getResolvedContext().calledInterfaces`.
 */

import { IUnitInterface } from '../../../../common/knowledgeBaseTypes.js';
import { ILLMMessageService } from '../../../../../void/common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../../../../../void/common/voidSettingsService.js';
import { LLMChatMessage } from '../../../../../void/common/sendLLMMessageTypes.js';
import { ModelSelection } from '../../../../../void/common/voidSettingsTypes.js';


// \u2500\u2500\u2500 Constants \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** If Layer 1 extracts nothing from code this long, fall back to LLM */
const MIN_CODE_FOR_LLM_FALLBACK = 200;

/** Maximum number of signatures to record (avoid bloating context) */
const MAX_SIGNATURES = 20;

const LOGGING_NAME = 'ModernisationInterfaceExtractor';


// \u2500\u2500\u2500 Main entry point \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Extract the public interface from translated code and return an `IUnitInterface`.
 *
 * @param unitId         KB unit ID
 * @param unitName       Unit's display name
 * @param unitDomain     Optional business domain (used in summary)
 * @param translatedCode The complete translated code string
 * @param targetLang     Target language key (e.g. 'java', 'typescript')
 * @param llm            LLM service (used for Layer 2 fallback)
 * @param settings       Void settings (for model selection)
 * @returns              IUnitInterface ready for `kb.recordInterface()`
 */
export async function extractTranslatedInterface(
	unitId: string,
	unitName: string,
	unitDomain: string | undefined,
	translatedCode: string,
	targetLang: string,
	llm: ILLMMessageService,
	settings: IVoidSettingsService,
): Promise<IUnitInterface> {
	const lang = targetLang.toLowerCase();

	// \u2500\u2500 Layer 1: Deterministic extraction \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const layer1 = extractSignaturesLayer1(translatedCode, lang);
	const summary = extractSummary(translatedCode, lang, unitDomain, unitName);

	if (layer1.signatures.length > 0) {
		return {
			unitId,
			targetLanguage: targetLang,
			signatures:     layer1.signatures.slice(0, MAX_SIGNATURES),
			summary,
			inputTypes:     layer1.inputTypes,
			outputTypes:    layer1.outputTypes,
		};
	}

	// \u2500\u2500 Layer 2: LLM fallback \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (translatedCode.trim().length >= MIN_CODE_FOR_LLM_FALLBACK) {
		const llmResult = await extractSignaturesLayer2(
			unitName, translatedCode, targetLang, llm, settings,
		);
		if (llmResult.signatures.length > 0) {
			return {
				unitId,
				targetLanguage: targetLang,
				signatures:     llmResult.signatures.slice(0, MAX_SIGNATURES),
				summary:        llmResult.summary || summary,
				inputTypes:     llmResult.inputTypes,
				outputTypes:    llmResult.outputTypes,
			};
		}
	}

	// \u2500\u2500 Fallback: empty interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// Unit's translated code is too small or has no detectable public API
	// (e.g. a pure data record with no methods). Still record something useful.
	return {
		unitId,
		targetLanguage: targetLang,
		signatures:     [],
		summary,
		inputTypes:     [],
		outputTypes:    [],
	};
}


// \u2500\u2500\u2500 Layer 1: Per-language deterministic extraction \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface ILayer1Result {
	signatures:  string[];
	inputTypes:  string[];
	outputTypes: string[];
}

function extractSignaturesLayer1(code: string, lang: string): ILayer1Result {
	switch (lang) {
		case 'java':       return extractJavaSignatures(code);
		case 'kotlin':     return extractKotlinSignatures(code);
		case 'typescript':
		case 'javascript': return extractTypeScriptSignatures(code);
		case 'python':     return extractPythonSignatures(code);
		case 'go':         return extractGoSignatures(code);
		case 'csharp':
		case 'c#':         return extractCSharpSignatures(code);
		case 'rust':       return extractRustSignatures(code);
		case 'scala':      return extractScalaSignatures(code);
		default:           return { signatures: [], inputTypes: [], outputTypes: [] };
	}
}

// \u2500\u2500 Java \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function extractJavaSignatures(code: string): ILayer1Result {
	const signatures:  string[] = [];
	const inputTypes:  string[] = [];
	const outputTypes: string[] = [];

	// Class / interface / enum declarations
	const typeDecls = [
		...code.matchAll(/^(?:public\s+)?(?:abstract\s+)?(?:class|interface|enum|record)\s+(\w+)(?:<[^>]+>)?(?:\s+extends[^{]+)?(?:\s+implements[^{]+)?\s*\{/gm),
	];
	for (const m of typeDecls) {
		const access = m[0].trimStart();
		if (access.startsWith('public') || !access.startsWith('private') && !access.startsWith('protected')) {
			signatures.push(m[0].replace(/\s*\{$/, '').trim());
		}
	}

	// Public methods (instance + static)
	const methodDecls = [
		...code.matchAll(/^\s*public\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:<[^>]+>\s+)?(\w[\w<>\[\],\s]*)\s+(\w+)\s*\(([^)]*)\)(?:\s+throws\s+[\w,\s]+)?\s*\{/gm),
	];
	for (const m of methodDecls) {
		const returnType = m[1].trim();
		const params     = m[3].trim();
		const sig        = m[0].replace(/\s*\{$/, '').trim();
		signatures.push(sig);
		if (returnType !== 'void') { outputTypes.push(returnType); }
		// Extract parameter types
		for (const param of params.split(',')) {
			const parts = param.trim().split(/\s+/);
			if (parts.length >= 2) { inputTypes.push(parts[parts.length - 2]); }
		}
	}

	return { signatures: dedup(signatures), inputTypes: dedup(inputTypes), outputTypes: dedup(outputTypes) };
}

// \u2500\u2500 Kotlin \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function extractKotlinSignatures(code: string): ILayer1Result {
	const signatures:  string[] = [];
	const inputTypes:  string[] = [];
	const outputTypes: string[] = [];

	// Class / interface / object / data class
	const typeDecls = [...code.matchAll(/^(?:(?:data|sealed|abstract|open|inner)\s+)*(?:class|interface|object|enum class)\s+(\w+)/gm)];
	for (const m of typeDecls) {
		if (!m[0].trimStart().startsWith('private') && !m[0].trimStart().startsWith('internal')) {
			signatures.push(m[0].replace(/\s*[{(].*$/, '').trim());
		}
	}

	// Public fun declarations
	const funs = [...code.matchAll(/^\s*(?:(?:override|open|suspend|inline|operator)\s+)*fun\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*([\w<>?,\s]+))?\s*[{=]/gm)];
	for (const m of funs) {
		// Skip private/protected funs
		const line = m[0].trimStart();
		if (line.startsWith('private') || line.startsWith('protected')) { continue; }
		const returnType = m[3]?.trim();
		const params     = m[2]?.trim() ?? '';
		signatures.push(m[0].replace(/\s*[{=].*$/, '').trim());
		if (returnType && returnType !== 'Unit') { outputTypes.push(returnType); }
		for (const param of params.split(',')) {
			const colonIdx = param.indexOf(':');
			if (colonIdx >= 0) { inputTypes.push(param.slice(colonIdx + 1).trim().replace(/\s*=.*$/, '')); }
		}
	}

	return { signatures: dedup(signatures), inputTypes: dedup(inputTypes), outputTypes: dedup(outputTypes) };
}

// \u2500\u2500 TypeScript / JavaScript \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function extractTypeScriptSignatures(code: string): ILayer1Result {
	const signatures:  string[] = [];
	const inputTypes:  string[] = [];
	const outputTypes: string[] = [];

	// export [default] class / interface / type / enum
	const typeExports = [...code.matchAll(/^export\s+(?:default\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+(\w+)(?:<[^>]+>)?/gm)];
	for (const m of typeExports) {
		signatures.push(m[0].replace(/\s*[{=].*$/, '').trim());
	}

	// export function / export const (arrow functions and regular)
	const fnExports = [...code.matchAll(/^export\s+(?:async\s+)?(?:function\s+(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)(?:\s*:\s*([\w<>?,\s|[\]]+))?|const\s+(\w+)\s*(?::\s*[\w<>?,\s|[\]]+)?\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*([\w<>?,\s|[\]]+))?\s*=>)/gm)];
	for (const m of fnExports) {
		const sig = m[0].replace(/\s*[{=>].*$/, '').replace(/\s*=\s*$/, '').trim();
		signatures.push(sig);
		const returnType = (m[3] || m[6])?.trim();
		if (returnType && returnType !== 'void' && returnType !== 'Promise<void>') {
			outputTypes.push(returnType);
		}
		const params = m[2] || m[5] || '';
		for (const param of params.split(',')) {
			const colonIdx = param.indexOf(':');
			if (colonIdx >= 0) { inputTypes.push(param.slice(colonIdx + 1).trim().replace(/\s*=.*$/, '')); }
		}
	}

	// export default function
	const defaultFns = [...code.matchAll(/^export\s+default\s+(?:async\s+)?function\s*(\w*)\s*\(([^)]*)\)/gm)];
	for (const m of defaultFns) {
		signatures.push(m[0].trim());
	}

	return { signatures: dedup(signatures), inputTypes: dedup(inputTypes), outputTypes: dedup(outputTypes) };
}

// \u2500\u2500 Python \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function extractPythonSignatures(code: string): ILayer1Result {
	const signatures:  string[] = [];
	const inputTypes:  string[] = [];
	const outputTypes: string[] = [];

	// Module-level class definitions (not indented)
	const classes = [...code.matchAll(/^class\s+(\w+)(?:\([^)]*\))?:/gm)];
	for (const m of classes) {
		if (!m[1].startsWith('_')) { // Skip private (leading underscore)
			signatures.push(m[0].replace(/:$/, '').trim());
		}
	}

	// Module-level and class-level public methods/functions
	// (indented by at most one level for class methods)
	const fns = [...code.matchAll(/^(?:    )?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([\w\[\],\s|"']+))?:/gm)];
	for (const m of fns) {
		const name = m[1];
		if (name.startsWith('__') && name !== '__init__') { continue; } // Skip dunder except init
		if (name.startsWith('_')) { continue; } // Skip private
		const returnType = m[3]?.trim();
		const params     = m[2]?.trim() ?? '';
		signatures.push(m[0].replace(/:$/, '').trim());
		if (returnType && returnType !== 'None') { outputTypes.push(returnType); }
		for (const param of params.split(',')) {
			const colonIdx = param.indexOf(':');
			if (colonIdx >= 0) {
				const t = param.slice(colonIdx + 1).trim().replace(/\s*=.*$/, '');
				if (t && t !== 'self' && t !== 'cls') { inputTypes.push(t); }
			}
		}
	}

	return { signatures: dedup(signatures), inputTypes: dedup(inputTypes), outputTypes: dedup(outputTypes) };
}

// \u2500\u2500 Go \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function extractGoSignatures(code: string): ILayer1Result {
	const signatures:  string[] = [];
	const inputTypes:  string[] = [];
	const outputTypes: string[] = [];

	// Exported type declarations (PascalCase)
	const typeDecls = [...code.matchAll(/^type\s+([A-Z]\w*)\s+(?:struct|interface)\s*\{/gm)];
	for (const m of typeDecls) {
		signatures.push(`type ${m[1]}`);
	}

	// Exported functions (PascalCase name)
	const fns = [...code.matchAll(/^func\s+(?:\([^)]+\)\s+)?([A-Z]\w*)\s*\(([^)]*)\)(?:\s*\(([^)]+)\)|\s*([\w*[\],\s]+))?\s*\{/gm)];
	for (const m of fns) {
		const returnTypes = (m[3] || m[4])?.trim();
		const params      = m[2]?.trim() ?? '';
		signatures.push(m[0].replace(/\s*\{$/, '').trim());
		if (returnTypes) {
			for (const rt of returnTypes.split(',')) {
				const t = rt.trim().replace(/^\w+\s+/, ''); // strip param name if present
				if (t && t !== 'error') { outputTypes.push(t); }
			}
		}
		for (const param of params.split(',')) {
			const parts = param.trim().split(/\s+/);
			if (parts.length >= 2) { inputTypes.push(parts[parts.length - 1]); }
		}
	}

	return { signatures: dedup(signatures), inputTypes: dedup(inputTypes), outputTypes: dedup(outputTypes) };
}

// \u2500\u2500 C# \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function extractCSharpSignatures(code: string): ILayer1Result {
	const signatures:  string[] = [];
	const inputTypes:  string[] = [];
	const outputTypes: string[] = [];

	// Class / interface / record / struct
	const typeDecls = [...code.matchAll(/^\s*public\s+(?:(?:abstract|sealed|static|partial|readonly)\s+)*(?:class|interface|record|struct|enum)\s+(\w+)(?:<[^>]+>)?(?:\s*:[^{]+)?/gm)];
	for (const m of typeDecls) {
		signatures.push(m[0].trim().replace(/\s*$/, ''));
	}

	// Public methods (instance, static, async, virtual, override)
	const methods = [...code.matchAll(/^\s*public\s+(?:(?:static|async|virtual|override|abstract|new)\s+)*(?:Task<([\w<>[\],\s]+)>|Task|void|([\w<>[\],?\s]+))\s+(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)/gm)];
	for (const m of methods) {
		const returnType = (m[1] || m[2])?.trim();
		const params     = m[4]?.trim() ?? '';
		signatures.push(m[0].trim());
		if (returnType && returnType !== 'void') { outputTypes.push(returnType); }
		for (const param of params.split(',')) {
			const parts = param.trim().split(/\s+/);
			if (parts.length >= 2) { inputTypes.push(parts[parts.length - 2]); }
		}
	}

	// Public properties
	const props = [...code.matchAll(/^\s*public\s+(?:(?:static|virtual|override)\s+)?([\w<>[\],?\s]+)\s+(\w+)\s*\{\s*(?:get|set)/gm)];
	for (const m of props) {
		const propType = m[1]?.trim();
		signatures.push(m[0].trim().replace(/\s*\{.*$/, '').trim());
		if (propType) { outputTypes.push(propType); }
	}

	return { signatures: dedup(signatures), inputTypes: dedup(inputTypes), outputTypes: dedup(outputTypes) };
}

// \u2500\u2500 Rust \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function extractRustSignatures(code: string): ILayer1Result {
	const signatures:  string[] = [];
	const inputTypes:  string[] = [];
	const outputTypes: string[] = [];

	// pub struct / pub enum / pub trait / pub type
	const typeDecls = [...code.matchAll(/^pub\s+(?:(?:async\s+)?(?:struct|enum|trait|type|union))\s+(\w+)(?:<[^>]+>)?/gm)];
	for (const m of typeDecls) {
		signatures.push(m[0].replace(/\s*[{;=].*$/, '').trim());
	}

	// pub fn (free functions and impl methods)
	const fns = [...code.matchAll(/^\s*pub\s+(?:async\s+)?fn\s+(\w+)(?:<[^>]+>)?\s*\(([^)]*)\)(?:\s*->\s*([\w<>(),\s'&[\]]+))?/gm)];
	for (const m of fns) {
		const returnType = m[3]?.trim();
		const params     = m[2]?.trim() ?? '';
		signatures.push(m[0].trim().replace(/\s*\{?$/, '').trim());
		if (returnType && returnType !== '()') { outputTypes.push(returnType); }
		for (const param of params.split(',')) {
			const colonIdx = param.indexOf(':');
			if (colonIdx >= 0) { inputTypes.push(param.slice(colonIdx + 1).trim()); }
		}
	}

	return { signatures: dedup(signatures), inputTypes: dedup(inputTypes), outputTypes: dedup(outputTypes) };
}

// \u2500\u2500 Scala \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function extractScalaSignatures(code: string): ILayer1Result {
	const signatures:  string[] = [];
	const inputTypes:  string[] = [];
	const outputTypes: string[] = [];

	// class / trait / object / case class
	const typeDecls = [...code.matchAll(/^(?:case\s+)?(?:class|trait|object|sealed)\s+(\w+)(?:\[[\w,\s]+\])?(?:\s*\([^)]*\))?(?:\s+extends[^{]+)?/gm)];
	for (const m of typeDecls) {
		const line = m[0].trimStart();
		if (!line.startsWith('private') && !line.startsWith('protected')) {
			signatures.push(line.replace(/\s*[{$].*$/, '').trim());
		}
	}

	// def declarations
	const defs = [...code.matchAll(/^\s*(?:override\s+)?def\s+(\w+)(?:\[[\w,\s]+\])?\s*\(([^)]*)\)\s*(?::\s*([\w\[\],\s]+))?\s*=/gm)];
	for (const m of defs) {
		const line = m[0].trimStart();
		if (line.startsWith('private') || line.startsWith('protected')) { continue; }
		const returnType = m[3]?.trim();
		const params     = m[2]?.trim() ?? '';
		signatures.push(line.replace(/\s*=.*$/, '').trim());
		if (returnType && returnType !== 'Unit') { outputTypes.push(returnType); }
		for (const param of params.split(',')) {
			const colonIdx = param.indexOf(':');
			if (colonIdx >= 0) { inputTypes.push(param.slice(colonIdx + 1).trim()); }
		}
	}

	return { signatures: dedup(signatures), inputTypes: dedup(inputTypes), outputTypes: dedup(outputTypes) };
}


// \u2500\u2500\u2500 Layer 2: LLM-assisted extraction \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface ILLMExtractionResult {
	signatures:  string[];
	inputTypes:  string[];
	outputTypes: string[];
	summary:     string;
}

async function extractSignaturesLayer2(
	unitName: string,
	translatedCode: string,
	targetLang: string,
	llm: ILLMMessageService,
	settings: IVoidSettingsService,
): Promise<ILLMExtractionResult> {
	const empty: ILLMExtractionResult = { signatures: [], inputTypes: [], outputTypes: [], summary: '' };

	const modelSelection: ModelSelection | null =
		settings.state.modelSelectionOfFeature['Checks'] ??
		settings.state.modelSelectionOfFeature['Chat'] ??
		null;
	if (!modelSelection) { return empty; }

	const messages = buildInterfaceExtractionPrompt(unitName, translatedCode, targetLang);

	return new Promise((resolve) => {
		llm.sendLLMMessage({
			messagesType:          'chatMessages',
			messages,
			separateSystemMessage: undefined,
			chatMode:              null,
			modelSelection,
			logging:               { loggingName: LOGGING_NAME },
			modelSelectionOptions: undefined,
			overridesOfModel:      undefined,
			onText:        () => { },
			onFinalMessage: ({ fullText }) => {
				resolve(parseLLMInterfaceResponse(fullText ?? ''));
			},
			onError: () => { resolve(empty); },
			onAbort: () => { resolve(empty); },
		});
	});
}

function buildInterfaceExtractionPrompt(
	unitName: string,
	translatedCode: string,
	targetLang: string,
): LLMChatMessage[] {
	const maxCodeLen = 6000;
	const code = translatedCode.length > maxCodeLen
		? translatedCode.slice(0, maxCodeLen) + '\n... [truncated]'
		: translatedCode;

	const system = `You are a code analysis assistant. Given a translated code unit, extract ONLY its public API.
Respond with valid JSON only \u2014 no explanation, no markdown, no prose outside the JSON block.`;

	const user = `Analyse this ${targetLang.toUpperCase()} unit named "${unitName}" and extract its public interface.

\`\`\`${targetLang}
${code}
\`\`\`

Respond with this exact JSON structure:
{
  "summary": "<one sentence: what does this unit do from a business perspective>",
  "signatures": ["<each public class/function/method signature, one per entry, no body>"],
  "inputTypes": ["<unique type names of all input parameters>"],
  "outputTypes": ["<unique type names of all return types / output parameters>"]
}

Rules:
- "signatures" = only public/exported declarations, NO implementation bodies
- Keep each signature on one line
- Maximum 20 entries in "signatures"
- "inputTypes" and "outputTypes" = deduplicated type names only, no variable names`;

	return [
		{ role: 'system', content: system },
		{ role: 'user',   content: user },
	] as LLMChatMessage[];
}

function parseLLMInterfaceResponse(raw: string): ILLMExtractionResult {
	const empty: ILLMExtractionResult = { signatures: [], inputTypes: [], outputTypes: [], summary: '' };
	try {
		// Strip markdown code fences if present
		const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
		const obj = JSON.parse(cleaned);
		if (typeof obj !== 'object' || obj === null) { return empty; }

		const signatures  = Array.isArray(obj.signatures)  ? obj.signatures.map(String).filter(Boolean)  : [];
		const inputTypes  = Array.isArray(obj.inputTypes)  ? obj.inputTypes.map(String).filter(Boolean)  : [];
		const outputTypes = Array.isArray(obj.outputTypes) ? obj.outputTypes.map(String).filter(Boolean) : [];
		const summary     = typeof obj.summary === 'string' ? obj.summary.trim() : '';

		return { signatures, inputTypes, outputTypes, summary };
	} catch {
		return empty;
	}
}


// \u2500\u2500\u2500 Summary extraction \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Derive a one-sentence summary without an LLM call.
 *
 * Priority:
 * 1. The unit's `domain` + name (e.g. "Billing domain \u2014 CalcLateFee")
 * 2. First meaningful block comment (/** ... *\/ or # ...) in the translated code
 * 3. Fallback to unit name
 */
function extractSummary(
	code: string,
	lang: string,
	domain: string | undefined,
	unitName: string,
): string {
	// Priority 1: domain + name
	if (domain) {
		return `${capitalise(domain)} \u2014 ${unitName}`;
	}

	// Priority 2: first block/line comment that looks like a description
	const commentPatterns: RegExp[] = [];
	if (['java', 'typescript', 'javascript', 'csharp', 'kotlin', 'scala', 'go', 'rust'].includes(lang)) {
		commentPatterns.push(/\/\*\*?\s*([\s\S]*?)\*\//);      // /** ... */
		commentPatterns.push(/\/\/\s*(.{10,100})/);             // // comment
	} else if (['python', 'ruby'].includes(lang)) {
		commentPatterns.push(/"""([\s\S]*?)"""/);               // """docstring"""
		commentPatterns.push(/#\s*(.{10,100})/);                // # comment
	}

	for (const pattern of commentPatterns) {
		const m = code.match(pattern);
		if (m) {
			const text = (m[1] ?? '').replace(/\s*\*\s*/g, ' ').replace(/\s+/g, ' ').trim();
			if (text.length >= 10 && text.length <= 200) {
				return text.split(/[.!?]/)[0].trim() || unitName;
			}
		}
	}

	// Priority 3: unit name
	return unitName;
}


// \u2500\u2500\u2500 Utilities \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function dedup(arr: string[]): string[] {
	return [...new Set(arr.filter(s => s.trim().length > 0))];
}

function capitalise(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}
