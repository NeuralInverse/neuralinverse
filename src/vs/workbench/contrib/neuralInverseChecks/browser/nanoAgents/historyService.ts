import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { EncryptionService } from './encryptionService.js';
import { dirname } from '../../../../../base/common/resources.js';

export interface ICheckpoint {
	hash: string;
	date: string;
	message: string;
}

export class HistoryService extends Disposable {
	private readonly terminalName = 'Nano Agent History Service';

	constructor(
		private readonly inverseDir: URI,
		@IFileService private readonly fileService: IFileService,
		@ITerminalService private readonly terminalService: ITerminalService,
		private readonly encryptionService: EncryptionService
	) {
		super();
	}

	public async getCheckpoints(): Promise<ICheckpoint[]> {
		// Use parent directory (workspace root) effectively for temp files to bypass read-only .inverse
		const workspaceRoot = dirname(this.inverseDir);
		const loadFile = URI.joinPath(workspaceRoot, '.inverse_history_log');
		const statusFile = URI.joinPath(workspaceRoot, '.inverse_history_status');

		await this.cleanup([loadFile, statusFile]);

		// We cd into .inverse, so outputting to ../filename puts it in workspace root
		// Strict isolation usage
		const cmd = `git --git-dir=.git --work-tree=. log --pretty=format:"%H|%ad|%s" --date=iso > "../.inverse_history_log" && echo "DONE" > "../.inverse_history_status"`;
		await this.runCommand(cmd, statusFile);

		try {
			const content = await this.fileService.readFile(loadFile);
			const lines = content.value.toString().split('\n');
			const checkpoints: ICheckpoint[] = [];

			for (const line of lines) {
				if (!line.trim()) continue;
				const [hash, date, message] = line.split('|');
				if (hash && date) {
					checkpoints.push({ hash, date, message: message || '' });
				}
			}
			// Clean up immediately
			await this.cleanup([loadFile, statusFile]);
			return checkpoints;
		} catch (e) {
			console.error('Failed to read checkpoints', e);
			return [];
		}
	}

	public async getFileContent(commitHash: string, relativePath: string): Promise<string | null> {
		const workspaceRoot = dirname(this.inverseDir);
		const outFile = URI.joinPath(workspaceRoot, '.inverse_history_content');
		const statusFile = URI.joinPath(workspaceRoot, '.inverse_history_status');

		await this.cleanup([outFile, statusFile]);

		const cmd = `git --git-dir=.git --work-tree=. show ${commitHash}:"${relativePath}" > "../.inverse_history_content" && echo "DONE" > "../.inverse_history_status"`;
		await this.runCommand(cmd, statusFile);

		try {
			const content = await this.fileService.readFile(outFile);
			const encrypted = content.value.toString();
			await this.cleanup([outFile, statusFile]);
			return await this.encryptionService.decrypt(encrypted);
		} catch (e) {
			console.error(`Failed to get/decrypt content for ${relativePath} at ${commitHash}`, e);
			await this.cleanup([outFile, statusFile]);
			return null;
		}
	}

	public async getChangedFiles(commitHash: string): Promise<string[]> {
		const workspaceRoot = dirname(this.inverseDir);
		const outFile = URI.joinPath(workspaceRoot, '.inverse_history_files');
		const statusFile = URI.joinPath(workspaceRoot, '.inverse_history_status');

		await this.cleanup([outFile, statusFile]);

		const cmd = `git --git-dir=.git --work-tree=. show --pretty="" --name-only ${commitHash} > "../.inverse_history_files" && echo "DONE" > "../.inverse_history_status"`;
		await this.runCommand(cmd, statusFile);

		try {
			const content = await this.fileService.readFile(outFile);
			const text = content.value.toString();
			await this.cleanup([outFile, statusFile]);
			return text.split('\n').filter(line => line.trim().length > 0);
		} catch (e) {
			console.error(`Failed to get changed files for ${commitHash}`, e);
			await this.cleanup([outFile, statusFile]);
			return [];
		}
	}

	private async runCommand(cmd: string, waitFile: URI): Promise<void> {
		let terminal = this.terminalService.instances.find(t => t.title === this.terminalName);
		if (!terminal) {
			terminal = await this.terminalService.createTerminal({ config: { name: this.terminalName, isTransient: true } });
		}

		// Ensure we are in .inverse
		// Ensure file existence loop
		try {
			await this.fileService.del(waitFile);
		} catch { }

		const fullCmd = `cd "${this.inverseDir.fsPath}" && ${cmd}`;
		terminal.sendText(fullCmd, true);

		// Wait for status file
		await this.waitForFile(waitFile);
	}

	private async waitForFile(file: URI, timeoutMs: number = 5000): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			try {
				const exists = await this.fileService.exists(file);
				if (exists) return; // Found it
			} catch (e) { }
			await new Promise(r => setTimeout(r, 200));
		}
		// throw new Error(`Timeout waiting for command completion (file: ${file.path})`);
		// Silent fail
	}

	private async cleanup(files: URI[]): Promise<void> {
		for (const f of files) {
			try {
				await this.fileService.del(f);
			} catch (e) { /* ignore */ }
		}
	}
}
