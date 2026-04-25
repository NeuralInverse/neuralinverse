/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Modernisation Mode UI \u2014 HTML/CSS for the two-window analysis panel.
 *
 * Layout:
 *   \u250C\u2500 Top Bar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510
 *   \u251C\u2500 Split Editor \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
 *   \u2502  LEGACY  (COBOL / read-side)      \u2502  MODERN  (target / draft)   \u2502
 *   \u2502                                   \u2502                             \u2502
 *   \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
 *   \u2514\u2500 Compliance Strip \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500  \u2518
 */

export const SAMPLE_COBOL = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALC-LATE-FEE.
      *----------------------------------------------------------------
      * Calculates late payment fee on overdue account balance.
      * Late fee = 1.5% of WS-OVERDUE-BAL if WS-DAYS-OVERDUE > 30.
      * Result stored in WS-LATE-FEE-AMT (COMP-3 packed decimal).
      *----------------------------------------------------------------
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-ACCT-BAL          PIC S9(11)V99 COMP-3.
       01  WS-OVERDUE-BAL       PIC S9(11)V99 COMP-3.
       01  WS-LATE-FEE-AMT      PIC S9(9)V99  COMP-3.
       01  WS-DAYS-OVERDUE      PIC 9(4)       COMP.
       01  WS-LATE-FEE-RATE     PIC V999       COMP-3 VALUE .015.

       PROCEDURE DIVISION.
       CALC-LATE-FEE.
           IF WS-DAYS-OVERDUE > 30
               COMPUTE WS-LATE-FEE-AMT =
                   WS-OVERDUE-BAL * WS-LATE-FEE-RATE
               MOVE WS-LATE-FEE-AMT TO WS-AUDIT-FEE-AMT
           ELSE
               MOVE ZEROS TO WS-LATE-FEE-AMT
           END-IF
           STOP RUN.`;

export const SAMPLE_MODERN = `/**
 * Calculates late payment fee on overdue account balance.
 * Late fee = 1.5% of overdueBalance if daysOverdue > 30.
 */
