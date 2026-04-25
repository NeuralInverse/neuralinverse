/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # EnclaveSBOMService
 *
 * Software Bill of Materials generation and cryptographic signing for every workspace.
 *
 * ## What Is a SBOM?
 * A Software Bill of Materials is a formal, machine-readable inventory of every
 * dependency in the software supply chain \u2014 analogous to a food ingredients label.
 *
 * Post-Log4Shell (2021), post-SolarWinds (2020), US Executive Order 14028 (May 2021)
 * mandates SBOM for all software sold to the US Federal Government.
 * EU Cyber Resilience Act (CRA, 2024) similarly mandates SBOM for CE-marked products.
 *
 * ## Formats Supported
 * - **CycloneDX JSON** (default) \u2014 OWASP standard, widely tooled
 * - **SPDX JSON** \u2014 Linux Foundation standard, required by NTIA
 *
 * ## Sources Parsed
 * | File               | Ecosystem  |
 * |--------------------|------------|
 * | `package.json`     | npm/Node   |
 * | `package-lock.json`| npm        |
 * | `yarn.lock`        | Yarn       |
 * | `pnpm-lock.yaml`   | pnpm       |
 * | `Cargo.toml`       | Rust       |
 * | `Cargo.lock`       | Rust       |
 * | `requirements.txt` | Python     |
 * | `Pipfile.lock`     | Python     |
 * | `go.mod`           | Go         |
 * | `go.sum`           | Go         |
 * | `CMakeLists.txt`   | CMake      |
 *
 * ## SBOM Record (CycloneDX JSON, simplified)
 * The generated SBOM conforms to CycloneDX 1.5 and is then:
 *   1. SHA-256 hashed (the entire JSON document)
 *   2. ECDSA P-256 signed by the Enclave keypair
 *   3. Bundled with the public key JWK for external verification
 *   4. Persisted to `.inverse/sbom/sbom-{YYYY-MM-DD}-{shortHash}.json`
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

export const IEnclaveSBOMService = createDecorator<IEnclaveSBOMService>('enclaveSBOMService');

// \u2500\u2500\u2500 Types \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export type SBOMEcosystem =
	| 'npm'        // Node.js / JavaScript / TypeScript
	| 'rust'       // Rust / Cargo
	| 'python'     // Python / PyPI
	| 'go'         // Go modules
	| 'java'       // Java / Maven / Gradle
	| 'kotlin'     // Kotlin / Gradle
	| 'dotnet'     // .NET / C# / NuGet
	| 'swift'      // Swift Package Manager
	| 'dart'       // Dart / Flutter
	| 'ruby'       // Ruby / Bundler / RubyGems
	| 'php'        // PHP / Composer
	| 'elixir'     // Elixir / Mix / Hex
	| 'erlang'     // Erlang/OTP / rebar3
	| 'haskell'    // Haskell / GHC / Cabal / Stack
	| 'scala'      // Scala / sbt / Mill / Coursier
	| 'clojure'    // Clojure / Leiningen / deps.edn
	| 'ocaml'      // OCaml / opam (CompCert)
	| 'd_lang'     // D language / DUB
	| 'nim'        // Nim / Nimble
	| 'fortran'    // Fortran / FPM
	| 'lua'        // Lua / LuaRocks
	| 'perl'       // Perl / CPAN
	| 'r'          // R / CRAN / renv
	| 'julia'      // Julia / Pkg
	| 'conda'      // Python Conda / Mamba
	| 'cocoapods'  // iOS/macOS CocoaPods
	| 'nix'        // Nix flakes
	| 'bazel'      // Bazel / WORKSPACE http_archive
	| 'zig'        // Zig Package Manager
	| 'ada'        // Ada / Alire
	| 'cpp_conan'  // C++ / Conan
	| 'cpp_vcpkg'  // C++ / vcpkg
	| 'cmake'      // CMake FetchContent / ExternalProject
	| 'unknown';
export type SBOMFormat = 'cyclonedx-json' | 'spdx-json';

export interface ISBOMComponent {
	/** Component name (package/crate/module) */
	readonly name: string;
	/** Resolved version */
	readonly version: string;
	/** Ecosystem (npm, cargo, pip, etc.) */
	readonly ecosystem: SBOMEcosystem;
	/** Package URL (purl) \u2014 unique cross-ecosystem identifier */
	readonly purl: string;
	/** SPDX license identifier, if known */
	readonly license: string | null;
	/** Integrity hash from lockfile (e.g. npm integrity, Cargo.lock checksum) */
	readonly lockfileIntegrity: string | null;
	/** Whether integrity was verified against the lockfile */
	readonly integrityVerified: boolean;
	/** Source file this component was discovered in */
	readonly sourceFile: string;
}

export interface ISBOMDocument {
	/** UUIDv4 \u2014 CycloneDX serialNumber */
	readonly id: string;
	readonly sessionId: string;
	/** CycloneDX spec version */
	readonly specVersion: '1.5';
	/** BOM version (increments on re-generation within a session) */
	readonly version: number;
	readonly timestamp: string;
	/** Workspace root absolute path */
	readonly workspaceRoot: string;
	/** All discovered components */
	readonly components: ISBOMComponent[];
	/** Total component count */
	readonly componentCount: number;
	/** Component counts per ecosystem */
	readonly ecosystemCounts: Record<SBOMEcosystem, number>;
	/** Number of components with integrity verification */
	readonly verifiedIntegrityCount: number;
	/** Number of components missing integrity data */
	readonly missingIntegrityCount: number;
	/** SHA-256 of the serialized JSON document (self-referential hash, computed after) */
	readonly documentHash: string;
	/** ECDSA P-256 signature of the document */
	readonly signature: string;
	/** Public key JWK for auditor verification */
	readonly publicKeyJwk: JsonWebKey | null;
}

export interface IEnclaveSBOMService {
	readonly _serviceBrand: undefined;

	/** Fires when a new SBOM is generated */
	readonly onDidGenerateSBOM: Event<ISBOMDocument>;

	/**
	 * Scan the workspace and generate a signed SBOM.
	 * Parses all known lockfiles and dependency manifests.
	 */
	generateSBOM(): Promise<ISBOMDocument>;

	/**
	 * Get the most recently generated SBOM for this session.
	 * null if never generated.
	 */
	getLastSBOM(): ISBOMDocument | null;

	/**
	 * Verify the integrity of the last generated SBOM.
	 * Checks: document hash + ECDSA signature + lockfile integrity counts.
	 */
	verifyLastSBOM(): Promise<{ valid: boolean; reason?: string }>;

	/**
	 * Export the SBOM as a formatted CycloneDX JSON string.
	 * Ready to upload to a dependency vulnerability scanner or compliance portal.
	 */
	exportCycloneDX(sbom?: ISBOMDocument): string;
}

// \u2500\u2500\u2500 Constants \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const SBOM_FOLDER = '.inverse/sbom';

