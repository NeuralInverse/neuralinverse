/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

/**
 * Full CC-style webview UI for Power Mode.
 * Replaces the xterm terminal host — all features at parity.
 */
export function getPowerModeHTML(nonce: string): string {
	return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Power Mode</title>
<style nonce="${nonce}">
:root {
  --bg:      #0d1117;
  --bg2:     #161b22;
  --bg3:     #1c2128;
  --fg:      #c9d1d9;
  --fg2:     #8b949e;
  --fg3:     #6e7681;
  --fg4:     #484f58;
  --border:  #30363d;
  --border2: #21262d;
  --cyan:    #79c0ff;
  --green:   #3fb950;
  --red:     #f85149;
  --yellow:  #e3b341;
  --purple:  #d2a8ff;
  --orange:  #ffa657;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  height: 100%; background: var(--bg); color: var(--fg);
  font-family: 'Cascadia Code','Fira Code','JetBrains Mono','SF Mono',Menlo,Monaco,'Courier New',monospace;
  font-size: 13px; line-height: 1.55; -webkit-font-smoothing: antialiased;
}
::-webkit-scrollbar { width: 5px; height: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

/* ── Shell ──────────────────────────────────────── */
#shell { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

/* ── Topbar ─────────────────────────────────────── */
#topbar {
  display: flex; align-items: center; justify-content: space-between;
  height: 34px; min-height: 34px; padding: 0 14px;
  background: var(--bg2); border-bottom: 1px solid var(--border2); flex-shrink: 0;
}
.tb-brand { color: var(--cyan); font-weight: 700; font-size: 12px; letter-spacing: .04em; margin-right: 8px; }
#tb-model { color: var(--fg3); font-size: 11px; }
.tb-right { display: flex; align-items: center; gap: 10px; }
#ctx-pct { font-size: 11px; color: var(--fg4); }
#ctx-pct.warn { color: var(--yellow); }
#ctx-pct.crit { color: var(--red); }
.tb-btn {
  background: none; border: 1px solid var(--border); color: var(--fg3);
  font-family: inherit; font-size: 11px; padding: 1px 8px; cursor: pointer; transition: color .15s, border-color .15s;
}
.tb-btn:hover { color: var(--fg); border-color: var(--fg3); }
#btn-stop { border-color: var(--red); color: var(--red); display: none; }
#btn-stop.on { display: inline-block; }
#btn-stop:hover { background: rgba(248,81,73,.1); }

/* ── Token banner ───────────────────────────────── */
#tok-banner {
  display: none; padding: 5px 14px; flex-shrink: 0;
  background: rgba(227,179,65,.07); border-bottom: 1px solid rgba(227,179,65,.2);
  color: var(--yellow); font-size: 12px; align-items: center; justify-content: space-between;
}
#tok-banner.on { display: flex; }
#tok-banner.crit { background: rgba(248,81,73,.07); border-bottom-color: rgba(248,81,73,.2); color: var(--red); }
#tok-banner button {
  background: none; border: 1px solid currentColor; color: inherit;
  font-family: inherit; font-size: 11px; padding: 1px 8px; cursor: pointer;
}

/* ── Messages ───────────────────────────────────── */
#msgs { flex: 1; overflow-y: auto; padding: 12px 0 6px; }

/* ── Welcome ────────────────────────────────────── */
#welcome { padding: 48px 20px 20px; text-align: center; }
.wlc-star { color: var(--cyan); font-size: 20px; display: block; margin-bottom: 8px; }
.wlc-title { color: var(--fg); font-weight: 700; font-size: 14px; }
.wlc-sub { color: var(--fg2); font-size: 12px; margin-top: 3px; }
.wlc-hint { margin-top: 24px; color: var(--fg3); font-size: 12px; line-height: 2; }
.wlc-hint kbd {
  color: var(--fg2); background: var(--bg3); border: 1px solid var(--border);
  padding: 0 5px; border-radius: 3px; font-family: inherit; font-size: 11px;
}

/* ── User message ───────────────────────────────── */
.msg-user { display: flex; gap: 8px; padding: 6px 16px; align-items: flex-start; }
.u-ptr { color: var(--cyan); font-weight: 700; flex-shrink: 0; user-select: none; }
.u-text { color: var(--fg); white-space: pre-wrap; word-break: break-word; flex: 1; }

/* ── Assistant block ────────────────────────────── */
.msg-asst { padding: 2px 16px 6px; }

/* ── Text part ──────────────────────────────────── */
.p-text { color: var(--fg); white-space: pre-wrap; word-break: break-word; line-height: 1.6; }
.p-text.streaming::after { content: '\u258b'; color: var(--cyan); animation: blink 1s steps(1) infinite; }
@keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }

/* ── Reasoning block ────────────────────────────── */
.p-reason { margin: 4px 0; border-left: 2px solid var(--border); padding-left: 10px; }
.reason-hdr {
  display: flex; align-items: center; gap: 6px;
  cursor: pointer; user-select: none; color: var(--fg3); font-size: 12px; padding: 3px 0;
}
.reason-hdr:hover { color: var(--fg2); }
.reason-sym { color: var(--fg4); }
.reason-tog { color: var(--fg4); font-size: 10px; transition: transform .2s; }
.reason-hdr.open .reason-tog { transform: rotate(90deg); }
.reason-body {
  overflow: hidden; max-height: 0; transition: max-height .25s ease;
  color: var(--fg3); font-style: italic; font-size: 12px; white-space: pre-wrap;
}
.reason-body.open { max-height: 800px; }

/* ── Tool part ──────────────────────────────────── */
.p-tool { margin: 3px 0; font-size: 12px; }
.tool-hdr {
  display: flex; align-items: baseline; gap: 5px;
  cursor: pointer; user-select: none; padding: 3px 0; line-height: 1.4;
}
.tool-hdr:hover .tool-name { opacity: .8; }
.tool-dot { flex-shrink: 0; font-size: 9px; width: 14px; text-align: center; }
.tool-dot.pending { color: var(--fg4); }
.tool-dot.running { color: var(--cyan); animation: pulse 1.2s ease-in-out infinite; }
.tool-dot.completed { color: var(--green); }
.tool-dot.error { color: var(--red); }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
.tool-name { color: var(--purple); font-weight: 600; }
.tool-args { color: var(--fg3); max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-time { color: var(--fg4); font-size: 11px; margin-left: auto; flex-shrink: 0; }
.tool-exp { color: var(--fg4); font-size: 10px; margin-left: 4px; transition: transform .2s; }
.tool-hdr.open .tool-exp { transform: rotate(90deg); }
.tool-body { overflow: hidden; max-height: 0; transition: max-height .3s ease; padding-left: 18px; }
.tool-body.open { max-height: 600px; }
.tool-out {
  color: var(--fg3); font-size: 11px; white-space: pre-wrap;
  border-left: 2px solid var(--border2); padding: 4px 0 4px 8px;
  margin: 2px 0; overflow-y: auto; max-height: 280px;
}
.tool-err { color: var(--red); font-size: 11px; padding: 4px 0 4px 8px; }
.diff-block { font-size: 11px; padding: 4px 0 4px 8px; border-left: 2px solid var(--border2); margin: 2px 0; }
.diff-del { color: var(--red); }
.diff-add { color: var(--green); }

/* ── Step divider ───────────────────────────────── */
.step-div { display: flex; align-items: center; gap: 8px; padding: 8px 16px 4px; }
.step-hr { flex: 1; height: 1px; background: var(--border2); }
.step-meta { color: var(--fg4); font-size: 11px; white-space: nowrap; }

/* ── Thinking row ───────────────────────────────── */
#thinking {
  display: none; align-items: center; gap: 8px;
  padding: 5px 16px; flex-shrink: 0; font-size: 12px;
  border-top: 1px solid var(--border2); background: var(--bg);
}
#thinking.on { display: flex; }
.think-arr { color: var(--cyan); animation: arr-blink 1.2s steps(1) infinite; }
@keyframes arr-blink { 0%,100% { color: var(--cyan); } 50% { color: var(--fg4); } }
#think-verb {
  background: linear-gradient(90deg, var(--fg4) 0%, var(--fg) 40%, var(--fg4) 80%);
  background-size: 200% auto; -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; animation: shimmer 1.8s linear infinite;
}
@keyframes shimmer { 0% { background-position: 100% center; } 100% { background-position: -100% center; } }
#think-time { color: var(--fg4); font-size: 11px; }
.think-esc { color: var(--fg4); font-size: 11px; margin-left: 4px; }

