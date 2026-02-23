/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { Event, Emitter } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';

export const IEnclaveEnvironmentService = createDecorator<IEnclaveEnvironmentService>('neuralInverseEnclaveEnvironmentService');

/**
 * Enclave Enforcement Modes.
 *
 * - **OPEN**: "Open". No blocking. AI has full access. For rapid prototyping.
 * - **STANDARD**: "Standard Security". Blocks Critical security risks only. Standard AI tools.
 * - **LOCKED_DOWN**: "Locked Down". Blocks ALL violations. AI is restricted.
 */
export type EnclaveMode = 'open' | 'standard' | 'locked_down';

export interface IEnclaveEnvironmentService {
	readonly _serviceBrand: undefined;

	/**
	 * The current enforcement mode.
	 */
	readonly mode: EnclaveMode;

	/**
	 * Fires when the mode changes.
	 */
	readonly onDidChangeMode: Event<EnclaveMode>;

	/**
	 * Set the current enforcement mode.
	 */
	setMode(mode: EnclaveMode): void;
}

const STORAGE_KEY = 'neuralInverse.enclave.environmentMode';

export class EnclaveEnvironmentService extends Disposable implements IEnclaveEnvironmentService {
	declare readonly _serviceBrand: undefined;

	private _mode: EnclaveMode;

	private readonly _onDidChangeMode = this._register(new Emitter<EnclaveMode>());
	public readonly onDidChangeMode: Event<EnclaveMode> = this._onDidChangeMode.event;

	constructor(
		@IStorageService private readonly storageService: IStorageService
	) {
		super();

		// Load from storage or default to 'standard'
		// Note: Also checked the old GRC storage key for backward compatibility during migration
		const oldStoredMode = this.storageService.get('neuralInverse.grc.environmentMode', StorageScope.WORKSPACE);
		let storedMode = this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE, oldStoredMode ?? 'standard');

		// Map old modes to new modes if they exist in storage
		if (storedMode === 'draft') storedMode = 'open';
		if (storedMode === 'dev') storedMode = 'standard';
		if (storedMode === 'prod') storedMode = 'locked_down';

		this._mode = this._isValidMode(storedMode) ? storedMode : 'standard';
	}

	public get mode(): EnclaveMode {
		return this._mode;
	}

	public setMode(mode: EnclaveMode): void {
		if (this._mode === mode) {
			return;
		}

		this._mode = mode;
		this.storageService.store(STORAGE_KEY, mode, StorageScope.WORKSPACE, StorageTarget.USER);
		this._onDidChangeMode.fire(mode);
		console.log(`[EnclaveEnvironmentService] Switched to ${mode.toUpperCase()} mode`);
	}

	private _isValidMode(mode: string): mode is EnclaveMode {
		return mode === 'open' || mode === 'standard' || mode === 'locked_down';
	}
}

registerSingleton(IEnclaveEnvironmentService, EnclaveEnvironmentService, InstantiationType.Delayed);
