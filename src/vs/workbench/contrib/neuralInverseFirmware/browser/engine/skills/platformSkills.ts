/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Platform Skills
 *
 * Curated, platform-specific knowledge packs for embedded development.
 * Each skill contains:
 *   - Initialization sequences for common peripherals
 *   - Clock tree configuration guidance
 *   - Interrupt and DMA setup patterns
 *   - Common pitfalls and debugging tips
 *   - Debug probe configuration
 *   - Linker script templates
 *
 * These correspond to what Embedder calls "skill system" — pre-built workflows
 * for specific platforms that encode curated embedded knowledge.
 *
 * V1 platforms: STM32, ESP32, nRF, RP2040
 */


// ─── Platform Skill Interface ─────────────────────────────────────────────────

export interface IPlatformSkill {
	/** Platform identifier (matches session.platformId) */
	id: string;
	/** Display name */
	name: string;
	/** Manufacturer */
	manufacturer: string;
	/** Peripheral initialization code templates (peripheral name → C code) */
	initSequences: Record<string, string>;
	/** Clock tree configuration guidance */
	clockTreeNotes: string;
	/** Interrupt vector and NVIC configuration notes */
	interruptNotes: string;
	/** DMA configuration guidance */
	dmaNotes: string;
	/** Common pitfalls and debugging tips */
	pitfalls: string[];
	/** Debug probe configuration commands */
	debugConfig: IDebugProbeConfig;
	/** Startup sequence (boot process) notes */
	startupNotes: string;
	/** Low-power mode configuration guidance */
	lowPowerNotes: string;
	/** Linker script template (for bare-metal) */
	linkerTemplate?: string;
}

export interface IDebugProbeConfig {
	/** Recommended debug probe */
	probe: string;
	/** OpenOCD config files */
	openocdConfig: string[];
	/** GDB server launch command */
	gdbServerCommand: string[];
	/** Flash command */
	flashCommand: string[];
	/** Reset and halt command */
	resetCommand: string;
}


// ─── Skill Registry ──────────────────────────────────────────────────────────

const SKILLS: Map<string, IPlatformSkill> = new Map();

export function getPlatformSkill(platformId: string): IPlatformSkill | undefined {
	return SKILLS.get(platformId);
}

export function getAllPlatformSkills(): IPlatformSkill[] {
	return Array.from(SKILLS.values());
}

export function getPlatformIds(): string[] {
	return Array.from(SKILLS.keys());
}


// ─── STM32 Skill ──────────────────────────────────────────────────────────────

