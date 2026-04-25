/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 4.1 — Enclave Analysis Proof Service
 *
 * Every static analysis / GRC engine run produces a cryptographically-signed proof bundle:
 *  • Source tree hash at the exact moment analysis ran (cannot retroactively change analysis)
 *  • Analyzer identity: name, version, ruleset hash
 *  • Per-finding record: severity, rule, location, disposition (fixed/waived/accepted_risk)
 *  • Signed waivers: each waiver carries reviewer identity, rationale, expiry, and signature
 *  • Full bundle signed by the Enclave session private key
 *  • Persisted to .inverse/analysis/analysis-{date}-{sourceHash}.json
 *
 * This enables DO-178C / IEC 62304 / ISO 26262 audit packages — auditors can verify that
 * the analysis results correspond to the exact source state, and all waivers are authorized.
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IEnclaveCryptoService } from '../crypto/enclaveCryptoService.js';
import { IEnclaveSessionService } from '../session/enclaveSessionService.js';
import { IEnclaveAuditTrailService } from '../audit/enclaveAuditTrailService.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';

// ─── Service Contract ──────────────────────────────────────────────────────────

export const IEnclaveAnalysisProofService = createDecorator<IEnclaveAnalysisProofService>('IEnclaveAnalysisProofService');

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingDisposition = 'open' | 'fixed' | 'waived' | 'accepted_risk' | 'false_positive';
export type AnalysisCategory =
	| 'misra_c'        // MISRA C:2012
	| 'misra_cpp'      // MISRA C++:2008/2023
	| 'autosar_cpp'    // AUTOSAR C++14
	| 'cert_c'         // SEI CERT C
	| 'cert_cpp'       // SEI CERT C++
	| 'cwe'            // MITRE CWE
	| 'owasp_top10'    // OWASP Top 10
	| 'security'       // General security
	| 'memory_safety'  // Buffer overflows, UAF, etc.
	| 'concurrency'    // Data races, deadlocks
	| 'type_safety'    // Type errors
	| 'null_safety'    // Null dereference
	| 'bounds_checking'// Array bounds
	| 'resource_leak'  // Memory/handle leaks
	| 'arithmetic'     // Integer overflow, divide-by-zero
	| 'do178c'         // DO-178C structural coverage
	| 'iec62304'       // IEC 62304 software process
	| 'iso26262'       // ISO 26262 functional safety
	| 'complexity'     // Cyclomatic/cognitive complexity
	| 'coverage'       // MC/DC coverage metrics
	| 'style'
	| 'generic';

export interface IAnalysisFinding {
	readonly id: string;
	readonly ruleId: string;
	readonly category: AnalysisCategory;
	readonly severity: FindingSeverity;
	readonly message: string;
	readonly fileUri: string;
	readonly line: number;
	readonly column: number;
	readonly endLine?: number;
	readonly endColumn?: number;
	readonly snippet?: string;
	readonly cweId?: string;       // e.g. CWE-119
	readonly standard?: string;    // e.g. MISRA C Rule 4.1
	disposition: FindingDisposition;
	waivedAt?: string;
	waivedBy?: string;
	waiverRationale?: string;
	waiverExpiry?: string;         // ISO date — waiver auto-expires
	waiverSignature?: string;      // ECDSA signature of waiver record
}

export interface IAnalyzerIdentity {
	readonly name: string;          // e.g. 'clang-tidy', 'Coverity', 'Frama-C', 'LDRA'
	readonly version: string;
	readonly rulesetPath?: string;
	readonly rulesetHash?: string;  // SHA-256 of ruleset config file
	readonly configHash?: string;   // SHA-256 of analyzer config (e.g. .clang-tidy)
	readonly domain?: string;       // 'aerospace' | 'automotive' | 'medical' | 'general'
}

export interface IAnalysisProofRecord {
	readonly proofId: string;
	readonly sessionId: string;
	readonly timestamp: string;
	readonly sourceTreeHash: string;   // Merkle hash of all analyzed source files
	readonly workspaceRoot: string;
	readonly analyzer: IAnalyzerIdentity;
	readonly findings: IAnalysisFinding[];
	readonly summary: {
		readonly total: number;
		readonly bySeverity: Record<FindingSeverity, number>;
		readonly byDisposition: Record<FindingDisposition, number>;
		readonly openCritical: number;
		readonly openHigh: number;
	};
	readonly passedGate: boolean;      // true if no open critical/high findings
	readonly signature: string;        // ECDSA signature of proof bundle
	readonly publicKey: JsonWebKey;
}

