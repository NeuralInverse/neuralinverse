/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Framework Import Schema
 *
 * This file defines the TypeScript interfaces for the GRC Framework Import Format.
 *
 * ## Overview
 *
 * Neural Inverse is a **framework-agnostic GRC platform**. It does NOT hardcode
 * compliance standards (DO-178C, IEC 62304, ISO 26262, MISRA, SOC 2, etc.).
 * Instead, enterprises import their own frameworks as JSON files into
 * `.inverse/frameworks/{name}.json`.
 *
 * The IDE loads, validates, and enforces these frameworks in real-time.
 *
 * ## Framework File Location
 *
 *   {workspace}/.inverse/frameworks/{framework-name}.json
 *
 * ## Check Types
 *
 * Each rule in a framework specifies a `check` with one of these types:
 *
 * - `regex`        — Simple pattern matching per line (existing capability)
 * - `ast`          — TypeScript AST structural analysis (e.g. detect eval() even when aliased)
 * - `dataflow`     — Taint tracking from source \u2192 sink (e.g. unsanitized user input \u2192 SQL query)
 * - `import-graph` — Architecture-level checks (e.g. circular dependencies, layer violations)
 * - `external`     — Delegate to any CLI tool and parse its output
 * - `file-level`   — File-level checks (e.g. max line count, missing headers)
 *
 * ## Usage
 *
 * Framework files are loaded by the `IFrameworkRegistry` service on workspace open.
 * The service watches for changes, so adding/removing/modifying a framework file
 * takes effect immediately without restarting the IDE.
 *
 * ## Example Framework
 *
 * ```json
 * {
 *   "framework": {
 *     "id": "my-org-standard",
 *     "name": "My Org Security Standard",
 *     "version": "1.0.0",
 *     "appliesTo": ["typescript", "javascript"]
 *   },
 *   "rules": [
 *     {
 *       "id": "SEC-001",
 *       "title": "No eval()",
 *       "severity": "blocker",
 *       "category": "security",
 *       "check": { "type": "regex", "pattern": "\\beval\\s*\\(" }
 *     }
 *   ]
 * }
 * ```
 */

// ─── Framework Metadata ──────────────────────────────────────────────────────

/**
 * Top-level metadata for a compliance framework.
 *
 * Every imported framework must have an `id` (unique identifier), a `name`
 * (human-readable), and a `version` (semver string). The rest is optional
 * but recommended for traceability in regulated environments.
 */
export interface IFrameworkMetadata {
	/** Unique identifier for this framework, e.g. "acme-security-v2" */
	id: string;

	/** Human-readable name, e.g. "Acme Corp Security Standard v2.0" */
	name: string;

	/** Semantic version string, e.g. "2.0.0" */
	version: string;

	/** Optional description of the framework's purpose */
	description?: string;

	/** Who authored/owns this framework, e.g. "Acme Security Team" */
	authority?: string;

	/**
	 * Which languages this framework applies to.
	 * If omitted, applies to all languages.
	 * Use lowercase language identifiers (e.g. "typescript", "javascript", "python").
	 */
	appliesTo?: string[];

	/**
	 * Custom severity levels defined by this framework.
	 * Keys are severity names (e.g. "blocker", "critical", "major", "minor", "info").
	 * If omitted, the default severity levels from grcTypes.ts are used.
	 */
	severityLevels?: Record<string, ISeverityLevelDefinition>;
}


// ─── Severity ────────────────────────────────────────────────────────────────

/**
 * Custom severity level definition.
 *
 * Frameworks can define their own severity scale. Each level specifies
 * whether violations at that severity should block commits and/or deploys.
 */
export interface ISeverityLevelDefinition {
	/** Whether violations at this severity block git commits (via pre-commit hook) */
	blocksCommit: boolean;

	/** Whether violations at this severity block deployments (via CI/CD gate) */
	blocksDeploy: boolean;