SKILLS.set('stm32', {
	id: 'stm32',
	name: 'STM32',
	manufacturer: 'STMicroelectronics',

	initSequences: {
		'GPIO': `// Enable GPIO clock
RCC->AHB1ENR |= RCC_AHB1ENR_GPIOxEN;  // Replace x with port letter

// Configure pin mode: 00=Input, 01=Output, 10=AF, 11=Analog
GPIOx->MODER &= ~(0x3U << (pin * 2));
GPIOx->MODER |= (0x1U << (pin * 2));   // Output mode

// Set output type: 0=Push-pull, 1=Open-drain
GPIOx->OTYPER &= ~(1U << pin);         // Push-pull

// Set speed: 00=Low, 01=Medium, 10=Fast, 11=High
GPIOx->OSPEEDR &= ~(0x3U << (pin * 2));
GPIOx->OSPEEDR |= (0x2U << (pin * 2)); // Fast

// Set pull-up/pull-down: 00=None, 01=Pull-up, 10=Pull-down
GPIOx->PUPDR &= ~(0x3U << (pin * 2));`,

		'USART': `// 1. Enable clocks
RCC->APB1ENR |= RCC_APB1ENR_USARTxEN;  // USART2/3/4/5 on APB1
RCC->AHB1ENR |= RCC_AHB1ENR_GPIOxEN;   // GPIO clock for TX/RX pins

// 2. Configure GPIO pins for AF mode
GPIOx->MODER &= ~(0x3U << (tx_pin * 2));
GPIOx->MODER |= (0x2U << (tx_pin * 2));  // AF mode
// Set AF number in AFR[0] (pins 0-7) or AFR[1] (pins 8-15)
GPIOx->AFR[tx_pin / 8] &= ~(0xFU << ((tx_pin % 8) * 4));
GPIOx->AFR[tx_pin / 8] |= (af_num << ((tx_pin % 8) * 4));

// 3. Configure USART
USARTx->BRR = APB_CLOCK / BAUD_RATE;   // Baud rate
USARTx->CR1 = 0;                        // Reset CR1
USARTx->CR1 |= USART_CR1_TE | USART_CR1_RE;  // Enable TX and RX
USARTx->CR1 |= USART_CR1_UE;           // Enable USART
// Wait for TEACK and REACK on F7/H7 (not needed on F4)`,

		'SPI': `// 1. Enable clocks
RCC->APB2ENR |= RCC_APB2ENR_SPI1EN;    // SPI1 on APB2
RCC->AHB1ENR |= RCC_AHB1ENR_GPIOxEN;   // GPIO for SCK/MOSI/MISO

// 2. Configure GPIO pins (AF mode, high speed)
// SCK, MOSI: AF push-pull, high speed
// MISO: AF input (or AF push-pull for bidirectional)
// NSS: GPIO output if software-managed

// 3. Configure SPI
SPI1->CR1 = 0;
SPI1->CR1 |= SPI_CR1_MSTR;             // Master mode
SPI1->CR1 |= (0x3U << SPI_CR1_BR_Pos); // Baud = fPCLK/16
SPI1->CR1 |= SPI_CR1_SSI | SPI_CR1_SSM; // Software NSS
// CPOL=0,CPHA=0 by default (Mode 0)
SPI1->CR1 |= SPI_CR1_SPE;              // Enable SPI`,

		'I2C': `// 1. Enable clocks
RCC->APB1ENR |= RCC_APB1ENR_I2C1EN;
RCC->AHB1ENR |= RCC_AHB1ENR_GPIOBEN;   // PB6=SCL, PB7=SDA typical

// 2. Configure GPIO: AF mode, open-drain, pull-up
GPIOx->MODER |= (0x2U << (scl_pin * 2)) | (0x2U << (sda_pin * 2));
GPIOx->OTYPER |= (1U << scl_pin) | (1U << sda_pin);  // Open-drain!
GPIOx->PUPDR |= (0x1U << (scl_pin * 2)) | (0x1U << (sda_pin * 2)); // Pull-up

// 3. Configure I2C timing (example for 100kHz standard mode @ 42MHz APB1)
I2C1->CR1 &= ~I2C_CR1_PE;              // Disable before config
I2C1->CR2 = 42;                         // APB1 clock in MHz
I2C1->CCR = 210;                        // CCR = fPCLK / (2 * fSCL)
I2C1->TRISE = 43;                       // (fPCLK_MHz / 1000000) + 1
I2C1->CR1 |= I2C_CR1_PE;               // Enable I2C`,

		'ADC': `// 1. Enable clocks
RCC->APB2ENR |= RCC_APB2ENR_ADC1EN;
RCC->AHB1ENR |= RCC_AHB1ENR_GPIOxEN;

// 2. Configure GPIO pin as analog
GPIOx->MODER |= (0x3U << (pin * 2));   // Analog mode

// 3. Configure ADC
ADC1->CR2 = 0;
ADC1->SQR3 = channel;                  // First conversion channel
ADC1->SQR1 = 0;                        // 1 conversion
ADC1->SMPR2 |= (0x7U << (channel * 3)); // 480 cycles sample time
ADC1->CR2 |= ADC_CR2_ADON;            // Enable ADC

// 4. Start conversion
ADC1->CR2 |= ADC_CR2_SWSTART;
while (!(ADC1->SR & ADC_SR_EOC));       // Wait for conversion
uint16_t value = ADC1->DR;             // Read result`,

		'TIM_PWM': `// 1. Enable clocks
RCC->APB1ENR |= RCC_APB1ENR_TIM2EN;    // TIM2 on APB1
RCC->AHB1ENR |= RCC_AHB1ENR_GPIOxEN;

// 2. GPIO: AF mode for timer channel output

// 3. Configure timer for PWM
TIM2->PSC = 84 - 1;                    // Prescaler: 84MHz / 84 = 1MHz tick
TIM2->ARR = 1000 - 1;                  // Period: 1000 ticks = 1kHz PWM
TIM2->CCR1 = 500;                      // 50% duty cycle
TIM2->CCMR1 = (0x6U << TIM_CCMR1_OC1M_Pos) | TIM_CCMR1_OC1PE; // PWM Mode 1
TIM2->CCER |= TIM_CCER_CC1E;           // Enable channel 1 output
TIM2->CR1 |= TIM_CR1_ARPE | TIM_CR1_CEN; // Enable timer`,

		'DMA': `// 1. Enable DMA clock
RCC->AHB1ENR |= RCC_AHB1ENR_DMA1EN;    // or DMA2

// 2. Configure DMA stream
DMA1_Stream5->CR &= ~DMA_SxCR_EN;      // Disable before config
while (DMA1_Stream5->CR & DMA_SxCR_EN); // Wait until disabled

DMA1_Stream5->CR = 0;
DMA1_Stream5->CR |= (4U << DMA_SxCR_CHSEL_Pos); // Channel select (check reference manual)
DMA1_Stream5->CR |= DMA_SxCR_MINC;     // Memory increment
DMA1_Stream5->CR |= (0x1U << DMA_SxCR_DIR_Pos); // Memory-to-peripheral
DMA1_Stream5->CR |= DMA_SxCR_TCIE;     // Transfer complete interrupt

DMA1_Stream5->PAR = (uint32_t)&USARTx->DR;  // Peripheral address
DMA1_Stream5->M0AR = (uint32_t)buffer;       // Memory address
DMA1_Stream5->NDTR = length;                 // Number of data items

DMA1_Stream5->CR |= DMA_SxCR_EN;       // Enable stream`,
	},

	clockTreeNotes: `STM32 Clock Tree:
- Reset default: HSI (8-16MHz internal RC, varies by family)
- PLL input: HSE (external crystal 4-26MHz) or HSI
- PLL output: VCO_freq = PLL_input * (PLLN / PLLM), SYSCLK = VCO / PLLP
- Prescalers: SYSCLK → AHB (HPRE) → APB1 (PPRE1, max 42MHz F4) → APB2 (PPRE2, max 84MHz F4)
- CRITICAL: Set Flash wait states BEFORE increasing SYSCLK
  - 0WS: up to 30MHz, 1WS: up to 60MHz, 2WS: up to 90MHz (varies by Vdd)
- Enable CSS (Clock Security System) for safety: automatic switchover to HSI if HSE fails
- Timer clocks: if APBx prescaler != 1, timer clock = 2 * APBx_clock`,

	interruptNotes: `STM32 NVIC:
- Priority grouping: set SCB->AIRCR[10:8] (typically 4 bits preemption, 0 bits sub)
- NVIC_SetPriority(IRQn, priority) — lower number = higher priority
- NVIC_EnableIRQ(IRQn) — enable in NVIC
- Peripheral IRQ enable: set IE bit in peripheral register (e.g., USART_CR1_RXNEIE)
- Clear interrupt flag in ISR: peripheral->SR &= ~FLAG or peripheral->ICR = FLAG
- Shared IRQ lines: multiple peripherals may share one NVIC line (check vector table)
- DMA interrupts: clear flags in DMA_LIFCR/HIFCR (not in stream->CR)`,

	dmaNotes: `STM32 DMA:
- DMA1: 8 streams, 8 channels per stream — channels are fixed mapping to peripherals
- DMA2: 8 streams, 8 channels per stream
- Check DMA request mapping in Reference Manual (different per family)
- Always disable stream before reconfiguring (wait for EN=0)
- Clear DMA flags in LIFCR/HIFCR before enabling
- For circular mode: set CIRC bit, DMA auto-reloads NDTR
- Double-buffer mode: set DBM bit, swap between M0AR and M1AR
- FIFO: 4-word FIFO per stream, configure threshold in FCR`,

	pitfalls: [
		'Forgetting to enable peripheral clock in RCC before accessing registers → hard fault',
		'Flash wait states not set before increasing SYSCLK → random crashes / data corruption',
		'GPIO alternate function number wrong → peripheral doesn\'t work, no error indication',
		'I2C SDA/SCL not configured as open-drain → bus contention, random NAKs',
		'DMA channel/stream mapping wrong → DMA never triggers, no error',
		'APB1 peripherals max clock lower than SYSCLK → need prescaler or it\'s out of spec',
		'SysTick not configured for FreeRTOS tick → kernel crashes on first context switch',
		'Backup domain write-protected → RTC/backup register writes silently ignored',
		'USB requires 48MHz clock from PLL → must configure PLL_Q divider correctly',
		'Bootloader mode entered if BOOT0 pin high on reset → seems like brick',
	],

	debugConfig: {
		probe: 'ST-Link V2/V3',
		openocdConfig: ['-f', 'interface/stlink.cfg', '-f', 'target/stm32f4x.cfg'],
		gdbServerCommand: ['openocd', '-f', 'interface/stlink.cfg', '-f', 'target/stm32f4x.cfg'],
		flashCommand: ['openocd', '-f', 'interface/stlink.cfg', '-f', 'target/stm32f4x.cfg',
			'-c', 'program build/*.elf verify reset exit'],
		resetCommand: 'monitor reset halt',
	},

	startupNotes: `STM32 Boot Sequence:
1. Reset vector fetched from 0x00000004 (mapped from Flash at 0x08000000)
2. Stack pointer loaded from 0x00000000 (first word of vector table)
3. Reset_Handler runs: copies .data from Flash to RAM, zeroes .bss
4. SystemInit() called: configures FPU, sets VTOR if needed
5. main() called
6. If using HAL: HAL_Init() → SysTick to 1ms, NVIC priority grouping
7. SystemClock_Config() → HSE, PLL, Flash wait states, bus prescalers`,

	lowPowerNotes: `STM32 Low Power:
- Sleep: CPU stops, peripherals run. WFI/WFE instruction. Wake by any interrupt.
- Stop: All clocks stopped except LSE/LSI. 1.2V regulator in low-power. Wake by EXTI.
- Standby: 1.2V regulator off, SRAM lost. Only backup domain + RTC alive. Wake by WKUP pin/RTC.
- Before entering Stop: configure wake-up sources, set SLEEPDEEP bit
- HAL_PWR_EnterSTOPMode(PWR_LOWPOWERREGULATOR_ON, PWR_STOPENTRY_WFI)
- After wake from Stop: must reconfigure clocks (PLL is off)`,
});


