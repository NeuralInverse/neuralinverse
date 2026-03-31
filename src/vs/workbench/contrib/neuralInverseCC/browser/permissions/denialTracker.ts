// @ts-nocheck
/*---------------------------------------------------------------------------------------------
 *  Ported from Claude Code (MIT License - Copyright (c) Anthropic)
 *  Source: src/utils/permissions/denialTracking.ts
 *  Near-verbatim port — no external deps
 *--------------------------------------------------------------------------------------------*/

import type { DenialTrackingState } from '../../common/neuralInverseCCTypes.js';

export const DENIAL_LIMITS = {
	maxConsecutive: 3,
	maxTotal: 20,
} as const;

export function createDenialTrackingState(): DenialTrackingState {
	return { consecutiveDenials: 0, totalDenials: 0 };
}

export function recordDenial(state: DenialTrackingState): DenialTrackingState {
	return {
		...state,
		consecutiveDenials: state.consecutiveDenials + 1,
		totalDenials: state.totalDenials + 1,
	};
}

export function recordSuccess(state: DenialTrackingState): DenialTrackingState {
	if (state.consecutiveDenials === 0) { return state; }
	return { ...state, consecutiveDenials: 0 };
}

export function shouldFallbackToPrompting(state: DenialTrackingState): boolean {
	return (
		state.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
		state.totalDenials >= DENIAL_LIMITS.maxTotal
	);
}
