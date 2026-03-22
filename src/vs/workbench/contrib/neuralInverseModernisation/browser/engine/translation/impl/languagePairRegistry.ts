/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Language Pair Registry
 *
 * Defines migration profiles for every supported source → target language pair.
 * Each profile provides:
 *
 * - **systemPersona**    — Expert role the AI should adopt in the system prompt
 * - **idiomMap**         — Construct-level source→target mappings (20–40 per pair)
 * - **conventionNotes**  — Target language conventions injected into the user prompt
 * - **warningPatterns**  — Constructs that require raised decisions or extra care
 * - **targetFramework**  — Default framework (overridable via ITranslationOptions)
 * - **targetTestFramework** — Default test framework
 *
 * ## Supported Pairs (22 specific profiles + generic fallback)
 *
 * | Source              | Targets                                      |
 * |---------------------|----------------------------------------------|
 * | COBOL               | Java, TypeScript, Python, Go                 |
 * | PL/SQL (Oracle)     | TypeScript, Java, Python                     |
 * | RPG / RPGLE         | Java                                         |
 * | Java EE             | Spring Boot (Java modernisation)             |
 * | Angular 1.x         | Angular 18+                                  |
 * | PL/1                | Java                                         |
 * | VB6                 | C# (.NET 8)                                  |
 * | ABAP (SAP)          | TypeScript (NestJS)                          |
 * | PowerBuilder        | Java (Spring Boot)                           |
 * | Assembler (x86/z)   | C                                            |
 * | Ada                 | C++ (safety-critical)                        |
 * | Fortran             | Python (NumPy/SciPy), C++ (Eigen/OpenMP)     |
 * | NATURAL / ADABAS    | Java, Python                                 |
 * | MUMPS / M           | Python (FHIR R4)                             |
 * | ColdFusion (CFML)   | TypeScript (NestJS)                          |
 * | (Generic fallback)  | Any                                          |
 */

import { canonicaliseLanguage } from '../../fingerprint/impl/languageRegistry.js';


// ─── Profile types ────────────────────────────────────────────────────────────

export interface IIdiomMapping {
	/** Source language construct or pattern */
	sourceConstruct: string;
	/** Target language equivalent or idiom */
	targetConstruct: string;
	/** Optional clarifying note for the AI */
	notes?: string;
}

export interface ILanguagePairProfile {
	sourceLang: string;      // canonical source language key
	targetLang: string;      // canonical target language key
	label: string;           // Human-readable pair label for prompts
	targetFramework?: string;
	targetTestFramework?: string;
	/**
	 * Expert persona for the LLM system prompt.
	 * Describes the role, experience, and specific expertise expected.
	 */
	systemPersona: string;
	/** Key construct-level mappings, most important first */
	idiomMap: IIdiomMapping[];
	/** Bullet-point conventions injected into the user prompt */
	conventionNotes: string[];
	/**
	 * Patterns that require special attention, raised decisions, or extra care.
	 * Each entry is a bullet point in the "Warning Patterns" section of the prompt.
	 */
	warningPatterns: string[];
	/**
	 * File extension for the translated output.
	 * Used to generate suggested target file paths.
	 */
	targetFileExtension: string;
}


// ─── COBOL → Java ─────────────────────────────────────────────────────────────

const COBOL_TO_JAVA: ILanguagePairProfile = {
	sourceLang: 'cobol',
	targetLang: 'java',
	label: 'COBOL → Java (Spring Boot)',
	targetFramework: 'Spring Boot 3',
	targetTestFramework: 'JUnit 5',
	targetFileExtension: 'java',

	systemPersona: `You are a senior software architect with 20 years of experience migrating IBM mainframe COBOL batch programs and CICS transactions to modern Java Spring Boot microservices. You have deep expertise in COBOL data types (COMP-3 packed decimal, USAGE DISPLAY, REDEFINES), COBOL structured programming patterns, and their precise Java equivalents. You understand that monetary arithmetic in COBOL uses fixed-point packed decimal and MUST be mapped to java.math.BigDecimal with explicit scale and RoundingMode — never double or float. You are meticulous about preserving business logic, rounding rules, and overflow behaviour.`,

	idiomMap: [
		{ sourceConstruct: 'IDENTIFICATION DIVISION. PROGRAM-ID. PROGNAME.',         targetConstruct: '@Service\npublic class ProgName { ... }',                           notes: 'Use @Service for business logic, @Component for utilities' },
		{ sourceConstruct: 'WORKING-STORAGE SECTION. 01 WS-field PIC ...',           targetConstruct: 'private BigDecimal wsField;  // instance field',                   notes: 'Group 01 items become POJOs or flat fields depending on usage' },
		{ sourceConstruct: 'PIC 9(9)V9(2) COMP-3 (packed decimal, 2 decimal)',       targetConstruct: 'BigDecimal (scale=2, RoundingMode.HALF_UP)',                       notes: 'NEVER use double/float for packed decimal monetary fields' },
		{ sourceConstruct: 'PIC 9(N) COMP / COMP-4 (binary integer)',                targetConstruct: 'int (N≤9) or long (N>9)',                                          notes: 'Match sign/unsigned from picture clause' },
		{ sourceConstruct: 'PIC X(N) (alphanumeric)',                                targetConstruct: 'String (use .trim() when reading)',                                 notes: 'COBOL strings are space-padded; always trim when comparing' },
		{ sourceConstruct: 'PIC 9(N) (zoned decimal display)',                       targetConstruct: 'int or long',                                                      notes: 'Zoned decimal is just an integer in display format' },
		{ sourceConstruct: 'MOVE source TO dest',                                    targetConstruct: 'dest = source;',                                                   notes: 'Handle type coercions explicitly (numeric↔string)' },
		{ sourceConstruct: 'COMPUTE result = expression',                            targetConstruct: 'result = expression;  // use BigDecimal.multiply/divide/add',      notes: 'For COMP-3 fields use BigDecimal arithmetic throughout' },
		{ sourceConstruct: 'ADD a TO b',                                             targetConstruct: 'b = b.add(a);  // or b += a for int/long',                         notes: '' },
		{ sourceConstruct: 'SUBTRACT a FROM b',                                      targetConstruct: 'b = b.subtract(a);  // or b -= a',                                 notes: '' },
		{ sourceConstruct: 'MULTIPLY a BY b GIVING c',                               targetConstruct: 'c = a.multiply(b);',                                               notes: '' },
		{ sourceConstruct: 'DIVIDE a INTO b GIVING c REMAINDER r',                   targetConstruct: 'BigDecimal[] dr = b.divideAndRemainder(a); c = dr[0]; r = dr[1];', notes: 'Use divideAndRemainder for combined divide+remainder' },
		{ sourceConstruct: 'COMPUTE x ROUNDED',                                      targetConstruct: 'x.setScale(scale, RoundingMode.HALF_UP)',                          notes: 'COBOL default rounding is HALF_UP' },
		{ sourceConstruct: 'PERFORM PARA-NAME',                                      targetConstruct: 'paraName();  // private method call',                              notes: 'Each paragraph becomes a private method' },
		{ sourceConstruct: 'PERFORM PARA UNTIL condition',                           targetConstruct: 'while (!condition) { para(); }',                                   notes: 'PERFORM UNTIL is pre-test by default' },
		{ sourceConstruct: 'PERFORM PARA WITH TEST AFTER UNTIL condition',           targetConstruct: 'do { para(); } while (!condition);',                               notes: 'WITH TEST AFTER = post-test (do-while)' },
		{ sourceConstruct: 'PERFORM VARYING I FROM 1 BY 1 UNTIL I > N',             targetConstruct: 'for (int i = 1; i <= n; i++)',                                     notes: 'COBOL VARYING is 1-based and inclusive' },
		{ sourceConstruct: 'IF cond THEN ... ELSE ... END-IF',                       targetConstruct: 'if (cond) { ... } else { ... }',                                   notes: '' },
		{ sourceConstruct: 'EVALUATE subject WHEN val1 ... WHEN OTHER END-EVALUATE', targetConstruct: 'switch (subject) { case val1: ... default: ... }',                 notes: 'Prefer switch expression (Java 14+) for single-value evaluation' },
		{ sourceConstruct: '88 FLAG-NAME VALUE "Y".',                                targetConstruct: 'boolean isFlagName() { return "Y".equals(flagField); }',           notes: 'Level-88 condition names become boolean methods or enums' },
		{ sourceConstruct: '01 REDEFINES another-field',                             targetConstruct: '// Raise decision: REDEFINES requires structural analysis',        notes: 'ALWAYS raise a type-mapping decision for REDEFINES' },
		{ sourceConstruct: 'OCCURS N TIMES (fixed-length table)',                    targetConstruct: 'T[] field = new T[N];',                                            notes: '' },
		{ sourceConstruct: 'OCCURS 1 TO N TIMES DEPENDING ON counter',              targetConstruct: 'List<T> field = new ArrayList<>(counter);',                        notes: 'Variable-length table → ArrayList' },
		{ sourceConstruct: 'GO TO PARA-NAME',                                        targetConstruct: '// Raise decision: GO TO requires structural refactoring',         notes: 'ALWAYS raise a rule-interpretation decision for GO TO' },
		{ sourceConstruct: 'CALL "PROGNAME" USING a b c',                            targetConstruct: 'progName.method(a, b, c);  // see calledInterfaces section',       notes: 'Check calledInterfaces section for exact method signature' },
		{ sourceConstruct: 'STRING a DELIMITED BY SPACE INTO b',                     targetConstruct: 'b = a.trim() + ...;  // use StringBuilder for multi-STRING',       notes: '' },
		{ sourceConstruct: 'UNSTRING source DELIMITED BY "," INTO a b c',            targetConstruct: 'String[] parts = source.split(",", -1);',                          notes: '' },
		{ sourceConstruct: 'INSPECT field REPLACING ALL SPACES BY ZEROES',          targetConstruct: 'field = field.replace(" ", "0");',                                 notes: '' },
		{ sourceConstruct: 'OPEN INPUT file-name / READ file-name / CLOSE',          targetConstruct: 'BufferedReader / InputStream / @Repository injection',             notes: 'File I/O → repository or stream; raise decision if file layout unclear' },
		{ sourceConstruct: 'SORT sort-file ON ASCENDING KEY sort-key',               targetConstruct: 'list.sort(Comparator.comparing(...));',                             notes: '' },
		{ sourceConstruct: 'ACCEPT identifier FROM DATE',                            targetConstruct: 'LocalDate.now()  or  LocalDate date = LocalDate.now();',           notes: '' },
		{ sourceConstruct: 'DISPLAY "message" identifier',                           targetConstruct: 'log.info("message {}", identifier);  // SLF4J',                   notes: 'Replace DISPLAY with SLF4J logging' },
		{ sourceConstruct: 'INITIALIZE group-item',                                  targetConstruct: 'Set all fields to zero/blank in constructor or init method',       notes: '' },
		{ sourceConstruct: 'STOP RUN',                                               targetConstruct: '// End of method — return from main entry point',                  notes: 'Multiple STOP RUN = early returns in Java' },
	],

	conventionNotes: [
		'Use `java.math.BigDecimal` for ALL monetary computations — never `double` or `float`',
		'Annotate business logic classes with `@Service`, repositories with `@Repository`',
		'Constructor-inject all dependencies (`@Autowired` on constructor, not field injection)',
		'Each COBOL paragraph (PROCEDURE DIVISION section) becomes a `private void` method',
		'01-level group items become inner static POJOs or flat fields — raise decision if ambiguous',
		'Name classes using UpperCamelCase from the COBOL program-id (e.g. CALC-LATE-FEE → CalcLateFeeService)',
		'Name methods using lowerCamelCase from the paragraph name (e.g. CALC-INTEREST → calcInterest())',
		'Level-88 condition names become either enums or boolean helper methods',
		'Replace DISPLAY with SLF4J: `private static final Logger log = LoggerFactory.getLogger(...)`',
		'File I/O (OPEN/READ/CLOSE) should use injected Spring repositories or Java NIO streams',
		'Follow Spring Boot 3 / Java 17+ idioms: records for POJOs, switch expressions, sealed classes where appropriate',
	],

	warningPatterns: [
		'REDEFINES — always raise a type-mapping decision; structural overlay is rarely straightforward',
		'COMP-1 / COMP-2 (floating-point) — monetary fields using COMP-1/2 may lose precision; raise a rule-interpretation decision',
		'GO TO — always raise a rule-interpretation decision; refactoring GO TO requires understanding control flow',
		'PERFORM THRU — if the paragraph range spans non-trivial logic, raise a decision',
		'EXTERNAL data — EXTERNAL working-storage implies shared singleton state; raise a naming decision about Spring bean scope',
		'SORT file WITH DUPLICATES IN ORDER — preservation of sort stability must be confirmed',
		'Signed numeric with SIGN IS LEADING SEPARATE — ensure correct BigDecimal parsing',
		'OCCURS DEPENDING ON > 500 entries — consider streaming rather than materialising into a List',
		'Multiple CALL targets based on a variable (computed CALL) — raise a rule-interpretation decision',
	],
};


// ─── COBOL → TypeScript ───────────────────────────────────────────────────────

