/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Industrial IoT / OT Analyzer
 *
 * Executes `type: "iot-ot"` rules against source files.
 *
 * ## Coverage
 *
 * Detects 10 classes of Industrial IoT / Operational Technology violations:
 *
 * | detect value              | Description                                                    |
 * |---------------------------|----------------------------------------------------------------|
 * | missing-watchdog          | Infinite loop / task without watchdog timer kick              |
 * | heap-in-rt-task           | Dynamic memory allocation in a real-time task or ISR          |
 * | missing-redundancy        | Safety-critical actuator output without redundancy voting      |
 * | determinism-violation     | Non-deterministic call inside a real-time task context         |
 * | missing-safety-check      | Safety function return value not checked                       |
 * | plc-write-unprotected     | PLC output write without preceding interlock validation        |
 * | scada-historian-direct    | Direct SCADA historian DB write without bounds/range check     |
 * | ot-hardcoded-ip           | Hardcoded IP / MAC address for OT device communication        |
 * | missing-failsafe          | Control loop or state machine without failsafe/fault state    |
 * | heartbeat-missing         | Redundant-system component without heartbeat signal            |
 *
 * ## False-positive suppression
 *
 * - Test files are skipped by default (override with `includeTests: true`).
 * - Comment-only lines are filtered before matching.
 * - Block comments are blanked preserving line numbers.
 * - Documentation files (.md, .txt, .rst) are silently skipped.
 *
 * ## Applies to
 *
 * All language IDs (no `supportedLanguages` restriction).
 */

import { ITextModel } from '../../../../../../editor/common/model.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IGRCRule, ICheckResult, toDisplaySeverity } from '../types/grcTypes.js';
import { IRuleAnalyzer } from '../services/grcEngineService.js';
import { INanoAgentContext } from '../../nanoAgents/projectAnalyzerService.js';


// ─── Local check interface ────────────────────────────────────────────────────

/**
 * Structured check definition for `type: "iot-ot"` rules.
 * Lives locally until promoted into frameworkSchema.ts.
 */
interface IIoTOTCheck {
	type: 'iot-ot';
	detect:
	| 'missing-watchdog'
	| 'heap-in-rt-task'
	| 'missing-redundancy'
	| 'determinism-violation'
	| 'missing-safety-check'
	| 'plc-write-unprotected'
	| 'scada-historian-direct'
	| 'ot-hardcoded-ip'
	| 'missing-failsafe'
	| 'heartbeat-missing';
	/** Optional deployment context hint. Does not restrict scanning — used for message tailoring. */
	context?: 'firmware' | 'plc' | 'scada' | 'hmi' | 'generic';
	/** When true, test files are also scanned. Default: false. */
	includeTests?: boolean;
}


// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Lines within ±N of center (inclusive), joined and lowercased. */
function contextWindow(lines: string[], center: number, radius: number): string {
	const start = Math.max(0, center - radius);
	const end   = Math.min(lines.length - 1, center + radius);
	return lines.slice(start, end + 1).join('\n').toLowerCase();
}

/** Lines before center (exclusive), looking back up to `lookback` rows. */
function precedingContext(lines: string[], center: number, lookback: number): string {
	const start = Math.max(0, center - lookback);
	return lines.slice(start, center).join('\n').toLowerCase();
}


// ─── Industrial IoT / OT Analyzer ───────────────────────────────────────────

export class IndustrialIotAnalyzer implements IRuleAnalyzer {
	readonly supportedTypes = ['iot-ot'];

	// No supportedLanguages — applies to all language IDs.


	// ─── IRuleAnalyzer: evaluate (open model) ────────────────────────

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


	// ─── IRuleAnalyzer: evaluateContent (background scan) ───────────

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


	// ─── Core dispatch ───────────────────────────────────────────────

