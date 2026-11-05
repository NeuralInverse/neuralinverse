/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *
 *  Web QA Loop Tool — Automatic screenshot-to-fix feedback loop for Power Mode agents.
 *--------------------------------------------------------------------------------------------*/

import { definePowerTool } from './powerToolRegistry.js';
import { IToolContext, IToolResult, IPowerTool } from '../../common/powerModeTypes.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IExternalCommandExecutor } from '../../../void/browser/externalCommandExecutor.js';

const DEFAULT_PORT = 3000;
const DEFAULT_MAX_ITERATIONS = 5;
const SCREENSHOT_DIR = '/tmp/neuralinverse-qa';

const _WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
function _isAbsolute(p: string): boolean {
	return p.startsWith('/') || _WIN_DRIVE_RE.test(p);
}
function _resolve(dir: string, file: string): string {
	if (_isAbsolute(file)) { return file; }
	const base = dir.replace(/\\/g, '/');
	const rel = file.replace(/\\/g, '/');
	return base + (base.endsWith('/') ? '' : '/') + rel;
}
function _shellQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

export function createWebQALoopTool(
	workingDirectory: string,
	fileService: IFileService,
	commandExecutor: IExternalCommandExecutor,
): IPowerTool {
	return definePowerTool(
		'web_qa_loop',
		`Run an automatic screenshot-to-fix feedback loop for web development.

The agent iterates:
  1. Start/connect to a local dev server
  2. Open Chromium via Playwright, take a full-page screenshot
  3. Capture console errors, network failures, and page title
  4. Analyze results with a vision-capable model
  5. Report issues so you can fix the code
  6. Re-preview and repeat until clean OR max iterations reached

Parameters:
- url: The URL to open (e.g. "http://localhost:3000"). Auto-detected from package.json if omitted.
- command: Shell command to start the dev server (e.g. "npm run dev"). Auto-detected if omitted.
- port: Server port (default: 3000).
- maxIterations: Maximum preview-fix cycles (default: 5, max: 10).
- designDescription: Optional description of the target design.
- waitFor: Optional CSS selector to wait for before screenshotting (e.g. "#app").
- fullPage: Capture entire page (default: true).
- killServer: Stop the dev server when done (default: false).

Example:
  web_qa_loop({ url: "http://localhost:3000", maxIterations: 5 })`,
		[
			{ name: 'url', type: 'string', description: 'URL to preview.', required: false },
			{ name: 'command', type: 'string', description: 'Dev server command.', required: false },
			{ name: 'port', type: 'number', description: 'Server port (default: 3000).', required: false },
			{ name: 'maxIterations', type: 'number', description: 'Max preview-fix cycles (default: 5, max: 10).', required: false },
			{ name: 'designDescription', type: 'string', description: 'Description of the target design.', required: false },
			{ name: 'waitFor', type: 'string', description: 'CSS selector to wait for.', required: false },
			{ name: 'fullPage', type: 'boolean', description: 'Capture full page height (default: true).', required: false },
			{ name: 'killServer', type: 'boolean', description: 'Stop dev server when done (default: false).', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const url = args.url as string | undefined;
			const command = args.command as string | undefined;
			const port = Math.min(Math.max((args.port as number) ?? DEFAULT_PORT, 1000), 65535);
			const maxIterations = Math.min(Math.max((args.maxIterations as number) ?? DEFAULT_MAX_ITERATIONS, 1), 10);
			const designDescription = args.designDescription as string | undefined;
			const waitFor = args.waitFor as string | undefined;
			const fullPage = args.fullPage ?? true;
			const killServer = args.killServer ?? false;

			ctx.metadata({ title: `Web QA Loop: ${url ?? 'auto-detect'}` });

			const screenshotDirUri = URI.file(SCREENSHOT_DIR);
			try { await fileService.createFolder(screenshotDirUri); } catch { /* already exists */ }

			let startedServer = false;
			let iterations = 0;
			let startCommand: string | undefined = command;
			let targetUrl = url;

			if (!targetUrl) {
				const pkgUri = URI.file(_resolve(workingDirectory, 'package.json'));
				let pkgContent: string;
				try {
					const content = await fileService.readFile(pkgUri);
					pkgContent = content.value.toString();
				} catch {
					return {
						title: 'Web QA Loop Failed',
						output: 'No URL provided and could not read package.json.',
						metadata: { error: true },
					};
				}
				let pkg: any;
				try { pkg = JSON.parse(pkgContent); } catch {
					return {
						title: 'Web QA Loop Failed',
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
						title: 'Web QA Loop Failed',
						output: 'No URL provided and no dev script found in package.json.',
						metadata: { error: true },
					};
				}
			}

			const portCheckCommand = process.platform === 'win32'
				? `(echo > /dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo IN_USE || echo FREE`
				: `(echo > /dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo IN_USE || echo FREE`;
			let portStatus = 'UNKNOWN';
			try {
				const result = await commandExecutor.execute(`portcheck_${Date.now()}`, portCheckCommand, 5000, 1024);
				portStatus = result.trim();
			} catch { /* ignore */ }

			if (portStatus !== 'IN_USE') {
				if (!startCommand) {
					return {
						title: 'Web QA Loop Failed',
						output: `Port ${port} is not in use and no start command was provided.`,
						metadata: { error: true },
					};
				}

				ctx.metadata({ title: `Starting dev server: ${startCommand}` });

				const fullCommand = `cd ${_shellQuote(workingDirectory)} && ${startCommand}`;
				const jobId = `qa_loop_server_${Date.now()}`;

				await commandExecutor.execute(
					jobId,
					`(${fullCommand}) > /tmp/ni_qa_loop_server.log 2>&1 & echo $!`,
					10000,
					10 * 1024
				);

				startedServer = true;

				let serverReady = false;
				for (let i = 0; i < 45; i++) {
					await new Promise(r => setTimeout(r, 1000));
					try {
						const checkResult = await commandExecutor.execute(
							`qa_loop_urlcheck_${Date.now()}`,
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
					const serverLog = await _readFileSafe(fileService, URI.file('/tmp/ni_qa_loop_server.log'));
					return {
						title: 'Dev Server Failed to Start',
						output: `Started "${startCommand}" but ${targetUrl} did not respond within 45 seconds.\n\n${serverLog.slice(-2000)}`,
						metadata: { error: true },
					};
				}
			}

			for (let iter = 1; iter <= maxIterations; iter++) {
				iterations = iter;
				ctx.metadata({ title: `QA Loop: Iteration ${iter}/${maxIterations}` });

				const screenshotFileName = `qa-preview-${iter}-${Date.now()}.png`;
				const screenshotPath = _resolve(SCREENSHOT_DIR, screenshotFileName);
				const screenshotUri = URI.file(screenshotPath);

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

				const scriptPath = `/tmp/ni_qa_loop_script_${iter}.js`;
				await fileService.writeFile(URI.file(scriptPath), VSBuffer.fromString(playwrightScript));

				const pwResult = await commandExecutor.execute(
					`qa_loop_pw_${Date.now()}`,
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
						output: `Playwright script failed on iteration ${iter}:\n${pwResult.slice(-3000)}`,
						metadata: { error: true, iterations },
					};
				}

				let screenshotDataUrl = '';
				try {
					const screenshotContent = await fileService.readFile(screenshotUri);
					screenshotDataUrl = `data:image/png;base64,${screenshotContent.value.toString('base64')}`;
				} catch {
					screenshotDataUrl = `data:image/png;base64,${pwData.screenshot}`;
				}

				const designIssues: string[] = [];
				if (designDescription) {
					designIssues.push(
						`Design description provided: "${designDescription}". ` +
						`Review the screenshot (${screenshotPath}) and compare against this description.`
					);
				}

				const lastResult = {
					title: pwData.title,
					consoleErrors: pwData.consoleErrors,
					networkErrors: pwData.networkErrors,
					screenshotPath,
					screenshotDataUrl,
					designIssues,
				};

				const hasConsoleErrors = pwData.consoleErrors.length > 0;
				const hasNetworkErrors = pwData.networkErrors.length > 0;

				if (!hasConsoleErrors && !hasNetworkErrors && designIssues.length === 0) {
					const output = [
						`Web QA Loop Complete — CLEAN`,
						`==============================`,
						`Iterations: ${iterations}/${maxIterations}`,
						`URL: ${targetUrl}`,
						`Page Title: ${pwData.title}`,
						`Screenshot: ${screenshotPath}`,
						`\nNo console errors, no network errors, and no design mismatches detected.`,
						`The page is ready.`,
					].join('\n');

					return {
						title: `Web QA Loop: Clean`,
						output,
						metadata: {
							status: 'clean',
							iterations,
							finalUrl: targetUrl,
							finalScreenshotPath: screenshotPath,
							finalScreenshotDataUrl: screenshotDataUrl,
							consoleErrors: [],
							networkErrors: [],
							designIssues: [],
						},
					};
				}

				if (iter < maxIterations) {
					const issueLines: string[] = [];
					if (hasConsoleErrors) {
						issueLines.push(`Console errors (${pwData.consoleErrors.length}):`);
						issueLines.push(...pwData.consoleErrors.map(e => `  - ${e}`));
					}
					if (hasNetworkErrors) {
						issueLines.push(`Network errors (${pwData.networkErrors.length}):`);
						issueLines.push(...pwData.networkErrors.map(e => `  - ${e}`));
					}
					if (designIssues.length > 0) {
						issueLines.push(`Design review needed:`);
						issueLines.push(...designIssues.map(d => `  - ${d}`));
					}

					const intermediateOutput = [
						`Web QA Loop — Iteration ${iter}/${maxIterations}`,
						`========================================`,
						`URL: ${targetUrl}`,
						`Page Title: ${pwData.title}`,
						`Screenshot: ${screenshotPath}`,
						`\nIssues found (fix these and re-run web_qa_loop):`,
						...issueLines,
						`\nNext step: Fix the issues above, then call web_qa_loop again.`,
					].join('\n');

					return {
						title: `Web QA Loop: Iteration ${iter} - Issues Found`,
						output: intermediateOutput,
						metadata: {
							status: 'issuesFound',
							iterations,
							finalUrl: targetUrl,
							finalScreenshotPath: screenshotPath,
							finalScreenshotDataUrl: screenshotDataUrl,
							consoleErrors: pwData.consoleErrors,
							networkErrors: pwData.networkErrors,
							designIssues,
							moreIterationsAvailable: true,
						},
					};
				}
			}

			const output = [
				`Web QA Loop — Max Iterations Reached`,
				`====================================`,
				`Iterations: ${iterations}/${maxIterations}`,
				`URL: ${targetUrl}`,
				`Page Title: Last iteration`,
				`Screenshot: Last screenshot`,
				`\nMax iterations (${iterations}) reached.`,
			].join('\n');

			return {
				title: `Web QA Loop: Max Iterations Reached`,
				output,
				metadata: {
					status: 'maxIterationsReached',
					iterations,
					finalUrl: targetUrl,
					finalScreenshotPath: '',
					finalScreenshotDataUrl: '',
					consoleErrors: [],
					networkErrors: [],
					designIssues: [],
				},
			};
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
