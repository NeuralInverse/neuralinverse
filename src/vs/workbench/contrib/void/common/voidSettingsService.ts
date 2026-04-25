/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IEncryptionService } from '../../../../platform/encryption/common/encryptionService.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IMetricsService } from './metricsService.js';
import { defaultProviderSettings, getModelCapabilities, ModelOverrides, neuralInverseModelDisplayNames } from './modelCapabilities.js';
import { NEURAL_INVERSE_DEFAULT_ENDPOINT } from './neuralInverseConfig.js';
import { VOID_SETTINGS_STORAGE_KEY } from './storageKeys.js';
import { defaultSettingsOfProvider, FeatureName, ProviderName, ModelSelectionOfFeature, SettingsOfProvider, SettingName, providerNames, ModelSelection, modelSelectionsEqual, featureNames, VoidStatefulModelInfo, GlobalSettings, GlobalSettingName, defaultGlobalSettings, ModelSelectionOptions, OptionsOfModelSelection, ChatMode, OverridesOfModel, defaultOverridesOfModel, MCPUserStateOfName as MCPUserStateOfName, MCPUserState, displayInfoOfProviderName } from './voidSettingsTypes.js';
import { IEnterprisePolicyService } from './enterprisePolicyService.js';
import { EnterpriseModelPolicy } from './enterprisePolicyTypes.js';


// name is the name in the dropdown
export type ModelOption = { name: string, selection: ModelSelection }



type SetSettingOfProviderFn = <S extends SettingName>(
	providerName: ProviderName,
	settingName: S,
	newVal: SettingsOfProvider[ProviderName][S extends keyof SettingsOfProvider[ProviderName] ? S : never],
) => Promise<void>;

type SetModelSelectionOfFeatureFn = <K extends FeatureName>(
	featureName: K,
	newVal: ModelSelectionOfFeature[K],
) => Promise<void>;

type SetGlobalSettingFn = <T extends GlobalSettingName>(settingName: T, newVal: GlobalSettings[T]) => void;

type SetOptionsOfModelSelection = (featureName: FeatureName, providerName: ProviderName, modelName: string, newVal: Partial<ModelSelectionOptions>) => void


export type VoidSettingsState = {
	readonly settingsOfProvider: SettingsOfProvider; // optionsOfProvider
	readonly modelSelectionOfFeature: ModelSelectionOfFeature; // stateOfFeature
	readonly optionsOfModelSelection: OptionsOfModelSelection;
	readonly overridesOfModel: OverridesOfModel;
	readonly globalSettings: GlobalSettings;
	readonly mcpUserStateOfName: MCPUserStateOfName; // user-controlled state of MCP servers

	readonly _modelOptions: ModelOption[] // computed based on the two above items

	// ARCH-001: Enterprise policy state
	readonly isEnterpriseManaged: boolean;
	readonly enterprisePolicyMode: 'enforced' | 'byollm' | null;
	readonly enterprisePolicy: EnterpriseModelPolicy | null;  // raw policy for sub-policy UI checks
}

// type RealVoidSettings = Exclude<keyof VoidSettingsState, '_modelOptions'>
// type EventProp<T extends RealVoidSettings = RealVoidSettings> = T extends 'globalSettings' ? [T, keyof VoidSettingsState[T]] : T | 'all'


export interface IVoidSettingsService {
	readonly _serviceBrand: undefined;
	readonly state: VoidSettingsState; // in order to play nicely with react, you should immutably change state
	readonly waitForInitState: Promise<void>;

	onDidChangeState: Event<void>;

	setSettingOfProvider: SetSettingOfProviderFn;
	setModelSelectionOfFeature: SetModelSelectionOfFeatureFn;
	setOptionsOfModelSelection: SetOptionsOfModelSelection;
	setGlobalSetting: SetGlobalSettingFn;
	// setMCPServerStates: (newStates: MCPServerStates) => Promise<void>;

	// setting to undefined CLEARS it, unlike others:
	setOverridesOfModel(providerName: ProviderName, modelName: string, overrides: Partial<ModelOverrides> | undefined): Promise<void>;

	dangerousSetState(newState: VoidSettingsState): Promise<void>;
	resetState(): Promise<void>;

	setAutodetectedModels(providerName: ProviderName, modelNames: string[], logging: object): void;
	toggleModelHidden(providerName: ProviderName, modelName: string): void;
	addModel(providerName: ProviderName, modelName: string): void;
	deleteModel(providerName: ProviderName, modelName: string): boolean;