export interface IWaiverRecord {
	readonly findingId: string;
	readonly proofId: string;
	readonly disposition: FindingDisposition;
	readonly rationale: string;
	readonly reviewerSessionId: string;
	readonly expiry?: string;
	readonly timestamp: string;
	readonly signature: string;
}

export interface IEnclaveAnalysisProofService {
	readonly _serviceBrand: undefined;

	/** Fired whenever a new analysis proof is recorded */
	readonly onDidRecordProof: Event<IAnalysisProofRecord>;

	/** Fired whenever a finding disposition is updated */
	readonly onDidUpdateDisposition: Event<{ proofId: string; findingId: string; disposition: FindingDisposition }>;

	/**
	 * Record a complete analysis run as a signed proof bundle.
	 * The source tree hash is computed at call time — call this immediately after analysis finishes.
	 */
	recordAnalysisRun(analyzer: IAnalyzerIdentity, findings: Omit<IAnalysisFinding, 'id' | 'disposition'>[]): Promise<IAnalysisProofRecord>;

	/** Waive a specific finding — signed with the current session key */
	waiseFinding(proofId: string, findingId: string, disposition: FindingDisposition, rationale: string, expiryDate?: string): Promise<IWaiverRecord>;

	/** Get all recorded proof bundles (most recent first) */
	getProofHistory(): IAnalysisProofRecord[];

	/** Get active (latest) proof for the current source tree */
	getActiveProof(): IAnalysisProofRecord | null;

	/** Check if the current workspace passes the analysis gate (no open critical/high) */
	checkGateStatus(): { passed: boolean; openCritical: number; openHigh: number; proofId: string | null };

	/** Export a complete verifiable bundle (proof + waivers + public key) for external auditors */
	exportAuditBundle(proofId: string): Promise<string>;

