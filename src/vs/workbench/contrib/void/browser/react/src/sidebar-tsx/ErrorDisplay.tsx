/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronUp, X, Cloud, ExternalLink, Settings } from 'lucide-react';
import { useAccessor, useSettingsState } from '../util/services.js';
import { errorDetails } from '../../../../common/sendLLMMessageTypes.js';
import { VOID_OPEN_SETTINGS_ACTION_ID } from '../../../voidSettingsPane.js';


type ErrorCardInfo = {
	title: string;
	description: string;
	docsUrl: string;
	showSettings?: boolean;
	showSignup?: boolean;
};

const ERROR_CARDS: { match: (msg: string) => boolean; info: ErrorCardInfo }[] = [
	{
		match: m => m.includes('Neural Inverse Free Models requires'),
		info: {
			title: 'Free Models require a cloud workspace',
			description: 'Connect to a Neural Inverse Cloud workspace, or configure your own API key.',
			docsUrl: 'https://neuralinverse.com/docs/troubleshooting/cloud-workspace-required',
			showSettings: true,
			showSignup: true,
		},
	},
	{
		match: m => m.includes('providerName was invalid'),
		info: {
			title: 'Provider not available',
			description: 'The selected provider isn\'t registered in this IDE build. Update or switch providers.',
			docsUrl: 'https://neuralinverse.com/docs/troubleshooting/provider-not-available',
			showSettings: true,
		},
	},
	{
		match: m => m.includes('Invalid') && m.includes('API key'),
		info: {
			title: 'Invalid API key',
			description: 'The API key for this provider is incorrect or expired. Re-enter it in settings.',
			docsUrl: 'https://neuralinverse.com/docs/troubleshooting/invalid-api-key',
			showSettings: true,
		},
	},
	{
		match: m => m.includes('exceeds the available context size'),
		info: {
			title: 'Context size exceeded',
			description: 'The conversation is too long for this model. Start a new chat or use a model with larger context.',
			docsUrl: 'https://neuralinverse.com/docs/troubleshooting/context-exceeded',
		},
	},
	{
		match: m => m.includes('429') || m.includes('Rate limit'),
		info: {
			title: 'Rate limited',
			description: 'Too many requests. Wait a moment and retry.',
			docsUrl: 'https://neuralinverse.com/docs/troubleshooting/rate-limited',
		},
	},
	{
		match: m => m.includes('Failed to fetch') || m.includes('Connection error') || m.includes('Response timeout'),
		info: {
			title: 'Connection failed',
			description: 'Could not reach the model provider. Check your connection or endpoint settings.',
			docsUrl: 'https://neuralinverse.com/docs/troubleshooting/connection-failed',
			showSettings: true,
		},
	},
	{
		match: m => m.includes('does not support tools'),
		info: {
			title: 'Model doesn\'t support tools',
			description: 'This model can\'t run in Agent mode. Switch to a model with tool-calling support.',
			docsUrl: 'https://neuralinverse.com/docs/troubleshooting/tools-not-supported',
			showSettings: true,
		},
	},
	{
		match: m => m.includes('Response from model was empty'),
		info: {
			title: 'Empty response from model',
			description: 'The model returned nothing. Retry or try a different model.',
			docsUrl: 'https://neuralinverse.com/docs/troubleshooting/empty-response',
		},
	},
	{
		match: m => m.includes('Ollama Endpoint was empty'),
		info: {
			title: 'Ollama endpoint not configured',
			description: 'Enter your Ollama endpoint in settings (default: http://localhost:11434).',
			docsUrl: 'https://neuralinverse.com/docs/troubleshooting/ollama-endpoint-empty',
			showSettings: true,
		},
	},
	{
		match: m => m.includes('Error parsing OpenAI-Compatible headers'),
		info: {
			title: 'Invalid custom headers',
			description: 'The custom headers field must be valid JSON.',
			docsUrl: 'https://neuralinverse.com/docs/troubleshooting/custom-headers-invalid',
			showSettings: true,
		},
	},
	{
		match: m => m.includes('Error running Autocomplete'),
		info: {
			title: 'Autocomplete not supported',
			description: 'This provider doesn\'t support autocomplete. Switch to one that does, or disable autocomplete.',
			docsUrl: 'https://neuralinverse.com/docs/troubleshooting/autocomplete-error',
			showSettings: true,
		},
	},
	{
		match: m => m.includes('not supported in web mode'),
		info: {
			title: 'Not available in web mode',
			description: 'This provider requires the desktop IDE. Use a different provider in the web IDE.',
			docsUrl: 'https://neuralinverse.com/docs/troubleshooting/web-mode-unsupported',
			showSettings: true,
		},
	},
	{
		match: m => m.includes('Google API failed to generate a key'),
		info: {
			title: 'Google authentication failed',
			description: 'Could not get a Google access token. Re-run gcloud auth or check your credentials.',
			docsUrl: 'https://neuralinverse.com/docs/troubleshooting/google-api-key-failed',
			showSettings: true,
		},
	},
	{
		match: m => m.includes('balance is too low') || m.includes('purchase credits') || m.includes('402') || m.includes('requires more credits'),
		info: {
			title: 'Insufficient credits',
			description: 'Your account balance with this provider is too low. Add credits or switch to a different provider.',
			docsUrl: 'https://neuralinverse.com/docs/troubleshooting/invalid-api-key',
			showSettings: true,
		},
	},
	{
		match: m => m.includes('status code') && m.includes('no body'),
		info: {
			title: 'Provider returned an error',
			description: 'The model provider returned an error with no details. Check your endpoint and API key.',
			docsUrl: 'https://neuralinverse.com/docs/troubleshooting/connection-failed',
			showSettings: true,
		},
	},
	{
		match: m => m.includes('Provider returned error') || (m.includes('400') && m.includes('invalid_request')),
		info: {
			title: 'Invalid request',
			description: 'The request was rejected by the provider. This often means unsupported parameters for this model.',
			docsUrl: 'https://neuralinverse.com/docs/troubleshooting/connection-failed',
			showSettings: true,
		},
	},
	{
		match: m => m.includes('404') && (m.includes('File Not Found') || m.includes('Cannot')),
		info: {
			title: 'Endpoint not found',
			description: 'The provider URL returned 404. Check your endpoint is correct in settings.',
			docsUrl: 'https://neuralinverse.com/docs/troubleshooting/connection-failed',
			showSettings: true,
		},
	},
];