	addMCPUserStateOfNames(userStateOfName: MCPUserStateOfName): Promise<void>;
	removeMCPUserStateOfNames(serverNames: string[]): Promise<void>;
	setMCPServerState(serverName: string, state: MCPUserState): Promise<void>;
}




const _modelsWithSwappedInNewModels = (options: { existingModels: VoidStatefulModelInfo[], models: string[], type: 'autodetected' | 'default' }) => {
	const { existingModels, models, type } = options

	const existingModelsMap: Record<string, VoidStatefulModelInfo> = {}
	for (const existingModel of existingModels) {
		existingModelsMap[existingModel.modelName] = existingModel
	}

	const newDetectedModels = models.map((modelName) => ({ modelName, type, isHidden: !!existingModelsMap[modelName]?.isHidden, }))

	// When the server returns an authoritative autodetected list, hide any default models
	// not in that list. This lets IAM policy enforcement on the server control which models
	// are visible without requiring us to remove hardcoded defaults.
	const detectedSet = type === 'autodetected' && models.length > 0 ? new Set(models) : null

	return [
		...newDetectedModels,
		...existingModels
			.filter(m => m.type !== type && !detectedSet?.has(m.modelName))
			.map(m => ({
				...m,
				isHidden: detectedSet ? !detectedSet.has(m.modelName) : m.isHidden,
			}))
	]
}


export const modelFilterOfFeatureName: {
	[featureName in FeatureName]: {
		filter: (
			o: ModelSelection,
			opts: { chatMode: ChatMode, overridesOfModel: OverridesOfModel }
		) => boolean;
		emptyMessage: null | { message: string, priority: 'always' | 'fallback' }
	} } = {
	'Autocomplete': { filter: (o, opts) => getModelCapabilities(o.providerName, o.modelName, opts.overridesOfModel).supportsFIM, emptyMessage: { message: 'No models support FIM', priority: 'always' } },
	'Chat': { filter: o => true, emptyMessage: null, },
	'Ctrl+K': { filter: o => true, emptyMessage: null, },
	'Apply': { filter: o => true, emptyMessage: null, },
	'SCM': { filter: o => true, emptyMessage: null, },
	'Checks': { filter: o => true, emptyMessage: null, },
}


const _stateWithMergedDefaultModels = (state: VoidSettingsState): VoidSettingsState => {
	let newSettingsOfProvider = state.settingsOfProvider

	// recompute default models
	for (const providerName of providerNames) {
		const defaultModels = defaultSettingsOfProvider[providerName]?.models ?? []
		const currentModels = newSettingsOfProvider[providerName]?.models ?? []
		const defaultModelNames = defaultModels.map(m => m.modelName)
		const newModels = _modelsWithSwappedInNewModels({ existingModels: currentModels, models: defaultModelNames, type: 'default' })
		newSettingsOfProvider = {
			...newSettingsOfProvider,
			[providerName]: {
				...newSettingsOfProvider[providerName],
				models: newModels,
			},
		}
	}
	return {
		...state,
		settingsOfProvider: newSettingsOfProvider,
	}
}

