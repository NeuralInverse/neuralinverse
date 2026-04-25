/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Compliance gate verification.
 *
 * Before a unit can be moved to 'approved' in regulated domains, it must pass a
 * set of compliance requirements. Each requirement is either:
 *   - auto-checkable  (e.g. "fingerprint comparison passed", "test coverage \u2265 80%")
 *   - human-required  (e.g. "sign-off by compliance officer", "legal review")
 *
 * The gate result is cached in ext and re-evaluated on every call.
 * A unit in a regulated domain with a FAIL gate is blocked from approval.
 */

import {
	IComplianceGateResult,
	IComplianceRequirement,
	IKnowledgeUnit,
	IBusinessDomain,
} from '../../../common/knowledgeBaseTypes.js';

// \u2500\u2500\u2500 Gate store \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IGateStore {
	/** Most recent gate result per unit */
	gateResults: Map<string, IComplianceGateResult>; // unitId \u2192 result
}

export function createGateStore(): IGateStore {
	return { gateResults: new Map() };
}

// \u2500\u2500\u2500 Default requirements builder \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Build the default compliance requirements for a unit based on its domain.
 * In a real deployment this would be driven by the GRC framework configuration.
 * Here we provide sensible defaults for regulated vs. unregulated domains.
 */
function buildRequirementsFor(
	unit: IKnowledgeUnit,
	domain: IBusinessDomain | undefined,
): IComplianceRequirement[] {
	const reqs: IComplianceRequirement[] = [];

	// Every unit: fingerprint comparison must be present
	reqs.push({
		id:          'req-fingerprint',
		label:       'Compliance fingerprint comparison',
		description: 'A semantic compliance fingerprint comparison must have been recorded for this unit.',
		kind:        'auto',
		status:      unit.fingerprintComparison ? 'pass' : 'fail',
		evidence:    unit.fingerprintComparison ? `comparison.matchPercentage=${unit.fingerprintComparison.matchPercentage}` : undefined,
	});

	// Every unit: at least one approval record
	reqs.push({
		id:          'req-approval',
		label:       'Translation approved by reviewer',
		description: 'At least one approval record must exist for this unit.',
		kind:        'auto',
		status:      (unit.approvals?.length ?? 0) > 0 ? 'pass' : 'fail',
		evidence:    unit.approvals?.[0] ? `approved by ${unit.approvals[0].approvedBy}` : undefined,
	});

	if (domain?.regulated) {
		// Regulated domain: equivalence check must pass
		reqs.push({
			id:          'req-equivalence',
			label:       'Semantic equivalence verified',
			description: 'Equivalence result must be stored and must report zero failures.',
			kind:        'auto',
			status:      (unit.equivalenceResult?.failCount ?? 1) === 0 && !unit.equivalenceResult?.overridden ? 'pass' : 'fail',
			evidence:    unit.equivalenceResult ? `failCount=${unit.equivalenceResult.failCount}, overridden=${unit.equivalenceResult.overridden}` : undefined,
		});

		// Regulated domain: human sign-off required (fingerprint-change approval = compliance officer gate)
		const hasComplianceApproval = (unit.approvals ?? []).some(a => a.approvalType === 'fingerprint-change');
		reqs.push({
			id:          'req-compliance-officer',
			label:       'Compliance officer sign-off',
			description: 'A compliance officer must have approved this unit.',
			kind:        'human-required',
			status:      hasComplianceApproval ? 'pass' : 'pending',
			evidence:    hasComplianceApproval ? 'compliance-officer approval on record' : undefined,
		});

		// \u2500\u2500 Market vertical-specific gates \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const frameworks = (domain.complianceFrameworks ?? []).map((f: string) => f.toLowerCase());

		// Automotive (ISO 26262 / AUTOSAR)
		if (frameworks.some(f => f.includes('iso-26262') || f.includes('autosar'))) {
			// ASIL-D units require formal verification evidence (model checker or static proof)
			const hasAsilVerification = (unit.approvals ?? []).some(a =>
				a.approvalType === 'plan' && a.rationale.toLowerCase().includes('asil'),
			);
			reqs.push({
				id:          'req-asil-formal-verification',
				label:       'ASIL-D formal verification evidence',
				description:
					'For ASIL-D rated units, formal verification evidence (model checking, ' +
					'abstract interpretation, or theorem proving) must be on record per ISO 26262-6 §7.4.7.',
				kind:        'human-required',
				status:      hasAsilVerification ? 'pass' : 'pending',
				evidence:    hasAsilVerification ? 'ASIL-D formal verification approval on record' : undefined,
			});
			// E2E protection profile must be configured
			const hasE2EApproval = (unit.approvals ?? []).some(a =>
				a.approvalType === 'plan' && /e2e|end.to.end/i.test(a.rationale),
			);
			reqs.push({
				id:          'req-e2e-protection-profile',
				label:       'AUTOSAR E2E protection profile verified',
				description:
					'All ASIL-rated inter-SWC signals must have an E2E protection profile (CRC + counter) ' +
					'configured in the target AUTOSAR manifest per AUTOSAR SWS_E2ELibrary §7.3.',
				kind:        'human-required',
				status:      hasE2EApproval ? 'pass' : 'pending',
				evidence:    hasE2EApproval ? 'E2E profile approval on record' : undefined,
			});
		}

		// Energy / Critical Infrastructure (IEC 61850 / IEC 61511 / IEC 61508)
		if (frameworks.some(f => f.includes('iec-61850') || f.includes('iec-61511') || f.includes('iec-61508'))) {
			// GOOSE protection path: must NOT route through OPC-UA or MQTT
			const hasGoosePathApproval = (unit.approvals ?? []).some(a =>
				a.approvalType === 'plan' && /goose|protection.relay/i.test(a.rationale),
			);
			reqs.push({
				id:          'req-goose-path-isolation',
				label:       'IEC 61850 GOOSE protection path must not bridge to OPC-UA',
				description:
					'Protection relay GOOSE trip commands must remain on native IEC 61850 GOOSE. ' +
					'Bridging to OPC-UA or MQTT cannot guarantee < 4 ms latency required by IEC 61850-5 Class P5/P6. ' +
					'A grid protection engineer must confirm this path is unmodified.',
				kind:        'human-required',
				status:      hasGoosePathApproval ? 'pass' : 'pending',
				evidence:    hasGoosePathApproval ? 'GOOSE path isolation confirmed by protection engineer' : undefined,
			});
			// SIL verification document
			const hasSilVerification = (unit.approvals ?? []).some(a =>
				a.approvalType === 'plan' && /sil.verif|iec.6151[18]/i.test(a.rationale),
			);
			reqs.push({
				id:          'req-sil-verification-report',
				label:       'SIL verification report (IEC 61511-1 §11)',
				description:
					'A SIL verification calculation must be on record for all SIS/ESD functions, ' +
					'confirming the modernised target achieves the required SIL level per IEC 61511-1 §11.',
				kind:        'human-required',
				status:      hasSilVerification ? 'pass' : 'pending',
				evidence:    hasSilVerification ? 'SIL verification report sign-off on record' : undefined,
			});
		}

		// Telecom (3GPP / GSMA)
		if (frameworks.some(f => f.includes('3gpp') || f.includes('gsma') || f.includes('iec-62443'))) {
			// Security key material must be externalized
			const hasKeyMaterialClearance = (unit.approvals ?? []).some(a =>
				a.approvalType === 'plan' && /key.material|hsm|tee|suci/i.test(a.rationale),
			);
			reqs.push({
				id:          'req-key-material-externalised',
				label:       '3GPP security key material externalised (HSM/TEE)',
				description:
					'All AS/NAS/RRC cryptographic key material must be managed by an HSM or TEE. ' +
					'No key derivation material may appear in source code or configuration files ' +
					'per 3GPP TS 33.501 §6.2 Key Hierarchy.',
				kind:        'human-required',
				status:      hasKeyMaterialClearance ? 'pass' : 'pending',
				evidence:    hasKeyMaterialClearance ? 'Key externalisation confirmed on record' : undefined,
			});
			// TTCN-3 verdict traceability
			const hasTtcnVerdictApproval = (unit.approvals ?? []).some(a =>
				a.approvalType === 'plan' && /ttcn|verdict|inconc/i.test(a.rationale),
			);
			if (unit.sourceLang === 'ttcn3') {
				reqs.push({
					id:          'req-ttcn3-verdict-traceability',
					label:       'TTCN-3 INCONC verdict traceability to 3GPP TS',
					description:
						'Every INCONC verdict in the source TTCN-3 must be replaced with an explicit ' +
						'pytest.skip() or Robot Framework SKIP call with a documented 3GPP TS clause reference. ' +
						'Required for compliance with GSMA PRD FS.13 test evidence format.',
					kind:        'human-required',
					status:      hasTtcnVerdictApproval ? 'pass' : 'pending',
					evidence:    hasTtcnVerdictApproval ? 'Verdict traceability review on record' : undefined,
				});
			}
		}

		// Industrial IoT / OT (IEC 62443)
		if (frameworks.some(f => f.includes('iec-62443') || f.includes('iiot') || f.includes('ot'))) {
			// OT network zone isolation
			const hasZoneIsolationApproval = (unit.approvals ?? []).some(a =>
				a.approvalType === 'plan' && /zone|conduit|iec.62443/i.test(a.rationale),
			);
			reqs.push({
				id:          'req-ot-zone-conduit-isolation',
				label:       'IEC 62443 OT zone/conduit isolation verified',
				description:
					'All OT-to-IT data flows introduced by this unit must pass through a documented ' +
					'IEC 62443-3-3 Security Level conduit (IDMZ or unidirectional data diode). ' +
					'Direct OT-to-cloud paths without conduit control are prohibited.',
				kind:        'human-required',
				status:      hasZoneIsolationApproval ? 'pass' : 'pending',
				evidence:    hasZoneIsolationApproval ? 'Zone/conduit isolation verification on record' : undefined,
			});
		}

		// \u2500\u2500 Telecom & 5G (3GPP / GSMA NESAS) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		if (frameworks.some(f => f.includes('3gpp') || f.includes('gsma') || f.includes('etsi-nfv') || f.includes('o-ran'))) {

			// 5G NF deployment security checklist \u2014 GSMA NESAS FS.13
			const hasNfSecurityApproval = (unit.approvals ?? []).some(a =>
				a.approvalType === 'plan' && /nesas|nf.security|5g.sec|gsma.scas/i.test(a.rationale),
			);
			reqs.push({
				id:          'req-gsma-nesas-scas',
				label:       'GSMA NESAS SCAS security assessment (FS.13)',
				description:
					'For 5G NF deployments, a GSMA NESAS Network Product Class security assessment must be on record. ' +
					'This validates that the NF meets GSMA FS.13 / 3GPP TS 33.117 security baseline requirements.',
				kind:        'human-required',
				status:      hasNfSecurityApproval ? 'pass' : 'pending',
				evidence:    hasNfSecurityApproval ? 'GSMA NESAS SCAS approval on record' : undefined,
			});

			// eCPRI / O-RAN fronthaul latency compliance
			const hasOranFhApproval = (unit.approvals ?? []).some(a =>
				a.approvalType === 'plan' && /oran|ecpri|fronthaul|timing.class|gPTP|802\.1AS/i.test(a.rationale),
			);
			reqs.push({
				id:          'req-oran-fronthaul-timing',
				label:       'O-RAN fronthaul timing class validation (IEC/IEEE 60802)',
				description:
					'O-RAN Option 7-2x eCPRI fronthaul must meet timing class requirements: Class B (\u2264 100 µs one-way) ' +
					'per O-RAN.WG4.CUS.0 and IEC/IEEE 60802. IEEE 802.1AS gPTP must be verified on all fronthaul ports.',
				kind:        'human-required',
				status:      hasOranFhApproval ? 'pass' : 'pending',
				evidence:    hasOranFhApproval ? 'O-RAN fronthaul timing validation on record' : undefined,
			});

			// Network slicing isolation
			if (frameworks.some(f => f.includes('network-slicing') || f.includes('3gpp-ran'))) {
				const hasSlicingApproval = (unit.approvals ?? []).some(a =>
					a.approvalType === 'plan' && /slice|nssai|s-nssai|network.slice/i.test(a.rationale),
				);
				reqs.push({
					id:          'req-network-slice-isolation',
					label:       'Network slice isolation verification (3GPP TS 28.530)',
					description:
						'Where network slicing is implemented, slice isolation (data plane and control plane) ' +
						'must be verified per 3GPP TS 28.530 and ETSI TS 128.530.',
					kind:        'human-required',
					status:      hasSlicingApproval ? 'pass' : 'pending',
					evidence:    hasSlicingApproval ? 'Slice isolation verification on record' : undefined,
				});
			}
		}

		// \u2500\u2500 TTCN-3 / Protocol Testing Compliance (GSMA PRD FS.13 / 3GPP TS 36.523) \u2500\u2500
		if (unit.sourceLang === 'ttcn3' || frameworks.some(f => f.includes('gsma-prd-fs13'))) {
			const hasTtcnGsmaCoverage = (unit.approvals ?? []).some(a =>
				a.approvalType === 'plan' && /ttcn|gsma.fs.13|36\.523|38\.523|prd.fs/i.test(a.rationale),
			);
			reqs.push({
				id:          'req-ttcn3-gsma-coverage',
				label:       'GSMA PRD FS.13 test evidence format compliance',
				description:
					'All migrated test modules must produce GSMA PRD FS.13-compliant test evidence: ' +
					'every INCONC verdict replaced with pytest.skip() / Robot SKIP with 3GPP TS clause reference, ' +
					'and GCF/PTCRB verdict traceability matrix produced.',
				kind:        'human-required',
				status:      hasTtcnGsmaCoverage ? 'pass' : 'pending',
				evidence:    hasTtcnGsmaCoverage ? 'GSMA PRD FS.13 coverage review on record' : undefined,
			});
		}

		// \u2500\u2500 Industrial IoT / OT Extended (IEC 62061 / ISO 13849 / EtherCAT / Profinet) \u2500\u2500
		if (frameworks.some(f => f.includes('iec-62061') || f.includes('iso-13849') || f.includes('profibus-profinet') || f.includes('odva-cip'))) {

			// IEC 62061 safety function validation
			const hasSafetyFunctionApproval = (unit.approvals ?? []).some(a =>
				a.approvalType === 'plan' && /iec.62061|iso.13849|PLc|safety.function|sf_emergency|ple/i.test(a.rationale),
			);
			reqs.push({
				id:          'req-iec62061-safety-function',
				label:       'IEC 62061 / ISO 13849 safety function verification',
				description:
					'All machine safety functions (Emergency Stop, Safety Guard, Speed Monitoring) must be ' +
					'verified per IEC 62061 SIL or ISO 13849-1 PLe, including diagnostic coverage calculation ' +
					'and MTTF_d documentation for each safety function block.',
				kind:        'human-required',
				status:      hasSafetyFunctionApproval ? 'pass' : 'pending',
				evidence:    hasSafetyFunctionApproval ? 'IEC 62061 safety function verification on record' : undefined,
			});

			// EtherCAT / Profinet RT validation
			const hasFieldbusApproval = (unit.approvals ?? []).some(a =>
				a.approvalType === 'plan' && /ethercat|profinet|canopen|ethernet.ip|fieldbus.validation/i.test(a.rationale),
			);
			reqs.push({
				id:          'req-fieldbus-rt-validation',
				label:       'Real-time fieldbus cycle time validation (EtherCAT / Profinet IRT)',
				description:
					'EtherCAT or Profinet IRT cycle times must be validated on target hardware against ' +
					'application requirements. For EtherCAT IRT: jitter \u2264 1 µs. For Profinet CC-C IRT: \u2264 1 ms cycle time.',
				kind:        'human-required',
				status:      hasFieldbusApproval ? 'pass' : 'pending',
				evidence:    hasFieldbusApproval ? 'Fieldbus RT cycle time validation on record' : undefined,
			});

			// TSN validation if enabled
			if (frameworks.some(f => f.includes('tsn-iec60802') || f.includes('opc-ua-spec'))) {
				const hasTsnApproval = (unit.approvals ?? []).some(a =>
					a.approvalType === 'plan' && /tsn|802\.1qbv|802\.1as|gptp|taprio|iec.60802/i.test(a.rationale),
				);
				reqs.push({
					id:          'req-tsn-gptp-synchronisation',
					label:       'IEEE 802.1AS (gPTP) synchronisation verified for TSN deployment',
					description:
						'Time-Sensitive Networking deployments require IEEE 802.1AS-2020 gPTP synchronisation ' +
						'to be validated across all TSN-capable switches and endpoints. ' +
						'Grandmaster clock quality must meet ITU-T G.8272.1 PRTC Class A (\u2264 100 ns).',
					kind:        'human-required',
					status:      hasTsnApproval ? 'pass' : 'pending',
					evidence:    hasTsnApproval ? 'gPTP / TSN synchronisation validation on record' : undefined,
				});
			}
		}

		// \u2500\u2500 Critical Infrastructure Extended (NERC CIP / IEC 62351 / Oil & Gas) \u2500\u2500\u2500\u2500\u2500\u2500
		if (frameworks.some(f => f.includes('nerc-cip') || f.includes('iec-62351') || f.includes('api-std-1164') || f.includes('nist-sp-800-82'))) {

			// NERC CIP supply chain risk management
			const hasNercCipApproval = (unit.approvals ?? []).some(a =>
				a.approvalType === 'plan' && /nerc.cip|cip.013|supply.chain|bes.cyber/i.test(a.rationale),
			);
			reqs.push({
				id:          'req-nerc-cip-supply-chain',
				label:       'NERC CIP-013-2 supply chain risk management verification',
				description:
					'For BES Cyber Systems, CIP-013-2 requires a supply chain risk management plan ' +
					'covering software integrity verification, vendor risk assessment, and notification procedures. ' +
					'All modernised software must be verified against a trusted software bill of materials (SBOM).',
				kind:        'human-required',
				status:      hasNercCipApproval ? 'pass' : 'pending',
				evidence:    hasNercCipApproval ? 'NERC CIP-013-2 supply chain review on record' : undefined,
			});

			// IEC 62351 communication security
			const hasIec62351Approval = (unit.approvals ?? []).some(a =>
				a.approvalType === 'plan' && /iec.62351|tls.1\.3|dnp3.sav5|61850.security|power.system.comms/i.test(a.rationale),
			);
			reqs.push({
				id:          'req-iec62351-comms-security',
				label:       'IEC 62351 power system communications security verification',
				description:
					'All power system communication protocols (IEC 60870-5-104, IEC 61850 MMS, DNP3) must be ' +
					'secured per IEC 62351: TLS 1.3 for TCP-based protocols, SAv5 for DNP3, and RBAC (Part 8) ' +
					'for OPC-UA. Security profile verification report required.',
				kind:        'human-required',
				status:      hasIec62351Approval ? 'pass' : 'pending',
				evidence:    hasIec62351Approval ? 'IEC 62351 communications security verification on record' : undefined,
			});
		}

		// \u2500\u2500 Automotive Extended (ASPICE / ISO 21434 / UN R155) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		if (frameworks.some(f => f.includes('aspice') || f.includes('iso-21434') || f.includes('un-r155') || f.includes('un-r156') || f.includes('iatf-16949'))) {

			// ISO 21434 TARA (Threat Analysis and Risk Assessment)
			const hasTaraApproval = (unit.approvals ?? []).some(a =>
				a.approvalType === 'plan' && /tara|iso.21434|un.r155|csms|threat.analysis|risk.assessment/i.test(a.rationale),
			);
			reqs.push({
				id:          'req-iso21434-tara',
				label:       'ISO 21434 / UN R155 Threat Analysis and Risk Assessment (TARA)',
				description:
					'For in-vehicle software, a TARA per ISO 21434 §9 must be conducted on the modernised unit. ' +
					'All cybersecurity goals and claims must be traced to the CSMS (Cybersecurity Management System) ' +
					'per UN Regulation 155.',
				kind:        'human-required',
				status:      hasTaraApproval ? 'pass' : 'pending',
				evidence:    hasTaraApproval ? 'ISO 21434 TARA approval on record' : undefined,
			});

			// A-SPICE process compliance
			const hasAspiceApproval = (unit.approvals ?? []).some(a =>
				a.approvalType === 'plan' && /aspice|a-spice|spice|process.assessment|pal.2|pal.3/i.test(a.rationale),
			);
			reqs.push({
				id:          'req-aspice-process',
				label:       'Automotive SPICE (A-SPICE v3.1) process compliance',
				description:
					'Automotive software development must follow A-SPICE Level 2 minimum (MAN.3, SYS.2\u20135, SWE.1\u20136). ' +
					'Process assessment evidence must be attached to each migration unit for OEM supplier approval.',
				kind:        'human-required',
				status:      hasAspiceApproval ? 'pass' : 'pending',
				evidence:    hasAspiceApproval ? 'A-SPICE process assessment on record' : undefined,
			});

			// UN R156 OTA update security
			if (frameworks.some(f => f.includes('un-r156'))) {
				const hasOtaApproval = (unit.approvals ?? []).some(a =>
					a.approvalType === 'plan' && /un.r156|ota|sums|software.update|fota|delta.update/i.test(a.rationale),
				);
				reqs.push({
					id:          'req-un-r156-ota',
					label:       'UN R156 Software Update Management System (SUMS) compliance',
					description:
						'If the modernised unit is deployable via OTA update, it must comply with UN Regulation 156 ' +
						'SUMS requirements: cryptographic signing of update packages, rollback capability, ' +
						'and secure update channel verification.',
					kind:        'human-required',
					status:      hasOtaApproval ? 'pass' : 'pending',
					evidence:    hasOtaApproval ? 'UN R156 SUMS OTA compliance review on record' : undefined,
				});
			}
		}

		// \u2500\u2500 Avionics / Railway (DO-178C / EN 50128) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		if (frameworks.some(f => f.includes('do-178c') || f.includes('do-254') || f.includes('en-50128') || f.includes('arinc-653'))) {

			// DO-178C / EN 50128 independence requirements
			const hasIndependenceApproval = (unit.approvals ?? []).some(a =>
				a.approvalType === 'plan' && /do.178|en.50128|dv|independent.review|mc.dc|statement.of.compliance/i.test(a.rationale),
			);
			reqs.push({
				id:          'req-do178c-independence',
				label:       'DO-178C / EN 50128 independent review and MC/DC coverage',
				description:
					'Safety-critical avionics (DO-178C DAL A/B) and railway software (EN 50128 SIL 3/4) require: ' +
					'(1) Independent Verification & Validation (IV&V), ' +
					'(2) MC/DC (Modified Condition/Decision Coverage) test evidence for DAL A, ' +
					'(3) Statement of Compliance from a DER or NoBo.',
				kind:        'human-required',
				status:      hasIndependenceApproval ? 'pass' : 'pending',
				evidence:    hasIndependenceApproval ? 'DO-178C / EN 50128 independent review on record' : undefined,
			});
		}
	}

	return reqs;
}

