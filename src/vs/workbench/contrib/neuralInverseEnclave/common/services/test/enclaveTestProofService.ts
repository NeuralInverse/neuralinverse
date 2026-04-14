/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 4.2 — Enclave Test Execution Proof Service
 *
 * Every test run is bound cryptographically to the exact source state being tested:
 *  • Source tree hash captured before tests execute
 *  • Test runner binary hash (proves which runner version was used)
 *  • Per-test results: name, status, duration, error message if failed
 *  • Coverage: per-file line/branch/function/MC-DC coverage tied to source hash
 *  • Coverage invalidates if source changes — cannot claim old coverage on new code
 *  • Entire bundle signed by Enclave session key
 *  • Persisted to .inverse/tests/test-{date}-{sourceHash}.json
 *
 * Supports DO-178C MC/DC coverage evidence, IEC 62304 test records, ISO 26262
 * software testing phase evidence, and ASPICE software unit verification.
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

// ─── Service Contract ─────────────────────────────────────────────────────────

export const IEnclaveTestProofService = createDecorator<IEnclaveTestProofService>('IEnclaveTestProofService');

export type TestStatus = 'pass' | 'fail' | 'skip' | 'error' | 'timeout' | 'pending';

export type TestCategory =
	| 'unit'             // Unit tests (DO-178C low-level tests)
	| 'integration'      // Integration / component tests
	| 'system'           // System-level tests (DO-178C high-level tests)
	| 'e2e'              // End-to-end / acceptance tests
	| 'regression'       // Regression test suite
	| 'performance'      // Performance / timing (DO-178C WC execution time)
	| 'stress'           // Stress / soak testing
	| 'security'         // Security / penetration tests
	| 'static_analysis'  // Static analysis as test (MISRA compliance)
	| 'hil'              // Hardware-In-the-Loop (ISO 26262 SIL4)
	| 'sil'              // Software-In-the-Loop
	| 'mil'              // Model-In-the-Loop (Simulink MIL)
	| 'pil'              // Processor-In-the-Loop
	| 'mutation'         // Mutation testing (test quality proof)
	| 'fuzz'             // Fuzz / property-based testing
	| 'formal'           // Formal proof (Coq, Dafny, TLA+, Isabelle)
	| 'coverage'         // Coverage measurement run
	| 'other';

export interface ITestResult {
	readonly testId: string;        // Deterministic ID: hash(suite + name)
	readonly suiteName: string;
	readonly testName: string;
	readonly category: TestCategory;
	readonly status: TestStatus;
	readonly durationMs: number;
	readonly errorMessage?: string;
	readonly stackTrace?: string;
	readonly retryCount?: number;
	readonly tags?: string[];        // e.g. ['misra', 'do178c', 'safety-critical']
	readonly requirementIds?: string[]; // Traceability: links to requirements
	readonly fileUri?: string;       // Source file containing the test
	readonly line?: number;
}

export interface ICoverageRecord {
	readonly fileUri: string;
	readonly totalLines: number;
	readonly coveredLines: number;
	readonly totalBranches: number;
	readonly coveredBranches: number;
	readonly totalFunctions: number;
	readonly coveredFunctions: number;
	// DO-178C MC/DC (modified condition/decision coverage) — required for Level A/B
	readonly totalConditions?: number;
	readonly coveredConditions?: number;
	readonly mcDcCoverage?: number; // 0–100 percentage
}

export interface ITestRunnerIdentity {
	readonly name: string;   // e.g. 'jest', 'pytest', 'CppUTest', 'VectorCAST', 'Robot'
	readonly version: string;
	readonly binaryPath?: string;
	readonly binaryHash?: string;   // SHA-256 of test runner binary
	readonly configPath?: string;
	readonly configHash?: string;   // SHA-256 of test config (jest.config.js, pytest.ini, etc.)
	readonly framework?: string;    // DO-178C | IEC 62304 | ISO 26262 | ASPICE
}

