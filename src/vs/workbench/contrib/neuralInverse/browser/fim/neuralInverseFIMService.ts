import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { IASTContextService, IASTContext } from '../context/input/astContextService.js';
import { IDependencyGraphService } from '../context/graph/dependencyGraph.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { IEnterprisePolicyService } from '../../../void/common/enterprisePolicyService.js';

export const INeuralInverseFIMService = createDecorator<INeuralInverseFIMService>('neuralInverseFIMService');

export interface IFIMRequest {
    prefix: string;
    suffix: string;
    stopTokens?: string[];
    maxTokens?: number;
    temperature?: number;
    context?: {
        ast?: IASTContext;
        policy?: unknown;
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
        @IASTContextService private readonly _astService: IASTContextService,
        @IDependencyGraphService private readonly _dependencyService: IDependencyGraphService,
        @IEnterprisePolicyService private readonly _policyServiceEnterprise: IEnterprisePolicyService,
    ) {
        super();
    }

    public async requestCompletion(_req: IFIMRequest, _model: ITextModel, _position: Position): Promise<string> {
        // Community edition: FIM requires auth which is not available
        return '';
    }
}

registerSingleton(INeuralInverseFIMService, NeuralInverseFIMService, InstantiationType.Eager);
