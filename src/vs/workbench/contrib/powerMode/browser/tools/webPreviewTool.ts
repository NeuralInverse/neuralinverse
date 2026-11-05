/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *
 *  Web Preview Tool — Browser automation with visual feedback loop for Power Mode agents.
 *--------------------------------------------------------------------------------------------*/

import { definePowerTool } from './powerToolRegistry.js';
import { IToolContext, IToolResult, IPowerTool } from '../../common/powerModeTypes.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IExternalCommandExecutor } from '../../../void/browser/externalCommandExecutor.js';
import * as path from 'path';

const DEFAULT_PORT = 3000;
const SCREENSHOT_DIR = '/tmp/neuralinverse-previews';

const _WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
function _isAbsolute(p: string): boolean {
	return p.startsWith('/') || _WIN_DRIVE_RE.test(p);
}
function _resolve(workingDirectory: string, filePath: string): string {
	if (_isAbsolute(filePath)) { return filePath; }
	const base = workingDirectory.replace(/\\/g, '/');
	const rel = filePath.replace(/\\/g, '/');
	return base + (base.endsWith('/') ? '' : '/') + rel;
}

export function createWebPreviewTool(
	workingDirectory: string,
	fileService: IFileService,
	commandExecutor: IExternalCommandExecutor,
): IPowerTool {
	return definePowerTool(
		'web_preview',
		`Launch or connect to a local web server, open it in a real Chromium browser,
take a full-page screenshot, and capture console errors + network failures.

Use this to visually verify your app after making changes. The agent can
iterate: edit code → run web_preview → inspect screenshot + errors → fix → repeat.

Vision feedback loop: With a vision-capable model (e.g. nvidia/nemotron-3.5-super-vl-120b-a12b),
the agent can analyze the screenshot directly to spot layout, styling, or rendering bugs.

Parameters:
- url: The URL to open (e.g. "http://localhost:3000"). If omitted, auto-detects from package.json dev script.
- command: Optional shell command to start the dev server (e.g. "npm run dev"). Auto-detected if omitted.
- port: The port the server runs on (default: 3000).
- waitFor: Optional CSS selector to wait for before screenshotting (e.g. "h1", "#root").
- fullPage: If true, capture the entire page (default: true).
- killServer: If true, stop the dev server after previewing (default: false).

Returns:
- screenshotPath: Absolute path to the saved PNG screenshot.
- screenshotDataUrl: Base64 data URL of the screenshot (for vision model analysis).
- consoleErrors: Array of console error messages from the page.
- networkErrors: Array of failed network requests.
- pageTitle: The page's <title>.
- url: The final URL that was opened.
- issues: Auto-detected problems and suggested fixes.

Example:
  web_preview({ url: "http://localhost:3000", waitFor: "#app", fullPage: true })`,
		[
			{ name: 'url', type: 'string', description: 'URL to open (e.g. http://localhost:3000). Auto-detected if omitted.', required: false },
			{ name: 'command', type: 'string', description: 'Command to start the dev server (e.g. "npm run dev"). Auto-detected from package.json if omitted.', required: false },
			{ name: 'port', type: 'number', description: 'Port the server listens on (default: 3000).', required: false },
			{ name: 'waitFor', type: 'string', description: 'CSS selector to wait for before screenshotting (e.g. "#root", "h1").', required: false },
			{ name: 'fullPage', type: 'boolean', description: 'Capture the entire page height (default: true).', required: false },
			{ name: 'killServer', type: 'boolean', description: 'Stop the dev server after previewing (default: false).', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const url = args.url as string | undefined;
			const command = args.command as string | undefined;
			const port = (args.port as number) ?? DEFAULT_PORT;
			const waitFor = args.waitFor as string | undefined;
			const fullPage = args.fullPage ?? true;
			const killServer = args.killServer ?? false;

			ctx.metadata({ title: `Web Preview: ${url ?? 'auto-detect'}` });

			// Ensure screenshot directory exists
			const screenshotDirUri = URI.file(SCREENSHOT_DIR);
			try { await fileService.createFolder(screenshotDirUri); } catch { /* already exists */ }

			let startedServer = false;
			let startCommand: string | undefined = command;

			try {
				// ── 1. Determine URL ──
				let targetUrl = url;

				if (!targetUrl) {
					const pkgUri = URI.file(path.join(workingDirectory, 'package.json'));
					let pkgContent: string;
					try {
						const content = await fileService.readFile(pkgUri);
						pkgContent = content.value.toString();
					} catch {
						return {
							title: 'Web Preview Failed',
							output: 'No URL provided and could not read package.json. Please provide a `url` or `command`.',
							metadata: { error: true },
						};
					}
					let pkg: any;
					try { pkg = JSON.parse(pkgContent); } catch {
						return {
							title: 'Web Preview Failed',
							output: 'package.json is not valid JSON.',
							metadata: { error: true },
						};
					}
					const scripts = pkg.scripts || {};
					for (const name of ['dev', 'start', 'serve', 'preview']) {
						if (scripts[name]) {
							startCommand = name;
							targetUrl = `http://localhost:${port}`;
							break;
						}
					}
					if (!targetUrl) {
						return {
							title: 'Web Preview Failed',
							output: 'No URL provided and no dev/start/serve/preview script found in package.json.',
							metadata: { error: true },
						};
					}
				}

				// ── 2. Start dev server if port not already in use ──
				const portCheckCommand = process.platform === 'win32'
					? `(echo > /dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo IN_USE || echo FREE`
					: `(echo > /dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo IN_USE || echo FREE`;
				let portStatus = 'UNKNOWN';
				try {
					const result = await commandExecutor.execute(
						`portcheck_${Date.now()}`,
						portCheckCommand,
						5000,
						1024
					);
					portStatus = result.trim();
				} catch { /* ignore */ }

				if (portStatus !== 'IN_USE') {
					if (!startCommand) {
						return {
							title: 'Web Preview Failed',
							output: `Port ${port} is not in use and no start command was provided. Please provide a \`command\` (e.g. "npm run dev").`,
							metadata: { error: true },
						};
					}

					ctx.metadata({ title: `Starting dev server: ${startCommand}` });

					const fullCommand = `cd ${_shellQuote(workingDirectory)} && ${startCommand}`;
					const jobId = `webprev_server_${Date.now()}`;

					await commandExecutor.execute(
						jobId,
						`(${fullCommand}) > /tmp/ni_webprev_server.log 2>&1 & echo $!`,
						10000,
						10 * 1024
					);

					startedServer = true;

					// Wait for server to become reachable
					let serverReady = false;
					for (let i = 0; i < 45; i++) {
						await new Promise(r => setTimeout(r, 1000));
						try {
							const checkResult = await commandExecutor.execute(
								`urlcheck_${Date.now()}`,
								`curl -s -o /dev/null -w "%{http_code}" "${targetUrl}" --max-time 3 2>/dev/null || echo "FAILED"`,
								10000,
								1024
							);
							if (checkResult.trim() && checkResult.trim() !== 'FAILED' && checkResult.trim() !== '000') {
								serverReady = true;
								break;
							}
						} catch { /* not yet */ }
					}

					if (!serverReady) {
						const serverLog = await _readFileSafe(fileService, URI.file('/tmp/ni_webprev_server.log'));
						return {
							title: 'Dev Server Failed to Start',
							output: `Started "${startCommand}" but ${targetUrl} did not respond within 45 seconds.\n\nServer output:\n${serverLog.slice(-2000)}`,
							metadata: { error: true },
						};
					}
				}

				// ── 3. Launch Chromium via Playwright using Node.js script ──
				const screenshotFileName = `preview-${Date.now()}.png`;
				const screenshotPath = _resolve(SCREENSHOT_DIR, screenshotFileName);
				const screenshotUri = URI.file(screenshotPath);

				// Build a Node.js script that uses Playwright to take the screenshot
				const playwrightScript = `
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-gpu'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const consoleErrors = [];
  const networkErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(\`[\${msg.type()}] \${msg.text()}\`); });
  page.on('pageerror', err => consoleErrors.push(\`[page error] \${err.message}\`));
  page.on('requestfailed', req => networkErrors.push(\`[\${req.method()}] \${req.url()} \${req.failure()?.errorText ?? 'failed'}\`));
  page.on('response', res => { if (res.status() >= 400) networkErrors.push(\`[\${res.status()}] \${res.url()}\`); });
  await page.goto('${targetUrl.replace(/'/g, "\\'")}', { waitUntil: 'domcontentloaded', timeout: 30000 });
  ${waitFor ? `try { await page.waitForSelector('${waitFor.replace(/'/g, "\\'")}', { timeout: 10000 }); } catch {}` : ''}
  await new Promise(r => setTimeout(r, 1000));
  const title = await page.title().catch(() => '(unknown)');
  const buf = await page.screenshot({ fullPage: ${fullPage}, type: 'png' });
  await browser.close();
  process.stdout.write(JSON.stringify({ title, consoleErrors, networkErrors, screenshot: buf.toString('base64') }));
})();
`;

				const scriptPath = '/tmp/ni_webprev_script.js';
				await fileService.writeFile(URI.file(scriptPath), VSBuffer.fromString(playwrightScript));

				ctx.metadata({ title: 'Capturing screenshot with Chromium...' });

				const pwResult = await commandExecutor.execute(
					`webprev_pw_${Date.now()}`,
					`node "${scriptPath}"`,
					60000,
					5 * 1024 * 1024
				);

				let pwData: { title: string; consoleErrors: string[]; networkErrors: string[]; screenshot: string };
				try {
					pwData = JSON.parse(pwResult.trim());
				} catch {
					return {
						title: 'Playwright Failed',
						output: `Playwright script failed:\n${pwResult.slice(-3000)}`,
						metadata: { error: true },
					};
				}

				// ── 4. Read the saved screenshot ──
				let screenshotDataUrl = '';
				try {
					const screenshotContent = await fileService.readFile(screenshotUri);
					const buf = screenshotContent.value as unknown as Buffer;
					screenshotDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
				} catch {
					// If the script didn't save to file, use the base64 from stdout
					screenshotDataUrl = `data:image/png;base64,${pwData.screenshot}`;
				}

				// ── 5. Auto-detect issues ──
				const issues: string[] = [];
				if (pwData.consoleErrors.length > 0) {
					issues.push(`${pwData.consoleErrors.length} console error(s) detected`);
				}
				if (pwData.networkErrors.length > 0) {
					issues.push(`${pwData.networkErrors.length} network error(s) detected`);
				}
				if (!pwData.title || pwData.title === '(unknown)') {
					issues.push('Page title is missing or empty');
				}

				const suggestion = issues.length > 0
					? `Suggested fixes:\n${issues.map(i => `- ${i}`).join('\n')}\n\nEdit the relevant files and run web_preview again to verify.`
					: 'No issues detected. The page loaded cleanly.';

				const output = [
					`Web Preview Complete`,
					`====================`,
					`URL: ${targetUrl}`,
					`Page Title: ${pwData.title}`,
					`Screenshot: ${screenshotPath}`,
					`Console Errors: ${pwData.consoleErrors.length}`,
					`Network Errors: ${pwData.networkErrors.length}`,
					`\n${suggestion}`,
					...(pwData.consoleErrors.length > 0 ? [`\nConsole Errors:\n${pwData.consoleErrors.join('\n')}`] : []),
					...(pwData.networkErrors.length > 0 ? [`\nNetwork Errors:\n${pwData.networkErrors.join('\n')}`] : []),
				].join('\n');

				return {
					title: `Web Preview: ${pwData.title}`,
					output,
					metadata: {
						url: targetUrl,
						pageTitle: pwData.title,
						screenshotPath,
						screenshotDataUrl,
						consoleErrors: pwData.consoleErrors,
						networkErrors: pwData.networkErrors,
						issues,
						startedServer,
						killServer,
					},
				};
			} catch (err: any) {
				return {
					title: 'Web Preview Failed',
					output: `Error: ${err.message}`,
					metadata: { error: true },
				};
			} finally {
				if (killServer && startedServer && startCommand) {
					try {
						await commandExecutor.execute(
							`webprev_kill_${Date.now()}`,
							`pkill -f "${_shellQuote(startCommand)}" 2>/dev/null || true`,
							10000,
							1024
						);
					} catch { /* ignore */ }
				}
			}
		},
	);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function _readFileSafe(fileService: IFileService, uri: URI): Promise<string> {
	try {
		const content = await fileService.readFile(uri);
		return content.value.toString();
	} catch {
		return '';
	}
}

function _shellQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
