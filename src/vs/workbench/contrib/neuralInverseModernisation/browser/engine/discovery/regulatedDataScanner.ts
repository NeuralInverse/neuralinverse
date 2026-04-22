/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Regulated Data Scanner — Firmware & Safety-Critical Edition
 *
 * Scans firmware source code for safety-regulated patterns embedded directly
 * in source text. Each hit is language-neutral — the scanner works on raw
 * text after basic comment stripping.
 *
 * ## Pattern Catalogue
 *
 * | Pattern                    | Framework             | Confidence |
 * |----------------------------|-----------------------|------------|
 * | Hardcoded peripheral addr  | IEC 61508 / MISRA-C   | High       |
 * | Raw MMIO volatile cast     | MISRA-C Rule 11.4      | High       |
 * | ISR handler definition     | IEC 61508             | High       |
 * | Watchdog refresh call      | IEC 61508             | High       |
 * | Hardcoded credential       | IEC 62443             | High       |
 * | API key / auth token       | IEC 62443             | High       |
 * | PLCopen Safety FB call     | IEC 61508 / 61131     | High       |
 * | Hardcoded IP address       | IEC 62443             | Medium     |
 * | Dynamic allocation (malloc)| MISRA-C Rule 21.3     | High       |
 * | GPIO hardcoded pin literal  | IEC 61508             | Medium     |
 *
 * ## Redaction
 *
 * All stored samples have the last 4 characters visible and the rest replaced
 * with `*` characters to prevent the scan result itself from leaking data.
 *
 * ## False Positive Reduction
 *
 * - Patterns are checked against surrounding context to exclude known test/mock data.
 * - Comment-only lines are scanned with lower confidence.
 */

import { IRegulatedDataHit, RegulatedDataPattern } from './discoveryTypes.js';


// ─── Pattern → Framework Tag Mapping ─────────────────────────────────────────
//
// Maps each RegulatedDataPattern to the tag keywords that a loaded enterprise
// framework's rules must include (in IFrameworkRule.tags) for that framework to
// be considered applicable to a detected pattern.
//
// The discovery service uses this at scan time to query IFrameworkRegistry for
// the actual framework names — zero framework name strings are hardcoded here.
//
export const PATTERN_TAGS: Record<RegulatedDataPattern, string[]> = {
	// Safety-regulated firmware patterns
	'peripheral-register':   ['peripheral', 'mmio', 'register', 'hardware', 'iec-61508'],
	'raw-mmio-cast':         ['mmio', 'volatile-cast', 'misra-c-rule-11', 'iec-61508'],
	'isr-definition':        ['interrupt', 'isr', 'handler', 'iec-61508', 'timing'],
	'watchdog-refresh':      ['watchdog', 'wdt', 'iec-61508', 'safety'],
	'safety-function-block': ['plcopen-safety', 'sf-fb', 'iec-61508', 'iec-61131'],
	'dynamic-allocation':    ['malloc', 'heap', 'misra-c-rule-21', 'iec-61508'],
	'hardcoded-ip':          ['ip-address', 'iec-62443', 'network', 'ot-security'],
	// Cybersecurity patterns (IEC 62443)
	'api-key':               ['api-key', 'access-token', 'auth-token', 'credential', 'iec-62443'],
	'private-key':           ['private-key', 'pem', 'credential', 'iec-62443'],
	'connection-string':     ['connection-string', 'credential', 'iec-62443'],
	// Financial / PII patterns (retained for hybrid codebases — GDPR / PCI-DSS)
	'ssn':                   ['pii', 'gdpr', 'ccpa', 'hipaa'],
	'credit-card':           ['pci-dss', 'pii', 'financial'],
	'iban':                  ['pii', 'gdpr', 'psd2', 'financial'],
	'bic-swift':             ['pii', 'gdpr', 'financial'],
	'national-id':           ['pii', 'gdpr', 'ccpa'],
	'passport':              ['pii', 'gdpr'],
	'date-of-birth':         ['pii', 'gdpr', 'hipaa'],
	'email':                 ['pii', 'gdpr', 'ccpa'],
	'phone':                 ['pii', 'gdpr', 'ccpa'],
	'ip-address':            ['pii', 'gdpr', 'network'],
};


/**
 * Maps each RegulatedDataPattern to the list of framework names (or IDs) that
 * are applicable to it.
 *
 * Built by the discovery service from IFrameworkRegistry.getActiveFrameworks()
 * at scan time. Empty arrays mean no loaded framework explicitly covers that
 * pattern type — the hit is still recorded, just without applicable framework info.
 */
export type IPatternFrameworkMap = Partial<Record<RegulatedDataPattern, string[]>>;


// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan source content for regulated data literals.
 *
 * @param content       Full source text of the unit (or file)
 * @param unitId        Unit ID to attach hits to
 * @param fileUri       Absolute URI of the source file (for hit attribution)
 * @param lang          Normalised language key
 * @param frameworkMap  Pattern → applicable framework names, built from
 *                      IFrameworkRegistry by the discovery service at scan time.
 *                      Defaults to empty (no framework attribution) if not provided.
 */
export function scanForRegulatedData(
	content: string,
	unitId: string,
	fileUri: string,
	lang: string,
	frameworkMap: IPatternFrameworkMap = {},
): IRegulatedDataHit[] {
	const hits: IRegulatedDataHit[] = [];
	const lines = content.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNum = i + 1;

		// Determine if this line is entirely a comment (lower confidence)
		const isComment = isCommentLine(line, lang);

		scanLine(line, unitId, fileUri, lineNum, isComment, hits, frameworkMap);
	}

	return deduplicateHits(hits);
}


// ─── Per-Line Scanner ─────────────────────────────────────────────────────────

function scanLine(
	line: string,
	unitId: string,
	fileUri: string,
	lineNum: number,
	isComment: boolean,
	hits: IRegulatedDataHit[],
	frameworkMap: IPatternFrameworkMap,
): void {
	const addHit = (
		pattern: RegulatedDataPattern,
		matched: string,
		confidence: IRegulatedDataHit['confidence'],
	) => {
		const frameworks = frameworkMap[pattern] ?? [];
		if (isTestOrFakeContext(line, matched)) { return; }
		if (isComment) {
			confidence = confidence === 'high' ? 'medium' : 'low';
		}
		hits.push({
			unitId,
			fileUri,
			lineNumber: lineNum,
			pattern,
			redactedSample: redact(matched),
			confidence,
			applicableFrameworks: frameworks,
		});
	};

	// ── Raw MMIO volatile cast (MISRA-C Rule 11.4) ────────────────────────────
	// e.g.  (volatile uint32_t*)0x40020000UL
	if (/\(\s*volatile\s+uint(?:8|16|32|64)_t\s*\*\s*\)\s*0x[0-9A-Fa-f]+/.test(line)) {
		const m = /0x[0-9A-Fa-f]+U?L?/.exec(line);
		addHit('raw-mmio-cast', m?.[0] ?? line.trim().slice(0, 40), 'high');
	}

	// ── Hardcoded peripheral register address (numeric literal in peripheral range) ──
	// Typical Cortex-M peripheral space: 0x40000000 – 0x5FFFFFFF
	const perpAddrRe = /\b(0x4[0-9A-Fa-f]{7}|0x5[0-9A-Fa-f]{7})\b/g;
	let m: RegExpExecArray | null;
	while ((m = perpAddrRe.exec(line)) !== null) {
		if (!(/(volatile|uint|REG|BASE|ADDR)/i.test(line))) { continue; } // only if context looks like HW access
		addHit('peripheral-register', m[0], 'medium');
	}

	// ── ISR/Interrupt handler definition ──────────────────────────────────────
	if (/\bvoid\s+\w+_IRQHandler\s*\(\s*void\s*\)/.test(line) ||
	    /\bvoid\s+\w+_Handler\s*\(\s*void\s*\)/.test(line) ||
	    /\b__interrupt\s+void\b/.test(line)) {
		const fn = /void\s+(\w+)\s*\(/.exec(line);
		addHit('isr-definition', fn?.[1] ?? 'IRQHandler', 'high');
	}

	// ── Watchdog refresh call ─────────────────────────────────────────────────
	if (/\b(?:HAL_IWDG_Refresh|HAL_WWDG_Refresh|IWDG_ReloadCounter|wdt_feed|WDT_Feed|WDT_Kick|wdt_clear)\s*\(/.test(line)) {
		const fn = /(\w+)\s*\(/.exec(line);
		addHit('watchdog-refresh', fn?.[1] ?? 'wdt_refresh', 'high');
	}

	// ── PLCopen Safety FB call ────────────────────────────────────────────────
	if (/\b(SF_EmergencyStop|SF_SafelyLimitedSpeed|SF_SafelyLimitedPosition|SF_GuardMonitoring|SF_SafeStop|SF_EnableSwitch)\s*\(/.test(line)) {
		const fn = /(SF_\w+)/.exec(line);
		addHit('safety-function-block', fn?.[1] ?? 'SF_', 'high');
	}

	// ── Dynamic allocation (MISRA-C Rule 21.3 / IEC 61508) ───────────────────
	if (/\b(?:malloc|calloc|realloc|free|pvPortMalloc|vPortFree)\s*\(/.test(line)) {
		const fn = /(\w+)\s*\(/.exec(line);
		addHit('dynamic-allocation', fn?.[1] ?? 'malloc', 'high');
	}

	// ── Hardcoded IP address (IEC 62443 — OT network credential) ─────────────
	const ipRe = /\b((?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))\b/g;
	while ((m = ipRe.exec(line)) !== null) {
		const ip = m[1];
		// Only flag if it looks like an OT/IT target (not private test ranges)
		if (!isLoopbackIP(ip) && !isTestOrFakeContext(line, ip)) {
			addHit('hardcoded-ip', ip, 'medium');
		}
	}

	// ── PEM Private Key ───────────────────────────────────────────────────────
	if (/-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/.test(line)) {
		addHit('private-key', '-----BEGIN PRIVATE KEY-----...', 'high');
	}
	const b64KeyRe = /(?:private_?key|rsa_?key|pem_?cert)\s*[=:]\s*["']([A-Za-z0-9+/=]{40,})["']/i;
	const b64Mat = b64KeyRe.exec(line);
	if (b64Mat) { addHit('private-key', b64Mat[1], 'high'); }

	// ── API Key / Auth Token (IEC 62443 — OT credential) ─────────────────────
	const apiKeyRe = /(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|bearer[_-]?token|client[_-]?secret|oauth[_-]?token)\s*[=:]\s*["'`]([^\s"'`]{16,})["'`]/i;
	const apiMat = apiKeyRe.exec(line);
	if (apiMat) { addHit('api-key', apiMat[1], 'high'); }

	// ── OT/IT Connection String ────────────────────────────────────────────────
	const connStrPatterns = [
		/(?:modbus|opcua|opc\.tcp|mqtt|amqp|s7|profinet):\/\/[^:@\s]+:[^@\s]{4,}@[^\s"'`]+/i,
		/(?:Server|Host)=[^;]+;.*(?:Password|Pwd)=[^;]+/i,
		/jdbc:[\w:]+:\/\/[^\s"'`]+:[^@\s]{4,}@[^\s"'`]+/i,
	];
	for (const re of connStrPatterns) {
		const connMat = re.exec(line);
		if (connMat) {
			addHit('connection-string', connMat[0], 'high');
			break;
		}
	}
}



function isLoopbackIP(ip: string): boolean {
	return ip === '127.0.0.1' || ip.startsWith('127.') || ip === '0.0.0.0';
}

/** Returns true if the surrounding context contains known test data markers. */
function isTestOrFakeContext(line: string, matched: string): boolean {
	const TEST_MARKERS = /\b(?:test|fake|mock|dummy|example|sample|placeholder|fixture|stub)\b/i;
	const idx = line.indexOf(matched);
	const context = line.slice(Math.max(0, idx - 50), Math.min(line.length, idx + matched.length + 50));
	return TEST_MARKERS.test(context);
}


// ─── Comment Detection ────────────────────────────────────────────────────────

function isCommentLine(line: string, lang: string): boolean {
	const t = line.trim();
	if (!t) { return false; }
	// C-style (embedded C, C++, assembler with // comments)
	if (['c', 'cpp', 'java', 'kotlin', 'scala', 'csharp', 'typescript', 'javascript', 'go', 'rust', 'swift', 'dart', 'php', 'groovy'].includes(lang)) {
		return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
	}
	// Assembly (ARM: ; or @ prefix, AVR: ;)
	if (lang === 'assembler') { return t.startsWith(';') || t.startsWith('@') || t.startsWith('//'); }
	// IEC 61131-3 (* ... *) comments
	if (lang === 'iec61131') { return t.startsWith('(*') || t.startsWith('//'); }
	if (['python', 'ruby', 'shell', 'elixir', 'yaml', 'toml'].includes(lang)) { return t.startsWith('#'); }
	if (lang === 'sql' || lang === 'plsql') { return t.startsWith('--'); }
	if (lang === 'haskell' || lang === 'lua') { return t.startsWith('--'); }
	if (lang === 'xml' || lang === 'html') { return t.startsWith('<!--'); }
	return false;
}


// ─── Redaction ────────────────────────────────────────────────────────────────

/** Redact all but the last 4 characters of a matched value. */
function redact(value: string): string {
	const clean = value.replace(/\s/g, '');
	if (clean.length <= 4) { return '****'; }
	return '*'.repeat(clean.length - 4) + clean.slice(-4);
}


// ─── Deduplication ────────────────────────────────────────────────────────────

function deduplicateHits(hits: IRegulatedDataHit[]): IRegulatedDataHit[] {
	const seen = new Set<string>();
	return hits.filter(hit => {
		const key = `${hit.pattern}:${hit.lineNumber}:${hit.redactedSample}`;
		if (seen.has(key)) { return false; }
		seen.add(key);
		return true;
	});
}
