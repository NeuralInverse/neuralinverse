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

export interface ITrackedExtension {
	id: string;
	displayName: string;
	version: string;
	publisher: string;
	isEnabled: boolean;
	status: ExtensionPolicyStatus;
	reason?: string;
	firstSeenTimestamp: number;
	categories?: string[];
	dependencyCount: number;
}

export type ExtensionPolicyStatus = 'allowed' | 'blocked' | 'flagged' | 'required' | 'unknown';

export interface IExtensionPolicyRule {
	pattern: string;
	action: 'block' | 'flag' | 'allow' | 'require';
	reason: string;
}

export interface IExtensionStats {
	totalInstalled: number;
	enabled: number;
	disabled: number;
	blocked: number;
	flagged: number;
	required: number;
	missingRequired: number;
	lastScanTimestamp: number;
}

export interface IExtensionChangeEvent {
	type: 'installed' | 'uninstalled' | 'enabled' | 'disabled' | 'blocked' | 'flagged';
	extensionId: string;
	displayName?: string;
	reason?: string;
}