	/**
	 * Maps this custom severity to one of the IDE's display severities.
	 * This controls the squiggly underline color in the editor.
	 * - "error"   \u2192 red squiggly
	 * - "warning" \u2192 yellow squiggly
	 * - "info"    \u2192 blue hint
	 */
	displaySeverity?: 'error' | 'warning' | 'info';
}


// ─── Check Definitions ──────────────────────────────────────────────────────

/**
 * Union type for all supported check types.
 *
 * Each rule specifies exactly one check. The `type` field determines
 * which analyzer in the GRC engine handles the rule.
 */
export type ICheckDefinition =
	| IRegexCheck
	| IAstCheck
	| IDataFlowCheck
	| IImportGraphCheck
	| IExternalCheck
	| IFileLevelCheck
	| IUniversalCheck
	| ISvdCCheck
	| ICStructuralCheck
	| IICSSecurityCheck
	| ITelecomSecurityCheck
	| IIoTOTCheck;

/**
 * SVD C/C++ hardware check — SVD-aware analysis of firmware code.
 * Used for detecting reserved bit writes, missing clock enables, and
 * missing pin muxing.
 */
export interface ISvdCCheck {
	type: 'svd-c';

	/** 
	 * What to detect:
	 * - 'reserved-bit-write': Writing to undocumented/reserved bits
	 * - 'missing-clock-enable': Using a peripheral before enabling its clock
	 * - 'missing-pin-mux': Enabling a peripheral without mapping GPIO pins
	 */
	detect: 'reserved-bit-write' | 'missing-clock-enable' | 'missing-pin-mux';
}
/**
 * C/C++ structural check — MISRA C, AUTOSAR, ISO 26262, and ISR safety patterns.
 * Handled by CStructuralAnalyzer. Applies to C, C++, and embedded-C/C++ files.
 */
export interface ICStructuralCheck {
	type: 'c-structural';
	detect:
		| 'goto-usage'
		| 'recursive-call'
		| 'dynamic-memory'
		| 'unbounded-recursion'
		| 'isr-shared-state'
		| 'isr-blocking-call'
		| 'misra-implicit-type'
		| 'misra-no-else'
		| 'misra-switch-default'
		| 'misra-multiple-return'
		| 'autosar-layer-violation'
		| 'unsafe-pointer-cast'
		| 'stack-overflow-risk'
		| 'missing-volatile-shared'
		| 'missing-error-propagation'
		| 'polling-without-timeout'
		| 'timeout-without-recovery'
		| 'non-atomic-output-register'
		| 'unbounded-string-loop';
}

/**
 * ICS/SCADA security check — Critical Infrastructure (Energy/Oil/Gas) patterns.
 * Handled by ICSSecurityAnalyzer. Language-agnostic.
 */
export interface IICSSecurityCheck {
	type: 'ics-security';
	detect:
		| 'hardcoded-credential'
		| 'scada-unauthenticated'
		| 'dnp3-no-auth'
		| 'modbus-no-whitelist'
		| 'opc-ua-no-security'
		| 'iec61850-unprotected'
		| 'engineering-station-path'
		| 'cleartext-ot-protocol'
		| 'missing-network-isolation'
		| 'unsafe-firmware-update';
}

/**
 * Telecom & 5G security check — SIP/GTP/NAS/Diameter/SS7 security patterns.
 * Handled by TelecomSecurityAnalyzer. Language-agnostic.
 */
export interface ITelecomSecurityCheck {
	type: 'telecom-security';
	detect:
		| 'imsi-plaintext-log'
		| 'sip-header-injection'
		| 'gtp-missing-validation'
		| 'nas-unprotected'
		| 'diameter-no-tls'
		| 'ss7-unfiltered'
		| 'suci-concealment-skip'
		| 'ki-plaintext'
		| 'lawful-intercept-gap';
}

