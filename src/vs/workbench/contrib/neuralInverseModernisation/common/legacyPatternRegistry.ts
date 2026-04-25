/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Firmware & Industrial Pattern Registry
 *
 * Known patterns for safety-critical and regulated attributes in firmware and
 * industrial source languages. Used by the deterministic fingerprint extractor
 * (Layer 1) to identify safety-regulated code without relying on the LLM.
 *
 * ## Coverage
 *
 * - **Embedded C (bare-metal)**: Memory-mapped peripheral access, ISR declarations,
 *   HAL API calls, watchdog patterns, MISRA-C structural violations.
 * - **C++ (MISRA / AUTOSAR)**: RTOS API calls, dynamic allocation, `volatile` patterns.
 * - **IEC 61131-3 (Ladder / Structured Text)**: Function block calls, safety FBs,
 *   timer/counter instances, coil/contact patterns.
 * - **MISRA-C violation patterns**: Structural patterns detecting mandatory rule violations.
 *
 * ## Safety Framework Keys
 *
 * - `iec-61508`   \u2014 IEC 61508 Functional Safety (SIL 1\u20134)
 * - `iec-62443`   \u2014 IEC 62443 Industrial Cybersecurity
 * - `misra-c`     \u2014 MISRA C:2012 (language subset for safety-critical C)
 * - `autosar`     \u2014 AUTOSAR Classic / Adaptive Platform
 * - `iso-26262`   \u2014 ISO 26262 Automotive Functional Safety (ASIL A\u2013D)
 * - `iec-61131`   \u2014 IEC 61131-3 PLC Programming Standards
 */

export interface IRegulatedFieldPattern {
	/** Regex pattern matched against the field / variable name (case-insensitive) */
	namePattern: RegExp;
	/** The normalized semantic attribute this pattern represents */
	regulatedAttribute: string;
	/** The safety / compliance framework that classifies this as regulated */
	framework: string;
	/** Human-readable description for the compliance strip UI */
	description: string;
}

export interface IStructuralPattern {
	/** Regex matched against the source line (case-insensitive) */
	linePattern: RegExp;
	/** What this structural pattern indicates */
	indicates: string;
	/** Whether code containing this pattern is always treated as safety-regulated */
	alwaysRegulated: boolean;
}

export interface ILanguagePatterns {
	fieldPatterns: IRegulatedFieldPattern[];
	structuralPatterns: IStructuralPattern[];
	/** Function / paragraph / FB name patterns that indicate regulated logic */
	paragraphPatterns: RegExp[];
}


// \u2500\u2500\u2500 Embedded C (bare-metal) Patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const EMBEDDED_C_FIELD_PATTERNS: IRegulatedFieldPattern[] = [
	// Memory-mapped peripheral registers
	{ namePattern: /\b(.*_REG|.*_CTRL|.*_STATUS|.*_FLAG|.*_CR[0-9]?|.*_DR|.*_SR)\b/i,   regulatedAttribute: 'peripheral_register', framework: 'iec-61508', description: 'Memory-mapped peripheral register' },
	{ namePattern: /\b(GPIO_PIN|GPIO_PORT|GPIO_MODE)\b/i,                                  regulatedAttribute: 'gpio_control',        framework: 'iec-61508', description: 'GPIO control register or pin definition' },
	{ namePattern: /\b(USART|UART|SPI|I2C|CAN|USB|ADC|DAC|DMA).*_(BASE|CR|DR|SR|ISR|ICR|CCR|BRR)\b/i, regulatedAttribute: 'peripheral_config', framework: 'iec-61508', description: 'Peripheral configuration register' },
	{ namePattern: /\b(.*_IRQ|.*_IRQn|.*_IRQHandler)\b/i,                                   regulatedAttribute: 'interrupt_vector',    framework: 'iec-61508', description: 'Interrupt vector or IRQ number' },
	// Safety-critical signal names
	{ namePattern: /\b(safety|safe_|SIL|sil_|critical|CRITICAL|emergency|EMERGENCY|fail_safe|failsafe|FAILSAFE)\w*/i, regulatedAttribute: 'safety_signal', framework: 'iec-61508', description: 'Safety-critical signal or flag' },
	{ namePattern: /\b(watchdog|wdt|WDT|iwdg|IWDG|wwdg|WWDG)\w*/i,                         regulatedAttribute: 'watchdog_timer',      framework: 'iec-61508', description: 'Watchdog timer reference' },
	{ namePattern: /\b(fault|FAULT|error_code|ERROR_CODE|error_flag|ERROR_FLAG)\w*/i,        regulatedAttribute: 'fault_state',         framework: 'iec-61508', description: 'Fault or error state variable' },
	// PLC / fieldbus identifiers
	{ namePattern: /\b(IO_|io_|INPUT_|OUTPUT_|DI_|DO_|AI_|AO_)\w+/i,                        regulatedAttribute: 'io_point',            framework: 'iec-61131', description: 'PLC I/O point reference' },
	{ namePattern: /\b(modbus_|Modbus|MODBUS)\w*/i,                                          regulatedAttribute: 'modbus_register',     framework: 'iec-62443', description: 'Modbus register or coil reference' },
	{ namePattern: /\b(opc_|OPC_|opcua_|OPCUA_)\w*/i,                                       regulatedAttribute: 'opcua_node',          framework: 'iec-62443', description: 'OPC-UA node reference' },
	// Cybersecurity (IEC 62443)
	{ namePattern: /\b(auth_key|AUTH_KEY|crypto_key|CRYPTO_KEY|secret|SECRET|password|PASSWORD|token|TOKEN)\w*/i, regulatedAttribute: 'credential', framework: 'iec-62443', description: 'Authentication or cryptographic credential' },
];