	private _run(
		rule: IGRCRule,
		lines: string[],
		fileUri: URI,
		_languageId: string,
		timestamp: number
	): ICheckResult[] {
		const check = rule.check as IIoTOTCheck | undefined;
		if (!check || check.type !== 'iot-ot') return [];

		// Skip documentation files (no executable content)
		if (this._isDocFile(fileUri.path)) return [];

		// Skip test files by default
		if (!check.includeTests && this._isTestFile(fileUri.path)) return [];

		// Blank block comments while preserving line indices
		const cleaned = this._stripBlockComments(lines);

		switch (check.detect) {
			case 'missing-watchdog':       return this._checkMissingWatchdog(rule, cleaned, fileUri, timestamp);
			case 'heap-in-rt-task':        return this._checkHeapInRtTask(rule, cleaned, fileUri, timestamp);
			case 'missing-redundancy':     return this._checkMissingRedundancy(rule, cleaned, fileUri, timestamp);
			case 'determinism-violation':  return this._checkDeterminismViolation(rule, cleaned, fileUri, timestamp);
			case 'missing-safety-check':   return this._checkMissingSafetyCheck(rule, cleaned, fileUri, timestamp);
			case 'plc-write-unprotected':  return this._checkPlcWriteUnprotected(rule, cleaned, fileUri, timestamp);
			case 'scada-historian-direct': return this._checkScadaHistorianDirect(rule, cleaned, fileUri, timestamp);
			case 'ot-hardcoded-ip':        return this._checkOtHardcodedIp(rule, cleaned, fileUri, timestamp);
			case 'missing-failsafe':       return this._checkMissingFailsafe(rule, cleaned, fileUri, timestamp);
			case 'heartbeat-missing':      return this._checkHeartbeatMissing(rule, cleaned, fileUri, timestamp);
			default:                       return [];
		}
	}


	// ─── Detector: missing-watchdog ──────────────────────────────────

	private _checkMissingWatchdog(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Infinite-loop patterns
		const INFINITE_LOOP = /(?:while\s*\(\s*(?:1|true)\s*\)|for\s*\(\s*;;\s*\))\s*\{?/i;
		// Watchdog kick / refresh calls
		const WDT_KICK = /(?:WDT_Kick|WDT_Feed|HAL_IWDG_Refresh|wdt_reset|watchdog_reset|WDOG_Feed|wdg_clear|iwdg_reset|watchdog_refresh|Watchdog\.reset|wdt\.feed|esp_task_wdt_reset|taskYIELD|KICK_DOG|WDG_REFRESH)\s*\(/i;

		// Scan backwards from lineIdx to find the enclosing function name (within 60 lines)
		const enclosingFunction = (lineIdx: number): string => {
			for (let j = lineIdx - 1; j >= Math.max(0, lineIdx - 60); j--) {
				const m = /^\s*(?:void|int|uint\w*|bool|static\s+\w+)\s+(\w+)\s*\(/.exec(lines[j]);
				if (m) return m[1];
			}
			return '';
		};

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentOnly(line)) continue;
			if (!INFINITE_LOOP.test(line)) continue;

			// Skip fault-trap / exception-handler loops.
			// Default_Handler, HardFault_Handler, and *_IRQHandler / *_ISR
			// use while(1) as an intentional CPU-halt trap.
			// Reset_Handler is NOT skipped — its post-main() loop should
			// have a watchdog or NVIC_SystemReset to recover from main() return.
			const fn = enclosingFunction(i);
			if (fn) {
				const isTrap =
					fn === 'Default_Handler' ||
					fn.endsWith('_IRQHandler') ||
					fn.endsWith('_ISR') ||
					/[Ff]ault/.test(fn) ||
					/[Ee]rror[Hh]andler/.test(fn);
				if (isTrap) continue;
			}

			// Scan up to 50 lines ahead for a watchdog call (approximate scope)
			const ahead = lines.slice(i + 1, Math.min(lines.length, i + 51)).join('\n');
			if (!WDT_KICK.test(ahead)) {
				const t = line.trim();
				results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
					'Infinite loop without watchdog timer kick. Call WDT_Kick/HAL_IWDG_Refresh (or equivalent) inside every main application loop to prevent silent system lock-up.'));
			}
		}

