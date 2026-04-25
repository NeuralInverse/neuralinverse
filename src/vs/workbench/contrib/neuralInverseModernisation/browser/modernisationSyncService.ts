/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ModernisationSyncService
 * ─────────────────────────
 * Persists modernisation sessions and KB snapshots to the backend (checks-socket \u2192
 * db-api \u2192 PostgreSQL) so they survive IDE restarts, machine changes, and are
 * visible in the web console.
 *
 * Responsibilities:
 *  1. On session start     \u2192 POST /modernisation/v1/sessions  (upsert)
 *  2. On stage / plan change \u2192 debounced PATCH (metadata only, no KB)
 *  3. On KB change         \u2192 debounced PATCH with full kbSnapshot (30 s window)
 *  4. On session end       \u2192 PATCH status = "completed"
 *  5. On IDE start         \u2192 if session is active but KB is empty \u2192 restore kbSnapshot
 *                            from backend via kb.importKB()
 *
 * Pattern mirrors ChecksSocketService — REST via INativeHostService, JWT from
 * INeuralInverseAuthService, URL from MODERNISATION_API_URL.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INeuralInverseAuthService } from '../../../services/neuralInverseAuth/common/neuralInverseAuth.js';
import { IModernisationSessionService, IModernisationSessionData } from './modernisationSessionService.js';
import { IKnowledgeBaseService } from './knowledgeBase/service.js';
import { MODERNISATION_API_URL } from '../../../contrib/void/common/neuralInverseConfig.js';

// ─── Service Interface ────────────────────────────────────────────────────────

export interface IModernisationSyncService {
	readonly _serviceBrand: undefined;
	/** Whether the service is currently connected to the backend */
	readonly isConnected: boolean;
	/** Manually trigger a KB snapshot sync */
	syncKBSnapshot(): Promise<void>;
}

export const IModernisationSyncService = createDecorator<IModernisationSyncService>('modernisationSyncService');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Debounce window for metadata-only patches (stage, planApproved) */
const META_DEBOUNCE_MS = 2_000;

/** Debounce window for full KB snapshot patches */
const KB_DEBOUNCE_MS = 30_000;

// ─── Implementation ───────────────────────────────────────────────────────────

class ModernisationSyncService extends Disposable implements IModernisationSyncService {
	declare readonly _serviceBrand: undefined;

	private _isConnected = false;
	get isConnected(): boolean { return this._isConnected; }

	private _metaTimer: ReturnType<typeof setTimeout> | undefined;
	private _kbTimer: ReturnType<typeof setTimeout>   | undefined;

	constructor(
		@INeuralInverseAuthService private readonly _authService: INeuralInverseAuthService,
		@INativeHostService        private readonly _nativeHost: INativeHostService,
		@ILogService               private readonly _log: ILogService,
		@IModernisationSessionService private readonly _sessionService: IModernisationSessionService,
		@IKnowledgeBaseService     private readonly _kbService: IKnowledgeBaseService,
	) {
		super();

		console.log('[ModernisationSync] Service instantiated');

		// On auth ready — attempt restore then start sync
		this._authService.isAuthenticated().then((authed: boolean) => {
			console.log('[ModernisationSync] isAuthenticated ->', authed);
			if (authed) { this._onAuthReady(); }
		});

		this._register(this._authService.onDidChangeAuthStatus((authed: boolean) => {
			console.log('[ModernisationSync] onDidChangeAuthStatus ->', authed);
			if (authed) { this._onAuthReady(); }
		}));

		// React to session changes
		this._register(this._sessionService.onDidChangeSession(s => {
			this._onSessionChanged(s);
		}));

		// React to KB mutations — schedule a KB snapshot sync
		this._register(this._kbService.onDidChange(() => {
			this._scheduleKBSync();
		}));
	}

	// ── Bootstrap ─────────────────────────────────────────────────────────────

	private async _onAuthReady(): Promise<void> {
		this._isConnected = true;

		const session = this._sessionService.session;
		console.log('[ModernisationSync] _onAuthReady — session:', { isActive: session.isActive, sessionId: session.sessionId, stage: session.currentStage });
		if (!session.isActive || !session.sessionId) { return; }

		// Always upsert the already-running session so it appears in the web console
		// even if no onDidChangeSession event fires after service boot.
		await this._upsertSession(session);

		// If KB is empty but backend has a snapshot \u2192 restore it
		if (!this._kbService.isActive) {
			await this._tryRestoreFromBackend(session.sessionId);
		} else {
			// KB is already populated — push a snapshot so the console has current data
			this._scheduleKBSync();
		}
	}

	// ── Session change handler ─────────────────────────────────────────────────

	private _onSessionChanged(s: IModernisationSessionData): void {
		if (!s.isActive) {
			// Session ended — mark as completed in backend
			if (s.sessionId) {
				this._patchSession(s.sessionId, { status: 'completed' }).catch(() => { /* non-fatal */ });
			}
			this._cancelTimers();
			return;
		}

		// Session started or metadata changed \u2192 upsert then schedule KB sync
		this._upsertSession(s).catch(() => { /* non-fatal */ });
		this._scheduleMetaSync(s);
		this._scheduleKBSync();
	}

