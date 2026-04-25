/*--------------------------------------------------------------------------------------
 *  Enterprise Model Policy Types
 *  ARCH-001: Enterprise LLM Control System
 *
 *  These types define the shape of the enterprise model policy that flows from
 *  Console \u2192 db-api \u2192 agent-socket \u2192 IDE.
 *
 *  The IDE fetches this policy on startup via GET /agent/v1/model-policy and uses
 *  it to filter available models, lock settings in enforced mode, and apply
 *  enterprise-configured feature\u2192model assignments.
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
     * Maps raw model ID \u2192 display label shown in the IDE dropdown.
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
    forceInlineChat?: TriState;
    forceCodeActions?: TriState;
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

    /** Feature\u2192model assignments (enforced mode only) */
    featureAssignments?: {
        [feature: string]: FeatureAssignment | null;
    };

    /** Feature on/off enforcement */
    featurePolicy?: FeaturePolicy;

    /** Behavior / system instructions enforcement */
    behaviorPolicy?: BehaviorPolicy;

    /** MCP server allowlist/blocklist */
    mcpPolicy?: MCPPolicy;

    /** FIM / inline code completion settings */
    fimPolicy?: FIMPolicy;

    /** Power Mode (autonomous agent terminal) settings */
    powerModePolicy?: PowerModePolicy;

    /** Checks Agent (GRC enforcement agent) settings */
    checksAgentPolicy?: ChecksAgentPolicy;

    /** Workflow Agents (agent-to-agent orchestration) settings */
    agentPolicy?: AgentPolicy;

    /** Global settings overrides applied to IDE */
    globalSettings?: GlobalSettingsOverrides;
}

export interface PowerModePolicy {
    /** Force Power Mode on/off org-wide. null = developer decides. */
    enabled?: boolean | null;
    /** Allowlist of tool names available in Power Mode. Empty = all tools allowed. */
    allowedTools?: string[];
    /** Maximum agent iteration count per session. Undefined = no cap. */
    maxIterations?: number;
    /** Auto-approve all Power Mode tool calls without developer confirmation. null = developer decides. */
    autoApprove?: boolean | null;
    /** Prevent developers from changing their local Power Mode settings. */
    lockSettings?: boolean;
}

export interface ChecksAgentPolicy {
    /** Force Checks Agent on/off org-wide. null = developer decides. */
    enabled?: boolean | null;
    /** Auto-trigger workspace scan on file save. null = developer decides. */
    autoScanOnSave?: boolean | null;
    /** Block git commits when blocker/critical violations are present. */
    blockCommitsOnViolations?: boolean;
    /** Framework IDs that are mandatory for all projects in this org. */
    enforcedFrameworkIds?: string[];
    /** Prevent developers from changing their local Checks Agent settings. */
    lockSettings?: boolean;
}

export interface AgentPolicy {
    /** Force Workflow Agents on/off org-wide. null = developer decides. */
    enabled?: boolean | null;
    /** Maximum number of sub-agents that can run concurrently. Default: 3. */
    maxConcurrentAgents?: number;
    /** Maximum iterations per sub-agent session. Default: 20. */
    maxIterationsPerAgent?: number;
    /** Per-tool-type auto-approve overrides for agent sessions. */
    autoApprove?: {
        terminal?: boolean | null;
        file?: boolean | null;
        browser?: boolean | null;
        [key: string]: boolean | null | undefined;
    };
    /** Restrict which sub-agent roles are permitted. Empty = all roles. */
    allowedRoles?: ('explorer' | 'editor' | 'verifier')[];
    /** Prevent developers from changing their local Agent settings. */
    lockSettings?: boolean;
}

export interface FIMPolicy {
    /** null/undefined = developer decides, true = force on, false = force off */
    enabled?: boolean | null;
    /** Override the FIM model (defaults to Codestral-2501 on agent-socket) */
    model?: string;
    /** Max tokens per completion */
    maxTokens?: number;
    /** Temperature 0.0–1.0 */
    temperature?: number;
    /** Tokens that must never appear in output — server-side firewall */
    forbiddenTokens?: string[];
    /** Stop tokens to end completion early */
    stopTokens?: string[];
    /** Prevent developers from overriding FIM settings locally */
    lockFIMSettings?: boolean;
}

/** Response shape from GET /agent/v1/model-policy */
export interface ModelPolicyResponse {
    modelPolicy: EnterpriseModelPolicy | null;
    policyVersion: number;
}
