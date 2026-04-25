/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Build analysis agent tools \u2014 Phase 1c + Phase 2
 *
 * Phase 1c: Surfaces structured build errors, flash tool detection, and build
 * command inspection. Replaces the generic stub responses in fw_build / fw_flash
 * with tools that give the agent actionable diagnostic data.
 *
 * Phase 2: Binary & memory analysis \u2014 linker .map file, GCC .su stack-usage
 * files, and ELF symbol table. Extracts intelligence from compiler/linker output
 * that no IDE currently surfaces to an AI agent.
 */

import { IVoidInternalTool } from '../../../../void/browser/voidInternalToolService.js';
import { IBuildSystemService } from '../build/buildSystemService.js';
import { IFirmwareSessionService } from '../../firmwareSessionService.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { URI } from '../../../../../../base/common/uri.js';


export function buildBuildAnalysisTools(
	buildService: IBuildSystemService,
	sessionService: IFirmwareSessionService,
	fileService: IFileService,
): IVoidInternalTool[] {
	return [
		// Phase 1c
		_fwGetBuildErrors(buildService),
		_fwDetectFlashTools(buildService),
		_fwGetBuildCommand(buildService, sessionService),
		// Phase 2
		_fwAnalyzeMapFile(sessionService, fileService),
		_fwAnalyzeStackUsage(sessionService, fileService),
		_fwReadElfSymbols(sessionService, fileService),
	];
}


function _fwGetBuildErrors(svc: IBuildSystemService): IVoidInternalTool {
	return {
		name: 'fw_get_build_errors',
		description: 'Get structured errors and warnings from the last build. Returns file paths, line numbers, severity, and messages \u2014 ready to act on. Call this after fw_build reports a failure.',
		params: {
			severity: { description: 'Filter by severity: "error", "warning", or "all" (default: "all")' },
		},
		execute: async (args: Record<string, any>) => {
			const result = svc.lastBuildResult;
			if (!result) {
				return 'No build has been run in this session. Call fw_build first.';
			}

			const filter = (args.severity as string | undefined) ?? 'all';
			let errors = filter === 'warning' ? [] : result.errors;
			let warnings = filter === 'error' ? [] : result.warnings;

			if (errors.length === 0 && warnings.length === 0) {
				return result.success
					? `Last build succeeded (${result.durationMs}ms) \u2014 no errors or warnings.`
					: 'Last build failed but no parsed diagnostics found. Check build output directly.';
			}

			const lines: string[] = [
				`Last build: ${result.success ? 'SUCCEEDED' : 'FAILED'} (${result.durationMs}ms)`,
				`  ${errors.length} error(s), ${warnings.length} warning(s)`,
				'',
			];

			if (errors.length > 0) {
				lines.push(`Errors (${errors.length}):`);
				for (const e of errors) {
					const loc = e.file ? `${e.file}:${e.line ?? '?'}:${e.column ?? '?'}` : 'unknown location';
					const code = e.code ? ` [${e.code}]` : '';
					lines.push(`  ${loc}: error${code}: ${e.message}`);
				}
			}

			if (warnings.length > 0) {
				lines.push('');
				lines.push(`Warnings (${warnings.length}):`);
				for (const w of warnings.slice(0, 20)) {
					const loc = w.file ? `${w.file}:${w.line ?? '?'}` : 'unknown location';
					lines.push(`  ${loc}: warning: ${w.message}`);
				}
				if (warnings.length > 20) {
					lines.push(`  \u2026 and ${warnings.length - 20} more warnings`);
				}
			}

			return lines.join('\n');
		},
	};
}


