/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Modernisation tools for Power Mode agents.
 *
 * Exposes the Modernisation engine (discovery, planning, regulated-data scanning,
 * and session state) as callable tools so the model can decide when and how
 * to use migration context \u2014 rather than following a fixed workflow sequence.
 *
 * All tools accept folder paths directly and work on ANY project folder.
 * No active Modernisation session is required.
 *
 * Tools:
 *   modernisation_scan             \u2014 full codebase scan (units, deps, GRC, regulated data)
 *   modernisation_get_units        \u2014 list migration units from a folder with risk / complexity
 *   modernisation_get_regulated_data \u2014 list PII / PCI / PHI literals found in source
 *   modernisation_generate_plan    \u2014 scan + AI roadmap generation in one call
 *   modernisation_session          \u2014 current session state (if any)
 *   get_sector_profile             \u2014 full compliance profile for the active or named sector
 */

import { URI } from '../../../../../base/common/uri.js';
import { IPowerTool, IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import { IDiscoveryService } from '../../../neuralInverseModernisation/browser/engine/discovery/discoveryService.js';
import { IMigrationPlannerService } from '../../../neuralInverseModernisation/browser/engine/migrationPlannerService.js';
import { IModernisationSessionService, IProjectTarget } from '../../../neuralInverseModernisation/browser/modernisationSessionService.js';
import { getSectorLabel, getSectorProfile, getAllSectorProfiles, getSectorProfileById, SectorId } from '../../../neuralInverseModernisation/browser/engine/sectorRegistry.js';
import { definePowerTool } from './powerToolRegistry.js';


// \u2500\u2500\u2500 Factory \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function buildModernisationPowerTools(
	discoveryService: IDiscoveryService,
	plannerService: IMigrationPlannerService,
	sessionService: IModernisationSessionService,
): IPowerTool[] {
	return [
		_buildScanTool(discoveryService),
		_buildGetUnitsTool(discoveryService),
		_buildRegulatedDataTool(discoveryService),
		_buildGeneratePlanTool(discoveryService, plannerService),
		_buildSessionTool(sessionService),
		_buildSectorProfileTool(sessionService),
	];
}


// \u2500\u2500\u2500 Shared helper \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _toTarget(folderPath: string, role: IProjectTarget['role']): IProjectTarget {
	const uri = folderPath.includes('://') ? folderPath : URI.file(folderPath).toString();
	const label = folderPath.split(/[/\\]/).filter(Boolean).pop() ?? folderPath;
	return { id: uri, role, label, folderUri: uri };
}


