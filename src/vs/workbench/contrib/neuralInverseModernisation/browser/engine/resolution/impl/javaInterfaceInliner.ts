/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Java Interface Inliner
 *
 * Resolves Java EE and Spring Bean dependencies for context injection.
 *
 * ## The Java Context Problem
 *
 * Java code references external classes through:
 * 1. `@EJB UserSessionBean userBean` — an injected EJB whose interface the AI doesn't know
 * 2. `@Autowired UserRepository userRepo` — a Spring bean
 * 3. `UserSessionBean bean = (UserSessionBean) ctx.lookup("...")` — JNDI lookup
 *
 * When the AI encounters these, it knows the type name but not what methods it exposes,
 * what transactions it manages, or what business rules it encapsulates.
 *
 * ## Strategy
 *
 * We inject a `// [INTERFACE CONTEXT]` comment block before the class body, listing:
 * - For each injected dependency found in the KB: its purpose + public method signatures
 * - For each dependency NOT found in the KB: a note that it's unknown
 *
 * We deliberately keep Java imports intact (unlike COBOL copybooks, we don't expand them
 * inline — Java's type system would reject inlined class bodies). Comments are injected
 * instead.
 *
 * ## Example Output
 *
 * ```java
 * // ── NEURAL INVERSE INTERFACE CONTEXT ────────────────────────────────────────
 * // Injected beans resolved from Knowledge Base:
 * //
 * // @EJB UserSessionBean
 * //   Purpose: Manages user authentication and session lifecycle
 * //   Status:  PENDING (not yet translated)
 * //   Key methods:
 * //     getUserById(long userId): UserDTO
 * //     validateSession(String token): boolean
 * //     createSession(UserDTO user): String
 * //
 * // @Autowired AccountRepository
 * //   Purpose: [NOT IN KNOWLEDGE BASE — external or library class]
 * // ─────────────────────────────────────────────────────────────────────────────
 * @Stateless
 * public class PaymentService { ... }
 * ```
 */

import { IDependencyRef, IDependencyResolutionResult } from './resolutionTypes.js';
import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';


// ─── Public API ───────────────────────────────────────────────────────────────

export interface IJavaInlineOptions {
	insertMarkers: boolean;
	maxMethodsPerBean: number;
}

export interface IJavaInlineResult {
	expandedSource: string;
	resolvedRefs: IDependencyResolutionResult[];
	unresolvedRefs: IDependencyResolutionResult[];
}

/**
 * Inject interface context for Java EE / Spring bean dependencies.
 */
export function resolveJavaDependencies(
	sourceText: string,
	kb: IKnowledgeBaseService,
	options: IJavaInlineOptions,
): IJavaInlineResult {
	if (!options.insertMarkers) {
		return { expandedSource: sourceText, resolvedRefs: [], unresolvedRefs: [] };
	}

	const resolvedRefs: IDependencyResolutionResult[] = [];
	const unresolvedRefs: IDependencyResolutionResult[] = [];

	// Extract all injection points
	const injections = extractInjectionPoints(sourceText);
	if (injections.length === 0) {
		return { expandedSource: sourceText, resolvedRefs, unresolvedRefs };
	}

	// Build context block
	const contextLines: string[] = [
		'// ══ NEURAL INVERSE — DEPENDENCY CONTEXT ═════════════════════════════════════',
		'// Injected dependencies resolved from Knowledge Base:',
		'//',
	];

	for (const inj of injections) {
		const unit = kb.getAllUnits().find(u =>
			u.name === inj.typeName ||
			u.name.endsWith(`.${inj.typeName}`) ||
			u.name.includes(inj.typeName)
		);

		const depRef: IDependencyRef = {
			rawRef: inj.rawDeclaration,
			canonicalName: inj.typeName,
			line: inj.line,
			depType: inj.depType,
		};

		if (!unit) {
			contextLines.push(`// ${inj.annotationType} ${inj.typeName}`);
			contextLines.push(`//   [NOT IN KNOWLEDGE BASE — external library or not yet scanned]`);
			contextLines.push('//');
			unresolvedRefs.push({
				ref: depRef,
				resolved: false,
				inlinedContent: '',
				failureReason: `${inj.typeName} not found in knowledge base`,
			});
			continue;
		}

		contextLines.push(`// ${inj.annotationType} ${inj.typeName} (${inj.fieldName})`);
		contextLines.push(`//   Status:  ${unit.status.toUpperCase()} | Risk: ${unit.riskLevel.toUpperCase()}`);

		if (unit.businessRules.length > 0) {
			contextLines.push(`//   Purpose: ${unit.businessRules[0].description}`);
		}

		if (unit.targetInterface) {
			contextLines.push(`//   Modern interface (${unit.targetInterface.targetLanguage}):`);
			const methods = unit.targetInterface.signatures.slice(0, options.maxMethodsPerBean);
			for (const method of methods) {
				contextLines.push(`//     ${method}`);
			}
			if (unit.targetInterface.signatures.length > options.maxMethodsPerBean) {
				contextLines.push(`//     ... (${unit.targetInterface.signatures.length - options.maxMethodsPerBean} more)`);
			}
		} else {
			// Try to extract method signatures from the source text
			const methods = extractPublicMethodSignatures(unit.sourceText, options.maxMethodsPerBean);
			if (methods.length > 0) {
				contextLines.push(`//   Source signatures (${unit.sourceLang}):`);
				for (const m of methods) {
					contextLines.push(`//     ${m}`);
				}
			}
		}

		contextLines.push('//');

		resolvedRefs.push({
			ref: depRef,
			resolved: true,
			inlinedContent: contextLines.join('\n'),
			resolvedUnitId: unit.id,
		});
	}

	contextLines.push('// ══════════════════════════════════════════════════════════════════════════════');
	contextLines.push('');

	return {
		expandedSource: contextLines.join('\n') + sourceText,
		resolvedRefs,
		unresolvedRefs,
	};
}


// ─── Injection Point Parser ───────────────────────────────────────────────────

interface IInjectionPoint {
	annotationType: string;           // '@EJB', '@Autowired', '@Inject', '@Resource'
	typeName: string;                 // 'UserSessionBean', 'AccountRepository'
	fieldName: string;                // 'userBean', 'accountRepo'
	rawDeclaration: string;
	line: number;
	depType: IDependencyRef['depType'];
}

/**
 * Extract all @EJB, @Autowired, @Inject, @Resource injection points.
 */
function extractInjectionPoints(text: string): IInjectionPoint[] {
	const points: IInjectionPoint[] = [];
	const lines = text.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();

		// @EJB / @Autowired / @Inject / @Resource followed by field declaration
		if (/@EJB|@Autowired|@Inject\b|@Resource/.test(line)) {
			const annotationType = line.match(/@(EJB|Autowired|Inject|Resource)\b/)?.[0] ?? '@Inject';
			const depType: IDependencyRef['depType'] = /@EJB/i.test(annotationType) ? 'java-ejb' : 'java-import';

			// Field declaration is on same line or next line
			const declLine = line.includes(' ') && !line.endsWith(')') ? line : (lines[i + 1] ?? '').trim();
			const fieldMatch = declLine.match(/(?:private|protected|public|final)?\s*(?:static)?\s*([A-Z][A-Za-z0-9$_<>]+)\s+([a-z][A-Za-z0-9$_]+)/);

			if (fieldMatch) {
				const typeName = fieldMatch[1].replace(/<.*>/, ''); // strip generics
				const fieldName = fieldMatch[2];

				// Skip primitive types and common standard types
				if (!isStandardJavaType(typeName)) {
					points.push({
						annotationType,
						typeName,
						fieldName,
						rawDeclaration: line,
						line: i + 1,
						depType,
					});
				}
			}
		}
	}

	return points;
}

