/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Formal Verification Output Parser
 *
 * Parses stdout/stderr from CBMC, Frama-C, GNATprove, Dafny, TLA+, Alloy,
 * Z3, Spin, Coq, Isabelle, Why3, and custom FV tools into
 * structured IFVProofObligation[].
 */

import { IFVProofObligation, FVPropertyKind, FVToolKind, FVVerificationStatus } from './formalVerificationTypes.js';

// \u2500\u2500\u2500 Pattern record \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface IFVPattern {
	kind: FVPropertyKind;
	status: FVVerificationStatus;
	re: RegExp;
	fileGroup?: number;
	lineGroup?: number;
	msgOverride?: string;
}

// \u2500\u2500\u2500 CBMC patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const CBMC_PATTERNS: IFVPattern[] = [
	{ kind: 'assertion',     status: 'failed',  re: /VERIFICATION FAILED/i },
	{ kind: 'assertion',     status: 'proved',  re: /VERIFICATION SUCCESSFUL/i },
	{ kind: 'memory-safety', status: 'failed',  re: /\[.*\]\s+Failed\s*$|assertion.*FAILED/i },
	{ kind: 'memory-safety', status: 'proved',  re: /\[.*\]\s+Passed\s*$/i },
	{ kind: 'overflow',      status: 'failed',  re: /arithmetic overflow|integer overflow|unwanted|CBMC.*overflow/i },
	{ kind: 'memory-safety', status: 'failed',  re: /buffer overflow|out-of-bound|dereference failure|NULL pointer/i },
	{ kind: 'safety',        status: 'timeout', re: /CBMC.*time.{0,10}out|timeout.*CBMC/i },
	{ kind: 'assertion',     status: 'error',   re: /parse error|type error|compilation.*failed/i },
	{ kind: 'termination',   status: 'failed',  re: /unwinding assertion.*FAILED/i },
];

// \u2500\u2500\u2500 Frama-C patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const FRAMAC_PATTERNS: IFVPattern[] = [
	{ kind: 'precondition',  status: 'proved',  re: /\[wp\].*\[Valid\].*Precondition/i },
	{ kind: 'precondition',  status: 'failed',  re: /\[wp\].*\[Invalid\].*Precondition|precondition.*unknown/i },
	{ kind: 'postcondition', status: 'proved',  re: /\[wp\].*\[Valid\].*Postcondition/i },
	{ kind: 'postcondition', status: 'failed',  re: /\[wp\].*\[Invalid\].*Postcondition|postcondition.*unknown/i },
	{ kind: 'invariant',     status: 'proved',  re: /\[wp\].*\[Valid\].*Invariant/i },
	{ kind: 'invariant',     status: 'failed',  re: /\[wp\].*\[Invalid\].*Invariant/i },
	{ kind: 'assertion',     status: 'proved',  re: /\[wp\].*\[Valid\].*Assert/i },
	{ kind: 'assertion',     status: 'failed',  re: /\[wp\].*\[Invalid\].*Assert/i },
	{ kind: 'memory-safety', status: 'failed',  re: /\[eva\].*out of bounds|null.*deref.*Frama/i },
	{ kind: 'overflow',      status: 'failed',  re: /overflow.*Frama|integer overflow.*\[eva\]/i },
	{ kind: 'safety',        status: 'unknown', re: /\[wp\].*\[Unknown\]/i },
	{ kind: 'safety',        status: 'timeout', re: /\[wp\].*timeout|\[eva\].*timeout/i },
];

// \u2500\u2500\u2500 GNATprove / SPARK Ada patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const SPARK_PATTERNS: IFVPattern[] = [
	{ kind: 'precondition',  status: 'proved',  re: /\bproved\b.*precondition|precondition.*\bproved\b/i },
	{ kind: 'precondition',  status: 'failed',  re: /precondition.*\b(?:failed|medium|high|unproved)\b/i },
	{ kind: 'postcondition', status: 'proved',  re: /\bproved\b.*postcondition|postcondition.*\bproved\b/i },
	{ kind: 'postcondition', status: 'failed',  re: /postcondition.*\b(?:failed|medium|high|unproved)\b/i },
	{ kind: 'invariant',     status: 'proved',  re: /type invariant.*proved/i },
	{ kind: 'invariant',     status: 'failed',  re: /type invariant.*(?:failed|unproved)/i },
	{ kind: 'overflow',      status: 'proved',  re: /range check.*proved|overflow.*proved/i },
	{ kind: 'overflow',      status: 'failed',  re: /range check.*(?:failed|unproved|medium)|overflow check.*failed/i },
	{ kind: 'termination',   status: 'proved',  re: /termination.*proved/i },
	{ kind: 'termination',   status: 'failed',  re: /termination.*(?:failed|unproved)/i },
	{ kind: 'safety',        status: 'proved',  re: /gnatprove.*all checks proved|proof successful/i },
	{ kind: 'safety',        status: 'failed',  re: /gnatprove.*unproved|proof.*failed/i },
];