const COBOL_TO_TYPESCRIPT: ILanguagePairProfile = {
	sourceLang: 'cobol',
	targetLang: 'typescript',
	label: 'COBOL → TypeScript (Node.js)',
	targetFramework: 'Node.js + TypeScript',
	targetTestFramework: 'Jest',
	targetFileExtension: 'ts',

	systemPersona: `You are an expert in migrating COBOL batch programs to TypeScript Node.js services. You understand COBOL data types precisely and know how to represent packed decimal (COMP-3) fields using Decimal.js or big.js to preserve monetary precision. You translate COBOL procedural programs into clean TypeScript classes with async/await patterns.`,

	idiomMap: [
		{ sourceConstruct: 'PIC 9(N)V9(M) COMP-3 (packed decimal monetary)',  targetConstruct: 'Decimal (from decimal.js library)',                             notes: 'Never use JavaScript number for monetary COMP-3 fields' },
		{ sourceConstruct: 'PIC X(N) (alphanumeric)',                          targetConstruct: 'string (trimmed)',                                              notes: 'Always trim COBOL alphanumeric strings' },
		{ sourceConstruct: 'PIC 9(N) (integer)',                               targetConstruct: 'number (safe integer range) or bigint',                        notes: 'Use bigint for N > 15' },
		{ sourceConstruct: 'MOVE source TO dest',                              targetConstruct: 'dest = source;',                                                notes: '' },
		{ sourceConstruct: 'PERFORM PARA UNTIL condition',                     targetConstruct: 'while (!condition) { para(); }  // or await para() if async',  notes: '' },
		{ sourceConstruct: 'CALL "PROGNAME" USING a b c',                      targetConstruct: 'await progName.method(a, b, c);',                              notes: 'All external calls become async functions' },
		{ sourceConstruct: 'EVALUATE subject WHEN ...',                        targetConstruct: 'switch / if-else chain',                                       notes: '' },
		{ sourceConstruct: '88 FLAG-NAME VALUE "Y".',                          targetConstruct: 'get isFlagName(): boolean { return this.flagField === "Y"; }', notes: '' },
		{ sourceConstruct: 'DISPLAY "msg" var',                                targetConstruct: 'console.log(`msg ${var}`);  // or logger.info()',              notes: '' },
		{ sourceConstruct: 'OPEN INPUT file / READ / CLOSE',                   targetConstruct: 'fs.createReadStream() with readline interface',                notes: 'File I/O → Node.js streams' },
	],

	conventionNotes: [
		'Use `Decimal` from `decimal.js` for all COMP-3 monetary fields',
		'Use `class` with constructor injection pattern for services',
		'All external program calls become `async` methods with `await`',
		'Use TypeScript strict mode: no implicit any, strictNullChecks enabled',
		'Export classes and interfaces from index.ts files per module',
		'Use `readonly` for fields that are set once in the constructor',
		'Prefer `interface` over `type` for data shapes that may be extended',
	],

	warningPatterns: [
		'REDEFINES — raise type-mapping decision; JavaScript has no union/overlay types',
		'GO TO — raise rule-interpretation decision',
		'COMP-1 / COMP-2 — raise decision about precision requirements',
		'Computed CALL (variable program name) — raise rule-interpretation decision',
	],
};


// ─── COBOL → Python ───────────────────────────────────────────────────────────

const COBOL_TO_PYTHON: ILanguagePairProfile = {
	sourceLang: 'cobol',
	targetLang: 'python',
	label: 'COBOL → Python',
	targetFramework: 'Python 3.11+',
	targetTestFramework: 'pytest',
	targetFileExtension: 'py',

	systemPersona: `You are an expert migrating COBOL programs to Python 3. You know that Python's Decimal module (from decimal import Decimal) must replace COBOL packed decimal (COMP-3) to preserve monetary precision. You translate COBOL paragraphs into Python functions and working-storage into instance or class variables.`,

	idiomMap: [
		{ sourceConstruct: 'PIC 9(N)V9(M) COMP-3',               targetConstruct: 'Decimal (from decimal import Decimal)',                        notes: 'Set context: decimal.getcontext().prec = 28' },
		{ sourceConstruct: 'PIC X(N)',                             targetConstruct: 'str (stripped)',                                               notes: '' },
		{ sourceConstruct: 'MOVE source TO dest',                  targetConstruct: 'dest = source',                                                notes: '' },
		{ sourceConstruct: 'PERFORM PARA UNTIL cond',              targetConstruct: 'while not cond: para()',                                       notes: '' },
		{ sourceConstruct: 'PERFORM VARYING I FROM 1 BY 1',        targetConstruct: 'for i in range(1, n+1):',                                      notes: '' },
		{ sourceConstruct: 'EVALUATE WHEN ... WHEN OTHER',         targetConstruct: 'match subject: case val1: ... case _:',                        notes: 'Python 3.10+ match statement' },
		{ sourceConstruct: '88 FLAG VALUE "Y"',                    targetConstruct: '@property def is_flag(self): return self.flag_field == "Y"',   notes: '' },
		{ sourceConstruct: 'CALL "PROG" USING a b c',              targetConstruct: 'prog.method(a, b, c)  # see called interfaces',               notes: '' },
		{ sourceConstruct: 'DISPLAY "msg" var',                    targetConstruct: 'logger.info(f"msg {var}")',                                   notes: '' },
		{ sourceConstruct: 'OPEN INPUT / READ / CLOSE',            targetConstruct: 'with open(path, "r") as f:',                                  notes: '' },
	],

	conventionNotes: [
		'Use `Decimal` from `decimal` module for all monetary COMP-3 fields',
		'Use `dataclasses` or `pydantic.BaseModel` for WORKING-STORAGE group items',
		'Follow PEP 8: snake_case for variables/functions, PascalCase for classes',
		'Each COBOL paragraph becomes a private method (`_para_name`)',
		'Use type hints throughout: `def calc_fee(self, balance: Decimal) -> Decimal:`',
		'Use `@dataclass` for simple data containers, `pydantic` for validated models',
	],

	warningPatterns: [
		'REDEFINES — raise type-mapping decision; Python has no native union/overlay',
		'GO TO — raise rule-interpretation decision',
		'Computed CALL — raise rule-interpretation decision',
		'OCCURS DEPENDING ON large tables — consider generators/iterators',
	],
};


// ─── PL/SQL → TypeScript ──────────────────────────────────────────────────────

const PLSQL_TO_TYPESCRIPT: ILanguagePairProfile = {
	sourceLang: 'plsql',
	targetLang: 'typescript',
	label: 'PL/SQL (Oracle) → TypeScript (Node.js)',
	targetFramework: 'Node.js + TypeScript + TypeORM',
	targetTestFramework: 'Jest',
	targetFileExtension: 'ts',

	systemPersona: `You are an expert database migration engineer specialising in moving Oracle PL/SQL stored procedures, packages, and functions to TypeScript Node.js services backed by TypeORM or a similar ORM. You understand PL/SQL type anchoring (%TYPE, %ROWTYPE), cursor patterns, exception handling, and package-level state, and know how to faithfully translate them to TypeScript with appropriate ORM patterns.`,

	idiomMap: [
		{ sourceConstruct: 'v_balance accounts.balance%TYPE',                    targetConstruct: 'let balance: number;  // or exact Account["balance"] type',    notes: 'Use TypeORM entity field type for anchored declarations' },
		{ sourceConstruct: 'v_rec accounts%ROWTYPE',                             targetConstruct: 'let rec: Account;  // TypeORM entity',                          notes: '' },
		{ sourceConstruct: 'CURSOR c IS SELECT ... FROM ... WHERE ...',          targetConstruct: 'const records = await repo.find({ where: ... })',               notes: 'Explicit cursors → repository.find() or query builder' },
		{ sourceConstruct: 'OPEN c; FETCH c INTO v_col; CLOSE c;',              targetConstruct: 'for (const row of await cursor) { ... }',                       notes: '' },
		{ sourceConstruct: 'REF CURSOR / SYS_REFCURSOR',                        targetConstruct: 'Promise<T[]>  (return type from async function)',               notes: '' },
		{ sourceConstruct: 'INSERT INTO ... VALUES / SELECT',                    targetConstruct: 'await repo.save(entity) / await repo.createQueryBuilder()...',  notes: '' },
		{ sourceConstruct: 'UPDATE ... SET ... WHERE ...',                       targetConstruct: 'await repo.update(criteria, partialEntity)',                    notes: '' },
		{ sourceConstruct: 'DELETE FROM ... WHERE ...',                          targetConstruct: 'await repo.delete(criteria)',                                   notes: '' },
		{ sourceConstruct: 'BEGIN TRANSACTION / COMMIT / ROLLBACK',             targetConstruct: 'await dataSource.transaction(async (em) => { ... })',           notes: 'Wrap in TypeORM transaction callback' },
		{ sourceConstruct: 'EXCEPTION WHEN NO_DATA_FOUND THEN ...',             targetConstruct: 'catch (err) { if (err instanceof EntityNotFoundError) ... }',   notes: '' },
		{ sourceConstruct: 'EXCEPTION WHEN OTHERS THEN ...',                    targetConstruct: 'catch (err: unknown) { ... }',                                  notes: '' },
		{ sourceConstruct: 'RAISE_APPLICATION_ERROR(-20001, "msg")',             targetConstruct: 'throw new ApplicationError("msg");',                           notes: 'Define ApplicationError extending Error' },
		{ sourceConstruct: 'pkg_name.procedure_name(a, b)',                     targetConstruct: 'await pkgNameService.procedureName(a, b)',                      notes: 'PL/SQL package → TypeScript @Injectable service class' },
		{ sourceConstruct: 'v_result := pkg_billing.calc_late_fee(bal, days)',   targetConstruct: 'const result = await billingService.calcLateFee(bal, days)',   notes: '' },
		{ sourceConstruct: 'ROUND(v_amount, 2)',                                 targetConstruct: 'Math.round(amount * 100) / 100  // or Decimal rounding',       notes: 'Raise decision if monetary precision critical' },
		{ sourceConstruct: 'NVL(expr, default)',                                 targetConstruct: 'expr ?? default',                                              notes: '' },
		{ sourceConstruct: 'NVL2(expr, val_if_not_null, val_if_null)',           targetConstruct: 'expr != null ? val_if_not_null : val_if_null',                 notes: '' },
		{ sourceConstruct: 'TO_DATE("2024-01-01", "YYYY-MM-DD")',               targetConstruct: 'new Date("2024-01-01")',                                        notes: '' },
		{ sourceConstruct: 'SYSDATE',                                            targetConstruct: 'new Date()',                                                    notes: '' },
		{ sourceConstruct: 'DBMS_OUTPUT.PUT_LINE(msg)',                          targetConstruct: 'console.log(msg)  // or logger.debug()',                       notes: '' },
	],

	conventionNotes: [
		'Each PL/SQL package becomes a TypeScript `@Injectable()` service class',
		'Each package procedure/function becomes a `public async` method',
		'Use TypeORM `DataSource.transaction()` for all multi-statement blocks',
		'All methods that touch the database must be `async` and return `Promise<T>`',
		'Use TypeORM entity classes annotated with `@Entity()` for schema types',
		'Replace Oracle-specific functions (SUBSTR, INSTR, etc.) with JS string methods',
		'Package-level variables become class instance variables (`private` fields)',
	],

	warningPatterns: [
		'BULK COLLECT / FORALL — large-dataset patterns; check if pagination is more appropriate',
		'AUTONOMOUS_TRANSACTION — raise rule-interpretation decision; side-effect semantics change',
		'Pragma EXCEPTION_INIT — custom exception codes; define TypeScript error hierarchy',
		'Dynamic SQL (EXECUTE IMMEDIATE) — raise rule-interpretation decision; parameterise carefully',
		'LOB handling (CLOB, BLOB) — raise type-mapping decision; streams vs. Buffers vs. strings',
		'Database links — raise rule-interpretation decision; cross-service calls in microservices',
	],
};


// ─── PL/SQL → Java ────────────────────────────────────────────────────────────

const PLSQL_TO_JAVA: ILanguagePairProfile = {
	sourceLang: 'plsql',
	targetLang: 'java',
	label: 'PL/SQL (Oracle) → Java (Spring Boot)',
	targetFramework: 'Spring Boot 3 + Spring Data JPA',
	targetTestFramework: 'JUnit 5',
	targetFileExtension: 'java',

	systemPersona: `You are an expert migrating Oracle PL/SQL packages and stored procedures to Java Spring Boot services using Spring Data JPA and Hibernate. You translate PL/SQL cursors to JPA repository queries, PL/SQL exception handling to Spring's exception hierarchy, and PL/SQL packages to Spring @Service classes.`,

	idiomMap: [
		{ sourceConstruct: 'CREATE PACKAGE pkg_name',             targetConstruct: '@Service\npublic class PkgNameService { ... }',                        notes: '' },
		{ sourceConstruct: 'CURSOR c IS SELECT ... FROM ...',      targetConstruct: '@Query("SELECT ...") List<T> findBy...();  // JPA repository',        notes: '' },
		{ sourceConstruct: 'EXCEPTION WHEN NO_DATA_FOUND',        targetConstruct: 'catch (EmptyResultDataAccessException e)',                             notes: '' },
		{ sourceConstruct: 'COMMIT / ROLLBACK',                   targetConstruct: '@Transactional on service method',                                     notes: '' },
		{ sourceConstruct: 'v_rec table%ROWTYPE',                  targetConstruct: '@Entity class TableName { ... }',                                     notes: '' },
		{ sourceConstruct: 'NVL(expr, default)',                   targetConstruct: 'Optional.ofNullable(expr).orElse(default)',                           notes: '' },
		{ sourceConstruct: 'ROUND(amount, 2)',                     targetConstruct: 'amount.setScale(2, RoundingMode.HALF_UP)',                            notes: 'Use BigDecimal for monetary amounts' },
		{ sourceConstruct: 'DBMS_OUTPUT.PUT_LINE(msg)',            targetConstruct: 'log.debug("{}", msg);',                                               notes: '' },
		{ sourceConstruct: 'RAISE_APPLICATION_ERROR(-20001, m)',   targetConstruct: 'throw new BusinessException(m);',                                    notes: '' },
		{ sourceConstruct: 'pkg_name.func(a, b)',                  targetConstruct: 'pkgNameService.func(a, b)',                                           notes: '' },
	],

	conventionNotes: [
		'Each PL/SQL package → `@Service` class with constructor-injected `@Repository` dependencies',
		'Use `@Transactional` on service methods that span multiple DML operations',
		'Use `BigDecimal` for all monetary fields',
		'JPA entities annotated with `@Entity`, `@Column`, `@Id`',
		'Repository interfaces extend `JpaRepository<T, ID>` with `@Query` for complex queries',
	],

	warningPatterns: [
		'AUTONOMOUS_TRANSACTION — raise rule-interpretation decision',
		'BULK COLLECT with FORALL — consider JPA batch insert/update',
		'Dynamic SQL — raise rule-interpretation decision; use parameterised JPA Criteria API',
		'Database links — raise rule-interpretation decision',
	],
};


// ─── RPG / RPGLE → Java ───────────────────────────────────────────────────────

