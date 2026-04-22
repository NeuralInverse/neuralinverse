/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Language Pair Registry — Firmware & Industrial Edition
 *
 * Defines migration profiles for every supported source → target pair in the
 * firmware and industrial modernisation domain.
 * Each profile provides:
 *
 * - **systemPersona**    — Expert role the AI should adopt in the system prompt
 * - **idiomMap**         — Construct-level source→target mappings (20–35 per pair)
 * - **conventionNotes**  — Target conventions injected into the user prompt
 * - **warningPatterns**  — Constructs that require raised decisions or extra care
 * - **targetFramework**  — Default framework / RTOS
 * - **targetTestFramework** — HIL/SIL framework or unit test framework
 *
 * ## Supported Pairs
 *
 * | Source                       | Target                                   |
 * |------------------------------|------------------------------------------|
 * | Bare-metal Embedded C        | FreeRTOS C                               |
 * | Bare-metal Embedded C        | Zephyr RTOS C                            |
 * | Embedded C                   | Embedded C++ (MISRA-C++ / AUTOSAR)       |
 * | ARM/AVR Assembly             | Embedded C (HAL-abstracted)              |
 * | IEC 61131-3 Ladder           | IEC 61131-3 Structured Text              |
 * | Register-direct C (STM32)    | STM32 HAL-abstracted C                   |
 * | Register-direct C (legacy)   | NXP SDK / MCUXpresso C                  |
 * | FreeRTOS C                   | Zephyr RTOS C                            |
 * | AUTOSAR Classic SWC          | AUTOSAR Adaptive (ARA)                   |
 * | PLC / Ladder (IEC 61131-3)   | Linux-RT IPC Application (C/C++)         |
 * | Modbus RTU/TCP C             | OPC-UA C++ Client                        |
 * | (Generic firmware fallback)  | Any embedded target                      |
 */

import { canonicaliseLanguage } from '../../fingerprint/impl/languageRegistry.js';


// ─── File Extension Map ───────────────────────────────────────────────────────

/** Map a target language key to the conventional file extension (with dot). */
export function getTargetFileExtension(targetLang: string): string {
	const ext: Record<string, string> = {
		'c':            '.c',
		'embedded-c':   '.c',
		'cpp':          '.cpp',
		'c++':          '.cpp',
		'embedded-cpp': '.cpp',
		'assembly':     '.s',
		'asm':          '.s',
		'structured-text': '.st',
		'st':           '.st',
		'iec61131':     '.st',
		'java':         '.java',
		'kotlin':       '.kt',
		'typescript':   '.ts',
		'javascript':   '.js',
		'python':       '.py',
		'csharp':       '.cs',
		'rust':         '.rs',
		'go':           '.go',
		'scala':        '.scala',
	};
	return ext[canonicaliseLanguage(targetLang)] ?? ext[targetLang.toLowerCase()] ?? '.c';
}

/** Return all registered language pair profiles. */
export function listLanguagePairProfiles(): ILanguagePairProfile[] {
	return [...LANGUAGE_PAIR_PROFILES];
}


export interface IIdiomMapping {
	/** Source language construct or pattern */
	sourceConstruct: string;
	/** Target language equivalent or idiom */
	targetConstruct: string;
	/** Optional clarifying note for the AI */
	notes?: string;
}

export interface ILanguagePairProfile {
	sourceLang: string;      // canonical source language key
	targetLang: string;      // canonical target language key
	label: string;           // Human-readable pair label for prompts
	targetFramework?: string;
	targetTestFramework?: string;
	/**
	 * Expert persona for the LLM system prompt.
	 * Describes the role, experience, and specific expertise expected.
	 */
	systemPersona: string;
	/** Key construct-level mappings, most important first */
	idiomMap: IIdiomMapping[];
	/** Bullet-point conventions injected into the user prompt */
	conventionNotes: string[];
	/**
	 * Patterns that require special attention, raised decisions, or extra care.
	 * Each entry is a bullet point in the "Warning Patterns" section of the prompt.
	 */
	warningPatterns: string[];
	/**
	 * File extension for the translated output.
	 * Used to generate suggested target file paths.
	 */
	targetFileExtension: string;
}


// ─── Bare-metal C → FreeRTOS C ───────────────────────────────────────────────

const BARE_METAL_C_TO_FREERTOS: ILanguagePairProfile = {
	sourceLang: 'c',
	targetLang: 'c',
	label: 'Bare-metal C → FreeRTOS C',
	targetFramework: 'FreeRTOS v10+',
	targetTestFramework: 'Unity + HIL',
	targetFileExtension: 'c',

	systemPersona: `You are a senior embedded systems engineer with 15 years of experience migrating bare-metal firmware to FreeRTOS-based RTOS architectures. You have deep expertise in super-loop refactoring, ISR deferral via queues and task notifications, and translating global state to task-local or mutex-protected state. You are meticulous about stack depth sizing, priority assignment, and interrupt-safe API selection (xQueueSendFromISR vs xQueueSend). You understand MISRA-C:2012 constraints and ensure that all dynamic memory allocation is confined to initialization (no heap use at run-time). You always reason about worst-case execution time (WCET) and tick resolution when translating timing loops.`,

	idiomMap: [
		{ sourceConstruct: 'while(1) { /* super-loop */ }',                            targetConstruct: 'void vMainTask(void *pvParams) { for(;;) { /* task body */ vTaskDelay(pdMS_TO_TICKS(N)); } }', notes: 'Break super-loop into tasks; use vTaskDelay for periodic timing' },
		{ sourceConstruct: '__disable_irq(); /* critical section */ __enable_irq();',  targetConstruct: 'taskENTER_CRITICAL(); /* critical section */ taskEXIT_CRITICAL();', notes: 'Use FreeRTOS critical section macros, NOT bare __disable_irq() inside RTOS context' },
		{ sourceConstruct: 'volatile uint8_t g_flag;  // shared between ISR and loop', targetConstruct: 'static QueueHandle_t xG_FlagQueue;  // ISR posts, task reads',  notes: 'Replace volatile shared globals with thread-safe queues or task notifications' },
		{ sourceConstruct: 'void TIMER_IRQHandler(void) { g_flag = 1; }',              targetConstruct: 'void TIMER_IRQHandler(void) { BaseType_t xHigherPriorityTaskWoken = pdFALSE; xQueueSendFromISR(xQ, &data, &xHigherPriorityTaskWoken); portYIELD_FROM_ISR(xHigherPriorityTaskWoken); }', notes: 'Always use FromISR variants inside interrupt handlers; yield if unblocking a higher-priority task' },
		{ sourceConstruct: 'delay_ms(N);  // busy-wait or SysTick polling',            targetConstruct: 'vTaskDelay(pdMS_TO_TICKS(N));',                                  notes: 'Replace busy-wait delays with vTaskDelay to yield CPU' },
		{ sourceConstruct: 'uint8_t g_uart_buf[64];  // ring buffer in global',        targetConstruct: 'static StreamBufferHandle_t xUartStream;  // FreeRTOS stream buffer', notes: 'Use FreeRTOS stream buffers for byte-stream ISR→task data transfer' },
		{ sourceConstruct: 'HAL_IWDG_Refresh(&hiwdg);  // in super-loop',             targetConstruct: 'HAL_IWDG_Refresh(&hiwdg);  // in watchdog refresh task with tight vTaskDelay', notes: 'Create a dedicated high-priority watchdog refresh task; never skip its refresh window' },
		{ sourceConstruct: 'static uint8_t mutex_flag = 0;  // home-made mutex',       targetConstruct: 'static SemaphoreHandle_t xMutex;  // xSemaphoreCreateMutex()',   notes: 'Replace hand-rolled mutexes with FreeRTOS mutexes (priority inheritance)' },
		{ sourceConstruct: '/* state machine with polling: switch(state) */  ',        targetConstruct: 'Each state phase becomes a task or uses xEventGroupWaitBits()',    notes: 'Raise decision: state machine may map to one event-driven task or multiple tasks' },
		{ sourceConstruct: 'xTaskCreate(vTaskFunc, "Name", stack, NULL, pri, &h)',     targetConstruct: 'xTaskCreateStatic(vTaskFunc, "Name", stack, NULL, pri, stackBuf, &tcb)', notes: 'Prefer xTaskCreateStatic (no heap) for safety-relevant tasks per IEC 61508' },
		{ sourceConstruct: 'SemaphoreHandle_t xBinarySem = xSemaphoreCreateBinary();',targetConstruct: 'Same — but give from ISR with xSemaphoreGiveFromISR()',            notes: 'Binary semaphore for simple ISR→task signalling without data' },
		{ sourceConstruct: 'uint32_t tick = HAL_GetTick();  // polling timer',         targetConstruct: 'TickType_t xLastWakeTime = xTaskGetTickCount(); vTaskDelayUntil(&xLastWakeTime, period)', notes: 'Use vTaskDelayUntil for jitter-free periodic tasks' },
		{ sourceConstruct: 'osDelay(N);  // CMSIS-RTOS v1',                            targetConstruct: 'vTaskDelay(pdMS_TO_TICKS(N));  // native FreeRTOS',              notes: 'Prefer native FreeRTOS API over CMSIS-RTOS wrapper for clarity' },
		{ sourceConstruct: 'void Error_Handler(void) { while(1); }',                  targetConstruct: 'void vErrorHandler(void) { /* log */ vTaskSuspend(NULL); }  // or trigger watchdog reset', notes: 'Infinite loop in error handler starves other tasks; suspend or trigger controlled reset' },
		{ sourceConstruct: 'malloc() / free()  // in application code',               targetConstruct: '/* PROHIBITED at runtime */ — use statically allocated buffers or FreeRTOS heap_4 at init only', notes: 'Dynamic allocation after scheduler start violates MISRA-C Rule 21.3 and IEC 61508 guidelines' },
		{ sourceConstruct: 'NVIC_SetPriority(IRQn, pri)',                              targetConstruct: 'NVIC_SetPriority(IRQn, pri)  — keep below configMAX_SYSCALL_INTERRUPT_PRIORITY', notes: 'ISR priorities above configMAX_SYSCALL_INTERRUPT_PRIORITY cannot call FreeRTOS ISR-safe API' },
	],

	conventionNotes: [
		'All tasks must have a clearly documented stack size with worst-case analysis (use uxTaskGetStackHighWaterMark() during testing)',
		'Assign task priorities explicitly: Watchdog > Safety > Control > Communication > Background',
		'Never use vTaskDelay(0) as a yield; use taskYIELD() explicitly',
		'Thread-safe logging via a dedicated logging queue or xStreamBufferSend(); never directly from task',
		'Initialise all FreeRTOS objects (queues, semaphores, mutexes) before starting the scheduler',
		'Use `configASSERT()` to catch NULL handles from object creation failures',
		'Heap: prefer heap_4 (coalescing) or heap_5 (non-contiguous); document total heap usage',
		'All ISR handlers that call FreeRTOS API must use the FromISR variants and check xHigherPriorityTaskWoken',
	],

	warningPatterns: [
		'Volatile shared globals — raise a data-sharing decision for each one; most should become queues or event groups',
		'Blocking calls inside ISRs (HAL_Delay, vTaskDelay) — these MUST be removed; raise a rule-interpretation decision',
		'Re-entrant HAL calls — HAL is not thread-safe by default; add mutex guards around peripheral access shared between tasks',
		'Very short ISR periods (< 1 tick) — may be impossible to defer without losing interrupts; raise a design decision',
		'Watchdog timeout shorter than longest task period — raise a safety decision about watchdog refresh strategy',
		'malloc/free in application code — raise a severity-critical rule-interpretation decision',
	],
};


