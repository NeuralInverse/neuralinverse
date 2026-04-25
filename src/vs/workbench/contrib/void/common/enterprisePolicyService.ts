/*--------------------------------------------------------------------------------------
 *  Enterprise Policy Service
 *  ARCH-001: Enterprise LLM Control System
 *
 *  Fetches the enterprise model policy from agent-socket on IDE startup.
 *  The VoidSettingsService consumes this to filter available models,
 *  apply enforced feature assignments, and lock settings.
 *
 *  OFFLINE RESILIENCE: Caches the last-known-good policy locally so
 *  enforcement survives agent-socket disconnections and IDE restarts.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { INeuralInverseAuthService } from '../../../services/neuralInverseAuth/common/neuralInverseAuth.js';
import { EnterpriseModelPolicy, ModelPolicyResponse } from './enterprisePolicyTypes.js';
import { AGENT_API_URL } from './neuralInverseConfig.js';

const POLICY_CACHE_KEY = 'enterprise_policy_cache';

export interface IEnterprisePolicyService {
    readonly _serviceBrand: undefined;

    /** The current enterprise policy, or null if no policy / not enterprise */
    readonly policy: EnterpriseModelPolicy | null;

    /** Current policy version from server */
    readonly policyVersion: number;

    /** Whether the IDE is under enterprise management */
    readonly isEnterpriseManaged: boolean;

    /** Whether the enterprise policy is in enforced mode */
    readonly isEnforced: boolean;

    /** Fires when policy changes (fetch completes, refresh, etc.) */
    readonly onDidChangePolicy: Event<void>;

    /** Wait for initial policy fetch to complete */
    readonly waitForInit: Promise<void>;

    /** Manually trigger a policy refresh */
    refreshPolicy(): Promise<void>;
}

export const IEnterprisePolicyService = createDecorator<IEnterprisePolicyService>('EnterprisePolicyService');

class EnterprisePolicyService extends Disposable implements IEnterprisePolicyService {
    _serviceBrand: undefined;

    private _policy: EnterpriseModelPolicy | null = null;
    private _policyVersion: number = 0;

    private readonly _onDidChangePolicy = new Emitter<void>();
    readonly onDidChangePolicy: Event<void> = this._onDidChangePolicy.event;

    private readonly _resolver: () => void;
    readonly waitForInit: Promise<void>;

    get policy(): EnterpriseModelPolicy | null { return this._policy; }
    get policyVersion(): number { return this._policyVersion; }
    get isEnterpriseManaged(): boolean { return this._policy !== null; }
    get isEnforced(): boolean { return this._policy?.mode === 'enforced'; }

    constructor(
        @INeuralInverseAuthService private readonly _authService: INeuralInverseAuthService,
        @INativeHostService private readonly _nativeHostService: INativeHostService,
        @IStorageService private readonly _storageService: IStorageService,
        @IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
        @IFileService private readonly _fileService: IFileService,
    ) {
        super();

        let resolver: () => void = () => { };
        this.waitForInit = new Promise((res) => resolver = res);
        this._resolver = resolver;

        // Load cached policy immediately so enforcement is active from startup
        this._loadCachedPolicy();

        // Then fetch fresh policy from server
        this._fetchPolicy().finally(() => {
            this._resolver();
        });

        // Re-fetch policy when auth status changes (login/logout)
        this._register(this._authService.onDidChangeAuthStatus(async (isAuthenticated) => {
            if (isAuthenticated) {
                await this._fetchPolicy();
            } else {
                // Explicit logout \u2014 clear policy AND cache
                this._policy = null;
                this._policyVersion = 0;
                this._clearCachedPolicy();
                this._onDidChangePolicy.fire();
            }
        }));

        // ARCH-001: Poll for policy changes every 30 seconds so dashboard changes propagate without IDE restart
        const pollInterval = setInterval(() => {
            this._fetchPolicy();
        }, 30_000);
        this._register({ dispose: () => clearInterval(pollInterval) });
    }

    async refreshPolicy(): Promise<void> {
        await this._fetchPolicy();
    }

    // \u2500\u2500\u2500 Local Cache \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

    private _loadCachedPolicy(): void {
        try {
            const cached = this._storageService.get(POLICY_CACHE_KEY, StorageScope.APPLICATION);
            if (cached) {
                const parsed = JSON.parse(cached);
                this._policy = parsed.policy;
                this._policyVersion = parsed.policyVersion || 0;
                console.log(`[EnterprisePolicyService] Loaded cached policy (version ${this._policyVersion}, mode: ${this._policy?.mode})`);
                this._onDidChangePolicy.fire();
            }
        } catch (e) {
            console.warn('[EnterprisePolicyService] Failed to load cached policy:', e);
        }
    }