// ─── ESP32 Skill ──────────────────────────────────────────────────────────────

SKILLS.set('esp32', {
	id: 'esp32',
	name: 'ESP32',
	manufacturer: 'Espressif',

	initSequences: {
		'GPIO': `// ESP-IDF GPIO API
gpio_config_t io_conf = {
    .pin_bit_mask = (1ULL << GPIO_NUM),
    .mode = GPIO_MODE_OUTPUT,           // or GPIO_MODE_INPUT
    .pull_up_en = GPIO_PULLUP_DISABLE,
    .pull_down_en = GPIO_PULLDOWN_DISABLE,
    .intr_type = GPIO_INTR_DISABLE,
};
gpio_config(&io_conf);

// Set/get level
gpio_set_level(GPIO_NUM, 1);
int level = gpio_get_level(GPIO_NUM);`,

		'UART': `// ESP-IDF UART
uart_config_t uart_config = {
    .baud_rate = 115200,
    .data_bits = UART_DATA_8_BITS,
    .parity = UART_PARITY_DISABLE,
    .stop_bits = UART_STOP_BITS_1,
    .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
};
uart_param_config(UART_NUM_1, &uart_config);
uart_set_pin(UART_NUM_1, TX_PIN, RX_PIN, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
uart_driver_install(UART_NUM_1, 256, 256, 0, NULL, 0);

// Write/Read
uart_write_bytes(UART_NUM_1, data, len);
int read = uart_read_bytes(UART_NUM_1, buf, len, pdMS_TO_TICKS(100));`,

		'SPI': `// ESP-IDF SPI Master
spi_bus_config_t bus_cfg = {
    .mosi_io_num = MOSI_PIN,
    .miso_io_num = MISO_PIN,
    .sclk_io_num = SCLK_PIN,
    .quadwp_io_num = -1,
    .quadhd_io_num = -1,
    .max_transfer_sz = 4096,
};
spi_bus_initialize(SPI2_HOST, &bus_cfg, SPI_DMA_CH_AUTO);

spi_device_interface_config_t dev_cfg = {
    .clock_speed_hz = 1000000,  // 1MHz
    .mode = 0,                   // CPOL=0, CPHA=0
    .spics_io_num = CS_PIN,
    .queue_size = 7,
};
spi_device_handle_t spi;
spi_bus_add_device(SPI2_HOST, &dev_cfg, &spi);`,

		'I2C': `// ESP-IDF I2C Master
i2c_config_t conf = {
    .mode = I2C_MODE_MASTER,
    .sda_io_num = SDA_PIN,
    .scl_io_num = SCL_PIN,
    .sda_pullup_en = GPIO_PULLUP_ENABLE,
    .scl_pullup_en = GPIO_PULLUP_ENABLE,
    .master.clk_speed = 100000,  // 100kHz
};
i2c_param_config(I2C_NUM_0, &conf);
i2c_driver_install(I2C_NUM_0, conf.mode, 0, 0, 0);

// Read from device
i2c_cmd_handle_t cmd = i2c_cmd_link_create();
i2c_master_start(cmd);
i2c_master_write_byte(cmd, (addr << 1) | I2C_MASTER_WRITE, true);
i2c_master_write_byte(cmd, reg, true);
i2c_master_start(cmd);  // Repeated start
i2c_master_write_byte(cmd, (addr << 1) | I2C_MASTER_READ, true);
i2c_master_read_byte(cmd, &data, I2C_MASTER_NACK);
i2c_master_stop(cmd);
i2c_master_cmd_begin(I2C_NUM_0, cmd, pdMS_TO_TICKS(100));
i2c_cmd_link_delete(cmd);`,

		'WiFi_STA': `// ESP-IDF WiFi Station Mode
ESP_ERROR_CHECK(esp_netif_init());
ESP_ERROR_CHECK(esp_event_loop_create_default());
esp_netif_create_default_wifi_sta();

wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
ESP_ERROR_CHECK(esp_wifi_init(&cfg));

wifi_config_t wifi_config = {
    .sta = {
        .ssid = "SSID",
        .password = "PASSWORD",
    },
};
ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
ESP_ERROR_CHECK(esp_wifi_start());
ESP_ERROR_CHECK(esp_wifi_connect());`,

		'ADC': `// ESP-IDF ADC (oneshot mode, v5.x+)
adc_oneshot_unit_handle_t adc_handle;
adc_oneshot_unit_init_cfg_t init_cfg = {
    .unit_id = ADC_UNIT_1,
};
adc_oneshot_new_unit(&init_cfg, &adc_handle);

adc_oneshot_chan_cfg_t chan_cfg = {
    .atten = ADC_ATTEN_DB_12,    // 0-3.3V range
    .bitwidth = ADC_BITWIDTH_12, // 12-bit resolution
};
adc_oneshot_config_channel(adc_handle, ADC_CHANNEL_0, &chan_cfg);

int raw;
adc_oneshot_read(adc_handle, ADC_CHANNEL_0, &raw);
// Note: ADC2 CANNOT be used while WiFi is active!`,
	},

	clockTreeNotes: `ESP32 Clock:
- CPU: 80/160/240 MHz (configurable via menuconfig)
- APB: always 80MHz (peripheral reference clock)
- RTC: 150kHz internal RC or 32.768kHz external crystal
- Dynamic frequency scaling: esp_pm_configure() → CPU clock scales with load
- PLL: 320MHz or 480MHz, divided down for CPU clock
- XTAL: 40MHz (most boards) or 26MHz (check board schematic)`,

	interruptNotes: `ESP32 Interrupts:
- Two interrupt controllers (one per core)
- Use esp_intr_alloc() to allocate interrupts — don't manually write to NVIC
- IRAM_ATTR: ISR handler function MUST be in IRAM (Flash may be accessed by other core)
- GPIO interrupt: gpio_isr_handler_add(pin, handler, arg)
- Timer interrupt: timer_isr_callback_add() or gptimer_register_event_callbacks()
- FreeRTOS safe: use xQueueSendFromISR, xSemaphoreGiveFromISR in ISRs`,

	dmaNotes: `ESP32 DMA:
- Most peripherals have built-in DMA (SPI, I2C, UART, I2S)
- SPI DMA: set SPI_DMA_CH_AUTO in spi_bus_initialize()
- DMA buffers MUST be in internal RAM (DMA_ATTR or MALLOC_CAP_DMA)
- DMA buffer alignment: 4 bytes
- Max DMA transfer: 4092 bytes per descriptor (linked list for larger)`,

	pitfalls: [
		'ADC2 disabled while WiFi is active — use ADC1 for analog readings',
		'ISR handler not in IRAM → crash when flash cache is disabled',
		'DMA buffers in PSRAM → DMA fails silently (must be internal RAM)',
		'Task stack too small → stack overflow → random crashes (use uxTaskGetStackHighWaterMark to check)',
		'WiFi/BLE stack runs on core 0 — CPU-intensive tasks on core 1 with xTaskCreatePinnedToCore()',
		'Brownout detector triggers on USB power → disable in menuconfig for dev, keep for production',
		'Flash encryption enabled → can\'t re-flash without key → PERMANENT if in RELEASE mode',
		'GPIO strapping pins (GPIO0, GPIO2, GPIO12, GPIO15) affect boot mode if pulled wrong',
	],

	debugConfig: {
		probe: 'ESP-PROG or built-in USB-JTAG (S3/C3)',
		openocdConfig: ['-f', 'board/esp32-wrover-kit-3.3v.cfg'],
		gdbServerCommand: ['openocd', '-f', 'board/esp32-wrover-kit-3.3v.cfg'],
		flashCommand: ['idf.py', 'flash'],
		resetCommand: 'monitor reset halt',
	},

	startupNotes: `ESP32 Boot Sequence:
1. ROM bootloader: checks strapping pins (GPIO0/GPIO2/GPIO12/GPIO15)
2. Second-stage bootloader: from flash, loads partition table
3. App starts: FreeRTOS scheduler, creates app_main() task on core 0
4. app_main() is your entry point (runs as a FreeRTOS task)
5. Never return from app_main() — use vTaskDelete(NULL) if done`,

	lowPowerNotes: `ESP32 Power Modes:
- Active: ~240mA (WiFi TX), ~68mA (WiFi RX), ~25mA (BLE)
- Modem sleep: CPU active, WiFi/BT off → ~20mA
- Light sleep: CPU paused, RTC + ULP active → ~0.8mA
- Deep sleep: only RTC + ULP → ~10uA. Wake: timer, touch, ext0/ext1, ULP
- esp_deep_sleep_start() / esp_light_sleep_start()
- ULP coprocessor: runs during deep sleep, 8MHz, can read ADC/I2C/GPIO`,
});


