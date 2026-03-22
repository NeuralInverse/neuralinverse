/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import React, { useState, useEffect } from 'react';

interface AgentNetworkVizProps {
	agentId: string;
	role: string;
	goal: string;
	hasWriteAccess: boolean;
}

interface AgentCompletionCardProps {
	agentId: string;
	role: string;
	goal: string;
	result: string;
	duration?: string;
}

// Track if we've shown the parent for this session - use WeakMap to avoid stale state
const parentShownMap = new WeakMap<object, boolean>();
let sessionResetTimer: NodeJS.Timeout | null = null;
let sessionKey = {};

export const AgentNetworkViz: React.FC<AgentNetworkVizProps> = ({
	agentId,
	role,
	goal,
	hasWriteAccess
}) => {
	const [showParent, setShowParent] = useState(false);
	const shortId = agentId.substring(0, 8);

	// Clean up task display - show meaningful description, not file paths
	let taskTitle = goal;
	// If goal contains "Create/Write a file at [path]", extract the action before it
	const filePathMatch = goal.match(/^(.+?)(?:\.\s+)?(?:Create|Write).*?\s+(?:at|to)\s+[\/~]/i);
	if (filePathMatch) {
		taskTitle = filePathMatch[1].trim();
	}
	// Truncate if still too long
	if (taskTitle.length > 55) {
		taskTitle = taskTitle.substring(0, 55) + '...';
	}

	useEffect(() => {
		// Show parent on first agent in a batch
		if (!parentShownMap.get(sessionKey)) {
			setShowParent(true);
			parentShownMap.set(sessionKey, true);
		}

		// Reset after 2 seconds of no new agents
		if (sessionResetTimer) clearTimeout(sessionResetTimer);
		sessionResetTimer = setTimeout(() => {
			sessionKey = {}; // Create new key to reset session
			parentShownMap.set(sessionKey, false);
		}, 2000);

		return () => {
			if (sessionResetTimer) {
				clearTimeout(sessionResetTimer);
				sessionResetTimer = null;
			}
		};
	}, []);

	const roleColors: Record<string, string> = {
		editor: '#10b981',
		explorer: '#3b82f6',
		verifier: '#f59e0b',
		compliance: '#8b5cf6',
	};

	const roleLabels: Record<string, string> = {
		editor: 'writer',
		explorer: 'explorer',
		verifier: 'verifier',
		compliance: 'compliance',
	};

	const color = roleColors[role] || roleColors.editor;
	const displayRole = roleLabels[role] || role;

	return (
		<div style={{ position: 'relative' }}>
			{/* Parent node (shown only for first agent) */}
			{showParent && (
				<div style={{
					display: 'flex',
					alignItems: 'center',
					gap: '8px',
					padding: '6px 10px',
					marginBottom: '8px',
					background: 'var(--vscode-editor-background)',
					borderRadius: '6px',
					border: '1px solid var(--vscode-widget-border)',
				}}>
					<div style={{
						width: '6px',
						height: '6px',
						borderRadius: '50%',
						background: 'var(--vscode-descriptionForeground)',
					}} />
					<span style={{
						fontSize: '11px',
						color: 'var(--vscode-descriptionForeground)',
						fontWeight: 500,
					}}>
						Deploying Agents
					</span>
				</div>
			)}

			{/* Child agent */}
			<div style={{
				position: 'relative',
				paddingLeft: '20px',
				marginBottom: '4px',
			}}>
				{/* Vertical connection line */}
				<div style={{
					position: 'absolute',
					left: '6px',
					top: showParent ? '-17px' : '-8px',
					bottom: '50%',
					width: '1px',
					background: 'var(--vscode-editorIndentGuide-background)',
				}} />

				{/* Horizontal branch line */}
				<div style={{
					position: 'absolute',
					left: '6px',
					top: '50%',
					width: '14px',
					height: '1px',
					background: 'var(--vscode-editorIndentGuide-background)',
				}} />

				{/* Agent card */}
				<div style={{
					display: 'flex',
					alignItems: 'center',
					gap: '8px',
					padding: '6px 10px',
					background: 'var(--vscode-editor-background)',
					borderRadius: '6px',
					border: '1px solid var(--vscode-widget-border)',
				}}>
					{/* Status dot */}
					<div style={{
						width: '6px',
						height: '6px',
						borderRadius: '50%',
						background: color,
						boxShadow: `0 0 8px ${color}80`,
						flexShrink: 0,
					}} />

					{/* Info in one row */}
					<span style={{
						fontSize: '11px',
						fontWeight: 500,
						color: 'var(--vscode-foreground)',
						textTransform: 'capitalize',
						flexShrink: 0,
					}}>
						{displayRole}
					</span>
					<span style={{
						fontSize: '10px',
						color: 'var(--vscode-descriptionForeground)',
						fontFamily: 'monospace',
						flexShrink: 0,
					}}>
						{shortId}
					</span>
					<span style={{
						fontSize: '10px',
						color: 'var(--vscode-descriptionForeground)',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'nowrap',
						flex: 1,
						minWidth: 0,
					}}>
						{taskTitle}
					</span>
				</div>
			</div>
		</div>
	);
};

