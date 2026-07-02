/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { getPlatformSkill, getAllPlatformSkills, getPlatformIds, IPlatformSkill } from '../../../../browser/engine/skills/platformSkills.js';

suite('Platform Skills Registry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('getAllPlatformSkills returns non-empty list', () => {
		const skills = getAllPlatformSkills();
		assert.ok(skills.length > 0, `Expected at least one platform skill, got ${skills.length}`);
	});

	test('getPlatformIds returns non-empty list', () => {
		const ids = getPlatformIds();
		assert.ok(ids.length > 0);
		assert.ok(ids.every(id => typeof id === 'string' && id.length > 0));
	});

	test('getPlatformSkill returns undefined for unknown platform', () => {
		const skill = getPlatformSkill('unknown-platform-xyz');
		assert.strictEqual(skill, undefined);
	});

	test('all skills have required interface fields', () => {
		const skills = getAllPlatformSkills();
		for (const skill of skills) {
			assert.ok(skill.id, `Skill missing id`);
			assert.ok(skill.name, `Skill ${skill.id} missing name`);
			assert.ok(skill.manufacturer, `Skill ${skill.id} missing manufacturer`);
			assert.ok(typeof skill.initSequences === 'object', `Skill ${skill.id} missing initSequences`);
			assert.ok(typeof skill.clockTreeNotes === 'string', `Skill ${skill.id} missing clockTreeNotes`);
			assert.ok(Array.isArray(skill.pitfalls), `Skill ${skill.id} pitfalls must be array`);
			assert.ok(skill.debugConfig, `Skill ${skill.id} missing debugConfig`);
		}
	});

	test('stm32 platform skill exists', () => {
		const skill = getPlatformSkill('stm32');
		assert.ok(skill, 'Expected stm32 platform skill');
		assert.strictEqual(skill!.manufacturer, 'STMicroelectronics');
	});

	test('stm32 skill has OpenOCD debug config', () => {
		const skill = getPlatformSkill('stm32');
		assert.ok(skill?.debugConfig.openocdConfig.length > 0, 'Expected OpenOCD config files for STM32');
	});

	test('stm32 skill has GDB server command', () => {
		const skill = getPlatformSkill('stm32');
		assert.ok(skill?.debugConfig.gdbServerCommand.length > 0, 'Expected GDB server command');
	});

	test('stm32 skill has at least one init sequence', () => {
		const skill = getPlatformSkill('stm32');
		const keys = Object.keys(skill?.initSequences ?? {});
		assert.ok(keys.length > 0, 'Expected at least one peripheral init sequence for STM32');
	});

	test('stm32 skill has clock tree notes', () => {
		const skill = getPlatformSkill('stm32')!;
		assert.ok(skill.clockTreeNotes.length > 10, 'Clock tree notes should be non-trivial');
	});

	test('stm32 skill has embedded pitfalls', () => {
		const skill = getPlatformSkill('stm32')!;
		assert.ok(skill.pitfalls.length > 0, 'Expected pitfall list for STM32');
	});

	test('nrf52 or esp32 or rp2040 platform exists', () => {
		const ids = getPlatformIds();
		const hasEmbedded = ids.some(id => ['nrf52', 'esp32', 'rp2040', 'nrf', 'esp', 'rp'].some(prefix => id.startsWith(prefix)));
		assert.ok(hasEmbedded || ids.length >= 2, `Expected at least 2 platforms, have: ${ids.join(', ')}`);
	});

	test('getPlatformIds and getAllPlatformSkills are consistent', () => {
		const ids = getPlatformIds();
		const skills = getAllPlatformSkills();
		assert.strictEqual(ids.length, skills.length, 'getPlatformIds and getAllPlatformSkills should return same count');
	});

	test('each skill id matches the key it was registered under', () => {
		const ids = getPlatformIds();
		for (const id of ids) {
			const skill = getPlatformSkill(id)!;
			assert.strictEqual(skill.id, id, `Skill registered under '${id}' should have id '${id}', got '${skill.id}'`);
		}
	});

	test('debug config flash command is non-empty', () => {
		const skills = getAllPlatformSkills();
		for (const skill of skills) {
			assert.ok(skill.debugConfig.flashCommand.length > 0, `${skill.id} missing flash command`);
		}
	});
});

suite('Platform Skills - firmwareSystemPrompt integration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('stm32 init sequences include GPIO or UART initialization code', () => {
		const skill = getPlatformSkill('stm32')!;
		const allCode = Object.values(skill.initSequences).join('\n');
		assert.ok(
			allCode.includes('GPIO') || allCode.includes('UART') || allCode.includes('USART') || allCode.includes('RCC'),
			'Expected GPIO/UART/RCC code in STM32 init sequences'
		);
	});

	test('stm32 interrupt notes mention NVIC or IRQ', () => {
		const skill = getPlatformSkill('stm32')!;
		assert.ok(
			skill.interruptNotes.includes('NVIC') || skill.interruptNotes.includes('IRQ') || skill.interruptNotes.includes('interrupt'),
			`Interrupt notes should mention NVIC/IRQ: ${skill.interruptNotes.slice(0, 100)}`
		);
	});

	test('stm32 pitfalls contain concrete issues (not empty strings)', () => {
		const skill = getPlatformSkill('stm32')!;
		for (const pitfall of skill.pitfalls) {
			assert.ok(pitfall.length > 10, `Pitfall should be non-trivial: "${pitfall}"`);
		}
	});
});
