/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { Event, Emitter } from '../../../../../../../base/common/event.js';
import { registerSingleton, InstantiationType } from '../../../../../../../platform/instantiation/common/extensions.js';
import { VSBuffer } from '../../../../../../../base/common/buffer.js';

import { IEnclaveEnvironmentService } from '../../../../../neuralInverseEnclave/browser/services/enclaveEnvironmentService.js';

export const IPolicyService = createDecorator<IPolicyService>('neuralInversePolicyService');

export interface IDomainRule {
    constraints: string[];
    allowedCalls: string[];
    forbiddenCalls: string[];
}

export interface IProjectPolicy {
    domains: { [domainName: string]: IDomainRule };
    architecturalDecisions: string[];
    errorHandling: string[];
    securityConstraints: string[];
    namingConventions: string[];
}

export interface IPolicyService {
    readonly _serviceBrand: undefined;

    readonly onDidChangePolicy: Event<void>;

    getPolicy(): IProjectPolicy | undefined;
    getDomainRules(domain: string): IDomainRule | undefined;

    /**
     * Checks if a function call is allowed in the current environment mode and domain.
     */
    isCallAllowed(call: string, domain: string): boolean;
}

const POLICY_FOLDER = '.inverse';
const POLICY_FILE = 'autocomplete-policy.json';

const DEFAULT_POLICY: IProjectPolicy = {
    domains: {
        default: {
            constraints: ["Follow project patterns", "Use idiomatic TypeScript"],
            allowedCalls: ["*"],
            forbiddenCalls: ["eval", "alert"]
        },
        auth: {
            constraints: ["no-io", "deterministic", "secure-logging"],
            allowedCalls: ["decodeJWT", "verifySignature", "sanitize"],
            forbiddenCalls: ["fs.read", "fetch", "Math.random", "console.log"]
        }
    },
    architecturalDecisions: [
        "Use Functional Patterns where possible",
        "Prefer const over let",
        "Strict Null Checks Enabled"
    ],
    errorHandling: ["Use Result<T> pattern", "No unchecked exceptions"],
    securityConstraints: ["Input Validation Required", "Use OWASP friendly libraries"],
    namingConventions: ["camelCase", "PascalCase for Classes"]
};

export class PolicyService extends Disposable implements IPolicyService {
    declare readonly _serviceBrand: undefined;

    private _policy: IProjectPolicy | undefined;
    private readonly _onDidChangePolicy = this._register(new Emitter<void>());
    public readonly onDidChangePolicy = this._onDidChangePolicy.event;

    constructor(
        @IFileService private readonly fileService: IFileService,
        @IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
        @IEnclaveEnvironmentService private readonly enclaveEnv: IEnclaveEnvironmentService
    ) {
        super();
        this._initialize();
    }

    private async _initialize() {
        await this._ensurePolicyExists();
        await this._loadPolicy();
        this._registerListeners();
    }

    private _registerListeners() {
        const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
        if (workspaceFolders.length === 0) return;

        const rootUri = workspaceFolders[0].uri;
        const policyUri = URI.joinPath(rootUri, POLICY_FOLDER, POLICY_FILE);

        this._register(this.fileService.onDidFilesChange(e => {
            if (e.contains(policyUri)) {
                this._loadPolicy();
            }
        }));
    }

    private async _ensurePolicyExists() {
        const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
        if (workspaceFolders.length === 0) return;

        const rootUri = workspaceFolders[0].uri;
        const folderUri = URI.joinPath(rootUri, POLICY_FOLDER);
        const policyUri = URI.joinPath(folderUri, POLICY_FILE);

        try {
            // Always try to create the folder first.
            // checking .exists() is racy. If it fails (exists), we proceed.
            try {
                if (!(await this.fileService.exists(folderUri))) {
                    await this.fileService.createFolder(folderUri);
                }
            } catch (err) {
                // Ignore folder creation errors (likely already exists or specific permission issue)
                console.log('[PolicyService] Folder creation check skipped/failed, proceeding to file logic', err);
            }

            // Now check file
            if (!(await this.fileService.exists(policyUri))) {
                const content = VSBuffer.fromString(JSON.stringify(DEFAULT_POLICY, null, 4));
                await this.fileService.createFile(policyUri, content);
                console.log('[PolicyService] Created default policy file');
            }
        } catch (e) {
            console.error('[PolicyService] Failed to ensure policy file exists', e);
        }
    }

    private async _loadPolicy() {
        const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
        if (workspaceFolders.length === 0) return;

        const rootUri = workspaceFolders[0].uri;
        const policyUri = URI.joinPath(rootUri, POLICY_FOLDER, POLICY_FILE);

        try {
            const exists = await this.fileService.exists(policyUri);
            if (!exists) {
                console.warn('[PolicyService] Policy file does not exist at:', policyUri.toString());
                this._policy = undefined;
                return;
            }

            const content = await this.fileService.readFile(policyUri);
            const json = content.value.toString();
            console.log('[PolicyService] Loaded policy content:', json.substring(0, 50) + '...');
            this._policy = JSON.parse(json) as IProjectPolicy;
            this._onDidChangePolicy.fire();

        } catch (error) {
            console.error('[PolicyService] Failed to load policy:', error);
            this._policy = undefined;
        }
    }

    public getPolicy(): IProjectPolicy | undefined {
        return this._policy;
    }

    public getDomainRules(domain: string): IDomainRule | undefined {
        return this._policy?.domains?.[domain];
    }

    public isCallAllowed(call: string, domain: string): boolean {
        const mode = this.enclaveEnv.mode;

        // DRAFT Mode: Everything is allowed (Chaos Mode)
        if (mode === 'draft') {
            return true;
        }

        if (!this._policy) {
            // Fallback: If no policy loaded, default to safe in Prod?
            return mode !== 'prod';
        }

        const domainRules = this._policy.domains[domain] || this._policy.domains['default'];
        if (!domainRules) {
            return true; // No rules for domain -> allow
        }

        // Check forbidden calls
        if (domainRules.forbiddenCalls.includes(call)) {
            return false;
        }

        // PROD Mode: Strict Allowlist?
        if (mode === 'prod') {
            if (domainRules.allowedCalls.includes('*')) {
                return true;
            }
            return domainRules.allowedCalls.includes(call);
        }

        // DEV Mode: Generally allowed unless forbidden
        return true;
    }
}

registerSingleton(IPolicyService, PolicyService, InstantiationType.Eager);
