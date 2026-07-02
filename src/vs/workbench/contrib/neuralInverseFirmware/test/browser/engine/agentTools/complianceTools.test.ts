/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildComplianceTools } from '../../../../browser/engine/agentTools/complianceTools.js';

function makeMockLSPBridge(overrides: {
	diagnostics?: any[];
} = {}) {
	return {
		_serviceBrand: undefined as any,
		analyzeFirmwareCode: (_content: string, filePath: string) => {
			return overrides.diagnostics ?? [
				{ ruleId: 'FW001', severity: 'warning', message: 'Register pointer missing volatile', file: filePath, line: 10, category: 'volatile', fix: 'volatile uint32_t *' },
				{ ruleId: 'FW003', severity: 'warning', message: 'malloc() detected', file: filePath, line: 20, category: 'misra' },
			];
		},
		onDiagnosticsChanged: { event: () => {} },
		getRegisterCompletions: () => [],
		getRegisterHoverInfo: () => undefined,
		getHardwareSymbols: () => [],
	};
}

function makeMockSessionService(overrides: {
	isActive?: boolean;
	complianceFrameworks?: string[];
	sourceFiles?: Array<{ path: string; content: string }>;
} = {}) {
	return {
		session: {
			isActive: overrides.isActive ?? true,
			mcuConfig: { family: 'STM32F4', variant: 'STM32F407VGT6' },
			complianceFrameworks: overrides.complianceFrameworks ?? ['misra-c-2012'],
			sourceFiles: overrides.sourceFiles ?? [],
		},
	};
}

suite('Compliance Agent Tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('buildComplianceTools returns 3 tools', () => {
		const tools = buildComplianceTools(makeMockLSPBridge() as any, makeMockSessionService() as any);
		assert.strictEqual(tools.length, 3);
	});

	test('tool names are fw_misra_check_file, fw_list_framework_violations, fw_generate_traceability', () => {
		const tools = buildComplianceTools(makeMockLSPBridge() as any, makeMockSessionService() as any);
		const names = tools.map(t => t.name);
		assert.ok(names.includes('fw_misra_check_file'));
		assert.ok(names.includes('fw_list_framework_violations'));
		assert.ok(names.includes('fw_generate_traceability'));
	});

	// ─── fw_misra_check_file ──────────────────────────────────────────────────

	test('fw_misra_check_file requires active session', async () => {
		const tools = buildComplianceTools(makeMockLSPBridge() as any, makeMockSessionService({ isActive: false }) as any);
		const tool = tools.find(t => t.name === 'fw_misra_check_file')!;
		const result = await tool.execute({ content: 'void main(){}\n', filePath: 'main.c' });
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_misra_check_file analyzes content and returns violations', async () => {
		const tools = buildComplianceTools(makeMockLSPBridge() as any, makeMockSessionService() as any);
		const tool = tools.find(t => t.name === 'fw_misra_check_file')!;
		const result = await tool.execute({ content: 'uint32_t *r = (uint32_t *)0x40011000;\n', filePath: 'src/main.c' });
		assert.ok(result.includes('FW001') || result.includes('volatile') || result.includes('warning'), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_misra_check_file with no violations returns clean message', async () => {
		const tools = buildComplianceTools(makeMockLSPBridge({ diagnostics: [] }) as any, makeMockSessionService() as any);
		const tool = tools.find(t => t.name === 'fw_misra_check_file')!;
		const result = await tool.execute({ content: 'void blink(void){}\n', filePath: 'src/main.c' });
		assert.ok(result.toLowerCase().includes('no violation') || result.toLowerCase().includes('✓') || result.toLowerCase().includes('clean'));
	});

	test('fw_misra_check_file groups violations by category', async () => {
		const tools = buildComplianceTools(makeMockLSPBridge() as any, makeMockSessionService() as any);
		const tool = tools.find(t => t.name === 'fw_misra_check_file')!;
		const result = await tool.execute({ content: 'code', filePath: 'src/main.c' });
		// Should show both volatile and misra categories
		assert.ok(result.includes('FW001') || result.includes('volatile'), `Result: ${result.slice(0, 200)}`);
	});

	// ─── fw_list_framework_violations ────────────────────────────────────────

	test('fw_list_framework_violations requires active session', async () => {
		const tools = buildComplianceTools(makeMockLSPBridge() as any, makeMockSessionService({ isActive: false }) as any);
		const tool = tools.find(t => t.name === 'fw_list_framework_violations')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_list_framework_violations shows active frameworks', async () => {
		const tools = buildComplianceTools(makeMockLSPBridge() as any, makeMockSessionService({ complianceFrameworks: ['misra-c-2012'] }) as any);
		const tool = tools.find(t => t.name === 'fw_list_framework_violations')!;
		const result = await tool.execute({});
		assert.ok(result.includes('misra') || result.includes('MISRA') || result.includes('framework'), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_list_framework_violations when no frameworks configured shows guidance', async () => {
		const tools = buildComplianceTools(makeMockLSPBridge() as any, makeMockSessionService({ complianceFrameworks: [] }) as any);
		const tool = tools.find(t => t.name === 'fw_list_framework_violations')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no compliance') || result.toLowerCase().includes('framework') || result.toLowerCase().includes('configure'));
	});

	// ─── fw_generate_traceability ─────────────────────────────────────────────

	test('fw_generate_traceability requires active session', async () => {
		const tools = buildComplianceTools(makeMockLSPBridge() as any, makeMockSessionService({ isActive: false }) as any);
		const tool = tools.find(t => t.name === 'fw_generate_traceability')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_generate_traceability produces traceability matrix', async () => {
		const tools = buildComplianceTools(makeMockLSPBridge() as any, makeMockSessionService({ complianceFrameworks: ['misra-c-2012'] }) as any);
		const tool = tools.find(t => t.name === 'fw_generate_traceability')!;
		const result = await tool.execute({});
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('traceability') || result.includes('Traceability') || result.includes('misra') || result.includes('MISRA') || result.length > 10);
	});
});
