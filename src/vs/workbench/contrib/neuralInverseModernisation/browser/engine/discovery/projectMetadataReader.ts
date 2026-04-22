/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Project Metadata Reader
 *
 * Inspects the project root (and one level deep) for build system files,
 * framework indicators, CI configuration, Docker, and test infrastructure.
 *
 * ## Detected Build Systems
 *
 * | File                        | System     |
 * |-----------------------------|------------|
 * | `pom.xml`                   | Maven      |
 * | `build.gradle[.kts]`        | Gradle     |
 * | `package.json`              | npm / yarn / pnpm |
 * | `Cargo.toml`                | Cargo (Rust) |
 * | `go.mod`                    | Go Modules |
 * | `requirements.txt` / `pyproject.toml` | pip / Poetry |
 * | `build.sbt`                 | sbt (Scala) |
 * | `build.xml`                 | Ant        |
 * | `*.csproj` / `*.sln`        | MSBuild (.NET) |
 * | `CMakeLists.txt`            | CMake (generic + firmware heuristics) |
 * | `Makefile`                  | Make       |
 * | `platformio.ini`            | PlatformIO (embedded) |
 * | `sdkconfig` / `idf_component.yml` | ESP-IDF (Espressif) |
 * | `*.uvprojx` / `*.uvoptx`   | Keil MDK (ARM) |
 * | `*.ewp` / `*.eww`          | IAR Embedded Workbench |
 * | `*.s32project`              | S32 Design Studio (NXP AUTOSAR) |
 * | `*.codesys` / `*.project` (CoDeSys NS) | CoDeSys / CODESYS IEC 61131-3 |
 *
 * ## Framework Detection
 *
 * Frameworks are detected by scanning the primary build file for known
 * dependency strings (Spring, Django, Express, etc.).
 *
 * ## CI / Docker
 *
 * Presence of `.github/workflows/`, `Jenkinsfile`, `.gitlab-ci.yml`,
 * `Dockerfile`, `docker-compose.yml`, `.circleci/` etc.
 */

import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IProjectMetadata } from './discoveryTypes.js';


// ─── Constants ────────────────────────────────────────────────────────────────

/** Root-level filenames that indicate a test directory. */
const TEST_DIRS = new Set([
	'test', 'tests', 'spec', 'specs', '__tests__', 'it',
	'integrationtest', 'e2e', 'acceptance', 'bdd', 'features',
]);

/** Root-level files / directories that indicate CI is configured. */
const CI_MARKERS = [
	'.github', '.gitlab-ci.yml', 'jenkinsfile', 'azure-pipelines.yml',
	'.circleci', '.travis.yml', 'bitbucket-pipelines.yml', '.buildkite',
	'.semaphore', 'codefresh.yml', '.appveyor.yml', 'wercker.yml',
];

/** Root-level files that indicate Docker is used. */
const DOCKER_MARKERS = ['dockerfile', 'docker-compose.yml', 'docker-compose.yaml', '.dockerignore'];


// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Read project metadata from the project root.
 *
 * @param root      Project root URI
 * @param fileUris  All source-code file URIs already collected by the walker
 *                  (used for test-directory detection without an extra walk)
 * @param fileService  VS Code file service
 */
export async function readProjectMetadata(
	root: URI,
	fileUris: URI[],
	fileService: IFileService,
): Promise<IProjectMetadata> {
	const metadata: IProjectMetadata = {
		detectedFrameworks: [],
		hasDockerfile:  false,
		hasCI:          false,
		hasTests:       false,
		hasGitIgnore:   false,
		testFrameworks: [],
		languages:      [],
	};

	// List root-level directory entries
	const rootEntries = await listRootEntries(root, fileService);
	const rootLower   = new Set(rootEntries.map(n => n.toLowerCase()));

	// ── Build system ──────────────────────────────────────────────────────
	await detectBuildSystem(root, rootLower, rootEntries, fileService, metadata);

	// ── CI ────────────────────────────────────────────────────────────────
	for (const marker of CI_MARKERS) {
		if (rootLower.has(marker)) { metadata.hasCI = true; break; }
	}

	// ── Docker ────────────────────────────────────────────────────────────
	for (const marker of DOCKER_MARKERS) {
		if (rootLower.has(marker)) { metadata.hasDockerfile = true; break; }
	}

	// ── .gitignore ────────────────────────────────────────────────────────
	if (rootLower.has('.gitignore')) { metadata.hasGitIgnore = true; }

	// ── Test directories (scan scanned file paths) ────────────────────────
	const allPaths = fileUris.map(u => u.path.replace(/\\/g, '/').toLowerCase());
	for (const td of TEST_DIRS) {
		if (allPaths.some(p => p.includes(`/${td}/`))) {
			metadata.hasTests = true;
			break;
		}
	}
	// Also check root entries directly
	if (!metadata.hasTests) {
		for (const td of TEST_DIRS) {
			if (rootLower.has(td)) { metadata.hasTests = true; break; }
		}
	}

	return metadata;
}


