/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { Event, Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';

export const IEnclaveEnvironmentService = createDecorator<IEnclaveEnvironmentService>('neuralInverseEnclaveEnvironmentService');

/**
 * Enclave Enforcement Modes.
 *
 * - **DRAFT**: "Chaos Mode". No blocking. AI has full access. For rapid prototyping.
 * - **DEV**: "Standard". Blocks Critical security risks only. Standard AI tools.
 * - **PROD**: "Zero Trust". Blocks ALL violations. AI is restricted.
 */
export type EnclaveMode = 'draft' | 'dev' | 'prod';

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

		// Load from storage or default to 'dev'
		// Note: Also checked the old GRC storage key for backward compatibility during migration
		const oldStoredMode = this.storageService.get('neuralInverse.grc.environmentMode', StorageScope.WORKSPACE);
		const storedMode = this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE, oldStoredMode ?? 'dev');
		this._mode = this._isValidMode(storedMode) ? storedMode : 'dev';
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
		return mode === 'draft' || mode === 'dev' || mode === 'prod';
	}
}

registerSingleton(IEnclaveEnvironmentService, EnclaveEnvironmentService, InstantiationType.Delayed);
