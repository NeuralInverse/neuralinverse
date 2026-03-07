/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # External Output Parsers
 *
 * Pure functions that parse vendor tool output into Map<fileUriString, ICheckResult[]>.
 *
 * All parsers return a Map (not an array) because tools like CodeQL, Semgrep, and Polyspace
 * emit results covering many files in a single run. The map key is the file URI string;
 * callers iterate it to inject results per-file into the GRC engine.
 *
 * ## Supported formats
 *
 * | Class                | Format         | Tools                                      |
 * |----------------------|----------------|--------------------------------------------|
 * | SarifParser          | SARIF v2.1     | CodeQL, Semgrep, Snyk, GitHub Adv Security |
 * | PolyspaceParser      | CSV / XML      | Polyspace Bug Finder, Code Prover          |
 * | MatlabMlintParser    | text           | MATLAB mlint / checkcode                   |
 * | EslintJsonParser     | JSON           | ESLint --format=json                       |
 * | CheckstyleXmlParser  | XML            | Checkstyle, PMD, SpotBugs (Java)           |
 *
 * See: docs/EXTERNAL_ANALYSIS_BRIDGE.md — Part 4
 */

import { URI } from '../../../../../../base/common/uri.js';
import { IGRCRule, ICheckResult, toDisplaySeverity } from '../types/grcTypes.js';


// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve a SARIF artifact URI (may be relative) to an absolute file URI string. */
function resolveArtifactUri(rawUri: string, workspaceRoot: string): string {
	if (!rawUri) return '';
	// Already absolute
	if (rawUri.startsWith('file://') || rawUri.startsWith('/') || /^[A-Za-z]:\\/.test(rawUri)) {
		return rawUri.startsWith('file://') ? rawUri : URI.file(rawUri).toString();
	}
	// Relative — resolve against workspace root
	const joined = workspaceRoot.replace(/\/$/, '') + '/' + rawUri.replace(/^\//, '');
	return URI.file(joined).toString();
}

/** Build a base ICheckResult from a rule and location data. */
function makeResult(
	ruleId: string,
	rule: IGRCRule,
	severity: string,
	message: string,
	fileUri: URI,
	line: number,
	column: number,
	endLine: number,
	endColumn: number,
	timestamp: number,
	fix?: string
): ICheckResult {
	return {
		ruleId,
		domain: rule.domain,
		severity: toDisplaySeverity(severity),
		message: `[${ruleId}] ${message}`,
		fileUri,
		line: Math.max(1, line),
		column: Math.max(1, column),
		endLine: Math.max(1, endLine || line),
		endColumn: Math.max(1, endColumn || column + 1),
		fix: fix ?? rule.fix,
		timestamp,
		frameworkId: rule.frameworkId,
		references: rule.references,
		blockingBehavior: rule.blockingBehavior,
	};
}


// ─── SARIF v2.1 Parser ───────────────────────────────────────────────────────

/**
 * Full SARIF v2.1 parser.
 *
 * SARIF (Static Analysis Results Interchange Format) is the industry standard
 * output format for CodeQL, Semgrep, Snyk, and GitHub Advanced Security.
 *
 * What this parser handles beyond the previous basic implementation:
 * - Maps each result to the CORRECT file using result.locations[].physicalLocation.artifactLocation.uri
 * - Resolves relative artifact URIs against the workspace root
 * - Looks up rule metadata (full description, help URI) from run.tool.driver.rules[]
 * - Extracts fix text from result.fixes[].description.text
 * - Handles run.artifacts[] for URI index resolution
 * - Multi-run SARIF files (multiple tools in one file)
 * - Severity from result.level with fallback to rule defaultConfiguration.level
 */
export class SarifParser {

	/**
	 * Parse SARIF JSON string into per-file results.
	 *
	 * @param sarifJson     Raw stdout from the tool
	 * @param defaultRule   The IGRCRule that triggered this scan (used for domain/frameworkId)
	 * @param workspaceRoot Absolute workspace path for resolving relative URIs
	 * @param timestamp     Millisecond timestamp for the ICheckResult
	 * @returns Map of fileUri string → violations in that file
	 */
	static parse(
		sarifJson: string,
		defaultRule: IGRCRule,
		workspaceRoot: string,
		timestamp: number
	): Map<string, ICheckResult[]> {
		const out = new Map<string, ICheckResult[]>();

		let sarif: any;
		try {
			sarif = JSON.parse(sarifJson);
		} catch (e) {
			console.error('[SarifParser] Failed to parse SARIF JSON:', e);
			return out;
		}

		if (!Array.isArray(sarif.runs)) {
			return out;
		}

		for (const run of sarif.runs) {
			// Build rule metadata index from tool.driver.rules[]
			const ruleMetaMap = new Map<string, { description: string; helpUri?: string; level?: string }>();
			const driverRules = run.tool?.driver?.rules ?? [];
			for (const r of driverRules) {
				if (!r.id) continue;
				ruleMetaMap.set(r.id, {
					description: r.fullDescription?.text ?? r.shortDescription?.text ?? '',
					helpUri: r.helpUri ?? r.help?.uri,
					level: r.defaultConfiguration?.level,
				});
			}

			// Build artifact URI index (artifacts may use integer index references)
			const artifactUris: string[] = [];
			for (const artifact of (run.artifacts ?? [])) {
				artifactUris.push(artifact.location?.uri ?? '');
			}

			for (const result of (run.results ?? [])) {
				const ruleId: string = result.ruleId ?? defaultRule.id;
				const ruleMeta = ruleMetaMap.get(ruleId);

				// Determine message
				const message = result.message?.text ?? result.message?.markdown ?? ruleMeta?.description ?? defaultRule.message;

				// Determine severity
				const sarifLevel = result.level ?? ruleMeta?.level ?? 'warning';
				const severity = SarifParser._levelToSeverity(sarifLevel);

				// Extract fix text if available
				const fix = result.fixes?.[0]?.description?.text;

				// Process each location
				for (const location of (result.locations ?? [{ physicalLocation: {} }])) {
					const physLoc = location.physicalLocation ?? {};
					const artLoc = physLoc.artifactLocation ?? {};

					// Resolve file URI
					let rawUri: string = artLoc.uri ?? '';

					// Handle artifact index reference
					if (!rawUri && typeof artLoc.index === 'number') {
						rawUri = artifactUris[artLoc.index] ?? '';
					}

					if (!rawUri) continue;

					const resolvedUriStr = resolveArtifactUri(rawUri, workspaceRoot);
					if (!resolvedUriStr) continue;

					const fileUri = URI.parse(resolvedUriStr);

					const region = physLoc.region ?? {};
					const r = makeResult(
						ruleId,
						defaultRule,
						severity,
						message,
						fileUri,
						region.startLine ?? 1,
						region.startColumn ?? 1,
						region.endLine ?? region.startLine ?? 1,
						region.endColumn ?? (region.startColumn ?? 0) + 1,
						timestamp,
						fix
					);

					const key = fileUri.toString();
					if (!out.has(key)) out.set(key, []);
					out.get(key)!.push(r);
				}
			}
		}

		return out;
	}

	private static _levelToSeverity(level: string): string {
		switch (level?.toLowerCase()) {
			case 'error':   return 'error';
			case 'warning': return 'warning';
			case 'note':    return 'info';
			case 'none':    return 'info';
			default:        return 'warning';
		}
	}
}


// ─── Polyspace Parser ────────────────────────────────────────────────────────

/**
 * Polyspace Bug Finder / Code Prover output parser.
 *
 * Polyspace is MathWorks' static analysis tool for C/C++/Ada, widely used in
 * automotive (ISO 26262), aerospace (DO-178C), and medical (IEC 62304) sectors.
 *
 * CSV format (Polyspace 2018 and earlier):
 *   File,Function,Check,Category,Color,Line,Col,Comment
 *   src/ctrl.c,PID_Control,Overflow,Numerical,Red,142,8,""
 *
 * XML format (Polyspace 2019+):
 *   <polyspace-results>
 *     <defect file="src/ctrl.c" line="142" col="8"
 *             category="Numerical" check="Overflow" color="red" function="PID_Control"/>
 *   </polyspace-results>
 *
 * Color → severity:  Red=error, Orange=warning, Green=info
 */
export class PolyspaceParser {

	static parse(
		output: string,
		format: 'polyspace-csv' | 'polyspace-xml',
		defaultRule: IGRCRule,
		workspaceRoot: string,
		timestamp: number
	): Map<string, ICheckResult[]> {
		return format === 'polyspace-xml'
			? PolyspaceParser._parseXml(output, defaultRule, workspaceRoot, timestamp)
			: PolyspaceParser._parseCsv(output, defaultRule, workspaceRoot, timestamp);
	}

	private static _colorToSeverity(color: string): string {
		switch (color?.toLowerCase()) {
			case 'red':    return 'error';
			case 'orange': return 'warning';
			case 'green':  return 'info';
			default:       return 'warning';
		}
	}

	private static _parseCsv(
		csv: string,
		defaultRule: IGRCRule,
		workspaceRoot: string,
		timestamp: number
	): Map<string, ICheckResult[]> {
		const out = new Map<string, ICheckResult[]>();
		const lines = csv.split('\n').filter(l => l.trim());

		// Skip header row
		const dataLines = lines[0]?.toLowerCase().includes('file') ? lines.slice(1) : lines;

		for (const line of dataLines) {
			// CSV: File,Function,Check,Category,Color,Line,Col,Comment
			const cols = PolyspaceParser._splitCsvLine(line);
			if (cols.length < 6) continue;

			const [file, fn, check, category, color, lineStr, colStr] = cols;
			const lineNum = parseInt(lineStr, 10) || 1;
			const colNum = parseInt(colStr, 10) || 1;
			const severity = PolyspaceParser._colorToSeverity(color);
			const message = `${check} (${category}) in ${fn}`;

			const resolvedUri = resolveArtifactUri(file.trim(), workspaceRoot);
			if (!resolvedUri) continue;

			const fileUri = URI.parse(resolvedUri);
			const r = makeResult(defaultRule.id, defaultRule, severity, message, fileUri, lineNum, colNum, lineNum, colNum + 1, timestamp);

			const key = fileUri.toString();
			if (!out.has(key)) out.set(key, []);
			out.get(key)!.push(r);
		}

		return out;
	}

	private static _parseXml(
		xml: string,
		defaultRule: IGRCRule,
		workspaceRoot: string,
		timestamp: number
	): Map<string, ICheckResult[]> {
		const out = new Map<string, ICheckResult[]>();

		// Simple attribute extraction without a full XML parser dependency
		const defectRe = /<defect\s([^>]+)\/>/g;
		let match: RegExpExecArray | null;

		while ((match = defectRe.exec(xml)) !== null) {
			const attrs = PolyspaceParser._parseXmlAttrs(match[1]);
			const file = attrs['file'] ?? '';
			if (!file) continue;

			const lineNum = parseInt(attrs['line'] ?? '1', 10) || 1;
			const colNum = parseInt(attrs['col'] ?? '1', 10) || 1;
			const severity = PolyspaceParser._colorToSeverity(attrs['color'] ?? 'orange');
			const message = `${attrs['check'] ?? 'Defect'} (${attrs['category'] ?? ''}) in ${attrs['function'] ?? ''}`;

			const resolvedUri = resolveArtifactUri(file, workspaceRoot);
			if (!resolvedUri) continue;

			const fileUri = URI.parse(resolvedUri);
			const r = makeResult(defaultRule.id, defaultRule, severity, message, fileUri, lineNum, colNum, lineNum, colNum + 1, timestamp);

			const key = fileUri.toString();
			if (!out.has(key)) out.set(key, []);
			out.get(key)!.push(r);
		}

		return out;
	}

	/** Parse XML attribute string into a key-value map. */
	private static _parseXmlAttrs(attrStr: string): Record<string, string> {
		const result: Record<string, string> = {};
		const re = /(\w+)="([^"]*)"/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(attrStr)) !== null) {
			result[m[1]] = m[2];
		}
		return result;
	}

	/** Minimal CSV line splitter (handles quoted fields). */
	private static _splitCsvLine(line: string): string[] {
		const cols: string[] = [];
		let current = '';
		let inQuotes = false;
		for (const ch of line) {
			if (ch === '"') { inQuotes = !inQuotes; }
			else if (ch === ',' && !inQuotes) { cols.push(current); current = ''; }
			else { current += ch; }
		}
		cols.push(current);
		return cols;
	}
}