// ─── Build System Detection ──────────────────────────────────────────────────

async function detectBuildSystem(
	root: URI,
	rootLower: Set<string>,
	rootEntries: string[],
	fileService: IFileService,
	out: IProjectMetadata,
): Promise<void> {
	// Maven
	if (rootLower.has('pom.xml')) {
		out.buildSystem  = 'maven';
		out.buildFileUri = URI.joinPath(root, 'pom.xml').toString();
		const content = await safeRead(URI.joinPath(root, 'pom.xml'), fileService);
		if (content) {
			out.packageName    = xmlElement(content, 'artifactId');
			out.packageVersion = xmlElement(content, 'version');
			addFrameworksFromPomXml(content, out);
		}
		return;
	}

	// Gradle
	const gradleFile = rootLower.has('build.gradle.kts') ? 'build.gradle.kts'
	                 : rootLower.has('build.gradle')     ? 'build.gradle'
	                 : undefined;
	if (gradleFile) {
		out.buildSystem  = 'gradle';
		out.buildFileUri = URI.joinPath(root, gradleFile).toString();
		const content    = await safeRead(URI.joinPath(root, gradleFile), fileService);
		if (content) { addFrameworksFromGradle(content, out); }
		return;
	}

	// npm / yarn / pnpm
	if (rootLower.has('package.json')) {
		out.buildSystem  = rootLower.has('yarn.lock')         ? 'yarn'
		                 : rootLower.has('pnpm-lock.yaml')    ? 'pnpm'
		                 : 'npm';
		out.buildFileUri = URI.joinPath(root, 'package.json').toString();
		const content    = await safeRead(URI.joinPath(root, 'package.json'), fileService);
		if (content) { parsePackageJson(content, out); }
		return;
	}

	// Cargo (Rust)
	if (rootLower.has('cargo.toml')) {
		out.buildSystem  = 'cargo';
		out.buildFileUri = URI.joinPath(root, 'Cargo.toml').toString();
		const content    = await safeRead(URI.joinPath(root, 'Cargo.toml'), fileService);
		if (content) { parseCargoToml(content, out); }
		return;
	}

	// Go Modules
	if (rootLower.has('go.mod')) {
		out.buildSystem  = 'go-modules';
		out.buildFileUri = URI.joinPath(root, 'go.mod').toString();
		const content    = await safeRead(URI.joinPath(root, 'go.mod'), fileService);
		if (content) { parseGoMod(content, out); }
		return;
	}

	// Poetry / pip
	if (rootLower.has('pyproject.toml') || rootLower.has('requirements.txt') || rootLower.has('setup.py') || rootLower.has('setup.cfg')) {
		out.buildSystem = rootLower.has('pyproject.toml') ? 'poetry' : 'pip';
		const file      = rootLower.has('pyproject.toml') ? 'pyproject.toml'
		                : rootLower.has('setup.py')       ? 'setup.py'
		                : 'requirements.txt';
		out.buildFileUri = URI.joinPath(root, file).toString();
		const content    = await safeRead(URI.joinPath(root, file), fileService);
		if (content) { addFrameworksFromPython(content, out); }
		return;
	}

	// sbt (Scala)
	if (rootLower.has('build.sbt')) {
		out.buildSystem  = 'sbt';
		out.buildFileUri = URI.joinPath(root, 'build.sbt').toString();
		const content    = await safeRead(URI.joinPath(root, 'build.sbt'), fileService);
		if (content) {
			const nm = /name\s*:=\s*"([^"]+)"/.exec(content);
			const vm = /version\s*:=\s*"([^"]+)"/.exec(content);
			if (nm) { out.packageName    = nm[1]; }
			if (vm) { out.packageVersion = vm[1]; }
			if (content.includes('akka'))      { addFramework(out, 'Akka'); }
			if (content.includes('play'))       { addFramework(out, 'Play Framework'); }
			if (content.includes('zio'))        { addFramework(out, 'ZIO'); }
			if (content.includes('cats'))       { addFramework(out, 'Cats'); }
			if (content.includes('spark'))      { addFramework(out, 'Apache Spark'); }
		}
		return;
	}

	// Ant
	if (rootLower.has('build.xml')) {
		out.buildSystem  = 'ant';
		out.buildFileUri = URI.joinPath(root, 'build.xml').toString();
		return;
	}

	// MSBuild / .NET
	const csproj = rootEntries.find(n => /\.(c|v|f)sproj$|\.sln$/.test(n.toLowerCase()));
	if (csproj) {
		out.buildSystem  = 'msbuild';
		out.buildFileUri = URI.joinPath(root, csproj).toString();
		const content    = await safeRead(URI.joinPath(root, csproj), fileService);
		if (content) { addFrameworksFromCsproj(content, out); }
		return;
	}

	// CMake (with embedded/firmware heuristics)
	if (rootLower.has('cmakelists.txt')) {
		out.buildSystem  = 'cmake';
		out.buildFileUri = URI.joinPath(root, 'CMakeLists.txt').toString();
		const content    = await safeRead(URI.joinPath(root, 'CMakeLists.txt'), fileService);
		if (content) { addFrameworksFromCMakeFirmware(content, out); }
		return;
	}

	// PlatformIO (embedded cross-platform build)
	if (rootLower.has('platformio.ini')) {
		out.buildSystem  = 'platformio';
		out.buildFileUri = URI.joinPath(root, 'platformio.ini').toString();
		const content    = await safeRead(URI.joinPath(root, 'platformio.ini'), fileService);
		if (content) { addFrameworksFromPlatformIO(content, out); }
		return;
	}

	// ESP-IDF (Espressif IoT Development Framework)
	if (rootLower.has('sdkconfig') || rootLower.has('idf_component.yml') || rootLower.has('idf_component.yaml')) {
		out.buildSystem  = 'esp-idf';
		const cfgFile    = rootLower.has('idf_component.yml') ? 'idf_component.yml'
		                 : rootLower.has('idf_component.yaml') ? 'idf_component.yaml'
		                 : 'sdkconfig';
		out.buildFileUri = URI.joinPath(root, cfgFile).toString();
		addFramework(out, 'ESP-IDF');
		addFramework(out, 'FreeRTOS');
		return;
	}

	// Keil MDK (ARM microcontroller IDE)
	const keilProj = rootEntries.find(n => /\.uvprojx$/i.test(n));
	if (keilProj) {
		out.buildSystem  = 'keil-mdk';
		out.buildFileUri = URI.joinPath(root, keilProj).toString();
		const content    = await safeRead(URI.joinPath(root, keilProj), fileService);
		if (content) { addFrameworksFromKeilProject(content, out); }
		return;
	}

	// IAR Embedded Workbench
	const iarProj = rootEntries.find(n => /\.ewp$/i.test(n));
	if (iarProj) {
		out.buildSystem  = 'iar-ewb';
		out.buildFileUri = URI.joinPath(root, iarProj).toString();
		const content    = await safeRead(URI.joinPath(root, iarProj), fileService);
		if (content) { addFrameworksFromIARProject(content, out); }
		return;
	}

	// NXP S32 Design Studio (AUTOSAR / S32K automotive)
	const s32Proj = rootEntries.find(n => /\.s32project$/i.test(n));
	if (s32Proj) {
		out.buildSystem  = 's32-design-studio';
		out.buildFileUri = URI.joinPath(root, s32Proj).toString();
		addFramework(out, 'AUTOSAR MCAL');
		addFramework(out, 'S32 SDK');
		return;
	}

	// CoDeSys / CODESYS IEC 61131-3 PLC IDE
	const codeysProject = rootEntries.find(n => /\.codesys$/i.test(n));
	const codeysXmlProject = rootEntries.find(n => /\.project$/i.test(n));
	if (codeysProject) {
		out.buildSystem  = 'codesys';
		out.buildFileUri = URI.joinPath(root, codeysProject).toString();
		addFramework(out, 'CODESYS IEC 61131-3');
		return;
	}
	if (codeysXmlProject) {
		const content = await safeRead(URI.joinPath(root, codeysXmlProject), fileService);
		if (content && /codesys|3s-smart|IEC61131/i.test(content)) {
			out.buildSystem  = 'codesys';
			out.buildFileUri = URI.joinPath(root, codeysXmlProject).toString();
			addFramework(out, 'CODESYS IEC 61131-3');
			return;
		}
	}

	// Make
	if (rootLower.has('makefile') || rootLower.has('gnumakefile')) {
		out.buildSystem  = 'make';
		out.buildFileUri = URI.joinPath(root, rootLower.has('makefile') ? 'Makefile' : 'GNUmakefile').toString();
		const content    = await safeRead(URI.joinPath(root, rootLower.has('makefile') ? 'Makefile' : 'GNUmakefile'), fileService);
		if (content) { addFrameworksFromMakeFirmware(content, out); }
		return;
	}
}


