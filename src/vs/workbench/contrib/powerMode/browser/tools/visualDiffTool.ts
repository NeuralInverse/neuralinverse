/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *
 *  Visual Diff Tool — Screenshot comparison for visual regression testing.
 *
 *  Compares two screenshots pixel-by-pixel and reports differences.
 *  Designed to work with screenshots from web_preview / web_qa_loop.
 *
 *  Parameters:
 *    beforeImage: Base64 data URL or file path of the first screenshot
 *    afterImage: Base64 data URL or file path of the second screenshot
 *    threshold: Pixel difference threshold (0-255, default: 30)
 *    minDiffPixels: Minimum changed pixels to report (default: 10)
 *
 *  Returns:
 *    diffPercent: Percentage of pixels that differ (0-100)
 *    diffPixelCount: Absolute number of differing pixels
 *    totalPixels: Total pixels compared
 *    changedRegions: Array of bounding boxes for changed areas
 *    areSimilar: True if diff is below threshold
 *    dimensions: { width, height } of the images
 *--------------------------------------------------------------------------------------------*/

import { definePowerTool } from './powerToolRegistry.js';
import { IToolContext, IToolResult, IPowerTool } from '../../common/powerModeTypes.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';

const DEFAULT_THRESHOLD = 30;
const DEFAULT_MIN_DIFF_PIXELS = 10;

function _resolve(workingDirectory: string, filePath: string): string {
	const _WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
	const isAbsolute = filePath.startsWith('/') || _WIN_DRIVE_RE.test(filePath);
	if (isAbsolute) { return filePath; }
	const base = workingDirectory.replace(/\\/g, '/');
	const rel = filePath.replace(/\\/g, '/');
	return base + (base.endsWith('/') ? '' : '/') + rel;
}