const _validatedModelState = (state: Omit<VoidSettingsState, '_modelOptions'>): VoidSettingsState => {

	let newSettingsOfProvider = state.settingsOfProvider

	// recompute _didFillInProviderSettings
	for (const providerName of providerNames) {
		const settingsAtProvider = newSettingsOfProvider[providerName]

		let didFillInProviderSettings = Object.keys(defaultProviderSettings[providerName]).every(key => !!settingsAtProvider[key as keyof typeof settingsAtProvider])
		if (providerName === 'neuralInverse') {
			didFillInProviderSettings = !!settingsAtProvider.endpoint;
		}

		if (didFillInProviderSettings === settingsAtProvider._didFillInProviderSettings) continue

		newSettingsOfProvider = {
			...newSettingsOfProvider,
			[providerName]: {
				...settingsAtProvider,
				_didFillInProviderSettings: didFillInProviderSettings,
			},
		}
	}

	// update model options — deduplicate by (providerName, modelName)
	let newModelOptions: ModelOption[] = []
	const seenModels = new Set<string>()
	for (const providerName of providerNames) {
		const { title: providerTitle } = displayInfoOfProviderName(providerName)
		if (!newSettingsOfProvider[providerName]._didFillInProviderSettings) continue // if disabled, don't display model options
		for (const { modelName, displayName, isHidden } of newSettingsOfProvider[providerName].models) {
			if (isHidden) continue
			const dedupeKey = `${providerName}::${modelName}`
			if (seenModels.has(dedupeKey)) continue  // skip duplicates
			seenModels.add(dedupeKey)
			// For Neural Inverse, use hardcoded friendly names.
			// For other providers, fall back to policy-supplied displayName then raw modelName.
			const label = providerName === 'neuralInverse'
				? (neuralInverseModelDisplayNames[modelName] ?? displayName ?? modelName)
				: (displayName ?? modelName)
			newModelOptions.push({ name: `${label} (${providerTitle})`, selection: { providerName, modelName } })
		}
	}

	// now that model options are updated, make sure the selection is valid
	// if the user-selected model is no longer in the list, update the selection for each feature that needs it to something relevant (the 0th model available, or null)
	let newModelSelectionOfFeature = state.modelSelectionOfFeature
	for (const featureName of featureNames) {

		const { filter } = modelFilterOfFeatureName[featureName]
		const filterOpts = { chatMode: state.globalSettings.chatMode, overridesOfModel: state.overridesOfModel }
		const modelOptionsForThisFeature = newModelOptions.filter((o) => filter(o.selection, filterOpts))

		const modelSelectionAtFeature = newModelSelectionOfFeature[featureName]
		const selnIdx = modelSelectionAtFeature === null ? -1 : modelOptionsForThisFeature.findIndex(m => modelSelectionsEqual(m.selection, modelSelectionAtFeature))

		if (selnIdx !== -1) continue // no longer in list, so update to 1st in list or null

		newModelSelectionOfFeature = {
			...newModelSelectionOfFeature,
			[featureName]: modelOptionsForThisFeature.length === 0 ? null : modelOptionsForThisFeature[0].selection
		}
	}


	const newState = {
		...state,
		settingsOfProvider: newSettingsOfProvider,
		modelSelectionOfFeature: newModelSelectionOfFeature,
		overridesOfModel: state.overridesOfModel,
		_modelOptions: newModelOptions,
	} satisfies VoidSettingsState

	return newState
}





const defaultState = () => {
	const d: VoidSettingsState = {
		settingsOfProvider: deepClone(defaultSettingsOfProvider),
		modelSelectionOfFeature: { 'Chat': null, 'Ctrl+K': null, 'Autocomplete': null, 'Apply': null, 'SCM': null, 'Checks': null },
		globalSettings: deepClone(defaultGlobalSettings),
		optionsOfModelSelection: { 'Chat': {}, 'Ctrl+K': {}, 'Autocomplete': {}, 'Apply': {}, 'SCM': {}, 'Checks': {} },
		overridesOfModel: deepClone(defaultOverridesOfModel),
		_modelOptions: [], // computed later
		mcpUserStateOfName: {},
		isEnterpriseManaged: false,
		enterprisePolicyMode: null,
		enterprisePolicy: null,
	}
	return d
}


export const IVoidSettingsService = createDecorator<IVoidSettingsService>('VoidSettingsService');
class VoidSettingsService extends Disposable implements IVoidSettingsService {
	_serviceBrand: undefined;

	private readonly _onDidChangeState = new Emitter<void>();
	readonly onDidChangeState: Event<void> = this._onDidChangeState.event; // this is primarily for use in react, so react can listen + update on state changes

	state: VoidSettingsState;

