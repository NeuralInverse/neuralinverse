/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Codebase Context Service
 *
 * Reads project manifest files once on startup to detect what frameworks,
 * auth libraries, and DB libraries are in use. Provides an `ICodebaseContext`
 * snapshot injected into AI analysis prompts so the LLM understands the
 * project's technology stack before analyzing any code.
 *
 * Detection is lazy — triggered 3s after construction to avoid blocking startup.
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';


// ─── Public Interface ────────────────────────────────────────────────────────

export interface ICodebaseContext {
	/** Primary language(s) detected from project files */
	primaryLanguages: string[];
	/** Web/app frameworks detected (express, fastapi, spring, django, rails, etc.) */
	frameworks: string[];
	/** Auth libraries detected (passport, jwt, firebase-auth, oauth2, etc.) */
	authLibraries: string[];
	/** Database libraries detected (mongoose, sequelize, hibernate, sqlalchemy, etc.) */
	dbLibraries: string[];
	/** Crypto libraries detected (bcrypt, crypto-js, openssl, etc.) */
	cryptoLibraries: string[];
	/** Whether tests are present */
	hasTests: boolean;
	/** Test frameworks detected */
	testFrameworks: string[];
	/** Build system detected */
	buildSystem: string | undefined;
	/** Firmware/embedded specific: RTOS detected */
	rtos: string | undefined;
	/** Firmware/embedded specific: HAL/SDK detected */
	hal: string | undefined;
	/** Industrial/OT specific: protocols detected */
	industrialProtocols: string[];
	/** Telecom specific: protocols/standards detected */
	telecomStandards: string[];
	/** Whether this appears to be a firmware/embedded project */
	isFirmware: boolean;
	/** Whether this appears to be an industrial/OT project */
	isIndustrial: boolean;
	/** Whether this appears to be a safety-critical project */
	isSafetyCritical: boolean;
	/** Detected compliance frameworks from manifest files */
	declaredComplianceFrameworks: string[];
	/** Raw risk bonus for files in this project (0–30) — added to per-file risk scores */
	projectRiskBonus: number;
}

export const ICodebaseContextService = createDecorator<ICodebaseContextService>('codebaseContextService');

export interface ICodebaseContextService {
	readonly _serviceBrand: undefined;
	/** Current detected context. May be empty until `detect()` completes. */
	readonly context: ICodebaseContext;
	/** Fires when context is first detected or changes */
	readonly onDidChangeContext: Event<ICodebaseContext>;
	/** Trigger detection (idempotent — only runs once; subsequent calls are no-ops unless force=true) */
	detect(force?: boolean): Promise<void>;
	/** Format a compact context summary suitable for injection into an AI prompt (under 400 chars) */
	formatForPrompt(): string;
}


// ─── Empty Context Sentinel ──────────────────────────────────────────────────

function emptyContext(): ICodebaseContext {
	return {
		primaryLanguages: [],
		frameworks: [],
		authLibraries: [],
		dbLibraries: [],
		cryptoLibraries: [],
		hasTests: false,
		testFrameworks: [],
		buildSystem: undefined,
		rtos: undefined,
		hal: undefined,
		industrialProtocols: [],
		telecomStandards: [],
		isFirmware: false,
		isIndustrial: false,
		isSafetyCritical: false,
		declaredComplianceFrameworks: [],
		projectRiskBonus: 0,
	};
}


// ─── Implementation ──────────────────────────────────────────────────────────

export class CodebaseContextService extends Disposable implements ICodebaseContextService {
	declare readonly _serviceBrand: undefined;

	private _context: ICodebaseContext = emptyContext();
	private _detected = false;

