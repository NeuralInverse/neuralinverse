/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Sector Registry
 *
 * Single source of truth for the 5 regulated industry verticals supported by
 * Neural Inverse Modernisation. Every backend engine and every AI system reads
 * from here instead of maintaining its own hard-coded strings.
 *
 * ## Design
 *
 * Each `ISectorProfile` describes one vertical:
 *   - Which standards/frameworks govern it
 *   - Which compliance gate IDs must pass before a unit can be approved
 *   - Which tech-debt categories are blocking (not just warnings) in this sector
 *   - Which migration blocker types are mandatory to surface
 *   - Which language-pair profile IDs are primary for this sector
 *   - An `aiGuidance` string injected verbatim into LLM prompts
 *
 * ## Usage
 *
 *   // Detect from a migration pattern ID
 *   const profile = getSectorProfile(session.migrationPattern ?? '');
 *
 *   // Look up by sector ID directly
 *   const profile = getSectorProfileById('automotive');
 *
 *   // Enumerate all
 *   const all = getAllSectorProfiles();
 */

import type { TechDebtCategory } from './discovery/discoveryTypes.js';
import type { MigrationBlockerType } from '../../common/modernisationTypes.js';


// \u2500\u2500\u2500 Sector ID \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export type SectorId =
	| 'firmware'
	| 'automotive'
	| 'energy'
	| 'telecom'
	| 'iiot';


// \u2500\u2500\u2500 Profile interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface ISectorProfile {
	/** Stable machine-readable identifier */
	id: SectorId;

	/** Human-readable label (used in UI and injected into prompts) */
	label: string;

	/** Primary standards / frameworks governing this sector */
	primaryStandards: string[];

	/**
	 * Compliance gate requirement IDs (from complianceGates.ts) that MUST pass
	 * before a unit in this sector can be marked 'approved'.
	 */
	requiredGateIds: string[];

	/**
	 * Tech debt categories that are BLOCKING in this sector.
	 * The translation engine and Power Mode treat these as hard blockers,
	 * not warnings \u2014 the unit must be refactored before translation.
	 */
	blockingDebtCategories: TechDebtCategory[];

	/**
	 * Migration blocker types that are MANDATORY to surface for units
	 * in this sector (even if heuristics don't fire).
	 */
	mandatoryBlockerTypes: MigrationBlockerType[];

	/**
	 * Primary language-pair profile IDs from languagePairRegistry.ts
	 * that are relevant for migrations in this sector.
	 */
	primaryLanguagePairs: Array<{ sourceLang: string; targetLang: string }>;

	/**
	 * Key data patterns (from regulatedDataScanner.ts) that are especially
	 * sensitive in this sector \u2014 triggers extra scrutiny during scanning.
	 */
	sensitiveDataPatterns: string[];

	/**
	 * Verbatim text injected into LLM system prompts whenever this sector
	 * is active. Describes compliance obligations at the code level.
	 */
	aiGuidance: string;
}


