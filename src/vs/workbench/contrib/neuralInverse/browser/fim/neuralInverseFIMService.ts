import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { IASTContextService, IASTContext } from '../context/input/astContextService.js';
import { IPolicyService, IDomainRule } from '../../../neuralInverseChecks/browser/context/autocomplete/policy/policyService.js';
import { IDependencyGraphService } from '../context/graph/dependencyGraph.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { INeuralInverseAuthService } from '../../../../services/neuralInverseAuth/common/neuralInverseAuth.js';
import { IEnterprisePolicyService } from '../../../void/common/enterprisePolicyService.js';
import { AGENT_API_URL } from '../../../void/common/neuralInverseConfig.js';

export const INeuralInverseFIMService = createDecorator<INeuralInverseFIMService>('neuralInverseFIMService');

export interface IFIMRequest {
    prefix: string;
    suffix: string;
    stopTokens?: string[];
    maxTokens?: number;
    temperature?: number;
    context?: {
        ast?: IASTContext;
        policy?: IDomainRule;
        imports?: string;  // top-of-file import block (may not be in the 25-line prefix window)
    }
}

export interface INeuralInverseFIMService {
    _serviceBrand: undefined;
    requestCompletion(req: IFIMRequest, model: ITextModel, position: Position): Promise<string>;
}

export class NeuralInverseFIMService extends Disposable implements INeuralInverseFIMService {
    _serviceBrand: undefined;

    constructor(
        @IASTContextService private readonly astService: IASTContextService,
        @IPolicyService private readonly policyService: IPolicyService,
        @IDependencyGraphService private readonly dependencyService: IDependencyGraphService,
        @INeuralInverseAuthService private readonly authService: INeuralInverseAuthService,
        @IEnterprisePolicyService private readonly policyServiceEnterprise: IEnterprisePolicyService,
    ) {
        super();
    }

    public async requestCompletion(req: IFIMRequest, model: ITextModel, position: Position): Promise<string> {
        // \u2500\u2500 Enterprise gate \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
        const fimPolicy = this.policyServiceEnterprise.policy?.fimPolicy;
        if (fimPolicy?.enabled === false) {
            console.log('[NeuralInverseFIM] FIM disabled by enterprise policy');
            return '';
        }

        // \u2500\u2500 Auth \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
        const token = await this.authService.getToken();
        if (!token) {
            console.warn('[NeuralInverseFIM] No auth token \u2014 skipping completion');
            return '';
        }

        // \u2500\u2500 Enrich request with AST + policy context \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
        const astContext = await this.astService.getASTContext(model, position);
        const domainRule = this.policyService.getDomainRules('default');
        const allowedCalls = await this.dependencyService.getAllowedCalls(model);

        const effectivePolicy = domainRule
            ? { ...domainRule, allowedCalls: [...(domainRule.allowedCalls || []), ...allowedCalls] }
            : { constraints: [], allowedCalls, forbiddenCalls: [] };

        // Client-side firewall: block before sending if prefix contains a forbidden token
        if (effectivePolicy.forbiddenCalls.length > 0) {
            for (const forbidden of effectivePolicy.forbiddenCalls) {
                if (req.prefix.includes(forbidden)) {
                    console.warn(`[NeuralInverseFIM] Request blocked client-side: forbidden token '${forbidden}'`);
                    return '';
                }
            }
        }

        // \u2500\u2500 Extract import block from full file (not the 25-line trimmed prefix) \u2500\u2500
        // The autocomplete service only sends the last 25 lines \u2014 imports at the top
        // of a large file would be invisible to the model without this.
        const fullText = model.getValue();
        const importBlock = fullText
            .split('\n')
            .filter(l => /^\s*(import\s|from\s|require\()/.test(l))
            .slice(0, 20)
            .join('\n');

        const enrichedReq: IFIMRequest = {
            ...req,
            context: {
                policy: effectivePolicy,
                ast: astContext,
                imports: importBlock || undefined,
            }
        };

        // \u2500\u2500 SSE fetch to agent-socket /agent/v1/fim/complete \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);

            const response = await fetch(`${AGENT_API_URL}/fim/complete`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(enrichedReq),
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (!response.ok) {
                console.warn(`[NeuralInverseFIM] Server rejected request: ${response.status}`);
                return '';
            }

            const reader = response.body?.getReader();
            if (!reader) return '';

            const decoder = new TextDecoder();
            let completion = '';
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const payload = line.slice(6).trim();
                    if (payload === '[DONE]') break;
                    try {
                        const msg = JSON.parse(payload);
                        if (msg.type === 'fim:stream' && msg.content) {
                            completion += msg.content;
                        } else if (msg.type === 'fim:done') {
                            return completion;
                        } else if (msg.type === 'fim:error') {
                            console.error('[NeuralInverseFIM] Server error:', msg.message);
                            return '';
                        }
                    } catch {
                        // malformed SSE line \u2014 skip
                    }
                }
            }

            return completion;

        } catch (e: any) {
            if (e?.name === 'AbortError') {
                console.warn('[NeuralInverseFIM] Request timed out');
            } else {
                console.error('[NeuralInverseFIM] Fetch error:', e);
            }
            return '';
        }
    }
}

registerSingleton(INeuralInverseFIMService, NeuralInverseFIMService, InstantiationType.Eager);