// ─── nRF Skill ────────────────────────────────────────────────────────────────

SKILLS.set('nrf', {
	id: 'nrf',
	name: 'nRF52/nRF53',
	manufacturer: 'Nordic Semiconductor',

	initSequences: {
		'GPIO': `// nRF SDK or Zephyr
// nRF SDK (bare-metal)
NRF_GPIO->PIN_CNF[pin] =
    (GPIO_PIN_CNF_DIR_Output << GPIO_PIN_CNF_DIR_Pos) |
    (GPIO_PIN_CNF_DRIVE_S0S1 << GPIO_PIN_CNF_DRIVE_Pos) |
    (GPIO_PIN_CNF_PULL_Disabled << GPIO_PIN_CNF_PULL_Pos);

NRF_GPIO->OUTSET = (1UL << pin);  // Set high
NRF_GPIO->OUTCLR = (1UL << pin);  // Set low

// Zephyr (preferred)
// In devicetree: &gpioX { status = "okay"; };
const struct device *gpio = DEVICE_DT_GET(DT_NODELABEL(gpio0));
gpio_pin_configure(gpio, pin, GPIO_OUTPUT_ACTIVE);
gpio_pin_set(gpio, pin, 1);`,

		'UARTE': `// nRF UARTE (DMA-based UART)
// Zephyr approach:
const struct device *uart = DEVICE_DT_GET(DT_NODELABEL(uart0));

struct uart_config cfg = {
    .baudrate = 115200,
    .parity = UART_CFG_PARITY_NONE,
    .stop_bits = UART_CFG_STOP_BITS_1,
    .data_bits = UART_CFG_DATA_BITS_8,
    .flow_ctrl = UART_CFG_FLOW_CTRL_NONE,
};
uart_configure(uart, &cfg);

// Async (DMA) API — preferred for nRF
uart_callback_set(uart, uart_callback, NULL);
uart_rx_enable(uart, rx_buf, sizeof(rx_buf), SYS_FOREVER_US);`,

		'BLE': `// Zephyr BLE
bt_enable(NULL);  // Initialize BLE stack

// Advertising
static const struct bt_data ad[] = {
    BT_DATA_BYTES(BT_DATA_FLAGS, BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR),
    BT_DATA_BYTES(BT_DATA_UUID16_ALL, 0x0d, 0x18),  // Heart Rate Service
};
bt_le_adv_start(BT_LE_ADV_CONN_NAME, ad, ARRAY_SIZE(ad), NULL, 0);

// GATT service
BT_GATT_SERVICE_DEFINE(my_svc, ...);`,

		'SAADC': `// nRF SAADC (ADC)
// Zephyr approach:
const struct device *adc = DEVICE_DT_GET(DT_NODELABEL(adc));

struct adc_channel_cfg ch_cfg = {
    .gain = ADC_GAIN_1_6,
    .reference = ADC_REF_INTERNAL,    // 0.6V internal
    .acquisition_time = ADC_ACQ_TIME(ADC_ACQ_TIME_MICROSECONDS, 10),
    .channel_id = 0,
    .input_positive = NRF_SAADC_INPUT_AIN0,
};
adc_channel_setup(adc, &ch_cfg);

int16_t sample;
struct adc_sequence seq = {
    .channels = BIT(0),
    .buffer = &sample,
    .buffer_size = sizeof(sample),
    .resolution = 12,
};
adc_read(adc, &seq);`,
	},

	clockTreeNotes: `nRF Clock:
- HFCLK: 64MHz (nRF52840). Source: HFINT (internal RC) or HFXO (32MHz crystal, doubled)
- LFCLK: 32.768kHz. Source: LFRC (internal RC), LFXO (crystal), or LFSYNTH (from HFCLK)
- BLE REQUIRES HFXO — must be started before BLE operations
- Peripherals run at 16MHz or 32MHz, not the full 64MHz
- NRF_CLOCK->TASKS_HFCLKSTART = 1; // Start HFXO
- Zephyr: clock_control_on() for runtime management`,

	interruptNotes: `nRF Interrupts:
- ARM Cortex-M4 NVIC (nRF52) or Cortex-M33 (nRF53)
- SoftDevice (if used): reserves interrupt priorities 0-2, app uses 3+
- Zephyr: use IRQ_CONNECT() macro, not direct NVIC manipulation
- nRF events/tasks system: EVENTS_xxx, TASKS_xxx registers
- PPI (Programmable Peripheral Interconnect): connect events to tasks without CPU
- EasyDMA: automatic DMA for most peripherals (UARTE, SPIM, TWIM, SAADC)`,

	dmaNotes: `nRF EasyDMA:
- Built into most peripherals — no separate DMA controller
- DMA buffers MUST be in RAM (not Flash/XIP)
- Buffers must be word-aligned (4 bytes)
- MAXCNT register limits transfer size (typically 8-bit or 16-bit field)
- For UARTE: separate RX and TX DMA, configured per transaction
- Double-buffering supported on some peripherals (e.g., SAADC with RESULT.AMOUNT)`,

	pitfalls: [
		'BLE requires HFXO crystal — HFINT not accurate enough for BLE timing',
		'EasyDMA buffers must be in RAM, not Flash (common Zephyr mistake)',
		'SoftDevice hogs interrupt priorities 0-2 — app interrupts must be priority 3+',
		'GPIO port 1 (P1.xx) needs NRF_P1 not NRF_GPIO on nRF52840',
		'UARTE double-buffering: must provide next buffer before current completes',
		'Power-on RAM retention: configure NRF_POWER->RAM[x].POWERSET for deep sleep',
		'Debug pins (SWDIO/SWDCLK) overlap with GPIO — disable debug to reclaim',
	],

	debugConfig: {
		probe: 'J-Link OB (on DK boards) or external J-Link',
		openocdConfig: ['-f', 'interface/jlink.cfg', '-f', 'target/nrf52.cfg'],
		gdbServerCommand: ['JLinkGDBServer', '-device', 'nRF52840_xxAA', '-if', 'SWD'],
		flashCommand: ['nrfjprog', '--program', '*.hex', '--verify', '--reset'],
		resetCommand: 'monitor reset',
	},

	startupNotes: `nRF Boot Sequence:
1. Boot ROM: checks UICR.NRFFW[0] for SoftDevice/bootloader presence
2. SoftDevice (if present): initializes radio and BLE stack
3. Application start: Reset_Handler → SystemInit → main
4. Zephyr: kernel init → device init → main thread starts`,

	lowPowerNotes: `nRF Power:
- System ON: 1.5mA active, 1.9uA idle (all RAM retained)
- System OFF: 0.3uA (wake by GPIO DETECT, NFC, or LPCOMP)
- Zephyr PM subsystem handles sleep automatically between thread yields
- BLE: ~8mA during TX/RX bursts, <5uA average at 1s connection interval
- SAADC: shut down between readings (consumes ~500uA when enabled)`,
});


