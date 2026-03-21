/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Standalone codebase discovery tools for Power Mode agents.
 *
 * These tools expose the discovery engine's analytical capabilities as
 * general-purpose key-findings tools — independent of any migration workflow.
 * The model calls them whenever it needs structural or compliance insight
 * about a codebase, regardless of whether a Modernisation session is active.
 *
 * Tools:
 *   codebase_scan        — structural overview: languages, units, complexity, build system, GRC risk
 *   find_regulated_data  — PII / PCI-DSS / PHI / credential literals in source
 *   code_units           — list code units (classes, paragraphs, functions) with risk / complexity
 *   tech_debt            — technical debt findings (dead code, clones, god units, credentials, etc.)
 *   api_surface          — externally accessible entry points (REST, SOAP, gRPC, CICS, MQ, etc.)
 *   data_schemas         — data structures, tables, entities and their regulated fields
 */

import { URI } from '../../../../../base/common/uri.js';
import { IPowerTool, IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import { IDiscoveryService } from '../../../neuralInverseModernisation/browser/engine/discovery/discoveryService.js';
import { IProjectTarget } from '../../../neuralInverseModernisation/browser/modernisationSessionService.js';
import { definePowerTool } from './powerToolRegistry.js';


// ─── Factory ──────────────────────────────────────────────────────────────────

export function buildDiscoveryTools(discoveryService: IDiscoveryService): IPowerTool[] {
	return [
		_buildCodebaseScanTool(discoveryService),
		_buildFindRegulatedDataTool(discoveryService),
		_buildCodeUnitsTool(discoveryService),
		_buildTechDebtTool(discoveryService),
		_buildAPISurfaceTool(discoveryService),
		_buildDataSchemasTool(discoveryService),
	];
}


// ─── Shared helper ────────────────────────────────────────────────────────────

function _folder(folderPath: string): IProjectTarget {
	const uri = folderPath.includes('://') ? folderPath : URI.file(folderPath).toString();
	const label = folderPath.split(/[/\\]/).filter(Boolean).pop() ?? folderPath;
	return { id: uri, role: 'source', label, folderUri: uri };
}


// ─── codebase_scan ────────────────────────────────────────────────────────────

function _buildCodebaseScanTool(discoveryService: IDiscoveryService): IPowerTool {
	return definePowerTool(
		'codebase_scan',
		`Scan a folder for key structural and compliance findings.

Returns:
- Language(s) detected, file count, unit count (classes / paragraphs / functions / procedures)
- Complexity stats: average cyclomatic complexity, largest file, most complex unit
- Build system, detected frameworks, CI pipeline, test frameworks
- Critical and dead-code unit counts
- GRC overall risk level and violation count
- Regulated data hit count (PII / PCI / PHI literals in source)
- External API endpoint count
- Technical debt item count

Use this as a first step when exploring an unfamiliar codebase, before refactoring, or to get a quick health overview before a code review.`,
		[
			{ name: 'folder_path', type: 'string', description: 'Absolute path to the folder to scan.', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const folderPath = args.folder_path as string;
			ctx.metadata({ title: `Scanning ${folderPath.split(/[/\\]/).pop()}` });

			const result = await discoveryService.scan([_folder(folderPath)], []);
			const proj = result.sources[0];
			if (!proj) {
				return { title: 'Codebase Scan', output: 'No data returned from scan.', metadata: {} };
			}

			const s = proj.stats;
			const meta = proj.metadata;

			const lines: string[] = [`Codebase scan — ${proj.projectLabel} (${(result.totalElapsedMs / 1000).toFixed(1)}s)\n`];

			// Language
			const langs = [proj.dominantLanguage, proj.secondaryLanguage].filter(Boolean).join(', ');
			lines.push(`Language:        ${langs}`);
			const topDist = Object.entries(s.languageDistribution).sort(([, a], [, b]) => b - a).slice(0, 5)
				.map(([l, n]) => `${l}(${n})`).join('  ');
			if (topDist) { lines.push(`Lang breakdown:  ${topDist}`); }

			// Size
			lines.push(`Files:           ${proj.fileCount}`);
			lines.push(`Units:           ${proj.units.length}`);
			lines.push(`Avg complexity:  ${s.avgUnitComplexity.toFixed(1)}`);
			lines.push(`Largest file:    ${s.largestFileUri.split('/').pop() ?? '?'} (${s.largestFileLines} lines)`);
			if (s.mostComplexUnitId) {
				lines.push(`Most complex:    ${s.mostComplexUnitId.split('/').pop() ?? s.mostComplexUnitId} (CC ${s.mostComplexUnitCC})`);
			}
			lines.push(`Critical units:  ${s.criticalUnitCount}`);
			lines.push(`Dead code units: ${s.deadCodeUnitCount}`);

			// Risk distribution
			const rd = s.riskDistribution;
			lines.push(`Risk dist:       critical:${rd.critical}  high:${rd.high}  medium:${rd.medium}  low:${rd.low}`);

			// Infrastructure
			if (meta.buildSystem)      { lines.push(`Build system:    ${meta.buildSystem}`); }
			if (meta.detectedFrameworks?.length) { lines.push(`Frameworks:      ${meta.detectedFrameworks.join(', ')}`); }
			if (meta.testFrameworks?.length) { lines.push(`Test frameworks: ${meta.testFrameworks.join(', ')}`); }
			if (meta.runtimeVersion)   { lines.push(`Runtime version: ${meta.runtimeVersion}`); }
			const infra: string[] = [];
			if (meta.hasCI) { infra.push('CI'); }
			if (meta.hasDockerfile) { infra.push('Docker'); }
			if (meta.hasTests) { infra.push('tests'); }
			if (meta.hasGitIgnore) { infra.push('.gitignore'); }
			if (infra.length) { lines.push(`Infrastructure:  ${infra.join(', ')}`); }

			// Key findings
			lines.push('');
			const grcRisk = proj.grcSnapshot.blockingCount > 0 ? 'high' : proj.grcSnapshot.totalViolations > 0 ? 'medium' : 'low';
			lines.push(`GRC risk level:  ${grcRisk}`);
			lines.push(`GRC violations:  ${proj.grcSnapshot.violations?.length ?? 0}`);
			lines.push(`Regulated data:  ${proj.regulatedDataHits.length} hit(s)`);
			lines.push(`API endpoints:   ${proj.apiEndpoints.length}`);
			lines.push(`Tech debt items: ${proj.techDebtItems.length}`);
			lines.push(`Data schemas:    ${proj.dataSchemas.length}`);
			lines.push(`Ext. deps:       ${proj.externalDependencies.length}`);

			return {
				title: 'Codebase Scan',
				output: lines.join('\n'),
				metadata: {
					units: proj.units.length,
					files: proj.fileCount,
					grcRisk,
					regulatedHits: proj.regulatedDataHits.length,
				},
			};
		},
	);
}


// ─── find_regulated_data ──────────────────────────────────────────────────────

function _buildFindRegulatedDataTool(discoveryService: IDiscoveryService): IPowerTool {
	return definePowerTool(
		'find_regulated_data',
		`Scan a folder for regulated data literals (PII, PCI-DSS, PHI, credentials) embedded directly in source code.

Detects:
- SSN (US), credit cards (Luhn-validated), IBAN, BIC/SWIFT
- Passport numbers, dates of birth
- Email addresses, phone numbers, public IP addresses
- PEM private keys, API keys/tokens, database connection strings

Each hit is redacted (last 4 chars visible) and tagged with applicable enterprise compliance frameworks loaded in the Checks engine.

Use before modifying any code that handles sensitive data, before a security review, or to audit a codebase for compliance exposure.`,
		[
			{ name: 'folder_path', type: 'string', description: 'Absolute path to the folder to scan.', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const folderPath = args.folder_path as string;
			ctx.metadata({ title: `Finding regulated data in ${folderPath.split(/[/\\]/).pop()}` });

			const result = await discoveryService.scan([_folder(folderPath)], []);
			const proj = result.sources[0];
			if (!proj) {
				return { title: 'Regulated Data', output: 'No data returned from scan.', metadata: {} };
			}

			const hits = proj.regulatedDataHits;
			if (hits.length === 0) {
				return { title: 'Regulated Data', output: `No regulated data literals found in ${proj.projectLabel}.`, metadata: { count: 0 } };
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
				if (patHits.length > 6) { lines.push(`  … ${patHits.length - 6} more`); }
				lines.push('');
			}

			return {
				title: 'Regulated Data',
				output: lines.join('\n'),
				metadata: { total: hits.length, patternTypes: grouped.size },
			};
		},
	);
}


// ─── code_units ───────────────────────────────────────────────────────────────

function _buildCodeUnitsTool(discoveryService: IDiscoveryService): IPowerTool {
	return definePowerTool(
		'code_units',
		`List the code units in a folder: COBOL paragraphs/sections, Java/Kotlin/Scala classes, Python modules, SQL procedures, TypeScript functions, RPG subroutines, etc.

Each unit shows its type, risk level, dependency count, and location.

Filter by:
- risk_level (critical / high / medium / low) — focus on what matters most
- unit_type — e.g. "class", "function", "paragraph", "procedure"

Use this to understand what a codebase is made of before writing code that touches multiple units, or to identify the highest-risk components to address first.`,
		[
			{ name: 'folder_path', type: 'string', description: 'Absolute path to the folder to scan.', required: true },
			{ name: 'risk_level', type: 'string', description: 'Optional. Filter by risk level: critical, high, medium, or low.', required: false },
			{ name: 'unit_type', type: 'string', description: 'Optional. Filter by unit type substring (e.g. "class", "function", "paragraph").', required: false },
			{ name: 'limit', type: 'number', description: 'Optional. Maximum units to return (default 50).', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const folderPath  = args.folder_path as string;
			const riskFilter  = (args.risk_level as string | undefined)?.toLowerCase();
			const typeFilter  = (args.unit_type as string | undefined)?.toLowerCase();
			const limit       = typeof args.limit === 'number' ? args.limit : 50;
			ctx.metadata({ title: `Code units — ${folderPath.split(/[/\\]/).pop()}` });

			const result = await discoveryService.scan([_folder(folderPath)], []);
			const proj = result.sources[0];
			if (!proj) {
				return { title: 'Code Units', output: 'No data returned.', metadata: {} };
			}

			let units = proj.units;
			if (riskFilter) { units = units.filter(u => u.riskLevel?.toLowerCase() === riskFilter); }
			if (typeFilter) { units = units.filter(u => u.unitType?.toLowerCase().includes(typeFilter)); }
			const total = units.length;
			units = units.slice(0, limit);

			if (units.length === 0) {
				return { title: 'Code Units', output: `No units found${riskFilter ? ` (risk: ${riskFilter})` : ''}${typeFilter ? ` (type: ${typeFilter})` : ''}.`, metadata: {} };
			}

			const lines = units.map(u => {
				const loc = u.legacyFilePath.split('/').slice(-2).join('/');
				const line = u.legacyRange?.startLine ?? '?';
				const deps = u.dependencies.length > 0 ? `  deps:${u.dependencies.length}` : '';
				return `[${(u.riskLevel ?? '?').toUpperCase()}] ${u.unitName}  (${u.unitType})\n  ${loc}:${line}${deps}`;
			});

			const header = `${total} unit(s) in ${proj.projectLabel}${riskFilter ? ` — risk: ${riskFilter}` : ''}${typeFilter ? ` — type: ${typeFilter}` : ''}, showing ${units.length}:`;
			return {
				title: 'Code Units',
				output: header + '\n\n' + lines.join('\n\n'),
				metadata: { total, shown: units.length },
			};
		},
	);
}


// ─── tech_debt ────────────────────────────────────────────────────────────────

function _buildTechDebtTool(discoveryService: IDiscoveryService): IPowerTool {
	return definePowerTool(
		'tech_debt',
		`Find technical debt items in a folder.

Detects: god units (too large/complex), dead code, code clones, magic numbers, hardcoded credentials, hardcoded URLs, deep nesting, long parameter lists, missing error handling, commented-out code, TODO/FIXME markers, implicit type coercions, unbounded loops, GOTO usage, global mutable state, and units with no test coverage.

Filter by category to focus on specific debt types (e.g. "dead-code", "hardcoded-credential", "god-unit").

Use this before a refactoring sprint, security review, or to understand the maintenance burden of a codebase.`,
		[
			{ name: 'folder_path', type: 'string', description: 'Absolute path to the folder to scan.', required: true },
			{ name: 'category', type: 'string', description: 'Optional. Filter by debt category (e.g. dead-code, hardcoded-credential, god-unit, code-clone, todo-fixme).', required: false },
			{ name: 'severity', type: 'string', description: 'Optional. Filter by severity: error, warning, or info.', required: false },
			{ name: 'limit', type: 'number', description: 'Optional. Maximum items to return (default 40).', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const folderPath     = args.folder_path as string;
			const catFilter      = (args.category as string | undefined)?.toLowerCase();
			const sevFilter      = (args.severity as string | undefined)?.toLowerCase();
			const limit          = typeof args.limit === 'number' ? args.limit : 40;
			ctx.metadata({ title: `Tech debt — ${folderPath.split(/[/\\]/).pop()}` });

			const result = await discoveryService.scan([_folder(folderPath)], []);
			const proj = result.sources[0];
			if (!proj) {
				return { title: 'Tech Debt', output: 'No data returned.', metadata: {} };
			}

			let items = proj.techDebtItems;
			if (catFilter) { items = items.filter(i => i.category.toLowerCase().includes(catFilter)); }
			if (sevFilter) { items = items.filter(i => i.severity.toLowerCase() === sevFilter); }
			const total = items.length;
			items = items.slice(0, limit);

			if (items.length === 0) {
				return { title: 'Tech Debt', output: `No tech debt items found${catFilter ? ` (category: ${catFilter})` : ''}${sevFilter ? ` (severity: ${sevFilter})` : ''}.`, metadata: { total: 0 } };
			}

			// Group by category for readability
			const grouped = new Map<string, typeof items>();
			for (const item of items) {
				const g = grouped.get(item.category) ?? [];
				g.push(item);
				grouped.set(item.category, g);
			}

			const lines: string[] = [`${total} tech debt item(s) in ${proj.projectLabel}, showing ${items.length}:\n`];
			for (const [cat, catItems] of grouped) {
				lines.push(`${cat.toUpperCase().replace(/-/g, ' ')}  (${catItems.length})`);
				for (const i of catItems) {
					const loc = i.lineNumber != null ? `:${i.lineNumber}` : '';
					const unitShort = i.unitId.split('/').pop() ?? i.unitId;
					lines.push(`  [${i.severity.toUpperCase()}] ${unitShort}${loc} — ${i.description}`);
					if (i.migrationImpact) {
						lines.push(`    Impact: ${i.migrationImpact}`);
					}
				}
				lines.push('');
			}

			return {
				title: 'Tech Debt',
				output: lines.join('\n'),
				metadata: { total, shown: items.length },
			};
		},
	);
}


// ─── api_surface ──────────────────────────────────────────────────────────────

function _buildAPISurfaceTool(discoveryService: IDiscoveryService): IPowerTool {
	return definePowerTool(
		'api_surface',
		`List the externally accessible entry points of a project.

Detects: REST endpoints (GET/POST/PUT/PATCH/DELETE), SOAP operations, gRPC methods, CICS transactions, JCL procedures, MQ listeners, batch entry points, stored procedures, GraphQL resolvers, WebSocket handlers, and event handlers.

Use before writing integration code, API changes, or security reviews to understand what is exposed and how.`,
		[
			{ name: 'folder_path', type: 'string', description: 'Absolute path to the folder to scan.', required: true },
			{ name: 'kind', type: 'string', description: 'Optional. Filter by endpoint kind substring (e.g. "rest", "cics", "grpc", "soap").', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const folderPath = args.folder_path as string;
			const kindFilter = (args.kind as string | undefined)?.toLowerCase();
			ctx.metadata({ title: `API surface — ${folderPath.split(/[/\\]/).pop()}` });

			const result = await discoveryService.scan([_folder(folderPath)], []);
			const proj = result.sources[0];
			if (!proj) {
				return { title: 'API Surface', output: 'No data returned.', metadata: {} };
			}

			let endpoints = proj.apiEndpoints;
			if (kindFilter) { endpoints = endpoints.filter(e => e.kind.toLowerCase().includes(kindFilter)); }

			if (endpoints.length === 0) {
				return { title: 'API Surface', output: `No API entry points found${kindFilter ? ` (kind: ${kindFilter})` : ''} in ${proj.projectLabel}.`, metadata: { count: 0 } };
			}

			const lines: string[] = [`${endpoints.length} entry point(s) in ${proj.projectLabel}:\n`];
			for (const ep of endpoints) {
				const name = ep.path ?? ep.operationName ?? ep.txCode ?? '(unnamed)';
				const method = ep.httpMethod ? `${ep.httpMethod} ` : '';
				const pub = ep.isPublicFacing ? '  [public]' : '';
				const io = [ep.inputType, ep.outputType].filter(Boolean).join(' → ');
				const ioStr = io ? `  ${io}` : '';
				const loc = `line ${ep.lineNumber}`;
				lines.push(`  ${ep.kind.padEnd(22)} ${method}${name}${pub}${ioStr}  (${loc})`);
			}

			return {
				title: 'API Surface',
				output: lines.join('\n'),
				metadata: { count: endpoints.length },
			};
		},
	);
}


// ─── data_schemas ─────────────────────────────────────────────────────────────

function _buildDataSchemasTool(discoveryService: IDiscoveryService): IPowerTool {
	return definePowerTool(
		'data_schemas',
		`List data structures, database tables, and entities found in a project.

Detects: SQL tables/views/procedures, COBOL FD and Working-Storage records, JPA entities, Django/SQLAlchemy/TypeORM/Prisma models, Pydantic models, TypeScript interfaces, Protocol Buffer messages, Avro schemas, XML elements, and JSON Schema objects.

Shows whether each schema contains regulated fields (PII/financial/health data).

Use before modifying data access code, planning a schema migration, or reviewing data compliance posture.`,
		[
			{ name: 'folder_path', type: 'string', description: 'Absolute path to the folder to scan.', required: true },
			{ name: 'regulated_only', type: 'boolean', description: 'Optional. If true, return only schemas that contain regulated (PII/financial/health) fields.', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const folderPath    = args.folder_path as string;
			const regulatedOnly = !!args.regulated_only;
			ctx.metadata({ title: `Data schemas — ${folderPath.split(/[/\\]/).pop()}` });

			const result = await discoveryService.scan([_folder(folderPath)], []);
			const proj = result.sources[0];
			if (!proj) {
				return { title: 'Data Schemas', output: 'No data returned.', metadata: {} };
			}

			let schemas = proj.dataSchemas;
			if (regulatedOnly) { schemas = schemas.filter(s => s.hasRegulatedFields); }

			if (schemas.length === 0) {
				return {
					title: 'Data Schemas',
					output: `No data schemas found${regulatedOnly ? ' with regulated fields' : ''} in ${proj.projectLabel}.`,
					metadata: { count: 0 },
				};
			}

			const lines: string[] = [`${schemas.length} schema(s) in ${proj.projectLabel}${regulatedOnly ? ' (regulated only)' : ''}:\n`];
			for (const schema of schemas) {
				const regulated = schema.hasRegulatedFields ? '  ⚠ regulated fields' : '';
				lines.push(`${schema.name}  [${schema.kind}]  ${schema.fields.length} field(s)${regulated}`);
				const regFields = schema.fields.filter(f => f.isRegulated);
				if (regFields.length > 0) {
					lines.push(`  Regulated: ${regFields.map(f => `${f.name}(${f.regulatedReason ?? 'pii'})`).join(', ')}`);
				}
				const keyFields = schema.fields.filter(f => f.isPrimaryKey || f.isForeignKey).slice(0, 4);
				if (keyFields.length > 0) {
					lines.push(`  Keys: ${keyFields.map(f => `${f.name}${f.isPrimaryKey ? '[PK]' : '[FK]'}`).join(', ')}`);
				}
			}

			return {
				title: 'Data Schemas',
				output: lines.join('\n'),
				metadata: { total: schemas.length, regulatedCount: schemas.filter(s => s.hasRegulatedFields).length },
			};
		},
	);
}