// \u2500\u2500\u2500 Gate evaluation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function checkComplianceGate(
	store: IGateStore,
	unit: IKnowledgeUnit,
	domain: IBusinessDomain | undefined,
): IComplianceGateResult {
	const requirements = buildRequirementsFor(unit, domain);

	const failed   = requirements.filter(r => r.status === 'fail');
	const pending  = requirements.filter(r => r.status === 'pending');
	const passed   = requirements.filter(r => r.status === 'pass');
	const waived   = requirements.filter(r => r.status === 'waived');

	let overallStatus: IComplianceGateResult['overallStatus'];
	if (failed.length > 0) {
		overallStatus = 'fail';
	} else if (pending.length > 0) {
		overallStatus = 'partial';
	} else {
		overallStatus = 'pass';
	}

	const result: IComplianceGateResult = {
		unitId:        unit.id,
		overallStatus,
		requirements,
		evaluatedAt:   Date.now(),
		failedCount:   failed.length,
		passedCount:   passed.length,
		pendingCount:  pending.length,
		waivedCount:   waived.length,
		blockerReasons: failed.map(r => r.label),
	};

	store.gateResults.set(unit.id, result);
	return result;
}

// \u2500\u2500\u2500 Manual approval recording \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Record a human compliance approval for a specific requirement.
 * Updates the stored gate result.
 */
