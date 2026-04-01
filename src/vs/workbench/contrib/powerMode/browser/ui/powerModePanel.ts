/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

/**
 * True TUI terminal interface for Power Mode.
 * Everything is a character on a grid. No CSS decorations.
 * Modeled after Claude Code / OpenCode ink TUI.
 */
export function getPowerModeHTML(nonce: string): string {
	return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style nonce="${nonce}">
		* { margin: 0; padding: 0; box-sizing: border-box; }

		body {
			font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'SF Mono', Menlo, Monaco, 'Courier New', monospace;
			background: #1a2332;
			color: #c8d3e0;
			height: 100vh;
			overflow: hidden;
			font-size: 13px;
			line-height: 1.45;
			-webkit-font-smoothing: antialiased;
		}

		::-webkit-scrollbar { width: 8px; }
		::-webkit-scrollbar-track { background: #1a2332; }
		::-webkit-scrollbar-thumb { background: #2a3a4e; }

		.shell { display: flex; flex-direction: column; height: 100vh; }

		/* ── Top bar ──────────────────────────────────────────── */
		.topbar {
			padding: 6px 12px;
			background: #151d2b;
			color: #7a8a9e;
			font-size: 13px;
			display: flex;
			justify-content: space-between;
			border-bottom: 1px solid #2a3545;
			flex-shrink: 0;
		}
		.topbar .brand { color: #5eaed6; font-weight: bold; }
		.topbar .agent-label { color: #7a8a9e; }
		.topbar .agent-name { color: #5ec990; font-weight: bold; }
		.topbar .sep { color: #3a4a5e; margin: 0 6px; }
		.topbar-right { display: flex; gap: 12px; align-items: center; }
		.topbar-action {
			background: none; border: none; color: #5a6a7e;
			font-family: inherit; font-size: 13px; cursor: pointer; padding: 0;
		}
		.topbar-action:hover { color: #c8d3e0; }
		.topbar-action.stop-btn { color: #d06060; display: none; }
		.topbar-action.stop-btn.on { display: inline; }
		.ctx-pct { font-size: 11px; color: #5a6a7e; }
		.ctx-pct.warn { color: #e0a84e; }
		.ctx-pct.danger { color: #d06060; }

		/* ── Token warning banner ─────────────────────────────── */
		.token-banner {
			display: none;
			background: #2a1a0a;
			border-bottom: 1px solid #5a3a1a;
			padding: 4px 12px;
			font-size: 12px;
			color: #e0a84e;
			flex-shrink: 0;
		}
		.token-banner.on { display: flex; justify-content: space-between; align-items: center; }
		.token-banner.blocking { background: #2a0a0a; border-bottom-color: #d06060; color: #d06060; }
		.token-banner button {
			background: none; border: 1px solid currentColor; color: inherit;
			font-family: inherit; font-size: 11px; cursor: pointer; padding: 1px 6px;
		}

		/* ── Compact status ───────────────────────────────────── */
		.compact-notice {
			display: none;
			background: #0a1a2a;
			border-bottom: 1px solid #1a3a5a;
			padding: 4px 12px;
			font-size: 12px;
			color: #5eaed6;
			flex-shrink: 0;
		}
		.compact-notice.on { display: block; }

		/* ── Scrollable output ────────────────────────────────── */
		.output { flex: 1; overflow-y: auto; padding: 8px 12px; }

		/* ── Welcome screen ───────────────────────────────────── */
		.welcome { text-align: center; padding: 60px 0 20px; color: #5a6a7e; }
		.welcome .title { color: #5eaed6; font-weight: bold; font-size: 14px; margin-bottom: 2px; }
		.welcome .sub { color: #4a5a6e; }
		.welcome .hint { margin-top: 16px; color: #4a5a6e; font-size: 12px; }
		.welcome .hint .key { color: #7a8a9e; background: #222e3e; padding: 1px 4px; }
		.welcome .cmds { margin-top: 12px; color: #3a4a5e; font-size: 11px; }
		.welcome .cmds span { color: #5a6a7e; }

		/* ── User input line ──────────────────────────────────── */
		.u-line { margin: 10px 0 2px; }
		.u-prompt { color: #5eaed6; }
		.u-text { color: #e0e8f0; }

		/* ── Assistant block ──────────────────────────────────── */
		.a-block { margin: 2px 0 10px; padding-left: 2px; }
		.a-text { color: #c8d3e0; white-space: pre-wrap; word-break: break-word; }
		.a-reasoning { color: #5a6a7e; white-space: pre-wrap; font-style: italic; }

		/* ── Tool call block ──────────────────────────────────── */
		.t-block { margin: 4px 0; }
		.t-header { cursor: pointer; user-select: none; }
		.t-icon { display: inline; }
		.t-icon.pending { color: #5a6a7e; }
		.t-icon.running { color: #5eaed6; }
		.t-icon.completed { color: #5ec990; }
		.t-icon.error { color: #d06060; }
		.t-name { color: #b08cd6; font-weight: bold; }
		.t-title { color: #7a8a9e; }
		.t-time { color: #4a5a6e; }
		.t-output {
			color: #5a6a7e; white-space: pre-wrap; font-size: 12px;
			max-height: 0; overflow: hidden; padding-left: 4px;
		}
		.t-output.open { max-height: 400px; overflow-y: auto; }
		.t-error { color: #d06060; font-size: 12px; padding-left: 4px; }

		/* ── Permission request ───────────────────────────────── */
		.perm-block {
			margin: 6px 0;
			border: 1px solid #2a3a5e;
			background: #111927;
			padding: 8px 10px;
		}
		.perm-block.danger-perm {
			border-color: #8a2020;
			background: #180e0e;
		}
		.perm-header { font-size: 12px; color: #7a8a9e; margin-bottom: 4px; }
		.perm-danger-badge {
			display: inline-block;
			background: #8a2020;
			color: #ffaaaa;
			font-size: 10px;
			padding: 0 4px;
			margin-right: 6px;
		}
		.perm-tool { color: #b08cd6; font-weight: bold; }
		.perm-preview {
			color: #c8d3e0; font-size: 12px; white-space: pre-wrap;
			background: #0d1520; padding: 4px 6px; margin: 4px 0;
			max-height: 120px; overflow-y: auto;
		}
		.perm-actions { display: flex; gap: 8px; margin-top: 6px; }
		.perm-btn {
			background: none; border: 1px solid; font-family: inherit;
			font-size: 12px; cursor: pointer; padding: 2px 10px;
		}
		.perm-btn.allow { border-color: #5ec990; color: #5ec990; }
		.perm-btn.allow:hover { background: #0a2a1a; }
		.perm-btn.allow-all { border-color: #5eaed6; color: #5eaed6; font-size: 11px; }
		.perm-btn.allow-all:hover { background: #0a1a2a; }
		.perm-btn.deny { border-color: #d06060; color: #d06060; }
		.perm-btn.deny:hover { background: #2a0a0a; }
		.perm-resolved { color: #4a5a6e; font-size: 11px; font-style: italic; }

		/* ── Ask-user question ────────────────────────────────── */
		.question-block {
			margin: 6px 0;
			border: 1px solid #2a4a2a;
			background: #0e160e;
			padding: 8px 10px;
		}
		.question-header { font-size: 12px; color: #5ec990; margin-bottom: 4px; }
		.question-text { color: #c8d3e0; margin-bottom: 6px; white-space: pre-wrap; }
		.question-input {
			width: 100%; background: #0d1520; border: 1px solid #2a4a2a;
			color: #e0e8f0; font-family: inherit; font-size: 12px;
			padding: 4px 6px; outline: none;
		}
		.question-send {
			margin-top: 4px; background: none; border: 1px solid #5ec990;
			color: #5ec990; font-family: inherit; font-size: 12px;
			cursor: pointer; padding: 2px 10px;
		}
		.question-resolved { color: #4a5a6e; font-size: 11px; font-style: italic; }

		/* ── Step marker ──────────────────────────────────────── */
		.step-mark { color: #3a4a5e; font-size: 12px; margin: 4px 0; }

		/* ── Spinner ──────────────────────────────────────────── */
		.spinner { color: #5a6a7e; font-size: 12px; margin: 4px 0 4px 2px; display: none; }
		.spinner.on { display: block; }
		.spinner .dots::after {
			content: ''; animation: d 1.2s steps(4) infinite;
		}
		@keyframes d {
			0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; }
		}

		/* ── Error ────────────────────────────────────────────── */
		.err-line { color: #d06060; margin: 2px 0; }

		/* ── Prompt area ──────────────────────────────────────── */
		.prompt-area {
			background: #151d2b;
			border-top: 1px solid #2a3545;
			padding: 0 12px 4px;
			flex-shrink: 0;
			position: relative;
		}

		/* ── Slash typeahead ──────────────────────────────────── */
		.typeahead {
			display: none;
			position: absolute;
			bottom: 100%;
			left: 12px; right: 12px;
			background: #111927;
			border: 1px solid #2a3a5e;
			max-height: 180px;
			overflow-y: auto;
		}
		.typeahead.on { display: block; }
		.ta-item {
			padding: 5px 10px;
			cursor: pointer;
			display: flex;
			gap: 10px;
			align-items: baseline;
		}
		.ta-item:hover, .ta-item.selected { background: #1a2a3a; }
		.ta-cmd { color: #5eaed6; }
		.ta-desc { color: #5a6a7e; font-size: 11px; }

		.prompt-row { display: flex; align-items: flex-end; padding-top: 6px; }
		.prompt-char { color: #5eaed6; font-weight: bold; padding-right: 6px; padding-bottom: 1px; flex-shrink: 0; }

		#input {
			flex: 1; background: none; border: none; color: #e0e8f0;
			font-family: inherit; font-size: 13px; line-height: 1.45;
			resize: none; outline: none; max-height: 100px; min-height: 19px;
		}
		#input::placeholder { color: #3a4a5e; }
		#input:disabled { opacity: 0.5; }

		.prompt-hints { font-size: 11px; color: #3a4a5e; padding: 2px 0 0 0; }
		.prompt-hints .key { color: #5a6a7e; background: #222e3e; padding: 0 3px; font-size: 10px; }
	</style>
</head>
<body>
	<div class="shell">
		<div class="topbar">
			<div>
				<span class="brand">neural inverse</span>
				<span class="sep">|</span>
				<span class="agent-label">agent: </span><span class="agent-name" id="agentName">build</span>
				<span id="sessionInfo"></span>
			</div>
			<div class="topbar-right">
				<span class="ctx-pct" id="ctxPct"></span>
				<button class="topbar-action" id="btnNew">new session</button>
				<button class="topbar-action stop-btn" id="btnStop">stop</button>
			</div>
		</div>

		<div class="token-banner" id="tokenBanner">
			<span id="tokenBannerMsg"></span>
			<button onclick="triggerCompact()">compact now</button>
		</div>
		<div class="compact-notice" id="compactNotice">compacting context\u2026</div>

		<div class="output" id="output">
			<div class="welcome" id="welcome">
				<div class="title">neural inverse power mode</div>
				<div class="sub">agentic coding terminal</div>
				<div class="hint">Type a task below and press <span class="key">Enter</span> to start</div>
				<div class="cmds">
					slash commands: <span>/compact</span> &nbsp; <span>/clear</span> &nbsp; <span>/review</span> &nbsp; <span>/memory</span> &nbsp; <span>/help</span>
				</div>
			</div>
			<div id="stream"></div>
			<div class="spinner" id="spinner"><span class="dots">thinking</span></div>
		</div>

		<div class="prompt-area">
			<div class="typeahead" id="typeahead"></div>
			<div class="prompt-row">
				<span class="prompt-char">&gt;</span>
				<textarea id="input" rows="1" placeholder="What do you want to build?" autofocus></textarea>
			</div>
			<div class="prompt-hints">
				<span class="key">Enter</span> send &nbsp;&nbsp;
				<span class="key">Shift+Enter</span> newline &nbsp;&nbsp;
				<span class="key">\u2191\u2193</span> history &nbsp;&nbsp;
				<span class="key">/</span> commands
			</div>
		</div>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const $ = id => document.getElementById(id);
		const input = $('input');
		const output = $('output');
		const stream = $('stream');
		const welcome = $('welcome');
		const spinner = $('spinner');
		const btnStop = $('btnStop');
		const btnNew = $('btnNew');
		const agentName = $('agentName');
		const typeahead = $('typeahead');
		const tokenBanner = $('tokenBanner');
		const compactNotice = $('compactNotice');
		const ctxPct = $('ctxPct');

		let sid = null;
		let busy = false;
		let pending = null;

		// ── Command history ─────────────────────────────────────────────
		const hist = [];
		let histIdx = -1;

		// ── Slash commands ──────────────────────────────────────────────
		const SLASH_CMDS = [
			{ cmd: '/compact',  desc: 'Summarise and compress conversation context' },
			{ cmd: '/clear',    desc: 'Clear all messages in this session' },
			{ cmd: '/review',   desc: 'Review recent file changes' },
			{ cmd: '/memory',   desc: 'List memory files' },
			{ cmd: '/help',     desc: 'Show available commands' },
		];

		function filterCmds(prefix) {
			return SLASH_CMDS.filter(c => c.cmd.startsWith(prefix));
		}

		let taIdx = -1;

		function showTypeahead(prefix) {
			const matches = filterCmds(prefix);
			if (!matches.length) { hideTypeahead(); return; }
			typeahead.innerHTML = matches.map((c, i) =>
				'<div class="ta-item" data-cmd="' + c.cmd + '" onclick="selectCmd(\\'' + c.cmd + '\\')">' +
				'<span class="ta-cmd">' + c.cmd + '</span>' +
				'<span class="ta-desc">' + c.desc + '</span>' +
				'</div>'
			).join('');
			taIdx = -1;
			typeahead.className = 'typeahead on';
		}

		function hideTypeahead() {
			typeahead.className = 'typeahead';
			typeahead.innerHTML = '';
			taIdx = -1;
		}

		function selectCmd(cmd) {
			input.value = cmd + ' ';
			hideTypeahead();
			input.focus();
		}

		function navigateTypeahead(dir) {
			const items = typeahead.querySelectorAll('.ta-item');
			if (!items.length) return false;
			items.forEach(el => el.classList.remove('selected'));
			taIdx = (taIdx + dir + items.length) % items.length;
			items[taIdx].classList.add('selected');
			return true;
		}

		// ── Send ────────────────────────────────────────────────────────
		function send() {
			const t = input.value.trim();
			if (!t) return;

			// Handle slash commands client-side
			if (t === '/compact') {
				input.value = ''; resize();
				if (sid) vscode.postMessage({ type: 'compact', sessionId: sid });
				return;
			}
			if (t === '/clear') {
				input.value = ''; resize();
				stream.innerHTML = '';
				welcome.style.display = 'block';
				hist.length = 0; histIdx = -1;
				return;
			}
			if (t === '/help') {
				input.value = ''; resize();
				const helpDiv = document.createElement('div');
				helpDiv.className = 'step-mark';
				helpDiv.textContent = SLASH_CMDS.map(c => c.cmd + '  ' + c.desc).join('\\n');
				stream.appendChild(helpDiv);
				bottom();
				return;
			}

			if (busy) return;

			// Push to history (avoid duplicates at top)
			if (hist[hist.length - 1] !== t) { hist.push(t); }
			histIdx = hist.length;

			input.value = ''; resize();
			hideTypeahead();

			if (!sid) { pending = t; vscode.postMessage({ type: 'create-session' }); return; }
			vscode.postMessage({ type: 'send-message', sessionId: sid, text: t });
		}

		// ── Input event handlers ────────────────────────────────────────
		input.addEventListener('keydown', e => {
			// Typeahead navigation
			if (typeahead.classList.contains('on')) {
				if (e.key === 'ArrowUp') { e.preventDefault(); navigateTypeahead(-1); return; }
				if (e.key === 'ArrowDown') { e.preventDefault(); navigateTypeahead(1); return; }
				if (e.key === 'Tab' || e.key === 'Enter') {
					const sel = typeahead.querySelector('.ta-item.selected') || typeahead.querySelector('.ta-item');
					if (sel && e.key === 'Tab') { e.preventDefault(); selectCmd(sel.dataset.cmd); return; }
				}
				if (e.key === 'Escape') { hideTypeahead(); return; }
			}

			if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); return; }

			// History navigation
			if (e.key === 'ArrowUp' && !e.shiftKey && input.value === '') {
				e.preventDefault();
				if (histIdx > 0) { histIdx--; input.value = hist[histIdx]; resize(); }
				return;
			}
			if (e.key === 'ArrowDown' && !e.shiftKey && histIdx >= 0) {
				e.preventDefault();
				histIdx++;
				input.value = histIdx < hist.length ? hist[histIdx] : '';
				resize();
				return;
			}
		});

		input.addEventListener('input', () => {
			resize();
			const v = input.value;
			if (v.startsWith('/')) { showTypeahead(v); }
			else { hideTypeahead(); }
		});

		btnStop.addEventListener('click', () => { if (sid) vscode.postMessage({ type: 'cancel', sessionId: sid }); });
		btnNew.addEventListener('click', () => vscode.postMessage({ type: 'create-session' }));

		function triggerCompact() {
			if (sid) vscode.postMessage({ type: 'compact', sessionId: sid });
		}

		function resize() {
			input.style.height = 'auto';
			input.style.height = Math.min(input.scrollHeight, 100) + 'px';
		}

		function bottom() { output.scrollTop = output.scrollHeight; }

		function esc(s) {
			const d = document.createElement('span');
			d.textContent = s;
			return d.innerHTML;
		}

		function setBusy(b) {
			busy = b;
			btnStop.className = 'topbar-action stop-btn' + (b ? ' on' : '');
			spinner.className = 'spinner' + (b ? ' on' : '');
			input.disabled = b;
		}

		// ── Render helpers ──────────────────────────────────────────────
		function userLine(msg) {
			welcome.style.display = 'none';
			const text = msg.parts && msg.parts[0] ? msg.parts[0].text : '';
			const div = document.createElement('div');
			div.className = 'u-line';
			div.innerHTML = '<span class="u-prompt">\\u276f </span><span class="u-text">' + esc(text) + '</span>';
			stream.appendChild(div);
			bottom();
		}

		function assistantStart(msg) {
			const div = document.createElement('div');
			div.className = 'a-block';
			div.id = 'a-' + msg.id;
			stream.appendChild(div);
			bottom();
		}

		function part(mid, p) {
			const box = $('a-' + mid);
			if (!box) return;
			let el = $('p-' + p.id);

			switch (p.type) {
				case 'text':
					if (!el) { el = document.createElement('div'); el.id = 'p-' + p.id; el.className = 'a-text'; box.appendChild(el); }
					el.textContent = p.text;
					break;

				case 'reasoning':
					if (!el) { el = document.createElement('div'); el.id = 'p-' + p.id; el.className = 'a-reasoning'; box.appendChild(el); }
					el.textContent = p.text;
					break;

				case 'tool': {
					if (!el) { el = document.createElement('div'); el.id = 'p-' + p.id; el.className = 't-block'; box.appendChild(el); }
					const st = p.state;
					const ic = { pending: '\\u25cb', running: '\\u25cf', completed: '\\u2713', error: '\\u2717' };
					let tm = '';
					if (st.time && st.time.end) tm = ' ' + ((st.time.end - st.time.start) / 1000).toFixed(1) + 's';

					let h = '<div class="t-header" onclick="var o=this.nextElementSibling;if(o)o.classList.toggle(\\\'open\\\')">';
					h += '<span class="t-icon ' + st.status + '">' + (ic[st.status] || '') + '</span> ';
					h += '<span class="t-name">' + esc(p.toolName) + '</span>';
					if (st.title) h += ' <span class="t-title">' + esc(st.title) + '</span>';
					if (tm) h += ' <span class="t-time">' + tm + '</span>';
					h += '</div>';

					if (st.output) {
						const preview = st.output.length > 600 ? st.output.substring(0, 600) + '\\n...' : st.output;
						h += '<div class="t-output">' + esc(preview) + '</div>';
					}
					if (st.error) h += '<div class="t-error">' + esc(st.error) + '</div>';
					el.innerHTML = h;
					break;
				}

				case 'step-start':
					break;

				case 'step-finish': {
					if (!el) {
						el = document.createElement('div');
						el.id = 'p-' + p.id;
						el.className = 'step-mark';
						let lbl = '---';
						if (p.tokens) {
							lbl = '--- ' + p.tokens.input.toLocaleString() + ' in / ' + p.tokens.output.toLocaleString() + ' out';
						}
						if (p.cost != null) {
							const costStr = p.cost > 0.5
								? '$' + p.cost.toFixed(2)
								: '$' + p.cost.toFixed(4);
							lbl += '  ' + costStr;
						}
						el.textContent = lbl;
						box.appendChild(el);
					}
					break;
				}
			}
			bottom();
		}

		// ── Permission request ──────────────────────────────────────────
		function renderPermissionRequest(req) {
			welcome.style.display = 'none';
			const el = document.createElement('div');
			el.id = 'perm-' + req.requestId;
			el.className = 'perm-block' + (req.danger ? ' danger-perm' : '');

			let h = '<div class="perm-header">';
			if (req.danger) h += '<span class="perm-danger-badge">\u26a0 DANGEROUS</span>';
			h += 'Tool permission required: <span class="perm-tool">' + esc(req.toolName) + '</span></div>';
			h += '<pre class="perm-preview">' + esc(req.preview || '') + '</pre>';
			h += '<div class="perm-actions">';
			h += '<button class="perm-btn allow" onclick="respondPerm(\\'' + req.requestId + '\\', \\'allow\\')">Allow</button>';
			h += '<button class="perm-btn allow-all" onclick="respondPerm(\\'' + req.requestId + '\\', \\'allow-all\\')">Allow All</button>';
			h += '<button class="perm-btn deny" onclick="respondPerm(\\'' + req.requestId + '\\', \\'deny\\')">Deny</button>';
			h += '</div>';
			el.innerHTML = h;
			stream.appendChild(el);
			bottom();
		}

		function respondPerm(requestId, decision) {
			const el = $('perm-' + requestId);
			if (el) {
				const lbl = decision === 'deny' ? 'denied' : (decision === 'allow-all' ? 'allowed (all)' : 'allowed');
				el.innerHTML = '<span class="perm-resolved">Permission ' + lbl + ' for ' + requestId + '</span>';
			}
			vscode.postMessage({ type: 'permission-response', requestId, decision });
		}

		// ── User question ───────────────────────────────────────────────
		function renderUserQuestion(questionId, question) {
			welcome.style.display = 'none';
			const el = document.createElement('div');
			el.id = 'question-' + questionId;
			el.className = 'question-block';
			el.innerHTML =
				'<div class="question-header">? Question from agent</div>' +
				'<div class="question-text">' + esc(question) + '</div>' +
				'<input class="question-input" id="qi-' + questionId + '" placeholder="Your answer\u2026" />' +
				'<button class="question-send" onclick="sendAnswer(\\'' + questionId + '\\')">Send</button>';
			stream.appendChild(el);
			const qi = $('qi-' + questionId);
			if (qi) {
				qi.addEventListener('keydown', e => {
					if (e.key === 'Enter') { e.preventDefault(); sendAnswer(questionId); }
				});
				qi.focus();
			}
			bottom();
		}

		function sendAnswer(questionId) {
			const qi = $('qi-' + questionId);
			const answer = qi ? qi.value.trim() : '';
			const el = $('question-' + questionId);
			if (el) {
				el.innerHTML = '<span class="question-resolved">Answered: ' + esc(answer || '(empty)') + '</span>';
			}
			vscode.postMessage({ type: 'question-response', questionId, answer: answer || '' });
		}

		// ── Messages from extension ─────────────────────────────────────
		window.addEventListener('message', e => {
			const m = e.data;
			switch (m.type) {
				case 'session-created':
					sid = m.session.id;
					agentName.textContent = m.session.agentId;
					stream.innerHTML = '';
					welcome.style.display = 'block';
					tokenBanner.className = 'token-banner';
					compactNotice.className = 'compact-notice';
					ctxPct.textContent = '';
					if (pending) {
						const t = pending; pending = null;
						vscode.postMessage({ type: 'send-message', sessionId: sid, text: t });
					}
					break;

				case 'session-updated':
					setBusy(m.status === 'busy' || m.status === 'compact');
					if (m.status === 'compact') {
						compactNotice.className = 'compact-notice on';
					} else {
						compactNotice.className = 'compact-notice';
					}
					break;

				case 'compact-started':
					compactNotice.className = 'compact-notice on';
					break;

				case 'compact-done':
					compactNotice.className = 'compact-notice';
					tokenBanner.className = 'token-banner';
					ctxPct.textContent = '';
					break;

				case 'token-warning': {
					const pct = m.percentLeft;
					ctxPct.textContent = pct + '% ctx left';
					ctxPct.className = 'ctx-pct' + (m.isAtBlockingLimit ? ' danger' : ' warn');
					tokenBanner.className = 'token-banner on' + (m.isAtBlockingLimit ? ' blocking' : '');
					const bannerMsg = m.isAtBlockingLimit
						? '\u26a0 Context nearly full \u2014 compact required before next message'
						: '\u2191 Context ' + (100 - pct) + '% used \u2014 consider compacting';
					$('tokenBannerMsg').textContent = bannerMsg;
					break;
				}

				case 'message-created':
					if (m.message.role === 'user') userLine(m.message);
					else assistantStart(m.message);
					break;

				case 'part-updated':
					part(m.messageId, m.part);
					break;

				case 'part-delta': {
					const el = $('p-' + m.partId);
					if (el) { el.textContent = (el.textContent || '') + m.delta; bottom(); }
					break;
				}

				case 'sessions-list':
					if (m.sessions.length > 0 && !sid) {
						sid = m.sessions[0].id;
						agentName.textContent = m.sessions[0].agentId;
					}
					break;

				case 'permission-request':
					renderPermissionRequest(m.request);
					break;

				case 'user-question':
					renderUserQuestion(m.questionId, m.question);
					break;

				case 'bus-message':
					// Currently ignored \u2014 could add bus message display later
					break;

				case 'error': {
					welcome.style.display = 'none';
					const err = document.createElement('div');
					err.className = 'err-line';
					err.textContent = 'error: ' + m.error;
					stream.appendChild(err);
					bottom();
					break;
				}
			}
		});

		vscode.postMessage({ type: 'ready' });
		vscode.postMessage({ type: 'list-sessions' });
	</script>
</body>
</html>`;
}
