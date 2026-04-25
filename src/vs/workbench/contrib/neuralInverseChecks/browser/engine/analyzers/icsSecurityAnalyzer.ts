/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # ICS / SCADA Security Analyzer
 *
 * Handles `type: "ics-security"` rules against source files for
 * Critical Infrastructure (Energy, Oil & Gas, Water, SCADA, ICS) contexts.
 *
 * ## Coverage
 *
 * Detects 10 classes of ICS/SCADA security violations:
 *
 * | detect value                | Description                                                        |
 * |-----------------------------|--------------------------------------------------------------------|
 * | hardcoded-credential        | Hardcoded username/password/secret in ICS code or config          |
 * | scada-unauthenticated       | SCADA protocol communication without authentication                |
 * | dnp3-no-auth                | DNP3 used without Secure Authentication v5                        |
 * | modbus-no-whitelist         | Modbus TCP server accepts connections without IP whitelist         |
 * | opc-ua-no-security          | OPC-UA endpoint security mode set to None                         |
 * | iec61850-unprotected        | IEC 61850 GOOSE/MMS without authentication or TLS                 |
 * | engineering-station-path    | Hardcoded path to engineering station or SCADA server             |
 * | cleartext-ot-protocol       | OT protocol data transmitted or logged in cleartext              |
 * | missing-network-isolation   | OT/IT zone crossing without DMZ or firewall reference             |
 * | unsafe-firmware-update      | Firmware update without signature/hash verification               |
 *
 * ## False-positive suppression
 *
 * - Environment variable reads (getenv, os.environ, process.env) are excluded from
 *   hardcoded-credential detection.
 * - Template placeholders and empty strings are excluded.
 * - Comment-only lines are skipped; block comments are blanked preserving line numbers.
 * - Documentation files (.md, .txt, .rst) are skipped.
 *
 * ## Applies to
 *
 * All language IDs (no `supportedLanguages` restriction) \u2014 ICS/SCADA code spans C, Python,
 * Java, JavaScript, config files, and more.
 */

import { ITextModel } from '../../../../../../editor/common/model.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IGRCRule, ICheckResult } from '../types/grcTypes.js';
import { IRuleAnalyzer } from '../services/grcEngineService.js';
import { INanoAgentContext } from '../../nanoAgents/projectAnalyzerService.js';


// \u2500\u2500\u2500 Local check interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface IICSSecurityCheck {
	type: 'ics-security';
	detect:
	| 'hardcoded-credential'
	| 'scada-unauthenticated'
	| 'dnp3-no-auth'
	| 'modbus-no-whitelist'
	| 'opc-ua-no-security'
	| 'iec61850-unprotected'
	| 'engineering-station-path'
	| 'cleartext-ot-protocol'
	| 'missing-network-isolation'
	| 'unsafe-firmware-update';
}