	private readonly _resolver: () => void
	waitForInitState: Promise<void> // await this if you need a valid state initially

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IEncryptionService private readonly _encryptionService: IEncryptionService,
		@IMetricsService private readonly _metricsService: IMetricsService,
		@IEnterprisePolicyService private readonly _enterprisePolicyService: IEnterprisePolicyService,
	) {
		super()

		// at the start, we haven't read the partial config yet, but we need to set state to something
		this.state = defaultState()
		let resolver: () => void = () => { }
		this.waitForInitState = new Promise((res, rej) => resolver = res)
		this._resolver = resolver

		this.readAndInitializeState()

		// ARCH-001: Listen for enterprise policy changes
		this._register(this._enterprisePolicyService.onDidChangePolicy(() => {
			this._applyEnterprisePolicy();
		}));
	}




	dangerousSetState = async (newState: VoidSettingsState) => {
		this.state = _validatedModelState(newState)
		await this._storeState()
		this._onDidChangeState.fire()
		this._onUpdate_syncApplyToChat()
		this._onUpdate_syncSCMToChat()
		// ARCH-001: Re-apply enterprise policy AFTER import to ensure enforced settings are restored.
		// This means any policy-locked settings in the imported JSON are overwritten back to policy values.
		const policy = this._enterprisePolicyService.policy;
		if (policy && policy.mode === 'enforced') {
			this._applyEnterprisePolicy();
		}
	}
	async resetState() {
		const policy = this._enterprisePolicyService.policy;
		// ARCH-001: In enforced mode, resetting to defaults would clear org-required provider settings.
		// Allow reset but immediately re-apply policy to restore enforced values.
		await this.dangerousSetState(defaultState())
		if (policy && policy.mode === 'enforced') {
			this._applyEnterprisePolicy();
		}
	}




	async readAndInitializeState() {
		let readS: VoidSettingsState
		try {
			readS = await this._readState();
			// 1.0.3 addition, remove when enough users have had this code run
			if (readS.globalSettings.includeToolLintErrors === undefined) readS.globalSettings.includeToolLintErrors = true

			// autoapprove is now an obj not a boolean (1.2.5)
			if (typeof readS.globalSettings.autoApprove === 'boolean') readS.globalSettings.autoApprove = {}

			// 1.3.5 add source control feature
			if (readS.modelSelectionOfFeature && !readS.modelSelectionOfFeature['SCM']) {
				readS.modelSelectionOfFeature['SCM'] = deepClone(readS.modelSelectionOfFeature['Chat'])
				readS.optionsOfModelSelection['SCM'] = deepClone(readS.optionsOfModelSelection['Chat'])
			}
			// add disableSystemMessage feature
			if (readS.globalSettings.disableSystemMessage === undefined) readS.globalSettings.disableSystemMessage = false;

			// add autoAcceptLLMChanges feature
			if (readS.globalSettings.autoAcceptLLMChanges === undefined) readS.globalSettings.autoAcceptLLMChanges = false;

			// add Checks feature (dedicated model for GRC checks)
			if (readS.modelSelectionOfFeature && !readS.modelSelectionOfFeature['Checks']) {
				readS.modelSelectionOfFeature['Checks'] = null; // null = not configured, falls back to Chat
				if (!readS.optionsOfModelSelection['Checks']) {
					readS.optionsOfModelSelection['Checks'] = {};
				}
			}
		}
		catch (e) {
			readS = defaultState()
		}

		// the stored data structure might be outdated, so we need to update it here
		try {
			readS = {
				...defaultState(),
				...readS,
				// no idea why this was here, seems like a bug
				// ...defaultSettingsOfProvider,
				// ...readS.settingsOfProvider,
			}

			for (const providerName of providerNames) {
				readS.settingsOfProvider[providerName] = {
					...defaultSettingsOfProvider[providerName],
					...readS.settingsOfProvider[providerName],
				} as any

				if (providerName === 'neuralInverse') {
					readS.settingsOfProvider[providerName].endpoint = NEURAL_INVERSE_DEFAULT_ENDPOINT;
				}

				// conversion from 1.0.3 to 1.2.5 (can remove this when enough people update)
				for (const m of readS.settingsOfProvider[providerName].models) {
					if (!m.type) {
						const old = (m as { isAutodetected?: boolean; isDefault?: boolean })
						if (old.isAutodetected)
							m.type = 'autodetected'
						else if (old.isDefault)
							m.type = 'default'
						else m.type = 'custom'
					}
				}

				// remove when enough people have had it run (default is now {})
				if (providerName === 'openAICompatible' && !readS.settingsOfProvider[providerName].headersJSON) {
					readS.settingsOfProvider[providerName].headersJSON = '{}'
				}
			}
		}

		catch (e) {
			readS = defaultState()
		}

		this.state = readS
		this.state = _stateWithMergedDefaultModels(this.state)
		this.state = _validatedModelState(this.state);

		// ARCH-001: Apply enterprise policy after state is initialized
		await this._enterprisePolicyService.waitForInit;
		this._applyEnterprisePolicy();

		this._resolver();
		this._onDidChangeState.fire();

	}


	private async _readState(): Promise<VoidSettingsState> {
		const encryptedState = this._storageService.get(VOID_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION)

		if (!encryptedState)
			return defaultState()

		const stateStr = await this._encryptionService.decrypt(encryptedState)
		const state = JSON.parse(stateStr)
		return state
	}


	private async _storeState() {
		const state = this.state
		const encryptedState = await this._encryptionService.encrypt(JSON.stringify(state))
		this._storageService.store(VOID_SETTINGS_STORAGE_KEY, encryptedState, StorageScope.APPLICATION, StorageTarget.USER);
	}

	setSettingOfProvider: SetSettingOfProviderFn = async (providerName, settingName, newVal) => {

		// ARCH-001: In enforced mode, block writes to providers not approved by policy.
		// This prevents adding API keys for Groq, DeepSeek, etc. via devtools or direct service calls.
		const policy = this._enterprisePolicyService.policy;
		if (policy && policy.mode === 'enforced') {
			const providerPolicy = policy.providers[providerName];
			if (!providerPolicy || !providerPolicy.enabled) {
				return; // Provider not approved — reject all setting writes
			}
			// For approved providers, block overwriting org-supplied credentials
			if (providerPolicy.apiKey && settingName === 'apiKey') return;
			if (providerPolicy.endpoint && settingName === 'endpoint') return;
		}

		const newModelSelectionOfFeature = this.state.modelSelectionOfFeature

		const newOptionsOfModelSelection = this.state.optionsOfModelSelection

		const newSettingsOfProvider: SettingsOfProvider = {
			...this.state.settingsOfProvider,
			[providerName]: {
				...this.state.settingsOfProvider[providerName],
				[settingName]: newVal,
			}
		}

		const newGlobalSettings = this.state.globalSettings
		const newOverridesOfModel = this.state.overridesOfModel
		const newMCPUserStateOfName = this.state.mcpUserStateOfName

		const newState = {
			...this.state,
			modelSelectionOfFeature: newModelSelectionOfFeature,
			optionsOfModelSelection: newOptionsOfModelSelection,
			settingsOfProvider: newSettingsOfProvider,
			globalSettings: newGlobalSettings,
			overridesOfModel: newOverridesOfModel,
			mcpUserStateOfName: newMCPUserStateOfName,
		}

		this.state = _validatedModelState(newState)

		await this._storeState()
		this._onDidChangeState.fire()

	}


	private _onUpdate_syncApplyToChat() {
		// if sync is turned on, sync (call this whenever Chat model or !!sync changes)
		this.setModelSelectionOfFeature('Apply', deepClone(this.state.modelSelectionOfFeature['Chat']))
	}

	private _onUpdate_syncSCMToChat() {
		this.setModelSelectionOfFeature('SCM', deepClone(this.state.modelSelectionOfFeature['Chat']))
	}

	setGlobalSetting: SetGlobalSettingFn = async (settingName, newVal) => {
		const policy = this._enterprisePolicyService.policy;

		// ── ARCH-001: Enterprise enforcement ─────────────────────────────────────
		// If an enterprise featurePolicy or behaviorPolicy forces this setting,
		// silently refuse the change. There is no workaround — even direct service
		// calls cannot bypass enforced policy. Re-apply policy to ensure state
		// is always consistent with current policy.
		if (policy && policy.mode === 'enforced') {
			const fp = policy.featurePolicy;
			const bp = policy.behaviorPolicy;
			const lockedSettings = new Set<string>();

			if (fp) {
				if (fp.forceAutocomplete !== null && fp.forceAutocomplete !== undefined) lockedSettings.add('enableAutocomplete');
				if (fp.forceInlineSuggestions !== null && fp.forceInlineSuggestions !== undefined) lockedSettings.add('showInlineSuggestions');
				if (fp.forceAutoAcceptLLMChanges !== null && fp.forceAutoAcceptLLMChanges !== undefined) lockedSettings.add('autoAcceptLLMChanges');
				if (fp.forceIncludeToolLintErrors !== null && fp.forceIncludeToolLintErrors !== undefined) lockedSettings.add('includeToolLintErrors');
			}
			if (bp) {
				if (bp.forceDisableSystemMessage !== null && bp.forceDisableSystemMessage !== undefined) lockedSettings.add('disableSystemMessage');
				// aiInstructions is locked if systemInstructions + lockSystemInstructions
				if (bp.systemInstructions && bp.lockSystemInstructions) lockedSettings.add('aiInstructions');
			}

			if (lockedSettings.has(settingName as string)) {
				// Setting is enterprise-locked — reject change, re-enforce policy
				this._applyEnterprisePolicy();
				return;
			}
		}
		// ─────────────────────────────────────────────────────────────────────────

		const newState: VoidSettingsState = {
			...this.state,
			globalSettings: {
				...this.state.globalSettings,
				[settingName]: newVal
			}
		}
		this.state = _validatedModelState(newState)
		await this._storeState()
		this._onDidChangeState.fire()

		// hooks
		if (this.state.globalSettings.syncApplyToChat) this._onUpdate_syncApplyToChat()
		if (this.state.globalSettings.syncSCMToChat) this._onUpdate_syncSCMToChat()

	}


	setModelSelectionOfFeature: SetModelSelectionOfFeatureFn = async (featureName, newVal) => {
		// ARCH-001: In enforced mode, validate the selection is from the org-approved model list.
		const policy = this._enterprisePolicyService.policy;
		if (policy && policy.mode === 'enforced') {
			// Allow switching between approved models — the dropdown already only shows approved ones.
			// Validate that the selected model is actually in the approved list.
			if (!newVal) return;
			const isApproved = this.state._modelOptions.some(
				opt => opt.selection.providerName === newVal.providerName
					&& opt.selection.modelName === newVal.modelName
			);
			if (!isApproved) {
				return; // Reject unapproved model selection
			}
		}

		const newState: VoidSettingsState = {
			...this.state,
			modelSelectionOfFeature: {
				...this.state.modelSelectionOfFeature,
				[featureName]: newVal
			}
		}

		this.state = _validatedModelState(newState)

		await this._storeState()
		this._onDidChangeState.fire()

		// hooks
		if (featureName === 'Chat') {
			// When Chat model changes, update synced features
			this._onUpdate_syncApplyToChat()
			this._onUpdate_syncSCMToChat()
		}
	}


	setOptionsOfModelSelection = async (featureName: FeatureName, providerName: ProviderName, modelName: string, newVal: Partial<ModelSelectionOptions>) => {
		const newState: VoidSettingsState = {
			...this.state,
			optionsOfModelSelection: {
				...this.state.optionsOfModelSelection,
				[featureName]: {
					...this.state.optionsOfModelSelection[featureName],
					[providerName]: {
						...this.state.optionsOfModelSelection[featureName][providerName],
						[modelName]: {
							...this.state.optionsOfModelSelection[featureName][providerName]?.[modelName],
							...newVal
						}
					}
				}
			}
		}
		this.state = _validatedModelState(newState)

		await this._storeState()
		this._onDidChangeState.fire()
	}

	setOverridesOfModel = async (providerName: ProviderName, modelName: string, overrides: Partial<ModelOverrides> | undefined) => {
		const newState: VoidSettingsState = {
			...this.state,
			overridesOfModel: {
				...this.state.overridesOfModel,
				[providerName]: {
					...this.state.overridesOfModel[providerName],
					[modelName]: overrides === undefined ? undefined : {
						...this.state.overridesOfModel[providerName][modelName],
						...overrides
					},
				}
			}
		};

		this.state = _validatedModelState(newState);
		await this._storeState();
		this._onDidChangeState.fire();

		this._metricsService.capture('Update Model Overrides', { providerName, modelName, overrides });
	}




	setAutodetectedModels(providerName: ProviderName, autodetectedModelNames: string[], logging: object) {

		const { models } = this.state.settingsOfProvider[providerName]
		const oldModelNames = models.map(m => m.modelName)

		const newModels = _modelsWithSwappedInNewModels({ existingModels: models, models: autodetectedModelNames, type: 'autodetected' })
		this.setSettingOfProvider(providerName, 'models', newModels)

		// if the models changed, log it
		const new_names = newModels.map(m => m.modelName)
		if (!(oldModelNames.length === new_names.length
			&& oldModelNames.every((_, i) => oldModelNames[i] === new_names[i]))
		) {
			this._metricsService.capture('Autodetect Models', { providerName, newModels: newModels, ...logging })
		}
	}
	toggleModelHidden(providerName: ProviderName, modelName: string) {


		const { models } = this.state.settingsOfProvider[providerName]
		const modelIdx = models.findIndex(m => m.modelName === modelName)
		if (modelIdx === -1) return
		const newIsHidden = !models[modelIdx].isHidden
		const newModels: VoidStatefulModelInfo[] = [
			...models.slice(0, modelIdx),
			{ ...models[modelIdx], isHidden: newIsHidden },
			...models.slice(modelIdx + 1, Infinity)
		]
		this.setSettingOfProvider(providerName, 'models', newModels)

		this._metricsService.capture('Toggle Model Hidden', { providerName, modelName, newIsHidden })

	}
	addModel(providerName: ProviderName, modelName: string) {
		const { models } = this.state.settingsOfProvider[providerName]
		const existingIdx = models.findIndex(m => m.modelName === modelName)
		if (existingIdx !== -1) return // if exists, do nothing
		const newModels = [
			...models,
			{ modelName, type: 'custom', isHidden: false } as const
		]
		this.setSettingOfProvider(providerName, 'models', newModels)

		this._metricsService.capture('Add Model', { providerName, modelName })

	}
	deleteModel(providerName: ProviderName, modelName: string): boolean {
		const { models } = this.state.settingsOfProvider[providerName]
		const delIdx = models.findIndex(m => m.modelName === modelName)
		if (delIdx === -1) return false
		const newModels = [
			...models.slice(0, delIdx), // delete the idx
			...models.slice(delIdx + 1, Infinity)
		]
		this.setSettingOfProvider(providerName, 'models', newModels)

		this._metricsService.capture('Delete Model', { providerName, modelName })

		return true
	}

	// MCP Server State
	private _setMCPUserStateOfName = async (newStates: MCPUserStateOfName) => {
		const newState: VoidSettingsState = {
			...this.state,
			mcpUserStateOfName: {
				...this.state.mcpUserStateOfName,
				...newStates
			}
		};
		this.state = _validatedModelState(newState);
		await this._storeState();
		this._onDidChangeState.fire();
		this._metricsService.capture('Set MCP Server States', { newStates });
	}

	addMCPUserStateOfNames = async (newMCPStates: MCPUserStateOfName) => {
		const { mcpUserStateOfName: mcpServerStates } = this.state
		const newMCPServerStates = {
			...mcpServerStates,
			...newMCPStates,
		}
		await this._setMCPUserStateOfName(newMCPServerStates)
		this._metricsService.capture('Add MCP Servers', { servers: Object.keys(newMCPStates).join(', ') });
	}

	removeMCPUserStateOfNames = async (serverNames: string[]) => {
		const { mcpUserStateOfName: mcpServerStates } = this.state
		const newMCPServerStates = {
			...mcpServerStates,
		}
		serverNames.forEach(serverName => {
			if (serverName in newMCPServerStates) {
				delete newMCPServerStates[serverName]
			}
		})
		await this._setMCPUserStateOfName(newMCPServerStates)
		this._metricsService.capture('Remove MCP Servers', { servers: serverNames.join(', ') });
	}

	setMCPServerState = async (serverName: string, state: MCPUserState) => {
		const { mcpUserStateOfName } = this.state
		const newMCPServerStates = {
			...mcpUserStateOfName,
			[serverName]: state,
		}
		await this._setMCPUserStateOfName(newMCPServerStates)
		this._metricsService.capture('Update MCP Server State', { serverName, state });
	}

	// ────────────────── ARCH-001: Enterprise Policy ──────────────────

	private _applyEnterprisePolicy(): void {
		const policy = this._enterprisePolicyService.policy;

		if (!policy) {
			// No enterprise policy — clear enterprise state
			if (this.state.isEnterpriseManaged) {
				this.state = {
					...this.state,
					isEnterpriseManaged: false,
					enterprisePolicyMode: null,
					enterprisePolicy: null,
				};
				this.state = _validatedModelState(this.state);
				this._onDidChangeState.fire();
			}
			return;
		}

		let newState: VoidSettingsState = {
			...this.state,
			isEnterpriseManaged: true,
			enterprisePolicyMode: policy.mode,
			enterprisePolicy: policy,
		};

		// 1. Filter models by policy: hide models not in the allowed list
		let newSettingsOfProvider = newState.settingsOfProvider;
		for (const providerName of providerNames) {
			const provPolicy = policy.providers[providerName];
			if (!provPolicy || !provPolicy.enabled) {
				// Provider disabled by policy — hide all its models
				const currentModels = newSettingsOfProvider[providerName].models;
				const allHidden = currentModels.map(m => ({ ...m, isHidden: true }));
				newSettingsOfProvider = {
					...newSettingsOfProvider,
					[providerName]: {
						...newSettingsOfProvider[providerName],
						models: allHidden,
					},
				};
				continue;
			}

			// Provider enabled — filter models by allowed list
			if (provPolicy.allowedModels.length > 0) {
				const currentModels = newSettingsOfProvider[providerName].models;
				const filtered = currentModels.map(m => ({
					...m,
					// Models in allowedModels should be explicitly VISIBLE; models NOT in allowedModels should be HIDDEN
					isHidden: !provPolicy.allowedModels.includes(m.modelName),
					// Apply friendly display name from modelAliases if provided
					displayName: provPolicy.modelAliases?.[m.modelName] ?? m.displayName,
				}));
				newSettingsOfProvider = {
					...newSettingsOfProvider,
					[providerName]: {
						...newSettingsOfProvider[providerName],
						models: filtered,
					},
				};
			} else if (provPolicy.modelAliases) {
				// No model whitelist but aliases are set — apply display names only
				const currentModels = newSettingsOfProvider[providerName].models;
				const aliased = currentModels.map(m => ({
					...m,
					displayName: provPolicy.modelAliases![m.modelName] ?? m.displayName,
				}));
				newSettingsOfProvider = {
					...newSettingsOfProvider,
					[providerName]: {
						...newSettingsOfProvider[providerName],
						models: aliased,
					},
				};
			}

			// In enforced mode, apply enterprise-supplied credentials
			if (policy.mode === 'enforced') {
				if (provPolicy.apiKey) {
					newSettingsOfProvider = {
						...newSettingsOfProvider,
						[providerName]: {
							...newSettingsOfProvider[providerName],
							apiKey: provPolicy.apiKey,
							_didFillInProviderSettings: true,
						} as any,
					};
				}
				if (provPolicy.endpoint) {
					newSettingsOfProvider = {
						...newSettingsOfProvider,
						[providerName]: {
							...newSettingsOfProvider[providerName],
							endpoint: provPolicy.endpoint,
						} as any,
					};
				}
			}
		}

		newState = {
			...newState,
			settingsOfProvider: newSettingsOfProvider,
		};

		// 2. In enforced mode, apply feature\u2192model assignments
		if (policy.mode === 'enforced' && policy.featureAssignments) {
			let newModelSelection = newState.modelSelectionOfFeature;
			for (const [feature, assignment] of Object.entries(policy.featureAssignments)) {
				if (assignment && featureNames.includes(feature as any)) {
					newModelSelection = {
						...newModelSelection,
						[feature]: {
							providerName: assignment.providerName as ProviderName,
							modelName: assignment.modelName,
						},
					};
				}
			}
			newState = {
				...newState,
				modelSelectionOfFeature: newModelSelection,
			};
		}

		// 3. Apply global settings overrides (legacy)
		if (policy.globalSettings) {
			const overrides = policy.globalSettings;
			const newGlobal = { ...newState.globalSettings };
			if (overrides.enableAutocomplete !== undefined) newGlobal.enableAutocomplete = overrides.enableAutocomplete;
			if (overrides.aiInstructions !== undefined) newGlobal.aiInstructions = overrides.aiInstructions;
			if (overrides.disableSystemMessage !== undefined) newGlobal.disableSystemMessage = overrides.disableSystemMessage;

			newState = {
				...newState,
				globalSettings: newGlobal,
			};
		}

		// 4. ARCH-001: Apply featurePolicy — force global feature toggles
		if (policy.featurePolicy && policy.mode === 'enforced') {
			const fp = policy.featurePolicy;
			const newGlobal = { ...newState.globalSettings };

			if (fp.forceAutocomplete !== null && fp.forceAutocomplete !== undefined) {
				newGlobal.enableAutocomplete = fp.forceAutocomplete;
			}
			if (fp.forceInlineSuggestions !== null && fp.forceInlineSuggestions !== undefined) {
				newGlobal.showInlineSuggestions = fp.forceInlineSuggestions;
			}
			if (fp.forceAutoAcceptLLMChanges !== null && fp.forceAutoAcceptLLMChanges !== undefined) {
				newGlobal.autoAcceptLLMChanges = fp.forceAutoAcceptLLMChanges;
			}
			if (fp.forceIncludeToolLintErrors !== null && fp.forceIncludeToolLintErrors !== undefined) {
				newGlobal.includeToolLintErrors = fp.forceIncludeToolLintErrors;
			}
			if (fp.forceAutoApprove) {
				const currentAutoApprove = newGlobal.autoApprove ?? {};
				const newAutoApprove = { ...currentAutoApprove };
				for (const [toolType, value] of Object.entries(fp.forceAutoApprove)) {
					if (value !== null && value !== undefined) {
						(newAutoApprove as any)[toolType] = value;
					}
				}
				newGlobal.autoApprove = newAutoApprove;
			}

			newState = { ...newState, globalSettings: newGlobal };
		}

		// 5. ARCH-001: Apply behaviorPolicy — system instructions prefix + locks
		if (policy.behaviorPolicy) {
			const bp = policy.behaviorPolicy;
			const newGlobal = { ...newState.globalSettings };

			// Prepend org system instructions to developer's instructions
			if (bp.systemInstructions) {
				const devInstructions = bp.lockSystemInstructions
					? '' // dev instructions suppressed when locked
					: (newGlobal.aiInstructions ?? '');
				const separator = devInstructions ? '\n\n' : '';
				newGlobal.aiInstructions = `${bp.systemInstructions}${separator}${devInstructions}`.trim();
			}

			if (bp.forceDisableSystemMessage !== null && bp.forceDisableSystemMessage !== undefined) {
				newGlobal.disableSystemMessage = bp.forceDisableSystemMessage;
			}

			newState = { ...newState, globalSettings: newGlobal };
		}

		this.state = _validatedModelState(newState);
		this._storeState();
		this._onDidChangeState.fire();
	}

}


registerSingleton(IVoidSettingsService, VoidSettingsService, InstantiationType.Eager);