const RPG_TO_JAVA: ILanguagePairProfile = {
	sourceLang: 'rpgle',
	targetLang: 'java',
	label: 'RPG/RPGLE (IBM i) → Java (Spring Boot)',
	targetFramework: 'Spring Boot 3',
	targetTestFramework: 'JUnit 5',
	targetFileExtension: 'java',

	systemPersona: `You are an expert in migrating IBM i RPG and RPGLE programs to Java Spring Boot. You understand RPG IV free-format code, RPG III fixed-format, data structures (DS), file processing (F-specs), procedure interfaces (PI/PR), and the IBM i service program model. You map RPG packed fields to BigDecimal, RPG date/time fields to java.time types, and RPG file operations to Spring repositories or JPA.`,

	idiomMap: [
		{ sourceConstruct: 'D fieldname S 9P2 (packed decimal, 9 digits, 2 dec)',  targetConstruct: 'BigDecimal fieldname;  // scale=2',                            notes: '' },
		{ sourceConstruct: 'D fieldname S 10A (character 10)',                     targetConstruct: 'String fieldname;',                                            notes: '' },
		{ sourceConstruct: 'D fieldname S 4 0 (integer 4 digits)',                 targetConstruct: 'int fieldname;',                                               notes: '' },
		{ sourceConstruct: 'D struct DS (data structure)',                         targetConstruct: 'class StructName { ... }  // POJO',                            notes: '' },
		{ sourceConstruct: 'EVAL target = expression',                             targetConstruct: 'target = expression;',                                         notes: '' },
		{ sourceConstruct: 'CALLP procedureName(a: b: c)',                         targetConstruct: 'procedureName(a, b, c);',                                      notes: 'Check calledInterfaces for signature' },
		{ sourceConstruct: 'DOW condition / ENDDO',                               targetConstruct: 'while (condition) { ... }',                                    notes: '' },
		{ sourceConstruct: 'DOU condition / ENDDO',                               targetConstruct: 'do { ... } while (!condition);',                               notes: '' },
		{ sourceConstruct: 'FOR i = 1 TO n / ENDFOR',                             targetConstruct: 'for (int i = 1; i <= n; i++) { ... }',                         notes: '' },
		{ sourceConstruct: 'SELECT WHEN cond ... OTHER / ENDSL',                  targetConstruct: 'if/else chain or switch expression',                           notes: '' },
		{ sourceConstruct: 'MONITOR / ON-ERROR / ENDMON',                         targetConstruct: 'try { ... } catch (Exception e) { ... }',                     notes: '' },
		{ sourceConstruct: 'CHAIN key fileDS (random read by key)',                targetConstruct: 'repo.findById(key).orElse(null)',                              notes: '' },
		{ sourceConstruct: 'READ fileDS (sequential read)',                        targetConstruct: 'repo.findAll() iterator or streaming',                        notes: '' },
		{ sourceConstruct: 'WRITE fileDS (write record)',                          targetConstruct: 'repo.save(entity)',                                            notes: '' },
		{ sourceConstruct: 'UPDATE fileDS (update after CHAIN)',                   targetConstruct: 'repo.save(entity)  // after mutation',                        notes: '' },
		{ sourceConstruct: 'DELETE fileDS (delete after CHAIN)',                   targetConstruct: 'repo.deleteById(key)',                                         notes: '' },
	],

	conventionNotes: [
		'RPG procedure interfaces (PI/PR) become Java method signatures',
		'RPG service programs become Spring `@Service` classes',
		'RPG file specs (F-specs) become Spring Data JPA repositories',
		'All packed decimal (P) fields → `BigDecimal` with appropriate scale',
		'RPG date fields → `LocalDate`, time fields → `LocalTime`, timestamp → `LocalDateTime`',
		'RPG indicator variables (*IN01..*IN99) → boolean fields',
	],

	warningPatterns: [
		'Data queues (DTAQ) — raise rule-interpretation decision; JMS or async queue may apply',
		'Program-described files — raise type-mapping decision about record format',
		'Externally described files (DDS) — use DDS field definitions for entity mapping',
		'ILE binding directory — service program dependencies become Spring bean injections',
		'*DTAARA (data area) — raise naming decision about shared state',
	],
};


// ─── Java EE → Spring Boot ────────────────────────────────────────────────────

const JAVAEE_TO_SPRINGBOOT: ILanguagePairProfile = {
	sourceLang: 'java',
	targetLang: 'java',
	label: 'Java EE → Spring Boot 3 (modernisation)',
	targetFramework: 'Spring Boot 3 + Spring Data JPA',
	targetTestFramework: 'JUnit 5 + Mockito',
	targetFileExtension: 'java',

	systemPersona: `You are a Java enterprise migration expert specialising in moving Java EE (Jakarta EE) applications to Spring Boot 3. You replace EJBs with Spring components, JPA from the EJB container with Spring Data JPA, JAX-RS with Spring MVC/WebFlux, and CDI with Spring DI. You retain all business logic faithfully while modernising the infrastructure wiring.`,

	idiomMap: [
		{ sourceConstruct: '@Stateless / @Stateful EJB',                 targetConstruct: '@Service  // or @Component',                                         notes: '' },
		{ sourceConstruct: '@EJB UserBean userBean',                      targetConstruct: '@Autowired UserBean userBean  // or constructor injection',          notes: 'Prefer constructor injection' },
		{ sourceConstruct: '@Inject dependency',                          targetConstruct: '@Autowired dependency  // or constructor param',                     notes: '' },
		{ sourceConstruct: '@PersistenceContext EntityManager em',        targetConstruct: 'Inject JpaRepository<T,ID> via constructor',                        notes: '' },
		{ sourceConstruct: 'em.find(Entity.class, id)',                   targetConstruct: 'repo.findById(id).orElseThrow()',                                   notes: '' },
		{ sourceConstruct: 'em.persist(entity)',                          targetConstruct: 'repo.save(entity)',                                                  notes: '' },
		{ sourceConstruct: 'em.merge(entity)',                            targetConstruct: 'repo.save(entity)',                                                  notes: '' },
		{ sourceConstruct: 'em.remove(em.merge(entity))',                 targetConstruct: 'repo.delete(entity)',                                                notes: '' },
		{ sourceConstruct: 'em.createQuery("JPQL", T.class).getResultList()', targetConstruct: '@Query("JPQL") List<T> findBy...();',                          notes: '' },
		{ sourceConstruct: '@TransactionAttribute(REQUIRED)',             targetConstruct: '@Transactional  // default propagation REQUIRED',                   notes: '' },
		{ sourceConstruct: '@Path("/resource") @GET @Produces(JSON)',     targetConstruct: '@RestController @GetMapping("/resource") @ResponseBody',            notes: '' },
		{ sourceConstruct: '@MessageDriven(activationConfig=...)',        targetConstruct: '@JmsListener(destination="queue")',                                  notes: '' },
		{ sourceConstruct: '@Schedule(hour="0", minute="0")',             targetConstruct: '@Scheduled(cron="0 0 * * * *")',                                    notes: '' },
		{ sourceConstruct: 'InitialContext / JNDI lookup',                targetConstruct: 'Spring @Autowired / @Value injection',                              notes: '' },
		{ sourceConstruct: 'UserTransaction (BMT)',                       targetConstruct: '@Transactional(propagation=Propagation.REQUIRES_NEW)',               notes: '' },
	],

	conventionNotes: [
		'Replace all `@Stateless`/`@Stateful` EJBs with `@Service` (stateless) or `@Component`',
		'Replace all `@PersistenceContext` with constructor-injected `JpaRepository<T, ID>`',
		'Use Spring `@Transactional` (org.springframework.transaction.annotation) not javax.ejb',
		'Replace JAX-RS annotations with Spring MVC: `@RestController`, `@GetMapping`, etc.',
		'Replace CDI `@Inject` with `@Autowired` on constructors (constructor injection preferred)',
		'Replace JNDI lookups with Spring `@Value("${property}")` or `@Autowired` injection',
		'Use Spring Boot auto-configuration — remove boilerplate XML and web.xml',
	],

	warningPatterns: [
		'Stateful Session Beans (SFSB) — raise naming decision about Spring scope (prototype vs session)',
		'Entity Beans (pre-JPA) — raise type-mapping decision; likely need full JPA entity redesign',
		'Message-driven Beans with complex activation specs — raise rule-interpretation decision',
		'Remote EJBs / RMI — raise rule-interpretation decision; replace with REST/gRPC/messaging',
		'Application client components — raise rule-interpretation decision',
	],
};


// ─── Angular 1 → Angular 18 ───────────────────────────────────────────────────

const ANGULARJS_TO_ANGULAR: ILanguagePairProfile = {
	sourceLang: 'javascript',
	targetLang: 'typescript',
	label: 'Angular 1 (AngularJS) → Angular 18+ (TypeScript)',
	targetFramework: 'Angular 18+ with standalone components',
	targetTestFramework: 'Jest + Angular Testing Library',
	targetFileExtension: 'ts',

	systemPersona: `You are an expert in migrating AngularJS (Angular 1.x) applications to modern Angular 18+ with TypeScript. You translate controllers to components, factories/services to injectable Angular services, $scope to component properties/methods, ng-repeat to *ngFor, ng-model to [(ngModel)] or reactive forms, and $http to Angular HttpClient.`,

	idiomMap: [
		{ sourceConstruct: 'angular.module("app", []).controller("Ctrl", fn)',  targetConstruct: '@Component({ selector: "app-ctrl", ... })\nexport class CtrlComponent implements OnInit',  notes: '' },
		{ sourceConstruct: '$scope.property = value',                           targetConstruct: 'property = value;  // component property',                notes: '' },
		{ sourceConstruct: '$scope.method = function() { ... }',               targetConstruct: 'method(): void { ... }  // component method',            notes: '' },
		{ sourceConstruct: 'factory("ServiceName", function(...) {})',          targetConstruct: '@Injectable({ providedIn: "root" })\nexport class ServiceName { }', notes: '' },
		{ sourceConstruct: '$http.get(url)',                                    targetConstruct: 'this.http.get<T>(url)',                                   notes: 'Inject HttpClient via constructor' },
		{ sourceConstruct: '$http.post(url, data)',                             targetConstruct: 'this.http.post<T>(url, data)',                           notes: '' },
		{ sourceConstruct: 'promise.then(fn).catch(fn)',                        targetConstruct: 'observable.pipe(catchError(...)).subscribe()',           notes: 'Or use async/await with firstValueFrom()' },
		{ sourceConstruct: '$q.defer() / deferred.resolve()',                   targetConstruct: 'Observable.create() or new Promise<T>()',               notes: '' },
		{ sourceConstruct: 'ng-repeat="item in items"',                        targetConstruct: '*ngFor="let item of items"',                             notes: '' },
		{ sourceConstruct: 'ng-if="condition"',                                targetConstruct: '*ngIf="condition"  // or @if block (Angular 17+)',        notes: '' },
		{ sourceConstruct: 'ng-show / ng-hide',                                targetConstruct: '[hidden]="condition" / [style.display]',                 notes: '' },
		{ sourceConstruct: 'ng-model="obj.field"',                             targetConstruct: '[(ngModel)]="obj.field"  // or reactive FormControl',    notes: '' },
		{ sourceConstruct: 'ng-click="method()"',                              targetConstruct: '(click)="method()"',                                    notes: '' },
		{ sourceConstruct: 'ng-class="{ active: isActive }"',                  targetConstruct: '[class.active]="isActive"',                             notes: '' },
		{ sourceConstruct: '$routeProvider.when("/path", { controller, template })', targetConstruct: 'Routes array with component: RouteComponent',     notes: '' },
		{ sourceConstruct: '$stateProvider (ui-router)',                        targetConstruct: 'Angular Router with RouterModule.forRoot(routes)',       notes: '' },
		{ sourceConstruct: '$broadcast / $emit / $on',                         targetConstruct: 'EventEmitter @Output / RxJS Subject / NgRx action',     notes: 'Raise decision if event bus is complex' },
	],

	conventionNotes: [
		'Use standalone components (Angular 14+) — no `NgModule` required unless integrating with existing modules',
		'Use `inject()` function or constructor injection for all service dependencies',
		'Use `@Input()` and `@Output()` for component communication instead of $scope',
		'Use Angular Signals (`signal()`, `computed()`) for reactive state (Angular 16+)',
		'Replace `$http` with `HttpClient` — always use typed responses `http.get<T>(url)`',
		'Use reactive forms (`FormBuilder`, `FormGroup`) for complex form handling',
		'Use `OnPush` change detection strategy for performance',
		'Replace `$q` promises with RxJS observables or native `async/await`',
	],

	warningPatterns: [
		'Two-way binding on complex objects — raise rule-interpretation decision about state management',
		'$rootScope event bus — raise rule-interpretation decision (NgRx / component events)',
		'Dynamic template compilation ($compile) — raise rule-interpretation decision',
		'Custom directives with complex link functions — raise rule-interpretation decision',
		'$watch on large objects — raise naming decision about signals vs observables',
	],
};


// ─── PL/1 → Java ─────────────────────────────────────────────────────────────