export function createVisualDiffTool(
	workingDirectory: string,
	fileService: IFileService
): IPowerTool {
	return definePowerTool(
		'visual_diff',
		`Compare two screenshots pixel-by-pixel for visual regression testing.

Use this to verify that code changes don't break the visual design. Works with
screenshots from web_preview / web_qa_loop (base64 data URLs or file paths).

The tool:
  1. Loads both images (from data URLs or file paths)
  2. Resizes them to match dimensions if needed
  3. Compares each pixel's RGB values against the threshold
  4. Groups adjacent changed pixels into regions
  5. Returns diff percentage, count, and bounding boxes

Parameters:
- beforeImage: Base64 data URL or file path of the baseline screenshot
- afterImage: Base64 data URL or file path of the comparison screenshot
- threshold: Max per-channel color difference to consider "same" (0-255, default: 30)
- minDiffPixels: Minimum changed pixels to count as a region (default: 10)

Returns:
- diffPercent: Percentage of differing pixels (0-100)
- diffPixelCount: Absolute count of differing pixels
- totalPixels: Total pixels in the images
- changedRegions: Bounding boxes [x, y, width, height] of changed areas
- areSimilar: True if diffPercent is below 5% (visually similar)
- dimensions: { width, height }

Example:
  visual_diff({
    beforeImage: "data:image/png;base64,iVBORw0KGgo...",
    afterImage: "data:image/png;base64,iVBORw0KGgo...",
    threshold: 25
  })`,
		[
			{
				name: 'beforeImage',
				type: 'string',
				description: 'Baseline screenshot (base64 data URL or file path)',
				required: true,
			},
			{
				name: 'afterImage',
				type: 'string',
				description: 'Comparison screenshot (base64 data URL or file path)',
				required: true,
			},
			{
				name: 'threshold',
				type: 'number',
				description: 'Max per-channel color difference (0-255, default: 30)',
				required: false,
			},
			{
				name: 'minDiffPixels',
				type: 'number',
				description: 'Minimum changed pixels to report as a region (default: 10)',
				required: false,
			},
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const beforeImage = args.beforeImage;
			const afterImage = args.afterImage;
			const threshold = (args.threshold as number) ?? DEFAULT_THRESHOLD;
			const minDiffPixels = (args.minDiffPixels as number) ?? DEFAULT_MIN_DIFF_PIXELS;

			if (typeof beforeImage !== 'string' || beforeImage.trim().length === 0) {
				return {
					title: 'Invalid beforeImage',
					output: 'Error: beforeImage must be a non-empty string (base64 data URL or file path).',
					metadata: { error: true },
				};
			}
			if (typeof afterImage !== 'string' || afterImage.trim().length === 0) {
				return {
					title: 'Invalid afterImage',
					output: 'Error: afterImage must be a non-empty string (base64 data URL or file path).',
					metadata: { error: true },
				};
			}

			ctx.metadata({ title: 'Visual diff comparison' });

			// Load both images as ImageData
			let beforeData: ImageData | null = null;
			let afterData: ImageData | null = null;

			try {
				beforeData = await _loadImageAsImageData(beforeImage, workingDirectory, fileService);
			} catch (err: any) {
				return {
					title: 'Failed to load beforeImage',
					output: `Error loading beforeImage: ${err.message}`,
					metadata: { error: true },
				};
			}

			try {
				afterData = await _loadImageAsImageData(afterImage, workingDirectory, fileService);
			} catch (err: any) {
				return {
					title: 'Failed to load afterImage',
					output: `Error loading afterImage: ${err.message}`,
					metadata: { error: true },
				};
			}

			if (!beforeData || !afterData) {
				return {
					title: 'Image load failed',
					output: 'Error: Could not load one or both images.',
					metadata: { error: true },
				};
			}

			// Resize afterData to match beforeData dimensions if needed
			let comparisonAfter = afterData;
			if (beforeData.width !== afterData.width || beforeData.height !== afterData.height) {
				comparisonAfter = _resizeImageData(afterData, beforeData.width, beforeData.height);
			}

			const width = beforeData.width;
			const height = beforeData.height;
			const totalPixels = width * height;

			// Compare pixel by pixel
			const beforePixels = beforeData.data;
			const afterPixels = comparisonAfter.data;

			let diffPixelCount = 0;
			const changedRegions: Array<{ x: number; y: number; width: number; height: number }> = [];
			const changedMap: boolean[] = new Array(totalPixels).fill(false);

			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					const idx = (y * width + x) * 4;
					const rDiff = Math.abs(beforePixels[idx] - afterPixels[idx]);
					const gDiff = Math.abs(beforePixels[idx + 1] - afterPixels[idx + 1]);
					const bDiff = Math.abs(beforePixels[idx + 2] - afterPixels[idx + 2]);

					if (rDiff > threshold || gDiff > threshold || bDiff > threshold) {
						diffPixelCount++;
						changedMap[y * width + x] = true;
					}
				}
			}

			// Group changed pixels into regions
			if (diffPixelCount > 0) {
				const visited = new Array(totalPixels).fill(false);
				for (let y = 0; y < height; y++) {
					for (let x = 0; x < width; x++) {
						const idx = y * width + x;
						if (changedMap[idx] && !visited[idx]) {
							const region = _floodFillRegion(changedMap, visited, width, height, x, y);
							if (region.pixelCount >= minDiffPixels) {
								changedRegions.push({
									x: region.minX,
									y: region.minY,
									width: region.maxX - region.minX + 1,
									height: region.maxY - region.minY + 1,
								});
							}
						}
					}
				}
			}

			const diffPercent = (diffPixelCount / totalPixels) * 100;
			const areSimilar = diffPercent < 5.0;

			const lines: string[] = [];
			lines.push(`Visual Diff Comparison`);
			lines.push(`=======================`);
			lines.push(`Dimensions: ${width} x ${height}`);
			lines.push(`Total pixels: ${totalPixels.toLocaleString()}`);
			lines.push(`Differing pixels: ${diffPixelCount.toLocaleString()}`);
			lines.push(`Difference: ${diffPercent.toFixed(2)}%`);
			lines.push(`Changed regions: ${changedRegions.length}`);
			lines.push(`Are similar: ${areSimilar ? 'YES' : 'NO'}`);
			lines.push('');

			if (changedRegions.length > 0) {
				lines.push('Changed regions:');
				for (const r of changedRegions.slice(0, 10)) {
					lines.push(`  [${r.x}, ${r.y}] ${r.width}x${r.height}`);
				}
				if (changedRegions.length > 10) {
					lines.push(`  ... and ${changedRegions.length - 10} more`);
				}
			}

			if (areSimilar) {
				lines.push('');
				lines.push('Result: Images are visually similar (diff < 5%). No significant visual regression detected.');
			} else {
				lines.push('');
				lines.push('Result: Visual differences detected. Review the changed regions above.');
			}

			return {
				title: `Visual Diff: ${diffPercent.toFixed(2)}% different`,
				output: lines.join('\n'),
				metadata: {
					diffPercent,
					diffPixelCount,
					totalPixels,
					dimensions: { width, height },
					changedRegions,
					areSimilar,
					threshold,
				},
			};
		},
	);
}