export function calculateLateFee(
    accountBalance: number,
    overdueBalance: number,
    daysOverdue: number
): number {
    const LATE_FEE_RATE = 0.015;
    const LATE_FEE_THRESHOLD_DAYS = 30;

    if (daysOverdue > LATE_FEE_THRESHOLD_DAYS) {
        // TODO: verify rounding matches COMP-3 packed decimal behaviour
        return Math.round(overdueBalance * LATE_FEE_RATE * 100) / 100;
    }

    return 0;
}`;

export function getModernisationHTML(nonce: string): string {
	return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
* { margin:0; padding:0; box-sizing:border-box; }

body {
	font-family: 'Cascadia Code','Fira Code','JetBrains Mono','SF Mono',Menlo,Monaco,'Courier New',monospace;
	background: #111820;
	color: #c8d3e0;
	height: 100vh;
	overflow: hidden;
	font-size: 13px;
	line-height: 1.5;
	-webkit-font-smoothing: antialiased;
}

::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: #111820; }
::-webkit-scrollbar-thumb { background: #2a3a4e; border-radius: 3px; }

.shell {
	display: flex;
	flex-direction: column;
	height: 100vh;
}

/* \u2500\u2500 Top Bar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.topbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	height: 36px;
	min-height: 36px;
	padding: 0 14px;
	background: #0d1520;
	border-bottom: 1px solid #1e2d3e;
}

.topbar-left {
	display: flex;
	align-items: center;
	gap: 10px;
}

.brand {
	color: #4fc3f7;
	font-weight: bold;
	font-size: 12px;
	letter-spacing: 0.05em;
	text-transform: uppercase;
}

.stage-badge {
	background: #1a2a3a;
	color: #5eaed6;
	border: 1px solid #2a3d52;
	border-radius: 3px;
	padding: 1px 7px;
	font-size: 11px;
}

.topbar-right {
	display: flex;
	align-items: center;
	gap: 8px;
}

.unit-input {
	background: #1a2332;
	border: 1px solid #2a3545;
	border-radius: 4px;
	color: #c8d3e0;
	font-family: inherit;
	font-size: 12px;
	padding: 3px 8px;
	width: 180px;
	outline: none;
}

.unit-input:focus { border-color: #4fc3f7; }
.unit-input::placeholder { color: #3a4e62; }

.btn {
	border: none;
	border-radius: 4px;
	cursor: pointer;
	font-family: inherit;
	font-size: 12px;
	padding: 4px 12px;
	transition: opacity 0.15s;
}
.btn:hover { opacity: 0.85; }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }

.btn-analyse {
	background: #1e5f8a;
	color: #e8f4fd;
	font-weight: bold;
}

.btn-clear {
	background: #1a2332;
	border: 1px solid #2a3545;
	color: #7a8a9e;
}

/* \u2500\u2500 Split Editor \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.editors {
	display: flex;
	flex: 1;
	min-height: 0;
	border-bottom: 2px solid #1e2d3e;
}

.pane {
	display: flex;
	flex-direction: column;
	flex: 1;
	min-width: 0;
	overflow: hidden;
}

.pane + .pane {
	border-left: 1px solid #1e2d3e;
}

.pane-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	height: 28px;
	min-height: 28px;
	padding: 0 12px;
	background: #0d1520;
	border-bottom: 1px solid #1e2d3e;
}

.pane-title {
	font-size: 11px;
	font-weight: bold;
	letter-spacing: 0.06em;
	text-transform: uppercase;
}

.pane-legacy .pane-title { color: #e0a84e; }
.pane-modern .pane-title { color: #56c2a0; }

.pane-lang {
	font-size: 10px;
	color: #3a4e62;
}

.pane-editor {
	flex: 1;
	resize: none;
	background: #111820;
	color: #c8d3e0;
	border: none;
	outline: none;
	padding: 12px;
	font-family: inherit;
	font-size: 13px;
	line-height: 1.55;
	tab-size: 4;
	overflow-y: auto;
}

.pane-editor.legacy { background: #0f1a24; color: #d4c5a0; }
.pane-editor.modern { background: #111820; }

.pane-editor::placeholder { color: #2a3a4e; }

/* Modern pane draft banner */
.draft-banner {
	display: none;
	align-items: center;
	justify-content: center;
	gap: 8px;
	height: 24px;
	background: #1a1200;
	border-top: 1px solid #2a2000;
	font-size: 11px;
	color: #e0a84e;
}
.draft-banner.visible { display: flex; }

/* \u2500\u2500 Compliance Strip \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.compliance-strip {
	min-height: 120px;
	max-height: 200px;
	background: #0d1520;
	border-top: 2px solid #1e2d3e;
	overflow-y: auto;
	display: flex;
	flex-direction: column;
}

.strip-header {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 8px 14px;
	background: #0a1018;
	border-bottom: 1px solid #1a2332;
	flex-shrink: 0;
}

.strip-label {
	font-size: 11px;
	font-weight: bold;
	letter-spacing: 0.06em;
	text-transform: uppercase;
	color: #4a6278;
}

.match-pct {
	font-size: 20px;
	font-weight: bold;
	min-width: 52px;
}

.match-pass  { color: #56c2a0; }
.match-warn  { color: #e0a84e; }
.match-block { color: #e05a5a; }

.result-badge {
	border-radius: 3px;
	padding: 2px 8px;
	font-size: 11px;
	font-weight: bold;
	letter-spacing: 0.05em;
	text-transform: uppercase;
}

.badge-pass  { background: #0d2e20; color: #56c2a0; border: 1px solid #1a5a3a; }
.badge-warn  { background: #2a1e00; color: #e0a84e; border: 1px solid #5a4000; }
.badge-block { background: #2e0d0d; color: #e05a5a; border: 1px solid #5a1a1a; }
.badge-idle  { background: #1a2332; color: #3a4e62; border: 1px solid #2a3545; }

.strip-hint {
	font-size: 11px;
	color: #3a4e62;
	flex: 1;
}

.strip-body {
	padding: 6px 14px 10px;
	flex: 1;
	overflow-y: auto;
}

.divergence-list {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.divergence-item {
	display: flex;
	align-items: flex-start;
	gap: 8px;
	font-size: 12px;
	padding: 4px 8px;
	border-radius: 3px;
	background: #0f1820;
}

.div-icon {
	flex-shrink: 0;
	font-size: 13px;
	margin-top: 1px;
}

.div-blocking { border-left: 2px solid #e05a5a; }
.div-warning  { border-left: 2px solid #e0a84e; }
.div-info     { border-left: 2px solid #4a6278; }

.div-text { color: #9aacbe; line-height: 1.4; }

.idle-state {
	display: flex;
	align-items: center;
	justify-content: center;
	height: 60px;
	color: #2a3a4e;
	font-size: 12px;
	letter-spacing: 0.05em;
}

.analysing-state {
	display: flex;
	align-items: center;
	justify-content: center;
	height: 60px;
	gap: 8px;
	color: #4fc3f7;
	font-size: 12px;
}

@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
.pulse { animation: pulse 1.2s ease-in-out infinite; }

</style>
</head>
<body>
<div class="shell">

  <!-- Top Bar -->
  <div class="topbar">
    <div class="topbar-left">
      <span class="brand">NeuralInverse Modernisation</span>
      <span class="stage-badge">Stage 3 · Migration</span>
    </div>
    <div class="topbar-right">
      <input class="unit-input" id="unitName" placeholder="Unit name (e.g. CALC-LATE-FEE)" value="CALC-LATE-FEE" />
      <select class="unit-input" id="sourceLanguage" style="width:90px">
        <option value="cobol">COBOL</option>
        <option value="java">Java</option>
        <option value="plsql">PL/SQL</option>
      </select>
      <button class="btn btn-analyse" id="btnAnalyse">Run Analysis</button>
      <button class="btn btn-clear" id="btnClear">Clear</button>
    </div>
  </div>

  <!-- Split Editor -->
  <div class="editors">

    <!-- Legacy Pane -->
    <div class="pane pane-legacy">
      <div class="pane-header">
        <span class="pane-title">Legacy</span>
        <span class="pane-lang" id="legacyLang">COBOL · Read-only source of truth</span>
      </div>
      <textarea class="pane-editor legacy" id="legacyEditor" spellcheck="false"
        placeholder="Paste legacy COBOL source here\u2026"></textarea>
    </div>

    <!-- Modern Pane -->
    <div class="pane pane-modern">
      <div class="pane-header">
        <span class="pane-title">Modern</span>
        <span class="pane-lang">TypeScript · Draft buffer</span>
      </div>
      <textarea class="pane-editor modern" id="modernEditor" spellcheck="false"
        placeholder="Paste or write modern translation here\u2026"></textarea>
      <div class="draft-banner" id="draftBanner">
        PENDING APPROVAL \u2014 awaiting compliance analysis
      </div>
    </div>

  </div>

  <!-- Compliance Strip -->
  <div class="compliance-strip">
    <div class="strip-header">
      <span class="strip-label">Compliance Fingerprint</span>
      <span class="match-pct badge-idle" id="matchPct">\u2014</span>
      <span class="result-badge badge-idle" id="resultBadge">AWAITING ANALYSIS</span>
      <span class="strip-hint" id="stripHint">Paste code in both panes and click Run Analysis</span>
    </div>
    <div class="strip-body" id="stripBody">
      <div class="idle-state" id="idleState">
        No analysis run yet · Enter legacy and modern code above then click Run Analysis
      </div>
      <div class="analysing-state" id="analysingState" style="display:none">
        <span class="pulse">\u25B6</span>
        <span id="analysingMsg">Extracting compliance fingerprint\u2026</span>
      </div>
      <div class="divergence-list" id="divergenceList" style="display:none"></div>
    </div>
  </div>

</div>
<script nonce="${nonce}">
(function() {
	const vscode = window.acquireVsCodeApi ? window.acquireVsCodeApi() : null;

	// Pre-fill with samples
	const legacyEditor = document.getElementById('legacyEditor');
	const modernEditor = document.getElementById('modernEditor');
	legacyEditor.value = window.__SAMPLE_COBOL__ || '';
	modernEditor.value = window.__SAMPLE_MODERN__ || '';

	document.getElementById('btnAnalyse').addEventListener('click', () => {
		const legacyCode = legacyEditor.value.trim();
		const modernCode = modernEditor.value.trim();
		const unitName   = document.getElementById('unitName').value.trim() || 'UNKNOWN-UNIT';
		const sourceLang = document.getElementById('sourceLanguage').value;

		if (!legacyCode || !modernCode) {
			setStripMessage('Paste code into both panes first.', 'warn');
			return;
		}

		setAnalysing(true, 'Extracting compliance fingerprint\u2026');
		document.getElementById('draftBanner').classList.add('visible');

		if (vscode) {
			vscode.postMessage({ type: 'analyse', legacyCode, modernCode, unitName, sourceLang });
		}
	});

	document.getElementById('btnClear').addEventListener('click', () => {
		legacyEditor.value = '';
		modernEditor.value = '';
		resetStrip();
		document.getElementById('draftBanner').classList.remove('visible');
	});

	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (!msg) return;

		if (msg.type === 'analysing') {
			setAnalysing(true, msg.message || 'Analysing\u2026');
		} else if (msg.type === 'result') {
			setAnalysing(false);
			renderResult(msg.comparison);
		} else if (msg.type === 'error') {
			setAnalysing(false);
			setStripMessage('Analysis error: ' + msg.message, 'block');
		}
	});

	function setAnalysing(active, message) {
		document.getElementById('idleState').style.display    = active ? 'none' : 'flex';
		document.getElementById('analysingState').style.display = active ? 'flex' : 'none';
		document.getElementById('divergenceList').style.display = 'none';
		if (message) document.getElementById('analysingMsg').textContent = message;
	}

	function resetStrip() {
		document.getElementById('matchPct').textContent = '\u2014';
		document.getElementById('matchPct').className = 'match-pct badge-idle';
		document.getElementById('resultBadge').textContent = 'AWAITING ANALYSIS';
		document.getElementById('resultBadge').className = 'result-badge badge-idle';
		document.getElementById('stripHint').textContent = 'Paste code in both panes and click Run Analysis';
		document.getElementById('idleState').style.display = 'flex';
		document.getElementById('analysingState').style.display = 'none';
		document.getElementById('divergenceList').style.display = 'none';
		document.getElementById('divergenceList').innerHTML = '';
	}

	function setStripMessage(msg, level) {
		document.getElementById('idleState').style.display = 'none';
		document.getElementById('analysingState').style.display = 'none';
		const dl = document.getElementById('divergenceList');
		dl.style.display = 'flex';
		dl.innerHTML = '<div class="divergence-item div-' + level + '">' +
			'<span class="div-icon">' + (level === 'block' ? '\u26D4' : '\u26A0') + '</span>' +
			'<span class="div-text">' + escapeHtml(msg) + '</span>' +
			'</div>';
	}

	function renderResult(comparison) {
		if (!comparison) { setStripMessage('No result returned.', 'warn'); return; }

		const pct = comparison.matchPercentage;
		const result = comparison.overallResult;

		const pctEl = document.getElementById('matchPct');
		pctEl.textContent = pct + '%';
		pctEl.className = 'match-pct ' +
			(result === 'pass' ? 'match-pass' : result === 'warning' ? 'match-warn' : 'match-block');

		const badgeEl = document.getElementById('resultBadge');
		badgeEl.textContent = result.toUpperCase();
		badgeEl.className = 'result-badge ' +
			(result === 'pass' ? 'badge-pass' : result === 'warning' ? 'badge-warn' : 'badge-block');

		const totalDivs = (comparison.divergences || []).length;
		const blockCount = (comparison.divergences || []).filter(d => d.severity === 'blocking').length;
		document.getElementById('stripHint').textContent =
			totalDivs === 0
				? 'No compliance divergences detected'
				: blockCount + ' blocking, ' + (totalDivs - blockCount) + ' warnings';

		document.getElementById('idleState').style.display = 'none';
		document.getElementById('analysingState').style.display = 'none';

		const dl = document.getElementById('divergenceList');
		dl.style.display = 'flex';
		dl.innerHTML = '';

		if (totalDivs === 0) {
			dl.innerHTML = '<div class="divergence-item div-info">' +
				'<span class="div-icon">\u2713</span>' +
				'<span class="div-text" style="color:#56c2a0">Compliance fingerprint matches. All regulated fields, semantic rules, and domains are preserved.</span>' +
				'</div>';
			return;
		}

		for (const div of (comparison.divergences || [])) {
			const cls = div.severity === 'blocking' ? 'div-blocking' : div.severity === 'warning' ? 'div-warning' : 'div-info';
			const icon = div.severity === 'blocking' ? '\u26D4' : div.severity === 'warning' ? '\u26A0' : '\u2139';
			const el = document.createElement('div');
			el.className = 'divergence-item ' + cls;
			el.innerHTML =
				'<span class="div-icon">' + icon + '</span>' +
				'<span class="div-text">' +
					'<strong style="color:#c8d3e0">[' + escapeHtml(div.type) + ']</strong> ' +
					escapeHtml(div.description) +
				'</span>';
			dl.appendChild(el);
		}
	}

	function escapeHtml(str) {
		if (!str) return '';
		return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
	}
})();
</script>
</body>
</html>`;
}