const PL1_TO_JAVA: ILanguagePairProfile = {
	sourceLang: 'pl1',
	targetLang: 'java',
	label: 'PL/1 → Java (Spring Boot)',
	targetFramework: 'Spring Boot 3',
	targetTestFramework: 'JUnit 5',
	targetFileExtension: 'java',

	systemPersona: `You are an expert in migrating IBM PL/1 programs to Java Spring Boot. You understand PL/1's block structure, FIXED DECIMAL type (monetary precision), string handling with VARYING and FIXED attributes, PL/1 ON conditions (exception handling), BASED variables (pointer-based data), and PL/1 structure overlays.`,

	idiomMap: [
		{ sourceConstruct: 'DCL field FIXED DEC(15,2)',           targetConstruct: 'BigDecimal field;  // scale=2',                              notes: '' },
		{ sourceConstruct: 'DCL field FIXED BIN(31)',             targetConstruct: 'int field;',                                                notes: '' },
		{ sourceConstruct: 'DCL field CHAR(N) [VARYING]',        targetConstruct: 'String field;',                                             notes: '' },
		{ sourceConstruct: 'DCL 1 struct, 2 a CHAR(5), 2 b ...',  targetConstruct: 'class Struct { String a; ... }',                           notes: '' },
		{ sourceConstruct: 'ON CONDITION (name) ... END',         targetConstruct: 'try { ... } catch (NameException e) { ... }',              notes: '' },
		{ sourceConstruct: 'SIGNAL condition',                    targetConstruct: 'throw new NameException()',                                 notes: '' },
		{ sourceConstruct: 'DO WHILE (cond) / END',               targetConstruct: 'while (cond) { ... }',                                    notes: '' },
		{ sourceConstruct: 'DO VARYING i FROM 1 TO n BY 1 / END', targetConstruct: 'for (int i = 1; i <= n; i++) { ... }',                   notes: '' },
		{ sourceConstruct: 'SELECT WHEN / OTHERWISE / END',       targetConstruct: 'switch / if-else chain',                                  notes: '' },
		{ sourceConstruct: 'CALL module(a, b)',                   targetConstruct: 'module.method(a, b)',                                     notes: '' },
		{ sourceConstruct: 'PUT FILE(print) EDIT(expr) (fmt)',     targetConstruct: 'log.info("{}", formatted)',                               notes: '' },
		{ sourceConstruct: 'GET FILE(input) EDIT(var) (fmt)',      targetConstruct: 'BufferedReader / Scanner',                                notes: '' },
	],

	conventionNotes: [
		'PL/1 PROCEDURE becomes a Java `@Service` class',
		'PL/1 FIXED DEC → `BigDecimal` with explicit scale',
		'PL/1 ON conditions become Java `try/catch` with specific exception types',
		'PL/1 structured variables (1-level, 2-level nesting) become Java POJOs',
		'PL/1 BASED variables / pointer arithmetic → raise rule-interpretation decision',
	],

	warningPatterns: [
		'BASED variables and pointer arithmetic — raise rule-interpretation decision',
		'Structure overlays (LIKE / DEFINED) — raise type-mapping decision',
		'Interrupt handlers (ON ERROR SYSTEM) — raise rule-interpretation decision',
		'TASK / EVENT / WAIT (PL/1 multitasking) — raise rule-interpretation decision',
	],
};


// ─── Assembler → C ────────────────────────────────────────────────────────────

const ASSEMBLER_TO_C: ILanguagePairProfile = {
	sourceLang: 'assembler',
	targetLang: 'c',
	label: 'Assembler (x86 / IBM z) → C',
	targetFramework: 'C (POSIX)',
	targetTestFramework: 'Unity / CMocka',
	targetFileExtension: 'c',

	systemPersona: `You are an expert reverse-engineering assembler programs and translating them to idiomatic C. You understand register allocation, calling conventions (System V AMD64 ABI / IBM z calling convention), stack frames, flag operations, and assembler structured programming patterns. You produce C that is semantically equivalent and safe, not just a mechanical register-by-register transcription.`,

	idiomMap: [
		{ sourceConstruct: 'MOV eax, operand',        targetConstruct: 'int eax = operand;  // or direct use of variable',      notes: '' },
		{ sourceConstruct: 'ADD eax, operand',         targetConstruct: 'eax += operand;',                                       notes: '' },
		{ sourceConstruct: 'SUB eax, operand',         targetConstruct: 'eax -= operand;',                                       notes: '' },
		{ sourceConstruct: 'MUL operand',              targetConstruct: 'result = eax * operand;  // unsigned 64-bit result',    notes: '' },
		{ sourceConstruct: 'CMP a, b + conditional JMP', targetConstruct: 'if (a == b) { ... }  (or appropriate comparison)',  notes: '' },
		{ sourceConstruct: 'CALL label',               targetConstruct: 'label();  // function call',                            notes: '' },
		{ sourceConstruct: 'RET',                      targetConstruct: 'return eax;  // or return; for void',                  notes: '' },
		{ sourceConstruct: 'PUSH / POP',               targetConstruct: '// Local variables on C stack (implicit)',             notes: '' },
		{ sourceConstruct: 'Loop structure JMP back',  targetConstruct: 'while / for / do-while',                               notes: '' },
	],

	conventionNotes: [
		'Translate semantic intent, not register-by-register — identify the algorithm',
		'Use `int32_t`, `uint32_t`, etc. from `<stdint.h>` to match register widths',
		'Use `uint64_t` for 64-bit arithmetic results (MUL/IMUL overflow)',
		'Identify calling conventions from the context to determine function boundaries',
		'Use `volatile` for memory-mapped I/O or interrupt-shared variables',
	],

	warningPatterns: [
		'Self-modifying code — raise rule-interpretation decision; not translatable to C',
		'Inline hardware I/O (IN/OUT instructions) — raise rule-interpretation decision',
		'Interrupt service routines — raise rule-interpretation decision',
		'Position-dependent code (PIC vs non-PIC) — raise naming decision',
		'Mixed data/code segments — raise type-mapping decision',
	],
};


// ─── NATURAL → Java ───────────────────────────────────────────────────────────

const NATURAL_TO_JAVA: ILanguagePairProfile = {
	sourceLang: 'natural',
	targetLang: 'java',
	label: 'NATURAL (Software AG) → Java (Spring Boot)',
	targetFramework: 'Spring Boot 3',
	targetTestFramework: 'JUnit 5',
	targetFileExtension: 'java',

	systemPersona: `You are an expert migrating Software AG NATURAL programs from ADABAS-backed mainframe environments to Java Spring Boot. You understand NATURAL DDMs (Data Definition Modules), NATURAL data areas (LDA/GDA/PDA), CALLNAT, FETCH, and NATURAL's READ/HISTOGRAM/FIND loops against ADABAS files.`,

	idiomMap: [
		{ sourceConstruct: 'DEFINE DATA LOCAL 1 #field (A20)',        targetConstruct: 'private String field;',                                         notes: '' },
		{ sourceConstruct: 'DEFINE DATA LOCAL 1 #amount (P9.2)',      targetConstruct: 'private BigDecimal amount;  // scale=2',                        notes: '' },
		{ sourceConstruct: 'USING DA-name (data area)',               targetConstruct: '// Fields from data area injected as class fields',             notes: 'Data area contents are inlined by Phase 1 resolver' },
		{ sourceConstruct: 'CALLNAT "SUBPROG" #a #b',                 targetConstruct: 'subProgService.call(a, b)',                                     notes: 'Check calledInterfaces for signature' },
		{ sourceConstruct: 'FETCH "SUBPROG"',                         targetConstruct: 'subProgService.execute()',                                      notes: '' },
		{ sourceConstruct: 'READ CUSTOMER BY #cust-no',               targetConstruct: 'customerRepo.findByCustomerNo(custNo)',                        notes: '' },
		{ sourceConstruct: 'FIND CUSTOMER WITH #name = "SMITH"',      targetConstruct: 'customerRepo.findByName("SMITH")',                             notes: '' },
		{ sourceConstruct: 'HISTOGRAM CUSTOMER FOR #name',            targetConstruct: 'customerRepo.findDistinctNames()',                             notes: '' },
		{ sourceConstruct: 'AT START OF DATA / AT END OF DATA',       targetConstruct: 'if (firstRecord) {...}  /  if (lastRecord) {...}',             notes: '' },
		{ sourceConstruct: 'ESCAPE TOP / ESCAPE BOTTOM',              targetConstruct: 'continue;  /  break;',                                        notes: '' },
		{ sourceConstruct: 'MOVE #a TO #b',                           targetConstruct: 'b = a;',                                                       notes: '' },
		{ sourceConstruct: 'COMPUTE #result = #a + #b',               targetConstruct: 'result = a.add(b);  // BigDecimal or arithmetic',             notes: '' },
		{ sourceConstruct: 'IF #x = "Y" THEN ... END-IF',             targetConstruct: 'if ("Y".equals(x)) { ... }',                                 notes: '' },
		{ sourceConstruct: 'FOR #i = 1 TO #n',                        targetConstruct: 'for (int i = 1; i <= n; i++) { ... }',                       notes: '' },
		{ sourceConstruct: 'PERFORM subroutine',                      targetConstruct: 'subroutine();',                                               notes: '' },
		{ sourceConstruct: 'WRITE / PRINT output-field',              targetConstruct: 'log.info("{}", outputField);',                               notes: '' },
		{ sourceConstruct: 'INPUT USING MAP "map-name"',              targetConstruct: '// Screen map; raise rule-interpretation decision',           notes: '' },
		{ sourceConstruct: 'PROCESS COMMAND',                         targetConstruct: '// Command processing; raise rule-interpretation decision',  notes: '' },
	],

	conventionNotes: [
		'NATURAL DDMs map to JPA `@Entity` classes with ADABAS field names',
		'Local data areas (LDA) map to method-local variables or method parameters',
		'Global data areas (GDA) map to shared Spring `@Scope("session")` beans',
		'Parameter data areas (PDA) map to method parameters or request DTOs',
		'NATURAL packed decimal (P type) → `BigDecimal` with appropriate scale',
		'NATURAL READ loops → Spring Data repository queries (JPA or custom)',
		'Replace NATURAL WRITE/PRINT with SLF4J logging',
	],

	warningPatterns: [
		'ADABAS MU/PE fields (multiple-value / periodic group) — raise type-mapping decision',
		'NATURAL maps (INPUT USING MAP) — raise rule-interpretation decision; UI redesign needed',
		'PROCESS COMMAND — raise rule-interpretation decision; command routing patterns',
		'CALLNAT with variable program name — raise rule-interpretation decision',
		'NATURAL security objects — raise rule-interpretation decision',
		'NATURAL database calls against Tamino or other non-ADABAS stores — raise decision',
	],
};


// ─── Fortran → Python ─────────────────────────────────────────────────────────

const FORTRAN_TO_PYTHON: ILanguagePairProfile = {
	sourceLang: 'fortran',
	targetLang: 'python',
	label: 'Fortran → Python (NumPy/SciPy)',
	targetFramework: 'Python 3.11+ with NumPy / SciPy',
	targetTestFramework: 'pytest',
	targetFileExtension: 'py',

	systemPersona: `You are an expert migrating Fortran 77/90/95/2003 scientific programs to Python 3 using NumPy and SciPy. You understand Fortran array semantics (column-major order, 1-based indexing), COMMON blocks, EQUIVALENCE, implicit typing, DO loops, and FORMAT statements. You faithfully translate numerical algorithms while adapting to Python idioms.`,

	idiomMap: [
		{ sourceConstruct: 'REAL*8 / DOUBLE PRECISION',            targetConstruct: 'float  // Python float is 64-bit (C double)',               notes: '' },
		{ sourceConstruct: 'REAL (single precision)',               targetConstruct: 'np.float32 when precision matters',                         notes: '' },
		{ sourceConstruct: 'INTEGER*4',                            targetConstruct: 'int',                                                        notes: '' },
		{ sourceConstruct: 'COMPLEX*16',                           targetConstruct: 'complex',                                                    notes: '' },
		{ sourceConstruct: 'DIMENSION A(10)',                      targetConstruct: 'A = np.zeros(10)',                                          notes: '1-based → 0-based indexing shift; use A[i-1] or refactor loop' },
		{ sourceConstruct: 'DIMENSION A(M, N) (column-major)',     targetConstruct: 'A = np.zeros((M, N), order="F")  // Fortran order',        notes: 'Use order="F" to preserve column-major access patterns' },
		{ sourceConstruct: 'DO I = 1, N ... END DO',               targetConstruct: 'for i in range(1, n+1):',                                   notes: 'Or vectorise with NumPy for performance' },
		{ sourceConstruct: 'DO WHILE (cond) ... END DO',           targetConstruct: 'while cond:',                                               notes: '' },
		{ sourceConstruct: 'COMMON /BLOCKNAME/ var1, var2',        targetConstruct: 'global var1, var2  // or module-level variables',          notes: 'Raise naming decision about module structure' },
		{ sourceConstruct: 'SUBROUTINE name(a, b, c)',             targetConstruct: 'def name(a, b, c):',                                        notes: '' },
		{ sourceConstruct: 'FUNCTION name(a) RESULT(r)',           targetConstruct: 'def name(a): ... return r',                                 notes: '' },
		{ sourceConstruct: 'CALL subroutine(a, b)',                targetConstruct: 'subroutine(a, b)',                                          notes: '' },
		{ sourceConstruct: 'IF (cond) THEN ... ELSE IF ... END IF', targetConstruct: 'if cond: ... elif ...: ... else: ...',                    notes: '' },
		{ sourceConstruct: 'WRITE(*, fmt) variables',              targetConstruct: 'print(f"formatted: {variables}")',                          notes: 'Or use logging for non-interactive output' },
		{ sourceConstruct: 'READ(unit, fmt) variables',            targetConstruct: 'variables = input()  /  np.loadtxt(file)',                 notes: '' },
	],

	conventionNotes: [
		'Use NumPy arrays instead of Fortran DIMENSION arrays — vectorise where possible',
		'Fortran arrays are 1-based; shift to 0-based Python indexing carefully',
		'Fortran column-major arrays → NumPy `order="F"` arrays for direct memory mapping',
		'COMMON blocks → Python module-level variables or class attributes',
		'Use `scipy` for numerical algorithms already available (LAPACK, BLAS wrappers)',
		'Use `@numba.jit` or `@numba.njit` for performance-critical inner loops',
		'Use type hints: `def solve(A: np.ndarray, b: np.ndarray) -> np.ndarray:`',
	],

	warningPatterns: [
		'EQUIVALENCE — raise type-mapping decision; overlapping storage is unsafe in Python',
		'GOTO — raise rule-interpretation decision; refactor to structured loops',
		'ENTRY statement (multiple entry points) — raise rule-interpretation decision',
		'FORMAT statements with complex edit descriptors — raise naming decision',
		'Pointer arithmetic / C interop — raise rule-interpretation decision',
	],
};


// ─── VB6 → C# ────────────────────────────────────────────────────────────────

