/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode, h } from '../../../../base/browser/dom.js';
import { KeybindingLabel } from '../../../../base/browser/ui/keybindingLabel/keybindingLabel.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { OS } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { defaultKeybindingLabelStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { editorForeground, registerColor, transparent } from '../../../../platform/theme/common/colorRegistry.js';
import { ColorScheme } from '../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { FileAccess } from '../../../../base/common/network.js';

const NI_WORKSPACE_SHORTCUTS: { label: string; commandId: string }[] = [
	{ label: 'Agents', commandId: 'neuralInverse.openAgentManager' },
	{ label: 'Firmware', commandId: 'neuralInverse.openFirmware' },
	{ label: 'Legacy', commandId: 'neuralInverse.openModernisation' },
];

export class EditorGroupWatermark extends Disposable {

	private static readonly SETTINGS_KEY = 'workbench.tips.enabled';

	private readonly shortcuts: HTMLElement;
	private readonly toolbarContainer: HTMLElement;
	private readonly transientDisposables = this._register(new DisposableStore());
	private currentDisposables = new Set<IDisposable>();

	private workbenchState: WorkbenchState;

	constructor(
		container: HTMLElement,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService _storageService: IStorageService,
		@IThemeService private readonly themeService: IThemeService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();

		this.workbenchState = this.contextService.getWorkbenchState();

		const elements = h('.editor-group-watermark-wrapper', [
			h('.editor-group-watermark-toolbar-container@toolbarContainer'),
			h('.editor-group-watermark', [
				h('.shortcuts@shortcuts'),
			])
		]);

		append(container, elements.root);
		this.shortcuts = elements.shortcuts;
		this.toolbarContainer = elements.toolbarContainer;

		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, this.toolbarContainer, MenuId.EditorGroupWatermarkToolbar, {
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			highlightToggledItems: true,
			menuOptions: { shouldForwardArgs: true }
		}));

		this.registerListeners();
		this.render();
	}

	private registerListeners(): void {
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(EditorGroupWatermark.SETTINGS_KEY)) {
				this.render();
			}
		}));

		this._register(this.contextService.onDidChangeWorkbenchState(workbenchState => {
			if (this.workbenchState !== workbenchState) {
				this.workbenchState = workbenchState;
				this.render();
			}
		}));

		this._register(this.themeService.onDidColorThemeChange(() => {
			this.render();
		}));
	}

	private render(): void {
		clearNode(this.shortcuts);
		this.transientDisposables.clear();
		this.currentDisposables.forEach(d => d.dispose());
		this.currentDisposables.clear();

		const enabled = this.configurationService.getValue<boolean>(EditorGroupWatermark.SETTINGS_KEY);
		if (!enabled) { return; }

		const isEmpty = this.workbenchState === WorkbenchState.EMPTY;
		const isDark = (() => {
			const type = this.themeService.getColorTheme().type;
			return type === ColorScheme.DARK || type === ColorScheme.HIGH_CONTRAST_DARK;
		})();

		const logoUri = FileAccess.asBrowserUri('vs/workbench/browser/parts/editor/media/neuralinverse_logo.png').toString(true);

		if (isEmpty) {
			// Empty window: right-aligned Neural Inverse branding (matches OG)
			this.shortcuts.style.cssText = 'display:flex!important;flex-direction:row!important;align-items:center!important;justify-content:flex-end!important;width:100%!important;height:100%!important;max-width:none!important;margin:0!important;padding:0!important;box-sizing:border-box!important;';

			const panel = append(this.shortcuts, $('div'));
			panel.style.cssText = 'display:flex!important;flex-direction:column!important;align-items:flex-start!important;margin-right:8%!important;user-select:none!important;flex-shrink:0!important;width:auto!important;height:auto!important;';

			// Brand row: logo + title inline
			const brandRow = append(panel, $('div'));
			brandRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:0;';

			const logoImg = append(brandRow, $('img')) as HTMLImageElement;
			logoImg.src = logoUri;
			logoImg.style.cssText = `width:80px;height:80px;object-fit:contain;flex-shrink:0;mix-blend-mode:screen;margin-top:6px;${isDark ? '' : 'filter:invert(1);'}`;

			const nameDiv = append(brandRow, $('div'));
			nameDiv.style.cssText = 'font-size:52px;font-weight:700;color:var(--vscode-foreground);opacity:.82;letter-spacing:-1.5px;line-height:1;white-space:nowrap;';
			nameDiv.textContent = 'Neural Inverse';

			// Tagline indented to align under title (past the logo)
			const tagline = append(panel, $('div'));
			tagline.style.cssText = 'font-size:14px;color:var(--vscode-foreground);opacity:.38;text-align:left;line-height:1.75;margin-left:88px;';
			tagline.textContent = 'AI-native IDE for regulated software.';

		} else {
			// Workspace open: logo + name footer + NI shortcut row
			this.shortcuts.style.cssText = '';

			const box = append(this.shortcuts, $('.watermark-box'));

			// Footer: logo + "Neural Inverse"
			const footer = append(box, $('div'));
			footer.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:20px;opacity:0.55;user-select:none;cursor:default;';

			const footerImg = append(footer, $('img')) as HTMLImageElement;
			footerImg.src = logoUri;
			footerImg.style.cssText = `height:32px;width:auto;object-fit:contain;${isDark ? 'filter:invert(1);' : ''}`;

			const footerName = append(footer, $('div'));
			footerName.style.cssText = 'font-size:22px;font-weight:500;color:var(--vscode-foreground);letter-spacing:-.5px;';
			footerName.textContent = 'Neural Inverse';

			// Shortcut row
			const keysRow = append(box, $('div'));
			keysRow.style.cssText = 'display:flex;flex-direction:row;justify-content:center;align-items:center;gap:48px;';

			const updateShortcuts = () => {
				clearNode(keysRow);
				this.currentDisposables.forEach(d => d.dispose());
				this.currentDisposables.clear();

				for (const shortcut of NI_WORKSPACE_SHORTCUTS) {
					const kb = this.keybindingService.lookupKeybinding(shortcut.commandId);
					const dl = append(keysRow, $('dl'));
					dl.style.cssText = 'display:flex;align-items:center;gap:5px;margin:0;';
					const dt = append(dl, $('dt'));
					dt.textContent = shortcut.label;
					const dd = append(dl, $('dd'));
					const kbLabel = new KeybindingLabel(dd, OS, { renderUnboundKeybindings: true, ...defaultKeybindingLabelStyles });
					if (kb) { kbLabel.set(kb); }
					this.currentDisposables.add(kbLabel);
				}
			};

			updateShortcuts();
			this.transientDisposables.add(this.keybindingService.onDidUpdateKeybindings(updateShortcuts));
		}
	}

	override dispose(): void {
		this.currentDisposables.forEach(d => d.dispose());
		this.currentDisposables.clear();
		super.dispose();
	}
}

registerColor('editorWatermark.foreground', { dark: transparent(editorForeground, 0.6), light: transparent(editorForeground, 0.68), hcDark: editorForeground, hcLight: editorForeground }, localize('editorLineHighlight', 'Foreground color for the labels in the editor watermark.'));
