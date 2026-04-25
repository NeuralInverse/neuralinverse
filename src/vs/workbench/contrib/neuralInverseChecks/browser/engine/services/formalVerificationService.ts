/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Formal Verification Service
 *
 * Session lifecycle, proof obligation tracking, output parsing, and GRC injection
 * for all FV tools (CBMC, Frama-C, GNATprove, Dafny, TLA+, Alloy, Z3, Spin,
 * Coq, Isabelle, Why3, Polyspace Code Prover, Custom).
 *
 * Architecture mirrors SimulatorService:
 *   - createSession / runSession / stopSession / deleteSession / cloneSession
 *   - onDidSessionUpdate fires on every state change (UI patches cards live)
 *   - Proven obligations are injected into GRCEngine as 'formal-verification' results
 *   - Failed obligations produce error-severity GRC results with code-linked violations
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IFVSession, IFVToolConfig, IFVProofObligation, IFVPreset, FVToolKind } from './formalVerificationTypes.js';
import { parseFVOutput } from './formalVerificationOutputParser.js';
import { IGRCEngineService } from './grcEngineService.js';
import { IExternalCommandExecutor } from './externalCommandExecutor.js';

// ─── Presets ──────────────────────────────────────────────────────────────────

export const FV_PRESETS: IFVPreset[] = [
	// ── CBMC ──────────────────────────────────────────────────────────────────
	{ id: 'fv-cbmc-memory',   name: 'CBMC Memory Safety',       sector: 'Firmware & Embedded', targetLanguage: 'C/C++',    kind: 'cbmc',      description: 'Bounded model check for null dereference, buffer overflow, and memory faults',           tags: ['memory-safety','C','MISRA','ISO 26262'],  verifyCommand: 'cbmc ${workspace}/src --unwind 10 --memory-leak-check --bounds-check --pointer-check', timeoutMs: 180000 },
	{ id: 'fv-cbmc-overflow', name: 'CBMC Arithmetic Overflow', sector: 'Firmware & Embedded', targetLanguage: 'C/C++',    kind: 'cbmc',      description: 'Check for signed/unsigned integer overflow in safety-critical arithmetic',                tags: ['overflow','arithmetic','C','IEC 61508'], verifyCommand: 'cbmc ${workspace}/src --unwind 5 --signed-overflow-check --unsigned-overflow-check',    timeoutMs: 120000 },
	{ id: 'fv-cbmc-assert',   name: 'CBMC Assertion Checking',  sector: 'Generic',             targetLanguage: 'C/C++',    kind: 'cbmc',      description: 'Verify all assert() statements in the codebase reachable within unwind bound',             tags: ['assertion','C','C++'],                   verifyCommand: 'cbmc ${workspace}/src --unwind 10 --trace',                                            timeoutMs: 120000 },
	{ id: 'fv-cbmc-iso26262', name: 'CBMC ISO 26262 ASIL-C',    sector: 'Automotive',          targetLanguage: 'C',        kind: 'cbmc',      description: 'Memory safety + overflow checks required for ISO 26262 ASIL-C software',                  tags: ['ISO 26262','ASIL-C','automotive','C'],   verifyCommand: 'cbmc ${workspace}/src --unwind 20 --bounds-check --pointer-check --overflow-check',    timeoutMs: 300000 },

	// ── Frama-C ───────────────────────────────────────────────────────────────
	{ id: 'fv-framac-wp',     name: 'Frama-C WP Deductive',     sector: 'Aerospace',           targetLanguage: 'C',        kind: 'frama-c',   description: 'WP (Weakest Precondition) deductive verification of ACSL contracts — DO-178C Level A',     tags: ['DO-178C','WP','contracts','C'],          verifyCommand: 'frama-c -wp -wp-rte -wp-timeout 30 ${file}',                                          timeoutMs: 300000 },
	{ id: 'fv-framac-eva',    name: 'Frama-C EVA Value',        sector: 'Critical Infrastructure', targetLanguage: 'C',    kind: 'frama-c',   description: 'Economic Value Analysis — value range propagation for IEC 61508 SIL 4 verification',      tags: ['EVA','IEC 61508','SIL 4','C'],          verifyCommand: 'frama-c -eva -eva-precision 5 ${file}',                                                timeoutMs: 240000 },
	{ id: 'fv-framac-misra',  name: 'Frama-C MISRA+Contracts',  sector: 'Automotive',          targetLanguage: 'C',        kind: 'frama-c',   description: 'WP verification of ACSL function contracts for MISRA-C rule compliance',                   tags: ['MISRA-C:2012','ACSL','automotive'],      verifyCommand: 'frama-c -wp -rte -rte-mem ${workspace}/src/*.c',                                      timeoutMs: 300000 },

	// ── SPARK Ada / GNATprove ─────────────────────────────────────────────────
	{ id: 'fv-spark-asild',   name: 'GNATprove ASIL-D Proof',   sector: 'Automotive',          targetLanguage: 'Ada/SPARK', kind: 'spark-ada', description: 'Full proof mode — discharges all proof obligations for ISO 26262 ASIL-D certification',   tags: ['ISO 26262','ASIL-D','Ada','SPARK'],      verifyCommand: 'gnatprove -P ${workspace}/project.gpr --mode=prove --level=4 --output=brief',         timeoutMs: 600000 },
	{ id: 'fv-spark-flow',    name: 'GNATprove Flow Analysis',   sector: 'Generic',             targetLanguage: 'Ada/SPARK', kind: 'spark-ada', description: 'Data and control flow analysis — initialisation and information flow',                     tags: ['flow','Ada','SPARK','DO-178C'],          verifyCommand: 'gnatprove -P ${workspace}/project.gpr --mode=flow',                                   timeoutMs: 120000 },
	{ id: 'fv-spark-do178',   name: 'GNATprove DO-178C Level A', sector: 'Aerospace',           targetLanguage: 'Ada/SPARK', kind: 'spark-ada', description: 'Proof + flow analysis for DO-178C Level A structural coverage',                           tags: ['DO-178C','Level A','Ada','avionics'],    verifyCommand: 'gnatprove -P ${workspace}/project.gpr --mode=all --level=4 --report=all',             timeoutMs: 600000 },

	// ── Dafny ─────────────────────────────────────────────────────────────────
	{ id: 'fv-dafny-verify',  name: 'Dafny Contract Verify',     sector: 'Generic',             targetLanguage: 'Dafny',    kind: 'dafny',     description: 'Verify pre/postconditions, loop invariants, and termination in Dafny source',              tags: ['contracts','invariants','Dafny'],        verifyCommand: 'dafny verify ${workspace}/src',                                                       timeoutMs: 180000 },
	{ id: 'fv-dafny-translate', name: 'Dafny C# Translate+Verify', sector: 'Generic',           targetLanguage: 'C#',       kind: 'dafny',     description: 'Verify and compile Dafny to C# for .NET deployment',                                       tags: ['Dafny','C#','.NET'],                    verifyCommand: 'dafny build --target cs ${workspace}/src',                                            timeoutMs: 240000 },

	// ── TLA+ ──────────────────────────────────────────────────────────────────
	{ id: 'fv-tla-protocol',  name: 'TLA+ Protocol Safety',      sector: 'Telecommunications',  targetLanguage: 'TLA+',     kind: 'tlaplus',   description: 'TLC model check safety + liveness properties of distributed protocol specification',        tags: ['distributed','protocol','TLA+','safety'], verifyCommand: 'tlc ${workspace}/spec/Main.tla -config ${workspace}/spec/Main.cfg -deadlock',        timeoutMs: 600000 },
	{ id: 'fv-tla-consensus', name: 'TLA+ Consensus Algorithm',  sector: 'Generic',             targetLanguage: 'TLA+',     kind: 'tlaplus',   description: 'Verify Paxos / Raft / consensus invariants — agreement, validity, termination',            tags: ['consensus','Raft','Paxos','distributed'], verifyCommand: 'tlc ${workspace}/spec/Consensus.tla -workers 4',                                    timeoutMs: 600000 },

	// ── Alloy ─────────────────────────────────────────────────────────────────
	{ id: 'fv-alloy-model',   name: 'Alloy Model Check',         sector: 'Generic',             targetLanguage: 'Alloy',    kind: 'alloy',     description: 'Bounded relational model checking for access-control and data-model invariants',            tags: ['relational','model','access-control'],  verifyCommand: 'java -cp alloy.jar edu.mit.csail.sdg.alloy4whole.ExampleUsingTheCompiler ${workspace}/model.als', timeoutMs: 120000 },

	// ── Z3 ────────────────────────────────────────────────────────────────────
	{ id: 'fv-z3-smt',        name: 'Z3 SMT-LIB Query',          sector: 'Generic',             targetLanguage: 'SMT-LIB',  kind: 'z3',        description: 'Direct Z3 SMT solver query — satisfiability / validity of logical formulas',               tags: ['SMT','Z3','logic'],                     verifyCommand: 'z3 ${workspace}/query.smt2',                                                          timeoutMs: 60000  },
	{ id: 'fv-z3-security',   name: 'Z3 Security Policy Check',  sector: 'Cybersecurity',       targetLanguage: 'SMT-LIB',  kind: 'z3',        description: 'Verify security policy constraints (firewall rules, access policy) via SMT encoding',       tags: ['security','policy','SMT','Z3'],         verifyCommand: 'z3 -smt2 ${workspace}/policy.smt2',                                                   timeoutMs: 60000  },

	// ── Spin / Promela ────────────────────────────────────────────────────────
	{ id: 'fv-spin-proto',    name: 'Spin Protocol Verify',       sector: 'Telecommunications',  targetLanguage: 'Promela',  kind: 'spin',      description: 'Verify concurrent protocol model — safety, liveness, and deadlock freedom',                tags: ['protocol','concurrent','Promela','Spin'], verifyCommand: 'spin -run -a -ltl ltl_formula ${workspace}/model.pml',                              timeoutMs: 300000 },
	{ id: 'fv-spin-rtos',     name: 'Spin RTOS Task Model',       sector: 'Firmware & Embedded', targetLanguage: 'Promela',  kind: 'spin',      description: 'Model-check RTOS task interactions for deadlock, priority inversion, and scheduling bugs',  tags: ['RTOS','deadlock','priority','Promela'],  verifyCommand: 'spin -run -safety ${workspace}/rtos_model.pml',                                       timeoutMs: 240000 },

	// ── Coq ───────────────────────────────────────────────────────────────────
	{ id: 'fv-coq-proof',     name: 'Coq Theorem Proof',          sector: 'Generic',             targetLanguage: 'Coq',      kind: 'coq',       description: 'Interactive theorem proving — compile and check Coq proof scripts',                         tags: ['theorem','Coq','proof'],                verifyCommand: 'coqc ${workspace}/proofs/*.v',                                                         timeoutMs: 300000 },
	{ id: 'fv-coq-certicrypt', name: 'Coq CertiCrypt Crypto',     sector: 'Cybersecurity',       targetLanguage: 'Coq',      kind: 'coq',       description: 'CertiCrypt framework — machine-checked cryptographic security proofs',                      tags: ['crypto','CertiCrypt','Coq','security'],  verifyCommand: 'coqc -R CertiCrypt CertiCrypt ${workspace}/proofs/*.v',                               timeoutMs: 600000 },

	// ── Isabelle ──────────────────────────────────────────────────────────────
	{ id: 'fv-isabelle',      name: 'Isabelle/HOL Session',       sector: 'Generic',             targetLanguage: 'Isabelle', kind: 'isabelle',  description: 'Build and check Isabelle/HOL theory session — functional correctness proofs',              tags: ['Isabelle','HOL','theorem'],             verifyCommand: 'isabelle build -b ${workspace}/ROOT',                                                 timeoutMs: 600000 },

	// ── Why3 ──────────────────────────────────────────────────────────────────
	{ id: 'fv-why3-driver',   name: 'Why3 Multi-Prover',          sector: 'Generic',             targetLanguage: 'WhyML',    kind: 'why3',      description: 'Deductive verification dispatching to Alt-Ergo, Z3, CVC4 simultaneously',                  tags: ['Why3','WhyML','deductive','multi-prover'], verifyCommand: 'why3 prove -P alt-ergo,z3,cvc4 ${workspace}/src/*.mlw',                            timeoutMs: 300000 },

	// ── Polyspace Code Prover ─────────────────────────────────────────────────
	{ id: 'fv-polyspace-cp-asild', name: 'Polyspace Code Prover ASIL-D', sector: 'Automotive', targetLanguage: 'C/C++', kind: 'polyspace-cp', description: 'Formal proof of absence of runtime errors for ISO 26262 ASIL-D — no red/orange',            tags: ['ISO 26262','ASIL-D','Polyspace','formal'], verifyCommand: 'polyspace-code-prover -sources ${workspace}/src -results-dir .inverse/polyspace-cp', timeoutMs: 600000 },
	{ id: 'fv-polyspace-cp-do178', name: 'Polyspace Code Prover DO-178C', sector: 'Aerospace', targetLanguage: 'C/C++', kind: 'polyspace-cp', description: 'Formal proof for DO-178C Level A avionics software — complete absence of runtime errors',    tags: ['DO-178C','Level A','Polyspace','avionics'], verifyCommand: 'polyspace-code-prover -sources ${workspace}/src -prog-name DO178C -results-dir .inverse/ps', timeoutMs: 600000 },

	// ── Custom ────────────────────────────────────────────────────────────────
	{ id: 'fv-custom-script', name: 'Custom FV Script',           sector: 'Generic',             targetLanguage: 'Any',      kind: 'custom',    description: 'Run any custom formal verification CLI tool or verification script',                         tags: ['custom','script'],                      verifyCommand: '${workspace}/scripts/verify.sh',                                                      timeoutMs: 300000 },
];


