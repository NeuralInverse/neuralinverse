/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Telecom Security Analyzer
 *
 * Executes `type: "telecom-security"` rules against source files.
 *
 * ## Coverage
 *
 * Detects 9 classes of telecom / 5G infrastructure security violations:
 *
 * | detect value              | Description                                               |
 * |---------------------------|-----------------------------------------------------------|
 * | imsi-plaintext-log        | IMSI/SUPI/MSISDN logged or transmitted in plaintext       |
 * | sip-header-injection      | Unsanitized data inserted into SIP headers               |
 * | gtp-missing-validation    | GTP-U/GTP-C tunnel without TEID/source validation        |
 * | nas-unprotected           | NAS message sent without integrity/confidentiality       |
 * | diameter-no-tls           | Diameter Ro/Rf/S6a connection without TLS/IPsec          |
 * | ss7-unfiltered            | SS7 MAP/ISUP processing without firewall checks          |
 * | suci-concealment-skip     | SUPI transmitted without SUCI concealment (5G NR)        |
 * | ki-plaintext              | Authentication key (Ki/K/AUTN) in plaintext              |
 * | lawful-intercept-gap      | LI trigger path disabled or bypassed                     |
 *
 * ## False-positive suppression
 *
 * - Test files (paths containing `/test`, `__test__`, `.spec.`, `.test.`) are
 *   skipped unless the check's `includeTests` flag is explicitly set.
 * - Comment-only lines are stripped before pattern matching.
 * - Block comments `/* ... *\/` are blanked before scanning so patterns
 *   inside multi-line comments do not fire.
 *
 * ## Applies to
 *
 * All languages (no `supportedLanguages` restriction). Pattern matching is
 * case-insensitive throughout.
 */

import { ITextModel } from '../../../../../../editor/common/model.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IGRCRule, ICheckResult, toDisplaySeverity } from '../types/grcTypes.js';
import { IRuleAnalyzer } from '../services/grcEngineService.js';
import { INanoAgentContext } from '../../nanoAgents/projectAnalyzerService.js';


// \u2500\u2500\u2500 Local check interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Structured check definition for `type: "telecom-security"` rules.
 * This lives locally until it is promoted into frameworkSchema.ts.
 */
interface ITelecomSecurityCheck {
	type: 'telecom-security';
	detect:
	| 'imsi-plaintext-log'
	| 'sip-header-injection'
	| 'gtp-missing-validation'
	| 'nas-unprotected'
	| 'diameter-no-tls'
	| 'ss7-unfiltered'
	| 'suci-concealment-skip'
	| 'ki-plaintext'
	| 'lawful-intercept-gap';
	/** When true, test files are also scanned. Default: false. */
	includeTests?: boolean;
}


// \u2500\u2500\u2500 Context-window helper \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** Lines within ±N of a target line (inclusive), clamped to array bounds. */
function contextWindow(lines: string[], center: number, radius: number): string {
	const start = Math.max(0, center - radius);
	const end = Math.min(lines.length - 1, center + radius);
	return lines.slice(start, end + 1).join('\n').toLowerCase();
}