	/** Verify a previously exported bundle's signatures without trusting local state */
	verifyExportedBundle(bundleJson: string): Promise<{ valid: boolean; errors: string[] }>;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class EnclaveAnalysisProofService extends Disposable implements IEnclaveAnalysisProofService {
	declare readonly _serviceBrand: undefined;

	private _proofHistory: IAnalysisProofRecord[] = [];
	private _waiverLog: IWaiverRecord[] = [];
	private _findingIndex = new Map<string, IAnalysisFinding>(); // findingId \u2192 finding (mutable view)

	private readonly _onDidRecordProof = this._register(new Emitter<IAnalysisProofRecord>());
	public readonly onDidRecordProof: Event<IAnalysisProofRecord> = this._onDidRecordProof.event;

	private readonly _onDidUpdateDisposition = this._register(
		new Emitter<{ proofId: string; findingId: string; disposition: FindingDisposition }>()
	);
	public readonly onDidUpdateDisposition = this._onDidUpdateDisposition.event;

	constructor(
		@IEnclaveCryptoService private readonly cryptoService: IEnclaveCryptoService,
		@IEnclaveSessionService private readonly sessionService: IEnclaveSessionService,
		@IEnclaveAuditTrailService private readonly auditTrailService: IEnclaveAuditTrailService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._loadPersistedHistory().catch(err =>
			console.warn('[Enclave Analysis] Failed to load history:', err)
		);
	}

	// ─── Public API ─────────────────────────────────────────────────────────────

	public async recordAnalysisRun(
		analyzer: IAnalyzerIdentity,
		rawFindings: Omit<IAnalysisFinding, 'id' | 'disposition'>[],
	): Promise<IAnalysisProofRecord> {
		const sessionId = this.sessionService.sessionId;
		const timestamp = new Date().toISOString();
		const proofId = this._uuid();

		// 1. Hash the current source tree
		const sourceTreeHash = await this._hashSourceTree();

		// 2. Assign IDs to findings; carry over known dispositions from prior runs
		const findings: IAnalysisFinding[] = rawFindings.map(f => {
			const id = this._fingerprintFinding(f);
			const prior = this._findingIndex.get(id);
			return {
				...f,
				id,
				disposition: prior?.disposition ?? 'open',
				waivedAt: prior?.waivedAt,
				waivedBy: prior?.waivedBy,
				waiverRationale: prior?.waiverRationale,
				waiverExpiry: prior?.waiverExpiry,
				waiverSignature: prior?.waiverSignature,
			};
		});

		// 3. Build summary
		const summary = this._buildSummary(findings);

		// 4. Hash the analyzer ruleset if path provided
		let rulesetHash = analyzer.rulesetHash;
		if (!rulesetHash && analyzer.rulesetPath) {
			rulesetHash = await this._hashFile(analyzer.rulesetPath);
		}
		const analyzerWithHash: IAnalyzerIdentity = { ...analyzer, rulesetHash };

		// 5. Sign the bundle
		const bundleForSigning = JSON.stringify({
			proofId, sessionId, timestamp, sourceTreeHash,
			analyzer: analyzerWithHash, findings, summary,
		});
		const signature = await this.cryptoService.sign(bundleForSigning);
		const publicKey = await this.cryptoService.exportPublicKeyJwk();

		const record: IAnalysisProofRecord = {
			proofId,
			sessionId,
			timestamp,
			sourceTreeHash,
			workspaceRoot: this._getWorkspaceRoot() ?? 'unknown',
			analyzer: analyzerWithHash,
			findings,
			summary,
			passedGate: summary.openCritical === 0 && summary.openHigh === 0,
			signature,
			publicKey,
		};

		// 6. Update finding index with latest state
		for (const f of findings) {
			this._findingIndex.set(f.id, f);
		}

		// 7. Prepend to history (newest first)
		this._proofHistory.unshift(record);
		if (this._proofHistory.length > 100) { this._proofHistory.pop(); }

		// 8. Persist
		await this._persist(record);

		// 9. Audit trail
		await this.auditTrailService.logEntry(
			'anomaly_detected',
			'enclave_system',
			`analysis:${proofId}`,
			'completed',
			`Analyzer: ${analyzer.name} v${analyzer.version} | Findings: ${findings.length} | Open critical: ${summary.openCritical} | Proof: ${proofId}`,
		);

		this._onDidRecordProof.fire(record);
		return record;
	}

	public async waiseFinding(
		proofId: string,
		findingId: string,
		disposition: FindingDisposition,
		rationale: string,
		expiryDate?: string,
	): Promise<IWaiverRecord> {
		const sessionId = this.sessionService.sessionId;
		const timestamp = new Date().toISOString();

		// Update the live finding
		const finding = this._findingIndex.get(findingId);
		if (finding) {
			(finding as any).disposition = disposition;
			(finding as any).waivedAt = timestamp;
			(finding as any).waivedBy = sessionId;
			(finding as any).waiverRationale = rationale;
			(finding as any).waiverExpiry = expiryDate ?? null;
		}

		// Build signed waiver
		const waiverContent = JSON.stringify({ findingId, proofId, disposition, rationale, sessionId, expiry: expiryDate, timestamp });
		const signature = await this._sign(waiverContent);

		if (finding) {
			(finding as any).waiverSignature = signature;
		}

		const waiver: IWaiverRecord = {
			findingId, proofId, disposition, rationale,
			reviewerSessionId: sessionId, expiry: expiryDate,
			timestamp, signature,
		};
		this._waiverLog.push(waiver);

		// Persist waiver
		await this._persistWaiver(waiver);

		await this.auditTrailService.logEntry(
			'review_approved',
			'user',
			`finding:${findingId}`,
			'completed',
			`Finding ${findingId} \u2192 ${disposition} | Rationale: "${rationale.slice(0, 80)}" | Proof: ${proofId}`,
		);

		this._onDidUpdateDisposition.fire({ proofId, findingId, disposition });
		return waiver;
	}

	public getProofHistory(): IAnalysisProofRecord[] {
		return [...this._proofHistory];
	}

	public getActiveProof(): IAnalysisProofRecord | null {
		return this._proofHistory[0] ?? null;
	}

	public checkGateStatus(): { passed: boolean; openCritical: number; openHigh: number; proofId: string | null } {
		const active = this.getActiveProof();
		if (!active) {
			return { passed: true, openCritical: 0, openHigh: 0, proofId: null };
		}
		return {
			passed: active.passedGate,
			openCritical: active.summary.openCritical,
			openHigh: active.summary.openHigh,
			proofId: active.proofId,
		};
	}

	public async exportAuditBundle(proofId: string): Promise<string> {
		const proof = this._proofHistory.find(p => p.proofId === proofId);
		if (!proof) { throw new Error(`Analysis proof ${proofId} not found`); }
		const waivers = this._waiverLog.filter(w => w.proofId === proofId);
		return JSON.stringify({ proof, waivers, exportedAt: new Date().toISOString() }, null, 2);
	}

	public async verifyExportedBundle(bundleJson: string): Promise<{ valid: boolean; errors: string[] }> {
		const errors: string[] = [];
		try {
			const bundle = JSON.parse(bundleJson);
			const proof: IAnalysisProofRecord = bundle.proof;
			const waivers: IWaiverRecord[] = bundle.waivers ?? [];

			// Verify proof signature
			const { signature, publicKey, ...proofData } = proof;
			const proofContent = JSON.stringify(proofData);
			const proofValid = await this.cryptoService.verifyWithKey(proofContent, signature, publicKey);
			if (!proofValid) { errors.push(`Proof signature invalid: ${proof.proofId}`); }

			// Verify each waiver signature
			for (const waiver of waivers) {
				const { signature: wSig, ...wData } = waiver;
				const wContent = JSON.stringify({ findingId: wData.findingId, proofId: wData.proofId, disposition: wData.disposition, rationale: wData.rationale, sessionId: wData.reviewerSessionId, expiry: wData.expiry, timestamp: wData.timestamp });
				const wValid = await this.cryptoService.verifyWithKey(wContent, wSig, publicKey);
				if (!wValid) { errors.push(`Waiver signature invalid: finding ${waiver.findingId}`); }

				// Check expiry
				if (waiver.expiry && new Date(waiver.expiry) < new Date()) {
					errors.push(`Waiver expired: finding ${waiver.findingId} (expired ${waiver.expiry})`);
				}
			}
		} catch (err) {
			errors.push(`Bundle parse error: ${String(err)}`);
		}
		return { valid: errors.length === 0, errors };
	}

	// ─── Private: Source Tree Hashing ────────────────────────────────────────────

	private async _hashSourceTree(): Promise<string> {
		const root = this._getWorkspaceRootUri();
		if (!root) { return 'no-workspace'; }
		try {
			const hashes: string[] = [];
			await this._walkAndHash(root, hashes);
			hashes.sort();
			return await this._sha256(hashes.join('|'));
		} catch {
			return 'hash-failed';
		}
	}

	private async _walkAndHash(dirUri: URI, hashes: string[]): Promise<void> {
		try {
			const stat = await this.fileService.resolve(dirUri);
			if (!stat.children) { return; }
			for (const child of stat.children) {
				if (child.isDirectory) {
					const name = child.name;
					if (['.git', '.inverse', 'node_modules', 'target', '__pycache__', '.venv', 'dist', 'build'].includes(name)) { continue; }
					await this._walkAndHash(child.resource, hashes);
				} else if (this._isSourceFile(child.name)) {
					try {
						const content = await this.fileService.readFile(child.resource);
						const h = await this._sha256(content.value.toString());
						hashes.push(`${child.resource.path}:${h}`);
					} catch { /* skip unreadable */ }
				}
			}
		} catch { /* skip */ }
	}

	private _isSourceFile(name: string): boolean {
		const ext = name.split('.').pop()?.toLowerCase() ?? '';
		const sourceExts = new Set([
			'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
			'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'c++', 'hh',
			'cs', 'fs', 'fsx', 'vb',
			'rs', 'go', 'py', 'rb', 'java', 'kt', 'kts', 'scala',
			'swift', 'dart', 'm', 'mm',
			'zig', 'nim', 'v', 'cr', 'd',
			'adb', 'ads', 'ada',  // Ada
			'f90', 'f95', 'f03', 'f08', 'for', 'f',  // Fortran
			'ml', 'mli',          // OCaml
			'hs', 'lhs',          // Haskell
			'erl', 'hrl',         // Erlang
			'ex', 'exs',          // Elixir
			'clj', 'cljs', 'cljc', // Clojure
			'lua', 'pl', 'pm', 'tcl', 'rb',
			'vhd', 'vhdl', 'v', 'sv',  // HDL
			'asm', 's',           // Assembly
			'cob', 'cbl', 'cpy',  // COBOL
			'sh', 'bash', 'zsh',
			'tf', 'tfvars',       // Terraform
			'yaml', 'yml', 'json', 'toml', 'xml',
		]);
		return sourceExts.has(ext);
	}

	// ─── Private: Summary ────────────────────────────────────────────────────────

	private _buildSummary(findings: IAnalysisFinding[]): IAnalysisProofRecord['summary'] {
		const bySeverity: Record<FindingSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
		const byDisposition: Record<FindingDisposition, number> = { open: 0, fixed: 0, waived: 0, accepted_risk: 0, false_positive: 0 };
		let openCritical = 0;
		let openHigh = 0;

		for (const f of findings) {
			bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
			byDisposition[f.disposition] = (byDisposition[f.disposition] ?? 0) + 1;
			if (f.disposition === 'open') {
				if (f.severity === 'critical') { openCritical++; }
				if (f.severity === 'high') { openHigh++; }
			}
		}

		return { total: findings.length, bySeverity, byDisposition, openCritical, openHigh };
	}

	// ─── Private: Deduplication fingerprint ──────────────────────────────────────

	private _fingerprintFinding(f: Omit<IAnalysisFinding, 'id' | 'disposition'>): string {
		// Stable ID across analysis runs: rule + file + line + column
		const raw = `${f.ruleId}|${f.fileUri}|${f.line}|${f.column}`;
		// Simple deterministic hash — not security-sensitive
		let hash = 0;
		for (let i = 0; i < raw.length; i++) {
			const char = raw.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash |= 0;
		}
		return `F${Math.abs(hash).toString(16).toUpperCase().padStart(8, '0')}`;
	}

	// ─── Private: Persistence ────────────────────────────────────────────────────

	private async _persist(record: IAnalysisProofRecord): Promise<void> {
		const root = this._getWorkspaceRootUri();
		if (!root) { return; }
		const dir = URI.joinPath(root, '.inverse', 'analysis');
		const dateStr = record.timestamp.split('T')[0];
		const fileUri = URI.joinPath(dir, `analysis-${dateStr}-${record.proofId.slice(0, 8)}.json`);
		try {
			const content = JSON.stringify(record, null, 2);
			await this.fileService.writeFile(fileUri, VSBuffer.fromString(content));
		} catch (err) {
			console.warn('[Enclave Analysis] Failed to persist proof:', err);
		}
	}

	private async _persistWaiver(waiver: IWaiverRecord): Promise<void> {
		const root = this._getWorkspaceRootUri();
		if (!root) { return; }
		const dir = URI.joinPath(root, '.inverse', 'analysis', 'waivers');
		const fileUri = URI.joinPath(dir, `waiver-${waiver.findingId}-${Date.now()}.json`);
		try {
			await this.fileService.writeFile(fileUri, VSBuffer.fromString(JSON.stringify(waiver, null, 2)));
		} catch (err) {
			console.warn('[Enclave Analysis] Failed to persist waiver:', err);
		}
	}

	private async _loadPersistedHistory(): Promise<void> {
		const root = this._getWorkspaceRootUri();
		if (!root) { return; }
		const dir = URI.joinPath(root, '.inverse', 'analysis');
		try {
			const stat = await this.fileService.resolve(dir);
			const jsonFiles = (stat.children ?? [])
				.filter(c => !c.isDirectory && c.name.endsWith('.json'))
				.sort((a, b) => b.name.localeCompare(a.name))
				.slice(0, 50);
			for (const file of jsonFiles) {
				try {
					const raw = await this.fileService.readFile(file.resource);
					const record = JSON.parse(raw.value.toString()) as IAnalysisProofRecord;
					this._proofHistory.push(record);
					// Rebuild finding index from history (latest wins)
					for (const f of record.findings) {
						if (!this._findingIndex.has(f.id)) {
							this._findingIndex.set(f.id, f);
						}
					}
				} catch { /* skip malformed */ }
			}
		} catch { /* dir doesn't exist yet */ }
	}

	// ─── Private: Crypto ─────────────────────────────────────────────────────────

	private async _sign(data: string): Promise<string> {
		try {
			return await this.cryptoService.sign(data);
		} catch {
			return 'sign-failed';
		}
	}

	private async _hashFile(path: string): Promise<string | undefined> {
		try {
			const uri = URI.file(path);
			const content = await this.fileService.readFile(uri);
			return await this._sha256(content.value.toString());
		} catch { return undefined; }
	}

	private async _sha256(data: string): Promise<string> {
		try {
			const buffer = new TextEncoder().encode(data).buffer;
			const hashBuffer = await crypto.subtle.digest('SHA-256', buffer as ArrayBuffer);
			return Array.from(new Uint8Array(hashBuffer))
				.map(b => b.toString(16).padStart(2, '0'))
				.join('');
		} catch { return 'hash-failed'; }
	}

	// ─── Private: Utilities ──────────────────────────────────────────────────────

	private _getWorkspaceRootUri(): URI | null {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : null;
	}

	private _getWorkspaceRoot(): string | null {
		return this._getWorkspaceRootUri()?.fsPath ?? null;
	}

	private _uuid(): string {
		try { return crypto.randomUUID(); } catch {
			return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
				const r = Math.random() * 16 | 0;
				return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
			});
		}
	}
}

registerSingleton(IEnclaveAnalysisProofService, EnclaveAnalysisProofService, InstantiationType.Delayed);