		return results;
	}


	// ─── Detector: heap-in-rt-task ───────────────────────────────────

	private _checkHeapInRtTask(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Real-time task function name indicators (heuristic: look for enclosing scope)
		const RT_FUNC_RE = /(?:(?:void|int|TASK_FCN|portTASK_FUNCTION)\s+\w*(?:Task|ISR|Handler|_task|_isr|_irq|vTask|xTask|osThread)\w*\s*\(|pthread_create\s*\()/i;
		// Heap allocation calls
		const HEAP_ALLOC = /(?:\bmalloc\s*\(|\bcalloc\s*\(|\brealloc\s*\(|\bfree\s*\(|\bnew\s+|\bdelete\s+|\boperator\s+new|\bpvPortMalloc\s*\(|\bxQueueCreate\s*\(|\bkmalloc\s*\()/;
		// STL containers (implicit heap)
		const STL_HEAP = /(?:std\s*::\s*(?:vector|string|map|list|deque|set|unordered_map|unordered_set)\s*[<(])/;

		// Identify line ranges of RT-task-like functions
		// Strategy: find function header, then scan its body (up to 200 lines) for heap calls.
		let inRtTask = false;
		let rtTaskBraceDepth = 0;
		let rtTaskStartLine = -1;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentOnly(line)) continue;

			if (!inRtTask) {
				if (RT_FUNC_RE.test(line)) {
					inRtTask = true;
					rtTaskBraceDepth = 0;
					rtTaskStartLine = i;
				}
			}

			if (inRtTask) {
				// Track brace depth to find function body boundaries
				for (const ch of line) {
					if (ch === '{') rtTaskBraceDepth++;
					else if (ch === '}') rtTaskBraceDepth--;
				}

				// Check for heap usage inside the task body (not on the definition line itself)
				if (i > rtTaskStartLine && (HEAP_ALLOC.test(line) || STL_HEAP.test(line))) {
					const t = line.trim();
					results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
						'Dynamic memory allocation (malloc/new/std::vector/...) inside a real-time task or ISR. Pre-allocate all buffers at system initialisation to avoid non-deterministic heap latency and fragmentation.'));
				}

				// Exit task scope when top-level braces are balanced and at least one was opened
				if (rtTaskBraceDepth <= 0 && i > rtTaskStartLine) {
					inRtTask = false;
					rtTaskStartLine = -1;
				}

				// Safety exit to prevent run-on for files without balanced braces
				if (i - rtTaskStartLine > 300) {
					inRtTask = false;
				}
			}
		}

		return results;
	}


	// ─── Detector: missing-redundancy ────────────────────────────────

	private _checkMissingRedundancy(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Safety-critical actuator / output commands
		const SAFETY_OP = /(?:setActuator|writeOutput|triggerValve|openRelay|closeBreaker|energizeSolenoid|fireSuppressionActivate|emergencyShutdown)\s*\(/i;
		// Redundancy / voting indicators nearby
		const REDUNDANCY_NEAR = /(?:voted|2oo3|majority|redundant_check|safety_voted|cross_check|verify_independent|dual_channel|sis_check|sil_check)/i;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentOnly(line)) continue;
			if (!SAFETY_OP.test(line)) continue;

			const ctx = contextWindow(lines, i, 15);
			if (!REDUNDANCY_NEAR.test(ctx)) {
				const t = line.trim();
				results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
					'Safety-critical actuator command without redundancy or voting check. Implement 2oo3 voting or dual-channel verification before triggering safety outputs to prevent single-point failures per IEC 61508.'));
			}
		}

		return results;
	}


	// ─── Detector: determinism-violation ─────────────────────────────

	private _checkDeterminismViolation(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Same RT-task scope detection as heap-in-rt-task
		const RT_FUNC_RE = /(?:(?:void|int|TASK_FCN|portTASK_FUNCTION)\s+\w*(?:Task|ISR|Handler|_task|_isr|_irq|vTask|xTask|osThread)\w*\s*\()/i;
		// Non-deterministic calls
		const NONDETERMINISTIC = /(?:\bprintf\s*\(|\bfprintf\s*\(|\bcout\s*<<|\bsprintf\s*\(|\bmalloc\s*\(|\bfree\s*\(|\bsleep\s*\(|\busleep\s*\(|\bdelay\s*\(|\btime\s*\(|\bgettimeofday\s*\(|\brand\s*\(|\bsrand\s*\(|\bfopen\s*\(|\bfclose\s*\(|\bfread\s*\(|\bfwrite\s*\(|\bsocket\s*\(|\bconnect\s*\(|\brecv\s*\(|\bsend\s*\(|\bstd\s*::\s*sort\s*\(|\bstd\s*::\s*map\s*::\s*find\s*\()/;

		let inRtTask = false;
		let rtBraceDepth = 0;
		let rtStartLine = -1;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentOnly(line)) continue;

			if (!inRtTask) {
				if (RT_FUNC_RE.test(line)) {
					inRtTask = true;
					rtBraceDepth = 0;
					rtStartLine = i;
				}
			}

			if (inRtTask) {
				for (const ch of line) {
					if (ch === '{') rtBraceDepth++;
					else if (ch === '}') rtBraceDepth--;
				}

				if (i > rtStartLine && NONDETERMINISTIC.test(line)) {
					const t = line.trim();
					results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
						'Non-deterministic call (I/O, heap, blocking, or unbounded-runtime function) inside a real-time task or ISR. Replace with deterministic alternatives or move to a lower-priority task to preserve WCET guarantees.'));
				}

				if (rtBraceDepth <= 0 && i > rtStartLine) { inRtTask = false; rtStartLine = -1; }
				if (i - rtStartLine > 300) { inRtTask = false; }
			}
		}

		return results;
	}


	// ─── Detector: missing-safety-check ──────────────────────────────

	private _checkMissingSafetyCheck(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Safety-state query functions whose return values must be checked
		const SAFETY_FUNC = /(?:readSensor|getSafetyState|checkInterlock|getSILStatus|verifySetpoint|validateActuator|readSafetyInput|getSensorHealth|checkRedundancy)\s*\(/i;
		// Call used as a bare statement (no assignment, no if-check)
		// A line whose trimmed form starts with the function name and ends with );
		const BARE_CALL_RE = /^(?:readSensor|getSafetyState|checkInterlock|getSILStatus|verifySetpoint|validateActuator|readSafetyInput|getSensorHealth|checkRedundancy)\s*\(.*\)\s*;$/i;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentOnly(line)) continue;
			if (!SAFETY_FUNC.test(line)) continue;

			const t = line.trim();

			// Flag if the line is a bare call (not assigned and not inside an if/while)
			if (BARE_CALL_RE.test(t)) {
				results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
					'Safety function return value discarded. Always check the return value of safety-state query functions (readSensor, checkInterlock, etc.) — ignoring failure codes can allow operation in an unsafe state.'));
			} else if (!/(?:if\s*\(|while\s*\(|=\s*|return\s+|&&|\|\||\?)/i.test(t) && SAFETY_FUNC.test(t)) {
				// Heuristic: function present but no assignment or condition on same line
				results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
					'Safety function called without apparent result check. Verify the return value is tested or assigned before proceeding with control actions.'));
			}
		}

		return results;
	}


	// ─── Detector: plc-write-unprotected ─────────────────────────────

	private _checkPlcWriteUnprotected(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// PLC output write operations
		const PLC_WRITE = /(?:writeCoil\s*\(|writeRegister\s*\(|WriteMultipleCoils\s*\(|WriteMultipleRegisters\s*\(|SetOutput\s*\(|DO_Set\s*\(|AO_Set\s*\(|DQ_Write\s*\(|ModbusWrite\s*\(|OPC_Write\s*\()/i;
		// Interlock / safety permit indicators
		const INTERLOCK = /(?:if.*interlock|check_interlock|safety_relay_ok|ESD_ok|safety_check|permit_to_work|PTW_active|safeguard_ok)/i;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentOnly(line)) continue;
			if (!PLC_WRITE.test(line)) continue;

			// Check up to 5 preceding lines for an interlock check
			const preceding = precedingContext(lines, i, 5);
			if (!INTERLOCK.test(preceding)) {
				const t = line.trim();
				results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
					'PLC output write without preceding interlock validation. Verify safety relays, ESD status, and permit-to-work conditions before issuing output commands per IEC 62443-3-3.'));
			}
		}

		return results;
	}


	// ─── Detector: scada-historian-direct ────────────────────────────

	private _checkScadaHistorianDirect(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Direct historian write operations
		const HISTORIAN_WRITE = /(?:pi_insert\s*\(|PI_PutValue\s*\(|af_insert_value\s*\(|historian_write\s*\(|SqlHistorianWrite\s*\(|historian\.insert\s*\(|InfluxDB.*\.write\s*\(|timeseries.*\.write\s*\(|INSERT\s+INTO\s+\w*(?:tag_value|process_value|historian)\w*)/i;
		// Validation / range-check indicators nearby
		const VALIDATION_NEAR = /(?:validate_value|check_bounds|validate_range|sanity_check|engineering_range|in_range|bounds_check|clamp)/i;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentOnly(line)) continue;
			if (!HISTORIAN_WRITE.test(line)) continue;

			const ctx = contextWindow(lines, i, 10);
			if (!VALIDATION_NEAR.test(ctx)) {
				const t = line.trim();
				results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
					'Direct SCADA historian write without value validation or range check. Validate engineering units and bounds before persisting process values to prevent historian corruption and false alarm generation.'));
			}
		}

		return results;
	}


	// ─── Detector: ot-hardcoded-ip ───────────────────────────────────

	private _checkOtHardcodedIp(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Private IPv4 ranges (typical OT network addressing)
		const IPV4_LITERAL = /(?:["'`]|=\s*|connect\s*\(.*?)(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3})(?:["'`]|\s*[,);])/;
		// MAC address literal
		const MAC_LITERAL = /["'`]([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}["'`]/;
		// Additional OT context signals (hardcoded in a communication call)
		const OT_CONTEXT = /(?:connect|send_to|ping|modbus|dnp3|opc.*connect|iec104|s7_connect|fins_connect)/i;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentOnly(line)) continue;
			const t = line.trim();

			// IP address literal in a communication context
			if (IPV4_LITERAL.test(t) && OT_CONTEXT.test(t)) {
				results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
					'Hardcoded IP address for OT device communication. Use configuration files or a device registry to manage OT device addresses; hardcoded IPs prevent network topology changes and break zone/conduit isolation per IEC 62443-3-3.'));
				continue;
			}

			// MAC address literal anywhere (uncommon in legitimate production code)
			if (MAC_LITERAL.test(t)) {
				results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
					'Hardcoded MAC address detected. OT device MAC addresses should be resolved dynamically or stored in configuration, not embedded in source code.'));
			}
		}

		return results;
	}


	// ─── Detector: missing-failsafe ──────────────────────────────────

	private _checkMissingFailsafe(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Control-loop entry points
		const CTRL_LOOP = /(?:PID_Control\s*\(|control_loop\s*\(|process_control\s*\(|feedback_loop\s*\(|setpoint_control\s*\()/i;
		// Failsafe indicators nearby
		const FAILSAFE_NEAR = /(?:failsafe|safe_state|emergency_stop|default_safe|watchdog_expired_action|on_timeout|fail_safe)/i;

		// switch(state)/switch(mode) without a default: containing a safe transition
		const SWITCH_STATE = /switch\s*\(\s*(?:state|mode|current_state|op_mode)\s*\)/i;
		// default: clause that triggers a safe action
		const DEFAULT_SAFE = /default\s*:\s*.*(?:failsafe|safe_state|emergency_stop|FAILSAFE|EMERGENCY|SAFE|FAULT|ERROR)/i;

		// State-machine enum without a fault/safe state
		const ENUM_STATE = /enum\s+\w*[Ss]tate\w*\s*\{([^}]*)\}/;

		// Scan for control loops missing failsafe
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentOnly(line)) continue;

			if (CTRL_LOOP.test(line)) {
				const ctx = contextWindow(lines, i, 20);
				if (!FAILSAFE_NEAR.test(ctx)) {
					const t = line.trim();
					results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
						'Control loop without failsafe state handling. Define and invoke a failsafe/safe_state action on watchdog expiry, sensor failure, or communication loss per IEC 61508-2.'));
				}
			}

			// switch(state) without a safe default
			if (SWITCH_STATE.test(line)) {
				// Scan up to 60 lines ahead for the switch body
				const body = lines.slice(i + 1, Math.min(lines.length, i + 61)).join('\n');
				if (!DEFAULT_SAFE.test(body)) {
					const t = line.trim();
					results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
						'State/mode switch without a default: case that enforces a safe state. Add a default: branch that transitions to a FAILSAFE or EMERGENCY state to handle undefined modes.'));
				}
			}
		}

		// Scan full file for state-machine enums missing fault/safe members
		const fullContent = lines.join('\n');
		let enumMatch: RegExpExecArray | null;
		const enumRegex = new RegExp(ENUM_STATE.source, 'gi');
		while ((enumMatch = enumRegex.exec(fullContent)) !== null) {
			const members = enumMatch[1] || '';
			if (!/(?:FAULT|ERROR|SAFE|FAILSAFE|EMERGENCY)/i.test(members)) {
				// Find the line number of the match
				const lineNum = fullContent.substring(0, enumMatch.index).split('\n').length;
				const snippet = enumMatch[0].substring(0, 100);
				results.push(this._makeResult(rule, fileUri, lineNum, 1, lineNum, snippet.length + 1, snippet, timestamp,
					'State-machine enum without a FAULT, ERROR, SAFE, or FAILSAFE state. Every safety-relevant state machine must include at least one failure/safe state to handle anomalies.'));
			}
		}

		return results;
	}


	// ─── Detector: heartbeat-missing ─────────────────────────────────

	private _checkHeartbeatMissing(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// File-level check: does this file reference redundant/HA/failover concepts?
		const FILE_REDUNDANCY = /(?:primary|secondary|standby|backup|redundant|master|slave|active_node|passive_node)/i;
		const fullContent = lines.join('\n');
		if (!FILE_REDUNDANCY.test(fullContent)) return results; // Not a redundancy-related file

		// Heartbeat / alive-signal call patterns
		const HEARTBEAT_CALL = /(?:heartbeat\s*\(|send_alive\s*\(|alive_signal\s*\(|ping_primary\s*\(|keepalive\s*\(|aliveCheck\s*\(|watchdog_alive\s*\()/i;
		if (HEARTBEAT_CALL.test(fullContent)) return results; // Heartbeat present — no violation

		// File has redundancy references but no heartbeat calls: flag at function/loop level
		const MAIN_FUNC = /(?:void\s+main\s*\(|int\s+main\s*\(|void\s+\w*(?:Task|Loop|Run|Start|Init)\s*\()/i;
		let reported = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (this._isCommentOnly(line)) continue;
			if (MAIN_FUNC.test(line) && !reported) {
				const t = line.trim();
				results.push(this._makeResult(rule, fileUri, i + 1, 1, i + 1, t.length + 1, t, timestamp,
					'Redundant-system component without heartbeat or alive-signal call. Implement periodic heartbeat()/send_alive() to allow the partner node to detect loss of this component and initiate failover.'));
				reported = true; // One finding per file is sufficient
			}
		}

		// If no function header found, emit a file-level finding at line 1
		if (!reported) {
			results.push(this._makeResult(rule, fileUri, 1, 1, 1, 1, '', timestamp,
				'Redundant-system component without heartbeat or alive-signal call. Implement periodic heartbeat()/send_alive() to allow the partner node to detect loss of this component and initiate failover.'));
		}

		return results;
	}


	// ─── Result factory ──────────────────────────────────────────────

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


	// ─── Utility helpers ─────────────────────────────────────────────

	private _isDocFile(filePath: string): boolean {
		const ext = filePath.toLowerCase().split('.').pop() ?? '';
		return ['md', 'txt', 'rst', 'adoc', 'pdf'].includes(ext);
	}

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
	 * Replace block comment content with spaces while preserving newlines
	 * so that line indices remain valid for all downstream checks.
	 */
	private _stripBlockComments(lines: string[]): string[] {
		const content = lines.join('\n');
		const stripped = content.replace(/\/\*[\s\S]*?\*\//g, (match) => {
			return match.replace(/[^\n]/g, ' ');
		});
		return stripped.split('\n');
	}

	/** True when a line, after trimming, is a comment or blank. */
	private _isCommentOnly(line: string): boolean {
		const t = line.trim();
		return (
			t.length === 0 ||
			t.startsWith('//') ||
			t.startsWith('#') ||
			t.startsWith('*') ||
			t.startsWith('/*') ||
			t.startsWith('--') ||
			t.startsWith(';') ||
			t.startsWith('(*')  // IEC 61131-3 block comment start
		);
	}
}
