/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # EnclaveToolchainService
 *
 * Cryptographic verification of the development toolchain: compilers, linkers, SDKs,
 * runtimes, and package managers. Ensures that only approved, hash-verified tools
 * participate in the build pipeline.
 *
 * ## Why This Matters
 * A compromised compiler can inject malicious code during compilation without ever
 * touching the source. This is the "trusting trust" attack (Ken Thompson, 1984).
 * DO-178C (avionics), ISO 26262 (automotive), and IEC 62304 (medical) all require
 * tool qualification \u2014 formally proving that your tools are approved and their
 * outputs are trustworthy.
 *
 * The Enclave Toolchain Service provides:
 *   1. Discovery of all relevant toolchain binaries in the workspace
 *   2. SHA-256 hashing of each binary
 *   3. Comparison against an enterprise-approved manifest
 *   4. ECDSA-signed verification records
 *   5. Build-blocking enforcement in `locked_down` mode
 *
 * ## Approved Manifest Format (`.inverse/toolchain-manifest.json`)
 * ```json
 * {
 *   "version": "1",
 *   "approvedAt": "2026-04-07T00:00:00Z",
 *   "approvedBy": "security-team@corp.com",
 *   "tools": [
 *     {
 *       "name": "gcc",
 *       "expectedPath": "/usr/bin/gcc",
 *       "expectedHash": "sha256:abc123...",
 *       "version": "12.3.0",
 *       "purpose": "C/C++ compiler"
 *     }
 *   ]
 * }
 * ```
 *
 * ## Verification Record (per tool, per session)
 * ```json
 * {
 *   "id": "uuid",
 *   "sessionId": "ses_...",
 *   "toolName": "gcc",
 *   "toolPath": "/usr/bin/gcc",
 *   "expectedHash": "sha256:abc123...",
 *   "actualHash":   "sha256:abc123...",
 *   "status": "approved" | "mismatch" | "unlisted" | "not_found",
 *   "version": "12.3.0",
 *   "timestamp": 1712345678000,
 *   "signature": "base64url..."
 * }
 * ```
 */

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IEnclaveCryptoService } from '../crypto/enclaveCryptoService.js';
import { IEnclaveSessionService } from '../session/enclaveSessionService.js';
import { IEnclaveAuditTrailService } from '../audit/enclaveAuditTrailService.js';
import { IEnclaveEnvironmentService } from '../environment/enclaveEnvironmentService.js';

export const IEnclaveToolchainService = createDecorator<IEnclaveToolchainService>('enclaveToolchainService');

// \u2500\u2500\u2500 Types \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export type ToolVerificationStatus = 'approved' | 'mismatch' | 'unlisted' | 'not_found';

export interface IApprovedToolEntry {
	/** Human-readable name, e.g. "gcc", "rustc", "node" */
	readonly name: string;
	/** Absolute path to the binary */
	readonly expectedPath: string;
	/** SHA-256 hex string, prefixed with "sha256:" */
	readonly expectedHash: string;
	/** Tool version string */
	readonly version: string;
	/** Human-readable purpose */
	readonly purpose: string;
}

export interface IToolchainManifest {
	readonly version: '1';
	readonly approvedAt: string;
	readonly approvedBy: string;
	readonly tools: IApprovedToolEntry[];
}

export interface IToolVerificationRecord {
	/** UUIDv4 */
	readonly id: string;
	readonly sessionId: string;
	readonly toolName: string;
	readonly toolPath: string;
	/** Expected hash from manifest. null if tool is unlisted. */
	readonly expectedHash: string | null;
	/** Actual computed hash of the binary */
	readonly actualHash: string;
	/** File size in bytes */
	readonly sizeBytes: number;
	readonly status: ToolVerificationStatus;
	readonly timestamp: number;
	readonly signature: string;
}

export interface IToolchainVerificationSummary {
	readonly sessionId: string;
	readonly timestamp: number;
	readonly manifestPath: string | null;
	readonly totalDiscovered: number;
	readonly approved: number;
	readonly mismatched: number;
	readonly unlisted: number;
	readonly notFound: number;
	readonly records: IToolVerificationRecord[];
	readonly overallStatus: 'clean' | 'warnings' | 'violations';
	readonly signature: string;
}

export interface IEnclaveToolchainService {
	readonly _serviceBrand: undefined;

	/** Fires when toolchain verification completes */
	readonly onDidVerify: Event<IToolchainVerificationSummary>;
	/** Fires when a mismatch or unlisted tool is found */
	readonly onDidDetectViolation: Event<IToolVerificationRecord>;

	/**
	 * Run toolchain verification against the workspace manifest.
	 * Discovers tools, hashes each binary, compares against manifest.
	 * Results are ECDSA-signed and persisted.
	 */
	verifyToolchain(): Promise<IToolchainVerificationSummary>;

	/**
	 * Get the most recent verification summary for this session.
	 * null if verification has not been run yet.
	 */
	getLastVerification(): IToolchainVerificationSummary | null;

	/**
	 * Check if the toolchain is approved (no mismatches, no unlisted tools in locked_down).
	 * Safe to call synchronously \u2014 uses the cached last verification.
	 */
	isToolchainClean(): boolean;

	/**
	 * Generate an approved toolchain manifest from the current environment.
	 * Used to bootstrap the first manifest \u2014 should only be called by a trusted admin.
	 */
	generateManifest(toolPaths: string[]): Promise<IToolchainManifest>;
}

// \u2500\u2500\u2500 Constants \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const MANIFEST_PATH = '.inverse/toolchain-manifest.json';
const VERIFICATION_FOLDER = '.inverse/toolchain';
const LARGE_BINARY_THRESHOLD = 500 * 1024 * 1024; // 500MB \u2014 skip hash for huge files

/**
 * HOME prefix helper \u2014 resolved at module load time.
 */
const HOME = typeof process !== 'undefined' ? (process.env['HOME'] ?? '') : '';

/**
 * Comprehensive default tool paths for ALL regulated/critical software domains.
 *
 * Organised by domain so the manifest generator can be domain-scoped.
 * Paths cover: macOS (Homebrew + system), Linux (Debian/RHEL), and common
 * Windows Subsystem for Linux paths. Enterprise tool installations are
 * represented by the most common install prefixes.
 *
 * Domains covered:
 *  A. Web/Node/General \u2014 npm, node, deno, bun
 *  B. Rust \u2014 rustc, cargo, clippy, rustfmt, cross
 *  C. Python \u2014 python3, pip3, uv, poetry, ruff, mypy, bandit
 *  D. Go \u2014 go, golint, staticcheck
 *  E. Java/.NET/JVM \u2014 javac, kotlinc, dotnet, mvn, gradle
 *  F. Swift/Dart/Flutter \u2014 swift, dart, flutter
 *  G. C/C++ General \u2014 gcc, g++, clang, clang++, ld, ar, objdump
 *  H. Embedded/Cross-Compile \u2014 arm-none-eabi-*, avr-gcc, xtensa, riscv
 *  I. Aerospace/Avionics (DO-178C) \u2014 IAR EWARM, Green Hills MULTI, Ada GNAT, SPARK
 *  J. Automotive (ISO 26262) \u2014 arm-none-eabi qualified compilers, Polyspace
 *  K. Medical (IEC 62304) \u2014 same + MISRA analysis
 *  L. Defense/High-Assurance \u2014 Frama-C, Why3, TLA+, Coq, Isabelle
 *  M. Hardware Debug/Flash \u2014 OpenOCD, J-Link, pyOCD, ST-Link, Lauterbach
 *  N. PLC/Industrial (IEC 61131, IEC 61508) \u2014 CODESYS, TwinCAT
 *  O. Static Analysis \u2014 Coverity, Klocwork, Cppcheck, LDRA, SonarQube, clang-tidy
 *  P. Build Systems \u2014 make, cmake, bazel, meson, ninja, scons
 *  Q. Containers/Infra \u2014 docker, podman, kubectl
 *  R. VCS \u2014 git, svn, perforce (p4)
 *  S. Package Managers \u2014 npm, yarn, pnpm, pip, cargo, gem, composer, conan, vcpkg
 *  T. Signing/Security \u2014 gpg, openssl, cosign, sigstore
 */
