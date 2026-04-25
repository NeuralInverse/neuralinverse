/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Standalone codebase discovery tools for the Checks Agent.
 *
 * Gives the compliance-specialist Checks Agent direct access to discovery
 * findings \u2014 independently of any Modernisation session or migration workflow.
 *
 * Tools:
 *   codebase_scan       \u2014 structural + GRC risk overview of any folder
 *   find_regulated_data \u2014 PII / PCI-DSS / PHI / credential literals in source
 *   tech_debt           \u2014 security-relevant debt (hardcoded credentials, dead code, god units, etc.)
 */

import { URI } from '../../../../../../base/common/uri.js';
import { IChecksTool } from '../checksAgentTypes.js';
import { defineChecksTool } from '../checksToolRegistry.js';
import { IDiscoveryService } from '../../../../neuralInverseModernisation/browser/engine/discovery/discoveryService.js';
import { IProjectTarget } from '../../../../neuralInverseModernisation/browser/modernisationSessionService.js';


// \u2500\u2500\u2500 Factory \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function buildDiscoveryChecksTools(discoveryService: IDiscoveryService): IChecksTool[] {
	return [
		_buildCodebaseScanTool(discoveryService),
		_buildFindRegulatedDataTool(discoveryService),
		_buildTechDebtTool(discoveryService),
	];
}


// \u2500\u2500\u2500 Shared helper \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _folder(folderPath: string): IProjectTarget {
	const uri = folderPath.includes('://') ? folderPath : URI.file(folderPath).toString();
	const label = folderPath.split(/[/\\]/).filter(Boolean).pop() ?? folderPath;
	return { id: uri, role: 'source', label, folderUri: uri };
}


// \u2500\u2500\u2500 codebase_scan \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildCodebaseScanTool(discoveryService: IDiscoveryService): IChecksTool {
	return defineChecksTool(
		'codebase_scan',
		`Scan a folder for structural and compliance key findings.

Returns: language, file count, unit count, complexity stats, GRC risk level, GRC violation count, regulated-data hit count, API endpoint count, and tech debt count.

Use this when you need a compliance and structural health overview before advising on GRC requirements, risk, or regulatory framework applicability.`,
		[
			{ name: 'folder_path', type: 'string', description: 'Absolute path to the folder to scan.', required: true },
		],
		async (args) => {
			const folderPath = args.folder_path as string;
			const result = await discoveryService.scan([_folder(folderPath)], []);
			const proj = result.sources[0];
			if (!proj) { return 'No data returned from scan.'; }

			const s = proj.stats;
			const lines: string[] = [`Codebase scan \u2014 ${proj.projectLabel} (${(result.totalElapsedMs / 1000).toFixed(1)}s)\n`];
			lines.push(`Language:        ${proj.dominantLanguage}${proj.secondaryLanguage ? ', ' + proj.secondaryLanguage : ''}`);
			lines.push(`Files:           ${proj.fileCount}`);
			lines.push(`Units:           ${proj.units.length}`);
			lines.push(`Critical units:  ${s.criticalUnitCount}`);
			lines.push(`Dead code units: ${s.deadCodeUnitCount}`);
			lines.push(`Avg complexity:  ${s.avgUnitComplexity.toFixed(1)}`);
			if (proj.metadata.buildSystem) { lines.push(`Build system:    ${proj.metadata.buildSystem}`); }
			lines.push('');
			lines.push(`GRC risk level:  ${proj.grcSnapshot.blockingCount > 0 ? 'high' : proj.grcSnapshot.totalViolations > 0 ? 'medium' : 'low'}`);
			lines.push(`GRC violations:  ${proj.grcSnapshot.violations?.length ?? 0}`);
			lines.push(`Regulated data:  ${proj.regulatedDataHits.length} hit(s)`);
			lines.push(`API endpoints:   ${proj.apiEndpoints.length}`);
			lines.push(`Tech debt items: ${proj.techDebtItems.length}`);

			if (proj.grcSnapshot.violations && proj.grcSnapshot.violations.length > 0) {
				lines.push('\nTop GRC violations:');
				for (const v of proj.grcSnapshot.violations.slice(0, 5)) {
					lines.push(`  [${(v.severity ?? 'info').toUpperCase()}] ${v.ruleId} \u2014 ${v.message}`);
				}
				if (proj.grcSnapshot.violations.length > 5) {
					lines.push(`  \u2026 and ${proj.grcSnapshot.violations.length - 5} more`);
				}
			}

			return lines.join('\n');
		},
	);
}


