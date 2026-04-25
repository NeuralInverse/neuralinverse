/*---------------------------------------------------------------------------------------------
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

/**
 * PowerBusService \u2014 inter-agent communication bus for Power Mode.
 *
 * Responsibilities:
 * - Agent registration and capability tracking
 * - Message routing (point-to-point and broadcast)
 * - Circular loop protection (depth limit)
 * - Capability enforcement (only registered agents with correct caps can publish)
 * - Routing tool-requests to Power Mode's permission gate via onToolRequest event
 *
 * Power Mode auto-registers as 'power-mode' and subscribes to tool-requests.
 * All other agents must explicitly register before they can communicate.
 *
 * This service has no dependencies on PowerModeService \u2014 it is standalone.
 * PowerModeService subscribes to this service's events.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import {
	IAgentBusMessage,
	IRegisteredAgent,
	AgentMessageType,
	AgentCapability,
	POWER_BUS_MAX_DEPTH,
} from '../common/powerBusTypes.js';

// \u2500\u2500\u2500 Service Interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const IPowerBusService = createDecorator<IPowerBusService>('powerBusService');

export interface IPowerBusService {
	readonly _serviceBrand: undefined;

	// \u2500\u2500\u2500 Registration \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Register an agent so it can publish and subscribe */
	register(agentId: string, capabilities: AgentCapability[], displayName?: string): void;

	/** Remove an agent from the bus */
	unregister(agentId: string): void;

	/** All currently registered agents */
	getAgents(): IRegisteredAgent[];

	/** Check if an agent is registered */
	isRegistered(agentId: string): boolean;

	// \u2500\u2500\u2500 Messaging \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Publish a message to the bus.
	 * Routes to the target agent(s). Enforces depth limit and capability checks.
	 */
	publish(message: Omit<IAgentBusMessage, 'id' | 'timestamp' | 'depth'> & { depth?: number }): void;

	/**
	 * Convenience: send a text message from one agent to another.
	 */
	send(from: string, to: string | '*', type: AgentMessageType, content: string, options?: {
		replyTo?: string;
		sessionRef?: string;
	}): void;

	/**
	 * Convenience: send a tool execution request to Power Mode.
	 * Power Mode will show the permission prompt and execute if approved.
	 */
	requestTool(from: string, toolName: string, toolArgs: Record<string, any>, toolDirectory: string, sessionRef?: string): void;

	/**
	 * Called by Power Mode after executing a tool requested via bus.
	 * Routes the result back to the requesting agent.
	 */
	resolveToolRequest(requestId: string, result: string, isError?: boolean): void;

	// \u2500\u2500\u2500 Events \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Fires for every message delivered on the bus */
	readonly onMessage: Event<IAgentBusMessage>;

	/**
	 * Fires when a tool-request message arrives.
	 * Power Mode subscribes to this to show the permission prompt.
	 */
	readonly onToolRequest: Event<IAgentBusMessage>;

	/** Fires when any agent registers or unregisters */
	readonly onAgentsChanged: Event<IRegisteredAgent[]>;

	// \u2500\u2500\u2500 History \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Last N messages (in-memory, cleared on restart) */
	getHistory(limit?: number): IAgentBusMessage[];
}

// \u2500\u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const MAX_HISTORY = 200;

export class PowerBusService extends Disposable implements IPowerBusService {
	declare readonly _serviceBrand: undefined;

	private readonly _onMessage = this._register(new Emitter<IAgentBusMessage>());
	readonly onMessage = this._onMessage.event;

	private readonly _onToolRequest = this._register(new Emitter<IAgentBusMessage>());
	readonly onToolRequest = this._onToolRequest.event;

	private readonly _onAgentsChanged = this._register(new Emitter<IRegisteredAgent[]>());
	readonly onAgentsChanged = this._onAgentsChanged.event;

	private readonly _agents = new Map<string, IRegisteredAgent>();
	private readonly _history: IAgentBusMessage[] = [];

	/** Pending tool requests: message ID \u2192 requesting agent ID (for routing results back) */
	private readonly _pendingToolRequests = new Map<string, string>();