const DEFAULT_TOOL_PATHS: string[] = [

	// \u2500\u2500 A. Node / Web \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	'/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node',
	'/usr/local/bin/deno', '/opt/homebrew/bin/deno',
	'/usr/local/bin/bun', `${HOME}/.bun/bin/bun`,
	'/usr/local/bin/ts-node', `${HOME}/.npm-global/bin/ts-node`,

	// \u2500\u2500 B. Rust \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	`${HOME}/.cargo/bin/rustc`,
	`${HOME}/.cargo/bin/cargo`,
	`${HOME}/.cargo/bin/clippy-driver`,
	`${HOME}/.cargo/bin/rustfmt`,
	`${HOME}/.cargo/bin/cross`,
	`${HOME}/.cargo/bin/cargo-audit`,
	`${HOME}/.cargo/bin/cargo-deny`,

	// \u2500\u2500 C. Python \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	'/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3',
	'/usr/bin/python', '/usr/local/bin/python',
	'/usr/local/bin/pip3', '/opt/homebrew/bin/pip3',
	`${HOME}/.local/bin/uv`, '/usr/local/bin/uv',
	`${HOME}/.local/bin/poetry`, '/usr/local/bin/poetry',
	`${HOME}/.local/bin/ruff`, '/usr/local/bin/ruff',
	`${HOME}/.local/bin/mypy`, '/usr/local/bin/mypy',
	`${HOME}/.local/bin/bandit`,      // security linter \u2014 IEC 62304 relevant
	`${HOME}/.local/bin/safety`,      // dep vulnerability check

	// \u2500\u2500 D. Go \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	'/usr/local/go/bin/go', '/opt/homebrew/bin/go',
	`${HOME}/go/bin/staticcheck`,
	`${HOME}/go/bin/golangci-lint`, '/usr/local/bin/golangci-lint',
	`${HOME}/go/bin/golint`,

	// \u2500\u2500 E. Java / .NET / JVM \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// Java compilers
	'/usr/bin/javac', '/usr/local/bin/javac',
	'/usr/lib/jvm/default-java/bin/javac',
	'/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/javac',
	'/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home/bin/javac',
	'/Library/Java/JavaVirtualMachines/temurin-11.jdk/Contents/Home/bin/javac',
	// Kotlin
	'/usr/local/bin/kotlinc', '/opt/homebrew/bin/kotlinc',
	// .NET / C#
	'/usr/local/bin/dotnet', '/opt/homebrew/bin/dotnet',
	'/usr/share/dotnet/dotnet',
	// Build tools
	'/usr/local/bin/mvn', '/opt/homebrew/bin/mvn', '/usr/bin/mvn',
	'/usr/local/bin/gradle', '/opt/homebrew/bin/gradle', '/usr/bin/gradle',

	// \u2500\u2500 F. Swift / Dart / Flutter \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	'/usr/bin/swift', '/usr/local/bin/swift',
	`${HOME}/flutter/bin/dart`, '/usr/local/bin/dart',
	`${HOME}/flutter/bin/flutter`, '/usr/local/bin/flutter',

	// \u2500\u2500 G. C/C++ General \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	'/usr/bin/gcc', '/usr/bin/gcc-12', '/usr/bin/gcc-13', '/opt/homebrew/bin/gcc',
	'/usr/bin/g++', '/usr/bin/g++-12', '/usr/bin/g++-13', '/opt/homebrew/bin/g++',
	'/usr/bin/clang', '/usr/bin/clang-15', '/usr/bin/clang-16', '/opt/homebrew/bin/clang',
	'/usr/bin/clang++', '/opt/homebrew/bin/clang++',
	'/usr/bin/ld', '/usr/bin/ld.gold', '/usr/bin/ld.lld',
	'/usr/bin/ar', '/usr/bin/objdump', '/usr/bin/nm', '/usr/bin/strip',
	'/usr/bin/addr2line', '/usr/bin/readelf', '/usr/bin/objcopy',
	'/usr/local/bin/llvm-objdump', '/opt/homebrew/bin/llvm-objdump',

	// \u2500\u2500 H. Embedded / Cross-Compilers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// ARM Cortex-M / Cortex-A (GCC embedded)
	'/usr/bin/arm-none-eabi-gcc',
	'/usr/local/bin/arm-none-eabi-gcc',
	'/opt/homebrew/bin/arm-none-eabi-gcc',
	`${HOME}/gcc-arm-none-eabi/bin/arm-none-eabi-gcc`,
	'/usr/bin/arm-none-eabi-g++',
	'/usr/bin/arm-none-eabi-ld',
	'/usr/bin/arm-none-eabi-objcopy',
	'/usr/bin/arm-none-eabi-objdump',
	'/usr/bin/arm-none-eabi-size',
	'/usr/bin/arm-linux-gnueabihf-gcc',   // ARM Linux (e.g. Raspberry Pi)
	'/usr/bin/aarch64-linux-gnu-gcc',
	// AVR (Arduino ecosystem)
	'/usr/bin/avr-gcc', '/opt/homebrew/bin/avr-gcc',
	'/usr/bin/avrdude', '/opt/homebrew/bin/avrdude',
	// RISC-V
	'/usr/bin/riscv64-unknown-elf-gcc',
	'/usr/local/bin/riscv64-unknown-elf-gcc',
	// Xtensa (ESP32)
	`${HOME}/.espressif/tools/xtensa-esp32-elf/esp-12.2.0_20230208/xtensa-esp32-elf/bin/xtensa-esp32-elf-gcc`,
	'/usr/local/bin/xtensa-esp32-elf-gcc',
	// MIPS
	'/usr/bin/mips-linux-gnu-gcc', '/usr/bin/mipsel-linux-gnu-gcc',

	// \u2500\u2500 I. Aerospace / Avionics (DO-178C qual tools) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// IAR Embedded Workbench (ARM) \u2014 typical install locations
	'/Applications/IAR Systems/IAR Embedded Workbench for ARM/arm/bin/iccarm',
	'/usr/local/iar/arm/bin/iccarm',
	'/opt/iar/arm/bin/iccarm',
	// Green Hills MULTI / INTEGRITY
	'/usr/ghs/comp_201914/ccarm',
	'/usr/ghs/multi/ccarm',
	'/opt/ghs/arm/ccarm',
	// GNAT / Ada (FSF & AdaCore)
	'/usr/bin/gnat', '/usr/bin/gnatmake', '/usr/bin/gnatbind', '/usr/bin/gnatlink',
	'/opt/homebrew/bin/gnat',
	`${HOME}/GNAT/2021/bin/gnat`,
	`${HOME}/GNAT/2022/bin/gnat`,
	`${HOME}/GNAT/2023/bin/gnat`,
	// SPARK (AdaCore formal verification)
	'/usr/bin/gnatprove',
	`${HOME}/GNAT/2023/bin/gnatprove`,
	// Wind River VxWorks / Diab compiler
	`${HOME}/WindRiver/compilers/diab-5.9.7.0/bin/ddump`,
	'/opt/windriver/compilers/diab/bin/dcc',

	// \u2500\u2500 J. Automotive (ISO 26262 / AUTOSAR) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// Polyspace (MathWorks)
	'/usr/local/polyspace/R2023b/polyspace/bin/polyspace-bug-finder',
	'/usr/local/polyspace/R2023b/polyspace/bin/polyspace-code-prover',
	'/opt/polyspace/bin/polyspace-bug-finder',
	// MATLAB / Simulink (model-based development)
	'/Applications/MATLAB_R2023b.app/bin/matlab',
	'/usr/local/MATLAB/R2023b/bin/matlab',
	// Vector tools
	'/opt/vector/candb/bin/CANdb++',

	// \u2500\u2500 K. Formal Verification & High-Assurance \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// Frama-C (C formal verification \u2014 DO-178C, IEC 62304)
	'/usr/bin/frama-c', '/usr/local/bin/frama-c', '/opt/homebrew/bin/frama-c',
	// Why3 (deductive verification platform)
	'/usr/bin/why3', '/usr/local/bin/why3', '/opt/homebrew/bin/why3',
	// Coq proof assistant
	'/usr/bin/coqc', '/usr/local/bin/coqc', '/opt/homebrew/bin/coqc',
	// Isabelle
	`${HOME}/Isabelle/bin/isabelle`, '/usr/local/Isabelle/bin/isabelle',
	// TLA+ tools
	`${HOME}/tla+/tla2tools.jar`,
	// CBMC (C bounded model checker)
	'/usr/bin/cbmc', '/usr/local/bin/cbmc', '/opt/homebrew/bin/cbmc',
	// Dafny
	'/usr/local/bin/dafny', `${HOME}/.dotnet/tools/dafny`,

	// \u2500\u2500 L. Hardware Debug / Flash \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// OpenOCD (open on-chip debugger)
	'/usr/bin/openocd', '/usr/local/bin/openocd', '/opt/homebrew/bin/openocd',
	// SEGGER J-Link
	'/usr/local/bin/JLinkExe',
	'/opt/SEGGER/JLink/JLinkExe',
	'/Applications/SEGGER/JLink/JLinkExe',
	// pyOCD (ARM Cortex-M)
	`${HOME}/.local/bin/pyocd`, '/usr/local/bin/pyocd',
	// ST-Link (STMicroelectronics)
	'/usr/local/bin/st-flash', '/usr/bin/st-flash',
	'/usr/local/bin/st-info',
	// STM32CubeProgrammer
	'/usr/local/STMicroelectronics/STM32Cube/STM32CubeProgrammer/bin/STM32_Programmer_CLI',
	// Lauterbach TRACE32 (Power Tools)
	'/opt/t32/bin/pc_linux64/t32marm',
	// Black Magic Probe
	'/usr/local/bin/bmpflash',

	// \u2500\u2500 M. PLC / Industrial (IEC 61131, IEC 61508) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// CODESYS
	'/opt/codesys/CODESYS/Common/codesys',
	'C:/Program Files/CODESYS 3.5/CODESYS/Common/codesys.exe',
	// TwinCAT (Beckhoff)
	'C:/TwinCAT/3.1/System/TcSysSrv.exe',
	// Siemens TIA Portal CLI
	`${HOME}/TIA Portal/V17/TIA Portal.exe`,

	// \u2500\u2500 N. Static Analysis \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// Coverity (Synopsys)
	'/usr/local/cov-analysis/bin/cov-build',
	'/opt/coverity/bin/cov-build',
	`${HOME}/cov-analysis/bin/cov-build`,
	// Klocwork
	'/usr/local/klocwork/bin/kwbuildproject',
	'/opt/klocwork/bin/kwbuildproject',
	// LDRA Testbed
	'/usr/local/ldra/bin/ldra',
	'/opt/ldra/bin/ldratb',
	// SonarQube scanner
	'/usr/local/bin/sonar-scanner', '/opt/homebrew/bin/sonar-scanner',
	`${HOME}/sonar-scanner/bin/sonar-scanner`,
	// Clang-tidy (LLVM)
	'/usr/bin/clang-tidy', '/usr/bin/clang-tidy-15', '/usr/bin/clang-tidy-16',
	'/usr/local/bin/clang-tidy', '/opt/homebrew/bin/clang-tidy',
	// Cppcheck
	'/usr/bin/cppcheck', '/usr/local/bin/cppcheck', '/opt/homebrew/bin/cppcheck',
	// PC-lint / Flexelint
	'/opt/lint/pclint',
	// FlawFinder (Python-based C/C++ security)
	`${HOME}/.local/bin/flawfinder`, '/usr/local/bin/flawfinder',
	// semgrep (multi-language)
	'/usr/local/bin/semgrep', `${HOME}/.local/bin/semgrep`,
	// MISRA checker (Parasoft C/C++test, QA-C)
	'/opt/parasoft/bin/cpptestcli',
	'/opt/qa-systems/qac/bin/qac',

	// \u2500\u2500 O. Build Systems \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	'/usr/bin/make', '/usr/local/bin/make', '/opt/homebrew/bin/make',
	'/usr/bin/gmake', '/opt/homebrew/bin/gmake',
	'/usr/bin/cmake', '/usr/local/bin/cmake', '/opt/homebrew/bin/cmake',
	'/usr/local/bin/ninja', '/usr/bin/ninja', '/opt/homebrew/bin/ninja',
	'/usr/local/bin/bazel', '/opt/homebrew/bin/bazel', `${HOME}/bin/bazel`,
	'/usr/local/bin/meson', '/opt/homebrew/bin/meson',
	'/usr/local/bin/scons', `${HOME}/.local/bin/scons`,
	'/usr/local/bin/buck2', `${HOME}/.cargo/bin/buck2`,

	// \u2500\u2500 P. Containers / Infra \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	'/usr/local/bin/docker', '/usr/bin/docker',
	'/usr/local/bin/podman', '/usr/bin/podman',
	'/usr/local/bin/kubectl', '/opt/homebrew/bin/kubectl',
	'/usr/local/bin/helm', '/opt/homebrew/bin/helm',

	// \u2500\u2500 Q. VCS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	'/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git',
	'/usr/bin/svn', '/usr/local/bin/svn', '/opt/homebrew/bin/svn',
	'/usr/local/bin/p4', '/usr/bin/p4',   // Perforce \u2014 common in avionics/defense

	// \u2500\u2500 R. Package Managers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	'/usr/local/bin/npm', '/opt/homebrew/bin/npm',
	'/usr/local/bin/yarn', '/opt/homebrew/bin/yarn',
	'/usr/local/bin/pnpm',
	'/usr/local/bin/pip', '/usr/local/bin/pip3',
	'/usr/local/bin/gem', '/opt/homebrew/bin/gem',
	'/usr/local/bin/composer', `${HOME}/.composer/vendor/bin/composer`,
	`${HOME}/.cargo/bin/cargo`,  // already above but canonical PM path
	// Conan (C/C++ package manager \u2014 common in embedded/automotive)
	`${HOME}/.local/bin/conan`, '/usr/local/bin/conan',
	// vcpkg (Microsoft C++ packages)
	`${HOME}/vcpkg/vcpkg`,
	`${HOME}/src/vcpkg/vcpkg`,

	// \u2500\u2500 S. Signing / Security \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	'/usr/bin/gpg', '/usr/local/bin/gpg', '/opt/homebrew/bin/gpg',
	'/usr/bin/gpg2', '/opt/homebrew/bin/gpg2',
	'/usr/bin/openssl', '/usr/local/bin/openssl', '/opt/homebrew/bin/openssl',
	'/usr/local/bin/cosign', `${HOME}/go/bin/cosign`, // sigstore
	'/usr/local/bin/age',   // modern file encryption

	// \u2500\u2500 U. FPGA / HDL / EDA \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// Xilinx/AMD Vivado
	`${HOME}/Xilinx/Vivado/2023.2/bin/vivado`,
	`${HOME}/Xilinx/Vivado/2022.2/bin/vivado`,
	'/opt/Xilinx/Vivado/2023.2/bin/vivado',
	`${HOME}/Xilinx/Vivado/2023.2/bin/xvlog`,    // Verilog/SV compiler
	`${HOME}/Xilinx/Vivado/2023.2/bin/xvhdl`,    // VHDL compiler
	`${HOME}/Xilinx/Vivado/2023.2/bin/xelab`,    // elaboration
	`${HOME}/Xilinx/Vivado/2023.2/bin/xsim`,     // simulation
	// Intel/Altera Quartus
	`${HOME}/intelFPGA/quartus/bin/quartus_sh`,
	`${HOME}/intelFPGA_pro/quartus/bin/quartus_sh`,
	'/opt/intelFPGA/quartus/bin/quartus_sh',
	// Lattice Diamond / Radiant
	'/usr/local/diamond/3.13/bin/lin64/diamondc',
	'/opt/lscc/radiant/3.2/bin/lin64/radiantc',
	// Yosys (open-source synthesis)
	'/usr/bin/yosys', '/usr/local/bin/yosys', '/opt/homebrew/bin/yosys',
	// nextpnr (FPGA place & route)
	'/usr/bin/nextpnr-ice40', '/usr/local/bin/nextpnr-ice40',
	'/usr/bin/nextpnr-ecp5', '/usr/local/bin/nextpnr-ecp5',
	'/usr/bin/nextpnr-xilinx', '/usr/local/bin/nextpnr-xilinx',
	// GHDL (VHDL simulator / synthesis)
	'/usr/bin/ghdl', '/usr/local/bin/ghdl', '/opt/homebrew/bin/ghdl',
	// Icarus Verilog
	'/usr/bin/iverilog', '/usr/local/bin/iverilog', '/opt/homebrew/bin/iverilog',
	'/usr/bin/vvp',
	// Verilator (SystemVerilog linter/simulator)
	'/usr/bin/verilator', '/usr/local/bin/verilator', '/opt/homebrew/bin/verilator',
	// ModelSim / Questa (Siemens EDA)
	'/opt/modelsim/bin/vsim',
	'/opt/questa/bin/vsim',
	`${HOME}/modeltech/bin/vsim`,
	// Cadence Xcelium
	'/opt/cadence/xcelium/bin/xrun',
	// Synopsys VCS
	'/opt/synopsys/vcs/bin/vcs',
	// Riviera-PRO (Aldec)
	'/opt/aldec/Riviera-PRO/bin/vsim',
	// OpenLane (RTL to GDSII)
	`${HOME}/OpenLane/flow.tcl`,
	// iCEcube2 (Lattice iCE40)
	'/opt/lscc/iCEcube2/bin/synthesis_core',

	// \u2500\u2500 V. MCU-Specific Compilers & Toolchains \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// Microchip XC8 (PIC8 \u2014 DO-178C safety-critical embedded)
	'/opt/microchip/xc8/v2.45/bin/xc8-cc',
	'/opt/microchip/xc8/v2.40/bin/xc8-cc',
	'C:/Program Files/Microchip/xc8/v2.45/bin/xc8-cc.exe',
	// Microchip XC16 (PIC16/dsPIC)
	'/opt/microchip/xc16/v2.10/bin/xc16-gcc',
	'C:/Program Files/Microchip/xc16/v2.10/bin/xc16-gcc.exe',
	// Microchip XC32 (PIC32/SAM \u2014 Cortex-M)
	'/opt/microchip/xc32/v4.35/bin/xc32-gcc',
	'C:/Program Files/Microchip/xc32/v4.35/bin/xc32-gcc.exe',
	// NXP CodeWarrior (ARM/PowerPC)
	'/opt/nxp/CodeWarrior/MCU/11.1/cw_eclipse/CodeWarrior',
	`${HOME}/nxp/mcuxpressoide/ide/mcuxpressoide`,
	// Nordic Semiconductor (nRF Connect SDK)
	`${HOME}/ncs/toolchains/v2.5.0/opt/zephyr-sdk/arm-zephyr-eabi/bin/arm-zephyr-eabi-gcc`,
	'/opt/nordic/ncs/v2.5.0/toolchain/bin/west',
	`${HOME}/.local/bin/nrfjprog`, '/usr/local/bin/nrfjprog',
	`${HOME}/.local/bin/mergehex`,
	// Silicon Labs (Simplicity Studio)
	`${HOME}/SimplicityStudio_v5/developer/toolchains/gnu_arm/12.2.rel1_2023.7/bin/arm-none-eabi-gcc`,
	'/opt/silabs/simplicity_studio/developer/toolchains/gnu_arm/12.2.rel1_2023.7/bin/arm-none-eabi-gcc',
	// Infineon (ModusToolbox)
	`${HOME}/ModusToolbox/tools_3.1/gcc/bin/arm-none-eabi-gcc`,
	'/opt/infineon/ModusToolbox/tools_3.1/gcc/bin/arm-none-eabi-gcc',
	// Renesas (CS+ / e2 studio / GNURX)
	'/opt/renesas/e2studio/eclipse/e2studioc',
	`${HOME}/renesas/e2studio/eclipse/e2studioc`,
	'/opt/renesas/rx/bin/rx-elf-gcc',    // GCC for RX MCUs
	'/opt/renesas/rl78/bin/rl78-elf-gcc', // GCC for RL78
	// RP2040 / Raspberry Pi Pico
	`${HOME}/pico-sdk/tools/pioasm/pioasm`,
	'/usr/local/bin/pioasm',
	'/usr/local/bin/picotool', `${HOME}/.local/bin/picotool`,
	// ESP32 / Espressif (ESP-IDF)
	`${HOME}/.espressif/python_env/idf5.2_py3.11_env/bin/python`,
	`${HOME}/esp/esp-idf/tools/idf.py`,
	`${HOME}/.espressif/tools/esptool/4.7.0/esptool.py`,
	`${HOME}/.local/bin/esptool.py`, '/usr/local/bin/esptool.py',
	// TI (Texas Instruments Code Composer Studio / TI-CGT)
	`${HOME}/ti/ccs1230/ccs/tools/compiler/ti-cgt-arm_21.6.1.LTS/bin/armcl`,
	`${HOME}/ti/ccs1230/ccs/tools/compiler/ti-cgt-c2000_22.6.1.LTS/bin/cl2000`,
	'/opt/ti/ccs/tools/compiler/ti-cgt-arm_21.6.1.LTS/bin/armcl',
	// STMicroelectronics (CubeIDE / CubeMX)
	'/Applications/STM32CubeIDE.app/Contents/MacOS/STM32CubeIDE',
	`${HOME}/STM32CubeIDE/STM32CubeIDE`,
	'/usr/local/bin/STM32_Programmer_CLI',

	// \u2500\u2500 W. Assembly Tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// NASM (x86/x64 \u2014 used in bootloaders, OS kernels, DO-178C asm stubs)
	'/usr/bin/nasm', '/usr/local/bin/nasm', '/opt/homebrew/bin/nasm',
	// YASM
	'/usr/bin/yasm', '/usr/local/bin/yasm', '/opt/homebrew/bin/yasm',
	// FASM (flat assembler)
	'/usr/bin/fasm', '/usr/local/bin/fasm',
	// GAS (GNU assembler \u2014 part of binutils, cross-platform)
	'/usr/bin/as', '/usr/bin/arm-none-eabi-as', '/usr/bin/avr-as',
	// MASM (Microsoft \u2014 Windows)
	'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC/14.38.33130/bin/Hostx64/x64/ml64.exe',

	// \u2500\u2500 X. WebAssembly / Emscripten \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// Emscripten (C/C++ to WebAssembly)
	`${HOME}/.emscripten_cache/node/16.20.0_64bit/bin/node`,
	`${HOME}/emsdk/emscripten/main/emcc`,
	`${HOME}/emsdk/upstream/emscripten/emcc`,
	'/usr/local/bin/emcc', '/opt/homebrew/bin/emcc',
	`${HOME}/emsdk/upstream/emscripten/em++`,
	// wasm-pack (Rust to Wasm)
	`${HOME}/.cargo/bin/wasm-pack`, '/usr/local/bin/wasm-pack',
	// wasm-opt (Binaryen optimizer)
	'/usr/local/bin/wasm-opt', '/usr/bin/wasm-opt', '/opt/homebrew/bin/wasm-opt',
	// wabt (WebAssembly Binary Toolkit: wat2wasm, wasm2wat)
	'/usr/local/bin/wat2wasm', '/opt/homebrew/bin/wat2wasm',
	'/usr/local/bin/wasm2wat', '/opt/homebrew/bin/wasm2wat',
	'/usr/local/bin/wasm-validate',
	// wasi-sdk
	`${HOME}/wasi-sdk/bin/clang`,
	'/opt/wasi-sdk/bin/clang',

	// \u2500\u2500 Y. CUDA / GPU / HPC \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// NVIDIA CUDA compiler
	'/usr/local/cuda/bin/nvcc', '/usr/local/cuda-12/bin/nvcc',
	'/usr/local/cuda-11/bin/nvcc', '/opt/cuda/bin/nvcc',
	'/usr/local/cuda/bin/cuda-gdb',
	'/usr/local/cuda/bin/nvprof',
	'/usr/local/cuda/bin/ncu',     // Nsight Compute profiler
	// ROCm / AMD GPU
	'/opt/rocm/bin/hipcc', '/opt/rocm-5.7/bin/hipcc',
	// Intel oneAPI / DPC++
	'/opt/intel/oneapi/compiler/2024.0/bin/icx',   // C/C++
	'/opt/intel/oneapi/compiler/2024.0/bin/ifx',   // Fortran
	'/opt/intel/oneapi/compiler/2024.0/bin/dpcpp', // SYCL
	// MPI (parallel computing \u2014 HPC / scientific embedded)
	'/usr/bin/mpicc', '/usr/local/bin/mpicc', '/opt/homebrew/bin/mpicc',
	'/usr/bin/mpicxx', '/usr/local/bin/mpirun',

	// \u2500\u2500 Z-1. LLVM Advanced Tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	'/usr/bin/llc', '/usr/local/bin/llc', '/opt/homebrew/bin/llc',
	'/usr/bin/opt', '/usr/local/bin/opt',
	'/usr/bin/llvm-link', '/usr/local/bin/llvm-link',
	'/usr/bin/llvm-ar', '/usr/local/bin/llvm-ar', '/opt/homebrew/bin/llvm-ar',
	'/usr/bin/llvm-objdump', '/opt/homebrew/bin/llvm-objdump',
	'/usr/bin/llvm-dwarfdump',
	'/usr/local/bin/mlir-opt', '/opt/homebrew/bin/mlir-opt',   // MLIR (AI/ML compilation)
	'/usr/local/bin/lld', '/usr/bin/lld',
	'/usr/local/bin/lldb', '/usr/bin/lldb', '/opt/homebrew/bin/lldb',

	// \u2500\u2500 Z-2. Fortran \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// gfortran (scientific, CFD, FEM, DO-178C legacy)
	'/usr/bin/gfortran', '/usr/local/bin/gfortran', '/opt/homebrew/bin/gfortran',
	'/usr/bin/gfortran-12', '/usr/bin/gfortran-13',
	// FPM (Fortran Package Manager)
	`${HOME}/.local/bin/fpm`, '/usr/local/bin/fpm',
	// Intel ifx / ifort
	'/opt/intel/oneapi/compiler/2024.0/bin/ifort', // classic (deprecated)
	// Flang (LLVM Fortran)
	'/usr/local/bin/flang', '/opt/homebrew/bin/flang',

	// \u2500\u2500 Z-3. Scientific Computing \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// Julia (NASA, scientific, increasingly safety-critical)
	`${HOME}/.juliaup/bin/julia`, '/usr/local/bin/julia', '/opt/homebrew/bin/julia',
	// R (FDA-regulated clinical trials, IEC 62304 medical stats)
	'/usr/bin/R', '/usr/local/bin/R', '/opt/homebrew/bin/R',
	'/usr/bin/Rscript', '/usr/local/bin/Rscript',
	// GNU Octave (MATLAB alternative)
	'/usr/bin/octave', '/usr/local/bin/octave', '/opt/homebrew/bin/octave',
	// Scilab (model-based embedded)
	'/opt/scilab/bin/scilab', '/usr/local/bin/scilab',
	// Maxima (symbolic math)
	'/usr/bin/maxima', '/opt/homebrew/bin/maxima',

	// \u2500\u2500 Z-4. Scripting Runtimes \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// Lua (eLua, NodeMCU, RTOS scripting, AUTOSAR scripting)
	'/usr/bin/lua', '/usr/local/bin/lua', '/opt/homebrew/bin/lua',
	'/usr/bin/lua5.4', '/usr/bin/lua5.3',
	'/usr/bin/luajit', '/usr/local/bin/luajit', '/opt/homebrew/bin/luajit',
	'/usr/local/bin/luarocks', '/opt/homebrew/bin/luarocks',
	// Perl (build scripts, test harness, AUTOSAR codegen glue)
	'/usr/bin/perl', '/usr/local/bin/perl', '/opt/homebrew/bin/perl',
	`${HOME}/perl5/bin/perl`,
	// Tcl (EDA scripts \u2014 Vivado, Quartus, Synopsys all use Tcl)
	'/usr/bin/tclsh', '/usr/local/bin/tclsh', '/opt/homebrew/bin/tclsh',
	'/usr/bin/tclsh8.6', '/usr/bin/expect',
	// Ruby (build scripts, embedded testing with RSpec/Rake)
	'/usr/bin/ruby', '/usr/local/bin/ruby', '/opt/homebrew/bin/ruby',
	'/usr/local/bin/rake', '/opt/homebrew/bin/rake',

	// \u2500\u2500 Z-5. Functional / Academic / Verification Languages \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// Haskell GHC (Copilot DSL \u2014 NASA runtime monitoring; DARPA HACMS)
	'/usr/bin/ghc', '/usr/local/bin/ghc', '/opt/homebrew/bin/ghc',
	`${HOME}/.ghcup/bin/ghc`, `${HOME}/.ghcup/bin/ghci`,
	`${HOME}/.cabal/bin/cabal`, '/usr/local/bin/cabal',
	`${HOME}/.ghcup/bin/stack`, '/usr/local/bin/stack',
	`${HOME}/.ghcup/bin/haskell-language-server`,
	// Scala (Chisel HDL, SpinalHDL \u2014 hardware description in Scala)
	'/usr/bin/scalac', '/usr/local/bin/scalac', '/opt/homebrew/bin/scalac',
	'/usr/local/bin/scala', '/usr/local/bin/sbt', '/opt/homebrew/bin/sbt',
	`${HOME}/.local/bin/cs`, '/usr/local/bin/cs',  // Coursier (Scala package manager)
	`${HOME}/.local/bin/mill`, '/usr/local/bin/mill', // Mill build tool
	// Clojure (data transformation, scientific analysis)
	'/usr/local/bin/clj', '/opt/homebrew/bin/clj',
	'/usr/local/bin/clojure', '/opt/homebrew/bin/clojure',
	'/usr/local/bin/lein', '/opt/homebrew/bin/lein',
	// Erlang/OTP (telecom, high-reliability, Nerves embedded Linux)
	'/usr/bin/erl', '/usr/local/bin/erl', '/opt/homebrew/bin/erl',
	'/usr/bin/erlc', '/usr/local/bin/erlc', '/opt/homebrew/bin/erlc',
	'/usr/local/bin/rebar3', '/opt/homebrew/bin/rebar3',
	// OCaml (CompCert \u2014 formally verified C compiler used in aerospace)
	'/usr/bin/ocamlopt', '/usr/local/bin/ocamlopt', '/opt/homebrew/bin/ocamlopt',
	'/usr/bin/ocaml', '/opt/homebrew/bin/ocaml',
	'/usr/local/bin/opam', '/opt/homebrew/bin/opam',
	`${HOME}/.opam/default/bin/ocamlopt`,
	// D language (betterC subset for bare-metal embedded)
	'/usr/bin/dmd', '/usr/local/bin/dmd',
	'/usr/bin/ldc2', '/usr/local/bin/ldc2', '/opt/homebrew/bin/ldc2',
	'/usr/bin/gdc', '/opt/homebrew/bin/gdc',
	`${HOME}/.dub/bin/dub`, '/usr/local/bin/dub',
	// Nim (zero-overhead systems programming, growing embedded use)
	`${HOME}/.nimble/bin/nim`, '/usr/local/bin/nim',
	`${HOME}/.nimble/bin/nimble`, '/usr/local/bin/nimble',
	// V language (V is a statically typed compiled language)
	'/usr/local/bin/v',
	// Crystal (Ruby-like, compiled)
	'/usr/local/bin/crystal', '/opt/homebrew/bin/crystal',
	`${HOME}/.crystal/bin/crystal`,

	// \u2500\u2500 Z-6. Certified / Safety-Critical Compilers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// CompCert (formally verified C compiler \u2014 DO-178C, IEC 62304)
	'/usr/local/bin/ccomp',
	`${HOME}/compcert/bin/ccomp`,
	// SCADE (Ansys Embedded \u2014 certified code generator, DO-178C Level A)
	'/opt/esterel/SCADE/bin/scade',
	`${HOME}/SCADE/bin/scade`,
	// ProB (B-method model checker \u2014 railway, nuclear)
	'/usr/local/bin/probcli',
	`${HOME}/prob/probcli`,
	// Rodin (Event-B)
	`${HOME}/Rodin/rodin`,
	'/opt/Rodin/rodin',
	// SPIN (model checker \u2014 concurrent systems verification)
	'/usr/bin/spin', '/usr/local/bin/spin', '/opt/homebrew/bin/spin',
	// NuSMV / nuXmv (symbolic model checking)
	'/usr/bin/nusmv', '/usr/local/bin/nusmv',
	'/usr/local/bin/nuxmv',
	// PVS (Prototype Verification System \u2014 NASA)
	`${HOME}/PVS/pvs`,
	// ACL2 (theorem prover \u2014 verified seL4 kernel)
	'/usr/local/bin/acl2',

	// \u2500\u2500 Z-7. RTOS Build Tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// Zephyr RTOS (west meta-tool)
	`${HOME}/.local/bin/west`, '/usr/local/bin/west',
	// RTEMS (real-time OS for space \u2014 ESA, NASA)
	`${HOME}/rtems/6/bin/arm-rtems6-gcc`,
	'/opt/rtems/6/bin/arm-rtems6-gcc',
	`${HOME}/rtems/6/bin/riscv-rtems6-gcc`,
	// FreeRTOS \u2014 uses standard cross-compilers, tracked via arm-none-eabi above
	// ChibiOS \u2014 make-based, tracked via make above
	// Azure ThreadX / NetX (Microsoft RTOS)
	`${HOME}/threadx/cmake.sh`,
	// Integrity OS (Green Hills) build tools
	`${HOME}/ghs/integritys/bin/multi`,

	// \u2500\u2500 Z-8. Code Quality / Metrics \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// cloc (count lines of code \u2014 used in DO-178C planning docs)
	'/usr/bin/cloc', '/usr/local/bin/cloc', '/opt/homebrew/bin/cloc',
	// lizard (cyclomatic complexity \u2014 DO-178C / IEC 62304)
	`${HOME}/.local/bin/lizard`, '/usr/local/bin/lizard',
	// gcov / llvm-cov (coverage \u2014 MC/DC for DO-178C)
	'/usr/bin/gcov', '/usr/local/bin/gcov',
	'/usr/local/bin/llvm-cov', '/opt/homebrew/bin/llvm-cov',
	// gprof
	'/usr/bin/gprof',
	// valgrind (memory analysis)
	'/usr/bin/valgrind', '/usr/local/bin/valgrind',
	// AddressSanitizer / UBSanitizer \u2014 part of clang/gcc, tracked via those
	// rats (static C security analyzer)
	`${HOME}/.local/bin/rats`, '/usr/local/bin/rats',
	// hercules (MISRA-C checker)
	'/opt/hercules/bin/hercules',

	// \u2500\u2500 Z-9. Database CLIs & Admin Tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	// Oracle Database (regulated: FDA 21 CFR Part 11, HIPAA, financial)
	'/u01/app/oracle/product/19.0/dbhome_1/bin/sqlplus',
	'/u01/app/oracle/product/21.0/dbhome_1/bin/sqlplus',
	`${HOME}/oracle/product/19c/db_1/bin/sqlplus`,
	'/opt/oracle/product/19c/dbhome_1/bin/sqlplus',
	'/u01/app/oracle/product/19.0/dbhome_1/bin/expdp',
	'/u01/app/oracle/product/19.0/dbhome_1/bin/impdp',
	'/u01/app/oracle/product/19.0/dbhome_1/bin/rman',
	'/u01/app/oracle/product/19.0/dbhome_1/bin/sqlldr',  // SQL*Loader
	'/u01/app/oracle/product/19.0/dbhome_1/bin/tkprof',  // trace analyzer
	'/opt/instantclient_21_1/sqlplus',

	// PostgreSQL (open-source regulated workloads: medical, government)
	'/usr/bin/psql', '/usr/local/bin/psql', '/opt/homebrew/bin/psql',
	'/usr/bin/pg_dump', '/usr/local/bin/pg_dump', '/opt/homebrew/bin/pg_dump',
	'/usr/bin/pg_restore', '/usr/local/bin/pg_restore',
	'/usr/bin/pg_ctl', '/usr/local/bin/pg_ctl',
	'/usr/bin/pg_basebackup',
	'/usr/bin/pg_isready',
	'/usr/bin/pg_upgrade',
	'/usr/bin/createdb', '/usr/bin/dropdb',
	'/usr/bin/createuser', '/usr/bin/dropuser',
	'/usr/bin/initdb',
	'/usr/bin/vacuumdb', '/usr/bin/reindexdb', '/usr/bin/clusterdb',
	'/usr/lib/postgresql/15/bin/psql',  // Debian versioned path
	'/usr/lib/postgresql/14/bin/psql',

	// MySQL / MariaDB
	'/usr/bin/mysql', '/usr/local/bin/mysql', '/opt/homebrew/bin/mysql',
	'/usr/bin/mysqldump', '/usr/local/bin/mysqldump',
	'/usr/bin/mysqladmin', '/usr/local/bin/mysqladmin',
	'/usr/bin/mysqlimport', '/usr/bin/mysqlcheck',
	'/usr/bin/mysql_secure_installation',
	'/usr/bin/mariadb', '/usr/local/bin/mariadb',
	'/usr/bin/mariadb-dump',

	// SQLite (embedded DB \u2014 critical systems, IoT, aerospace ground support)
	'/usr/bin/sqlite3', '/usr/local/bin/sqlite3', '/opt/homebrew/bin/sqlite3',

	// Microsoft SQL Server (sqlcmd, bcp \u2014 .NET/Windows regulated workloads)
	'/opt/mssql-tools/bin/sqlcmd', '/opt/mssql-tools18/bin/sqlcmd',
	'/opt/mssql-tools/bin/bcp',
	'C:/Program Files/Microsoft SQL Server/Client SDK/ODBC/180/Tools/Binn/SQLCMD.EXE',

	// IBM DB2 (banking, insurance \u2014 ISO 9001, SOX regulated)
	`${HOME}/sqllib/bin/db2`,
	'/opt/ibm/db2/V11.5/bin/db2',
	'/opt/ibm/db2/V11.5/bin/db2look',
	'/opt/ibm/db2/V11.5/bin/db2move',

	// MongoDB / Atlas CLI
	'/usr/bin/mongosh', '/usr/local/bin/mongosh', '/opt/homebrew/bin/mongosh',
	'/usr/bin/mongodump', '/usr/local/bin/mongodump',
	'/usr/bin/mongorestore', '/usr/local/bin/mongorestore',
	'/usr/bin/mongoexport', '/usr/bin/mongoimport',
	'/usr/bin/mongotop', '/usr/bin/mongostat',
	'/usr/local/bin/atlas',  // MongoDB Atlas CLI

	// Redis
	'/usr/bin/redis-cli', '/usr/local/bin/redis-cli', '/opt/homebrew/bin/redis-cli',
	'/usr/bin/redis-server', '/usr/local/bin/redis-server',
	'/usr/bin/redis-benchmark',

	// Apache Cassandra / keyspace management (telecom, IoT, high-reliability)
	'/usr/bin/cqlsh', '/usr/local/bin/cqlsh',
	`${HOME}/.local/bin/cqlsh`,
	'/usr/bin/nodetool', '/usr/local/bin/nodetool',
	`${HOME}/cassandra/bin/cqlsh`,
	`${HOME}/cassandra/bin/nodetool`,

	// InfluxDB / InfluxDB2 (time-series: industrial IoT, SCADA, process control)
	'/usr/bin/influx', '/usr/local/bin/influx', '/opt/homebrew/bin/influx',
	`${HOME}/.influxdbv2/influx`,

	// Elasticsearch / OpenSearch (log management, SIEM in regulated environments)
	`${HOME}/elasticsearch/bin/elasticsearch`,
	'/usr/local/bin/elasticsearch',
	'/usr/local/bin/opensearch',
	`${HOME}/.local/bin/elasticdump`,

	// Neo4j (graph DB \u2014 supply chain, dependency analysis)
	`${HOME}/neo4j/bin/neo4j`,
	'/usr/local/bin/neo4j',
	'/opt/homebrew/bin/neo4j',
	'/usr/local/bin/cypher-shell', '/opt/homebrew/bin/cypher-shell',

	// Apache Kafka (event streaming \u2014 industrial, financial, telecom)
	`${HOME}/kafka/bin/kafka-topics.sh`,
	`${HOME}/kafka/bin/kafka-consumer-groups.sh`,
	`${HOME}/kafka/bin/kafka-console-producer.sh`,
	`${HOME}/kafka/bin/kafka-console-consumer.sh`,
	`${HOME}/kafka/bin/kafka-server-start.sh`,
	`${HOME}/kafka/bin/zookeeper-server-start.sh`,
	'/usr/local/bin/kafka-topics', '/opt/homebrew/bin/kafka-topics',
	`${HOME}/.local/bin/kcat`, '/usr/local/bin/kcat',  // kafkacat successor

	// Firebird SQL (open-source \u2014 legacy avionics/automotive ground systems)
	'/usr/bin/isql-fb', '/usr/local/bin/isql',
	'/usr/bin/gbak', '/usr/bin/gstat', '/usr/bin/gfix',

	// DB Migration Tools (regulated change control \u2014 SOX, DO-178C build baseline)
	'/usr/local/bin/flyway', '/opt/homebrew/bin/flyway',
	`${HOME}/flyway/flyway`,
	'/usr/local/bin/liquibase', '/opt/homebrew/bin/liquibase',
	`${HOME}/liquibase/liquibase`,
	`${HOME}/.local/bin/alembic`, '/usr/local/bin/alembic',  // Python SQLAlchemy
	`${HOME}/go/bin/migrate`, '/usr/local/bin/migrate',       // golang-migrate
	`${HOME}/.npm-global/bin/prisma`, '/usr/local/bin/prisma', // Prisma CLI
	`${HOME}/.npm-global/bin/knex`, '/usr/local/bin/knex',    // Knex.js migrations

	// HSQLDB / H2 / Derby (embedded Java databases \u2014 used in on-device regulated apps)
	`${HOME}/.local/bin/h2`,

	// \u2500\u2500 Z-10. Legacy Languages (Banking, Government, Aviation, Healthcare) \u2500\u2500\u2500\u2500

	// COBOL (60% of all business transactions globally \u2014 banking, insurance, SSA, FAA)
	// GNU COBOL (open-source)
	'/usr/bin/cobc', '/usr/local/bin/cobc', '/opt/homebrew/bin/cobc',
	'/usr/bin/cobcrun', '/usr/local/bin/cobcrun',
	// Micro Focus COBOL (enterprise \u2014 government, VSAM, CICS support)
	'/opt/microfocus/VisualCOBOL/bin/cobol',
	'/opt/microfocus/VisualCOBOL/bin/cobrun',
	'/opt/MicroFocus/COBOL/bin/cob',
	`${HOME}/microfocus/VisualCOBOL/bin/cobol`,
	// IBM Enterprise COBOL (z/OS \u2014 mainframe, no Linux binary but tooling exists)
	'/opt/ibm/cobol/bin/cobol',
	// COBOL-IT (open-source enterprise grade)
	'/opt/cobolit/bin/cobc',
	// Acucobol
	'/opt/acucorp/ACED/bin/ccbl',

	// MUMPS / GT.M / InterSystems IRIS (US VA, Epic, Meditech \u2014 FDA regulated EMR)
	'/usr/bin/gtm', '/usr/local/bin/gtm',
	'/opt/gtm/gtm',
	'/opt/yottadb/r1.34_x86_64/gtm',
	`${HOME}/yottadb/gtm`,
	// InterSystems IRIS
	'/usr/bin/iris', '/opt/intersystems/iris/bin/iris',
	`${HOME}/iris/bin/iris`,
	`${HOME}/cache/bin/cache`,  // Caché (predecessor to IRIS)
	// GT.M / YottaDB specific tools
	'/opt/yottadb/r1.34_x86_64/mupip',
	'/opt/yottadb/r1.34_x86_64/dse',

	// PL/I (IBM mainframe \u2014 financial, insurance, legacy government)
	'/opt/ibm/pli/bin/plic',  // IBM PL/I compiler for Linux
	`${HOME}/ibm/pli/bin/plic`,

	// Free Pascal / Delphi (medical devices, industrial automation, legacy VCL)
	'/usr/bin/fpc', '/usr/local/bin/fpc', '/opt/homebrew/bin/fpc',
	'/usr/bin/fp',  // FPC IDE
	`${HOME}/fpc/bin/fpc`,
	'/opt/freepascal/bin/fpc',
	// Delphi CE / RAD Studio (no Linux compiler, but documented)
	`${HOME}/.wine/drive_c/Program Files (x86)/Embarcadero/Studio/22.0/bin/dcc32.exe`,

	// Modula-2 / Modula-3 (used in operating systems research, some avionics)
	'/usr/bin/gm2', '/usr/local/bin/gm2',  // GNU Modula-2
	'/usr/bin/m2c', '/usr/local/bin/pm3',  // Portable Modula-3 (PM3)
	'/opt/homebrew/bin/gm2',

	// REXX / Open Object REXX (IBM mainframe tooling, z/OS, AS/400)
	'/usr/bin/rexx', '/usr/local/bin/rexx',
	'/usr/local/bin/oorexx', '/opt/homebrew/bin/oorexx',  // Open Object REXX
	`${HOME}/oorexx/bin/rexx`,

	// Forth / gForth (embedded bootloaders, OpenFirmware, space systems)
	'/usr/bin/gforth', '/usr/local/bin/gforth', '/opt/homebrew/bin/gforth',
	'/usr/bin/forth',

	// Smalltalk (historical: financial workstations, medical expert systems)
	'/usr/bin/gst', '/usr/local/bin/gst',     // GNU Smalltalk
	'/opt/homebrew/bin/gst',
	`${HOME}/Applications/Squeak5.3-19659-64bit-All-in-One.app/squeak`,
	`${HOME}/pharo/pharo`,  // Pharo Smalltalk

	// Groovy (Gradle DSL, Jenkins pipelines, enterprise automation)
	'/usr/bin/groovy', '/usr/local/bin/groovy', '/opt/homebrew/bin/groovy',
	'/usr/local/bin/groovyc', '/opt/homebrew/bin/groovyc',

	// Visual Basic / VBScript (legacy Windows automation, still in CI)
	'C:/Windows/System32/cscript.exe',   // VBScript
	'C:/Windows/System32/wscript.exe',
	'C:/Program Files (x86)/Microsoft Visual Studio/VB98/VB6.exe',

	// ABAP (SAP \u2014 manufacturing ERP, heavily regulated supply chain)
	'/sapmnt/trans/abapdecompiler',
	`${HOME}/.sap/tools/abap-compiler`,

	// PowerBuilder (legacy: banking, insurance, government \u2014 still live)
	'C:/Program Files/Appeon/PowerBuilder 2022/IDE/pb220.exe',

	// \u2500\u2500 Z-11. Message Queues & Enterprise Middleware \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	// RabbitMQ
	'/usr/sbin/rabbitmq-server', '/usr/local/sbin/rabbitmq-server',
	'/usr/sbin/rabbitmqctl', '/usr/local/sbin/rabbitmqctl',
	'/opt/homebrew/sbin/rabbitmq-server',
	'/usr/sbin/rabbitmq-plugins',

	// Apache ActiveMQ / ActiveMQ Artemis
	`${HOME}/activemq/bin/activemq`,
	'/opt/activemq/bin/activemq',

	// NATS (high-performance messaging \u2014 aerospace ground systems)
	'/usr/local/bin/nats-server', '/opt/homebrew/bin/nats-server',
	'/usr/local/bin/nats', `${HOME}/go/bin/nats`,  // NATS CLI

	// ZeroMQ (messaging library \u2014 no CLI per se, but zmq tools)
	'/usr/local/bin/zmqc',

	// Apache Pulsar
	`${HOME}/pulsar/bin/pulsar`,
	'/usr/local/bin/pulsar-admin',

	// IBM MQ (mission-critical: banking, telecom, airline reservation)
	'/opt/mqm/bin/dspmqver',
	'/opt/mqm/bin/crtmqm',
	'/opt/mqm/bin/strmqm',
	'/opt/mqm/bin/runmqsc',
	'/opt/mqm/bin/amqsput',
	'/opt/mqm/bin/amqsget',
	`${HOME}/mqm/bin/dspmqver`,

	// TIBCO EMS / Rendezvous (financial messaging \u2014 high-frequency trading, FIX)
	'/opt/tibco/ems/8.6/bin/tibemsadmin',
	'/opt/tibco/rv/8.4/bin/tibrvsend',

	// Apache Camel / WSO2 (enterprise integration \u2014 healthcare HL7, B2B EDI)
	`${HOME}/.local/bin/camel`, '/usr/local/bin/camel',

	// \u2500\u2500 Z-12. Application Servers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	// Apache Tomcat
	`${HOME}/tomcat/bin/catalina.sh`,
	'/opt/tomcat/bin/catalina.sh',
	'/usr/local/bin/catalina',

	// JBoss / WildFly (Red Hat \u2014 government, healthcare J2EE)
	`${HOME}/wildfly/bin/standalone.sh`,
	'/opt/wildfly/bin/standalone.sh',
	'/opt/jboss/bin/jboss-cli.sh',

	// IBM WebSphere (enterprise: banking, insurance, government)
	`${HOME}/IBM/WebSphere/AppServer/bin/wsadmin.sh`,
	'/opt/IBM/WebSphere/AppServer/bin/wsadmin.sh',

	// Oracle WebLogic
	`${HOME}/Oracle/Middleware/Oracle_Home/wlserver/server/bin/startWebLogic.sh`,

	// Payara / GlassFish (Jakarta EE regulated apps)
	`${HOME}/payara5/glassfish/bin/asadmin`,
	'/opt/payara5/glassfish/bin/asadmin',

	// \u2500\u2500 Z-13. Cloud CLIs \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	// AWS CLI (v2)
	'/usr/local/bin/aws', '/usr/bin/aws', `${HOME}/.local/bin/aws`,
	'/opt/homebrew/bin/aws',
	`${HOME}/aws/dist/aws`,

	// Google Cloud SDK
	`${HOME}/google-cloud-sdk/bin/gcloud`,
	'/usr/local/bin/gcloud', '/opt/homebrew/bin/gcloud',
	`${HOME}/google-cloud-sdk/bin/gsutil`,
	`${HOME}/google-cloud-sdk/bin/bq`,

	// Microsoft Azure CLI
	'/usr/local/bin/az', '/opt/homebrew/bin/az',
	`${HOME}/.azure/bin/az`,

	// Oracle Cloud CLI (OCI)
	`${HOME}/lib/oracle-cli/bin/oci`,
	'/usr/local/bin/oci',

	// IBM Cloud CLI
	'/usr/local/bin/ibmcloud', `${HOME}/ibmcloud`,

	// \u2500\u2500 Z-14. Infrastructure as Code / Configuration Management \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	// Terraform / OpenTofu (IaC \u2014 cloud infrastructure for regulated workloads)
	'/usr/local/bin/terraform', '/opt/homebrew/bin/terraform',
	`${HOME}/.tfenv/versions/1.7.0/bin/terraform`,
	'/usr/local/bin/tofu', '/opt/homebrew/bin/tofu',  // OpenTofu

	// Pulumi (IaC \u2014 alternative to Terraform)
	'/usr/local/bin/pulumi',`${HOME}/.pulumi/bin/pulumi`,

	// AWS CDK
	`${HOME}/.npm-global/bin/cdk`, '/usr/local/bin/cdk',

	// Ansible (configuration management \u2014 regulated server management)
	'/usr/bin/ansible', '/usr/local/bin/ansible', '/opt/homebrew/bin/ansible',
	'/usr/bin/ansible-playbook', '/usr/local/bin/ansible-playbook',
	'/usr/bin/ansible-vault', '/usr/bin/ansible-inventory',
	`${HOME}/.local/bin/ansible-playbook`,

	// Chef (configuration as code \u2014 FDA, SOX)
	'/usr/bin/chef', '/usr/local/bin/chef',
	`${HOME}/.chefdk/gem/ruby/3.1.0/bin/chef`,
	'/usr/local/bin/knife', '/usr/bin/knife',

	// Puppet (declarative config \u2014 government, enterprise)
	'/usr/bin/puppet', '/usr/local/bin/puppet',
	'/opt/puppetlabs/bin/puppet',
	`${HOME}/.puppet/bin/puppet`,

	// SaltStack / Salt (event-driven IaC)
	'/usr/bin/salt', '/usr/local/bin/salt',
	'/usr/bin/salt-call', '/usr/bin/salt-minion',

	// Vagrant (VM provisioning for test environments)
	'/usr/bin/vagrant', '/usr/local/bin/vagrant', '/opt/homebrew/bin/vagrant',
	`${HOME}/.vagrant.d/gems/gems/vagrant-2.4.0/bin/vagrant`,

	// Packer (immutable image builds \u2014 DO-178C build reproducibility)
	'/usr/local/bin/packer', '/opt/homebrew/bin/packer',
	`${HOME}/.packer.d/packer`,

	// \u2500\u2500 Z-15. Web Servers & Proxies \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	// Nginx (web server / reverse proxy \u2014 used in regulated APIs)
	'/usr/sbin/nginx', '/usr/local/sbin/nginx', '/opt/homebrew/bin/nginx',
	'/usr/bin/nginx',

	// Apache HTTP Server
	'/usr/sbin/apache2', '/usr/sbin/httpd',
	'/usr/local/sbin/httpd', '/opt/homebrew/sbin/httpd',
	'/usr/sbin/apachectl', '/usr/local/bin/apachectl',

	// Caddy (modern web server with auto-TLS)
	'/usr/bin/caddy', '/usr/local/bin/caddy', '/opt/homebrew/bin/caddy',

	// HAProxy (high-availability load balancer \u2014 financial, telecom)
	'/usr/sbin/haproxy', '/usr/local/sbin/haproxy', '/opt/homebrew/sbin/haproxy',

	// Envoy Proxy (cloud-native service mesh)
	'/usr/local/bin/envoy',

	// \u2500\u2500 Z-16. CI/CD Tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	// Jenkins CLI
	`${HOME}/.jenkins/jenkins-cli.jar`,
	'/usr/local/bin/jenkins-cli',

	// GitLab Runner
	'/usr/local/bin/gitlab-runner', '/usr/bin/gitlab-runner',
	'/opt/homebrew/bin/gitlab-runner',

	// GitHub Actions CLI (gh)
	'/usr/local/bin/gh', '/opt/homebrew/bin/gh', '/usr/bin/gh',

	// CircleCI CLI
	'/usr/local/bin/circleci', `${HOME}/.local/bin/circleci`,

	// Drone CLI
	'/usr/local/bin/drone',

	// ArgoCD CLI (GitOps \u2014 regulated Kubernetes deployments)
	'/usr/local/bin/argocd', `${HOME}/go/bin/argocd`,

	// Flux CLI (GitOps)
	'/usr/local/bin/flux', `${HOME}/.local/bin/flux`,

	// \u2500\u2500 Z-17. API Testing & Load Testing \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	// Newman (Postman CLI \u2014 API test automation )
	'/usr/local/bin/newman', `${HOME}/.npm-global/bin/newman`,

	// httpie
	'/usr/bin/http', '/usr/local/bin/http', '/opt/homebrew/bin/http',
	`${HOME}/.local/bin/http`,

	// curl & wget (universal \u2014 every regulated pipeline uses these)
	'/usr/bin/curl', '/usr/local/bin/curl', '/opt/homebrew/bin/curl',
	'/usr/bin/wget', '/usr/local/bin/wget', '/opt/homebrew/bin/wget',

	// k6 (load testing \u2014 performance baseline for regulated APIs)
	'/usr/local/bin/k6', '/opt/homebrew/bin/k6', `${HOME}/go/bin/k6`,

	// Locust (Python load testing \u2014 FDA performance testing)
	`${HOME}/.local/bin/locust`, '/usr/local/bin/locust',

	// Playwright / Cypress (E2E testing)
	`${HOME}/.local/bin/playwright`, `${HOME}/.npm-global/bin/playwright`,
	`${HOME}/.npm-global/bin/cypress`,

	// \u2500\u2500 Z-18. Data Engineering & Analytics \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	// Apache Spark (big data \u2014 regulated financial, pharma analytics)
	`${HOME}/spark/bin/spark-submit`,
	`${HOME}/spark/bin/spark-shell`,
	'/usr/local/bin/spark-submit',

	// Apache Hadoop
	`${HOME}/hadoop/bin/hadoop`,
	'/usr/local/bin/hdfs', '/usr/local/bin/yarn',

	// Apache Flink
	`${HOME}/flink/bin/flink`,

	// Apache Airflow (workflow orchestration \u2014 pharma data pipelines, FDA)
	`${HOME}/.local/bin/airflow`, '/usr/local/bin/airflow',

	// dbt (data build tool \u2014 data lineage for regulatory compliance)
	`${HOME}/.local/bin/dbt`, '/usr/local/bin/dbt',

	// \u2500\u2500 Z-19. Secrets & Security Infrastructure \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	// HashiCorp Vault (secret management \u2014 PCI-DSS, HIPAA)
	'/usr/local/bin/vault', '/opt/homebrew/bin/vault',
	`${HOME}/.vault`,

	// Trivy (container/dependency vulnerability scanner)
	'/usr/local/bin/trivy', '/opt/homebrew/bin/trivy',
	`${HOME}/.local/bin/trivy`,

	// Grype (vulnerability scanner \u2014 supply chain)
	'/usr/local/bin/grype', `${HOME}/.local/bin/grype`,

	// Syft (SBOM generator \u2014 can cross-validate our generated SBOMs)
	'/usr/local/bin/syft', `${HOME}/.local/bin/syft`,

	// Snyk CLI (vulnerability + license scanning)
	'/usr/local/bin/snyk', `${HOME}/.npm-global/bin/snyk`,

	// OWASP Dependency-Check
	`${HOME}/dependency-check/bin/dependency-check.sh`,
	'/opt/dependency-check/bin/dependency-check.sh',

	// Anchore Engine / grype
	'/usr/local/bin/anchore-cli',

	// \u2500\u2500 Z-20. Test Frameworks (as standalone CLIs) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	// Jest (Node.js)
	`${HOME}/.npm-global/bin/jest`, '/usr/local/bin/jest',

	// Mocha
	`${HOME}/.npm-global/bin/mocha`, '/usr/local/bin/mocha',

	// Pytest (Python \u2014 IEC 62304, DO-178C test evidence)
	`${HOME}/.local/bin/pytest`, '/usr/local/bin/pytest',

	// JUnit / Surefire \u2014 embedded in mvn, no standalone binary
	// TestNG \u2014 same as JUnit

	// Robot Framework (acceptance testing \u2014 regulated: EU MDR, DO-178C)
	`${HOME}/.local/bin/robot`, '/usr/local/bin/robot',

	// Cucumber / Behave (BDD \u2014 compliance testing)
	`${HOME}/.local/bin/behave`, '/usr/local/bin/behave',
	`${HOME}/bin/cucumber`, '/usr/local/bin/cucumber',

	// Google Test (C++ unit testing \u2014 embedded, DO-178C)
	'/usr/local/bin/gtest', `${HOME}/.local/bin/gtest_main`,

	// CppUTest (unit testing for embedded C \u2014 DO-178C)
	'/usr/local/bin/CppUTest', `/opt/cpputest/bin/CppUTest`,

	// Unity (C unit testing for embedded \u2014 NASA GSFC standard)
	`${HOME}/unity/build/testunity`,

	// VectorCAST (commercial \u2014 DO-178C, IEC 62304 certified testing)
	'/opt/vector/VectorCAST/clicast',
	`${HOME}/vector/VectorCAST/clicast`,

	// LDRA TBvision (already in N section)
	// Cantata++ (QA Systems \u2014 DO-178C/IEC 62304)
	'/opt/qa-systems/cantata/bin/cantata',

	// Parasoft C/C++test (already in N section)
];