function _fwDetectFlashTools(svc: IBuildSystemService): IVoidInternalTool {
	return {
		name: 'fw_detect_flash_tools',
		description: 'Detect which flash programming tools are installed on this system. Returns tool names, paths, versions, and supported debug interfaces. Use before fw_flash to confirm the right tool is available.',
		params: {},
		execute: async () => {
			const tools = await svc.detectFlashTools();
			if (tools.length === 0) {
				return [
					'No flash tools detected.',
					'',
					'Install one of:',
					'  STM32: openocd, stm32-programmer-cli, st-flash',
					'  ESP32: esptool (pip install esptool)',
					'  Nordic: nrfjprog (nRF Command Line Tools), west',
					'  Generic: pyocd (pip install pyocd), probe-rs',
					'  J-Link: JLink GDB Server (SEGGER)',
				].join('\n');
			}

			const lines = [`Found ${tools.length} flash tool(s):`, ''];
			for (const t of tools) {
				const ver = t.version ? ` v${t.version}` : '';
				const ifaces = t.supportedInterfaces.length > 0 ? ` [${t.supportedInterfaces.join(', ')}]` : '';
				lines.push(`  ${t.name}${ver} \u2014 ${t.path}${ifaces}`);
			}
			return lines.join('\n');
		},
	};
}


function _fwGetBuildCommand(svc: IBuildSystemService, session: IFirmwareSessionService): IVoidInternalTool {
	return {
		name: 'fw_get_build_command',
		description: 'Get the exact shell command that fw_build would run for the current project. Use to inspect or customize the build command before running it.',
		params: {
			target: { description: 'Optional build target, e.g. "debug", "release", PlatformIO env name' },
			type: { description: '"build" (default), "flash", or "clean"' },
		},
		execute: async (args: Record<string, any>) => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }

			const projectType = s.projectInfo?.projectType ?? 'generic';
			const cmdType = (args.type as string | undefined) ?? 'build';
			const target = args.target as string | undefined;

			let cmd: string[];
			if (cmdType === 'flash') {
				cmd = svc.getFlashCommand(projectType as any);
			} else if (cmdType === 'clean') {
				cmd = svc.getBuildCommand(projectType as any, 'clean');
			} else {
				cmd = svc.getBuildCommand(projectType as any, target);
			}

			return [
				`Project type: ${projectType}`,
				`Command type: ${cmdType}`,
				target ? `Target: ${target}` : '',
				'',
				`Command: ${cmd.join(' ')}`,
				'',
				'Run fw_build to execute this command in the integrated terminal.',
			].filter(Boolean).join('\n');
		},
	};
}


// \u2500\u2500\u2500 Phase 2: Binary & Memory Analysis \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _fwAnalyzeMapFile(session: IFirmwareSessionService, fileService: IFileService): IVoidInternalTool {
	return {
		name: 'fw_analyze_map_file',
		description: 'Parse the linker .map file produced alongside the ELF. Returns memory region usage (FLASH/RAM %), top 20 largest symbols by size, section breakdown (.text/.rodata/.data/.bss), orphan sections, and per-object-file contribution ranking. Essential when a build is over its flash budget.',
		params: {
			mapPath: { description: 'Path to the .map file. Auto-detected from build output directory if omitted (e.g. "build/firmware.map").' },
		},
		execute: async (args: Record<string, any>) => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }

			const mapPath = (args.mapPath as string | undefined) ?? _inferMapPath(s.lastBuildResult?.outputPath);
			if (!mapPath) {
				return 'Could not locate .map file. Provide mapPath explicitly, or run fw_build first to generate one.';
			}

			let content: string;
			try {
				const raw = await fileService.readFile(URI.file(mapPath));
				content = raw.value.toString();
			} catch {
				return `Could not read map file at ${mapPath}. Run fw_build first, or provide the correct mapPath.`;
			}

			return _parseMapFile(content, s.mcuConfig?.flashSize ?? 0, s.mcuConfig?.ramSize ?? 0, mapPath);
		},
	};
}


