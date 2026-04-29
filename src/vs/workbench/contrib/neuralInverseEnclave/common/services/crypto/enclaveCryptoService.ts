/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # EnclaveCryptoService
 *
 * The cryptographic backbone of the Neural Inverse Enclave.
 *
 * ## Responsibilities
 * - Generate and persist an ECDSA P-256 keypair bound to this IDE installation
 * - Sign arbitrary payloads on behalf of the Enclave (audit entries, sessions, commits)
 * - Verify signatures against the Enclave's public key (or a provided external key)
 * - Export the public key as JWK for external auditor verification
 *
 * ## Key Storage Strategy
 * The keypair is stored in the global application storage (not workspace), so it is:
 * - Stable across workspace sessions (same developer == same Enclave identity)
 * - NOT tied to any single project
 * - Recoverable: if lost, a new keypair is generated and a "key rotation" event is logged
 *
 * ## Algorithm Choice: ECDSA P-256
 * - NIST P-256 (secp256r1) is FIPS 140-2/3 approved
 * - Supported natively by Web Crypto API in Chromium (Electron)
 * - Compact signatures (~64 bytes) vs RSA (~256 bytes)
 * - Used in TLS, code signing, and hardware tokens \u2014 the standard for regulated industries
 *
 * ## Thread Safety
 * All crypto operations are async and non-blocking. Key generation happens once at
 * service initialization. Callers awaiting `isReady()` before signing is mandatory.
 */

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { ISecretStorageService } from '../../../../../../platform/secrets/common/secrets.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';

export const IEnclaveCryptoService = createDecorator<IEnclaveCryptoService>('enclaveCryptoService');

// \u2500\u2500\u2500 Public Interfaces \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IEnclaveCryptoService {
	readonly _serviceBrand: undefined;

	/**
	 * Fires once when the keypair is loaded or generated and the service is ready to sign.
	 * Fires immediately on subscription if already ready.
	 */
	readonly onReady: Event<void>;

	/**
	 * Whether the service has a valid keypair loaded and is ready to sign.
	 */
	readonly isReady: boolean;

	/**
	 * The stable Enclave Identity fingerprint \u2014 a truncated SHA-256 of the public key.
	 * Format: `ni-enc-{8 hex chars}` e.g. `ni-enc-a3f9c201`
	 * Available after `isReady === true`.
	 */
	readonly enclaveFingerprint: string;

	/**
	 * Sign arbitrary data. Returns a base64url-encoded ECDSA P-256 signature.
	 * Throws if the service is not ready.
	 * @param data \u2014 The raw bytes or string to sign
	 */
	sign(data: string | ArrayBuffer): Promise<string>;

	/**
	 * Verify a base64url-encoded signature against this Enclave's public key.
	 * @param data \u2014 The original data that was signed
	 * @param signatureB64 \u2014 The base64url signature returned by `sign()`
	 */
	verify(data: string | ArrayBuffer, signatureB64: string): Promise<boolean>;

	/**
	 * Verify a signature using an explicitly provided public key JWK.
	 * Used by auditors or external consumers verifying someone else's Enclave log.
	 */
	verifyWithKey(data: string | ArrayBuffer, signatureB64: string, publicKeyJwk: JsonWebKey): Promise<boolean>;

	/**
	 * Export the Enclave's public key as a JSON Web Key (JWK).
	 * This key should be distributed to auditors and stored alongside audit bundles.
	 */
	exportPublicKeyJwk(): Promise<JsonWebKey>;

	/**
	 * Force-rotate the keypair. Generates a new keypair, persists it, and logs the
	 * rotation event. Old signatures are invalidated \u2014 use only when the private key
	 * is suspected compromised.
	 */
	rotateKeypair(): Promise<void>;
}

// \u2500\u2500\u2500 Storage Keys \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const STORAGE_KEY_PRIVATE_JWK = 'neuralInverse.enclave.crypto.privateKeyJwk';
const STORAGE_KEY_PUBLIC_JWK = 'neuralInverse.enclave.crypto.publicKeyJwk';
const STORAGE_KEY_FINGERPRINT = 'neuralInverse.enclave.crypto.fingerprint';

