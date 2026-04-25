/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GRCDomain, IGRCRule, ICheckResult, IDomainSummary } from '../types/grcTypes.js';

function esc(t: string): string {
    return t ? t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '';
}

/**
 * Theme accent colors per domain
 */
const DOMAIN_THEME: Record<GRCDomain, { accent: string; accentBg: string; label: string }> = {
    'security': { accent: '#ff5252', accentBg: '#1a1a2e', label: 'SECURITY AS CODE' },
    'compliance': { accent: '#7c4dff', accentBg: '#1a1a2e', label: 'COMPLIANCE AS CODE' },
    'data-integrity': { accent: '#00bcd4', accentBg: '#1a2a1a', label: 'DATA INTEGRITY CHECKS' },
    'fail-safe': { accent: '#ff9800', accentBg: '#1a1a1a', label: 'FAIL-SAFE DEFAULTS' },
    'architecture': { accent: '#42a5f5', accentBg: '#1a1a2e', label: 'ARCHITECTURE AS CODE' },
    'policy': { accent: '#66bb6a', accentBg: '#1a1a2e', label: 'CODE AS POLICY' },
    'formal-verification': { accent: '#e040fb', accentBg: '#1a1a2e', label: 'FORMAL VERIFICATION' },
};

export interface CheckViewOptions {
    domain: GRCDomain;
    results: ICheckResult[];
    rules: IGRCRule[];
    activeFrameworks?: { id: string; name: string; version: string }[];
}

/**
 * Generates the complete interactive HTML for a check view.
 * Includes:
 * - Dashboard with live stats and framework summary
 * - Issues list with references and framework attribution
 * - Interactive Rules management
 */
/**
 * Generates the complete interactive HTML for a check view.
 * PRODUCTION-GRADE MINIMAL UI DESIGN (Monochrome, Data-Dense, VS Code Native)
 */
