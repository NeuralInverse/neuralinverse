/*--------------------------------------------------------------------------------------
 *  Enterprise Policy Service
 *  ARCH-001: Enterprise LLM Control System
 *
 *  Fetches the enterprise model policy from agent-socket on IDE startup.
 *  The VoidSettingsService consumes this to filter available models,
 *  apply enforced feature assignments, and lock settings.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INeuralInverseAuthService } from '../../../services/neuralInverseAuth/common/neuralInverseAuth.js';
import { EnterpriseModelPolicy, ModelPolicyResponse } from './enterprisePolicyTypes.js';
import { AGENT_API_URL } from './neuralInverseConfig.js';

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
    ) {
        super();

        let resolver: () => void = () => { };
        this.waitForInit = new Promise((res) => resolver = res);
        this._resolver = resolver;

        // Fetch policy on startup
        this._fetchPolicy().finally(() => {
            this._resolver();
        });

        // Re-fetch policy when auth status changes (login/logout)
        this._register(this._authService.onDidChangeAuthStatus(async (isAuthenticated) => {
            if (isAuthenticated) {
                await this._fetchPolicy();
            } else {
                this._policy = null;
                this._onDidChangePolicy.fire();
            }
        }));
    }

    async refreshPolicy(): Promise<void> {
        await this._fetchPolicy();
    }

    private async _fetchPolicy(): Promise<void> {
        try {
            const token = await this._authService.getToken();
            if (!token) {
                // Not authenticated — no enterprise context
                this._policy = null;
                this._onDidChangePolicy.fire();
                return;
            }

            // ARCH-001: Use central config — no more localhost hardcodes
            const response = await this._nativeHostService.request(
                `${AGENT_API_URL}/model-policy`,
                {
                    type: 'GET',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.statusCode >= 400) {
                console.warn(`[EnterprisePolicyService] Policy fetch returned ${response.statusCode}`);
                this._policy = null;
                this._onDidChangePolicy.fire();
                return;
            }

            const data: ModelPolicyResponse = JSON.parse(response.body);

            if (data.modelPolicy) {
                const oldVersion = this._policyVersion;
                this._policy = data.modelPolicy;
                this._policyVersion = data.policyVersion;

                if (oldVersion !== data.policyVersion) {
                    console.log(`[EnterprisePolicyService] Policy updated to version ${data.policyVersion}, mode: ${data.modelPolicy.mode}`);
                    this._onDidChangePolicy.fire();
                }
            } else {
                this._policy = null;
                this._onDidChangePolicy.fire();
            }

        } catch (error) {
            console.warn('[EnterprisePolicyService] Failed to fetch policy:', error);
            this._policy = null;
            this._onDidChangePolicy.fire();
        }
    }
}

registerSingleton(IEnterprisePolicyService, EnterprisePolicyService, InstantiationType.Eager);
