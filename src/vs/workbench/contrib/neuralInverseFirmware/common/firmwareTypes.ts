/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # NeuralInverse Firmware — Core Types
 *
 * Central type definitions for the firmware development environment.
 * These types flow through session management, hardware context injection,
 * datasheet intelligence, SVD parsing, and firmware agent tools.
 *
 * ## Design Principles
 *
 * - **Hardware-first**: Every session carries MCU specs, register maps, and timing constraints.
 * - **BYOLLM-powered**: Datasheet extraction uses the user's chosen LLM — no vendor lock.
 * - **Compliance-aware**: MISRA, CERT C, IEC 62304, ISO 26262, DO-178C enforced at the session level.
 */


// ─── MCU Configuration ───────────────────────────────────────────────────────

/** Supported MCU core architectures. */
export type MCUCoreType =
	| 'cortex-m0' | 'cortex-m0+' | 'cortex-m3' | 'cortex-m4' | 'cortex-m7'
	| 'cortex-m23' | 'cortex-m33' | 'cortex-m55' | 'cortex-m85'
	| 'cortex-a' | 'cortex-r'
	| 'risc-v'
	| 'xtensa'      // ESP32 (Xtensa LX6/LX7)
	| 'c28x' | 'mips32'        // TI C2000 real-time DSP
	| 'tricore'     // Infineon AURIX TriCore
	| 'arm7'        // Classic ARM7TDMI
	| 'powerpc'     // Power Architecture (e.g. MPC5xxx)
	| 'rx'          // Renesas RX core
	| '8051'
	| 'avr'
	| 'pic'
	| 'msp430'
	| 'other';

/** Supported firmware compliance frameworks. */
export type FirmwareComplianceFramework =
	| 'misra-c-2012'
	| 'misra-c-2023'
	| 'cert-c'
	| 'iec-62304'    // Medical device software
	| 'iso-26262'    // Automotive functional safety
	| 'do-178c'      // Airborne software
	| 'iec-61508'    // Industrial functional safety
	| 'autosar';

/** Memory region in the MCU memory map. */
export interface IMemoryRegion {
	/** Region name, e.g. "FLASH", "SRAM", "CCM", "ITCM" */
	name: string;
	/** Base address (hex string for display, number for computation) */
	baseAddress: number;
	/** Size in bytes */
	size: number;
	/** Access type */
	access: 'read-only' | 'read-write' | 'execute-only';
}

/** MCU hardware configuration for the active firmware session. */
export interface IMCUConfig {
	/** MCU family, e.g. "STM32F4", "nRF52", "ESP32", "RP2040" */
	family: string;
	/** Specific variant, e.g. "STM32F407VGT6", "nRF52840" */
	variant: string;
	/** Manufacturer, e.g. "STMicroelectronics", "Nordic", "Espressif" */
	manufacturer: string;
	/** Core architecture */
	core: MCUCoreType;
	/** Max clock speed in MHz */
	clockMHz: number;
	/** Flash size in bytes */
	flashSize: number;
	/** RAM size in bytes */
	ramSize: number;
	/** Memory map regions */
	memoryMap: IMemoryRegion[];
	/** Number of GPIO pins */
	gpioCount?: number;
	/** Available peripherals (names only — details come from SVD/datasheet) */
	peripherals: string[];
	/** FPU capability */
	fpu: 'none' | 'single' | 'double';
	/** Has MPU (Memory Protection Unit) */
	hasMPU: boolean;
	/** Has DSP instructions */
	hasDSP: boolean;
}


// ─── Register Map Types ──────────────────────────────────────────────────────

/** Access type for a register or bit field. */
export type RegisterAccess = 'read-only' | 'write-only' | 'read-write' | 'write-once' | 'read-write-once';