// \u2500\u2500\u2500 modernisation_scan \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildScanTool(discoveryService: IDiscoveryService): IPowerTool {
	return definePowerTool(
		'modernisation_scan',
		`Scan a project folder with the Modernisation discovery engine.

Returns migration unit count, language distribution, complexity stats, regulated-data hit count, GRC risk level, build system, and API endpoint count.

Works on ANY folder \u2014 no Modernisation session needed. Optionally provide a target folder to scan both sides together (e.g. before planning a migration).

Use this before refactoring, migrating, or assessing a codebase you are unfamiliar with.`,
		[
			{ name: 'source_folder', type: 'string', description: 'Absolute path to the source / legacy project folder to scan.', required: true },
			{ name: 'target_folder', type: 'string', description: 'Optional. Absolute path to the target / modern project folder to scan alongside the source.', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const srcPath = args.source_folder as string;
			const tgtPath  = args.target_folder as string | undefined;
			ctx.metadata({ title: `Scanning ${srcPath.split(/[/\\]/).pop()}` });

			const result = await discoveryService.scan(
				[_toTarget(srcPath, 'source')],
				tgtPath ? [_toTarget(tgtPath, 'target')] : [],
			);

			const allProjects = [...result.sources, ...result.targets];
			const lines: string[] = [];

			for (const proj of allProjects) {
				const role = result.sources.includes(proj) ? 'SOURCE' : 'TARGET';
				lines.push(`\n[${role}] ${proj.projectLabel}`);
				lines.push(`  Language:       ${proj.dominantLanguage}${proj.secondaryLanguage ? ', ' + proj.secondaryLanguage : ''}`);
				lines.push(`  Files:          ${proj.fileCount}`);
				lines.push(`  Units:          ${proj.units.length}`);
				lines.push(`  Critical units: ${proj.stats.criticalUnitCount}`);
				lines.push(`  Dead code:      ${proj.stats.deadCodeUnitCount}`);
				lines.push(`  Avg complexity: ${proj.stats.avgUnitComplexity.toFixed(1)}`);
				lines.push(`  API endpoints:  ${proj.apiEndpoints.length}`);
				lines.push(`  Regulated data: ${proj.regulatedDataHits.length} hit(s)`);
				lines.push(`  GRC risk:       ${proj.grcSnapshot.blockingCount > 0 ? 'high' : proj.grcSnapshot.totalViolations > 0 ? 'medium' : 'low'}`);
				lines.push(`  GRC violations: ${proj.grcSnapshot.violations?.length ?? 0}`);
				if (proj.metadata.buildSystem) {
					lines.push(`  Build system:   ${proj.metadata.buildSystem}`);
				}
				const topLangs = Object.entries(proj.stats.languageDistribution)
					.sort(([, a], [, b]) => b - a).slice(0, 4)
					.map(([l, n]) => `${l}:${n}`).join(', ');
				if (topLangs) { lines.push(`  Lang dist:      ${topLangs}`); }
			}

			const totalUnits = allProjects.reduce((n, p) => n + p.units.length, 0);
			const summary = `Scanned ${allProjects.length} project(s) in ${(result.totalElapsedMs / 1000).toFixed(1)}s \u2014 ${totalUnits} migration units total.`;

			return {
				title: 'Modernisation Scan',
				output: summary + lines.join('\n'),
				metadata: { totalUnits, projects: allProjects.length, elapsedMs: result.totalElapsedMs },
			};
		},
	);
}


// \u2500\u2500\u2500 modernisation_get_units \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildGetUnitsTool(discoveryService: IDiscoveryService): IPowerTool {
	return definePowerTool(
		'modernisation_get_units',
		`List migration units extracted from a project folder.

Each unit is a logical code block: a COBOL paragraph/section, Java class, Python module, SQL procedure, TypeScript function, etc.

Filter by risk_level (critical / high / medium / low) to focus on what matters most. Use this to understand what needs to be migrated and in what dependency order before writing code.`,
		[
			{ name: 'folder_path', type: 'string', description: 'Absolute path to the project folder to scan.', required: true },
			{ name: 'risk_level', type: 'string', description: 'Optional. Filter by risk level: critical, high, medium, or low.', required: false },
			{ name: 'limit', type: 'number', description: 'Optional. Maximum units to return (default 40).', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const folderPath = args.folder_path as string;
			const riskFilter = (args.risk_level as string | undefined)?.toLowerCase();
			const limit = typeof args.limit === 'number' ? args.limit : 40;
			ctx.metadata({ title: `Getting units from ${folderPath.split(/[/\\]/).pop()}` });

			const result = await discoveryService.scan([_toTarget(folderPath, 'source')], []);
			const proj = result.sources[0];
			if (!proj) {
				return { title: 'Migration Units', output: 'No project data returned.', metadata: {} };
			}

			let units = proj.units;
			if (riskFilter) {
				units = units.filter(u => u.riskLevel?.toLowerCase() === riskFilter);
			}
			const total = units.length;
			units = units.slice(0, limit);

			if (units.length === 0) {
				return {
					title: 'Migration Units',
					output: `No units found${riskFilter ? ` with risk "${riskFilter}"` : ''}.`,
					metadata: {},
				};
			}

			const lines = units.map(u => {
				const loc = u.legacyFilePath.split('/').slice(-2).join('/');
				const line = u.legacyRange?.startLine ?? '?';
				const deps = u.dependencies.length > 0 ? ` | deps: ${u.dependencies.length}` : '';
				return `  [${(u.riskLevel ?? 'unknown').toUpperCase()}] ${u.unitName} (${u.unitType})\n    ${loc}:${line}${deps}`;
			});

			const header = `${total} unit(s) in ${proj.projectLabel}${riskFilter ? ` (risk: ${riskFilter})` : ''}, showing ${units.length}:`;
			return {
				title: 'Migration Units',
				output: header + '\n\n' + lines.join('\n\n'),
				metadata: { total, shown: units.length },
			};
		},
	);
}


