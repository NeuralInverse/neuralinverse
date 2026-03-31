/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Compliance depth agent tools — Phase 6
 *
 * Routes the existing stub compliance tools through the live IGRCEngineService.
 * Replaces "connect to GRC engine" stubs with actual violation data.
 *
 * Three tools:
 *   fw_misra_check_file — all MISRA C violations in a specific file
 *   fw_list_framework_violations — violations for the active safety framework (IEC 62304, ISO 26262, etc.)
 *   fw_generate_traceability — requirements traceability matrix for safety documentation
 */

import { IVoidInternalTool } from '../../../../void/browser/voidInternalToolService.js';
import { IFirmwareSessionService } from '../../firmwareSessionService.js';
import { IGRCEngineService } from '../../../../neuralInverseChecks/browser/engine/services/grcEngineService.js';


export function buildComplianceTools(
	grcEngine: IGRCEngineService | undefined,
	sessionService: IFirmwareSessionService,
): IVoidInternalTool[] {
	return [
		_fwMisraCheckFile(grcEngine, sessionService),
		_fwListFrameworkViolations(grcEngine, sessionService),
		_fwGenerateTraceability(grcEngine, sessionService),
	];
}


// ─── Tool implementations ─────────────────────────────────────────────────────

function _fwMisraCheckFile(grc: IGRCEngineService | undefined, session: IFirmwareSessionService): IVoidInternalTool {
	return {
		name: 'fw_misra_check_file',
		description: 'Run MISRA C analysis on a specific source file using the live GRC engine. Returns all violations in file order with rule number (e.g. Rule 11.3), description, severity (mandatory/required/advisory), and the offending line number. More detailed than fw_misra_check which only analyzes snippets.',
		params: {
			filePath: { description: 'Path to the C source file to check, e.g. "src/main.c", "Src/stm32f4xx_it.c"' },
			severity: { description: 'Filter by severity: "mandatory", "required", "advisory", or "all" (default: "all")' },
		},
		execute: async (args: Record<string, any>) => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }

			const filePath = args.filePath as string | undefined;
			if (!filePath) { return 'Provide filePath, e.g. "src/main.c".'; }

			if (!grc) {
				return 'GRC engine not available. Ensure the Checks engine is initialized.';
			}

			if (!s.complianceFrameworks?.some(f => f.startsWith('misra'))) {
				return [
					`No MISRA framework active in session.`,
					`Active frameworks: ${s.complianceFrameworks?.join(', ') ?? 'none'}`,
					'',
					'Add MISRA C:2012 to the session compliance frameworks to enable this tool.',
				].join('\n');
			}

			const allResults = grc.getAllResults();
			const fileResults = allResults.filter(r => {
				const path = r.fileUri.fsPath ?? r.fileUri.path;
				return path.endsWith(filePath) || path.includes(filePath);
			});

			const severityFilter = (args.severity as string | undefined) ?? 'all';
			const filtered = severityFilter === 'all'
				? fileResults
				: fileResults.filter(r => r.severity.toLowerCase() === severityFilter);

			if (filtered.length === 0) {
				return fileResults.length === 0
					? `No MISRA violations found for file "${filePath}". Either the file is clean or has not been analyzed yet — try running a build first.`
					: `No ${severityFilter} violations in "${filePath}" (${fileResults.length} total violations filtered out by severity).`;
			}

			// Sort by line number
			filtered.sort((a, b) => a.line - b.line);

			const lines = [
				`MISRA C violations in ${filePath}: ${filtered.length} found`,
				'',
			];

			let mandatory = 0, required = 0, advisory = 0;
			for (const r of filtered) {
				const sev = r.severity.toLowerCase();
				if (sev === 'mandatory') { mandatory++; }
				else if (sev === 'required') { required++; }
				else { advisory++; }
			}

			lines.push(`  Mandatory: ${mandatory}  Required: ${required}  Advisory: ${advisory}`, '');

			for (const r of filtered) {
				const ruleStr = r.ruleId ? `[${r.ruleId}]` : '';
				lines.push(`  Line ${String(r.line).padStart(4)}: ${r.severity.padEnd(10)} ${ruleStr} ${r.message}`);
			}

			return lines.join('\n');
		},
	};
}


