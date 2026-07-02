/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import {
	detectFileType,
	parseClockConfigFile,
	mergeClockConfigs,
	CLOCK_CONFIG_SCAN_FILES,
	IClockConfig,
} from '../../../../browser/engine/clockTree/clockConfigReader.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const IOC_CONTENT = `
RCC.PLLDivM=4
RCC.PLLMulN=168
RCC.PLLDivP=2
RCC.PLLDivQ=7
RCC.HSEFreq_Value=8000000
RCC.AHBCLKDivider=RCC_SYSCLK_DIV1
RCC.APB1CLKDivider=RCC_HCLK_DIV4
RCC.APB2CLKDivider=RCC_HCLK_DIV2
`.trim();

const HAL_HEADER = `
#define HSE_VALUE    ((uint32_t)8000000U)
#define PLL_M      4
#define PLL_N      168
#define PLL_P      2
#define PLL_Q      7
`.trim();

const HAL_HEADER_PLLP_DIV = `
#define HSE_VALUE    ((uint32_t)8000000U)
#define PLLM      4
#define PLLN      180
#define PLL_P      RCC_PLLP_DIV2
#define PLLQ      7
`.trim();

const ZEPHYR_CONF = `
CONFIG_CLOCK_STM32_HSE_CLOCK=8000000
CONFIG_CLOCK_STM32_PLL_M_DIVISOR=4
CONFIG_CLOCK_STM32_PLL_N_MULTIPLIER=168
CONFIG_CLOCK_STM32_PLL_P_DIVISOR=2
CONFIG_CLOCK_STM32_PLL_Q_DIVISOR=7
CONFIG_CLOCK_STM32_AHB_PRESCALER=1
CONFIG_CLOCK_STM32_APB1_PRESCALER=4
CONFIG_CLOCK_STM32_APB2_PRESCALER=2
`.trim();

const ESP_SDKCONFIG = `
CONFIG_ESP32_DEFAULT_CPU_FREQ_MHZ=240
CONFIG_FREERTOS_HZ=1000
`.trim();

const ARDUINO_BOARDS = `
nucleo_f446re.name=Nucleo F446RE
nucleo_f446re.build.mcu=cortex-m4
nucleo_f446re.build.f_cpu=180000000L
`.trim();

const GENERIC_HEADER = `
#define HSE_VALUE 8000000
#define PLLM 4
#define PLLN 168
#define PLLP 2
#define PLLQ 7
`.trim();

suite('Clock Config Reader - detectFileType', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('.ioc file → cubemx-ioc', () => {
		assert.strictEqual(detectFileType('STM32F407.ioc'), 'cubemx-ioc');
	});

	test('system_stm32*.c → hal-header', () => {
		assert.strictEqual(detectFileType('system_stm32f4xx.c'), 'hal-header');
	});

	test('*_hal_conf.h → hal-header', () => {
		assert.strictEqual(detectFileType('stm32f4xx_hal_conf.h'), 'hal-header');
	});

	test('prj.conf → zephyr-conf', () => {
		assert.strictEqual(detectFileType('prj.conf'), 'zephyr-conf');
	});

	test('app.conf → zephyr-conf', () => {
		assert.strictEqual(detectFileType('app.conf'), 'zephyr-conf');
	});

	test('sdkconfig → espressif-sdkconfig', () => {
		assert.strictEqual(detectFileType('sdkconfig'), 'espressif-sdkconfig');
	});

	test('sdkconfig.defaults → espressif-sdkconfig', () => {
		assert.strictEqual(detectFileType('sdkconfig.defaults'), 'espressif-sdkconfig');
	});

	test('boards.txt → arduino-boards', () => {
		assert.strictEqual(detectFileType('boards.txt'), 'arduino-boards');
	});

	test('config.h → generic-header', () => {
		assert.strictEqual(detectFileType('config.h'), 'generic-header');
	});

	test('unknown extension → null', () => {
		assert.strictEqual(detectFileType('firmware.elf'), null);
	});

	test('README.md → null', () => {
		assert.strictEqual(detectFileType('README.md'), null);
	});
});

suite('Clock Config Reader - parseClockConfigFile (.ioc)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses M, N, P, Q from CubeMX .ioc', () => {
		const cfg = parseClockConfigFile(IOC_CONTENT, 'cubemx-ioc')!;
		assert.ok(cfg, 'Expected config from .ioc');
		assert.strictEqual(cfg.m, 4);
		assert.strictEqual(cfg.n, 168);
		assert.strictEqual(cfg.p, 2);
		assert.strictEqual(cfg.q, 7);
	});

	test('parses HSE from .ioc (8MHz)', () => {
		const cfg = parseClockConfigFile(IOC_CONTENT, 'cubemx-ioc')!;
		assert.strictEqual(cfg.hseMHz, 8);
	});

	test('.ioc confidence is high', () => {
		const cfg = parseClockConfigFile(IOC_CONTENT, 'cubemx-ioc')!;
		assert.strictEqual(cfg.confidence, 'high');
	});

	test('parses AHB prescaler from .ioc', () => {
		const cfg = parseClockConfigFile(IOC_CONTENT, 'cubemx-ioc')!;
		assert.strictEqual(cfg.ahbPrescaler, 1);
	});

	test('parses APB1 prescaler DIV4 from .ioc', () => {
		const cfg = parseClockConfigFile(IOC_CONTENT, 'cubemx-ioc')!;
		assert.strictEqual(cfg.apb1Prescaler, 4);
	});

	test('returns null for .ioc with no PLL config', () => {
		const cfg = parseClockConfigFile('# no pll here\nSome=Value', 'cubemx-ioc');
		assert.strictEqual(cfg, null);
	});
});

suite('Clock Config Reader - parseClockConfigFile (HAL header)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses M, N, P, Q from HAL header', () => {
		const cfg = parseClockConfigFile(HAL_HEADER, 'hal-header')!;
		assert.ok(cfg);
		assert.strictEqual(cfg.m, 4);
		assert.strictEqual(cfg.n, 168);
		assert.strictEqual(cfg.p, 2);
		assert.strictEqual(cfg.q, 7);
	});

	test('parses HSE_VALUE (8MHz) from HAL header', () => {
		const cfg = parseClockConfigFile(HAL_HEADER, 'hal-header')!;
		assert.strictEqual(cfg.hseMHz, 8);
	});

	test('parses RCC_PLLP_DIV2 style P divisor', () => {
		const cfg = parseClockConfigFile(HAL_HEADER_PLLP_DIV, 'hal-header')!;
		assert.ok(cfg);
		assert.strictEqual(cfg.p, 2);
		assert.strictEqual(cfg.n, 180);
	});

	test('returns null for header with no PLL defines', () => {
		const cfg = parseClockConfigFile('#include <stm32f4xx.h>\nvoid main(){}', 'hal-header');
		assert.strictEqual(cfg, null);
	});
});

suite('Clock Config Reader - parseClockConfigFile (Zephyr)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses M, N, P, Q from Zephyr .conf', () => {
		const cfg = parseClockConfigFile(ZEPHYR_CONF, 'zephyr-conf')!;
		assert.ok(cfg);
		assert.strictEqual(cfg.m, 4);
		assert.strictEqual(cfg.n, 168);
		assert.strictEqual(cfg.p, 2);
		assert.strictEqual(cfg.q, 7);
	});

	test('parses HSE from Zephyr .conf (8MHz)', () => {
		const cfg = parseClockConfigFile(ZEPHYR_CONF, 'zephyr-conf')!;
		assert.strictEqual(cfg.hseMHz, 8);
	});

	test('parses APB1 prescaler from Zephyr .conf', () => {
		const cfg = parseClockConfigFile(ZEPHYR_CONF, 'zephyr-conf')!;
		assert.strictEqual(cfg.apb1Prescaler, 4);
	});
});

suite('Clock Config Reader - parseClockConfigFile (ESP-IDF)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses CPU frequency from sdkconfig (240MHz)', () => {
		const cfg = parseClockConfigFile(ESP_SDKCONFIG, 'espressif-sdkconfig')!;
		assert.ok(cfg);
		assert.ok(cfg.n !== undefined, 'Expected synthesized N');
	});

	test('ESP-IDF config has medium confidence', () => {
		const cfg = parseClockConfigFile(ESP_SDKCONFIG, 'espressif-sdkconfig')!;
		assert.strictEqual(cfg.confidence, 'medium');
	});

	test('returns null when no CPU freq config', () => {
		const cfg = parseClockConfigFile('CONFIG_FREERTOS_HZ=1000', 'espressif-sdkconfig');
		assert.strictEqual(cfg, null);
	});
});

suite('Clock Config Reader - parseClockConfigFile (Arduino)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses f_cpu from boards.txt', () => {
		const cfg = parseClockConfigFile(ARDUINO_BOARDS, 'arduino-boards')!;
		assert.ok(cfg);
		assert.ok(cfg.hseMHz !== undefined);
	});

	test('Arduino boards confidence is low', () => {
		const cfg = parseClockConfigFile(ARDUINO_BOARDS, 'arduino-boards')!;
		assert.strictEqual(cfg.confidence, 'low');
	});
});

suite('Clock Config Reader - parseClockConfigFile (generic header)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses PLLM, PLLN, PLLP, PLLQ from generic header', () => {
		const cfg = parseClockConfigFile(GENERIC_HEADER, 'generic-header')!;
		assert.ok(cfg);
		assert.strictEqual(cfg.m, 4);
		assert.strictEqual(cfg.n, 168);
		assert.strictEqual(cfg.p, 2);
		assert.strictEqual(cfg.q, 7);
	});

	test('generic header confidence is medium', () => {
		const cfg = parseClockConfigFile(GENERIC_HEADER, 'generic-header')!;
		assert.strictEqual(cfg.confidence, 'medium');
	});
});

suite('Clock Config Reader - mergeClockConfigs', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('higher confidence config wins for each field', () => {
		const low: IClockConfig = { m: 2, n: 100, confidence: 'low' };
		const high: IClockConfig = { m: 4, n: 168, p: 2, hseMHz: 8, confidence: 'high' };
		const merged = mergeClockConfigs([low, high]);
		assert.strictEqual(merged.m, 4);
		assert.strictEqual(merged.n, 168);
		assert.strictEqual(merged.hseMHz, 8);
	});

	test('merged confidence reflects highest confidence input', () => {
		const low: IClockConfig = { m: 4, confidence: 'low' };
		const mid: IClockConfig = { n: 168, confidence: 'medium' };
		const merged = mergeClockConfigs([low, mid]);
		assert.strictEqual(merged.confidence, 'medium');
	});

	test('fields from low config fill gaps not covered by high config', () => {
		const low: IClockConfig = { q: 7, confidence: 'low' };
		const high: IClockConfig = { m: 4, n: 168, confidence: 'high' };
		const merged = mergeClockConfigs([low, high]);
		assert.strictEqual(merged.q, 7, 'Low config q should fill the gap');
		assert.strictEqual(merged.m, 4);
	});

	test('empty configs array returns default low-confidence empty config', () => {
		const merged = mergeClockConfigs([]);
		assert.strictEqual(merged.confidence, 'low');
		assert.strictEqual(merged.m, undefined);
	});

	test('single config returns equivalent config', () => {
		const cfg: IClockConfig = { m: 4, n: 168, p: 2, q: 7, hseMHz: 8, confidence: 'high' };
		const merged = mergeClockConfigs([cfg]);
		assert.strictEqual(merged.m, 4);
		assert.strictEqual(merged.n, 168);
		assert.strictEqual(merged.confidence, 'high');
	});
});

suite('Clock Config Reader - CLOCK_CONFIG_SCAN_FILES', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('scan list is non-empty', () => {
		assert.ok(CLOCK_CONFIG_SCAN_FILES.length > 0);
	});

	test('scan list has .ioc entry', () => {
		const ioc = CLOCK_CONFIG_SCAN_FILES.find(f => f.type === 'cubemx-ioc');
		assert.ok(ioc, 'Expected cubemx-ioc entry in scan files');
	});

	test('scan list has sdkconfig entry', () => {
		const esp = CLOCK_CONFIG_SCAN_FILES.find(f => f.type === 'espressif-sdkconfig');
		assert.ok(esp, 'Expected espressif-sdkconfig entry');
	});

	test('all entries have glob and type', () => {
		for (const entry of CLOCK_CONFIG_SCAN_FILES) {
			assert.ok(entry.glob.length > 0, `Missing glob for type ${entry.type}`);
			assert.ok(entry.type.length > 0, 'Missing type');
		}
	});
});
