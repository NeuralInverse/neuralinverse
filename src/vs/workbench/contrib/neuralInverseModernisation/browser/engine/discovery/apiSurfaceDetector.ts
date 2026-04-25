/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # API Surface Detector
 *
 * Detects every externally accessible entry point across all supported languages
 * and frameworks. Covers REST, SOAP, gRPC, CICS, JCL, MQ/Kafka, GraphQL,
 * WebSocket, batch entry points, and stored procedure public interfaces.
 *
 * ## Language / Framework Coverage
 *
 * | Category       | Languages / Frameworks                                                 |
 * |----------------|------------------------------------------------------------------------|
 * | REST           | Spring MVC/WebFlux, JAX-RS, Ktor, Express/Koa/Fastify/Hapi, NestJS,   |
 * |                | Flask, FastAPI, Django, Gin/Echo/Fiber/Chi, Actix-web, Axum, Warp,    |
 * |                | Rocket, ASP.NET Core, Rails, Sinatra, Laravel, Symfony, Phoenix,      |
 * |                | Sails.js, Restify, Revel, Iris                                         |
 * | SOAP           | JAX-WS @WebService, WSDL service annotations, WCF [ServiceContract]    |
 * | gRPC           | .proto service/rpc definitions, grpc-gateway annotations               |
 * | CICS           | EXEC CICS RECEIVE, EXEC CICS LINK PROGRAM, EXEC CICS RETURN            |
 * | JCL            | EXEC PGM=, EXEC PROC=                                                  |
 * | MQ/Kafka/AMQP  | @KafkaListener, @RabbitListener, @JmsListener, channel.consume,        |
 * |                | socket.on, NATS subscribe, Pulsar subscribe, SQS poll                   |
 * | GraphQL        | type Query, type Mutation, type Subscription (SDL + code-first)        |
 * | WebSocket      | @WebSocketGateway (NestJS), ws.on, socket.io handlers, SignalR Hub      |
 * | Batch          | Spring @Scheduled, Quartz @Scheduled, Celery @task, cron handlers      |
 * | Stored Proc    | CREATE OR REPLACE PROCEDURE/FUNCTION (PL/SQL, T-SQL, MySQL, PL/pgSQL)  |
 */

import { IAPIEndpoint, APIEndpointKind } from './discoveryTypes.js';

// \u2500\u2500\u2500 Public API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Detect all API endpoints in a unit's source content.
 *
 * @param content   The full source text of the unit (or file for file-level)
 * @param unitId    The unit ID to associate endpoints with
 * @param lang      Normalised language key
 * @param fileName  File name (used for proto / schema files)
 */
export function detectAPIEndpoints(
	content: string,
	unitId: string,
	lang: string,
	fileName: string,
): IAPIEndpoint[] {
	const results: IAPIEndpoint[] = [];
	const lines = content.split('\n');

	switch (lang) {
		case 'cobol':
			detectCICSEndpoints(lines, unitId, results);
			break;
		case 'jcl':
			detectJCLEntryPoints(lines, unitId, results);
			break;
		case 'plsql':
		case 'sql':
			detectStoredProcEndpoints(lines, unitId, results);
			break;
		case 'proto':
			detectGrpcEndpoints(lines, unitId, results);
			break;
		case 'graphql':
		case 'gql':
			detectGraphQLEndpoints(lines, unitId, results);
			break;
		case 'java':
		case 'kotlin':
		case 'scala':
		case 'groovy':
			detectJVMEndpoints(content, lines, unitId, lang, results);
			break;
		case 'csharp':
			detectDotNetEndpoints(content, lines, unitId, results);
			break;
		case 'python':
			detectPythonEndpoints(content, lines, unitId, results);
			break;
		case 'typescript':
		case 'javascript':
			detectNodeEndpoints(content, lines, unitId, lang, results);
			break;
		case 'go':
			detectGoEndpoints(content, lines, unitId, results);
			break;
		case 'rust':
			detectRustEndpoints(content, lines, unitId, results);
			break;
		case 'ruby':
			detectRubyEndpoints(content, lines, unitId, results);
			break;
		case 'php':
			detectPhpEndpoints(content, lines, unitId, results);
			break;
		case 'elixir':
			detectElixirEndpoints(content, lines, unitId, results);
			break;
		case 'swift':
			detectSwiftEndpoints(content, lines, unitId, results);
			break;
		case 'dart':
			detectDartEndpoints(content, lines, unitId, results);
			break;
	}

	return results;
}


