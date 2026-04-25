/*---------------------------------------------------------------------------------------------
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

/**
 * PowerBus \u2014 inter-agent communication types.
 *
 * The PowerBus connects LLM agents inside the Neural Inverse IDE.
 * It carries text-only messages between agents. Tool execution requests
 * are routed through Power Mode's permission gate before running.
 */

export type AgentMessageType =
	| 'query'        // One agent asking another a question
	| 'response'     // Reply to a query
	| 'tool-request' // Agent requesting Power Mode execute a tool on its behalf
	| 'tool-result'  // Power Mode returning the result of a tool execution
	| 'broadcast'    // One-to-all notification
	| 'handoff'      // Sender is nearing context limit \u2014 passing summary + new session ref
	| 'handoff-ack'; // Receiver acknowledging a handoff

export type AgentCapability =
	| 'send:query'          // Can ask questions
	| 'send:tool-request'   // Can request tool execution through Power Mode
	| 'receive:tool-result' // Can receive execution results
	| 'broadcast'           // Can broadcast to all agents
	| 'receive:all';        // Receives all messages (Power Mode default)

export interface IAgentBusMessage {
	readonly id: string;
	readonly from: string;           // Sending agent ID
	readonly to: string | '*';       // Target agent ID or '*' for broadcast
	readonly type: AgentMessageType;
	readonly content: string;        // Plain text \u2014 LLM-generated or structured JSON string
	readonly timestamp: number;
	readonly depth: number;          // Chain depth \u2014 messages dropped if > MAX_DEPTH
	readonly replyTo?: string;       // ID of the message being replied to
	readonly sessionRef?: string;    // Sender's current session ID (for routing replies)
	// Tool request fields (only present when type === 'tool-request')
	readonly toolName?: string;
	readonly toolArgs?: Record<string, any>;
	readonly toolDirectory?: string; // Working directory for tool execution
}

export interface IRegisteredAgent {
	readonly agentId: string;
	readonly capabilities: AgentCapability[];
	readonly registeredAt: number;
	displayName?: string;
}

/** Max message chain depth before circular loop protection kicks in */
export const POWER_BUS_MAX_DEPTH = 5;