const VB6_TO_CSHARP: ILanguagePairProfile = {
	sourceLang: 'vb6',
	targetLang: 'csharp',
	label: 'Visual Basic 6 → C# (.NET 8)',
	targetFramework: '.NET 8 / ASP.NET Core',
	targetTestFramework: 'xUnit',
	targetFileExtension: 'cs',

	systemPersona: `You are an expert migrating Visual Basic 6 (VB6) applications to modern C# on .NET 8. You understand VB6 forms, modules, class modules, COM interop, ADO/DAO data access, VB6 string functions, and the On Error GoTo error handling model. You produce idiomatic C# with proper exception handling, LINQ-based data access, and dependency injection patterns.`,

	idiomMap: [
		{ sourceConstruct: 'Module / BAS module',                  targetConstruct: 'static class',                                              notes: 'Module-level globals → static fields or injected services' },
		{ sourceConstruct: 'Class Module',                          targetConstruct: 'class',                                                     notes: '' },
		{ sourceConstruct: 'Form (.frm)',                           targetConstruct: 'class / ViewModel (MVVM) or Controller',                   notes: 'Raise naming decision about UI framework (WinForms/WPF/Blazor/API)' },
		{ sourceConstruct: 'Public Sub / Private Sub',             targetConstruct: 'public void / private void',                               notes: '' },
		{ sourceConstruct: 'Public Function / Private Function',   targetConstruct: 'public T / private T',                                     notes: '' },
		{ sourceConstruct: 'On Error GoTo label',                  targetConstruct: 'try { ... } catch (Exception ex) { ... }',                 notes: 'Map error label blocks to catch clauses' },
		{ sourceConstruct: 'On Error Resume Next',                 targetConstruct: 'try { ... } catch { /* swallow */ }',                      notes: 'Raise rule-interpretation decision: intentional silent swallow?' },
		{ sourceConstruct: 'Err.Number / Err.Description',        targetConstruct: 'ex.HResult / ex.Message',                                  notes: '' },
		{ sourceConstruct: 'Dim x As String',                      targetConstruct: 'string x',                                                  notes: '' },
		{ sourceConstruct: 'Dim x As Variant',                    targetConstruct: 'object x  // or dynamic; raise type-mapping decision',     notes: '' },
		{ sourceConstruct: 'Dim x As Long',                        targetConstruct: 'int x  // VB6 Long = 32-bit',                              notes: '' },
		{ sourceConstruct: 'Set obj = New ClassName',              targetConstruct: 'var obj = new ClassName()',                                 notes: '' },
		{ sourceConstruct: 'Set obj = Nothing',                    targetConstruct: 'obj = null;',                                               notes: '' },
		{ sourceConstruct: 'IsNull(x)',                            targetConstruct: 'x == null',                                                 notes: '' },
		{ sourceConstruct: 'IsEmpty(x)',                           targetConstruct: 'x == null || (x is string s && s.Length == 0)',             notes: '' },
		{ sourceConstruct: 'Len(s)',                               targetConstruct: 's.Length',                                                  notes: '' },
		{ sourceConstruct: 'Mid(s, start, len)',                   targetConstruct: 's.Substring(start - 1, len)',                              notes: '1-based → 0-based indexing' },
		{ sourceConstruct: 'Left(s, n)',                           targetConstruct: 's.Substring(0, Math.Min(n, s.Length))',                    notes: '' },
		{ sourceConstruct: 'Right(s, n)',                          targetConstruct: 's.Substring(Math.Max(0, s.Length - n))',                   notes: '' },
		{ sourceConstruct: 'InStr(s1, s2)',                        targetConstruct: 's1.IndexOf(s2, StringComparison.Ordinal) + 1',             notes: '0-based → 1-based return' },
		{ sourceConstruct: 'UCase(s) / LCase(s)',                 targetConstruct: 's.ToUpper() / s.ToLower()',                                notes: '' },
		{ sourceConstruct: 'Trim(s)',                              targetConstruct: 's.Trim()',                                                   notes: '' },
		{ sourceConstruct: 'CStr(x)',                              targetConstruct: 'x.ToString()',                                              notes: '' },
		{ sourceConstruct: 'CInt(x)',                              targetConstruct: '(int)x  /  Convert.ToInt32(x)',                           notes: '' },
		{ sourceConstruct: 'CDbl(x)',                              targetConstruct: '(double)x  /  Convert.ToDouble(x)',                       notes: '' },
		{ sourceConstruct: 'For i = 1 To n ... Next i',           targetConstruct: 'for (int i = 1; i <= n; i++)',                             notes: '' },
		{ sourceConstruct: 'For Each item In collection',         targetConstruct: 'foreach (var item in collection)',                          notes: '' },
		{ sourceConstruct: 'Do While ... Loop',                   targetConstruct: 'while (...) { }',                                           notes: '' },
		{ sourceConstruct: 'Select Case x',                       targetConstruct: 'switch (x) { case ...: break; }',                          notes: '' },
		{ sourceConstruct: 'ADODB.Recordset / DAO.Recordset',     targetConstruct: 'List<T> from EF Core / Dapper query',                     notes: 'Raise rule-interpretation decision about target ORM/data access layer' },
		{ sourceConstruct: 'MsgBox "text"',                        targetConstruct: '// UI concern — raise naming decision for target layer',    notes: '' },
		{ sourceConstruct: 'Collection object',                    targetConstruct: 'List<T>',                                                   notes: '' },
		{ sourceConstruct: 'Dictionary object',                    targetConstruct: 'Dictionary<TKey, TValue>',                                  notes: '' },
	],

	conventionNotes: [
		'Use C# 12 features: primary constructors, collection expressions, pattern matching',
		'Use `ArgumentNullException.ThrowIfNull()` for null guards',
		'Replace COM/ADO data access with EF Core (or Dapper for read-heavy paths)',
		'Use `async/await` for all database and network I/O',
		'Use `ILogger<T>` instead of Debug.Print / MsgBox logging',
		'Namespace: use the project root namespace + feature folder (e.g. `MyApp.Billing`)',
		'Use `record` for value types that were VB6 Type structures',
	],

	warningPatterns: [
		'Variant type — raise type-mapping decision: what type does business logic require?',
		'On Error Resume Next — raise rule-interpretation decision: is error swallowing intentional?',
		'COM/ActiveX references — raise rule-interpretation decision about .NET replacement',
		'Win32 API calls via Declare — raise rule-interpretation decision',
		'VB6 File I/O (Open, Get, Put) — raise naming decision about target I/O approach',
		'Global module-level state — raise naming decision about DI/scoping strategy',
	],
};


// ─── ABAP → TypeScript ────────────────────────────────────────────────────────

const ABAP_TO_TYPESCRIPT: ILanguagePairProfile = {
	sourceLang: 'abap',
	targetLang: 'typescript',
	label: 'ABAP (SAP) → TypeScript (Node.js / NestJS)',
	targetFramework: 'Node.js + NestJS + TypeORM',
	targetTestFramework: 'Jest',
	targetFileExtension: 'ts',

	systemPersona: `You are an expert migrating SAP ABAP programs to TypeScript/NestJS microservices. You understand ABAP Open SQL, transparent tables, function modules, BAPIs, BADIs, ALV reports, classical ABAP OOP (classes/interfaces), selection screens, and SAP message classes. You translate ABAP business logic into idiomatic TypeScript with NestJS dependency injection, TypeORM entities, and REST endpoints.`,

	idiomMap: [
		{ sourceConstruct: 'REPORT / PROGRAM',                     targetConstruct: '@Controller() or @Injectable() service class',             notes: '' },
		{ sourceConstruct: 'FUNCTION MODULE',                      targetConstruct: '@Injectable() service method',                             notes: 'Raise naming decision: REST endpoint vs. internal service call?' },
		{ sourceConstruct: 'CLASS ... DEFINITION / IMPLEMENTATION', targetConstruct: 'class ... { ... }',                                        notes: '' },
		{ sourceConstruct: 'INTERFACE in ABAP',                    targetConstruct: 'interface (TypeScript)',                                    notes: '' },
		{ sourceConstruct: 'DATA var TYPE table_field',            targetConstruct: 'type inferred from TypeORM entity field',                  notes: 'Raise type-mapping decision for each custom ABAP type' },
		{ sourceConstruct: 'DATA itab TYPE TABLE OF struc',        targetConstruct: 'StrucEntity[]  (TypeORM array)',                          notes: '' },
		{ sourceConstruct: 'SELECT * FROM ztable INTO TABLE itab', targetConstruct: 'await repo.find()  (TypeORM FindOptions)',                 notes: '' },
		{ sourceConstruct: 'SELECT SINGLE ... WHERE ...',          targetConstruct: 'await repo.findOne({ where: { ... } })',                   notes: '' },
		{ sourceConstruct: 'INSERT ztable FROM wa',                targetConstruct: 'await repo.save(entity)',                                  notes: '' },
		{ sourceConstruct: 'UPDATE ztable SET ... WHERE ...',      targetConstruct: 'await repo.update({ where }, partialEntity)',              notes: '' },
		{ sourceConstruct: 'DELETE FROM ztable WHERE ...',         targetConstruct: 'await repo.delete({ where })',                             notes: '' },
		{ sourceConstruct: 'LOOP AT itab INTO wa',                 targetConstruct: 'for (const wa of itab) {',                                notes: '' },
		{ sourceConstruct: 'READ TABLE itab WITH KEY field = val', targetConstruct: 'itab.find(r => r.field === val)',                          notes: '' },
		{ sourceConstruct: 'APPEND wa TO itab',                    targetConstruct: 'itab.push(wa)',                                            notes: '' },
		{ sourceConstruct: 'CLEAR wa / REFRESH itab',             targetConstruct: 'wa = {}; / itab = [];',                                    notes: '' },
		{ sourceConstruct: 'CONCATENATE a b INTO c SEPARATED BY sep', targetConstruct: 'const c = [a, b].join(sep)',                          notes: '' },
		{ sourceConstruct: 'SPLIT str AT sep INTO TABLE itab',     targetConstruct: 'const itab = str.split(sep)',                             notes: '' },
		{ sourceConstruct: 'IF sy-subrc = 0',                      targetConstruct: 'if (result !== null && result !== undefined)',              notes: 'ABAP return code → check result/exception' },
		{ sourceConstruct: 'RAISE EXCEPTION TYPE cx_...',          targetConstruct: 'throw new BadRequestException(...)',                       notes: 'Map cx_* exception classes to NestJS HTTP exceptions' },
		{ sourceConstruct: 'TRY. ... CATCH cx_... INTO lx. ENDTRY.', targetConstruct: 'try { ... } catch (e) { ... }',                        notes: '' },
		{ sourceConstruct: 'MESSAGE ... TYPE ... NUMBER ...',      targetConstruct: 'throw new RpcException({}) / logger.warn()',              notes: 'Raise rule-interpretation decision about error propagation strategy' },
		{ sourceConstruct: 'CALL FUNCTION ... EXPORTING ... IMPORTING ...', targetConstruct: 'await service.methodName(params)',               notes: '' },
		{ sourceConstruct: 'PERFORM routine IN PROGRAM',           targetConstruct: 'await service.routine()',                                  notes: 'Raise naming decision if cross-program call' },
		{ sourceConstruct: 'WRITE: / text, field',                 targetConstruct: 'return { text, field }  // REST response',                notes: '' },
	],

	conventionNotes: [
		'Map each transparent table to a TypeORM `@Entity()` class',
		'Map ABAP programs to NestJS modules: one controller + one service per functional area',
		'Use `@InjectRepository(Entity)` for all DB access',
		'Use `ConfigService` for SAP system parameters (client, language, etc.)',
		'Replace ALV reports with REST endpoints returning JSON arrays',
		'Use `@ApiProperty()` decorators for all DTO fields (Swagger/OpenAPI)',
		'Use `class-validator` for input validation replacing selection screen checks',
	],

	warningPatterns: [
		'BAPI calls — raise rule-interpretation decision: REST call to SAP, or replicated in Node?',
		'BADI / enhancement spots — raise rule-interpretation decision',
		'Dynamic SELECT (field list from variable) — raise rule-interpretation decision',
		'ABAP spool / print lists — raise naming decision about target reporting layer',
		'Authorization checks (AUTHORITY-CHECK) — raise rule-interpretation decision about ACL/RBAC strategy',
		'Numeric data types: CURR, QUAN with units — raise type-mapping decision (Decimal128 / string?)',
	],
};


// ─── COBOL → Go ───────────────────────────────────────────────────────────────