// ─── Bare-metal C → Zephyr RTOS ──────────────────────────────────────────────

const BARE_METAL_C_TO_ZEPHYR: ILanguagePairProfile = {
	sourceLang: 'c',
	targetLang: 'c',
	label: 'Bare-metal C → Zephyr RTOS',
	targetFramework: 'Zephyr RTOS v3+',
	targetTestFramework: 'Zephyr Twister + HIL',
	targetFileExtension: 'c',

	systemPersona: `You are an expert embedded systems architect specialising in Zephyr RTOS migration. You have deep knowledge of Zephyr's device tree binding model, Kconfig system, kernel primitives (k_thread, k_msgq, k_sem, k_mutex, k_work), and GPIO/UART/SPI/I2C device driver APIs. You understand how Zephyr's WEST build system and CMakeLists integration replace traditional Keil/IAR project files. You are familiar with Zephyr's memory protection unit (MPU) support, logging subsystem (LOG_MODULE_REGISTER), and shell integration.`,

	idiomMap: [
		{ sourceConstruct: 'while(1) { /* super-loop */ }',                           targetConstruct: 'K_THREAD_DEFINE(my_tid, MY_STACK_SIZE, my_thread_fn, NULL, NULL, NULL, MY_PRIORITY, 0, 0)', notes: 'Use K_THREAD_DEFINE macro for static thread creation; replaces super-loop directly' },
		{ sourceConstruct: '__disable_irq(); /* critical */ __enable_irq();',          targetConstruct: 'unsigned int key = irq_lock();  /* critical */  irq_unlock(key);', notes: 'Zephyr IRQ lock/unlock for interrupt-safe critical sections' },
		{ sourceConstruct: 'volatile uint8_t g_flag;  // ISR→loop shared',            targetConstruct: 'struct k_msgq my_msgq;  K_MSGQ_DEFINE(my_msgq, sizeof(data), 8, 4)', notes: 'Use k_msgq for ISR→thread data transfer; zero-copy variant available' },
		{ sourceConstruct: 'HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5, GPIO_PIN_SET)',       targetConstruct: 'const struct device *gpio = DEVICE_DT_GET(DT_NODELABEL(gpioa)); gpio_pin_set(gpio, 5, 1)', notes: 'All GPIO access goes through Zephyr device tree node; no direct register access' },
		{ sourceConstruct: 'HAL_UART_Transmit(&huart1, buf, len, timeout)',            targetConstruct: 'const struct device *uart = DEVICE_DT_GET(DT_NODELABEL(uart1)); uart_tx(uart, buf, len, SYS_FOREVER_US)', notes: 'UART via Zephyr async API with uart_callback_set()' },
		{ sourceConstruct: 'delay_ms(N);',                                            targetConstruct: 'k_msleep(N);',                                                   notes: 'k_msleep yields CPU; k_busy_wait(us) for sub-ms busy-wait (avoid in tasks)' },
		{ sourceConstruct: 'uint8_t g_uart_buf[64];  // ring buffer',                 targetConstruct: 'K_MSGQ_DEFINE(uart_msgq, sizeof(char), 64, 1)',                  notes: 'Zephyr message queue as ring buffer; or use ring_buf API for byte streams' },
		{ sourceConstruct: '#include "stm32f4xx_hal.h"',                             targetConstruct: '#include <zephyr/kernel.h>\n#include <zephyr/drivers/gpio.h>',   notes: 'Replace vendor HAL includes with Zephyr subsystem headers' },
		{ sourceConstruct: 'SPI_HandleTypeDef hspi1;  HAL_SPI_Transmit(&hspi1, ...)', targetConstruct: 'spi_write(spi_dev, &spi_cfg, &tx_bufs)',                         notes: 'Zephyr SPI: configure struct spi_config, use spi_write/spi_transceive' },
		{ sourceConstruct: 'I2C_HandleTypeDef hi2c1;  HAL_I2C_Master_Transmit()',    targetConstruct: 'i2c_write(i2c_dev, buf, len, addr)',                              notes: 'Zephyr I2C: use i2c_write / i2c_read / i2c_write_read for combined transfers' },
		{ sourceConstruct: 'void EXTI0_IRQHandler(void)',                             targetConstruct: 'gpio_init_callback(&cb_data, my_callback, BIT(pin)); gpio_add_callback(gpio_dev, &cb_data)', notes: 'Zephyr GPIO interrupts use callback registration via device tree pin config' },
		{ sourceConstruct: 'IWDG_HandleTypeDef hiwdg; HAL_IWDG_Refresh(&hiwdg)',     targetConstruct: 'const struct device *wdt = DEVICE_DT_GET(DT_NODELABEL(iwdg)); wdt_feed(wdt, channel_id)', notes: 'Zephyr watchdog API: wdt_install_timeout(), wdt_setup(), wdt_feed()' },
		{ sourceConstruct: 'printf("debug: %d\\n", val)',                             targetConstruct: 'LOG_MODULE_REGISTER(my_module, CONFIG_MY_LOG_LEVEL); LOG_INF("debug: %d", val)', notes: 'Zephyr logging subsystem; configurable log level per module via Kconfig' },
		{ sourceConstruct: 'malloc() / free()',                                       targetConstruct: 'k_malloc() / k_free()  — or use static pools: K_MEM_SLAB_DEFINE', notes: 'Prefer k_mem_slab for deterministic allocation; k_malloc uses heap_mem_pool' },
		{ sourceConstruct: '#define MY_TIMER_PERIOD_MS 100  // in main.c',           targetConstruct: 'MY_TIMER_PERIOD_MS in Kconfig under modules/my_module/Kconfig',   notes: 'Expose tunable parameters through Kconfig, not #define in source files' },
	],

	conventionNotes: [
		'All hardware peripherals must be referenced via Device Tree nodes (DT_NODELABEL), never by direct register address',
		'Add thread stack size and priority as Kconfig symbols so they are tunable per board',
		'Use CONFIG_LOG=y and LOG_MODULE_REGISTER for all debug/info output; remove printf calls',
		'Zephyr shell commands (SHELL_CMD_REGISTER) replace USART debug menus',
		'All device pointers must be validated with DEVICE_DT_GET + device_is_ready() before use',
		'Use K_SEM_DEFINE / K_MUTEX_DEFINE / K_MSGQ_DEFINE macros for static kernel object allocation',
		'Interrupt priorities must be configured in the device tree overlay, not in C code via NVIC_SetPriority',
	],

	warningPatterns: [
		'Direct register access (*(volatile uint32_t*)ADDR) — raise blocking decision: must be replaced with DT-based driver API',
		'CubeMX-generated init code — generate board-specific Zephyr device tree overlay instead; raise design decision',
		'Vendor CMSIS headers included directly — eliminate; all types come from <zephyr/kernel.h>',
		'HAL_Delay() inside any callback — raise rule-interpretation decision; use k_msleep in threads only',
		'Hardcoded flash/RAM addresses in linker script — describe in board DTS memory node instead',
	],
};