// \u2500\u2500\u2500 Sector Profiles \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const FIRMWARE: ISectorProfile = {
	id: 'firmware',
	label: 'Firmware & Embedded Systems',
	primaryStandards: [
		'IEC 61508 (Functional Safety)',
		'MISRA-C:2012',
		'IEC 62443 (IIoT Security)',
		'ISO 26262 (where automotive overlap exists)',
		'AUTOSAR Classic (BSP layer)',
		'DO-178C (where avionics overlap exists)',
	],
	requiredGateIds: [
		'req-fingerprint',
		'req-approval',
	],
	blockingDebtCategories: [
		'unsafe-pointer-arithmetic',
		'isr-reentrance-risk',
		'misra-c-critical-violation',
		'hardware-dependency',
		'watchdog-gap',
		'hardcoded-credential',
	],
	mandatoryBlockerTypes: [
		'unsafe-pointer-arithmetic',
		'isr-reentrance-risk',
		'misra-c-critical-violation',
		'hardware-dependency',
		'no-hal-equivalent',
		'watchdog-gap',
		'timing-constraint',
		'safety-integrity-level',
	],
	primaryLanguagePairs: [
		{ sourceLang: 'c',         targetLang: 'c'   },   // bare-metal \u2192 FreeRTOS / Zephyr
		{ sourceLang: 'c',         targetLang: 'cpp' },   // embedded-C \u2192 MISRA C++
		{ sourceLang: 'assembler', targetLang: 'c'   },   // ASM \u2192 embedded-C
	],
	sensitiveDataPatterns: [
		'peripheral-register',
		'raw-mmio-cast',
		'isr-definition',
		'watchdog-refresh',
		'dynamic-allocation',
	],
	aiGuidance: `
## Firmware & Embedded Sector \u2014 Compliance Obligations

You are working in a safety-critical firmware codebase governed by IEC 61508 and MISRA-C:2012.

### Hard rules \u2014 violation = raise a blocking decision, do NOT translate the construct as-is
- Every ISR that touches shared state MUST use a critical section (taskENTER_CRITICAL / __disable_irq or equivalent). If the source doesn't, raise a decision.
- Raw pointer casts to peripheral addresses (volatile uint32_t*)0x40000000 violate MISRA-C Rule 11.4. Replace with HAL API calls. If no HAL equivalent exists, raise a 'no-hal-equivalent' decision.
- Watchdog refresh calls (HAL_IWDG_Refresh, WDT_Feed, etc.) MUST be preserved in all long-running loops and tasks. Never remove them.
- Dynamic memory allocation (malloc/free/calloc) violates MISRA-C Rule 21.3. Replace with static allocation or memory pools. Flag any usage.
- Stack usage in ISRs must be minimal \u2014 never call blocking OS APIs (vTaskDelay, osDelay, sleep) from interrupt context.

### Translation conventions
- Use HAL/LL driver APIs (STM32 HAL, NXP SDK, Zephyr drivers) instead of direct register writes.
- Preserve all __attribute__((interrupt)), __irq, ISR() decorators and their vector table mappings.
- FreeRTOS task stacks must be statically allocated when MISRA compliance is required.
- All safety-function return codes must be checked \u2014 never discard return values from IEC 61508 SIL-rated functions.
`.trim(),
};


const AUTOMOTIVE: ISectorProfile = {
	id: 'automotive',
	label: 'Automotive (ISO 26262 / AUTOSAR)',
	primaryStandards: [
		'ISO 26262:2018 (ASIL-A through ASIL-D)',
		'AUTOSAR Classic Platform (CP R23-11)',
		'AUTOSAR Adaptive Platform (AP R23-11)',
		'ISO 21434:2021 (Cybersecurity)',
		'UN Regulation No. 155 (Cybersecurity Management)',
		'UN Regulation No. 156 (Software Update / OTA)',
		'A-SPICE Level 2',
		'MISRA-C:2012 / MISRA-C++:2008',
	],
	requiredGateIds: [
		'req-fingerprint',
		'req-approval',
		'req-compliance-officer',
		'req-asil-formal-verification',
		'req-e2e-protection-profile',
		'req-iso21434-tara',
		'req-aspice-process',
		'req-un-r156-ota',
	],
	blockingDebtCategories: [
		'autosar-rte-dependency',
		'e2e-protection-gap',
		'asil-decomposition-break',
		'can-signal-scaling-mismatch',
		'unsafe-pointer-arithmetic',
		'misra-c-critical-violation',
		'hardcoded-credential',
	],
	mandatoryBlockerTypes: [
		'autosar-rte-dependency',
		'e2e-protection-gap',
		'asil-decomposition-break',
		'can-signal-scaling-mismatch',
		'safety-integrity-level',
		'iso21434-tara-missing',
		'aspice-process-gap',
		'do178c-independence-missing',
	],
	primaryLanguagePairs: [
		{ sourceLang: 'autosar',  targetLang: 'cpp'   },  // Classic CP SWC \u2192 Adaptive
		{ sourceLang: 'can-dbc',  targetLang: 'c'     },  // CAN DBC \u2192 CANopen OD
		{ sourceLang: 'c',        targetLang: 'cpp'   },  // embedded-C SWC \u2192 C++14
	],
	sensitiveDataPatterns: [
		'autosar-rte-write',
		'autosar-rte-read',
		'peripheral-register',
		'raw-mmio-cast',
	],
	aiGuidance: `
## Automotive Sector \u2014 Compliance Obligations

You are working in an automotive codebase governed by ISO 26262 and AUTOSAR.

### Hard rules \u2014 violation = raise a blocking decision
- AUTOSAR Classic Rte_Write/Rte_Read calls have NO direct equivalent in Adaptive ara::com. Every occurrence must be mapped to a Service Interface method (ara::com::proxy or skeleton). Raise a 'autosar-rte-dependency' decision for each unmapped port.
- E2E protection profiles (E2E_P01, P02, P04, P05, P07) MUST be preserved end-to-end. Never drop CRC, counter, or data-ID fields when translating communication code.
- ASIL-D units may only be split into ASIL-B+ASIL-B with a documented decomposition rationale. Never silently merge or split ASIL-rated components.
- CAN DBC signal factor/offset/min/max values are safety-relevant. Every signal mapping to a CANopen OD entry must preserve scaling exactly \u2014 raise a decision if the target OD type has different precision.
- ISO 21434 TARA must be on record before any cryptographic or network-facing unit is marked approved. Call check_compliance_gate to verify.

### Translation conventions
- Classic BSP/MCAL code maps to Adaptive Platform's ara::hal or vendor-specific HAL.
- Use ara::com generated proxies/skeletons \u2014 never raw socket calls in adaptive SWCs.
- ara::exec Execution Management requires a machine manifest entry for every executable.
- All crypto operations must use ara::crypto \u2014 no direct OpenSSL calls in production SWCs.
`.trim(),
};