const COBOL_TO_GO: ILanguagePairProfile = {
	sourceLang: 'cobol',
	targetLang: 'go',
	label: 'COBOL → Go (high-throughput services)',
	targetFramework: 'Go 1.22 + standard library',
	targetTestFramework: 'testing (go test)',
	targetFileExtension: 'go',

	systemPersona: `You are an expert migrating COBOL batch programs and CICS transactions to idiomatic Go. You understand COBOL data division (PIC clauses, COMP, COMP-3, OCCURS, REDEFINES), the PROCEDURE DIVISION paragraph structure, PERFORM, GO TO, nested IF/EVALUATE, file I/O (QSAM, VSAM), and CICS commands. You produce Go that is concise, concurrent where applicable, and uses standard library idioms including error-as-value and struct-based data modelling.`,

	idiomMap: [
		{ sourceConstruct: 'IDENTIFICATION DIVISION / PROGRAM-ID',  targetConstruct: '`package main` + func main()  OR  package named after program', notes: '' },
		{ sourceConstruct: 'PIC X(n) DISPLAY',                     targetConstruct: 'string  (max length n — document in comment)',                  notes: '' },
		{ sourceConstruct: 'PIC 9(n)',                              targetConstruct: 'int32 / int64 (choose based on n)',                              notes: '' },
		{ sourceConstruct: 'PIC 9(n)V9(d) / PIC S9(n)V9(d)',      targetConstruct: 'float64  // or decimal.Decimal for currency',                   notes: 'Raise type-mapping decision for monetary fields' },
		{ sourceConstruct: 'PIC S9(n) COMP-3 (packed decimal)',    targetConstruct: 'int64 / decimal.Decimal',                                        notes: 'Raise type-mapping decision' },
		{ sourceConstruct: '01 WS-RECORD PIC ... (flat record)',   targetConstruct: 'type WSRecord struct { ... }',                                   notes: '' },
		{ sourceConstruct: 'OCCURS n TIMES',                        targetConstruct: '[n]T  or  []T (slice for dynamic)',                             notes: '' },
		{ sourceConstruct: 'REDEFINES',                             targetConstruct: '// union via encoding/binary or unsafe.Pointer — raise decision', notes: 'Raise rule-interpretation decision' },
		{ sourceConstruct: 'MOVE a TO b',                          targetConstruct: 'b = a',                                                          notes: '' },
		{ sourceConstruct: 'MOVE SPACES TO ws-field',              targetConstruct: 'wsField = ""  // or strings.Repeat(" ", n)',                     notes: '' },
		{ sourceConstruct: 'MOVE ZEROS TO ws-field',               targetConstruct: 'wsField = 0',                                                   notes: '' },
		{ sourceConstruct: 'ADD a TO b',                           targetConstruct: 'b += a',                                                         notes: '' },
		{ sourceConstruct: 'SUBTRACT a FROM b',                    targetConstruct: 'b -= a',                                                         notes: '' },
		{ sourceConstruct: 'MULTIPLY a BY b GIVING c',             targetConstruct: 'c = a * b',                                                      notes: '' },
		{ sourceConstruct: 'DIVIDE a INTO b GIVING c REMAINDER d', targetConstruct: 'c = b / a; d = b % a',                                          notes: '' },
		{ sourceConstruct: 'COMPUTE expr',                         targetConstruct: 'result = expr  (Go arithmetic)',                                 notes: '' },
		{ sourceConstruct: 'PERFORM paragraph-name',               targetConstruct: 'paragraphName()',                                                 notes: '' },
		{ sourceConstruct: 'PERFORM UNTIL condition',              targetConstruct: 'for !condition { }',                                             notes: '' },
		{ sourceConstruct: 'PERFORM n TIMES',                      targetConstruct: 'for i := 0; i < n; i++ { }',                                    notes: '' },
		{ sourceConstruct: 'IF ... ELSE ... END-IF',               targetConstruct: 'if ... { } else { }',                                           notes: '' },
		{ sourceConstruct: 'EVALUATE TRUE WHEN ... WHEN OTHER',    targetConstruct: 'switch { case ...: default: }',                                 notes: '' },
		{ sourceConstruct: 'STOP RUN',                             targetConstruct: 'return  // or os.Exit(0) in main()',                             notes: '' },
		{ sourceConstruct: 'OPEN INPUT fd / OPEN OUTPUT fd',       targetConstruct: 'f, err := os.Open(path) / os.Create(path)',                     notes: '' },
		{ sourceConstruct: 'READ fd INTO ws-record',               targetConstruct: 'scanner.Scan() + decode record',                                notes: '' },
		{ sourceConstruct: 'WRITE record FROM ws-record',          targetConstruct: 'fmt.Fprintf(f, format, fields...)',                             notes: '' },
		{ sourceConstruct: 'CLOSE fd',                             targetConstruct: 'defer f.Close()',                                                notes: '' },
		{ sourceConstruct: 'CALL "progname" USING ...',            targetConstruct: 'result = progname(args...)  // raise naming decision',          notes: '' },
		{ sourceConstruct: 'ON SIZE ERROR ...',                     targetConstruct: 'if err != nil { return err }  // overflow check',               notes: '' },
	],

	conventionNotes: [
		'One Go file per COBOL program; package name = program identifier lowercased',
		'Each COBOL paragraph becomes a Go function',
		'Use `errors.New()` and `fmt.Errorf()` for error propagation (not panics)',
		'Monetary amounts: use `github.com/shopspring/decimal` or `int64` cents — decide via type-mapping decision',
		'Use `encoding/binary` for packed decimal (COMP-3) field parsing in file I/O',
		'WORKING-STORAGE → struct fields; LINKAGE SECTION → function parameters/return values',
		'Use `sync.WaitGroup` and goroutines when parallelising COBOL batch loops',
		'Write table-driven tests with `testing.T` for each paragraph',
	],

	warningPatterns: [
		'REDEFINES — raise rule-interpretation decision: use separate types, or unsafe union?',
		'GO TO — raise rule-interpretation decision: refactor to structured loop/function?',
		'COPY member with local overrides — raise naming decision about struct embedding',
		'CICS EXEC commands — raise rule-interpretation decision: REST/gRPC or MQ replacement?',
		'Packed decimal (COMP-3) monetary fields — raise type-mapping decision',
		'ALTER statement (modifying PERFORM targets at runtime) — raise rule-interpretation decision',
	],
};


// ─── PL/SQL → Python ──────────────────────────────────────────────────────────

const PLSQL_TO_PYTHON: ILanguagePairProfile = {
	sourceLang: 'plsql',
	targetLang: 'python',
	label: 'PL/SQL (Oracle) → Python (SQLAlchemy + asyncpg)',
	targetFramework: 'Python 3.11+ with SQLAlchemy 2.x + FastAPI',
	targetTestFramework: 'pytest',
	targetFileExtension: 'py',

	systemPersona: `You are an expert migrating Oracle PL/SQL stored procedures, packages, and triggers to Python using SQLAlchemy Core/ORM and asyncpg. You understand PL/SQL CURSOR logic, bulk collect, FORALL, exception blocks, package state, UTL_FILE, DBMS_SCHEDULER, and Oracle-specific SQL extensions. You produce async Python with proper SQLAlchemy 2.x patterns, parameterised queries, and Alembic-compatible models.`,

	idiomMap: [
		{ sourceConstruct: 'CREATE OR REPLACE PROCEDURE name(p1 IN t, p2 OUT t)', targetConstruct: 'async def name(p1: T) -> T:',                notes: 'OUT params become return values' },
		{ sourceConstruct: 'CREATE OR REPLACE FUNCTION name RETURN type',          targetConstruct: 'async def name(...) -> ReturnType:',        notes: '' },
		{ sourceConstruct: 'DECLARE ... BEGIN ... EXCEPTION ... END',              targetConstruct: 'try: ... except Exception as e: ...',        notes: '' },
		{ sourceConstruct: 'CURSOR c IS SELECT ...',                               targetConstruct: 'stmt = select(...)',                         notes: '' },
		{ sourceConstruct: 'OPEN c; FETCH c INTO ...; CLOSE c',                   targetConstruct: 'async for row in conn.execute(stmt):',       notes: '' },
		{ sourceConstruct: 'FOR rec IN (SELECT ...) LOOP',                        targetConstruct: 'async for rec in conn.execute(select(...)): ', notes: '' },
		{ sourceConstruct: 'BULK COLLECT INTO collection LIMIT n',                targetConstruct: 'result.fetchmany(n)',                         notes: '' },
		{ sourceConstruct: 'FORALL i IN ... INSERT/UPDATE/DELETE',                targetConstruct: 'await conn.execute(stmt, [params_list])',     notes: 'Batch execute via executemany' },
		{ sourceConstruct: 'EXCEPTION WHEN NO_DATA_FOUND THEN',                   targetConstruct: 'if result is None: raise HTTPException(404)', notes: '' },
		{ sourceConstruct: 'EXCEPTION WHEN DUP_VAL_ON_INDEX THEN',                targetConstruct: 'except IntegrityError as e:',                 notes: '' },
		{ sourceConstruct: 'RAISE_APPLICATION_ERROR(-20001, msg)',                 targetConstruct: 'raise HTTPException(status_code=400, detail=msg)', notes: '' },
		{ sourceConstruct: 'DBMS_OUTPUT.PUT_LINE(msg)',                            targetConstruct: 'logger.debug(msg)',                           notes: '' },
		{ sourceConstruct: 'UTL_FILE.FOPEN / PUT_LINE / FCLOSE',                  targetConstruct: 'async with aiofiles.open(...) as f: await f.write(...)', notes: '' },
		{ sourceConstruct: 'NVL(expr, default)',                                   targetConstruct: 'expr if expr is not None else default',       notes: '' },
		{ sourceConstruct: 'DECODE(expr, v1, r1, v2, r2, default)',               targetConstruct: '{v1: r1, v2: r2}.get(expr, default)',         notes: '' },
		{ sourceConstruct: 'TO_DATE(str, fmt)',                                    targetConstruct: 'datetime.strptime(str, fmt)',                  notes: '' },
		{ sourceConstruct: 'TO_CHAR(date, fmt)',                                   targetConstruct: 'date.strftime(fmt)',                          notes: '' },
		{ sourceConstruct: 'SYSDATE',                                              targetConstruct: 'datetime.now(timezone.utc)',                  notes: '' },
		{ sourceConstruct: 'TRUNC(date)',                                           targetConstruct: 'date.replace(hour=0, minute=0, second=0, microsecond=0)', notes: '' },
		{ sourceConstruct: 'NUMBER(p, s)',                                         targetConstruct: 'Decimal  // from decimal import Decimal',     notes: '' },
		{ sourceConstruct: 'VARCHAR2(n)',                                          targetConstruct: 'str  (max n chars — annotate with comment)',  notes: '' },
		{ sourceConstruct: 'COMMIT',                                               targetConstruct: 'await session.commit()',                       notes: '' },
		{ sourceConstruct: 'ROLLBACK',                                             targetConstruct: 'await session.rollback()',                     notes: '' },
	],

	conventionNotes: [
		'Use SQLAlchemy 2.x Core (text() / select()) for complex SQL; ORM for CRUD',
		'Use `async def` and `await` for all DB calls via asyncpg engine',
		'Each PL/SQL package → Python module; package globals → module-level state or FastAPI dependency',
		'Use `Annotated` + FastAPI `Depends()` to inject `AsyncSession`',
		'Use Alembic for schema migrations corresponding to DDL in packages',
		'All monetary fields: `Decimal` from Python `decimal` module, not `float`',
		'Use `structlog` or standard `logging` instead of DBMS_OUTPUT',
	],

	warningPatterns: [
		'Package-level variables (stateful sessions) — raise rule-interpretation decision about session scope',
		'Autonomous transactions (PRAGMA AUTONOMOUS_TRANSACTION) — raise rule-interpretation decision',
		'Dynamic SQL (EXECUTE IMMEDIATE) — raise rule-interpretation decision: parameterise or ORM?',
		'Oracle-specific SQL (CONNECT BY, ROWNUM, MERGE) — raise naming decision',
		'Database triggers — raise rule-interpretation decision: keep trigger or move to application layer?',
		'UTL_HTTP / UTL_SMTP — raise naming decision about Python HTTP/email library',
	],
};


// ─── Natural → Python ─────────────────────────────────────────────────────────

const NATURAL_TO_PYTHON: ILanguagePairProfile = {
	sourceLang: 'natural',
	targetLang: 'python',
	label: 'NATURAL (Software AG) → Python (FastAPI + SQLAlchemy)',
	targetFramework: 'Python 3.11+ with FastAPI + SQLAlchemy',
	targetTestFramework: 'pytest',
	targetFileExtension: 'py',

	systemPersona: `You are an expert migrating Software AG NATURAL programs (on ADABAS or SQL databases) to Python FastAPI services. You understand NATURAL data areas (LDA, PDA, GDA), FIND/READ/HISTOGRAM statements against ADABAS, CALLNAT, FETCH, DEFINE SUBROUTINE, INPUT/WRITE maps, and NATURAL security. You produce idiomatic async Python with proper SQLAlchemy models when migrating off ADABAS, or direct SQL via asyncpg when keeping the database.`,

	idiomMap: [
		{ sourceConstruct: 'DEFINE DATA LOCAL / GLOBAL',          targetConstruct: 'local variables / FastAPI `Depends()` injected state',        notes: '' },
		{ sourceConstruct: 'DEFINE DATA PARAMETER',               targetConstruct: 'function parameters',                                          notes: '' },
		{ sourceConstruct: 'FIND file WITH criteria',             targetConstruct: 'await session.execute(select(Model).where(...))',               notes: '' },
		{ sourceConstruct: 'READ file BY ISN/BY value',           targetConstruct: 'await session.get(Model, pk)  /  .execute(select(...))',       notes: '' },
		{ sourceConstruct: 'STORE file',                          targetConstruct: 'session.add(entity); await session.commit()',                   notes: '' },
		{ sourceConstruct: 'UPDATE file',                         targetConstruct: 'await session.execute(update(Model).where(...))',               notes: '' },
		{ sourceConstruct: 'DELETE file',                         targetConstruct: 'await session.execute(delete(Model).where(...))',               notes: '' },
		{ sourceConstruct: 'AT END OF FILE',                      targetConstruct: '# after async for loop ends naturally',                        notes: '' },
		{ sourceConstruct: 'ESCAPE BOTTOM',                       targetConstruct: 'break',                                                         notes: '' },
		{ sourceConstruct: 'CALLNAT "subprogram" pda',            targetConstruct: 'await subprogram_service.method(params)',                      notes: '' },
		{ sourceConstruct: 'FETCH "program"',                     targetConstruct: '# redirect / subroutine call — raise naming decision',         notes: '' },
		{ sourceConstruct: 'DEFINE SUBROUTINE name',              targetConstruct: 'async def name(params):',                                      notes: '' },
		{ sourceConstruct: 'PERFORM subroutine',                  targetConstruct: 'await subroutine(params)',                                     notes: '' },
		{ sourceConstruct: 'IF field = value',                    targetConstruct: 'if field == value:',                                           notes: '' },
		{ sourceConstruct: 'DECIDE ON FIRST VALUE OF x',         targetConstruct: 'match x:  (Python 3.10+)',                                     notes: '' },
		{ sourceConstruct: 'FOR i := 1 TO n',                    targetConstruct: 'for i in range(1, n + 1):',                                    notes: '' },
		{ sourceConstruct: 'WRITE / INPUT statement (TUI map)',   targetConstruct: '// UI concern — raise naming decision for REST/web target',    notes: '' },
		{ sourceConstruct: 'ON ERROR DO / ESCAPE ROUTINE',        targetConstruct: 'try: ... except Exception as e: ...',                         notes: '' },
	],

	conventionNotes: [
		'Map ADABAS file definitions to SQLAlchemy ORM models + Alembic migrations',
		'NATURAL LDA/PDA data areas map to Python dataclasses or Pydantic models',
		'Use FastAPI `APIRouter` per NATURAL library/module',
		'Use async SQLAlchemy with asyncpg driver for all database operations',
		'Replace INPUT/WRITE maps with FastAPI endpoints returning JSON',
		'Preserve NATURAL error numbers as HTTP status codes where semantically appropriate',
	],

	warningPatterns: [
		'ADABAS MU/PE fields (multi-value / periodic groups) — raise type-mapping decision (JSON array vs. child table)',
		'Predict/predict file — raise rule-interpretation decision about target schema',
		'CALLNAT with variable program name — raise rule-interpretation decision',
		'NATURAL security / entitlements — raise rule-interpretation decision about RBAC replacement',
		'HISTOGRAM statement (ADABAS index scan) — raise naming decision about query strategy',
	],
};


// ─── MUMPS / M → Python ───────────────────────────────────────────────────────