// ─── Framework detection helpers ─────────────────────────────────────────────

function addFramework(meta: IProjectMetadata, name: string): void {
	if (!meta.detectedFrameworks.includes(name)) { meta.detectedFrameworks.push(name); }
}

function addFrameworksFromPomXml(xml: string, meta: IProjectMetadata): void {
	if (/spring/.test(xml))                     { addFramework(meta, xml.includes('spring-boot') ? 'Spring Boot' : 'Spring'); }
	if (/quarkus/.test(xml))                    { addFramework(meta, 'Quarkus'); }
	if (/micronaut/.test(xml))                  { addFramework(meta, 'Micronaut'); }
	if (/jakarta\.persistence|javax\.persistence/.test(xml)) { addFramework(meta, 'JPA'); }
	if (/hibernate/.test(xml))                  { addFramework(meta, 'Hibernate'); }
	if (/struts/.test(xml))                     { addFramework(meta, 'Struts'); }
	if (/myfaces|richfaces|primefaces/.test(xml)){ addFramework(meta, 'JSF'); }
	if (/jersey/.test(xml))                     { addFramework(meta, 'Jersey'); }
	if (/resteasy/.test(xml))                   { addFramework(meta, 'RESTEasy'); }
	if (/camel/.test(xml))                      { addFramework(meta, 'Apache Camel'); }
	if (/kafka/.test(xml))                      { addFramework(meta, 'Apache Kafka'); }
	if (/spark/.test(xml))                      { addFramework(meta, 'Apache Spark'); }
	if (/hadoop/.test(xml))                     { addFramework(meta, 'Hadoop'); }
}

