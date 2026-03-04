/*---------------------------------------------------------------------------------------------
 *  Neural Inverse — Central URL Configuration
 *  ARCH-001: Single source of truth for all agent-socket URLs.
 *
 *  HOW ENVIRONMENTS WORK:
 *    Local dev:  Run IDE with AGENT_SOCKET_URL=http://localhost:3002
 *                e.g. in launch.json: "env": { "AGENT_SOCKET_URL": "http://localhost:3002" }
 *                or in terminal: AGENT_SOCKET_URL=http://localhost:3002 ./scripts/code.sh
 *
 *    Production: No env var needed — falls back to the production URL automatically.
 *
 *    Azure Pipeline: Set AGENT_SOCKET_URL as a pipeline variable in Azure DevOps.
 *                    No sed/string replacement needed — just set the variable and build.
 *--------------------------------------------------------------------------------------------*/

const PROD_AGENT_BASE = 'https://agent-socket.pilot.api.neuralinverse.com';

/**
 * Base URL for agent-socket. Override with env var AGENT_SOCKET_URL for local dev.
 * e.g. AGENT_SOCKET_URL=http://localhost:3002
 */
export const AGENT_SOCKET_BASE_URL: string =
    (typeof process !== 'undefined' && process.env?.['AGENT_SOCKET_URL'])
        ? process.env['AGENT_SOCKET_URL']
        : PROD_AGENT_BASE;

/**
 * Versioned REST API root — all IDE REST calls go through this.
 * Routes: /ide/register, /ide/profile, /model-policy
 */
export const AGENT_API_URL = `${AGENT_SOCKET_BASE_URL}/agent/v1`;

/**
 * Default endpoint pre-filled in Neural Inverse provider settings
 * (the raw /agent path, without the /v1 REST prefix).
 */
export const NEURAL_INVERSE_DEFAULT_ENDPOINT = `${AGENT_SOCKET_BASE_URL}/agent`;