const MUMPS_TO_PYTHON: ILanguagePairProfile = {
	sourceLang: 'mumps',
	targetLang: 'python',
	label: 'MUMPS / M (Healthcare) → Python (FastAPI + FHIR)',
	targetFramework: 'Python 3.11+ with FastAPI + FHIR R4 (fhir.resources)',
	targetTestFramework: 'pytest',
	targetFileExtension: 'py',

	systemPersona: `You are an expert migrating MUMPS (M) code — including VistA/CPRS clinical modules — to Python. You understand MUMPS globals (^GLOBAL), naked references, XECUTE, implicit string/number coercion, indirection, subscript levels, MUMPS string functions ($EXTRACT, $PIECE, $FIND, $ORDER), and FILEMAN data dictionary structures. You produce idiomatic Python that maps MUMPS globals to FHIR R4 resources or relational models, and MUMPS string operations to Python string methods.`,

	idiomMap: [
		{ sourceConstruct: '^GLOBAL(subscript)',                   targetConstruct: 'fhir_resource.attribute  / db.query(Entity)',               notes: 'Raise naming decision about data model target' },
		{ sourceConstruct: 'S var=expr',                           targetConstruct: 'var = expr',                                                 notes: '' },
		{ sourceConstruct: 'K var  (KILL)',                        targetConstruct: 'del var  /  var = None',                                    notes: '' },
		{ sourceConstruct: 'D routine^namespace (DO)',             targetConstruct: 'routine_module.namespace()',                                 notes: '' },
		{ sourceConstruct: 'Q value  (QUIT)',                      targetConstruct: 'return value',                                               notes: '' },
		{ sourceConstruct: 'W string  (WRITE)',                    targetConstruct: 'return {"message": string}  /  logger.info(string)',         notes: '' },
		{ sourceConstruct: 'I cond  (IF)',                         targetConstruct: 'if cond:',                                                   notes: '' },
		{ sourceConstruct: 'F i=1:1:n  (FOR)',                    targetConstruct: 'for i in range(1, n+1):',                                   notes: '' },
		{ sourceConstruct: '$ORDER(^GLOBAL(sub))',                 targetConstruct: 'next(iter(sorted(global_dict.keys())))',                    notes: '' },
		{ sourceConstruct: '$PIECE(str,delim,pos)',                targetConstruct: 'str.split(delim)[pos-1]  // 1-based',                      notes: '' },
		{ sourceConstruct: '$EXTRACT(str,start,end)',              targetConstruct: 'str[start-1:end]',                                          notes: '1-based → 0-based' },
		{ sourceConstruct: '$LENGTH(str)',                         targetConstruct: 'len(str)',                                                   notes: '' },
		{ sourceConstruct: '$FIND(str,target)',                    targetConstruct: 'str.find(target) + len(target) + 1  // returns end+1',     notes: '' },
		{ sourceConstruct: 'XECUTE string',                        targetConstruct: '// Avoid exec(); raise rule-interpretation decision',       notes: 'Security risk — raise decision' },
		{ sourceConstruct: 'FILEMAN file^field access',            targetConstruct: 'FHIR resource attribute / ORM model field',                notes: 'Raise naming decision for each FILEMAN field mapping' },
		{ sourceConstruct: 'HL7 v2 message parsing',              targetConstruct: 'python-hl7 library or hl7apy',                              notes: '' },
	],

	conventionNotes: [
		'Map MUMPS globals to FHIR R4 resources (Patient, Encounter, Observation, etc.) where applicable',
		'Use `fhir.resources` Python library for FHIR R4 model classes',
		'FILEMAN file numbers → FHIR resource types (raise naming decision per file)',
		'Replace implicit type coercion with explicit `str()`, `int()`, `float()` conversions',
		'MUMPS namespaces → Python modules; routine names → function names',
		'Use HL7 FHIR REST API (`/Patient`, `/Observation`) for all data exchange',
	],

	warningPatterns: [
		'XECUTE with constructed strings — raise rule-interpretation decision (security: use safe dispatch table)',
		'Naked references (^(subscript) without full global name) — raise rule-interpretation decision',
		'MUMPS indirection (@variable) — raise rule-interpretation decision',
		'Global subscript-level schema (raise naming decision: normalize to relational or document model?)',
		'Patient privacy / PHI fields — raise approval decision: HIPAA data handling confirmed?',
		'VistA RPCs (Remote Procedure Calls) — raise naming decision about REST equivalent',
	],
};


// ─── Ada → C++ ────────────────────────────────────────────────────────────────

const ADA_TO_CPP: ILanguagePairProfile = {
	sourceLang: 'ada',
	targetLang: 'cpp',
	label: 'Ada → C++ (safety-critical systems)',
	targetFramework: 'C++17 / C++20 with CMake',
	targetTestFramework: 'Google Test (gtest)',
	targetFileExtension: 'cpp',

	systemPersona: 'You are an expert migrating Ada 83/95/2005/2012 code to modern C++17/20, particularly for safety-critical and defense/aerospace systems. You understand Ada packages, generics, protected types, tasks (concurrency), discriminant records, tagged types (OOP), Ada contracts (Pre/Post conditions), and SPARK annotations. You produce C++ that is semantically equivalent with explicit attention to undefined behaviour avoidance, using std::mutex for protected types, std::thread/std::async for tasks, and static_assert/[[nodiscard]] for contracts.',

	idiomMap: [
		{ sourceConstruct: 'package Foo is ... end Foo',          targetConstruct: 'namespace Foo { ... }  /  class Foo { ... }',                notes: '' },
		{ sourceConstruct: 'package body Foo is ... end Foo',     targetConstruct: 'Foo.cpp implementation file',                                notes: '' },
		{ sourceConstruct: 'with Foo; use Foo;',                  targetConstruct: '#include "foo.hpp"  using namespace Foo;',                   notes: '' },
		{ sourceConstruct: 'subtype T is BaseT range A..B',       targetConstruct: 'T with range-checked wrapper or `[[clang::annotate]]`',     notes: 'Raise type-mapping decision: runtime check or static assertion?' },
		{ sourceConstruct: 'type T is record ... end record',     targetConstruct: 'struct T { ... };',                                          notes: '' },
		{ sourceConstruct: 'type T is tagged record ... end record', targetConstruct: 'class T { ... }; (inheritance)',                         notes: '' },
		{ sourceConstruct: 'type T is array (...) of E',          targetConstruct: 'std::array<E, N>  /  std::vector<E>',                       notes: '' },
		{ sourceConstruct: 'procedure P(x: in T; y: out T)',       targetConstruct: 'void p(const T& x, T& y)',                                 notes: '' },
		{ sourceConstruct: 'function F(x: T) return R',           targetConstruct: 'R f(const T& x)',                                           notes: '' },
		{ sourceConstruct: 'protected type PT is ... end PT',      targetConstruct: 'struct PT { std::mutex m; ... };  + lock guards',          notes: '' },
		{ sourceConstruct: 'task T is ... end T',                  targetConstruct: 'std::thread / std::async',                                  notes: 'Raise rule-interpretation decision about threading model' },
		{ sourceConstruct: 'generic package / procedure',          targetConstruct: 'template<typename T> class / function',                     notes: '' },
		{ sourceConstruct: 'declare begin ... end',                targetConstruct: '{ ... }  (local scope block)',                              notes: '' },
		{ sourceConstruct: 'raise Constraint_Error',               targetConstruct: 'throw std::out_of_range("...")',                            notes: '' },
		{ sourceConstruct: 'exception: when Constraint_Error =>',  targetConstruct: 'catch (const std::out_of_range& e)',                       notes: '' },
		{ sourceConstruct: 'Ada.Text_IO.Put_Line',                 targetConstruct: 'std::cout << ... << std::endl',                            notes: '' },
		{ sourceConstruct: 'Ada.Numerics.Float_Random',            targetConstruct: 'std::mt19937 / std::uniform_real_distribution',             notes: '' },
		{ sourceConstruct: 'Pre => cond, Post => cond (SPARK)',    targetConstruct: 'assert(cond);  /  [[expects: cond]] (C++20)',              notes: '' },
	],

	conventionNotes: [
		'Use `[[nodiscard]]` for functions corresponding to Ada functions (non-procedure)',
		'Use `std::optional<T>` for Ada discriminant records with optional fields',
		'Use `std::variant<T1, T2>` for Ada variant records',
		'Enable `-Wall -Wextra -Wpedantic -fsanitize=address,undefined` in CMakeLists',
		'Use `std::mutex` + `std::lock_guard` for all Ada protected type operations',
		'Replace Ada range subtypes with C++ range-checking wrappers or `gsl::Expects`',
		'Use CMake `add_executable` + GoogleTest `target_link_libraries` for test builds',
	],

	warningPatterns: [
		'Ada tasks with rendezvous (accept/select) — raise rule-interpretation decision: std::future or message queue?',
		'SPARK annotations (proof obligations) — raise approval decision: are proofs to be maintained in C++?',
		'Ada controlled types (finalization hooks) — raise rule-interpretation decision: RAII class?',
		'Unchecked_Conversion — raise rule-interpretation decision: reinterpret_cast is UB risk',
		'Ada 83 generics with complex instantiation — raise naming decision',
		'Safety integrity level (SIL/DAL) — raise approval decision: has DO-178C/IEC 61508 re-qualification been scoped?',
	],
};


// ─── Fortran → C++ ────────────────────────────────────────────────────────────

const FORTRAN_TO_CPP: ILanguagePairProfile = {
	sourceLang: 'fortran',
	targetLang: 'cpp',
	label: 'Fortran → C++ (scientific / HPC)',
	targetFramework: 'C++17 with Eigen / OpenMP / MPI',
	targetTestFramework: 'Google Test (gtest)',
	targetFileExtension: 'cpp',

	systemPersona: `You are an expert migrating Fortran 77/90/95/2003/2008 scientific and HPC programs to modern C++17 using Eigen (for linear algebra), OpenMP (for parallelism), and optional MPI (for distributed memory). You understand Fortran array semantics (column-major, 1-based indexing), COMMON blocks, EQUIVALENCE, IMPLICIT NONE, DO loops, INTERFACE blocks, and BLAS/LAPACK calls. You produce C++ that is semantically equivalent, numerically correct, and leverages RAII.`,

	idiomMap: [
		{ sourceConstruct: 'REAL*8 / DOUBLE PRECISION',            targetConstruct: 'double',                                                     notes: '' },
		{ sourceConstruct: 'REAL (single precision)',               targetConstruct: 'float',                                                      notes: '' },
		{ sourceConstruct: 'INTEGER',                              targetConstruct: 'int  /  int64_t',                                             notes: '' },
		{ sourceConstruct: 'COMPLEX*16',                           targetConstruct: 'std::complex<double>',                                        notes: '' },
		{ sourceConstruct: 'DIMENSION A(10)',                      targetConstruct: 'std::array<double, 10> A;  // 0-based indexing',             notes: '1-based → 0-based; document shift' },
		{ sourceConstruct: 'DIMENSION A(M, N) column-major',       targetConstruct: 'Eigen::MatrixXd A(M, N);  // ColMajor by default',          notes: 'Eigen is column-major matching Fortran' },
		{ sourceConstruct: 'DO I = 1, N ... END DO',               targetConstruct: 'for (int i = 1; i <= n; ++i)',                              notes: '' },
		{ sourceConstruct: '!$OMP PARALLEL DO',                   targetConstruct: '#pragma omp parallel for',                                   notes: '' },
		{ sourceConstruct: 'COMMON /NAME/ var1, var2',             targetConstruct: 'namespace NAME { double var1, var2; }  // or singleton',    notes: 'Raise naming decision about global state scope' },
		{ sourceConstruct: 'SUBROUTINE name(a, b)',                targetConstruct: 'void name(double& a, double& b)',                            notes: '' },
		{ sourceConstruct: 'FUNCTION name(a) RESULT(r)',           targetConstruct: 'double name(double a) { ... return r; }',                   notes: '' },
		{ sourceConstruct: 'CALL DGEMM(...) [BLAS]',              targetConstruct: 'A = B * C;  // Eigen operator* (calls BLAS internally)',     notes: '' },
		{ sourceConstruct: 'CALL DGESV(...) [LAPACK]',             targetConstruct: 'x = A.colPivHouseholderQr().solve(b)',                      notes: '' },
		{ sourceConstruct: 'WRITE(*,*) var',                       targetConstruct: 'std::cout << var << std::endl;',                            notes: '' },
		{ sourceConstruct: 'READ(*,*) var',                        targetConstruct: 'std::cin >> var;',                                          notes: '' },
		{ sourceConstruct: 'IF (cond) GOTO label',                 targetConstruct: '// refactor to if/break/continue — raise decision',         notes: '' },
	],

	conventionNotes: [
		'Use `Eigen::MatrixXd` for 2D arrays; `Eigen::VectorXd` for 1D — column-major matches Fortran',
		'Use `std::vector<double>` for dynamically-sized 1D arrays',
		'Use `#pragma omp parallel for` to replace `!$OMP PARALLEL DO` directives',
		'COMMON blocks → anonymous namespace with `static` variables or singletons',
		'EQUIVALENCE → `union` (raise rule-interpretation decision about aliasing)',
		'Enable `-O3 -march=native -fopenmp` in CMakeLists for HPC performance',
		'Use `const` and `noexcept` on pure compute functions',
	],

	warningPatterns: [
		'EQUIVALENCE — raise rule-interpretation decision: union or reinterpret_cast?',
		'GOTO — raise rule-interpretation decision: refactor to structured flow',
		'ENTRY statement — raise rule-interpretation decision: split into separate functions?',
		'Assumed-shape arrays in Fortran 90 — ensure correct Eigen dimensions',
		'MPI calls — raise naming decision about MPI wrapper strategy (mpi.h vs. Boost.MPI)',
		'Precision-critical accumulation (REAL*16 quad) — raise type-mapping decision: `long double` or `__float128`?',
	],
};


// ─── ColdFusion → TypeScript ──────────────────────────────────────────────────

