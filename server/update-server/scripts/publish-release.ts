#!/usr/bin/env npx ts-node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * publish-release.ts
 *
 * Uploads community-edition release binaries to S3 and updates latest.json.
 *
 * Usage:
 *   npx ts-node scripts/publish-release.ts --version 0.1.0 --dist ./dist
 *
 * Expected dist layout:
 *   dist/
 *     darwin-x64/       NeuralInverse-{version}-darwin-x64.zip
 *     darwin-arm64/     NeuralInverse-{version}-darwin-arm64.zip
 *     win32-x64/        NeuralInverseSetup-{version}-x64.exe
 *     win32-arm64/      NeuralInverseSetup-{version}-arm64.exe
 *     linux-x64/        NeuralInverse-{version}-linux-x64.tar.gz
 *     linux-arm64/      NeuralInverse-{version}-linux-arm64.tar.gz
 *
 * Environment variables required:
 *   AWS_REGION      e.g. us-east-1
 *   UPDATE_BUCKET   e.g. ni-community-updates
 *   CDN_BASE_URL    e.g. https://updates.neuralinverse.com  (CloudFront / S3 public URL)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
const BUCKET = process.env.UPDATE_BUCKET!;
const CDN_BASE = (process.env.CDN_BASE_URL ?? '').replace(/\/$/, '');

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const version = argValue(args, '--version');
const distDir = argValue(args, '--dist') ?? './dist';

if (!version) { die('--version is required'); }
if (!BUCKET) { die('UPDATE_BUCKET env var is required'); }
if (!CDN_BASE) { die('CDN_BASE_URL env var is required'); }

// ─── Platform definitions ────────────────────────────────────────────────────

interface PlatformDef {
	platform: string;
	fileName: (v: string) => string;
	buildPayload: (url: string, hash: string, version: string, date: string) => object;
}

const PLATFORMS: PlatformDef[] = [
	{
		platform: 'darwin',
		fileName: (v) => `NeuralInverse-${v}-darwin-x64.zip`,
		buildPayload: (url, _hash, v, date) => ({
			url,
			name: v,
			notes: '',
			pub_date: date,
		}),
	},
	{
		platform: 'darwin-arm64',
		fileName: (v) => `NeuralInverse-${v}-darwin-arm64.zip`,
		buildPayload: (url, _hash, v, date) => ({
			url,
			name: v,
			notes: '',
			pub_date: date,
		}),
	},
	{
		platform: 'win32-x64',
		fileName: (v) => `NeuralInverseSetup-${v}-x64.exe`,
		buildPayload: (url, hash, v) => ({
			url,
			name: v,
			version: v,
			productVersion: v,
			hash,
			hashAlgorithm: 'sha256',
			supportsFastUpdate: true,
		}),
	},
	{
		platform: 'win32-arm64',
		fileName: (v) => `NeuralInverseSetup-${v}-arm64.exe`,
		buildPayload: (url, hash, v) => ({
			url,
			name: v,
			version: v,
			productVersion: v,
			hash,
			hashAlgorithm: 'sha256',
			supportsFastUpdate: true,
		}),
	},
	{
		platform: 'linux-x64',
		fileName: (v) => `NeuralInverse-${v}-linux-x64.tar.gz`,
		buildPayload: (url, hash, v) => ({
			url,
			name: v,
			version: v,
			productVersion: v,
			hash,
			hashAlgorithm: 'sha256',
			timestamp: Date.now(),
		}),
	},
	{
		platform: 'linux-arm64',
		fileName: (v) => `NeuralInverse-${v}-linux-arm64.tar.gz`,
		buildPayload: (url, hash, v) => ({
			url,
			name: v,
			version: v,
			productVersion: v,
			hash,
			hashAlgorithm: 'sha256',
			timestamp: Date.now(),
		}),
	},
];

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const date = new Date().toISOString();
	let uploaded = 0;
	let skipped = 0;

	for (const def of PLATFORMS) {
		const localPath = path.join(distDir, def.platform, def.fileName(version));

		if (!fs.existsSync(localPath)) {
			console.log(`  skip  ${def.platform}  (${localPath} not found)`);
			skipped++;
			continue;
		}

		const fileBytes = fs.readFileSync(localPath);
		const hash = crypto.createHash('sha256').update(fileBytes).digest('hex');

		// Upload binary
		const binaryKey = `releases/${version}/${def.platform}/${def.fileName(version)}`;
		await upload(binaryKey, fileBytes, contentType(localPath));
		console.log(`  ✓  ${def.platform}  binary → s3://${BUCKET}/${binaryKey}`);

		// Build + upload update.json
		const binaryUrl = `${CDN_BASE}/${binaryKey}`;
		const payload = def.buildPayload(binaryUrl, hash, version, date);
		const payloadKey = `releases/${version}/${def.platform}/update.json`;
		await upload(payloadKey, JSON.stringify(payload, null, 2), 'application/json');
		console.log(`  ✓  ${def.platform}  update.json → s3://${BUCKET}/${payloadKey}`);

		uploaded++;
	}

	if (uploaded === 0) {
		die(`No binaries found in ${distDir}. Did you run the build first?`);
	}

	// Update latest.json (only after all binaries are uploaded)
	const latestPayload = JSON.stringify({ version, date }, null, 2);
	await upload('releases/latest.json', latestPayload, 'application/json');
	console.log(`\n  ✓  latest.json → ${version}`);
	console.log(`\n  Done. ${uploaded} platform(s) uploaded, ${skipped} skipped.\n`);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

async function upload(key: string, body: string | Buffer, contentType: string): Promise<void> {
	await s3.send(new PutObjectCommand({
		Bucket: BUCKET,
		Key: key,
		Body: body,
		ContentType: contentType,
	}));
}

function contentType(filePath: string): string {
	if (filePath.endsWith('.exe')) { return 'application/octet-stream'; }
	if (filePath.endsWith('.zip')) { return 'application/zip'; }
	if (filePath.endsWith('.tar.gz')) { return 'application/gzip'; }
	if (filePath.endsWith('.dmg')) { return 'application/octet-stream'; }
	return 'application/octet-stream';
}

function argValue(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	return i !== -1 ? args[i + 1] : undefined;
}

function die(msg: string): never {
	console.error(`\nError: ${msg}\n`);
	process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