/**
 * Industrial IoT / OT check — real-time safety, PLC/SCADA, and determinism patterns.
 * Handled by IndustrialIotAnalyzer. Language-agnostic.
 */
export interface IIoTOTCheck {
	type: 'iot-ot';
	detect:
		| 'missing-watchdog'
		| 'heap-in-rt-task'
		| 'missing-redundancy'
		| 'determinism-violation'
		| 'missing-safety-check'
		| 'plc-write-unprotected'
		| 'scada-historian-direct'
		| 'ot-hardcoded-ip'
		| 'missing-failsafe'
		| 'heartbeat-missing';
	context?: 'firmware' | 'plc' | 'scada' | 'hmi' | 'generic';
}

/**
 * Regex check — matches a pattern against each line of code.
 *
 * This is the simplest and fastest check type. Good for catching
 * obvious patterns like `eval()`, hardcoded secrets, banned APIs.
 *
 * Limitation: Cannot understand code structure (aliased variables,
 * scope, type information). Use `ast` type for structural analysis.
 */
export interface IRegexCheck {
	type: 'regex';

	/** Regular expression pattern string */
	pattern: string;

	/** Regex flags, e.g. "i" for case-insensitive. Default: none */
	flags?: string;

	/**
	 * If true, run the regex against the entire file content (joined lines)
	 * instead of line-by-line. Useful for patterns that span multiple lines.
	 * Line numbers are computed from match positions.
	 * Default: false (line-by-line)
	 */
	multiline?: boolean;

	/**
	 * Skip matches found in these contexts.
	 * - "comment" — skip matches inside // or /* * / comments
	 * - "string" — skip matches inside '...' or "..." string literals
	 * - "template-literal" — skip matches inside `...` template literals
	 * Default: undefined (match everywhere)
	 */
	excludeContexts?: ('comment' | 'string' | 'template-literal')[];
}

/**
 * AST check — matches against TypeScript/JavaScript syntax tree nodes.
 *
 * More powerful than regex: can detect patterns even when code is
 * refactored (e.g. `eval` aliased to a variable, or a function
 * called through an intermediate object).
 *
 * ## Node Types
 *
 * Use TypeScript AST node type names:
 * - `CallExpression` — function calls
 * - `PropertyAccessExpression` — property access (e.g. `obj.method`)
 * - `FunctionDeclaration` — function declarations
 * - `ArrowFunction` — arrow functions
 * - `VariableDeclaration` — variable declarations
 * - `ImportDeclaration` — import statements
 * - `ClassDeclaration` — class declarations
 * - etc.
 *
 * Multiple node types can be specified with `|` separator.
 *
 * ## Constraints
 *
 * Constraints are predicate expressions evaluated on the matched node.
 * Available predicates depend on the node type:
 *
 * - `isAsync` — function is marked async
 * - `hasTryCatch` — function body contains try/catch
 * - `callsFunction(name)` — function calls the specified function
 * - `hasReturnType` — function has an explicit return type annotation
 * - `paramCount > N` — function has more than N parameters
 *
 * Constraints can be combined with `&&` and `||`.
 */
export interface IAstCheck {
	type: 'ast';

	match: {
		/**
		 * AST node type(s) to match, e.g. "CallExpression" or
		 * "FunctionDeclaration|ArrowFunction".
		 */
		nodeType: string;

		/**
		 * For CallExpression: name(s) of the callee function, e.g. ["eval", "Function"].
		 * Supports simple name matching, not full expression matching.
		 */
		callee?: string[];

		/**
		 * Constraint expression to evaluate on the matched node.
		 * e.g. "isAsync && !hasTryCatch" or "paramCount > 5"
		 */
		constraint?: string;
	};
}