const COLDFUSION_TO_TYPESCRIPT: ILanguagePairProfile = {
	sourceLang: 'coldfusion',
	targetLang: 'typescript',
	label: 'ColdFusion (CFML) → TypeScript (Node.js + Express/NestJS)',
	targetFramework: 'Node.js + NestJS + TypeORM',
	targetTestFramework: 'Jest',
	targetFileExtension: 'ts',

	systemPersona: `You are an expert migrating ColdFusion (CFML) applications to TypeScript/NestJS. You understand CFML tags (CFQUERY, CFLOOP, CFIF, CFINCLUDE, CFCOMPONENT, CFFUNCTION), ColdFusion components (CFCs), Application.cfc lifecycle hooks, session/application scopes, CF ORM, and CF scheduler. You produce idiomatic TypeScript with NestJS decorators, TypeORM entities, and proper async/await patterns.`,

	idiomMap: [
		{ sourceConstruct: '<cfcomponent>',                        targetConstruct: '@Injectable() class  /  @Controller()',                     notes: '' },
		{ sourceConstruct: '<cffunction name="f" access="remote">', targetConstruct: '@Get("f") async f(): Promise<T>',                         notes: '' },
		{ sourceConstruct: '<cffunction access="public">',         targetConstruct: 'async f(): Promise<T>  // service method',                  notes: '' },
		{ sourceConstruct: '<cfargument name="x" type="string">',  targetConstruct: '(@Body() / @Param() x: string)',                           notes: '' },
		{ sourceConstruct: '<cfquery name="q" datasource="ds">',   targetConstruct: 'await this.repo.find(...)  /  await conn.execute(sql)',     notes: '' },
		{ sourceConstruct: '<cfloop query="q">',                   targetConstruct: 'for (const row of rows)',                                   notes: '' },
		{ sourceConstruct: '<cfloop from="1" to="n">',             targetConstruct: 'for (let i = 1; i <= n; i++)',                             notes: '' },
		{ sourceConstruct: '<cfif condition>',                     targetConstruct: 'if (condition)',                                             notes: '' },
		{ sourceConstruct: '<cfswitch expression="x">',            targetConstruct: 'switch (x)',                                                notes: '' },
		{ sourceConstruct: '<cfinclude template="page.cfm">',      targetConstruct: "import { ... } from './page'",                             notes: 'Raise naming decision about module boundary' },
		{ sourceConstruct: '<cftry><cfcatch type="any">',          targetConstruct: 'try { } catch (e)',                                         notes: '' },
		{ sourceConstruct: '<cfthrow message="...">',              targetConstruct: 'throw new BadRequestException("...")',                       notes: '' },
		{ sourceConstruct: 'SESSION.userId',                       targetConstruct: 'req.session.userId  /  JWT claim userId',                   notes: 'Raise naming decision about session strategy (cookie vs JWT)' },
		{ sourceConstruct: 'APPLICATION.config',                   targetConstruct: 'ConfigService.get("config")',                               notes: '' },
		{ sourceConstruct: 'REQUEST scope',                        targetConstruct: 'local function variables',                                  notes: '' },
		{ sourceConstruct: 'ArrayNew(1)',                          targetConstruct: '[]',                                                         notes: '' },
		{ sourceConstruct: 'StructNew()',                          targetConstruct: '{}',                                                         notes: '' },
		{ sourceConstruct: 'ListToArray(str, delim)',              targetConstruct: 'str.split(delim)',                                           notes: '' },
		{ sourceConstruct: 'Len(str)',                             targetConstruct: 'str.length',                                                 notes: '' },
		{ sourceConstruct: 'UCase(str) / LCase(str)',             targetConstruct: 'str.toUpperCase() / str.toLowerCase()',                     notes: '' },
		{ sourceConstruct: 'DateFormat(date, mask)',               targetConstruct: 'format(date, mask)  // date-fns',                          notes: '' },
		{ sourceConstruct: '<cfmail>',                             targetConstruct: 'nodemailer / @nestjs-modules/mailer',                       notes: '' },
	],

	conventionNotes: [
		'One CFC → one NestJS module (controller + service + module file)',
		'Map `datasource` names to TypeORM connection names in ormconfig',
		'Use TypeORM `@Entity()` for CF ORM persistent components',
		'Session scope → NestJS session middleware (express-session) or JWT',
		'Application scope → NestJS `ConfigModule` + environment variables',
		'Use `@nestjs/swagger` + `@ApiProperty()` for all DTOs',
		'Replace CF Scheduler tasks with NestJS `@Cron()` decorated methods',
	],

	warningPatterns: [
		'CFQUERY with dynamic SQL — raise rule-interpretation decision: parameterise or QueryBuilder?',
		'Direct table/column names in CFQUERY — raise naming decision about ORM entity mapping',
		'CF Component inheritance (extends) — raise naming decision about class hierarchy',
		'CF custom tags — raise naming decision: NestJS interceptor, decorator, or middleware?',
		'FILE/DIRECTORY operations via CFFILE/CFDIRECTORY — raise naming decision',
		'CF charting/reporting — raise naming decision about target charting library',
	],
};


// ─── PowerBuilder → Java ──────────────────────────────────────────────────────

const POWERBUILDER_TO_JAVA: ILanguagePairProfile = {
	sourceLang: 'powerbuilder',
	targetLang: 'java',
	label: 'PowerBuilder → Java (Spring Boot)',
	targetFramework: 'Java 21 + Spring Boot 3 + JPA/Hibernate',
	targetTestFramework: 'JUnit 5 + Mockito',
	targetFileExtension: 'java',

	systemPersona: `You are an expert migrating PowerBuilder (PB) applications to Java Spring Boot. You understand PowerBuilder DataWindows, DataStores, embedded SQL, PowerScript syntax, window/visual objects, transaction objects, ancestor/descendant inheritance, non-visual user objects (NVOs), and the PowerBuilder event model (Clicked, Constructor, Destructor, etc.). You produce idiomatic Java with Spring Boot services, JPA repositories, and REST controllers.`,

	idiomMap: [
		{ sourceConstruct: 'Non-Visual User Object (NVO)',          targetConstruct: '@Service class',                                            notes: '' },
		{ sourceConstruct: 'Window object',                         targetConstruct: '@RestController  /  @Controller (MVC)',                    notes: 'Raise naming decision: REST API or web UI?' },
		{ sourceConstruct: 'DataWindow / DataStore',                targetConstruct: 'JpaRepository<Entity, Long> + DTO list',                  notes: 'Raise naming decision about query migration strategy' },
		{ sourceConstruct: 'DataWindow SQL (embedded)',             targetConstruct: '@Query (JPQL/native) on Repository interface',             notes: '' },
		{ sourceConstruct: 'Retrieve() / Update()',                targetConstruct: 'repo.findAll() / repo.saveAll(entities)',                   notes: '' },
		{ sourceConstruct: 'Transaction object (SQLCA)',            targetConstruct: '@Transactional annotation',                               notes: '' },
		{ sourceConstruct: 'Transaction.DBHandle (JDBC URL parts)', targetConstruct: 'spring.datasource.url in application.yml',               notes: '' },
		{ sourceConstruct: 'PowerScript event: Constructor',       targetConstruct: '@PostConstruct method / constructor injection',            notes: '' },
		{ sourceConstruct: 'PowerScript event: Destructor',        targetConstruct: '@PreDestroy method',                                       notes: '' },
		{ sourceConstruct: 'object.Post event()',                  targetConstruct: 'applicationEventPublisher.publishEvent(new MyEvent())',    notes: '' },
		{ sourceConstruct: 'Integer / Long in PB',                 targetConstruct: 'int / long (or Integer / Long)',                           notes: 'PB Integer = 16-bit; PB Long = 32-bit' },
		{ sourceConstruct: 'String in PB (null distinct from "")',  targetConstruct: 'String (null-safe; use Optional<String> where nullable)', notes: '' },
		{ sourceConstruct: 'of_GetValue() pattern (getter NVO)',    targetConstruct: 'getter method: getXxx()',                                 notes: '' },
		{ sourceConstruct: 'of_SetValue() pattern (setter NVO)',    targetConstruct: 'setter method: setXxx(T value)',                          notes: '' },
		{ sourceConstruct: 'ancestor.Super::functionname()',        targetConstruct: 'super.functionName()',                                    notes: '' },
		{ sourceConstruct: 'IF ... THEN ... ELSEIF ... END IF',    targetConstruct: 'if ... { } else if ... { } else { }',                    notes: '' },
		{ sourceConstruct: 'CHOOSE CASE x',                        targetConstruct: 'switch (x) { case ...: break; }  /  pattern switch',     notes: '' },
		{ sourceConstruct: 'FOR i = 1 TO n STEP 1',               targetConstruct: 'for (int i = 1; i <= n; i++)',                            notes: '' },
		{ sourceConstruct: 'DO WHILE ... LOOP',                    targetConstruct: 'while (...) { }',                                          notes: '' },
		{ sourceConstruct: 'TRY ... CATCH ... END TRY',            targetConstruct: 'try { } catch (Exception e) { }',                         notes: '' },
		{ sourceConstruct: 'THROW ExceptionObject',                targetConstruct: 'throw new RuntimeException(message)',                     notes: '' },
	],

	conventionNotes: [
		'Each DataWindow SQL → JPQL `@Query` or Criteria API query on a Repository interface',
		'Map PowerScript column/row loops to Java streams: `list.stream().map(...).collect()`',
		'Use `@Transactional` on service methods to replace PB transaction objects',
		'One PowerBuilder NVO → one Spring `@Service` class; use constructor injection for deps',
		'Use `@ControllerAdvice` + `@ExceptionHandler` for PowerBuilder error handling patterns',
		'DataWindow row selection → Specification pattern for complex filtered queries',
	],

	warningPatterns: [
		'DataWindow with dynamic sort/filter (modify calls) — raise rule-interpretation decision',
		'DynamicDescriptionArea / DynamicStagingArea — raise naming decision',
		'Shared Objects (PB shared object pool) — raise rule-interpretation decision: Spring singleton?',
		'Pipeline objects — raise naming decision about Spring Batch equivalent',
		'External function calls (Windows DLLs) — raise rule-interpretation decision',
		'PB DataWindow UpdateWhere property — raise rule-interpretation decision about optimistic locking strategy',
	],
};


// ─── Generic fallback ─────────────────────────────────────────────────────────

const GENERIC_FALLBACK: ILanguagePairProfile = {
	sourceLang: '*',
	targetLang: '*',
	label: 'Generic migration',
	targetFileExtension: 'txt',

	systemPersona: `You are an expert software migration engineer. You translate source code faithfully into the specified target language, preserving all business logic, data transformations, and error handling. You use idiomatic patterns of the target language.`,

	idiomMap: [],

	conventionNotes: [
		'Preserve all business logic exactly',
		'Use idiomatic target language patterns',
		'Replace source-language I/O patterns with target-language equivalents',
		'Ensure all error/exception handling is present in the output',
	],

	warningPatterns: [
		'Any construct with no clear target equivalent — raise a rule-interpretation decision',
		'Any data type with precision/scale requirements — raise a type-mapping decision',
		'Any external call without a visible interface — raise a naming decision',
	],
};


// ─── Registry ─────────────────────────────────────────────────────────────────

/** All registered language pair profiles. Order matters for fallback resolution. */
const PROFILES: ILanguagePairProfile[] = [
	// ── COBOL targets ──────────────────────────────────────────────────────
	COBOL_TO_JAVA,
	COBOL_TO_TYPESCRIPT,
	COBOL_TO_PYTHON,
	COBOL_TO_GO,

	// ── PL/SQL targets ─────────────────────────────────────────────────────
	PLSQL_TO_TYPESCRIPT,
	PLSQL_TO_JAVA,
	PLSQL_TO_PYTHON,

	// ── IBM i / RPG ────────────────────────────────────────────────────────
	RPG_TO_JAVA,

	// ── Java platform ──────────────────────────────────────────────────────
	JAVAEE_TO_SPRINGBOOT,

	// ── Web / UI ───────────────────────────────────────────────────────────
	ANGULARJS_TO_ANGULAR,
	COLDFUSION_TO_TYPESCRIPT,

	// ── Enterprise legacy ──────────────────────────────────────────────────
	PL1_TO_JAVA,
	VB6_TO_CSHARP,
	ABAP_TO_TYPESCRIPT,
	POWERBUILDER_TO_JAVA,

	// ── Low-level ──────────────────────────────────────────────────────────
	ASSEMBLER_TO_C,
	ADA_TO_CPP,
	FORTRAN_TO_CPP,

	// ── Scientific / data ──────────────────────────────────────────────────
	FORTRAN_TO_PYTHON,

	// ── Scripting / 4GL ───────────────────────────────────────────────────
	NATURAL_TO_JAVA,
	NATURAL_TO_PYTHON,

	// ── Healthcare ─────────────────────────────────────────────────────────
	MUMPS_TO_PYTHON,
];

/**
 * Look up the language pair profile for a given source→target pair.
 * Falls back to the generic profile if no specific pair is registered.
 *
 * Both `sourceLang` and `targetLang` are normalised via `canonicaliseLanguage()`
 * before lookup so aliases resolve correctly (e.g. 'cbl' → 'cobol').
 */
export function getLanguagePairProfile(
	sourceLang: string,
	targetLang: string,
): ILanguagePairProfile {
	const src = canonicaliseLanguage(sourceLang);
	const tgt = canonicaliseLanguage(targetLang);

	// Exact match
	const exact = PROFILES.find(p =>
		canonicaliseLanguage(p.sourceLang) === src &&
		canonicaliseLanguage(p.targetLang) === tgt,
	);
	if (exact) { return exact; }

	// Same target, any source → use generic but inherit target conventions from closest match
	const targetMatch = PROFILES.find(p => canonicaliseLanguage(p.targetLang) === tgt);
	if (targetMatch) {
		return {
			...GENERIC_FALLBACK,
			sourceLang: src,
			targetLang: tgt,
			label: `${src.toUpperCase()} → ${tgt.toUpperCase()} (generic)`,
			targetFramework: targetMatch.targetFramework,
			targetTestFramework: targetMatch.targetTestFramework,
			targetFileExtension: targetMatch.targetFileExtension,
			conventionNotes: targetMatch.conventionNotes,
		};
	}

	return { ...GENERIC_FALLBACK, sourceLang: src, targetLang: tgt };
}

/**
 * Returns the file extension for a given target language canonical key.
 * Falls back to the target language key itself.
 */
export function getTargetFileExtension(targetLang: string): string {
	const tgt = canonicaliseLanguage(targetLang);
	const profile = PROFILES.find(p => canonicaliseLanguage(p.targetLang) === tgt);
	return profile?.targetFileExtension ?? tgt;
}

/** List all registered profiles (used for diagnostics / UI display). */
export function listLanguagePairProfiles(): ILanguagePairProfile[] {
	return [...PROFILES];
}
