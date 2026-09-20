/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Agent-turn termination caps (K-1, final-closure order 2026-09-17 §3)
 *
 * Pure module: the caps live here so tests and the acceptance fixture can pin
 * them WITHOUT importing the browser-side chat thread service (whose DI import
 * closure reaches workbench browser modules that need a DOM). The chat thread
 * service imports and enforces them; `agentTurnTermination.test.ts` asserts
 * the exact values BEFORE running the termination scenarios, as the order
 * demands ("سقف تعداد retry و زمان recovery را پیش از آزمون در fixture ثبت
 * کن").
 */

/** related to retrying when LLM message has error */
export const CHAT_RETRIES = 3;
export const RETRY_DELAY = 2500;

/** A provider stream that makes no content progress for this long is treated
 *  as dead and aborted — without this a stalled connection leaves the thread
 *  spinning forever. */
export const LLM_STREAM_STALL_MS = 180_000; // 3 minutes

/** K-1: hard, non-resettable ceiling on ONE provider request. A stream that
 *  keeps producing FRESH text forever (router fallback churn re-streaming the
 *  context) resets the stall deadline on every chunk; only a total cap bounds
 *  that turn. 30 minutes: long enough for a legitimate slow recovery turn
 *  (run1's L9 recovery legitimately finished at ~25 min), short enough that
 *  the run1 L6 non-terminating turn (>30 min, never finished) is bounded. */
export const LLM_STREAM_TOTAL_CAP_MS = 30 * 60_000;

/** K-1: Stop settles LOCALLY within this bound even when a tool has not yet
 *  yielded its interruptor or the provider abort never answers — the 5s
 *  acceptance threshold of the final-closure order is met with margin. */
export const ABORT_LOCAL_SETTLE_MS = 2_000;

/** K-1: hard cap on model requests per agent run. */
export const MAX_AGENT_MESSAGES_SENT = 50;