const ENERGY: ISectorProfile = {
	id: 'energy',
	label: 'Critical Infrastructure / Energy',
	primaryStandards: [
		'IEC 61850 (Substation Automation / GOOSE / SV)',
		'IEC 62351 (Power System Communications Security)',
		'IEC 61511 / IEC 62061 (Functional Safety / SIL)',
		'IEC 62443 (Industrial Cybersecurity)',
		'NERC CIP-005-7 / CIP-013-2 (Critical Infrastructure Protection)',
		'DNP3 Secure Authentication v5 (IEC 62351-5)',
		'IEEE 1686 (Intelligent Electronic Devices Security)',
	],
	requiredGateIds: [
		'req-fingerprint',
		'req-approval',
		'req-compliance-officer',
		'req-goose-path-isolation',
		'req-sil-verification-report',
		'req-nerc-cip-supply-chain',
		'req-iec62351-comms-security',
		'req-iec62061-safety-function',
	],
	blockingDebtCategories: [
		'goose-protection-relay',
		'dnp3-secure-auth-gap',
		'sis-sil-downgrade',
		'hardcoded-credential',
		'hardcoded-url',
		'unsafe-pointer-arithmetic',
	],
	mandatoryBlockerTypes: [
		'goose-protection-relay',
		'dnp3-secure-auth-gap',
		'sis-sil-downgrade',
		'safety-integrity-level',
		'nerc-cip-supply-chain',
		'iec62351-comms-security',
		'sil-fb-diagnostic-gap',
	],
	primaryLanguagePairs: [
		{ sourceLang: 'iec61850', targetLang: 'cpp'  },  // IEC 61850 SCL \u2192 OPC-UA C++ (open62541)
		{ sourceLang: 'c',        targetLang: 'c'    },  // DNP3 RTU C \u2192 IEC60870-5-104 TLS
		{ sourceLang: 'iec61131', targetLang: 'cpp'  },  // PLC ST/LD \u2192 Linux-RT C++
	],
	sensitiveDataPatterns: [
		'iec61850-goose',
		'iec61850-xcbr',
		'iec61850-xswi',
		'dnp3-endpoint',
		'safety-function-block',
		'hardcoded-ip',
	],
	aiGuidance: `
## Critical Infrastructure / Energy Sector \u2014 Compliance Obligations

You are working in a safety-critical energy / OT codebase governed by IEC 61850, IEC 61511, and NERC CIP.

### Hard rules \u2014 violation = raise a blocking decision
- IEC 61850 GOOSE trip paths MUST remain on a dedicated, time-bounded network path (IEC 61850-8-1). NEVER route GOOSE messages via OPC-UA, MQTT, or any TCP-based transport \u2014 this violates Class P5/P6 timing requirements (< 4 ms). Raise a 'goose-protection-relay' blocking decision if such routing is detected.
- DNP3 stations without Secure Authentication v5 (SA_CHALLENGE) violate NERC CIP CIP-005-7 R2 and IEC 62351-5. Every migrated DNP3 implementation must include SAv5 \u2014 raise 'dnp3-secure-auth-gap' if missing.
- SIL-rated functions (IEC 61511 / IEC 62061) must maintain or improve their SIL level after migration. A SIL downgrade is a regulatory violation \u2014 raise 'sis-sil-downgrade' immediately.
- PLCopen Safety function blocks (SF_EmergencyStop, SF_GuardLocking etc.) must have DiagCode output monitored. Never remove diagnostic coverage.
- NERC CIP-013-2 supply chain evidence must be on record before any network-facing component is approved. Call check_compliance_gate.

### Translation conventions
- Use IEC 61850 SCL/CID schema for GOOSE publisher/subscriber configuration \u2014 never hardcode multicast addresses.
- IEC 60870-5-104 migrations must use TLS 1.2+ (IEC 62351-3) \u2014 never plaintext.
- OPC-UA industrial profiles must use SecurityMode=SignAndEncrypt in production \u2014 never SecurityMode=None.
`.trim(),
};