/** A single bit field within a register. */
export interface IBitField {
	/** Field name, e.g. "EN", "TXIE", "BAUD_DIV" */
	name: string;
	/** Bit offset from LSB */
	bitOffset: number;
	/** Width in bits */
	bitWidth: number;
	/** Access type */
	access: RegisterAccess;
	/** Human-readable description */
	description: string;
	/** Reset value for this field */
	resetValue?: number;
	/** Enumerated values, e.g. { 0: "Disabled", 1: "Enabled" } */
	enumeratedValues?: Record<number, string>;
}

/** A single register within a peripheral. */
export interface IRegister {
	/** Register name, e.g. "CR1", "SR", "DR" */
	name: string;
	/** Offset from peripheral base address */
	addressOffset: number;
	/** Size in bits (usually 8, 16, or 32) */
	size: number;
	/** Access type */
	access: RegisterAccess;
	/** Reset value */
	resetValue: number;
	/** Human-readable description */
	description: string;
	/** Bit fields within this register */
	fields: IBitField[];
}

/** A peripheral register map (e.g. USART, SPI, GPIO). */
export interface IPeripheralRegisterMap {
	/** Peripheral name, e.g. "USART1", "SPI2", "GPIOA" */
	name: string;
	/** Group name (peripheral type), e.g. "USART", "SPI", "GPIO" */
	groupName: string;
	/** Base address */
	baseAddress: number;
	/** Human-readable description */
	description: string;
	/** All registers in this peripheral */
	registers: IRegister[];
	/** Interrupt names associated with this peripheral */
	interrupts: Array<{ name: string; value: number; description: string }>;
}


// ─── Datasheet Types ─────────────────────────────────────────────────────────

/** Metadata about a parsed datasheet. */
export interface IDatasheetInfo {
	/** Unique ID for this datasheet within the session */
	id: string;
	/** Original filename */
	fileName: string;
	/** Document title (extracted from cover page) */
	title: string;
	/** MCU family this datasheet covers */
	mcuFamily: string;
	/** Part numbers covered by this datasheet */
	partNumbers: string[];
	/** Total page count */
	pageCount: number;
	/** When the datasheet was parsed */
	parsedAt: number;
	/** Number of peripherals extracted */
	peripheralCount: number;
	/** Number of registers extracted */
	registerCount: number;
	/** Number of errata entries extracted */
	errataCount: number;
}

/** A timing constraint extracted from a datasheet. */
export interface ITimingConstraint {
	/** Peripheral this constraint applies to */
	peripheral: string;
	/** Constraint name, e.g. "setup_time", "hold_time", "propagation_delay" */
	name: string;
	/** Minimum value (if applicable) */
	minValue?: number;
	/** Typical value */
	typValue?: number;
	/** Maximum value (if applicable) */
	maxValue?: number;
	/** Unit, e.g. "ns", "μs", "ms", "MHz" */
	unit: string;
	/** Conditions under which this constraint applies */
	conditions?: string;
	/** Datasheet page reference */
	datasheetPage?: number;
}

/** A silicon errata entry. */
export interface IErrata {
	/** Errata ID, e.g. "ES_STM32F407_23" */
	id: string;
	/** Title / summary */
	title: string;
	/** Affected peripheral or subsystem */
	affectedPeripheral: string;
	/** Full description of the bug */
	description: string;
	/** Known workaround (if any) */
	workaround?: string;
	/** Severity assessment */
	severity: 'info' | 'minor' | 'major' | 'critical';
	/** Affected silicon revisions */
	affectedRevisions: string[];
	/** Whether this has been fixed in a later revision */
	fixedInRevision?: string;
	/** Datasheet/errata document page reference */
	documentPage?: number;
}


// ─── Firmware Session ────────────────────────────────────────────────────────

