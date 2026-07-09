/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *
 *  Licensed under the Business Source License 1.1 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at https://mariadb.com/bsl11
 *
 *  Change Date: 2029-07-14
 *  Change License: GNU Affero General Public License v3.0
 *
 *  Use of this software in production requires a commercial license from Neural Inverse Inc.
 *  Contact (code): github@neuralinverse.com | Contact (sales): sales@neuralinverse.com
 *--------------------------------------------------------------------------------------------*/

export interface ITrackedDependency {
	name: string;
	versionConstraint: string;
	resolvedVersion?: string;
	isDev: boolean;
	ecosystem: DependencyEcosystem;
	sourceFile: string;
	status: DependencyStatus;
	reason?: string;
}

export type DependencyEcosystem = 'npm' | 'pip' | 'go' | 'cargo' | 'maven' | 'nuget' | 'unknown';
export type DependencyStatus = 'allowed' | 'blocked' | 'flagged' | 'unknown';

export interface IDependencyPolicyRule {
	pattern: string;
	action: 'block' | 'flag' | 'allow';
	reason: string;
	ecosystems?: DependencyEcosystem[];
}

export interface IDependencyStats {
	totalDependencies: number;
	devDependencies: number;
	prodDependencies: number;
	blocked: number;
	flagged: number;
	byEcosystem: Partial<Record<DependencyEcosystem, number>>;
	lastScanTimestamp: number;
}

export interface IDependencyChangeEvent {
	type: 'added' | 'removed' | 'updated';
	dependency: ITrackedDependency;
	sourceFile: string;
}