/**
 * Data flow check — taint tracking from sources to sinks.
 *
 * Tracks data from specified "sources" (e.g. user input, environment
 * variables) through the code, and flags when tainted data reaches
 * a "sink" (e.g. SQL query, file path, exec call) without passing
 * through a "sanitizer" (e.g. validation function, escape function).
 *
 * ## Example
 *
 * ```json
 * {
 *   "type": "dataflow",
 *   "taint": {
 *     "sources": ["req.body", "req.query"],
 *     "sinks": ["db.query", "res.send"],
 *     "sanitizers": ["validate", "sanitize", "escape"]
 *   }
 * }
 * ```
 *
 * This would flag: `res.send(req.body.name)` (tainted data sent to response)
 * But NOT: `res.send(sanitize(req.body.name))` (sanitizer applied)
 */
export interface IDataFlowCheck {
	type: 'dataflow';

	taint: {
		/**
		 * Expressions that produce tainted data.
		 * e.g. ["req.body", "req.query", "req.params", "process.env"]
		 */
		sources: string[];

		/**
		 * Expressions where tainted data is dangerous.
		 * e.g. ["db.query", "fs.readFile", "child_process.exec", "res.send"]
		 */
		sinks: string[];

		/**
		 * Functions that clean/validate tainted data.
		 * If tainted data passes through a sanitizer before a sink, no violation.
		 * e.g. ["validate", "sanitize", "escape", "DOMPurify.sanitize"]
		 */
		sanitizers?: string[];
	};
}

/**
 * Import graph check — architecture-level analysis.
 *
 * Analyzes the import/dependency graph of the workspace.
 * Supports:
 * - `cycles`: detect circular dependencies
 * - `boundaries`: enforce module import boundaries
 * - `layers`: enforce layered architecture (e.g. UI \u2192	Service \u2192 Data)
 */
export interface IImportGraphCheck {
	type: 'import-graph';

	/**
	 * What to detect in the import graph.
	 * - "cycles" — circular dependency detection
	 * - "boundary-violation" — imports crossing module boundaries
	 * - "layer-violation" — imports violating layer ordering
	 */
	detect: 'cycles' | 'boundary-violation' | 'layer-violation';

	/**
	 * For boundary/layer checks: define the allowed import rules.
	 * Each entry maps a source pattern to allowed target patterns.
	 * e.g. { "src/ui/**": ["src/services/**"], "src/services/**": ["src/data/**"] }
	 */
	boundaries?: Record<string, string[]>;
}

/**
 * External check — delegate to any CLI tool.
 *
 * This is the escape hatch for custom tooling. The IDE runs the
 * specified command, captures its output, and parses violations.
 *
 * ## Variables
 *
 * The `command` string supports these variables:
 * - `${file}` — absolute path to the file being checked
 * - `${workspace}` — absolute path to the workspace root
 * - `${relativeFile}` — path relative to workspace root
 *
 * ## Example
 *
 * ```json
 * {
 *   "type": "external",
 *   "command": "npx semgrep --config=auto --json ${file}",
 *   "parseOutput": "json",
 *   "resultMapping": {
 *     "line": "$.results[*].start.line",
 *     "column": "$.results[*].start.col",
 *     "message": "$.results[*].extra.message",
 *     "severity": "$.results[*].extra.severity"
 *   }
 * }
 * ```
 */
export interface IExternalCheck {
	type: 'external';

	/**
	 * Command to execute.
	 *
	 * Variable substitutions:
	 *   ${file}         — absolute path to the file (file-scope only)
	 *   ${workspace}    — absolute path to the workspace root
	 *   ${relativeFile} — file path relative to workspace root
	 *   ${env:VAR}      — value of environment variable VAR
	 */
	command: string;

	/**
	 * Execution scope.
	 *
	 * - 'file'      — tool runs once per file (fast linters, MATLAB mlint)
	 * - 'workspace' — tool runs once per workspace scan (CodeQL, Semgrep, Polyspace)
	 *
	 * Workspace-scope tools avoid the overhead of N invocations for N files.
	 * Their output is a SARIF/Polyspace report covering all files at once.
	 *
	 * Default: 'file'
	 */
	scope?: 'file' | 'workspace';