// \u2500\u2500\u2500 find_regulated_data \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildFindRegulatedDataTool(discoveryService: IDiscoveryService): IChecksTool {
	return defineChecksTool(
		'find_regulated_data',
		`Scan a folder for regulated data literals (PII, PCI-DSS, PHI, credentials) embedded directly in source code.

Detects: SSN, credit cards (Luhn-validated), IBAN, BIC/SWIFT, passport numbers, dates of birth, email addresses, phone numbers, public IP addresses, PEM private keys, API keys/tokens, and database connection strings.

Each hit is redacted (last 4 chars visible) and tagged with applicable enterprise compliance frameworks loaded in the Checks engine.

Use to confirm compliance exposure, advise on applicable regulatory frameworks, or audit a codebase for embedded sensitive data before a security or compliance review.`,
		[
			{ name: 'folder_path', type: 'string', description: 'Absolute path to the folder to scan.', required: true },
		],
		async (args) => {
			const folderPath = args.folder_path as string;
			const result = await discoveryService.scan([_folder(folderPath)], []);
			const proj = result.sources[0];
			if (!proj) { return 'No data returned from scan.'; }

			const hits = proj.regulatedDataHits;
			if (hits.length === 0) {
				return `No regulated data literals found in ${proj.projectLabel}.`;
			}

			const grouped = new Map<string, typeof hits>();
			for (const h of hits) {
				const g = grouped.get(h.pattern) ?? [];
				g.push(h);
				grouped.set(h.pattern, g);
			}

			const lines: string[] = [`${hits.length} hit(s) across ${grouped.size} pattern type(s) in ${proj.projectLabel}:\n`];
			for (const [pattern, patHits] of grouped) {
				lines.push(`${pattern.toUpperCase()}  (${patHits.length})`);
				for (const h of patHits.slice(0, 6)) {
					const loc = h.fileUri.split('/').slice(-2).join('/');
					const fw = h.applicableFrameworks.length > 0 ? `  [${h.applicableFrameworks.join(', ')}]` : '';
					lines.push(`  ${loc}:${h.lineNumber}  ${h.redactedSample}  ${h.confidence}${fw}`);
				}
				if (patHits.length > 6) { lines.push(`  \u2026 ${patHits.length - 6} more`); }
				lines.push('');
			}

			return lines.join('\n');
		},
	);
}


// \u2500\u2500\u2500 tech_debt \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildTechDebtTool(discoveryService: IDiscoveryService): IChecksTool {
	return defineChecksTool(
		'tech_debt',
		`Find technical debt items in a folder, with a focus on security and compliance-relevant categories.

Detects: hardcoded credentials, god units, dead code, code clones, magic numbers, hardcoded URLs, deep nesting, missing error handling, TODO/FIXME markers, unbounded loops, implicit type coercions, GOTO usage, global state, and units with no test coverage.

Filter by category (e.g. "hardcoded-credential", "dead-code") or severity (error / warning / info).

Use when advising on security posture, SOC2 readiness, or code-quality compliance requirements.`,
		[
			{ name: 'folder_path', type: 'string', description: 'Absolute path to the folder to scan.', required: true },
			{ name: 'category', type: 'string', description: 'Optional. Filter by category (e.g. hardcoded-credential, dead-code, god-unit, todo-fixme).', required: false },
			{ name: 'severity', type: 'string', description: 'Optional. Filter by severity: error, warning, or info.', required: false },
		],
		async (args) => {
			const folderPath = args.folder_path as string;
			const catFilter  = (args.category as string | undefined)?.toLowerCase();
			const sevFilter  = (args.severity as string | undefined)?.toLowerCase();

			const result = await discoveryService.scan([_folder(folderPath)], []);
			const proj = result.sources[0];
			if (!proj) { return 'No data returned from scan.'; }

			let items = proj.techDebtItems;
			if (catFilter) { items = items.filter(i => i.category.toLowerCase().includes(catFilter)); }
			if (sevFilter) { items = items.filter(i => i.severity.toLowerCase() === sevFilter); }

			if (items.length === 0) {
				return `No tech debt items found${catFilter ? ` (category: ${catFilter})` : ''}${sevFilter ? ` (severity: ${sevFilter})` : ''} in ${proj.projectLabel}.`;
			}

			const grouped = new Map<string, typeof items>();
			for (const item of items) {
				const g = grouped.get(item.category) ?? [];
				g.push(item);
				grouped.set(item.category, g);
			}

			const lines: string[] = [`${items.length} item(s) in ${proj.projectLabel}:\n`];
			for (const [cat, catItems] of grouped) {
				lines.push(`${cat.toUpperCase().replace(/-/g, ' ')}  (${catItems.length})`);
				for (const i of catItems.slice(0, 5)) {
					const unitShort = i.unitId.split('/').pop() ?? i.unitId;
					const loc = i.lineNumber != null ? `:${i.lineNumber}` : '';
					lines.push(`  [${i.severity.toUpperCase()}] ${unitShort}${loc} \u2014 ${i.description}`);
				}
				if (catItems.length > 5) { lines.push(`  \u2026 ${catItems.length - 5} more`); }
				lines.push('');
			}

			return lines.join('\n');
		},
	);
}