/**
 * Extract public method signatures from Java source text (heuristic, no AST).
 */
function extractPublicMethodSignatures(sourceText: string, maxMethods: number): string[] {
	const signatures: string[] = [];
	const METHOD_RE = /public\s+(?:(?:static|final|synchronized|abstract)\s+)*([A-Za-z0-9$_<>\[\]]+)\s+([a-z][A-Za-z0-9$_]*)\s*\(([^)]*)\)/g;

	let match: RegExpExecArray | null;
	while ((match = METHOD_RE.exec(sourceText)) !== null) {
		const returnType = match[1];
		const methodName = match[2];
		const params = match[3].trim();

		// Skip main, equals, hashCode, toString — boilerplate
		if (['main', 'equals', 'hashCode', 'toString', 'clone'].includes(methodName)) {
			continue;
		}

		signatures.push(`${returnType} ${methodName}(${params})`);
		if (signatures.length >= maxMethods) {
			break;
		}
	}

	return signatures;
}

const STANDARD_JAVA_TYPES = new Set([
	'String', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Byte', 'Short', 'Character',
	'void', 'int', 'long', 'double', 'float', 'boolean', 'byte', 'short', 'char',
	'List', 'Map', 'Set', 'Collection', 'Optional', 'Stream', 'Object', 'Class',
	'BigDecimal', 'BigInteger', 'Date', 'LocalDate', 'LocalDateTime', 'Instant',
	'StringBuilder', 'StringBuffer', 'Number',
]);

function isStandardJavaType(typeName: string): boolean {
	return STANDARD_JAVA_TYPES.has(typeName);
}
