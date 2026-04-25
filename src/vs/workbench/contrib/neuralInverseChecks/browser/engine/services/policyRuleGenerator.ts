/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IGRCRule } from '../types/grcTypes.js';
import { IProjectPolicy, IDomainRule } from '../../context/autocomplete/policy/policyService.js';

/**
 * Generates GRC rules from the policy service's IProjectPolicy definition.
 *
 * Each forbidden call, constraint, and security constraint is converted into
 * an IGRCRule with type 'regex' so the GRC engine can evaluate it using its
 * standard pipeline.
 *
 * Generated rule IDs follow the pattern: POLICY-{DOMAIN}-{index}
 * All rules are tagged with ['policy', domainName] for filtering.
 */
export class PolicyRuleGenerator {

	/**
	 * Convert a full project policy into GRC rules.
	 */
	public generateRules(policy: IProjectPolicy): IGRCRule[] {
		const rules: IGRCRule[] = [];

		// Generate rules from domain definitions
		for (const [domainName, domainRule] of Object.entries(policy.domains)) {
			rules.push(...this._generateDomainRules(domainName, domainRule));
		}

		// Generate rules from security constraints
		rules.push(...this._generateSecurityConstraintRules(policy.securityConstraints));

		return rules;
	}

	private _generateDomainRules(domainName: string, domainRule: IDomainRule): IGRCRule[] {
		const rules: IGRCRule[] = [];

		// Forbidden calls \u2192 regex rules matching function invocations
		for (const call of domainRule.forbiddenCalls) {
			const escapedCall = this._escapeRegex(call);
			rules.push({
				id: `POLICY-${domainName.toUpperCase()}-FORBID-${call.replace(/[^a-zA-Z0-9]/g, '_')}`,
				domain: 'policy',
				severity: 'error',
				pattern: `\\b${escapedCall}\\s*\\(`,
				message: `Forbidden call '${call}' in '${domainName}' domain (policy violation)`,
				fix: `Remove or replace the call to '${call}' with an approved alternative.`,
				enabled: true,
				type: 'regex',
				tags: ['policy', domainName],
				blockingBehavior: {
					blocksCommit: true,
					blocksDeploy: true,
				},
			});
		}

		// Known constraints \u2192 regex rules
		for (const constraint of domainRule.constraints) {
			const constraintRules = this._constraintToRules(domainName, constraint);
			rules.push(...constraintRules);
		}

		return rules;
	}

	/**
	 * Map well-known constraint names to regex rules.
	 */
	private _constraintToRules(domainName: string, constraint: string): IGRCRule[] {
		const rules: IGRCRule[] = [];
		const tag = ['policy', domainName];

		switch (constraint) {
			case 'no-io':
				rules.push({
					id: `POLICY-${domainName.toUpperCase()}-CONSTRAINT-NO-IO`,
					domain: 'policy',
					severity: 'error',
					pattern: '\\b(fs\\.read|fs\\.write|fetch|XMLHttpRequest|require\\(.*fs.*\\))\\s*\\(',
					message: `I/O operations are forbidden in '${domainName}' domain (no-io constraint)`,
					fix: 'Move I/O operations outside this domain boundary.',
					enabled: true,
					type: 'regex',
					tags: tag,
				});
				break;

			case 'deterministic':
				rules.push({
					id: `POLICY-${domainName.toUpperCase()}-CONSTRAINT-DETERMINISTIC`,
					domain: 'policy',
					severity: 'warning',
					pattern: '\\b(Math\\.random|crypto\\.random|Date\\.now|new Date\\(\\))\\s*',
					message: `Non-deterministic call in '${domainName}' domain (deterministic constraint)`,
					fix: 'Use deterministic alternatives or inject randomness/time as parameters.',
					enabled: true,
					type: 'regex',
					tags: tag,
				});
				break;

			case 'secure-logging':
				rules.push({
					id: `POLICY-${domainName.toUpperCase()}-CONSTRAINT-SECURE-LOG`,
					domain: 'policy',
					severity: 'warning',
					pattern: '\\bconsole\\.(log|debug|info|warn|error)\\s*\\(',
					message: `Direct console logging in '${domainName}' domain (secure-logging constraint)`,
					fix: 'Use the secure logging service instead of console methods.',
					enabled: true,
					type: 'regex',
					tags: tag,
				});
				break;
		}

		return rules;
	}

	private _generateSecurityConstraintRules(constraints: string[]): IGRCRule[] {
		const rules: IGRCRule[] = [];

		for (const constraint of constraints) {
			if (constraint.toLowerCase().includes('input validation')) {
				rules.push({
					id: 'POLICY-SEC-INPUT-VALIDATION',
					domain: 'policy',
					severity: 'warning',
					pattern: '\\b(req\\.body|req\\.query|req\\.params)\\b(?!.*\\b(validate|sanitize|zod|joi|yup)\\b)',
					message: 'Direct use of request input without validation (policy: Input Validation Required)',
					fix: 'Validate input using a schema validation library before use.',
					enabled: true,
					type: 'regex',
					tags: ['policy', 'security'],
				});
			}
		}

		return rules;
	}

	private _escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
}

/**
 * Detect which policy domain a file belongs to based on its path.
 *
 * Matches directory segments against policy domain names.
 * Falls back to common patterns (auth/, api/, etc.) and finally 'default'.
 */
export function detectDomainFromPath(filePath: string, policy: IProjectPolicy): string {
	const segments = filePath.toLowerCase().split('/');
	const domainNames = Object.keys(policy.domains);

	// Direct match: any path segment matches a domain name
	for (const domain of domainNames) {
		if (domain === 'default') continue;
		if (segments.some(seg => seg === domain || seg.startsWith(domain + '-') || seg.endsWith('-' + domain))) {
			return domain;
		}
	}

	// Fallback heuristics for common directory patterns
	const pathLower = filePath.toLowerCase();
	if (pathLower.includes('/auth/') || pathLower.includes('/authentication/')) return domainNames.includes('auth') ? 'auth' : 'default';
	if (pathLower.includes('/api/') || pathLower.includes('/routes/')) return domainNames.includes('api') ? 'api' : 'default';
	if (pathLower.includes('/security/')) return domainNames.includes('security') ? 'security' : 'default';

	return 'default';
}
