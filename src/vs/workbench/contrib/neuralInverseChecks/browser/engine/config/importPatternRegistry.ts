/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Import Pattern Registry
 *
 * Data-driven, language-agnostic import/dependency resolution for the GRC engine.
 *
 * ## Why this exists
 *
 * The cross-file impact graph (`_importedBy`) must work across ALL languages used
 * in critical and regulated sectors — not just JS/TS. Rather than hardcoding per-language
 * logic in the engine, patterns are defined as plain data so:
 *
 *   - New languages (Verilog, VHDL, Ladder Logic, etc.) are added via config, not code
 *   - Enterprises can override or extend patterns in `.inverse/import-patterns.json`
 *   - The engine applies a single generic resolver for all languages
 *
 * ## Pattern resolution modes
 *
 *   `relative`        — path is relative to the importing file's directory
 *                       e.g. `#include "utils/crc.h"` \u2192 ./utils/crc (from file dir)
 *
 *   `package-to-path` — dot-separated package/namespace converted to slash-separated path
 *                       e.g. `import com.example.auth.Token` \u2192 com/example/auth/Token
 *                       Stored as a workspace-relative path; looked up from source roots.
 *
 * ## Adding a new language
 *
 * Option 1 — without code: add to `.inverse/import-patterns.json` in the workspace:
 *   { "ext": { "patterns": [{ "regex": "...", "group": 1, "resolution": "relative" }] } }
 *
 * Option 2 — to ship built-in: add an entry to BUILTIN_IMPORT_PATTERNS below.
 */

import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../../base/common/uri.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ImportResolution = 'relative' | 'package-to-path';

export interface IImportPattern {
	/** Regex applied to file content. Must have at least one capture group. */
	regex: string;
	/** Which capture group contains the import path (1-indexed). */
	group: number;
	/** How to resolve the captured path to a workspace file. */
	resolution: ImportResolution;
	/**
	 * Optional: prefixes that identify stdlib/vendor imports that should be
	 * skipped (not added to the intra-project dependency graph).
	 */
	externalPrefixes?: string[];
}

export interface ILanguageImportConfig {
	/** Human-readable description (shown in docs / user error messages). */
	comment?: string;
	patterns: IImportPattern[];
}

/** Map of file extension (lowercase, no dot) \u2192 language import config. */
export type IImportPatternMap = Record<string, ILanguageImportConfig>;

// ─── Built-in patterns ───────────────────────────────────────────────────────
// Coverage:
//   Hardware:      Verilog, SystemVerilog, VHDL
//   Safety-critical embedded: C/C++, Ada, Fortran, Assembly
//   Systems:       Rust, Go, Zig, D, Nim
//   JVM:           Java, Kotlin, Scala, Groovy
//   .NET:          C#, F#
//   Scripting:     Python, Ruby, Perl, Lua, TCL, R, Julia
//   Web:           JS/TS, PHP
//   Functional:    Haskell, Erlang, Elixir, OCaml, Clojure
//   Shell/Build:   Bash, PowerShell, Makefile, CMake, Terraform, Bazel
//   Other:         COBOL, Pascal/Delphi, MATLAB (source calls), Swift (file-includes)

