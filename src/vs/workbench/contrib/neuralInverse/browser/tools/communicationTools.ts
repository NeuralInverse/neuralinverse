/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Communication Tools
 *
 * IAgentTool implementations for agent-to-user communication within the IDE.
 *
 * ## Tools
 *
 * | Tool                   | Service                      | What it does                              |
 * |------------------------|------------------------------|-------------------------------------------|
 * | notify                 | INotificationService         | VS Code toast (info / warning / error)    |
 * | playNotificationSound  | IAccessibilitySignalService  | Plays neuralInverseNotification.mp3       |
 * | setStatusBar           | IStatusbarService            | Temporary status bar message              |
 * | showProgress           | IProgressService             | Indeterminate progress in notification    |
 * | clipboardWrite         | IClipboardService            | Write text to system clipboard            |
 * | clipboardRead          | IClipboardService            | Read text from system clipboard           |
 * | openUrl                | IOpenerService               | Open HTTPS URL in external browser        |
 *
 * ## Construction
 *
 * Each tool receives its required VS Code service(s) via constructor injection.
 * Instantiate through WorkflowAgentService which has all services available.
 */

import { URI } from '../../../../../base/common/uri.js';
import { IAgentTool, IToolExecutionContext, IToolResult } from '../../common/workflowTypes.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import {
	IAccessibilitySignalService,
	AccessibilitySignal,
	AcknowledgeDocCommentsToken,
} from '../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { IStatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';

// \u2500\u2500\u2500 notify \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class NotifyTool implements IAgentTool {

	readonly name = 'notify';
	readonly description =
		'Show a VS Code notification toast to the user. ' +
		'Use for important status updates, errors, or when human attention is needed. ' +
		'Severity: "info" (blue), "warning" (yellow), "error" (red).';

	readonly parameters = {
		message: {
			type: 'string' as const,
			description: 'The notification message to display.',
			required: true,
		},
		severity: {
			type: 'string' as const,
			description: 'Severity level: "info", "warning", or "error". Defaults to "info".',
			required: false,
			enum: ['info', 'warning', 'error'],
		},
		title: {
			type: 'string' as const,
			description: 'Optional bold title prefix shown before the message.',
			required: false,
		},
	};

	constructor(private readonly notificationService: INotificationService) {}

	async execute(args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		const rawMessage = args['message'] as string;
		const severity = (args['severity'] as string) || 'info';
		const title = args['title'] as string | undefined;

		if (!rawMessage?.trim()) {
			return { success: false, output: '', error: 'message is required' };
		}

		const message = title ? `**${title}** \u2014 ${rawMessage}` : rawMessage;
		ctx.log(`notify: [${severity}] ${message}`);

		switch (severity) {
			case 'warning':
				this.notificationService.warn(message);
				break;
			case 'error':
				this.notificationService.error(message);
				break;
			default:
				this.notificationService.info(message);
		}

		return { success: true, output: `Notification shown: [${severity}] ${rawMessage}` };
	}
}

// \u2500\u2500\u2500 playNotificationSound \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class PlayNotificationSoundTool implements IAgentTool {

	readonly name = 'playNotificationSound';
	readonly description =
		'Play the Neural Inverse notification sound (neuralInverseNotification.mp3) to alert the user. ' +
		'Use when an important task completes, requires attention, or an agent finishes its run. ' +
		'Plays immediately regardless of system volume settings.';

	readonly parameters = {};

	constructor(private readonly signalService: IAccessibilitySignalService) {}

	async execute(_args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		ctx.log('playNotificationSound');
		try {
			// playSound bypasses enabled-state check \u2014 plays regardless of accessibility config
			await this.signalService.playSound(
				AccessibilitySignal.neuralInverseTaskComplete.sound.getSound(),
				true,
				AcknowledgeDocCommentsToken,
			);
			return { success: true, output: 'Notification sound played.' };
		} catch (e: any) {
			return { success: false, output: '', error: `Sound playback failed: ${e.message}` };
		}
	}
}