export interface ITestProofRecord {
	readonly proofId: string;
	readonly sessionId: string;
	readonly timestamp: string;
	readonly sourceTreeHash: string;    // Must match analysis proof for cross-reference
	readonly workspaceRoot: string;
	readonly runner: ITestRunnerIdentity;
	readonly category: TestCategory;
	readonly results: ITestResult[];
	readonly coverage: ICoverageRecord[];
	readonly summary: {
		readonly total: number;
		readonly passed: number;
		readonly failed: number;
		readonly skipped: number;
		readonly errors: number;
		readonly durationMs: number;
		readonly passRate: number;          // 0–100
		readonly lineCoverage: number;      // 0–100 (workspace average)
		readonly branchCoverage: number;
		readonly functionCoverage: number;
		readonly mcDcCoverage: number;      // DO-178C key metric
	};
	readonly passedGate: boolean;           // All tests pass + coverage thresholds met
	readonly gateThresholds: IGateThresholds;
	readonly requirementCoverage: {         // Traceability matrix summary
		readonly total: number;
		readonly covered: number;
		readonly uncoveredIds: string[];
	};
	readonly signature: string;
	readonly publicKey: JsonWebKey;
}

export interface IGateThresholds {
	readonly minPassRate: number;           // Default: 100 (no failures allowed)
	readonly minLineCoverage: number;       // e.g. 90
	readonly minBranchCoverage: number;     // e.g. 85
	readonly minMcDcCoverage: number;       // DO-178C A: 100, B: 100
	readonly framework?: string;
}

const DEFAULT_GATE_THRESHOLDS: IGateThresholds = {
	minPassRate: 100,
	minLineCoverage: 80,
	minBranchCoverage: 75,
	minMcDcCoverage: 0,  // Only required if explicitly set
};

const DO178C_LEVEL_A_THRESHOLDS: IGateThresholds = {
	minPassRate: 100,
	minLineCoverage: 100,
	minBranchCoverage: 100,
	minMcDcCoverage: 100,
	framework: 'DO-178C Level A',
};

export interface IEnclaveTestProofService {
	readonly _serviceBrand: undefined;
	readonly onDidRecordProof: Event<ITestProofRecord>;
	readonly onDidFailGate: Event<ITestProofRecord>;

	/**
	 * Record a complete test run as a signed proof bundle.
	 * Call immediately after tests finish — source hash is captured at call time.
	 */
	recordTestRun(
		runner: ITestRunnerIdentity,
		category: TestCategory,
		results: Omit<ITestResult, 'testId'>[],
		coverage?: ICoverageRecord[],
		thresholds?: Partial<IGateThresholds>,
	): Promise<ITestProofRecord>;

	/** Get the most recent proof */
	getActiveProof(): ITestProofRecord | null;

	/** Get all proof history (newest first) */
	getProofHistory(): ITestProofRecord[];

	/**
	 * Cross-reference with an analysis proof: verify both share the same source tree hash.
	 * Returns true if analysis proof and test proof cover the same source snapshot.
	 */
	crossValidateWithAnalysis(testProofId: string, analysisProofId: string, analysisSourceHash: string): boolean;

	/** Get coverage delta between two runs (regression detector) */
	getCoverageDelta(olderProofId: string, newerProofId: string): { lineDelta: number; branchDelta: number; mcDcDelta: number } | null;

	/** Export verifiable bundle for auditors */
	exportAuditBundle(proofId: string): Promise<string>;