function addFrameworksFromGradle(content: string, meta: IProjectMetadata): void {
	if (/org\.springframework/.test(content))   { addFramework(meta, content.includes('spring-boot') ? 'Spring Boot' : 'Spring'); }
	if (/quarkus/.test(content))                { addFramework(meta, 'Quarkus'); }
	if (/micronaut/.test(content))              { addFramework(meta, 'Micronaut'); }
	if (/android/.test(content))                { addFramework(meta, 'Android'); }
	if (/ktor/.test(content))                   { addFramework(meta, 'Ktor'); }
	const nm = /rootProject\.name\s*=\s*['"]([^'"]+)['"]/.exec(content);
	if (nm) { meta.packageName = nm[1]; }
}

function parsePackageJson(raw: string, meta: IProjectMetadata): void {
	try {
		const pkg = JSON.parse(raw) as Record<string, unknown>;
		meta.packageName    = pkg['name']    as string | undefined;
		meta.packageVersion = pkg['version'] as string | undefined;
		const deps = {
			...(pkg['dependencies']    as Record<string, string> ?? {}),
			...(pkg['devDependencies'] as Record<string, string> ?? {}),
			...(pkg['peerDependencies'] as Record<string, string> ?? {}),
		};
		if (deps['react'] || deps['react-dom'])           { addFramework(meta, 'React'); }
		if (deps['@angular/core'])                        { addFramework(meta, 'Angular'); }
		if (deps['vue'] || deps['@vue/core'])             { addFramework(meta, 'Vue'); }
		if (deps['next'])                                 { addFramework(meta, 'Next.js'); }
		if (deps['nuxt'] || deps['nuxt3'])                { addFramework(meta, 'Nuxt'); }
		if (deps['svelte'] || deps['@sveltejs/kit'])      { addFramework(meta, 'Svelte'); }
		if (deps['express'])                              { addFramework(meta, 'Express'); }
		if (deps['fastify'])                              { addFramework(meta, 'Fastify'); }
		if (deps['@nestjs/core'])                         { addFramework(meta, 'NestJS'); }
		if (deps['koa'])                                  { addFramework(meta, 'Koa'); }
		if (deps['hapi'] || deps['@hapi/hapi'])           { addFramework(meta, 'Hapi'); }
		if (deps['remix'] || deps['@remix-run/react'])    { addFramework(meta, 'Remix'); }
		if (deps['astro'])                                { addFramework(meta, 'Astro'); }
		if (deps['solid-js'])                             { addFramework(meta, 'SolidJS'); }
		if (deps['typeorm'])                              { addFramework(meta, 'TypeORM'); }
		if (deps['prisma'] || deps['@prisma/client'])     { addFramework(meta, 'Prisma'); }
		if (deps['mongoose'])                             { addFramework(meta, 'Mongoose'); }
		if (deps['sequelize'])                            { addFramework(meta, 'Sequelize'); }
		if (deps['graphql'])                              { addFramework(meta, 'GraphQL'); }
		if (deps['socket.io'])                            { addFramework(meta, 'Socket.io'); }
		if (deps['rxjs'])                                 { addFramework(meta, 'RxJS'); }
		if (deps['rxdb'])                                 { addFramework(meta, 'RxDB'); }
		if (deps['electron'])                             { addFramework(meta, 'Electron'); }
		if (deps['tauri'] || deps['@tauri-apps/api'])     { addFramework(meta, 'Tauri'); }
		if (deps['jest'])                                 { addFramework(meta, 'Jest'); }
		if (deps['vitest'])                               { addFramework(meta, 'Vitest'); }
		if (deps['cypress'])                              { addFramework(meta, 'Cypress'); }
		if (deps['playwright'] || deps['@playwright/test']) { addFramework(meta, 'Playwright'); }
	} catch { /* JSON parse failure — best effort */ }
}

