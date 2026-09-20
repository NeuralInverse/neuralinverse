/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * B1 memory management UI (task 2026-09-15 §B1)
 *
 * Command-based manager for the agent memory store: list / pin / unpin /
 * edit / forget / add, plus the auto-capture toggle. QuickPick + InputBox —
 * no webview dependency, works in every window.
 */

import { localize } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IAgentMemoryService } from './agentMemoryService.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { memoryKeyOf } from './agentMemoryConsolidationContrib.js';

export abstract class ManageMemoryAction extends Action2 {
	abstract override run(accessor: ServicesAccessor): Promise<void>;
}

interface MemoryPickItem extends IQuickPickItem {
	entryId?: string;
	action?: 'add' | 'toggle-capture' | 'pin' | 'unpin' | 'edit' | 'forget' | 'back';
}

export class ManageAgentMemoryAction extends ManageMemoryAction {
	static readonly ID = 'void.manageAgentMemory';
	constructor() {
		super({ id: ManageAgentMemoryAction.ID, title: { value: localize('void.manageAgentMemory', "Manage Agent Memory"), original: 'Manage Agent Memory' }, category: Categories.Developer, f1: true });
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const memory = accessor.get(IAgentMemoryService);
		const quickInput = accessor.get(IQuickInputService);
		const settings = accessor.get(IVoidSettingsService);

		const choose = async (): Promise<void> => {
			const captureOn = settings.state.globalSettings.autoMemoryCaptureEnabled;
			const entries = memory.getAllEntries();
			const picks: MemoryPickItem[] = entries.map((e: ReturnType<IAgentMemoryService['getAllEntries']>[number]) => ({
				entryId: e.id,
				label: `${e.pinned ? '$(pin)' : '$(circle-outline)'} ${e.type}: ${e.content.length > 80 ? e.content.slice(0, 77) + '…' : e.content}`,
				description: e.tags.filter(t => t.startsWith('thread:') || t === 'ledger').join(' ') || undefined,
				detail: e.content,
			}));
			const addPick: MemoryPickItem = { action: 'add', label: '$(add) Add a memory…' };
			picks.push(addPick);
			const togglePick: MemoryPickItem = { action: 'toggle-capture', label: captureOn ? '$(eye) Auto-capture from episodes: ON' : '$(eye-closed) Auto-capture from episodes: OFF' };
			picks.push(togglePick);

			const picked = await new Promise<MemoryPickItem | undefined>(resolve => {
				const pick = quickInput.createQuickPick<MemoryPickItem>();
				pick.items = picks;
				pick.placeholder = localize('void.manageAgentMemory.placeholder', "Select a memory to manage ({0} entries)", entries.length);
				pick.onDidAccept(() => { resolve(pick.selectedItems[0]); pick.hide(); });
				pick.onDidHide(() => { resolve(undefined); });
				pick.show();
			});
			if (!picked) { return; }

			if (picked.action === 'toggle-capture') {
				settings.setGlobalSetting('autoMemoryCaptureEnabled', !captureOn);
				return choose(); // show the flipped state
			}
			if (picked.action === 'add') {
				const content = await quickInput.input({
					placeHolder: localize('void.manageAgentMemory.add', "Memory content (a preference, rule or project fact)"),
					prompt: localize('void.manageAgentMemory.add.prompt', "Stored as a manual preference; recalled when relevant."),
				});
				if (content && content.trim().length > 0) {
					memory.remember('preference', content.trim(), [memoryKeyOf(content.trim()), 'manual'], 'manual');
				}
				return choose();
			}
			if (picked.entryId === undefined) { return; }
			const entry = memory.getAllEntries().find(e => e.id === picked.entryId);
			if (!entry) { return choose(); }

			const actionItems: MemoryPickItem[] = [
				{ action: entry.pinned ? 'unpin' : 'pin', entryId: entry.id, label: entry.pinned ? '$(pin) Unpin' : '$(pin) Pin (never evicted)' },
				{ action: 'edit', entryId: entry.id, label: '$(edit) Edit content' },
				{ action: 'forget', entryId: entry.id, label: '$(trash) Forget' },
				{ action: 'back', label: '$(arrow-left) Back' },
			];
			const action = await new Promise<MemoryPickItem | undefined>(resolve => {
				const pick = quickInput.createQuickPick<MemoryPickItem>();
				pick.items = actionItems;
				pick.placeholder = entry.content;
				pick.onDidAccept(() => { resolve(pick.selectedItems[0]); pick.hide(); });
				pick.onDidHide(() => { resolve(undefined); });
				pick.show();
			});
			if (!action) { return; }
			if (action.action === 'pin' && action.entryId !== undefined) { memory.pin(action.entryId); }
			else if (action.action === 'unpin' && action.entryId !== undefined) { memory.unpin(action.entryId); }
			else if (action.action === 'forget' && action.entryId !== undefined) { memory.forget(action.entryId); }
			else if (action.action === 'edit') {
				const edited = await quickInput.input({ value: entry.content, prompt: localize('void.manageAgentMemory.edit', "Edit the memory content") });
				if (edited !== undefined && edited.trim().length > 0 && edited !== entry.content) {
					const wasPinned = entry.pinned;
					const tags = entry.tags.includes('manual') ? [...entry.tags] : [...entry.tags, 'manual'];
					memory.forget(entry.id);
					const created = memory.remember(entry.type, edited.trim(), tags.includes(memoryKeyOf(entry.content)) ? tags : [memoryKeyOf(edited.trim()), ...tags.filter(t => t !== memoryKeyOf(entry.content))], 'manual');
					if (wasPinned) { memory.pin(created.id); }
				}
			}
			if (action.action !== 'back') { return choose(); }
			return choose();
		};

		await choose();
	}
}

registerAction2(ManageAgentMemoryAction);