// \u2500\u2500\u2500 modernisation_get_regulated_data \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildRegulatedDataTool(discoveryService: IDiscoveryService): IPowerTool {
	return definePowerTool(
		'modernisation_get_regulated_data',
		`Scan a project folder for regulated data literals embedded directly in source code.

Detects: SSN, credit cards (Luhn-validated), IBAN, BIC/SWIFT, passport numbers, dates of birth, email addresses, phone numbers, IP addresses, PEM private keys, API keys/tokens, and database connection strings.

Each hit is redacted (last 4 chars visible) and tagged with the applicable enterprise compliance frameworks currently loaded in the Checks engine.

Use this before migrating, refactoring, or reviewing any code that may touch sensitive or regulated data.`,
		[
			{ name: 'folder_path', type: 'string', description: 'Absolute path to the project folder to scan for regulated data.', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const folderPath = args.folder_path as string;
			ctx.metadata({ title: `Scanning regulated data in ${folderPath.split(/[/\\]/).pop()}` });

			const result = await discoveryService.scan([_toTarget(folderPath, 'source')], []);
			const proj = result.sources[0];
			if (!proj) {
				return { title: 'Regulated Data', output: 'No project data returned.', metadata: {} };
			}

			const hits = proj.regulatedDataHits;
			if (hits.length === 0) {
				return { title: 'Regulated Data', output: 'No regulated data literals found in source.', metadata: { count: 0 } };
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

			return {
				title: 'Regulated Data Scan',
				output: lines.join('\n'),
				metadata: { total: hits.length, patterns: grouped.size },
			};
		},
	);
}


// \u2500\u2500\u2500 modernisation_generate_plan \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildGeneratePlanTool(
	discoveryService: IDiscoveryService,
	plannerService: IMigrationPlannerService,
): IPowerTool {
	return definePowerTool(
		'modernisation_generate_plan',
		`Run a discovery scan and then generate an AI-refined migration roadmap.

Returns: migration phases with effort estimates, critical path units (zero-slack), blockers, compliance notes, and an overall risk narrative.

Specify migration_pattern to guide the AI planner (e.g. "cobol-to-java", "monolith-to-microservices", "oracle-to-postgresql"). Works on any project folder \u2014 no active session required.

Use this to get a concrete, sequenced migration plan before starting implementation work.`,
		[
			{ name: 'source_folder', type: 'string', description: 'Absolute path to the source / legacy project folder.', required: true },
			{ name: 'target_folder', type: 'string', description: 'Optional. Absolute path to the target / modern project folder.', required: false },
			{ name: 'migration_pattern', type: 'string', description: 'Optional. Pattern description e.g. "cobol-to-java", "monolith-to-microservices". Defaults to "custom".', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const srcPath = args.source_folder as string;
			const tgtPath  = args.target_folder as string | undefined;
			const pattern  = (args.migration_pattern as string | undefined) ?? 'custom';
			ctx.metadata({ title: `Generating migration plan \u2014 ${pattern}` });

			const discovery = await discoveryService.scan(
				[_toTarget(srcPath, 'source')],
				tgtPath ? [_toTarget(tgtPath, 'target')] : [],
			);

			const roadmap = await plannerService.generateRoadmap(discovery, pattern, `tool-${Date.now()}`);

			const lines: string[] = [];
			lines.push(`Migration Plan \u2014 ${pattern}`);
			lines.push(`  Method:        ${roadmap.generationMethod}`);
			lines.push(`  Total units:   ${roadmap.totalUnits}`);
			lines.push(`  Phases:        ${roadmap.phases?.length ?? 0}`);
			lines.push(`  Critical path: ${roadmap.criticalPath?.length ?? 0} units`);
			const blockingCount = roadmap.migrationBlockers?.filter(b => b.severity === 'blocking').length ?? 0;
			lines.push(`  Blockers:      ${blockingCount} blocking, ${(roadmap.migrationBlockers?.length ?? 0) - blockingCount} warnings`);
			lines.push(`  Effort est.:   ${roadmap.estimatedHoursLow ?? '?'}\u2013${roadmap.estimatedHoursHigh ?? '?'}h`);
			if (roadmap.aiEstimatedEffort) { lines.push(`  AI effort band: ${roadmap.aiEstimatedEffort}`); }

			if (roadmap.phases && roadmap.phases.length > 0) {
				lines.push('\nPhases:');
				for (const ph of roadmap.phases) {
					const gates: string[] = [];
					if (ph.hasComplianceGate) { gates.push('compliance-gate'); }
					if (ph.hasAPICompatibilityGate) { gates.push('api-gate'); }
					const gateStr = gates.length > 0 ? ` [${gates.join(', ')}]` : '';
					lines.push(`  P${ph.index} ${ph.label} \u2014 ${ph.unitIds.length} units, ${ph.estimatedHoursLow}\u2013${ph.estimatedHoursHigh}h${gateStr}`);
				}
			}

			const blocking = roadmap.migrationBlockers?.filter(b => b.severity === 'blocking') ?? [];
			if (blocking.length > 0) {
				lines.push(`\nBlocking issues (${blocking.length}):`);
				for (const b of blocking) {
					lines.push(`  [${b.blockerType}] ${b.title}`);
					lines.push(`    \u2192 ${b.recommendedAction}`);
				}
			}

			if (roadmap.riskNarrative) {
				lines.push(`\nRisk: ${roadmap.riskNarrative}`);
			}
			if (roadmap.complianceNotes) {
				lines.push(`\nCompliance: ${roadmap.complianceNotes}`);
			}

			return {
				title: 'Migration Plan',
				output: lines.join('\n'),
				metadata: {
					totalUnits: roadmap.totalUnits,
					phases: roadmap.phases?.length ?? 0,
					blockers: roadmap.migrationBlockers?.length ?? 0,
					method: roadmap.generationMethod,
				},
			};
		},
	);
}


// \u2500\u2500\u2500 modernisation_session \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildSessionTool(sessionService: IModernisationSessionService): IPowerTool {
	return definePowerTool(
		'modernisation_session',
		`Returns the current Modernisation session state, if one is active.

Shows: paired source/target projects, current workflow stage, migration pattern, whether the AI plan has been approved, and the active file pair under analysis.

Use this to orient yourself when working inside an active migration project \u2014 it tells you where in the workflow things are and which files are currently under review.`,
		[],
		async (_args: Record<string, any>, _ctx: IToolContext): Promise<IToolResult> => {
			const session = sessionService.session;
			if (!session.isActive) {
				return { title: 'Modernisation Session', output: 'No active Modernisation session.', metadata: { active: false } };
			}

			// Sector detection from migration pattern
			const patternId = session.migrationPattern ?? '';
			const sector = getSectorLabel(patternId);

			const lines: string[] = ['Active Modernisation Session:'];
			lines.push(`  Stage:         ${session.currentStage}`);
			lines.push(`  Pattern:       ${session.migrationPattern ?? 'not set'}`);
			lines.push(`  Sector:        ${sector}`);
			lines.push(`  Plan approved: ${session.planApproved ? 'yes' : 'no'}`);
			lines.push(`\n  Sources (${session.sources.length}):`);
			for (const s of session.sources) { lines.push(`    ${s.label}: ${s.folderUri}`); }
			lines.push(`  Targets (${session.targets.length}):`);
			for (const t of session.targets) { lines.push(`    ${t.label}: ${t.folderUri}`); }
			if (session.activeSourceFileUri) { lines.push(`\n  Active source file: ${session.activeSourceFileUri}`); }
			if (session.activeTargetFileUri) { lines.push(`  Active target file: ${session.activeTargetFileUri}`); }
			lines.push(`\n  Call get_progress for KB unit counts, get_pending_decisions for blocking decisions.`);
			lines.push(`  Call get_sector_profile to see full compliance obligations, required gates, and blocking debt categories for this sector.`);

			return {
				title: 'Modernisation Session',
				output: lines.join('\n'),
				metadata: { active: true, stage: session.currentStage, sector },
			};
		},
	);
}