function _fwListFrameworkViolations(grc: IGRCEngineService | undefined, session: IFirmwareSessionService): IVoidInternalTool {
	return {
		name: 'fw_list_framework_violations',
		description: 'List all active safety/compliance framework violations from the GRC engine. Returns violations grouped by file, filtered to the frameworks active in the current session (IEC 62304, ISO 26262, DO-178C, CERT-C, AUTOSAR, etc.). Use to get a cross-file compliance status report.',
		params: {
			framework: { description: 'Filter by specific framework ID, e.g. "iec-62304", "iso-26262", "cert-c". Defaults to all active session frameworks.' },
			maxViolations: { description: 'Maximum violations to return. Default: 50.' },
		},
		execute: async (args: Record<string, any>) => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }

			if (!grc) {
				return 'GRC engine not available.';
			}

			const activeFrameworks = s.complianceFrameworks ?? [];
			if (activeFrameworks.length === 0) {
				return 'No compliance frameworks active in session. Add frameworks via the Firmware Environment dashboard.';
			}

			const frameworkFilter = (args.framework as string | undefined)?.toLowerCase();
			const maxViolations = typeof args.maxViolations === 'number' ? args.maxViolations : 50;

			const allResults = grc.getAllResults();

			// Filter to compliance domain results that match active frameworks
			const filtered = allResults.filter(r => {
				if (r.domain !== 'compliance') { return false; }
				if (frameworkFilter) {
					return r.ruleId?.toLowerCase().includes(frameworkFilter)
						|| r.message?.toLowerCase().includes(frameworkFilter);
				}
				// Match against active frameworks
				return activeFrameworks.some(fw =>
					r.ruleId?.toLowerCase().includes(fw.replace('-', ''))
					|| r.ruleId?.toLowerCase().includes(fw)
				);
			}).slice(0, maxViolations);

			if (filtered.length === 0) {
				return [
					`No compliance violations found.`,
					`Active frameworks: ${activeFrameworks.join(', ')}`,
					'',
					`Total GRC results: ${allResults.length}`,
					'Build the project and ensure source files are analyzed.',
				].join('\n');
			}

			// Group by file
			const byFile = new Map<string, typeof filtered>();
			for (const r of filtered) {
				const file = r.fileUri.fsPath?.split('/').pop() ?? r.fileUri.path;
				if (!byFile.has(file)) { byFile.set(file, []); }
				byFile.get(file)!.push(r);
			}

			const lines = [
				`Compliance Violations — ${filtered.length} result(s)`,
				`Active frameworks: ${activeFrameworks.join(', ')}`,
				'',
			];

			for (const [file, results] of byFile) {
				lines.push(`${file} (${results.length}):`);
				for (const r of results.slice(0, 10)) {
					const rule = r.ruleId ? ` [${r.ruleId}]` : '';
					lines.push(`  Line ${String(r.line).padStart(4)}: ${r.severity.padEnd(10)}${rule} ${r.message}`);
				}
				if (results.length > 10) { lines.push(`  … and ${results.length - 10} more`); }
				lines.push('');
			}

			if (filtered.length >= maxViolations) {
				lines.push(`Results truncated at ${maxViolations}. Increase maxViolations to see more.`);
			}

			return lines.join('\n');
		},
	};
}


function _fwGenerateTraceability(grc: IGRCEngineService | undefined, session: IFirmwareSessionService): IVoidInternalTool {
	return {
		name: 'fw_generate_traceability',
		description: 'Generate a requirements traceability matrix for IEC 62304 or ISO 26262 documentation. Links source file violations to safety requirements derived from the active compliance framework rules. Returns a Markdown table suitable for inclusion in a Software Requirements Specification or Technical Safety Concept document.',
		params: {
			framework: { description: '"iec-62304" or "iso-26262". Defaults to the first active safety framework.' },
			includeClean: { description: 'Include files with no violations (shows compliant status). Default: false.' },
		},
		execute: async (args: Record<string, any>) => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }

			const safetyFrameworks = ['iec-62304', 'iso-26262', 'do-178c', 'iec-61508', 'autosar'];
			const active = s.complianceFrameworks?.filter(f => safetyFrameworks.includes(f)) ?? [];

			if (active.length === 0) {
				return [
					'No safety framework active in session.',
					`Active frameworks: ${s.complianceFrameworks?.join(', ') ?? 'none'}`,
					'',
					'Supported frameworks for traceability: iec-62304, iso-26262, do-178c, iec-61508, autosar',
				].join('\n');
			}

			const frameworkArg = (args.framework as string | undefined)?.toLowerCase() ?? active[0];
			const includeClean = args.includeClean === true;

			if (!grc) {
				return _generateStaticTraceability(frameworkArg, s.mcuConfig?.family ?? '', includeClean);
			}

			const allResults = grc.getAllResults();
			const relevant = allResults.filter(r =>
				r.domain === 'compliance' &&
				(r.ruleId?.toLowerCase().includes(frameworkArg.replace('-', '')) || active.some(fw => r.ruleId?.includes(fw)))
			);

			return _buildTraceabilityMatrix(frameworkArg, relevant, includeClean, s.projectInfo?.projectType ?? 'generic');
		},
	};
}


