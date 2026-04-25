/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # HTTP Tools
 *
 * IAgentTool implementations for making HTTP requests to external APIs.
 * Enables agents to interact with GitHub, Jira, Linear, Slack, and any
 * REST endpoint to replace internal integration tools.
 *
 * ## Safety
 *
 * - Only HTTP/HTTPS URLs are allowed
 * - Request body size capped at 256 KB
 * - Response body truncated at 64 KB to protect context window
 * - Timeout enforced at 30s
 * - Internal/private IP ranges are blocked (SSRF protection)
 */

import { IAgentTool, IToolExecutionContext, IToolResult } from '../../common/workflowTypes.js';

// \u2500\u2500\u2500 SSRF Protection \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const BLOCKED_HOSTS = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|::1|fc00:|fe80:)/i;

function isSafeUrl(rawUrl: string): { safe: boolean; reason?: string } {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return { safe: false, reason: 'Invalid URL' };
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return { safe: false, reason: 'Only http/https URLs are allowed' };
	}
	if (BLOCKED_HOSTS.test(parsed.hostname)) {
		return { safe: false, reason: 'Requests to private/internal addresses are blocked' };
	}
	return { safe: true };
}

// \u2500\u2500\u2500 Shared fetch helper \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const MAX_RESPONSE_BYTES = 64 * 1024;   // 64 KB
const MAX_BODY_BYTES = 256 * 1024;      // 256 KB
const TIMEOUT_MS = 30_000;

interface FetchResult {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body: string;
	truncated: boolean;
}

async function doFetch(
	url: string,
	method: string,
	headers: Record<string, string>,
	body: string | undefined,
): Promise<FetchResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

	try {
		const res = await fetch(url, {
			method,
			headers,
			body: body ?? undefined,
			signal: controller.signal,
		});

		// Read body up to cap
		const reader = res.body?.getReader();
		const chunks: Uint8Array[] = [];
		let totalBytes = 0;
		let truncated = false;

		if (reader) {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				totalBytes += value.byteLength;
				if (totalBytes > MAX_RESPONSE_BYTES) {
					truncated = true;
					chunks.push(value.slice(0, value.byteLength - (totalBytes - MAX_RESPONSE_BYTES)));
					reader.cancel();
					break;
				}
				chunks.push(value);
			}
		}

		const combined = new Uint8Array(chunks.reduce((acc, c) => acc + c.byteLength, 0));
		let offset = 0;
		for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
		const bodyText = new TextDecoder().decode(combined);

		const respHeaders: Record<string, string> = {};
		res.headers.forEach((v, k) => { respHeaders[k] = v; });

		return { status: res.status, statusText: res.statusText, headers: respHeaders, body: bodyText, truncated };
	} finally {
		clearTimeout(timer);
	}
}

function formatFetchResult(result: FetchResult): string {
	const parts: string[] = [
		`HTTP ${result.status} ${result.statusText}`,
	];
	const ct = result.headers['content-type'] ?? '';
	if (ct.includes('json')) {
		try {
			parts.push(JSON.stringify(JSON.parse(result.body), null, 2));
		} catch {
			parts.push(result.body);
		}
	} else {
		parts.push(result.body);
	}
	if (result.truncated) {
		parts.push(`\n[Response truncated at ${MAX_RESPONSE_BYTES / 1024} KB]`);
	}
	return parts.join('\n\n');
}

// \u2500\u2500\u2500 httpRequest \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class HttpRequestTool implements IAgentTool {

	readonly name = 'httpRequest';
	readonly description =
		'Make an HTTP request (GET, POST, PUT, PATCH, DELETE) to an external API or URL. ' +
		'Returns the status code and response body. ' +
		'Use this to interact with GitHub, Jira, Linear, Slack, or any REST API. ' +
		'Private/internal IP addresses are blocked.';

	readonly parameters = {
		method: {
			type: 'string' as const,
			description: 'HTTP method: GET, POST, PUT, PATCH, DELETE.',
			required: true,
			enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
		},
		url: {
			type: 'string' as const,
			description: 'Full URL including query string, e.g. "https://api.github.com/repos/org/repo/issues".',
			required: true,
		},
		headers: {
			type: 'string' as const,
			description: 'JSON object of request headers, e.g. {"Authorization":"Bearer token","Content-Type":"application/json"}.',
			required: false,
		},
		body: {
			type: 'string' as const,
			description: 'Request body as a string. For JSON APIs, stringify the payload first.',
			required: false,
		},
	};

	async execute(args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		const method = (args['method'] as string)?.toUpperCase() ?? 'GET';
		const url = args['url'] as string;
		const headersRaw = args['headers'] as string | undefined;
		const body = args['body'] as string | undefined;

		if (!url?.trim()) {
			return { success: false, output: '', error: 'url is required' };
		}

		const safety = isSafeUrl(url);
		if (!safety.safe) {
			return { success: false, output: '', error: safety.reason };
		}

		if (body && body.length > MAX_BODY_BYTES) {
			return { success: false, output: '', error: `Request body too large (max ${MAX_BODY_BYTES / 1024} KB)` };
		}

		let headers: Record<string, string> = {};
		if (headersRaw) {
			try {
				headers = JSON.parse(headersRaw);
			} catch {
				return { success: false, output: '', error: 'headers must be a valid JSON object string' };
			}
		}

		ctx.log(`httpRequest: ${method} ${url}`);

		try {
			const result = await doFetch(url, method, headers, body);
			const success = result.status >= 200 && result.status < 300;
			return { success, output: formatFetchResult(result) };
		} catch (e: any) {
			const msg = e.name === 'AbortError' ? `Request timed out after ${TIMEOUT_MS / 1000}s` : e.message;
			return { success: false, output: '', error: msg };
		}
	}
}

// \u2500\u2500\u2500 Export \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const ALL_HTTP_TOOLS: IAgentTool[] = [
	new HttpRequestTool(),
];