export const AgentCompletionCard: React.FC<AgentCompletionCardProps> = ({
	agentId,
	role,
	goal,
	result,
	duration
}) => {
	const [isExpanded, setIsExpanded] = useState(false);
	const shortId = agentId.substring(0, 8);

	// Clean up task display
	let taskTitle = goal;
	const filePathMatch = goal.match(/^(.+?)(?:\.\s+)?(?:Create|Write).*?\s+(?:at|to)\s+[\/~]/i);
	if (filePathMatch) {
		taskTitle = filePathMatch[1].trim();
	}
	if (taskTitle.length > 55) {
		taskTitle = taskTitle.substring(0, 55) + '...';
	}

	const roleColors: Record<string, string> = {
		editor: '#10b981',
		explorer: '#3b82f6',
		verifier: '#f59e0b',
		compliance: '#8b5cf6',
	};

	const roleLabels: Record<string, string> = {
		editor: 'writer',
		explorer: 'explorer',
		verifier: 'verifier',
		compliance: 'compliance',
	};

	const color = roleColors[role] || roleColors.editor;
	const displayRole = roleLabels[role] || role;

	return (
		<div style={{ position: 'relative', marginBottom: '4px' }}>
			{/* Completion card */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: '8px',
					padding: '6px 10px',
					background: 'var(--vscode-editor-background)',
					borderRadius: '6px',
					border: '1px solid var(--vscode-widget-border)',
					cursor: 'pointer',
				}}
				onClick={() => setIsExpanded(!isExpanded)}
			>
				{/* Checkmark icon */}
				<svg
					width="12"
					height="12"
					viewBox="0 0 16 16"
					fill="none"
					style={{ flexShrink: 0 }}
				>
					<circle cx="8" cy="8" r="7" stroke={color} strokeWidth="1.5" fill="none" />
					<path
						d="M5 8.5L7 10.5L11 6.5"
						stroke={color}
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>

				{/* Info in one row */}
				<span style={{
					fontSize: '11px',
					fontWeight: 500,
					color: 'var(--vscode-foreground)',
					textTransform: 'capitalize',
					flexShrink: 0,
				}}>
					{displayRole}
				</span>
				<span style={{
					fontSize: '10px',
					color: 'var(--vscode-descriptionForeground)',
					fontFamily: 'monospace',
					flexShrink: 0,
				}}>
					{shortId}
				</span>
				<span style={{
					fontSize: '10px',
					color: color,
					fontWeight: 500,
					flexShrink: 0,
				}}>
					completed{duration ? ` in ${duration}` : ''}
				</span>
				<span style={{
					fontSize: '10px',
					color: 'var(--vscode-descriptionForeground)',
					overflow: 'hidden',
					textOverflow: 'ellipsis',
					whiteSpace: 'nowrap',
					flex: 1,
					minWidth: 0,
				}}>
					{taskTitle}
				</span>

				{/* Expand indicator */}
				<svg
					width="12"
					height="12"
					viewBox="0 0 16 16"
					fill="none"
					style={{
						flexShrink: 0,
						transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
						transition: 'transform 0.2s',
					}}
				>
					<path
						d="M6 4L10 8L6 12"
						stroke="var(--vscode-descriptionForeground)"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</div>

			{/* Expandable result details */}
			{isExpanded && (
				<div style={{
					marginTop: '4px',
					padding: '8px 10px',
					background: 'var(--vscode-editor-background)',
					borderRadius: '6px',
					border: '1px solid var(--vscode-widget-border)',
					fontSize: '11px',
					color: 'var(--vscode-descriptionForeground)',
					lineHeight: '1.5',
					whiteSpace: 'pre-wrap',
					wordBreak: 'break-word',
				}}>
					{result}
				</div>
			)}
		</div>
	);
};