	private _idCounter = 0;

	// \u2500\u2500\u2500 Registration \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	register(agentId: string, capabilities: AgentCapability[], displayName?: string): void {
		this._agents.set(agentId, {
			agentId,
			capabilities,
			displayName: displayName ?? agentId,
			registeredAt: Date.now(),
		});
		this._onAgentsChanged.fire(this.getAgents());
		console.log(`[PowerBus] Agent registered: ${agentId}`, capabilities);
	}

	unregister(agentId: string): void {
		this._agents.delete(agentId);
		this._onAgentsChanged.fire(this.getAgents());
		console.log(`[PowerBus] Agent unregistered: ${agentId}`);
	}

	getAgents(): IRegisteredAgent[] {
		return [...this._agents.values()];
	}

	isRegistered(agentId: string): boolean {
		return this._agents.has(agentId);
	}

	// \u2500\u2500\u2500 Messaging \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	publish(raw: Omit<IAgentBusMessage, 'id' | 'timestamp' | 'depth'> & { depth?: number }): void {
		const message: IAgentBusMessage = {
			...raw,
			id: `bus_${Date.now()}_${++this._idCounter}`,
			timestamp: Date.now(),
			depth: raw.depth ?? 0,
		};

		// \u2500\u2500 Gate checks \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

		// Drop if circular loop depth exceeded
		if (message.depth > POWER_BUS_MAX_DEPTH) {
			console.warn(`[PowerBus] Message dropped \u2014 max depth ${POWER_BUS_MAX_DEPTH} exceeded`, message);
			return;
		}

		// Sender must be registered (Power Mode is always registered)
		if (!this._agents.has(message.from)) {
			console.warn(`[PowerBus] Unregistered agent tried to publish: ${message.from}`);
			return;
		}

		// Check capability for tool-requests
		if (message.type === 'tool-request') {
			const agent = this._agents.get(message.from)!;
			if (!agent.capabilities.includes('send:tool-request')) {
				console.warn(`[PowerBus] Agent ${message.from} lacks 'send:tool-request' capability`);
				return;
			}
		}

		// \u2500\u2500 Deliver \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

		this._addToHistory(message);
		this._onMessage.fire(message);

		if (message.type === 'tool-request') {
			this._pendingToolRequests.set(message.id, message.from);
			this._onToolRequest.fire(message);
		}

		console.log(`[PowerBus] ${message.from} \u2192 ${message.to} [${message.type}] depth=${message.depth}`);
	}

	send(from: string, to: string | '*', type: AgentMessageType, content: string, options?: {
		replyTo?: string;
		sessionRef?: string;
	}): void {
		this.publish({ from, to, type, content, replyTo: options?.replyTo, sessionRef: options?.sessionRef });
	}

	requestTool(from: string, toolName: string, toolArgs: Record<string, any>, toolDirectory: string, sessionRef?: string): void {
		this.publish({
			from,
			to: 'power-mode',
			type: 'tool-request',
			content: `Tool request: ${toolName}`,
			toolName,
			toolArgs,
			toolDirectory,
			sessionRef,
		});
	}

	resolveToolRequest(requestId: string, result: string, isError = false): void {
		const requestingAgent = this._pendingToolRequests.get(requestId);
		if (!requestingAgent) { return; }
		this._pendingToolRequests.delete(requestId);

		this.publish({
			from: 'power-mode',
			to: requestingAgent,
			type: 'tool-result',
			content: isError ? `[Error] ${result}` : result,
			replyTo: requestId,
		});
	}

	// \u2500\u2500\u2500 History \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	getHistory(limit = 50): IAgentBusMessage[] {
		return this._history.slice(-limit);
	}

	private _addToHistory(message: IAgentBusMessage): void {
		this._history.push(message);
		if (this._history.length > MAX_HISTORY) {
			this._history.splice(0, this._history.length - MAX_HISTORY);
		}
	}
}

registerSingleton(IPowerBusService, PowerBusService, InstantiationType.Eager);