// ─── MATLAB mlint Parser ─────────────────────────────────────────────────────

/**
 * MATLAB Code Analyzer (mlint / checkcode) output parser.
 *
 * Format (single-file, file-scope only):
 *   L 42 (C 1-8): FNDEF: Missing function definition end.
 *   L 67 (C 12): AGROW: Variable 'data' changes size on every loop iteration.
 *
 * Returns a Map with a single entry (the scanned file).
 */
export class MatlabMlintParser {

	// L <line> (C <colStart>[-<colEnd>]): <id>: <message>
	private static readonly LINE_RE =
		/^L\s+(\d+)\s+\(C\s+(\d+)(?:-(\d+))?\):\s+(\w+):\s+(.+)$/;

	static parse(
		output: string,
		fileUri: URI,
		defaultRule: IGRCRule,
		timestamp: number
	): Map<string, ICheckResult[]> {
		const out = new Map<string, ICheckResult[]>();
		const results: ICheckResult[] = [];

		for (const line of output.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			const m = MatlabMlintParser.LINE_RE.exec(trimmed);
			if (!m) continue;

			const lineNum = parseInt(m[1], 10);
			const colStart = parseInt(m[2], 10);
			const colEnd = m[3] ? parseInt(m[3], 10) : colStart + 1;
			const mlintId = m[4];
			const message = `${mlintId}: ${m[5]}`;

			results.push(makeResult(
				`${defaultRule.id}:${mlintId}`,
				defaultRule,
				'warning',   // mlint doesn't report severity — all are warnings
				message,
				fileUri,
				lineNum, colStart, lineNum, colEnd,
				timestamp
			));
		}

		if (results.length > 0) {
			out.set(fileUri.toString(), results);
		}

		return out;
	}
}


