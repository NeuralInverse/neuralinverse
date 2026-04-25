/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

// \u2500\u2500\u2500 CSS NOTE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// See STYLING_RULES.md in this directory before using Tailwind classes.
// Key rule: void-border-* colors are plain CSS variables \u2014 NEVER use /opacity
// modifiers (e.g. border-void-border-3/40). Use opacity-* utilities instead.
// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

import React, { useState } from 'react';

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

const roleLabels: Record<string, string> = {
	editor: 'writer',
	writer: 'writer',
	explorer: 'explorer',
	verifier: 'verifier',
	compliance: 'compliance',
};

function cleanGoal(goal: string): string {
	const filePathMatch = goal.match(/^(.+?)(?:\.\s+)?(?:Create|Write).*?\s+(?:at|to)\s+[\/~]/i);
	const cleaned = filePathMatch ? filePathMatch[1].trim() : goal;
	return cleaned.length > 65 ? cleaned.substring(0, 65) + '\u2026' : cleaned;
}

function formatDuration(duration?: string): string | null {
	if (!duration) return null;
	// If it's "0s" or "0ms" it's not meaningful \u2014 show nothing
	if (/^0+[ms]?s?$/.test(duration.trim())) return null;
	return duration;
}

// \u2500\u2500\u2500 AgentNetworkViz \u2500\u2500\u2500 render when a sub-agent is spawned \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
//
// UX intent: show a clean inline row for each spawned agent.
// No session hacks \u2014 the TaskGroupBlock above provides "Spawning\u2026" context.
// Each spawn_agent call renders exactly one agent row.

export const AgentNetworkViz: React.FC<AgentNetworkVizProps> = ({
	agentId,
	role,
	goal,
}) => {
	const shortId = agentId.substring(0, 8);
	const taskTitle = cleanGoal(goal);
	const displayRole = roleLabels[role] || role;

	return (
		<div className="flex items-center gap-1.5 py-0.5 my-0.5">
			{/* Status dot \u2014 static, no glow/pulse */}
			<span className="w-[5px] h-[5px] rounded-full flex-shrink-0 mt-px bg-void-fg-4 opacity-40" />
			{/* Role */}
			<span className="text-[11px] text-void-fg-3 capitalize flex-shrink-0 font-medium">{displayRole}</span>
			{/* Short ID */}
			<span className="text-[10px] text-void-fg-4 opacity-50 font-mono flex-shrink-0">{shortId}</span>
			{/* Goal */}
			<span className="text-[10px] text-void-fg-4 opacity-50 truncate min-w-0">{taskTitle}</span>
		</div>
	);
};

// \u2500\u2500\u2500 AgentCompletionCard \u2500\u2500\u2500 render when a sub-agent completes \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
//
// UX intent: show a compact done row. Click to reveal the agent's full result.
// Duration is omitted if it's zero or missing \u2014 both mean we didn't measure it.

export const AgentCompletionCard: React.FC<AgentCompletionCardProps> = ({
	agentId,
	role,
	goal,
	result,
	duration,
}) => {
	const [isExpanded, setIsExpanded] = useState(false);
	const shortId = agentId.substring(0, 8);
	const taskTitle = cleanGoal(goal);
	const displayRole = roleLabels[role] || role;
	const displayDuration = formatDuration(duration);

	// Trim result for preview
	const resultPreview = result.length > 1200
		? result.substring(0, 1200) + '\n\n\u2026truncated'
		: result;

	return (
		<div className="my-0.5">
			{/* Completion row */}
			<div
				className="flex items-center gap-1.5 py-0.5 cursor-pointer group select-none"
				onClick={() => setIsExpanded(v => !v)}
			>
				{/* Done dot */}
				<span className="w-[5px] h-[5px] rounded-full flex-shrink-0 mt-px bg-void-fg-4 opacity-40" />
				{/* Role */}
				<span className="text-[11px] text-void-fg-3 capitalize flex-shrink-0 font-medium group-hover:text-void-fg-2 transition-colors">
					{displayRole}
				</span>
				{/* Short ID */}
				<span className="text-[10px] text-void-fg-4 opacity-50 font-mono flex-shrink-0">{shortId}</span>
				{/* Duration \u2014 only shown when meaningful */}
				{displayDuration && (
					<span className="text-[10px] text-void-fg-4 opacity-40 flex-shrink-0">{displayDuration}</span>
				)}
				{/* Goal \u2014 truncated */}
				<span className="text-[10px] text-void-fg-4 opacity-50 truncate min-w-0 flex-1">{taskTitle}</span>
				{/* Expand chevron \u2014 right edge */}
				<svg
					width="10" height="10" viewBox="0 0 16 16" fill="none"
					className="flex-shrink-0 opacity-40 transition-transform duration-150 text-void-fg-4 ml-auto"
					style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
				>
					<path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
			</div>

			{/* Expanded result panel */}
			{isExpanded && (
				<div className="ml-2 pl-2.5 border-l border-void-border-3 mt-0.5 pb-0.5">
					<pre className="text-[11px] text-void-fg-4 opacity-60 leading-relaxed whitespace-pre-wrap break-words max-h-[280px] overflow-y-auto select-text cursor-auto">
						{resultPreview}
					</pre>
				</div>
			)}
		</div>
	);
};
