/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Task C2: the context gauge for the Void sidebar. The backend report comes
// from the ledger assembler (IContextUsageReport, written per send and already
// exposed by chatThreadService.getLedgerUsageReport) — this widget only
// displays it: "Context: 34.2k / 200k" with a click-through breakdown. It
// reads the report during render and re-renders on every thread-state change
// (messages, stream ticks), which is when a new report can exist anyway.
// When the ledger is off or no report exists yet (fresh thread) the gauge
// renders nothing: absent means unknown, not zero.

import { useState } from 'react';
import { useAccessor, useChatThreadsState } from '../util/services.js';
import type { IContextUsageReport, IContextUsageSection } from '../../../../common/ledgerTypes.js';

const fmtTokens = (t: number): string => t >= 1000 ? `${(t / 1000).toFixed(1)}k` : `${t}`;

const SECTION_LABELS: Record<IContextUsageSection['name'], string> = {
	system: 'System prompt',
	brief: 'Working brief',
	pinned: 'Pinned blocks',
	recalled: 'Recalled episodes',
	notice: 'Notices',
	tail: 'Recent history',
	'reserved-output': 'Reserved for output',
	'reserved-system': 'Reserved for system & tools',
};

// thresholds mirror the compactor: 72% of the window is the compaction trigger
const gaugeColorOf = (ratio: number): string => {
	if (ratio > 0.72) { return 'text-red-400'; }
	if (ratio > 0.60) { return 'text-yellow-400'; }
	return 'text-void-fg-3';
};


export const ContextGauge = () => {
	const { get } = useAccessor();
	const threadsState = useChatThreadsState();
	const [open, setOpen] = useState(false);

	const chatThreadService = get('IChatThreadService');
	const report: IContextUsageReport | undefined = chatThreadService.getLedgerUsageReport(threadsState.currentThreadId);
	if (report === undefined) { return null; }

	const ratio = report.contextWindow > 0 ? report.totalTokens / report.contextWindow : 0;
	// reserved-output is informational and excluded from totalTokens — show it as its own row
	const sections = report.sections.filter(s => s.name !== 'reserved-output' && s.name !== 'reserved-system');
	const reservedOutput = report.sections.find(s => s.name === 'reserved-output')?.tokens ?? 0;
	const reservedSystem = report.sections.find(s => s.name === 'reserved-system')?.tokens ?? 0;
	const lastUsage = chatThreadService.getLedgerLastUsage(threadsState.currentThreadId);

	return (
		<div className='relative'>
			<button
				type='button'
				className={`text-xs text-nowrap cursor-pointer hover:brightness-110 ${gaugeColorOf(ratio)}`}
				title='Context window usage — click for the breakdown'
				onClick={() => setOpen(o => !o)}
			>
				Context: {fmtTokens(report.totalTokens)} / {fmtTokens(report.contextWindow)}
				{ratio > 0.72 && ' ⚠'}
			</button>

			{open && (
				<div className='
					absolute top-full right-0 mt-1 z-10 w-64 p-2
					bg-void-bg-1 border border-void-border-1 rounded-md shadow-lg
					text-xs text-void-fg-2
				'>
					<div className='flex justify-between text-void-fg-1 mb-1'>
						<span>Context breakdown</span>
						<span>{Math.round(ratio * 100)}%</span>
					</div>

					{sections.map(s => (
						<div key={s.name} className='mb-1'>
							<div className='flex justify-between'>
								<span>{SECTION_LABELS[s.name] ?? s.name}</span>
								<span className='text-void-fg-3'>{fmtTokens(s.tokens)}</span>
							</div>
							<div className='h-1 rounded bg-void-bg-2 overflow-hidden'>
								<div
									className='h-full bg-void-fg-4'
									style={{ width: `${report.totalTokens > 0 ? Math.min(100, 100 * s.tokens / report.totalTokens) : 0}%` }}
								/>
							</div>
						</div>
					))}

					<div className='flex justify-between mt-2 pt-1 border-t border-void-border-2 text-void-fg-3'>
						<span>Available for input</span>
						<span>{fmtTokens(report.availableInputTokens)}</span>
					</div>
					<div className='flex justify-between text-void-fg-3'>
						<span>Reserved for output</span>
						<span>{fmtTokens(reservedOutput)}</span>
					</div>
					{reservedSystem > 0 && (
						<div className='flex justify-between text-void-fg-3'>
							<span>Reserved for system &amp; tools</span>
							<span>{fmtTokens(reservedSystem)}</span>
						</div>
					)}
					{lastUsage && (
						<div className='flex justify-between text-void-fg-3'>
							<span>Last reply (actual input)</span>
							<span>{fmtTokens(lastUsage.input)}</span>
						</div>
					)}

					{!report.cacheStable && (
						<div className='mt-1 text-yellow-400/80'>
							Prompt cache unstable — prefix changed without a brief revision
						</div>
					)}
				</div>
			)}
		</div>
	);
};
