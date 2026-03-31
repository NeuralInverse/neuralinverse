/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * Neural Inverse Community Edition — Update Server
 *
 * Implements the VS Code update protocol so the Electron app can
 * auto-update via AWS Lambda + S3.
 *
 * Route (via API Gateway):
 *   GET /api/update/{platform}/{quality}/{version}
 *
 * S3 layout:
 *   {BUCKET}/releases/latest.json          → { "version": "0.1.0", "date": "..." }
 *   {BUCKET}/releases/{version}/{platform}/update.json  → platform update payload
 *   {BUCKET}/releases/{version}/{platform}/{binary}     → actual installer / archive
 *
 * Platforms handled:
 *   darwin        macOS x64  (Squirrel)
 *   darwin-arm64  macOS arm64 (Squirrel)
 *   win32-x64     Windows x64 setup
 *   win32-arm64   Windows arm64 setup
 *   linux-x64     Linux x64 tar.gz
 *   linux-arm64   Linux arm64 tar.gz
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
const BUCKET = process.env.UPDATE_BUCKET!;

// ─── Types ────────────────────────────────────────────────────────────────────

interface LatestJson {
	version: string;
	date: string;
}

// VS Code update response shapes

interface DarwinUpdatePayload {
	url: string;
	name: string;
	notes: string;
	pub_date: string;
}

interface Win32UpdatePayload {
	url: string;
	name: string;
	version: string;
	productVersion: string;
	hash: string;
	hashAlgorithm: 'sha256';
	supportsFastUpdate: boolean;
}

interface LinuxUpdatePayload {
	url: string;
	name: string;
	version: string;
	productVersion: string;
	hash: string;
	hashAlgorithm: 'sha256';
	timestamp: number;
}

type UpdatePayload = DarwinUpdatePayload | Win32UpdatePayload | LinuxUpdatePayload;

// ─── Handler ─────────────────────────────────────────────────────────────────

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
	try {
		// Parse path: /api/update/{platform}/{quality}/{version}
		const pathParts = (event.rawPath ?? '').split('/').filter(Boolean);
		// pathParts: ['api', 'update', platform, quality, version]
		if (pathParts.length < 5 || pathParts[0] !== 'api' || pathParts[1] !== 'update') {
			return { statusCode: 400, body: 'Invalid path' };
		}

		const platform = pathParts[2];
		// quality = pathParts[3]  (stable / insider — reserved for future use)
		const currentVersion = pathParts[4];

		if (!isSupportedPlatform(platform)) {
			return { statusCode: 400, body: `Unsupported platform: ${platform}` };
		}

		// ── Fetch latest version from S3 ──────────────────────────────────────
		const latest = await readS3Json<LatestJson>(`releases/latest.json`);
		if (!latest) {
			return { statusCode: 503, body: 'Update server temporarily unavailable' };
		}

		// ── Already up to date ────────────────────────────────────────────────
		if (currentVersion === latest.version) {
			return { statusCode: 204, body: '' };
		}

		// ── Fetch platform-specific update payload from S3 ────────────────────
		const payload = await readS3Json<UpdatePayload>(`releases/${latest.version}/${platform}/update.json`);
		if (!payload) {
			// Release exists in latest.json but assets not yet uploaded for this platform
			return { statusCode: 204, body: '' };
		}

		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		};

	} catch (err) {
		console.error('[update-server] Unhandled error:', err);
		return { statusCode: 500, body: 'Internal server error' };
	}
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SUPPORTED_PLATFORMS = [
	'darwin',
	'darwin-arm64',
	'win32-x64',
	'win32-arm64',
	'linux-x64',
	'linux-arm64',
] as const;

type Platform = typeof SUPPORTED_PLATFORMS[number];

function isSupportedPlatform(p: string): p is Platform {
	return (SUPPORTED_PLATFORMS as readonly string[]).includes(p);
}

async function readS3Json<T>(key: string): Promise<T | null> {
	try {
		const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
		const body = await res.Body!.transformToString('utf-8');
		return JSON.parse(body) as T;
	} catch (err: any) {
		// NoSuchKey = object doesn't exist (requires s3:ListBucket)
		// AccessDenied on missing key = same meaning when ListBucket not granted
		if (err?.name === 'NoSuchKey' || err?.name === 'AccessDenied' || err?.$metadata?.httpStatusCode === 403 || err?.$metadata?.httpStatusCode === 404) {
			return null;
		}
		throw err;
	}
}