/* ── Permission prompt ──────────────────────────── */
.p-perm {
  margin: 6px 0; border: 1px solid var(--border); background: var(--bg2); padding: 10px 12px;
}
.p-perm.danger { border-color: rgba(248,81,73,.4); background: rgba(248,81,73,.04); }
.perm-title { color: var(--fg3); font-size: 11px; margin-bottom: 5px; }
.perm-danger { display: inline-block; background: rgba(248,81,73,.15); color: var(--red); border: 1px solid rgba(248,81,73,.3); font-size: 10px; padding: 0 5px; margin-right: 6px; }
.perm-tool { color: var(--purple); font-weight: 700; font-size: 13px; }
.perm-prev { background: var(--bg); border: 1px solid var(--border2); padding: 6px 8px; margin: 6px 0; color: var(--fg); font-size: 12px; white-space: pre-wrap; max-height: 120px; overflow-y: auto; }
.perm-acts { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.perm-btn { background: none; border: 1px solid; font-family: inherit; font-size: 12px; padding: 3px 12px; cursor: pointer; transition: background .15s; }
.perm-btn.allow { border-color: var(--green); color: var(--green); }
.perm-btn.allow:hover { background: rgba(63,185,80,.1); }
.perm-btn.all { border-color: var(--cyan); color: var(--cyan); }
.perm-btn.all:hover { background: rgba(121,192,255,.1); }
.perm-btn.deny { border-color: var(--red); color: var(--red); }
.perm-btn.deny:hover { background: rgba(248,81,73,.1); }
.perm-done { color: var(--fg4); font-size: 11px; font-style: italic; padding: 3px 0; }

/* ── Question prompt ────────────────────────────── */
.p-question { margin: 6px 0; border: 1px solid rgba(63,185,80,.3); background: rgba(63,185,80,.03); padding: 10px 12px; }
.q-header { color: var(--green); font-size: 12px; margin-bottom: 6px; }
.q-text { color: var(--fg); white-space: pre-wrap; margin-bottom: 8px; }
.q-input { width: 100%; background: var(--bg); border: 1px solid var(--border); color: var(--fg); font-family: inherit; font-size: 12px; padding: 5px 8px; outline: none; transition: border-color .15s; }
.q-input:focus { border-color: var(--green); }
.q-send { margin-top: 6px; background: none; border: 1px solid var(--green); color: var(--green); font-family: inherit; font-size: 12px; padding: 3px 12px; cursor: pointer; }
.q-send:hover { background: rgba(63,185,80,.1); }
.q-done { color: var(--fg4); font-size: 11px; font-style: italic; }

/* ── Info blocks (slash command output) ─────────── */
.info-block { padding: 4px 0; }
.info-hdr { color: var(--fg2); font-weight: 600; margin-bottom: 4px; }
.info-row { display: flex; gap: 12px; padding: 2px 0; font-size: 12px; }
.info-key { color: var(--cyan); width: 100px; flex-shrink: 0; }
.info-val { color: var(--fg); }
.info-dim { color: var(--fg3); }
.info-hr { border: none; border-top: 1px solid var(--border2); margin: 6px 0; }
.info-badge { display: inline-block; font-size: 10px; padding: 0 5px; border-radius: 2px; margin-left: 6px; }
.badge-plan { background: rgba(227,179,65,.15); color: var(--yellow); }
.badge-wt { background: rgba(210,168,255,.15); color: var(--purple); }
.badge-busy { background: rgba(121,192,255,.15); color: var(--cyan); }
.badge-idle { background: rgba(63,185,80,.15); color: var(--green); }
.badge-err { background: rgba(248,81,73,.15); color: var(--red); }

/* ── Model picker ───────────────────────────────── */
.model-pick { margin: 4px 0; }
.mp-item { display: flex; gap: 10px; padding: 5px 8px; cursor: pointer; font-size: 12px; border: 1px solid transparent; }
.mp-item:hover { background: var(--bg3); }
.mp-item.active { border-color: var(--cyan); }
.mp-num { color: var(--fg3); width: 20px; flex-shrink: 0; }
.mp-model { color: var(--fg); }
.mp-provider { color: var(--fg3); }
.mp-cur { color: var(--green); font-size: 10px; margin-left: auto; }

/* ── Error row ──────────────────────────────────── */
.err-row { color: var(--red); padding: 3px 16px; font-size: 12px; }

/* ── Markdown ───────────────────────────────────── */
.md-h1 { color: var(--fg); font-weight: 700; font-size: 15px; margin: 5px 0 3px; }
.md-h2 { color: var(--cyan); font-weight: 600; font-size: 14px; margin: 4px 0 2px; }
.md-h3 { color: var(--cyan); font-size: 13px; margin: 3px 0 2px; }
.md-h4,.md-h5,.md-h6 { color: var(--fg2); font-size: 12px; margin: 2px 0; }
.md-code { color: var(--yellow); background: var(--bg3); padding: 0 3px; border-radius: 2px; font-size: 12px; }
.md-pre { background: var(--bg2); border: 1px solid var(--border2); border-radius: 4px; padding: 10px 12px; margin: 5px 0; overflow-x: auto; font-size: 12px; line-height: 1.5; }
.md-pre code { color: var(--fg); white-space: pre; display: block; }
.md-bq { border-left: 3px solid var(--border); color: var(--fg3); padding-left: 10px; font-style: italic; margin: 3px 0; }
.md-ul,.md-ol { padding-left: 18px; margin: 3px 0; }
.md-li { margin: 2px 0; }
.md-link { color: var(--cyan); text-decoration: none; }
.md-link:hover { text-decoration: underline; }
.md-hr { border: none; border-top: 1px solid var(--border2); margin: 6px 0; }
.md-table { border-collapse: collapse; margin: 5px 0; font-size: 12px; }
.md-table th { color: var(--fg2); border-bottom: 1px solid var(--border); padding: 2px 12px 2px 0; }
.md-table td { padding: 2px 12px 2px 0; border-bottom: 1px solid var(--border2); }
/* Syntax highlight */
.sh-kw { color: #ff7b72; } .sh-str { color: #a5d6ff; } .sh-num { color: #79c0ff; }
.sh-cmt { color: #8b949e; font-style: italic; } .sh-fn { color: #d2a8ff; } .sh-type { color: #ffa657; }

/* ── Input area ─────────────────────────────────── */
#input-area {
  background: var(--bg2); border-top: 1px solid var(--border2);
  padding: 0 14px 8px; flex-shrink: 0; position: relative;
}
#typeahead {
  display: none; position: absolute; bottom: 100%; left: 0; right: 0;
  background: var(--bg2); border: 1px solid var(--border); border-bottom: none;
  max-height: 220px; overflow-y: auto; z-index: 10;
}
#typeahead.on { display: block; }
.ta-item { display: flex; gap: 10px; align-items: baseline; padding: 6px 14px; cursor: pointer; }
.ta-item:hover,.ta-item.sel { background: var(--bg3); }
.ta-cmd { color: var(--cyan); font-size: 12px; flex-shrink: 0; min-width: 120px; }
.ta-desc { color: var(--fg3); font-size: 11px; }
#prompt-row { display: flex; align-items: flex-end; gap: 8px; padding-top: 7px; }
#prompt-ptr { color: var(--cyan); font-weight: 700; font-size: 14px; flex-shrink: 0; padding-bottom: 1px; transition: color .2s; }
#prompt-ptr.busy { color: var(--fg4); }
#input {
  flex: 1; background: none; border: none; color: var(--fg);
  font-family: inherit; font-size: 13px; line-height: 1.5;
  resize: none; outline: none; max-height: 120px; min-height: 20px; padding: 0;
}
#input::placeholder { color: var(--fg4); }
#input:disabled { opacity: .4; cursor: not-allowed; }
#prompt-meta { display: flex; justify-content: space-between; align-items: center; padding-top: 3px; font-size: 11px; }
#cost-disp { color: var(--fg4); }
#hint-text { color: var(--fg4); }
#hint-text kbd { color: var(--fg3); background: var(--bg3); border: 1px solid var(--border); padding: 0 4px; border-radius: 2px; font-family: inherit; }
</style>
</head>
<body>
<div id="shell">
  <div id="topbar">
    <div style="display:flex;align-items:center;gap:8px">
      <span class="tb-brand">&#10059; Neural Inverse</span>
      <span id="tb-model">power mode</span>
    </div>
    <div class="tb-right">
      <span id="ctx-pct"></span>
      <button class="tb-btn" id="btn-new">+ new</button>
      <button class="tb-btn" id="btn-stop">&#9632; stop</button>
    </div>
  </div>
  <div id="tok-banner"><span id="tok-msg"></span><button onclick="doCompact()">compact</button></div>
  <div id="msgs">
    <div id="welcome">
      <span class="wlc-star">&#10059;</span>
      <div class="wlc-title">Neural Inverse Power Mode</div>
      <div class="wlc-sub">Agentic coding terminal</div>
      <div class="wlc-hint">
        <kbd>Enter</kbd> send &nbsp;&middot;&nbsp; <kbd>Shift+Enter</kbd> newline &nbsp;&middot;&nbsp;
        <kbd>/</kbd> commands &nbsp;&middot;&nbsp; <kbd>Esc</kbd> stop
      </div>
    </div>
  </div>
  <div id="thinking">
    <span class="think-arr">&#8595;</span>
    <span id="think-verb">Working</span>
    <span id="think-time"></span>
    <span class="think-esc">esc to interrupt</span>
  </div>
  <div id="input-area">
    <div id="typeahead"></div>
    <div id="prompt-row">
      <span id="prompt-ptr">&#10095;</span>
      <textarea id="input" rows="1" placeholder="What do you want to build?" autofocus></textarea>
    </div>
    <div id="prompt-meta">
      <span id="cost-disp"></span>
      <span id="hint-text"><kbd>Enter</kbd> send &nbsp; <kbd>Shift+Enter</kbd> newline &nbsp; <kbd>/</kbd> commands</span>
    </div>
  </div>