const TELECOM: ISectorProfile = {
	id: 'telecom',
	label: 'Telecom & 5G',
	primaryStandards: [
		'3GPP TS 33.501 (5G NR Security)',
		'3GPP TS 38.401 (NG-RAN Architecture)',
		'O-RAN.WG4 (Open Fronthaul / eCPRI)',
		'GSMA NESAS / SCAS (Network Equipment Security Assurance)',
		'GSMA PRD FS.13 (5G Interconnect Security)',
		'IEC/IEEE 60802 (TSN for Industrial Networks)',
		'TTCN-3 (Testing and Test Control Notation)',
	],
	requiredGateIds: [
		'req-fingerprint',
		'req-approval',
		'req-compliance-officer',
		'req-key-material-externalised',
		'req-gsma-nesas-scas',
		'req-oran-fronthaul-timing',
		'req-network-slice-isolation',
		'req-ttcn3-gsma-coverage',
	],
	blockingDebtCategories: [
		'security-key-material',
		'protocol-state-machine-break',
		'ttcn3-verdict-suppression',
		'hardcoded-credential',
		'hardcoded-url',
	],
	mandatoryBlockerTypes: [
		'security-key-material',
		'protocol-state-machine-break',
		'ttcn3-verdict-suppression',
		'gsma-nesas-scas',
		'oran-fronthaul-timing',
		'gtp-up-cp-mixing',
	],
	primaryLanguagePairs: [
		{ sourceLang: 'c',      targetLang: 'cpp'    },  // LTE eNB monolithic \u2192 O-RAN CU/DU
		{ sourceLang: 'ttcn3',  targetLang: 'python' },  // TTCN-3 test suite \u2192 PyTest+Scapy
		{ sourceLang: 'c',      targetLang: 'cpp'    },  // SS7/MAP \u2192 Diameter/SIP
	],
	sensitiveDataPatterns: [
		'nas-key-derivation',
		'rrc-key-array',
		'gtp-tunnel',
		'3gpp-key-material',
	],
	aiGuidance: `
## Telecom & 5G Sector \u2014 Compliance Obligations

You are working in a 5G / telecom codebase governed by 3GPP TS 33.501 and GSMA NESAS.

### Hard rules \u2014 violation = raise a blocking decision
- 3GPP AS/NAS key material (kNASenc, kNASint, kRRCenc, kRRCint, kUPenc, SUPI, SUCI) MUST be stored in an HSM or TEE \u2014 never inline in source. Any key array literal is a 'security-key-material' blocking violation.
- GTP-U user-plane traffic must be strictly separated from GTP-C control-plane on distinct logical channels (3GPP TS 38.401 CU-UP / CU-CP split). Never mix UP and CP in the same socket or thread \u2014 raise 'gtp-up-cp-mixing'.
- O-RAN eCPRI fronthaul must use IEEE 1914.3 transport \u2014 never HTTP/REST for fronthaul data. Timing requirement: < 100 µs (Class C). Raise 'oran-fronthaul-timing' if the implementation cannot meet this.
- TTCN-3 test cases must never suppress 'inconc' or 'fail' verdicts without a documented reference to a GSMA PRD FS.13 or 3GPP test spec entry. Raise 'ttcn3-verdict-suppression' if suppression is detected.
- Network slice isolation: each slice's UPF and SMF instances must be logically isolated \u2014 no cross-slice state sharing.

### Translation conventions
- Monolithic LTE eNB C code splits into CU (PDCP/RRC) and DU (RLC/MAC/PHY) over F1AP interface.
- Use O-RAN Alliance M-Plane (NETCONF/YANG) for O-RU configuration \u2014 never proprietary management channels.
- GSMA NESAS SCAS evidence must be generated before any network function is marked approved. Call check_compliance_gate.
`.trim(),
};


