import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const logPath = path.join(root, 'scripts', 'rebuild-native.log');
const log = createWriteStream(logPath, { flags: 'w' });

const write = (s) => {
	process.stdout.write(s);
	log.write(s);
};

write(`[rebuild-native] Starting at ${new Date().toISOString()}\n`);
write(`[rebuild-native] Root: ${root}\n`);

const cli = path.join(root, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
const args = [
	cli,
	'--version', '42.2.0',
	'--arch', 'x64',
	'--only', '@vscode/sqlite3,@vscode/spdlog,@vscode/windows-mutex',
	'--force',
];

write(`[rebuild-native] Command: node ${args.join(' ')}\n\n`);

const child = spawn(process.execPath, args, {
	cwd: root,
	stdio: ['ignore', 'pipe', 'pipe'],
	env: {
		...process.env,
		// Set VCINSTALLDIR so node-gyp uses the "VS Command Prompt" fast-path
		// (findVSFromSpecifiedLocation) and skips all PowerShell/vswhere discovery.
		// Must point to the VC directory (one level BELOW the VS root).
		VCINSTALLDIR: 'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\VC\\',
		// VSCMD_VER lets node-gyp know the version without needing PowerShell
		VSCMD_VER: '18.11.3',
		// Windows SDK version for include path resolution
		WindowsSDKVersion: '10.0.26100.0',
		// All required binaries on PATH
		PATH: [
			'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\VC\\Tools\\MSVC\\14.51.36231\\bin\\HostX64\\x64',
			'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\MSBuild\\Current\\Bin',
			'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64',
			'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x86',
			process.env.PATH,
		].join(';'),
		// node-gyp msvs_version — matches VS 2026 year
		GYP_MSVS_VERSION: '2026',
		npm_config_msvs_version: '2026',
	},
});

child.stdout.on('data', (d) => write(d.toString()));
child.stderr.on('data', (d) => write(d.toString()));

child.on('close', (code) => {
	const msg = `\n[rebuild-native] Exited with code ${code} at ${new Date().toISOString()}\n`;
	write(msg);
	log.end();
	process.exit(code ?? 0);
});

child.on('error', (e) => {
	write(`[rebuild-native] ERROR: ${e.message}\n`);
	log.end();
	process.exit(1);
});

// Keep alive
setInterval(() => { }, 60000);