    private _cachePolicy(policy: EnterpriseModelPolicy, version: number): void {
        try {
            this._storageService.store(
                POLICY_CACHE_KEY,
                JSON.stringify({ policy, policyVersion: version }),
                StorageScope.APPLICATION,
                StorageTarget.MACHINE
            );
        } catch (e) {
            console.warn('[EnterprisePolicyService] Failed to cache policy:', e);
        }
    }

    private _clearCachedPolicy(): void {
        this._storageService.remove(POLICY_CACHE_KEY, StorageScope.APPLICATION);
    }

    // \u2500\u2500\u2500 Workspace Context \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

    /**
     * Reads the current workspace root path and git remote origin URL.
     * Used to scope IAM enforcement to project/subproject level on agent-socket.
     *
     * - workspacePath: local filesystem path (subproject resourceId)
     * - repoUrl: git remote origin URL (used to resolve DB project ID)
     */
    private async _getWorkspaceContext(): Promise<{ workspacePath: string | null; repoUrl: string | null }> {
        const folders = this._workspaceContextService.getWorkspace().folders;
        if (!folders.length) return { workspacePath: null, repoUrl: null };

        const rootFolder = folders[0];
        const workspacePath = rootFolder.uri.fsPath;

        let repoUrl: string | null = null;
        try {
            const gitConfigUri = URI.joinPath(rootFolder.uri, '.git', 'config');
            const content = await this._fileService.readFile(gitConfigUri);
            const text = content.value.toString();
            // Parse [remote "origin"] section \u2014 grab first url = line after it
            const match = text.match(/\[remote\s+"origin"\][^\[]*\burl\s*=\s*([^\r\n]+)/);
            if (match) {
                repoUrl = match[1].trim();
            }
        } catch {
            // No .git folder or not readable \u2014 workspace may not be a git repo
        }

        return { workspacePath, repoUrl };
    }

    // \u2500\u2500\u2500 Fetch \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

    private async _fetchPolicy(): Promise<void> {
        try {
            const token = await this._authService.getToken();
            if (!token) {
                // Not authenticated \u2014 no enterprise context, clear everything
                this._policy = null;
                this._policyVersion = 0;
                this._clearCachedPolicy();
                this._onDidChangePolicy.fire();
                return;
            }

            // Resolve workspace context so agent-socket can apply project/subproject IAM scoping
            const { workspacePath, repoUrl } = await this._getWorkspaceContext();

            const headers: Record<string, string> = {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            };
            if (workspacePath) headers['x-ni-workspace-path'] = workspacePath;
            if (repoUrl) headers['x-ni-repo-url'] = repoUrl;

            // ARCH-001: Use central config \u2014 no more localhost hardcodes
            const response = await this._nativeHostService.request(
                `${AGENT_API_URL}/model-policy`,
                { type: 'GET', headers }
            );

            if (response.statusCode === 403) {
                // Org explicitly revoked access \u2014 clear enforcement
                this._policy = null;
                this._policyVersion = 0;
                this._clearCachedPolicy();
                this._onDidChangePolicy.fire();
                return;
            }

            if (response.statusCode >= 400) {
                // Server error or transient failure \u2014 KEEP last-known-good policy
                console.warn(`[EnterprisePolicyService] Policy fetch returned ${response.statusCode}, keeping cached policy`);
                return;
            }

            const data: ModelPolicyResponse = JSON.parse(response.body);

            if (data.modelPolicy) {
                const oldVersion = this._policyVersion;
                this._policy = data.modelPolicy;
                this._policyVersion = data.policyVersion;

                // Cache the successfully fetched policy
                this._cachePolicy(data.modelPolicy, data.policyVersion);

                if (oldVersion !== data.policyVersion) {
                    console.log(`[EnterprisePolicyService] Policy updated to version ${data.policyVersion}, mode: ${data.modelPolicy.mode}`);
                    this._onDidChangePolicy.fire();
                }
            } else {
                // Server returned no policy \u2014 org has no policy set
                this._policy = null;
                this._policyVersion = 0;
                this._clearCachedPolicy();
                this._onDidChangePolicy.fire();
            }

        } catch (error) {
            // Network error \u2014 KEEP last-known-good policy (offline resilience)
            console.warn('[EnterprisePolicyService] Failed to fetch policy, keeping cached policy:', error);
            // Do NOT null out this._policy \u2014 keep cached/previous value
        }
    }
}

registerSingleton(IEnterprisePolicyService, EnterprisePolicyService, InstantiationType.Eager);