const IIOT: ISectorProfile = {
	id: 'iiot',
	label: 'Industrial IoT & OT',
	primaryStandards: [
		'IEC 62443 (Industrial Cybersecurity \u2014 Zone/Conduit)',
		'IEC 61131-3 (PLC Programming)',
		'IEC 62061 (Safety of Machinery \u2014 SIL)',
		'OPC UA (IEC 62541) \u2014 Security Mode SignAndEncrypt',
		'EtherCAT (IEC 61784-2) \u2014 IRT < 1 µs jitter',
		'PROFINET (IEC 61158-6-10)',
		'MQTT Sparkplug B v3.0',
		'IEEE 802.1AS-2020 (gPTP for TSN)',
		'IEEE 802.1Qbv (TSN Time-Aware Shaper)',
	],
	requiredGateIds: [
		'req-fingerprint',
		'req-approval',
		'req-ot-zone-conduit-isolation',
		'req-iec62061-safety-function',
		'req-fieldbus-rt-validation',
		'req-tsn-gptp-synchronisation',
	],
	blockingDebtCategories: [
		'goose-protection-relay',
		'hardcoded-credential',
		'hardcoded-url',
		'unsafe-pointer-arithmetic',
		'sis-sil-downgrade',
	],
	mandatoryBlockerTypes: [
		'opcua-security-none',
		'sparkplug-birth-missing',
		'tsn-gptp-missing',
		'ethercat-timing-violation',
		'canopen-sdo-timeout',
		'profinet-station-hardcoded',
		'sil-fb-diagnostic-gap',
	],
	primaryLanguagePairs: [
		{ sourceLang: 'iec61131', targetLang: 'cpp' },  // PLC LD/ST \u2192 Linux-RT C++
		{ sourceLang: 'c',        targetLang: 'c'   },  // CANopen \u2192 EtherCAT CoE
		{ sourceLang: 'c',        targetLang: 'cpp' },  // Modbus \u2192 OPC-UA
	],
	sensitiveDataPatterns: [
		'opcua-security-none',
		'profinet-station-name',
		'sparkplug-nbirth-missing',
		'hardcoded-ip',
		'safety-function-block',
	],
	aiGuidance: `
## Industrial IoT & OT Sector \u2014 Compliance Obligations

You are working in an industrial OT/IIoT codebase governed by IEC 62443, IEC 61131-3, and IEC 62061.

### Hard rules \u2014 violation = raise a blocking decision
- OPC-UA sessions must use SecurityMode=SignAndEncrypt and a valid certificate chain in production (IEC 62443-3-3 / IEC 62541-6). SecurityMode=None is a blocking violation \u2014 raise 'opcua-security-none'.
- MQTT Sparkplug B publishers MUST send an NBIRTH (Node Birth) and DBIRTH (Device Birth) certificate before any NDATA/DDATA payload. A publisher that emits NDATA without a prior NBIRTH violates SparkplugB v3.0 §4.2 \u2014 raise 'sparkplug-birth-missing'.
- EtherCAT IRT (Isochronous Real-Time) cycle times require < 1 µs jitter. Any OS sleep call (usleep, nanosleep, vTaskDelay) inside an EtherCAT cycle handler violates IEC 61784-2 \u2014 raise 'ethercat-timing-violation'.
- TSN deployments that use IEEE 802.1Qbv Time-Aware Shaper MUST verify IEEE 802.1AS-2020 gPTP synchronisation before transmitting scheduled traffic \u2014 raise 'tsn-gptp-missing' if synchronisation check is absent.
- IEC 62443 zone/conduit isolation: OT devices in different security zones must communicate via conduit devices only \u2014 never direct IP routing across zone boundaries.
- PROFINET station names and IP addresses must be assigned via DCP/LLDP at runtime \u2014 never hardcoded \u2014 raise 'profinet-station-hardcoded'.

### Translation conventions
- IEC 61131-3 ST/LD programs translate to structured C++ with PREEMPT_RT scheduling and shared-memory IPC.
- CANopen SDO timeouts must be handled at every node \u2014 missing timeout handling risks bus stall on error.
- Use OPC-UA PubSub (IEC 62541-14) for time-sensitive data \u2014 never polling-based read/write cycles in production.
`.trim(),
};


