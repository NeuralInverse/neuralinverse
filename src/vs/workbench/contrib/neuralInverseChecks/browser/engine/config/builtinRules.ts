/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *
 *  Licensed under the Business Source License 1.1 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at https://mariadb.com/bsl11
 *
 *  Change Date: 2029-07-14
 *  Change License: GNU Affero General Public License v3.0
 *
 *  Use of this software in production requires a commercial license from Neural Inverse Inc.
 *  Contact (code): github@neuralinverse.com | Contact (sales): sales@neuralinverse.com
 *--------------------------------------------------------------------------------------------*/

/**
 * # Built-in Rules — Platform Baseline
 *
 * This file defines the built-in framework structure for the Neural Inverse IDE.
 *
 * ## Philosophy
 *
 * Neural Inverse is a **platform**, not an opinionated ruleset. Companies define
 * their own GRC requirements via `.inverse/frameworks/` using the framework
 * import format. The built-in framework ships with ZERO rules — it only provides
 * the structural baseline (categories, severity definitions) that enterprise
 * frameworks can reference.
 *
 * ## How Companies Use This
 *
 * 1. Drop framework JSON files into `.inverse/frameworks/`
 * 2. Framework files define rules using check types: regex, ast, dataflow,
 *    import-graph, external, file-level, metrics-threshold
 * 3. Rules are loaded and enforced automatically — no IDE restart needed
 * 4. The engine provides deep analysis context (nano agent data) to all analyzers
 *
 * ## Available Check Types
 *
 * | Type              | Analyzer         | What It Does                                    |
 * |-------------------|------------------|-------------------------------------------------|
 * | `regex`           | Built-in engine  | Line-by-line pattern matching                   |
 * | `file-level`      | Built-in engine  | File-level checks (max lines, headers)           |
 * | `ast`             | AstAnalyzer      | TypeScript AST structural analysis + constraints |
 * | `dataflow`        | DataFlowAnalyzer | Taint tracking: source → sink                   |
 * | `import-graph`    | ImportGraphAnalyzer | Module boundary/layer violation detection      |
 * | `external`        | ExternalCheckRunner | Delegate to CLI tools (semgrep, eslint, etc.)  |
 *
 * ## AST Constraints (powered by nano agent context)
 *
 * Framework rules with `type: "ast"` can use these constraints:
 * - `isAsync`, `hasTryCatch`, `hasReturnType`, `paramCount > N`
 * - `hasNetwork`, `hasCrypto`, `hasAuth`, `hasDatabase` (from nano agent capabilities)
 * - `isTestFile`, `complexity > N` (from nano agent metrics)
 */

import { IFrameworkDefinition } from '../framework/frameworkSchema.js';
import { IGRCRule } from '../types/grcTypes.js';


// ─── Default Framework Definition ────────────────────────────────────────────

/**
 * The built-in framework definition.
 *
 * Ships with ZERO rules. Companies define their own via .inverse/frameworks/.
 * This provides the structural baseline only.
 */
export const BUILTIN_FRAMEWORK: IFrameworkDefinition = {
	framework: {
		id: 'neural-inverse-builtin',
		name: 'Neural Inverse Platform',
		version: '2.0.0',
		description: 'Platform baseline — no built-in rules. Companies define their own GRC requirements via .inverse/frameworks/.',
		authority: 'Neural Inverse',
		appliesTo: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'python', 'java', 'go', 'rust', 'c', 'cpp'],
	},

	rules: [],

	categories: {
		'security': { label: 'Security', icon: 'shield', color: '#ff5252' },
		'compliance': { label: 'Compliance', icon: 'verified', color: '#ffd740' },
		'data-integrity': { label: 'Data Integrity', icon: 'database', color: '#ab47bc' },
		'architecture': { label: 'Architecture', icon: 'layers', color: '#42a5f5' },
		'fail-safe': { label: 'Fail-Safe Defaults', icon: 'error', color: '#ff7043' },
		'policy': { label: 'Policy', icon: 'policy', color: '#66bb6a' },
		'privacy': { label: 'Privacy', icon: 'lock', color: '#7c4dff' },
		'performance': { label: 'Performance', icon: 'dashboard', color: '#26c6da' },
		'reliability': { label: 'Reliability', icon: 'verified_user', color: '#9ccc65' },
	},
};


// ─── Backward Compatibility Export ───────────────────────────────────────────

/**
 * Empty array — no built-in rules.
 * Companies define all rules via .inverse/frameworks/.
 */
export const BUILTIN_RULES: IGRCRule[] = [];