/** The main firmware session state. */
export interface IFirmwareSessionData {
	/** Whether a firmware session is currently active */
	isActive: boolean;
	/** Unique session ID */
	sessionId?: string;
	/** MCU configuration */
	mcuConfig?: IMCUConfig;
	/** Board name (e.g. "NUCLEO-F446RE", "nRF52840-DK", "custom") */
	boardName?: string;
	/** Workspace folder URI for the firmware project */
	projectUri?: string;
	/** Loaded SVD file paths */
	svdFiles: string[];
	/** Parsed datasheet metadata */
	datasheets: IDatasheetInfo[];
	/** Active compliance frameworks for this session */
	complianceFrameworks: FirmwareComplianceFramework[];
	/** Parsed peripheral register maps (from SVD + datasheets) */
	registerMaps: IPeripheralRegisterMap[];
	/** Timing constraints extracted from datasheets */
	timingConstraints: ITimingConstraint[];
	/** Silicon errata entries */
	errata: IErrata[];
	/** Currently focused peripheral (for context injection) */
	activePeripheral?: string;
	/** RTOS in use, if any */
	rtos?: string;
	/** Build system, e.g. "cmake", "make", "platformio", "stm32cubeide" */
	buildSystem?: string;
	/** Detected project info (populated by project auto-detector) */
	projectInfo?: IFirmwareProjectInfo;

	// ── Session Lifecycle ──

	/** When the session was first started (epoch ms) */
	sessionStartedAt?: number;
	/** Last activity timestamp — updated on any state change (epoch ms) */
	lastActivityAt?: number;
	/** Last serial port configuration used */
	lastSerialConfig?: ISerialPortConfig;
	/** Whether serial was connected when session was last saved */
	serialWasConnected?: boolean;
	/** Last build result (persisted across restarts) */
	lastBuildResult?: IBuildResult;
	/** Platform skill ID for platform-specific knowledge (e.g. 'stm32', 'esp32') */
	platformId?: string;
	/** Debug session state */
	debugState?: IDebugSessionState;
}

/** Debug session state tracked on the firmware session. */
export interface IDebugSessionState {
	/** Whether a GDB session is active */
	isActive: boolean;
	/** GDB server tool in use */
	gdbServer?: 'openocd' | 'jlink-gdbserver' | 'pyocd' | 'st-util' | 'qemu';
	/** GDB server port */
	gdbPort?: number;
	/** Target device for the GDB server */
	targetDevice?: string;
	/** Last GDB command issued */
	lastCommand?: string;
	/** Last GDB response */
	lastResponse?: string;
}

/** Default empty session. */
export const DEFAULT_FIRMWARE_SESSION: IFirmwareSessionData = {
	isActive: false,
	svdFiles: [],
	datasheets: [],
	complianceFrameworks: [],
	registerMaps: [],
	timingConstraints: [],
	errata: [],
};


// ─── Citation Types ──────────────────────────────────────────────────────────

/** Inline citation linking extracted data back to a source document page. */
export interface ICitation {
	/** Datasheet ID this citation references */
	datasheetId: string;
	/** Page number within the datasheet (1-indexed) */
	pageNumber: number;
	/** Section title, e.g. "16.5 DMA Configuration" */
	sectionTitle: string;
	/** Extraction confidence (0.0–1.0) */
	confidence: number;
	/** Exact text snippet from the source */
	sourceSnippet?: string;
}

/** A register with citation to its source datasheet. */
export interface ICitedRegister extends IRegister {
	/** Where this register was defined */
	citation?: ICitation;
}

/** A timing constraint with citation. */
export interface ICitedTimingConstraint extends ITimingConstraint {
	/** Citation to source page */
	citation?: ICitation;
}

/** An errata entry with citation. */
export interface ICitedErrata extends IErrata {
	/** Citation to source page */
	citation?: ICitation;
}


// ─── Firmware.inverse Project File ──────────────────────────────────────────

/** Filename at the workspace root that triggers guaranteed firmware session activation. */
export const FIRMWARE_INVERSE_FILENAME = 'Firmware.inverse';