// ─── Embedded C → Embedded C++ (MISRA-C++) ─────────────────────────────────

const EMBEDDED_C_TO_CPP_MISRA: ILanguagePairProfile = {
	sourceLang: 'c',
	targetLang: 'cpp',
	label: 'Embedded C → C++ (MISRA-C++ / AUTOSAR)',
	targetFramework: 'MISRA-C++:2008 / AUTOSAR C++14',
	targetTestFramework: 'GoogleTest + HIL',
	targetFileExtension: 'cpp',

	systemPersona: `You are a safety-critical embedded C++ architect with expertise in MISRA-C++:2008, AUTOSAR C++14, and ISO 26262 software architecture. You translate embedded C into idiomatic C++ that eliminates dynamic allocation, exceptions, and RTTI — all forbidden in safety-critical embedded contexts — while introducing class-based HAL abstractions using CRTP, policy-based design, and RAII for peripheral lifetime management. You know which C++ features are safe in embedded contexts (constexpr, templates, in-place construction) and which are forbidden (virtual destructors with RTTI, std::function, std::string on microcontrollers without an allocator).`,

	idiomMap: [
		{ sourceConstruct: 'typedef struct { uint8_t data[N]; } MyStruct_t;',         targetConstruct: 'struct MyStruct { std::array<uint8_t, N> data{}; };', notes: 'Use std::array<> instead of C arrays — bounds checked, no decay to pointer' },
		{ sourceConstruct: 'void* memset(s, 0, sizeof(s))',                           targetConstruct: 's = {};  // value-initialise to zero',                            notes: 'Value-initialisation is idiomatic C++; use std::fill for explicit array init' },
		{ sourceConstruct: '#define MAX_SIZE 64  // magic constant',                  targetConstruct: 'constexpr std::size_t kMaxSize = 64U;',                           notes: 'Replace all object-like macros with constexpr — MISRA-C++ Rule 16-0-4' },
		{ sourceConstruct: '#define MIN(a,b) ((a)<(b)?(a):(b))  // function macro',  targetConstruct: 'template<typename T> constexpr T min(T a, T b) noexcept { return (a < b) ? a : b; }', notes: 'Replace function-like macros with constexpr templates — MISRA-C++ Rule 16-0-4' },
		{ sourceConstruct: 'extern uint32_t g_counter;  // global mutable state',     targetConstruct: 'class Counter { public: void increment() noexcept; uint32_t value() const noexcept; private: uint32_t m_count{}; };', notes: 'Encapsulate global mutable state in classes; no mutable namespace-scope variables per AUTOSAR A3-1-1' },
		{ sourceConstruct: 'static uint8_t s_uart_buf[256];  // file-static buffer',  targetConstruct: 'class UartDriver { private: std::array<uint8_t, 256U> m_rxBuf{}; };', notes: 'Move file-static buffers into class members with appropriate access control' },
		{ sourceConstruct: 'HAL_StatusTypeDef HAL_UART_Transmit(UART_HandleTypeDef*, const uint8_t*, uint16_t, uint32_t)', targetConstruct: 'class IUart { public: virtual bool transmit(std::span<const uint8_t> data, std::chrono::milliseconds timeout) noexcept = 0; virtual ~IUart() = default; };', notes: 'Abstract HAL interface for testability; concrete impl wraps HAL; CRTP alternative avoids vtable' },
		{ sourceConstruct: 'void Error_Handler(void) { while(1); }',                  targetConstruct: '[[noreturn]] void errorHandler() noexcept { /* log state then */ NVIC_SystemReset(); }', notes: 'Use [[noreturn]], remove infinite loop — raises watchdog rather than starving system' },
		{ sourceConstruct: 'malloc() / free()',                                       targetConstruct: '/* FORBIDDEN */ Use std::array<>, in-place construction, or custom pool allocator', notes: 'Dynamic allocation forbidden per MISRA-C++ Rule 18-4-1 and AUTOSAR A18-5-1' },
		{ sourceConstruct: 'try { ... } catch(...) { }  // exceptions',               targetConstruct: '/* FORBIDDEN */ Use error return codes or std::expected<T,E> (C++23)',  notes: 'Exceptions forbidden per MISRA-C++ Rule 15-0-1 and AUTOSAR A15-0-1' },
		{ sourceConstruct: 'void (*callback)(uint8_t data);  // function pointer',    targetConstruct: 'template<typename Callback> class Driver { Callback m_cb; };  // or std::function avoided', notes: 'Prefer templated callbacks over std::function (heap allocation risk) in safety code' },
		{ sourceConstruct: '(uint32_t*)0x40020000  // raw cast to register',          targetConstruct: 'reinterpret_cast<volatile uint32_t*>(0x40020000U)  // mark volatile; prefer HAL', notes: 'MISRA-C++ Rule 5-2-7: raw casts to hardware address must be documented and isolated in BSP' },
		{ sourceConstruct: 'switch(state) { case STATE_A: ... }  // enum state',      targetConstruct: 'enum class State : uint8_t { A, B, C };  switch(m_state) { case State::A: ... }', notes: 'Use enum class (scoped enum) — prevents implicit integer conversion (AUTOSAR A7-2-3)' },
		{ sourceConstruct: 'uint8_t flags = FLAG_A | FLAG_B;  // bit flags',          targetConstruct: 'constexpr uint8_t kFlagA = 0x01U; constexpr uint8_t kFlagB = 0x02U;  // or std::bitset<8>', notes: '' },
		{ sourceConstruct: 'uint32_t val = *(volatile uint32_t*)(BASE + OFFSET)',     targetConstruct: 'mmio::read32(kBase + kOffset)  // BSP-provided mmio namespace',  notes: 'Isolate all MMIO access in a thin BSP namespace; do not scatter throughout application' },
	],

	conventionNotes: [
		'No dynamic allocation at runtime: all objects must be statically allocated or constructed in-place',
		'No exceptions: use error codes, std::optional<>, or a custom Result<T,E> type',
		'No RTTI (no dynamic_cast, no typeid): disable with -fno-rtti in build flags',
		'All header-only code must guard against multiple inclusion with #pragma once (MISRA-C++ Rule 16-2-3)',
		'Use `noexcept` on all functions that cannot throw (which is all functions in fully compliant code)',
		'Prefer CRTP (Curiously Recurring Template Pattern) for static polymorphism over virtual dispatch',
		'Use std::array<>, not raw arrays; use std::span<> for non-owning views (C++20)',
		'Name constants kUpperCamelCase, member variables m_lowerCamel, static s_lowerCamel',
	],

	warningPatterns: [
		'Virtual destructors with RTTI — raise blocking decision; forbidden in MISRA-C++',
		'std::string / std::vector / std::deque — raise decision: these use heap; replace with fixed-size alternatives',
		'#include <iostream> — raise decision: stream I/O allocates; use printf equivalent or logging subsystem',
		'reinterpret_cast to hardware address in non-BSP code — raise decision: must be isolated in BSP layer',
		'Function pointer casts — raise decision; may violate MISRA-C++ Rule 5-2-6',
		'Nested templates with deep instantiation — raise note: may cause long compile times on small toolchains',
	],
};


// ─── Assembly → Embedded C ───────────────────────────────────────────────────