const EMBEDDED_C_STRUCTURAL_PATTERNS: IStructuralPattern[] = [
	// Memory-mapped I/O via raw pointer (MISRA-C Rule 11.4 violation)
	{
		linePattern: /\(\s*(volatile\s+)?(uint8_t|uint16_t|uint32_t|uint64_t)\s*\*\s*\)\s*0x[0-9A-Fa-f]+/,
		indicates: 'memory_mapped_io_raw_cast',
		alwaysRegulated: true,
	},
	// ISR declaration
	{
		linePattern: /\b(void\s+\w+_IRQHandler\s*\(void\)|__interrupt\s+void|ISR\s*\(|INTERRUPT\s+)/,
		indicates: 'interrupt_service_routine',
		alwaysRegulated: true,
	},
	// Watchdog refresh / kick
	{
		linePattern: /\b(HAL_IWDG_Refresh|HAL_WWDG_Refresh|IWDG_ReloadCounter|WDT_Feed|WDT_Kick|__WFI|wdt_clear)\s*\(/,
		indicates: 'watchdog_refresh',
		alwaysRegulated: true,
	},
	// Critical section / interrupt disable
	{
		linePattern: /\b(__disable_irq|__enable_irq|taskENTER_CRITICAL|taskEXIT_CRITICAL|portDISABLE_INTERRUPTS|portENABLE_INTERRUPTS|NVIC_DisableIRQ|NVIC_EnableIRQ)\s*\(/,
		indicates: 'critical_section_boundary',
		alwaysRegulated: true,
	},
	// RTOS task creation / semaphore
	{
		linePattern: /\b(xTaskCreate|xTaskCreateStatic|osThreadNew|k_thread_create|TaskCreate)\s*\(/,
		indicates: 'rtos_task_creation',
		alwaysRegulated: false,
	},
	// HAL peripheral init
	{
		linePattern: /\bHAL_[A-Z]+_Init\s*\(/,
		indicates: 'hal_peripheral_init',
		alwaysRegulated: false,
	},
	// Assert / error handler call (safety boundary)
	{
		linePattern: /\b(assert_param|configASSERT|Error_Handler|ASSERT|HAL_ERROR)\s*\(/,
		indicates: 'safety_assertion_or_error_handler',
		alwaysRegulated: true,
	},
];

/** Function name patterns that indicate safety-regulated embedded logic */
const EMBEDDED_C_FUNCTION_PATTERNS: RegExp[] = [
	/\b(HAL_|BSP_|MX_)\w+_Init/i,
	/\b\w*_IRQHandler$/i,
	/\bvTask\w+/i,
	/\b(safety|fail|fault|watchdog|wdt)\w*/i,
	/\b(Emergency|Safe|SIL|Critical)\w*/i,
];


// \u2500\u2500\u2500 C++ / MISRA-C++ / AUTOSAR Patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const CPP_EMBEDDED_FIELD_PATTERNS: IRegulatedFieldPattern[] = [
	{ namePattern: /\b(m_safety|m_fault|m_error|m_watchdog)\w*/i,    regulatedAttribute: 'safety_member',        framework: 'misra-c', description: 'Safety-critical class member' },
	{ namePattern: /\b(mReg|mCtrl|mStatus|m_reg|m_ctrl)\w*/i,        regulatedAttribute: 'register_member',      framework: 'iec-61508', description: 'Register-mapped class member' },
	{ namePattern: /\b(m_mutex|m_semaphore|m_lock|m_critical)\w*/i,   regulatedAttribute: 'rtos_sync_primitive',  framework: 'misra-c', description: 'RTOS synchronisation primitive member' },
];

const CPP_EMBEDDED_STRUCTURAL_PATTERNS: IStructuralPattern[] = [
	// Dynamic allocation \u2014 MISRA-C++ Rule 18-4-1 / AUTOSAR A18-5-1 violation
	{
		linePattern: /\bnew\s+\w|\bdelete\b|\bstd::make_unique|\bstd::make_shared|\bmalloc\s*\(|\bfree\s*\(/,
		indicates: 'dynamic_memory_allocation',
		alwaysRegulated: true,
	},
	// Exceptions \u2014 MISRA-C++ Rule 15-0-1 / AUTOSAR A15-0-1
	{
		linePattern: /\btry\s*\{|\bcatch\s*\(|\bthrow\s+/,
		indicates: 'exception_usage',
		alwaysRegulated: true,
	},
	// RTOS call in C++
	{
		linePattern: /\b(osThreadNew|xTaskCreate|osMutexAcquire|osSemaphoreAcquire|xQueueSend|xQueueReceive)\s*\(/,
		indicates: 'rtos_api_call',
		alwaysRegulated: false,
	},
	// reinterpret_cast to hardware address \u2014 MISRA-C++ Rule 5-2-7
	{
		linePattern: /\breinterpret_cast\s*<.*volatile.*/,
		indicates: 'reinterpret_cast_volatile',
		alwaysRegulated: true,
	},
	// AUTOSAR RunTimeError / DEM event
	{
		linePattern: /\bDem_SetEventStatus|Dem_ReportErrorStatus|Rte_Call_\w+|\bDET_REPORT\s*\(/,
		indicates: 'autosar_diagnostic_event',
		alwaysRegulated: true,
	},
];

const CPP_EMBEDDED_FUNCTION_PATTERNS: RegExp[] = [
	/\binit\w*\b|\bInit\w*/i,
	/\b(Safety|Emergency|Fault|Watchdog)\w*/i,
	/\b(Dem_|Rte_|Com_|CanSM_|EcuM_)\w*/i,
];


// \u2500\u2500\u2500 IEC 61131-3 (Ladder / Structured Text / FBD) Patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const IEC61131_FIELD_PATTERNS: IRegulatedFieldPattern[] = [
	// Safety function block instances
	{ namePattern: /\b(SF_|Safety_|ESTP_|E_STOP)\w*/i,            regulatedAttribute: 'safety_function_block', framework: 'iec-61508', description: 'Safety Function Block instance (IEC 61508 SIL)' },
	// Timer / counter instances
	{ namePattern: /\b(TON_|TOF_|TP_|CTU_|CTD_|CTUD_)\w*/i,      regulatedAttribute: 'timer_counter_instance', framework: 'iec-61131', description: 'IEC 61131-3 timer or counter instance' },
	// Motion / axis control
	{ namePattern: /\b(MC_|Axis_|Drive_|VFD_)\w*/i,               regulatedAttribute: 'motion_axis',           framework: 'iec-61508', description: 'Motion control axis reference' },
	// Process signals
	{ namePattern: /\b(PID_|PV_|SP_|MV_|CV_)\w*/i,               regulatedAttribute: 'pid_process_variable',  framework: 'iec-61131', description: 'PID controller or process variable' },
	// Emergency / alarm
	{ namePattern: /\b(ALARM_|EMERGENCY_|E_STOP|ESTOP|INTERLOCK_)\w*/i, regulatedAttribute: 'safety_alarm',   framework: 'iec-61508', description: 'Safety alarm or interlock signal' },
];

const IEC61131_STRUCTURAL_PATTERNS: IStructuralPattern[] = [
	// Safety function block call
	{
		linePattern: /\b(SF_EmergencyStop|SF_SafelyLimitedSpeed|SF_SafelyLimitedPosition|SF_GuardMonitoring|SF_SafeStop)\s*\(/i,
		indicates: 'plcopen_safety_fb_call',
		alwaysRegulated: true,
	},
	// Standard timer/counter call
	{
		linePattern: /\b(TON|TOF|TP|CTU|CTD|CTUD)\s*\(/i,
		indicates: 'iec61131_timer_counter_call',
		alwaysRegulated: false,
	},
	// Ladder coil
	{
		linePattern: /\(\s*(OTE|OTL|OTU|OUT)\s*\)/i,
		indicates: 'ladder_output_coil',
		alwaysRegulated: false,
	},
	// SCADA / HMI tag write
	{
		linePattern: /\b(HMI_Write|SCADA_Write|Tag\.Write|TagWrite)\s*\(/i,
		indicates: 'hmi_scada_tag_write',
		alwaysRegulated: false,
	},
	// Motion function block
	{
		linePattern: /\b(MC_Power|MC_MoveAbsolute|MC_MoveRelative|MC_Stop|MC_Reset)\s*\(/i,
		indicates: 'motion_control_fb_call',
		alwaysRegulated: true,
	},
];

const IEC61131_FUNCTION_PATTERNS: RegExp[] = [
	/\b(SF_|Safety_)\w*/i,
	/\b(MC_|Motion_)\w*/i,
	/\b(EMERGENCY|E_STOP|ESTOP|INTERLOCK)\w*/i,
	/\b(ALARM|FAULT|ERROR)\w*/i,
];


// \u2500\u2500\u2500 MISRA-C Violation Structural Patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const MISRA_C_STRUCTURAL_PATTERNS: IStructuralPattern[] = [
	// Rule 15.5 \u2014 function with multiple exit points via goto
	{
		linePattern: /\bgoto\s+\w+[^:]/,
		indicates: 'misra_r15_goto',
		alwaysRegulated: false,
	},
	// Rule 11.1 \u2014 non-boolean condition in if/while (use of assignment in condition)
	{
		linePattern: /\bif\s*\([^=!<>]*=[^=][^)]*\)/,
		indicates: 'misra_r14_assignment_in_condition',
		alwaysRegulated: false,
	},
	// Rule 12.1 \u2014 absence of braces in if/for/while
	{
		linePattern: /\bif\s*\([^)]+\)\s+[^{]/,
		indicates: 'misra_r15_no_braces',
		alwaysRegulated: false,
	},
	// Rule 5.4 \u2014 macro identifier collision (MACRO used as variable)
	{
		linePattern: /#define\s+[A-Z_][A-Z0-9_]*\s+[^\\]+\n.*\bint\s+[A-Z_][A-Z0-9_]*/,
		indicates: 'misra_r5_macro_collision',
		alwaysRegulated: false,
	},
	// Rule 8.5 \u2014 function declared in header files (extern in .c)
	{
		linePattern: /\bextern\s+\w+\s+\w+\s*\(/,
		indicates: 'misra_r8_extern_declaration',
		alwaysRegulated: false,
	},
];


// \u2500\u2500\u2500 ARM / AVR Assembly Patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const ASSEMBLY_EMBEDDED_FIELD_PATTERNS: IRegulatedFieldPattern[] = [
	{ namePattern: /\b(LR|SP|PC|CPSR|APSR|IPSR)\b/i,               regulatedAttribute: 'cpu_register',         framework: 'iec-61508', description: 'ARM CPU core register' },
	{ namePattern: /\b(PRIMASK|FAULTMASK|BASEPRI|CONTROL)\b/i,      regulatedAttribute: 'arm_control_register', framework: 'iec-61508', description: 'ARM Cortex-M exception control register' },
];

const ASSEMBLY_EMBEDDED_STRUCTURAL_PATTERNS: IStructuralPattern[] = [
	// ARM SVC / BKPT (supervisor call / breakpoint \u2014 used in RTOS context switching)
	{
		linePattern: /\b(SVC\s+#[0-9]+|BKPT\s+#[0-9]+|__bkpt|__svc)/i,
		indicates: 'arm_supervisor_call',
		alwaysRegulated: true,
	},
	// AVR SEI / CLI (global interrupt enable/disable)
	{
		linePattern: /\b(sei\s*$|cli\s*$|SREG\s*\|=|SREG\s*&=)/im,
		indicates: 'avr_global_interrupt_control',
		alwaysRegulated: true,
	},
];

const ASSEMBLY_FUNCTION_PATTERNS: RegExp[] = [
	/\b\w*_IRQ\b/i,
	/\b\w*_Handler\b/i,
	/\b(Reset_Handler|HardFault_Handler|MemManage_Handler|BusFault_Handler)\b/i,
];


// \u2500\u2500\u2500 Automotive / ISO 26262 / AUTOSAR Patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const AUTOMOTIVE_FIELD_PATTERNS: IRegulatedFieldPattern[] = [
	// AUTOSAR SWC port interface signals
	{ namePattern: /\b(Rte_Read_|Rte_Write_|Rte_Call_|Rte_IWrite_|Rte_IRead_)\w+/i,    regulatedAttribute: 'autosar_port_signal',      framework: 'autosar',    description: 'AUTOSAR RTE port interface read/write/call' },
	{ namePattern: /\b(Com_SendSignal|Com_ReceiveSignal|Com_SendDynSignal)\w*/i,         regulatedAttribute: 'autosar_com_signal',       framework: 'autosar',    description: 'AUTOSAR COM signal transmission' },
	{ namePattern: /\b(NvM_ReadBlock|NvM_WriteBlock|NvM_WriteAll)\w*/i,                 regulatedAttribute: 'autosar_nvm_block',        framework: 'autosar',    description: 'AUTOSAR NvM non-volatile storage block' },
	{ namePattern: /\b(Dem_SetEventStatus|Dem_ReportErrorStatus|DEM_EVENT_)\w*/i,       regulatedAttribute: 'autosar_dem_event',        framework: 'autosar',    description: 'AUTOSAR DEM diagnostic event marker' },
	// ISO 26262 ASIL signals
	{ namePattern: /\b(asil_|ASIL_|safety_state|SAFETY_STATE|sil_|SIL_)\w*/i,          regulatedAttribute: 'iso26262_asil_signal',     framework: 'iso-26262',  description: 'ISO 26262 ASIL-classified safety signal' },
	{ namePattern: /\b(torque_|TORQUE_|steer_|STEER_|brake_|BRAKE_|throttle_)\w*/i,    regulatedAttribute: 'vehicle_actuator_signal',  framework: 'iso-26262',  description: 'Safety-critical vehicle actuator signal' },
	{ namePattern: /\b(speed_sensor|SPEED_SENSOR|wheel_speed|WHEEL_SPEED)\w*/i,        regulatedAttribute: 'vehicle_sensor_signal',    framework: 'iso-26262',  description: 'Vehicle speed sensor signal (safety-critical)' },
	// CAN bus safety messages
	{ namePattern: /\b(can_id_|CAN_ID_|can_msg_|CAN_MSG_|CAN_FRAME)\w*/i,              regulatedAttribute: 'can_bus_signal',           framework: 'iso-26262',  description: 'CAN bus message/frame identifier' },
	{ namePattern: /\b(E2E_|e2e_|checksum_protect|crc_protect)\w*/i,                   regulatedAttribute: 'e2e_protection',           framework: 'autosar',    description: 'AUTOSAR E2E end-to-end CRC protection' },
];

const AUTOMOTIVE_STRUCTURAL_PATTERNS: IStructuralPattern[] = [
	// AUTOSAR runnable entity
	{
		linePattern: /\bRUNNABLE_DEFINE\s*\(|Rte_Task_\w+\s*\(/,
		indicates: 'autosar_runnable',
		alwaysRegulated: true,
	},
	// E2E protection check
	{
		linePattern: /\bE2E_P\w+Check\s*\(|E2E_Check\s*\(/,
		indicates: 'e2e_protection_check',
		alwaysRegulated: true,
	},
	// AUTOSAR OS task
	{
		linePattern: /\bDEFINE_TASK\s*\(|TASK\s*\(\s*\w+\s*\)|Os_Task\w+\s*\(/,
		indicates: 'autosar_os_task',
		alwaysRegulated: false,
	},
	// FlexRay / LIN frame send
	{
		linePattern: /\bFr_TransmitTxLPdu\s*\(|Lin_SendFrame\s*\(/,
		indicates: 'flexray_lin_frame_send',
		alwaysRegulated: true,
	},
	// ISO 26262 safety mechanism activation
	{
		linePattern: /\b(Fls_SafetyMechanism|Wdg_SetMode|EcuM_SelectShutdownTarget)\s*\(/,
		indicates: 'iso26262_safety_mechanism',
		alwaysRegulated: true,
	},
];

const AUTOMOTIVE_FUNCTION_PATTERNS: RegExp[] = [
	/\bRte_\w+/i,
	/\b(ASIL|asil)_[ABCD]\w*/i,
	/\b(safety|Safety|SAFETY)_\w+/i,
	/\b(Torque|Brake|Steer|Throttle)\w*/i,
	/\b(Dem_|NvM_|Com_|EcuM_|WdgM_|Fls_)\w*/i,
];


// \u2500\u2500\u2500 Telecom & 5G Infrastructure Patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const TELECOM_FIELD_PATTERNS: IRegulatedFieldPattern[] = [
	// 3GPP / LTE / 5G protocol signals
	{ namePattern: /\b(rrc_|RRC_|nas_|NAS_|pdcp_|PDCP_|rlc_|RLC_|mac_|MAC_)\w+/i,     regulatedAttribute: 'lte5g_protocol_signal',    framework: 'iec-62443',  description: '3GPP LTE/5G protocol layer signal' },
	{ namePattern: /\b(ue_id|UE_ID|rnti|RNTI|imsi|IMSI|tmsi|TMSI)\w*/i,               regulatedAttribute: 'subscriber_identity',      framework: 'iec-62443',  description: 'Subscriber identity or device identifier (regulated PII)' },
	{ namePattern: /\b(cipher_key|CIPHER_KEY|integrity_key|INTEGRITY_KEY|krrc|KRRC)\w*/i, regulatedAttribute: 'telecom_crypto_key',    framework: 'iec-62443',  description: 'Telecom cryptographic key material (3GPP AS/NAS security)' },
	// TTCN-3 / protocol testing
	{ namePattern: /\b(ttcn_|TTCN_|verdicttype|VerdictType|testcase_|module_)\w*/i,    regulatedAttribute: 'ttcn3_test_entity',        framework: 'iec-62443',  description: 'TTCN-3 test component or test case entity' },
	// O-RAN / fronthaul
	{ namePattern: /\b(oran_|ORAN_|fronthaul_|FRONTHAUL_|cu_up|CU_UP|du_|DU_)\w*/i,   regulatedAttribute: 'oran_interface_signal',    framework: 'iec-62443',  description: 'O-RAN open fronthaul interface signal' },
	// SS7 / SIGTRAN legacy
	{ namePattern: /\b(sccp_|SCCP_|mtp3_|MTP3_|isup_|ISUP_|sigtran_)\w*/i,            regulatedAttribute: 'ss7_sigtran_signal',       framework: 'iec-62443',  description: 'SS7 / SIGTRAN signalling protocol entity' },
];

const TELECOM_STRUCTURAL_PATTERNS: IStructuralPattern[] = [
	// 3GPP ASN.1 decode/encode
	{
		linePattern: /\bASN1_ENCODE\s*\(|asn1_decode\s*\(|aper_decode\s*\(|per_encode\s*\(/i,
		indicates: '3gpp_asn1_codec',
		alwaysRegulated: true,
	},
	// 3GPP ciphering / integrity
	{
		linePattern: /\b(snow3g_|zuc_|aes_|EIA[0-9]_|EEA[0-9]_)\w+\s*\(/i,
		indicates: '3gpp_security_algorithm',
		alwaysRegulated: true,
	},
	// O-RAN CU/DU split API
	{
		linePattern: /\bF1AP_\w+\s*\(|E1AP_\w+\s*\(|XnAP_\w+\s*\(|NgAP_\w+\s*\(/i,
		indicates: 'oran_cu_du_interface',
		alwaysRegulated: true,
	},
	// DIAMETER / Radius auth
	{
		linePattern: /\bdiameter_send\s*\(|radius_auth\s*\(|AAR_\w+\s*\(/i,
		indicates: 'telecom_aaa_protocol',
		alwaysRegulated: true,
	},
];

const TELECOM_FUNCTION_PATTERNS: RegExp[] = [
	/\b(rrc_|nas_|pdcp_|rlc_|mac_)\w+/i,
	/\b(F1AP_|E1AP_|NgAP_|N2AP_)\w+/i,
	/\b(cipher|integrity|authenticate)\w*/i,
	/\b(ue_attach|ue_detach|paging_)\w*/i,
];


// \u2500\u2500\u2500 Energy / Oil & Gas / Critical Infrastructure Patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const ENERGY_FIELD_PATTERNS: IRegulatedFieldPattern[] = [
	// IEC 61850 substation automation
	{ namePattern: /\b(XCBR|XSWI|CSWI|CTLZ|BSCH|LLNO|LLN0|LPHD)\w*/i,                regulatedAttribute: 'iec61850_logical_node',    framework: 'iec-61508',  description: 'IEC 61850 logical node class reference' },
	{ namePattern: /\b(goose_|GOOSE_|sampled_value|SV_|GOCB_)\w*/i,                    regulatedAttribute: 'iec61850_goose_sv',        framework: 'iec-61508',  description: 'IEC 61850 GOOSE or Sampled Value dataset' },
	// DNP3 / SCADA
	{ namePattern: /\b(dnp3_|DNP3_|modbus_|MODBUS_|scada_tag|SCADA_TAG)\w*/i,          regulatedAttribute: 'scada_dnp3_point',         framework: 'iec-62443',  description: 'DNP3 / Modbus SCADA data point' },
	{ namePattern: /\b(rtu_|RTU_|mtu_|MTU_|historian_|HISTORIAN_)\w*/i,                regulatedAttribute: 'scada_field_device',       framework: 'iec-62443',  description: 'SCADA RTU/MTU field device reference' },
	// Process variables (Oil & Gas)
	{ namePattern: /\b(pressure_|PRESSURE_|flow_rate|FLOW_RATE|level_|LEVEL_|temp_|TEMP_)\w*/i, regulatedAttribute: 'process_variable', framework: 'iec-61508', description: 'Critical process variable (pressure/flow/level/temp)' },
	{ namePattern: /\b(esd_|ESD_|sis_|SIS_|safety_instrumented|SAFETY_INSTRUMENTED)\w*/i, regulatedAttribute: 'sis_esd_signal',       framework: 'iec-61508',  description: 'Safety Instrumented System or Emergency Shutdown signal' },
	// Cybersecurity (IEC 62443)
	{ namePattern: /\b(zone_|ZONE_|conduit_|CONDUIT_|security_level|SECURITY_LEVEL)\w*/i, regulatedAttribute: 'iec62443_zone_conduit', framework: 'iec-62443', description: 'IEC 62443 security zone or conduit reference' },
];

const ENERGY_STRUCTURAL_PATTERNS: IStructuralPattern[] = [
	// IEC 61850 GOOSE publication
	{
		linePattern: /\bMmsValue_\w+\s*\(|IedServer_handleWriteAccess\s*\(|GoosePublisher_publish\s*\(/i,
		indicates: 'iec61850_goose_publish',
		alwaysRegulated: true,
	},
	// DNP3 outstation update
	{
		linePattern: /\bDNP3_UpdateAnalog\s*\(|DNP3_UpdateBinary\s*\(|OutstationApplication_\w+\s*\(/i,
		indicates: 'dnp3_outstation_update',
		alwaysRegulated: true,
	},
	// SIS/ESD activation
	{
		linePattern: /\b(ESD_Activate|SIS_Trip|SafetyInstrumentedSystem_)\w+\s*\(/i,
		indicates: 'sis_esd_activation',
		alwaysRegulated: true,
	},
	// Historian write
	{
		linePattern: /\b(OSIsoft_PI_Write|Historian_Write|Tag_WriteValue)\s*\(/i,
		indicates: 'historian_tag_write',
		alwaysRegulated: false,
	},
];

const ENERGY_FUNCTION_PATTERNS: RegExp[] = [
	/\b(ESD|SIS|GOOSE|DNP3)\w*/i,
	/\b(iec61850|iec62443|dnp3)\w*/i,
	/\b(pressure|flow|level|temperature)_(trip|alarm|control)\w*/i,
	/\b(RTU|MTU|SCADA)_\w+/i,
];


// \u2500\u2500\u2500 Industrial IoT & OT Extended Patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const IIOT_OT_FIELD_PATTERNS: IRegulatedFieldPattern[] = [
	// MQTT / cloud bridge
	{ namePattern: /\b(mqtt_|MQTT_|mqtt_topic|MQTT_TOPIC|mqtt_payload)\w*/i,           regulatedAttribute: 'mqtt_topic_payload',       framework: 'iec-62443',  description: 'MQTT topic or payload (OT/IT convergence bridge)' },
	{ namePattern: /\b(aws_iot|AWS_IOT|azure_iot|AZURE_IOT|gcp_iot)\w*/i,              regulatedAttribute: 'cloud_iot_endpoint',       framework: 'iec-62443',  description: 'Cloud IoT platform connection endpoint' },
	// EtherCAT / Profinet
	{ namePattern: /\b(ecm_|ECM_|ethercat_|ETHERCAT_|profinet_|PROFINET_)\w*/i,        regulatedAttribute: 'ethercat_profinet_signal', framework: 'iec-61508',  description: 'EtherCAT/Profinet real-time fieldbus signal' },
	{ namePattern: /\b(PDO_|SDO_|pdo_|sdo_|COB_ID|cob_id)\w*/i,                       regulatedAttribute: 'canopen_pdo_sdo',          framework: 'iec-61508',  description: 'CANopen PDO/SDO communication object' },
	// OPC-UA Pub/Sub
	{ namePattern: /\b(UA_WriterGroup|UA_PublishedData|UA_MonitoredItem)\w*/i,          regulatedAttribute: 'opcua_pubsub_entity',      framework: 'iec-62443',  description: 'OPC-UA Pub/Sub writer group or monitored item' },
	// Functional safety (IEC 62061 / PLe / SIL 3)
	{ namePattern: /\b(PLe_|PL_e|PLd_|PL_d|SIL3_|SIL2_|Cat4_|Cat3_)\w*/i,            regulatedAttribute: 'plc_safety_integrity',     framework: 'iec-61508',  description: 'IEC 62061 / ISO 13849 Performance Level or SIL classification' },
];

const IIOT_OT_STRUCTURAL_PATTERNS: IStructuralPattern[] = [
	// MQTT publish with QoS 2 (guaranteed delivery)
	{
		linePattern: /mqtt_publish\s*\(|MQTTClient_publish\s*\(|AWS_IOT_MQTT_Publish\s*\(/i,
		indicates: 'mqtt_publish',
		alwaysRegulated: false,
	},
	// EtherCAT process data exchange
	{
		linePattern: /\becrt_domain_process\s*\(|ecm_process_data\s*\(|EtherCAT_PDI_\w+\s*\(/i,
		indicates: 'ethercat_pdi_exchange',
		alwaysRegulated: true,
	},
	// CANopen NMT state machine
	{
		linePattern: /\bCO_NMT_sendCommand\s*\(|canopen_nmt_\w+\s*\(|NMT_RESET_\w+/i,
		indicates: 'canopen_nmt_command',
		alwaysRegulated: true,
	},
	// Profinet alarm indication
	{
		linePattern: /\bPNIO_AlarmSend\s*\(|Profinet_AlarmIndication\s*\(|AR_Abort\s*\(/i,
		indicates: 'profinet_alarm',
		alwaysRegulated: true,
	},
];

const IIOT_OT_FUNCTION_PATTERNS: RegExp[] = [
	/\b(mqtt|MQTT)_\w+/i,
	/\b(ethercat|profinet|canopen|CANopen)\w*/i,
	/\b(opcua|OPC_UA)_\w+/i,
	/\b(SIL|PLe|PLd|Cat[34])_\w+/i,
];


// \u2500\u2500\u2500 Registry \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const LEGACY_PATTERN_REGISTRY: Record<string, ILanguagePatterns> = {
	'embedded-c': {
		fieldPatterns:      EMBEDDED_C_FIELD_PATTERNS,
		structuralPatterns: [...EMBEDDED_C_STRUCTURAL_PATTERNS, ...MISRA_C_STRUCTURAL_PATTERNS],
		paragraphPatterns:  EMBEDDED_C_FUNCTION_PATTERNS,
	},
	'embedded-cpp': {
		fieldPatterns:      CPP_EMBEDDED_FIELD_PATTERNS,
		structuralPatterns: CPP_EMBEDDED_STRUCTURAL_PATTERNS,
		paragraphPatterns:  CPP_EMBEDDED_FUNCTION_PATTERNS,
	},
	'iec61131': {
		fieldPatterns:      IEC61131_FIELD_PATTERNS,
		structuralPatterns: IEC61131_STRUCTURAL_PATTERNS,
		paragraphPatterns:  IEC61131_FUNCTION_PATTERNS,
	},
	'assembler': {
		fieldPatterns:      ASSEMBLY_EMBEDDED_FIELD_PATTERNS,
		structuralPatterns: ASSEMBLY_EMBEDDED_STRUCTURAL_PATTERNS,
		paragraphPatterns:  ASSEMBLY_FUNCTION_PATTERNS,
	},
	// \u2500\u2500 Market vertical aliases \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	'autosar': {
		fieldPatterns:      [...CPP_EMBEDDED_FIELD_PATTERNS, ...AUTOMOTIVE_FIELD_PATTERNS],
		structuralPatterns: [...CPP_EMBEDDED_STRUCTURAL_PATTERNS, ...AUTOMOTIVE_STRUCTURAL_PATTERNS],
		paragraphPatterns:  [...CPP_EMBEDDED_FUNCTION_PATTERNS, ...AUTOMOTIVE_FUNCTION_PATTERNS],
	},
	'automotive': {
		fieldPatterns:      [...EMBEDDED_C_FIELD_PATTERNS, ...AUTOMOTIVE_FIELD_PATTERNS],
		structuralPatterns: [...EMBEDDED_C_STRUCTURAL_PATTERNS, ...AUTOMOTIVE_STRUCTURAL_PATTERNS],
		paragraphPatterns:  [...EMBEDDED_C_FUNCTION_PATTERNS, ...AUTOMOTIVE_FUNCTION_PATTERNS],
	},
	'telecom': {
		fieldPatterns:      [...EMBEDDED_C_FIELD_PATTERNS, ...TELECOM_FIELD_PATTERNS],
		structuralPatterns: [...EMBEDDED_C_STRUCTURAL_PATTERNS, ...TELECOM_STRUCTURAL_PATTERNS],
		paragraphPatterns:  [...EMBEDDED_C_FUNCTION_PATTERNS, ...TELECOM_FUNCTION_PATTERNS],
	},
	'energy': {
		fieldPatterns:      [...IEC61131_FIELD_PATTERNS, ...ENERGY_FIELD_PATTERNS],
		structuralPatterns: [...IEC61131_STRUCTURAL_PATTERNS, ...ENERGY_STRUCTURAL_PATTERNS],
		paragraphPatterns:  [...IEC61131_FUNCTION_PATTERNS, ...ENERGY_FUNCTION_PATTERNS],
	},
	'iiot-ot': {
		fieldPatterns:      [...EMBEDDED_C_FIELD_PATTERNS, ...IEC61131_FIELD_PATTERNS, ...IIOT_OT_FIELD_PATTERNS],
		structuralPatterns: [...EMBEDDED_C_STRUCTURAL_PATTERNS, ...IEC61131_STRUCTURAL_PATTERNS, ...IIOT_OT_STRUCTURAL_PATTERNS],
		paragraphPatterns:  [...EMBEDDED_C_FUNCTION_PATTERNS, ...IEC61131_FUNCTION_PATTERNS, ...IIOT_OT_FUNCTION_PATTERNS],
	},
	// Alias: plain 'c' maps to embedded-c for discovery routing
	'c': {
		fieldPatterns:      EMBEDDED_C_FIELD_PATTERNS,
		structuralPatterns: [...EMBEDDED_C_STRUCTURAL_PATTERNS, ...MISRA_C_STRUCTURAL_PATTERNS],
		paragraphPatterns:  EMBEDDED_C_FUNCTION_PATTERNS,
	},
	'cpp': {
		fieldPatterns:      CPP_EMBEDDED_FIELD_PATTERNS,
		structuralPatterns: CPP_EMBEDDED_STRUCTURAL_PATTERNS,
		paragraphPatterns:  CPP_EMBEDDED_FUNCTION_PATTERNS,
	},
};

/**
 * Default attribute when a volatile uint32_t* cast is detected but no specific
 * peripheral register name pattern matches.
 */
export const UNSAFE_CAST_DEFAULT_ATTRIBUTE  = 'peripheral_register_raw_access';
export const UNSAFE_CAST_DEFAULT_FRAMEWORK  = 'misra-c';

/**
 * Default attribute for ISR handlers that don't match a named handler pattern.
 */
export const ISR_DEFAULT_ATTRIBUTE = 'interrupt_service_routine_generic';
export const ISR_DEFAULT_FRAMEWORK = 'iec-61508';
