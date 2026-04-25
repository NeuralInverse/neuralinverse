/*--------------------------------------------------------------------------------------
 *  Copyright (c) NeuralInverse. All rights reserved.
 *  Agent Manager \u2014 Execution dashboard for the agentic engine.
 *--------------------------------------------------------------------------------------*/

import { useState, useMemo } from 'react'
import { useAccessor, useAgentTask, useSubAgents } from '../util/services.js'
import { AgentTaskStatus } from '../../../../common/neuralInverseAgentTypes.js'
import { SubAgentTask } from '../../../../common/subAgentTypes.js'

type LogEntry = { timestamp: string; type: string; summary: string }

// \u2500\u2500\u2500 Status \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const STATUS: Record<AgentTaskStatus, { label: string; color: string; pulse: boolean }> = {
	planning:          { label: 'Planning',          color: 'var(--vscode-charts-blue)',   pulse: true  },
	executing:         { label: 'Executing',         color: 'var(--vscode-charts-green)',  pulse: true  },
	paused:            { label: 'Paused',            color: 'var(--vscode-charts-yellow)', pulse: false },
	awaiting_approval: { label: 'Awaiting Approval', color: 'var(--vscode-charts-orange)', pulse: true  },
	completed:         { label: 'Completed',         color: 'var(--vscode-charts-green)',  pulse: false },
	failed:            { label: 'Failed',            color: 'var(--vscode-charts-red)',    pulse: false },
	cancelled:         { label: 'Cancelled',         color: 'var(--vscode-disabledForeground)', pulse: false },
}

// \u2500\u2500\u2500 Atoms \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const PulseDot = ({ color, pulse }: { color: string; pulse: boolean }) => (
	<span style={{
		width: 6, height: 6, borderRadius: '50%', flexShrink: 0, display: 'inline-block',
		background: color, animation: pulse ? 'ni-pulse 1.6s ease-in-out infinite' : 'none',
	}} />
)

const StatusPill = ({ status }: { status: AgentTaskStatus }) => {
	const s = STATUS[status]
	return (
		<span style={{
			display: 'inline-flex', alignItems: 'center', gap: 5,
			padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 600,
			letterSpacing: '0.08em', textTransform: 'uppercase',
			color: s.color,
			background: `color-mix(in srgb, ${s.color} 10%, transparent)`,
			border: `1px solid color-mix(in srgb, ${s.color} 20%, transparent)`,
		}}>
			<PulseDot color={s.color} pulse={s.pulse} />
			{s.label}
		</span>
	)
}

const Btn = ({ label, onClick, variant = 'default', disabled = false }: {
	label: string; onClick: () => void
	variant?: 'default' | 'primary' | 'danger'
	disabled?: boolean
}) => (
	<button onClick={onClick} disabled={disabled} style={{
		padding: '3px 10px', borderRadius: 3, fontSize: 11, fontWeight: 500,
		letterSpacing: '0.02em', cursor: disabled ? 'not-allowed' : 'pointer',
		opacity: disabled ? 0.4 : 1,
		border: '1px solid',
		...(variant === 'primary' ? {
			background: 'var(--vscode-button-background)',
			color: 'var(--vscode-button-foreground)',
			borderColor: 'transparent',
		} : variant === 'danger' ? {
			background: 'color-mix(in srgb, var(--vscode-charts-red) 8%, transparent)',
			color: 'var(--vscode-charts-red)',
			borderColor: 'color-mix(in srgb, var(--vscode-charts-red) 20%, transparent)',
		} : {
			background: 'transparent',
			color: 'var(--vscode-descriptionForeground)',
			borderColor: 'var(--vscode-widget-border)',
		}),
	}}>
		{label}
	</button>
)

const Label = ({ children }: { children: string }) => (
	<div style={{
		fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
		textTransform: 'uppercase', color: 'var(--vscode-descriptionForeground)',
		marginBottom: 5, opacity: 0.7,
	}}>
		{children}
	</div>
)

const Divider = () => (
	<div style={{ height: 1, background: 'var(--vscode-widget-border)', opacity: 0.5 }} />
)

// \u2500\u2500\u2500 Metrics Row \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const MetricRow = ({ items }: { items: Array<{ label: string; value: string | number; warn?: boolean }> }) => (
	<div style={{ display: 'flex', gap: 1 }}>
		{items.map(({ label, value, warn }, i) => (
			<div key={label} style={{
				flex: 1, padding: '7px 10px',
				background: 'var(--vscode-editor-background)',
				borderTop: '1px solid var(--vscode-widget-border)',
				borderBottom: '1px solid var(--vscode-widget-border)',
				borderLeft: i === 0 ? '1px solid var(--vscode-widget-border)' : 'none',
				borderRight: '1px solid var(--vscode-widget-border)',
				borderRadius: i === 0 ? '3px 0 0 3px' : i === items.length - 1 ? '0 3px 3px 0' : 0,
			}}>
				<div style={{
					fontSize: 15, fontWeight: 600, lineHeight: 1, marginBottom: 3,
					color: warn ? 'var(--vscode-charts-red)' : 'var(--vscode-editor-foreground)',
					fontVariantNumeric: 'tabular-nums',
				}}>
					{value}
				</div>
				<div style={{ fontSize: 9, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--vscode-descriptionForeground)', opacity: 0.6 }}>
					{label}
				</div>
			</div>
		))}
	</div>
)