// \u2500\u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class EnclaveToolchainService extends Disposable implements IEnclaveToolchainService {
	declare readonly _serviceBrand: undefined;

	private _lastVerification: IToolchainVerificationSummary | null = null;

	private readonly _onDidVerify = this._register(new Emitter<IToolchainVerificationSummary>());
	public readonly onDidVerify: Event<IToolchainVerificationSummary> = this._onDidVerify.event;

	private readonly _onDidDetectViolation = this._register(new Emitter<IToolVerificationRecord>());
	public readonly onDidDetectViolation: Event<IToolVerificationRecord> = this._onDidDetectViolation.event;

	constructor(
		@IEnclaveCryptoService private readonly cryptoService: IEnclaveCryptoService,
		@IEnclaveSessionService private readonly sessionService: IEnclaveSessionService,
		@IEnclaveAuditTrailService private readonly auditTrailService: IEnclaveAuditTrailService,
		@IEnclaveEnvironmentService private readonly enclaveEnv: IEnclaveEnvironmentService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		// Run verification eagerly on service start
		this.verifyToolchain().catch(err => {
			console.error('[Enclave Toolchain] Initial verification failed:', err);
		});
		console.log('[Enclave Toolchain] Service initialized.');
	}

	// \u2500\u2500\u2500 Public API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	public async verifyToolchain(): Promise<IToolchainVerificationSummary> {
		const sessionId = this.sessionService.sessionId;
		const timestamp = Date.now();

		// 1. Load the manifest (if it exists)
		const manifest = await this._loadManifest();
		const manifestPath = manifest ? this._getManifestPath() : null;

		// 2. Build the set of tool paths to check
		// Priority: manifest tools \u2192 default well-known paths
		const toolPathsToCheck = manifest
			? manifest.tools.map(t => t.expectedPath)
			: DEFAULT_TOOL_PATHS;

		// 3. Hash each tool
		const records: IToolVerificationRecord[] = [];

		for (const toolPath of toolPathsToCheck) {
			const record = await this._verifyTool(toolPath, manifest, sessionId);
			records.push(record);
			if (record.status === 'mismatch' || (record.status === 'unlisted' && this.enclaveEnv.mode === 'locked_down')) {
				this._onDidDetectViolation.fire(record);
			}
		}

		// 4. Compute summary stats
		const approved = records.filter(r => r.status === 'approved').length;
		const mismatched = records.filter(r => r.status === 'mismatch').length;
		const unlisted = records.filter(r => r.status === 'unlisted').length;
		const notFound = records.filter(r => r.status === 'not_found').length;

		const overallStatus: IToolchainVerificationSummary['overallStatus'] =
			mismatched > 0 ? 'violations' :
				unlisted > 0 && this.enclaveEnv.mode === 'locked_down' ? 'violations' :
					unlisted > 0 ? 'warnings' : 'clean';

		// 5. Sign the summary
		const summaryPayload = JSON.stringify({
			sessionId, timestamp, manifestPath,
			totalDiscovered: records.length,
			approved, mismatched, unlisted, notFound,
			overallStatus,
		});

		const signature = this.cryptoService.isReady
			? await this.cryptoService.sign(summaryPayload).catch(() => 'sign-failed')
			: 'pending';

		const summary: IToolchainVerificationSummary = Object.freeze({
			sessionId,
			timestamp,
			manifestPath,
			totalDiscovered: records.length,
			approved,
			mismatched,
			unlisted,
			notFound,
			records,
			overallStatus,
			signature,
		});

		this._lastVerification = summary;

		// 6. Audit log
		await this.auditTrailService.logEntry(
			'provenance_tag',
			'enclave_system',
			`toolchain-verify:${overallStatus} (${approved} approved, ${mismatched} mismatched, ${unlisted} unlisted)`,
			overallStatus === 'violations' ? 'flagged' : 'completed',
			JSON.stringify({ approved, mismatched, unlisted, notFound })
		);

		// 7. Persist
		await this._persistSummary(summary);

		this._onDidVerify.fire(summary);

		console.log(`[Enclave Toolchain] Verification complete: ${overallStatus}. ${approved}\u2713 ${mismatched}\u2717 ${unlisted}? ${notFound}\u2298`);
		return summary;
	}

	public getLastVerification(): IToolchainVerificationSummary | null {
		return this._lastVerification;
	}

	public isToolchainClean(): boolean {
		if (!this._lastVerification) { return true; } // not yet verified \u2014 optimistic
		return this._lastVerification.overallStatus === 'clean';
	}

	public async generateManifest(toolPaths: string[]): Promise<IToolchainManifest> {
		const entries: IApprovedToolEntry[] = [];

		for (const toolPath of toolPaths) {
			try {
				const uri = URI.file(toolPath);
				const stat = await this.fileService.stat(uri);
				const actualHash = stat.size < LARGE_BINARY_THRESHOLD
					? await this._hashBinaryFile(uri)
					: `size-fingerprint:${stat.size}`;

				const name = toolPath.split('/').pop() ?? toolPath;
				entries.push({
					name,
					expectedPath: toolPath,
					expectedHash: `sha256:${actualHash}`,
					version: 'detected-at-generation',
					purpose: 'auto-detected',
				});
			} catch {
				// Tool not found or not accessible \u2014 skip
			}
		}

		const manifest: IToolchainManifest = {
			version: '1',
			approvedAt: new Date().toISOString(),
			approvedBy: 'enclave-system-generated',
			tools: entries,
		};

		// Persist manifest so the workspace can start using it
		const root = this._getWorkspaceRootUri();
		if (root) {
			const manifestUri = URI.joinPath(root, MANIFEST_PATH);
			await this.fileService.writeFile(
				manifestUri,
				VSBuffer.fromString(JSON.stringify(manifest, null, 2))
			);
			console.log(`[Enclave Toolchain] Manifest generated with ${entries.length} tools.`);
		}

		return manifest;
	}

	// \u2500\u2500\u2500 Private: Tool Verification \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _verifyTool(
		toolPath: string,
		manifest: IToolchainManifest | null,
		sessionId: string
	): Promise<IToolVerificationRecord> {
		const id = this._uuid();
		const timestamp = Date.now();
		const toolName = toolPath.split('/').pop() ?? toolPath;
		const uri = URI.file(toolPath);

		let actualHash: string;
		let sizeBytes: number;

		// Check if the binary exists and is readable
		try {
			const stat = await this.fileService.stat(uri);
			sizeBytes = stat.size;

			if (sizeBytes > LARGE_BINARY_THRESHOLD) {
				actualHash = `size-fingerprint:${sizeBytes}:${stat.mtime}`;
			} else {
				actualHash = await this._hashBinaryFile(uri);
			}
		} catch {
			// Tool not found on this system
			const record = await this._signRecord({
				id, sessionId, toolName, toolPath,
				expectedHash: manifest?.tools.find(t => t.expectedPath === toolPath)?.expectedHash ?? null,
				actualHash: 'not-found',
				sizeBytes: 0,
				status: 'not_found',
				timestamp,
			});
			return record;
		}

		// Find in manifest
		const manifestEntry = manifest?.tools.find(t => t.expectedPath === toolPath);
		const expectedHash = manifestEntry?.expectedHash ?? null;

		let status: ToolVerificationStatus;
		if (!manifest || !manifestEntry) {
			status = 'unlisted';
		} else {
			const expectedHashClean = expectedHash?.replace('sha256:', '') ?? '';
			status = actualHash === expectedHashClean ? 'approved' : 'mismatch';
		}

		return this._signRecord({
			id, sessionId, toolName, toolPath,
			expectedHash,
			actualHash,
			sizeBytes,
			status,
			timestamp,
		});
	}

	private async _signRecord(params: Omit<IToolVerificationRecord, 'signature'>): Promise<IToolVerificationRecord> {
		const canonical = JSON.stringify(params);
		const signature = this.cryptoService.isReady
			? await this.cryptoService.sign(canonical).catch(() => 'sign-failed')
			: 'pending';
		return Object.freeze({ ...params, signature });
	}

	// \u2500\u2500\u2500 Private: Manifest \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _loadManifest(): Promise<IToolchainManifest | null> {
		const root = this._getWorkspaceRootUri();
		if (!root) { return null; }

		const manifestUri = URI.joinPath(root, MANIFEST_PATH);
		try {
			const content = await this.fileService.readFile(manifestUri);
			const parsed = JSON.parse(content.value.toString()) as IToolchainManifest;
			return parsed;
		} catch {
			return null;
		}
	}

	private _getManifestPath(): string {
		const root = this._getWorkspaceRootUri();
		return root ? URI.joinPath(root, MANIFEST_PATH).fsPath : MANIFEST_PATH;
	}

	// \u2500\u2500\u2500 Private: Persistence \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _persistSummary(summary: IToolchainVerificationSummary): Promise<void> {
		const root = this._getWorkspaceRootUri();
		if (!root) { return; }

		const dateStr = new Date(summary.timestamp).toISOString().split('T')[0];
		const fileUri = URI.joinPath(root, VERIFICATION_FOLDER, `toolchain-${dateStr}.json`);
		try {
			await this.fileService.writeFile(
				fileUri,
				VSBuffer.fromString(JSON.stringify(summary, null, 2))
			);
		} catch (err) {
			console.warn('[Enclave Toolchain] Failed to persist summary:', err);
		}
	}

	// \u2500\u2500\u2500 Private: Binary Hashing \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _hashBinaryFile(uri: URI): Promise<string> {
		try {
			const file = await this.fileService.readFile(uri);
			const hashBuffer = await crypto.subtle.digest('SHA-256', file.value.buffer as ArrayBuffer);
			return Array.from(new Uint8Array(hashBuffer))
				.map(b => b.toString(16).padStart(2, '0'))
				.join('');
		} catch {
			return 'hash-failed';
		}
	}

	// \u2500\u2500\u2500 Private: Utilities \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _getWorkspaceRootUri(): URI | null {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : null;
	}

	private _uuid(): string {
		try { return crypto.randomUUID(); } catch {
			return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
				const r = Math.random() * 16 | 0;
				return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
			});
		}
	}
}

registerSingleton(IEnclaveToolchainService, EnclaveToolchainService, InstantiationType.Delayed);