function _fwAnalyzeStackUsage(session: IFirmwareSessionService, fileService: IFileService): IVoidInternalTool {
	return {
		name: 'fw_analyze_stack_usage',
		description: 'Parse GCC .su stack-usage files (generated with -fstack-usage). Returns top 20 functions by frame size, flags functions with dynamic/unbounded frames (potential stack overflow sources), and warns when any frame exceeds the threshold. Stack overflows are the most common silent crash in embedded systems.',
		params: {
			suDir: { description: 'Directory containing .su files (usually the build directory). Auto-detected if omitted.' },
			threshold: { description: 'Warn when a function frame exceeds this many bytes. Default: 256.' },
		},
		execute: async (args: Record<string, any>) => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }

			const threshold = typeof args.threshold === 'number' ? args.threshold : 256;
			const suDir = (args.suDir as string | undefined) ?? _inferBuildDir(s.lastBuildResult?.outputPath);
			if (!suDir) {
				return 'Could not locate build directory. Provide suDir explicitly, or run fw_build with -fstack-usage first.';
			}

			// List .su files in the build directory
			let suFiles: URI[];
			try {
				const stat = await fileService.resolve(URI.file(suDir));
				if (!stat.children) {
					return `Build directory ${suDir} is empty or not a directory.`;
				}
				suFiles = stat.children
					.filter(c => c.name.endsWith('.su'))
					.map(c => c.resource);
			} catch {
				return `Could not read build directory ${suDir}. Provide suDir explicitly, or run fw_build with -fstack-usage first.`;
			}

			if (suFiles.length === 0) {
				return [
					`No .su files found in ${suDir}.`,
					'',
					'To enable stack usage analysis, add -fstack-usage to your compiler flags:',
					'  CMake:      add_compile_options(-fstack-usage)',
					'  PlatformIO: build_flags = -fstack-usage',
					'  ESP-IDF:    CONFIG_COMPILER_STACK_CHECK_MODE_STRONG=y',
				].join('\n');
			}

			interface SuEntry { func: string; bytes: number; qualifier: string; file: string }
			const entries: SuEntry[] = [];

			for (const uri of suFiles) {
				try {
					const raw = await fileService.readFile(uri);
					const lines = raw.value.toString().split('\n');
					for (const line of lines) {
						// Format: file.c:line:col:function_name	bytes	qualifier
						const m = line.match(/^(.+?):(\d+):\d+:(\S+)\s+(\d+)\s+(\S+)/);
						if (m) {
							entries.push({
								file: m[1],
								func: m[3],
								bytes: parseInt(m[4]),
								qualifier: m[5],
							});
						}
					}
				} catch { /* skip unreadable .su files */ }
			}

			if (entries.length === 0) {
				return `Found ${suFiles.length} .su file(s) but no parseable entries. Ensure the build used arm-none-eabi-gcc with -fstack-usage.`;
			}

			entries.sort((a, b) => b.bytes - a.bytes);
			const top20 = entries.slice(0, 20);
			const dynamic = entries.filter(e => e.qualifier === 'dynamic' || e.qualifier === 'dynamic,bounded');
			const overThreshold = entries.filter(e => e.bytes > threshold);

			const lines = [
				`Stack Usage Analysis \u2014 ${entries.length} function(s) from ${suFiles.length} .su file(s)`,
				'',
				`Top 20 largest frames:`,
			];

			for (const e of top20) {
				const warn = e.bytes > threshold ? ' \u26A0' : '';
				const dyn = e.qualifier !== 'static' ? ` [${e.qualifier}]` : '';
				lines.push(`  ${e.bytes.toString().padStart(6)} B  ${e.func}${dyn}${warn}  \u2014 ${e.file}`);
			}

			if (dynamic.length > 0) {
				lines.push('', `Dynamic/unbounded frames (${dynamic.length}) \u2014 potential stack overflow sources:`);
				for (const e of dynamic.slice(0, 10)) {
					lines.push(`  ${e.func} (${e.bytes} B, ${e.qualifier})  \u2014 ${e.file}`);
				}
				if (dynamic.length > 10) { lines.push(`  \u2026 and ${dynamic.length - 10} more`); }
			}

			if (overThreshold.length > 0) {
				lines.push('', `\u26A0 ${overThreshold.length} function(s) exceed the ${threshold} B threshold.`);
			}

			return lines.join('\n');
		},
	};
}