	/**
	 * Output format to parse.
	 *
	 * - 'sarif'            — SARIF v2.1 (CodeQL, Semgrep, Snyk, GitHub Advanced Security)
	 * - 'json'             — Generic JSON with resultMapping
	 * - 'line-per-violation' — One violation per stdout line
	 * - 'polyspace-csv'    — Polyspace Bug Finder / Code Prover CSV export
	 * - 'polyspace-xml'    — Polyspace XML detailed report (2019+)
	 * - 'matlab-mlint'     — MATLAB Code Analyzer (mlint) text output
	 * - 'eslint-json'      — ESLint --format=json
	 * - 'checkstyle-xml'   — Checkstyle XML (Java: Checkstyle, PMD, SpotBugs)
	 */
	parseOutput: 'json'
	           | 'line-per-violation'
	           | 'sarif'
	           | 'polyspace-csv'
	           | 'polyspace-xml'
	           | 'matlab-mlint'
	           | 'eslint-json'
	           | 'checkstyle-xml';

	/**
	 * For JSON output: field mapping from tool output to violation fields.
	 * For line-per-violation: regex with named capture groups.
	 */
	resultMapping?: {
		line?: string;
		column?: string;
		endLine?: string;
		endColumn?: string;
		message?: string;
		severity?: string;
	};

	/**
	 * Binary name to check for availability before running.
	 * If specified and the binary is not found in PATH, the check is
	 * skipped gracefully (status: 'skipped', skipReason: 'tool-not-found').
	 *
	 * Example: 'semgrep', 'matlab', 'polyspace-bug-finder'
	 */
	toolBinary?: string;

	/**
	 * Command to run to get the tool version string.
	 * Used for diagnostic reporting in the External Tools panel.
	 *
	 * Example: 'semgrep --version'
	 */
	toolVersionCommand?: string;

	/**
	 * Cache strategy — when to re-run the tool vs. serve cached results.
	 *
	 * - 'content-hash' — re-run only when file content (file-scope) or workspace
	 *                    file mtimes (workspace-scope) have changed since last run.
	 *                    Best for slow tools (Polyspace: minutes, CodeQL: minutes).
	 * - 'time'         — re-run when cache is older than timeoutMs. Legacy behaviour.
	 * - 'never'        — always use cached results (manual refresh only).
	 *
	 * Default: 'content-hash'
	 */
	cacheStrategy?: 'content-hash' | 'time' | 'never';

	/**
	 * Extra environment variables to set when running the command.
	 * Useful for license server addresses, API keys, tool configuration.
	 *
	 * Example: { "MATLAB_LICENSE_FILE": "27000@license-server" }
	 */
	env?: Record<string, string>;

	/**
	 * Working directory for the command.
	 *
	 * - 'workspace' — workspace root (default, correct for most tools)
	 * - 'file-dir'  — directory containing the file being checked
	 */
	workingDirectory?: 'workspace' | 'file-dir';

	/** Maximum time in ms to wait for the command. Default: 30000 */
	timeoutMs?: number;

	/**
	 * Maximum stdout bytes to read from the tool output.
	 * Output beyond this limit is truncated with a warning.
	 * Default: 5242880 (5 MB)
	 */
	maxOutputBytes?: number;
}

/**
 * File-level check — evaluated once per file, not per line.
 *
 * Used for checks like maximum file length, missing headers,
 * file naming conventions, etc.
 */
export interface IFileLevelCheck {
	type: 'file-level';

	/**
	 * What to check at file level.
	 * - "max-lines" — file exceeds threshold lines
	 * - "missing-header" — file does not start with specified pattern
	 * - "naming" — filename does not match pattern
	 */
	detect: 'max-lines' | 'missing-header' | 'naming';

	/** For max-lines: the threshold. For naming: unused. */
	threshold?: number;