/**
 * Schema for `Firmware.inverse` — the Neural Inverse firmware project manifest.
 *
 * Drop this file in any project root and Neural Inverse will:
 *  1. Detect the project immediately with confidence = 1.0
 *  2. Auto-start the firmware session with the specified MCU
 *  3. Load SVD files and datasheet PDFs listed in the manifest
 *  4. Inject full hardware context into Power Mode and sidebar chat
 *
 * Example:
 * ```json
 * {
 *   "neuralInverseFirmware": true,
 *   "version": "1",
 *   "mcu": "STM32F407VGT6",
 *   "board": "STM32F4DISCOVERY",
 *   "rtos": "FreeRTOS",
 *   "buildSystem": "cmake",
 *   "hal": "stm32-hal",
 *   "compliance": ["misra-c-2012"],
 *   "datasheets": ["docs/stm32f407_rm.pdf"],
 *   "svd": "docs/STM32F407.svd",
 *   "createdAt": 1742300000000
 * }
 * ```
 */
export interface IFirmwareInverseFile {
	/** Discriminator — must be `true`. */
	readonly neuralInverseFirmware: true;
	/** File format version. */
	readonly version: '1';
	/** MCU variant (exact database key, e.g. "STM32F407VGT6"). */
	readonly mcu: string;
	/** Board name (displayed in status bar and session info). */
	readonly board?: string;
	/** RTOS in use (e.g. "FreeRTOS", "Zephyr", "Embassy"). */
	readonly rtos?: string;
	/** Build system (e.g. "cmake", "platformio", "esp-idf", "make"). */
	readonly buildSystem?: string;
	/** HAL / framework in use (e.g. "stm32-hal", "esp-idf", "arduino"). */
	readonly hal?: string;
	/** Compliance frameworks to enforce (e.g. ["misra-c-2012"]). */
	readonly compliance?: FirmwareComplianceFramework[];
	/** Relative paths to PDF datasheets to auto-load on session start. */
	readonly datasheets?: string[];
	/** Relative path to primary SVD file (overrides bundled SVD lookup). */
	readonly svd?: string;
	/** Timestamp when the file was created. */
	readonly createdAt: number;
}


// ─── Project Detection Types ─────────────────────────────────────────────────

/** Firmware project type indicator. */
export type FirmwareProjectType =
	| 'firmware-inverse' // Firmware.inverse manifest present — highest confidence
	| 'stm32cubeide'
	| 'stm32cubemx'
	| 'platformio'
	| 'esp-idf'
	| 'zephyr'
	| 'cmake-embedded'
	| 'make-embedded'
	| 'rust-embedded'
	| 'arduino'
	| 'mbed'
	| 'generic';

/** Result of scanning a workspace for firmware project indicators. */
export interface IFirmwareProjectInfo {
	/** Detected project type */
	projectType: FirmwareProjectType;
	/** MCU family detected from project files */
	mcuFamily?: string;
	/** MCU variant detected from project files */
	mcuVariant?: string;
	/** Board name detected from project files */
	boardName?: string;
	/** RTOS detected from project files */
	rtos?: string;
	/** Build system in use */
	buildSystem?: string;
	/** Framework in use */
	framework?: string;
	/** Hardware abstraction layer, e.g. "stm32-hal", "esp-hal", "zephyr-api" */
	hal?: string;
	/** Project root URI */
	projectRoot: string;
	/** Specific config files found */
	configFiles: IDetectedConfigFile[];
	/** SVD files found in project tree */
	svdFilePaths: string[];
	/** PDF datasheet paths to auto-load (from Firmware.inverse manifest) */
	datasheetPaths?: string[];
	/** Compliance frameworks declared in Firmware.inverse */
	complianceFrameworks?: FirmwareComplianceFramework[];
	/** Confidence that this is a firmware project (0.0–1.0) */
	confidence: number;
}

/** A config file detected during project scanning. */
export interface IDetectedConfigFile {
	/** Relative path from workspace root */
	path: string;
	/** Type of config file */
	type: 'Firmware.inverse' | 'platformio.ini' | 'CMakeLists.txt' | '.ioc' | 'Makefile' | 'Cargo.toml'
	    | 'prj.conf' | 'sdkconfig' | 'board.json' | '.cproject' | 'mbed_app.json'
	    | 'arduino.ino' | 'other';
	/** Data extracted from this file */
	extractedData: Record<string, string>;
}


