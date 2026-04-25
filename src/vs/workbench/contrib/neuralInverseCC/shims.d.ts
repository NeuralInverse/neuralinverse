/*---------------------------------------------------------------------------------------------
 *  NeuralInverseCC \u2014 module shims for packages unavailable in VS Code context.
 *
 *  These stub declarations let the CC source files type-check without the private
 *  Anthropic packages or Bun-specific modules. Runtime usage is not expected for
 *  these stubs \u2014 they exist only for compilation purposes.
 *--------------------------------------------------------------------------------------------*/

// \u2500\u2500 Bun-specific \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
declare module 'bun:bundle' {
	export const bundle: (...args: unknown[]) => unknown;
	export default bundle;
}

// \u2500\u2500 Anthropic-private packages \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
declare module '@ant/claude-for-chrome-mcp' {
	const v: unknown; export default v; export const createServer: unknown;
}
declare module '@ant/computer-use-input' {
	export const createInput: unknown; export const InputEvent: unknown;
	const v: unknown; export default v;
}
declare module '@ant/computer-use-mcp' {
	const v: unknown; export default v; export const createServer: unknown;
}
declare module '@ant/computer-use-mcp/types' {
	export type ComputerUseRequest = unknown; export type ComputerUseResponse = unknown;
}
declare module '@ant/computer-use-swift' {
	const v: unknown; export default v;
}
declare module '@anthropic-ai/claude-agent-sdk' {
	export class Agent { constructor(...args: unknown[]); [key: string]: unknown; }
	export const createAgent: unknown;
	const v: unknown; export default v;
}
declare module '@anthropic-ai/mcpb' {
	const v: unknown; export default v; export const McpBridge: unknown;
}
declare module '@anthropic-ai/sandbox-runtime' {
	const v: unknown; export default v;
}

// \u2500\u2500 Deep subpath imports from @anthropic-ai/sdk (.mjs variants) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
declare module '@anthropic-ai/sdk/resources/beta/messages.js' { export * from '@anthropic-ai/sdk'; }
declare module '@anthropic-ai/sdk/resources/beta/messages/messages.mjs' { export * from '@anthropic-ai/sdk'; }
declare module '@anthropic-ai/sdk/resources/index.mjs' { export * from '@anthropic-ai/sdk'; }
declare module '@anthropic-ai/sdk/resources/messages.js' { export * from '@anthropic-ai/sdk'; }
declare module '@anthropic-ai/sdk/resources/messages.mjs' { export * from '@anthropic-ai/sdk'; }
declare module '@anthropic-ai/sdk/resources/messages/messages.mjs' { export * from '@anthropic-ai/sdk'; }
declare module '@anthropic-ai/sdk/streaming.mjs' { export * from '@anthropic-ai/sdk'; }
declare module '@anthropic-ai/sdk/error' { export * from '@anthropic-ai/sdk'; }
declare module '@anthropic-ai/sdk/resources' { export * from '@anthropic-ai/sdk'; }

// \u2500\u2500 color-diff-napi (native module) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
declare module 'color-diff-napi' {
	export function diff(a: unknown, b: unknown): number;
	export function closest(color: unknown, palette: unknown[]): unknown;
	const v: unknown; export default v;
}

// \u2500\u2500 'user' module (CC internal stub) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
declare module 'user' {
	export const username: string; export const homedir: string;
	const v: unknown; export default v;
}

// \u2500\u2500 vscode-jsonrpc/node.js \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
declare module 'vscode-jsonrpc/node.js' {
	export * from 'vscode-jsonrpc';
}

// \u2500\u2500 jsonc-parser ESM subpath \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
declare module 'jsonc-parser/lib/esm/main.js' {
	export * from 'jsonc-parser';
}
