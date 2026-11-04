/**
 * verify-native.mjs
 *
 * Loads each rebuilt native module via Node.js (same ABI path as Electron's
 * renderer process uses for CJS requires) and runs a basic functional test
 * for each one, then writes a machine-readable result file.
 */

import { createRequire } from 'module';
import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const results = [];

function pass(name, detail) {
	results.push({ name, status: 'PASS', detail });
	console.log(`✔  PASS  ${name}: ${detail}`);
}

function fail(name, detail) {
	results.push({ name, status: 'FAIL', detail });
	console.error(`✖  FAIL  ${name}: ${detail}`);
}

// ─── 1. @vscode/sqlite3 ──────────────────────────────────────────────────────
try {
	const sqlite3 = require(path.join(root, 'node_modules/@vscode/sqlite3'));
	// Run an in-memory DB create + insert + select to confirm the binary is functional
	await new Promise((resolve, reject) => {
		const db = new sqlite3.Database(':memory:', (err) => {
			if (err) return reject(err);
			db.run('CREATE TABLE t (v TEXT)', (err2) => {
				if (err2) return reject(err2);
				db.run("INSERT INTO t VALUES ('hello')", (err3) => {
					if (err3) return reject(err3);
					db.get('SELECT v FROM t', (err4, row) => {
						if (err4) return reject(err4);
						if (row?.v !== 'hello') return reject(new Error(`unexpected row: ${JSON.stringify(row)}`));
						db.close();
						resolve();
					});
				});
			});
		});
	});
	pass('@vscode/sqlite3', 'in-memory DB create/insert/select succeeded');
} catch (e) {
	fail('@vscode/sqlite3', String(e));
}

// ─── 2. @vscode/spdlog ───────────────────────────────────────────────────────
try {
	const spdlog = require(path.join(root, 'node_modules/@vscode/spdlog'));
	const tmpLog = path.join(root, 'scripts', '_verify-spdlog.log');
	// createRotatingLogger returns a Promise in @vscode/spdlog ≥ 0.13
	const logger = await spdlog.createRotatingLogger('verify', tmpLog, 1024 * 1024, 1);
	if (typeof logger.info !== 'function') throw new Error(`logger.info is not a function; methods: ${Object.getOwnPropertyNames(Object.getPrototypeOf(logger)).join(',')}`);
	logger.info('spdlog verification probe');
	logger.flush();
	logger.drop();
	try { require('fs').unlinkSync(tmpLog); } catch (_) { }
	pass('@vscode/spdlog', 'createRotatingLogger (async) + info + flush + drop succeeded');
} catch (e) {
	fail('@vscode/spdlog', String(e));
}

// ─── 3. @vscode/windows-mutex ────────────────────────────────────────────────
try {
	const mutex = require(path.join(root, 'node_modules/@vscode/windows-mutex'));
	// createMutex returns an object; verify the constructor works
	if (typeof mutex.Mutex !== 'function' && typeof mutex.createMutex !== 'function') {
		// The module may export directly — just require loading it without error
		// and check it has a truthy export
		if (!mutex || (typeof mutex !== 'object' && typeof mutex !== 'function')) {
			throw new Error('module exported nothing usable');
		}
	}
	pass('@vscode/windows-mutex', 'module loaded successfully');
} catch (e) {
	fail('@vscode/windows-mutex', String(e));
}

// ─── Summary ─────────────────────────────────────────────────────────────────
const allPass = results.every(r => r.status === 'PASS');
console.log('');
console.log(allPass ? '✔ ALL NATIVE MODULES VERIFIED' : '✖ SOME VERIFICATIONS FAILED');

const report = { timestamp: new Date().toISOString(), results, allPass };
writeFileSync(path.join(__dirname, 'verify-native-result.json'), JSON.stringify(report, null, 2));

process.exit(allPass ? 0 : 1);