const ASSEMBLY_TO_EMBEDDED_C: ILanguagePairProfile = {
	sourceLang: 'assembler',
	targetLang: 'c',
	label: 'ARM/AVR Assembly → Embedded C (HAL)',
	targetFramework: 'CMSIS + Vendor HAL',
	targetTestFramework: 'Unity + HIL',
	targetFileExtension: 'c',

	systemPersona: `You are an expert in translating ARM Cortex-M and AVR assembly routines into portable embedded C. You understand ARM calling conventions (AAPCS), ARM load/store architecture, barrel shifter idioms, CPSR flag usage, and how assembly-level hardware operations map to CMSIS intrinsics and vendor HAL API calls. You translate memory-mapped register access via LDR/STR to volatile pointer or HAL calls. You recognise assembly-level critical section patterns (CPSID i / CPSIE i on ARM, CLI/SEI on AVR) and map them to CMSIS intrinsics or RTOS critical section macros.`,

	idiomMap: [
		{ sourceConstruct: 'CPSID I  // disable global interrupts (ARM)',              targetConstruct: '__disable_irq();  // CMSIS intrinsic',                           notes: 'Always pair with __enable_irq(); raise decision if nested disable expected' },
		{ sourceConstruct: 'CPSIE I  // enable global interrupts (ARM)',               targetConstruct: '__enable_irq();',                                                notes: '' },
		{ sourceConstruct: 'LDR R0, =0x40020000  // base address literal',            targetConstruct: '#define GPIOA_BASE  (0x40020000UL)  // or use CMSIS define',    notes: 'Use CMSIS device header constants, not hardcoded literals' },
		{ sourceConstruct: 'LDR R1, [R0, #0x14]  // read register at offset 0x14',   targetConstruct: '*(volatile uint32_t*)(BASE + 0x14U)',                            notes: 'Prefer SVD-generated accessor macro; document register name in comment' },
		{ sourceConstruct: 'STR R1, [R0, #0x18]  // write register',                  targetConstruct: '*(volatile uint32_t*)(BASE + 0x18U) = value;',                  notes: '' },
		{ sourceConstruct: 'BIC R1, R1, #(1 << N)  // clear bit N',                  targetConstruct: 'reg &= ~(1UL << N);',                                            notes: '' },
		{ sourceConstruct: 'ORR R1, R1, #(1 << N)  // set bit N',                    targetConstruct: 'reg |= (1UL << N);',                                             notes: '' },
		{ sourceConstruct: 'TST R1, #(1 << N); BEQ label  // test and branch',        targetConstruct: 'if ((reg & (1UL << N)) == 0U) { /* branch body */ }',           notes: '' },
		{ sourceConstruct: 'MUL R0, R1, R2  // 32-bit multiply',                      targetConstruct: 'uint32_t result = (uint32_t)a * (uint32_t)b;',                  notes: 'Check for overflow if result > 32-bit; use __SMULL if signed 64-bit product needed' },
		{ sourceConstruct: 'UDIV R0, R1, R2  // hardware divide (Cortex-M3+)',        targetConstruct: 'uint32_t result = a / b;  // requires b != 0 check',             notes: 'Add divide-by-zero guard; Cortex-M0 has no hardware UDIV — use __aeabi_uidiv()' },
		{ sourceConstruct: 'WFI  // Wait For Interrupt (low-power)',                   targetConstruct: '__WFI();  // CMSIS intrinsic',                                   notes: 'Ensure interrupt is enabled before WFI to avoid deadlock' },
		{ sourceConstruct: 'SEV / WFE  // event signalling (ARM multicore)',           targetConstruct: '__SEV(); __WFE();',                                              notes: 'Raise decision: multicore event signalling may need OS-level replacement' },
		{ sourceConstruct: 'PUSH {R4-R11, LR}; ... POP {R4-R11, PC}  // prologue',   targetConstruct: '// Handled by compiler; function body is all that needs porting', notes: 'Calling convention handled by C compiler; no manual prologue/epilogue needed' },
		{ sourceConstruct: 'CLI  // AVR disable interrupt',                            targetConstruct: 'SREG &= ~(1 << SREG_I);  // or cli() macro',                    notes: 'avr/interrupt.h provides cli() / sei()' },
		{ sourceConstruct: 'SEI  // AVR enable interrupt',                             targetConstruct: 'sei();',                                                         notes: '' },
		{ sourceConstruct: 'RJMP label / RCALL label  // AVR relative jump/call',     targetConstruct: 'goto / function call — should not be needed in structured C',    notes: 'Structured C eliminates all jumps; raise decision if computed jump present' },
		{ sourceConstruct: 'LD R16, X  // AVR indirect load',                         targetConstruct: 'uint8_t val = *ptr;',                                            notes: '' },
		{ sourceConstruct: 'ST X, R16  // AVR indirect store',                        targetConstruct: '*ptr = val;',                                                    notes: '' },
		{ sourceConstruct: 'NOP  // no-operation (timing)',                            targetConstruct: '__NOP();  // CMSIS — or replace with a documented delay',        notes: 'Raise decision: NOP-based timing is not portable; use HAL_Delay or timer peripheral' },
	],

	conventionNotes: [
		'All hardware register access must be wrapped in BSP accessor functions or CMSIS macros — no raw numeric addresses in application code',
		'Translate assembly-coded loops to while/for loops; compiler optimisation handles the rest',
		'Document every CMSIS intrinsic usage with a comment explaining the hardware rationale',
		'Guard all divide operations against zero divisor explicitly',
		'Mark interrupt handler entry points with the correct IRQHandler name and __attribute__((interrupt)) if required by toolchain',
	],

	warningPatterns: [
		'Self-modifying code — cannot be translated to C; raise blocking decision',
		'PC-relative data tables (LDR Rn, [PC, #offset]) — raise decision: likely a jump table or constant pool; must be restructured',
		'THUMB/ARM interworking (BX LR, BLX) — raise note: C compiler handles this; no manual interwork needed',
		'Cortex-M0 use of UDIV — raise decision: M0 has no hardware divide; compiler inserts __aeabi_uidiv() automatically',
		'Inline assembly retention (`asm volatile`) — raise decision: document WHY assembly is still needed; prefer CMSIS intrinsic',
	],
};


// ─── IEC 61131-3 Ladder → Structured Text ────────────────────────────────────

const LADDER_TO_STRUCTURED_TEXT: ILanguagePairProfile = {
	sourceLang: 'iec61131',
	targetLang: 'iec61131',
	label: 'Ladder Diagram → Structured Text (IEC 61131-3)',
	targetFramework: 'IEC 61131-3 ST (CoDeSys v3 / CODESYS / Siemens TIA SCL)',
	targetTestFramework: 'PLCunit + SIL Simulation',
	targetFileExtension: 'st',

	systemPersona: `You are a senior PLC and IEC 61131-3 automation engineer with expertise in migrating Ladder Diagram (LD) programs to Structured Text (ST), following PLCopen and IEC 61131-3 best practices. You understand that every Ladder rung maps to a boolean expression and that function block instantiation must be preserved exactly. You are meticulous about scan-cycle semantics, output coil latching, and rising/falling edge detection patterns. You know that safety function blocks (PLCopen Safety FB library: SF_EmergencyStop, SF_SafelyLimitedSpeed) must never be reinterpreted — their calling convention and output semantics are normative.`,

	idiomMap: [
		{ sourceConstruct: '|---[ ]---[ ]---( )---|  // Series contacts + output coil',   targetConstruct: 'Output := ContactA AND ContactB;',                              notes: 'Series contacts = AND; parallel contacts = OR; output coil = assignment' },
		{ sourceConstruct: '|---[/]---( )---|  // Normally-closed contact',               targetConstruct: 'Output := NOT ContactA;',                                       notes: 'Normally-closed contact = NOT' },
		{ sourceConstruct: '|-+--[ ]--+-( )--|  // Parallel contacts (OR)',               targetConstruct: 'Output := ContactA OR ContactB;',                               notes: '' },
		{ sourceConstruct: '|---[ ]---[TON EN]-+---( )---|  // Timer in rung',            targetConstruct: 'Timer1(IN := Contact, PT := T#5S); Output := Timer1.Q;',        notes: 'TON/TOF/TP instances persist across scans; never re-declare inside ST block' },
		{ sourceConstruct: '(OTE)  // Output Energise coil',                              targetConstruct: 'Output := Condition;',                                          notes: 'Direct assignment' },
		{ sourceConstruct: '(OTL)  // Latch coil (set on rising edge)',                   targetConstruct: 'IF RisingEdge THEN Output := TRUE; END_IF',                     notes: 'Use R_TRIG FB to detect rising edge for latch' },
		{ sourceConstruct: '(OTU)  // Unlatch coil (clear on rising edge)',               targetConstruct: 'IF RisingEdge THEN Output := FALSE; END_IF',                    notes: '' },
		{ sourceConstruct: '[CTU] // Counter up',                                        targetConstruct: 'Counter1(CU := PulseSignal, R := Reset, PV := 100); AtCount := Counter1.Q;', notes: 'CTU instance must be declared as VAR Counter1 : CTU; END_VAR' },
		{ sourceConstruct: '[SF_EmergencyStop]  // PLCopen Safety FB',                   targetConstruct: 'EStop1(S_EStopIn := EStopButton, S_StartReset := ResetBtn, S_AutoReset := FALSE); SafetyOK := EStop1.S_SafetyActive;', notes: 'NEVER simplify safety FB calls — their input/output mapping is safety-normative; raise decision if any parameter is unclear' },
		{ sourceConstruct: '[PID_COMPACT]  // Siemens PID block',                        targetConstruct: 'PID1(SetPoint := SP, ProcessValue := PV, ManualValue := MV, Mode := Auto); CV := PID1.Output;', notes: 'Map Siemens PID_COMPACT to IEC-standard PID FB; raise decision if vendor-specific tuning params are used' },
		{ sourceConstruct: '[MC_Power]  // PLCopen Motion FB',                           targetConstruct: 'Axis1_Power(Axis := Axis1, Enable := EnableSignal, bRegulatorOn := TRUE, bDriveStart := TRUE);', notes: 'Motion FBs must be instantiated once and called every scan; raise decision if axis type differs' },
		{ sourceConstruct: '|---[P]---  // Positive (rising-edge) contact',              targetConstruct: 'R_TRIG1(CLK := Signal); IF R_TRIG1.Q THEN ... END_IF',          notes: 'Positive contact = R_TRIG function block' },
		{ sourceConstruct: '|---[N]---  // Negative (falling-edge) contact',             targetConstruct: 'F_TRIG1(CLK := Signal); IF F_TRIG1.Q THEN ... END_IF',          notes: 'Negative contact = F_TRIG function block' },
		{ sourceConstruct: 'network:  (* Rung comment *)',                               targetConstruct: '(* Network comment preserved above the translated expression *)', notes: 'Preserve all rung comments as (* block comments *) above each ST expression' },
	],

	conventionNotes: [
		'Every function block instance declared in Ladder (TON, CTU, R_TRIG, etc.) must be declared in the ST VAR section before use',
		'Declaration order in VAR: inputs (VAR_INPUT), outputs (VAR_OUTPUT), local FBs (VAR), external (VAR_EXTERNAL)',
		'Safety FBs (SF_ prefix) must be called every scan cycle WITHOUT exception — never call conditionally',
		'All rungs must be translated in the same order as the Ladder — scan-cycle semantics must be preserved',
		'Use BOOL TRUE/FALSE not 1/0 for boolean assignments',
		'Network/rung comments must be preserved — they often convey safety rationale required for IEC 61508 documentation',
		'Do not merge multiple rungs into a single complex ST expression — keep one expression per rung for traceability',
	],

	warningPatterns: [
		'Safety function blocks (SF_ prefix) — raise blocking decision if any input mapping is unclear; do not guess',
		'Latching coils (OTL/OTU) with non-obvious reset logic — raise rule-interpretation decision; verify with commissioning documentation',
		'Motion FB calls without axis configuration — raise decision; axis type and drive parameters required',
		'TON/TOF timers with very short preset times (< 10ms) — raise note: ST scan cycle time must be faster than timer preset',
		'Rungs with complex structured text already embedded (ST block in Ladder) — raise note for review; direct lifting may introduce double-execution',
	],
};


