/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IKnowledgeBaseService, IUnitLock } from '../../../knowledgeBase/service.js';
import {
	IAgentToolCallResult,
	ILockUnitInput,
	IUnlockUnitInput,
	IForceUnlockUnitInput,
	ILockResult,
} from '../agentToolTypes.js';


// ─── Helpers ──────────────────────────────────────────────────────────────────

function toLockResult(lock: IUnitLock): ILockResult {
	return {
		unitId:     lock.unitId,
		lockId:     lock.id,
		ownerId:    lock.ownerId,
		acquiredAt: lock.acquiredAt,
		ttlMs:      lock.ttlMs,
		expiresAt:  lock.ttlMs > 0 ? lock.acquiredAt + lock.ttlMs : null,
	};
}


// ─── Tool implementations ─────────────────────────────────────────────────────

export function lockUnit(
	input: ILockUnitInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<ILockResult | null> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const unit = kb.getUnit(input.unitId);
	if (!unit) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}

	const existing = kb.getLock(input.unitId);
	if (existing) {
		// Check if already owned by the same owner
		if (existing.ownerId === input.ownerId) {
			return {
				success: true,
				data:    toLockResult(existing),
				summary: `Lock already held by "${input.ownerId}" on "${unit.name}"`,
			};
		}
		return {
			success: false,
			error:   `Unit "${unit.name}" is already locked by "${existing.ownerId}". Release that lock first or use force_unlock_unit.`,
		};
	}

	const lock = kb.lockUnit(input.unitId, input.ownerId, input.ttlMs);
	if (!lock) {
		return { success: false, error: `Failed to acquire lock on unit "${unit.name}".` };
	}

	return {
		success: true,
		data:    toLockResult(lock),
		summary: `Lock acquired on "${unit.name}" by "${input.ownerId}"${input.ttlMs ? ` (TTL: ${input.ttlMs}ms)` : ''}`,
	};
}


export function unlockUnit(
	input: IUnlockUnitInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ released: boolean }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const unit = kb.getUnit(input.unitId);
	if (!unit) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}

	const released = kb.unlockUnit(input.unitId, input.ownerId);

	return {
		success: released,
		data:    { released },
		summary: released
			? `Lock on "${unit.name}" released by "${input.ownerId}"`
			: `Failed to release lock — "${input.ownerId}" does not hold the lock on "${unit.name}"`,
		error: released ? undefined : `Cannot release: lock on "${unit.name}" is not held by "${input.ownerId}"`,
	};
}


export function forceUnlockUnit(
	input: IForceUnlockUnitInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ released: boolean }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const unit = kb.getUnit(input.unitId);
	if (!unit) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}

	const existing = kb.getLock(input.unitId);
	const previousOwner = existing?.ownerId ?? '(none)';

	kb.forceUnlockUnit(input.unitId);

	return {
		success: true,
		data:    { released: true },
		summary: `Force-released lock on "${unit.name}" (was held by "${previousOwner}")`,
	};
}


export function listLocks(
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<Array<ILockResult & { unitName: string; isExpired: boolean }>> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const now   = Date.now();
	const locks = kb.getAllLocks().map(lock => {
		const unit      = kb.getUnit(lock.unitId);
		const isExpired = lock.ttlMs > 0 && (now - lock.acquiredAt) > lock.ttlMs;
		return {
			...toLockResult(lock),
			unitName:  unit?.name ?? lock.unitId,
			isExpired,
		};
	});

	const expired = locks.filter(l => l.isExpired).length;

	return {
		success: true,
		data:    locks,
		summary: `${locks.length} active lock(s), ${expired} expired (call run_health_check to prune)`,
	};
}


export function pruneExpiredLocks(
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ prunedCount: number }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const prunedCount = kb.pruneExpiredLocks();

	return {
		success: true,
		data:    { prunedCount },
		summary: `${prunedCount} expired lock(s) pruned`,
	};
}