// \u2500\u2500\u2500 get_sector_profile \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildSectorProfileTool(sessionService: IModernisationSessionService): IPowerTool {
	return definePowerTool(
		'get_sector_profile',
		`Returns the full compliance profile for a regulated industry sector.

Includes: primary standards/frameworks, required compliance gate IDs, blocking tech-debt categories, mandatory migration blocker types, primary language-pair profiles, sensitive data patterns to watch for, and the verbatim AI guidance text injected into system prompts for this sector.

If no sector_id is provided, detects the sector automatically from the active Modernisation session's migration pattern.

Available sectors: firmware, automotive, energy, telecom, iiot`,
		[
			{ name: 'sector_id', type: 'string', description: 'Optional. One of: firmware, automotive, energy, telecom, iiot. Defaults to the active session sector.', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const sectorIdArg = args.sector_id as string | undefined;
			ctx.metadata({ title: `Sector profile: ${sectorIdArg ?? 'auto-detect'}` });

			let profile = sectorIdArg
				? getSectorProfileById(sectorIdArg as SectorId)
				: getSectorProfile(sessionService.session?.migrationPattern ?? '');

			if (!profile && !sectorIdArg) {
				// No active session sector \u2014 list all available profiles
				const all = getAllSectorProfiles();
				const lines = ['No active session sector detected. Available sector profiles:'];
				for (const p of all) {
					lines.push(`  ${p.id}  \u2014  ${p.label}`);
					lines.push(`    Standards: ${p.primaryStandards.slice(0, 3).join(', ')}${p.primaryStandards.length > 3 ? ' \u2026' : ''}`);
				}
				lines.push('');
				lines.push('Pass sector_id to retrieve a specific profile.');
				return { title: 'Sector Profiles', output: lines.join('\n'), metadata: { count: all.length } };
			}

			if (!profile) {
				return { title: 'Sector Profile', output: `Unknown sector_id "${sectorIdArg}". Valid values: firmware, automotive, energy, telecom, iiot.`, metadata: {} };
			}

			const lines: string[] = [`Sector Profile \u2014 ${profile.label} (${profile.id})`];
			lines.push('');
			lines.push('Primary Standards:');
			for (const s of profile.primaryStandards) { lines.push(`  \u2022 ${s}`); }
			lines.push('');
			lines.push('Required Compliance Gates (must pass before unit approval):');
			for (const g of profile.requiredGateIds) { lines.push(`  \u2022 ${g}`); }
			lines.push('');
			lines.push('Blocking Tech-Debt Categories (hard blockers \u2014 unit must be refactored before translation):');
			for (const c of profile.blockingDebtCategories) { lines.push(`  \u2022 ${c}`); }
			lines.push('');
			lines.push('Mandatory Migration Blocker Types:');
			for (const b of profile.mandatoryBlockerTypes) { lines.push(`  \u2022 ${b}`); }
			lines.push('');
			lines.push('Primary Language Pairs:');
			for (const lp of profile.primaryLanguagePairs) { lines.push(`  \u2022 ${lp.sourceLang} \u2192 ${lp.targetLang}`); }
			lines.push('');
			lines.push('Sensitive Data Patterns (trigger extra scrutiny during scan):');
			for (const p2 of profile.sensitiveDataPatterns) { lines.push(`  \u2022 ${p2}`); }
			lines.push('');
			lines.push('AI Guidance (injected into system prompts for this sector):');
			lines.push(profile.aiGuidance);

			return {
				title: `Sector Profile \u2014 ${profile.label}`,
				output: lines.join('\n'),
				metadata: { sectorId: profile.id, sectorLabel: profile.label, gateCount: profile.requiredGateIds.length },
			};
		},
	);
}