// \u2500\u2500\u2500 Dafny patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const DAFNY_PATTERNS: IFVPattern[] = [
	{ kind: 'safety',        status: 'proved',  re: /Dafny program verifier.*\b0 errors\b/i },
	{ kind: 'safety',        status: 'failed',  re: /Dafny program verifier.*\b\d+ error/i },
	{ kind: 'precondition',  status: 'failed',  re: /precondition.*might not hold|PreconditionInCaller/i },
	{ kind: 'postcondition', status: 'failed',  re: /postcondition.*might not hold|PostconditionViolation/i },
	{ kind: 'invariant',     status: 'failed',  re: /loop invariant.*might not be maintained|invariant.*violation/i },
	{ kind: 'assertion',     status: 'failed',  re: /assertion.*might not hold|assertion violation/i },
	{ kind: 'termination',   status: 'failed',  re: /decreases.*might not decrease|termination/i },
	{ kind: 'overflow',      status: 'failed',  re: /overflow.*Dafny|integer overflow/i },
	{ kind: 'safety',        status: 'timeout', re: /timed out|Dafny.*time limit/i },
	{ kind: 'safety',        status: 'error',   re: /Dafny.*parse error|Dafny.*resolution error/i },
];

// \u2500\u2500\u2500 TLA+ patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const TLAPLUS_PATTERNS: IFVPattern[] = [
	{ kind: 'safety',        status: 'proved',  re: /Model checking completed.*No error/i },
	{ kind: 'safety',        status: 'failed',  re: /Error.*has been found|TLC.*found.*violation/i },
	{ kind: 'invariant',     status: 'failed',  re: /Invariant.*is violated|safety property.*violated/i },
	{ kind: 'liveness',      status: 'failed',  re: /liveness property.*violated|LIVENESS.*error/i },
	{ kind: 'deadlock-free', status: 'failed',  re: /Deadlock reached|deadlock.*TLC/i },
	{ kind: 'reachability',  status: 'failed',  re: /Error state is reachable/i },
	{ kind: 'safety',        status: 'timeout', re: /TLC.*time limit|timeout.*TLC/i },
	{ kind: 'safety',        status: 'proved',  re: /TLAPS.*proof.*complete|QED/i },
	{ kind: 'safety',        status: 'failed',  re: /TLAPS.*proof.*failed|TLAPS.*obligation.*failed/i },
];

// \u2500\u2500\u2500 Alloy patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const ALLOY_PATTERNS: IFVPattern[] = [
	{ kind: 'safety',        status: 'proved',  re: /No counterexample found|Unsatisfiable/i },
	{ kind: 'safety',        status: 'failed',  re: /Counterexample found|Satisfiable/i },
	{ kind: 'invariant',     status: 'failed',  re: /assertion.*fail|check.*counterexample/i },
	{ kind: 'reachability',  status: 'failed',  re: /run.*counterexample|instance found/i },
	{ kind: 'safety',        status: 'timeout', re: /Alloy.*time.{0,10}out|timeout.*Alloy/i },
];

// \u2500\u2500\u2500 Z3 / SMT-LIB patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const Z3_PATTERNS: IFVPattern[] = [
	{ kind: 'safety',        status: 'proved',  re: /^unsat\s*$/im },
	{ kind: 'safety',        status: 'failed',  re: /^sat\s*$/im },
	{ kind: 'safety',        status: 'unknown', re: /^unknown\s*$/im },
	{ kind: 'safety',        status: 'timeout', re: /timeout|Z3.*resource.*limit/i },
	{ kind: 'assertion',     status: 'failed',  re: /model is:\s|counterexample:/i },
	{ kind: 'safety',        status: 'error',   re: /Z3.*error:|parse error.*smt/i },
];

