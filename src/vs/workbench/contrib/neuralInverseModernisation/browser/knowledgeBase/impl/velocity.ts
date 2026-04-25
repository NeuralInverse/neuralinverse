/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Migration velocity tracking and ETA calculation.
 *
 * Velocity is measured in units-per-day. We keep a time-series of data points
 * and compute a rolling weighted average over a configurable window (default 7 days).
 * More recent data points are weighted higher (linear decay).
 *
 * ETA is estimated as: remainingUnits / rollingVelocity
 */

import { IVelocityDataPoint, IVelocityMetrics } from '../../../common/knowledgeBaseTypes.js';

const MS_PER_DAY = 86_400_000;
const DEFAULT_WINDOW_DAYS = 7;
const MAX_DATA_POINTS = 365; // Keep 1 year of daily data

// ─── Velocity store ───────────────────────────────────────────────────────────

export interface IVelocityStore {
	dataPoints: IVelocityDataPoint[];
}

export function createVelocityStore(): IVelocityStore {
	return { dataPoints: [] };
}

// ─── Record ───────────────────────────────────────────────────────────────────

export function recordVelocityDataPoint(
	store: IVelocityStore,
	unitsCompleted: number,
	periodStartMs: number,
	periodEndMs: number,
): void {
	const durationDays = (periodEndMs - periodStartMs) / MS_PER_DAY;
	if (durationDays <= 0 || unitsCompleted < 0) { return; }

	store.dataPoints.push({
		recordedAt:     periodEndMs,
		periodStartMs,
		periodEndMs,
		unitsCompleted,
		unitsPerDay:    unitsCompleted / durationDays,
	});

	// Cap data points
	if (store.dataPoints.length > MAX_DATA_POINTS) {
		store.dataPoints = store.dataPoints.slice(-MAX_DATA_POINTS);
	}
}

// ─── Compute metrics ──────────────────────────────────────────────────────────

export function getVelocityMetrics(
	store: IVelocityStore,
	totalUnits: number,
	completedUnits: number,
	windowDays = DEFAULT_WINDOW_DAYS,
): IVelocityMetrics {
	const remainingUnits = Math.max(0, totalUnits - completedUnits);

	if (store.dataPoints.length === 0) {
		return _zeroMetrics(totalUnits, completedUnits, remainingUnits);
	}

	const windowStart = Date.now() - windowDays * MS_PER_DAY;
	const windowPoints = store.dataPoints.filter(p => p.periodEndMs >= windowStart);

	if (windowPoints.length === 0) {
		return _zeroMetrics(totalUnits, completedUnits, remainingUnits);
	}

	// Weighted rolling average: most recent point has weight N, oldest has weight 1
	let weightedSum = 0;
	let totalWeight = 0;
	const n = windowPoints.length;

	for (let i = 0; i < n; i++) {
		const weight = i + 1; // 1..n, newest last \u2192 sort ascending by time
		weightedSum += windowPoints[i].unitsPerDay * weight;
		totalWeight += weight;
	}

	const rollingAvg = totalWeight > 0 ? weightedSum / totalWeight : 0;

	// All-time average
	const allTimeTotal = store.dataPoints.reduce((s, p) => s + p.unitsCompleted, 0);
	const allTimeSpanDays = store.dataPoints.length > 0
		? (store.dataPoints[store.dataPoints.length - 1].periodEndMs - store.dataPoints[0].periodStartMs) / MS_PER_DAY
		: 1;
	const allTimeAvg = allTimeSpanDays > 0 ? allTimeTotal / allTimeSpanDays : 0;

	// ETA based on rolling average
	let etaMs: number | undefined;
	let etaDays: number | undefined;
	if (rollingAvg > 0 && remainingUnits > 0) {
		etaDays = remainingUnits / rollingAvg;
		etaMs   = Date.now() + etaDays * MS_PER_DAY;
	} else if (remainingUnits === 0) {
		etaMs   = Date.now();
		etaDays = 0;
	}

	// Trend: compare last-7-day avg to prior-7-day avg
	const priorWindowStart = windowStart - windowDays * MS_PER_DAY;
	const priorPoints = store.dataPoints.filter(
		p => p.periodEndMs >= priorWindowStart && p.periodEndMs < windowStart,
	);
	let trend: IVelocityMetrics['trend'] = 'stable';
	if (priorPoints.length > 0) {
		const priorAvg = priorPoints.reduce((s, p) => s + p.unitsPerDay, 0) / priorPoints.length;
		if (priorAvg > 0) {
			const delta = (rollingAvg - priorAvg) / priorAvg;
			if      (delta >  0.15) { trend = 'accelerating'; }
			else if (delta < -0.15) { trend = 'decelerating'; }
		}
	}

	return {
		unitsPerDayRolling:  rollingAvg,
		unitsPerDayAllTime:  allTimeAvg,
		windowDays,
		dataPointCount:      store.dataPoints.length,
		totalUnits,
		completedUnits,
		remainingUnits,
		estimatedEtaMs:      etaMs,
		estimatedEtaDays:    etaDays,
		trend,
		lastUpdatedAt:       store.dataPoints[store.dataPoints.length - 1].recordedAt,
	};
}

function _zeroMetrics(
	totalUnits: number,
	completedUnits: number,
	remainingUnits: number,
): IVelocityMetrics {
	return {
		unitsPerDayRolling: 0,
		unitsPerDayAllTime: 0,
		windowDays:         DEFAULT_WINDOW_DAYS,
		dataPointCount:     0,
		totalUnits,
		completedUnits,
		remainingUnits,
		estimatedEtaMs:     undefined,
		estimatedEtaDays:   undefined,
		trend:              'stable',
		lastUpdatedAt:      Date.now(),
	};
}