// \u2500\u2500\u2500 COBOL / CICS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectCICSEndpoints(lines: string[], unitId: string, out: IAPIEndpoint[]): void {
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// EXEC CICS RECEIVE MAP(mapname) \u2014 screen entry
		let m = /EXEC\s+CICS\s+RECEIVE\s+MAP\s*\(\s*['"]?([\w-]+)['"]?\s*\)/i.exec(line);
		if (m) {
			out.push({ unitId, kind: 'cics-transaction', operationName: m[1], lineNumber: i + 1 });
		}

		// EXEC CICS RETURN TRANSID(txid)
		m = /EXEC\s+CICS\s+RETURN\s+TRANSID\s*\(\s*['"]?([\w-]+)['"]?\s*\)/i.exec(line);
		if (m) {
			out.push({ unitId, kind: 'cics-transaction', txCode: m[1], lineNumber: i + 1 });
		}

		// EXEC CICS LINK PROGRAM(progname)
		m = /EXEC\s+CICS\s+LINK\s+PROGRAM\s*\(\s*['"]?([\w-]+)['"]?\s*\)/i.exec(line);
		if (m) {
			out.push({ unitId, kind: 'cics-link', operationName: m[1], lineNumber: i + 1 });
		}

		// EXEC CICS HANDLE
		if (/EXEC\s+CICS\s+HANDLE/i.test(line)) {
			out.push({ unitId, kind: 'event-handler', lineNumber: i + 1 });
		}
	}
}


// \u2500\u2500\u2500 JCL \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectJCLEntryPoints(lines: string[], unitId: string, out: IAPIEndpoint[]): void {
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// //STEP01 EXEC PGM=MYPGM
		let m = /\/\/\S+\s+EXEC\s+PGM\s*=\s*([\w#$@]+)/i.exec(line);
		if (m) {
			out.push({ unitId, kind: 'jcl-exec-pgm', operationName: m[1], lineNumber: i + 1 });
			continue;
		}
		// //STEP02 EXEC MYPROC
		m = /\/\/\S+\s+EXEC\s+([\w#$@]+)/i.exec(line);
		if (m && m[1].toUpperCase() !== 'PGM') {
			out.push({ unitId, kind: 'jcl-proc', operationName: m[1], lineNumber: i + 1 });
		}
	}
}


// \u2500\u2500\u2500 Stored Procedures (PL/SQL, T-SQL, MySQL, PL/pgSQL) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectStoredProcEndpoints(lines: string[], unitId: string, out: IAPIEndpoint[]): void {
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const m = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?(PROCEDURE|FUNCTION|PACKAGE)\s+([\w.]+)/i.exec(line);
		if (m) {
			out.push({ unitId, kind: 'stored-proc-public', operationName: m[2], lineNumber: i + 1 });
		}
	}
}


// \u2500\u2500\u2500 gRPC / Protobuf \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectGrpcEndpoints(lines: string[], unitId: string, out: IAPIEndpoint[]): void {
	let inService = false;
	let serviceName = '';
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		const svc = /^service\s+([\w]+)\s*\{/.exec(line);
		if (svc) { inService = true; serviceName = svc[1]; continue; }
		if (inService) {
			if (line === '}') { inService = false; continue; }
			const rpc = /^rpc\s+([\w]+)\s*\(([^)]*)\)\s*returns\s*\(([^)]*)\)/i.exec(line);
			if (rpc) {
				out.push({
					unitId,
					kind: 'grpc-method',
					operationName: `${serviceName}.${rpc[1]}`,
					inputType: rpc[2].trim(),
					outputType: rpc[3].trim(),
					lineNumber: i + 1,
				});
			}
		}
	}
}


// \u2500\u2500\u2500 GraphQL SDL \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectGraphQLEndpoints(lines: string[], unitId: string, out: IAPIEndpoint[]): void {
	let currentType: 'Query' | 'Mutation' | 'Subscription' | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (/^type\s+Query\s*(\{|$)/i.test(line))        { currentType = 'Query'; continue; }
		if (/^type\s+Mutation\s*(\{|$)/i.test(line))      { currentType = 'Mutation'; continue; }
		if (/^type\s+Subscription\s*(\{|$)/i.test(line))  { currentType = 'Subscription'; continue; }
		if (line === '}') { currentType = null; continue; }
		if (currentType) {
			const field = /^([\w]+)\s*(?:\([^)]*\))?\s*:\s*([\w!\[\]]+)/.exec(line);
			if (field) {
				const kind: APIEndpointKind = currentType === 'Mutation' ? 'rest-post' : 'graphql-resolver';
				out.push({ unitId, kind, operationName: `${currentType}.${field[1]}`, outputType: field[2], lineNumber: i + 1 });
			}
		}
	}
}


// \u2500\u2500\u2500 JVM (Java / Kotlin / Scala / Groovy) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectJVMEndpoints(
	content: string, lines: string[], unitId: string, lang: string, out: IAPIEndpoint[],
): void {
	// Spring MVC / WebFlux annotations
	const springAnnotations: Array<[RegExp, APIEndpointKind, 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'ANY']> = [
		[/@GetMapping\s*(?:\(\s*(?:value\s*=\s*)?["']([^"']*)["'])?/gi,     'rest-get',    'GET'],
		[/@PostMapping\s*(?:\(\s*(?:value\s*=\s*)?["']([^"']*)["'])?/gi,    'rest-post',   'POST'],
		[/@PutMapping\s*(?:\(\s*(?:value\s*=\s*)?["']([^"']*)["'])?/gi,     'rest-put',    'PUT'],
		[/@PatchMapping\s*(?:\(\s*(?:value\s*=\s*)?["']([^"']*)["'])?/gi,   'rest-patch',  'PATCH'],
		[/@DeleteMapping\s*(?:\(\s*(?:value\s*=\s*)?["']([^"']*)["'])?/gi,  'rest-delete', 'DELETE'],
		[/@RequestMapping\s*(?:\([^)]*\))?/gi,                               'rest-generic','ANY'],
	];

	for (const [re, kind, method] of springAnnotations) {
		let m: RegExpExecArray | null;
		const re2 = new RegExp(re.source, re.flags);
		while ((m = re2.exec(content)) !== null) {
			const line = lineOf(content, m.index);
			out.push({ unitId, kind, httpMethod: method, path: m[1], lineNumber: line, isPublicFacing: true });
		}
	}

	// JAX-RS
	const jaxrs: Array<[RegExp, 'GET'|'POST'|'PUT'|'PATCH'|'DELETE']> = [
		[/@GET\b/g,    'GET'],
		[/@POST\b/g,   'POST'],
		[/@PUT\b/g,    'PUT'],
		[/@PATCH\b/g,  'PATCH'],
		[/@DELETE\b/g, 'DELETE'],
	];
	for (const [re, method] of jaxrs) {
		const re2 = new RegExp(re.source, re.flags);
		let m: RegExpExecArray | null;
		while ((m = re2.exec(content)) !== null) {
			// Try to find @Path on next few lines
			const snippet = content.slice(m.index, m.index + 300);
			const pathM = /@Path\s*\(\s*["']([^"']*)["']/.exec(snippet);
			out.push({ unitId, kind: `rest-${method.toLowerCase()}` as APIEndpointKind, httpMethod: method, path: pathM?.[1], lineNumber: lineOf(content, m.index), isPublicFacing: true });
		}
	}

	// JAX-WS / SOAP
	if (/@WebService\b/i.test(content)) {
		const m = /@WebService\s*\([^)]*name\s*=\s*["']([^"']*)["']/i.exec(content);
		out.push({ unitId, kind: 'soap-operation', operationName: m?.[1], lineNumber: 1, isPublicFacing: true });
	}

	// Spring @Scheduled / Quartz
	const sched = /@Scheduled\s*\([^)]*\)/gi;
	let sm: RegExpExecArray | null;
	while ((sm = sched.exec(content)) !== null) {
		out.push({ unitId, kind: 'batch-entry', lineNumber: lineOf(content, sm.index) });
	}

	// @KafkaListener
	const kafka = /@KafkaListener\s*\([^)]*topics\s*=\s*["']([^"']*)["']/gi;
	let km: RegExpExecArray | null;
	while ((km = kafka.exec(content)) !== null) {
		out.push({ unitId, kind: 'mq-listener', path: km[1], lineNumber: lineOf(content, km.index) });
	}

	// @RabbitListener
	const rabbit = /@RabbitListener\s*\([^)]*queues\s*=\s*["']([^"']*)["']/gi;
	let rm: RegExpExecArray | null;
	while ((rm = rabbit.exec(content)) !== null) {
		out.push({ unitId, kind: 'mq-listener', path: rm[1], lineNumber: lineOf(content, rm.index) });
	}

	// @JmsListener
	const jms = /@JmsListener\s*\([^)]*destination\s*=\s*["']([^"']*)["']/gi;
	let jm: RegExpExecArray | null;
	while ((jm = jms.exec(content)) !== null) {
		out.push({ unitId, kind: 'mq-listener', path: jm[1], lineNumber: lineOf(content, jm.index) });
	}

	// Ktor (Kotlin)
	if (lang === 'kotlin') {
		const ktorRoutes: Array<[RegExp, 'GET'|'POST'|'PUT'|'PATCH'|'DELETE']> = [
			[/\bget\s*\(\s*["']([^"']*)["']/g,    'GET'],
			[/\bpost\s*\(\s*["']([^"']*)["']/g,   'POST'],
			[/\bput\s*\(\s*["']([^"']*)["']/g,    'PUT'],
			[/\bpatch\s*\(\s*["']([^"']*)["']/g,  'PATCH'],
			[/\bdelete\s*\(\s*["']([^"']*)["']/g, 'DELETE'],
		];
		for (const [re, method] of ktorRoutes) {
			const re2 = new RegExp(re.source, re.flags);
			let m: RegExpExecArray | null;
			while ((m = re2.exec(content)) !== null) {
				out.push({ unitId, kind: `rest-${method.toLowerCase()}` as APIEndpointKind, httpMethod: method, path: m[1], lineNumber: lineOf(content, m.index) });
			}
		}
	}

	// WebSocket
	if (/@WebSocketGateway\b/.test(content)) {
		out.push({ unitId, kind: 'websocket-handler', lineNumber: 1 });
	}

	// GraphQL resolvers (Spring / Netflix DGS / graphql-java)
	const dgs = /@DgsQuery\b|@DgsMutation\b|@DgsSubscription\b|@QueryMapping\b|@MutationMapping\b/gi;
	let dgsM: RegExpExecArray | null;
	while ((dgsM = dgs.exec(content)) !== null) {
		out.push({ unitId, kind: 'graphql-resolver', lineNumber: lineOf(content, dgsM.index) });
	}
}


// \u2500\u2500\u2500 .NET / C# \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectDotNetEndpoints(content: string, lines: string[], unitId: string, out: IAPIEndpoint[]): void {
	const httpAttrs: Array<[RegExp, APIEndpointKind, 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'ANY']> = [
		[/\[HttpGet(?:\s*\([^)]*\))?\]/gi,    'rest-get',    'GET'],
		[/\[HttpPost(?:\s*\([^)]*\))?\]/gi,   'rest-post',   'POST'],
		[/\[HttpPut(?:\s*\([^)]*\))?\]/gi,    'rest-put',    'PUT'],
		[/\[HttpPatch(?:\s*\([^)]*\))?\]/gi,  'rest-patch',  'PATCH'],
		[/\[HttpDelete(?:\s*\([^)]*\))?\]/gi, 'rest-delete', 'DELETE'],
		[/\[Route\s*\([^)]*\)\]/gi,           'rest-generic','ANY'],
	];
	for (const [re, kind, method] of httpAttrs) {
		const re2 = new RegExp(re.source, re.flags);
		let m: RegExpExecArray | null;
		while ((m = re2.exec(content)) !== null) {
			const pathM = /\["([^"]*)"\]/.exec(m[0]);
			out.push({ unitId, kind, httpMethod: method, path: pathM?.[1], lineNumber: lineOf(content, m.index), isPublicFacing: true });
		}
	}

	// WCF [ServiceContract]
	if (/\[ServiceContract\]/.test(content)) {
		out.push({ unitId, kind: 'soap-operation', lineNumber: 1 });
	}
	// [OperationContract]
	const oc = /\[OperationContract(?:\([^)]*\))?\]/g;
	let ocM: RegExpExecArray | null;
	while ((ocM = oc.exec(content)) !== null) {
		out.push({ unitId, kind: 'soap-operation', lineNumber: lineOf(content, ocM.index) });
	}

	// SignalR Hub
	if (/\bHub\b/.test(content) && /Microsoft\.AspNetCore\.SignalR/.test(content)) {
		out.push({ unitId, kind: 'websocket-handler', lineNumber: 1 });
	}

	// Minimal API: app.MapGet/MapPost/MapPut/MapPatch/MapDelete
	const minimalRoutes: Array<[RegExp, 'GET'|'POST'|'PUT'|'PATCH'|'DELETE']> = [
		[/app\.MapGet\s*\(\s*["']([^"']*)["']/g,    'GET'],
		[/app\.MapPost\s*\(\s*["']([^"']*)["']/g,   'POST'],
		[/app\.MapPut\s*\(\s*["']([^"']*)["']/g,    'PUT'],
		[/app\.MapPatch\s*\(\s*["']([^"']*)["']/g,  'PATCH'],
		[/app\.MapDelete\s*\(\s*["']([^"']*)["']/g, 'DELETE'],
	];
	for (const [re, method] of minimalRoutes) {
		const re2 = new RegExp(re.source, re.flags);
		let m: RegExpExecArray | null;
		while ((m = re2.exec(content)) !== null) {
			out.push({ unitId, kind: `rest-${method.toLowerCase()}` as APIEndpointKind, httpMethod: method, path: m[1], lineNumber: lineOf(content, m.index) });
		}
	}
}


// \u2500\u2500\u2500 Python \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectPythonEndpoints(content: string, lines: string[], unitId: string, out: IAPIEndpoint[]): void {
	// Flask / Flask-RESTful / Blueprint
	const flaskRoutes = /@(?:app|bp|blueprint|api)\.(route|get|post|put|patch|delete)\s*\(\s*["']([^"']*)["']/gi;
	let m: RegExpExecArray | null;
	while ((m = flaskRoutes.exec(content)) !== null) {
		const verb = m[1].toUpperCase();
		const kind = verb === 'ROUTE' ? 'rest-generic' : `rest-${verb.toLowerCase()}` as APIEndpointKind;
		const method = verb === 'ROUTE' ? 'ANY' : verb as 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'ANY';
		out.push({ unitId, kind, httpMethod: method, path: m[2], lineNumber: lineOf(content, m.index), isPublicFacing: true });
	}

	// FastAPI
	const fastapiRoutes = /@(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*["']([^"']*)["']/gi;
	while ((m = fastapiRoutes.exec(content)) !== null) {
		const verb = m[1].toUpperCase() as 'GET'|'POST'|'PUT'|'PATCH'|'DELETE';
		out.push({ unitId, kind: `rest-${verb.toLowerCase()}` as APIEndpointKind, httpMethod: verb, path: m[2], lineNumber: lineOf(content, m.index), isPublicFacing: true });
	}

	// Django REST @api_view
	const apiView = /@api_view\s*\(\s*\[([^\]]*)\]/gi;
	while ((m = apiView.exec(content)) !== null) {
		out.push({ unitId, kind: 'rest-generic', lineNumber: lineOf(content, m.index) });
	}

	// Celery @task / @shared_task
	const celery = /@(?:app\.task|shared_task|celery\.task)\b/gi;
	while ((m = celery.exec(content)) !== null) {
		out.push({ unitId, kind: 'batch-entry', lineNumber: lineOf(content, m.index) });
	}

	// gRPC service implementation (grpc.ServicerContext)
	if (/grpc\.ServicerContext/i.test(content) || /servicer/i.test(content)) {
		out.push({ unitId, kind: 'grpc-method', lineNumber: 1 });
	}

	// WebSocket (websockets, FastAPI WebSocket)
	if (/\bwebsocket\b/i.test(content) && /@app\.websocket\b/.test(content)) {
		const wsRoutes = /@app\.websocket\s*\(\s*["']([^"']*)["']/gi;
		while ((m = wsRoutes.exec(content)) !== null) {
			out.push({ unitId, kind: 'websocket-handler', path: m[1], lineNumber: lineOf(content, m.index) });
		}
	}

	// Strawberry / Graphene GraphQL
	if (/@strawberry\.(type|mutation|query|subscription)|graphene\.ObjectType/i.test(content)) {
		out.push({ unitId, kind: 'graphql-resolver', lineNumber: 1 });
	}

	// NATS / RabbitMQ / Kafka subscriptions (aio-pika, aiokafka)
	if (/await channel\.consume\b|@nats\.subscribe\b|consumer\.subscribe\b/i.test(content)) {
		out.push({ unitId, kind: 'mq-listener', lineNumber: 1 });
	}
}


// \u2500\u2500\u2500 Node.js / TypeScript / JavaScript \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectNodeEndpoints(
	content: string, lines: string[], unitId: string, lang: string, out: IAPIEndpoint[],
): void {
	// Express / Koa (via koa-router) / Restify
	const expressRoutes: Array<[RegExp, 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'ANY']> = [
		[/(?:router|app|server)\s*\.\s*get\s*\(\s*['"`]([^'"`]*)['"`]/g,    'GET'],
		[/(?:router|app|server)\s*\.\s*post\s*\(\s*['"`]([^'"`]*)['"`]/g,   'POST'],
		[/(?:router|app|server)\s*\.\s*put\s*\(\s*['"`]([^'"`]*)['"`]/g,    'PUT'],
		[/(?:router|app|server)\s*\.\s*patch\s*\(\s*['"`]([^'"`]*)['"`]/g,  'PATCH'],
		[/(?:router|app|server)\s*\.\s*delete\s*\(\s*['"`]([^'"`]*)['"`]/g, 'DELETE'],
		[/(?:router|app|server)\s*\.\s*all\s*\(\s*['"`]([^'"`]*)['"`]/g,    'ANY'],
	];
	for (const [re, method] of expressRoutes) {
		const re2 = new RegExp(re.source, re.flags);
		let m: RegExpExecArray | null;
		while ((m = re2.exec(content)) !== null) {
			out.push({ unitId, kind: method === 'ANY' ? 'rest-generic' : `rest-${method.toLowerCase()}` as APIEndpointKind, httpMethod: method, path: m[1], lineNumber: lineOf(content, m.index), isPublicFacing: true });
		}
	}

	// Fastify
	const fastifyRoutes: Array<[RegExp, 'GET'|'POST'|'PUT'|'PATCH'|'DELETE']> = [
		[/fastify\s*\.\s*get\s*\(\s*['"`]([^'"`]*)['"`]/g,    'GET'],
		[/fastify\s*\.\s*post\s*\(\s*['"`]([^'"`]*)['"`]/g,   'POST'],
		[/fastify\s*\.\s*put\s*\(\s*['"`]([^'"`]*)['"`]/g,    'PUT'],
		[/fastify\s*\.\s*patch\s*\(\s*['"`]([^'"`]*)['"`]/g,  'PATCH'],
		[/fastify\s*\.\s*delete\s*\(\s*['"`]([^'"`]*)['"`]/g, 'DELETE'],
	];
	for (const [re, method] of fastifyRoutes) {
		const re2 = new RegExp(re.source, re.flags);
		let m: RegExpExecArray | null;
		while ((m = re2.exec(content)) !== null) {
			out.push({ unitId, kind: `rest-${method.toLowerCase()}` as APIEndpointKind, httpMethod: method, path: m[1], lineNumber: lineOf(content, m.index) });
		}
	}

	// Hapi
	const hapiRoutes = /server\s*\.\s*route\s*\(\s*\{\s*method\s*:\s*['"`]([^'"`]*)['"`][^}]*path\s*:\s*['"`]([^'"`]*)['"`]/gi;
	let m: RegExpExecArray | null;
	while ((m = hapiRoutes.exec(content)) !== null) {
		const method = m[1].toUpperCase() as 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'ANY';
		out.push({ unitId, kind: method === 'ANY' ? 'rest-generic' : `rest-${method.toLowerCase()}` as APIEndpointKind, httpMethod: method, path: m[2], lineNumber: lineOf(content, m.index) });
	}

	// NestJS decorators
	const nestDecorators: Array<[RegExp, APIEndpointKind, 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'ANY']> = [
		[/@Get\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g,    'rest-get',    'GET'],
		[/@Post\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g,   'rest-post',   'POST'],
		[/@Put\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g,    'rest-put',    'PUT'],
		[/@Patch\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g,  'rest-patch',  'PATCH'],
		[/@Delete\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g, 'rest-delete', 'DELETE'],
	];
	for (const [re, kind, method] of nestDecorators) {
		const re2 = new RegExp(re.source, re.flags);
		let nm: RegExpExecArray | null;
		while ((nm = re2.exec(content)) !== null) {
			out.push({ unitId, kind, httpMethod: method, path: nm[1], lineNumber: lineOf(content, nm.index) });
		}
	}

	// NestJS @WebSocketGateway
	if (/@WebSocketGateway\b/.test(content)) {
		out.push({ unitId, kind: 'websocket-handler', lineNumber: 1 });
	}
	// socket.io / ws
	const socketOn = /(?:socket|wss?)\s*\.\s*on\s*\(\s*['"`]([^'"`]*)['"`]/gi;
	while ((m = socketOn.exec(content)) !== null) {
		out.push({ unitId, kind: 'websocket-handler', operationName: m[1], lineNumber: lineOf(content, m.index) });
	}

	// Kafka (kafkajs)
	const kafkaConsume = /consumer\s*\.\s*subscribe\s*\(\s*\{\s*topics?\s*:\s*\[?\s*['"`]([^'"`]*)['"`]/gi;
	while ((m = kafkaConsume.exec(content)) !== null) {
		out.push({ unitId, kind: 'mq-listener', path: m[1], lineNumber: lineOf(content, m.index) });
	}

	// Apollo GraphQL resolvers
	if (/resolvers\s*=\s*\{|new\s+ApolloServer|makeExecutableSchema\b/i.test(content)) {
		out.push({ unitId, kind: 'graphql-resolver', lineNumber: 1 });
	}

	// node-cron / node-schedule
	if (/cron\.schedule\s*\(|schedule\.scheduleJob\s*\(/i.test(content)) {
		out.push({ unitId, kind: 'batch-entry', lineNumber: 1 });
	}
}


// \u2500\u2500\u2500 Go \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectGoEndpoints(content: string, lines: string[], unitId: string, out: IAPIEndpoint[]): void {
	// Gin: r.GET("/path", handler)
	const ginRoutes: Array<[RegExp, 'GET'|'POST'|'PUT'|'PATCH'|'DELETE']> = [
		[/\.\s*GET\s*\(\s*"([^"]*)"/g,    'GET'],
		[/\.\s*POST\s*\(\s*"([^"]*)"/g,   'POST'],
		[/\.\s*PUT\s*\(\s*"([^"]*)"/g,    'PUT'],
		[/\.\s*PATCH\s*\(\s*"([^"]*)"/g,  'PATCH'],
		[/\.\s*DELETE\s*\(\s*"([^"]*)"/g, 'DELETE'],
	];
	for (const [re, method] of ginRoutes) {
		const re2 = new RegExp(re.source, re.flags);
		let m: RegExpExecArray | null;
		while ((m = re2.exec(content)) !== null) {
			out.push({ unitId, kind: `rest-${method.toLowerCase()}` as APIEndpointKind, httpMethod: method, path: m[1], lineNumber: lineOf(content, m.index) });
		}
	}

	// Standard net/http: http.HandleFunc("/path", handler)
	const httpHandle = /http\.HandleFunc\s*\(\s*"([^"]*)"/g;
	let m: RegExpExecArray | null;
	while ((m = httpHandle.exec(content)) !== null) {
		out.push({ unitId, kind: 'rest-generic', path: m[1], lineNumber: lineOf(content, m.index) });
	}

	// gRPC server registration
	if (/grpc\.NewServer\b|RegisterXxxServer\b/.test(content)) {
		out.push({ unitId, kind: 'grpc-method', lineNumber: 1 });
	}

	// Kafka (confluent-kafka-go, sarama)
	if (/consumer\.SubscribeTopics\b|sarama\.NewConsumer\b/i.test(content)) {
		out.push({ unitId, kind: 'mq-listener', lineNumber: 1 });
	}
}


// \u2500\u2500\u2500 Rust \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectRustEndpoints(content: string, lines: string[], unitId: string, out: IAPIEndpoint[]): void {
	// Actix-web attributes: #[get("/path")], #[post("/path")], etc.
	const actixAttrs: Array<[RegExp, 'GET'|'POST'|'PUT'|'PATCH'|'DELETE']> = [
		[/#\[get\s*\(\s*"([^"]*)"\s*\)\]/g,    'GET'],
		[/#\[post\s*\(\s*"([^"]*)"\s*\)\]/g,   'POST'],
		[/#\[put\s*\(\s*"([^"]*)"\s*\)\]/g,    'PUT'],
		[/#\[patch\s*\(\s*"([^"]*)"\s*\)\]/g,  'PATCH'],
		[/#\[delete\s*\(\s*"([^"]*)"\s*\)\]/g, 'DELETE'],
	];
	for (const [re, method] of actixAttrs) {
		const re2 = new RegExp(re.source, re.flags);
		let m: RegExpExecArray | null;
		while ((m = re2.exec(content)) !== null) {
			out.push({ unitId, kind: `rest-${method.toLowerCase()}` as APIEndpointKind, httpMethod: method, path: m[1], lineNumber: lineOf(content, m.index) });
		}
	}

	// Axum: Router::new().route("/path", get(handler))
	const axumRoutes = /\.route\s*\(\s*"([^"]*)"\s*,\s*(\w+)\s*\(/g;
	let m: RegExpExecArray | null;
	while ((m = axumRoutes.exec(content)) !== null) {
		const method = m[2].toUpperCase();
		const kind: APIEndpointKind = (['GET','POST','PUT','PATCH','DELETE'].includes(method))
			? `rest-${method.toLowerCase()}` as APIEndpointKind
			: 'rest-generic';
		out.push({ unitId, kind, path: m[1], lineNumber: lineOf(content, m.index) });
	}

	// Warp filters: warp::path("api").and(warp::get())
	if (/warp::get\(\)|warp::post\(\)|warp::put\(\)|warp::delete\(\)/i.test(content)) {
		out.push({ unitId, kind: 'rest-generic', lineNumber: 1 });
	}

	// Rocket: #[get("/path")] via similar pattern (already caught by actix pattern)

	// gRPC tonic
	if (/tonic::transport::Server\b|\.add_service\b/.test(content)) {
		out.push({ unitId, kind: 'grpc-method', lineNumber: 1 });
	}
}


// \u2500\u2500\u2500 Ruby \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectRubyEndpoints(content: string, lines: string[], unitId: string, out: IAPIEndpoint[]): void {
	// Rails routes.rb
	const railsRoutes: Array<[RegExp, 'GET'|'POST'|'PUT'|'PATCH'|'DELETE']> = [
		[/\bget\s+['"]([^'"]*)['"]/g,    'GET'],
		[/\bpost\s+['"]([^'"]*)['"]/g,   'POST'],
		[/\bput\s+['"]([^'"]*)['"]/g,    'PUT'],
		[/\bpatch\s+['"]([^'"]*)['"]/g,  'PATCH'],
		[/\bdelete\s+['"]([^'"]*)['"]/g, 'DELETE'],
	];
	for (const [re, method] of railsRoutes) {
		const re2 = new RegExp(re.source, re.flags);
		let m: RegExpExecArray | null;
		while ((m = re2.exec(content)) !== null) {
			out.push({ unitId, kind: `rest-${method.toLowerCase()}` as APIEndpointKind, httpMethod: method, path: m[1], lineNumber: lineOf(content, m.index) });
		}
	}

	// Sinatra
	const sinatra: Array<[RegExp, 'GET'|'POST'|'PUT'|'PATCH'|'DELETE']> = [
		[/^get\s+['"]([^'"]*)['"]/gm,    'GET'],
		[/^post\s+['"]([^'"]*)['"]/gm,   'POST'],
		[/^put\s+['"]([^'"]*)['"]/gm,    'PUT'],
		[/^patch\s+['"]([^'"]*)['"]/gm,  'PATCH'],
		[/^delete\s+['"]([^'"]*)['"]/gm, 'DELETE'],
	];
	for (const [re, method] of sinatra) {
		const re2 = new RegExp(re.source, re.flags);
		let m: RegExpExecArray | null;
		while ((m = re2.exec(content)) !== null) {
			out.push({ unitId, kind: `rest-${method.toLowerCase()}` as APIEndpointKind, httpMethod: method, path: m[1], lineNumber: lineOf(content, m.index) });
		}
	}

	// Grape
	const grape = /(?:get|post|put|patch|delete)\s+(?:do|['"]([^'"]*)['"])/gi;
	let m: RegExpExecArray | null;
	while ((m = grape.exec(content)) !== null) {
		const verb = m[0].split(/\s+/)[0].toUpperCase() as 'GET'|'POST'|'PUT'|'PATCH'|'DELETE';
		out.push({ unitId, kind: `rest-${verb.toLowerCase()}` as APIEndpointKind, httpMethod: verb, path: m[1], lineNumber: lineOf(content, m.index) });
	}
}


// \u2500\u2500\u2500 PHP \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectPhpEndpoints(content: string, lines: string[], unitId: string, out: IAPIEndpoint[]): void {
	// Laravel Route::get/post/put/patch/delete
	const laravelRoutes: Array<[RegExp, 'GET'|'POST'|'PUT'|'PATCH'|'DELETE']> = [
		[/Route::get\s*\(\s*['"]([^'"]*)['"]/g,    'GET'],
		[/Route::post\s*\(\s*['"]([^'"]*)['"]/g,   'POST'],
		[/Route::put\s*\(\s*['"]([^'"]*)['"]/g,    'PUT'],
		[/Route::patch\s*\(\s*['"]([^'"]*)['"]/g,  'PATCH'],
		[/Route::delete\s*\(\s*['"]([^'"]*)['"]/g, 'DELETE'],
	];
	for (const [re, method] of laravelRoutes) {
		const re2 = new RegExp(re.source, re.flags);
		let m: RegExpExecArray | null;
		while ((m = re2.exec(content)) !== null) {
			out.push({ unitId, kind: `rest-${method.toLowerCase()}` as APIEndpointKind, httpMethod: method, path: m[1], lineNumber: lineOf(content, m.index) });
		}
	}

	// Symfony: #[Route("/path", methods: ["GET"])]
	const symfonyRoute = /#\[Route\s*\(\s*['"]([^'"]*)['"]/gi;
	let m: RegExpExecArray | null;
	while ((m = symfonyRoute.exec(content)) !== null) {
		out.push({ unitId, kind: 'rest-generic', path: m[1], lineNumber: lineOf(content, m.index) });
	}

	// Slim: $app->get('/path', ...)
	const slimRoutes: Array<[RegExp, 'GET'|'POST'|'PUT'|'PATCH'|'DELETE']> = [
		[/\$app->get\s*\(\s*['"]([^'"]*)['"]/g,    'GET'],
		[/\$app->post\s*\(\s*['"]([^'"]*)['"]/g,   'POST'],
		[/\$app->put\s*\(\s*['"]([^'"]*)['"]/g,    'PUT'],
		[/\$app->patch\s*\(\s*['"]([^'"]*)['"]/g,  'PATCH'],
		[/\$app->delete\s*\(\s*['"]([^'"]*)['"]/g, 'DELETE'],
	];
	for (const [re, method] of slimRoutes) {
		const re2 = new RegExp(re.source, re.flags);
		let m2: RegExpExecArray | null;
		while ((m2 = re2.exec(content)) !== null) {
			out.push({ unitId, kind: `rest-${method.toLowerCase()}` as APIEndpointKind, httpMethod: method, path: m2[1], lineNumber: lineOf(content, m2.index) });
		}
	}
}


// \u2500\u2500\u2500 Elixir / Phoenix \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectElixirEndpoints(content: string, lines: string[], unitId: string, out: IAPIEndpoint[]): void {
	// Phoenix router: get "/path", Controller, :action
	const phoenixRoutes: Array<[RegExp, 'GET'|'POST'|'PUT'|'PATCH'|'DELETE']> = [
		[/\bget\s+"([^"]+)"/g,    'GET'],
		[/\bpost\s+"([^"]+)"/g,   'POST'],
		[/\bput\s+"([^"]+)"/g,    'PUT'],
		[/\bpatch\s+"([^"]+)"/g,  'PATCH'],
		[/\bdelete\s+"([^"]+)"/g, 'DELETE'],
	];
	for (const [re, method] of phoenixRoutes) {
		const re2 = new RegExp(re.source, re.flags);
		let m: RegExpExecArray | null;
		while ((m = re2.exec(content)) !== null) {
			out.push({ unitId, kind: `rest-${method.toLowerCase()}` as APIEndpointKind, httpMethod: method, path: m[1], lineNumber: lineOf(content, m.index) });
		}
	}

	// Phoenix LiveView
	if (/use\s+Phoenix\.LiveView\b/.test(content)) {
		out.push({ unitId, kind: 'websocket-handler', lineNumber: 1 });
	}

	// Broadway (Kafka/AMQP consumer)
	if (/use\s+Broadway\b/.test(content)) {
		out.push({ unitId, kind: 'mq-listener', lineNumber: 1 });
	}
}


// \u2500\u2500\u2500 Swift / Vapor \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectSwiftEndpoints(content: string, lines: string[], unitId: string, out: IAPIEndpoint[]): void {
	// Vapor: app.get("path") { ... }
	const vaporRoutes: Array<[RegExp, 'GET'|'POST'|'PUT'|'PATCH'|'DELETE']> = [
		[/app\.get\s*\(\s*"([^"]*)"/g,    'GET'],
		[/app\.post\s*\(\s*"([^"]*)"/g,   'POST'],
		[/app\.put\s*\(\s*"([^"]*)"/g,    'PUT'],
		[/app\.patch\s*\(\s*"([^"]*)"/g,  'PATCH'],
		[/app\.delete\s*\(\s*"([^"]*)"/g, 'DELETE'],
	];
	for (const [re, method] of vaporRoutes) {
		const re2 = new RegExp(re.source, re.flags);
		let m: RegExpExecArray | null;
		while ((m = re2.exec(content)) !== null) {
			out.push({ unitId, kind: `rest-${method.toLowerCase()}` as APIEndpointKind, httpMethod: method, path: m[1], lineNumber: lineOf(content, m.index) });
		}
	}
}


// \u2500\u2500\u2500 Dart / Flutter \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectDartEndpoints(content: string, lines: string[], unitId: string, out: IAPIEndpoint[]): void {
	// Shelf / Dart Frog
	const shelfRoutes: Array<[RegExp, 'GET'|'POST'|'PUT'|'PATCH'|'DELETE']> = [
		[/Router\(\)\.get\s*\(\s*['"]([^'"]*)['"]/g,    'GET'],
		[/Router\(\)\.post\s*\(\s*['"]([^'"]*)['"]/g,   'POST'],
		[/Router\(\)\.put\s*\(\s*['"]([^'"]*)['"]/g,    'PUT'],
		[/Router\(\)\.patch\s*\(\s*['"]([^'"]*)['"]/g,  'PATCH'],
		[/Router\(\)\.delete\s*\(\s*['"]([^'"]*)['"]/g, 'DELETE'],
	];
	for (const [re, method] of shelfRoutes) {
		const re2 = new RegExp(re.source, re.flags);
		let m: RegExpExecArray | null;
		while ((m = re2.exec(content)) !== null) {
			out.push({ unitId, kind: `rest-${method.toLowerCase()}` as APIEndpointKind, httpMethod: method, path: m[1], lineNumber: lineOf(content, m.index) });
		}
	}
}


// \u2500\u2500\u2500 Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** Return 1-based line number of a character offset in content. */
function lineOf(content: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < content.length; i++) {
		if (content[i] === '\n') { line++; }
	}
	return line;
}
