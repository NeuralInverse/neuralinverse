/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IUpdateService, StateType } from '../../../../platform/update/common/update.js';
import { IVoidUpdateService } from '../common/voidUpdateService.js';
import { VoidCheckUpdateRespose } from '../common/voidUpdateServiceTypes.js';
import { IVoidAutoUpdaterService } from './voidAutoUpdaterService.js';



export class VoidMainUpdateService extends Disposable implements IVoidUpdateService {
	_serviceBrand: undefined;

	constructor(
		@IProductService _productService: IProductService,
		@IEnvironmentMainService private readonly _envMainService: IEnvironmentMainService,
		@IUpdateService private readonly _updateService: IUpdateService,
		@IVoidAutoUpdaterService private readonly _autoUpdater: IVoidAutoUpdaterService,
	) {
		super()
	}


	async check(explicit: boolean): Promise<VoidCheckUpdateRespose> {

		const isDevMode = !this._envMainService.isBuilt

		if (isDevMode) {
			return { message: null } as const
		}

		// If update is already downloaded and ready — surface it immediately
		if (this._autoUpdater.state.type === 'ready') {
			return {
				message: `Neural Inverse ${this._autoUpdater.state.version} is ready — restart to update!`,
				action: 'apply',
			} as const
		}

		// If already downloading in background — let the user know only if explicit
		if (this._autoUpdater.state.type === 'downloading') {
			return explicit
				? { message: 'Downloading update in background...' } as const
				: { message: null } as const
		}

		// Standard VS Code update service (works when app is signed + updateUrl set)
		if (this._updateService.state.type !== StateType.Disabled) {
			this._updateService.checkForUpdates(false)

			if (this._updateService.state.type === StateType.Idle) {
				return { message: explicit ? 'No updates found!' : null, action: explicit ? undefined : undefined } as const
			}
			if (this._updateService.state.type === StateType.CheckingForUpdates) {
				return { message: explicit ? 'Checking for updates...' : null } as const
			}
			if (this._updateService.state.type === StateType.AvailableForDownload) {
				return { message: 'A new update is available!', action: 'download' } as const
			}
			if (this._updateService.state.type === StateType.Downloading) {
				return { message: explicit ? 'Downloading update...' : null } as const
			}
			if (this._updateService.state.type === StateType.Downloaded) {
				return { message: explicit ? 'Update ready to apply!' : null, action: 'apply' } as const
			}
			if (this._updateService.state.type === StateType.Updating) {
				return { message: explicit ? 'Applying update...' : null } as const
			}
			if (this._updateService.state.type === StateType.Ready) {
				return { message: 'Restart Neural Inverse to update!', action: 'restart' } as const
			}
		}

		// Fallback: use our auto-updater (unsigned builds, no updateUrl, etc.)
		return await this._autoCheck(explicit)
	}

	async applyAutoUpdate(): Promise<void> {
		this._autoUpdater.applyUpdate()
	}


	private async _autoCheck(explicit: boolean): Promise<VoidCheckUpdateRespose> {
		try {
			const update = await this._autoUpdater.check()

			if (!update) {
				// up to date or error
				const s = this._autoUpdater.state
				if (s.type === 'up-to-date') {
					return explicit ? { message: 'Neural Inverse is up-to-date!' } as const : { message: null } as const
				}
				if (s.type === 'error') {
					return explicit
						? { message: `Could not check for updates: ${s.message}` } as const
						: { message: null } as const
				}
				return { message: null } as const
			}

			// Update available — start background download immediately
			this._startBackgroundDownload(update.downloadUrl, update.version)

			return {
				message: `Neural Inverse ${update.version} is available — downloading in background...`,
			} as const

		} catch (e) {
			return explicit
				? { message: `Error checking for updates: ${e}` } as const
				: { message: null } as const
		}
	}

	private _startBackgroundDownload(downloadUrl: string, version: string): void {
		this._autoUpdater.download(downloadUrl, version).then(() => {
			// Download finished — the next check() call will surface the 'apply' action
			// We don't notify here; the periodic auto-check in voidUpdateActions will pick it up
		}).catch((e) => {
			console.error('[VoidAutoUpdater] Background download failed:', e)
		})
	}
}