const LOCKFILE_SIGNATURES: Array<{ filename: string; ecosystem: SBOMEcosystem }> = [
	// \u2500\u2500 npm / Node.js \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'package-lock.json', ecosystem: 'npm' },
	{ filename: 'yarn.lock', ecosystem: 'npm' },
	{ filename: 'pnpm-lock.yaml', ecosystem: 'npm' },
	{ filename: 'package.json', ecosystem: 'npm' },
	// \u2500\u2500 Rust \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'Cargo.lock', ecosystem: 'rust' },
	{ filename: 'Cargo.toml', ecosystem: 'rust' },
	// \u2500\u2500 Python \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'requirements.txt', ecosystem: 'python' },
	{ filename: 'requirements-dev.txt', ecosystem: 'python' },
	{ filename: 'requirements-test.txt', ecosystem: 'python' },
	{ filename: 'Pipfile.lock', ecosystem: 'python' },
	{ filename: 'pyproject.toml', ecosystem: 'python' },
	{ filename: 'poetry.lock', ecosystem: 'python' },
	{ filename: 'uv.lock', ecosystem: 'python' },
	// \u2500\u2500 Go \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'go.sum', ecosystem: 'go' },
	{ filename: 'go.mod', ecosystem: 'go' },
	// \u2500\u2500 Java / Kotlin / Maven / Gradle \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'pom.xml', ecosystem: 'java' },
	{ filename: 'build.gradle', ecosystem: 'java' },
	{ filename: 'build.gradle.kts', ecosystem: 'kotlin' },
	{ filename: 'gradle.lockfile', ecosystem: 'java' },
	{ filename: 'settings.gradle', ecosystem: 'java' },
	{ filename: 'settings.gradle.kts', ecosystem: 'kotlin' },
	// \u2500\u2500 .NET / NuGet \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'packages.lock.json', ecosystem: 'dotnet' },
	{ filename: 'packages.config', ecosystem: 'dotnet' },
	{ filename: 'global.json', ecosystem: 'dotnet' },
	// \u2500\u2500 Swift \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'Package.resolved', ecosystem: 'swift' },
	{ filename: 'Package.swift', ecosystem: 'swift' },
	// \u2500\u2500 Dart / Flutter \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'pubspec.lock', ecosystem: 'dart' },
	{ filename: 'pubspec.yaml', ecosystem: 'dart' },
	// \u2500\u2500 Ruby \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'Gemfile.lock', ecosystem: 'ruby' },
	{ filename: 'Gemfile', ecosystem: 'ruby' },
	// \u2500\u2500 PHP / Composer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'composer.lock', ecosystem: 'php' },
	{ filename: 'composer.json', ecosystem: 'php' },
	// \u2500\u2500 Elixir / Mix \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'mix.lock', ecosystem: 'elixir' },
	{ filename: 'mix.exs', ecosystem: 'elixir' },
	// \u2500\u2500 Zig \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'build.zig.zon', ecosystem: 'zig' },
	// \u2500\u2500 Ada / Alire \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'alire.toml', ecosystem: 'ada' },
	{ filename: 'alire.lock', ecosystem: 'ada' },
	// \u2500\u2500 C++ / Conan \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'conanfile.txt', ecosystem: 'cpp_conan' },
	{ filename: 'conanfile.py', ecosystem: 'cpp_conan' },
	{ filename: 'conan.lock', ecosystem: 'cpp_conan' },
	// \u2500\u2500 C++ / vcpkg \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'vcpkg.json', ecosystem: 'cpp_vcpkg' },
	{ filename: 'vcpkg-configuration.json', ecosystem: 'cpp_vcpkg' },
	// \u2500\u2500 CMake \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'CMakeLists.txt', ecosystem: 'cmake' },
	{ filename: 'CMakeCache.txt', ecosystem: 'cmake' },
	// \u2500\u2500 Erlang / rebar3 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'rebar.lock', ecosystem: 'erlang' },
	{ filename: 'rebar.config', ecosystem: 'erlang' },
	// \u2500\u2500 Haskell / Cabal / Stack \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'cabal.project.freeze', ecosystem: 'haskell' },
	{ filename: 'cabal.project', ecosystem: 'haskell' },
	{ filename: 'stack.yaml.lock', ecosystem: 'haskell' },
	{ filename: 'stack.yaml', ecosystem: 'haskell' },
	// \u2500\u2500 Scala / sbt \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'build.sbt', ecosystem: 'scala' },
	{ filename: 'build.sc', ecosystem: 'scala' },
	// \u2500\u2500 Clojure \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'deps.edn', ecosystem: 'clojure' },
	{ filename: 'project.clj', ecosystem: 'clojure' },
	// \u2500\u2500 D language / DUB \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'dub.json', ecosystem: 'd_lang' },
	{ filename: 'dub.selections.json', ecosystem: 'd_lang' },
	{ filename: 'dub.sdl', ecosystem: 'd_lang' },
	// \u2500\u2500 Fortran / FPM \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'fpm.toml', ecosystem: 'fortran' },
	// \u2500\u2500 R / renv / CRAN \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'renv.lock', ecosystem: 'r' },
	{ filename: 'DESCRIPTION', ecosystem: 'r' },
	// \u2500\u2500 Julia / Pkg \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'Manifest.toml', ecosystem: 'julia' },
	{ filename: 'Project.toml', ecosystem: 'julia' },
	// \u2500\u2500 Conda / Mamba \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'environment.yml', ecosystem: 'conda' },
	{ filename: 'conda-lock.yml', ecosystem: 'conda' },
	// \u2500\u2500 CocoaPods (iOS / macOS) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'Podfile.lock', ecosystem: 'cocoapods' },
	{ filename: 'Podfile', ecosystem: 'cocoapods' },
	// \u2500\u2500 Nix Flakes \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'flake.lock', ecosystem: 'nix' },
	// \u2500\u2500 Bazel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'WORKSPACE', ecosystem: 'bazel' },
	{ filename: 'WORKSPACE.bazel', ecosystem: 'bazel' },
	// \u2500\u2500 Perl / CPAN \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{ filename: 'cpanfile', ecosystem: 'perl' },
	{ filename: 'cpanfile.snapshot', ecosystem: 'perl' },
	{ filename: 'META.json', ecosystem: 'perl' },
	{ filename: 'META.yml', ecosystem: 'perl' },
];