function _fwReadElfSymbols(session: IFirmwareSessionService, fileService: IFileService): IVoidInternalTool {
	return {
		name: 'fw_read_elf_symbols',
		description: 'Read the symbol table from a pre-generated nm output file or parse an nm-format text dump. Returns symbol names, sections, addresses, and sizes. Use to verify code placement, find symbol size contributions, detect weak/undefined symbols, or check for duplicate symbol names before linking.',
		params: {
			nmPath: { description: 'Path to a pre-generated nm output file (run: arm-none-eabi-nm --print-size --size-sort --radix=d firmware.elf > firmware.nm). Auto-detected from build dir if omitted.' },
			filter: { description: '"functions" (T/t sections), "variables" (D/d/B/b), or "all" (default)' },
			minSize: { description: 'Only return symbols >= this many bytes. Default: 0 (all).' },
		},
		execute: async (args: Record<string, any>) => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }

			const filter = (args.filter as string | undefined) ?? 'all';
			const minSize = typeof args.minSize === 'number' ? args.minSize : 0;
			const nmPath = (args.nmPath as string | undefined) ?? _inferNmPath(s.lastBuildResult?.outputPath);

			if (!nmPath) {
				return [
					'Could not locate nm output file. Generate one with:',
					'  arm-none-eabi-nm --print-size --size-sort --radix=d build/firmware.elf > build/firmware.nm',
					'Then call fw_read_elf_symbols with nmPath: "build/firmware.nm".',
				].join('\n');
			}

			let content: string;
			try {
				const raw = await fileService.readFile(URI.file(nmPath));
				content = raw.value.toString();
			} catch {
				return [
					`Could not read nm file at ${nmPath}.`,
					'',
					'Generate one with:',
					'  arm-none-eabi-nm --print-size --size-sort --radix=d build/firmware.elf > build/firmware.nm',
				].join('\n');
			}

			return _parseNmOutput(content, filter, minSize);
		},
	};
}


// \u2500\u2500\u2500 Phase 2 parsers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _inferMapPath(outputPath: string | undefined): string | undefined {
	if (!outputPath) { return 'build/firmware.map'; }
	// Replace .elf with .map, or append .map to build dir
	if (outputPath.endsWith('.elf')) { return outputPath.replace(/\.elf$/, '.map'); }
	return outputPath + '/firmware.map';
}

function _inferBuildDir(outputPath: string | undefined): string | undefined {
	if (!outputPath) { return 'build'; }
	if (outputPath.endsWith('.elf')) { return outputPath.replace(/\/[^/]+\.elf$/, ''); }
	return outputPath;
}

function _inferNmPath(outputPath: string | undefined): string | undefined {
	if (!outputPath) { return undefined; }
	if (outputPath.endsWith('.elf')) { return outputPath.replace(/\.elf$/, '.nm'); }
	return undefined;
}