</div>

<script nonce="${nonce}">
(function () {
'use strict';

var vsc = acquireVsCodeApi();

// ── DOM ──────────────────────────────────────────────────────────────────
var $msgs    = document.getElementById('msgs');
var $welcome = document.getElementById('welcome');
var $thinking= document.getElementById('thinking');
var $thVerb  = document.getElementById('think-verb');
var $thTime  = document.getElementById('think-time');
var $input   = document.getElementById('input');
var $ptr     = document.getElementById('prompt-ptr');
var $ta      = document.getElementById('typeahead');
var $tokBan  = document.getElementById('tok-banner');
var $tokMsg  = document.getElementById('tok-msg');
var $ctxPct  = document.getElementById('ctx-pct');
var $costDisp= document.getElementById('cost-disp');
var $btnNew  = document.getElementById('btn-new');
var $btnStop = document.getElementById('btn-stop');
var $tbModel = document.getElementById('tb-model');

// ── State ────────────────────────────────────────────────────────────────
var sid         = null;
var busy        = false;
var skills      = [];
var sessions    = [];
var curSession  = null;   // full IPowerSession object
var curModel    = null;   // {model, provider}
var totalCost   = 0;
var tokenPct    = 100;
var pendText    = null;
var hist        = [];
var histIdx     = -1;
var taIdx       = -1;

// Thinking timer
var thTimer  = null;
var thStart  = null;
var VERBS    = ['Analyzing','Thinking','Writing','Reasoning','Searching',
                'Considering','Processing','Working','Reading','Planning',
                'Reviewing','Crafting','Exploring','Evaluating','Generating'];

// Pending slash-command callbacks waiting for data responses
var pendModels  = null;  // fn(models-info event)
var pendTasks   = null;
var pendMemory  = null;
var pendChanges = null;
var pendRollback= null;
var pendAgents  = null;

// ── Helpers ──────────────────────────────────────────────────────────────
function esc(s) {
  var d = document.createElement('div');
  d.textContent = String(s || '');
  return d.innerHTML;
}

function post(msg) { vsc.postMessage(msg); }

function bottom() { $msgs.scrollTop = $msgs.scrollHeight; }

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ── Thinking ─────────────────────────────────────────────────────────────
function startThinking() {
  if (thTimer) return;
  $thVerb.textContent = VERBS[Math.floor(Math.random() * VERBS.length)];
  $thTime.textContent = '';
  thStart = Date.now();
  $thinking.classList.add('on');
  thTimer = setInterval(function () {
    $thTime.textContent = ((Date.now() - thStart) / 1000).toFixed(1) + 's';
  }, 200);
}

function stopThinking() {
  if (thTimer) { clearInterval(thTimer); thTimer = null; }
  $thinking.classList.remove('on');
  $thTime.textContent = '';
}

// ── Busy ─────────────────────────────────────────────────────────────────
function setBusy(b) {
  busy = b;
  $input.disabled = b;
  $ptr.className = b ? 'busy' : '';
  if (b) { $btnStop.classList.add('on'); } else { $btnStop.classList.remove('on'); }
  if (!b) stopThinking();
}

// ── Model label ──────────────────────────────────────────────────────────
function updateModelLabel() {
  $tbModel.textContent = curModel ? (curModel.model + ' \u00b7 ' + curModel.provider) : 'power mode';
}

// ── Cost display ─────────────────────────────────────────────────────────
function updateCost() {
  $costDisp.textContent = totalCost > 0
    ? (totalCost > 0.5 ? '$' + totalCost.toFixed(2) : '$' + totalCost.toFixed(4))
    : '';
}

// ── Markdown renderer ────────────────────────────────────────────────────
function renderMD(text) {
  var frag = document.createDocumentFragment();
  var lines = String(text || '').split('\\n');
  var i = 0, inCode = false, codeLang = '', codeBuf = [], inTable = false, tableRows = [];

  function flushTable() {
    if (!tableRows.length) return;
    var tbl = el('table', 'md-table');
    tableRows.forEach(function (row, ri) {
      var tr = document.createElement('tr');
      row.forEach(function (cell) {
        var td = document.createElement(ri === 0 ? 'th' : 'td');
        td.innerHTML = inlineMD(cell.trim());
        tr.appendChild(td);
      });
      tbl.appendChild(tr);
    });
    frag.appendChild(tbl);
    tableRows = []; inTable = false;
  }

  function app(node) { if (inTable) flushTable(); frag.appendChild(node); }

  while (i < lines.length) {
    var raw = lines[i];
    // Code fence
    if (/^\`\`\`|^~~~/.test(raw)) {
      if (inCode) {
        var pre = el('pre', 'md-pre');
        var code = el('code');
        code.innerHTML = hlCode(codeBuf.join('\\n'), codeLang);
        pre.appendChild(code); app(pre);
        inCode = false; codeLang = ''; codeBuf = [];
      } else { inCode = true; codeLang = raw.replace(/^\`\`\`|^~~~/, '').trim(); codeBuf = []; }
      i++; continue;
    }
    if (inCode) { codeBuf.push(raw); i++; continue; }
    // Table
    if (/^\s*\|/.test(raw)) {
      if (/^\s*\|[-: |]+\|\s*$/.test(raw)) { i++; continue; }
      tableRows.push(raw.split('|').slice(1, -1));
      inTable = true; i++; continue;
    }
    if (inTable) flushTable();
    // Blank
    if (!raw.trim()) { var sp = el('div'); sp.style.height = '.4em'; frag.appendChild(sp); i++; continue; }
    // HR
    if (/^\s*[-*_]{3,}\s*$/.test(raw) || /^\s*[\u2501\u2500]{3,}\s*$/.test(raw)) { app(el('hr', 'md-hr')); i++; continue; }
    // Header
    var hm = raw.match(/^(#{1,6})\s+(.+)$/);
    if (hm) { var hel = el('div', 'md-h' + hm[1].length); hel.innerHTML = inlineMD(hm[2]); app(hel); i++; continue; }
    // Blockquote
    if (/^>\s?/.test(raw)) { var bq = el('div', 'md-bq'); bq.innerHTML = inlineMD(raw.replace(/^>\s?/, '')); app(bq); i++; continue; }
    // Unordered list
    if (/^\s*[-*\u2022]\s+/.test(raw)) {
      var ul = el('ul', 'md-ul');
      while (i < lines.length && /^\s*[-*\u2022]\s+/.test(lines[i])) {
        var li = el('li', 'md-li'); li.innerHTML = inlineMD(lines[i].replace(/^\s*[-*\u2022]\s+/, '')); ul.appendChild(li); i++;
      }
      app(ul); continue;
    }
    // Ordered list
    if (/^\s*\d+\.\s+/.test(raw)) {
      var ol = el('ol', 'md-ol');
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        var oli = el('li', 'md-li'); oli.innerHTML = inlineMD(lines[i].replace(/^\s*\d+\.\s+/, '')); ol.appendChild(oli); i++;
      }
      app(ol); continue;
    }
    // Normal
    var p = el('div', 'p-text'); p.innerHTML = inlineMD(raw); app(p); i++;
  }
  if (inCode && codeBuf.length) {
    var fp = el('pre', 'md-pre'); var fc = el('code'); fc.innerHTML = hlCode(codeBuf.join('\\n'), codeLang); fp.appendChild(fc); frag.appendChild(fp);
  }
  if (inTable) flushTable();
  return frag;
}

function inlineMD(text) {
  var s = esc(text);
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '<em>$1</em>');
  s = s.replace(/\x60([^\x60\n]+)\x60/g, '<code class="md-code">$1</code>');
  s = s.replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '<span class="md-link">$1</span>');
  return s;
}

function hlCode(code, lang) {
  var s = esc(code);
  var kws = {
    js:   /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|void|delete|yield|true|false|null|undefined)\b/g,
    ts:   /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|void|delete|yield|type|interface|enum|namespace|declare|abstract|implements|readonly|public|private|protected|static|true|false|null|undefined)\b/g,
    py:   /\b(def|return|if|elif|else|for|while|import|from|as|class|pass|break|continue|try|except|finally|raise|with|lambda|yield|True|False|None|and|or|not|in|is)\b/g,
    go:   /\b(func|return|if|else|for|range|switch|case|break|continue|type|struct|interface|import|package|var|const|map|chan|go|defer|select|nil|true|false)\b/g,
    rust: /\b(fn|let|mut|return|if|else|for|while|loop|match|struct|enum|impl|trait|use|mod|pub|crate|super|self|type|where|async|await|true|false)\b/g
  };
  var lmap = { javascript:'js', typescript:'ts', python:'py', golang:'go' };
  var key = lmap[lang] || lang;
  if (kws[key]) s = s.replace(kws[key], '<span class="sh-kw">$1</span>');
  s = s.replace(/(&quot;[^&]*&quot;|&#039;[^&]*&#039;)/g, '<span class="sh-str">$1</span>');
  s = s.replace(/\b(\d+\.?\d*)\b/g, '<span class="sh-num">$1</span>');
  s = s.replace(/(\/\/[^\n]*)$/gm, '<span class="sh-cmt">$1</span>');
  s = s.replace(/(#[^\n]*)$/gm, '<span class="sh-cmt">$1</span>');
  return s;
}

// ── Tool arg preview ─────────────────────────────────────────────────────
function toolPreview(name, input) {
  var short = function (s, n) { s = String(s || ''); n = n || 50; return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; };
  var fname = function (p) { if (!p) return ''; var parts = String(p).split('/'); return parts.slice(-2).join('/'); };
  switch (name) {
    case 'bash':        return short(input.command, 56);
    case 'read':        return fname(input.filePath);
    case 'write':       return fname(input.filePath);
    case 'edit':        return fname(input.filePath);
    case 'multi_edit':  return fname(input.filePath);
    case 'glob':        return short(input.pattern);
    case 'grep':        return short(input.pattern);
    case 'web_fetch':   return short(input.url, 56);
    case 'web_search':  return short(input.query);
    case 'git_commit':  return short(input.message);
    case 'memory_write':return short(input.key);
    case 'memory_read': return short(input.key);
    case 'tasks_create':return short(input.title);
    case 'spawn_agent': return short((input.role || '') + ': ' + (input.goal || ''), 56);
    default:            return '';
  }
}

// ── Render user message ──────────────────────────────────────────────────
function renderUser(msg) {
  $welcome.style.display = 'none';
  var text = (msg.parts && msg.parts[0]) ? msg.parts[0].text : '';
  var row = el('div', 'msg-user');
  row.appendChild(el('span', 'u-ptr', '\u276f'));
  var t = el('span', 'u-text'); t.textContent = text; row.appendChild(t);
  $msgs.appendChild(row); bottom();
}

// ── Create / get assistant block ─────────────────────────────────────────
function mkAsstBlock(msgId) {
  $welcome.style.display = 'none';
  var d = el('div', 'msg-asst'); d.id = 'msg-' + msgId;
  $msgs.appendChild(d); return d;
}
function getAsstBlock(msgId) { return document.getElementById('msg-' + msgId); }

// ── Render part ──────────────────────────────────────────────────────────
function renderPart(msgId, part) {
  stopThinking();
  var box = getAsstBlock(msgId);
  if (!box) return;
  var existing = document.getElementById('part-' + part.id);

  switch (part.type) {
    case 'text': {
      if (existing) {
        existing.classList.remove('streaming');
        existing.innerHTML = '';
        existing.appendChild(renderMD(part.text || ''));
      } else {
        var te = el('div', 'p-text'); te.id = 'part-' + part.id;
        te.appendChild(renderMD(part.text || ''));
        box.appendChild(te);
      }
      break;
    }

    case 'reasoning': {
      if (!existing) {
        existing = el('div', 'p-reason'); existing.id = 'part-' + part.id;
        var rHdr = el('div', 'reason-hdr');
        var rSym = el('span', 'reason-sym', '\u2234');
        var rLbl = el('span', 'reason-lbl', 'Thinking'); rLbl.id = 'rlbl-' + part.id;
        var rTog = el('span', 'reason-tog', '\u25b6');
        rHdr.appendChild(rSym); rHdr.appendChild(rLbl); rHdr.appendChild(rTog);
        var rBody = el('div', 'reason-body'); rBody.id = 'rbody-' + part.id;
        rHdr.onclick = function () { rHdr.classList.toggle('open'); rBody.classList.toggle('open'); };
        existing.appendChild(rHdr); existing.appendChild(rBody);
        box.appendChild(existing);
      }
      var rb = document.getElementById('rbody-' + part.id);
      if (rb) rb.textContent = part.text || '';
      var rl = document.getElementById('rlbl-' + part.id);
      if (rl) {
        var wc = (part.text || '').split(/\s+/).filter(Boolean).length;
        rl.textContent = 'Thinking  \u00b7  ' + wc + ' words';
      }
      break;
    }

    case 'tool': {
      if (!existing) {
        existing = el('div', 'p-tool'); existing.id = 'part-' + part.id;
        var th = el('div', 'tool-hdr'); th.id = 'thdr-' + part.id;
        var dot = el('span', 'tool-dot', '\u23fa'); dot.id = 'tdot-' + part.id;
        var tn = el('span', 'tool-name', part.toolName);
        var ta2 = el('span', 'tool-args'); ta2.id = 'targs-' + part.id;
        var tt = el('span', 'tool-time'); tt.id = 'ttime-' + part.id;
        var te2 = el('span', 'tool-exp', '\u25b6');
        var tb = el('div', 'tool-body'); tb.id = 'tbody-' + part.id;
        th.onclick = function () { th.classList.toggle('open'); tb.classList.toggle('open'); };
        th.appendChild(dot); th.appendChild(tn); th.appendChild(ta2); th.appendChild(tt); th.appendChild(te2);
        existing.appendChild(th); existing.appendChild(tb);
        box.appendChild(existing);
      }
      updateTool(part);
      break;
    }

    case 'step-finish': {
      if (!existing) {
        existing = el('div', 'step-div'); existing.id = 'part-' + part.id;
        var hr = el('div', 'step-hr');
        var sm = el('span', 'step-meta');
        var pts = [];
        if (part.tokens) pts.push('\u2193 ' + (part.tokens.input + part.tokens.output).toLocaleString() + ' tokens');
        if (part.cost && part.cost > 0) pts.push(part.cost > 0.5 ? '$' + part.cost.toFixed(2) : '$' + part.cost.toFixed(4));
        sm.textContent = pts.join('  \u00b7  ');
        existing.appendChild(hr); existing.appendChild(sm);
        box.appendChild(existing);
      }
      break;
    }
  }
  bottom();
}

function updateTool(part) {
  var st = part.state;
  var dot  = document.getElementById('tdot-' + part.id);
  var hdr  = document.getElementById('thdr-' + part.id);
  var args = document.getElementById('targs-' + part.id);
  var time = document.getElementById('ttime-' + part.id);
  var body = document.getElementById('tbody-' + part.id);
  if (!dot) return;
  dot.className = 'tool-dot ' + st.status;
  if (args) {
    var preview = st.title || (st.input ? toolPreview(part.toolName, st.input) : '');
    args.textContent = preview ? '(' + preview + ')' : '';
  }
  if (time && st.time && st.time.start) {
    var end = st.time.end || Date.now();
    time.textContent = '  ' + ((end - st.time.start) / 1000).toFixed(1) + 's';
  }
  if (body) {
    if (st.status === 'completed') {
      body.innerHTML = '';
      if (part.toolName === 'edit' && st.input && st.input.old_string != null) {
        var diff = el('div', 'diff-block');
        String(st.input.old_string || '').split('\\n').filter(Boolean).slice(0, 8).forEach(function (l) {
          var d = el('div', 'diff-del', '- ' + l); diff.appendChild(d);
        });
        String(st.input.new_string || '').split('\\n').filter(Boolean).slice(0, 8).forEach(function (l) {
          var d = el('div', 'diff-add', '+ ' + l); diff.appendChild(d);
        });
        body.appendChild(diff); body.classList.add('open');
      } else if (st.output) {
        var lines = st.output.split('\\n').filter(function (l) { return l.trim(); });
        var shown = lines.slice(0, 30).join('\\n');
        var out = el('div', 'tool-out', shown);
        body.appendChild(out);
        if (lines.length > 30) { var more = el('div', 'info-dim', '\u2026 ' + (lines.length - 30) + ' more lines'); body.appendChild(more); }
      }
    } else if (st.status === 'error' && st.error) {
      body.innerHTML = '';
      body.appendChild(el('div', 'tool-err', st.error.length > 120 ? st.error.slice(0, 117) + '...' : st.error));
      body.classList.add('open');
    }
  }
}

// ── Part delta (streaming) ───────────────────────────────────────────────
function applyDelta(msgId, partId, delta) {
  stopThinking();
  var existing = document.getElementById('part-' + partId);
  if (!existing) {
    var box = getAsstBlock(msgId);
    if (!box) return;
    existing = el('div', 'p-text streaming'); existing.id = 'part-' + partId;
    box.appendChild(existing);
  }
  existing.textContent = (existing.textContent || '') + delta;
  bottom();
}

// ── Permission prompt ────────────────────────────────────────────────────
function renderPerm(req) {
  $welcome.style.display = 'none'; stopThinking();
  var d = el('div', 'p-perm' + (req.danger ? ' danger' : '')); d.id = 'perm-' + req.requestId;
  var title = el('div', 'perm-title');
  if (req.danger) { title.appendChild(el('span', 'perm-danger', '\u26a0 DANGEROUS')); }
  title.appendChild(document.createTextNode('Tool permission required'));
  var tool = el('div', 'perm-tool', req.toolName);
  var prev = el('pre', 'perm-prev'); prev.textContent = req.preview || '';
  var acts = el('div', 'perm-acts');
  function mkBtn(cls, text, dec) {
    var b = el('button', 'perm-btn ' + cls, text);
    b.onclick = function () { resolvePerm(req.requestId, dec); };
    return b;
  }
  acts.appendChild(mkBtn('allow', 'Allow', 'allow'));
  acts.appendChild(mkBtn('all', 'Allow All', 'allow-all'));
  acts.appendChild(mkBtn('deny', 'Deny', 'deny'));
  d.appendChild(title); d.appendChild(tool); d.appendChild(prev); d.appendChild(acts);
  $msgs.appendChild(d); bottom();
}

function resolvePerm(reqId, decision) {
  var d = document.getElementById('perm-' + reqId);
  if (d) { var r = el('div', 'perm-done', 'Permission ' + decision + '  \u00b7  ' + reqId.slice(0, 8)); d.innerHTML = ''; d.appendChild(r); }
  post({ type: 'permission-response', requestId: reqId, decision: decision });
}

// ── Question prompt ──────────────────────────────────────────────────────
function renderQuestion(qid, question) {
  $welcome.style.display = 'none'; stopThinking();
  var d = el('div', 'p-question'); d.id = 'q-' + qid;
  var hdr = el('div', 'q-header', '? Question from agent');
  var qt = el('div', 'q-text', question);
  var qi = el('input', 'q-input'); qi.id = 'qi-' + qid; qi.placeholder = 'Your answer\u2026';
  qi.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); resolveQ(qid); } });
  var send = el('button', 'q-send', 'Send'); send.onclick = function () { resolveQ(qid); };
  d.appendChild(hdr); d.appendChild(qt); d.appendChild(qi); d.appendChild(send);
  $msgs.appendChild(d); setTimeout(function () { qi.focus(); }, 50); bottom();
}

function resolveQ(qid) {
  var qi = document.getElementById('qi-' + qid);
  var ans = qi ? qi.value.trim() : '';
  var d = document.getElementById('q-' + qid);
  if (d) { d.innerHTML = ''; d.appendChild(el('div', 'q-done', 'Answered: ' + (ans || '(empty)'))); }
  post({ type: 'question-response', questionId: qid, answer: ans || '' });
}

// ── Info block helpers (for slash command output) ─────────────────────────
function infoSection(title) {
  var d = el('div', 'info-block');
  if (title) d.appendChild(el('div', 'info-hdr', title));
  $msgs.appendChild(d); bottom();
  return d;
}

function infoRow(parent, key, val, valCls) {
  var row = el('div', 'info-row');
  row.appendChild(el('span', 'info-key', key));
  var v = el('span', valCls || 'info-val'); v.innerHTML = val; row.appendChild(v);
  parent.appendChild(row);
}

function appendMsg(cls, text) {
  var d = el('div', cls); d.textContent = text;
  $msgs.appendChild(d); bottom();
}

// ── Slash commands ────────────────────────────────────────────────────────
var BUILTIN = [
  {cmd:'/clear',     desc:'Clear conversation'},
  {cmd:'/new',       desc:'New session'},
  {cmd:'/sessions',  desc:'List all sessions'},
  {cmd:'/switch',    desc:'Switch session  <number|id>'},
  {cmd:'/stop',      desc:'Stop current response'},
  {cmd:'/compact',   desc:'Summarize and compress conversation'},
  {cmd:'/model',     desc:'Change model'},
  {cmd:'/plan',      desc:'Enter plan mode (blocks write tools)'},
  {cmd:'/exit-plan', desc:'Exit plan mode'},
  {cmd:'/worktree',  desc:'Show active worktree info'},
  {cmd:'/tasks',     desc:'List tracked tasks'},
  {cmd:'/memory',    desc:'List memory entries'},
  {cmd:'/review',    desc:'Review recent file changes'},
  {cmd:'/rollback',  desc:'Rollback changes  [all|filename]'},
  {cmd:'/agents',    desc:'Show PowerBus agents'},
  {cmd:'/status',    desc:'Show session status'},
  {cmd:'/crons',     desc:'List scheduled cron jobs'},
  {cmd:'/tools',     desc:'List available tools'},
  {cmd:'/help',      desc:'Show all commands'},
];

function allCmds() {
  return BUILTIN.concat(skills.map(function (s) { return {cmd:'/' + s.name, desc: s.description + (s.argumentHint ? '  ' + s.argumentHint : '')}; }));
}

function showTA(prefix) {
  var q = prefix.toLowerCase();
  var matches = allCmds().filter(function (c) { return c.cmd.startsWith(q); });
  if (!matches.length) { hideTA(); return; }
  $ta.innerHTML = '';
  matches.forEach(function (c, i) {
    var item = el('div', 'ta-item' + (i === taIdx ? ' sel' : '')); item.dataset.cmd = c.cmd;
    item.appendChild(el('span', 'ta-cmd', c.cmd));
    item.appendChild(el('span', 'ta-desc', c.desc));
    item.onclick = function () { selectCmd(c.cmd); };
    $ta.appendChild(item);
  });
  $ta.className = 'on';
}

function hideTA() { $ta.className = ''; $ta.innerHTML = ''; taIdx = -1; }

function selectCmd(cmd) { $input.value = cmd + ' '; hideTA(); $input.focus(); }

function navTA(dir) {
  var items = $ta.querySelectorAll('.ta-item');
  if (!items.length) return false;
  items.forEach(function (it) { it.classList.remove('sel'); });
  taIdx = (taIdx + dir + items.length) % items.length;
  items[taIdx].classList.add('sel'); return true;
}

function doCompact() { if (sid) post({type:'compact', sessionId: sid}); }

// ── Execute slash command ─────────────────────────────────────────────────
function execSlash(raw) {
  var parts = raw.trim().split(/\s+/);
  var cmd = parts[0].toLowerCase();
  var arg = parts.slice(1).join(' ');

  switch (cmd) {
    case '/clear':
      if (sid) post({type:'clear-session', sessionId: sid});
      $msgs.innerHTML = ''; $msgs.appendChild($welcome); $welcome.style.display = 'block'; return;

    case '/new':
      post({type:'create-session'}); return;

    case '/stop':
      if (sid) post({type:'cancel', sessionId: sid}); return;

    case '/compact':
      doCompact(); return;

    case '/plan':
      if (sid) post({type:'send-message', sessionId: sid, text: '/enter_plan_mode'}); return;

    case '/exit-plan':
      if (sid) post({type:'send-message', sessionId: sid, text: '/exit_plan_mode'}); return;

    case '/crons':
      if (sid) post({type:'send-message', sessionId: sid, text: 'cron_list'}); return;

    case '/sessions': {
      var sec = infoSection('Sessions (' + sessions.length + ')');
      if (!sessions.length) { sec.appendChild(el('div', 'info-dim', 'No sessions')); bottom(); return; }
      sessions.forEach(function (s, i) {
        var row = el('div', 'info-row');
        var isCur = s.id === sid;
        var dot = el('span', isCur ? 'info-val' : 'info-dim', (i + 1) + '.  ');
        var title = el('span', isCur ? 'info-val' : 'info-dim');
        title.textContent = s.title.slice(0, 48);
        var age = Math.round((Date.now() - s.updatedAt) / 60000);
        var ageStr = age < 1 ? 'just now' : age < 60 ? age + 'm ago' : Math.round(age/60) + 'h ago';
        var meta = el('span', 'info-dim', '  ' + s.messages.length + ' msgs \u00b7 ' + ageStr);
        row.appendChild(dot); row.appendChild(title); row.appendChild(meta);
        row.style.cursor = 'pointer';
        row.onclick = (function(ss) { return function () { post({type:'switch-session', sessionId: ss.id}); }; })(s);
        sec.appendChild(row);
      });
      sec.appendChild(el('hr', 'info-hr'));
      sec.appendChild(el('div', 'info-dim', 'Click a session to switch, or /switch <number>'));
      bottom(); return;
    }

    case '/switch': {
      if (!arg) { appendMsg('info-dim', 'Usage: /switch <number>'); return; }
      var n = parseInt(arg, 10);
      if (!isNaN(n) && n >= 1 && n <= sessions.length) {
        post({type:'switch-session', sessionId: sessions[n-1].id}); return;
      }
      var matchSess = sessions.find(function(s){ return s.id === arg; });
      if (matchSess) { post({type:'switch-session', sessionId: matchSess.id}); return; }
      appendMsg('err-row', 'Session not found: ' + arg); return;
    }

    case '/worktree': {
      var sec2 = infoSection('Worktree');
      if (curSession && curSession.worktree) {
        infoRow(sec2, 'Path', esc(curSession.worktree.path));
        infoRow(sec2, 'Branch', esc(curSession.worktree.branch));
        infoRow(sec2, 'Original', esc(curSession.worktree.originalDirectory));
      } else {
        sec2.appendChild(el('div', 'info-dim', 'No active worktree. Use enter_worktree tool.'));
      }
      bottom(); return;
    }

    case '/status': {
      var sec3 = infoSection('Power Mode Status');
      if (curModel) infoRow(sec3, 'Model', esc(curModel.model + '  \u00b7  ' + curModel.provider));
      else infoRow(sec3, 'Model', '<span class="info-dim">none selected</span>');
      if (curSession) {
        var badges = '';
        if (curSession.planMode) badges += '<span class="info-badge badge-plan">plan mode</span>';
        if (curSession.worktree) badges += '<span class="info-badge badge-wt">' + esc(curSession.worktree.branch) + '</span>';
        var statusBadge = busy
          ? '<span class="info-badge badge-busy">busy</span>'
          : '<span class="info-badge badge-idle">idle</span>';
        infoRow(sec3, 'Session', esc(curSession.title.slice(0, 44)) + badges);
        infoRow(sec3, 'Status', statusBadge);
        var uc = curSession.messages.filter(function(m){return m.role==='user';}).length;
        infoRow(sec3, 'Messages', String(uc) + ' user / ' + String(curSession.messages.length - uc) + ' assistant');
      }
      if (totalCost > 0 || tokenPct < 100) {
        if (totalCost > 0) infoRow(sec3, 'Session cost', esc(totalCost > 0.5 ? '$' + totalCost.toFixed(2) : '$' + totalCost.toFixed(4)));
        if (tokenPct < 100) infoRow(sec3, 'Context', esc(tokenPct + '% remaining'), tokenPct < 20 ? 'badge-err' : 'badge-plan');
      }
      bottom(); return;
    }

    case '/model': {
      post({type:'get-models'});
      var sec4 = infoSection('Select model');
      var spinner4 = el('div', 'info-dim', 'Loading\u2026'); sec4.appendChild(spinner4); bottom();
      pendModels = function (ev) {
        sec4.innerHTML = '';
        var hdr4 = el('div', 'info-hdr', 'Available models'); sec4.appendChild(hdr4);
        if (!ev.models.length) { sec4.appendChild(el('div', 'info-dim', 'No models configured')); bottom(); return; }
        ev.models.forEach(function (m, i) {
          var isCur = ev.current && ev.current.model === m.modelName && ev.current.provider === m.providerName;
          var item = el('div', 'mp-item' + (isCur ? ' active' : ''));
          item.appendChild(el('span', 'mp-num', (i+1) + '.'));
          item.appendChild(el('span', 'mp-model', m.modelName));
          item.appendChild(el('span', 'mp-provider', m.providerName));
          if (isCur) item.appendChild(el('span', 'mp-cur', '\u25cf current'));
          item.onclick = (function (mm) { return function () {
            post({type:'set-model', providerName: mm.providerName, modelName: mm.modelName});
            sec4.innerHTML = '';
            sec4.appendChild(el('div', 'info-dim', 'Model set to ' + mm.modelName + ' \u00b7 ' + mm.providerName));
            bottom();
          }; })(m);
          sec4.appendChild(item);
        });
        sec4.appendChild(el('hr', 'info-hr'));
        sec4.appendChild(el('div', 'info-dim', 'Click to select'));
        bottom();
      };
      return;
    }

    case '/tasks': {
      post({type:'get-tasks'});
      var sec5 = infoSection('Tasks');
      var sp5 = el('div', 'info-dim', 'Loading\u2026'); sec5.appendChild(sp5); bottom();
      pendTasks = function (ev) {
        sec5.innerHTML = '';
        sec5.appendChild(el('div', 'info-hdr', 'Tasks (' + ev.tasks.length + ')'));
        if (!ev.tasks.length) { sec5.appendChild(el('div', 'info-dim', 'No tasks yet.')); bottom(); return; }
        var icons = {pending:'\u00b7', in_progress:'\u21bb', completed:'\u2713', blocked:'\u2717'};
        var colors = {pending:'info-dim', in_progress:'info-val', completed:'', blocked:'badge-err'};
        ev.tasks.forEach(function (t) {
          var row = el('div', 'info-row');
          row.appendChild(el('span', 'info-dim', (icons[t.status]||'\u00b7') + ' '));
          var ti = el('span', 'info-val'); ti.textContent = t.title.slice(0,52); row.appendChild(ti);
          row.appendChild(el('span', colors[t.status] || 'info-dim', '  ' + t.status));
          sec5.appendChild(row);
          if (t.description) { var sub = el('div', 'info-dim'); sub.style.paddingLeft='16px'; sub.textContent = t.description.slice(0,70); sec5.appendChild(sub); }
        });
        bottom();
      };
      return;
    }

    case '/memory': {
      post({type:'get-memory'});
      var sec6 = infoSection('Memory');
      var sp6 = el('div', 'info-dim', 'Loading\u2026'); sec6.appendChild(sp6); bottom();
      pendMemory = function (ev) {
        sec6.innerHTML = '';
        sec6.appendChild(el('div', 'info-hdr', 'Memory entries (' + ev.keys.length + ')'));
        if (!ev.keys.length) { sec6.appendChild(el('div', 'info-dim', 'No memory files.')); bottom(); return; }
        ev.keys.forEach(function (k) {
          var row = el('div', 'info-row');
          row.appendChild(el('span', 'info-dim', '\u2022 '));
          row.appendChild(el('span', 'info-val', k));
          sec6.appendChild(row);
        });
        bottom();
      };
      return;
    }

    case '/review': {
      post({type:'get-changes'});
      var sec7 = infoSection('Recent Changes');
      var sp7 = el('div', 'info-dim', 'Loading\u2026'); sec7.appendChild(sp7); bottom();
      pendChanges = function (ev) {
        sec7.innerHTML = '';
        if (!ev.changeGroup || !ev.changeGroup.changes.length) {
          sec7.appendChild(el('div', 'info-dim', 'No recent changes.')); bottom(); return;
        }
        var cg = ev.changeGroup;
        sec7.appendChild(el('div', 'info-hdr', 'Recent Changes  \u00b7  ' + cg.changes.length + ' files'));
        cg.changes.forEach(function (c) {
          var row = el('div', 'info-row');
          var fname = c.filePath.split('/').pop() || c.filePath;
          var typeEl = el('span', c.contentBefore === null ? 'diff-add' : 'info-val', c.contentBefore === null ? 'NEW   ' : 'MOD   ');
          var sup = el('span', c.superseded ? 'info-dim' : 'diff-add', c.superseded ? '\u2717 ' : '\u2713 ');
          row.appendChild(sup); row.appendChild(typeEl);
          row.appendChild(el('span', 'info-val', fname));
          row.appendChild(el('span', 'info-dim', '  +' + c.linesAdded + ' -' + c.linesRemoved));
          sec7.appendChild(row);
          var path = el('div', 'info-dim'); path.style.paddingLeft='16px'; path.textContent = c.filePath; sec7.appendChild(path);
        });
        sec7.appendChild(el('hr', 'info-hr'));
        sec7.appendChild(el('div', 'info-dim', '/rollback or /rollback <filename> to undo'));
        bottom();
      };
      return;
    }

    case '/rollback': {
      var target = arg || 'all';
      post({type:'rollback', target: target});
      var sec8 = infoSection('Rollback');
      var sp8 = el('div', 'info-dim', 'Rolling back ' + target + '\u2026'); sec8.appendChild(sp8); bottom();
      pendRollback = function (ev) {
        sec8.innerHTML = '';
        if (ev.success) {
          sec8.appendChild(el('div', 'diff-add', '\u2713 Rolled back ' + (ev.count || 1) + ' file(s)'));
        } else {
          sec8.appendChild(el('div', 'err-row', '\u2717 ' + (ev.error || 'Rollback failed')));
        }
        bottom();
      };
      return;
    }

    case '/agents': {
      post({type:'get-agents'});
      var sec9 = infoSection('PowerBus Agents');
      var sp9 = el('div', 'info-dim', 'Loading\u2026'); sec9.appendChild(sp9); bottom();
      pendAgents = function (ev) {
        sec9.innerHTML = '';
        sec9.appendChild(el('div', 'info-hdr', 'Connected agents (' + ev.agents.length + ')'));
        if (!ev.agents.length) { sec9.appendChild(el('div', 'info-dim', 'No agents registered.')); }
        ev.agents.forEach(function (a) {
          var row = el('div', 'info-row');
          row.appendChild(el('span', 'info-key', (a.displayName || a.agentId).slice(0,18)));
          row.appendChild(el('span', 'info-dim', a.capabilities.join(', ')));
          var up = Math.round((Date.now() - a.registeredAt) / 1000);
          row.appendChild(el('span', 'info-dim', '  ' + up + 's'));
          sec9.appendChild(row);
        });
        if (ev.history.length) {
          sec9.appendChild(el('hr', 'info-hr'));
          sec9.appendChild(el('div', 'info-hdr', 'Recent bus messages'));
          ev.history.slice(-10).forEach(function (m) {
            var row = el('div', 'info-row');
            var ts = new Date(m.timestamp).toLocaleTimeString();
            var preview = m.content.length > 50 ? m.content.slice(0, 50) + '\u2026' : m.content;
            row.appendChild(el('span', 'info-dim', ts + '  '));
            row.appendChild(el('span', 'info-val', m.from));
            row.appendChild(el('span', 'info-dim', ' \u2192 ' + m.to + '  [' + m.type + ']  '));
            row.appendChild(el('span', 'info-dim', preview));
            sec9.appendChild(row);
          });
        }
        bottom();
      };
      return;
    }

    case '/tools': {
      var sec10 = infoSection('Available Tools');
      var TOOL_SECTIONS = [
        ['Files',    'read  write  edit  multi_edit  list  glob  grep  notebook_edit'],
        ['Shell',    'bash'],
        ['Git',      'git_status  git_diff  git_log  git_add  git_commit  git_branch  git_stash  git_push  git_pull'],
        ['Search',   'web_search  web_fetch'],
        ['Memory',   'memory_read  memory_write  memory_list  memory_delete  memory_search'],
        ['Tasks',    'tasks_create  tasks_list  tasks_update  tasks_get  tasks_delete'],
        ['Agents',   'spawn_agent  get_agent_status  wait_for_agent  list_agents  send_message'],
        ['Workflow', 'enter_plan_mode  exit_plan_mode  enter_worktree  exit_worktree'],
        ['Schedule', 'cron_create  cron_list  cron_delete'],
        ['Run',      'run_tests  ask_user'],
      ];
      TOOL_SECTIONS.forEach(function (s) { infoRow(sec10, s[0], '<span class="info-dim">' + esc(s[1]) + '</span>'); });
      if (skills.length) {
        sec10.appendChild(el('hr', 'info-hr'));
        sec10.appendChild(el('div', 'info-hdr', 'CC Bundled Skills'));
        skills.forEach(function (s) { infoRow(sec10, '/' + s.name, esc(s.description)); });
      }
      bottom(); return;
    }

    case '/help': {
      var sec11 = infoSection('Commands');
      BUILTIN.forEach(function (c) { infoRow(sec11, c.cmd, '<span class="info-dim">' + esc(c.desc) + '</span>'); });
      if (skills.length) {
        sec11.appendChild(el('hr', 'info-hr'));
        sec11.appendChild(el('div', 'info-hdr', 'CC Bundled Skills'));
        skills.forEach(function (s) {
          var hint = s.argumentHint ? ' <span class="info-dim">' + esc(s.argumentHint) + '</span>' : '';
          infoRow(sec11, '/' + s.name, esc(s.description) + hint);
          if (s.aliases && s.aliases.length) {
            var sub = el('div', 'info-dim'); sub.style.paddingLeft='16px';
            sub.textContent = 'aliases: ' + s.aliases.map(function(a){return '/'+a;}).join(', ');
            sec11.appendChild(sub);
          }
        });
      }
      sec11.appendChild(el('hr', 'info-hr'));
      sec11.appendChild(el('div', 'info-dim', 'Shortcuts:  Esc to stop  \u00b7  \u2191\u2193 history  \u00b7  Tab autocomplete'));
      bottom(); return;
    }

    default: {
      // CC skill invocation
      var skillName = cmd.slice(1);
      var skill = skills.find(function (s) {
        return s.name === skillName || (s.aliases && s.aliases.indexOf(skillName) !== -1);
      });
      if (skill && sid) {
        $welcome.style.display = 'none';
        var sr = el('div', 'info-block');
        var sh = el('div', 'info-row');
        sh.appendChild(el('span', 'info-key', '&#9648; ' + skill.name));
        sh.appendChild(el('span', 'info-dim', skill.description));
        sr.appendChild(sh); $msgs.appendChild(sr); bottom();
        post({type:'invoke-skill', sessionId: sid, skillName: skill.name, args: arg});
        return;
      }
      appendMsg('err-row', 'Unknown command: ' + cmd + '  \u2014  /help for list');
      return;
    }
  }
}

// ── Send ──────────────────────────────────────────────────────────────────
function send() {
  var text = $input.value.trim();
  if (!text || busy) return;
  hideTA();
  if (text.startsWith('/')) { $input.value = ''; resize(); execSlash(text); return; }
  if (hist[hist.length - 1] !== text) hist.push(text);
  histIdx = hist.length;
  $input.value = ''; resize();
  if (!sid) { pendText = text; post({type:'create-session'}); return; }
  post({type:'send-message', sessionId: sid, text: text});
}

// ── Input events ──────────────────────────────────────────────────────────
$input.addEventListener('keydown', function (e) {
  if ($ta.classList.contains('on')) {
    if (e.key === 'ArrowUp') { e.preventDefault(); navTA(-1); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); navTA(1); return; }
    if (e.key === 'Tab') { e.preventDefault(); var sel = $ta.querySelector('.ta-item.sel') || $ta.querySelector('.ta-item'); if (sel) selectCmd(sel.dataset.cmd); return; }
    if (e.key === 'Enter' && taIdx >= 0) { e.preventDefault(); var asel = $ta.querySelector('.ta-item.sel'); if (asel) { selectCmd(asel.dataset.cmd); return; } }
    if (e.key === 'Escape') { hideTA(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); return; }
  if (e.key === 'Escape') { if (sid && busy) post({type:'cancel', sessionId: sid}); return; }
  if (e.key === 'ArrowUp' && !e.shiftKey && $input.value === '') {
    e.preventDefault(); if (histIdx > 0) { histIdx--; $input.value = hist[histIdx]; resize(); } return;
  }
  if (e.key === 'ArrowDown' && !e.shiftKey && histIdx >= 0) {
    e.preventDefault(); histIdx++; $input.value = histIdx < hist.length ? hist[histIdx] : ''; resize(); return;
  }
});
$input.addEventListener('input', function () {
  resize(); var v = $input.value;
  if (v.startsWith('/')) showTA(v); else hideTA();
});
$btnNew.addEventListener('click', function () { post({type:'create-session'}); });
$btnStop.addEventListener('click', function () { if (sid) post({type:'cancel', sessionId: sid}); });
function resize() { $input.style.height = 'auto'; $input.style.height = Math.min($input.scrollHeight, 120) + 'px'; }

// ── Messages from extension ───────────────────────────────────────────────
window.addEventListener('message', function (e) {
  var m = e.data;
  switch (m.type) {

    case 'session-created':
      sid = m.session.id; curSession = m.session;
      $msgs.innerHTML = ''; $msgs.appendChild($welcome); $welcome.style.display = 'block';
      $tokBan.className = ''; $ctxPct.textContent = ''; $ctxPct.className = 'ctx-pct';
      totalCost = 0; tokenPct = 100; updateCost();
      if (pendText) { var pt = pendText; pendText = null; post({type:'send-message', sessionId: sid, text: pt}); }
      break;

    case 'session-updated':
      if (m.sessionId === sid) {
        setBusy(m.status === 'busy' || m.status === 'compact');
        if (m.status === 'busy') startThinking();
      }
      break;

    case 'message-created':
      if (m.message.role === 'user') renderUser(m.message);
      else { mkAsstBlock(m.message.id); stopThinking(); }
      break;

    case 'part-updated':
      renderPart(m.messageId, m.part);
      if (m.part.type === 'tool' && m.part.state.status === 'completed') startThinking();
      break;

    case 'part-delta':
      applyDelta(m.messageId, m.partId, m.delta);
      break;

    case 'sessions-list':
      sessions = m.sessions || [];
      if (sessions.length && !sid) {
        sid = sessions[0].id; curSession = sessions[0];
      }
      break;

    case 'permission-request':
      renderPerm(m.request); setBusy(false); break;

    case 'user-question':
      renderQuestion(m.questionId, m.question); break;

    case 'error':
      appendMsg('err-row', '\u2717 ' + m.error); setBusy(false); break;

    case 'token-warning':
      tokenPct = m.percentLeft;
      $ctxPct.textContent = m.percentLeft + '% ctx';
      $ctxPct.className = 'ctx-pct ' + (m.isAtBlockingLimit ? 'crit' : 'warn');
      $tokBan.className = 'on' + (m.isAtBlockingLimit ? ' crit' : '');
      $tokMsg.textContent = m.isAtBlockingLimit
        ? '\u26a0 Context nearly full (' + m.percentLeft + '% left) \u2014 /compact required'
        : '\u2191 Context ' + (100 - m.percentLeft) + '% used \u2014 /compact recommended';
      break;

    case 'compact-started':
      var cr = el('div', 'step-div'); cr.id = 'compact-row';
      var chr = el('div', 'step-hr'); var cm = el('span', 'step-meta', '\u21e9 compacting\u2026');
      cr.appendChild(chr); cr.appendChild(cm); $msgs.appendChild(cr); bottom(); break;

    case 'compact-done':
      var crow = document.getElementById('compact-row');
      if (crow) crow.remove();
      $tokBan.className = ''; $ctxPct.textContent = '';
      tokenPct = 100; break;

    case 'skill-list':
      skills = m.skills || []; break;

    case 'session-cost':
      totalCost = m.cost.totalCostUSD || 0; updateCost(); break;

    case 'model-info':
      curModel = (m.model) ? {model: m.model, provider: m.provider || ''} : null;
      updateModelLabel(); break;

    // ── Pull responses ─────────────────────────────────────────────────
    case 'models-info':
      if (pendModels) { var fn0 = pendModels; pendModels = null; fn0(m); } break;
    case 'tasks-info':
      if (pendTasks) { var fn1 = pendTasks; pendTasks = null; fn1(m); } break;
    case 'memory-info':
      if (pendMemory) { var fn2 = pendMemory; pendMemory = null; fn2(m); } break;
    case 'changes-info':
      if (pendChanges) { var fn3 = pendChanges; pendChanges = null; fn3(m); } break;
    case 'rollback-result':
      if (pendRollback) { var fn4 = pendRollback; pendRollback = null; fn4(m); } break;
    case 'agents-info':
      if (pendAgents) { var fn5 = pendAgents; pendAgents = null; fn5(m); } break;

    case 'bus-message':
      if (m.messageType === 'broadcast') {
        try {
          var data = JSON.parse(m.content);
          if (data.type === 'blocking-violations-alert' && data.blockingCount > 0) {
            var vr = el('div', 'err-row');
            vr.textContent = '[checks] ' + data.blockingCount + ' blocking violation' + (data.blockingCount > 1 ? 's' : '');
            $msgs.appendChild(vr); bottom();
          }
        } catch (ex) { /* not JSON */ }
      }
      break;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────
post({type:'ready'});
post({type:'list-sessions'});

})();
</script>
</body>
</html>`;
}