// ─── ESLint JSON Parser ──────────────────────────────────────────────────────

/**
 * ESLint --format=json output parser.
 *
 * Format:
 * [
 *   {
 *     "filePath": "/abs/path/to/file.js",
 *     "messages": [
 *       { "line": 10, "column": 5, "endLine": 10, "endColumn": 12,
 *         "severity": 2, "message": "Unexpected eval.", "ruleId": "no-eval" }
 *     ]
 *   }
 * ]
 *
 * ESLint severity: 2=error, 1=warning, 0=off
 */
export class EslintJsonParser {

	static parse(
		json: string,
		defaultRule: IGRCRule,
		timestamp: number
	): Map<string, ICheckResult[]> {
		const out = new Map<string, ICheckResult[]>();

		let data: any[];
		try {
			data = JSON.parse(json);
			if (!Array.isArray(data)) return out;
		} catch (e) {
			console.error('[EslintJsonParser] Failed to parse ESLint JSON:', e);
			return out;
		}

		for (const fileResult of data) {
			if (!fileResult.filePath || !Array.isArray(fileResult.messages)) continue;

			const fileUri = URI.file(fileResult.filePath);
			const results: ICheckResult[] = [];

			for (const msg of fileResult.messages) {
				if (!msg.message) continue;

				const severity = msg.severity === 2 ? 'error' : msg.severity === 1 ? 'warning' : 'info';
				const ruleId = msg.ruleId ? `${defaultRule.id}:${msg.ruleId}` : defaultRule.id;
				const message = msg.ruleId ? `${msg.ruleId}: ${msg.message}` : msg.message;

				results.push(makeResult(
					ruleId,
					defaultRule,
					severity,
					message,
					fileUri,
					msg.line ?? 1,
					msg.column ?? 1,
					msg.endLine ?? msg.line ?? 1,
					msg.endColumn ?? (msg.column ?? 0) + 1,
					timestamp
				));
			}

			if (results.length > 0) {
				out.set(fileUri.toString(), results);
			}
		}

		return out;
	}
}


// ─── Checkstyle XML Parser ───────────────────────────────────────────────────

/**
 * Checkstyle XML output parser.
 *
 * Used by Java tools: Checkstyle, PMD (with checkstyle reporter), SpotBugs.
 *
 * Format:
 * <checkstyle version="10.0">
 *   <file name="/abs/path/File.java">
 *     <error line="10" column="5" severity="error"
 *            message="Unused import." source="com.puppycrawl.tools.checkstyle.checks.imports.UnusedImportsCheck"/>
 *   </file>
 * </checkstyle>
 */
export class CheckstyleXmlParser {

	static parse(
		xml: string,
		defaultRule: IGRCRule,
		timestamp: number
	): Map<string, ICheckResult[]> {
		const out = new Map<string, ICheckResult[]>();

		// Extract <file name="..."> blocks
		const fileBlockRe = /<file\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/file>/g;
		let fileMatch: RegExpExecArray | null;

		while ((fileMatch = fileBlockRe.exec(xml)) !== null) {
			const filePath = fileMatch[1];
			const blockContent = fileMatch[2];

			const fileUri = URI.file(filePath);
			const results: ICheckResult[] = [];

			// Extract <error .../> within this file block
			const errorRe = /<error\s([^>]+)\/>/g;
			let errMatch: RegExpExecArray | null;

			while ((errMatch = errorRe.exec(blockContent)) !== null) {
				const attrs = CheckstyleXmlParser._parseAttrs(errMatch[1]);

				const lineNum = parseInt(attrs['line'] ?? '1', 10) || 1;
				const colNum = parseInt(attrs['column'] ?? '1', 10) || 1;
				const severity = attrs['severity'] ?? 'warning';
				const message = attrs['message'] ?? '';
				const source = attrs['source'] ?? '';

				// Use last segment of source class name as rule suffix
				const sourceSuffix = source.split('.').pop() ?? '';
				const ruleId = sourceSuffix ? `${defaultRule.id}:${sourceSuffix}` : defaultRule.id;

				results.push(makeResult(
					ruleId,
					defaultRule,
					severity,
					message,
					fileUri,
					lineNum, colNum, lineNum, colNum + 1,
					timestamp
				));
			}

			if (results.length > 0) {
				out.set(fileUri.toString(), results);
			}
		}

		return out;
	}

	private static _parseAttrs(attrStr: string): Record<string, string> {
		const result: Record<string, string> = {};
		const re = /(\w+)="([^"]*)"/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(attrStr)) !== null) {
			result[m[1]] = m[2];
		}
		return result;
	}
}