function parseCargoToml(content: string, meta: IProjectMetadata): void {
	const nm = /^name\s*=\s*"([^"]+)"/m.exec(content);
	const vm = /^version\s*=\s*"([^"]+)"/m.exec(content);
	if (nm) { meta.packageName    = nm[1]; }
	if (vm) { meta.packageVersion = vm[1]; }
	if (/actix.web|actix_web/.test(content))    { addFramework(meta, 'Actix Web'); }
	if (/axum/.test(content))                   { addFramework(meta, 'Axum'); }
	if (/warp/.test(content))                   { addFramework(meta, 'Warp'); }
	if (/rocket/.test(content))                 { addFramework(meta, 'Rocket'); }
	if (/tokio/.test(content))                  { addFramework(meta, 'Tokio'); }
	if (/serde/.test(content))                  { addFramework(meta, 'Serde'); }
	if (/diesel/.test(content))                 { addFramework(meta, 'Diesel'); }
	if (/sqlx/.test(content))                   { addFramework(meta, 'SQLx'); }
	if (/tonic/.test(content))                  { addFramework(meta, 'Tonic (gRPC)'); }
	if (/tauri/.test(content))                  { addFramework(meta, 'Tauri'); }
}

function parseGoMod(content: string, meta: IProjectMetadata): void {
	const mm = /^module\s+(\S+)/m.exec(content);
	if (mm) { meta.packageName = mm[1]; }
	if (/gin-gonic\/gin/.test(content))         { addFramework(meta, 'Gin'); }
	if (/labstack\/echo/.test(content))         { addFramework(meta, 'Echo'); }
	if (/gofiber\/fiber/.test(content))         { addFramework(meta, 'Fiber'); }
	if (/go-kit\/kit/.test(content))            { addFramework(meta, 'Go Kit'); }
	if (/grpc/.test(content))                   { addFramework(meta, 'gRPC'); }
	if (/ent\/ent/.test(content))               { addFramework(meta, 'ent'); }
	if (/gorm/.test(content))                   { addFramework(meta, 'GORM'); }
	if (/gorilla\/mux/.test(content))           { addFramework(meta, 'Gorilla Mux'); }
}

