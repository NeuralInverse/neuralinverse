/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Modernisation tools for the Checks Agent.
 *
 * Gives the compliance-specialist Checks Agent the ability to pull migration
 * context on demand \u2014 without being locked into the Modernisation workflow
 * sequence. The model decides when this context is useful.
 *
 * Works on ANY project folder. No active Modernisation session required.
 *
 * Tools:
 *   modernisation_scan             \u2014 full project scan: units, GRC snapshot, regulated data
 *   modernisation_get_regulated_data \u2014 list PII / PCI / PHI literals in source
 *   modernisation_session          \u2014 current session state (if any)
 */

import { URI } from '../../../../../../base/common/uri.js';
import { IChecksTool } from '../checksAgentTypes.js';
import { defineChecksTool } from '../checksToolRegistry.js';
import { IDiscoveryService } from '../../../../neuralInverseModernisation/browser/engine/discovery/discoveryService.js';
import { IModernisationSessionService, IProjectTarget } from '../../../../neuralInverseModernisation/browser/modernisationSessionService.js';


// \u2500\u2500\u2500 Factory \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function buildModernisationChecksTools(
	discoveryService: IDiscoveryService,
	sessionService: IModernisationSessionService,
): IChecksTool[] {
	return [
		_buildScanTool(discoveryService),
		_buildRegulatedDataTool(discoveryService),
		_buildSessionTool(sessionService),
	];
}


// \u2500\u2500\u2500 Shared helper \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _toTarget(folderPath: string, role: IProjectTarget['role']): IProjectTarget {
	const uri = folderPath.includes('://') ? folderPath : URI.file(folderPath).toString();
	const label = folderPath.split(/[/\\]/).filter(Boolean).pop() ?? folderPath;
	return { id: uri, role, label, folderUri: uri };
}


// \u2500\u2500\u2500 modernisation_scan \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildScanTool(discoveryService: IDiscoveryService): IChecksTool {
	return defineChecksTool(
		'modernisation_scan',
		`Scan a project folder with the Modernisation discovery engine to get its compliance and structural posture.

Returns: migration unit count, dominant language, GRC risk level, GRC violation count, regulated-data hit count, API endpoint count, and critical unit count.

Works on ANY folder \u2014 no Modernisation session needed.

Use this when you need to understand the compliance risk profile of a codebase before advising on GRC requirements, or when asked about the regulated-data exposure of a project.`,
		[
			{ name: 'source_folder', type: 'string', description: 'Absolute path to the project folder to scan.', required: true },
		],
		async (args) => {
			const folderPath = args.source_folder as string;
			const result = await discoveryService.scan([_toTarget(folderPath, 'source')], []);
			const proj = result.sources[0];
			if (!proj) { return 'No project data returned from scan.'; }

			const lines: string[] = [`Scan result for ${proj.projectLabel} (${(result.totalElapsedMs / 1000).toFixed(1)}s):`];
			lines.push(`  Language:       ${proj.dominantLanguage}${proj.secondaryLanguage ? ', ' + proj.secondaryLanguage : ''}`);
			lines.push(`  Files:          ${proj.fileCount}`);
			lines.push(`  Units:          ${proj.units.length}`);
			lines.push(`  Critical units: ${proj.stats.criticalUnitCount}`);
			lines.push(`  Regulated data: ${proj.regulatedDataHits.length} hit(s)`);
			lines.push(`  GRC risk level: ${proj.grcSnapshot.blockingCount > 0 ? 'high' : proj.grcSnapshot.totalViolations > 0 ? 'medium' : 'low'}`);
			lines.push(`  GRC violations: ${proj.grcSnapshot.violations?.length ?? 0}`);
			lines.push(`  API endpoints:  ${proj.apiEndpoints.length}`);

			if (proj.grcSnapshot.violations && proj.grcSnapshot.violations.length > 0) {
				lines.push('\nTop GRC violations:');
				for (const v of proj.grcSnapshot.violations.slice(0, 6)) {
					lines.push(`  [${v.severity?.toUpperCase() ?? 'INFO'}] ${v.ruleId} \u2014 ${v.message}`);
				}
				if (proj.grcSnapshot.violations.length > 6) {
					lines.push(`  \u2026 and ${proj.grcSnapshot.violations.length - 6} more`);
				}
			}

			return lines.join('\n');
		},
	);
}