export function recordComplianceApproval(
	store: IGateStore,
	unitId: string,
	requirementId: string,
	approver: string,
	evidence?: string,
): void {
	const result = store.gateResults.get(unitId);
	if (!result) { return; }

	const updatedReqs = result.requirements.map(req => {
		if (req.id !== requirementId) { return req; }
		return {
			...req,
			status:  'pass' as const,
			evidence: evidence ?? `approved by ${approver} at ${new Date().toISOString()}`,
		};
	});

	// Recompute overall
	const failed  = updatedReqs.filter(r => r.status === 'fail');
	const pending = updatedReqs.filter(r => r.status === 'pending');
	const passed  = updatedReqs.filter(r => r.status === 'pass');
	const waived  = updatedReqs.filter(r => r.status === 'waived');

	const overallStatus: IComplianceGateResult['overallStatus'] =
		failed.length > 0 ? 'fail' :
		pending.length > 0 ? 'partial' :
		'pass';

	store.gateResults.set(unitId, {
		...result,
		requirements:   updatedReqs,
		overallStatus,
		failedCount:    failed.length,
		passedCount:    passed.length,
		pendingCount:   pending.length,
		waivedCount:    waived.length,
		blockerReasons: failed.map(r => r.label),
		evaluatedAt:    Date.now(),
	});
}