export const BUILTIN_IMPORT_PATTERNS: IImportPatternMap = {

	// ── Hardware Description ─────────────────────────────────────────────────

	v: {
		comment: 'Verilog — `include "file.v"',
		patterns: [{ regex: '`include\\s+"([^"]+)"', group: 1, resolution: 'relative' }],
	},
	sv: {
		comment: 'SystemVerilog — `include and package import',
		patterns: [
			{ regex: '`include\\s+"([^"]+)"', group: 1, resolution: 'relative' },
			// `import pkg::*` — package is in pkg.sv in same or include path
			{ regex: '\\bimport\\s+(\\w+)::', group: 1, resolution: 'relative' },
		],
	},
	svh: {
		comment: 'SystemVerilog header — same as .sv',
		patterns: [{ regex: '`include\\s+"([^"]+)"', group: 1, resolution: 'relative' }],
	},
	vhd: {
		comment: 'VHDL — use Library.Package.all',
		patterns: [{
			regex: '\\buse\\s+(\\w+\\.\\w+)',
			group: 1,
			resolution: 'package-to-path',
			externalPrefixes: ['IEEE.', 'STD.', 'VITAL_', 'Synopsys.'],
		}],
	},
	vhdl: {
		comment: 'VHDL (alternate extension)',
		patterns: [{
			regex: '\\buse\\s+(\\w+\\.\\w+)',
			group: 1,
			resolution: 'package-to-path',
			externalPrefixes: ['IEEE.', 'STD.', 'VITAL_', 'Synopsys.'],
		}],
	},

	// ── Safety-Critical Embedded ─────────────────────────────────────────────

	c: {
		comment: 'C — quoted #include (angle-bracket = system, skipped)',
		patterns: [{ regex: '#\\s*include\\s+"([^"]+)"', group: 1, resolution: 'relative' }],
	},
	h: {
		comment: 'C header',
		patterns: [{ regex: '#\\s*include\\s+"([^"]+)"', group: 1, resolution: 'relative' }],
	},
	cpp: {
		comment: 'C++',
		patterns: [{ regex: '#\\s*include\\s+"([^"]+)"', group: 1, resolution: 'relative' }],
	},
	cc: {
		comment: 'C++ (alternate)',
		patterns: [{ regex: '#\\s*include\\s+"([^"]+)"', group: 1, resolution: 'relative' }],
	},
	cxx: {
		comment: 'C++ (alternate)',
		patterns: [{ regex: '#\\s*include\\s+"([^"]+)"', group: 1, resolution: 'relative' }],
	},
	hpp: {
		comment: 'C++ header',
		patterns: [{ regex: '#\\s*include\\s+"([^"]+)"', group: 1, resolution: 'relative' }],
	},
	hxx: {
		comment: 'C++ header (alternate)',
		patterns: [{ regex: '#\\s*include\\s+"([^"]+)"', group: 1, resolution: 'relative' }],
	},
	m: {
		comment: 'Objective-C',
		patterns: [{ regex: '#\\s*include\\s+"([^"]+)"', group: 1, resolution: 'relative' }],
	},
	mm: {
		comment: 'Objective-C++',
		patterns: [{ regex: '#\\s*include\\s+"([^"]+)"', group: 1, resolution: 'relative' }],
	},

	// Ada — with PackageName; (Ada.* / GNAT.* / Interfaces.* are stdlib)
	adb: {
		comment: 'Ada body — with Package;',
		patterns: [{
			regex: '^\\s*with\\s+([\\w.]+)\\s*;',
			group: 1,
			resolution: 'package-to-path',
			externalPrefixes: ['Ada.', 'GNAT.', 'Interfaces.', 'System.', 'Standard'],
		}],
	},
	ads: {
		comment: 'Ada spec — with Package;',
		patterns: [{
			regex: '^\\s*with\\s+([\\w.]+)\\s*;',
			group: 1,
			resolution: 'package-to-path',
			externalPrefixes: ['Ada.', 'GNAT.', 'Interfaces.', 'System.', 'Standard'],
		}],
	},
	ada: {
		comment: 'Ada (alternate extension)',
		patterns: [{
			regex: '^\\s*with\\s+([\\w.]+)\\s*;',
			group: 1,
			resolution: 'package-to-path',
			externalPrefixes: ['Ada.', 'GNAT.', 'Interfaces.', 'System.', 'Standard'],
		}],
	},

	// Fortran — USE module_name (intrinsic modules are stdlib)
	f90: {
		comment: 'Fortran 90+ — USE module',
		patterns: [{
			regex: '^\\s*USE\\s+([\\w_]+)',
			group: 1,
			resolution: 'package-to-path',
			externalPrefixes: ['ISO_', 'OMP_LIB', 'MPI'],
		}],
	},
	f95: { comment: 'Fortran 95', patterns: [{ regex: '^\\s*USE\\s+([\\w_]+)', group: 1, resolution: 'package-to-path', externalPrefixes: ['ISO_', 'OMP_LIB', 'MPI'] }] },
	f03: { comment: 'Fortran 2003', patterns: [{ regex: '^\\s*USE\\s+([\\w_]+)', group: 1, resolution: 'package-to-path', externalPrefixes: ['ISO_', 'OMP_LIB', 'MPI'] }] },
	f08: { comment: 'Fortran 2008', patterns: [{ regex: '^\\s*USE\\s+([\\w_]+)', group: 1, resolution: 'package-to-path', externalPrefixes: ['ISO_', 'OMP_LIB', 'MPI'] }] },
	f: { comment: 'Fortran (fixed form)', patterns: [{ regex: '^\\s*USE\\s+([\\w_]+)', group: 1, resolution: 'package-to-path', externalPrefixes: ['ISO_', 'OMP_LIB'] }] },
	for: { comment: 'Fortran (alternate)', patterns: [{ regex: '^\\s*USE\\s+([\\w_]+)', group: 1, resolution: 'package-to-path', externalPrefixes: ['ISO_', 'OMP_LIB'] }] },

	// Assembly — INCLUDE / .include directives (GAS, NASM, MASM)
	asm: {
		comment: 'Assembly (NASM/MASM) — %include / INCLUDE',
		patterns: [
			{ regex: '%include\\s+"([^"]+)"', group: 1, resolution: 'relative' },
			{ regex: '%include\\s+\'([^\']+)\'', group: 1, resolution: 'relative' },
			{ regex: '^\\s*INCLUDE\\s+(\\S+)', group: 1, resolution: 'relative' },
		],
	},
	s: {
		comment: 'Assembly (GAS) — .include',
		patterns: [{ regex: '\\.include\\s+"([^"]+)"', group: 1, resolution: 'relative' }],
	},
	// uppercase .S (preprocessed assembly — uses C #include)
	// handled by matching 's' case-insensitively via extension lowercasing

	// ── Systems Languages ────────────────────────────────────────────────────

	rs: {
		comment: 'Rust — mod name; (resolves to ./name.rs or ./name/mod.rs)',
		patterns: [
			{ regex: '^\\s*(?:pub\\s+(?:crate\\s+)?|pub\\s*\\([^)]*\\)\\s*)?mod\\s+(\\w+)\\s*;', group: 1, resolution: 'relative' },
		],
	},

	go: {
		comment: 'Go — relative import paths only (./pkg, ../pkg)',
		patterns: [{ regex: 'import\\s+(?:[\\w.]+\\s+)?["\'](\\.{1,2}/[^"\']+)["\']', group: 1, resolution: 'relative' }],
	},

	zig: {
		comment: 'Zig — @import("file.zig") for relative paths',
		patterns: [{ regex: '@import\\s*\\(\\s*"(\\.{1,2}/[^"]+)"', group: 1, resolution: 'relative' }],
	},

	d: {
		comment: 'D — import path.to.module (dot = slash)',
		patterns: [{
			regex: '^\\s*import\\s+([\\w.]+)\\s*(?:=\\s*[\\w.]+)?\\s*;',
			group: 1,
			resolution: 'package-to-path',
			externalPrefixes: ['std.', 'core.', 'rt.', 'object'],
		}],
	},

	nim: {
		comment: 'Nim — import module / include "file"',
		patterns: [
			{ regex: '^\\s*import\\s+([\\w/]+)', group: 1, resolution: 'relative' },
			{ regex: '^\\s*include\\s+"([^"]+)"', group: 1, resolution: 'relative' },
		],
	},

	// ── JVM Languages ────────────────────────────────────────────────────────

	java: {
		comment: 'Java — import com.example.Class',
		patterns: [{
			regex: '^\\s*import\\s+(?:static\\s+)?([\\w.]+)(?:\\.\\*)?\\s*;',
			group: 1,
			resolution: 'package-to-path',
			externalPrefixes: [
				'java.', 'javax.', 'jakarta.', 'sun.', 'com.sun.', 'jdk.',
				'android.', 'androidx.', 'dalvik.',
				'org.junit.', 'org.testng.', 'org.mockito.',
				'org.springframework.', 'org.hibernate.',
				'com.google.guava', 'com.fasterxml.', 'io.netty.',
			],
		}],
	},

	kt: {
		comment: 'Kotlin — import com.example.Class',
		patterns: [{
			regex: '^\\s*import\\s+([\\w.]+)(?:\\.\\*)?',
			group: 1,
			resolution: 'package-to-path',
			externalPrefixes: ['java.', 'javax.', 'kotlin.', 'kotlinx.', 'android.', 'androidx.'],
		}],
	},
	kts: {
		comment: 'Kotlin Script',
		patterns: [{
			regex: '^\\s*import\\s+([\\w.]+)(?:\\.\\*)?',
			group: 1,
			resolution: 'package-to-path',
			externalPrefixes: ['java.', 'javax.', 'kotlin.', 'kotlinx.'],
		}],
	},

	scala: {
		comment: 'Scala — import com.example.Class',
		patterns: [{
			regex: '^\\s*import\\s+([\\w.]+)(?:\\.(?:\\{[^}]+\\}|_))?',
			group: 1,
			resolution: 'package-to-path',
			externalPrefixes: ['java.', 'javax.', 'scala.', 'akka.', 'cats.', 'zio.'],
		}],
	},

	groovy: {
		comment: 'Groovy — same as Java',
		patterns: [{
			regex: '^\\s*import\\s+(?:static\\s+)?([\\w.]+)(?:\\.\\*)?\\s*',
			group: 1,
			resolution: 'package-to-path',
			externalPrefixes: ['java.', 'javax.', 'groovy.', 'org.codehaus.'],
		}],
	},

	// ── .NET ─────────────────────────────────────────────────────────────────

	cs: {
		comment: 'C# — using Company.Namespace',
		patterns: [{
			regex: '^\\s*using\\s+(?:static\\s+|global\\s+)?([\\w.]+)\\s*;',
			group: 1,
			resolution: 'package-to-path',
			externalPrefixes: ['System', 'Microsoft.', 'Windows.', 'Xunit.', 'NUnit.', 'Moq.', 'Newtonsoft.', 'AutoMapper.'],
		}],
	},
	csx: { comment: 'C# Script', patterns: [{ regex: '^\\s*using\\s+(?:static\\s+|global\\s+)?([\\w.]+)\\s*;', group: 1, resolution: 'package-to-path', externalPrefixes: ['System', 'Microsoft.', 'Windows.'] }] },

	fs: {
		comment: 'F# — open Namespace',
		patterns: [{
			regex: '^\\s*open\\s+([\\w.]+)',
			group: 1,
			resolution: 'package-to-path',
			externalPrefixes: ['System', 'Microsoft.', 'FSharp.'],
		}],
	},
	fsx: { comment: 'F# Script', patterns: [{ regex: '^\\s*open\\s+([\\w.]+)', group: 1, resolution: 'package-to-path', externalPrefixes: ['System', 'Microsoft.', 'FSharp.'] }] },

	// ── JavaScript / TypeScript ──────────────────────────────────────────────

	ts: {
		comment: 'TypeScript — import/export/require (relative paths)',
		patterns: [{
			regex: '(?:import\\s+(?:type\\s+)?(?:[^\'"\\n]*?from\\s+)?|export\\s+(?:type\\s+)?(?:[^\'"\\n]*?from\\s+)|(?:const|let|var)\\s+[^=]+=\\s*(?:await\\s+)?(?:require|import)\\s*\\()[\'"]([^\'"]+)[\'"]',
			group: 1,
			resolution: 'relative',
		}],
	},
	tsx: { comment: 'TypeScript JSX', patterns: [{ regex: '(?:import\\s+(?:type\\s+)?(?:[^\'"\\n]*?from\\s+)?|export\\s+(?:type\\s+)?(?:[^\'"\\n]*?from\\s+)|(?:const|let|var)\\s+[^=]+=\\s*(?:await\\s+)?(?:require|import)\\s*\\()[\'"]([^\'"]+)[\'"]', group: 1, resolution: 'relative' }] },
	js: { comment: 'JavaScript', patterns: [{ regex: '(?:import\\s+(?:type\\s+)?(?:[^\'"\\n]*?from\\s+)?|export\\s+(?:type\\s+)?(?:[^\'"\\n]*?from\\s+)|(?:const|let|var)\\s+[^=]+=\\s*(?:await\\s+)?(?:require|import)\\s*\\()[\'"]([^\'"]+)[\'"]', group: 1, resolution: 'relative' }] },
	jsx: { comment: 'JavaScript JSX', patterns: [{ regex: '(?:import\\s+(?:type\\s+)?(?:[^\'"\\n]*?from\\s+)?|export\\s+(?:type\\s+)?(?:[^\'"\\n]*?from\\s+)|(?:const|let|var)\\s+[^=]+=\\s*(?:await\\s+)?(?:require|import)\\s*\\()[\'"]([^\'"]+)[\'"]', group: 1, resolution: 'relative' }] },
	mjs: { comment: 'ES Module', patterns: [{ regex: '(?:import\\s+(?:type\\s+)?(?:[^\'"\\n]*?from\\s+)?|export\\s+(?:type\\s+)?(?:[^\'"\\n]*?from\\s+)|(?:const|let|var)\\s+[^=]+=\\s*(?:await\\s+)?(?:require|import)\\s*\\()[\'"]([^\'"]+)[\'"]', group: 1, resolution: 'relative' }] },
	cjs: { comment: 'CommonJS', patterns: [{ regex: '(?:import\\s+(?:type\\s+)?(?:[^\'"\\n]*?from\\s+)?|export\\s+(?:type\\s+)?(?:[^\'"\\n]*?from\\s+)|(?:const|let|var)\\s+[^=]+=\\s*(?:await\\s+)?(?:require|import)\\s*\\()[\'"]([^\'"]+)[\'"]', group: 1, resolution: 'relative' }] },

	// ── Scripting ─────────────────────────────────────────────────────────────

	py: {
		comment: 'Python — relative from . imports only (from .mod import x)',
		patterns: [{
			// Captures dot-prefix and module name separately; join handled in resolver
			regex: '^\\s*from\\s+(\\.+[\\w./]*)\\s+import',
			group: 1,
			resolution: 'relative',
		}],
	},

	rb: {
		comment: 'Ruby — require_relative',
		patterns: [{ regex: 'require_relative\\s+[\'"]([^\'"]+)[\'"]', group: 1, resolution: 'relative' }],
	},

	pl: {
		comment: 'Perl — require / use (relative paths)',
		patterns: [
			{ regex: "require\\s+'([^']+)'", group: 1, resolution: 'relative' },
			{ regex: 'require\\s+"([^"]+)"', group: 1, resolution: 'relative' },
		],
	},
	pm: { comment: 'Perl module', patterns: [{ regex: "require\\s+'([^']+)'", group: 1, resolution: 'relative' }, { regex: 'require\\s+"([^"]+)"', group: 1, resolution: 'relative' }] },

	lua: {
		comment: 'Lua — require("a.b.c") \u2192 a/b/c',
		patterns: [{ regex: 'require\\s*\\(?\\s*[\'"]([^\'"]+)[\'"]\\s*\\)?', group: 1, resolution: 'package-to-path' }],
	},

	tcl: {
		comment: 'TCL — source file.tcl',
		patterns: [{ regex: 'source\\s+[\'"]?([\\w./\\-]+\\.tcl)[\'"]?', group: 1, resolution: 'relative' }],
	},

	r: {
		comment: 'R — source("file.R")',
		patterns: [{ regex: 'source\\s*\\(\\s*[\'"]([^\'"]+)[\'"]', group: 1, resolution: 'relative' }],
	},

	jl: {
		comment: 'Julia — include("file.jl")',
		patterns: [{ regex: 'include\\s*\\(\\s*[\'"]([^\'"]+)[\'"]', group: 1, resolution: 'relative' }],
	},

	php: {
		comment: 'PHP — relative require/include',
		patterns: [{ regex: '(?:require|include)(?:_once)?\\s*\\(?\\s*[\'"]([^\'"]+)[\'"]', group: 1, resolution: 'relative' }],
	},

	// ── Functional ────────────────────────────────────────────────────────────

	hs: {
		comment: 'Haskell — import Module.Name',
		patterns: [{
			regex: '^\\s*import\\s+(?:qualified\\s+)?([\\w.]+)',
			group: 1,
			resolution: 'package-to-path',
			externalPrefixes: ['Prelude', 'Data.', 'Control.', 'System.', 'Text.', 'Network.', 'GHC.'],
		}],
	},

	erl: {
		comment: 'Erlang — -include("file.hrl")',
		patterns: [
			{ regex: '-include\\s*\\(\\s*"([^"]+)"', group: 1, resolution: 'relative' },
			{ regex: '-include_lib\\s*\\(\\s*"([^"]+)"', group: 1, resolution: 'relative' },
		],
	},
	hrl: { comment: 'Erlang header', patterns: [{ regex: '-include\\s*\\(\\s*"([^"]+)"', group: 1, resolution: 'relative' }] },

	ex: {
		comment: 'Elixir — import/alias Module',
		patterns: [{
			regex: '^\\s*(?:import|alias|use)\\s+([\\w.]+)',
			group: 1,
			resolution: 'package-to-path',
			externalPrefixes: ['Elixir.', 'Kernel', 'Phoenix.', 'Ecto.', 'Plug.'],
		}],
	},
	exs: { comment: 'Elixir Script', patterns: [{ regex: '^\\s*(?:import|alias|use)\\s+([\\w.]+)', group: 1, resolution: 'package-to-path', externalPrefixes: ['Elixir.', 'Kernel', 'Phoenix.', 'Ecto.'] }] },

	ml: {
		comment: 'OCaml — open Module',
		patterns: [{
			regex: '^\\s*open\\s+([\\w.]+)',
			group: 1,
			resolution: 'package-to-path',
			externalPrefixes: ['Stdlib.', 'Printf', 'List', 'Array', 'String', 'Bytes', 'Buffer', 'Format', 'Unix.'],
		}],
	},
	mli: { comment: 'OCaml interface', patterns: [{ regex: '^\\s*open\\s+([\\w.]+)', group: 1, resolution: 'package-to-path', externalPrefixes: ['Stdlib.', 'Printf', 'List', 'Array', 'String'] }] },

	clj: {
		comment: 'Clojure — (:require [namespace.module])',
		patterns: [{ regex: '\\(:require\\s+\\[([\\w./\\-]+)', group: 1, resolution: 'package-to-path', externalPrefixes: ['clojure.', 'cljs.'] }],
	},
	cljs: { comment: 'ClojureScript', patterns: [{ regex: '\\(:require\\s+\\[([\\w./\\-]+)', group: 1, resolution: 'package-to-path', externalPrefixes: ['clojure.', 'cljs.', 'goog.'] }] },

	// ── Shell / Build ─────────────────────────────────────────────────────────

	sh: {
		comment: 'Shell — source ./file.sh',
		patterns: [{ regex: '(?:^|\\n)\\s*(?:source|\\.)\\s+[\'"]?(\\.{1,2}/[^\'"\\s;\\n]+)', group: 1, resolution: 'relative' }],
	},
	bash: { comment: 'Bash', patterns: [{ regex: '(?:^|\\n)\\s*(?:source|\\.)\\s+[\'"]?(\\.{1,2}/[^\'"\\s;\\n]+)', group: 1, resolution: 'relative' }] },
	zsh: { comment: 'Zsh', patterns: [{ regex: '(?:^|\\n)\\s*(?:source|\\.)\\s+[\'"]?(\\.{1,2}/[^\'"\\s;\\n]+)', group: 1, resolution: 'relative' }] },
	ps1: {
		comment: 'PowerShell — . ./script.ps1 / Import-Module ./Module',
		patterns: [
			{ regex: '(?:^|\\n)\\s*\\.\\s+[\'"]?(\\.{1,2}/[^\'"\\s;\\n]+)', group: 1, resolution: 'relative' },
			{ regex: 'Import-Module\\s+[\'"]?(\\.{1,2}/[^\'"\\s;\\n]+)', group: 1, resolution: 'relative' },
		],
	},

	// Makefile — include sub.mk
	mk: {
		comment: 'Makefile fragment — include',
		patterns: [{ regex: '^\\s*-?include\\s+(\\S+)', group: 1, resolution: 'relative' }],
	},
	cmake: {
		comment: 'CMake — include(path/file.cmake)',
		patterns: [{ regex: '\\binclude\\s*\\(\\s*([\\w./\\-]+)', group: 1, resolution: 'relative' }],
	},

	tf: {
		comment: 'Terraform — module source = "./path"',
		patterns: [{ regex: 'source\\s*=\\s*"(\\.{1,2}/[^"]+)"', group: 1, resolution: 'relative' }],
	},

	bzl: {
		comment: 'Bazel/Starlark — load("//path:file.bzl", ...)',
		patterns: [{ regex: 'load\\s*\\(\\s*"(//[^"]+)"', group: 1, resolution: 'relative' }],
	},

	// ── Legacy / Specialised ──────────────────────────────────────────────────

	cob: {
		comment: 'COBOL — COPY copybook',
		patterns: [{ regex: '\\bCOPY\\s+([\\w\\-]+)', group: 1, resolution: 'package-to-path' }],
	},
	cbl: { comment: 'COBOL', patterns: [{ regex: '\\bCOPY\\s+([\\w\\-]+)', group: 1, resolution: 'package-to-path' }] },
	cobol: { comment: 'COBOL', patterns: [{ regex: '\\bCOPY\\s+([\\w\\-]+)', group: 1, resolution: 'package-to-path' }] },

	pas: {
		comment: 'Pascal/Delphi — uses UnitName',
		patterns: [{ regex: '\\buses\\s+([\\w,\\s]+)\\s*;', group: 1, resolution: 'package-to-path', externalPrefixes: ['SysUtils', 'Classes', 'Forms', 'Dialogs', 'Windows', 'Vcl.'] }],
	},
	dpr: { comment: 'Delphi project', patterns: [{ regex: '\\buses\\s+([\\w,\\s]+)\\s*;', group: 1, resolution: 'package-to-path', externalPrefixes: ['SysUtils', 'Classes', 'Forms', 'Windows', 'Vcl.'] }] },

	// Swift — import is module-level, not file-level; file resolution not actionable
	// MATLAB .m — function calls resolve by filename; no explicit import syntax
};