// ─── Image loading helpers ───────────────────────────────────────────────

async function _loadImageAsImageData(
	imageInput: string,
	workingDirectory: string,
	fileService: IFileService
): Promise<ImageData> {
	// Check if it's a base64 data URL
	if (imageInput.startsWith('data:')) {
		return _dataUrlToImageData(imageInput);
	}

	// Otherwise treat as file path
	const resolvedPath = _resolve(workingDirectory, imageInput);
	const content = await fileService.readFile(URI.file(resolvedPath));
	const base64 = content.value.toString('base64');
	const mime = _getMimeFromPath(resolvedPath);
	return _dataUrlToImageData(`data:${mime};base64,${base64}`);
}

function _dataUrlToImageData(dataUrl: string): Promise<ImageData> {
	return new Promise<ImageData>((resolve, reject) => {
		const img = new Image();
		img.onload = () => {
			try {
				const canvas = _createCanvas(img.width, img.height);
				const ctx = canvas.getContext('2d');
				if (!ctx) {
					reject(new Error('Could not get canvas 2D context'));
					return;
				}
				ctx.drawImage(img, 0, 0);
				const imageData = ctx.getImageData(0, 0, img.width, img.height);
				resolve(imageData);
			} catch (err) {
				reject(err);
			}
		};
		img.onerror = () => reject(new Error('Failed to load image'));
		img.src = dataUrl;
	});
}

function _createCanvas(width: number, height: number): HTMLCanvasElement {
	// Try OffscreenCanvas first (workers), fall back to regular canvas
	if (typeof OffscreenCanvas !== 'undefined') {
		return new OffscreenCanvas(width, height) as unknown as HTMLCanvasElement;
	}
	if (typeof document !== 'undefined' && document.createElement) {
		return document.createElement('canvas');
	}
	// Last resort: create a plain object with canvas-like interface
	throw new Error('No canvas API available in this environment');
}

function _getMimeFromPath(filePath: string): string {
	const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
	switch (ext) {
		case 'png': return 'image/png';
		case 'jpg':
		case 'jpeg': return 'image/jpeg';
		case 'webp': return 'image/webp';
		case 'gif': return 'image/gif';
		default: return 'image/png';
	}
}

// ─── Image resize helper ─────────────────────────────────────────────────

function _resizeImageData(src: ImageData, targetWidth: number, targetHeight: number): ImageData {
	const canvas = _createCanvas(targetWidth, targetHeight);
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		return src;
	}

	// Create a temporary canvas with source data
	const tempCanvas = _createCanvas(src.width, src.height);
	const tempCtx = tempCanvas.getContext('2d');
	if (!tempCtx) {
		return src;
	}
	tempCtx.putImageData(src, 0, 0);

	// Draw resized to target
	ctx.drawImage(tempCanvas, 0, 0, src.width, src.height, 0, 0, targetWidth, targetHeight);
	return ctx.getImageData(0, 0, targetWidth, targetHeight);
}

// ─── Region flood fill ───────────────────────────────────────────────────

interface Region { minX: number; minY: number; maxX: number; maxY: number; pixelCount: number; }

function _floodFillRegion(
	changedMap: boolean[],
	visited: boolean[],
	width: number,
	height: number,
	startX: number,
	startY: number
): Region {
	const stack: Array<{ x: number; y: number }> = [{ x: startX, y: startY }];
	let minX = startX, minY = startY, maxX = startX, maxY = startY, pixelCount = 0;

	while (stack.length > 0) {
		const { x, y } = stack.pop()!;
		const idx = y * width + x;

		if (x < 0 || x >= width || y < 0 || y >= height) continue;
		if (visited[idx]) continue;
		if (!changedMap[idx]) continue;

		visited[idx] = true;
		pixelCount++;

		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;

		// 4-connected flood fill
		stack.push({ x: x + 1, y });
		stack.push({ x: x - 1, y });
		stack.push({ x, y: y + 1 });
		stack.push({ x, y: y - 1 });
	}

	return { minX, minY, maxX, maxY, pixelCount };
}
