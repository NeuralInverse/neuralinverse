/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { session } from 'electron';
import { Disposable, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { Schemas } from '../../../base/common/network.js';
import { basename, normalize } from '../../../base/common/path.js';
import { isLinux } from '../../../base/common/platform.js';
import { TernarySearchTree } from '../../../base/common/ternarySearchTree.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { validatedIpcMain } from '../../../base/parts/ipc/electron-main/ipcMain.js';
import { INativeEnvironmentService } from '../../environment/common/environment.js';
import { ILogService } from '../../log/common/log.js';
import { IIPCObjectUrl, IProtocolMainService } from './protocol.js';
import { IUserDataProfilesService } from '../../userDataProfile/common/userDataProfile.js';

export class ProtocolMainService extends Disposable implements IProtocolMainService {

	declare readonly _serviceBrand: undefined;

	private readonly validRoots = TernarySearchTree.forPaths<boolean>(!isLinux);
	private readonly validRootsList: string[] = [];

	constructor(
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
		@IUserDataProfilesService userDataProfilesService: IUserDataProfilesService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		// Define valid file roots we allow loading from.
		// appRoot = src/ in dev mode, repoRoot = parent directory (covers out/ compiled output).
		const appRoot = environmentService.appRoot;
		const repoRoot = appRoot.replace(/[\\/]src$/, '');
		this.addValidFileRoot(appRoot);
		this.addValidFileRoot(repoRoot);
		this.addValidFileRoot(environmentService.extensionsPath);
		this.addValidFileRoot(userDataProfilesService.defaultProfile.globalStorageHome.with({ scheme: Schemas.file }).fsPath);
		this.addValidFileRoot(environmentService.workspaceStorageHome.with({ scheme: Schemas.file }).fsPath);

		// Handle protocols
		this.handleProtocols();
	}

	private handleProtocols(): void {
		const { defaultSession } = session;

		// Register vscode-file:// handler using file protocol (standard VS Code approach).
		// callback({ path }) lets Electron serve the file directly from the filesystem.
		defaultSession.protocol.registerFileProtocol(Schemas.vscodeFileResource, (request, callback) => {
			let path: string;
			try {
				path = this.requestToNormalizedFilePath(request);
			} catch (err) {
				this.logService.error(`${Schemas.vscodeFileResource}: Failed to parse request url ${request.url}`, err);
				return callback({ error: -3 /* ABORTED */ });
			}

			// Build headers for workbench.html / workbench-dev.html
			let headers: Record<string, string> = {};
			const pathBasename = basename(path);
			try {
				if (this.environmentService.crossOriginIsolated) {
					if (pathBasename === 'workbench.html' || pathBasename === 'workbench-dev.html') {
						headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
					}
				}
			} catch {
				// headers are optional
			}

			if (!this.environmentService.isBuilt) {
				headers = { ...headers, 'Cache-Control': 'no-cache, no-store, must-revalidate' };
			}

			if (pathBasename === 'workbench.html' || pathBasename === 'workbench-dev.html') {
				headers = { ...headers, 'Document-Policy': 'js-memory-limits=0' };
			}

			// Security: only serve files under valid roots (case-insensitive, since path
			// casing can vary on Windows).
			try {
				const lowerPath = path.toLowerCase();
				const roots = this.getAllValidRoots();
				const matchesRoot = roots.some(root => lowerPath.startsWith(root.toLowerCase()));
				if (matchesRoot) {
					return callback({ path, headers });
				}
			} catch {
				// fall through to abort
			}

			this.logService.error(`${Schemas.vscodeFileResource}: Refused to load resource ${path} from ${Schemas.vscodeFileResource}: protocol (original URL: ${request.url})`);
			return callback({ error: -3 /* ABORTED */ });
		});

		// Block any file:// access
		defaultSession.protocol.interceptFileProtocol(Schemas.file, (request, callback) => this.handleFileRequest(request, callback));

		// Cleanup
		this._register(toDisposable(() => {
			defaultSession.protocol.unregisterProtocol(Schemas.vscodeFileResource);
			defaultSession.protocol.uninterceptProtocol(Schemas.file);
		}));
	}

	addValidFileRoot(root: string): IDisposable {
		const normalizedRoot = normalize(root);

		if (!this.validRoots.get(normalizedRoot)) {
			this.validRoots.set(normalizedRoot, true);
			this.validRootsList.push(normalizedRoot);
			return toDisposable(() => {
				this.validRoots.delete(normalizedRoot);
				const index = this.validRootsList.indexOf(normalizedRoot);
				if (index >= 0) {
					this.validRootsList.splice(index, 1);
				}
			});
		}

		return Disposable.None;
	}

	getAllValidRoots(): string[] {
		return this.validRootsList;
	}

	//#region file://

	private handleFileRequest(
		request: Electron.ProtocolRequest,
		callback: (result: string | Electron.FilePathWithHeaders | { error: number }) => void
	) {
		const uri = URI.parse(request.url);
		this.logService.error(`Refused to load resource ${uri.fsPath} from ${Schemas.file}: protocol (original URL: ${request.url})`);
		return callback({ error: -3 /* ABORTED */ });
	}

	//#endregion

	private requestToNormalizedFilePath(request: Electron.ProtocolRequest): string {
		const requestUri = URI.parse(request.url);
		// For vscode-file:// URLs, the path after the authority is already a filesystem path.
		// e.g. vscode-file://vscode-app/c:/AI-Editors/... → /c:/AI-Editors/...
		let filePath = requestUri.path;
		if (filePath.startsWith('/')) {
			filePath = filePath.slice(1);
		}
		return normalize(filePath);
	}

	//#region IPC Object URLs

	createIPCObjectUrl<T>(): IIPCObjectUrl<T> {
		let obj: T | undefined = undefined;
		const resource = URI.from({
			scheme: 'vscode',
			path: generateUuid()
		});
		const channel = resource.toString();
		const handler = async (): Promise<T | undefined> => obj;
		validatedIpcMain.handle(channel, handler);
		this.logService.trace(`IPC Object URL: Registered new channel ${channel}.`);
		return {
			resource,
			update: updatedObj => obj = updatedObj,
			dispose: () => {
				this.logService.trace(`IPC Object URL: Removed channel ${channel}.`);
				validatedIpcMain.removeHandler(channel);
			}
		};
	}

	//#endregion
}