// \u2500\u2500\u2500 setStatusBar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class SetStatusBarTool implements IAgentTool {

	readonly name = 'setStatusBar';
	readonly description =
		'Display a temporary message in the VS Code status bar at the bottom of the window. ' +
		'Good for showing brief ongoing status without interrupting the user. ' +
		'The entry auto-removes after the specified duration (default 5 seconds).';

	readonly parameters = {
		text: {
			type: 'string' as const,
			description: 'Text to display in the status bar. Supports $(icon-name) codicons, e.g. "$(sync~spin) Running...".',
			required: true,
		},
		tooltip: {
			type: 'string' as const,
			description: 'Optional tooltip shown on hover.',
			required: false,
		},
		durationMs: {
			type: 'number' as const,
			description: 'How long to show the message in milliseconds. Defaults to 5000 (5 seconds). Use 0 to show indefinitely (caller must manage disposal).',
			required: false,
		},
		alignment: {
			type: 'string' as const,
			description: 'Where to place the entry: "left" or "right". Defaults to "left".',
			required: false,
			enum: ['left', 'right'],
		},
	};

	private static _entryCounter = 0;

	constructor(private readonly statusbarService: IStatusbarService) {}

	async execute(args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		const text = args['text'] as string;
		const tooltip = args['tooltip'] as string | undefined;
		const durationMs = (args['durationMs'] as number) ?? 5000;
		const alignmentArg = (args['alignment'] as string) || 'left';

		if (!text?.trim()) {
			return { success: false, output: '', error: 'text is required' };
		}

		const id = `neuralInverse.statusBar.${++SetStatusBarTool._entryCounter}`;
		const alignment = alignmentArg === 'right' ? StatusbarAlignment.RIGHT : StatusbarAlignment.LEFT;

		ctx.log(`setStatusBar: "${text}" (${durationMs}ms)`);

		const accessor = this.statusbarService.addEntry(
			{ name: 'Neural Inverse Agent', text, tooltip, ariaLabel: text, kind: 'prominent' },
			id,
			alignment,
			100,
		);

		if (durationMs > 0) {
			setTimeout(() => accessor.dispose(), durationMs);
		}

		return { success: true, output: `Status bar entry set: "${text}"${durationMs > 0 ? ` (auto-removes in ${durationMs}ms)` : ''}` };
	}
}

// \u2500\u2500\u2500 showProgress \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class ShowProgressTool implements IAgentTool {

	readonly name = 'showProgress';
	readonly description =
		'Show an indeterminate progress notification that auto-closes after a given duration. ' +
		'Use to indicate that a long background task is running. ' +
		'This is fire-and-forget \u2014 it does not block the agent.';

	readonly parameters = {
		title: {
			type: 'string' as const,
			description: 'Progress notification title, e.g. "Running analysis...".',
			required: true,
		},
		message: {
			type: 'string' as const,
			description: 'Optional detail message shown under the title.',
			required: false,
		},
		durationMs: {
			type: 'number' as const,
			description: 'How long to show the progress notification in milliseconds. Defaults to 8000 (8 seconds).',
			required: false,
		},
	};

	constructor(private readonly progressService: IProgressService) {}

	async execute(args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		const title = args['title'] as string;
		const message = args['message'] as string | undefined;
		const durationMs = (args['durationMs'] as number) ?? 8000;

		if (!title?.trim()) {
			return { success: false, output: '', error: 'title is required' };
		}

		ctx.log(`showProgress: "${title}" (${durationMs}ms)`);

		// Fire-and-forget \u2014 resolves the inner promise after durationMs
		this.progressService.withProgress(
			{
				location: ProgressLocation.Notification,
				title,
			},
			async (progress) => {
				if (message) {
					progress.report({ message });
				}
				await new Promise<void>(r => setTimeout(r, durationMs));
			},
		).catch(() => {/* ignore */});

		return { success: true, output: `Progress notification started: "${title}" (${durationMs}ms)` };
	}
}

