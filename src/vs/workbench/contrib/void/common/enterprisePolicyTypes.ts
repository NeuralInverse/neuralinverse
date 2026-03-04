/*--------------------------------------------------------------------------------------
 *  Enterprise Model Policy Types
 *  ARCH-001: Enterprise LLM Control System
 *
 *  These types define the shape of the enterprise model policy that flows from
 *  Console → db-api → agent-socket → IDE.
 *
 *  The IDE fetches this policy on startup via GET /agent/v1/model-policy and uses
 *  it to filter available models, lock settings in enforced mode, and apply
 *  enterprise-configured feature→model assignments.
 *--------------------------------------------------------------------------------------*/

export interface ProviderPolicy {
    /** Whether this provider is visible/available in the IDE */
    enabled: boolean;
    /** Whether developer can add their own API key for this provider (BYOLLM mode) */
    byollm: boolean;
    /** Enterprise-supplied API key (enforced mode only) */
    apiKey?: string;
    /** Enterprise-supplied endpoint (enforced mode only) */
    endpoint?: string;
    /** Whitelist of model names allowed for this provider */
    allowedModels: string[];
    /**
     * ARCH-001: Friendly display names for models.
     * Maps raw model ID → display label shown in the IDE dropdown.
     * e.g. { 'us.anthropic.claude-opus-4-6-v1': 'Claude Opus 4' }
     */
    modelAliases?: Record<string, string>;
}

export interface FeatureAssignment {
    providerName: string;
    modelName: string;
}

export interface GlobalSettingsOverrides {
    enableAutocomplete?: boolean;
    aiInstructions?: string;
    disableSystemMessage?: boolean;
    [key: string]: any;
}

/** Tri-state: null = no policy, true/false = force on/off */
type TriState = boolean | null;

export interface FeaturePolicy {
    forceAutocomplete?: TriState;
    forceInlineSuggestions?: TriState;
    forceAutoAcceptLLMChanges?: TriState;
    forceIncludeToolLintErrors?: TriState;
    forceAutoApprove?: {
        terminal?: TriState;
        browser?: TriState;
        file?: TriState;
        [key: string]: TriState | undefined;
    };
}

export interface BehaviorPolicy {
    /** Org-wide system instructions prefix — prepended to all AI calls */
    systemInstructions?: string;
    /** When true, developer's own instructions are suppressed */
    lockSystemInstructions?: boolean;
    /** Force disable system message entirely */
    forceDisableSystemMessage?: TriState;
}

export interface MCPServerConfig {
    name: string;
    transport?: 'stdio' | 'sse';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    locked?: boolean;
}

export interface MCPPolicy {
    preConfiguredServers?: MCPServerConfig[];
    /** null/undefined = dev decides, true = allow with policy, false = org-only no dev servers */
    allowDeveloperServers?: boolean | null;
    allowedServers?: string[];
    blockedServers?: string[];
}

export interface EnterpriseModelPolicy {
    /**
     * "enforced" — Enterprise controls everything. IDE settings are read-only.
     * "byollm" — Enterprise enables providers; developer adds own keys.
     */
    mode: 'enforced' | 'byollm';

    /** Per-provider configuration */
    providers: {
        [providerName: string]: ProviderPolicy;
    };

    /** Feature→model assignments (enforced mode only) */
    featureAssignments?: {
        [feature: string]: FeatureAssignment | null;
    };

    /** Feature on/off enforcement */
    featurePolicy?: FeaturePolicy;

    /** Behavior / system instructions enforcement */
    behaviorPolicy?: BehaviorPolicy;

    /** MCP server allowlist/blocklist */
    mcpPolicy?: MCPPolicy;

    /** Global settings overrides applied to IDE */
    globalSettings?: GlobalSettingsOverrides;
}

/** Response shape from GET /agent/v1/model-policy */
export interface ModelPolicyResponse {
    modelPolicy: EnterpriseModelPolicy | null;
    policyVersion: number;
}