// ─── RP2040 Skill ─────────────────────────────────────────────────────────────

SKILLS.set('rp2040', {
	id: 'rp2040',
	name: 'RP2040/RP2350',
	manufacturer: 'Raspberry Pi',

	initSequences: {
		'GPIO': `// Pico SDK
#include "pico/stdlib.h"

gpio_init(PIN);
gpio_set_dir(PIN, GPIO_OUT);  // or GPIO_IN
gpio_put(PIN, 1);              // Set high

// With pull-up/down
gpio_init(PIN);
gpio_set_dir(PIN, GPIO_IN);
gpio_pull_up(PIN);             // or gpio_pull_down(PIN)
bool state = gpio_get(PIN);`,

		'UART': `// Pico SDK UART
#include "hardware/uart.h"

uart_init(uart0, 115200);
gpio_set_function(0, GPIO_FUNC_UART);  // TX
gpio_set_function(1, GPIO_FUNC_UART);  // RX

uart_puts(uart0, "Hello\\r\\n");

// Read with timeout
if (uart_is_readable_within_us(uart0, 1000)) {
    char c = uart_getc(uart0);
}`,

		'SPI': `// Pico SDK SPI
#include "hardware/spi.h"

spi_init(spi0, 1000000);  // 1MHz
gpio_set_function(SCK_PIN, GPIO_FUNC_SPI);
gpio_set_function(TX_PIN, GPIO_FUNC_SPI);
gpio_set_function(RX_PIN, GPIO_FUNC_SPI);

// CS as GPIO
gpio_init(CS_PIN);
gpio_set_dir(CS_PIN, GPIO_OUT);
gpio_put(CS_PIN, 1);

// Transfer
gpio_put(CS_PIN, 0);
spi_write_read_blocking(spi0, tx_buf, rx_buf, len);
gpio_put(CS_PIN, 1);`,

		'I2C': `// Pico SDK I2C
#include "hardware/i2c.h"

i2c_init(i2c0, 100000);  // 100kHz
gpio_set_function(SDA_PIN, GPIO_FUNC_I2C);
gpio_set_function(SCL_PIN, GPIO_FUNC_I2C);
gpio_pull_up(SDA_PIN);
gpio_pull_up(SCL_PIN);

// Write
uint8_t data[] = {reg, value};
i2c_write_blocking(i2c0, addr, data, sizeof(data), false);

// Read
i2c_write_blocking(i2c0, addr, &reg, 1, true);  // nostop=true for repeated start
i2c_read_blocking(i2c0, addr, buf, len, false);`,

		'ADC': `// Pico SDK ADC
#include "hardware/adc.h"

adc_init();
adc_gpio_init(26);             // ADC0 = GPIO26, ADC1=27, ADC2=28
adc_select_input(0);           // Channel 0
uint16_t result = adc_read();  // 12-bit result (0-4095)

// Internal temperature sensor
adc_set_temp_sensor_enabled(true);
adc_select_input(4);           // Channel 4 = temp sensor
float temp = 27 - (adc_read() * 3.3f / 4096 - 0.706f) / 0.001721f;`,

		'PIO': `// PIO (Programmable IO) — RP2040's killer feature
#include "hardware/pio.h"

// Load PIO program
PIO pio = pio0;
uint offset = pio_add_program(pio, &my_program);
uint sm = pio_claim_unused_sm(pio, true);

// Configure state machine
pio_sm_config c = my_program_get_default_config(offset);
sm_config_set_out_pins(&c, pin, 1);
pio_gpio_init(pio, pin);
pio_sm_set_consecutive_pindirs(pio, sm, pin, 1, true);
pio_sm_init(pio, sm, offset, &c);
pio_sm_set_enabled(pio, sm, true);

// PIO assembly example (.pio file):
// .program blink
// .wrap_target
//     set pins, 1    [31]
//     nop            [31]
//     set pins, 0    [31]
//     nop            [31]
// .wrap`,

		'DMA': `// Pico SDK DMA
#include "hardware/dma.h"

int chan = dma_claim_unused_channel(true);

dma_channel_config c = dma_channel_get_default_config(chan);
channel_config_set_transfer_data_size(&c, DMA_SIZE_8);
channel_config_set_read_increment(&c, true);
channel_config_set_write_increment(&c, false);
channel_config_set_dreq(&c, DREQ_UART0_TX);  // Paced by UART TX

dma_channel_configure(chan, &c,
    &uart_get_hw(uart0)->dr,  // Write address
    buffer,                    // Read address
    length,                    // Transfer count
    true                       // Start immediately
);

dma_channel_wait_for_finish_blocking(chan);`,
	},

	clockTreeNotes: `RP2040 Clock:
- XOSC: 12MHz crystal (standard on Pico boards)
- System PLL: 125MHz default (12MHz * 125 / 6 / 2)
- USB PLL: 48MHz (required for USB)
- System clock: SYS_CLK can be sourced from ROSC, XOSC, or PLL
- Peripheral clock: CLK_PERI, typically same as SYS_CLK
- ADC clock: 48MHz from USB PLL
- RTC clock: derived from XOSC (46875 Hz with default divider)
- ROSC: 1-12MHz ring oscillator (imprecise, for initial boot)
- clock_configure() to change clocks at runtime`,

	interruptNotes: `RP2040 Interrupts:
- Dual Cortex-M0+ → each core has its own NVIC
- irq_set_exclusive_handler(IRQ, handler) — one handler per IRQ
- irq_set_enabled(IRQ, true)
- GPIO interrupts: gpio_set_irq_enabled_with_callback(pin, events, true, callback)
- Core-to-core: multicore_fifo_push_blocking() → SIO_IRQ_PROCx interrupt
- PIO: irq_set_exclusive_handler(PIO0_IRQ_0, handler)`,

	dmaNotes: `RP2040 DMA:
- 12 DMA channels, each independently configurable
- DREQ pacing: DMA waits for peripheral to be ready before each transfer
- Chain transfers: one DMA channel triggers another on completion
- Ring buffer: address wrapping for circular buffers
- Sniff: CRC calculation during DMA transfer (CRC-32, CRC-32C, etc.)
- Transfer size: 8, 16, or 32 bits per element`,

	pitfalls: [
		'No internal flash — boot from external QSPI flash via XIP (execute-in-place)',
		'Multicore: shared peripherals need mutex (spin_lock_t) to avoid corruption',
		'PIO programs limited to 32 instructions per PIO block — optimize carefully',
		'USB CDC (stdio over USB): must wait for connection, adds ~1s startup delay',
		'ADC: only 3 external channels (GPIO26-28) + 1 internal temp sensor',
		'No hardware floating point — use integer math for performance-critical paths',
		'Overclocking beyond 133MHz: increase flash wait states and voltage',
		'BOOTSEL button: hold during reset to enter USB mass storage bootloader',
	],

	debugConfig: {
		probe: 'Picoprobe (another Pico) or Raspberry Pi Debug Probe',
		openocdConfig: ['-f', 'interface/cmsis-dap.cfg', '-f', 'target/rp2040.cfg'],
		gdbServerCommand: ['openocd', '-f', 'interface/cmsis-dap.cfg', '-f', 'target/rp2040.cfg'],
		flashCommand: ['openocd', '-f', 'interface/cmsis-dap.cfg', '-f', 'target/rp2040.cfg',
			'-c', 'program build/*.elf verify reset exit'],
		resetCommand: 'monitor reset init',
	},

	startupNotes: `RP2040 Boot Sequence:
1. ROM bootloader: checks SPI flash for valid boot2 stage
2. boot2: configures QSPI interface for XIP (execute-in-place)
3. Application entry: vector table in flash, SP and Reset_Handler loaded
4. runtime_init: configures clocks (XOSC→PLL→125MHz), sets up C runtime
5. main() called on core 0
6. Core 1: parked in WFE loop, wake with multicore_launch_core1()`,

	lowPowerNotes: `RP2040 Power:
- Active: ~24mA (both cores + peripherals)
- Sleep (WFI): ~12mA (one core sleeping)
- Dormant (XOSC stopped): ~0.8mA (wake by GPIO or RTC)
- DORMANT mode: call xosc_dormant() or rosc_dormant()
- No true deep sleep — lowest power requires external power management IC
- Turn off unused peripherals: set WAKE_EN bits in CLOCKS block`,
});
