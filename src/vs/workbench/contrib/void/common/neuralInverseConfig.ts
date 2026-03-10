/*---------------------------------------------------------------------------------------------
 *  Neural Inverse — Central URL Configuration
 *  ARCH-001: Single source of truth for the agent-socket URL.
 *
 *  DEV:        Default is localhost:3002 — works immediately, zero config.
 *  PRODUCTION: Azure Pipeline runs a single sed command before building:
 *              sed -i "s|http://localhost:3002|https://agent-socket.pilot.api.neuralinverse.com|g" \
 *                src/vs/workbench/contrib/void/common/neuralInverseConfig.ts
 *--------------------------------------------------------------------------------------------*/

/** Base URL for agent-socket. */
export const AGENT_SOCKET_BASE_URL = 'https://agents-socket.pilot.api.neuralinverse.com';

/** Versioned REST API root — /ide/register, /ide/profile, /model-policy */
export const AGENT_API_URL = `${AGENT_SOCKET_BASE_URL}/agent/v1`;

/** Default endpoint pre-filled in Neural Inverse provider settings */
export const NEURAL_INVERSE_DEFAULT_ENDPOINT = `${AGENT_SOCKET_BASE_URL}/agent`;

/** Base URL for checks-socket. */
export const CHECKS_SOCKET_BASE_URL = 'https://checks-socket.pilot.api.neuralinverse.com';

/** Versioned REST API root for checks — /checks/v1/frameworks, /checks/v1/violations */
export const CHECKS_API_URL = `${CHECKS_SOCKET_BASE_URL}/checks/v1`;

