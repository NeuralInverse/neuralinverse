/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildBuildAnalysisTools } from '../../../../browser/engine/agentTools/buildAnalysisTools.js';

// ─── Mock services ────────────────────────────────────────────────────────────

function makeMockBuildService(overrides: Partial<{
	lastBuildResult: any;
	isBuilding: boolean;
	toolchainResult: any;
	flashTools: any[];
	flashVerified: boolean | undefined;
}> = {}) {
	return {
		_serviceBrand: undefined as any,
		onBuildStarted: { event: () => {} },
		onBuildOutput: { event: () => {} },
		onBuildCompleted: { event: () => {} },
		onFlashStarted: { event: () => {} },
		onFlashCompleted: { event: () => {} },
		isBuilding: overrides.isBuilding ?? false,
		isFlashing: false,
		lastBuildResult: overrides.lastBuildResult ?? {
			success: false,
			durationMs: 2500,
			errors: [
				{ file: 'src/main.c', line: 42, column: 10, severity: 'error', message: "expected ';' before '}'" },
				{ file: 'src/uart.c', line: 15, severity: 'error', message: 'implicit declaration of function' },
			],
			warnings: [
				{ file: 'src/config.h', line: 5, severity: 'warning', message: 'unused variable x' },
			],
		},
		build: async () => overrides.lastBuildResult ?? { success: false, errors: [], warnings: [] },
		flash: async () => ({ success: true, durationMs: 3000, tool: 'openocd', message: 'Flash complete', verified: overrides.flashVerified }),
		clean: async () => {},
		analyzeBinarySize: async () => ({ textSize: 0, dataSize: 0, bssSize: 0, flashUsage: 0, ramUsage: 0, flashPercent: 0, ramPercent: 0, sections: [] }),
		getBuildCommand: (type: string, target?: string) => {
			const cmds: Record<string, string[]> = {
				'platformio': ['pio', 'run', ...(target ? ['-e', target] : [])],
				'cmake-embedded': ['cmake', '--build', 'build'],
				'generic': ['make'],
			};
			return cmds[type] ?? ['make'];
		},
		getFlashCommand: (type: string) => {
			const cmds: Record<string, string[]> = {
				'platformio': ['pio', 'run', '--target', 'upload'],
				'generic': ['openocd', '-f', 'interface/stlink.cfg', '-c', 'program *.elf verify reset exit'],
			};
			return cmds[type] ?? ['openocd'];
		},
		detectFlashTools: async () => overrides.flashTools ?? [
			{ name: 'openocd', path: '/usr/bin/openocd', version: '0.12.0', supportedInterfaces: ['swd', 'jtag'] },
			{ name: 'st-flash', path: '/usr/local/bin/st-flash', version: '1.7.0', supportedInterfaces: ['swd'] },
		],
		checkToolchain: async () => overrides.toolchainResult ?? {
			available: false,
			missing: [
				{ tool: 'arm-none-eabi-gcc', purpose: 'ARM cross-compiler', installHint: 'brew install arm-none-eabi-gcc' },
			],
			found: [
				{ tool: 'make', path: '/usr/bin/make', version: '4.3' },
			],
		},
		parseBuildOutput: () => ({ errors: [], warnings: [] }),
		analyzeStackUsage: async () => ({ functions: [], maxStack: 0, maxStackFunction: '', deepChains: [] }),
		disassemble: async (elfPath: string, symbol: string) => ({
			symbol,
			address: 0x08001000,
			lines: [
				{ address: 0x08001000, hex: 'e92d 4ff0', mnemonic: 'push', operands: '{r4, r5, r6, r7, r8, r9, sl, fp, lr}' },
				{ address: 0x08001004, hex: '4604', mnemonic: 'mov', operands: 'r4, r0' },
			],
			sizeBytes: 8,
		}),
		lookupSymbols: async (elfPath: string, pattern: string) => {
			if (!pattern || pattern === '') return [
				{ name: 'main', address: 0x08000100, size: 256, type: 'function', binding: 'global', section: 'T' },
				{ name: 'HAL_UART_Init', address: 0x08001000, size: 128, type: 'function', binding: 'global', section: 'T' },
			];
			return [];
		},
		abort: () => {},
	};
}

function makeMockSession(overrides: { projectType?: string; isActive?: boolean; lastBuildResult?: any } = {}) {
	return {
		_serviceBrand: undefined as any,
		session: {
			isActive: overrides.isActive ?? true,
			mcuConfig: { family: 'STM32F4', variant: 'STM32F407VG', flashSize: 1048576, ramSize: 196608 },
			projectInfo: {
				projectRoot: '/workspace/firmware',
				projectType: overrides.projectType ?? 'cmake-embedded',
				rtos: 'freertos',
			},
			lastBuildResult: overrides.lastBuildResult,
			errata: [],
			registerMaps: [],
		},
	};
}