// ─── Register-direct C → STM32 HAL ───────────────────────────────────────────

const REGISTER_DIRECT_TO_STM32_HAL: ILanguagePairProfile = {
	sourceLang: 'c',
	targetLang: 'c',
	label: 'Register-direct C → STM32 HAL',
	targetFramework: 'STM32 HAL (STM32Cube)',
	targetTestFramework: 'Unity + STM32CubeMonitor HIL',
	targetFileExtension: 'c',

	systemPersona: `You are a senior STM32 firmware architect who specialises in migrating register-direct peripheral access code to the STM32Cube HAL library. You have deep knowledge of STM32 peripheral register maps (from SVD and reference manuals), HAL API signatures, and how to configure handles (SPI_HandleTypeDef, UART_HandleTypeDef, etc.) generated by STM32CubeMX. You understand the trade-offs between HAL (portable, slower), LL (low-level, faster), and register-direct (fastest, least portable) and can explain upgrade path costs in each direction.`,

	idiomMap: [
		{ sourceConstruct: 'RCC->AHB1ENR |= RCC_AHB1ENR_GPIOAEN;  // enable clock',  targetConstruct: '__HAL_RCC_GPIOA_CLK_ENABLE();',                                  notes: 'HAL provides clock enable macros for all peripherals' },
		{ sourceConstruct: 'GPIOA->MODER |= (1 << (pin*2));  // output mode',         targetConstruct: 'GPIO_InitTypeDef cfg = {.Pin=GPIO_PIN_5, .Mode=GPIO_MODE_OUTPUT_PP, .Pull=GPIO_NOPULL, .Speed=GPIO_SPEED_FREQ_LOW}; HAL_GPIO_Init(GPIOA, &cfg);', notes: 'HAL_GPIO_Init configures mode, speed, pull in one call' },
		{ sourceConstruct: 'GPIOA->ODR |= (1 << pin);  // set GPIO high',             targetConstruct: 'HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5, GPIO_PIN_SET);',            notes: '' },
		{ sourceConstruct: 'GPIOA->ODR &= ~(1 << pin);  // set GPIO low',             targetConstruct: 'HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5, GPIO_PIN_RESET);',          notes: '' },
		{ sourceConstruct: '(GPIOA->IDR >> pin) & 1  // read GPIO',                   targetConstruct: 'HAL_GPIO_ReadPin(GPIOA, GPIO_PIN_5)',                             notes: '' },
		{ sourceConstruct: 'USART1->BRR = ...; USART1->CR1 |= USART_CR1_UE;',        targetConstruct: 'UART_HandleTypeDef huart1 = {.Instance=USART1, .Init={.BaudRate=115200, ...}}; HAL_UART_Init(&huart1);', notes: 'CubeMX generates huart1 init; transplant .Init fields from register config' },
		{ sourceConstruct: 'while(!(USART1->SR & USART_SR_TXE)); USART1->DR = byte;', targetConstruct: 'HAL_UART_Transmit(&huart1, &byte, 1, HAL_MAX_DELAY);',           notes: 'Non-blocking: HAL_UART_Transmit_IT / HAL_UART_Transmit_DMA for production code' },
		{ sourceConstruct: 'SPI1->CR1 |= SPI_CR1_SPE; SPI1->DR = byte; while(!(SPI1->SR & SPI_SR_RXNE)); byte = SPI1->DR;', targetConstruct: 'HAL_SPI_TransmitReceive(&hspi1, &txByte, &rxByte, 1, HAL_MAX_DELAY);', notes: '' },
		{ sourceConstruct: 'ADC1->CR2 |= ADC_CR2_SWSTART; while(!(ADC1->SR & ADC_SR_EOC)); val = ADC1->DR;', targetConstruct: 'HAL_ADC_Start(&hadc1); HAL_ADC_PollForConversion(&hadc1, HAL_MAX_DELAY); val = HAL_ADC_GetValue(&hadc1);', notes: 'Use HAL_ADC_Start_DMA for multi-channel continuous conversion' },
		{ sourceConstruct: 'TIM2->ARR = period - 1; TIM2->PSC = prescaler - 1; TIM2->CR1 |= TIM_CR1_CEN;', targetConstruct: 'HAL_TIM_Base_Init(&htim2); HAL_TIM_Base_Start_IT(&htim2);',           notes: 'Timer period/prescaler set in MX_TIM2_Init; use _IT or _DMA variant for events' },
		{ sourceConstruct: 'NVIC_SetPriority(USART1_IRQn, 5); NVIC_EnableIRQ(USART1_IRQn);', targetConstruct: 'HAL_NVIC_SetPriority(USART1_IRQn, 5, 0); HAL_NVIC_EnableIRQ(USART1_IRQn);', notes: 'Use HAL_NVIC_ wrappers; sub-priority (3rd arg) relevant only in grouped mode' },
		{ sourceConstruct: 'DMA1_Channel5->CCR |= DMA_CCR_EN;  // raw DMA enable',   targetConstruct: 'HAL_UART_Receive_DMA(&huart1, rxBuf, rxLen);  // HAL manages DMA handle', notes: 'HAL DMA transfer is configured through peripheral DMA association in CubeMX' },
	],

	conventionNotes: [
		'Use CubeMX-generated peripheral handles (huart1, hspi1, hadc1) as the basis for all HAL calls',
		'Wrap HAL calls in application functions that return a custom StatusCode enum — never expose HAL_StatusTypeDef to application layer',
		'Prefer IT (interrupt) or DMA variants over polling (HAL_MAX_DELAY) for all production data transfers',
		'Always check HAL return codes: HAL_OK, HAL_ERROR, HAL_BUSY, HAL_TIMEOUT',
		'Do not mix register-direct and HAL access on the same peripheral — pick one consistently',
		'Document the SVD register name and reference manual section for every raw register access that cannot be replaced by HAL',
	],

	warningPatterns: [
		'Raw SPI/I2C CS GPIO toggling not using HAL — raise decision: some HAL functions expect manual CS management; document the strategy',
		'DMA memory address alignment — raise note: STM32 DMA requires word-aligned buffers for 32-bit transfers',
		'USART Baud rate calculation with non-standard clocks — raise decision: verify HAL UART init uses correct PCLK from SystemClock_Config',
		'Shared peripherals (multiple drivers using same SPI bus) — raise decision: must add mutex before HAL call',
		'Using HAL_MAX_DELAY in production — raise decision: replace with application-specific timeout and error handling',
	],
};


// ─── FreeRTOS C → Zephyr RTOS ────────────────────────────────────────────────