	/** For missing-header: regex that the first N lines must match */
	headerPattern?: string;

	/** For naming: glob or regex pattern for valid filenames */
	namePattern?: string;
}


/**
 * Universal check — language-agnostic pattern matching with language filters.
 *
 * Works for ANY language. Combines the speed of regex with awareness of
 * which language is being checked and optional per-language pattern variants.
 *
 * ## Language IDs
 *
 * Use VS Code language identifiers: "typescript", "javascript", "python",
 * "java", "c", "cpp", "csharp", "go", "rust", "ruby", "php", "swift",
 * "kotlin", "scala", "sql", "dockerfile", "terraform", "yaml", "json"
 *
 * ## Multi-language Pattern Example
 *
 * ```json
 * {
 *   "type": "universal",
 *   "languages": ["python", "javascript", "typescript"],
 *   "pattern": "(password|secret|api_key)\\s*=\\s*[\"'][^\"']{4,}[\"']",
 *   "languagePatterns": {
 *     "java": "(?:String|final)\\s+(?:password|secret|apiKey)\\s*=\\s*\"[^\"]+\""
 *   }
 * }
 * ```
 */
export interface IUniversalCheck {
	type: 'universal';

	/**
	 * VS Code language IDs this rule applies to.
	 * If omitted, applies to ALL languages.
	 * e.g. ["c", "cpp", "java", "python", "typescript", "javascript"]
	 */
	languages?: string[];

	/**
	 * Default regex pattern applied to all target languages.
	 * Use `languagePatterns` to override for specific languages.
	 */
	pattern?: string;

	/** Regex flags for the default pattern. Default: "gi" */
	flags?: string;

	/**
	 * Per-language pattern overrides.
	 * Key: VS Code language ID. Value: regex pattern string.
	 * When a language ID matches, this pattern is used INSTEAD of `pattern`.
	 *
	 * Use this when the same concept has different syntax across languages.
	 * e.g. null check in Java vs Go vs Python.
	 */
	languagePatterns?: Record<string, string>;

	/**
	 * Skip matches found in these contexts.
	 * Applied before pattern matching for all target languages.
	 */
	excludeContexts?: ('comment' | 'string' | 'template-literal')[];

	/** If true, run as multi-line match against entire file. Default: false */
	multiline?: boolean;
}


// ─── Framework Rule ──────────────────────────────────────────────────────────

/**
 * A single rule within a compliance framework.
 *
 * Each rule defines:
 * - What to check (`check`)
 * - What severity a violation is (`severity`)
 * - Which category/domain it belongs to (`category`)
 * - How to fix it (`fix`)
 * - External references like CWE, CVE, OWASP (`references`)
 */
export interface IFrameworkRule {
	/** Unique rule ID within the framework, e.g. "ACME-SEC-001" */
	id: string;

	/** Human-readable title shown in diagnostics */
	title: string;

	/** Detailed description of what this rule checks and why */
	description?: string;

	/**
	 * Severity of a violation.
	 *
	 * If the framework defines custom severity levels, this should be
	 * one of those keys. Otherwise, use the defaults: "error", "warning", "info".
	 */
	severity: string;

	/**
	 * Category this rule belongs to.
	 *
	 * Maps to the IDE's subsystem views. Standard categories:
	 * "security", "compliance", "architecture", "data-integrity",
	 * "fail-safe", "policy". Frameworks can define custom categories.
	 */
	category: string;

	/** The check definition — what and how to check */
	check: ICheckDefinition;

	/** Suggested fix text shown alongside the violation */
	fix?: string;

	/**
	 * External references for traceability.
	 * e.g. ["CWE-94", "OWASP A03:2021", "DO-178C Table A-5 Objective 6"]
	 */
	references?: string[];

	/** Searchable tags for filtering/grouping, e.g. ["injection", "xss"] */
	tags?: string[];

