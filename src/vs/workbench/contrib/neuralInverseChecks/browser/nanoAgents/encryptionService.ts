
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { dirname } from '../../../../../base/common/resources.js';

export class EncryptionService {
	private key: CryptoKey | null = null;
	private readonly algorithm = { name: 'AES-GCM', length: 256 };
	private readonly keyFile = '.key';

	constructor(
		private readonly inverseDir: URI,
		private readonly fileService: IFileService
	) { }

	public async init(): Promise<void> {
		const keyUri = URI.joinPath(this.inverseDir, this.keyFile);

		try {
			// Try to read existing key
			const content = await this.fileService.readFile(keyUri);
			const tempKey = JSON.parse(content.value.toString());
			this.key = await globalThis.crypto.subtle.importKey(
				'jwk',
				tempKey,
				this.algorithm,
				true,
				['encrypt', 'decrypt']
			);
		} catch (e) {
			// Generate new key
			console.log('Generating new encryption key...');
			this.key = await globalThis.crypto.subtle.generateKey(
				this.algorithm,
				true,
				['encrypt', 'decrypt']
			);

			// Save key
			const exportedKey = await globalThis.crypto.subtle.exportKey('jwk', this.key);
			await this.fileService.writeFile(keyUri, VSBuffer.fromString(JSON.stringify(exportedKey)));
		}
	}

	public async encrypt(data: string): Promise<string> {
		if (!this.key) await this.init();
		if (!this.key) throw new Error('Encryption key not initialized');

		const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
		const encodedData = new TextEncoder().encode(data);

		const encryptedBuffer = await globalThis.crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv },
			this.key,
			encodedData
		);

		// Combine IV and Ciphertext for storage: IV (12 bytes) + Ciphertext
		const combined = new Uint8Array(iv.length + encryptedBuffer.byteLength);
		combined.set(iv);
		combined.set(new Uint8Array(encryptedBuffer), iv.length);

		// Return as Base64 string for JSON compatibility/file writing
		return this.arrayBufferToBase64(combined);
	}

	public async decrypt(encryptedBase64: string): Promise<string> {
		if (!this.key) await this.init();
		if (!this.key) throw new Error('Encryption key not initialized');

		const combined = this.base64ToArrayBuffer(encryptedBase64);
		const iv = combined.slice(0, 12);
		const data = combined.slice(12);

		const decryptedBuffer = await globalThis.crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: new Uint8Array(iv) },
			this.key,
			data
		);

		return new TextDecoder().decode(decryptedBuffer);
	}

	// Helpers for Base64 conversion in browser environment
	private arrayBufferToBase64(buffer: Uint8Array): string {
		let binary = '';
		const bytes = new Uint8Array(buffer);
		const len = bytes.byteLength;
		for (let i = 0; i < len; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return globalThis.btoa(binary);
	}

	private base64ToArrayBuffer(base64: string): ArrayBuffer {
		const binary_string = globalThis.atob(base64);
		const len = binary_string.length;
		const bytes = new Uint8Array(len);
		for (let i = 0; i < len; i++) {
			bytes[i] = binary_string.charCodeAt(i);
		}
		return bytes.buffer;
	}
}