const FREERTOS_TO_ZEPHYR: ILanguagePairProfile = {
	sourceLang: 'c',
	targetLang: 'c',
	label: 'FreeRTOS C → Zephyr RTOS C',
	targetFramework: 'Zephyr RTOS v3+',
	targetTestFramework: 'Zephyr Twister + HIL',
	targetFileExtension: 'c',

	systemPersona: `You are an RTOS migration specialist with hands-on experience porting FreeRTOS applications to Zephyr RTOS. You know the API equivalences between FreeRTOS (xTaskCreate, xQueueSend, xSemaphoreGive, osDelay) and Zephyr (k_thread_create, k_msgq_put, k_sem_give, k_msleep), including important semantic differences like Zephyr's kernel object lifetimes, the lack of a heap-only allocation model, and how Zephyr's syswork queue replaces some deferred ISR patterns. You understand Zephyr's CMake/Kconfig build integration and device tree peripheral binding.`,

	idiomMap: [
		{ sourceConstruct: 'xTaskCreate(fn, "Name", stackSz, param, pri, &handle)',   targetConstruct: 'K_THREAD_DEFINE(tid, stackSz, fn, param, NULL, NULL, pri, 0, 0)', notes: 'K_THREAD_DEFINE creates a static thread at boot; or use k_thread_create() with pre-allocated stack' },
		{ sourceConstruct: 'vTaskDelay(pdMS_TO_TICKS(N))',                            targetConstruct: 'k_msleep(N)',                                                    notes: '' },
		{ sourceConstruct: 'vTaskDelayUntil(&xLastWake, period)',                     targetConstruct: 'k_sleep(K_TIMEOUT_ABS_TICKS(next_tick))',                        notes: 'Zephyr uses absolute timeout; compute next_tick = last_tick + period using k_uptime_ticks()' },
		{ sourceConstruct: 'xQueueCreate(len, sizeof(Item))',                         targetConstruct: 'K_MSGQ_DEFINE(my_msgq, sizeof(Item), len, 4)',                   notes: 'Zephyr msgq is statically defined; alignment (4th arg) typically 4 bytes' },
		{ sourceConstruct: 'xQueueSend(xQ, &item, timeout)',                          targetConstruct: 'k_msgq_put(&my_msgq, &item, K_MSEC(timeout))',                   notes: '' },
		{ sourceConstruct: 'xQueueReceive(xQ, &item, timeout)',                       targetConstruct: 'k_msgq_get(&my_msgq, &item, K_MSEC(timeout))',                   notes: '' },
		{ sourceConstruct: 'xQueueSendFromISR(xQ, &item, &pxWoken)',                  targetConstruct: 'k_msgq_put(&my_msgq, &item, K_NO_WAIT)',                         notes: 'Zephyr kernel objects are ISR-safe when used with K_NO_WAIT; no separate FromISR variant needed' },
		{ sourceConstruct: 'xSemaphoreCreateBinary()',                                targetConstruct: 'K_SEM_DEFINE(my_sem, 0, 1)',                                     notes: '' },
		{ sourceConstruct: 'xSemaphoreGive(sem)',                                     targetConstruct: 'k_sem_give(&my_sem)',                                            notes: '' },
		{ sourceConstruct: 'xSemaphoreTake(sem, timeout)',                            targetConstruct: 'k_sem_take(&my_sem, K_MSEC(timeout))',                           notes: '' },
		{ sourceConstruct: 'xSemaphoreCreateMutex()',                                 targetConstruct: 'K_MUTEX_DEFINE(my_mutex)',                                       notes: 'Zephyr mutex has priority inheritance by default' },
		{ sourceConstruct: 'xMutexTake(m, portMAX_DELAY) / xMutexGive(m)',           targetConstruct: 'k_mutex_lock(&my_mutex, K_FOREVER) / k_mutex_unlock(&my_mutex)', notes: '' },
		{ sourceConstruct: 'xEventGroupCreate() / xEventGroupSetBits()',              targetConstruct: 'K_EVENT_DEFINE(my_event) / k_event_post(&my_event, bits)',       notes: 'Zephyr event object; use k_event_wait() for multi-bit wait' },
		{ sourceConstruct: 'xStreamBufferCreate(size, trigLevel)',                    targetConstruct: 'K_PIPE_DEFINE(pipe, size, 4)  // or ring_buf for byte streams',  notes: 'Zephyr pipe or ring_buf for byte-stream ISR→thread communication' },
		{ sourceConstruct: 'taskENTER_CRITICAL() / taskEXIT_CRITICAL()',             targetConstruct: 'unsigned int key = irq_lock(); /* ... */ irq_unlock(key);',       notes: 'Zephyr IRQ lock; note: does NOT disable cooperative thread preemption' },
		{ sourceConstruct: 'pvPortMalloc(sz) / vPortFree(ptr)',                       targetConstruct: 'k_malloc(sz) / k_free(ptr)  // or k_mem_slab for pools',        notes: 'Allocate from Zephyr heap; prefer k_mem_slab for fixed-size deterministic allocation' },
		{ sourceConstruct: 'configASSERT(expr)',                                      targetConstruct: '__ASSERT(expr, "message")',                                      notes: 'Zephyr assert macro; configurable via CONFIG_ASSERT' },
		{ sourceConstruct: 'uxTaskGetStackHighWaterMark(NULL)',                        targetConstruct: 'k_thread_stack_space_get(k_current_get(), &unused)',            notes: 'Zephyr stack introspection; enable CONFIG_THREAD_STACK_INFO' },
	],

	conventionNotes: [
		'Replace all portMAX_DELAY with K_FOREVER and all pdMS_TO_TICKS(N) with K_MSEC(N)',
		'Static thread definition (K_THREAD_DEFINE) is preferred over dynamic k_thread_create() for safety-relevant threads',
		'Zephyr logging: use LOG_MODULE_REGISTER in each .c file; remove all FreeRTOS-era printf calls',
		'Zephyr shell (CONFIG_SHELL=y) replaces UART command menus; bind commands with SHELL_CMD_REGISTER',
		'Peripheral access via Device Tree only: replace FreeRTOS HAL direct calls with Zephyr driver API',
	],

	warningPatterns: [
		'xTimerCreate — raise decision: Zephyr software timer (k_timer) has different API; callback runs in sysclock ISR context by default',
		'vTaskSuspend / vTaskResume — raise decision: Zephyr uses k_thread_suspend / k_thread_resume with handle from K_THREAD_DEFINE',
		'FreeRTOS hooks (vApplicationStackOverflowHook, etc.) — raise decision: map to Zephyr fatal error hook (k_sys_fatal_error_handler)',
		'pvPortMalloc in ISR context — raise blocking decision; heap allocation from ISR is undefined behaviour in Zephyr',
		'configTICK_RATE_HZ mismatch — raise note: verify CONFIG_SYS_CLOCK_TICKS_PER_SEC matches application timing assumptions',
	],
};


// ─── AUTOSAR Classic SWC → AUTOSAR Adaptive ──────────────────────────────────

const AUTOSAR_CLASSIC_TO_ADAPTIVE: ILanguagePairProfile = {
	sourceLang: 'autosar',
	targetLang: 'cpp',
	label: 'AUTOSAR Classic SWC → AUTOSAR Adaptive (ARA)',
	targetFramework: 'AUTOSAR Adaptive Platform (ara::com, ara::exec)',
	targetTestFramework: 'GoogleTest + vADASim',
	targetFileExtension: 'cpp',

	systemPersona: `You are an AUTOSAR Adaptive Platform architect with expertise in migrating AUTOSAR Classic (CP) SWCs to AUTOSAR Adaptive (AP) executables. You understand the CP RTE generated code model (Rte_Call, Rte_Read, Rte_Write API), port-interface contracts, inter-runnable variable patterns, and how they map to AUTOSAR Adaptive ara::com service discovery with SkeletonBase/ProxyBase patterns, SOME/IP serialization, and ara::exec Adaptive Application lifecycle. You are familiar with C++14/17 compliance requirements and AP-forbidden constructs (no exceptions in safety-relevant paths, no RTTI).`,

	idiomMap: [
		{ sourceConstruct: 'Rte_Read_<port>_<elem>(&value)',                          targetConstruct: 'auto future = proxy->elem.Get(); value = future.get();  // ara::com Proxy field', notes: 'CP Rte_Read → AP ara::com field Get() on Proxy; adapt for async/event patterns' },
		{ sourceConstruct: 'Rte_Write_<port>_<elem>(value)',                          targetConstruct: 'skeleton->elem.Update(value);  // ara::com Skeleton field Update', notes: 'CP Rte_Write → AP Skeleton field Update; fires SOME/IP notification to subscribers' },
		{ sourceConstruct: 'Rte_Call_<port>_<op>(<args>)',                            targetConstruct: 'auto result = proxy->Op(<args>).get();  // ara::com method call',  notes: 'CP client–server port → AP ara::com method on Proxy (Fire-and-forget or fire for result)' },
		{ sourceConstruct: 'RUNNABLE_DEFINE(MyRunnable, 10ms, cyclic)',               targetConstruct: 'class MyApplication : public ara::core::Initialize { void Run(); }; // scheduled by ara::exec', notes: 'Runnables become Run() method of Adaptive Application; scheduler managed by ara::exec' },
		{ sourceConstruct: 'IVR (inter-runnable variable): static uint32_t g_ivr;',  targetConstruct: 'Class member variable or ara::com event field; shared across methods of same executable', notes: 'IVR → class member; if cross-process: ara::com field; raise decision on scope' },
		{ sourceConstruct: 'Dem_SetEventStatus(DEM_EVENT_STATUS_FAILED)',             targetConstruct: 'ara::diag::DTCInhibitRecord or ara::diag::Monitor::ReportMonitorAction', notes: 'DEM events → AP diagnostic monitor report; map DTC IDs in diagnostic manifest' },
		{ sourceConstruct: 'NvM_ReadBlock / NvM_WriteBlock',                          targetConstruct: 'ara::per::KeyValueStorage::GetOrCreate() / kv->Set(key, value)',  notes: 'NvM persistent storage → ara::per key-value store; configure in manifest' },
		{ sourceConstruct: 'Com_SendSignal / Com_ReceiveSignal',                      targetConstruct: 'ara::com event send/subscribe via Skeleton::NotifySubscribers / Proxy::event.Subscribe', notes: 'COM signals → ara::com events over SOME/IP; serializer configured in ARXML manifest' },
		{ sourceConstruct: 'Os_GetTaskID() / Schedule()',                             targetConstruct: 'ara::exec::ApplicationClient — lifecycle managed by Execution Management', notes: 'No manual OS task scheduling in AP; ara::exec provides lifecycle states (Running, Terminating)' },
	],

	conventionNotes: [
		'Every AP Executable must implement ara::core::Initialize, Run, and operator()(ara::exec::ActivationReasonType) lifecycle hooks',
		'Service interfaces defined in ARXML manifests using ServiceInterface element — ara::com generates Skeleton/Proxy from manifest',
		'Use ara::core::Result<T, ErrorCode> instead of exceptions for all fallible operations',
		'No RTTI (no dynamic_cast, no typeid) — compile with -fno-rtti; all polymorphism via virtual + documented interface',
		'SOME/IP serialization is auto-generated from ARXML; do not manually marshal/unmarshal SOME/IP frames',
		'ara::log replaces all Classic DLT calls; configure LogLevel in application manifest',
	],

	warningPatterns: [
		'Dual-mode SWCs (CP + AP bridge) — raise design decision: transition period requires SOME/IP ↔ AUTOSAR Signal Gateway',
		'Tightly-timed runnables (< 1ms cycle) — raise decision: AP scheduling granularity may be insufficient; consider RT OS tuning',
		'Shared memory IPC between AP executables — raise security decision: requires ara::crypto and AUTOSAR IAM configuration',
		'DEM events with no AP diagnostic manifest counterpart — raise blocking decision; DTCs must be defined in manifest before translation',
	],
};