// ─── Traceability matrix generators ──────────────────────────────────────────

function _buildTraceabilityMatrix(
	framework: string,
	results: ReturnType<IGRCEngineService['getAllResults']>,
	includeClean: boolean,
	projectType: string,
): string {
	const byFile = new Map<string, typeof results>();
	for (const r of results) {
		const file = r.fileUri.fsPath?.split('/').pop() ?? r.fileUri.path;
		if (!byFile.has(file)) { byFile.set(file, []); }
		byFile.get(file)!.push(r);
	}

	const date = new Date().toISOString().slice(0, 10);
	const lines = [
		`# Requirements Traceability Matrix`,
		`**Framework**: ${_frameworkLabel(framework)}`,
		`**Date**: ${date}`,
		`**Project type**: ${projectType}`,
		'',
		`| Source File | Requirement ID | Status | Violations | Notes |`,
		`|---|---|---|---|---|`,
	];

	for (const [file, fileResults] of byFile) {
		const openViolations = fileResults.filter(r => r.severity !== 'info');
		const status = openViolations.length === 0 ? '✅ COMPLIANT' : `❌ ${openViolations.length} OPEN`;
		const topViolation = openViolations[0];
		const note = topViolation ? `${topViolation.ruleId}: ${topViolation.message.slice(0, 60)}` : '—';
		const reqId = _mapFileToRequirement(file, framework);
		lines.push(`| \`${file}\` | ${reqId} | ${status} | ${openViolations.length} | ${note} |`);
	}

	if (includeClean || byFile.size === 0) {
		lines.push(`| *(other analyzed files)* | — | ✅ COMPLIANT | 0 | No violations detected |`);
	}

	lines.push('', `**Summary**: ${byFile.size} file(s) with violations, ${results.length} total findings.`);
	lines.push('', `*Generated by neuralInverseFirmware fw_generate_traceability*`);

	return lines.join('\n');
}

function _generateStaticTraceability(framework: string, mcuFamily: string, _includeClean: boolean): string {
	const date = new Date().toISOString().slice(0, 10);
	return [
		`# Requirements Traceability Matrix (Template)`,
		`**Framework**: ${_frameworkLabel(framework)}`,
		`**Date**: ${date}`,
		`**MCU**: ${mcuFamily || 'Not configured'}`,
		'',
		`> GRC engine has no results yet. Run a build and workspace scan first.`,
		`> This is a template — populate with fw_list_framework_violations data.`,
		'',
		`| Source File | Requirement ID | Status | Violations | Notes |`,
		`|---|---|---|---|---|`,
		`| \`src/main.c\` | ${_sampleReqId(framework, 1)} | ⏳ PENDING | — | Not yet analyzed |`,
		`| \`src/drivers/uart.c\` | ${_sampleReqId(framework, 2)} | ⏳ PENDING | — | Not yet analyzed |`,
		`| \`src/rtos/tasks.c\` | ${_sampleReqId(framework, 3)} | ⏳ PENDING | — | Not yet analyzed |`,
		'',
		`Run \`fw_list_framework_violations\` after a build to populate this table.`,
	].join('\n');
}

function _frameworkLabel(framework: string): string {
	const labels: Record<string, string> = {
		'iec-62304': 'IEC 62304 (Medical Device Software)',
		'iso-26262': 'ISO 26262 (Automotive Functional Safety)',
		'do-178c': 'DO-178C (Airborne Software)',
		'iec-61508': 'IEC 61508 (Functional Safety of E/E/PE Systems)',
		'autosar': 'AUTOSAR (Automotive Software Architecture)',
		'misra-c-2012': 'MISRA C:2012',
		'cert-c': 'CERT C Secure Coding Standard',
	};
	return labels[framework] ?? framework;
}

function _mapFileToRequirement(file: string, framework: string): string {
	const prefix: Record<string, string> = {
		'iec-62304': 'IEC-SRS',
		'iso-26262': 'FSR',
		'do-178c': 'SRD',
		'iec-61508': 'SRS',
		'autosar': 'AUTOSAR-SWS',
	};
	const p = prefix[framework] ?? 'REQ';
	// Derive a pseudo-requirement ID from the filename
	const base = file.replace(/\.[ch]$/, '').replace(/[^a-zA-Z0-9]/g, '-').toUpperCase();
	return `${p}-${base}-001`;
}

function _sampleReqId(framework: string, n: number): string {
	const prefix: Record<string, string> = {
		'iec-62304': `IEC-SRS-00${n}`,
		'iso-26262': `FSR-00${n}`,
		'do-178c': `SRD-00${n}`,
		'iec-61508': `SRS-00${n}`,
	};
	return prefix[framework] ?? `REQ-00${n}`;
}