// \u2500\u2500\u2500 ICS Security Analyzer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class ICSSecurityAnalyzer implements IRuleAnalyzer {

	readonly supportedTypes = ['ics-security'];

	// No supportedLanguages \u2014 applies to all language IDs and file types.


	// \u2500\u2500\u2500 IRuleAnalyzer: evaluate \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	public evaluate(
		rule: IGRCRule,
		model: ITextModel,
		fileUri: URI,
		timestamp: number,
		_context?: INanoAgentContext
	): ICheckResult[] {
		const lines = model.getLinesContent();
		return this._run(rule, lines, fileUri, timestamp);
	}


	// \u2500\u2500\u2500 IRuleAnalyzer: evaluateContent \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	public evaluateContent(
		rule: IGRCRule,
		content: string,
		fileUri: URI,
		languageId: string,
		timestamp: number
	): ICheckResult[] {
		const lines = content.split('\n');
		return this._run(rule, lines, fileUri, timestamp);
	}


	// \u2500\u2500\u2500 Core dispatch \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _run(
		rule: IGRCRule,
		rawLines: string[],
		fileUri: URI,
		timestamp: number
	): ICheckResult[] {
		const check = rule.check as IICSSecurityCheck | undefined;
		if (!check || check.type !== 'ics-security') return [];

		// Skip documentation files
		if (this._isDocFile(fileUri.path)) return [];

		// Blank block comments while preserving line indices
		const lines = this._stripBlockComments(rawLines);

		switch (check.detect) {
			case 'hardcoded-credential':       return this._checkHardcodedCredential(rule, rawLines, fileUri, timestamp);
			case 'scada-unauthenticated':      return this._checkScadaUnauthenticated(rule, lines, fileUri, timestamp);
			case 'dnp3-no-auth':               return this._checkDnp3NoAuth(rule, lines, fileUri, timestamp);
			case 'modbus-no-whitelist':        return this._checkModbusNoWhitelist(rule, lines, fileUri, timestamp);
			case 'opc-ua-no-security':         return this._checkOpcUaNoSecurity(rule, lines, fileUri, timestamp);
			case 'iec61850-unprotected':       return this._checkIec61850Unprotected(rule, lines, fileUri, timestamp);
			case 'engineering-station-path':   return this._checkEngineeringStationPath(rule, rawLines, fileUri, timestamp);
			case 'cleartext-ot-protocol':      return this._checkCleartextOtProtocol(rule, lines, fileUri, timestamp);
			case 'missing-network-isolation':  return this._checkMissingNetworkIsolation(rule, lines, fileUri, timestamp);
			case 'unsafe-firmware-update':     return this._checkUnsafeFirmwareUpdate(rule, lines, fileUri, timestamp);
			default:                           return [];
		}
	}


	// \u2500\u2500\u2500 Detector: hardcoded-credential \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	// Use rawLines so comment content is visible (credentials can appear in comments too)
	private _checkHardcodedCredential(
		rule: IGRCRule, rawLines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Patterns that indicate a credential is being read dynamically (not hardcoded)
		const DYNAMIC_READ_RE = /(?:getenv\s*\(|os\.environ|process\.env|loadConfig|readConfig|config\.get|settings\.get|vault\.|keystore\.|secrets_manager|aws_secret|azure_keyvault|\$\{[^}]+\}|<password>|<secret>|PLACEHOLDER|CHANGEME)/i;

		// Core credential assignment patterns
		// Group 1: key name, must be followed by value assignment
		const CREDENTIAL_ASSIGN_RE = /\b(password|passwd|pwd|secret|credential|auth_token|api_key|private_key|access_key|client_secret|token|passphrase)\s*[=:]\s*["']([^"']{4,})["']/i;

		// SCADA/ICS-specific credential constants
		const SCADA_CRED_RE = /\b(SCADA_PASSWORD|HMI_PASSWORD|RTU_AUTH|PLC_CREDENTIAL|OPC_SERVER_PASS|DCS_PASSWORD|RTU_PASSWORD|HISTORIAN_PASS|ENGINEERING_PASS)\s*[=:]\s*["']([^"']+)["']/i;

		// Config file patterns: key: value (YAML/TOML/INI style)
		const CONFIG_CRED_RE = /^\s*(?:password|passwd|pwd|secret|auth_token|api_key)\s*[:=]\s*(?!["']{2}|null|None|false|true|\$\{|\<)[^\s#][^\n]{3,}/i;

		// Connection string patterns
		const CONN_STRING_RE = /(?:Password\s*=\s*[^;'"]{4,}[;'"]|mongodb:\/\/[^:]+:[^@]{4,}@|Server=[^;]+;[^;]*Password=[^;'"]{3,})/i;

		// Empty string / template exclusions
		const EMPTY_OR_TEMPLATE_RE = /^["']{0,1}(\s*|null|None|false|true|undefined|""|''|\$\{[^}]+\}|<[^>]+>)["']{0,1}$/i;

		for (let i = 0; i < rawLines.length; i++) {
			const line = rawLines[i];
			const trimmed = line.trim();
			if (!trimmed) continue;

			// Skip lines that reference dynamic credential loading
			if (DYNAMIC_READ_RE.test(line)) continue;

			let matched = false;
			let credName = '';
			let credValue = '';

			// Check assignment patterns
			let m = CREDENTIAL_ASSIGN_RE.exec(line);
			if (m) {
				credName = m[1];
				credValue = m[2];
				matched = true;
			}

			if (!matched) {
				m = SCADA_CRED_RE.exec(line);
				if (m) {
					credName = m[1];
					credValue = m[2];
					matched = true;
				}
			}

			if (!matched && CONFIG_CRED_RE.test(trimmed)) {
				const configM = /^(\w+)\s*[:=]\s*(.+)$/.exec(trimmed);
				if (configM) {
					credName = configM[1];
					credValue = configM[2].trim();
					matched = true;
				}
			}

			if (!matched) {
				m = CONN_STRING_RE.exec(line);
				if (m) {
					credName = 'connection-string';
					credValue = m[0].substring(0, 30);
					matched = true;
				}
			}

			if (!matched) continue;

			// Final filter: skip empty or template values
			if (EMPTY_OR_TEMPLATE_RE.test(credValue)) continue;
			// Skip if value looks like an env-var reference
			if (/^\$\{|^%[A-Z_]+%|^env\[/.test(credValue)) continue;

			results.push(this._makeResult(
				rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1,
				this._redactLine(trimmed), timestamp,
				`Hardcoded credential '${credName}' detected \u2014 store secrets in a secrets manager, environment variables, or an encrypted vault (IEC 62443-3-3 SR 1.5)`
			));
		}
		return results;
	}


	// \u2500\u2500\u2500 Detector: scada-unauthenticated \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _checkScadaUnauthenticated(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// SCADA protocol connection patterns (unauthenticated if no auth context nearby)
		const SCADA_CONNECT_RE = /\b(?:ModbusClient[._]connect|modbus_connect|modbus_new_tcp|DNP3[._]connect|dnp3_session|ICCP[._]session|TASE[._]connect|IECClient[._]connect|IEC104[._]session|write_register\s*\(|write_coil\s*\(|WriteCoils\s*\(|WriteRegisters\s*\()\b/i;

		// Authentication indicators
		const AUTH_INDICATORS_RE = /(?:authenticate|auth_token|credentials|SAv5|challenge_response|crypto|TLS|certificate|auth_key|session\.authenticated|login\s*\(|verify_identity)/i;

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || this._isCommentOnly(trimmed)) continue;
			if (!SCADA_CONNECT_RE.test(trimmed)) continue;

			// Check surrounding 20 lines for authentication context
			const ctx = this._contextWindow(lines, i, 20);
			if (!AUTH_INDICATORS_RE.test(ctx)) {
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					`SCADA protocol connection/operation without authentication context \u2014 all SCADA sessions must be authenticated per IEC 62443-3-3 SR 1.2`
				));
			}
		}
		return results;
	}


	// \u2500\u2500\u2500 Detector: dnp3-no-auth \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _checkDnp3NoAuth(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// DNP3 session / config creation
		const DNP3_SESSION_RE = /\b(?:DNP3OutstationConfig|DNP3MasterConfig|dnp3_create_channel|dnp3_create_master|dnp3_create_outstation|DNP3[._]session|MasterStackConfig|OutstationStackConfig)\b/i;

		// DNP3 SAv5 indicators
		const SAV5_RE = /(?:SAv5|secure_auth|challenge_response|MAC_algorithm|KeyChangeMethod|auth_config|security_config|DNP3_SAv5|HMAC_SHA|AES_CMAC|critical_request_auth)/i;

		// Explicit disabled-auth patterns \u2014 always flag
		const AUTH_DISABLED_RE = /(?:enable_auth\s*[=:]\s*false|secure_authentication\s*[=:]\s*false|SAv5\s*[=:]\s*disabled|authentication\s*[=:]\s*(?:disabled|false|none|0))/i;

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || this._isCommentOnly(trimmed)) continue;

			// Explicit disablement \u2014 always report
			if (AUTH_DISABLED_RE.test(trimmed)) {
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					`DNP3 Secure Authentication explicitly disabled \u2014 IEC 62351-5 requires SAv5 for all DNP3 communications in critical infrastructure`
				));
				continue;
			}

			if (!DNP3_SESSION_RE.test(trimmed)) continue;

			// Check surrounding 30 lines for SAv5 configuration
			const ctx = this._contextWindow(lines, i, 30);
			if (!SAV5_RE.test(ctx)) {
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					`DNP3 session created without Secure Authentication v5 (SAv5) configuration \u2014 implement IEC 62351-5 challenge-response authentication to prevent spoofing and replay attacks`
				));
			}
		}
		return results;
	}


	// \u2500\u2500\u2500 Detector: modbus-no-whitelist \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _checkModbusNoWhitelist(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Modbus TCP server / listener creation
		const MODBUS_SERVER_RE = /\b(?:ModbusTcpServer|modbus_tcp_listen|modbus_new_tcp|modbus_tcp_pi_new|ModbusTCPServer|StartModbusTCPServer|listen\s*\(\s*502\b|bind\s*\(\s*["']0\.0\.0\.0["']\s*,\s*502\b|accept_tcp\s*\()\b/i;

		// IP whitelist / ACL indicators
		const WHITELIST_RE = /(?:whitelist|allowed_ips|ip_whitelist|ip_filter|source_filter|acl\b|access_control|check_source_ip|validate_client_ip|permitted_hosts|ip_allow_list)/i;

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || this._isCommentOnly(trimmed)) continue;
			if (!MODBUS_SERVER_RE.test(trimmed)) continue;

			// Check surrounding 25 lines for whitelist/ACL configuration
			const ctx = this._contextWindow(lines, i, 25);
			if (!WHITELIST_RE.test(ctx)) {
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					`Modbus TCP server accepts connections without IP whitelist \u2014 implement source IP filtering to prevent unauthorized access (IEC 62443-3-3 SR 5.2)`
				));
			}
		}
		return results;
	}


	// \u2500\u2500\u2500 Detector: opc-ua-no-security \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _checkOpcUaNoSecurity(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Explicit None/NoSecurity mode patterns \u2014 always flag
		const SECURITY_NONE_RE = /\b(?:SecurityMode\.None|MessageSecurityMode\.None|security_mode\s*[=:]\s*["']?(?:NONE|None|none)["']?|UA_SecurityMode_None|OpcUa_MessageSecurityMode_None|SecurityPolicy\.None|security_policy\s*[=:]\s*["']?(?:None|none)["']?|NoSecurity\b)\b/;

		// OPC-UA client/server creation
		const OPCUA_CREATE_RE = /\b(?:OpcUaServer\s*\(|OpcUaClient\s*\(|ua\.Client\s*\(|opcua\.Client\s*\(|ua\.Server\s*\(|Client\.create\s*\(|OPCUAClient\s*\(|OPCUAServer\s*\(|UaServer\s*\(|UaClient\s*\()\b/i;

		// Security presence indicators
		const SECURITY_PRESENT_RE = /(?:security_policy|certificate|private_key|user_token_policy|sign_and_encrypt|BasicSecurity|Basic256|Basic128|SecurityMode\.Sign|Aes256|x509|pki)/i;

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || this._isCommentOnly(trimmed)) continue;

			// Explicit None security \u2014 always flag
			if (SECURITY_NONE_RE.test(trimmed)) {
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					`OPC-UA endpoint security mode set to None \u2014 this allows unauthenticated and unencrypted communication. Use at minimum SecurityMode.Sign per IEC 62443-3-3 SR 4.1`
				));
				continue;
			}

			// OPC-UA server/client creation without security config
			if (OPCUA_CREATE_RE.test(trimmed)) {
				const ctx = this._contextWindow(lines, i, 20);
				if (!SECURITY_PRESENT_RE.test(ctx)) {
					results.push(this._makeResult(
						rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
						`OPC-UA server/client created without security policy or certificate configuration \u2014 configure security_policy and x509 certificates per IEC 62541 and IEC 62443`
					));
				}
			}
		}
		return results;
	}


	// \u2500\u2500\u2500 Detector: iec61850-unprotected \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _checkIec61850Unprotected(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// IEC 61850 GOOSE publish / MMS connect operations
		const IEC61850_OP_RE = /\b(?:GoosePublisher[._]publish|goose_send\s*\(|GOOSE[._]publish|IedConnection_create\s*\(|MmsClient[._]connect|iec61850_write\s*\(|IEC61850[._]send|Iec61850[._]connect|mms_connect\s*\()\b/i;

		// Authentication / security indicators
		const SECURITY_RE = /(?:hmac\b|signature\b|auth_tag|security_dataset|tls\b|TLS\b|certificate\b|auth_parameter|security_profile|IEC62351|iec62351)/i;

		// Explicit disabled security patterns
		const SECURITY_DISABLED_RE = /(?:goose_security\s*[=:]\s*false|mms_auth\s*[=:]\s*(?:none|false)|security\s*[=:]\s*(?:none|false|disabled))/i;

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || this._isCommentOnly(trimmed)) continue;

			// Explicit disablement
			if (SECURITY_DISABLED_RE.test(trimmed)) {
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					`IEC 61850 security explicitly disabled \u2014 GOOSE and MMS communications require IEC 62351 authentication to prevent protection relay spoofing`
				));
				continue;
			}

			if (!IEC61850_OP_RE.test(trimmed)) continue;

			const ctx = this._contextWindow(lines, i, 20);
			if (!SECURITY_RE.test(ctx)) {
				// Determine GOOSE vs MMS for a more specific message
				const isGoose = /goose/i.test(trimmed);
				const protocol = isGoose ? 'GOOSE' : 'MMS';
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					`IEC 61850 ${protocol} operation without authentication or TLS \u2014 implement IEC 62351 security to prevent protection relay spoofing and unauthorized command injection`
				));
			}
		}
		return results;
	}


	// \u2500\u2500\u2500 Detector: engineering-station-path \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	// Use rawLines \u2014 paths and hostnames often appear in string literals / comments
	private _checkEngineeringStationPath(
		rule: IGRCRule, rawLines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Windows UNC paths to OT servers
		const UNC_PATH_RE = /\\\\(?:SCADA[-_]?(?:SERVER)?|HMI[-_]|RTU[-_]|DCS[-_]|ENG[-_]?(?:PC|STATION)|HISTORIAN[-_]|PLC[-_]|SIS[-_])\w*/i;

		// Hardcoded OT hostname constants
		const OT_HOST_CONST_RE = /\b(?:SCADA_SERVER|SCADA_HOST|HMI_HOST|RTU_IP|DCS_SERVER|DCS_IP|ENG_STATION|HISTORIAN_HOST|PLC_ADDRESS)\s*[=:]\s*["'][^"']+["']/i;

		// Hardcoded private-range IP in OT naming context
		const OT_IP_CONTEXT_RE = /(?:SCADA|HMI|RTU|DCS|PLC|Historian|engineering)\s*[=:]\s*["'](?:192\.168\.|10\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)\d+\.\d+["']/i;

		// Windows registry paths for SCADA software
		const REGISTRY_PATH_RE = /HKEY[_A-Z]*[\\\/](?:SOFTWARE|SYSTEM)[\\\/][^"'\n]*(?:SCADA|Wonderware|FactoryTalk|WinCC|Citect|InTouch|Historian)/i;

		// Filesystem paths to known SCADA software install locations
		const FS_SCADA_PATH_RE = /["'](?:C:\\\\(?:Program Files|Wonderware|FactoryTalk|SIMATIC WinCC)|\/opt\/(?:scada|ics|automation)|\/home\/(?:ot|scada|plant))[\\\/][^"'\n]{4,}["']/i;

		for (let i = 0; i < rawLines.length; i++) {
			const line = rawLines[i];
			const trimmed = line.trim();
			if (!trimmed) continue;

			let message = '';

			if (UNC_PATH_RE.test(line)) {
				const m = UNC_PATH_RE.exec(line)!;
				message = `Hardcoded UNC path to engineering/SCADA station '${m[0].substring(0, 40)}' \u2014 use DNS names from a configuration file or service registry`;
			} else if (OT_HOST_CONST_RE.test(line)) {
				const m = OT_HOST_CONST_RE.exec(line)!;
				message = `Hardcoded OT server hostname/IP in constant '${m[0].split(/\s*[=:]\s*/)[0].trim()}' \u2014 manage OT device addresses in configuration, not source code`;
			} else if (OT_IP_CONTEXT_RE.test(line)) {
				message = `Hardcoded IP address for OT device (SCADA/HMI/RTU/DCS) \u2014 use a device registry or configuration file to support network topology changes`;
			} else if (REGISTRY_PATH_RE.test(line)) {
				message = `Hardcoded Windows registry path to SCADA/HMI software \u2014 registry paths should be read from configuration or discovered at runtime`;
			} else if (FS_SCADA_PATH_RE.test(line)) {
				message = `Hardcoded filesystem path to SCADA/ICS software installation \u2014 use configurable paths to support deployment variability and security hardening`;
			}

			if (message) {
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp, message
				));
			}
		}
		return results;
	}


	// \u2500\u2500\u2500 Detector: cleartext-ot-protocol \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _checkCleartextOtProtocol(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Patterns that indicate OT protocol data appearing in log/print statements
		const LOG_FUNCTIONS_RE = /\b(?:log|logger|LOG|print|printf|fprintf|cout|System\.out\.print|console\.log|logging\.(?:debug|info|warning|error|critical)|syslog)\b/;

		// OT data identifiers that should not appear in cleartext logs
		const OT_DATA_TERMS_RE = /(?:modbus|coil|register|PDU|dnp3|application_layer|process_value|setpoint|tag_value|OpcUa|ua_value|opcua|GOOSE|goose_frame|MMS|mms_data|RTU_data|PLC_output|field_bus|field_device)/i;

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || this._isCommentOnly(trimmed)) continue;

			// Line must contain a logging/print function AND OT data term
			if (!LOG_FUNCTIONS_RE.test(trimmed)) continue;
			if (!OT_DATA_TERMS_RE.test(trimmed)) continue;

			// Look for value / data context: '= digit', 'value', 'data', 'buf', 'frame'
			const hasDataContext = /(?:value|data|buf|frame|msg|packet|payload|register|coil)\b/i.test(trimmed);
			if (!hasDataContext) continue;

			// Find the matching OT term for the message
			const otMatch = OT_DATA_TERMS_RE.exec(trimmed);
			const otTerm = otMatch ? otMatch[0] : 'OT';

			results.push(this._makeResult(
				rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
				`OT protocol data ('${otTerm}') logged or printed in cleartext \u2014 process values and protocol PDUs must not appear in unprotected logs (IEC 62443-3-3 SR 3.1, NERC CIP-007)`
			));
		}
		return results;
	}


	// \u2500\u2500\u2500 Detector: missing-network-isolation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _checkMissingNetworkIsolation(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// OT context signals in the file path or content
		const OT_CONTEXT_FILE_RE = /(?:scada|ics|plc|rtu|dcs|hmi|ot_network|field_bus|substation|historian)/i;
		const filePath = fileUri.path.toLowerCase();
		const isOtContextFile = OT_CONTEXT_FILE_RE.test(filePath);

		// IT network access patterns that should not appear in OT context without isolation
		const IT_ACCESS_RE = /\b(?:http[s]?\s*:\/\/|requests\.get\s*\(|requests\.post\s*\(|fetch\s*\(.*http|urllib\.request|curl\s*\(|HttpClient|RestTemplate|axios\.get|axios\.post|socket\.connect\s*\(\s*["'][^"']+["']\s*,\s*(?:80|443|8080|8443)\b)\b/i;

		// Isolation / security gateway indicators
		const ISOLATION_RE = /(?:DMZ\b|proxy\b|firewall\b|unidirectional\b|data_diode\b|security_gateway\b|OT_gateway\b|jump_host\b|bastion\b|air_gap\b)/i;

		// OT-context indicators in content for files not detected by path
		const OT_CONTENT_RE = /\b(?:SCADA|Modbus|DNP3|IEC104|PLC_|RTU_|HMI_|DCS_|historian\b|field_device\b)\b/;

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || this._isCommentOnly(trimmed)) continue;
			if (!IT_ACCESS_RE.test(trimmed)) continue;

			// Determine if this file has OT context
			const hasOtContent = isOtContextFile || OT_CONTENT_RE.test(
				lines.slice(Math.max(0, i - 30), i + 30).join('\n')
			);
			if (!hasOtContent) continue;

			// Check surrounding 30 lines for isolation/DMZ reference
			const ctx = this._contextWindow(lines, i, 30);
			if (!ISOLATION_RE.test(ctx)) {
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					`IT network access from OT/SCADA context without DMZ or firewall reference \u2014 OT-to-IT communication must traverse a security gateway or DMZ per IEC 62443-3-2 zone/conduit model`
				));
			}
		}
		return results;
	}


	// \u2500\u2500\u2500 Detector: unsafe-firmware-update \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _checkUnsafeFirmwareUpdate(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Firmware update operation patterns
		const FW_UPDATE_RE = /\b(?:update_firmware\s*\(|flash_firmware\s*\(|write_firmware\s*\(|OTA_update\s*\(|firmware_download\s*\(|flash_write\s*\(|program_flash\s*\(|IAP_write\s*\(|boot_load\s*\(|FirmwareUpdate\s*\(|update_image\s*\(|load_firmware\s*\()\b/i;

		// Insecure transfer protocols for firmware
		const INSECURE_PROTO_RE = /\b(?:tftp:\/\/|ftp:\/\/|http:\/\/(?!localhost|127\.0\.0\.1))[^"'\s]+/i;
		const INSECURE_PROTO_FUNC_RE = /\b(?:tftp_get\s*\(|tftp_put\s*\(|ftp_get\s*\(|ftp_download\s*\()\b/i;

		// Raw memory write of firmware buffer without preceding verification
		const FW_MEMCPY_RE = /\b(?:memcpy\s*\([^)]*firmware|flash_program\s*\(|HAL_FLASH_Program\s*\()\b/i;

		// Integrity verification indicators
		const VERIFY_RE = /(?:verify_signature\s*\(|check_hash\s*\(|validate_image\s*\(|authenticate_image\s*\(|verify_integrity\s*\(|signature_verify\s*\(|hash_verify\s*\(|checksum_verify\s*\(|RSA_verify\s*\(|ECDSA_verify\s*\(|SHA256_verify\s*\(|mbedtls_pk_verify\s*\(|wolfSSL_RSA_verify\s*\()\b/i;

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || this._isCommentOnly(trimmed)) continue;

			// Insecure protocol for firmware delivery \u2014 always flag
			if (INSECURE_PROTO_RE.test(trimmed) || INSECURE_PROTO_FUNC_RE.test(trimmed)) {
				const proto = INSECURE_PROTO_RE.test(trimmed) ?
					(INSECURE_PROTO_RE.exec(trimmed)?.[0]?.split('://')[0] ?? 'insecure') : 'TFTP/FTP';
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					`Firmware delivered via insecure protocol '${proto}' \u2014 use HTTPS or SFTP with certificate pinning for firmware downloads (IEC 62443-4-2 CR 3.4)`
				));
				continue;
			}

			// Firmware update/flash write without preceding verification
			const isFwOp = FW_UPDATE_RE.test(trimmed) || FW_MEMCPY_RE.test(trimmed);
			if (!isFwOp) continue;

			// Check up to 15 preceding lines for a verification call
			const preceding = lines.slice(Math.max(0, i - 15), i).join('\n');
			if (!VERIFY_RE.test(preceding)) {
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					`Firmware update/flash write without preceding signature or hash verification \u2014 call verify_signature() or check_hash() before writing firmware to prevent malicious code injection (IEC 62443-4-2 CR 3.4)`
				));
			}
		}
		return results;
	}


	// \u2500\u2500\u2500 Result factory \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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
			ruleId:           rule.id,
			domain:           rule.domain,
			severity:         rule.severity,
			message:          `[${rule.id}] ${detail}`,
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


	// \u2500\u2500\u2500 Utility helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Lines within ±radius of center (inclusive), joined. */
	private _contextWindow(lines: string[], center: number, radius: number): string {
		const start = Math.max(0, center - radius);
		const end   = Math.min(lines.length - 1, center + radius);
		return lines.slice(start, end + 1).join('\n');
	}

	/**
	 * Blank block comment content while preserving newlines so that
	 * all line indices remain valid for downstream checks.
	 */
	private _stripBlockComments(lines: string[]): string[] {
		const content = lines.join('\n');
		const stripped = content.replace(/\/\*[\s\S]*?\*\//g, (match) =>
			match.replace(/[^\n]/g, ' ')
		);
		return stripped.split('\n');
	}

	/** True when a trimmed line is blank or is a comment token. */
	private _isCommentOnly(trimmed: string): boolean {
		return (
			trimmed.length === 0 ||
			trimmed.startsWith('//') ||
			trimmed.startsWith('/*') ||
			trimmed.startsWith('*') ||
			trimmed.startsWith('#') ||
			trimmed.startsWith('--') ||
			trimmed.startsWith(';') ||
			trimmed.startsWith("'") ||   // VB/ini comment
			trimmed.startsWith('(*')     // IEC 61131-3 block comment
		);
	}

	private _isDocFile(filePath: string): boolean {
		const ext = filePath.toLowerCase().split('.').pop() ?? '';
		return ['md', 'txt', 'rst', 'adoc', 'pdf'].includes(ext);
	}

	/**
	 * Redact the value portion of a credential line for safe display in findings.
	 * Replaces the content of string literals longer than 3 chars with `****`.
	 */
	private _redactLine(line: string): string {
		return line.replace(/(?<=[=:]\s*)["'][^"']{4,}["']/g, '"****"');
	}
}