// ─── MCU Database Entry Types ────────────────────────────────────────────────

/** A pre-indexed MCU entry in the built-in database. */
export interface IMCUDatabaseEntry {
	/** Full part number, e.g. "STM32F407VGT6" */
	variant: string;
	/** MCU family, e.g. "STM32F4" */
	family: string;
	/** Sub-family for grouping, e.g. "STM32F407" */
	subfamily: string;
	/** Manufacturer */
	manufacturer: string;
	/** Core type */
	core: MCUCoreType;
	/** Max clock speed in MHz */
	clockMHz: number;
	/** Flash size in bytes */
	flashSize: number;
	/** RAM size in bytes */
	ramSize: number;
	/** FPU capability */
	fpu: 'none' | 'single' | 'double';
	/** Has MPU */
	hasMPU: boolean;
	/** Has DSP */
	hasDSP: boolean;
	/** GPIO pin count */
	gpioCount: number;
	/** Available peripherals */
	peripherals: string[];
	/** Memory map regions */
	memoryMap: IMemoryRegion[];
	/** Package type, e.g. "LQFP100", "QFN48" */
	package?: string;
	/** Operating voltage range */
	voltageRange?: string;
	/** Operating temperature range */
	temperatureRange?: string;
	/** URL to download the SVD file (CMSIS pack) */
	svdUrl?: string;
	/** URL to the official datasheet PDF */
	datasheetUrl?: string;
	/** Common board names that use this MCU */
	commonBoards: string[];
	/** Search keywords: aliases, common names, board names */
	searchKeywords: string[];
}


// ─── Code Generation Types ───────────────────────────────────────────────────

/** Type of generated firmware code. */
export type FirmwareCodegenTarget =
	| 'peripheral-init'
	| 'isr-handler'
	| 'dma-config'
	| 'clock-config'
	| 'gpio-config'
	| 'linker-script'
	| 'startup-code'
	| 'rtos-task';

/** Options for firmware code generation. */
export interface ICodegenOptions {
	/** Target to generate */
	target: FirmwareCodegenTarget;
	/** Peripheral name (for peripheral-specific targets) */
	peripheral?: string;
	/** Language: C or C++ or Rust */
	language: 'c' | 'cpp' | 'rust';
	/** Include inline citations to datasheet pages */
	includeCitations: boolean;
	/** Enforce MISRA C compliance */
	misraCompliant: boolean;
	/** Use HAL macros or direct register access */
	useHAL: boolean;
	/** Additional context from the user */
	userContext?: string;
}

/** Result of firmware code generation. */
export interface ICodegenResult {
	/** Generated code */
	code: string;
	/** Language of the generated code */
	language: 'c' | 'cpp' | 'rust';
	/** Citations used in the generated code */
	citations: ICitation[];
	/** Warnings or notes about the generated code */
	warnings: string[];
	/** MISRA violations detected in generated code (if MISRA mode active) */
	misraViolations: string[];
}


// ─── Datasheet Extraction Types ──────────────────────────────────────────────

/** Classification of a page within a PDF datasheet. */
export type DatasheetPageType =
	| 'cover'
	| 'table-of-contents'
	| 'features-overview'
	| 'pinout'
	| 'memory-map'
	| 'register-description'
	| 'timing-table'
	| 'electrical-characteristics'
	| 'errata'
	| 'ordering-info'
	| 'mechanical'
	| 'other';

/** A single page extracted from a PDF datasheet. */
export interface IExtractedPage {
	/** Page number (1-indexed) */
	pageNumber: number;
	/** Raw extracted text content */
	text: string;
	/** Classified page type */
	pageType: DatasheetPageType;
	/** Section title detected on this page */
	sectionTitle?: string;
	/** Whether this page has been processed by the LLM extractor */
	processed: boolean;
	/** Peripherals referenced on this page */
	peripheralReferences: string[];
}

