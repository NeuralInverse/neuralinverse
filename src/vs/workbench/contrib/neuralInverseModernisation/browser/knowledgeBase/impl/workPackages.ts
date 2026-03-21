/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Work package management.
 *
 * Work packages are ad-hoc organisational groupings of units independent of
 * migration phases. Typical uses:
 *   - Assign a batch of units to a specific developer or team
 *   - Group units for a sprint or release
 *   - Track parallelisable work streams
 *
 * A unit can only belong to one work package at a time.
 */

import { IWorkPackage } from '../../../common/knowledgeBaseTypes.js';
import { makeId } from './helpers.js';

// ─── Work package store ───────────────────────────────────────────────────────

export interface IWorkPackageStore {
	packages: Map<string, IWorkPackage>;  // pkgId → package
	unitIndex: Map<string, string>;        // unitId → pkgId (1:1)
}

export function createWorkPackageStore(): IWorkPackageStore {
	return {
		packages:  new Map(),
		unitIndex: new Map(),
	};
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function createWorkPackage(
	store: IWorkPackageStore,
	pkg: Omit<IWorkPackage, 'id' | 'createdAt'>,
): IWorkPackage {
	const newPkg: IWorkPackage = {
		...pkg,
		id:        makeId('wp'),
		createdAt: Date.now(),
		unitIds:   [...(pkg.unitIds ?? [])],
	};
	store.packages.set(newPkg.id, newPkg);

	// Index all initial units
	for (const unitId of newPkg.unitIds) {
		store.unitIndex.set(unitId, newPkg.id);
	}

	return newPkg;
}

export function updateWorkPackage(
	store: IWorkPackageStore,
	id: string,
	patch: Partial<Omit<IWorkPackage, 'id' | 'createdAt'>>,
): void {
	const existing = store.packages.get(id);
	if (!existing) { return; }

	// If unitIds changed, reindex
	if (patch.unitIds) {
		// Remove old unit mappings for this package
		for (const [unitId, pkgId] of store.unitIndex) {
			if (pkgId === id) { store.unitIndex.delete(unitId); }
		}
		// Add new mappings
		for (const unitId of patch.unitIds) {
			store.unitIndex.set(unitId, id);
		}
	}

	store.packages.set(id, { ...existing, ...patch });
}

export function getWorkPackage(
	store: IWorkPackageStore,
	id: string,
): IWorkPackage | undefined {
	return store.packages.get(id);
}

export function getAllWorkPackages(store: IWorkPackageStore): IWorkPackage[] {
	return Array.from(store.packages.values());
}

export function deleteWorkPackage(
	store: IWorkPackageStore,
	id: string,
): void {
	const pkg = store.packages.get(id);
	if (!pkg) { return; }

	// Remove unit index entries
	for (const unitId of pkg.unitIds) {
		store.unitIndex.delete(unitId);
	}
	store.packages.delete(id);
}

// ─── Unit assignment ──────────────────────────────────────────────────────────

export function addUnitToWorkPackage(
	store: IWorkPackageStore,
	pkgId: string,
	unitId: string,
): void {
	const pkg = store.packages.get(pkgId);
	if (!pkg) { return; }

	// Remove from existing package (units are 1:1 with packages)
	const existingPkgId = store.unitIndex.get(unitId);
	if (existingPkgId && existingPkgId !== pkgId) {
		const existingPkg = store.packages.get(existingPkgId);
		if (existingPkg) {
			store.packages.set(existingPkgId, {
				...existingPkg,
				unitIds: existingPkg.unitIds.filter(id => id !== unitId),
			});
		}
	}

	if (!pkg.unitIds.includes(unitId)) {
		store.packages.set(pkgId, { ...pkg, unitIds: [...pkg.unitIds, unitId] });
	}
	store.unitIndex.set(unitId, pkgId);
}

export function removeUnitFromWorkPackage(
	store: IWorkPackageStore,
	pkgId: string,
	unitId: string,
): void {
	const pkg = store.packages.get(pkgId);
	if (!pkg) { return; }

	store.packages.set(pkgId, {
		...pkg,
		unitIds: pkg.unitIds.filter(id => id !== unitId),
	});

	if (store.unitIndex.get(unitId) === pkgId) {
		store.unitIndex.delete(unitId);
	}
}

export function getWorkPackageForUnit(
	store: IWorkPackageStore,
	unitId: string,
): IWorkPackage | undefined {
	const pkgId = store.unitIndex.get(unitId);
	return pkgId ? store.packages.get(pkgId) : undefined;
}