	// ── Upsert (create or update full session) ─────────────────────────────────

	private async _upsertSession(s: IModernisationSessionData): Promise<void> {
		if (!s.sessionId) { return; }
		const token = await this._authService.getToken();
		if (!token) { return; }

		try {
			console.log('[ModernisationSync] Upserting session:', s.sessionId, '\u2192', `${MODERNISATION_API_URL}/sessions`);
			const response = await this._nativeHost.request(`${MODERNISATION_API_URL}/sessions`, {
				type: 'POST',
				headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
				data: JSON.stringify({
					sessionId:        s.sessionId,
					sources:          s.sources,
					targets:          s.targets,
					migrationPattern: s.migrationPattern ?? null,
					currentStage:     s.currentStage,
					planApproved:     s.planApproved ?? false,
				}),
			});
			console.log('[ModernisationSync] Upsert response:', response.statusCode, response.body?.substring(0, 200));
			this._log.info('[ModernisationSync] Session upserted:', s.sessionId);
		} catch (err: any) {
			console.error('[ModernisationSync] Failed to upsert session:', err?.message);
			this._log.warn('[ModernisationSync] Failed to upsert session:', err?.message);
		}
	}

	// ── PATCH helpers ─────────────────────────────────────────────────────────

	private async _patchSession(sessionId: string, body: Record<string, unknown>): Promise<void> {
		const token = await this._authService.getToken();
		if (!token) { return; }

		await this._nativeHost.request(`${MODERNISATION_API_URL}/sessions/${sessionId}`, {
			type: 'PATCH',
			headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
			data: JSON.stringify(body),
		});
	}

	// ── Debounced meta sync (stage / planApproved) ────────────────────────────

	private _scheduleMetaSync(s: IModernisationSessionData): void {
		if (this._metaTimer !== undefined) { clearTimeout(this._metaTimer); }
		this._metaTimer = setTimeout(async () => {
			this._metaTimer = undefined;
			if (!s.sessionId) { return; }
			try {
				await this._patchSession(s.sessionId, {
					currentStage: s.currentStage,
					planApproved: s.planApproved ?? false,
					migrationPattern: s.migrationPattern ?? null,
				});
			} catch (err: any) {
				this._log.warn('[ModernisationSync] Meta patch failed:', err?.message);
			}
		}, META_DEBOUNCE_MS);
	}

	// ── Debounced KB snapshot sync ─────────────────────────────────────────────

	private _scheduleKBSync(): void {
		if (this._kbTimer !== undefined) { clearTimeout(this._kbTimer); }
		this._kbTimer = setTimeout(() => {
			this._kbTimer = undefined;
			this.syncKBSnapshot().catch(() => { /* non-fatal */ });
		}, KB_DEBOUNCE_MS);
	}

	async syncKBSnapshot(): Promise<void> {
		const session = this._sessionService.session;
		if (!session.isActive || !session.sessionId) { return; }
		if (!this._kbService.isActive) { return; }

		const token = await this._authService.getToken();
		if (!token) { return; }

		try {
			const kbSnapshot = this._kbService.exportKB();
			await this._patchSession(session.sessionId, { kbSnapshot });
			this._log.info('[ModernisationSync] KB snapshot synced for session:', session.sessionId);
		} catch (err: any) {
			this._log.warn('[ModernisationSync] KB snapshot sync failed:', err?.message);
		}
	}

	// ── Restore from backend ───────────────────────────────────────────────────

	private async _tryRestoreFromBackend(sessionId: string): Promise<void> {
		const token = await this._authService.getToken();
		if (!token) { return; }

		try {
			const response = await this._nativeHost.request(
				`${MODERNISATION_API_URL}/sessions/${sessionId}`,
				{ type: 'GET', headers: { 'Authorization': `Bearer ${token}` } },
			);

			if (response.statusCode >= 400) { return; }

			const data = JSON.parse(response.body ?? '{}');
			if (!data.kbSnapshot) { return; }

			// Init KB then import the snapshot
			await this._kbService.init(sessionId);
			await this._kbService.importKB(data.kbSnapshot);
			this._log.info('[ModernisationSync] KB restored from backend for session:', sessionId);
		} catch (err: any) {
			this._log.warn('[ModernisationSync] Failed to restore KB from backend:', err?.message);
		}
	}

	// ── Cleanup ────────────────────────────────────────────────────────────────

	private _cancelTimers(): void {
		if (this._metaTimer !== undefined) { clearTimeout(this._metaTimer); this._metaTimer = undefined; }
		if (this._kbTimer   !== undefined) { clearTimeout(this._kbTimer);   this._kbTimer   = undefined; }
	}

	override dispose(): void {
		this._cancelTimers();
		// Best-effort final KB sync on IDE shutdown
		this.syncKBSnapshot().catch(() => { /* non-fatal */ });
		super.dispose();
	}
}

registerSingleton(IModernisationSyncService, ModernisationSyncService, InstantiationType.Eager);
