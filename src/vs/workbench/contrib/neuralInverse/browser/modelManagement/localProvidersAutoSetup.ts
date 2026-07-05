/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IModelManagementService, IModelPullProgress, ProviderName } from '../../common/modelManagement/index.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { isLinux, isMacintosh } from '../../../../../base/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';

const LOCAL_PROVIDERS_SETUP_DISMISSED_KEY = 'neuralInverse.localProvidersSetup.dismissed';
const SETUP_CHECK_INTERVAL = 5000;
const POLL_TIMEOUT = 300000; // 5 minutes

interface IProviderSetupInfo {
	provider: ProviderName;
	displayName: string;
	installCommand: { mac: string; linux: string; windows: string };
	downloadUrl: { mac: string; linux: string; windows: string };
	supportsModelPull: boolean;
}

const PROVIDER_SETUP_INFO: IProviderSetupInfo[] = [
	{
		provider: 'ollama',
		displayName: 'Ollama',
		installCommand: {
			mac: 'brew install ollama',
			linux: 'curl -fsSL https://ollama.com/install.sh | sh',
			windows: 'Download installer from ollama.com'
		},
		downloadUrl: {
			mac: 'https://ollama.com/download/mac',
			linux: 'https://ollama.com/download/linux',
			windows: 'https://ollama.com/download/windows'
		},
		supportsModelPull: true
	},
	{
		provider: 'vLLM',
		displayName: 'vLLM',
		installCommand: {
			mac: 'pip install vllm',
			linux: 'pip install vllm',
			windows: 'pip install vllm'
		},
		downloadUrl: {
			mac: 'https://docs.vllm.ai/en/latest/getting_started/installation.html',
			linux: 'https://docs.vllm.ai/en/latest/getting_started/installation.html',
			windows: 'https://docs.vllm.ai/en/latest/getting_started/installation.html'
		},
		supportsModelPull: false
	},
	{
		provider: 'lmStudio',
		displayName: 'LM Studio',
		installCommand: {
			mac: 'Download LM Studio from lmstudio.ai',
			linux: 'Download LM Studio from lmstudio.ai',
			windows: 'Download LM Studio from lmstudio.ai'
		},
		downloadUrl: {
			mac: 'https://lmstudio.ai',
			linux: 'https://lmstudio.ai',
			windows: 'https://lmstudio.ai'
		},
		supportsModelPull: false
	}
];

export class LocalProvidersAutoSetupContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.localProvidersAutoSetup';

	private pollIntervals: Map<ProviderName, NodeJS.Timeout> = new Map();
	private pollTimeouts: Map<ProviderName, NodeJS.Timeout> = new Map();

	constructor(
		@IModelManagementService private readonly modelManagementService: IModelManagementService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStorageService private readonly storageService: IStorageService,
		@ITerminalService private readonly terminalService: ITerminalService,
	) {
		super();
		this.checkLocalProvidersSetup();
	}

	private async checkLocalProvidersSetup(): Promise<void> {
		const dismissed = this.storageService.getBoolean(LOCAL_PROVIDERS_SETUP_DISMISSED_KEY, StorageScope.APPLICATION, false);
		if (dismissed) return;

		const providers = await this.modelManagementService.detectProviders();
		const missingProviders: IProviderSetupInfo[] = [];
		const providersWithoutModels: Array<{ info: IProviderSetupInfo; detected: boolean }> = [];

		for (const setupInfo of PROVIDER_SETUP_INFO) {
			const detected = providers.find(p => p.provider === setupInfo.provider);
			if (!detected?.detected) {
				missingProviders.push(setupInfo);
			} else if (detected.modelsAvailable === 0 && setupInfo.supportsModelPull) {
				providersWithoutModels.push({ info: setupInfo, detected: true });
			}
		}

		if (missingProviders.length > 0) {
			this.showSetupNotification(missingProviders);
		} else if (providersWithoutModels.length > 0) {
			// Show first model notification for providers that support it
			for (const { info } of providersWithoutModels) {
				this.showFirstModelNotification(info.provider, info.displayName);
			}
		}
	}

	private showSetupNotification(missingProviders: IProviderSetupInfo[]): void {
		const providerNames = missingProviders.map(p => p.displayName).join(', ');
		this.notificationService.prompt(
			Severity.Info,
			`No local LLM providers detected. Install ${providerNames} to use local models?`,
			[
				{ label: 'Install', run: () => this.showProviderSelection(missingProviders) },
				{ label: 'Later', run: () => this.storageService.store(LOCAL_PROVIDERS_SETUP_DISMISSED_KEY, true, StorageScope.APPLICATION, StorageTarget.USER) }
			]
		);
	}

	private showProviderSelection(providers: IProviderSetupInfo[]): void {
		const providerList = providers.map(p => `• ${p.displayName}`).join('\n');
		this.notificationService.prompt(
			Severity.Info,
			`Select a provider to install:\n${providerList}`,
			providers.map(p => ({
				label: p.displayName,
				run: () => this.showInstallInstructions(p)
			}))
		);
	}

	private async showInstallInstructions(providerInfo: IProviderSetupInfo): Promise<void> {
		const command = isMacintosh ? providerInfo.installCommand.mac :
			isLinux ? providerInfo.installCommand.linux : providerInfo.installCommand.windows;

		this.notificationService.prompt(
			Severity.Info,
			`Install ${providerInfo.displayName} automatically?`,
			[
				{
					label: 'Install Now',
					run: async () => {
						this.notificationService.info(`Installing ${providerInfo.displayName}...`);
						await this.runInstallCommand(providerInfo, command);
					}
				},
				{
					label: 'Cancel',
					run: () => {}
				}
			]
		);
	}

	private async runInstallCommand(providerInfo: IProviderSetupInfo, command: string): Promise<void> {
		try {
			// Create terminal and run command
			const terminal = await this.terminalService.createTerminal({});

			this.terminalService.setActiveInstance(terminal);
			await this.terminalService.revealActiveTerminal();

			terminal.sendText(command, true);

			// Start polling for completion
			this.startPollingForProvider(providerInfo);
		} catch (error) {
			this.notificationService.error(`Failed to start installation: ${error}`);
		}
	}

	private startPollingForProvider(providerInfo: IProviderSetupInfo): void {
		const existing = this.pollIntervals.get(providerInfo.provider);
		if (existing) clearInterval(existing);

		this.notificationService.info(`Checking for ${providerInfo.displayName}...`);
		const interval = setInterval(async () => {
			const providers = await this.modelManagementService.detectProviders();
			const detected = providers.find(p => p.provider === providerInfo.provider);
			if (detected?.detected) {
				clearInterval(interval);
				this.pollIntervals.delete(providerInfo.provider);
				this.notificationService.prompt(
					Severity.Info,
					`✅ ${providerInfo.displayName} detected!`,
					providerInfo.supportsModelPull
						? [{ label: 'Download Model', run: () => this.showFirstModelNotification(providerInfo.provider, providerInfo.displayName) }]
						: []
				);
			}
		}, SETUP_CHECK_INTERVAL);

		this.pollIntervals.set(providerInfo.provider, interval);

		const timeout = setTimeout(() => {
			const stillRunning = this.pollIntervals.get(providerInfo.provider);
			if (stillRunning) {
				clearInterval(stillRunning);
				this.pollIntervals.delete(providerInfo.provider);
			}
			this.pollTimeouts.delete(providerInfo.provider);
		}, POLL_TIMEOUT);
		this.pollTimeouts.set(providerInfo.provider, timeout);
	}

	private async showFirstModelNotification(provider: ProviderName, displayName: string): Promise<void> {
		const models = await this.modelManagementService.getRecommendedModels('code');
		const first = models.find(m => m.provider === provider);
		if (!first) return;

		this.notificationService.prompt(
			Severity.Info,
			`Download ${first.name} for ${displayName}? (${this.formatBytes(first.size || 0)})`,
			[{ label: 'Download', run: () => this.downloadModel(provider, first.id, first.name) }]
		);
	}

	private async downloadModel(provider: ProviderName, modelId: string, modelName: string): Promise<void> {
		this.notificationService.info(`Downloading ${modelName}...`);
		let lastReportedTen = 0;

		const disposable = this.modelManagementService.onPullProgress((p: IModelPullProgress) => {
			if (p.provider === provider && p.modelId === modelId) {
				if (p.status === 'downloading' && p.percentage) {
					const currentTen = Math.floor(p.percentage / 10) * 10;
					if (currentTen > lastReportedTen) {
						lastReportedTen = currentTen;
						this.notificationService.info(`Downloading ${modelName}: ${currentTen}%`);
					}
				} else if (p.status === 'completed') {
					this.notificationService.info(`${modelName} ready!`);
					disposable.dispose();
				} else if (p.status === 'failed') {
					this.notificationService.error(`Download failed: ${p.error || 'Unknown error'}`);
					disposable.dispose();
				}
			}
		});

		this._register(disposable);
		try {
			await this.modelManagementService.pullModel(provider, modelId);
		} catch (err) {
			this.notificationService.error(`Download failed: ${err}`);
		}
	}

	private formatBytes(bytes: number): string {
		const sizes = ['B', 'KB', 'MB', 'GB'];
		if (bytes === 0) return '0 B';
		const i = Math.floor(Math.log(bytes) / Math.log(1024));
		return `${Math.round(bytes / Math.pow(1024, i) * 10) / 10} ${sizes[i]}`;
	}

	override dispose(): void {
		for (const interval of this.pollIntervals.values()) {
			clearInterval(interval);
		}
		for (const timeout of this.pollTimeouts.values()) {
			clearTimeout(timeout);
		}
		this.pollIntervals.clear();
		this.pollTimeouts.clear();
		super.dispose();
	}
}