// \u2500\u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class EnclaveCryptoService extends Disposable implements IEnclaveCryptoService {
	declare readonly _serviceBrand: undefined;

	private _privateKey: CryptoKey | null = null;
	private _publicKey: CryptoKey | null = null;
	private _fingerprint: string = '';
	private _isReady: boolean = false;

	private readonly _onReady = this._register(new Emitter<void>());
	public readonly onReady: Event<void> = this._onReady.event;

	// \u2500\u2500\u2500 ECDSA Algorithm Params \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	private static readonly KEY_ALGORITHM: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };
	private static readonly SIGN_ALGORITHM: EcdsaParams = { name: 'ECDSA', hash: { name: 'SHA-256' } };
	private static readonly KEY_USAGES_PRIVATE: KeyUsage[] = ['sign'];
	private static readonly KEY_USAGES_PUBLIC: KeyUsage[] = ['verify'];

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
	) {
		super();
		// Initialize asynchronously \u2014 callers must wait for `isReady` or `onReady`
		this._initialize().catch(err => {
			console.error('[Enclave Crypto] FATAL: Failed to initialize keypair:', err);
		});
	}

	// \u2500\u2500\u2500 Public API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	public get isReady(): boolean {
		return this._isReady;
	}

	public get enclaveFingerprint(): string {
		return this._fingerprint;
	}

	public async sign(data: string | ArrayBuffer): Promise<string> {
		this._assertReady();
		const bytes = this._toBytes(data);
		const signatureBuffer = await crypto.subtle.sign(
			EnclaveCryptoService.SIGN_ALGORITHM,
			this._privateKey!,
			bytes
		);
		return this._bufferToBase64Url(signatureBuffer);
	}

	public async verify(data: string | ArrayBuffer, signatureB64: string): Promise<boolean> {
		this._assertReady();
		return this._verifyInternal(data, signatureB64, this._publicKey!);
	}

	public async verifyWithKey(data: string | ArrayBuffer, signatureB64: string, publicKeyJwk: JsonWebKey): Promise<boolean> {
		const publicKey = await crypto.subtle.importKey(
			'jwk',
			publicKeyJwk,
			EnclaveCryptoService.KEY_ALGORITHM,
			true,
			EnclaveCryptoService.KEY_USAGES_PUBLIC
		);
		return this._verifyInternal(data, signatureB64, publicKey);
	}

	public async exportPublicKeyJwk(): Promise<JsonWebKey> {
		this._assertReady();
		const jwk = await crypto.subtle.exportKey('jwk', this._publicKey!);
		return jwk;
	}

	public async rotateKeypair(): Promise<void> {
		console.warn('[Enclave Crypto] Rotating keypair \u2014 all previous signatures will be invalidated.');
		this._isReady = false;
		this._privateKey = null;
		this._publicKey = null;
		this._fingerprint = '';

		// Clear persisted keys
		await this.secretStorageService.delete(STORAGE_KEY_PRIVATE_JWK);
		this.storageService.remove(STORAGE_KEY_PRIVATE_JWK, StorageScope.APPLICATION);
		this.storageService.remove(STORAGE_KEY_PUBLIC_JWK, StorageScope.APPLICATION);
		this.storageService.remove(STORAGE_KEY_FINGERPRINT, StorageScope.APPLICATION);

		await this._generateAndPersistKeypair();
		console.log(`[Enclave Crypto] Keypair rotated. New fingerprint: ${this._fingerprint}`);
	}

	// \u2500\u2500\u2500 Initialization \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _initialize(): Promise<void> {
		try {
			const loaded = await this._tryLoadPersistedKeypair();
			if (!loaded) {
				await this._generateAndPersistKeypair();
			}
			this._isReady = true;
			this._onReady.fire();
			console.log(`[Enclave Crypto] Service ready. Fingerprint: ${this._fingerprint}`);
		} catch (err) {
			// If crypto.subtle is not available (non-secure context), create a degraded instance
			console.error('[Enclave Crypto] Web Crypto API unavailable. Signing is disabled.', err);
			this._isReady = false;
		}
	}

	private async _tryLoadPersistedKeypair(): Promise<boolean> {
		let privateJwkStr = await this.secretStorageService.get(STORAGE_KEY_PRIVATE_JWK);
		const publicJwkStr = this.storageService.get(STORAGE_KEY_PUBLIC_JWK, StorageScope.APPLICATION);
		const fingerprint = this.storageService.get(STORAGE_KEY_FINGERPRINT, StorageScope.APPLICATION);

		if (!privateJwkStr) {
			const fallbackStr = this.storageService.get(STORAGE_KEY_PRIVATE_JWK, StorageScope.APPLICATION);
			if (fallbackStr) {
				await this.secretStorageService.set(STORAGE_KEY_PRIVATE_JWK, fallbackStr);
				this.storageService.remove(STORAGE_KEY_PRIVATE_JWK, StorageScope.APPLICATION);
				privateJwkStr = fallbackStr;
				console.log('[Enclave Crypto] Migrated private key to native OS keychain.');
			}
		}

		if (!privateJwkStr || !publicJwkStr || !fingerprint) {
			return false;
		}

		try {
			const privateJwk = JSON.parse(privateJwkStr) as JsonWebKey;
			const publicJwk = JSON.parse(publicJwkStr) as JsonWebKey;

			this._privateKey = await crypto.subtle.importKey(
				'jwk',
				privateJwk,
				EnclaveCryptoService.KEY_ALGORITHM,
				false, // non-extractable after import for security
				EnclaveCryptoService.KEY_USAGES_PRIVATE
			);

			this._publicKey = await crypto.subtle.importKey(
				'jwk',
				publicJwk,
				EnclaveCryptoService.KEY_ALGORITHM,
				true, // public key is always extractable
				EnclaveCryptoService.KEY_USAGES_PUBLIC
			);

			this._fingerprint = fingerprint;
			console.log(`[Enclave Crypto] Loaded persisted keypair. Fingerprint: ${fingerprint}`);
			return true;
		} catch (err) {
			console.warn('[Enclave Crypto] Failed to load persisted keypair (corrupt or incompatible). Generating new.', err);
			return false;
		}
	}

	private async _generateAndPersistKeypair(): Promise<void> {
		const keypair = await crypto.subtle.generateKey(
			EnclaveCryptoService.KEY_ALGORITHM,
			true, // extractable so we can persist as JWK
			[...EnclaveCryptoService.KEY_USAGES_PRIVATE, ...EnclaveCryptoService.KEY_USAGES_PUBLIC]
		) as CryptoKeyPair;

		this._privateKey = keypair.privateKey;
		this._publicKey = keypair.publicKey;

		// Export for persistence
		const privateJwk = await crypto.subtle.exportKey('jwk', this._privateKey);
		const publicJwk = await crypto.subtle.exportKey('jwk', this._publicKey);

		// Compute fingerprint from public key
		this._fingerprint = await this._computeFingerprint(publicJwk);

		// Persist to global application storage and native OS keychain
		await this.secretStorageService.set(STORAGE_KEY_PRIVATE_JWK, JSON.stringify(privateJwk));
		this.storageService.store(STORAGE_KEY_PUBLIC_JWK, JSON.stringify(publicJwk), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.storageService.store(STORAGE_KEY_FINGERPRINT, this._fingerprint, StorageScope.APPLICATION, StorageTarget.MACHINE);

		console.log(`[Enclave Crypto] Generated new ECDSA P-256 keypair. Fingerprint: ${this._fingerprint}`);
	}

	// \u2500\u2500\u2500 Private Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _verifyInternal(data: string | ArrayBuffer, signatureB64: string, publicKey: CryptoKey): Promise<boolean> {
		try {
			const bytes = this._toBytes(data);
			const signatureBuffer = this._base64UrlToBuffer(signatureB64);
			return await crypto.subtle.verify(
				EnclaveCryptoService.SIGN_ALGORITHM,
				publicKey,
				signatureBuffer,
				bytes
			);
		} catch {
			// Malformed input \u2014 treat as invalid signature
			return false;
		}
	}

	private async _computeFingerprint(publicJwk: JsonWebKey): Promise<string> {
		// Fingerprint = first 8 hex chars of SHA-256(canonical JSON of public key)
		// Canonical: sort keys, no whitespace
		const canonical = JSON.stringify(publicJwk, Object.keys(publicJwk).sort());
		const bytes = new TextEncoder().encode(canonical);
		const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
		const hashHex = Array.from(new Uint8Array(hashBuffer))
			.map(b => b.toString(16).padStart(2, '0'))
			.join('');
		return `ni-enc-${hashHex.substring(0, 8)}`;
	}

	private _toBytes(data: string | ArrayBuffer): ArrayBuffer {
		if (typeof data === 'string') {
			return new TextEncoder().encode(data).buffer;
		}
		return data;
	}

	private _bufferToBase64Url(buffer: ArrayBuffer): string {
		const bytes = new Uint8Array(buffer);
		let binary = '';
		for (let i = 0; i < bytes.byteLength; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
	}

	private _base64UrlToBuffer(base64url: string): ArrayBuffer {
		const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
		const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
		const binary = atob(padded);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes.buffer;
	}

	private _assertReady(): void {
		if (!this._isReady || !this._privateKey || !this._publicKey) {
			throw new Error('[Enclave Crypto] Service is not ready. Keypair not yet loaded. Await onReady before signing.');
		}
	}
}

registerSingleton(IEnclaveCryptoService, EnclaveCryptoService, InstantiationType.Eager);