// \u2500\u2500\u2500 Spin / Promela patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const SPIN_PATTERNS: IFVPattern[] = [
	{ kind: 'safety',        status: 'proved',  re: /errors: 0|no errors found/i },
	{ kind: 'safety',        status: 'failed',  re: /pan:.*error|SPIN.*assertion.*violated/i },
	{ kind: 'assertion',     status: 'failed',  re: /assertion violated|assert.*false/i },
	{ kind: 'deadlock-free', status: 'failed',  re: /invalid end state|deadlock/i },
	{ kind: 'liveness',      status: 'failed',  re: /liveness.*violated|acceptance cycle/i },
	{ kind: 'safety',        status: 'timeout', re: /timeout.*pan|SPIN.*time.{0,10}out/i },
];

// \u2500\u2500\u2500 Coq patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const COQ_PATTERNS: IFVPattern[] = [
	{ kind: 'safety',        status: 'proved',  re: /Proof completed\.|No more subgoals\./i },
	{ kind: 'safety',        status: 'failed',  re: /Error:|Syntax error:|Anomaly:/i },
	{ kind: 'assertion',     status: 'failed',  re: /Tactic.*failed|Goal.*not proved/i },
	{ kind: 'safety',        status: 'proved',  re: /QED\./i },
];

// \u2500\u2500\u2500 Isabelle patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const ISABELLE_PATTERNS: IFVPattern[] = [
	{ kind: 'safety',        status: 'proved',  re: /\bproved\b|\bQED\b/i },
	{ kind: 'safety',        status: 'failed',  re: /proof.*failed|error.*Isabelle/i },
	{ kind: 'safety',        status: 'unknown', re: /sorry|\bcheat\b/i },
];

// \u2500\u2500\u2500 Why3 patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const WHY3_PATTERNS: IFVPattern[] = [
	{ kind: 'safety',        status: 'proved',  re: /Valid|proved/i },
	{ kind: 'safety',        status: 'failed',  re: /Invalid|Unknown|Timeout|Why3.*error/i },
	{ kind: 'precondition',  status: 'failed',  re: /precondition.*invalid|pre.*failed/i },
	{ kind: 'postcondition', status: 'failed',  re: /postcondition.*invalid|post.*failed/i },
];

// \u2500\u2500\u2500 Polyspace Code Prover patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const POLYSPACE_CP_PATTERNS: IFVPattern[] = [
	{ kind: 'memory-safety', status: 'proved',  re: /Proven.*green|green.*pass/i },
	{ kind: 'memory-safety', status: 'failed',  re: /Red.*error|defect.*red/i },
	{ kind: 'memory-safety', status: 'unknown', re: /Orange.*unproven|unproven.*orange/i },
	{ kind: 'overflow',      status: 'failed',  re: /Overflow.*Polyspace|integer overflow.*red/i },
	{ kind: 'safety',        status: 'proved',  re: /Polyspace.*no error|all checks.*proved/i },
	{ kind: 'safety',        status: 'failed',  re: /Polyspace.*\d+ defect|Polyspace.*error found/i },
];

// \u2500\u2500\u2500 Universal fallback patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const UNIVERSAL_FV_PATTERNS: IFVPattern[] = [
	{ kind: 'safety',        status: 'proved',  re: /verification.*successful|proof.*complete|all.*proved/i },
	{ kind: 'safety',        status: 'failed',  re: /verification.*failed|proof.*failed|property.*violated/i },
	{ kind: 'assertion',     status: 'failed',  re: /assertion.*failed|assert.*violation/i },
	{ kind: 'invariant',     status: 'failed',  re: /invariant.*violated|invariant.*failed/i },
	{ kind: 'precondition',  status: 'failed',  re: /precondition.*failed|pre.*violation/i },
	{ kind: 'postcondition', status: 'failed',  re: /postcondition.*failed|post.*violation/i },
	{ kind: 'safety',        status: 'timeout', re: /time.{0,5}out|resource.*limit.*exceeded/i },
	{ kind: 'overflow',      status: 'failed',  re: /integer.*overflow|arithmetic.*overflow/i },
	{ kind: 'memory-safety', status: 'failed',  re: /null.*deref|buffer.*overflow|out.of.bound/i },
	{ kind: 'termination',   status: 'failed',  re: /termination.*fail|non.terminat/i },
	{ kind: 'deadlock-free', status: 'failed',  re: /deadlock.*detected|deadlock.*found/i },
	{ kind: 'data-race',     status: 'failed',  re: /data.*race|race.*condition/i },
];

// \u2500\u2500\u2500 File/line extraction \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const FILE_LINE_RE = /(?:at\s+)?([^\s:,]+\.[a-zA-Z]+):(\d+)/;

