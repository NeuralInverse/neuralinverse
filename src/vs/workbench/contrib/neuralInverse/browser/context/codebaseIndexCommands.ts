/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceSymbolIndexService } from './index/workspaceSymbolIndex.js';
import { IHybridSearchService } from './search/hybridSearchService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IStatusbarService, StatusbarAlignment, IStatusbarEntryAccessor } from '../../../../services/statusbar/browser/statusbar.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';

class CodebaseIndexStatusContribution extends Disposable {

	static readonly ID = 'workbench.contrib.codebaseIndexStatus';

	private readonly _entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._update();
		this._register(this._instantiationService.invokeFunction(a => {
			const symbolIndex = a.get(IWorkspaceSymbolIndexService);
			const store = new DisposableStore();
			store.add(symbolIndex.onDidFinishFullIndex(() => this._update()));
			store.add(symbolIndex.onDidStartFullIndex(() => this._update()));
			store.add(symbolIndex.onDidReindex(() => this._update()));
			return store;
		}));
	}

	private _update(): void {
		const symbolIndex = this._instantiationService.invokeFunction(a => a.get(IWorkspaceSymbolIndexService));
		const hybridSearch = this._instantiationService.invokeFunction(a => a.get(IHybridSearchService));
		const stats = symbolIndex.getStats();
		const searchStatus = hybridSearch.getStatus();

		let text: string;
		let tooltip: string;

		if (stats.indexingInProgress) {
			text = '$(sync~spin) Indexing…';
			tooltip = `Indexing codebase: ${stats.lastRun?.discovered || stats.totalFiles} files so far…`;
		} else if (stats.lastRun?.failed) {
			text = `$(error) Index: failed`;
			tooltip = `Last indexing run failed: ${stats.lastRun.error ?? 'unknown error'}. Click to retry.`;
		} else if (stats.indexCapped) {
			text = `$(warning) Index: ${stats.totalFiles}+ (capped)`;
			tooltip = `Codebase index capped at ${stats.totalFiles} files. The workspace has more source files than the 25,000 file limit.`;
		} else if (stats.totalFiles > 0) {
			text = `$(search) ${stats.totalFiles} files`;
			tooltip = `Codebase index: ${stats.totalFiles} files, ${stats.totalSymbols} symbols, ${searchStatus.bm25Files} searchable.`;
		} else {
			text = '$(search) Index: empty';
			tooltip = 'Codebase index is empty. It will populate automatically ~20 seconds after opening.';
		}

		this._entry.value = this._statusbarService.addEntry({
			name: 'Neural Inverse Codebase Index',
			text,
			ariaLabel: tooltip,
			tooltip,
			command: 'neuralInverse.reindexCodebase',
		}, 'neuralInverse.codebaseIndexStatus', StatusbarAlignment.RIGHT, 0);
	}
}

registerWorkbenchContribution2(
	CodebaseIndexStatusContribution.ID,
	CodebaseIndexStatusContribution,
	WorkbenchPhase.Eventually,
);

registerAction2(class ReindexCodebaseAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.reindexCodebase',
			title: localize2('neuralInverse.reindexCodebase', 'Neural Inverse: Reindex Codebase'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const symbolIndex = accessor.get(IWorkspaceSymbolIndexService);
		const notificationService = accessor.get(INotificationService);
		const hybridSearch = accessor.get(IHybridSearchService);

		notificationService.info('Reindexing codebase…');
		await symbolIndex.forceReindex();

		const stats = symbolIndex.getStats();
		const searchStatus = hybridSearch.getStatus();
		const run = stats.lastRun;

		if (run?.failed) {
			notificationService.warn(`Indexing failed: ${run.error ?? 'unknown error'}. Discovered ${run.discovered} files before the failure; the previous index (if any) is still in use.`);
			return;
		}
		if (!run) {
			notificationService.info(`Index complete: ${stats.totalFiles} files, ${stats.totalSymbols} symbols, ${searchStatus.bm25Files} searchable (lexical). Vector search: ${searchStatus.embeddingsAvailable ? 'available' : 'not configured'}.`);
			return;
		}

		const rejections = Object.entries(run.rejected)
			.map(([reason, count]) => `${count} ${reason}`)
			.join(', ');
		notificationService.info(
			`Index complete: ${run.discovered} files discovered, ${run.indexed} indexed (${run.unchanged} unchanged), ` +
			`${stats.totalSymbols} symbols, ${searchStatus.bm25Files} searchable (lexical). ` +
			`Vector search: ${searchStatus.embeddingsAvailable ? 'available' : 'not configured'}.` +
			(stats.indexCapped ? ' Capped at the 25,000-file limit; later files were skipped.' : '') +
			(rejections ? ` Skipped: ${rejections}.` : '')
		);
	}
});