function _parseMapFile(content: string, flashSize: number, ramSize: number, mapPath: string): string {
	const lines = content.split('\n');
	const lines_out: string[] = [`Map File: ${mapPath}`, ''];

	// \u2500\u2500 1. Memory region summary \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	interface MemRegion { name: string; origin: number; length: number; used: number }
	const regions: MemRegion[] = [];
	let inMemoryConfig = false;

	for (const line of lines) {
		if (line.match(/^Memory Configuration/)) { inMemoryConfig = true; continue; }
		if (inMemoryConfig && line.match(/^Linker script and memory map/)) { inMemoryConfig = false; continue; }
		if (inMemoryConfig) {
			// Name   Origin  Length  Attributes
			const m = line.match(/^(\w+)\s+(0x[\da-fA-F]+)\s+(0x[\da-fA-F]+)/);
			if (m && m[1] !== 'Name' && m[1] !== '*default*') {
				regions.push({ name: m[1], origin: parseInt(m[2], 16), length: parseInt(m[3], 16), used: 0 });
			}
		}
	}

	// \u2500\u2500 2. Section sizes \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	interface SectionEntry { name: string; size: number; addr: number }
	const sections: SectionEntry[] = [];
	let inLinkerMap = false;

	for (const line of lines) {
		if (line.match(/^Linker script and memory map/)) { inLinkerMap = true; continue; }
		if (!inLinkerMap) { continue; }
		// .text          0x08000000      0x2f4c
		const m = line.match(/^(\.\w[\w.]*)\s+(0x[\da-fA-F]+)\s+(0x[\da-fA-F]+)/);
		if (m) {
			const size = parseInt(m[3], 16);
			if (size > 0) {
				sections.push({ name: m[1], size, addr: parseInt(m[2], 16) });
			}
		}
	}

	// Summarize canonical sections
	const sectionTotals: Record<string, number> = {};
	for (const sec of sections) {
		const base = sec.name.replace(/\.\d+$/, '').split('.').slice(0, 2).join('.');
		sectionTotals[base] = (sectionTotals[base] ?? 0) + sec.size;
	}

	const textTotal = (sectionTotals['.text'] ?? 0) + (sectionTotals['.rodata'] ?? 0);
	const dataTotal = sectionTotals['.data'] ?? 0;
	const bssTotal = sectionTotals['.bss'] ?? 0;
	const flashUsed = textTotal + dataTotal;
	const ramUsed = dataTotal + bssTotal;

	lines_out.push('Section Sizes:');
	for (const [name, size] of Object.entries(sectionTotals).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
		lines_out.push(`  ${name.padEnd(20)} ${_formatBytes(size)}`);
	}
	lines_out.push('');
	lines_out.push(`Flash usage: ${_formatBytes(flashUsed)}${flashSize > 0 ? ` / ${_formatBytes(flashSize)} (${((flashUsed / flashSize) * 100).toFixed(1)}%)` : ''}`);
	lines_out.push(`RAM   usage: ${_formatBytes(ramUsed)}${ramSize > 0 ? ` / ${_formatBytes(ramSize)} (${((ramUsed / ramSize) * 100).toFixed(1)}%)` : ''}`);

	// \u2500\u2500 3. Top 20 symbols by size \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	interface SymEntry { name: string; size: number; section: string; objFile: string }
	const symbols: SymEntry[] = [];

	// Match symbol entries in map file:  0x08001234   0x100    func_name [file.o]
	const symRegex = /^\s+(0x[\da-fA-F]{8,})\s+(0x[\da-fA-F]+)\s+(\S+)/;
	let currentSection = '';
	let currentObj = '';

	for (const line of lines) {
		const secM = line.match(/^ (\.\w[\w.]*)\s+0x/);
		if (secM) { currentSection = secM[1]; }
		const objM = line.match(/^\s+(.+\.o[bj]?)\((.+)\)$/);
		if (objM) { currentObj = objM[1]; }

		const m = line.match(symRegex);
		if (m) {
			const size = parseInt(m[2], 16);
			if (size >= 16) {
				symbols.push({ name: m[3], size, section: currentSection, objFile: currentObj });
			}
		}
	}

	symbols.sort((a, b) => b.size - a.size);

	if (symbols.length > 0) {
		lines_out.push('', `Top ${Math.min(20, symbols.length)} largest symbols:`);
		for (const sym of symbols.slice(0, 20)) {
			const obj = sym.objFile ? `  (${sym.objFile.split('/').pop()})` : '';
			lines_out.push(`  ${_formatBytes(sym.size).padEnd(10)} ${sym.name}${obj}`);
		}
	}

	// \u2500\u2500 4. Object file contribution \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const objTotals: Record<string, number> = {};
	for (const sym of symbols) {
		if (sym.objFile) {
			const shortName = sym.objFile.split('/').pop() ?? sym.objFile;
			objTotals[shortName] = (objTotals[shortName] ?? 0) + sym.size;
		}
	}
	const topObjs = Object.entries(objTotals).sort((a, b) => b[1] - a[1]).slice(0, 10);
	if (topObjs.length > 0) {
		lines_out.push('', 'Top object file contributions:');
		for (const [name, size] of topObjs) {
			lines_out.push(`  ${_formatBytes(size).padEnd(10)} ${name}`);
		}
	}

	// \u2500\u2500 5. Memory region usage \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (regions.length > 0) {
		lines_out.push('', 'Memory Regions:');
		for (const r of regions) {
			const pct = r.used > 0 ? ` (${((r.used / r.length) * 100).toFixed(1)}%)` : '';
			lines_out.push(`  ${r.name.padEnd(12)} 0x${r.origin.toString(16).padStart(8, '0')}  ${_formatBytes(r.length)}${pct}`);
		}
	}

	return lines_out.join('\n');
}