// ─── Service interface ────────────────────────────────────────────────────────

export const IFormalVerificationService = createDecorator<IFormalVerificationService>('neuralInverseFormalVerificationService');

export interface IFormalVerificationService {
	readonly _serviceBrand: undefined;

	/** Fires on every session state change */
	readonly onDidSessionUpdate: Event<IFVSession>;

	getSessions(): IFVSession[];
	getPresets(): IFVPreset[];

	createSession(config: Omit<IFVToolConfig, 'id'>): Promise<IFVSession>;
	runSession(sessionId: string): Promise<void>;
	stopSession(sessionId: string): void;
	deleteSession(sessionId: string): void;
	cloneSession(sessionId: string, newName: string): Promise<IFVSession>;
	createSessionFromPreset(preset: IFVPreset): Promise<IFVSession>;
}


// ─── Implementation ───────────────────────────────────────────────────────────

class FormalVerificationService extends Disposable implements IFormalVerificationService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidSessionUpdate = this._register(new Emitter<IFVSession>());
	readonly onDidSessionUpdate: Event<IFVSession> = this._onDidSessionUpdate.event;

	private _sessions = new Map<string, IFVSession>();

	constructor(
		@IGRCEngineService private readonly grcEngine: IGRCEngineService,
		@IExternalCommandExecutor private readonly commandExecutor: IExternalCommandExecutor,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	getSessions(): IFVSession[] {
		return [...this._sessions.values()];
	}

	getPresets(): IFVPreset[] {
		return FV_PRESETS;
	}

	async createSession(config: Omit<IFVToolConfig, 'id'>): Promise<IFVSession> {
		const id = `fv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		const session: IFVSession = {
			config: { ...config, id },
			status: 'idle',
			outputLines: [],
			proofObligations: [],
		};
		this._sessions.set(id, session);
		this._onDidSessionUpdate.fire(session);
		return session;
	}

	async runSession(sessionId: string): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (!session || session.status === 'running') { return; }

		session.status = 'running';
		session.startedAt = Date.now();
		session.outputLines = [];
		session.proofObligations = [];
		session.error = undefined;
		this._onDidSessionUpdate.fire({ ...session });

		try {
			await this._runSessionAsync(session);
		} catch (e: any) {
			this._updateSession(sessionId, { status: 'failed', error: String(e?.message ?? e), completedAt: Date.now() });
		}
	}

	stopSession(sessionId: string): void {
		this._updateSession(sessionId, { status: 'cancelled', completedAt: Date.now() });
	}

	deleteSession(sessionId: string): void {
		this.stopSession(sessionId);
		this._sessions.delete(sessionId);
	}

	async cloneSession(sessionId: string, newName: string): Promise<IFVSession> {
		const src = this._sessions.get(sessionId);
		if (!src) { throw new Error(`Session ${sessionId} not found`); }
		return this.createSession({ ...src.config, name: newName });
	}

	async createSessionFromPreset(preset: IFVPreset): Promise<IFVSession> {
		return this.createSession({
			name: preset.name,
			kind: preset.kind,
			verifyCommand: preset.verifyCommand,
			buildCommand: preset.buildCommand,
			timeoutMs: preset.timeoutMs,
			env: preset.env,
		});
	}

	// ─── Async runner ─────────────────────────────────────────────────────────

	private async _runSessionAsync(session: IFVSession): Promise<void> {
		const { config } = session;
		const workspacePath = this._getWorkspacePath();
		const substituteVars = (cmd: string) => cmd.replace(/\$\{workspace\}/g, workspacePath);

		// Build step (non-fatal)
		if (config.buildCommand) {
			const buildCmd = substituteVars(config.buildCommand);
			try {
				const out = await this.commandExecutor.execute(`fv-build-${config.id}`, buildCmd, config.timeoutMs, undefined, config.env);
				out.split('\n').forEach(l => session.outputLines.push(l));
			} catch (e: any) {
				session.outputLines.push(`[BUILD-WARN] ${String(e?.message ?? e)}`);
			}
			this._onDidSessionUpdate.fire({ ...session });
		}

		// Verify step
		const verifyCmd = substituteVars(config.verifyCommand);
		const out = await this.commandExecutor.execute(`fv-verify-${config.id}`, verifyCmd, config.timeoutMs, undefined, config.env);
		out.split('\n').filter(Boolean).forEach(l => {
			session.outputLines.push(l);
			if (session.outputLines.length > 2000) { session.outputLines.shift(); }
		});
		this._onDidSessionUpdate.fire({ ...session });

		// Parse
		const obligations = parseFVOutput(session.outputLines, config.kind as FVToolKind, config.id, Date.now());
		const injectedCount = this._injectObligations(obligations, config);

		this._updateSession(config.id, {
			status: 'complete',
			completedAt: Date.now(),
			proofObligations: obligations,
			injectedCount,
		});
	}

	private _injectObligations(obligations: IFVProofObligation[], config: IFVToolConfig): number {
		const failed = obligations.filter(o => o.status === 'failed' || o.status === 'error' || o.status === 'unknown');
		if (failed.length === 0) { return 0; }

		const workspacePath = this._getWorkspacePath();
		let count = 0;
		const fileMap = new Map<string, typeof failed>();

		for (const obl of failed) {
			const filePath = obl.file
				? (obl.file.startsWith('/') ? obl.file : `${workspacePath}/${obl.file}`)
				: `${workspacePath}/unknown`;
			if (!fileMap.has(filePath)) { fileMap.set(filePath, []); }
			fileMap.get(filePath)!.push(obl);
		}

		for (const [filePath, obls] of fileMap) {
			const fileUri = URI.file(filePath);
			// Group by ruleId so each call passes a single ruleId
			const byRule = new Map<string, typeof obls>();
			for (const obl of obls) {
				const ruleId = `fv.${config.kind}.${obl.kind}`;
				if (!byRule.has(ruleId)) { byRule.set(ruleId, []); }
				byRule.get(ruleId)!.push(obl);
			}
			for (const [ruleId, ruleObls] of byRule) {
				const results = ruleObls.map(obl => ({
					ruleId,
					domain: 'formal-verification',
					severity: obl.status === 'failed' ? 'error' : 'warning',
					message: obl.message,
					fileUri,
					line: obl.line ?? 1,
					column: 1,
					endLine: obl.line ?? 1,
					endColumn: 1,
					codeSnippet: obl.rawLine.slice(0, 200),
					fix: `Review ${obl.property} — ${obl.tool} reports: ${obl.status}`,
					timestamp: obl.timestamp,
					checkSource: undefined,
				}));
				this.grcEngine.setExternalResults(fileUri, ruleId, results);
				count += results.length;
			}
		}

		return count;
	}

	private _updateSession(sessionId: string, patch: Partial<IFVSession>): void {
		const session = this._sessions.get(sessionId);
		if (!session) { return; }
		Object.assign(session, patch);
		this._onDidSessionUpdate.fire({ ...session });
	}

	private _getWorkspacePath(): string {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri.fsPath : '';
	}
}

registerSingleton(IFormalVerificationService, FormalVerificationService, InstantiationType.Delayed);