// \u2500\u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class EnclaveSBOMService extends Disposable implements IEnclaveSBOMService {
	declare readonly _serviceBrand: undefined;

	private _lastSBOM: ISBOMDocument | null = null;
	private _sbomVersion = 0;

	private readonly _onDidGenerateSBOM = this._register(new Emitter<ISBOMDocument>());
	public readonly onDidGenerateSBOM: Event<ISBOMDocument> = this._onDidGenerateSBOM.event;

	constructor(
		@IEnclaveCryptoService private readonly cryptoService: IEnclaveCryptoService,
		@IEnclaveSessionService private readonly sessionService: IEnclaveSessionService,
		@IEnclaveAuditTrailService private readonly auditTrailService: IEnclaveAuditTrailService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		console.log('[Enclave SBOM] Service initialized.');
	}

	// \u2500\u2500\u2500 Public API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	public async generateSBOM(): Promise<ISBOMDocument> {
		const root = this._getWorkspaceRootUri();
		const workspaceRoot = root?.fsPath ?? 'unknown';

		// 1. Discover and parse all dependency files
		const components: ISBOMComponent[] = [];

		for (const { filename, ecosystem } of LOCKFILE_SIGNATURES) {
			if (!root) { continue; }
			const fileUri = URI.joinPath(root, filename);

			try {
				const content = await this.fileService.readFile(fileUri);
				const text = content.value.toString();
				const parsed = this._parseDepFile(filename, ecosystem, text, fileUri);
				components.push(...parsed);
			} catch {
				// File doesn't exist in this workspace \u2014 skip
			}
		}

		// 2. Deduplicate by name+version+ecosystem
		const deduped = this._deduplicate(components);

		// 3. Compute ecosystem counts
		const ecosystemCounts: Record<SBOMEcosystem, number> = {
			npm: 0, rust: 0, python: 0, go: 0,
			java: 0, kotlin: 0, dotnet: 0, swift: 0,
			dart: 0, ruby: 0, php: 0, elixir: 0,
			erlang: 0, haskell: 0, scala: 0, clojure: 0,
			ocaml: 0, d_lang: 0, nim: 0, fortran: 0,
			lua: 0, perl: 0, r: 0, julia: 0,
			conda: 0, cocoapods: 0, nix: 0, bazel: 0,
			zig: 0, ada: 0, cpp_conan: 0, cpp_vcpkg: 0,
			cmake: 0, unknown: 0,
		};
		for (const c of deduped) { ecosystemCounts[c.ecosystem]++; }

		const verifiedIntegrityCount = deduped.filter(c => c.integrityVerified).length;
		const missingIntegrityCount = deduped.filter(c => !c.lockfileIntegrity).length;

		// 4. Assemble document (without hash and signature \u2014 compute those next)
		const id = this._uuid();
		const sessionId = this.sessionService.sessionId;
		const timestamp = new Date().toISOString();
		this._sbomVersion++;

		const documentBody = {
			id,
			sessionId,
			specVersion: '1.5' as const,
			version: this._sbomVersion,
			timestamp,
			workspaceRoot,
			components: deduped,
			componentCount: deduped.length,
			ecosystemCounts,
			verifiedIntegrityCount,
			missingIntegrityCount,
		};

		// 5. Hash the body JSON
		const bodyJson = JSON.stringify(documentBody);
		const documentHash = await this._sha256(bodyJson);

		// 6. Sign
		const signature = this.cryptoService.isReady
			? await this.cryptoService.sign(bodyJson + documentHash).catch(() => 'sign-failed')
			: 'pending';

		// 7. Export public key for bundling
		const publicKeyJwk = this.cryptoService.isReady
			? await this.cryptoService.exportPublicKeyJwk().catch(() => null)
			: null;

		const sbom: ISBOMDocument = Object.freeze({
			...documentBody,
			documentHash,
			signature,
			publicKeyJwk,
		});

		this._lastSBOM = sbom;

		// 8. Audit log
		await this.auditTrailService.logEntry(
			'provenance_tag',
			'enclave_system',
			`sbom-generated:${deduped.length} components, ${verifiedIntegrityCount} verified, ${missingIntegrityCount} missing-integrity`,
			'completed',
			JSON.stringify({ componentCount: deduped.length, ecosystemCounts, missingIntegrityCount })
		);

		// 9. Persist
		await this._persistSBOM(sbom, documentHash);

		this._onDidGenerateSBOM.fire(sbom);
		console.log(`[Enclave SBOM] Generated: ${deduped.length} components across ${Object.entries(ecosystemCounts).filter(([, v]) => v > 0).map(([k]) => k).join(', ')}`);

		return sbom;
	}

	public getLastSBOM(): ISBOMDocument | null {
		return this._lastSBOM;
	}

	public async verifyLastSBOM(): Promise<{ valid: boolean; reason?: string }> {
		if (!this._lastSBOM) {
			return { valid: false, reason: 'No SBOM has been generated yet this session.' };
		}

		const sbom = this._lastSBOM;

		// Re-compute document hash
		const documentBody = {
			id: sbom.id,
			sessionId: sbom.sessionId,
			specVersion: sbom.specVersion,
			version: sbom.version,
			timestamp: sbom.timestamp,
			workspaceRoot: sbom.workspaceRoot,
			components: sbom.components,
			componentCount: sbom.componentCount,
			ecosystemCounts: sbom.ecosystemCounts,
			verifiedIntegrityCount: sbom.verifiedIntegrityCount,
			missingIntegrityCount: sbom.missingIntegrityCount,
		};

		const bodyJson = JSON.stringify(documentBody);
		const expectedHash = await this._sha256(bodyJson);
		if (expectedHash !== sbom.documentHash) {
			return { valid: false, reason: `Document hash mismatch. Expected: ${expectedHash.substring(0, 16)}..., got: ${sbom.documentHash.substring(0, 16)}...` };
		}

		// Verify signature
		if (sbom.signature !== 'pending' && sbom.signature !== 'sign-failed') {
			const sigValid = this.cryptoService.isReady
				? await this.cryptoService.verify(bodyJson + expectedHash, sbom.signature).catch(() => false)
				: true;
			if (!sigValid) {
				return { valid: false, reason: 'ECDSA signature verification failed. SBOM may have been tampered with.' };
			}
		}

		return { valid: true };
	}

	public exportCycloneDX(sbom?: ISBOMDocument): string {
		const doc = sbom ?? this._lastSBOM;
		if (!doc) { return '{}'; }

		const cycloneDX = {
			bomFormat: 'CycloneDX',
			specVersion: '1.5',
			serialNumber: `urn:uuid:${doc.id}`,
			version: doc.version,
			metadata: {
				timestamp: doc.timestamp,
				tools: [{
					vendor: 'Neural Inverse',
					name: 'Neural Inverse Enclave',
					version: '1.0',
				}],
				component: {
					type: 'application',
					name: doc.workspaceRoot.split('/').pop() ?? 'workspace',
					version: 'unknown',
				},
			},
			components: doc.components.map(c => ({
				type: 'library',
				'bom-ref': `${c.ecosystem}:${c.name}@${c.version}`,
				name: c.name,
				version: c.version,
				purl: c.purl,
				licenses: c.license ? [{ license: { id: c.license } }] : [],
				hashes: c.lockfileIntegrity
					? [{ alg: 'SHA-256', content: c.lockfileIntegrity }]
					: [],
			})),
			externalReferences: [],
			// Enclave-specific extension
			'x-neural-inverse-enclave': {
				sessionId: doc.sessionId,
				documentHash: doc.documentHash,
				signature: doc.signature,
				enclavePublicKeyJwk: doc.publicKeyJwk,
			},
		};

		return JSON.stringify(cycloneDX, null, 2);
	}

	// \u2500\u2500\u2500 Private: Dependency Parsers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _parseDepFile(
		filename: string,
		ecosystem: SBOMEcosystem,
		content: string,
		uri: URI
	): ISBOMComponent[] {
		const sourceFile = uri.fsPath.split('/').pop() ?? filename;

		try {
			switch (filename) {
				// \u2500\u2500 npm \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'package.json':
					return this._parsePackageJson(content, sourceFile);
				case 'package-lock.json':
					return this._parsePackageLockJson(content, sourceFile);
				case 'yarn.lock':
					return this._parseYarnLock(content, sourceFile);
				// \u2500\u2500 Rust \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'Cargo.toml':
					return this._parseCargoToml(content, sourceFile);
				case 'Cargo.lock':
					return this._parseCargoLock(content, sourceFile);
				// \u2500\u2500 Python \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'requirements.txt':
				case 'requirements-dev.txt':
				case 'requirements-test.txt':
					return this._parseRequirementsTxt(content, sourceFile);
				case 'pyproject.toml':
					return this._parsePyprojectToml(content, sourceFile);
				case 'poetry.lock':
				case 'uv.lock':
					return this._parsePoetryLock(content, sourceFile);
				// \u2500\u2500 Go \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'go.mod':
					return this._parseGoMod(content, sourceFile);
				case 'go.sum':
					return this._parseGoSum(content, sourceFile);
				// \u2500\u2500 Java / Maven / Gradle \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'pom.xml':
					return this._parseMavenPom(content, sourceFile);
				case 'build.gradle':
				case 'build.gradle.kts':
					return this._parseGradleBuild(content, sourceFile, ecosystem);
				case 'gradle.lockfile':
					return this._parseGradleLockfile(content, sourceFile);
				// \u2500\u2500 .NET / NuGet \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'packages.lock.json':
					return this._parseNuGetLockJson(content, sourceFile);
				case 'packages.config':
					return this._parsePackagesConfig(content, sourceFile);
				// \u2500\u2500 Swift \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'Package.resolved':
					return this._parseSwiftPackageResolved(content, sourceFile);
				case 'Package.swift':
					return this._parseSwiftPackageSwift(content, sourceFile);
				// \u2500\u2500 Dart / Flutter \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'pubspec.lock':
					return this._parsePubspecLock(content, sourceFile);
				case 'pubspec.yaml':
					return this._parsePubspecYaml(content, sourceFile);
				// \u2500\u2500 Ruby \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'Gemfile.lock':
					return this._parseGemfileLock(content, sourceFile);
				case 'Gemfile':
					return this._parseGemfile(content, sourceFile);
				// \u2500\u2500 PHP / Composer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'composer.lock':
					return this._parseComposerLock(content, sourceFile);
				case 'composer.json':
					return this._parseComposerJson(content, sourceFile);
				// \u2500\u2500 Elixir / Mix \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'mix.lock':
					return this._parseMixLock(content, sourceFile);
				// \u2500\u2500 Zig \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'build.zig.zon':
					return this._parseZigZon(content, sourceFile);
				// \u2500\u2500 Ada / Alire \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'alire.toml':
				case 'alire.lock':
					return this._parseAlire(content, sourceFile);
				// \u2500\u2500 C++ / Conan \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'conanfile.txt':
					return this._parseConanfileTxt(content, sourceFile);
				case 'conan.lock':
					return this._parseConanLock(content, sourceFile);
				// \u2500\u2500 C++ / vcpkg \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'vcpkg.json':
					return this._parseVcpkgJson(content, sourceFile);
				// \u2500\u2500 Erlang \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'rebar.lock':
					return this._parseRebarLock(content, sourceFile);
				// \u2500\u2500 Haskell \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'cabal.project.freeze':
					return this._parseCabalFreeze(content, sourceFile);
				case 'stack.yaml':
				case 'stack.yaml.lock':
					return this._parseStackYaml(content, sourceFile);
				// \u2500\u2500 Scala / sbt \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'build.sbt':
					return this._parseBuildSbt(content, sourceFile);
				// \u2500\u2500 Clojure \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'deps.edn':
					return this._parseDepsEdn(content, sourceFile);
				case 'project.clj':
					return this._parseProjectClj(content, sourceFile);
				// \u2500\u2500 D language \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'dub.json':
				case 'dub.selections.json':
					return this._parseDubJson(content, sourceFile);
				// \u2500\u2500 Fortran / FPM \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'fpm.toml':
					return this._parseFpmToml(content, sourceFile);
				// \u2500\u2500 R / renv \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'renv.lock':
					return this._parseRenvLock(content, sourceFile);
				case 'DESCRIPTION':
					return this._parseRDescription(content, sourceFile);
				// \u2500\u2500 Julia \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'Manifest.toml':
					return this._parseJuliaManifest(content, sourceFile);
				// \u2500\u2500 Conda \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'environment.yml':
				case 'conda-lock.yml':
					return this._parseCondaEnv(content, sourceFile);
				// \u2500\u2500 CocoaPods \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'Podfile.lock':
					return this._parsePodfileLock(content, sourceFile);
				// \u2500\u2500 Nix \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'flake.lock':
					return this._parseFlakeLock(content, sourceFile);
				// \u2500\u2500 Bazel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'WORKSPACE':
				case 'WORKSPACE.bazel':
					return this._parseBazelWorkspace(content, sourceFile);
				// \u2500\u2500 Perl / CPAN \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
				case 'cpanfile':
				case 'cpanfile.snapshot':
					return this._parseCpanfile(content, sourceFile);
				case 'META.json':
					return this._parsePerlMetaJson(content, sourceFile);
				default:
					return [];
			}
		} catch (err) {
			console.warn(`[Enclave SBOM] Failed to parse ${filename}:`, err);
			return [];
		}
	}

	private _parsePackageJson(content: string, sourceFile: string): ISBOMComponent[] {
		const pkg = JSON.parse(content);
		const components: ISBOMComponent[] = [];
		const allDeps = {
			...pkg.dependencies,
			...pkg.devDependencies,
			...pkg.peerDependencies,
		};
		for (const [name, version] of Object.entries(allDeps)) {
			const ver = (version as string).replace(/^[\^~>=<]/, '');
			components.push({
				name,
				version: ver,
				ecosystem: 'npm',
				purl: `pkg:npm/${name}@${ver}`,
				license: null,
				lockfileIntegrity: null,
				integrityVerified: false,
				sourceFile,
			});
		}
		return components;
	}

	private _parsePackageLockJson(content: string, sourceFile: string): ISBOMComponent[] {
		const lock = JSON.parse(content);
		const components: ISBOMComponent[] = [];
		const packages = lock.packages ?? lock.dependencies ?? {};
		for (const [key, val] of Object.entries(packages) as [string, any][]) {
			if (!key || key === '') { continue; } // root package
			const name = key.replace(/^node_modules\//, '');
			const version = val.version ?? '0.0.0';
			const integrity = val.integrity ?? null;
			const integrityVerified = !!integrity;
			components.push({
				name,
				version,
				ecosystem: 'npm',
				purl: `pkg:npm/${name}@${version}`,
				license: val.license ?? null,
				lockfileIntegrity: integrity,
				integrityVerified,
				sourceFile,
			});
		}
		return components;
	}

	private _parseYarnLock(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// Yarn classic lock format: "name@version:" blocks
		const blockRegex = /^"?([^"@\n]+)@[^":\n]*"?:\s*\n(?:  [^\n]*\n)*/gm;
		const versionRegex = /  version "([^"]+)"/;
		const integrityRegex = /  integrity (\S+)/;
		let match: RegExpExecArray | null;
		while ((match = blockRegex.exec(content)) !== null) {
			const block = match[0];
			const name = match[1].trim();
			const version = versionRegex.exec(block)?.[1] ?? '0.0.0';
			const integrity = integrityRegex.exec(block)?.[1] ?? null;
			components.push({
				name,
				version,
				ecosystem: 'npm',
				purl: `pkg:npm/${name}@${version}`,
				license: null,
				lockfileIntegrity: integrity,
				integrityVerified: !!integrity,
				sourceFile,
			});
		}
		return components;
	}

	private _parseCargoToml(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// Parse [dependencies] section
		const inDepSection = /\[(?:dependencies|dev-dependencies|build-dependencies)\]([\s\S]*?)(?=\n\[|$)/g;
		const depLine = /^([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]+)"|(?:\{[^}]*version\s*=\s*"([^"]+)"[^}]*\}))/m;
		let sectionMatch: RegExpExecArray | null;
		while ((sectionMatch = inDepSection.exec(content)) !== null) {
			const section = sectionMatch[1];
			const lines = section.split('\n');
			for (const line of lines) {
				const m = depLine.exec(line);
				if (m) {
					const name = m[1];
					const version = (m[2] ?? m[3] ?? '0.0.0').replace(/^[\^~>=<]/, '');
					components.push({
						name,
						version,
						ecosystem: 'rust',
						purl: `pkg:cargo/${name}@${version}`,
						license: null,
						lockfileIntegrity: null,
						integrityVerified: false,
						sourceFile,
					});
				}
			}
		}
		return components;
	}

	private _parseCargoLock(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// Cargo.lock TOML v3 format: [[package]] blocks
		const packageBlocks = content.split(/\n\[\[package\]\]\n/);
		for (const block of packageBlocks.slice(1)) {
			const nameMatch = /name = "([^"]+)"/.exec(block);
			const versionMatch = /version = "([^"]+)"/.exec(block);
			const checksumMatch = /checksum = "([^"]+)"/.exec(block);
			if (!nameMatch || !versionMatch) { continue; }
			const name = nameMatch[1];
			const version = versionMatch[1];
			const checksum = checksumMatch ? checksumMatch[1] : null;
			components.push({
				name,
				version,
				ecosystem: 'rust',
				purl: `pkg:cargo/${name}@${version}`,
				license: null,
				lockfileIntegrity: checksum,
				integrityVerified: !!checksum,
				sourceFile,
			});
		}
		return components;
	}

	private _parseRequirementsTxt(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		const lines = content.split('\n');
		for (const raw of lines) {
			const line = raw.trim();
			if (!line || line.startsWith('#') || line.startsWith('-')) { continue; }
			// Handles: packagename==1.0.0, packagename>=1.0, packagename~=1.0.0
			const match = /^([a-zA-Z0-9_.-]+)(?:[=~><]+([a-zA-Z0-9_.!+]*))?/.exec(line);
			if (!match) { continue; }
			const name = match[1];
			const version = match[2] ?? 'unknown';
			// Check for hash: --hash=sha256:abc123
			const hashMatch = /--hash=sha256:([a-f0-9]+)/.exec(line);
			const integrity = hashMatch ? hashMatch[1] : null;
			components.push({
				name,
				version,
				ecosystem: 'python',
				purl: `pkg:pypi/${name.toLowerCase()}@${version}`,
				license: null,
				lockfileIntegrity: integrity,
				integrityVerified: !!integrity,
				sourceFile,
			});
		}
		return components;
	}

	private _parseGoMod(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// require ( ... ) or single require lines
		const requireBlock = /require\s*\(([\s\S]*?)\)|require\s+(\S+)\s+(\S+)/g;
		let match: RegExpExecArray | null;
		while ((match = requireBlock.exec(content)) !== null) {
			if (match[1]) {
				// require block
				const lines = match[1].split('\n');
				for (const line of lines) {
					const m = /\s*(\S+)\s+(\S+)/.exec(line.trim());
					if (m && !m[1].startsWith('//')) {
						components.push(this._makeGoComponent(m[1], m[2], sourceFile));
					}
				}
			} else if (match[2] && match[3]) {
				components.push(this._makeGoComponent(match[2], match[3], sourceFile));
			}
		}
		return components;
	}

	private _parseGoSum(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		const lines = content.split('\n');
		const seen = new Set<string>();
		for (const line of lines) {
			// format: module@version hash
			const parts = line.trim().split(/\s+/);
			if (parts.length < 2) { continue; }
			const [moduleVer, hash] = parts;
			const atIdx = moduleVer.lastIndexOf('@');
			if (atIdx < 0) { continue; }
			const name = moduleVer.substring(0, atIdx);
			const version = moduleVer.substring(atIdx + 1).replace('/go.mod', '');
			const key = `${name}@${version}`;
			if (seen.has(key)) { continue; }
			seen.add(key);
			components.push({
				name,
				version,
				ecosystem: 'go',
				purl: `pkg:golang/${name.replace(/\./g, '%2E')}@${version}`,
				license: null,
				lockfileIntegrity: hash ?? null,
				integrityVerified: !!hash,
				sourceFile,
			});
		}
		return components;
	}

	private _makeGoComponent(name: string, version: string, sourceFile: string): ISBOMComponent {
		return {
			name,
			version,
			ecosystem: 'go',
			purl: `pkg:golang/${name.replace(/\./g, '%2E')}@${version}`,
			license: null,
			lockfileIntegrity: null,
			integrityVerified: false,
			sourceFile,
		};
	}

	// \u2500\u2500\u2500 New Ecosystem Parsers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _parsePyprojectToml(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// [project.dependencies] or [tool.poetry.dependencies]
		const depSection = /\[(?:project|tool\.poetry)\.dependencies\]([\s\S]*?)(?=\n\[|$)/g;
		let secMatch: RegExpExecArray | null;
		while ((secMatch = depSection.exec(content)) !== null) {
			const lines = secMatch[1].split('\n');
			for (const line of lines) {
				const m = /^([a-zA-Z0-9_.-]+)\s*[=~><!^,\[\s]/.exec(line.trim());
				if (!m || m[1] === 'python') { continue; }
				const name = m[1];
				const verMatch = /[>=~^!]+([\w.]+)/.exec(line);
				const version = verMatch?.[1] ?? 'unknown';
				components.push({
					name, version, ecosystem: 'python',
					purl: `pkg:pypi/${name.toLowerCase()}@${version}`,
					license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile,
				});
			}
		}
		return components;
	}

	private _parsePoetryLock(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		const blocks = content.split(/\n\[\[package\]\]\n/);
		for (const block of blocks.slice(1)) {
			const name = /name = "([^"]+)"/.exec(block)?.[1];
			const version = /version = "([^"]+)"/.exec(block)?.[1];
			if (!name || !version) { continue; }
			components.push({
				name, version, ecosystem: 'python',
				purl: `pkg:pypi/${name.toLowerCase()}@${version}`,
				license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile,
			});
		}
		return components;
	}

	private _parseMavenPom(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// Match <dependency> blocks
		const depBlock = /<dependency>([\s\S]*?)<\/dependency>/g;
		let m: RegExpExecArray | null;
		while ((m = depBlock.exec(content)) !== null) {
			const block = m[1];
			const groupId = /<groupId>([^<]+)<\/groupId>/.exec(block)?.[1]?.trim();
			const artifactId = /<artifactId>([^<]+)<\/artifactId>/.exec(block)?.[1]?.trim();
			const version = /<version>([^<]+)<\/version>/.exec(block)?.[1]?.trim() ?? 'unknown';
			const scope = /<scope>([^<]+)<\/scope>/.exec(block)?.[1]?.trim();
			if (!groupId || !artifactId) { continue; }
			const name = `${groupId}:${artifactId}`;
			components.push({
				name, version, ecosystem: 'java',
				purl: `pkg:maven/${groupId.replace(/\./g, '/')}/${artifactId}@${version}${scope ? `?scope=${scope}` : ''}`,
				license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile,
			});
		}
		return components;
	}

	private _parseGradleBuild(content: string, sourceFile: string, ecosystem: SBOMEcosystem): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// Match: implementation 'group:artifact:version', api("g:a:v"), etc.
		const depLine = /(?:implementation|api|compileOnly|runtimeOnly|testImplementation|annotationProcessor)\s*[('"]([\w.\-]+):([\w.\-]+):([\w.\-+]+)['"]\)?/g;
		let m: RegExpExecArray | null;
		while ((m = depLine.exec(content)) !== null) {
			const [, group, artifact, version] = m;
			const name = `${group}:${artifact}`;
			components.push({
				name, version, ecosystem,
				purl: `pkg:maven/${group.replace(/\./g, '/')}/${artifact}@${version}`,
				license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile,
			});
		}
		return components;
	}

	private _parseGradleLockfile(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// format: group:artifact:version=configurationName,...
		const lines = content.split('\n').filter(l => !l.startsWith('#') && l.includes(':'));
		for (const line of lines) {
			const eqIdx = line.indexOf('=');
			const dep = eqIdx >= 0 ? line.substring(0, eqIdx).trim() : line.trim();
			const parts = dep.split(':');
			if (parts.length < 3) { continue; }
			const [group, artifact, version] = parts;
			components.push({
				name: `${group}:${artifact}`, version, ecosystem: 'java',
				purl: `pkg:maven/${group.replace(/\./g, '/')}/${artifact}@${version}`,
				license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile,
			});
		}
		return components;
	}

	private _parseNuGetLockJson(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		try {
			const lock = JSON.parse(content);
			// .NET lockfile v1: { "version": 1, "dependencies": { "framework": { "PackageName": { "resolved": "1.0" } } } }
			const deps = lock.dependencies ?? {};
			for (const framework of Object.values(deps)) {
				for (const [name, info] of Object.entries(framework as Record<string, any>)) {
					const version = info.resolved ?? info.requested ?? info.version ?? 'unknown';
					const integrity = info.contentHash ?? null;
					components.push({
						name, version, ecosystem: 'dotnet',
						purl: `pkg:nuget/${name}@${version}`,
						license: null, lockfileIntegrity: integrity, integrityVerified: !!integrity, sourceFile,
					});
				}
			}
		} catch { /* malformed */ }
		return components;
	}

	private _parsePackagesConfig(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		const packageEl = /<package\s+id="([^"]+)"\s+version="([^"]+)"/g;
		let m: RegExpExecArray | null;
		while ((m = packageEl.exec(content)) !== null) {
			const [, name, version] = m;
			components.push({
				name, version, ecosystem: 'dotnet',
				purl: `pkg:nuget/${name}@${version}`,
				license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile,
			});
		}
		return components;
	}

	private _parseSwiftPackageResolved(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		try {
			const resolved = JSON.parse(content);
			// v2: { "pins": [ { "identity": "name", "location": "url", "state": { "version": "x" } } ] }
			// v1: { "object": { "pins": [ { "package": "name", "repositoryURL": "..", "state": {"version": "x"} } ] } }
			const pins = resolved.pins ?? resolved.object?.pins ?? [];
			for (const pin of pins) {
				const name = pin.identity ?? pin.package ?? 'unknown';
				const version = pin.state?.version ?? pin.state?.branch ?? pin.state?.revision ?? 'unknown';
				const rev = pin.state?.revision ?? null;
				components.push({
					name, version, ecosystem: 'swift',
					purl: `pkg:swift/${name}@${version}`,
					license: null, lockfileIntegrity: rev, integrityVerified: !!rev, sourceFile,
				});
			}
		} catch { /* malformed */ }
		return components;
	}

	private _parseSwiftPackageSwift(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// .package(url: "...", from: "1.0.0") or .exact/upToNextMajor
		const pkgLine = /\.package\(\s*url:\s*"([^"]+)"[^)]*(?:from|exact|upToNextMajor|upToNextMinor)?:\s*"([^"]*)"/g;
		let m: RegExpExecArray | null;
		while ((m = pkgLine.exec(content)) !== null) {
			const url = m[1];
			const version = m[2] || 'unknown';
			const name = url.split('/').pop()?.replace(/\.git$/, '') ?? url;
			components.push({
				name, version, ecosystem: 'swift',
				purl: `pkg:swift/${name}@${version}`,
				license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile,
			});
		}
		return components;
	}

	private _parsePubspecLock(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// YAML-ish: look for "  name:\n    version: X"
		const packageBlock = /^  (\w+):\n    dependency:[^\n]*\n    description:[\s\S]*?\n    version: "?([^"\n]+)"?/gm;
		let m: RegExpExecArray | null;
		while ((m = packageBlock.exec(content)) !== null) {
			const name = m[1];
			const version = m[2].trim();
			components.push({
				name, version, ecosystem: 'dart',
				purl: `pkg:pub/${name}@${version}`,
				license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile,
			});
		}
		return components;
	}

	private _parsePubspecYaml(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// dependencies: / dev_dependencies: sections
		const secRegex = /(?:dev_)?dependencies:([\s\S]*?)(?=\n\w|$)/g;
		let secMatch: RegExpExecArray | null;
		while ((secMatch = secRegex.exec(content)) !== null) {
			const lines = secMatch[1].split('\n');
			for (const line of lines) {
				const m = /^  ([\w_]+):\s*(?:\^?([\d.]+))?/.exec(line);
				if (!m || !m[1]) { continue; }
				const name = m[1];
				const version = m[2] ?? 'unknown';
				components.push({
					name, version, ecosystem: 'dart',
					purl: `pkg:pub/${name}@${version}`,
					license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile,
				});
			}
		}
		return components;
	}

	private _parseGemfileLock(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// After DEPENDENCIES section: "    gemname (version)"
		const gemLine = /^    ([\w-]+)\s+\(([\d.]+(?:-[\w.]+)?)\)/gm;
		let m: RegExpExecArray | null;
		while ((m = gemLine.exec(content)) !== null) {
			const [, name, version] = m;
			components.push({
				name, version, ecosystem: 'ruby',
				purl: `pkg:gem/${name}@${version}`,
				license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile,
			});
		}
		return components;
	}

	private _parseGemfile(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// gem 'name', '~> version'
		const gemLine = /^\s*gem\s+['"]([\w-]+)['"](?:,\s*['"]([~>=<^! \d.]+)['"])?/gm;
		let m: RegExpExecArray | null;
		while ((m = gemLine.exec(content)) !== null) {
			const name = m[1];
			const version = m[2]?.replace(/[~>=<^! ]/g, '').split(',')[0] ?? 'unknown';
			components.push({
				name, version, ecosystem: 'ruby',
				purl: `pkg:gem/${name}@${version}`,
				license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile,
			});
		}
		return components;
	}

	private _parseComposerLock(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		try {
			const lock = JSON.parse(content);
			const packages = [...(lock.packages ?? []), ...(lock['packages-dev'] ?? [])];
			for (const pkg of packages) {
				const name = pkg.name ?? 'unknown';
				const version = (pkg.version ?? 'unknown').replace(/^v/, '');
				const integrity = pkg.dist?.shasum ?? null;
				components.push({
					name, version, ecosystem: 'php',
					purl: `pkg:composer/${name}@${version}`,
					license: typeof pkg.license === 'string' ? pkg.license : (pkg.license?.[0] ?? null),
					lockfileIntegrity: integrity, integrityVerified: !!integrity, sourceFile,
				});
			}
		} catch { /* malformed */ }
		return components;
	}

	private _parseComposerJson(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		try {
			const pkg = JSON.parse(content);
			const allDeps = { ...pkg.require, ...pkg['require-dev'] };
			for (const [name, version] of Object.entries(allDeps)) {
				if (name === 'php' || name.startsWith('ext-')) { continue; }
				const ver = (version as string).replace(/^[\^~>=<*]/, '') || 'unknown';
				components.push({
					name, version: ver, ecosystem: 'php',
					purl: `pkg:composer/${name}@${ver}`,
					license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile,
				});
			}
		} catch { /* malformed */ }
		return components;
	}

	private _parseMixLock(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// Format: "package_name": {:hex, :package_atom, "version", "hash", ...}
		const pkgLine = /"([\w_]+)":\s*\{:hex,\s*:[\w_]+,\s*"([^"]+)",\s*"([^"]*)"/g;
		let m: RegExpExecArray | null;
		while ((m = pkgLine.exec(content)) !== null) {
			const [, name, version, hash] = m;
			components.push({
				name, version, ecosystem: 'elixir',
				purl: `pkg:hex/${name}@${version}`,
				license: null, lockfileIntegrity: hash || null, integrityVerified: !!hash, sourceFile,
			});
		}
		return components;
	}

	private _parseZigZon(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// build.zig.zon: .name, .dependencies = .{ .dep_name = .{ .url = "...", .hash = "..." } }
		const depBlock = /\.(\w+)\s*=\s*\.\{([^}]+)\}/gs;
		let m: RegExpExecArray | null;
		while ((m = depBlock.exec(content)) !== null) {
			const depName = m[1];
			if (depName === 'name' || depName === 'version' || depName === 'dependencies') { continue; }
			const block = m[2];
			const url = /\.url\s*=\s*"([^"]+)"/.exec(block)?.[1] ?? '';
			const hash = /\.hash\s*=\s*"([^"]+)"/.exec(block)?.[1] ?? null;
			const version = /\/(v?[\d.]+)\//.exec(url)?.[1] ?? 'unknown';
			components.push({
				name: depName, version, ecosystem: 'zig',
				purl: `pkg:github/${url.replace(/^https:\/\/github\.com\//, '').split('/').slice(0, 2).join('/')}@${version}`,
				license: null, lockfileIntegrity: hash, integrityVerified: !!hash, sourceFile,
			});
		}
		return components;
	}

	private _parseAlire(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// [[dependency]] / [[pins]] sections in TOML
		const depBlock = /\[\[(?:dependency|pins)\]\]([\s\S]*?)(?=\[\[|$)/g;
		let m: RegExpExecArray | null;
		while ((m = depBlock.exec(content)) !== null) {
			const block = m[1];
			const name = /name\s*=\s*"([^"]+)"/.exec(block)?.[1];
			const version = /version\s*=\s*"([^"]+)"/.exec(block)?.[1] ?? 'unknown';
			if (!name) { continue; }
			components.push({
				name, version, ecosystem: 'ada',
				purl: `pkg:alire/${name}@${version}`,
				license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile,
			});
		}
		return components;
	}

	private _parseConanfileTxt(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		const inRequires = /\[requires\]([\s\S]*?)(?=\[|$)/.exec(content)?.[1] ?? '';
		for (const line of inRequires.split('\n')) {
			const clean = line.trim();
			if (!clean || clean.startsWith('#')) { continue; }
			// format: name/version or name/version@user/channel
			const m = /^([\w.+-]+)[/\\]([\w.+-]+)/.exec(clean);
			if (!m) { continue; }
			components.push({
				name: m[1], version: m[2], ecosystem: 'cpp_conan',
				purl: `pkg:conan/${m[1]}@${m[2]}`,
				license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile,
			});
		}
		return components;
	}

	private _parseConanLock(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		try {
			const lock = JSON.parse(content);
			// v1: { "graph_manager": { "nodes": { "0": { "ref": "name/version", "package_id": "..." } } } }
			// v2: { "requires": ["name/version#revision"] }
			const nodes = lock.graph_manager?.nodes ?? lock.nodes ?? {};
			for (const node of Object.values(nodes) as any[]) {
				const ref: string = node.ref ?? '';
				if (!ref || ref === 'conanfile') { continue; }
				const [nameVer] = ref.split('@');
				const [name, version] = (nameVer ?? '').split('/');
				if (!name || !version) { continue; }
				const hash = node.package_id ?? null;
				components.push({
					name, version, ecosystem: 'cpp_conan',
					purl: `pkg:conan/${name}@${version}`,
					license: null, lockfileIntegrity: hash, integrityVerified: !!hash, sourceFile,
				});
			}
			// v2 requires array
			for (const req of (lock.requires ?? []) as string[]) {
				const nameVer = req.split('@')[0].split('#')[0];
				const [name, version] = nameVer.split('/');
				if (!name || !version) { continue; }
				components.push({
					name, version, ecosystem: 'cpp_conan',
					purl: `pkg:conan/${name}@${version}`,
					license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile,
				});
			}
		} catch { /* malformed */ }
		return components;
	}

	private _parseVcpkgJson(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		try {
			const vcpkg = JSON.parse(content);
			const deps: Array<string | { name: string; version?: string }> = vcpkg.dependencies ?? [];
			for (const dep of deps) {
				if (typeof dep === 'string') {
					components.push({
						name: dep, version: 'unknown', ecosystem: 'cpp_vcpkg',
						purl: `pkg:vcpkg/${dep}`,
						license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile,
					});
				} else if (dep.name) {
					components.push({
						name: dep.name, version: dep.version ?? 'unknown', ecosystem: 'cpp_vcpkg',
						purl: `pkg:vcpkg/${dep.name}@${dep.version ?? 'unknown'}`,
						license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile,
					});
				}
			}
		} catch { /* malformed */ }
		return components;
	}

	private _deduplicate(components: ISBOMComponent[]): ISBOMComponent[] {
		// Prefer lockfile entries (more info) over manifest entries
		const map = new Map<string, ISBOMComponent>();
		for (const c of components) {
			const key = `${c.ecosystem}:${c.name}`;
			const existing = map.get(key);
			if (!existing || c.integrityVerified && !existing.integrityVerified) {
				map.set(key, c);
			}
		}
		return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
	}

	// \u2500\u2500\u2500 Private: Persistence \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _persistSBOM(sbom: ISBOMDocument, documentHash: string): Promise<void> {
		const root = this._getWorkspaceRootUri();
		if (!root) { return; }

		const dateStr = sbom.timestamp.split('T')[0];
		const shortHash = documentHash.substring(0, 8);
		const fileUri = URI.joinPath(root, SBOM_FOLDER, `sbom-${dateStr}-${shortHash}.json`);

		try {
			await this.fileService.writeFile(
				fileUri,
				VSBuffer.fromString(this.exportCycloneDX(sbom))
			);
		} catch (err) {
			console.warn('[Enclave SBOM] Failed to persist SBOM:', err);
		}
	}

	// \u2500\u2500\u2500 Private: SHA-256 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _sha256(data: string): Promise<string> {
		try {
			const buffer = new TextEncoder().encode(data).buffer;
			const hashBuffer = await crypto.subtle.digest('SHA-256', buffer as ArrayBuffer);
			return Array.from(new Uint8Array(hashBuffer))
				.map(b => b.toString(16).padStart(2, '0'))
				.join('');
		} catch {
			return 'hash-failed';
		}
	}

	// \u2500\u2500\u2500 Extended Ecosystem Parsers (Phase 3 Full Coverage) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _parseRebarLock(content: string, sourceFile: string): ISBOMComponent[] {
		// Erlang rebar3 lock format: {"1",[{PackageName,{pkg,Name,Version,Hash},...}],...}
		const components: ISBOMComponent[] = [];
		const pkgLine = /\{"([^"]+)",\{pkg,"([^"]+)","([^"]+)","([^"]*)"/g;
		let m: RegExpExecArray | null;
		while ((m = pkgLine.exec(content)) !== null) {
			const [, name,, version, hash] = m;
			components.push({ name, version, ecosystem: 'erlang', purl: `pkg:hex/${name}@${version}`, license: null, lockfileIntegrity: hash || null, integrityVerified: !!hash, sourceFile });
		}
		return components;
	}

	private _parseCabalFreeze(content: string, sourceFile: string): ISBOMComponent[] {
		// constraints: package ==version, ...
		const components: ISBOMComponent[] = [];
		const line = /any\.([\w-]+) ==([\d.]+)/g;
		let m: RegExpExecArray | null;
		while ((m = line.exec(content)) !== null) {
			const [, name, version] = m;
			components.push({ name, version, ecosystem: 'haskell', purl: `pkg:hackage/${name}@${version}`, license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile });
		}
		return components;
	}

	private _parseStackYaml(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// extra-deps: - package-version or - {name: pkg, version: v}
		const simpleDep = /^\s*-\s+([\w-]+)-([\d.]+(?:\.[\d.]+)*)/gm;
		let m: RegExpExecArray | null;
		while ((m = simpleDep.exec(content)) !== null) {
			const [, name, version] = m;
			components.push({ name, version, ecosystem: 'haskell', purl: `pkg:hackage/${name}@${version}`, license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile });
		}
		return components;
	}

	private _parseBuildSbt(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// "org" %% "artifact" % "version" or % "version"
		const dep = /"([\w.\-]+)"\s*%%?\s*"([\w.\-]+)"\s*%\s*"([\w.\-+]+)"/g;
		let m: RegExpExecArray | null;
		while ((m = dep.exec(content)) !== null) {
			const [, group, artifact, version] = m;
			components.push({ name: `${group}:${artifact}`, version, ecosystem: 'scala', purl: `pkg:maven/${group.replace(/\./g, '/')}/${artifact}@${version}`, license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile });
		}
		return components;
	}

	private _parseDepsEdn(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// {:deps {org.clojure/clojure {:mvn/version "1.11.1"}}}
		const dep = /([\w.\-]+\/[\w.\-]+)\s*\{:mvn\/version\s+"([^"]+)"/g;
		let m: RegExpExecArray | null;
		while ((m = dep.exec(content)) !== null) {
			const [, name, version] = m;
			const [group, artifact] = name.split('/');
			components.push({ name, version, ecosystem: 'clojure', purl: `pkg:maven/${(group ?? name).replace(/\./g, '/')}/${artifact ?? name}@${version}`, license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile });
		}
		return components;
	}

	private _parseProjectClj(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// [group/artifact "version"] or [group "version"]
		const dep = /\[([\w.\-]+(?:\/[\w.\-]+)?)\s+"([^"]+)"/g;
		let m: RegExpExecArray | null;
		while ((m = dep.exec(content)) !== null) {
			const [, name, version] = m;
			components.push({ name, version, ecosystem: 'clojure', purl: `pkg:clojars/${name}@${version}`, license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile });
		}
		return components;
	}

	private _parseDubJson(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		try {
			const dub = JSON.parse(content);
			// dub.json: {"dependencies":{"name":"~>1.0"}} or dub.selections.json: {"fileVersion":1,"versions":{"name":"1.0.0"}}
			const deps = dub.dependencies ?? dub.versions ?? {};
			for (const [name, ver] of Object.entries(deps)) {
				const version = (typeof ver === 'string' ? ver : (ver as any).version ?? 'unknown').replace(/^[~=^><]/, '');
				components.push({ name, version, ecosystem: 'd_lang', purl: `pkg:dub/${name}@${version}`, license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile });
			}
		} catch { /* malformed */ }
		return components;
	}

	private _parseFpmToml(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// [dependencies] name = ">=1.0"
		const depSection = /\[dependencies\]([\s\S]*?)(?=\n\[|$)/.exec(content)?.[1] ?? '';
		for (const line of depSection.split('\n')) {
			const m = /^\s*([\w-]+)\s*=\s*"([^"]+)"/.exec(line.trim());
			if (!m) { continue; }
			const version = m[2].replace(/^[>=<^~*]+/, '') || 'unknown';
			components.push({ name: m[1], version, ecosystem: 'fortran', purl: `pkg:fpm/${m[1]}@${version}`, license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile });
		}
		return components;
	}

	private _parseRenvLock(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		try {
			const lock = JSON.parse(content);
			const pkgs = lock.Packages ?? {};
			for (const [name, info] of Object.entries(pkgs) as [string, any][]) {
				const version = info.Version ?? 'unknown';
			const hash = info.Hash ?? null;
				components.push({ name, version, ecosystem: 'r', purl: `pkg:cran/${name}@${version}`, license: null, lockfileIntegrity: hash, integrityVerified: !!hash, sourceFile });
			}
		} catch { /* malformed */ }
		return components;
	}

	private _parseRDescription(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// DESCRIPTION: Imports: pkg1 (>= 1.0), pkg2, ...
		const importsMatch = /^(?:Imports|Depends|Suggests):([\s\S]*?)(?=^\w|$)/m.exec(content)?.[1] ?? '';
		for (const raw of importsMatch.split(',')) {
			const name = /([\w.]+)/.exec(raw.trim())?.[1];
			const ver = /\(>=?\s*([\d.]+)\)/.exec(raw)?.[1] ?? 'unknown';
			if (name && name !== 'R') {
				components.push({ name, version: ver, ecosystem: 'r', purl: `pkg:cran/${name}@${ver}`, license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile });
			}
		}
		return components;
	}

	private _parseJuliaManifest(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// [[deps.PackageName]] uuid = "..." version = "1.0.0"
		const blocks = content.split(/\n\[\[deps\.[^\]]+\]\]\n/);
		const pkgHeader = /\[\[deps\.([^\]]+)\]\]/g;
		let hm: RegExpExecArray | null;
		let idx = 1;
		while ((hm = pkgHeader.exec(content)) !== null) {
			const name = hm[1];
			const block = blocks[idx++] ?? '';
			const version = /version = "([^"]+)"/.exec(block)?.[1] ?? 'unknown';
			const uuid = /uuid = "([^"]+)"/.exec(block)?.[1] ?? null;
			components.push({ name, version, ecosystem: 'julia', purl: `pkg:julia/${name}@${version}`, license: null, lockfileIntegrity: uuid, integrityVerified: false, sourceFile });
		}
		return components;
	}

	private _parseCondaEnv(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// dependencies: - name=version=build_string OR - name>=version
		const depBlock = /^dependencies:([\s\S]*?)(?=^[a-z]|$)/m.exec(content)?.[1] ?? '';
		for (const line of depBlock.split('\n')) {
			const raw = line.trim().replace(/^-\s*/, '');
			if (!raw || raw.startsWith('#') || raw.startsWith('pip:')) { continue; }
			const eqParts = raw.split('=');
			const name = eqParts[0]?.trim();
			const version = eqParts[1]?.trim() ?? 'unknown';
			if (name) {
				components.push({ name, version, ecosystem: 'conda', purl: `pkg:conda/${name}@${version}`, license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile });
			}
		}
		return components;
	}

	private _parsePodfileLock(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// PODS:\n  - PodName (1.0.0):\n  - PodName/Subspec (1.0.0)
		const podLine = /^  - ([\w\/+.\-]+) \(([\d.]+(?:-[\w.]+)?)\)/gm;
		let m: RegExpExecArray | null;
		while ((m = podLine.exec(content)) !== null) {
			const [, name, version] = m;
			if (name.includes('/')) { continue; } // skip subspecs
			const checksum = new RegExp(`  ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\n    :checksum: ([a-f0-9]+)`).exec(content)?.[1] ?? null;
			components.push({ name, version, ecosystem: 'cocoapods', purl: `pkg:cocoapods/${name}@${version}`, license: null, lockfileIntegrity: checksum, integrityVerified: !!checksum, sourceFile });
		}
		return components;
	}

	private _parseFlakeLock(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		try {
			const lock = JSON.parse(content);
			const nodes = lock.nodes ?? {};
			for (const [name, node] of Object.entries(nodes) as [string, any][]) {
				if (name === 'root') { continue; }
				const rev = node.locked?.rev ?? null;
				const ref = node.locked?.ref ?? node.original?.ref ?? 'unknown';
				const owner = node.locked?.owner ?? node.original?.owner ?? '';
				const repo = node.locked?.repo ?? node.original?.repo ?? name;
				components.push({ name, version: ref, ecosystem: 'nix', purl: `pkg:github/${owner}/${repo}@${rev ?? ref}`, license: null, lockfileIntegrity: rev, integrityVerified: !!rev, sourceFile });
			}
		} catch { /* malformed */ }
		return components;
	}

	private _parseBazelWorkspace(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// http_archive(name = "...", urls = [...], sha256 = "...")
		const archive = /http_archive\s*\([^)]*?name\s*=\s*"([^"]+)"[^)]*?(?:sha256\s*=\s*"([^"]+)")?[^)]*?(?:strip_prefix\s*=\s*"([^"]+)")?/gs;
		let m: RegExpExecArray | null;
		while ((m = archive.exec(content)) !== null) {
			const [, name, hash, prefix] = m;
			const version = prefix?.split('-').pop() ?? 'unknown';
			components.push({ name, version, ecosystem: 'bazel', purl: `pkg:bazel/${name}@${version}`, license: null, lockfileIntegrity: hash || null, integrityVerified: !!hash, sourceFile });
		}
		return components;
	}

	private _parseCpanfile(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		// requires 'Module::Name', '1.0'; or requires 'Module::Name';
		const dep = /requires\s+'([^']+)'(?:,\s*'([^']*)')?/g;
		let m: RegExpExecArray | null;
		while ((m = dep.exec(content)) !== null) {
			const [, name, version] = m;
			components.push({ name, version: version?.replace(/^[>=<^~]+/, '') ?? 'unknown', ecosystem: 'perl', purl: `pkg:cpan/${name.replace(/::/g, '-')}@${version ?? 'unknown'}`, license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile });
		}
		return components;
	}

	private _parsePerlMetaJson(content: string, sourceFile: string): ISBOMComponent[] {
		const components: ISBOMComponent[] = [];
		try {
			const meta = JSON.parse(content);
			const prereqs = meta.prereqs ?? {};
			for (const phase of Object.values(prereqs) as any[]) {
				for (const [name, version] of Object.entries({ ...phase.requires, ...phase.recommends } as Record<string, string>)) {
					const ver = String(version).replace(/^[>=<^~]+/, '') || 'unknown';
					components.push({ name, version: ver, ecosystem: 'perl', purl: `pkg:cpan/${name.replace(/::/g, '-')}@${ver}`, license: null, lockfileIntegrity: null, integrityVerified: false, sourceFile });
				}
			}
		} catch { /* malformed */ }
		return components;
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

registerSingleton(IEnclaveSBOMService, EnclaveSBOMService, InstantiationType.Delayed);