// ─── PLC (IEC 61131-3) → Linux-RT IPC (C++) ──────────────────────────────────

const PLC_TO_LINUX_RT: ILanguagePairProfile = {
	sourceLang: 'iec61131',
	targetLang: 'cpp',
	label: 'PLC (IEC 61131-3) → Linux-RT IPC Application (C++)',
	targetFramework: 'PREEMPT-RT Linux + IEC 61499 / OPC-UA for Devices',
	targetTestFramework: 'GoogleTest + SIL simulation',
	targetFileExtension: 'cpp',

	systemPersona: `You are an industrial automation architect specialising in migrating PLC ladder and structured text programs to real-time Linux (PREEMPT-RT) industrial PC applications in C++. You understand POSIX real-time scheduling (SCHED_FIFO, sched_param), memory-locking (mlockall), and how PLC scan-cycle semantics map to a periodic POSIX timer thread. You know how to integrate MODBUS-TCP, OPC-UA (open62541), and EtherCAT master stacks into a Linux-RT application. You are familiar with IEC 62443 cybersecurity requirements for OT/IT convergence systems.`,

	idiomMap: [
		{ sourceConstruct: 'PROGRAM Main  (* PLC cyclic scan *)',                    targetConstruct: 'class ScanThread : public PeriodicThread { void execute() override; };  // SCHED_FIFO periodic RT thread', notes: 'PLC scan cycle → SCHED_FIFO POSIX thread with clock_nanosleep for deterministic timing' },
		{ sourceConstruct: 'VAR_GLOBAL i_StartButton AT %I*: BOOL; END_VAR',        targetConstruct: 'struct IoImage { bool startButton; };  // shared between IO-thread and logic thread with mutex', notes: 'PLC I/O image → shared memory struct with spinlock or mutex; IO thread updates, logic thread reads' },
		{ sourceConstruct: 'TON_Instance(IN:=Condition, PT:=T#5S); q:=TON_Instance.Q;', targetConstruct: 'class TonTimer { bool update(bool in, std::chrono::milliseconds pt); bool q; };', notes: 'Implement IEC 61131-3 timer semantics in C++ class; call on every scan period' },
		{ sourceConstruct: 'SF_EmergencyStop(S_EStopIn:=EStop)',                    targetConstruct: 'SafetyManager::handleEStop(eStopSignal);  // dedicated safety class with SIL-compliant logic', notes: 'Safety FBs must map to verified C++ safety classes with identical state machine; raise decision for SIL certification' },
		{ sourceConstruct: 'Modbus_TCP_Read(IPAddr:="192.168.1.10")',               targetConstruct: 'auto ctx = modbus_new_tcp("192.168.1.10", 502); modbus_read_registers(ctx, addr, nb, tab_reg);', notes: 'Use libmodbus; run in dedicated IO thread; share data via protected IO image struct' },
		{ sourceConstruct: 'OPCUA_Write(NodeId:=..., Value:=...)',                  targetConstruct: 'UA_Client_writeValueAttribute(client, nodeId, &value);  // open62541',   notes: 'OPC-UA write via open62541 client; run in separate thread; protect with mutex around shared state' },
		{ sourceConstruct: 'ALARM(Signal:=FaultCondition, Message:="Fault")',       targetConstruct: 'AlarmManager::raise(AlarmCode::FAULT, "Fault description");',            notes: 'Alarm management class with severity, acknowledgement, and timestamping' },
		{ sourceConstruct: 'RETAIN VAR  (* persistent variable *)',                 targetConstruct: 'nlohmann::json state; std::ofstream("state.json") << state;  // JSON persistence', notes: 'PLC RETAIN variables → persisted JSON or SQLite; write on clean shutdown, restore on startup' },
	],

	conventionNotes: [
		'Call mlockall(MCL_CURRENT | MCL_FUTURE) at startup to prevent page faults in RT threads',
		'All RT threads must use SCHED_FIFO with priority 80–99; non-RT threads ≤ 50',
		'Scan period jitter: measure with clock_gettime(CLOCK_MONOTONIC); alert if > 10% of period',
		'IO image struct access must be protected with std::mutex or a lock-free ring buffer for ISR→thread',
		'Safety-critical logic must run in a separate high-priority thread with independent watchdog',
		'Logging via spdlog (async, non-blocking) — never std::cout in RT threads',
		'Apply IEC 62443 Zone/Conduit model: OPC-UA interface in DMZ zone, control logic in control zone',
	],

	warningPatterns: [
		'Safety function blocks — raise blocking decision: C++ replacement must have equivalent SIL certification evidence',
		'Timer resolution < 1ms — raise decision: PREEMPT-RT jitter under load must be characterised on target hardware',
		'Large scan programs (> 1000 rungs) — raise decision: decompose into subsystem threads with defined cycle times',
		'RETAIN variables with large data — raise decision: JSON serialisation adds latency; consider mmap-backed persistence',
		'OPC-UA over untrusted network — raise IEC 62443 decision: TLS certificate management and user authentication required',
	],
};


// ─── Modbus C → OPC-UA C++ ────────────────────────────────────────────────────