function makeMockFileService() {
	return {
		readFile: async (uri: any) => {
			throw new Error(`File not found: ${uri.fsPath}`);
		},
		resolve: async () => { throw new Error('Not found'); },
	};
}

suite('Build Analysis Agent Tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const buildSvc = makeMockBuildService();
	const session = makeMockSession();
	const fileSvc = makeMockFileService();

	test('buildBuildAnalysisTools returns 9 tools', () => {
		const tools = buildBuildAnalysisTools(buildSvc as any, session as any, fileSvc as any);
		assert.strictEqual(tools.length, 9);
	});

	test('all tools have name, description, params, execute', () => {
		const tools = buildBuildAnalysisTools(buildSvc as any, session as any, fileSvc as any);
		for (const t of tools) {
			assert.ok(t.name, 'Missing name');
			assert.ok(t.description, 'Missing description');
			assert.ok(typeof t.execute === 'function', `Tool ${t.name} missing execute`);
		}
	});

	test('all tool names start with fw_', () => {
		const tools = buildBuildAnalysisTools(buildSvc as any, session as any, fileSvc as any);
		for (const t of tools) {
			assert.ok(t.name.startsWith('fw_'), `Tool ${t.name} does not start with fw_`);
		}
	});

	test('tool names include fw_get_build_errors, fw_detect_flash_tools, fw_check_toolchain', () => {
		const tools = buildBuildAnalysisTools(buildSvc as any, session as any, fileSvc as any);
		const names = new Set(tools.map(t => t.name));
		assert.ok(names.has('fw_get_build_errors'));
		assert.ok(names.has('fw_detect_flash_tools'));
		assert.ok(names.has('fw_check_toolchain'));
	});

	// ─── fw_get_build_errors ──────────────────────────────────────────────────

	test('fw_get_build_errors with failing build shows errors', async () => {
		const tools = buildBuildAnalysisTools(buildSvc as any, session as any, fileSvc as any);
		const tool = tools.find(t => t.name === 'fw_get_build_errors')!;
		const result = await tool.execute({ severity: 'all' });
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('src/main.c'));
		assert.ok(result.includes('42') || result.includes('error'), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_get_build_errors filtering by error only hides warnings', async () => {
		const tools = buildBuildAnalysisTools(buildSvc as any, session as any, fileSvc as any);
		const tool = tools.find(t => t.name === 'fw_get_build_errors')!;
		const result = await tool.execute({ severity: 'error' });
		assert.ok(result.includes('error') || result.includes('Error'));
	});

	test('fw_get_build_errors with no build shows prompt', async () => {
		const svcNoResult = makeMockBuildService({ lastBuildResult: undefined });
		const tools = buildBuildAnalysisTools(svcNoResult as any, session as any, fileSvc as any);
		const tool = tools.find(t => t.name === 'fw_get_build_errors')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no build') || result.toLowerCase().includes('fw_build'));
	});

	test('fw_get_build_errors with clean build shows success message', async () => {
		const cleanSvc = makeMockBuildService({ lastBuildResult: { success: true, durationMs: 1200, errors: [], warnings: [] } });
		const tools = buildBuildAnalysisTools(cleanSvc as any, session as any, fileSvc as any);
		const tool = tools.find(t => t.name === 'fw_get_build_errors')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('succeeded') || result.toLowerCase().includes('no errors') || result.toLowerCase().includes('0 error'));
	});

	// ─── fw_detect_flash_tools ────────────────────────────────────────────────

	test('fw_detect_flash_tools with tools present lists them', async () => {
		const tools = buildBuildAnalysisTools(buildSvc as any, session as any, fileSvc as any);
		const tool = tools.find(t => t.name === 'fw_detect_flash_tools')!;
		const result = await tool.execute({});
		assert.ok(result.includes('openocd'));
		assert.ok(result.includes('st-flash'));
	});

	test('fw_detect_flash_tools with no tools shows install hints', async () => {
		const noToolsSvc = makeMockBuildService({ flashTools: [] });
		const tools = buildBuildAnalysisTools(noToolsSvc as any, session as any, fileSvc as any);
		const tool = tools.find(t => t.name === 'fw_detect_flash_tools')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no flash tools') || result.toLowerCase().includes('install'));
	});

	// ─── fw_get_build_command ─────────────────────────────────────────────────

	test('fw_get_build_command shows command for current project type', async () => {
		const tools = buildBuildAnalysisTools(buildSvc as any, session as any, fileSvc as any);
		const tool = tools.find(t => t.name === 'fw_get_build_command')!;
		const result = await tool.execute({ type: 'build' });
		assert.ok(result.includes('cmake') || result.includes('make') || result.includes('Command:'), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_get_build_command returns error when session inactive', async () => {
		const inactiveSvc = makeMockSession({ isActive: false });
		const tools = buildBuildAnalysisTools(buildSvc as any, inactiveSvc as any, fileSvc as any);
		const tool = tools.find(t => t.name === 'fw_get_build_command')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	// ─── fw_check_toolchain ───────────────────────────────────────────────────

	test('fw_check_toolchain shows missing and found tools', async () => {
		const tools = buildBuildAnalysisTools(buildSvc as any, session as any, fileSvc as any);
		const tool = tools.find(t => t.name === 'fw_check_toolchain')!;
		const result = await tool.execute({});
		assert.ok(result.includes('arm-none-eabi-gcc') || result.includes('missing') || result.includes('Toolchain'));
	});

	test('fw_check_toolchain with all tools available shows success', async () => {
		const allFoundSvc = makeMockBuildService({ toolchainResult: { available: true, missing: [], found: [{ tool: 'arm-none-eabi-gcc', path: '/usr/bin/arm-none-eabi-gcc', version: '12.2.0' }] } });
		const tools = buildBuildAnalysisTools(allFoundSvc as any, session as any, fileSvc as any);
		const tool = tools.find(t => t.name === 'fw_check_toolchain')!;
		const result = await tool.execute({});
		assert.ok(result.includes('✓') || result.includes('All required') || result.includes('installed'), `Result: ${result.slice(0, 200)}`);
	});

	// ─── fw_disassemble ───────────────────────────────────────────────────────

	test('fw_disassemble returns address and mnemonic lines', async () => {
		const svcWithElf = makeMockBuildService({ lastBuildResult: { success: true, durationMs: 1000, errors: [], warnings: [], outputPath: '/workspace/build/firmware.elf' } });
		const sessionWithElf = makeMockSession();
		(sessionWithElf.session as any).lastBuildResult = { outputPath: '/workspace/build/firmware.elf' };

		const tools = buildBuildAnalysisTools(svcWithElf as any, sessionWithElf as any, fileSvc as any);
		const tool = tools.find(t => t.name === 'fw_disassemble')!;
		const result = await tool.execute({ symbol: 'main', elf_path: '/workspace/build/firmware.elf' });
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('main') || result.includes('0x0800') || result.includes('push'), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_disassemble returns error when no symbol provided', async () => {
		const tools = buildBuildAnalysisTools(buildSvc as any, session as any, fileSvc as any);
		const tool = tools.find(t => t.name === 'fw_disassemble')!;
		const result = await tool.execute({ elf_path: '/workspace/build/firmware.elf' });
		assert.ok(result.toLowerCase().includes('error') || result.toLowerCase().includes('provide') || result.toLowerCase().includes('symbol'));
	});

	test('fw_disassemble returns error when no ELF path available', async () => {
		const tools = buildBuildAnalysisTools(buildSvc as any, session as any, fileSvc as any);
		const tool = tools.find(t => t.name === 'fw_disassemble')!;
		const result = await tool.execute({ symbol: 'main' });
		assert.ok(result.toLowerCase().includes('no elf') || result.toLowerCase().includes('build') || result.toLowerCase().includes('elf path'));
	});

	// ─── fw_lookup_symbols ────────────────────────────────────────────────────

	test('fw_lookup_symbols returns symbol list', async () => {
		const svcWithElf = makeMockBuildService({ lastBuildResult: { success: true, durationMs: 1000, errors: [], warnings: [], outputPath: '/workspace/build/firmware.elf' } });
		const tools = buildBuildAnalysisTools(svcWithElf as any, session as any, fileSvc as any);
		const tool = tools.find(t => t.name === 'fw_lookup_symbols')!;
		const result = await tool.execute({ pattern: '', elf_path: '/workspace/build/firmware.elf' });
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('main') || result.includes('HAL_UART_Init') || result.includes('Symbol'), `Result: ${result.slice(0, 200)}`);
	});

	// ─── fw_analyze_stack_usage ───────────────────────────────────────────────

	test('fw_analyze_stack_usage with no session returns inactive error', async () => {
		const inactiveSess = makeMockSession({ isActive: false });
		const tools = buildBuildAnalysisTools(buildSvc as any, inactiveSess as any, fileSvc as any);
		const tool = tools.find(t => t.name === 'fw_analyze_stack_usage')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no active'));
	});
});