// \u2500\u2500\u2500 Registry \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const ALL_PROFILES: ISectorProfile[] = [
	FIRMWARE,
	AUTOMOTIVE,
	ENERGY,
	TELECOM,
	IIOT,
];

/** Pattern-based detection: maps a migration pattern ID string to a sector profile. */
const PATTERN_DETECTORS: Array<{ regex: RegExp; sectorId: SectorId }> = [
	{ regex: /autosar|iso.?26262|can.dbc|some.?ip|aspice|un.r/i,                                   sectorId: 'automotive' },
	{ regex: /iec.?61850|goose|dnp3|nerc.?cip|scada|iec.?62443.*energy|sil|iec.?61511/i,           sectorId: 'energy'     },
	{ regex: /3gpp|lte|5g|oran|ecpri|ttcn|gsma|ss7|diameter|voip.?core/i,                          sectorId: 'telecom'    },
	{ regex: /ethercat|profinet|canopen|opcua|sparkplug|tsn|iiot|iec.?61131|codesys|plc.to.linux/i, sectorId: 'iiot'       },
	{ regex: /firmware|rtos|freertos|zephyr|misra|embedded|mcu|hal|bare.?metal|iec.?61508/i,        sectorId: 'firmware'   },
];


// \u2500\u2500\u2500 Public API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Detect the sector profile from a migration pattern ID string.
 * Returns `undefined` when no sector matches (general/custom migration).
 */
export function getSectorProfile(migrationPatternId: string): ISectorProfile | undefined {
	for (const { regex, sectorId } of PATTERN_DETECTORS) {
		if (regex.test(migrationPatternId)) {
			return ALL_PROFILES.find(p => p.id === sectorId);
		}
	}
	return undefined;
}

/**
 * Look up a sector profile by its stable ID.
 */
export function getSectorProfileById(id: SectorId): ISectorProfile {
	return ALL_PROFILES.find(p => p.id === id)!;
}

/**
 * Return all registered sector profiles.
 */
export function getAllSectorProfiles(): ISectorProfile[] {
	return [...ALL_PROFILES];
}

/**
 * Build the compact sector label string used in system prompt injections.
 * Mirrors the inline regex previously duplicated across powerModeService.ts,
 * convertToLLMMessageService.ts, etc.
 */
export function getSectorLabel(migrationPatternId: string): string {
	const profile = getSectorProfile(migrationPatternId);
	return profile ? `${profile.label}` : 'General';
}
