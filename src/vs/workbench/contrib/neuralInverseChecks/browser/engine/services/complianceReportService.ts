/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IGRCEngineService } from './grcEngineService.js';
import { IAuditTrailService } from './auditTrailService.js';
import { IFrameworkRegistry } from '../framework/frameworkRegistry.js';
import { withInverseWriteAccess } from '../utils/inverseFs.js';

export const IComplianceReportService = createDecorator<IComplianceReportService>('complianceReportService');

export interface IComplianceReportService {
	readonly _serviceBrand: undefined;

	/** Generate a professional HTML compliance report (printable to PDF) */
	generateReport(): Promise<string>;

	/** Generate and write HTML report to .inverse/reports/ */
	exportReport(): Promise<URI | undefined>;

	/** Generate and write structured JSON export to .inverse/reports/ */
	exportJson(): Promise<URI | undefined>;
}

class ComplianceReportService extends Disposable implements IComplianceReportService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IGRCEngineService private readonly grcEngine: IGRCEngineService,
		@IAuditTrailService private readonly auditTrail: IAuditTrailService,
		@IFrameworkRegistry private readonly frameworkRegistry: IFrameworkRegistry,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
	}

	async generateReport(): Promise<string> {
		const now = new Date();
		const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
		const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

		const allResults = this.grcEngine.getAllResults();
		const domainSummary = this.grcEngine.getDomainSummary();
		const blockingViolations = this.grcEngine.getBlockingViolations();
		const rules = this.grcEngine.getRules();
		const activeFrameworks = this.grcEngine.getActiveFrameworks();
		const loadedFrameworks = this.frameworkRegistry.getActiveFrameworks();
		const workspaceName = this._getWorkspaceName();

		const enabledRules = rules.filter(r => r.enabled);
		const errorCount = allResults.filter(r => ['error', 'critical', 'blocker'].includes(r.severity)).length;
		const warningCount = allResults.filter(r => ['warning', 'major'].includes(r.severity)).length;
		const infoCount = allResults.filter(r => ['info', 'minor'].includes(r.severity)).length;

		const violatedRuleIds = new Set(allResults.map(r => r.ruleId));
		const passingRules = enabledRules.filter(r => !violatedRuleIds.has(r.id));
		const passRate = enabledRules.length > 0
			? ((passingRules.length / enabledRules.length) * 100).toFixed(1)
			: '100.0';

		const overallStatus = errorCount === 0 && blockingViolations.length === 0 ? 'COMPLIANT' : errorCount > 0 ? 'NON-COMPLIANT' : 'REVIEW REQUIRED';
		const statusColor = overallStatus === 'COMPLIANT' ? '#2e7d32' : overallStatus === 'NON-COMPLIANT' ? '#c62828' : '#e65100';

		const trend = await this._getHistoricalTrend();

		// ── Per-framework sections ──
		const frameworkSections = loadedFrameworks.filter(fw => fw.validation.valid).map(fw => {
			const meta = fw.definition.framework;
			const fwRules = fw.rules.filter(r => r.enabled !== false);
			const fwViolations = allResults.filter(r => r.frameworkId === meta.id);
			const fwViolatedIds = new Set(fwViolations.map(r => r.ruleId));
			const fwPassing = fwRules.filter(r => !fwViolatedIds.has(r.id));
			const fwCompliance = fwRules.length > 0
				? ((fwPassing.length / fwRules.length) * 100).toFixed(1)
				: '100.0';
			const fwErrors = fwViolations.filter(v => ['error', 'critical', 'blocker'].includes(v.severity)).length;
			const fwWarnings = fwViolations.filter(v => ['warning', 'major'].includes(v.severity)).length;
			const fwStatusColor = fwErrors > 0 ? '#c62828' : fwWarnings > 0 ? '#e65100' : '#2e7d32';
			const fwStatus = fwErrors > 0 ? 'NON-COMPLIANT' : fwWarnings > 0 ? 'REVIEW' : 'COMPLIANT';

			// Group violations by rule
			const byRule = new Map<string, { count: number; severity: string; message: string; files: Set<string>; lines: number[] }>();
			for (const v of fwViolations) {
				const existing = byRule.get(v.ruleId);
				const fileName = v.fileUri.path.split('/').pop() ?? v.fileUri.path;
				if (existing) {
					existing.count++;
					existing.files.add(fileName);
					existing.lines.push(v.line);
				} else {
					byRule.set(v.ruleId, { count: 1, severity: v.severity, message: v.message, files: new Set([fileName]), lines: [v.line] });
				}
			}

			const violationRows = Array.from(byRule.entries()).map(([ruleId, info]) => {
				const sevClass = info.severity === 'error' || info.severity === 'critical' || info.severity === 'blocker' ? 'sev-error' : info.severity === 'warning' || info.severity === 'major' ? 'sev-warning' : 'sev-info';
				const files = Array.from(info.files).join(', ');
				return `<tr>
					<td><code class="rule-id">${esc(ruleId)}</code></td>
					<td><span class="sev ${sevClass}">${info.severity.toUpperCase()}</span></td>
					<td>${info.count}</td>
					<td>${esc(this._truncate(info.message, 70))}</td>
					<td class="mono small">${esc(files)}</td>
				</tr>`;
			}).join('');

			return `
			<div class="section framework-section">
				<div class="framework-header">
					<div>
						<div class="framework-name">${esc(meta.name)} <span class="version">v${esc(meta.version)}</span></div>
						${meta.description ? `<div class="framework-desc">${esc(meta.description)}</div>` : ''}
						${meta.authority ? `<div class="framework-authority">Authority: ${esc(meta.authority)}</div>` : ''}
					</div>
					<div class="framework-stats">
						<div class="compliance-ring" style="--pct:${fwCompliance};--color:${fwStatusColor}">
							<div class="ring-inner">
								<div class="ring-pct">${fwCompliance}%</div>
								<div class="ring-label">COMPLIANCE</div>
							</div>
						</div>
						<div class="fw-meta">
							<div class="fw-stat"><span class="fw-stat-label">Status</span><span class="fw-stat-value" style="color:${fwStatusColor};font-weight:700">${fwStatus}</span></div>
							<div class="fw-stat"><span class="fw-stat-label">Rules</span><span class="fw-stat-value">${fwRules.length}</span></div>
							<div class="fw-stat"><span class="fw-stat-label">Violations</span><span class="fw-stat-value">${fwViolations.length}</span></div>
							<div class="fw-stat"><span class="fw-stat-label">Errors</span><span class="fw-stat-value" style="color:#c62828">${fwErrors}</span></div>
						</div>
					</div>
				</div>
				${fwViolations.length > 0 ? `
				<table class="violations-table">
					<thead><tr><th>Rule ID</th><th>Severity</th><th>Count</th><th>Message</th><th>Files</th></tr></thead>
					<tbody>${violationRows}</tbody>
				</table>` : `<div class="all-pass">✓ All rules passing for this framework</div>`}
			</div>`;
		}).join('');

		// ── Top violations with code snippets ──
		const topViolations = allResults
			.sort((a, b) => {
				const ord: Record<string, number> = { blocker: 0, critical: 0, error: 1, major: 2, warning: 2, minor: 3, info: 3 };
				return (ord[a.severity] ?? 3) - (ord[b.severity] ?? 3);
			})
			.slice(0, 30);

		const topViolationRows = topViolations.map((v, i) => {
			const fileName = v.fileUri.path.split('/').pop() ?? v.fileUri.path;
			const sevClass = ['error', 'critical', 'blocker'].includes(v.severity) ? 'sev-error' : ['warning', 'major'].includes(v.severity) ? 'sev-warning' : 'sev-info';
			const aiBlock = v.aiExplanation ? `<div class="ai-note">AI: ${esc(this._truncate(v.aiExplanation, 120))}</div>` : '';
			const snippetBlock = v.codeSnippet ? `<pre class="code-snippet">${esc(v.codeSnippet)}</pre>` : '';
			const fixBlock = v.fix ? `<div class="fix-note">Fix: ${esc(v.fix)}</div>` : '';
			return `<tr>
				<td class="num">${i + 1}</td>
				<td><code class="rule-id">${esc(v.ruleId)}</code></td>
				<td><span class="sev ${sevClass}">${v.severity.toUpperCase()}</span></td>
				<td class="mono small">${esc(fileName)}:${v.line}</td>
				<td>
					<div>${esc(this._truncate(v.message, 80))}</div>
					${aiBlock}${snippetBlock}${fixBlock}
				</td>
			</tr>`;
		}).join('');

		// ── Domain summary rows ──
		const domainRows = domainSummary.map(s => {
			const total = s.errorCount + s.warningCount + s.infoCount;
			const pct = s.totalRules > 0 ? (((s.totalRules - (s.errorCount > 0 ? 1 : 0)) / s.totalRules) * 100).toFixed(0) : '100';
			const barColor = s.errorCount > 0 ? '#c62828' : s.warningCount > 0 ? '#e65100' : '#2e7d32';
			return `<tr>
				<td><strong>${esc(s.domain)}</strong></td>
				<td style="color:#c62828;font-weight:${s.errorCount > 0 ? '700' : '400'}">${s.errorCount}</td>
				<td style="color:#e65100">${s.warningCount}</td>
				<td style="color:#1565c0">${s.infoCount}</td>
				<td>${total}</td>
				<td class="mono small">${s.enabledRules}/${s.totalRules}</td>
				<td>
					<div style="background:#e0e0e0;border-radius:2px;height:6px;width:100px;overflow:hidden">
						<div style="background:${barColor};height:6px;width:${pct}%"></div>
					</div>
				</td>
			</tr>`;
		}).join('');

		// ── Trend chart data ──
		const trendMax = Math.max(...trend.map(t => t.count), 1);
		const trendBars = trend.map(t => {
			const h = Math.round((t.count / trendMax) * 60);
			return `<div class="trend-bar-wrap" title="${t.date}: ${t.count} violations">
				<div class="trend-bar" style="height:${h}px"></div>
				<div class="trend-count">${t.count}</div>
				<div class="trend-date">${t.date.slice(5)}</div>
			</div>`;
		}).join('');

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GRC Compliance Report — ${esc(workspaceName)}</title>
<style>
	* { box-sizing: border-box; margin: 0; padding: 0; }
	body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; color: #1a1a2e; background: #f5f5f5; }

	.page { max-width: 1100px; margin: 0 auto; background: #fff; }

	/* Cover */
	.cover { background: linear-gradient(135deg, #0d1b2a 0%, #1b2a4a 60%, #0d2137 100%); color: #fff; padding: 60px 50px 40px; position: relative; overflow: hidden; }
	.cover::after { content:''; position:absolute; right:-80px; top:-80px; width:320px; height:320px; border-radius:50%; background:rgba(255,255,255,0.03); }
	.cover-logo { font-size:11px; letter-spacing:3px; color:rgba(255,255,255,0.5); text-transform:uppercase; margin-bottom:40px; }
	.cover-title { font-size: 32px; font-weight: 300; line-height: 1.2; margin-bottom: 8px; }
	.cover-subtitle { font-size: 16px; color: rgba(255,255,255,0.6); margin-bottom: 40px; }
	.cover-meta { display: flex; gap: 40px; }
	.cover-meta-item { display: flex; flex-direction: column; gap: 4px; }
	.cover-meta-label { font-size: 10px; color: rgba(255,255,255,0.4); text-transform: uppercase; letter-spacing: 1px; }
	.cover-meta-value { font-size: 14px; color: rgba(255,255,255,0.9); }
	.status-badge { display: inline-block; padding: 6px 16px; border-radius: 3px; font-size: 12px; font-weight: 700; letter-spacing: 1px; background: ${statusColor}22; color: ${statusColor}; border: 1px solid ${statusColor}44; margin-top: 20px; }

	/* Exec summary */
	.exec-bar { background: #0d1b2a; color: #fff; padding: 24px 50px; display: flex; gap: 0; }
	.exec-metric { flex: 1; border-right: 1px solid rgba(255,255,255,0.1); padding: 0 24px; }
	.exec-metric:first-child { padding-left: 0; }
	.exec-metric:last-child { border-right: none; }
	.exec-metric-value { font-size: 28px; font-weight: 300; line-height: 1; margin-bottom: 4px; }
	.exec-metric-label { font-size: 10px; color: rgba(255,255,255,0.5); text-transform: uppercase; letter-spacing: 1px; }
	.err-val { color: #ef5350; }
	.warn-val { color: #ffa726; }
	.pass-val { color: #66bb6a; }

	/* Sections */
	.section { padding: 36px 50px; border-bottom: 1px solid #e8e8e8; }
	.section-title { font-size: 11px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: #0d1b2a; border-left: 3px solid #0d1b2a; padding-left: 10px; margin-bottom: 24px; }

	/* Framework */
	.framework-section { background: #fafafa; }
	.framework-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; gap: 20px; }
	.framework-name { font-size: 16px; font-weight: 600; color: #0d1b2a; }
	.framework-name .version { font-size: 11px; font-weight: 400; color: #888; margin-left: 6px; }
	.framework-desc { font-size: 12px; color: #555; margin-top: 4px; max-width: 600px; line-height: 1.5; }
	.framework-authority { font-size: 11px; color: #888; margin-top: 4px; }
	.framework-stats { display: flex; gap: 20px; align-items: center; flex-shrink: 0; }
	.fw-meta { display: flex; flex-direction: column; gap: 8px; }
	.fw-stat { display: flex; flex-direction: column; }
	.fw-stat-label { font-size: 10px; color: #888; text-transform: uppercase; }
	.fw-stat-value { font-size: 14px; font-weight: 500; }
	.compliance-ring { width: 80px; height: 80px; position: relative; }
	.ring-inner { width: 80px; height: 80px; border-radius: 50%; background: conic-gradient(var(--color) calc(var(--pct) * 1%), #e0e0e0 0); display: flex; flex-direction: column; align-items: center; justify-content: center; }
	.ring-inner::before { content: ''; position: absolute; width: 60px; height: 60px; border-radius: 50%; background: #fafafa; }
	.ring-pct { font-size: 14px; font-weight: 700; color: #0d1b2a; z-index: 1; }
	.ring-label { font-size: 8px; color: #888; z-index: 1; letter-spacing: 0.5px; }
	.all-pass { color: #2e7d32; font-size: 13px; padding: 12px 0; font-weight: 500; }

	/* Tables */
	.violations-table { width: 100%; border-collapse: collapse; font-size: 12px; }
	.violations-table th { text-align: left; padding: 8px 12px; background: #f0f0f0; color: #555; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 2px solid #ddd; }
	.violations-table td { padding: 10px 12px; border-bottom: 1px solid #eee; vertical-align: top; }
	.violations-table tr:hover td { background: #f9f9f9; }

	.sev { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 2px; }
	.sev-error { color: #c62828; background: #ffebee; }
	.sev-warning { color: #e65100; background: #fff3e0; }
	.sev-info { color: #1565c0; background: #e3f2fd; }

	.rule-id { font-family: 'Consolas', 'Courier New', monospace; font-size: 11px; background: #f0f4ff; color: #0d47a1; padding: 2px 5px; border-radius: 3px; }
	.mono { font-family: 'Consolas', 'Courier New', monospace; }
	.small { font-size: 11px; }
	.num { color: #bbb; font-size: 11px; text-align: right; width: 28px; }

	.ai-note { font-size: 11px; color: #5c35b5; margin-top: 4px; font-style: italic; }
	.fix-note { font-size: 11px; color: #2e7d32; margin-top: 4px; }
	.code-snippet { font-size: 11px; background: #f5f5f5; border-left: 3px solid #ddd; padding: 6px 8px; margin-top: 4px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; color: #333; }

	/* Trend */
	.trend-chart { display: flex; gap: 8px; align-items: flex-end; height: 80px; padding: 0 0 24px; }
	.trend-bar-wrap { display: flex; flex-direction: column; align-items: center; gap: 3px; }
	.trend-bar { width: 24px; background: #0d1b2a; border-radius: 2px 2px 0 0; min-height: 3px; }
	.trend-count { font-size: 10px; color: #555; }
	.trend-date { font-size: 9px; color: #aaa; }

	/* Footer */
	.footer { background: #0d1b2a; color: rgba(255,255,255,0.4); padding: 20px 50px; font-size: 11px; display: flex; justify-content: space-between; }

	/* Print */
	@media print {
		body { background: #fff; }
		.page { max-width: 100%; }
		.section { break-inside: avoid; }
		.framework-section { break-before: page; }
	}
</style>
</head>
<body>
<div class="page">

<!-- Cover -->
<div class="cover">
	<div class="cover-logo">Neural Inverse · GRC Platform</div>
	<div class="cover-title">Compliance &amp; Audit Report</div>
	<div class="cover-subtitle">${esc(workspaceName)}</div>
	<div class="cover-meta">
		<div class="cover-meta-item"><div class="cover-meta-label">Generated</div><div class="cover-meta-value">${dateStr} ${timeStr}</div></div>
		<div class="cover-meta-item"><div class="cover-meta-label">Frameworks Active</div><div class="cover-meta-value">${activeFrameworks.length}</div></div>
		<div class="cover-meta-item"><div class="cover-meta-label">Rules Enabled</div><div class="cover-meta-value">${enabledRules.length} / ${rules.length}</div></div>
		<div class="cover-meta-item"><div class="cover-meta-label">Pass Rate</div><div class="cover-meta-value">${passRate}%</div></div>
	</div>
	<div><span class="status-badge">● ${overallStatus}</span></div>
</div>

<!-- Executive Metrics Bar -->
<div class="exec-bar">
	<div class="exec-metric"><div class="exec-metric-value err-val">${errorCount}</div><div class="exec-metric-label">Errors / Critical</div></div>
	<div class="exec-metric"><div class="exec-metric-value warn-val">${warningCount}</div><div class="exec-metric-label">Warnings</div></div>
	<div class="exec-metric"><div class="exec-metric-value">${infoCount}</div><div class="exec-metric-label">Informational</div></div>
	<div class="exec-metric"><div class="exec-metric-value" style="color:#ef5350">${blockingViolations.length}</div><div class="exec-metric-label">Blocking</div></div>
	<div class="exec-metric"><div class="exec-metric-value pass-val">${passRate}%</div><div class="exec-metric-label">Pass Rate</div></div>
	<div class="exec-metric"><div class="exec-metric-value">${allResults.length}</div><div class="exec-metric-label">Total Violations</div></div>
</div>

<!-- Domain Summary -->
<div class="section">
	<div class="section-title">Domain Summary</div>
	<table class="violations-table">
		<thead><tr><th>Domain</th><th>Errors</th><th>Warnings</th><th>Info</th><th>Total</th><th>Rules</th><th>Health</th></tr></thead>
		<tbody>${domainRows}</tbody>
	</table>
</div>

<!-- Framework Compliance -->
${loadedFrameworks.filter(fw => fw.validation.valid).length > 0 ? `
<div class="section">
	<div class="section-title">Framework Compliance</div>
</div>
${frameworkSections}` : ''}

<!-- Top Violations -->
${topViolations.length > 0 ? `
<div class="section">
	<div class="section-title">Top Violations (by severity)</div>
	<table class="violations-table">
		<thead><tr><th>#</th><th>Rule</th><th>Severity</th><th>Location</th><th>Details</th></tr></thead>
		<tbody>${topViolationRows}</tbody>
	</table>
</div>` : ''}

<!-- Historical Trend -->
${trend.length > 0 ? `
<div class="section">
	<div class="section-title">Historical Trend (Last 7 Days)</div>
	<div class="trend-chart">${trendBars}</div>
</div>` : ''}

<!-- Footer -->
<div class="footer">
	<span>Neural Inverse GRC Platform · Compliance Report</span>
	<span>${dateStr} ${timeStr} · ${esc(workspaceName)}</span>
</div>

</div>
</body>
</html>`;
	}

	async exportReport(): Promise<URI | undefined> {
		return this._writeFile(
			async () => await this.generateReport(),
			(date) => `compliance-${date}.html`,
			'[ComplianceReport] Exported HTML report to'
		);
	}

	async exportJson(): Promise<URI | undefined> {
		return this._writeFile(
			async () => {
				const allResults = this.grcEngine.getAllResults();
				const domainSummary = this.grcEngine.getDomainSummary();
				const blockingViolations = this.grcEngine.getBlockingViolations();
				const rules = this.grcEngine.getRules();
				const activeFrameworks = this.grcEngine.getActiveFrameworks();
				const loadedFrameworks = this.frameworkRegistry.getActiveFrameworks();
				const trend = await this._getHistoricalTrend();

				const enabledRules = rules.filter(r => r.enabled);
				const violatedRuleIds = new Set(allResults.map(r => r.ruleId));
				const passRate = enabledRules.length > 0
					? ((enabledRules.filter(r => !violatedRuleIds.has(r.id)).length / enabledRules.length) * 100).toFixed(1)
					: '100.0';

				const payload = {
					meta: {
						generatedAt: new Date().toISOString(),
						workspace: this._getWorkspaceName(),
						tool: 'Neural Inverse GRC Platform',
					},
					summary: {
						totalViolations: allResults.length,
						errors: allResults.filter(r => ['error', 'critical', 'blocker'].includes(r.severity)).length,
						warnings: allResults.filter(r => ['warning', 'major'].includes(r.severity)).length,
						info: allResults.filter(r => ['info', 'minor'].includes(r.severity)).length,
						blocking: blockingViolations.length,
						passRate,
						enabledRules: enabledRules.length,
						totalRules: rules.length,
						activeFrameworks: activeFrameworks.length,
					},
					frameworks: loadedFrameworks.filter(fw => fw.validation.valid).map(fw => {
						const meta = fw.definition.framework;
						const fwViolations = allResults.filter(r => r.frameworkId === meta.id);
						const fwRules = fw.rules.filter(r => r.enabled !== false);
						const fwViolatedIds = new Set(fwViolations.map(r => r.ruleId));
						return {
							id: meta.id,
							name: meta.name,
							version: meta.version,
							authority: meta.authority,
							totalRules: fwRules.length,
							violations: fwViolations.length,
							compliance: fwRules.length > 0
								? ((fwRules.filter(r => !fwViolatedIds.has(r.id)).length / fwRules.length) * 100).toFixed(1)
								: '100.0',
						};
					}),
					domainSummary,
					violations: allResults.map(v => ({
						ruleId: v.ruleId,
						domain: v.domain,
						severity: v.severity,
						message: v.message,
						file: v.fileUri.path,
						line: v.line,
						column: v.column,
						codeSnippet: v.codeSnippet,
						fix: v.fix,
						frameworkId: v.frameworkId,
						references: v.references,
						checkSource: v.checkSource,
						aiExplanation: v.aiExplanation,
						aiConfidence: v.aiConfidence,
						timestamp: v.timestamp,
					})),
					trend,
				};
				return JSON.stringify(payload, null, 2);
			},
			(date) => `compliance-${date}.json`,
			'[ComplianceReport] Exported JSON to'
		);
	}

	private async _writeFile(
		generate: () => Promise<string>,
		fileName: (date: string) => string,
		logPrefix: string
	): Promise<URI | undefined> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) return undefined;

		const rootUri = folders[0].uri;
		const reportsFolder = URI.joinPath(rootUri, '.inverse', 'reports');
		const inversePath = URI.joinPath(rootUri, '.inverse').fsPath;
		let resultUri: URI | undefined;

		try {
			const content = await generate();
			const dateStr = new Date().toISOString().split('T')[0];
			const fileUri = URI.joinPath(reportsFolder, fileName(dateStr));

			await withInverseWriteAccess(inversePath, async () => {
				try {
					if (!(await this.fileService.exists(reportsFolder))) {
						await this.fileService.createFolder(reportsFolder);
					}
				} catch { /* May already exist */ }
				await this.fileService.writeFile(fileUri, VSBuffer.fromString(content));
			});

			console.log(logPrefix, fileUri.path);
			resultUri = fileUri;
		} catch (e) {
			console.error('[ComplianceReport] Export failed:', e);
		}

		return resultUri;
	}

	private _getWorkspaceName(): string {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].name : 'Unknown Workspace';
	}

	private async _getHistoricalTrend(): Promise<Array<{ date: string; count: number }>> {
		const trend: Array<{ date: string; count: number }> = [];
		const availableDates = await this.auditTrail.getAvailableDates();
		for (const date of availableDates.slice(0, 7)) {
			const entries = await this.auditTrail.getEntries(date);
			trend.push({ date, count: entries.length });
		}
		return trend;
	}

	private _truncate(text: string, maxLen: number): string {
		return text.length <= maxLen ? text : text.substring(0, maxLen - 3) + '...';
	}
}

function esc(str: string): string {
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

registerSingleton(IComplianceReportService, ComplianceReportService, InstantiationType.Delayed);
