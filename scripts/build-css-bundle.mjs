/**
 * build-css-bundle.mjs
 *
 * Generates the missing workbench.desktop.main.css bundle by running esbuild
 * on the already-transpiled out/vs/workbench/workbench.desktop.main.js,
 * following all CSS imports and concatenating them into a single output file.
 *
 * This reproduces the CSS-bundle step that "build/next/index.ts bundle" runs
 * but skips the full TypeScript transpilation (we already have out/).
 *
 * Output: out/vs/workbench/workbench.desktop.main.css
 */

import * as esbuild from 'esbuild';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT  = path.join(ROOT, 'out');

const entry   = path.join(OUT, 'vs/workbench/workbench.desktop.main.js');
const outFile = path.join(OUT, 'vs/workbench/workbench.desktop.main.css');

if (!existsSync(entry)) {
	console.error(`ERROR: entry point not found: ${entry}`);
	process.exit(1);
}

console.log('[css-bundle] Building workbench.desktop.main.css ...');
console.log(`[css-bundle]   entry : ${entry}`);
console.log(`[css-bundle]   output: ${outFile}`);

const result = await esbuild.build({
	entryPoints: [{ in: entry, out: 'vs/workbench/workbench.desktop.main' }],
	outdir: OUT,
	bundle: true,
	format: 'esm',
	platform: 'neutral',
	target: ['es2024'],
	// All JS imports are external — we only want esbuild to follow the CSS imports
	packages: 'external',
	external: ['*.js'],
	loader: {
		'.ttf': 'file',
		'.svg': 'file',
		'.png': 'file',
		'.gif': 'file',
	},
	assetNames: 'media/[name]',
	write: false,
	logLevel: 'warning',
	// Only emit the CSS file — suppress the JS output by filtering
}).catch(e => {
	console.error('[css-bundle] esbuild error:', e.message);
	process.exit(1);
});

// Find the CSS output file from the build results
const cssOutput = result.outputFiles.find(f => f.path.endsWith('.css'));
if (!cssOutput) {
	// No CSS imports found — write a minimal empty file so the HTML doesn't 404
	console.warn('[css-bundle] WARNING: no CSS output from esbuild (no CSS imports found in bundle).');
	console.warn('[css-bundle] Writing empty placeholder CSS file...');
	writeFileSync(outFile, '/* NeuralInverse workbench CSS bundle */\n', 'utf8');
} else {
	writeFileSync(outFile, cssOutput.contents);
	console.log(`[css-bundle] ✔ Written ${cssOutput.contents.byteLength} bytes to:`);
	console.log(`[css-bundle]   ${outFile}`);
}

// The JS sibling output is irrelevant — we already have the transpiled version.
// Do NOT overwrite out/vs/workbench/workbench.desktop.main.js with the bundle.
console.log('[css-bundle] Done.');