export function buildCheckViewHtml(opts: CheckViewOptions): string {
    const { domain, results, rules } = opts;
    const theme = DOMAIN_THEME[domain];

    const errors = results.filter(r => r.severity === 'error');
    const enabledRules = rules.filter(r => r.enabled);
    const warnings = results.filter(r => r.severity === 'warning');


    const totalViolations = results.length;
    const totalRules = rules.length;
    const passRate = totalRules > 0 ? Math.round(((totalRules - totalViolations) / totalRules) * 100) : 100;

    // \u2500\u2500\u2500 Header Stats \u2500\u2500\u2500
    const passColor = passRate >= 80 ? '#73c991' : passRate >= 50 ? '#cca700' : 'var(--vscode-errorForeground)';
    const progressBar = `
        <div class="progress-bar">
            <div class="progress-fill" style="width:${passRate}%; background:${passColor}"></div>
        </div>`;

    // \u2500\u2500\u2500 Issues Table \u2500\u2500\u2500
    const issueRows = results.map(r => {
        const filePath = r.fileUri.path.split('/').pop() || r.fileUri.path;
        return `<tr>
            <td class="mono">${esc(r.ruleId)}</td>
            <td>${esc(r.message)}</td>
            <td class="mono" title="${esc(r.fileUri.path)}">${esc(filePath)}:${r.line}</td>
            <td><span class="sev sev-${r.severity}">${r.severity.toUpperCase()}</span></td>
        </tr>`;
    }).join('');

    // \u2500\u2500\u2500 Rules Table \u2500\u2500\u2500
    const ruleRows = rules.map(r => {
        const violationCount = results.filter(res => res.ruleId === r.id).length;
        const status = r.enabled ? (violationCount > 0 ? 'fail' : 'pass') : 'disabled';
        const statusLabel = r.enabled ? (violationCount > 0 ? 'FAIL' : 'PASS') : 'OFF';
        const statusClass = status === 'fail' ? 'sev-error' : status === 'pass' ? 'sev-pass' : 'sev-muted';

        const checked = r.enabled ? 'checked' : '';
        const toggle = `<label class="toggle"><input type="checkbox" ${checked} onchange="toggleRule('${esc(r.id)}', this.checked)"><span class="slider"></span></label>`;

        return `<tr>
            <td style="width:40px">${toggle}</td>
            <td class="mono">${esc(r.id)}</td>
            <td>${esc(r.message)}</td>
            <td><span class="sev ${statusClass}">${statusLabel}</span></td>
            <td class="action-cell"><button class="icon-btn" onclick="delRule('${esc(r.id)}')" title="Delete Rule">\u2715</button></td>
        </tr>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
    :root {
        --fg: var(--vscode-foreground);
        --fg-muted: var(--vscode-descriptionForeground);
        --bg: var(--vscode-editor-background);
        --border: var(--vscode-widget-border);
        --input-bg: var(--vscode-input-background);
        --input-fg: var(--vscode-input-foreground);
        --error-fg: var(--vscode-errorForeground);
        --warn-fg: var(--vscode-editorWarning-foreground);
        --accent: ${theme.accent};
    }
    body { font-family: var(--vscode-font-family, sans-serif); font-size: 13px; color: var(--fg); background: var(--bg); margin: 0; padding: 20px; }
    * { box-sizing: border-box; }

    /* Typography & Layout */
    .header { margin-bottom: 24px; }
    .header h1 { font-size: 18px; font-weight: 500; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 1px; display: flex; align-items: center; gap: 12px; }
    .header .domain-badge { background: var(--accent); color: #fff; font-size: 10px; padding: 2px 6px; border-radius: 2px; font-weight: 700; }

    /* Metrics */
    .metrics { display: flex; gap: 24px; margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
    .metric { display: flex; flex-direction: column; gap: 4px; }
    .metric-label { font-size: 11px; color: var(--fg-muted); text-transform: uppercase; font-weight: 600; }
    .metric-value { font-size: 24px; font-weight: 300; font-variant-numeric: tabular-nums; }
    .metric-value.err { color: var(--error-fg); }
    .metric-value.warn { color: var(--warn-fg); }

    /* Tabs */
    .tabs { display: flex; gap: 20px; border-bottom: 1px solid var(--border); margin-bottom: 20px; }
    .tab { padding: 8px 0; cursor: pointer; color: var(--fg-muted); border-bottom: 2px solid transparent; font-size: 13px; font-weight: 500; }
    .tab:hover { color: var(--fg); }
    .tab.active { color: var(--fg); border-bottom-color: var(--accent); }

    /* Views */
    .view { display: none; }
    .view.active { display: block; }

    /* Tables */
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); color: var(--fg-muted); font-weight: 600; font-size: 11px; text-transform: uppercase; }
    td { padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    tr:hover td { background: var(--vscode-list-hoverBackground); }
    .mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }

    /* Status Badges */
    .sev { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 2px; }
    .sev-error { color: var(--error-fg); background: rgba(255,82,82,0.1); }
    .sev-warning { color: var(--warn-fg); background: rgba(255,200,0,0.1); }
    .sev-info { color: #64b5f6; background: rgba(33,150,243,0.1); }
    .sev-pass { color: #73c991; background: rgba(115,201,145,0.1); }
    .sev-muted { color: var(--fg-muted); }

    /* Toggles */
    .toggle { position: relative; width: 28px; height: 16px; display: inline-block; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background: var(--border); transition: .3s; border-radius: 16px; }
    .slider:before { position: absolute; content: ""; height: 12px; width: 12px; left: 2px; bottom: 2px; background: white; transition: .3s; border-radius: 50%; }
    input:checked + .slider { background: var(--accent); }
    input:checked + .slider:before { transform: translateX(12px); }

    /* Buttons */
    .icon-btn { background: none; border: none; color: var(--fg-muted); cursor: pointer; padding: 4px; border-radius: 3px; }
    .icon-btn:hover { background: var(--vscode-list-hoverBackground); color: var(--error-fg); }

    .empty-state { padding: 40px; text-align: center; color: var(--fg-muted); font-style: italic; }
</style>
</head>
<body>
    <div class="header">
        <h1>
            <span class="domain-badge">${theme.label}</span>
            <span style="flex:1"></span>
            <span style="font-size:12px; color:var(--fg-muted); font-weight:400">Compliance ${passRate}%</span>
        </h1>
        ${progressBar}
    </div>

    <div class="metrics">
        <div class="metric"><div class="metric-label">Errors</div><div class="metric-value ${errors.length > 0 ? 'err' : ''}">${errors.length}</div></div>
        <div class="metric"><div class="metric-label">Warnings</div><div class="metric-value ${warnings.length > 0 ? 'warn' : ''}">${warnings.length}</div></div>
        <div class="metric"><div class="metric-label">Rules</div><div class="metric-value">${enabledRules.length}/${totalRules}</div></div>
    </div>

    <div class="tabs">
        <div class="tab active" onclick="show('issues', this)">Violations (${totalViolations})</div>
        <div class="tab" onclick="show('rules', this)">Rules Configuration</div>
    </div>

    <div id="issues" class="view active">
        ${results.length > 0 ?
            `<table>
            <thead><tr><th>Rule</th><th>Message</th><th>File</th><th>Severity</th></tr></thead>
            <tbody>${issueRows}</tbody>
        </table>` :
            `<div class="empty-state">No violations detected. All systems nominal.</div>`}
    </div>

    <div id="rules" class="view">
        ${rules.length > 0 ?
            `<table>
            <thead><tr><th>State</th><th>ID</th><th>Description</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>${ruleRows}</tbody>
        </table>` :
            `<div class="empty-state">No rules defined for this domain.</div>`}
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        function show(id, tab) {
            document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
            document.getElementById(id).classList.add('active');
            document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
            tab.classList.add('active');
        }
        function toggleRule(id, enabled) {
            vscode.postMessage({ command: 'toggleRule', ruleId: id, enabled: enabled });
        }
        function delRule(id) {
            if(confirm('Delete rule ' + id + '?')) {
                vscode.postMessage({ command: 'deleteRule', ruleId: id });
            }
        }
    </script>
</body>
</html>`;
}

/**
 * Generates HTML for the Audit & Evidence view (special case - reads from audit trail).
 */
/**
 * Generates HTML for the Audit & Evidence view (special case - reads from audit trail).
 */
export function buildAuditViewHtml(
    entries: { timestamp: number; domain: string; severity: string; message: string; file: string; line: number }[],
    dates: string[],
    summary: IDomainSummary[]
): string {
    const totalErrors = summary.reduce((a, s) => a + s.errorCount, 0);
    const totalWarnings = summary.reduce((a, s) => a + s.warningCount, 0);
    const totalInfos = summary.reduce((a, s) => a + s.infoCount, 0);

    const recentEntries = entries.slice(-50).reverse();

    const entryRows = recentEntries.map(e => {
        const time = new Date(e.timestamp).toLocaleTimeString();
        const filePath = e.file.split('/').pop() || e.file;
        return `<tr>
            <td class="mono">${time}</td>
            <td><span class="sev sev-${e.severity}">${e.severity.toUpperCase()}</span></td>
            <td><span class="domain-tag">${esc(e.domain)}</span></td>
            <td>${esc(e.message)}</td>
            <td class="mono">${esc(filePath)}:${e.line}</td>
        </tr>`;
    }).join('');

    const summaryRows = summary.map(s => {
        const total = s.errorCount + s.warningCount + s.infoCount;
        return `<tr>
            <td><strong>${esc(s.domain)}</strong></td>
            <td>${s.errorCount}</td>
            <td>${s.warningCount}</td>
            <td>${s.infoCount}</td>
            <td>${total}</td>
            <td class="mono">${s.enabledRules}/${s.totalRules}</td>
        </tr>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
    :root {
        --fg: var(--vscode-foreground);
        --fg-muted: var(--vscode-descriptionForeground);
        --bg: var(--vscode-editor-background);
        --border: var(--vscode-widget-border);
        --accent: #ab47bc; /* Audit Purple */
        --error-fg: var(--vscode-errorForeground);
        --warn-fg: var(--vscode-editorWarning-foreground);
    }
    body { font-family: var(--vscode-font-family, sans-serif); font-size: 13px; color: var(--fg); background: var(--bg); margin: 0; padding: 20px; }
    * { box-sizing: border-box; }

    .header { margin-bottom: 24px; }
    .header h1 { font-size: 18px; font-weight: 500; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 1px; display: flex; align-items: center; gap: 12px; }
    .header .badge { background: var(--accent); color: #fff; font-size: 10px; padding: 2px 6px; border-radius: 2px; font-weight: 700; }

    .metrics { display: flex; gap: 24px; margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
    .metric { display: flex; flex-direction: column; gap: 4px; }
    .metric-label { font-size: 11px; color: var(--fg-muted); text-transform: uppercase; font-weight: 600; }
    .metric-value { font-size: 24px; font-weight: 300; font-variant-numeric: tabular-nums; }
    .metric-value.err { color: var(--error-fg); }
    .metric-value.warn { color: var(--warn-fg); }

    .tabs { display: flex; gap: 20px; border-bottom: 1px solid var(--border); margin-bottom: 20px; }
    .tab { padding: 8px 0; cursor: pointer; color: var(--fg-muted); border-bottom: 2px solid transparent; font-size: 13px; font-weight: 500; }
    .tab:hover { color: var(--fg); }
    .tab.active { color: var(--fg); border-bottom-color: var(--accent); }

    .view { display: none; }
    .view.active { display: block; }

    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); color: var(--fg-muted); font-weight: 600; font-size: 11px; text-transform: uppercase; }
    td { padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    tr:hover td { background: var(--vscode-list-hoverBackground); }
    .mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }

    .sev { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 2px; }
    .sev-error { color: var(--error-fg); background: rgba(255,82,82,0.1); }
    .sev-warning { color: var(--warn-fg); background: rgba(255,200,0,0.1); }
    .sev-info { color: #64b5f6; background: rgba(33,150,243,0.1); }

    .domain-tag { font-size: 10px; text-transform: uppercase; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 2px 6px; border-radius: 10px; }

    .empty-state { padding: 40px; text-align: center; color: var(--fg-muted); font-style: italic; }
</style>
</head>
<body>
    <div class="header">
        <h1>
            <span class="badge">AUDIT & EVIDENCE</span>
            <span style="font-size:12px; color:var(--fg-muted); font-weight:400; margin-left: auto;">${entries.length} Entries Logged</span>
        </h1>
    </div>

    <div class="metrics">
        <div class="metric"><div class="metric-label">Errors</div><div class="metric-value ${totalErrors > 0 ? 'err' : ''}">${totalErrors}</div></div>
        <div class="metric"><div class="metric-label">Warnings</div><div class="metric-value ${totalWarnings > 0 ? 'warn' : ''}">${totalWarnings}</div></div>
        <div class="metric"><div class="metric-label">Info</div><div class="metric-value">${totalInfos}</div></div>
    </div>

    <div style="margin-bottom: 16px; display:flex; gap:8px; align-items:center;">
        <button id="exportReportBtn" style="background:var(--accent);color:#fff;border:none;padding:6px 14px;cursor:pointer;font-size:12px;border-radius:2px;">\u2B07 Export HTML Report</button>
        <button id="exportJsonBtn" style="background:transparent;color:var(--accent);border:1px solid var(--accent);padding:6px 14px;cursor:pointer;font-size:12px;border-radius:2px;">\u2B07 Export JSON</button>
        <span id="exportStatus" style="margin-left:4px;font-size:12px;color:var(--fg-muted);"></span>
    </div>

    <div class="tabs">
        <div class="tab active" onclick="show('overview', this)">Overview</div>
        <div class="tab" onclick="show('timeline', this)">Timeline</div>
        <div class="tab" onclick="show('dates', this)">Archives</div>
    </div>

    <div id="overview" class="view active">
        <h3>Domain Summary</h3>
        <table>
            <thead><tr><th>Domain</th><th>Errors</th><th>Warns</th><th>Info</th><th>Total</th><th>Rules Enabled</th></tr></thead>
            <tbody>${summaryRows}</tbody>
        </table>
    </div>

    <div id="timeline" class="view">
        ${entryRows ?
            `<table>
            <thead><tr><th>Time</th><th>Sev</th><th>Domain</th><th>Message</th><th>File</th></tr></thead>
            <tbody>${entryRows}</tbody>
        </table>` :
            `<div class="empty-state">No audit entries found.</div>`}
    </div>

    <div id="dates" class="view">
        ${dates.length > 0 ?
            `<table><thead><tr><th>Date</th><th>File Path</th></tr></thead><tbody>
        ${dates.map(d => `<tr><td class="mono">${esc(d)}</td><td class="mono">.inverse/audit/${esc(d)}.json</td></tr>`).join('')}
        </tbody></table>` :
            `<div class="empty-state">No archived audit logs found.</div>`}
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function show(id, tab) {
            document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
            document.getElementById(id).classList.add('active');
            document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
            tab.classList.add('active');
        }

        document.getElementById('exportReportBtn').addEventListener('click', () => {
            document.getElementById('exportStatus').textContent = 'Generating HTML report...';
            vscode.postMessage({ type: 'exportReport' });
        });

        document.getElementById('exportJsonBtn').addEventListener('click', () => {
            document.getElementById('exportStatus').textContent = 'Generating JSON export...';
            vscode.postMessage({ type: 'exportJson' });
        });

        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.type === 'exportResult') {
                const label = msg.kind === 'json' ? 'JSON' : 'HTML report';
                document.getElementById('exportStatus').textContent = msg.success
                    ? (label + ' exported to .inverse/reports/')
                    : 'Export failed';
                setTimeout(() => { document.getElementById('exportStatus').textContent = ''; }, 6000);
            }
        });
    </script>
</body>
</html>`;
}