	/**
	 * Whether this rule is enabled by default.
	 * Users can override via .inverse/grc-rules.json.
	 * Default: true
	 */
	enabled?: boolean;
}


// ─── Framework Category ──────────────────────────────────────────────────────

/**
 * Custom category (domain) definition.
 *
 * Categories determine which subsystem view in the Checks Manager
 * displays the rule's violations. Frameworks can define new categories
 * beyond the built-in ones.
 */
export interface IFrameworkCategory {
	/** Display label, e.g. "Security as Code" */
	label: string;

	/** Codicon icon name, e.g. "shield" */
	icon?: string;

	/** Accent color in hex, e.g. "#ff5252" */
	color?: string;
}


// ─── Top-Level Framework Definition ──────────────────────────────────────────

/**
 * The complete framework definition — the root object in a
 * `.inverse/frameworks/{name}.json` file.
 *
 * This is the contract between the enterprise and the IDE.
 */
export interface IFrameworkDefinition {
	/** Framework metadata */
	framework: IFrameworkMetadata;

	/** Array of rules to enforce */
	rules: IFrameworkRule[];

	/**
	 * Optional: custom category definitions.
	 * Keys are category identifiers (used in rule.category).
	 * Values define how the category appears in the IDE.
	 */
	categories?: Record<string, IFrameworkCategory>;
}


// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Result of validating a framework definition against the schema.
 */
export interface IFrameworkValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

/**
 * Validates a parsed JSON object against the framework schema.
 *
 * Returns validation errors for:
 * - Missing required fields (framework.id, framework.name, framework.version)
 * - Invalid check types
 * - Rules referencing undefined severity levels
 * - Rules with empty patterns
 * - Duplicate rule IDs
 *
 * Returns warnings for:
 * - Rules without fix suggestions
 * - Rules without references
 * - Categories defined but not used by any rules
 */