function _parseNmOutput(content: string, filter: string, minSize: number): string {
	// nm --print-size --size-sort --radix=d format:
	//   address size type name
	// Types: T=text/function, D=data, B=bss, R=rodata, W=weak, U=undefined

	interface NmSym { addr: number; size: number; type: string; name: string }
	const symbols: NmSym[] = [];

	for (const line of content.split('\n')) {
		const m = line.match(/^(\S+)\s+(\S+)\s+([a-zA-Z])\s+(\S+)$/);
		if (!m) { continue; }
		const size = parseInt(m[2]) || parseInt(m[2], 16) || 0;
		symbols.push({ addr: parseInt(m[1]) || 0, size, type: m[3], name: m[4] });
	}

	let filtered = symbols;
	if (filter === 'functions') { filtered = symbols.filter(s => 'Tt'.includes(s.type)); }
	else if (filter === 'variables') { filtered = symbols.filter(s => 'DdBbRr'.includes(s.type)); }
	if (minSize > 0) { filtered = filtered.filter(s => s.size >= minSize); }

	filtered.sort((a, b) => b.size - a.size);

	const undefined_syms = symbols.filter(s => s.type === 'U');
	const weak_syms = symbols.filter(s => 'Ww'.includes(s.type));

	const lines = [
		`ELF Symbol Table \u2014 ${filtered.length} symbol(s) shown (filter: ${filter}, minSize: ${minSize})`,
		'',
		`${'Size'.padEnd(10)} ${'Type'.padEnd(5)} ${'Address'.padEnd(12)} Name`,
	];

	for (const sym of filtered.slice(0, 50)) {
		const typeDesc = _nmTypeDesc(sym.type);
		const addrStr = sym.addr > 0 ? `0x${sym.addr.toString(16).padStart(8, '0')}` : '          ';
		lines.push(`  ${_formatBytes(sym.size).padEnd(10)} ${typeDesc.padEnd(5)} ${addrStr}  ${sym.name}`);
	}

	if (filtered.length > 50) { lines.push(`  \u2026 and ${filtered.length - 50} more`); }

	if (undefined_syms.length > 0) {
		lines.push('', `Undefined symbols (${undefined_syms.length}) \u2014 unresolved at link time:`);
		for (const sym of undefined_syms.slice(0, 10)) { lines.push(`  ${sym.name}`); }
		if (undefined_syms.length > 10) { lines.push(`  \u2026 and ${undefined_syms.length - 10} more`); }
	}

	if (weak_syms.length > 0) {
		lines.push('', `Weak symbols (${weak_syms.length}) \u2014 can be overridden by strong definitions:`);
		for (const sym of weak_syms.slice(0, 10)) { lines.push(`  ${sym.name}`); }
	}

	return lines.join('\n');
}


function _nmTypeDesc(type: string): string {
	switch (type) {
		case 'T': return '.text';
		case 't': return '.text';
		case 'D': return '.data';
		case 'd': return '.data';
		case 'B': return '.bss';
		case 'b': return '.bss';
		case 'R': return '.rodata';
		case 'r': return '.rodata';
		case 'W': return 'weak';
		case 'w': return 'weak';
		case 'U': return 'undef';
		default: return type;
	}
}


function _formatBytes(bytes: number): string {
	if (bytes >= 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
	return `${bytes} B`;
}