// \u2500\u2500\u2500 Telecom Security Analyzer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class TelecomSecurityAnalyzer implements IRuleAnalyzer {
	readonly supportedTypes = ['telecom-security'];

	// No supportedLanguages \u2014 applies to all language IDs.


	// \u2500\u2500\u2500 IRuleAnalyzer: evaluate (open model) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	public evaluate(
		rule: IGRCRule,
		model: ITextModel,
		fileUri: URI,
		timestamp: number,
		_context?: INanoAgentContext
	): ICheckResult[] {
		const lines = model.getLinesContent();
		return this._run(rule, lines, fileUri, model.getLanguageId(), timestamp);
	}


	// \u2500\u2500\u2500 IRuleAnalyzer: evaluateContent (background scan) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	public evaluateContent(
		rule: IGRCRule,
		content: string,
		fileUri: URI,
		languageId: string,
		timestamp: number
	): ICheckResult[] {
		const lines = content.split('\n');
		return this._run(rule, lines, fileUri, languageId, timestamp);
	}


	// \u2500\u2500\u2500 Core dispatch \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _run(
		rule: IGRCRule,
		lines: string[],
		fileUri: URI,
		_languageId: string,
		timestamp: number
	): ICheckResult[] {
		const check = rule.check as ITelecomSecurityCheck | undefined;
		if (!check || check.type !== 'telecom-security') return [];

		// Skip test files by default
		if (!check.includeTests && this._isTestFile(fileUri.path)) return [];

		// Strip block comments from a working copy so multi-line /* */ blocks
		// do not produce false positives.
		const cleaned = this._stripBlockComments(lines);

		switch (check.detect) {
			case 'imsi-plaintext-log':       return this._checkImsiPlaintextLog(rule, cleaned, lines, fileUri, timestamp);
			case 'sip-header-injection':     return this._checkSipHeaderInjection(rule, cleaned, lines, fileUri, timestamp);
			case 'gtp-missing-validation':   return this._checkGtpMissingValidation(rule, cleaned, lines, fileUri, timestamp);
			case 'nas-unprotected':          return this._checkNasUnprotected(rule, cleaned, lines, fileUri, timestamp);
			case 'diameter-no-tls':          return this._checkDiameterNoTls(rule, cleaned, lines, fileUri, timestamp);
			case 'ss7-unfiltered':           return this._checkSs7Unfiltered(rule, cleaned, lines, fileUri, timestamp);
			case 'suci-concealment-skip':    return this._checkSuciConcealmentSkip(rule, cleaned, lines, fileUri, timestamp);
			case 'ki-plaintext':             return this._checkKiPlaintext(rule, cleaned, lines, fileUri, timestamp);
			case 'lawful-intercept-gap':     return this._checkLawfulInterceptGap(rule, cleaned, lines, fileUri, timestamp);
			default:                         return [];
		}
	}


	// \u2500\u2500\u2500 Detector: imsi-plaintext-log \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _checkImsiPlaintextLog(
		rule: IGRCRule, lines: string[], _raw: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Patterns that write subscriber identities to logs, HTTP responses, or DB
		// without any masking / encryption context nearby.
		const LOG_SINK = /(?:log|printf|print|LOG|console\.log|System\.out\.print|fmt\.Print|NSLog|logger|sprintf|format|f["']|response|json|INSERT|save)\s*[\(.*]?.*?(?:imsi|msisdn|supi|suci|imei|msin|mcc_mnc|subscriber_id|subscriber_identity)/i;
		const DIRECT_FORMAT = /(?:f["'].*?\{(?:imsi|msisdn|supi|suci|imei|msin)\}|format.*(?:imsi|msisdn|supi))/i;
		const HTTP_RESPONSE = /response.*(?:imsi|msisdn|supi)|json.*(?:imsi|msisdn|supi).*send/i;
		const DB_INSERT = /INSERT\s+INTO.*(?:imsi|msisdn|supi)|save.*(?:imsi|msisdn|supi)/i;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentOnly(line)) continue;
			const t = line.trim();

			// Skip lines that mention masking/encryption \u2014 low false-positive filter
			if (/mask|encrypt|hash|redact|anonymi[sz]/i.test(t)) continue;

			if (LOG_SINK.test(t) || DIRECT_FORMAT.test(t) || HTTP_RESPONSE.test(t) || DB_INSERT.test(t)) {
				results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
					'Subscriber identity (IMSI/MSISDN/SUPI) appears to be logged or stored in plaintext. Mask or omit the identifier.'));
			}
		}

		return results;
	}


	// \u2500\u2500\u2500 Detector: sip-header-injection \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _checkSipHeaderInjection(
		rule: IGRCRule, lines: string[], _raw: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Concatenation near SIP header field names (common injection points)
		const HEADER_CONCAT = /["'](?:From|To|Contact|Via|Route|Record-Route|Call-ID|CSeq|Subject|P-Asserted-Identity)[:"]\s*["']\s*\+/i;
		// Generic SIP build functions with user data
		const SIP_BUILD = /(?:sip_message|buildSIP|sip_header_set|addHeader|setHeader|send_sip)\s*\(.*(?:user|input|param|body|request|uri)/i;
		// CRLF injection markers
		const CRLF_INJECT = /(?:sip|header|uri|from|to).*(?:\\r\\n|%0[dD]%0[aA])/i;
		// Unsanitized concat of user params into SIP fields
		const PARAM_CONCAT = /(?:request\.(?:body|params|query)|params)\s*.*sip/i;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentOnly(line)) continue;
			const t = line.trim();

			// Skip lines that call a sanitizer
			if (/sanitize|escape_sip|sip_sanitize|encodeURIComponent|htmlspecialchars/i.test(t)) continue;

			if (HEADER_CONCAT.test(t) || SIP_BUILD.test(t) || CRLF_INJECT.test(t) || PARAM_CONCAT.test(t)) {
				results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
					'Potential SIP header injection: unsanitized data concatenated into a SIP header field. Sanitize all user-controlled values before inserting into SIP messages.'));
			}
		}

		return results;
	}


	// \u2500\u2500\u2500 Detector: gtp-missing-validation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _checkGtpMissingValidation(
		rule: IGRCRule, lines: string[], _raw: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// GTP operation keywords
		const GTP_OP = /(?:gtp_send|gtp_recv|gtp_tunnel|GTPv[12]|GTPU|upf_handle_pdu|recvfrom.*gtp|recv.*2152)\b/i;
		// TEID / source validation patterns (indicate proper handling)
		const VALID_NEAR = /(?:validate.*teid|check.*teid|verify.*src|allowed_teid|if.*teid.*valid|if.*src_ip.*allowed|if.*peer.*trusted|teid_check|source_validation)/i;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentOnly(line)) continue;
			if (!GTP_OP.test(line)) continue;

			// Look ±10 lines for validation
			const ctx = contextWindow(lines, i, 10);
			if (!VALID_NEAR.test(ctx)) {
				const t = line.trim();
				results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
					'GTP tunnel operation without TEID or source address validation. Verify TEID bounds and peer IP before processing GTP-U/GTP-C packets.'));
			}
		}

		return results;
	}


	// \u2500\u2500\u2500 Detector: nas-unprotected \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _checkNasUnprotected(
		rule: IGRCRule, lines: string[], _raw: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// NAS transmission keywords
		const NAS_OP = /(?:nas_send|send_nas_message|NAS_Message|nas_encode|nas_plain_text|NAS_PLAIN|attach_request|registration_request)\b/i;
		// Security indicators nearby
		const SEC_NEAR = /(?:integrity_protect|ciphering|security_mode|eia[0-9]|eea[0-9]|integrity_algorithm|ciphering_algorithm|integrityProtect\s*=\s*true|SecurityModeCommand)/i;
		// Explicit insecure patterns
		const EXPLICIT_INSECURE = /(?:security_mode.*none|nas.*unprotected|nas.*plain)/i;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentOnly(line)) continue;

			// Flag explicit insecure markers regardless
			if (EXPLICIT_INSECURE.test(line)) {
				const t = line.trim();
				results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
					'NAS message security explicitly disabled or set to plaintext. All NAS messages must be integrity-protected and ciphered per 3GPP TS 33.501.'));
				continue;
			}

			if (!NAS_OP.test(line)) continue;

			// Look ±15 lines for security mode activation
			const ctx = contextWindow(lines, i, 15);
			if (!SEC_NEAR.test(ctx)) {
				const t = line.trim();
				results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
					'NAS message sent without integrity protection or ciphering context. Ensure SecurityModeCommand with EIA/EEA algorithms is applied before transmitting NAS PDUs.'));
			}
		}

		return results;
	}


	// \u2500\u2500\u2500 Detector: diameter-no-tls \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _checkDiameterNoTls(
		rule: IGRCRule, lines: string[], _raw: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Diameter connection keywords
		const DIAM_OP = /(?:diameter_connect|DiameterClient|diameter\.peer|Ro.*connect|Rf.*connect|S6a.*connect|diameter.*tcp.*3868)\b/i;
		// TLS/IPsec indicators nearby
		const TLS_NEAR = /(?:tls_enabled|use_tls|ssl_context|tls_config|SecurityMode\s*[^=]*(?!NONE)|TransportSecurity\s*[^=]*(?!NONE)|ipsec|starttls)/i;
		// Explicit no-security markers
		const EXPLICIT_INSECURE = /(?:TransportSecurity.*NONE|SecurityMode.*NONE)/i;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentOnly(line)) continue;

			if (EXPLICIT_INSECURE.test(line)) {
				const t = line.trim();
				results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
					'Diameter connection security explicitly set to NONE. Diameter Ro/Rf/S6a interfaces must use TLS or IPsec per 3GPP TS 33.210.'));
				continue;
			}

			if (!DIAM_OP.test(line)) continue;

			const ctx = contextWindow(lines, i, 15);
			if (!TLS_NEAR.test(ctx)) {
				const t = line.trim();
				results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
					'Diameter connection established without TLS/IPsec configuration. Secure Diameter interfaces (Ro, Rf, S6a) per 3GPP TS 33.210 section 5.'));
			}
		}

		return results;
	}


	// \u2500\u2500\u2500 Detector: ss7-unfiltered \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _checkSs7Unfiltered(
		rule: IGRCRule, lines: string[], _raw: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// High-risk SS7 MAP operations that must be firewall-guarded
		const SS7_OP = /(?:MAP_Send|MAP_Receive|ss7_process|mtp3_receive|sccp_handle|sendRoutingInfo|AnyTimeInterrogation|SendAuthenticationInfo|InsertSubscriberData|invoke.*MAP)\b/i;
		// Firewall/whitelist indicators nearby
		const FIREWALL_NEAR = /(?:validateSender|checkOriginMNC|allowedPC|allowedGT|whitelistSPC|ss7_firewall|firewall_check|checkOrigin|filterMessage|validateGT)/i;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentOnly(line)) continue;
			if (!SS7_OP.test(line)) continue;

			const ctx = contextWindow(lines, i, 10);
			if (!FIREWALL_NEAR.test(ctx)) {
				const t = line.trim();
				results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
					'SS7 MAP operation processed without origin/whitelist validation. All SS7 messages must pass through a firewall check (allowedPC/allowedGT) to prevent subscriber tracking and interception attacks.'));
			}
		}

		return results;
	}


	// \u2500\u2500\u2500 Detector: suci-concealment-skip \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _checkSuciConcealmentSkip(
		rule: IGRCRule, lines: string[], _raw: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Explicit disable of SUCI concealment
		const DISABLE = /(?:suci_enabled\s*=\s*false|suci\s*=\s*false|USE_SUCI\s+0|null_scheme|NullScheme|protection_scheme\s*[=:]\s*["']?null["']?|conceal\s*=\s*false)/i;
		// Direct SUPI transmission without concealment
		const DIRECT_SUPI = /(?:send.*supi|SUPI.*send.*plain)/i;
		// RegistrationRequest carrying raw SUPI (should be SUCI in 5G NR)
		const REG_SUPI = /RegistrationRequest.*supi(?!.*suci)/i;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentOnly(line)) continue;
			const t = line.trim();

			if (DISABLE.test(t)) {
				results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
					'SUCI concealment disabled or null protection scheme configured. 5G NR requires SUPI to be protected via SUCI concealment (ECIES profile A/B) per 3GPP TS 33.501 section 6.12.2.'));
			} else if (DIRECT_SUPI.test(t) || REG_SUPI.test(t)) {
				// Check that suci_encode or conceal is NOT nearby
				const ctx = contextWindow(lines, i, 8);
				if (!/(?:suci_encode|conceal|ecies|suci_protection)/i.test(ctx)) {
					results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
						'SUPI transmitted without SUCI concealment. Encode the SUPI into a SUCI using the home network public key before transmitting over the air interface.'));
				}
			}
		}

		return results;
	}


	// \u2500\u2500\u2500 Detector: ki-plaintext \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _checkKiPlaintext(
		rule: IGRCRule, lines: string[], _raw: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Variable assignments that directly hold a key value
		const KEY_ASSIGN = /(?:(?:const|let|var|final|#define|Ki|K_value|auth_key|k_amf|k_ausf|opc|op|autn|rand_autn|subscriber_key)\s*[=:]\s*["'`]?)([0-9a-fA-F]{16,}|[A-Za-z0-9+/]{24,}={0,2})(?:["'`]?)/i;
		// Config-file style (YAML/JSON/INI) key literals
		const CONFIG_KEY = /(?:ki|opc|op|auth_key|k_amf|k_ausf|subscriber_key)\s*[=:]\s*["']?[0-9a-fA-F]{16,}["']?/i;
		// Preprocessor macro with key
		const MACRO_KEY = /#define\s+(?:KI|OPC|AUTH_KEY|K_AMF|K_AUSF)\s+["']?[0-9a-fA-F]{16,}["']?/i;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentOnly(line)) continue;
			const t = line.trim();

			// Skip lines that mention environment variables or key stores
			if (/(?:getenv|environ|vault|hsm|keystore|kms|process\.env)/i.test(t)) continue;

			if (KEY_ASSIGN.test(t) || CONFIG_KEY.test(t) || MACRO_KEY.test(t)) {
				results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
					'Authentication key (Ki/K/OPC/K_AMF/K_AUSF) appears to be hardcoded in plaintext. Store authentication keys in an HSM or secure key store, never in source code or config files.'));
			}
		}

		return results;
	}


	// \u2500\u2500\u2500 Detector: lawful-intercept-gap \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _checkLawfulInterceptGap(
		rule: IGRCRule, lines: string[], _raw: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Explicit disable of LI
		const LI_DISABLE = /(?:li_enabled\s*=\s*false|LI_BYPASS\s*=\s*true|lawful_intercept\s*=?\s*disabled|enableLI\s*[=:]\s*["']?0["']?|lawfulIntercept\s*[=:]\s*false)/i;
		// Control flow that bypasses LI
		const LI_BYPASS_FLOW = /(?:if.*li_active.*continue|return.*skip_li|LI_BYPASS)/i;
		// Commented-out LI code is an audit finding
		const LI_COMMENTED = /(?:\/\/\s*li_forward|\/\*\s*lawful_intercept|#\s*li_forward|\/\/\s*LI\s+disabled|lawful.intercept.*disabled)/i;

		for (let i = 0; i < lines.length; i++) {
			// Use the raw (pre-stripping) line for commented-out detection
			const raw = lines[i];
			const t = raw.trim();

			if (LI_COMMENTED.test(t)) {
				results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
					'Lawful Intercept (LI) code appears to be commented out or explicitly disabled. LI trigger paths must remain active and unmodified in production builds. Audit finding logged per ETSI TS 101 671.'));
				continue;
			}

			if (this._isCommentOnly(raw)) continue;

			if (LI_DISABLE.test(t) || LI_BYPASS_FLOW.test(t)) {
				results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
					'Lawful Intercept path is disabled or bypassed. Removing or bypassing LI trigger logic violates ETSI TS 101 671 and CALEA requirements. Restore the LI activation path.'));
			}
		}

		return results;
	}


	// \u2500\u2500\u2500 Result factory \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _makeResult(
		rule: IGRCRule,
		fileUri: URI,
		line: number,
		column: number,
		endLine: number,
		endColumn: number,
		snippet: string,
		timestamp: number,
		detail: string
	): ICheckResult {
		return {
			ruleId:   rule.id,
			domain:   rule.domain,
			severity: toDisplaySeverity(rule.severity),
			message:  `[${rule.id}] ${detail}`,
			fileUri,
			line,
			column,
			endLine,
			endColumn,
			codeSnippet:      snippet.substring(0, 120),
			fix:              rule.fix,
			timestamp,
			frameworkId:      rule.frameworkId,
			references:       rule.references,
			blockingBehavior: rule.blockingBehavior,
			checkSource:      'static',
		};
	}


	// \u2500\u2500\u2500 Utility helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Returns true if the file path looks like a test file. */
	private _isTestFile(filePath: string): boolean {
		const p = filePath.toLowerCase();
		return (
			p.includes('/test/') ||
			p.includes('/tests/') ||
			p.includes('/__tests__/') ||
			p.includes('/__test__/') ||
			p.includes('.spec.') ||
			p.includes('.test.') ||
			p.endsWith('_test.go') ||
			p.endsWith('_spec.rb') ||
			p.endsWith('test.py') ||
			p.includes('/spec/')
		);
	}

	/**
	 * Returns a copy of `lines` with block comment content replaced by spaces
	 * so multi-line `/* \u2026 *\/` comments don't produce false positives.
	 * Preserves line count (newlines inside block comments are kept).
	 */
	private _stripBlockComments(lines: string[]): string[] {
		const content = lines.join('\n');
		const stripped = content.replace(/\/\*[\s\S]*?\*\//g, (match) => {
			// Preserve newlines so line indices remain valid; blank everything else.
			return match.replace(/[^\n]/g, ' ');
		});
		return stripped.split('\n');
	}

	/** True when a line, after trimming, is purely a comment or blank. */
	private _isCommentOnly(line: string): boolean {
		const t = line.trim();
		return (
			t.length === 0 ||
			t.startsWith('//') ||
			t.startsWith('#') ||
			t.startsWith('*') ||
			t.startsWith('/*') ||
			t.startsWith('--') ||
			t.startsWith(';')
		);
	}
}