const MODBUS_TO_OPCUA: ILanguagePairProfile = {
	sourceLang: 'c',
	targetLang: 'cpp',
	label: 'Modbus RTU/TCP C → OPC-UA C++ (open62541)',
	targetFramework: 'open62541 v1.3+ / OPC-UA Part 4',
	targetTestFramework: 'GoogleTest + OPC-UA Compliance Test Tool',
	targetFileExtension: 'cpp',

	systemPersona: `You are an industrial IoT architect with deep expertise in migrating Modbus (RTU and TCP) polling-based SCADA integrations to OPC-UA publish-subscribe and client-server architectures using the open62541 open-source C SDK. You understand Modbus FC01–FC06/FC15/FC16 function codes, register addressing, and how they map to OPC-UA nodes with the correct NodeClass (Variable, Method, Object), NodeId, and Access Level. You are familiar with OPC-UA Information Model design and the Companion Specification pattern for industrial equipment.`,

	idiomMap: [
		{ sourceConstruct: 'modbus_read_registers(ctx, addr, nb, regs)',             targetConstruct: 'UA_Client_readValueAttribute(client, UA_NODEID_NUMERIC(nsIdx, nodeId), &value)',  notes: 'Modbus read coil/register → OPC-UA readValue; map register address to NodeId' },
		{ sourceConstruct: 'modbus_write_register(ctx, addr, value)',                targetConstruct: 'UA_Client_writeValueAttribute(client, nodeId, &value)',               notes: 'Modbus write register → OPC-UA writeValue; check AccessLevel = CurrentWrite on node' },
		{ sourceConstruct: 'while(1) { modbus_read_registers(...); sleep(period); }', targetConstruct: 'UA_Client_Subscriptions_create(...); UA_MonitoredItemCreateRequest mi; /* event-driven */', notes: 'Replace Modbus polling loop with OPC-UA monitored item subscription (publish-subscribe reduces network load)' },
		{ sourceConstruct: 'uint16_t holdingReg[125];  // register bank',            targetConstruct: 'UA_VariableNode with NodeId NS=2, Identifier=1001, DataType=UInt16, AccessLevel=RW', notes: 'Each Modbus register maps to an OPC-UA Variable node; define in Information Model' },
		{ sourceConstruct: 'FC01 read coils (bit outputs)',                          targetConstruct: 'UA_VariableNode DataType=Boolean, writable; or StatusCode-typed Variable', notes: '' },
		{ sourceConstruct: 'FC02 read discrete inputs (bit inputs)',                  targetConstruct: 'UA_VariableNode DataType=Boolean, AccessLevel=CurrentRead only',       notes: '' },
		{ sourceConstruct: 'FC03 read holding registers (output registers)',          targetConstruct: 'UA_VariableNode DataType=UInt16 or Float, AccessLevel=RW',              notes: 'Float if engineering unit scaling applied; include EUInformation extension object' },
		{ sourceConstruct: 'FC04 read input registers (sensor values)',               targetConstruct: 'UA_VariableNode DataType=Float, AccessLevel=CurrentRead, with AnalogItemType', notes: 'Use OPC-UA AnalogItemType for sensor values — includes EURange and EUInformation' },
		{ sourceConstruct: 'modbus_set_slave(ctx, slaveId)',                         targetConstruct: '// OPC-UA has no slave ID concept — device discovery via FindServers / Browse', notes: 'Raise decision: multiple Modbus slaves → separate OPC-UA Server instances or OPC-UA Aggregation Proxy' },
		{ sourceConstruct: 'modbus_connect(ctx); if (rc == -1) retry...',           targetConstruct: 'UA_ClientConfig_setDefault(&config); UA_Client_connect(client, "opc.tcp://host:4840")', notes: 'OPC-UA connection includes session establishment and security channel; configure SecurityMode' },
	],

	conventionNotes: [
		'Design the OPC-UA Information Model (Namespace, NodeIds, Object hierarchy) BEFORE writing code — use a UaModeler or FreeOpcUa nodeset tool',
		'Node IDs must be stable across server restarts — use numeric NodeIds defined in a header, not string-based auto-generated IDs',
		'Apply SecurityMode at minimum SignAndEncrypt for all production OPC-UA connections (IEC 62443 requirement)',
		'Add EUInformation (engineering unit description) to all AnalogItemType nodes',
		'Use OPC-UA Methods (not Variable writes) for actuator commands — they provide a call-response semantic with argument validation',
		'Log all write operations with timestamp and caller identity for IEC 62443 audit trail',
	],

	warningPatterns: [
		'Modbus address-to-NodeId mapping gaps — raise blocking decision: all 125 holding registers must be explicitly mapped to named nodes with documented semantics',
		'Modbus CRC error handling → OPC-UA Bad status codes — raise decision: error propagation strategy needed (bad quality, null value, or alarm)',
		'Multiple masters — raise decision: OPC-UA server handles multiple concurrent clients natively; document access control per client certificate',
		'High-frequency Modbus polling (< 100ms) — raise decision: OPC-UA monitored item sampling interval must match; server capability check required',
	],
};


// ─── Generic Firmware Fallback ────────────────────────────────────────────────

const GENERIC_FIRMWARE_FALLBACK: ILanguagePairProfile = {
	sourceLang: 'c',
	targetLang: 'c',
	label: 'Generic Embedded Firmware Translation',
	targetFramework: 'Target-specific (specify in session options)',
	targetTestFramework: 'Unity / HIL',
	targetFileExtension: 'c',

	systemPersona: `You are a senior embedded systems engineer with expertise across multiple MCU families (ARM Cortex-M, RISC-V, AVR, PIC, ESP32), RTOS platforms (FreeRTOS, Zephyr, RTX, VxWorks), and embedded communication protocols (UART, SPI, I2C, CAN, Modbus, OPC-UA). You translate embedded C/C++ firmware with meticulous attention to hardware timing constraints, interrupt safety, watchdog requirements, and safety-critical compliance (IEC 61508, MISRA-C:2012). When context is insufficient to make a precise translation, you raise a decision rather than guess.`,

	idiomMap: [
		{ sourceConstruct: 'volatile uint32_t *reg = (volatile uint32_t*)ADDR',      targetConstruct: '/* BSP accessor */ uint32_t bsp_read_reg(uint32_t addr)',           notes: 'Isolate all MMIO into BSP layer; never scatter raw casts through application code' },
		{ sourceConstruct: 'void __attribute__((interrupt)) ISR_Name(void)',          targetConstruct: 'void ISR_Name_IRQHandler(void)  /* CMSIS naming */  — deferred via queue', notes: 'ISR should be minimal: post event to queue and return; deferred processing in task' },
		{ sourceConstruct: 'while(!(REG & FLAG));  // polling busy-wait',             targetConstruct: '/* Replace with interrupt / DMA or timeout-guarded loop */',        notes: 'Raise decision: polling loops block other work; consider ISR + semaphore or DMA' },
		{ sourceConstruct: 'HAL_IWDG_Refresh() / WDT_Feed()',                        targetConstruct: 'Called from dedicated watchdog task or at fixed points in control loop', notes: 'Watchdog refresh must be architecturally guaranteed; document refresh strategy' },
		{ sourceConstruct: 'assert(expr)',                                            targetConstruct: 'configASSERT(expr) / __ASSERT(expr, msg) / MISRA-compliant handler', notes: 'Replace C assert() with RTOS or MISRA-specific assert macro' },
	],

	conventionNotes: [
		'Always specify the target MCU family and HAL/RTOS in session options before translating — guidance adapts accordingly',
		'Every ISR must have documented maximum execution time',
		'All shared variables between ISR and task/main context must use atomic access or critical sections',
		'Zero-initialise all stack and static variables; never rely on undefined initial state',
	],

	warningPatterns: [
		'Raw peripheral register access outside BSP layer — raise decision: isolate in BSP',
		'Missing watchdog refresh coverage after translation — raise safety decision',
		'Shared mutable state between multiple interrupt levels — raise concurrency decision',
	],
};


// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * All supported language pair profiles, in priority order.
 * The lookup function searches this array from first to last and returns the
 * first profile matching the (sourceLang, targetLang, profileId?) query.
 */
export const LANGUAGE_PAIR_PROFILES: ILanguagePairProfile[] = [
	BARE_METAL_C_TO_FREERTOS,
	BARE_METAL_C_TO_ZEPHYR,
	EMBEDDED_C_TO_CPP_MISRA,
	ASSEMBLY_TO_EMBEDDED_C,
	LADDER_TO_STRUCTURED_TEXT,
	REGISTER_DIRECT_TO_STM32_HAL,
	FREERTOS_TO_ZEPHYR,
	AUTOSAR_CLASSIC_TO_ADAPTIVE,
	PLC_TO_LINUX_RT,
	MODBUS_TO_OPCUA,
	GENERIC_FIRMWARE_FALLBACK,
];


// ─── Lookup API ───────────────────────────────────────────────────────────────

/**
 * Find the best matching language pair profile for the given source and target
 * language keys (as returned by `detectLanguage` / `canonicaliseLanguage`).
 *
 * Resolution order:
 *  1. Exact match on sourceLang + targetLang
 *  2. Match on sourceLang only (first entry wins)
 *  3. Generic firmware fallback
 */
export function getLanguagePairProfile(
	sourceLang: string,
	targetLang: string,
): ILanguagePairProfile {
	const src = canonicaliseLanguage(sourceLang);
	const tgt = canonicaliseLanguage(targetLang);

	// 1. Exact match
	const exact = LANGUAGE_PAIR_PROFILES.find(p => p.sourceLang === src && p.targetLang === tgt);
	if (exact) { return exact; }

	// 2. Source-only match (first wins)
	const srcOnly = LANGUAGE_PAIR_PROFILES.find(p => p.sourceLang === src);
	if (srcOnly) { return srcOnly; }

	// 3. Fallback
	return GENERIC_FIRMWARE_FALLBACK;
}

/**
 * Return all profiles for a given source language, sorted alphabetically by label.
 */
export function getProfilesForSource(sourceLang: string): ILanguagePairProfile[] {
	const src = canonicaliseLanguage(sourceLang);
	return LANGUAGE_PAIR_PROFILES
		.filter(p => p.sourceLang === src)
		.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * @returns All unique source language keys represented in the registry.
 */
export function getSupportedSourceLanguages(): string[] {
	return [...new Set(LANGUAGE_PAIR_PROFILES.map(p => p.sourceLang))].sort();
}

/**
 * @returns All unique target language keys for a given source language.
 */
export function getSupportedTargetLanguages(sourceLang: string): string[] {
	const src = canonicaliseLanguage(sourceLang);
	return [...new Set(
		LANGUAGE_PAIR_PROFILES.filter(p => p.sourceLang === src).map(p => p.targetLang),
	)].sort();
}