/** Status of the datasheet extraction pipeline. */
export type ExtractionStatus =
	| 'pending'
	| 'reading-pdf'
	| 'checking-cache'
	| 'classifying-pages'
	| 'extracting-text'
	| 'extracting-registers'
	| 'extracting-timing'
	| 'extracting-errata'
	| 'saving-to-kb'
	| 'complete'
	| 'error';

/** Progress information for datasheet extraction. */
export interface IExtractionProgress {
	/** Current extraction status */
	status: ExtractionStatus;
	/** Total pages in the document */
	totalPages: number;
	/** Pages processed so far */
	processedPages: number;
	/** Number of registers extracted so far */
	registersExtracted: number;
	/** Number of timing values extracted so far */
	timingValuesExtracted: number;
	/** Number of errata entries extracted so far */
	errataExtracted: number;
	/** Error message (if status is 'error') */
	errorMessage?: string;
}


// ─── Serial Monitor Types ────────────────────────────────────────────────────

/** Serial port configuration. */
export interface ISerialPortConfig {
	/** Port path, e.g. "/dev/ttyUSB0", "COM3" */
	port: string;
	/** Baud rate */
	baudRate: number;
	/** Data bits: 5, 6, 7, or 8 */
	dataBits: 5 | 6 | 7 | 8;
	/** Stop bits: 1 or 2 */
	stopBits: 1 | 2;
	/** Parity */
	parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
	/** Flow control */
	flowControl: 'none' | 'hardware' | 'software';
}

/** A serial port discovered on the system. */
export interface ISerialPortInfo {
	/** Port path */
	path: string;
	/** Manufacturer name */
	manufacturer?: string;
	/** Product name */
	productId?: string;
	/** Vendor ID */
	vendorId?: string;
	/** Serial number */
	serialNumber?: string;
	/** Whether this might be a debug probe (ST-Link, J-Link, etc.) */
	isDebugProbe: boolean;
}

/** A line of serial monitor output. */
export interface ISerialLine {
	/** Timestamp (ms since epoch) */
	timestamp: number;
	/** Text content */
	text: string;
	/** Direction */
	direction: 'rx' | 'tx';
}

/** Standard baud rates for firmware development. */
export const COMMON_BAUD_RATES = [
	300, 1200, 2400, 4800, 9600, 14400, 19200, 28800,
	38400, 57600, 76800, 115200, 230400, 460800, 921600,
	1000000, 2000000, 3000000,
] as const;


// ─── Build System Types ──────────────────────────────────────────────────────

/** Build result from a firmware compile. */
export interface IBuildResult {
	/** Whether the build succeeded */
	success: boolean;
	/** Build duration in ms */
	durationMs: number;
	/** Output binary path */
	outputPath?: string;
	/** Binary size in bytes */
	binarySize?: number;
	/** Flash usage percentage */
	flashUsagePercent?: number;
	/** RAM usage percentage */
	ramUsagePercent?: number;
	/** Errors from the build */
	errors: IBuildDiagnostic[];
	/** Warnings from the build */
	warnings: IBuildDiagnostic[];
}

/** A build diagnostic (error or warning). */
export interface IBuildDiagnostic {
	/** File path */
	file: string;
	/** Line number */
	line: number;
	/** Column number */
	column?: number;
	/** Severity */
	severity: 'error' | 'warning' | 'note';
	/** Diagnostic message */
	message: string;
	/** Compiler diagnostic code (e.g. "-Werror=unused-variable") */
	code?: string;
}

/** Flash programming configuration. */
export interface IFlashConfig {
	/** Flash tool to use */
	tool: 'openocd' | 'stm32-programmer-cli' | 'esptool' | 'nrfjprog' | 'jlink' | 'pyocd' | 'dfu-util';
	/** Interface type */
	interface?: 'swd' | 'jtag' | 'uart' | 'usb' | 'dfu';
	/** Target MCU for the flash tool */
	target?: string;
	/** Extra arguments */
	extraArgs?: string[];
}