// ─── Registry class ──────────────────────────────────────────────────────────

/**
 * Loads built-in import patterns and merges user overrides from
 * `.inverse/import-patterns.json`. Provides `getPatterns(ext)` for
 * the import map bootstrap and `_updateImportMap`.
 */
export class ImportPatternRegistry {
	private _merged: IImportPatternMap = { ...BUILTIN_IMPORT_PATTERNS };

	constructor(
		private readonly fileService: IFileService,
		private readonly workspaceContextService: IWorkspaceContextService,
	) {
		this._loadUserPatterns().catch(() => { /* user file absent — fine */ });
	}

	/** Get patterns for a given file extension (lowercase, no dot). Returns [] if unknown. */
	getPatterns(ext: string): IImportPattern[] {
		return this._merged[ext]?.patterns ?? [];
	}

	/** All extensions that have at least one pattern registered. */
	get knownExtensions(): ReadonlySet<string> {
		return new Set(Object.keys(this._merged));
	}

	private async _loadUserPatterns(): Promise<void> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		for (const folder of folders) {
			const uri = URI.joinPath(folder.uri, '.inverse', 'import-patterns.json');
			try {
				const file = await this.fileService.readFile(uri);
				const overrides: IImportPatternMap = JSON.parse(file.value.toString());
				for (const [ext, cfg] of Object.entries(overrides)) {
					const existing = this._merged[ext];
					if (existing) {
						// Append user patterns — user patterns take precedence (evaluated first)
						this._merged[ext] = { ...existing, patterns: [...cfg.patterns, ...existing.patterns] };
					} else {
						this._merged[ext] = cfg;
					}
				}
				console.log(`[ImportPatternRegistry] Loaded user patterns from ${uri.fsPath}: ${Object.keys(overrides).length} extension(s) extended`);
			} catch { /* file not found or invalid JSON — skip */ }
		}
	}
}