	private readonly _onDidChangeContext = this._register(new Emitter<ICodebaseContext>());
	public readonly onDidChangeContext: Event<ICodebaseContext> = this._onDidChangeContext.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		// Lazy detection — delay 3s so we don't slow down IDE startup
		setTimeout(() => {
			this.detect().catch(() => { /* non-fatal */ });
		}, 3_000);
	}

	public get context(): ICodebaseContext {
		return this._context;
	}


	// ─── Detection Entry Point ───────────────────────────────────────

	public async detect(force?: boolean): Promise<void> {
		if (this._detected && !force) return;
		this._detected = true;

		const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
		if (!workspaceFolders || workspaceFolders.length === 0) return;

		const rootUri = workspaceFolders[0].uri;
		const ctx = emptyContext();

		// Collect all raw manifest content for broad scanning
		const allContent: string[] = [];

		// ── package.json (Node.js) ──────────────────────────────────────
		const pkgJson = await this._tryReadText(URI.joinPath(rootUri, 'package.json'));
		if (pkgJson) {
			allContent.push(pkgJson);
			ctx.primaryLanguages.push('javascript/typescript');
			this._detectFromPackageJson(pkgJson, ctx);
			if (!ctx.buildSystem) ctx.buildSystem = 'npm';
		}

		// ── requirements.txt (Python) ───────────────────────────────────
		const reqsTxt = await this._tryReadText(URI.joinPath(rootUri, 'requirements.txt'));
		if (reqsTxt) {
			allContent.push(reqsTxt);
			if (!ctx.primaryLanguages.includes('python')) ctx.primaryLanguages.push('python');
			this._detectFromPythonDeps(reqsTxt, ctx);
			if (!ctx.buildSystem) ctx.buildSystem = 'pip';
		}

		// ── pyproject.toml (Python/Poetry) ─────────────────────────────
		const pyproject = await this._tryReadText(URI.joinPath(rootUri, 'pyproject.toml'));
		if (pyproject) {
			allContent.push(pyproject);
			if (!ctx.primaryLanguages.includes('python')) ctx.primaryLanguages.push('python');
			this._detectFromPythonDeps(pyproject, ctx);
			if (!ctx.buildSystem) ctx.buildSystem = 'poetry';
		}

		// ── setup.py (Python) ───────────────────────────────────────────
		const setupPy = await this._tryReadText(URI.joinPath(rootUri, 'setup.py'));
		if (setupPy) {
			allContent.push(setupPy);
			if (!ctx.primaryLanguages.includes('python')) ctx.primaryLanguages.push('python');
			this._detectFromPythonDeps(setupPy, ctx);
		}

		// ── pom.xml (Java Maven) ────────────────────────────────────────
		const pomXml = await this._tryReadText(URI.joinPath(rootUri, 'pom.xml'));
		if (pomXml) {
			allContent.push(pomXml);
			if (!ctx.primaryLanguages.includes('java')) ctx.primaryLanguages.push('java');
			this._detectFromMaven(pomXml, ctx);
			if (!ctx.buildSystem) ctx.buildSystem = 'maven';
		}

		// ── build.gradle (Java/Kotlin Gradle) ──────────────────────────
		const buildGradle = await this._tryReadText(URI.joinPath(rootUri, 'build.gradle'));
		const buildGradleKts = await this._tryReadText(URI.joinPath(rootUri, 'build.gradle.kts'));
		const gradleContent = (buildGradle ?? '') + (buildGradleKts ?? '');
		if (gradleContent) {
			allContent.push(gradleContent);
			if (!ctx.primaryLanguages.includes('java')) ctx.primaryLanguages.push('java');
			this._detectFromGradle(gradleContent, ctx);
			if (!ctx.buildSystem) ctx.buildSystem = 'gradle';
		}

		// ── Cargo.toml (Rust) ───────────────────────────────────────────
		const cargoToml = await this._tryReadText(URI.joinPath(rootUri, 'Cargo.toml'));
		if (cargoToml) {
			allContent.push(cargoToml);
			if (!ctx.primaryLanguages.includes('rust')) ctx.primaryLanguages.push('rust');
			if (!ctx.buildSystem) ctx.buildSystem = 'cargo';
			// Check for embedded/firmware Rust targets
			if (/no_std|cortex-m|stm32|nrf5|rp2040|avr|embedded-hal/i.test(cargoToml)) {
				ctx.isFirmware = true;
			}
		}

		// ── go.mod (Go) ─────────────────────────────────────────────────
		const goMod = await this._tryReadText(URI.joinPath(rootUri, 'go.mod'));
		if (goMod) {
			allContent.push(goMod);
			if (!ctx.primaryLanguages.includes('go')) ctx.primaryLanguages.push('go');
			if (!ctx.buildSystem) ctx.buildSystem = 'go modules';
			// Detect frameworks
			if (/gin-gonic\/gin|labstack\/echo|gorilla\/mux|gofiber\/fiber/i.test(goMod)) {
				ctx.frameworks.push('gin/echo');
			}
		}

		// ── Firmware.inverse (Neural Inverse firmware manifest) ─────────
		const firmwareInverse = await this._tryReadText(URI.joinPath(rootUri, 'Firmware.inverse'));
		if (firmwareInverse) {
			allContent.push(firmwareInverse);
			this._detectFromFirmwareInverse(firmwareInverse, ctx);
		}

		// ── CMakeLists.txt (C/C++ CMake) ────────────────────────────────
		const cmake = await this._tryReadText(URI.joinPath(rootUri, 'CMakeLists.txt'));
		if (cmake) {
			allContent.push(cmake);
			if (!ctx.primaryLanguages.includes('c/c++')) ctx.primaryLanguages.push('c/c++');
			this._detectFromCMake(cmake, ctx);
			if (!ctx.buildSystem) ctx.buildSystem = 'cmake';
		}

		// ── platformio.ini (PlatformIO firmware) ────────────────────────
		const platformio = await this._tryReadText(URI.joinPath(rootUri, 'platformio.ini'));
		if (platformio) {
			allContent.push(platformio);
			ctx.isFirmware = true;
			if (!ctx.primaryLanguages.includes('c/c++')) ctx.primaryLanguages.push('c/c++');
			if (!ctx.buildSystem) ctx.buildSystem = 'platformio';
			// Detect board/framework from platformio.ini
			if (/freertos/i.test(platformio) && !ctx.rtos) ctx.rtos = 'FreeRTOS';
			if (/zephyr/i.test(platformio) && !ctx.rtos) ctx.rtos = 'Zephyr';
		}

		// ── Makefile ────────────────────────────────────────────────────
		const makefile = await this._tryReadText(URI.joinPath(rootUri, 'Makefile'));
		if (makefile) {
			allContent.push(makefile);
			if (!ctx.buildSystem) ctx.buildSystem = 'make';
			this._detectFromCMake(makefile, ctx); // reuse same detection patterns
		}

		// ── meson.build ─────────────────────────────────────────────────
		const meson = await this._tryReadText(URI.joinPath(rootUri, 'meson.build'));
		if (meson) {
			allContent.push(meson);
			if (!ctx.buildSystem) ctx.buildSystem = 'meson';
			if (!ctx.primaryLanguages.includes('c/c++')) ctx.primaryLanguages.push('c/c++');
		}

		// ── prj.conf (Zephyr RTOS) ──────────────────────────────────────
		const prjConf = await this._tryReadText(URI.joinPath(rootUri, 'prj.conf'));
		if (prjConf) {
			allContent.push(prjConf);
			ctx.isFirmware = true;
			if (!ctx.rtos) ctx.rtos = 'Zephyr';
			if (!ctx.primaryLanguages.includes('c/c++')) ctx.primaryLanguages.push('c/c++');
		}

		// ── sdkconfig (ESP-IDF) ─────────────────────────────────────────
		const sdkconfig = await this._tryReadText(URI.joinPath(rootUri, 'sdkconfig'));
		if (sdkconfig) {
			allContent.push(sdkconfig);
			ctx.isFirmware = true;
			if (!ctx.rtos) ctx.rtos = 'FreeRTOS'; // ESP-IDF uses FreeRTOS
			if (!ctx.hal) ctx.hal = 'ESP-IDF';
			if (!ctx.primaryLanguages.includes('c/c++')) ctx.primaryLanguages.push('c/c++');
		}

		// ── Cross-manifest safety + industrial detection ─────────────────
		const allText = allContent.join('\n');
		this._detectIndustrialProtocols(allText, ctx);
		this._detectSafetyCritical(allText, ctx);
		this._detectTelecomStandards(allText, ctx);

		// ── Compute projectRiskBonus ─────────────────────────────────────
		ctx.projectRiskBonus = this._computeRiskBonus(ctx);

		this._context = ctx;
		this._onDidChangeContext.fire(ctx);

		const summary = this.formatForPrompt();
		console.log(`[CodebaseContext] Detection complete: ${summary}`);
	}


	// ─── package.json detection ──────────────────────────────────────

	private _detectFromPackageJson(content: string, ctx: ICodebaseContext): void {
		let pkg: any;
		try {
			pkg = JSON.parse(content);
		} catch {
			return;
		}

		const deps: Record<string, string> = {
			...(pkg.dependencies ?? {}),
			...(pkg.devDependencies ?? {}),
		};

		const depNames = Object.keys(deps).map(d => d.toLowerCase());

		// Frameworks
		if (depNames.some(d => ['express', 'express-async-errors'].includes(d))) ctx.frameworks.push('express');
		if (depNames.includes('fastify')) ctx.frameworks.push('fastify');
		if (depNames.includes('@nestjs/core') || depNames.includes('@nestjs/common')) ctx.frameworks.push('nestjs');
		if (depNames.includes('koa')) ctx.frameworks.push('koa');
		if (depNames.includes('@hapi/hapi') || depNames.includes('hapi')) ctx.frameworks.push('hapi');
		if (depNames.includes('next') || depNames.includes('next.js')) ctx.frameworks.push('nextjs');
		if (depNames.includes('nuxt') || depNames.includes('@nuxt/core')) ctx.frameworks.push('nuxt');
		if (depNames.includes('@remix-run/node') || depNames.includes('@remix-run/react')) ctx.frameworks.push('remix');
		if (depNames.includes('@sveltejs/kit')) ctx.frameworks.push('sveltekit');
		if (depNames.includes('@angular/core')) ctx.frameworks.push('angular');
		if (depNames.includes('vue') || depNames.includes('@vue/core')) ctx.frameworks.push('vue');
		if (depNames.includes('react') && !ctx.frameworks.includes('nextjs') && !ctx.frameworks.includes('remix')) ctx.frameworks.push('react');

		// Auth libraries
		if (depNames.includes('passport')) ctx.authLibraries.push('passport');
		if (depNames.includes('jsonwebtoken') || depNames.includes('jwt-simple')) ctx.authLibraries.push('jsonwebtoken');
		if (depNames.includes('firebase-admin') || depNames.includes('firebase')) ctx.authLibraries.push('firebase-auth');
		if (depNames.some(d => ['auth0', 'auth0-js'].includes(d))) ctx.authLibraries.push('auth0');
		if (depNames.includes('@okta/okta-sdk-nodejs') || depNames.includes('@okta/oidc-middleware')) ctx.authLibraries.push('okta');
		if (depNames.includes('keycloak-connect') || depNames.includes('keycloak-js')) ctx.authLibraries.push('keycloak');
		if (depNames.includes('oauth2-server') || depNames.includes('node-oauth2-server')) ctx.authLibraries.push('oauth2-server');
		if (depNames.includes('express-session') || depNames.includes('cookie-session')) ctx.authLibraries.push('session-auth');

		// DB libraries
		if (depNames.includes('mongoose')) ctx.dbLibraries.push('mongoose');
		if (depNames.includes('sequelize') || depNames.includes('@sequelize/core')) ctx.dbLibraries.push('sequelize');
		if (depNames.includes('typeorm')) ctx.dbLibraries.push('typeorm');
		if (depNames.includes('@prisma/client') || depNames.includes('prisma')) ctx.dbLibraries.push('prisma');
		if (depNames.includes('knex')) ctx.dbLibraries.push('knex');
		if (depNames.includes('pg') || depNames.includes('postgres')) ctx.dbLibraries.push('postgres');
		if (depNames.includes('mysql') || depNames.includes('mysql2')) ctx.dbLibraries.push('mysql');
		if (depNames.includes('sqlite3') || depNames.includes('better-sqlite3')) ctx.dbLibraries.push('sqlite');
		if (depNames.includes('redis') || depNames.includes('ioredis')) ctx.dbLibraries.push('redis');
		if (depNames.includes('dynamodb') || depNames.includes('@aws-sdk/client-dynamodb')) ctx.dbLibraries.push('dynamodb');

		// Crypto libraries
		if (depNames.includes('bcrypt') || depNames.includes('bcryptjs')) ctx.cryptoLibraries.push('bcrypt');
		if (depNames.includes('argon2')) ctx.cryptoLibraries.push('argon2');
		if (depNames.includes('crypto-js')) ctx.cryptoLibraries.push('crypto-js');
		if (depNames.includes('node-forge')) ctx.cryptoLibraries.push('node-forge');
		if (depNames.includes('jose')) ctx.cryptoLibraries.push('jose');

		// Test frameworks
		if (depNames.includes('jest') || depNames.includes('@jest/core')) { ctx.testFrameworks.push('jest'); ctx.hasTests = true; }
		if (depNames.includes('mocha')) { ctx.testFrameworks.push('mocha'); ctx.hasTests = true; }
		if (depNames.includes('jasmine')) { ctx.testFrameworks.push('jasmine'); ctx.hasTests = true; }
		if (depNames.includes('vitest')) { ctx.testFrameworks.push('vitest'); ctx.hasTests = true; }
		if (depNames.includes('tap') || depNames.includes('node-tap')) { ctx.testFrameworks.push('tap'); ctx.hasTests = true; }
		if (depNames.includes('ava')) { ctx.testFrameworks.push('ava'); ctx.hasTests = true; }
		if (depNames.includes('cypress') || depNames.includes('playwright')) { ctx.testFrameworks.push('e2e'); ctx.hasTests = true; }
	}


	// ─── Python detection ────────────────────────────────────────────

	private _detectFromPythonDeps(content: string, ctx: ICodebaseContext): void {
		const lower = content.toLowerCase();

		// Frameworks
		if (/\bdjango\b/.test(lower)) ctx.frameworks.push('django');
		if (/\bflask\b/.test(lower)) ctx.frameworks.push('flask');
		if (/\bfastapi\b/.test(lower)) ctx.frameworks.push('fastapi');
		if (/\btornado\b/.test(lower)) ctx.frameworks.push('tornado');
		if (/\baiohttp\b/.test(lower)) ctx.frameworks.push('aiohttp');
		if (/\bstarlette\b/.test(lower)) ctx.frameworks.push('starlette');

		// Auth
		if (/\bpyjwt\b|\bjwt\b/.test(lower)) ctx.authLibraries.push('pyjwt');
		if (/\bpython-jose\b|\bjose\b/.test(lower)) ctx.authLibraries.push('python-jose');
		if (/\bfirebase-admin\b/.test(lower)) ctx.authLibraries.push('firebase-auth');
		if (/\bauth0\b/.test(lower)) ctx.authLibraries.push('auth0');
		if (/\boauthlib\b/.test(lower)) ctx.authLibraries.push('oauthlib');

		// DB
		if (/\bsqlalchemy\b/.test(lower)) ctx.dbLibraries.push('sqlalchemy');
		if (/\bpsycopg2?\b/.test(lower)) ctx.dbLibraries.push('postgres');
		if (/\bpymongo\b/.test(lower)) ctx.dbLibraries.push('mongodb');
		if (/\bmysql-connector\b|\bpymysql\b/.test(lower)) ctx.dbLibraries.push('mysql');
		if (/\baioredis\b|\bredis\b/.test(lower)) ctx.dbLibraries.push('redis');
		if (/\btortoise-orm\b/.test(lower)) ctx.dbLibraries.push('tortoise-orm');
		if (/\bcelery\b/.test(lower)) ctx.dbLibraries.push('celery');

		// Crypto
		if (/\bbcrypt\b/.test(lower)) ctx.cryptoLibraries.push('bcrypt');
		if (/\bcryptography\b/.test(lower)) ctx.cryptoLibraries.push('cryptography');
		if (/\bnacl\b|\bpynacl\b/.test(lower)) ctx.cryptoLibraries.push('nacl');
		if (/\bpasslib\b/.test(lower)) ctx.cryptoLibraries.push('passlib');

		// Test
		if (/\bpytest\b/.test(lower)) { ctx.testFrameworks.push('pytest'); ctx.hasTests = true; }
		if (/\bunittest\b/.test(lower)) { ctx.testFrameworks.push('unittest'); ctx.hasTests = true; }
		if (/\bhypothesis\b/.test(lower)) { ctx.testFrameworks.push('hypothesis'); ctx.hasTests = true; }
	}


	// ─── Java Maven detection ────────────────────────────────────────

	private _detectFromMaven(content: string, ctx: ICodebaseContext): void {
		const lower = content.toLowerCase();

		if (/spring-boot|spring-web|spring-framework/.test(lower)) ctx.frameworks.push('spring');
		if (/quarkus/.test(lower)) ctx.frameworks.push('quarkus');
		if (/micronaut/.test(lower)) ctx.frameworks.push('micronaut');
		if (/hibernate/.test(lower)) ctx.dbLibraries.push('hibernate');
		if (/mysql-connector/.test(lower)) ctx.dbLibraries.push('mysql');
		if (/postgresql/.test(lower)) ctx.dbLibraries.push('postgres');
		if (/h2/.test(lower)) ctx.dbLibraries.push('h2');
		if (/redis|lettuce/.test(lower)) ctx.dbLibraries.push('redis');
		if (/jackson/.test(lower)) ctx.frameworks.push('jackson');
		if (/log4j|slf4j|logback/.test(lower)) { /* logging — no action */ }
		if (/junit|mockito|testng/.test(lower)) { ctx.testFrameworks.push('junit'); ctx.hasTests = true; }
		if (/spring-security|java-jwt|jjwt/.test(lower)) ctx.authLibraries.push('spring-security');
		if (/bouncy-castle|bcprov/.test(lower)) ctx.cryptoLibraries.push('bouncy-castle');
	}


	// ─── Gradle detection ────────────────────────────────────────────

	private _detectFromGradle(content: string, ctx: ICodebaseContext): void {
		// Reuse Maven patterns — Gradle manifests contain similar artifact names
		this._detectFromMaven(content, ctx);
		if (/kotlin/.test(content.toLowerCase())) {
			if (!ctx.primaryLanguages.includes('kotlin')) ctx.primaryLanguages.push('kotlin');
		}
	}


	// ─── Firmware.inverse detection ──────────────────────────────────

	private _detectFromFirmwareInverse(content: string, ctx: ICodebaseContext): void {
		ctx.isFirmware = true;
		try {
			const parsed = JSON.parse(content);

			if (parsed.mcu) ctx.hal = String(parsed.mcu);
			if (parsed.rtos) ctx.rtos = String(parsed.rtos);
			if (parsed.hal) ctx.hal = String(parsed.hal);
			if (parsed.buildSystem && !ctx.buildSystem) ctx.buildSystem = String(parsed.buildSystem);

			// Detect compliance frameworks
			if (Array.isArray(parsed.compliance)) {
				for (const fw of parsed.compliance) {
					ctx.declaredComplianceFrameworks.push(String(fw));
				}
			}

			// Detect primary language from mcu/target hints
			if (/arm|cortex|stm32|nrf|esp|pic|avr/i.test(content)) {
				if (!ctx.primaryLanguages.includes('c/c++')) ctx.primaryLanguages.push('c/c++');
			}

			if (!ctx.buildSystem) ctx.buildSystem = 'cmake';
		} catch {
			// Not valid JSON — parse key fields via text search
			if (/rtos.*freertos/i.test(content) && !ctx.rtos) ctx.rtos = 'FreeRTOS';
			if (/rtos.*zephyr/i.test(content) && !ctx.rtos) ctx.rtos = 'Zephyr';
			if (/rtos.*threadx/i.test(content) && !ctx.rtos) ctx.rtos = 'ThreadX';
		}
	}


	// ─── CMake / Makefile detection ──────────────────────────────────

	private _detectFromCMake(content: string, ctx: ICodebaseContext): void {
		const lower = content.toLowerCase();

		if (!ctx.primaryLanguages.includes('c/c++')) ctx.primaryLanguages.push('c/c++');

		// RTOS detection
		if (/freertos/i.test(lower) && !ctx.rtos) { ctx.rtos = 'FreeRTOS'; ctx.isFirmware = true; }
		if (/zephyr/i.test(lower) && !ctx.rtos) { ctx.rtos = 'Zephyr'; ctx.isFirmware = true; }
		if (/mbed\s*os|mbedos/i.test(lower) && !ctx.rtos) { ctx.rtos = 'Mbed OS'; ctx.isFirmware = true; }
		if (/threadx/i.test(lower) && !ctx.rtos) { ctx.rtos = 'ThreadX'; ctx.isFirmware = true; }
		if (/rtx5|cmsis-rtos/i.test(lower) && !ctx.rtos) { ctx.rtos = 'CMSIS-RTOS'; ctx.isFirmware = true; }

		// HAL/SDK detection
		if (/arduino/i.test(lower) && !ctx.hal) { ctx.hal = 'Arduino'; ctx.isFirmware = true; }
		if (/stm32/i.test(lower) && !ctx.hal) { ctx.hal = 'STM32 HAL'; ctx.isFirmware = true; }
		if (/esp-idf|esp32|esp8266/i.test(lower) && !ctx.hal) { ctx.hal = 'ESP-IDF'; ctx.isFirmware = true; }
		if (/nordic|nrf5\d*/i.test(lower) && !ctx.hal) { ctx.hal = 'nRF SDK'; ctx.isFirmware = true; }
		if (/raspberry.*pico|rp2040/i.test(lower) && !ctx.hal) { ctx.hal = 'Pico SDK'; ctx.isFirmware = true; }

		// Security libs
		if (/mbedtls|openssl|wolfssl/i.test(lower)) ctx.cryptoLibraries.push('mbedtls/openssl');
		if (/lwip/i.test(lower)) ctx.frameworks.push('lwIP');
	}


	// ─── Industrial protocol detection ───────────────────────────────

	private _detectIndustrialProtocols(allText: string, ctx: ICodebaseContext): void {
		const lower = allText.toLowerCase();
		const protocols: Array<[RegExp, string]> = [
			[/\bmodbus\b/, 'Modbus'],
			[/\bdnp3\b/, 'DNP3'],
			[/\bprofibus\b/, 'PROFIBUS'],
			[/\bopc.?ua\b/, 'OPC-UA'],
			[/\bbacnet\b/, 'BACnet'],
			[/\bcanopen\b/, 'CANopen'],
			[/\bcan\s*bus\b/, 'CAN Bus'],
			[/\bethernet.?ip\b|\benip\b/, 'EtherNet/IP'],
			[/\bprofinet\b/, 'PROFINET'],
			[/\bhart\b/, 'HART'],
			[/\biec\s*61850\b/, 'IEC 61850'],
			[/\biec\s*60870\b/, 'IEC 60870'],
		];

		for (const [pattern, name] of protocols) {
			if (pattern.test(lower)) {
				ctx.industrialProtocols.push(name);
				ctx.isIndustrial = true;
			}
		}
	}


	// ─── Safety-critical detection ───────────────────────────────────

	private _detectSafetyCritical(allText: string, ctx: ICodebaseContext): void {
		const lower = allText.toLowerCase();
		const frameworks: Array<[RegExp, string]> = [
			[/\bmisra\b/, 'MISRA C'],
			[/\biso.?26262\b/, 'ISO 26262'],
			[/\biec.?62304\b/, 'IEC 62304'],
			[/\bdo.?178[bc]\b/, 'DO-178C'],
			[/\biec.?61508\b/, 'IEC 61508'],
			[/\bautosar\b/, 'AUTOSAR'],
			[/\biec.?61511\b/, 'IEC 61511'],
			[/\ben.?50128\b/, 'EN 50128'],
			[/\biec.?62443\b/, 'IEC 62443'],
			[/\bnist\s*sp\s*800\b/, 'NIST SP 800'],
		];

		for (const [pattern, name] of frameworks) {
			if (pattern.test(lower)) {
				ctx.declaredComplianceFrameworks.push(name);
				ctx.isSafetyCritical = true;
			}
		}
	}


	// ─── Telecom standards detection ─────────────────────────────────

	private _detectTelecomStandards(allText: string, ctx: ICodebaseContext): void {
		const lower = allText.toLowerCase();
		const standards: Array<[RegExp, string]> = [
			[/\b3gpp\b/, '3GPP'],
			[/\blte\b/, 'LTE'],
			[/\b5g-nr\b|\b5gnr\b/, '5G NR'],
			[/\bdiameter\b/, 'Diameter'],
			[/\bss7\b/, 'SS7'],
			[/\bsip\b/, 'SIP'],
			[/\bsctp\b/, 'SCTP'],
			[/\bgsma\b/, 'GSMA'],
		];

		for (const [pattern, name] of standards) {
			if (pattern.test(lower)) {
				ctx.telecomStandards.push(name);
			}
		}
	}


	// ─── Risk bonus calculation ──────────────────────────────────────

	private _computeRiskBonus(ctx: ICodebaseContext): number {
		if (ctx.isFirmware && ctx.isSafetyCritical) return 30;
		if (ctx.isIndustrial && ctx.isSafetyCritical) return 30;
		if (ctx.isFirmware) return 20;
		if (ctx.isIndustrial) return 20;
		if (ctx.isSafetyCritical) return 15;
		if (ctx.authLibraries.length > 0 && ctx.dbLibraries.length > 0) return 10;
		return 0;
	}


	// ─── Prompt Formatting ───────────────────────────────────────────

	public formatForPrompt(): string {
		const ctx = this._context;

		if (ctx.primaryLanguages.length === 0 && ctx.frameworks.length === 0) {
			return '';
		}

		let parts: string[] = [];

		if (ctx.isFirmware) {
			const hw = [ctx.hal, ctx.rtos].filter(Boolean).join(' + ');
			const safety = ctx.declaredComplianceFrameworks.length > 0
				? `Safety frameworks: ${ctx.declaredComplianceFrameworks.slice(0, 3).join(', ')}.`
				: '';
			parts.push(`Firmware project: ${hw || ctx.primaryLanguages.join('/')}. ${safety} isSafetyCritical=${ctx.isSafetyCritical}.`);
		} else if (ctx.telecomStandards && ctx.telecomStandards.length > 0) {
			const safety = ctx.declaredComplianceFrameworks.length > 0
				? ` Compliance: ${ctx.declaredComplianceFrameworks.slice(0, 3).join(', ')}.`
				: '';
			parts.push(`Telecom/5G project. Standards: ${ctx.telecomStandards.slice(0, 4).join(', ')}.${safety} isSafetyCritical=${ctx.isSafetyCritical}.`);
		} else if (ctx.isIndustrial) {
			const protocols = ctx.industrialProtocols.length > 0
				? ` Protocols: ${ctx.industrialProtocols.slice(0, 4).join(', ')}.`
				: '';
			const safety = ctx.declaredComplianceFrameworks.length > 0
				? ` Compliance: ${ctx.declaredComplianceFrameworks.slice(0, 3).join(', ')}.`
				: '';
			parts.push(`Industrial/OT project.${protocols}${safety} isSafetyCritical=${ctx.isSafetyCritical}.`);
		} else {
			const stack: string[] = [...ctx.primaryLanguages.slice(0, 2), ...ctx.frameworks.slice(0, 3)];
			parts.push(`Project: ${stack.join(' + ')}.`);

			if (ctx.authLibraries.length > 0) {
				parts.push(`Auth: ${ctx.authLibraries.slice(0, 3).join(', ')}.`);
			}
			if (ctx.dbLibraries.length > 0) {
				parts.push(`DB: ${ctx.dbLibraries.slice(0, 3).join(', ')}.`);
			}
			if (ctx.cryptoLibraries.length > 0) {
				parts.push(`Crypto: ${ctx.cryptoLibraries.slice(0, 2).join(', ')}.`);
			}
			if (ctx.testFrameworks.length > 0) {
				parts.push(`Tests: ${ctx.testFrameworks.slice(0, 2).join(', ')}.`);
			}
			if (ctx.declaredComplianceFrameworks.length > 0) {
				parts.push(`Compliance: ${ctx.declaredComplianceFrameworks.slice(0, 3).join(', ')}.`);
			}
		}

		const raw = parts.join(' ');
		// Cap at 400 chars
		return raw.length > 400 ? raw.slice(0, 397) + '...' : raw;
	}


	// ─── Helpers ─────────────────────────────────────────────────────

	private async _tryReadText(uri: URI): Promise<string | undefined> {
		try {
			const file = await this.fileService.readFile(uri);
			return file.value.toString();
		} catch {
			return undefined;
		}
	}
}


// ─── Registration ────────────────────────────────────────────────────────────

registerSingleton(ICodebaseContextService, CodebaseContextService, InstantiationType.Delayed);