function addFrameworksFromPython(content: string, meta: IProjectMetadata): void {
	const lower = content.toLowerCase();
	if (lower.includes('django'))               { addFramework(meta, 'Django'); }
	if (lower.includes('flask'))                { addFramework(meta, 'Flask'); }
	if (lower.includes('fastapi'))              { addFramework(meta, 'FastAPI'); }
	if (lower.includes('aiohttp'))              { addFramework(meta, 'aiohttp'); }
	if (lower.includes('tornado'))              { addFramework(meta, 'Tornado'); }
	if (lower.includes('sqlalchemy'))           { addFramework(meta, 'SQLAlchemy'); }
	if (lower.includes('celery'))               { addFramework(meta, 'Celery'); }
	if (lower.includes('pydantic'))             { addFramework(meta, 'Pydantic'); }
	if (lower.includes('alembic'))              { addFramework(meta, 'Alembic'); }
	if (lower.includes('pytest'))               { addFramework(meta, 'pytest'); }
	if (lower.includes('tensorflow'))           { addFramework(meta, 'TensorFlow'); }
	if (lower.includes('torch') || lower.includes('pytorch')) { addFramework(meta, 'PyTorch'); }
	const nm = /^name\s*=\s*['"]([^'"]+)['"]/m.exec(content);
	const vm = /^version\s*=\s*['"]([^'"]+)['"]/m.exec(content);
	if (nm) { meta.packageName    = nm[1]; }
	if (vm) { meta.packageVersion = vm[1]; }
}

// ─── Firmware / Embedded Framework Detection ─────────────────────────────────

