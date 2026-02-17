import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { IASTContextService, IASTContext } from '../context/input/astContextService.js';
import { IPolicyService, IDomainRule } from '../../../neuralInverseChecks/browser/context/autocomplete/policy/policyService.js';
import { IDependencyGraphService } from '../context/graph/dependencyGraph.js';

export const INeuralInverseFIMService = createDecorator<INeuralInverseFIMService>('neuralInverseFIMService');

export interface IFIMRequest {
    prefix: string;
    suffix: string;
    stopTokens?: string[];
    maxTokens?: number;
    temperature?: number;
    // Semantic Context
    context?: {
        ast?: IASTContext;
        policy?: IDomainRule;
    }
}

import { ITextModel } from '../../../../../editor/common/model.js';
import { Position } from '../../../../../editor/common/core/position.js';

export interface INeuralInverseFIMService {
    _serviceBrand: undefined;
    requestCompletion(req: IFIMRequest, model: ITextModel, position: Position): Promise<string>;
}

export class NeuralInverseFIMService extends Disposable implements INeuralInverseFIMService {
    _serviceBrand: undefined;

    private _socket: WebSocket | null = null;
    private _isConnected = false;
    private _pendingResolver: ((val: string) => void) | null = null;
    private _currentCompletion = '';

    constructor(
        @IASTContextService private readonly astService: IASTContextService,
        @IPolicyService private readonly policyService: IPolicyService,
        @IDependencyGraphService private readonly dependencyService: IDependencyGraphService
    ) {
        super();
        this._initSocket();
    }

    private _initSocket() {
        try {
            this._socket = new WebSocket('ws://localhost:3003');

            this._socket.onopen = () => {
                console.log('[NeuralInverseFIM] Connected to FIM Socket');
                this._isConnected = true;
            };

            this._socket.onclose = () => {
                console.log('[NeuralInverseFIM] Disconnected');
                this._isConnected = false;
                // Simple reconnect logic could go here
                setTimeout(() => this._initSocket(), 2000);
            };

            this._socket.onerror = (err) => {
                console.warn('[NeuralInverseFIM] Connection error:', err);
            };

            this._socket.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);

                    if (msg.type === 'fim:stream') {
                        this._currentCompletion += msg.chunk;
                    } else if (msg.type === 'fim:done') {
                        if (this._pendingResolver) {
                            this._pendingResolver(this._currentCompletion);
                            this._pendingResolver = null;
                        }
                    } else if (msg.type === 'fim:error') {
                        console.error('[NeuralInverseFIM] Remote Error:', msg.message);
                        if (this._pendingResolver) {
                            this._pendingResolver(''); // Resolve empty on error to not block UI
                            this._pendingResolver = null;
                        }
                    }
                } catch (e) {
                    console.error('[NeuralInverseFIM] Error parsing message', e);
                }
            };

        } catch (e) {
            console.error('[NeuralInverseFIM] Failed to init socket', e);
        }
    }

    public async requestCompletion(req: IFIMRequest, model: ITextModel, position: Position): Promise<string> {
        if (!this._socket || !this._isConnected) {
            return '';
        }

        // 1. Gather AST Context
        const astContext = await this.astService.getASTContext(model, position);

        // 2. Gather Policy (TODO: Resolve Domain from Model URI)
        const domainRule = this.policyService.getDomainRules('default');

        // 3. Gather Available Dependencies (Allowed Calls)
        const allowedCalls = await this.dependencyService.getAllowedCalls(model);

        // Merge Graph Allowed Calls into Policy Rule (Runtime enrichment)
        const effectivePolicy = domainRule ? { ...domainRule } : { constraints: [], allowedCalls: [], forbiddenCalls: [] };
        if (domainRule) {
            effectivePolicy.allowedCalls = [...(domainRule.allowedCalls || []), ...allowedCalls];
        } else {
            // If no policy, at least allow what we see
            effectivePolicy.allowedCalls = allowedCalls;
        }

        // Apply Hard Policy Blocks (Client Side Firewall)
        if (domainRule && domainRule.forbiddenCalls.length > 0) {
            for (const forbidden of domainRule.forbiddenCalls) {
                if (req.prefix.includes(forbidden)) {
                    console.warn(`[Policy] Request blocked: contains forbidden token '${forbidden}'`);
                    return ''; // Silent fail
                }
            }
        }

        const enrichedReq: IFIMRequest = {
            ...req,
            context: {
                policy: effectivePolicy,
                ast: astContext
            }
        };

        console.log('[NeuralInverseFIM] Sending Enriched Request:', JSON.stringify(enrichedReq, null, 2));

        // Reset state for new request
        this._currentCompletion = '';

        // Send request
        this._socket.send(JSON.stringify({
            type: 'fim:completion',
            data: enrichedReq
        }));

        return new Promise<string>((resolve) => {
            // Overwrite any pending resolver - last request wins in this simple version
            if (this._pendingResolver) {
                this._pendingResolver('');
            }
            this._pendingResolver = resolve;

            // Timeout
            setTimeout(() => {
                if (this._pendingResolver === resolve) {
                    this._pendingResolver(this._currentCompletion);
                    this._pendingResolver = null;
                }
            }, 5000);
        });
    }
}

registerSingleton(INeuralInverseFIMService, NeuralInverseFIMService, InstantiationType.Eager);