// \u2500\u2500\u2500 modernisation_get_regulated_data \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildRegulatedDataTool(discoveryService: IDiscoveryService): IChecksTool {
	return defineChecksTool(
		'modernisation_get_regulated_data',
		`Scan a project folder for regulated data literals (PII, PCI-DSS, PHI, credentials) embedded in source code.

Detects: SSN, credit cards (Luhn-validated), IBAN, BIC/SWIFT, passport numbers, dates of birth, email addresses, phone numbers, public IP addresses, PEM private keys, API keys/tokens, and database connection strings.

Each hit is redacted (last 4 chars visible) and tagged with the applicable enterprise compliance frameworks loaded in the Checks engine.

Use this when advising on GDPR/HIPAA/PCI-DSS compliance exposure, or to confirm whether a codebase contains data that must be handled under specific regulatory frameworks.`,
		[
			{ name: 'folder_path', type: 'string', description: 'Absolute path to the project folder to scan for regulated data.', required: true },
		],
		async (args) => {
			const folderPath = args.folder_path as string;
			const result = await discoveryService.scan([_toTarget(folderPath, 'source')], []);
			const proj = result.sources[0];
			if (!proj) { return 'No project data returned from scan.'; }

			const hits = proj.regulatedDataHits;
			if (hits.length === 0) {
				return `No regulated data literals found in ${proj.projectLabel}.`;
			}

			// Group by pattern
			const grouped = new Map<string, typeof hits>();
			for (const hit of hits) {
				const g = grouped.get(hit.pattern) ?? [];
				g.push(hit);
				grouped.set(hit.pattern, g);
			}

			const lines: string[] = [`${hits.length} regulated data hit(s) in ${proj.projectLabel}:\n`];
			for (const [pattern, patHits] of grouped) {
				lines.push(`  ${pattern.toUpperCase()} (${patHits.length})`);
				for (const h of patHits.slice(0, 5)) {
					const loc = h.fileUri.split('/').slice(-2).join('/');
					const fw = h.applicableFrameworks.length > 0 ? ` [${h.applicableFrameworks.join(', ')}]` : '';
					lines.push(`    ${loc}:${h.lineNumber}  ${h.redactedSample}  (${h.confidence})${fw}`);
				}
				if (patHits.length > 5) { lines.push(`    \u2026 and ${patHits.length - 5} more`); }
			}

			return lines.join('\n');
		},
	);
}


// \u2500\u2500\u2500 modernisation_session \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildSessionTool(sessionService: IModernisationSessionService): IChecksTool {
	return defineChecksTool(
		'modernisation_session',
		`Returns the current Modernisation session state, if one is active.

Shows: paired source/target projects, current workflow stage, migration pattern, whether the plan has been approved, and the active file pair.

Use this to understand the context of an in-progress migration when answering compliance questions about which codebases are involved, what stage they are at, and whether regulated data compliance reviews have been completed.`,
		[],
		async (_args) => {
			const session = sessionService.session;
			if (!session.isActive) {
				return 'No active Modernisation session.';
			}

			const lines: string[] = ['Active Modernisation Session:'];
			lines.push(`  Stage:         ${session.currentStage}`);
			lines.push(`  Pattern:       ${session.migrationPattern ?? 'not set'}`);
			lines.push(`  Plan approved: ${session.planApproved ? 'yes' : 'no'}`);
			lines.push(`\n  Sources (${session.sources.length}):`);
			for (const s of session.sources) { lines.push(`    ${s.label}: ${s.folderUri}`); }
			lines.push(`  Targets (${session.targets.length}):`);
			for (const t of session.targets) { lines.push(`    ${t.label}: ${t.folderUri}`); }
			if (session.activeSourceFileUri) { lines.push(`\n  Active source file: ${session.activeSourceFileUri}`); }
			if (session.activeTargetFileUri) { lines.push(`  Active target file: ${session.activeTargetFileUri}`); }

			return lines.join('\n');
		},
	);
}