// \u2500\u2500\u2500 Waiver \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Waive a specific compliance requirement for a unit.
 * A waived requirement does not count as failed \u2014 the gate can still pass.
 * Use for requirements that are known to be inapplicable or formally exempted.
 */
export function waiveComplianceRequirement(
	store: IGateStore,
	unitId: string,
	requirementId: string,
	waivedBy: string,
	reason: string,
): void {
	const result = store.gateResults.get(unitId);
	if (!result) { return; }

	const updatedReqs = result.requirements.map(req => {
		if (req.id !== requirementId) { return req; }
		return {
			...req,
			status:   'waived' as const,
			evidence: `waived by ${waivedBy}: ${reason}`,
		};
	});

	// Recompute overall \u2014 waived requirements do not count as failed
	const failed  = updatedReqs.filter(r => r.status === 'fail');
	const pending = updatedReqs.filter(r => r.status === 'pending');
	const passed  = updatedReqs.filter(r => r.status === 'pass');
	const waived  = updatedReqs.filter(r => r.status === 'waived');

	const overallStatus: IComplianceGateResult['overallStatus'] =
		failed.length  > 0 ? 'fail'    :
		pending.length > 0 ? 'partial' :
		'pass';

	store.gateResults.set(unitId, {
		...result,
		requirements:   updatedReqs,
		overallStatus,
		failedCount:    failed.length,
		passedCount:    passed.length,
		pendingCount:   pending.length,
		waivedCount:    waived.length,
		blockerReasons: failed.map(r => r.label),
		evaluatedAt:    Date.now(),
	});
}


// \u2500\u2500\u2500 Queries \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function getComplianceGateFailures(
	store: IGateStore,
): Array<{ unitId: string; result: IComplianceGateResult }> {
	const result: Array<{ unitId: string; result: IComplianceGateResult }> = [];
	for (const gateResult of store.gateResults.values()) {
		if (gateResult.overallStatus === 'fail' || gateResult.overallStatus === 'partial') {
			result.push({ unitId: gateResult.unitId, result: gateResult });
		}
	}
	return result;
}