function extractFileLine(line: string): { file?: string; lineNo?: number } {
	const m = FILE_LINE_RE.exec(line);
	return { file: m?.[1], lineNo: m ? parseInt(m[2], 10) : undefined };
}

// \u2500\u2500\u2500 Main parser \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function getPatternsForTool(kind: FVToolKind): IFVPattern[] {
	switch (kind) {
		case 'cbmc':        return [...CBMC_PATTERNS, ...UNIVERSAL_FV_PATTERNS];
		case 'frama-c':     return [...FRAMAC_PATTERNS, ...UNIVERSAL_FV_PATTERNS];
		case 'spark-ada':   return [...SPARK_PATTERNS, ...UNIVERSAL_FV_PATTERNS];
		case 'dafny':       return [...DAFNY_PATTERNS, ...UNIVERSAL_FV_PATTERNS];
		case 'tlaplus':     return [...TLAPLUS_PATTERNS, ...UNIVERSAL_FV_PATTERNS];
		case 'alloy':       return [...ALLOY_PATTERNS, ...UNIVERSAL_FV_PATTERNS];
		case 'z3':          return [...Z3_PATTERNS, ...UNIVERSAL_FV_PATTERNS];
		case 'spin':        return [...SPIN_PATTERNS, ...UNIVERSAL_FV_PATTERNS];
		case 'coq':         return [...COQ_PATTERNS, ...UNIVERSAL_FV_PATTERNS];
		case 'isabelle':    return [...ISABELLE_PATTERNS, ...UNIVERSAL_FV_PATTERNS];
		case 'why3':        return [...WHY3_PATTERNS, ...UNIVERSAL_FV_PATTERNS];
		case 'polyspace-cp': return [...POLYSPACE_CP_PATTERNS, ...UNIVERSAL_FV_PATTERNS];
		default:            return UNIVERSAL_FV_PATTERNS;
	}
}

let _poCounter = 0;

/**
 * Parse raw FV tool output lines into IFVProofObligation[].
 * First match wins per line. Duplicate obligations (same kind + status + file + line) deduplicated.
 */
export function parseFVOutput(
	lines: string[],
	kind: FVToolKind,
	sessionId: string,
	timestamp: number,
): IFVProofObligation[] {
	const patterns = getPatternsForTool(kind);
	const obligations: IFVProofObligation[] = [];
	const seen = new Set<string>();

	for (const rawLine of lines) {
		const trimmed = rawLine.trim();
		if (!trimmed) { continue; }

		for (const pat of patterns) {
			if (!pat.re.exec(trimmed)) { continue; }

			const { file, lineNo } = extractFileLine(trimmed);
			const message = pat.msgOverride ?? _buildMessage(pat.kind, pat.status, trimmed);
			const dedupKey = `${pat.kind}:${pat.status}:${file ?? ''}:${lineNo ?? ''}`;
			if (seen.has(dedupKey)) { break; }
			seen.add(dedupKey);

			obligations.push({
				id: `${sessionId}-PO-${++_poCounter}`,
				property: _propertyLabel(pat.kind),
				kind: pat.kind,
				status: pat.status,
				tool: kind,
				file,
				line: lineNo,
				message,
				rawLine: trimmed,
				timestamp,
			});
			break;
		}
	}

	return obligations;
}

function _buildMessage(kind: FVPropertyKind, status: FVVerificationStatus, line: string): string {
	const prefix = `${_kindLabel(kind)} [${status.toUpperCase()}]`;
	const detail = line.length > 120 ? line.slice(0, 120) + '\u2026' : line;
	return `${prefix}: ${detail}`;
}

function _kindLabel(kind: FVPropertyKind): string {
	const labels: Record<FVPropertyKind, string> = {
		'safety':        'Safety Property',
		'liveness':      'Liveness Property',
		'reachability':  'Reachability',
		'invariant':     'Invariant',
		'assertion':     'Assertion',
		'precondition':  'Precondition',
		'postcondition': 'Postcondition',
		'frame':         'Frame Condition',
		'termination':   'Termination',
		'overflow':      'Overflow Check',
		'memory-safety': 'Memory Safety',
		'data-race':     'Data Race',
		'deadlock-free': 'Deadlock Freedom',
		'refinement':    'Refinement',
		'custom':        'Custom Property',
	};
	return labels[kind] ?? 'Verification Property';
}

function _propertyLabel(kind: FVPropertyKind): string {
	return _kindLabel(kind);
}