// \u2500\u2500\u2500 Sub-Agent Row \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const agentColor: Record<string, string> = {
	pending:   'var(--vscode-disabledForeground)',
	running:   'var(--vscode-charts-blue)',
	completed: 'var(--vscode-charts-green)',
	failed:    'var(--vscode-charts-red)',
	cancelled: 'var(--vscode-disabledForeground)',
}

const SubAgentRow = ({ agent, idx }: { agent: SubAgentTask; idx: number }) => {
	const color = agentColor[agent.status] || 'var(--vscode-disabledForeground)'
	const isRunning = agent.status === 'running'
	return (
		<div style={{
			display: 'grid', gridTemplateColumns: '18px 52px 1fr 42px',
			alignItems: 'center', gap: 8,
			padding: '6px 10px',
			background: isRunning
				? `color-mix(in srgb, ${color} 4%, var(--vscode-editor-background))`
				: 'var(--vscode-editor-background)',
			borderLeft: `2px solid ${isRunning ? color : 'transparent'}`,
			borderBottom: '1px solid color-mix(in srgb, var(--vscode-widget-border) 60%, transparent)',
		}}>
			{/* Index */}
			<span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', opacity: 0.4, textAlign: 'right' }}>
				{idx + 1}
			</span>
			{/* Role */}
			<span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--vscode-descriptionForeground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
				{agent.role}
			</span>
			{/* Goal */}
			<span style={{ fontSize: 11, color: 'var(--vscode-editor-foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
				{agent.goal}
			</span>
			{/* Status */}
			<span style={{ fontSize: 9, fontWeight: 600, color, textAlign: 'right', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
				{isRunning && <PulseDot color={color} pulse />}
				{agent.status}
			</span>
		</div>
	)
}

// \u2500\u2500\u2500 Log \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const LOG_TYPE: Record<string, { color: string; tag: string }> = {
	tool_call:     { color: 'var(--vscode-charts-blue)',   tag: 'tool'  },
	llm_response:  { color: 'var(--vscode-charts-purple)', tag: 'llm'   },
	error:         { color: 'var(--vscode-charts-red)',    tag: 'error' },
	user_approval: { color: 'var(--vscode-charts-green)',  tag: 'appr'  },
	status_update: { color: 'var(--vscode-descriptionForeground)', tag: 'info' },
}

const LogLine = ({ entry }: { entry: LogEntry }) => {
	const t = LOG_TYPE[entry.type] || LOG_TYPE.status_update
	const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
	return (
		<div style={{
			display: 'grid', gridTemplateColumns: '48px 34px 1fr',
			gap: 8, padding: '3px 0',
			borderBottom: '1px solid color-mix(in srgb, var(--vscode-widget-border) 30%, transparent)',
			fontSize: 11,
		}}>
			<span style={{ color: 'var(--vscode-descriptionForeground)', opacity: 0.45, fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
				{time}
			</span>
			<span style={{ color: t.color, fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', paddingTop: 1 }}>
				{t.tag}
			</span>
			<span style={{ color: 'var(--vscode-editor-foreground)', lineHeight: 1.4 }}>
				{entry.summary}
			</span>
		</div>
	)
}

// \u2500\u2500\u2500 File Chips \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const FileList = ({ files, color }: { files: Set<string>; color: string }) => {
	if (files.size === 0) return null
	return (
		<div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
			{[...files].map(f => (
				<span key={f} title={f} style={{
					padding: '1px 7px', borderRadius: 2, fontSize: 10,
					background: `color-mix(in srgb, ${color} 8%, transparent)`,
					color, border: `1px solid color-mix(in srgb, ${color} 20%, transparent)`,
					fontFamily: 'var(--vscode-editor-font-family)',
					maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
				}}>
					{f.split('/').pop()}
				</span>
			))}
		</div>
	)
}

// \u2500\u2500\u2500 Idle \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const Idle = () => (
	<div style={{
		flex: 1, display: 'flex', flexDirection: 'column',
		alignItems: 'center', justifyContent: 'center',
		gap: 10, padding: '0 32px',
	}}>
		<div style={{
			width: 32, height: 32, borderRadius: '50%',
			border: '1px solid var(--vscode-widget-border)',
			display: 'flex', alignItems: 'center', justifyContent: 'center',
			opacity: 0.25,
		}}>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
				stroke="var(--vscode-editor-foreground)" strokeWidth="1.5"
				strokeLinecap="round" strokeLinejoin="round">
				<circle cx="12" cy="12" r="10" />
				<polyline points="12 6 12 12 16 14" />
			</svg>
		</div>
		<div style={{ textAlign: 'center' }}>
			<div style={{ fontSize: 12, fontWeight: 500, color: 'var(--vscode-editor-foreground)', opacity: 0.3, marginBottom: 4 }}>
				No active task
			</div>
			<div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', opacity: 0.25, lineHeight: 1.6 }}>
				Set mode to Agent in the sidebar<br />and send a message to begin.
			</div>
		</div>
	</div>
)

// \u2500\u2500\u2500 Main \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const AgentManager = () => {
	const accessor = useAccessor()
	const agentService = accessor.get('INeuralInverseAgentService')
	const task = useAgentTask()
	const subAgents = useSubAgents()
	const [tab, setTab] = useState<'overview' | 'log'>('overview')

	const subAgentList = useMemo(() => {
		const list: SubAgentTask[] = []
		subAgents.forEach(a => list.push(a))
		return list
	}, [subAgents])

	const logEntries = useMemo(() =>
		task ? [...task.executionLog].reverse().slice(0, 100) : []
	, [task])

	const isActive   = task?.status === 'executing' || task?.status === 'planning' || task?.status === 'awaiting_approval'
	const isPaused   = task?.status === 'paused'
	const isTerminal = task?.status === 'completed' || task?.status === 'failed' || task?.status === 'cancelled'

	const iterPct = task ? Math.round((task.iteration / task.maxIterations) * 100) : 0

	return (
		<div style={{
			display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
			background: 'var(--vscode-panel-background)',
			color: 'var(--vscode-editor-foreground)',
			fontFamily: 'var(--vscode-font-family)',
			fontSize: 12,
		}}>
			<style>{`
				@keyframes ni-pulse { 0%,100%{opacity:1} 50%{opacity:0.2} }
			`}</style>

			{/* \u2500\u2500 Header \u2500\u2500 */}
			<div style={{
				display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', flexShrink: 0,
				borderBottom: '1px solid var(--vscode-widget-border)',
				background: 'var(--vscode-editor-background)',
			}}>
				<span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', opacity: 0.5 }}>
					NI Agent
				</span>

				{task && <StatusPill status={task.status} />}

				<span style={{ flex: 1 }} />

				{task && (
					<div style={{ display: 'flex', gap: 4 }}>
						{isActive && !isPaused && <Btn label="Pause"  onClick={() => agentService.pauseTask(task.id)}  />}
						{isPaused            && <Btn label="Resume" onClick={() => agentService.resumeTask(task.id)} variant="primary" />}
						{(isActive || isPaused) && <Btn label="Stop" onClick={() => agentService.cancelTask(task.id)} variant="danger" />}
					</div>
				)}
			</div>

			{/* \u2500\u2500 Body \u2500\u2500 */}
			{!task ? <Idle /> : (
				<div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

					{/* Approval bar */}
					{task.status === 'awaiting_approval' && (
						<div style={{
							display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px',
							background: 'color-mix(in srgb, var(--vscode-charts-orange) 8%, transparent)',
							borderBottom: '1px solid color-mix(in srgb, var(--vscode-charts-orange) 20%, transparent)',
							flexShrink: 0,
						}}>
							<PulseDot color="var(--vscode-charts-orange)" pulse />
							<span style={{ flex: 1, fontSize: 11, color: 'var(--vscode-charts-orange)' }}>
								Tool approval required
							</span>
							<Btn label="Approve" onClick={() => agentService.approveToolCall?.(task.id)} variant="primary" />
							<Btn label="Reject"  onClick={() => agentService.rejectToolCall?.(task.id)}  variant="danger"  />
						</div>
					)}

					{/* Tab bar */}
					<div style={{
						display: 'flex', borderBottom: '1px solid var(--vscode-widget-border)', flexShrink: 0,
						background: 'var(--vscode-editor-background)',
					}}>
						{(['overview', 'log'] as const).map(t => (
							<button key={t} onClick={() => setTab(t)} style={{
								padding: '5px 14px', fontSize: 11, fontWeight: tab === t ? 600 : 400,
								background: 'transparent', border: 'none', cursor: 'pointer',
								color: tab === t ? 'var(--vscode-editor-foreground)' : 'var(--vscode-descriptionForeground)',
								borderBottom: tab === t ? '1.5px solid var(--vscode-focusBorder)' : '1.5px solid transparent',
								marginBottom: -1, textTransform: 'capitalize',
							}}>
								{t}{t === 'log' && task.executionLog.length > 0 && (
									<span style={{ marginLeft: 5, fontSize: 9, opacity: 0.5 }}>{task.executionLog.length}</span>
								)}
							</button>
						))}
					</div>

					{/* Scrollable content */}
					<div style={{ flex: 1, overflow: 'auto' }}>

						{tab === 'overview' && (
							<div style={{ display: 'flex', flexDirection: 'column' }}>

								{/* Goal */}
								<div style={{ padding: '10px 12px', borderBottom: '1px solid color-mix(in srgb, var(--vscode-widget-border) 60%, transparent)' }}>
									<Label>Goal</Label>
									<div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--vscode-editor-foreground)' }}>
										{task.goal}
									</div>
								</div>

								{/* Metrics */}
								<div style={{ padding: '10px 12px', borderBottom: '1px solid color-mix(in srgb, var(--vscode-widget-border) 60%, transparent)' }}>
									<Label>Progress</Label>
									{/* Iteration bar */}
									<div style={{ marginBottom: 8 }}>
										<div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
											<span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', opacity: 0.6 }}>
												Iteration {task.iteration} of {task.maxIterations}
											</span>
											<span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', opacity: 0.6 }}>
												{iterPct}%
											</span>
										</div>
										<div style={{ height: 2, background: 'var(--vscode-widget-border)', borderRadius: 1, overflow: 'hidden' }}>
											<div style={{
												height: '100%', width: `${iterPct}%`,
												background: isTerminal
													? (task.status === 'completed' ? 'var(--vscode-charts-green)' : 'var(--vscode-charts-red)')
													: 'var(--vscode-charts-blue)',
												transition: 'width 0.4s ease',
											}} />
										</div>
									</div>
									<MetricRow items={[
										{ label: 'Tool Calls',   value: task.totalToolCalls },
										{ label: 'LLM Calls',   value: task.totalLLMCalls },
										{ label: 'Files Read',  value: task.filesRead.size },
										{ label: 'Edited',      value: task.filesModified.size },
										{ label: 'Errors',      value: task.totalErrors, warn: task.totalErrors > 0 },
									]} />
								</div>

								{/* Sub-agents */}
								{subAgentList.length > 0 && (
									<div style={{ borderBottom: '1px solid color-mix(in srgb, var(--vscode-widget-border) 60%, transparent)' }}>
										<div style={{ padding: '10px 12px 6px' }}>
											<Label>
												{`Sub-Agents · ${subAgentList.filter(a => a.status === 'running').length} running / ${subAgentList.length}`}
											</Label>
										</div>
										{subAgentList.map((a, i) => <SubAgentRow key={a.id} agent={a} idx={i} />)}
									</div>
								)}

								{/* Files */}
								{(task.filesModified.size > 0 || task.filesRead.size > 0) && (
									<div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10, borderBottom: '1px solid color-mix(in srgb, var(--vscode-widget-border) 60%, transparent)' }}>
										{task.filesModified.size > 0 && (
											<div>
												<Label>Modified</Label>
												<FileList files={task.filesModified} color="var(--vscode-charts-green)" />
											</div>
										)}
										{task.filesRead.size > 0 && (
											<div>
												<Label>Read</Label>
												<FileList files={task.filesRead} color="var(--vscode-charts-blue)" />
											</div>
										)}
									</div>
								)}

								{/* Terminal result */}
								{isTerminal && (
									<div style={{ padding: '10px 12px' }}>
										<div style={{
											padding: '8px 12px', borderRadius: 3, fontSize: 11,
											borderLeft: `3px solid ${
												task.status === 'completed' ? 'var(--vscode-charts-green)' :
												task.status === 'failed'    ? 'var(--vscode-charts-red)'   :
												'var(--vscode-disabledForeground)'
											}`,
											background: 'var(--vscode-editor-background)',
											color: 'var(--vscode-descriptionForeground)',
										}}>
											{task.status === 'completed' && <span style={{ color: 'var(--vscode-charts-green)', fontWeight: 600 }}>Task completed</span>}
											{task.status === 'failed'    && <span style={{ color: 'var(--vscode-charts-red)',   fontWeight: 600 }}>Task failed</span>}
											{task.status === 'cancelled' && <span style={{ fontWeight: 600 }}>Task cancelled</span>}
											<span style={{ marginLeft: 8, opacity: 0.55 }}>
												{task.iteration} iter · {task.totalToolCalls} tool calls · {task.totalLLMCalls} LLM calls
											</span>
										</div>
									</div>
								)}
							</div>
						)}

						{tab === 'log' && (
							<div style={{ padding: '8px 12px' }}>
								{logEntries.length === 0 ? (
									<div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', opacity: 0.4, padding: '16px 0' }}>
										No log entries yet.
									</div>
								) : logEntries.map((entry, i) => (
									<LogLine key={i} entry={entry} />
								))}
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	)
}
