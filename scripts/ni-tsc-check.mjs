import { spawnSync } from 'child_process';
import { writeFileSync } from 'fs';

const result = spawnSync(
	process.execPath,
	[
		'--max-old-space-size=2048',
		'node_modules/typescript/bin/tsc',
		'--project', 'src/tsconfig.ni-checks-phase1.json',
	],
	{
		cwd: process.cwd(),
		encoding: 'utf8',
		maxBuffer: 10 * 1024 * 1024,
	}
);

const stdout = (result.stdout || '').trim();
const stderr = (result.stderr || '').trim();
const exitCode = result.status ?? -1;

const lines = [];
lines.push(`EXIT_CODE: ${exitCode}`);
lines.push(`STDOUT: ${stdout || '(empty)'}`);
lines.push(`STDERR: ${stderr || '(empty)'}`);
lines.push(exitCode === 0 ? 'RESULT: TSC_PASSED' : 'RESULT: TSC_FAILED');

const report = lines.join('\n');
writeFileSync('scripts/ni-tsc-result.txt', report, 'utf8');
process.stdout.write(report + '\n');