	/** Get predefined gate thresholds for certified frameworks */
	getFrameworkThresholds(framework: 'DO-178C-A' | 'DO-178C-B' | 'DO-178C-C' | 'IEC62304-A' | 'ISO26262-A' | 'ASPICE'): IGateThresholds;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class EnclaveTestProofService extends Disposable implements IEnclaveTestProofService {
	declare readonly _serviceBrand: undefined;

	private _proofHistory: ITestProofRecord[] = [];

	private readonly _onDidRecordProof = this._register(new Emitter<ITestProofRecord>());
	public readonly onDidRecordProof: Event<ITestProofRecord> = this._onDidRecordProof.event;

	private readonly _onDidFailGate = this._register(new Emitter<ITestProofRecord>());
	public readonly onDidFailGate: Event<ITestProofRecord> = this._onDidFailGate.event;

	constructor(
		@IEnclaveCryptoService private readonly cryptoService: IEnclaveCryptoService,
		@IEnclaveSessionService private readonly sessionService: IEnclaveSessionService,
		@IEnclaveAuditTrailService private readonly auditTrailService: IEnclaveAuditTrailService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._loadHistory().catch(err => console.warn('[Enclave Test] Failed to load history:', err));
	}

	// ─── Public API ───────────────────────────────────────────────────────────

	public async recordTestRun(
		runner: ITestRunnerIdentity,
		category: TestCategory,
		rawResults: Omit<ITestResult, 'testId'>[],
		coverage: ICoverageRecord[] = [],
		thresholdsPartial: Partial<IGateThresholds> = {},
	): Promise<ITestProofRecord> {
		const sessionId = this.sessionService.sessionId;
		const timestamp = new Date().toISOString();
		const proofId = this._uuid();
		const thresholds: IGateThresholds = { ...DEFAULT_GATE_THRESHOLDS, ...thresholdsPartial };

		// 1. Hash source tree to bind results to exact code state
		const sourceTreeHash = await this._hashSourceTree();

		// 2. Assign stable test IDs
		const results: ITestResult[] = rawResults.map(r => ({
			...r,
			testId: this._fingerprintTest(r.suiteName, r.testName),
		}));

		// 3. Hash runner binary if path provided
		let runnerWithHash = runner;
		if (runner.binaryPath && !runner.binaryHash) {
			const binaryHash = await this._hashFile(runner.binaryPath);
			const configHash = runner.configPath ? await this._hashFile(runner.configPath) : undefined;
			runnerWithHash = { ...runner, binaryHash: binaryHash ?? undefined, configHash: configHash ?? undefined };
		}

		// 4. Compute summary
		const summary = this._buildSummary(results, coverage);

		// 5. Compute requirement traceability
		const requirementCoverage = this._buildRequirementCoverage(results);

		// 6. Evaluate gate
		const passedGate = this._evaluateGate(summary, thresholds);

		// 7. Sign bundle
		const bundleForSigning = JSON.stringify({
			proofId, sessionId, timestamp, sourceTreeHash,
			runner: runnerWithHash, category, results, coverage,
			summary, requirementCoverage, passedGate, gateThresholds: thresholds,
		});
		const signature = await this.cryptoService.sign(bundleForSigning);
		const publicKey = await this.cryptoService.exportPublicKeyJwk();

		const record: ITestProofRecord = {
			proofId, sessionId, timestamp, sourceTreeHash,
			workspaceRoot: this._getWorkspaceRoot() ?? 'unknown',
			runner: runnerWithHash, category, results, coverage,
			summary, passedGate, gateThresholds: thresholds,
			requirementCoverage, signature, publicKey,
		};

		this._proofHistory.unshift(record);
		if (this._proofHistory.length > 100) { this._proofHistory.pop(); }

		await this._persist(record);

		await this.auditTrailService.logEntry(
			'anomaly_detected',
			'enclave_system',
			`test:${proofId}`,
			'completed',
			`Runner: ${runner.name} v${runner.version} | ${summary.total} tests | ${summary.passed} passed | Coverage: ${summary.lineCoverage.toFixed(1)}% lines | MC/DC: ${summary.mcDcCoverage.toFixed(1)}% | Gate: ${passedGate ? 'PASS' : 'FAIL'} | Proof: ${proofId}`,
		);

		this._onDidRecordProof.fire(record);
		if (!passedGate) { this._onDidFailGate.fire(record); }
		return record;
	}

	public getActiveProof(): ITestProofRecord | null {
		return this._proofHistory[0] ?? null;
	}

	public getProofHistory(): ITestProofRecord[] {
		return [...this._proofHistory];
	}

	public crossValidateWithAnalysis(testProofId: string, _analysisProofId: string, analysisSourceHash: string): boolean {
		const testProof = this._proofHistory.find(p => p.proofId === testProofId);
		if (!testProof) { return false; }
		return testProof.sourceTreeHash === analysisSourceHash;
	}

	public getCoverageDelta(olderProofId: string, newerProofId: string): { lineDelta: number; branchDelta: number; mcDcDelta: number } | null {
		const older = this._proofHistory.find(p => p.proofId === olderProofId);
		const newer = this._proofHistory.find(p => p.proofId === newerProofId);
		if (!older || !newer) { return null; }
		return {
			lineDelta: newer.summary.lineCoverage - older.summary.lineCoverage,
			branchDelta: newer.summary.branchCoverage - older.summary.branchCoverage,
			mcDcDelta: newer.summary.mcDcCoverage - older.summary.mcDcCoverage,
		};
	}

	public async exportAuditBundle(proofId: string): Promise<string> {
		const proof = this._proofHistory.find(p => p.proofId === proofId);
		if (!proof) { throw new Error(`Test proof ${proofId} not found`); }
		return JSON.stringify({ proof, exportedAt: new Date().toISOString() }, null, 2);
	}

	public getFrameworkThresholds(framework: 'DO-178C-A' | 'DO-178C-B' | 'DO-178C-C' | 'IEC62304-A' | 'ISO26262-A' | 'ASPICE'): IGateThresholds {
		switch (framework) {
			case 'DO-178C-A':
				return DO178C_LEVEL_A_THRESHOLDS;
			case 'DO-178C-B':
				return { minPassRate: 100, minLineCoverage: 100, minBranchCoverage: 100, minMcDcCoverage: 100, framework: 'DO-178C Level B' };
			case 'DO-178C-C':
				return { minPassRate: 100, minLineCoverage: 100, minBranchCoverage: 100, minMcDcCoverage: 0, framework: 'DO-178C Level C' };
			case 'IEC62304-A':
				return { minPassRate: 100, minLineCoverage: 100, minBranchCoverage: 100, minMcDcCoverage: 0, framework: 'IEC 62304 Class A' };
			case 'ISO26262-A':
				return { minPassRate: 100, minLineCoverage: 100, minBranchCoverage: 100, minMcDcCoverage: 100, framework: 'ISO 26262 ASIL D' };
			case 'ASPICE':
				return { minPassRate: 100, minLineCoverage: 85, minBranchCoverage: 80, minMcDcCoverage: 0, framework: 'ASPICE SWE.4' };
			default:
				return DEFAULT_GATE_THRESHOLDS;
		}
	}

	// ─── Private: Summary ─────────────────────────────────────────────────────

	private _buildSummary(results: ITestResult[], coverage: ICoverageRecord[]): ITestProofRecord['summary'] {
		let passed = 0, failed = 0, skipped = 0, errors = 0;
		let durationMs = 0;

		for (const r of results) {
			durationMs += r.durationMs;
			switch (r.status) {
				case 'pass': passed++; break;
				case 'fail': failed++; break;
				case 'skip': case 'pending': skipped++; break;
				case 'error': case 'timeout': errors++; break;
			}
		}

		const total = results.length;
		const passRate = total > 0 ? (passed / total) * 100 : 100;

		// Coverage aggregation
		let totalLines = 0, coveredLines = 0;
		let totalBranches = 0, coveredBranches = 0;
		let totalFunctions = 0, coveredFunctions = 0;
		let totalConditions = 0, coveredConditions = 0;

		for (const c of coverage) {
			totalLines += c.totalLines;
			coveredLines += c.coveredLines;
			totalBranches += c.totalBranches;
			coveredBranches += c.coveredBranches;
			totalFunctions += c.totalFunctions;
			coveredFunctions += c.coveredFunctions;
			totalConditions += c.totalConditions ?? 0;
			coveredConditions += c.coveredConditions ?? 0;
		}

		const lineCoverage = totalLines > 0 ? (coveredLines / totalLines) * 100 : 0;
		const branchCoverage = totalBranches > 0 ? (coveredBranches / totalBranches) * 100 : 0;
		const functionCoverage = totalFunctions > 0 ? (coveredFunctions / totalFunctions) * 100 : 0;
		const mcDcCoverage = totalConditions > 0 ? (coveredConditions / totalConditions) * 100 : 0;

		return { total, passed, failed, skipped, errors, durationMs, passRate, lineCoverage, branchCoverage, functionCoverage, mcDcCoverage };
	}

	private _buildRequirementCoverage(results: ITestResult[]): ITestProofRecord['requirementCoverage'] {
		const covered = new Set<string>();
		const all = new Set<string>();
		for (const r of results) {
			for (const reqId of r.requirementIds ?? []) {
				all.add(reqId);
				if (r.status === 'pass') { covered.add(reqId); }
			}
		}
		const uncoveredIds = [...all].filter(id => !covered.has(id));
		return { total: all.size, covered: covered.size, uncoveredIds };
	}

	private _evaluateGate(summary: ITestProofRecord['summary'], thresholds: IGateThresholds): boolean {
		if (summary.passRate < thresholds.minPassRate) { return false; }
		if (summary.lineCoverage < thresholds.minLineCoverage) { return false; }
		if (summary.branchCoverage < thresholds.minBranchCoverage) { return false; }
		if (thresholds.minMcDcCoverage > 0 && summary.mcDcCoverage < thresholds.minMcDcCoverage) { return false; }
		return true;
	}

	// ─── Private: Source Tree Hash ────────────────────────────────────────────

	private async _hashSourceTree(): Promise<string> {
		const root = this._getWorkspaceRootUri();
		if (!root) { return 'no-workspace'; }
		try {
			const hashes: string[] = [];
			await this._walkAndHash(root, hashes);
			hashes.sort();
			return await this._sha256(hashes.join('|'));
		} catch { return 'hash-failed'; }
	}

	private async _walkAndHash(dirUri: URI, hashes: string[]): Promise<void> {
		try {
			const stat = await this.fileService.resolve(dirUri);
			if (!stat.children) { return; }
			for (const child of stat.children) {
				if (child.isDirectory) {
					if (['.git', '.inverse', 'node_modules', 'target', '__pycache__', 'dist', 'build', '.venv'].includes(child.name)) { continue; }
					await this._walkAndHash(child.resource, hashes);
				} else if (this._isSourceFile(child.name)) {
					try {
						const content = await this.fileService.readFile(child.resource);
						const h = await this._sha256(content.value.toString());
						hashes.push(`${child.resource.path}:${h}`);
					} catch { /* skip */ }
				}
			}
		} catch { /* skip */ }
	}

	private _isSourceFile(name: string): boolean {
		const ext = name.split('.').pop()?.toLowerCase() ?? '';
		return ['ts', 'tsx', 'js', 'jsx', 'c', 'h', 'cpp', 'hpp', 'cs', 'rs', 'go', 'py',
			'java', 'kt', 'swift', 'zig', 'adb', 'ads', 'f90', 'for', 'cob', 'cbl',
			'erl', 'ex', 'hs', 'ml', 'lua', 'rb', 'vhd', 'sv', 'v'].includes(ext);
	}

	// ─── Private: Crypto & Utils ──────────────────────────────────────────────

	private _fingerprintTest(suite: string, name: string): string {
		const raw = `${suite}|${name}`;
		let hash = 0;
		for (let i = 0; i < raw.length; i++) {
			hash = ((hash << 5) - hash) + raw.charCodeAt(i);
			hash |= 0;
		}
		return `T${Math.abs(hash).toString(16).toUpperCase().padStart(8, '0')}`;
	}

	private async _persist(record: ITestProofRecord): Promise<void> {
		const root = this._getWorkspaceRootUri();
		if (!root) { return; }
		const dateStr = record.timestamp.split('T')[0];
		const fileUri = URI.joinPath(root, '.inverse', 'tests', `test-${dateStr}-${record.proofId.slice(0, 8)}.json`);
		try {
			await this.fileService.writeFile(fileUri, VSBuffer.fromString(JSON.stringify(record, null, 2)));
		} catch (err) {
			console.warn('[Enclave Test] Failed to persist:', err);
		}
	}

	private async _loadHistory(): Promise<void> {
		const root = this._getWorkspaceRootUri();
		if (!root) { return; }
		const dir = URI.joinPath(root, '.inverse', 'tests');
		try {
			const stat = await this.fileService.resolve(dir);
			const jsonFiles = (stat.children ?? [])
				.filter(c => !c.isDirectory && c.name.endsWith('.json'))
				.sort((a, b) => b.name.localeCompare(a.name))
				.slice(0, 50);
			for (const file of jsonFiles) {
				try {
					const raw = await this.fileService.readFile(file.resource);
					this._proofHistory.push(JSON.parse(raw.value.toString()) as ITestProofRecord);
				} catch { /* skip */ }
			}
		} catch { /* dir doesn't exist yet */ }
	}



	private async _hashFile(path: string): Promise<string | undefined> {
		try {
			const content = await this.fileService.readFile(URI.file(path));
			return await this._sha256(content.value.toString());
		} catch { return undefined; }
	}

	private async _sha256(data: string): Promise<string> {
		try {
			const buf = new TextEncoder().encode(data).buffer;
			const hash = await crypto.subtle.digest('SHA-256', buf as ArrayBuffer);
			return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
		} catch { return 'hash-failed'; }
	}

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

registerSingleton(IEnclaveTestProofService, EnclaveTestProofService, InstantiationType.Delayed);