export function validateFramework(data: unknown): IFrameworkValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!data || typeof data !== 'object') {
		return { valid: false, errors: ['Framework definition must be a JSON object'], warnings: [] };
	}

	const obj = data as any;

	// ── Validate framework metadata ──────────────────────────────────────
	if (!obj.framework || typeof obj.framework !== 'object') {
		errors.push('Missing required "framework" metadata object');
	} else {
		const fw = obj.framework;
		if (!fw.id || typeof fw.id !== 'string') {
			errors.push('framework.id is required and must be a string');
		}
		if (!fw.name || typeof fw.name !== 'string') {
			errors.push('framework.name is required and must be a string');
		}
		if (!fw.version || typeof fw.version !== 'string') {
			errors.push('framework.version is required and must be a string');
		}
		if (fw.appliesTo && !Array.isArray(fw.appliesTo)) {
			errors.push('framework.appliesTo must be an array of language identifiers');
		}
	}

	// ── Validate rules array ─────────────────────────────────────────────
	if (!Array.isArray(obj.rules)) {
		errors.push('Missing required "rules" array');
	} else {
		const ruleIds = new Set<string>();

		for (let i = 0; i < obj.rules.length; i++) {
			const rule = obj.rules[i];
			const prefix = `rules[${i}]`;

			if (!rule.id || typeof rule.id !== 'string') {
				errors.push(`${prefix}: "id" is required and must be a string`);
			} else if (ruleIds.has(rule.id)) {
				errors.push(`${prefix}: Duplicate rule ID "${rule.id}"`);
			} else {
				ruleIds.add(rule.id);
			}

			if (!rule.title || typeof rule.title !== 'string') {
				errors.push(`${prefix}: "title" is required and must be a string`);
			}

			if (!rule.severity || typeof rule.severity !== 'string') {
				errors.push(`${prefix}: "severity" is required and must be a string`);
			}

			if (!rule.category || typeof rule.category !== 'string') {
				errors.push(`${prefix}: "category" is required and must be a string`);
			}

			// Validate check definition
			if (!rule.check || typeof rule.check !== 'object') {
				errors.push(`${prefix}: "check" object is required`);
			} else {
				const validTypes = ['regex', 'ast', 'dataflow', 'import-graph', 'external', 'file-level', 'universal', 'svd-c', 'c-structural', 'ics-security', 'telecom-security', 'iot-ot'];
				if (!validTypes.includes(rule.check.type)) {
					errors.push(`${prefix}.check.type: must be one of: ${validTypes.join(', ')}`);
				}

				// Type-specific validation
				if (rule.check.type === 'regex') {
					if (!rule.check.pattern || typeof rule.check.pattern !== 'string') {
						errors.push(`${prefix}.check.pattern: required for regex checks`);
					} else {
						// Validate regex is parseable
						try {
							new RegExp(rule.check.pattern, rule.check.flags ?? '');
						} catch (e: any) {
							errors.push(`${prefix}.check.pattern: invalid regex — ${e.message}`);
						}
					}
				}

				if (rule.check.type === 'ast') {
					if (!rule.check.match || !rule.check.match.nodeType) {
						errors.push(`${prefix}.check.match.nodeType: required for AST checks`);
					}
				}

				if (rule.check.type === 'dataflow') {
					if (!rule.check.taint) {
						errors.push(`${prefix}.check.taint: required for dataflow checks`);
					} else {
						if (!Array.isArray(rule.check.taint.sources) || rule.check.taint.sources.length === 0) {
							errors.push(`${prefix}.check.taint.sources: at least one source is required`);
						}
						if (!Array.isArray(rule.check.taint.sinks) || rule.check.taint.sinks.length === 0) {
							errors.push(`${prefix}.check.taint.sinks: at least one sink is required`);
						}
					}
				}

				if (rule.check.type === 'external') {
					if (!rule.check.command || typeof rule.check.command !== 'string') {
						errors.push(`${prefix}.check.command: required for external checks`);
					}
					const validParseOutputs = [
						'json', 'line-per-violation', 'sarif',
						'polyspace-csv', 'polyspace-xml', 'matlab-mlint',
						'eslint-json', 'checkstyle-xml'
					];
					if (rule.check.parseOutput && !validParseOutputs.includes(rule.check.parseOutput)) {
						errors.push(`${prefix}.check.parseOutput: must be one of ${validParseOutputs.join(', ')}`);
					}
					const validScopes = ['file', 'workspace'];
					if (rule.check.scope && !validScopes.includes(rule.check.scope)) {
						errors.push(`${prefix}.check.scope: must be 'file' or 'workspace'`);
					}
					const validCacheStrategies = ['content-hash', 'time', 'never'];
					if (rule.check.cacheStrategy && !validCacheStrategies.includes(rule.check.cacheStrategy)) {
						errors.push(`${prefix}.check.cacheStrategy: must be one of ${validCacheStrategies.join(', ')}`);
					}
				}
			}

			// Warnings for missing best-practice fields
			if (!rule.fix) {
				warnings.push(`${prefix} ("${rule.id}"): No "fix" suggestion provided`);
			}
			if (!rule.references || rule.references.length === 0) {
				warnings.push(`${prefix} ("${rule.id}"): No "references" provided (CWE, OWASP, etc.)`);
			}
		}
	}

	// ── Validate categories (if present) ─────────────────────────────────
	if (obj.categories && typeof obj.categories === 'object') {
		const definedCategories = new Set(Object.keys(obj.categories));
		const usedCategories = new Set<string>();

		if (Array.isArray(obj.rules)) {
			for (const rule of obj.rules) {
				if (rule.category) {
					usedCategories.add(rule.category);
				}
			}
		}

		for (const cat of definedCategories) {
			if (!usedCategories.has(cat)) {
				warnings.push(`Category "${cat}" is defined but not used by any rules`);
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings
	};
}
