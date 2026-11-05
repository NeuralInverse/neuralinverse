/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *  Licensed under the Business Source License 1.1 (the "License").
 *  Change Date: 2029-07-14 | Change License: GNU Affero General Public License v3.0
 *--------------------------------------------------------------------------------------------*/
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IFileService } from '../../../../../platform/files/common/files.js';

export interface IAnalysisState {
	status: 'idle' | 'running' | 'complete' | 'error';
	filesAnalyzed: number;
	totalFiles: number;
	message?: string;
}

export interface IProjectCheckpoint {
	hash: string;
	message: string;
	timestamp: number;
	author: string;
}

class ProjectHistoryService {
	async getCheckpoints(): Promise<IProjectCheckpoint[]> { return []; }
	async getChangedFiles(_hash: string): Promise<string[]> { return []; }
}

/**
 * ProjectAnalyzer — scans the workspace for GRC-relevant project metadata.
 * OSS stub: returns empty data, never throws.
 */
export class ProjectAnalyzer extends Disposable {
	readonly historyService = new ProjectHistoryService();

	private _state: IAnalysisState = { status: 'idle', filesAnalyzed: 0, totalFiles: 0 };

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IEditorService private readonly _editorService: IEditorService,
		@IModelService private readonly _modelService: IModelService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
		void this._instantiationService;
		void this._editorService;
		void this._modelService;
		void this._fileService;
	}

	getAnalysisState(): IAnalysisState {
		return { ...this._state };
	}

	async analyzeProject(): Promise<void> {
		this._state = { status: 'complete', filesAnalyzed: 0, totalFiles: 0, message: 'OSS stub' };
	}
}