// \u2500\u2500\u2500 clipboardWrite \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class ClipboardWriteTool implements IAgentTool {

	readonly name = 'clipboardWrite';
	readonly description =
		'Write text to the system clipboard. ' +
		'Use to deliver results, code snippets, or summaries directly to the user\'s clipboard for easy pasting.';

	readonly parameters = {
		text: {
			type: 'string' as const,
			description: 'The text content to write to the clipboard.',
			required: true,
		},
	};

	constructor(private readonly clipboardService: IClipboardService) {}

	async execute(args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		const text = args['text'] as string;

		if (text === undefined || text === null) {
			return { success: false, output: '', error: 'text is required' };
		}

		ctx.log(`clipboardWrite: ${text.length} chars`);

		try {
			await this.clipboardService.writeText(text);
			return { success: true, output: `Copied ${text.length} characters to clipboard.` };
		} catch (e: any) {
			return { success: false, output: '', error: `Clipboard write failed: ${e.message}` };
		}
	}
}

// \u2500\u2500\u2500 clipboardRead \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class ClipboardReadTool implements IAgentTool {

	readonly name = 'clipboardRead';
	readonly description =
		'Read the current text content of the system clipboard. ' +
		'Useful when the user has copied something (e.g. an error message, a URL, or a snippet) for the agent to act on.';

	readonly parameters = {};

	constructor(private readonly clipboardService: IClipboardService) {}

	async execute(_args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		ctx.log('clipboardRead');
		try {
			const text = await this.clipboardService.readText();
			if (!text) {
				return { success: true, output: '(clipboard is empty)' };
			}
			return { success: true, output: text };
		} catch (e: any) {
			return { success: false, output: '', error: `Clipboard read failed: ${e.message}` };
		}
	}
}

// \u2500\u2500\u2500 openUrl \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const ALLOWED_PROTOCOLS = ['https:', 'http:'];
const BLOCKED_HOSTS = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|::1)/i;

export class OpenUrlTool implements IAgentTool {

	readonly name = 'openUrl';
	readonly description =
		'Open a URL in the user\'s default external browser. ' +
		'Only http/https URLs are allowed. Private/internal network addresses are blocked. ' +
		'Use to direct the user to documentation, dashboards, PRs, or external resources.';

	readonly parameters = {
		url: {
			type: 'string' as const,
			description: 'The full URL to open, e.g. "https://github.com/org/repo/pull/42".',
			required: true,
		},
	};

	constructor(private readonly openerService: IOpenerService) {}

	async execute(args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		const url = (args['url'] as string)?.trim();

		if (!url) {
			return { success: false, output: '', error: 'url is required' };
		}

		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return { success: false, output: '', error: `Invalid URL: "${url}"` };
		}

		if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
			return { success: false, output: '', error: `Only http/https URLs are allowed. Got: "${parsed.protocol}"` };
		}

		if (BLOCKED_HOSTS.test(parsed.hostname)) {
			return { success: false, output: '', error: `Private/internal network addresses are blocked: "${parsed.hostname}"` };
		}

		ctx.log(`openUrl: ${url}`);

		try {
			await this.openerService.open(URI.parse(url), { openExternal: true });
			return { success: true, output: `Opened in browser: ${url}` };
		} catch (e: any) {
			return { success: false, output: '', error: `Failed to open URL: ${e.message}` };
		}
	}
}

// \u2500\u2500\u2500 Export \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Factory \u2014 call this with the required services to get all communication tools.
 * Used by WorkflowAgentService on startup.
 */
export function createCommunicationTools(
	notificationService: INotificationService,
	signalService: IAccessibilitySignalService,
	statusbarService: IStatusbarService,
	progressService: IProgressService,
	clipboardService: IClipboardService,
	openerService: IOpenerService,
): IAgentTool[] {
	return [
		new NotifyTool(notificationService),
		new PlayNotificationSoundTool(signalService),
		new SetStatusBarTool(statusbarService),
		new ShowProgressTool(progressService),
		new ClipboardWriteTool(clipboardService),
		new ClipboardReadTool(clipboardService),
		new OpenUrlTool(openerService),
	];
}