const getErrorCard = (message: string): ErrorCardInfo | null => {
	for (const { match, info } of ERROR_CARDS) {
		if (match(message)) return info;
	}
	return null;
};


const ErrorCard = ({ info, onDismiss }: { info: ErrorCardInfo; onDismiss: (() => void) | null }) => {
	const accessor = useAccessor();
	const commandService = accessor.get('ICommandService');

	return (
		<div style={{
			borderRadius: '10px',
			border: '1px solid var(--vscode-input-border, var(--vscode-widget-border))',
			background: 'var(--vscode-editor-background)',
			padding: '14px 16px',
		}}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
				<AlertCircle style={{ width: '14px', height: '14px', color: 'var(--vscode-foreground)', flexShrink: 0 }} />
				<span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--vscode-foreground)' }}>
					{info.title}
				</span>
			</div>

			<p style={{ margin: '8px 0 0', fontSize: '11.5px', color: 'var(--vscode-descriptionForeground)', lineHeight: '1.5' }}>
				{info.description}
				{' '}See our{' '}
				<a href={info.docsUrl} target='_blank' rel='noopener noreferrer'
					style={{ color: 'var(--vscode-textLink-foreground)', textDecoration: 'underline' }}
				>troubleshooting guide</a> for help.
			</p>

			<div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px' }}>
				{onDismiss && (
					<button onClick={onDismiss} style={{
						padding: '5px 12px', borderRadius: '14px', fontSize: '11px', fontWeight: 500, cursor: 'pointer',
						background: 'var(--vscode-button-secondaryBackground)',
						color: 'var(--vscode-button-secondaryForeground)',
						border: 'none',
					}}>Dismiss</button>
				)}
				{info.showSettings && (
					<button onClick={() => commandService.executeCommand(VOID_OPEN_SETTINGS_ACTION_ID)} style={{
						padding: '5px 12px', borderRadius: '14px', fontSize: '11px', fontWeight: 500, cursor: 'pointer',
						background: 'var(--vscode-button-secondaryBackground)',
						color: 'var(--vscode-button-secondaryForeground)',
						border: 'none', marginLeft: onDismiss ? 'auto' : undefined,
					}}>Open settings</button>
				)}
				{info.showSignup && (
					<a href='https://cloud.neuralinverse.com' target='_blank' rel='noopener noreferrer' style={{
						padding: '5px 12px', borderRadius: '14px', fontSize: '11px', fontWeight: 500, textDecoration: 'none',
						background: 'var(--vscode-button-background)',
						color: 'var(--vscode-button-foreground)',
					}}>Sign up</a>
				)}
			</div>
		</div>
	);
};


export const ErrorDisplay = ({
	message: message_,
	fullError,
	onDismiss,
	showDismiss,
}: {
	message: string,
	fullError: Error | null,
	onDismiss: (() => void) | null,
	showDismiss?: boolean,
}) => {
	const [isExpanded, setIsExpanded] = useState(false);

	const details = errorDetails(fullError)
	const isExpandable = !!details

	const message = message_ + ''

	const cardInfo = getErrorCard(message);
	if (cardInfo) {
		return <ErrorCard info={cardInfo} onDismiss={onDismiss} />;
	}

	return (
		<div style={{
			borderRadius: '10px',
			border: '1px solid var(--vscode-input-border, var(--vscode-widget-border))',
			background: 'var(--vscode-editor-background)',
			padding: '14px 16px',
		}}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
				<AlertCircle style={{ width: '14px', height: '14px', color: 'var(--vscode-errorForeground)', flexShrink: 0 }} />
				<span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--vscode-foreground)' }}>
					Error
				</span>
			</div>

			<p style={{ margin: '8px 0 0', fontSize: '11.5px', color: 'var(--vscode-descriptionForeground)', lineHeight: '1.5', wordBreak: 'break-word' }}>
				{message}
			</p>

			{isExpandable && (
				<button onClick={() => setIsExpanded(!isExpanded)} style={{
					margin: '8px 0 0', padding: 0, background: 'none', border: 'none', cursor: 'pointer',
					fontSize: '11px', color: 'var(--vscode-textLink-foreground)',
				}}>
					{isExpanded ? 'Hide details' : 'Show details'}
				</button>
			)}
			{isExpanded && details && (
				<pre style={{ margin: '6px 0 0', fontSize: '10px', color: 'var(--vscode-descriptionForeground)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
					{details}
				</pre>
			)}

			<div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px' }}>
				{onDismiss && (
					<button onClick={onDismiss} style={{
						padding: '5px 12px', borderRadius: '14px', fontSize: '11px', fontWeight: 500, cursor: 'pointer',
						background: 'var(--vscode-button-secondaryBackground)',
						color: 'var(--vscode-button-secondaryForeground)',
						border: 'none',
					}}>Dismiss</button>
				)}
			</div>
		</div>
	);
};