function addFrameworksFromCMakeFirmware(content: string, meta: IProjectMetadata): void {
	const lower = content.toLowerCase();
	// RTOS detection
	if (/find_package\s*\(\s*freertos/i.test(content) || lower.includes('freertos'))     { addFramework(meta, 'FreeRTOS'); }
	if (/find_package\s*\(\s*zephyr/i.test(content) || lower.includes('zephyr_kernel'))  { addFramework(meta, 'Zephyr RTOS'); }
	if (lower.includes('threadx') || lower.includes('azure-rtos'))                       { addFramework(meta, 'Azure RTOS ThreadX'); }
	if (lower.includes('embos') || lower.includes('segger_embos'))                       { addFramework(meta, 'embOS'); }
	if (lower.includes('safertos') || lower.includes('safe_rtos'))                       { addFramework(meta, 'SafeRTOS'); }
	// AUTOSAR
	if (/autosar|mcal|rte_|isolar/i.test(content))                                       { addFramework(meta, 'AUTOSAR MCAL'); }
	// HAL / SDK
	if (/stm32\w*hal|hal_driver/i.test(content))                                         { addFramework(meta, 'STM32 HAL'); }
	if (/nxp.*sdk|mcuxpresso|ksdk/i.test(content))                                       { addFramework(meta, 'NXP MCUXpresso SDK'); }
	if (/nordic.*sdk|nrf5_sdk|nrf_sdk/i.test(content))                                   { addFramework(meta, 'Nordic nRF5 SDK'); }
	if (/ti.*sdk|simplelink|cc.*sdk/i.test(content))                                     { addFramework(meta, 'TI SimpleLink SDK'); }
	if (/esp-idf|esp32|idf_component/i.test(content))                                    { addFramework(meta, 'ESP-IDF'); }
	if (/avr-libc|avr\/io\.h/i.test(content))                                            { addFramework(meta, 'AVR-libc'); }
	// CMSIS
	if (/cmsis|arm_math/i.test(content))                                                 { addFramework(meta, 'CMSIS'); }
	// IEC 61131-3 / PLC
	if (/iec61131|codesys|oscat|plcopen/i.test(content))                                 { addFramework(meta, 'CODESYS IEC 61131-3'); }
	// Protocol stacks
	if (/libmodbus|modbus/i.test(content))                                               { addFramework(meta, 'libmodbus'); }
	if (/open62541|opcua/i.test(content))                                                { addFramework(meta, 'open62541 OPC-UA'); }
	if (/eclipse.*titan|ttcn3/i.test(content))                                           { addFramework(meta, 'Eclipse Titan TTCN-3'); }
	if (/canopen|lss|co_stack/i.test(content))                                           { addFramework(meta, 'CANopen Stack'); }
	if (/ethercat|soem|igh.*ethercat/i.test(content))                                    { addFramework(meta, 'EtherCAT SOEM'); }
	if (/mqtt|mosquitto|paho/i.test(content))                                            { addFramework(meta, 'MQTT'); }
}

function addFrameworksFromPlatformIO(content: string, meta: IProjectMetadata): void {
	// PlatformIO platform/framework fields
	if (/framework\s*=.*arduino/i.test(content))                                         { addFramework(meta, 'Arduino'); }
	if (/framework\s*=.*espidf/i.test(content))                                          { addFramework(meta, 'ESP-IDF'); }
	if (/framework\s*=.*zephyr/i.test(content))                                          { addFramework(meta, 'Zephyr RTOS'); }
	if (/framework\s*=.*freertos/i.test(content))                                        { addFramework(meta, 'FreeRTOS'); }
	if (/framework\s*=.*mbed/i.test(content))                                            { addFramework(meta, 'Mbed OS'); }
	if (/platform\s*=.*ststm32/i.test(content))                                          { addFramework(meta, 'STM32'); }
	if (/platform\s*=.*espressif/i.test(content))                                        { addFramework(meta, 'Espressif'); }
	if (/platform\s*=.*nxp/i.test(content))                                              { addFramework(meta, 'NXP MCUXpresso SDK'); }
	if (/platform\s*=.*atmelsam/i.test(content))                                         { addFramework(meta, 'Atmel SAM'); }
	if (/lib_deps.*freertos/i.test(content))                                             { addFramework(meta, 'FreeRTOS'); }
	if (/lib_deps.*arduino/i.test(content))                                              { addFramework(meta, 'Arduino'); }
}

function addFrameworksFromKeilProject(content: string, meta: IProjectMetadata): void {
	// Keil .uvprojx is XML
	if (/FreeRTOS/i.test(content))                                                        { addFramework(meta, 'FreeRTOS'); }
	if (/CMSIS.RTOS|RTX/i.test(content))                                                  { addFramework(meta, 'CMSIS-RTOS2 / Keil RTX5'); }
	if (/CMSIS.Driver|CMSIS.Core/i.test(content))                                         { addFramework(meta, 'CMSIS'); }
	if (/STM32Cube|STM32HAL/i.test(content))                                              { addFramework(meta, 'STM32 HAL'); }
	if (/NXP|MCUX|Kinetis/i.test(content))                                                { addFramework(meta, 'NXP MCUXpresso SDK'); }
	if (/Nordic|nRF/i.test(content))                                                      { addFramework(meta, 'Nordic nRF5 SDK'); }
	if (/AUTOSAR|MCAL/i.test(content))                                                    { addFramework(meta, 'AUTOSAR MCAL'); }
	if (/SafeRTOS/i.test(content))                                                        { addFramework(meta, 'SafeRTOS'); }
	if (/embOS/i.test(content))                                                           { addFramework(meta, 'embOS'); }
	// Extract target device name
	const deviceM = /<Device>([^<]+)<\/Device>/.exec(content);
	if (deviceM) { meta.packageName = deviceM[1].trim(); }
}

function addFrameworksFromIARProject(content: string, meta: IProjectMetadata): void {
	// IAR .ewp is XML
	if (/FreeRTOS/i.test(content))                                                        { addFramework(meta, 'FreeRTOS'); }
	if (/SafeRTOS/i.test(content))                                                        { addFramework(meta, 'SafeRTOS'); }
	if (/CMSIS/i.test(content))                                                           { addFramework(meta, 'CMSIS'); }
	if (/AUTOSAR|MCAL/i.test(content))                                                    { addFramework(meta, 'AUTOSAR MCAL'); }
	if (/STM32/i.test(content))                                                           { addFramework(meta, 'STM32 HAL'); }
	if (/Renesas|RA[0-9]|RX[0-9]/i.test(content))                                        { addFramework(meta, 'Renesas FSP'); }
	if (/NXP|LPC|Kinetis|S32K/i.test(content))                                           { addFramework(meta, 'NXP MCUXpresso SDK'); }
	if (/RL-ARM|RL-RTX/i.test(content))                                                   { addFramework(meta, 'CMSIS-RTOS2 / Keil RTX5'); }
	// Extract target processor
	const cpuM = /<name>([^<]+)<\/name>/.exec(content);
	if (cpuM) { meta.packageName = cpuM[1].trim(); }
}

function addFrameworksFromMakeFirmware(content: string, meta: IProjectMetadata): void {
	const lower = content.toLowerCase();
	if (lower.includes('freertos'))                                                        { addFramework(meta, 'FreeRTOS'); }
	if (lower.includes('zephyr'))                                                          { addFramework(meta, 'Zephyr RTOS'); }
	if (/stm32\w*hal|cubemx/i.test(content))                                              { addFramework(meta, 'STM32 HAL'); }
	if (/avr-gcc|avrdude|avr_libc/i.test(content))                                        { addFramework(meta, 'AVR-libc'); }
	if (/arm-none-eabi|armcc/i.test(content))                                             { addFramework(meta, 'ARM Embedded Toolchain'); }
	if (/misra|polyspace|pc.lint/i.test(content))                                         { addFramework(meta, 'MISRA-C Static Analysis'); }
	if (/open62541/i.test(content))                                                        { addFramework(meta, 'open62541 OPC-UA'); }
	if (/libmodbus/i.test(content))                                                        { addFramework(meta, 'libmodbus'); }
	if (/canopen/i.test(content))                                                          { addFramework(meta, 'CANopen Stack'); }
	if (/ethercat|soem/i.test(content))                                                    { addFramework(meta, 'EtherCAT SOEM'); }
}

function addFrameworksFromCsproj(content: string, meta: IProjectMetadata): void {
	if (/Microsoft\.AspNetCore/.test(content))  { addFramework(meta, 'ASP.NET Core'); }
	if (/Microsoft\.EntityFrameworkCore/.test(content)) { addFramework(meta, 'Entity Framework Core'); }
	if (/Blazor/.test(content))                 { addFramework(meta, 'Blazor'); }
	if (/Xamarin/.test(content))                { addFramework(meta, 'Xamarin'); }
	if (/\.Maui/.test(content))                 { addFramework(meta, '.NET MAUI'); }
	if (/SignalR/.test(content))                { addFramework(meta, 'SignalR'); }
	if (/NUnit|xunit|MSTest/.test(content))     { addFramework(meta, 'Unit Testing'); }
	const nm = /<AssemblyName>([^<]+)<\/AssemblyName>/.exec(content);
	if (nm) { meta.packageName = nm[1]; }
}


// ─── Utility ──────────────────────────────────────────────────────────────────

export async function listRootEntries(root: URI, fileService: IFileService): Promise<string[]> {
	try {
		const entries = await fileService.resolve(root, { resolveMetadata: false });
		return entries.children?.map(c => c.name) ?? [];
	} catch {
		return [];
	}
}

async function safeRead(uri: URI, fileService: IFileService): Promise<string | undefined> {
	try {
		return (await fileService.readFile(uri)).value.toString();
	} catch {
		return undefined;
	}
}

/** Extract the text of a single XML element (first occurrence, best-effort). */
function xmlElement(xml: string, tag: string): string | undefined {
	const m = new RegExp(`<${tag}[^>]*>([^<]+)<\/${tag}>`).exec(xml);
	return m ? m[1].trim() : undefined;
}
