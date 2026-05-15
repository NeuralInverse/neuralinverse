/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Language Pair Registry
 *
 * Defines migration profiles for every supported source -> target language pair.
 * Each profile provides:
 *
 * - **systemPersona**    -- Expert role the AI should adopt in the system prompt
 * - **idiomMap**         -- Construct-level source->target mappings (20-40 per pair)
 * - **conventionNotes**  -- Target language conventions injected into the user prompt
 * - **warningPatterns**  -- Constructs that require raised decisions or extra care
 * - **targetFramework**  -- Default framework (overridable via ITranslationOptions)
 * - **targetTestFramework** -- Default test framework
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


// --- Profile types ------------------------------------------------------------

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


// --- COBOL -> Java -------------------------------------------------------------

const COBOL_TO_JAVA: ILanguagePairProfile = {
	sourceLang: 'cobol',
	targetLang: 'java',
	label: 'COBOL -> Java (Spring Boot)',
	targetFramework: 'Spring Boot 3',
	targetTestFramework: 'JUnit 5',
	targetFileExtension: 'java',

	systemPersona: `You are a senior software architect with 20 years of experience migrating IBM mainframe COBOL batch programs and CICS transactions to modern Java Spring Boot microservices. You have deep expertise in COBOL data types (COMP-3 packed decimal, USAGE DISPLAY, REDEFINES), COBOL structured programming patterns, and their precise Java equivalents. You understand that monetary arithmetic in COBOL uses fixed-point packed decimal and MUST be mapped to java.math.BigDecimal with explicit scale and RoundingMode -- never double or float. You are meticulous about preserving business logic, rounding rules, and overflow behaviour.`,

	idiomMap: [
		{ sourceConstruct: 'IDENTIFICATION DIVISION. PROGRAM-ID. PROGNAME.',         targetConstruct: '@Service\npublic class ProgName { ... }',                           notes: 'Use @Service for business logic, @Component for utilities' },
		{ sourceConstruct: 'WORKING-STORAGE SECTION. 01 WS-field PIC ...',           targetConstruct: 'private BigDecimal wsField;  // instance field',                   notes: 'Group 01 items become POJOs or flat fields depending on usage' },
		{ sourceConstruct: 'PIC 9(9)V9(2) COMP-3 (packed decimal, 2 decimal)',       targetConstruct: 'BigDecimal (scale=2, RoundingMode.HALF_UP)',                       notes: 'NEVER use double/float for packed decimal monetary fields' },
		{ sourceConstruct: 'PIC 9(N) COMP / COMP-4 (binary integer)',                targetConstruct: 'int (N<=9) or long (N>9)',                                          notes: 'Match sign/unsigned from picture clause' },
		{ sourceConstruct: 'PIC X(N) (alphanumeric)',                                targetConstruct: 'String (use .trim() when reading)',                                 notes: 'COBOL strings are space-padded; always trim when comparing' },
		{ sourceConstruct: 'PIC 9(N) (zoned decimal display)',                       targetConstruct: 'int or long',                                                      notes: 'Zoned decimal is just an integer in display format' },
		{ sourceConstruct: 'MOVE source TO dest',                                    targetConstruct: 'dest = source;',                                                   notes: 'Handle type coercions explicitly (numeric<->string)' },
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
		{ sourceConstruct: 'OCCURS 1 TO N TIMES DEPENDING ON counter',              targetConstruct: 'List<T> field = new ArrayList<>(counter);',                        notes: 'Variable-length table -> ArrayList' },
		{ sourceConstruct: 'GO TO PARA-NAME',                                        targetConstruct: '// Raise decision: GO TO requires structural refactoring',         notes: 'ALWAYS raise a rule-interpretation decision for GO TO' },
		{ sourceConstruct: 'CALL "PROGNAME" USING a b c',                            targetConstruct: 'progName.method(a, b, c);  // see calledInterfaces section',       notes: 'Check calledInterfaces section for exact method signature' },
		{ sourceConstruct: 'STRING a DELIMITED BY SPACE INTO b',                     targetConstruct: 'b = a.trim() + ...;  // use StringBuilder for multi-STRING',       notes: '' },
		{ sourceConstruct: 'UNSTRING source DELIMITED BY "," INTO a b c',            targetConstruct: 'String[] parts = source.split(",", -1);',                          notes: '' },
		{ sourceConstruct: 'INSPECT field REPLACING ALL SPACES BY ZEROES',          targetConstruct: 'field = field.replace(" ", "0");',                                 notes: '' },
		{ sourceConstruct: 'OPEN INPUT file-name / READ file-name / CLOSE',          targetConstruct: 'BufferedReader / InputStream / @Repository injection',             notes: 'File I/O -> repository or stream; raise decision if file layout unclear' },
		{ sourceConstruct: 'SORT sort-file ON ASCENDING KEY sort-key',               targetConstruct: 'list.sort(Comparator.comparing(...));',                             notes: '' },
		{ sourceConstruct: 'ACCEPT identifier FROM DATE',                            targetConstruct: 'LocalDate.now()  or  LocalDate date = LocalDate.now();',           notes: '' },
		{ sourceConstruct: 'DISPLAY "message" identifier',                           targetConstruct: 'log.info("message {}", identifier);  // SLF4J',                   notes: 'Replace DISPLAY with SLF4J logging' },
		{ sourceConstruct: 'INITIALIZE group-item',                                  targetConstruct: 'Set all fields to zero/blank in constructor or init method',       notes: '' },
		{ sourceConstruct: 'STOP RUN',                                               targetConstruct: '// End of method -- return from main entry point',                  notes: 'Multiple STOP RUN = early returns in Java' },
	],

	conventionNotes: [
		'Use `java.math.BigDecimal` for ALL monetary computations -- never `double` or `float`',
		'Annotate business logic classes with `@Service`, repositories with `@Repository`',
		'Constructor-inject all dependencies (`@Autowired` on constructor, not field injection)',
		'Each COBOL paragraph (PROCEDURE DIVISION section) becomes a `private void` method',
		'01-level group items become inner static POJOs or flat fields -- raise decision if ambiguous',
		'Name classes using UpperCamelCase from the COBOL program-id (e.g. CALC-LATE-FEE -> CalcLateFeeService)',
		'Name methods using lowerCamelCase from the paragraph name (e.g. CALC-INTEREST -> calcInterest())',
		'Level-88 condition names become either enums or boolean helper methods',
		'Replace DISPLAY with SLF4J: `private static final Logger log = LoggerFactory.getLogger(...)`',
		'File I/O (OPEN/READ/CLOSE) should use injected Spring repositories or Java NIO streams',
		'Follow Spring Boot 3 / Java 17+ idioms: records for POJOs, switch expressions, sealed classes where appropriate',
	],

	warningPatterns: [
		'REDEFINES -- always raise a type-mapping decision; structural overlay is rarely straightforward',
		'COMP-1 / COMP-2 (floating-point) -- monetary fields using COMP-1/2 may lose precision; raise a rule-interpretation decision',
		'GO TO -- always raise a rule-interpretation decision; refactoring GO TO requires understanding control flow',
		'PERFORM THRU -- if the paragraph range spans non-trivial logic, raise a decision',
		'EXTERNAL data -- EXTERNAL working-storage implies shared singleton state; raise a naming decision about Spring bean scope',
		'SORT file WITH DUPLICATES IN ORDER -- preservation of sort stability must be confirmed',
		'Signed numeric with SIGN IS LEADING SEPARATE -- ensure correct BigDecimal parsing',
		'OCCURS DEPENDING ON > 500 entries -- consider streaming rather than materialising into a List',
		'Multiple CALL targets based on a variable (computed CALL) -- raise a rule-interpretation decision',
	],
};


// --- COBOL -> TypeScript -------------------------------------------------------

const COBOL_TO_TYPESCRIPT: ILanguagePairProfile = {
	sourceLang: 'cobol',
	targetLang: 'typescript',
	label: 'COBOL -> TypeScript (Node.js)',
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
		{ sourceConstruct: 'OPEN INPUT file / READ / CLOSE',                   targetConstruct: 'fs.createReadStream() with readline interface',                notes: 'File I/O -> Node.js streams' },
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
		'REDEFINES -- raise type-mapping decision; JavaScript has no union/overlay types',
		'GO TO -- raise rule-interpretation decision',
		'COMP-1 / COMP-2 -- raise decision about precision requirements',
		'Computed CALL (variable program name) -- raise rule-interpretation decision',
	],
};


// --- COBOL -> Python -----------------------------------------------------------

const COBOL_TO_PYTHON: ILanguagePairProfile = {
	sourceLang: 'cobol',
	targetLang: 'python',
	label: 'COBOL -> Python',
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
		'REDEFINES -- raise type-mapping decision; Python has no native union/overlay',
		'GO TO -- raise rule-interpretation decision',
		'Computed CALL -- raise rule-interpretation decision',
		'OCCURS DEPENDING ON large tables -- consider generators/iterators',
	],
};


// --- PL/SQL -> TypeScript ------------------------------------------------------

const PLSQL_TO_TYPESCRIPT: ILanguagePairProfile = {
	sourceLang: 'plsql',
	targetLang: 'typescript',
	label: 'PL/SQL (Oracle) -> TypeScript (Node.js)',
	targetFramework: 'Node.js + TypeScript + TypeORM',
	targetTestFramework: 'Jest',
	targetFileExtension: 'ts',

	systemPersona: `You are an expert database migration engineer specialising in moving Oracle PL/SQL stored procedures, packages, and functions to TypeScript Node.js services backed by TypeORM or a similar ORM. You understand PL/SQL type anchoring (%TYPE, %ROWTYPE), cursor patterns, exception handling, and package-level state, and know how to faithfully translate them to TypeScript with appropriate ORM patterns.`,

	idiomMap: [
		{ sourceConstruct: 'v_balance accounts.balance%TYPE',                    targetConstruct: 'let balance: number;  // or exact Account["balance"] type',    notes: 'Use TypeORM entity field type for anchored declarations' },
		{ sourceConstruct: 'v_rec accounts%ROWTYPE',                             targetConstruct: 'let rec: Account;  // TypeORM entity',                          notes: '' },
		{ sourceConstruct: 'CURSOR c IS SELECT ... FROM ... WHERE ...',          targetConstruct: 'const records = await repo.find({ where: ... })',               notes: 'Explicit cursors -> repository.find() or query builder' },
		{ sourceConstruct: 'OPEN c; FETCH c INTO v_col; CLOSE c;',              targetConstruct: 'for (const row of await cursor) { ... }',                       notes: '' },
		{ sourceConstruct: 'REF CURSOR / SYS_REFCURSOR',                        targetConstruct: 'Promise<T[]>  (return type from async function)',               notes: '' },
		{ sourceConstruct: 'INSERT INTO ... VALUES / SELECT',                    targetConstruct: 'await repo.save(entity) / await repo.createQueryBuilder()...',  notes: '' },
		{ sourceConstruct: 'UPDATE ... SET ... WHERE ...',                       targetConstruct: 'await repo.update(criteria, partialEntity)',                    notes: '' },
		{ sourceConstruct: 'DELETE FROM ... WHERE ...',                          targetConstruct: 'await repo.delete(criteria)',                                   notes: '' },
		{ sourceConstruct: 'BEGIN TRANSACTION / COMMIT / ROLLBACK',             targetConstruct: 'await dataSource.transaction(async (em) => { ... })',           notes: 'Wrap in TypeORM transaction callback' },
		{ sourceConstruct: 'EXCEPTION WHEN NO_DATA_FOUND THEN ...',             targetConstruct: 'catch (err) { if (err instanceof EntityNotFoundError) ... }',   notes: '' },
		{ sourceConstruct: 'EXCEPTION WHEN OTHERS THEN ...',                    targetConstruct: 'catch (err: unknown) { ... }',                                  notes: '' },
		{ sourceConstruct: 'RAISE_APPLICATION_ERROR(-20001, "msg")',             targetConstruct: 'throw new ApplicationError("msg");',                           notes: 'Define ApplicationError extending Error' },
		{ sourceConstruct: 'pkg_name.procedure_name(a, b)',                     targetConstruct: 'await pkgNameService.procedureName(a, b)',                      notes: 'PL/SQL package -> TypeScript @Injectable service class' },
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
		'BULK COLLECT / FORALL -- large-dataset patterns; check if pagination is more appropriate',
		'AUTONOMOUS_TRANSACTION -- raise rule-interpretation decision; side-effect semantics change',
		'Pragma EXCEPTION_INIT -- custom exception codes; define TypeScript error hierarchy',
		'Dynamic SQL (EXECUTE IMMEDIATE) -- raise rule-interpretation decision; parameterise carefully',
		'LOB handling (CLOB, BLOB) -- raise type-mapping decision; streams vs. Buffers vs. strings',
		'Database links -- raise rule-interpretation decision; cross-service calls in microservices',
	],
};


// --- PL/SQL -> Java ------------------------------------------------------------

const PLSQL_TO_JAVA: ILanguagePairProfile = {
	sourceLang: 'plsql',
	targetLang: 'java',
	label: 'PL/SQL (Oracle) -> Java (Spring Boot)',
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
		'Each PL/SQL package -> `@Service` class with constructor-injected `@Repository` dependencies',
		'Use `@Transactional` on service methods that span multiple DML operations',
		'Use `BigDecimal` for all monetary fields',
		'JPA entities annotated with `@Entity`, `@Column`, `@Id`',
		'Repository interfaces extend `JpaRepository<T, ID>` with `@Query` for complex queries',
	],

	warningPatterns: [
		'AUTONOMOUS_TRANSACTION -- raise rule-interpretation decision',
		'BULK COLLECT with FORALL -- consider JPA batch insert/update',
		'Dynamic SQL -- raise rule-interpretation decision; use parameterised JPA Criteria API',
		'Database links -- raise rule-interpretation decision',
	],
};


// --- RPG / RPGLE -> Java -------------------------------------------------------

const RPG_TO_JAVA: ILanguagePairProfile = {
	sourceLang: 'rpgle',
	targetLang: 'java',
	label: 'RPG/RPGLE (IBM i) -> Java (Spring Boot)',
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
		'All packed decimal (P) fields -> `BigDecimal` with appropriate scale',
		'RPG date fields -> `LocalDate`, time fields -> `LocalTime`, timestamp -> `LocalDateTime`',
		'RPG indicator variables (*IN01..*IN99) -> boolean fields',
	],

	warningPatterns: [
		'Data queues (DTAQ) -- raise rule-interpretation decision; JMS or async queue may apply',
		'Program-described files -- raise type-mapping decision about record format',
		'Externally described files (DDS) -- use DDS field definitions for entity mapping',
		'ILE binding directory -- service program dependencies become Spring bean injections',
		'*DTAARA (data area) -- raise naming decision about shared state',
	],
};


// --- Java EE -> Spring Boot ----------------------------------------------------

const JAVAEE_TO_SPRINGBOOT: ILanguagePairProfile = {
	sourceLang: 'java',
	targetLang: 'java',
	label: 'Java EE -> Spring Boot 3 (modernisation)',
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
		'Use Spring Boot auto-configuration -- remove boilerplate XML and web.xml',
	],

	warningPatterns: [
		'Stateful Session Beans (SFSB) -- raise naming decision about Spring scope (prototype vs session)',
		'Entity Beans (pre-JPA) -- raise type-mapping decision; likely need full JPA entity redesign',
		'Message-driven Beans with complex activation specs -- raise rule-interpretation decision',
		'Remote EJBs / RMI -- raise rule-interpretation decision; replace with REST/gRPC/messaging',
		'Application client components -- raise rule-interpretation decision',
	],
};


// --- Angular 1 -> Angular 18 ---------------------------------------------------

const ANGULARJS_TO_ANGULAR: ILanguagePairProfile = {
	sourceLang: 'javascript',
	targetLang: 'typescript',
	label: 'Angular 1 (AngularJS) -> Angular 18+ (TypeScript)',
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
		'Use standalone components (Angular 14+) -- no `NgModule` required unless integrating with existing modules',
		'Use `inject()` function or constructor injection for all service dependencies',
		'Use `@Input()` and `@Output()` for component communication instead of $scope',
		'Use Angular Signals (`signal()`, `computed()`) for reactive state (Angular 16+)',
		'Replace `$http` with `HttpClient` -- always use typed responses `http.get<T>(url)`',
		'Use reactive forms (`FormBuilder`, `FormGroup`) for complex form handling',
		'Use `OnPush` change detection strategy for performance',
		'Replace `$q` promises with RxJS observables or native `async/await`',
	],

	warningPatterns: [
		'Two-way binding on complex objects -- raise rule-interpretation decision about state management',
		'$rootScope event bus -- raise rule-interpretation decision (NgRx / component events)',
		'Dynamic template compilation ($compile) -- raise rule-interpretation decision',
		'Custom directives with complex link functions -- raise rule-interpretation decision',
		'$watch on large objects -- raise naming decision about signals vs observables',
	],
};


// --- PL/1 -> Java -------------------------------------------------------------

const PL1_TO_JAVA: ILanguagePairProfile = {
	sourceLang: 'pl1',
	targetLang: 'java',
	label: 'PL/1 -> Java (Spring Boot)',
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
		'PL/1 FIXED DEC -> `BigDecimal` with explicit scale',
		'PL/1 ON conditions become Java `try/catch` with specific exception types',
		'PL/1 structured variables (1-level, 2-level nesting) become Java POJOs',
		'PL/1 BASED variables / pointer arithmetic -> raise rule-interpretation decision',
	],

	warningPatterns: [
		'BASED variables and pointer arithmetic -- raise rule-interpretation decision',
		'Structure overlays (LIKE / DEFINED) -- raise type-mapping decision',
		'Interrupt handlers (ON ERROR SYSTEM) -- raise rule-interpretation decision',
		'TASK / EVENT / WAIT (PL/1 multitasking) -- raise rule-interpretation decision',
	],
};


// --- Assembler -> C ------------------------------------------------------------

const ASSEMBLER_TO_C: ILanguagePairProfile = {
	sourceLang: 'assembler',
	targetLang: 'c',
	label: 'Assembler (x86 / IBM z) -> C',
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
		'Translate semantic intent, not register-by-register -- identify the algorithm',
		'Use `int32_t`, `uint32_t`, etc. from `<stdint.h>` to match register widths',
		'Use `uint64_t` for 64-bit arithmetic results (MUL/IMUL overflow)',
		'Identify calling conventions from the context to determine function boundaries',
		'Use `volatile` for memory-mapped I/O or interrupt-shared variables',
	],

	warningPatterns: [
		'Self-modifying code -- raise rule-interpretation decision; not translatable to C',
		'Inline hardware I/O (IN/OUT instructions) -- raise rule-interpretation decision',
		'Interrupt service routines -- raise rule-interpretation decision',
		'Position-dependent code (PIC vs non-PIC) -- raise naming decision',
		'Mixed data/code segments -- raise type-mapping decision',
	],
};


// --- NATURAL -> Java -----------------------------------------------------------

const NATURAL_TO_JAVA: ILanguagePairProfile = {
	sourceLang: 'natural',
	targetLang: 'java',
	label: 'NATURAL (Software AG) -> Java (Spring Boot)',
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
		'NATURAL packed decimal (P type) -> `BigDecimal` with appropriate scale',
		'NATURAL READ loops -> Spring Data repository queries (JPA or custom)',
		'Replace NATURAL WRITE/PRINT with SLF4J logging',
	],

	warningPatterns: [
		'ADABAS MU/PE fields (multiple-value / periodic group) -- raise type-mapping decision',
		'NATURAL maps (INPUT USING MAP) -- raise rule-interpretation decision; UI redesign needed',
		'PROCESS COMMAND -- raise rule-interpretation decision; command routing patterns',
		'CALLNAT with variable program name -- raise rule-interpretation decision',
		'NATURAL security objects -- raise rule-interpretation decision',
		'NATURAL database calls against Tamino or other non-ADABAS stores -- raise decision',
	],
};


// --- Fortran -> Python ---------------------------------------------------------

const FORTRAN_TO_PYTHON: ILanguagePairProfile = {
	sourceLang: 'fortran',
	targetLang: 'python',
	label: 'Fortran -> Python (NumPy/SciPy)',
	targetFramework: 'Python 3.11+ with NumPy / SciPy',
	targetTestFramework: 'pytest',
	targetFileExtension: 'py',

	systemPersona: `You are an expert migrating Fortran 77/90/95/2003 scientific programs to Python 3 using NumPy and SciPy. You understand Fortran array semantics (column-major order, 1-based indexing), COMMON blocks, EQUIVALENCE, implicit typing, DO loops, and FORMAT statements. You faithfully translate numerical algorithms while adapting to Python idioms.`,

	idiomMap: [
		{ sourceConstruct: 'REAL*8 / DOUBLE PRECISION',            targetConstruct: 'float  // Python float is 64-bit (C double)',               notes: '' },
		{ sourceConstruct: 'REAL (single precision)',               targetConstruct: 'np.float32 when precision matters',                         notes: '' },
		{ sourceConstruct: 'INTEGER*4',                            targetConstruct: 'int',                                                        notes: '' },
		{ sourceConstruct: 'COMPLEX*16',                           targetConstruct: 'complex',                                                    notes: '' },
		{ sourceConstruct: 'DIMENSION A(10)',                      targetConstruct: 'A = np.zeros(10)',                                          notes: '1-based -> 0-based indexing shift; use A[i-1] or refactor loop' },
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
		'Use NumPy arrays instead of Fortran DIMENSION arrays -- vectorise where possible',
		'Fortran arrays are 1-based; shift to 0-based Python indexing carefully',
		'Fortran column-major arrays -> NumPy `order="F"` arrays for direct memory mapping',
		'COMMON blocks -> Python module-level variables or class attributes',
		'Use `scipy` for numerical algorithms already available (LAPACK, BLAS wrappers)',
		'Use `@numba.jit` or `@numba.njit` for performance-critical inner loops',
		'Use type hints: `def solve(A: np.ndarray, b: np.ndarray) -> np.ndarray:`',
	],

	warningPatterns: [
		'EQUIVALENCE -- raise type-mapping decision; overlapping storage is unsafe in Python',
		'GOTO -- raise rule-interpretation decision; refactor to structured loops',
		'ENTRY statement (multiple entry points) -- raise rule-interpretation decision',
		'FORMAT statements with complex edit descriptors -- raise naming decision',
		'Pointer arithmetic / C interop -- raise rule-interpretation decision',
	],
};


// --- VB6 -> C# ----------------------------------------------------------------

const VB6_TO_CSHARP: ILanguagePairProfile = {
	sourceLang: 'vb6',
	targetLang: 'csharp',
	label: 'Visual Basic 6 -> C# (.NET 8)',
	targetFramework: '.NET 8 / ASP.NET Core',
	targetTestFramework: 'xUnit',
	targetFileExtension: 'cs',

	systemPersona: `You are an expert migrating Visual Basic 6 (VB6) applications to modern C# on .NET 8. You understand VB6 forms, modules, class modules, COM interop, ADO/DAO data access, VB6 string functions, and the On Error GoTo error handling model. You produce idiomatic C# with proper exception handling, LINQ-based data access, and dependency injection patterns.`,

	idiomMap: [
		{ sourceConstruct: 'Module / BAS module',                  targetConstruct: 'static class',                                              notes: 'Module-level globals -> static fields or injected services' },
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
		{ sourceConstruct: 'Mid(s, start, len)',                   targetConstruct: 's.Substring(start - 1, len)',                              notes: '1-based -> 0-based indexing' },
		{ sourceConstruct: 'Left(s, n)',                           targetConstruct: 's.Substring(0, Math.Min(n, s.Length))',                    notes: '' },
		{ sourceConstruct: 'Right(s, n)',                          targetConstruct: 's.Substring(Math.Max(0, s.Length - n))',                   notes: '' },
		{ sourceConstruct: 'InStr(s1, s2)',                        targetConstruct: 's1.IndexOf(s2, StringComparison.Ordinal) + 1',             notes: '0-based -> 1-based return' },
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
		{ sourceConstruct: 'MsgBox "text"',                        targetConstruct: '// UI concern -- raise naming decision for target layer',    notes: '' },
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
		'Variant type -- raise type-mapping decision: what type does business logic require?',
		'On Error Resume Next -- raise rule-interpretation decision: is error swallowing intentional?',
		'COM/ActiveX references -- raise rule-interpretation decision about .NET replacement',
		'Win32 API calls via Declare -- raise rule-interpretation decision',
		'VB6 File I/O (Open, Get, Put) -- raise naming decision about target I/O approach',
		'Global module-level state -- raise naming decision about DI/scoping strategy',
	],
};


// --- ABAP -> TypeScript --------------------------------------------------------

const ABAP_TO_TYPESCRIPT: ILanguagePairProfile = {
	sourceLang: 'abap',
	targetLang: 'typescript',
	label: 'ABAP (SAP) -> TypeScript (Node.js / NestJS)',
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
		{ sourceConstruct: 'IF sy-subrc = 0',                      targetConstruct: 'if (result !== null && result !== undefined)',              notes: 'ABAP return code -> check result/exception' },
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
		'BAPI calls -- raise rule-interpretation decision: REST call to SAP, or replicated in Node?',
		'BADI / enhancement spots -- raise rule-interpretation decision',
		'Dynamic SELECT (field list from variable) -- raise rule-interpretation decision',
		'ABAP spool / print lists -- raise naming decision about target reporting layer',
		'Authorization checks (AUTHORITY-CHECK) -- raise rule-interpretation decision about ACL/RBAC strategy',
		'Numeric data types: CURR, QUAN with units -- raise type-mapping decision (Decimal128 / string?)',
	],
};


// --- COBOL -> Go ---------------------------------------------------------------

const COBOL_TO_GO: ILanguagePairProfile = {
	sourceLang: 'cobol',
	targetLang: 'go',
	label: 'COBOL -> Go (high-throughput services)',
	targetFramework: 'Go 1.22 + standard library',
	targetTestFramework: 'testing (go test)',
	targetFileExtension: 'go',

	systemPersona: `You are an expert migrating COBOL batch programs and CICS transactions to idiomatic Go. You understand COBOL data division (PIC clauses, COMP, COMP-3, OCCURS, REDEFINES), the PROCEDURE DIVISION paragraph structure, PERFORM, GO TO, nested IF/EVALUATE, file I/O (QSAM, VSAM), and CICS commands. You produce Go that is concise, concurrent where applicable, and uses standard library idioms including error-as-value and struct-based data modelling.`,

	idiomMap: [
		{ sourceConstruct: 'IDENTIFICATION DIVISION / PROGRAM-ID',  targetConstruct: '`package main` + func main()  OR  package named after program', notes: '' },
		{ sourceConstruct: 'PIC X(n) DISPLAY',                     targetConstruct: 'string  (max length n -- document in comment)',                  notes: '' },
		{ sourceConstruct: 'PIC 9(n)',                              targetConstruct: 'int32 / int64 (choose based on n)',                              notes: '' },
		{ sourceConstruct: 'PIC 9(n)V9(d) / PIC S9(n)V9(d)',      targetConstruct: 'float64  // or decimal.Decimal for currency',                   notes: 'Raise type-mapping decision for monetary fields' },
		{ sourceConstruct: 'PIC S9(n) COMP-3 (packed decimal)',    targetConstruct: 'int64 / decimal.Decimal',                                        notes: 'Raise type-mapping decision' },
		{ sourceConstruct: '01 WS-RECORD PIC ... (flat record)',   targetConstruct: 'type WSRecord struct { ... }',                                   notes: '' },
		{ sourceConstruct: 'OCCURS n TIMES',                        targetConstruct: '[n]T  or  []T (slice for dynamic)',                             notes: '' },
		{ sourceConstruct: 'REDEFINES',                             targetConstruct: '// union via encoding/binary or unsafe.Pointer -- raise decision', notes: 'Raise rule-interpretation decision' },
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
		'Monetary amounts: use `github.com/shopspring/decimal` or `int64` cents -- decide via type-mapping decision',
		'Use `encoding/binary` for packed decimal (COMP-3) field parsing in file I/O',
		'WORKING-STORAGE -> struct fields; LINKAGE SECTION -> function parameters/return values',
		'Use `sync.WaitGroup` and goroutines when parallelising COBOL batch loops',
		'Write table-driven tests with `testing.T` for each paragraph',
	],

	warningPatterns: [
		'REDEFINES -- raise rule-interpretation decision: use separate types, or unsafe union?',
		'GO TO -- raise rule-interpretation decision: refactor to structured loop/function?',
		'COPY member with local overrides -- raise naming decision about struct embedding',
		'CICS EXEC commands -- raise rule-interpretation decision: REST/gRPC or MQ replacement?',
		'Packed decimal (COMP-3) monetary fields -- raise type-mapping decision',
		'ALTER statement (modifying PERFORM targets at runtime) -- raise rule-interpretation decision',
	],
};


// --- PL/SQL -> Python ----------------------------------------------------------

const PLSQL_TO_PYTHON: ILanguagePairProfile = {
	sourceLang: 'plsql',
	targetLang: 'python',
	label: 'PL/SQL (Oracle) -> Python (SQLAlchemy + asyncpg)',
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
		{ sourceConstruct: 'VARCHAR2(n)',                                          targetConstruct: 'str  (max n chars -- annotate with comment)',  notes: '' },
		{ sourceConstruct: 'COMMIT',                                               targetConstruct: 'await session.commit()',                       notes: '' },
		{ sourceConstruct: 'ROLLBACK',                                             targetConstruct: 'await session.rollback()',                     notes: '' },
	],

	conventionNotes: [
		'Use SQLAlchemy 2.x Core (text() / select()) for complex SQL; ORM for CRUD',
		'Use `async def` and `await` for all DB calls via asyncpg engine',
		'Each PL/SQL package -> Python module; package globals -> module-level state or FastAPI dependency',
		'Use `Annotated` + FastAPI `Depends()` to inject `AsyncSession`',
		'Use Alembic for schema migrations corresponding to DDL in packages',
		'All monetary fields: `Decimal` from Python `decimal` module, not `float`',
		'Use `structlog` or standard `logging` instead of DBMS_OUTPUT',
	],

	warningPatterns: [
		'Package-level variables (stateful sessions) -- raise rule-interpretation decision about session scope',
		'Autonomous transactions (PRAGMA AUTONOMOUS_TRANSACTION) -- raise rule-interpretation decision',
		'Dynamic SQL (EXECUTE IMMEDIATE) -- raise rule-interpretation decision: parameterise or ORM?',
		'Oracle-specific SQL (CONNECT BY, ROWNUM, MERGE) -- raise naming decision',
		'Database triggers -- raise rule-interpretation decision: keep trigger or move to application layer?',
		'UTL_HTTP / UTL_SMTP -- raise naming decision about Python HTTP/email library',
	],
};


// --- Natural -> Python ---------------------------------------------------------

const NATURAL_TO_PYTHON: ILanguagePairProfile = {
	sourceLang: 'natural',
	targetLang: 'python',
	label: 'NATURAL (Software AG) -> Python (FastAPI + SQLAlchemy)',
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
		{ sourceConstruct: 'FETCH "program"',                     targetConstruct: '# redirect / subroutine call -- raise naming decision',         notes: '' },
		{ sourceConstruct: 'DEFINE SUBROUTINE name',              targetConstruct: 'async def name(params):',                                      notes: '' },
		{ sourceConstruct: 'PERFORM subroutine',                  targetConstruct: 'await subroutine(params)',                                     notes: '' },
		{ sourceConstruct: 'IF field = value',                    targetConstruct: 'if field == value:',                                           notes: '' },
		{ sourceConstruct: 'DECIDE ON FIRST VALUE OF x',         targetConstruct: 'match x:  (Python 3.10+)',                                     notes: '' },
		{ sourceConstruct: 'FOR i := 1 TO n',                    targetConstruct: 'for i in range(1, n + 1):',                                    notes: '' },
		{ sourceConstruct: 'WRITE / INPUT statement (TUI map)',   targetConstruct: '// UI concern -- raise naming decision for REST/web target',    notes: '' },
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
		'ADABAS MU/PE fields (multi-value / periodic groups) -- raise type-mapping decision (JSON array vs. child table)',
		'Predict/predict file -- raise rule-interpretation decision about target schema',
		'CALLNAT with variable program name -- raise rule-interpretation decision',
		'NATURAL security / entitlements -- raise rule-interpretation decision about RBAC replacement',
		'HISTOGRAM statement (ADABAS index scan) -- raise naming decision about query strategy',
	],
};


// --- MUMPS / M -> Python -------------------------------------------------------

const MUMPS_TO_PYTHON: ILanguagePairProfile = {
	sourceLang: 'mumps',
	targetLang: 'python',
	label: 'MUMPS / M (Healthcare) -> Python (FastAPI + FHIR)',
	targetFramework: 'Python 3.11+ with FastAPI + FHIR R4 (fhir.resources)',
	targetTestFramework: 'pytest',
	targetFileExtension: 'py',

	systemPersona: `You are an expert migrating MUMPS (M) code -- including VistA/CPRS clinical modules -- to Python. You understand MUMPS globals (^GLOBAL), naked references, XECUTE, implicit string/number coercion, indirection, subscript levels, MUMPS string functions ($EXTRACT, $PIECE, $FIND, $ORDER), and FILEMAN data dictionary structures. You produce idiomatic Python that maps MUMPS globals to FHIR R4 resources or relational models, and MUMPS string operations to Python string methods.`,

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
		{ sourceConstruct: '$EXTRACT(str,start,end)',              targetConstruct: 'str[start-1:end]',                                          notes: '1-based -> 0-based' },
		{ sourceConstruct: '$LENGTH(str)',                         targetConstruct: 'len(str)',                                                   notes: '' },
		{ sourceConstruct: '$FIND(str,target)',                    targetConstruct: 'str.find(target) + len(target) + 1  // returns end+1',     notes: '' },
		{ sourceConstruct: 'XECUTE string',                        targetConstruct: '// Avoid exec(); raise rule-interpretation decision',       notes: 'Security risk -- raise decision' },
		{ sourceConstruct: 'FILEMAN file^field access',            targetConstruct: 'FHIR resource attribute / ORM model field',                notes: 'Raise naming decision for each FILEMAN field mapping' },
		{ sourceConstruct: 'HL7 v2 message parsing',              targetConstruct: 'python-hl7 library or hl7apy',                              notes: '' },
	],

	conventionNotes: [
		'Map MUMPS globals to FHIR R4 resources (Patient, Encounter, Observation, etc.) where applicable',
		'Use `fhir.resources` Python library for FHIR R4 model classes',
		'FILEMAN file numbers -> FHIR resource types (raise naming decision per file)',
		'Replace implicit type coercion with explicit `str()`, `int()`, `float()` conversions',
		'MUMPS namespaces -> Python modules; routine names -> function names',
		'Use HL7 FHIR REST API (`/Patient`, `/Observation`) for all data exchange',
	],

	warningPatterns: [
		'XECUTE with constructed strings -- raise rule-interpretation decision (security: use safe dispatch table)',
		'Naked references (^(subscript) without full global name) -- raise rule-interpretation decision',
		'MUMPS indirection (@variable) -- raise rule-interpretation decision',
		'Global subscript-level schema (raise naming decision: normalize to relational or document model?)',
		'Patient privacy / PHI fields -- raise approval decision: HIPAA data handling confirmed?',
		'VistA RPCs (Remote Procedure Calls) -- raise naming decision about REST equivalent',
	],
};


// --- Ada -> C++ ----------------------------------------------------------------

const ADA_TO_CPP: ILanguagePairProfile = {
	sourceLang: 'ada',
	targetLang: 'cpp',
	label: 'Ada -> C++ (safety-critical systems)',
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
		'Ada tasks with rendezvous (accept/select) -- raise rule-interpretation decision: std::future or message queue?',
		'SPARK annotations (proof obligations) -- raise approval decision: are proofs to be maintained in C++?',
		'Ada controlled types (finalization hooks) -- raise rule-interpretation decision: RAII class?',
		'Unchecked_Conversion -- raise rule-interpretation decision: reinterpret_cast is UB risk',
		'Ada 83 generics with complex instantiation -- raise naming decision',
		'Safety integrity level (SIL/DAL) -- raise approval decision: has DO-178C/IEC 61508 re-qualification been scoped?',
	],
};


// --- Fortran -> C++ ------------------------------------------------------------

const FORTRAN_TO_CPP: ILanguagePairProfile = {
	sourceLang: 'fortran',
	targetLang: 'cpp',
	label: 'Fortran -> C++ (scientific / HPC)',
	targetFramework: 'C++17 with Eigen / OpenMP / MPI',
	targetTestFramework: 'Google Test (gtest)',
	targetFileExtension: 'cpp',

	systemPersona: `You are an expert migrating Fortran 77/90/95/2003/2008 scientific and HPC programs to modern C++17 using Eigen (for linear algebra), OpenMP (for parallelism), and optional MPI (for distributed memory). You understand Fortran array semantics (column-major, 1-based indexing), COMMON blocks, EQUIVALENCE, IMPLICIT NONE, DO loops, INTERFACE blocks, and BLAS/LAPACK calls. You produce C++ that is semantically equivalent, numerically correct, and leverages RAII.`,

	idiomMap: [
		{ sourceConstruct: 'REAL*8 / DOUBLE PRECISION',            targetConstruct: 'double',                                                     notes: '' },
		{ sourceConstruct: 'REAL (single precision)',               targetConstruct: 'float',                                                      notes: '' },
		{ sourceConstruct: 'INTEGER',                              targetConstruct: 'int  /  int64_t',                                             notes: '' },
		{ sourceConstruct: 'COMPLEX*16',                           targetConstruct: 'std::complex<double>',                                        notes: '' },
		{ sourceConstruct: 'DIMENSION A(10)',                      targetConstruct: 'std::array<double, 10> A;  // 0-based indexing',             notes: '1-based -> 0-based; document shift' },
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
		{ sourceConstruct: 'IF (cond) GOTO label',                 targetConstruct: '// refactor to if/break/continue -- raise decision',         notes: '' },
	],

	conventionNotes: [
		'Use `Eigen::MatrixXd` for 2D arrays; `Eigen::VectorXd` for 1D -- column-major matches Fortran',
		'Use `std::vector<double>` for dynamically-sized 1D arrays',
		'Use `#pragma omp parallel for` to replace `!$OMP PARALLEL DO` directives',
		'COMMON blocks -> anonymous namespace with `static` variables or singletons',
		'EQUIVALENCE -> `union` (raise rule-interpretation decision about aliasing)',
		'Enable `-O3 -march=native -fopenmp` in CMakeLists for HPC performance',
		'Use `const` and `noexcept` on pure compute functions',
	],

	warningPatterns: [
		'EQUIVALENCE -- raise rule-interpretation decision: union or reinterpret_cast?',
		'GOTO -- raise rule-interpretation decision: refactor to structured flow',
		'ENTRY statement -- raise rule-interpretation decision: split into separate functions?',
		'Assumed-shape arrays in Fortran 90 -- ensure correct Eigen dimensions',
		'MPI calls -- raise naming decision about MPI wrapper strategy (mpi.h vs. Boost.MPI)',
		'Precision-critical accumulation (REAL*16 quad) -- raise type-mapping decision: `long double` or `__float128`?',
	],
};


// --- ColdFusion -> TypeScript --------------------------------------------------

const COLDFUSION_TO_TYPESCRIPT: ILanguagePairProfile = {
	sourceLang: 'coldfusion',
	targetLang: 'typescript',
	label: 'ColdFusion (CFML) -> TypeScript (Node.js + Express/NestJS)',
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
		'One CFC -> one NestJS module (controller + service + module file)',
		'Map `datasource` names to TypeORM connection names in ormconfig',
		'Use TypeORM `@Entity()` for CF ORM persistent components',
		'Session scope -> NestJS session middleware (express-session) or JWT',
		'Application scope -> NestJS `ConfigModule` + environment variables',
		'Use `@nestjs/swagger` + `@ApiProperty()` for all DTOs',
		'Replace CF Scheduler tasks with NestJS `@Cron()` decorated methods',
	],

	warningPatterns: [
		'CFQUERY with dynamic SQL -- raise rule-interpretation decision: parameterise or QueryBuilder?',
		'Direct table/column names in CFQUERY -- raise naming decision about ORM entity mapping',
		'CF Component inheritance (extends) -- raise naming decision about class hierarchy',
		'CF custom tags -- raise naming decision: NestJS interceptor, decorator, or middleware?',
		'FILE/DIRECTORY operations via CFFILE/CFDIRECTORY -- raise naming decision',
		'CF charting/reporting -- raise naming decision about target charting library',
	],
};


// --- PowerBuilder -> Java ------------------------------------------------------

const POWERBUILDER_TO_JAVA: ILanguagePairProfile = {
	sourceLang: 'powerbuilder',
	targetLang: 'java',
	label: 'PowerBuilder -> Java (Spring Boot)',
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
		'Each DataWindow SQL -> JPQL `@Query` or Criteria API query on a Repository interface',
		'Map PowerScript column/row loops to Java streams: `list.stream().map(...).collect()`',
		'Use `@Transactional` on service methods to replace PB transaction objects',
		'One PowerBuilder NVO -> one Spring `@Service` class; use constructor injection for deps',
		'Use `@ControllerAdvice` + `@ExceptionHandler` for PowerBuilder error handling patterns',
		'DataWindow row selection -> Specification pattern for complex filtered queries',
	],

	warningPatterns: [
		'DataWindow with dynamic sort/filter (modify calls) -- raise rule-interpretation decision',
		'DynamicDescriptionArea / DynamicStagingArea -- raise naming decision',
		'Shared Objects (PB shared object pool) -- raise rule-interpretation decision: Spring singleton?',
		'Pipeline objects -- raise naming decision about Spring Batch equivalent',
		'External function calls (Windows DLLs) -- raise rule-interpretation decision',
		'PB DataWindow UpdateWhere property -- raise rule-interpretation decision about optimistic locking strategy',
	],
};



// --- Firmware & Industrial Profiles ----------------------------------------

const BARE_METAL_C_TO_FREERTOS: ILanguagePairProfile = {
	sourceLang: 'c',
	targetLang: 'c',
	label: 'Bare-metal C -> FreeRTOS C',
	targetFramework: 'FreeRTOS v10+',
	targetTestFramework: 'Unity + HIL',
	targetFileExtension: 'c',

	systemPersona: `You are a senior embedded systems engineer with 15 years of experience migrating bare-metal firmware to FreeRTOS-based RTOS architectures. You have deep expertise in super-loop refactoring, ISR deferral via queues and task notifications, and translating global state to task-local or mutex-protected state. You are meticulous about stack depth sizing, priority assignment, and interrupt-safe API selection (xQueueSendFromISR vs xQueueSend). You understand MISRA-C:2012 constraints and ensure that all dynamic memory allocation is confined to initialization (no heap use at run-time). You always reason about worst-case execution time (WCET) and tick resolution when translating timing loops.`,

	idiomMap: [
		{ sourceConstruct: 'while(1) { /* super-loop */ }',                            targetConstruct: 'void vMainTask(void *pvParams) { for(;;) { /* task body */ vTaskDelay(pdMS_TO_TICKS(N)); } }', notes: 'Break super-loop into tasks; use vTaskDelay for periodic timing' },
		{ sourceConstruct: '__disable_irq(); /* critical section */ __enable_irq();',  targetConstruct: 'taskENTER_CRITICAL(); /* critical section */ taskEXIT_CRITICAL();', notes: 'Use FreeRTOS critical section macros, NOT bare __disable_irq() inside RTOS context' },
		{ sourceConstruct: 'volatile uint8_t g_flag;  // shared between ISR and loop', targetConstruct: 'static QueueHandle_t xG_FlagQueue;  // ISR posts, task reads',  notes: 'Replace volatile shared globals with thread-safe queues or task notifications' },
		{ sourceConstruct: 'void TIMER_IRQHandler(void) { g_flag = 1; }',              targetConstruct: 'void TIMER_IRQHandler(void) { BaseType_t xHigherPriorityTaskWoken = pdFALSE; xQueueSendFromISR(xQ, &data, &xHigherPriorityTaskWoken); portYIELD_FROM_ISR(xHigherPriorityTaskWoken); }', notes: 'Always use FromISR variants inside interrupt handlers; yield if unblocking a higher-priority task' },
		{ sourceConstruct: 'delay_ms(N);  // busy-wait or SysTick polling',            targetConstruct: 'vTaskDelay(pdMS_TO_TICKS(N));',                                  notes: 'Replace busy-wait delays with vTaskDelay to yield CPU' },
		{ sourceConstruct: 'uint8_t g_uart_buf[64];  // ring buffer in global',        targetConstruct: 'static StreamBufferHandle_t xUartStream;  // FreeRTOS stream buffer', notes: 'Use FreeRTOS stream buffers for byte-stream ISR->task data transfer' },
		{ sourceConstruct: 'HAL_IWDG_Refresh(&hiwdg);  // in super-loop',             targetConstruct: 'HAL_IWDG_Refresh(&hiwdg);  // in watchdog refresh task with tight vTaskDelay', notes: 'Create a dedicated high-priority watchdog refresh task; never skip its refresh window' },
		{ sourceConstruct: 'static uint8_t mutex_flag = 0;  // home-made mutex',       targetConstruct: 'static SemaphoreHandle_t xMutex;  // xSemaphoreCreateMutex()',   notes: 'Replace hand-rolled mutexes with FreeRTOS mutexes (priority inheritance)' },
		{ sourceConstruct: '/* state machine with polling: switch(state) */  ',        targetConstruct: 'Each state phase becomes a task or uses xEventGroupWaitBits()',    notes: 'Raise decision: state machine may map to one event-driven task or multiple tasks' },
		{ sourceConstruct: 'xTaskCreate(vTaskFunc, "Name", stack, NULL, pri, &h)',     targetConstruct: 'xTaskCreateStatic(vTaskFunc, "Name", stack, NULL, pri, stackBuf, &tcb)', notes: 'Prefer xTaskCreateStatic (no heap) for safety-relevant tasks per IEC 61508' },
		{ sourceConstruct: 'SemaphoreHandle_t xBinarySem = xSemaphoreCreateBinary();',targetConstruct: 'Same -- but give from ISR with xSemaphoreGiveFromISR()',            notes: 'Binary semaphore for simple ISR->task signalling without data' },
		{ sourceConstruct: 'uint32_t tick = HAL_GetTick();  // polling timer',         targetConstruct: 'TickType_t xLastWakeTime = xTaskGetTickCount(); vTaskDelayUntil(&xLastWakeTime, period)', notes: 'Use vTaskDelayUntil for jitter-free periodic tasks' },
		{ sourceConstruct: 'osDelay(N);  // CMSIS-RTOS v1',                            targetConstruct: 'vTaskDelay(pdMS_TO_TICKS(N));  // native FreeRTOS',              notes: 'Prefer native FreeRTOS API over CMSIS-RTOS wrapper for clarity' },
		{ sourceConstruct: 'void Error_Handler(void) { while(1); }',                  targetConstruct: 'void vErrorHandler(void) { /* log */ vTaskSuspend(NULL); }  // or trigger watchdog reset', notes: 'Infinite loop in error handler starves other tasks; suspend or trigger controlled reset' },
		{ sourceConstruct: 'malloc() / free()  // in application code',               targetConstruct: '/* PROHIBITED at runtime */ -- use statically allocated buffers or FreeRTOS heap_4 at init only', notes: 'Dynamic allocation after scheduler start violates MISRA-C Rule 21.3 and IEC 61508 guidelines' },
		{ sourceConstruct: 'NVIC_SetPriority(IRQn, pri)',                              targetConstruct: 'NVIC_SetPriority(IRQn, pri)  -- keep below configMAX_SYSCALL_INTERRUPT_PRIORITY', notes: 'ISR priorities above configMAX_SYSCALL_INTERRUPT_PRIORITY cannot call FreeRTOS ISR-safe API' },
	],

	conventionNotes: [
		'All tasks must have a clearly documented stack size with worst-case analysis (use uxTaskGetStackHighWaterMark() during testing)',
		'Assign task priorities explicitly: Watchdog > Safety > Control > Communication > Background',
		'Never use vTaskDelay(0) as a yield; use taskYIELD() explicitly',
		'Thread-safe logging via a dedicated logging queue or xStreamBufferSend(); never directly from task',
		'Initialise all FreeRTOS objects (queues, semaphores, mutexes) before starting the scheduler',
		'Use `configASSERT()` to catch NULL handles from object creation failures',
		'Heap: prefer heap_4 (coalescing) or heap_5 (non-contiguous); document total heap usage',
		'All ISR handlers that call FreeRTOS API must use the FromISR variants and check xHigherPriorityTaskWoken',
	],

	warningPatterns: [
		'Volatile shared globals -- raise a data-sharing decision for each one; most should become queues or event groups',
		'Blocking calls inside ISRs (HAL_Delay, vTaskDelay) -- these MUST be removed; raise a rule-interpretation decision',
		'Re-entrant HAL calls -- HAL is not thread-safe by default; add mutex guards around peripheral access shared between tasks',
		'Very short ISR periods (< 1 tick) -- may be impossible to defer without losing interrupts; raise a design decision',
		'Watchdog timeout shorter than longest task period -- raise a safety decision about watchdog refresh strategy',
		'malloc/free in application code -- raise a severity-critical rule-interpretation decision',
	],
};


// --- Bare-metal C -> Zephyr RTOS ----------------------------------------------

const BARE_METAL_C_TO_ZEPHYR: ILanguagePairProfile = {
	sourceLang: 'c',
	targetLang: 'c',
	label: 'Bare-metal C -> Zephyr RTOS',
	targetFramework: 'Zephyr RTOS v3+',
	targetTestFramework: 'Zephyr Twister + HIL',
	targetFileExtension: 'c',

	systemPersona: `You are an expert embedded systems architect specialising in Zephyr RTOS migration. You have deep knowledge of Zephyr's device tree binding model, Kconfig system, kernel primitives (k_thread, k_msgq, k_sem, k_mutex, k_work), and GPIO/UART/SPI/I2C device driver APIs. You understand how Zephyr's WEST build system and CMakeLists integration replace traditional Keil/IAR project files. You are familiar with Zephyr's memory protection unit (MPU) support, logging subsystem (LOG_MODULE_REGISTER), and shell integration.`,

	idiomMap: [
		{ sourceConstruct: 'while(1) { /* super-loop */ }',                           targetConstruct: 'K_THREAD_DEFINE(my_tid, MY_STACK_SIZE, my_thread_fn, NULL, NULL, NULL, MY_PRIORITY, 0, 0)', notes: 'Use K_THREAD_DEFINE macro for static thread creation; replaces super-loop directly' },
		{ sourceConstruct: '__disable_irq(); /* critical */ __enable_irq();',          targetConstruct: 'unsigned int key = irq_lock();  /* critical */  irq_unlock(key);', notes: 'Zephyr IRQ lock/unlock for interrupt-safe critical sections' },
		{ sourceConstruct: 'volatile uint8_t g_flag;  // ISR->loop shared',            targetConstruct: 'struct k_msgq my_msgq;  K_MSGQ_DEFINE(my_msgq, sizeof(data), 8, 4)', notes: 'Use k_msgq for ISR->thread data transfer; zero-copy variant available' },
		{ sourceConstruct: 'HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5, GPIO_PIN_SET)',       targetConstruct: 'const struct device *gpio = DEVICE_DT_GET(DT_NODELABEL(gpioa)); gpio_pin_set(gpio, 5, 1)', notes: 'All GPIO access goes through Zephyr device tree node; no direct register access' },
		{ sourceConstruct: 'HAL_UART_Transmit(&huart1, buf, len, timeout)',            targetConstruct: 'const struct device *uart = DEVICE_DT_GET(DT_NODELABEL(uart1)); uart_tx(uart, buf, len, SYS_FOREVER_US)', notes: 'UART via Zephyr async API with uart_callback_set()' },
		{ sourceConstruct: 'delay_ms(N);',                                            targetConstruct: 'k_msleep(N);',                                                   notes: 'k_msleep yields CPU; k_busy_wait(us) for sub-ms busy-wait (avoid in tasks)' },
		{ sourceConstruct: 'uint8_t g_uart_buf[64];  // ring buffer',                 targetConstruct: 'K_MSGQ_DEFINE(uart_msgq, sizeof(char), 64, 1)',                  notes: 'Zephyr message queue as ring buffer; or use ring_buf API for byte streams' },
		{ sourceConstruct: '#include "stm32f4xx_hal.h"',                             targetConstruct: '#include <zephyr/kernel.h>\n#include <zephyr/drivers/gpio.h>',   notes: 'Replace vendor HAL includes with Zephyr subsystem headers' },
		{ sourceConstruct: 'SPI_HandleTypeDef hspi1;  HAL_SPI_Transmit(&hspi1, ...)', targetConstruct: 'spi_write(spi_dev, &spi_cfg, &tx_bufs)',                         notes: 'Zephyr SPI: configure struct spi_config, use spi_write/spi_transceive' },
		{ sourceConstruct: 'I2C_HandleTypeDef hi2c1;  HAL_I2C_Master_Transmit()',    targetConstruct: 'i2c_write(i2c_dev, buf, len, addr)',                              notes: 'Zephyr I2C: use i2c_write / i2c_read / i2c_write_read for combined transfers' },
		{ sourceConstruct: 'void EXTI0_IRQHandler(void)',                             targetConstruct: 'gpio_init_callback(&cb_data, my_callback, BIT(pin)); gpio_add_callback(gpio_dev, &cb_data)', notes: 'Zephyr GPIO interrupts use callback registration via device tree pin config' },
		{ sourceConstruct: 'IWDG_HandleTypeDef hiwdg; HAL_IWDG_Refresh(&hiwdg)',     targetConstruct: 'const struct device *wdt = DEVICE_DT_GET(DT_NODELABEL(iwdg)); wdt_feed(wdt, channel_id)', notes: 'Zephyr watchdog API: wdt_install_timeout(), wdt_setup(), wdt_feed()' },
		{ sourceConstruct: 'printf("debug: %d\\n", val)',                             targetConstruct: 'LOG_MODULE_REGISTER(my_module, CONFIG_MY_LOG_LEVEL); LOG_INF("debug: %d", val)', notes: 'Zephyr logging subsystem; configurable log level per module via Kconfig' },
		{ sourceConstruct: 'malloc() / free()',                                       targetConstruct: 'k_malloc() / k_free()  -- or use static pools: K_MEM_SLAB_DEFINE', notes: 'Prefer k_mem_slab for deterministic allocation; k_malloc uses heap_mem_pool' },
		{ sourceConstruct: '#define MY_TIMER_PERIOD_MS 100  // in main.c',           targetConstruct: 'MY_TIMER_PERIOD_MS in Kconfig under modules/my_module/Kconfig',   notes: 'Expose tunable parameters through Kconfig, not #define in source files' },
	],

	conventionNotes: [
		'All hardware peripherals must be referenced via Device Tree nodes (DT_NODELABEL), never by direct register address',
		'Add thread stack size and priority as Kconfig symbols so they are tunable per board',
		'Use CONFIG_LOG=y and LOG_MODULE_REGISTER for all debug/info output; remove printf calls',
		'Zephyr shell commands (SHELL_CMD_REGISTER) replace USART debug menus',
		'All device pointers must be validated with DEVICE_DT_GET + device_is_ready() before use',
		'Use K_SEM_DEFINE / K_MUTEX_DEFINE / K_MSGQ_DEFINE macros for static kernel object allocation',
		'Interrupt priorities must be configured in the device tree overlay, not in C code via NVIC_SetPriority',
	],

	warningPatterns: [
		'Direct register access (*(volatile uint32_t*)ADDR) -- raise blocking decision: must be replaced with DT-based driver API',
		'CubeMX-generated init code -- generate board-specific Zephyr device tree overlay instead; raise design decision',
		'Vendor CMSIS headers included directly -- eliminate; all types come from <zephyr/kernel.h>',
		'HAL_Delay() inside any callback -- raise rule-interpretation decision; use k_msleep in threads only',
		'Hardcoded flash/RAM addresses in linker script -- describe in board DTS memory node instead',
	],
};


// --- Embedded C -> Embedded C++ (MISRA-C++) ---------------------------------

const EMBEDDED_C_TO_CPP_MISRA: ILanguagePairProfile = {
	sourceLang: 'c',
	targetLang: 'cpp',
	label: 'Embedded C -> C++ (MISRA-C++ / AUTOSAR)',
	targetFramework: 'MISRA-C++:2008 / AUTOSAR C++14',
	targetTestFramework: 'GoogleTest + HIL',
	targetFileExtension: 'cpp',

	systemPersona: `You are a safety-critical embedded C++ architect with expertise in MISRA-C++:2008, AUTOSAR C++14, and ISO 26262 software architecture. You translate embedded C into idiomatic C++ that eliminates dynamic allocation, exceptions, and RTTI -- all forbidden in safety-critical embedded contexts -- while introducing class-based HAL abstractions using CRTP, policy-based design, and RAII for peripheral lifetime management. You know which C++ features are safe in embedded contexts (constexpr, templates, in-place construction) and which are forbidden (virtual destructors with RTTI, std::function, std::string on microcontrollers without an allocator).`,

	idiomMap: [
		{ sourceConstruct: 'typedef struct { uint8_t data[N]; } MyStruct_t;',         targetConstruct: 'struct MyStruct { std::array<uint8_t, N> data{}; };', notes: 'Use std::array<> instead of C arrays -- bounds checked, no decay to pointer' },
		{ sourceConstruct: 'void* memset(s, 0, sizeof(s))',                           targetConstruct: 's = {};  // value-initialise to zero',                            notes: 'Value-initialisation is idiomatic C++; use std::fill for explicit array init' },
		{ sourceConstruct: '#define MAX_SIZE 64  // magic constant',                  targetConstruct: 'constexpr std::size_t kMaxSize = 64U;',                           notes: 'Replace all object-like macros with constexpr -- MISRA-C++ Rule 16-0-4' },
		{ sourceConstruct: '#define MIN(a,b) ((a)<(b)?(a):(b))  // function macro',  targetConstruct: 'template<typename T> constexpr T min(T a, T b) noexcept { return (a < b) ? a : b; }', notes: 'Replace function-like macros with constexpr templates -- MISRA-C++ Rule 16-0-4' },
		{ sourceConstruct: 'extern uint32_t g_counter;  // global mutable state',     targetConstruct: 'class Counter { public: void increment() noexcept; uint32_t value() const noexcept; private: uint32_t m_count{}; };', notes: 'Encapsulate global mutable state in classes; no mutable namespace-scope variables per AUTOSAR A3-1-1' },
		{ sourceConstruct: 'static uint8_t s_uart_buf[256];  // file-static buffer',  targetConstruct: 'class UartDriver { private: std::array<uint8_t, 256U> m_rxBuf{}; };', notes: 'Move file-static buffers into class members with appropriate access control' },
		{ sourceConstruct: 'HAL_StatusTypeDef HAL_UART_Transmit(UART_HandleTypeDef*, const uint8_t*, uint16_t, uint32_t)', targetConstruct: 'class IUart { public: virtual bool transmit(std::span<const uint8_t> data, std::chrono::milliseconds timeout) noexcept = 0; virtual ~IUart() = default; };', notes: 'Abstract HAL interface for testability; concrete impl wraps HAL; CRTP alternative avoids vtable' },
		{ sourceConstruct: 'void Error_Handler(void) { while(1); }',                  targetConstruct: '[[noreturn]] void errorHandler() noexcept { /* log state then */ NVIC_SystemReset(); }', notes: 'Use [[noreturn]], remove infinite loop -- raises watchdog rather than starving system' },
		{ sourceConstruct: 'malloc() / free()',                                       targetConstruct: '/* FORBIDDEN */ Use std::array<>, in-place construction, or custom pool allocator', notes: 'Dynamic allocation forbidden per MISRA-C++ Rule 18-4-1 and AUTOSAR A18-5-1' },
		{ sourceConstruct: 'try { ... } catch(...) { }  // exceptions',               targetConstruct: '/* FORBIDDEN */ Use error return codes or std::expected<T,E> (C++23)',  notes: 'Exceptions forbidden per MISRA-C++ Rule 15-0-1 and AUTOSAR A15-0-1' },
		{ sourceConstruct: 'void (*callback)(uint8_t data);  // function pointer',    targetConstruct: 'template<typename Callback> class Driver { Callback m_cb; };  // or std::function avoided', notes: 'Prefer templated callbacks over std::function (heap allocation risk) in safety code' },
		{ sourceConstruct: '(uint32_t*)0x40020000  // raw cast to register',          targetConstruct: 'reinterpret_cast<volatile uint32_t*>(0x40020000U)  // mark volatile; prefer HAL', notes: 'MISRA-C++ Rule 5-2-7: raw casts to hardware address must be documented and isolated in BSP' },
		{ sourceConstruct: 'switch(state) { case STATE_A: ... }  // enum state',      targetConstruct: 'enum class State : uint8_t { A, B, C };  switch(m_state) { case State::A: ... }', notes: 'Use enum class (scoped enum) -- prevents implicit integer conversion (AUTOSAR A7-2-3)' },
		{ sourceConstruct: 'uint8_t flags = FLAG_A | FLAG_B;  // bit flags',          targetConstruct: 'constexpr uint8_t kFlagA = 0x01U; constexpr uint8_t kFlagB = 0x02U;  // or std::bitset<8>', notes: '' },
		{ sourceConstruct: 'uint32_t val = *(volatile uint32_t*)(BASE + OFFSET)',     targetConstruct: 'mmio::read32(kBase + kOffset)  // BSP-provided mmio namespace',  notes: 'Isolate all MMIO access in a thin BSP namespace; do not scatter throughout application' },
	],

	conventionNotes: [
		'No dynamic allocation at runtime: all objects must be statically allocated or constructed in-place',
		'No exceptions: use error codes, std::optional<>, or a custom Result<T,E> type',
		'No RTTI (no dynamic_cast, no typeid): disable with -fno-rtti in build flags',
		'All header-only code must guard against multiple inclusion with #pragma once (MISRA-C++ Rule 16-2-3)',
		'Use `noexcept` on all functions that cannot throw (which is all functions in fully compliant code)',
		'Prefer CRTP (Curiously Recurring Template Pattern) for static polymorphism over virtual dispatch',
		'Use std::array<>, not raw arrays; use std::span<> for non-owning views (C++20)',
		'Name constants kUpperCamelCase, member variables m_lowerCamel, static s_lowerCamel',
	],

	warningPatterns: [
		'Virtual destructors with RTTI -- raise blocking decision; forbidden in MISRA-C++',
		'std::string / std::vector / std::deque -- raise decision: these use heap; replace with fixed-size alternatives',
		'#include <iostream> -- raise decision: stream I/O allocates; use printf equivalent or logging subsystem',
		'reinterpret_cast to hardware address in non-BSP code -- raise decision: must be isolated in BSP layer',
		'Function pointer casts -- raise decision; may violate MISRA-C++ Rule 5-2-6',
		'Nested templates with deep instantiation -- raise note: may cause long compile times on small toolchains',
	],
};


// --- Assembly -> Embedded C ---------------------------------------------------

const ASSEMBLY_TO_EMBEDDED_C: ILanguagePairProfile = {
	sourceLang: 'assembler',
	targetLang: 'c',
	label: 'ARM/AVR Assembly -> Embedded C (HAL)',
	targetFramework: 'CMSIS + Vendor HAL',
	targetTestFramework: 'Unity + HIL',
	targetFileExtension: 'c',

	systemPersona: `You are an expert in translating ARM Cortex-M and AVR assembly routines into portable embedded C. You understand ARM calling conventions (AAPCS), ARM load/store architecture, barrel shifter idioms, CPSR flag usage, and how assembly-level hardware operations map to CMSIS intrinsics and vendor HAL API calls. You translate memory-mapped register access via LDR/STR to volatile pointer or HAL calls. You recognise assembly-level critical section patterns (CPSID i / CPSIE i on ARM, CLI/SEI on AVR) and map them to CMSIS intrinsics or RTOS critical section macros.`,

	idiomMap: [
		{ sourceConstruct: 'CPSID I  // disable global interrupts (ARM)',              targetConstruct: '__disable_irq();  // CMSIS intrinsic',                           notes: 'Always pair with __enable_irq(); raise decision if nested disable expected' },
		{ sourceConstruct: 'CPSIE I  // enable global interrupts (ARM)',               targetConstruct: '__enable_irq();',                                                notes: '' },
		{ sourceConstruct: 'LDR R0, =0x40020000  // base address literal',            targetConstruct: '#define GPIOA_BASE  (0x40020000UL)  // or use CMSIS define',    notes: 'Use CMSIS device header constants, not hardcoded literals' },
		{ sourceConstruct: 'LDR R1, [R0, #0x14]  // read register at offset 0x14',   targetConstruct: '*(volatile uint32_t*)(BASE + 0x14U)',                            notes: 'Prefer SVD-generated accessor macro; document register name in comment' },
		{ sourceConstruct: 'STR R1, [R0, #0x18]  // write register',                  targetConstruct: '*(volatile uint32_t*)(BASE + 0x18U) = value;',                  notes: '' },
		{ sourceConstruct: 'BIC R1, R1, #(1 << N)  // clear bit N',                  targetConstruct: 'reg &= ~(1UL << N);',                                            notes: '' },
		{ sourceConstruct: 'ORR R1, R1, #(1 << N)  // set bit N',                    targetConstruct: 'reg |= (1UL << N);',                                             notes: '' },
		{ sourceConstruct: 'TST R1, #(1 << N); BEQ label  // test and branch',        targetConstruct: 'if ((reg & (1UL << N)) == 0U) { /* branch body */ }',           notes: '' },
		{ sourceConstruct: 'MUL R0, R1, R2  // 32-bit multiply',                      targetConstruct: 'uint32_t result = (uint32_t)a * (uint32_t)b;',                  notes: 'Check for overflow if result > 32-bit; use __SMULL if signed 64-bit product needed' },
		{ sourceConstruct: 'UDIV R0, R1, R2  // hardware divide (Cortex-M3+)',        targetConstruct: 'uint32_t result = a / b;  // requires b != 0 check',             notes: 'Add divide-by-zero guard; Cortex-M0 has no hardware UDIV -- use __aeabi_uidiv()' },
		{ sourceConstruct: 'WFI  // Wait For Interrupt (low-power)',                   targetConstruct: '__WFI();  // CMSIS intrinsic',                                   notes: 'Ensure interrupt is enabled before WFI to avoid deadlock' },
		{ sourceConstruct: 'SEV / WFE  // event signalling (ARM multicore)',           targetConstruct: '__SEV(); __WFE();',                                              notes: 'Raise decision: multicore event signalling may need OS-level replacement' },
		{ sourceConstruct: 'PUSH {R4-R11, LR}; ... POP {R4-R11, PC}  // prologue',   targetConstruct: '// Handled by compiler; function body is all that needs porting', notes: 'Calling convention handled by C compiler; no manual prologue/epilogue needed' },
		{ sourceConstruct: 'CLI  // AVR disable interrupt',                            targetConstruct: 'SREG &= ~(1 << SREG_I);  // or cli() macro',                    notes: 'avr/interrupt.h provides cli() / sei()' },
		{ sourceConstruct: 'SEI  // AVR enable interrupt',                             targetConstruct: 'sei();',                                                         notes: '' },
		{ sourceConstruct: 'RJMP label / RCALL label  // AVR relative jump/call',     targetConstruct: 'goto / function call -- should not be needed in structured C',    notes: 'Structured C eliminates all jumps; raise decision if computed jump present' },
		{ sourceConstruct: 'LD R16, X  // AVR indirect load',                         targetConstruct: 'uint8_t val = *ptr;',                                            notes: '' },
		{ sourceConstruct: 'ST X, R16  // AVR indirect store',                        targetConstruct: '*ptr = val;',                                                    notes: '' },
		{ sourceConstruct: 'NOP  // no-operation (timing)',                            targetConstruct: '__NOP();  // CMSIS -- or replace with a documented delay',        notes: 'Raise decision: NOP-based timing is not portable; use HAL_Delay or timer peripheral' },
	],

	conventionNotes: [
		'All hardware register access must be wrapped in BSP accessor functions or CMSIS macros -- no raw numeric addresses in application code',
		'Translate assembly-coded loops to while/for loops; compiler optimisation handles the rest',
		'Document every CMSIS intrinsic usage with a comment explaining the hardware rationale',
		'Guard all divide operations against zero divisor explicitly',
		'Mark interrupt handler entry points with the correct IRQHandler name and __attribute__((interrupt)) if required by toolchain',
	],

	warningPatterns: [
		'Self-modifying code -- cannot be translated to C; raise blocking decision',
		'PC-relative data tables (LDR Rn, [PC, #offset]) -- raise decision: likely a jump table or constant pool; must be restructured',
		'THUMB/ARM interworking (BX LR, BLX) -- raise note: C compiler handles this; no manual interwork needed',
		'Cortex-M0 use of UDIV -- raise decision: M0 has no hardware divide; compiler inserts __aeabi_uidiv() automatically',
		'Inline assembly retention (`asm volatile`) -- raise decision: document WHY assembly is still needed; prefer CMSIS intrinsic',
	],
};


// --- IEC 61131-3 Ladder -> Structured Text ------------------------------------

const LADDER_TO_STRUCTURED_TEXT: ILanguagePairProfile = {
	sourceLang: 'iec61131',
	targetLang: 'iec61131',
	label: 'Ladder Diagram -> Structured Text (IEC 61131-3)',
	targetFramework: 'IEC 61131-3 ST (CoDeSys v3 / CODESYS / Siemens TIA SCL)',
	targetTestFramework: 'PLCunit + SIL Simulation',
	targetFileExtension: 'st',

	systemPersona: `You are a senior PLC and IEC 61131-3 automation engineer with expertise in migrating Ladder Diagram (LD) programs to Structured Text (ST), following PLCopen and IEC 61131-3 best practices. You understand that every Ladder rung maps to a boolean expression and that function block instantiation must be preserved exactly. You are meticulous about scan-cycle semantics, output coil latching, and rising/falling edge detection patterns. You know that safety function blocks (PLCopen Safety FB library: SF_EmergencyStop, SF_SafelyLimitedSpeed) must never be reinterpreted -- their calling convention and output semantics are normative.`,

	idiomMap: [
		{ sourceConstruct: '|---[ ]---[ ]---( )---|  // Series contacts + output coil',   targetConstruct: 'Output := ContactA AND ContactB;',                              notes: 'Series contacts = AND; parallel contacts = OR; output coil = assignment' },
		{ sourceConstruct: '|---[/]---( )---|  // Normally-closed contact',               targetConstruct: 'Output := NOT ContactA;',                                       notes: 'Normally-closed contact = NOT' },
		{ sourceConstruct: '|-+--[ ]--+-( )--|  // Parallel contacts (OR)',               targetConstruct: 'Output := ContactA OR ContactB;',                               notes: '' },
		{ sourceConstruct: '|---[ ]---[TON EN]-+---( )---|  // Timer in rung',            targetConstruct: 'Timer1(IN := Contact, PT := T#5S); Output := Timer1.Q;',        notes: 'TON/TOF/TP instances persist across scans; never re-declare inside ST block' },
		{ sourceConstruct: '(OTE)  // Output Energise coil',                              targetConstruct: 'Output := Condition;',                                          notes: 'Direct assignment' },
		{ sourceConstruct: '(OTL)  // Latch coil (set on rising edge)',                   targetConstruct: 'IF RisingEdge THEN Output := TRUE; END_IF',                     notes: 'Use R_TRIG FB to detect rising edge for latch' },
		{ sourceConstruct: '(OTU)  // Unlatch coil (clear on rising edge)',               targetConstruct: 'IF RisingEdge THEN Output := FALSE; END_IF',                    notes: '' },
		{ sourceConstruct: '[CTU] // Counter up',                                        targetConstruct: 'Counter1(CU := PulseSignal, R := Reset, PV := 100); AtCount := Counter1.Q;', notes: 'CTU instance must be declared as VAR Counter1 : CTU; END_VAR' },
		{ sourceConstruct: '[SF_EmergencyStop]  // PLCopen Safety FB',                   targetConstruct: 'EStop1(S_EStopIn := EStopButton, S_StartReset := ResetBtn, S_AutoReset := FALSE); SafetyOK := EStop1.S_SafetyActive;', notes: 'NEVER simplify safety FB calls -- their input/output mapping is safety-normative; raise decision if any parameter is unclear' },
		{ sourceConstruct: '[PID_COMPACT]  // Siemens PID block',                        targetConstruct: 'PID1(SetPoint := SP, ProcessValue := PV, ManualValue := MV, Mode := Auto); CV := PID1.Output;', notes: 'Map Siemens PID_COMPACT to IEC-standard PID FB; raise decision if vendor-specific tuning params are used' },
		{ sourceConstruct: '[MC_Power]  // PLCopen Motion FB',                           targetConstruct: 'Axis1_Power(Axis := Axis1, Enable := EnableSignal, bRegulatorOn := TRUE, bDriveStart := TRUE);', notes: 'Motion FBs must be instantiated once and called every scan; raise decision if axis type differs' },
		{ sourceConstruct: '|---[P]---  // Positive (rising-edge) contact',              targetConstruct: 'R_TRIG1(CLK := Signal); IF R_TRIG1.Q THEN ... END_IF',          notes: 'Positive contact = R_TRIG function block' },
		{ sourceConstruct: '|---[N]---  // Negative (falling-edge) contact',             targetConstruct: 'F_TRIG1(CLK := Signal); IF F_TRIG1.Q THEN ... END_IF',          notes: 'Negative contact = F_TRIG function block' },
		{ sourceConstruct: 'network:  (* Rung comment *)',                               targetConstruct: '(* Network comment preserved above the translated expression *)', notes: 'Preserve all rung comments as (* block comments *) above each ST expression' },
	],

	conventionNotes: [
		'Every function block instance declared in Ladder (TON, CTU, R_TRIG, etc.) must be declared in the ST VAR section before use',
		'Declaration order in VAR: inputs (VAR_INPUT), outputs (VAR_OUTPUT), local FBs (VAR), external (VAR_EXTERNAL)',
		'Safety FBs (SF_ prefix) must be called every scan cycle WITHOUT exception -- never call conditionally',
		'All rungs must be translated in the same order as the Ladder -- scan-cycle semantics must be preserved',
		'Use BOOL TRUE/FALSE not 1/0 for boolean assignments',
		'Network/rung comments must be preserved -- they often convey safety rationale required for IEC 61508 documentation',
		'Do not merge multiple rungs into a single complex ST expression -- keep one expression per rung for traceability',
	],

	warningPatterns: [
		'Safety function blocks (SF_ prefix) -- raise blocking decision if any input mapping is unclear; do not guess',
		'Latching coils (OTL/OTU) with non-obvious reset logic -- raise rule-interpretation decision; verify with commissioning documentation',
		'Motion FB calls without axis configuration -- raise decision; axis type and drive parameters required',
		'TON/TOF timers with very short preset times (< 10ms) -- raise note: ST scan cycle time must be faster than timer preset',
		'Rungs with complex structured text already embedded (ST block in Ladder) -- raise note for review; direct lifting may introduce double-execution',
	],
};


// --- Register-direct C -> STM32 HAL -------------------------------------------

const REGISTER_DIRECT_TO_STM32_HAL: ILanguagePairProfile = {
	sourceLang: 'c',
	targetLang: 'c',
	label: 'Register-direct C -> STM32 HAL',
	targetFramework: 'STM32 HAL (STM32Cube)',
	targetTestFramework: 'Unity + STM32CubeMonitor HIL',
	targetFileExtension: 'c',

	systemPersona: `You are a senior STM32 firmware architect who specialises in migrating register-direct peripheral access code to the STM32Cube HAL library. You have deep knowledge of STM32 peripheral register maps (from SVD and reference manuals), HAL API signatures, and how to configure handles (SPI_HandleTypeDef, UART_HandleTypeDef, etc.) generated by STM32CubeMX. You understand the trade-offs between HAL (portable, slower), LL (low-level, faster), and register-direct (fastest, least portable) and can explain upgrade path costs in each direction.`,

	idiomMap: [
		{ sourceConstruct: 'RCC->AHB1ENR |= RCC_AHB1ENR_GPIOAEN;  // enable clock',  targetConstruct: '__HAL_RCC_GPIOA_CLK_ENABLE();',                                  notes: 'HAL provides clock enable macros for all peripherals' },
		{ sourceConstruct: 'GPIOA->MODER |= (1 << (pin*2));  // output mode',         targetConstruct: 'GPIO_InitTypeDef cfg = {.Pin=GPIO_PIN_5, .Mode=GPIO_MODE_OUTPUT_PP, .Pull=GPIO_NOPULL, .Speed=GPIO_SPEED_FREQ_LOW}; HAL_GPIO_Init(GPIOA, &cfg);', notes: 'HAL_GPIO_Init configures mode, speed, pull in one call' },
		{ sourceConstruct: 'GPIOA->ODR |= (1 << pin);  // set GPIO high',             targetConstruct: 'HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5, GPIO_PIN_SET);',            notes: '' },
		{ sourceConstruct: 'GPIOA->ODR &= ~(1 << pin);  // set GPIO low',             targetConstruct: 'HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5, GPIO_PIN_RESET);',          notes: '' },
		{ sourceConstruct: '(GPIOA->IDR >> pin) & 1  // read GPIO',                   targetConstruct: 'HAL_GPIO_ReadPin(GPIOA, GPIO_PIN_5)',                             notes: '' },
		{ sourceConstruct: 'USART1->BRR = ...; USART1->CR1 |= USART_CR1_UE;',        targetConstruct: 'UART_HandleTypeDef huart1 = {.Instance=USART1, .Init={.BaudRate=115200, ...}}; HAL_UART_Init(&huart1);', notes: 'CubeMX generates huart1 init; transplant .Init fields from register config' },
		{ sourceConstruct: 'while(!(USART1->SR & USART_SR_TXE)); USART1->DR = byte;', targetConstruct: 'HAL_UART_Transmit(&huart1, &byte, 1, HAL_MAX_DELAY);',           notes: 'Non-blocking: HAL_UART_Transmit_IT / HAL_UART_Transmit_DMA for production code' },
		{ sourceConstruct: 'SPI1->CR1 |= SPI_CR1_SPE; SPI1->DR = byte; while(!(SPI1->SR & SPI_SR_RXNE)); byte = SPI1->DR;', targetConstruct: 'HAL_SPI_TransmitReceive(&hspi1, &txByte, &rxByte, 1, HAL_MAX_DELAY);', notes: '' },
		{ sourceConstruct: 'ADC1->CR2 |= ADC_CR2_SWSTART; while(!(ADC1->SR & ADC_SR_EOC)); val = ADC1->DR;', targetConstruct: 'HAL_ADC_Start(&hadc1); HAL_ADC_PollForConversion(&hadc1, HAL_MAX_DELAY); val = HAL_ADC_GetValue(&hadc1);', notes: 'Use HAL_ADC_Start_DMA for multi-channel continuous conversion' },
		{ sourceConstruct: 'TIM2->ARR = period - 1; TIM2->PSC = prescaler - 1; TIM2->CR1 |= TIM_CR1_CEN;', targetConstruct: 'HAL_TIM_Base_Init(&htim2); HAL_TIM_Base_Start_IT(&htim2);',           notes: 'Timer period/prescaler set in MX_TIM2_Init; use _IT or _DMA variant for events' },
		{ sourceConstruct: 'NVIC_SetPriority(USART1_IRQn, 5); NVIC_EnableIRQ(USART1_IRQn);', targetConstruct: 'HAL_NVIC_SetPriority(USART1_IRQn, 5, 0); HAL_NVIC_EnableIRQ(USART1_IRQn);', notes: 'Use HAL_NVIC_ wrappers; sub-priority (3rd arg) relevant only in grouped mode' },
		{ sourceConstruct: 'DMA1_Channel5->CCR |= DMA_CCR_EN;  // raw DMA enable',   targetConstruct: 'HAL_UART_Receive_DMA(&huart1, rxBuf, rxLen);  // HAL manages DMA handle', notes: 'HAL DMA transfer is configured through peripheral DMA association in CubeMX' },
	],

	conventionNotes: [
		'Use CubeMX-generated peripheral handles (huart1, hspi1, hadc1) as the basis for all HAL calls',
		'Wrap HAL calls in application functions that return a custom StatusCode enum -- never expose HAL_StatusTypeDef to application layer',
		'Prefer IT (interrupt) or DMA variants over polling (HAL_MAX_DELAY) for all production data transfers',
		'Always check HAL return codes: HAL_OK, HAL_ERROR, HAL_BUSY, HAL_TIMEOUT',
		'Do not mix register-direct and HAL access on the same peripheral -- pick one consistently',
		'Document the SVD register name and reference manual section for every raw register access that cannot be replaced by HAL',
	],

	warningPatterns: [
		'Raw SPI/I2C CS GPIO toggling not using HAL -- raise decision: some HAL functions expect manual CS management; document the strategy',
		'DMA memory address alignment -- raise note: STM32 DMA requires word-aligned buffers for 32-bit transfers',
		'USART Baud rate calculation with non-standard clocks -- raise decision: verify HAL UART init uses correct PCLK from SystemClock_Config',
		'Shared peripherals (multiple drivers using same SPI bus) -- raise decision: must add mutex before HAL call',
		'Using HAL_MAX_DELAY in production -- raise decision: replace with application-specific timeout and error handling',
	],
};


// --- FreeRTOS C -> Zephyr RTOS ------------------------------------------------

const FREERTOS_TO_ZEPHYR: ILanguagePairProfile = {
	sourceLang: 'c',
	targetLang: 'c',
	label: 'FreeRTOS C -> Zephyr RTOS C',
	targetFramework: 'Zephyr RTOS v3+',
	targetTestFramework: 'Zephyr Twister + HIL',
	targetFileExtension: 'c',

	systemPersona: `You are an RTOS migration specialist with hands-on experience porting FreeRTOS applications to Zephyr RTOS. You know the API equivalences between FreeRTOS (xTaskCreate, xQueueSend, xSemaphoreGive, osDelay) and Zephyr (k_thread_create, k_msgq_put, k_sem_give, k_msleep), including important semantic differences like Zephyr's kernel object lifetimes, the lack of a heap-only allocation model, and how Zephyr's syswork queue replaces some deferred ISR patterns. You understand Zephyr's CMake/Kconfig build integration and device tree peripheral binding.`,

	idiomMap: [
		{ sourceConstruct: 'xTaskCreate(fn, "Name", stackSz, param, pri, &handle)',   targetConstruct: 'K_THREAD_DEFINE(tid, stackSz, fn, param, NULL, NULL, pri, 0, 0)', notes: 'K_THREAD_DEFINE creates a static thread at boot; or use k_thread_create() with pre-allocated stack' },
		{ sourceConstruct: 'vTaskDelay(pdMS_TO_TICKS(N))',                            targetConstruct: 'k_msleep(N)',                                                    notes: '' },
		{ sourceConstruct: 'vTaskDelayUntil(&xLastWake, period)',                     targetConstruct: 'k_sleep(K_TIMEOUT_ABS_TICKS(next_tick))',                        notes: 'Zephyr uses absolute timeout; compute next_tick = last_tick + period using k_uptime_ticks()' },
		{ sourceConstruct: 'xQueueCreate(len, sizeof(Item))',                         targetConstruct: 'K_MSGQ_DEFINE(my_msgq, sizeof(Item), len, 4)',                   notes: 'Zephyr msgq is statically defined; alignment (4th arg) typically 4 bytes' },
		{ sourceConstruct: 'xQueueSend(xQ, &item, timeout)',                          targetConstruct: 'k_msgq_put(&my_msgq, &item, K_MSEC(timeout))',                   notes: '' },
		{ sourceConstruct: 'xQueueReceive(xQ, &item, timeout)',                       targetConstruct: 'k_msgq_get(&my_msgq, &item, K_MSEC(timeout))',                   notes: '' },
		{ sourceConstruct: 'xQueueSendFromISR(xQ, &item, &pxWoken)',                  targetConstruct: 'k_msgq_put(&my_msgq, &item, K_NO_WAIT)',                         notes: 'Zephyr kernel objects are ISR-safe when used with K_NO_WAIT; no separate FromISR variant needed' },
		{ sourceConstruct: 'xSemaphoreCreateBinary()',                                targetConstruct: 'K_SEM_DEFINE(my_sem, 0, 1)',                                     notes: '' },
		{ sourceConstruct: 'xSemaphoreGive(sem)',                                     targetConstruct: 'k_sem_give(&my_sem)',                                            notes: '' },
		{ sourceConstruct: 'xSemaphoreTake(sem, timeout)',                            targetConstruct: 'k_sem_take(&my_sem, K_MSEC(timeout))',                           notes: '' },
		{ sourceConstruct: 'xSemaphoreCreateMutex()',                                 targetConstruct: 'K_MUTEX_DEFINE(my_mutex)',                                       notes: 'Zephyr mutex has priority inheritance by default' },
		{ sourceConstruct: 'xMutexTake(m, portMAX_DELAY) / xMutexGive(m)',           targetConstruct: 'k_mutex_lock(&my_mutex, K_FOREVER) / k_mutex_unlock(&my_mutex)', notes: '' },
		{ sourceConstruct: 'xEventGroupCreate() / xEventGroupSetBits()',              targetConstruct: 'K_EVENT_DEFINE(my_event) / k_event_post(&my_event, bits)',       notes: 'Zephyr event object; use k_event_wait() for multi-bit wait' },
		{ sourceConstruct: 'xStreamBufferCreate(size, trigLevel)',                    targetConstruct: 'K_PIPE_DEFINE(pipe, size, 4)  // or ring_buf for byte streams',  notes: 'Zephyr pipe or ring_buf for byte-stream ISR->thread communication' },
		{ sourceConstruct: 'taskENTER_CRITICAL() / taskEXIT_CRITICAL()',             targetConstruct: 'unsigned int key = irq_lock(); /* ... */ irq_unlock(key);',       notes: 'Zephyr IRQ lock; note: does NOT disable cooperative thread preemption' },
		{ sourceConstruct: 'pvPortMalloc(sz) / vPortFree(ptr)',                       targetConstruct: 'k_malloc(sz) / k_free(ptr)  // or k_mem_slab for pools',        notes: 'Allocate from Zephyr heap; prefer k_mem_slab for fixed-size deterministic allocation' },
		{ sourceConstruct: 'configASSERT(expr)',                                      targetConstruct: '__ASSERT(expr, "message")',                                      notes: 'Zephyr assert macro; configurable via CONFIG_ASSERT' },
		{ sourceConstruct: 'uxTaskGetStackHighWaterMark(NULL)',                        targetConstruct: 'k_thread_stack_space_get(k_current_get(), &unused)',            notes: 'Zephyr stack introspection; enable CONFIG_THREAD_STACK_INFO' },
	],

	conventionNotes: [
		'Replace all portMAX_DELAY with K_FOREVER and all pdMS_TO_TICKS(N) with K_MSEC(N)',
		'Static thread definition (K_THREAD_DEFINE) is preferred over dynamic k_thread_create() for safety-relevant threads',
		'Zephyr logging: use LOG_MODULE_REGISTER in each .c file; remove all FreeRTOS-era printf calls',
		'Zephyr shell (CONFIG_SHELL=y) replaces UART command menus; bind commands with SHELL_CMD_REGISTER',
		'Peripheral access via Device Tree only: replace FreeRTOS HAL direct calls with Zephyr driver API',
	],

	warningPatterns: [
		'xTimerCreate -- raise decision: Zephyr software timer (k_timer) has different API; callback runs in sysclock ISR context by default',
		'vTaskSuspend / vTaskResume -- raise decision: Zephyr uses k_thread_suspend / k_thread_resume with handle from K_THREAD_DEFINE',
		'FreeRTOS hooks (vApplicationStackOverflowHook, etc.) -- raise decision: map to Zephyr fatal error hook (k_sys_fatal_error_handler)',
		'pvPortMalloc in ISR context -- raise blocking decision; heap allocation from ISR is undefined behaviour in Zephyr',
		'configTICK_RATE_HZ mismatch -- raise note: verify CONFIG_SYS_CLOCK_TICKS_PER_SEC matches application timing assumptions',
	],
};


// --- AUTOSAR Classic SWC -> AUTOSAR Adaptive ----------------------------------

const AUTOSAR_CLASSIC_TO_ADAPTIVE: ILanguagePairProfile = {
	sourceLang: 'autosar',
	targetLang: 'cpp',
	label: 'AUTOSAR Classic SWC -> AUTOSAR Adaptive (ARA)',
	targetFramework: 'AUTOSAR Adaptive Platform (ara::com, ara::exec)',
	targetTestFramework: 'GoogleTest + vADASim',
	targetFileExtension: 'cpp',

	systemPersona: `You are an AUTOSAR Adaptive Platform architect with expertise in migrating AUTOSAR Classic (CP) SWCs to AUTOSAR Adaptive (AP) executables. You understand the CP RTE generated code model (Rte_Call, Rte_Read, Rte_Write API), port-interface contracts, inter-runnable variable patterns, and how they map to AUTOSAR Adaptive ara::com service discovery with SkeletonBase/ProxyBase patterns, SOME/IP serialization, and ara::exec Adaptive Application lifecycle. You are familiar with C++14/17 compliance requirements and AP-forbidden constructs (no exceptions in safety-relevant paths, no RTTI).`,

	idiomMap: [
		{ sourceConstruct: 'Rte_Read_<port>_<elem>(&value)',                          targetConstruct: 'auto future = proxy->elem.Get(); value = future.get();  // ara::com Proxy field', notes: 'CP Rte_Read -> AP ara::com field Get() on Proxy; adapt for async/event patterns' },
		{ sourceConstruct: 'Rte_Write_<port>_<elem>(value)',                          targetConstruct: 'skeleton->elem.Update(value);  // ara::com Skeleton field Update', notes: 'CP Rte_Write -> AP Skeleton field Update; fires SOME/IP notification to subscribers' },
		{ sourceConstruct: 'Rte_Call_<port>_<op>(<args>)',                            targetConstruct: 'auto result = proxy->Op(<args>).get();  // ara::com method call',  notes: 'CP client-server port -> AP ara::com method on Proxy (Fire-and-forget or fire for result)' },
		{ sourceConstruct: 'RUNNABLE_DEFINE(MyRunnable, 10ms, cyclic)',               targetConstruct: 'class MyApplication : public ara::core::Initialize { void Run(); }; // scheduled by ara::exec', notes: 'Runnables become Run() method of Adaptive Application; scheduler managed by ara::exec' },
		{ sourceConstruct: 'IVR (inter-runnable variable): static uint32_t g_ivr;',  targetConstruct: 'Class member variable or ara::com event field; shared across methods of same executable', notes: 'IVR -> class member; if cross-process: ara::com field; raise decision on scope' },
		{ sourceConstruct: 'Dem_SetEventStatus(DEM_EVENT_STATUS_FAILED)',             targetConstruct: 'ara::diag::DTCInhibitRecord or ara::diag::Monitor::ReportMonitorAction', notes: 'DEM events -> AP diagnostic monitor report; map DTC IDs in diagnostic manifest' },
		{ sourceConstruct: 'NvM_ReadBlock / NvM_WriteBlock',                          targetConstruct: 'ara::per::KeyValueStorage::GetOrCreate() / kv->Set(key, value)',  notes: 'NvM persistent storage -> ara::per key-value store; configure in manifest' },
		{ sourceConstruct: 'Com_SendSignal / Com_ReceiveSignal',                      targetConstruct: 'ara::com event send/subscribe via Skeleton::NotifySubscribers / Proxy::event.Subscribe', notes: 'COM signals -> ara::com events over SOME/IP; serializer configured in ARXML manifest' },
		{ sourceConstruct: 'Os_GetTaskID() / Schedule()',                             targetConstruct: 'ara::exec::ApplicationClient -- lifecycle managed by Execution Management', notes: 'No manual OS task scheduling in AP; ara::exec provides lifecycle states (Running, Terminating)' },
	],

	conventionNotes: [
		'Every AP Executable must implement ara::core::Initialize, Run, and operator()(ara::exec::ActivationReasonType) lifecycle hooks',
		'Service interfaces defined in ARXML manifests using ServiceInterface element -- ara::com generates Skeleton/Proxy from manifest',
		'Use ara::core::Result<T, ErrorCode> instead of exceptions for all fallible operations',
		'No RTTI (no dynamic_cast, no typeid) -- compile with -fno-rtti; all polymorphism via virtual + documented interface',
		'SOME/IP serialization is auto-generated from ARXML; do not manually marshal/unmarshal SOME/IP frames',
		'ara::log replaces all Classic DLT calls; configure LogLevel in application manifest',
	],

	warningPatterns: [
		'Dual-mode SWCs (CP + AP bridge) -- raise design decision: transition period requires SOME/IP <-> AUTOSAR Signal Gateway',
		'Tightly-timed runnables (< 1ms cycle) -- raise decision: AP scheduling granularity may be insufficient; consider RT OS tuning',
		'Shared memory IPC between AP executables -- raise security decision: requires ara::crypto and AUTOSAR IAM configuration',
		'DEM events with no AP diagnostic manifest counterpart -- raise blocking decision; DTCs must be defined in manifest before translation',
	],
};


// --- PLC (IEC 61131-3) -> Linux-RT IPC (C++) ----------------------------------

const PLC_TO_LINUX_RT: ILanguagePairProfile = {
	sourceLang: 'iec61131',
	targetLang: 'cpp',
	label: 'PLC (IEC 61131-3) -> Linux-RT IPC Application (C++)',
	targetFramework: 'PREEMPT-RT Linux + IEC 61499 / OPC-UA for Devices',
	targetTestFramework: 'GoogleTest + SIL simulation',
	targetFileExtension: 'cpp',

	systemPersona: `You are an industrial automation architect specialising in migrating PLC ladder and structured text programs to real-time Linux (PREEMPT-RT) industrial PC applications in C++. You understand POSIX real-time scheduling (SCHED_FIFO, sched_param), memory-locking (mlockall), and how PLC scan-cycle semantics map to a periodic POSIX timer thread. You know how to integrate MODBUS-TCP, OPC-UA (open62541), and EtherCAT master stacks into a Linux-RT application. You are familiar with IEC 62443 cybersecurity requirements for OT/IT convergence systems.`,

	idiomMap: [
		{ sourceConstruct: 'PROGRAM Main  (* PLC cyclic scan *)',                    targetConstruct: 'class ScanThread : public PeriodicThread { void execute() override; };  // SCHED_FIFO periodic RT thread', notes: 'PLC scan cycle -> SCHED_FIFO POSIX thread with clock_nanosleep for deterministic timing' },
		{ sourceConstruct: 'VAR_GLOBAL i_StartButton AT %I*: BOOL; END_VAR',        targetConstruct: 'struct IoImage { bool startButton; };  // shared between IO-thread and logic thread with mutex', notes: 'PLC I/O image -> shared memory struct with spinlock or mutex; IO thread updates, logic thread reads' },
		{ sourceConstruct: 'TON_Instance(IN:=Condition, PT:=T#5S); q:=TON_Instance.Q;', targetConstruct: 'class TonTimer { bool update(bool in, std::chrono::milliseconds pt); bool q; };', notes: 'Implement IEC 61131-3 timer semantics in C++ class; call on every scan period' },
		{ sourceConstruct: 'SF_EmergencyStop(S_EStopIn:=EStop)',                    targetConstruct: 'SafetyManager::handleEStop(eStopSignal);  // dedicated safety class with SIL-compliant logic', notes: 'Safety FBs must map to verified C++ safety classes with identical state machine; raise decision for SIL certification' },
		{ sourceConstruct: 'Modbus_TCP_Read(IPAddr:="192.168.1.10")',               targetConstruct: 'auto ctx = modbus_new_tcp("192.168.1.10", 502); modbus_read_registers(ctx, addr, nb, tab_reg);', notes: 'Use libmodbus; run in dedicated IO thread; share data via protected IO image struct' },
		{ sourceConstruct: 'OPCUA_Write(NodeId:=..., Value:=...)',                  targetConstruct: 'UA_Client_writeValueAttribute(client, nodeId, &value);  // open62541',   notes: 'OPC-UA write via open62541 client; run in separate thread; protect with mutex around shared state' },
		{ sourceConstruct: 'ALARM(Signal:=FaultCondition, Message:="Fault")',       targetConstruct: 'AlarmManager::raise(AlarmCode::FAULT, "Fault description");',            notes: 'Alarm management class with severity, acknowledgement, and timestamping' },
		{ sourceConstruct: 'RETAIN VAR  (* persistent variable *)',                 targetConstruct: 'nlohmann::json state; std::ofstream("state.json") << state;  // JSON persistence', notes: 'PLC RETAIN variables -> persisted JSON or SQLite; write on clean shutdown, restore on startup' },
	],

	conventionNotes: [
		'Call mlockall(MCL_CURRENT | MCL_FUTURE) at startup to prevent page faults in RT threads',
		'All RT threads must use SCHED_FIFO with priority 80-99; non-RT threads <= 50',
		'Scan period jitter: measure with clock_gettime(CLOCK_MONOTONIC); alert if > 10% of period',
		'IO image struct access must be protected with std::mutex or a lock-free ring buffer for ISR->thread',
		'Safety-critical logic must run in a separate high-priority thread with independent watchdog',
		'Logging via spdlog (async, non-blocking) -- never std::cout in RT threads',
		'Apply IEC 62443 Zone/Conduit model: OPC-UA interface in DMZ zone, control logic in control zone',
	],

	warningPatterns: [
		'Safety function blocks -- raise blocking decision: C++ replacement must have equivalent SIL certification evidence',
		'Timer resolution < 1ms -- raise decision: PREEMPT-RT jitter under load must be characterised on target hardware',
		'Large scan programs (> 1000 rungs) -- raise decision: decompose into subsystem threads with defined cycle times',
		'RETAIN variables with large data -- raise decision: JSON serialisation adds latency; consider mmap-backed persistence',
		'OPC-UA over untrusted network -- raise IEC 62443 decision: TLS certificate management and user authentication required',
	],
};


// --- Modbus C -> OPC-UA C++ ----------------------------------------------------

const MODBUS_TO_OPCUA: ILanguagePairProfile = {
	sourceLang: 'c',
	targetLang: 'cpp',
	label: 'Modbus RTU/TCP C -> OPC-UA C++ (open62541)',
	targetFramework: 'open62541 v1.3+ / OPC-UA Part 4',
	targetTestFramework: 'GoogleTest + OPC-UA Compliance Test Tool',
	targetFileExtension: 'cpp',

	systemPersona: `You are an industrial IoT architect with deep expertise in migrating Modbus (RTU and TCP) polling-based SCADA integrations to OPC-UA publish-subscribe and client-server architectures using the open62541 open-source C SDK. You understand Modbus FC01-FC06/FC15/FC16 function codes, register addressing, and how they map to OPC-UA nodes with the correct NodeClass (Variable, Method, Object), NodeId, and Access Level. You are familiar with OPC-UA Information Model design and the Companion Specification pattern for industrial equipment.`,

	idiomMap: [
		{ sourceConstruct: 'modbus_read_registers(ctx, addr, nb, regs)',             targetConstruct: 'UA_Client_readValueAttribute(client, UA_NODEID_NUMERIC(nsIdx, nodeId), &value)',  notes: 'Modbus read coil/register -> OPC-UA readValue; map register address to NodeId' },
		{ sourceConstruct: 'modbus_write_register(ctx, addr, value)',                targetConstruct: 'UA_Client_writeValueAttribute(client, nodeId, &value)',               notes: 'Modbus write register -> OPC-UA writeValue; check AccessLevel = CurrentWrite on node' },
		{ sourceConstruct: 'while(1) { modbus_read_registers(...); sleep(period); }', targetConstruct: 'UA_Client_Subscriptions_create(...); UA_MonitoredItemCreateRequest mi; /* event-driven */', notes: 'Replace Modbus polling loop with OPC-UA monitored item subscription (publish-subscribe reduces network load)' },
		{ sourceConstruct: 'uint16_t holdingReg[125];  // register bank',            targetConstruct: 'UA_VariableNode with NodeId NS=2, Identifier=1001, DataType=UInt16, AccessLevel=RW', notes: 'Each Modbus register maps to an OPC-UA Variable node; define in Information Model' },
		{ sourceConstruct: 'FC01 read coils (bit outputs)',                          targetConstruct: 'UA_VariableNode DataType=Boolean, writable; or StatusCode-typed Variable', notes: '' },
		{ sourceConstruct: 'FC02 read discrete inputs (bit inputs)',                  targetConstruct: 'UA_VariableNode DataType=Boolean, AccessLevel=CurrentRead only',       notes: '' },
		{ sourceConstruct: 'FC03 read holding registers (output registers)',          targetConstruct: 'UA_VariableNode DataType=UInt16 or Float, AccessLevel=RW',              notes: 'Float if engineering unit scaling applied; include EUInformation extension object' },
		{ sourceConstruct: 'FC04 read input registers (sensor values)',               targetConstruct: 'UA_VariableNode DataType=Float, AccessLevel=CurrentRead, with AnalogItemType', notes: 'Use OPC-UA AnalogItemType for sensor values -- includes EURange and EUInformation' },
		{ sourceConstruct: 'modbus_set_slave(ctx, slaveId)',                         targetConstruct: '// OPC-UA has no slave ID concept -- device discovery via FindServers / Browse', notes: 'Raise decision: multiple Modbus slaves -> separate OPC-UA Server instances or OPC-UA Aggregation Proxy' },
		{ sourceConstruct: 'modbus_connect(ctx); if (rc == -1) retry...',           targetConstruct: 'UA_ClientConfig_setDefault(&config); UA_Client_connect(client, "opc.tcp://host:4840")', notes: 'OPC-UA connection includes session establishment and security channel; configure SecurityMode' },
	],

	conventionNotes: [
		'Design the OPC-UA Information Model (Namespace, NodeIds, Object hierarchy) BEFORE writing code -- use a UaModeler or FreeOpcUa nodeset tool',
		'Node IDs must be stable across server restarts -- use numeric NodeIds defined in a header, not string-based auto-generated IDs',
		'Apply SecurityMode at minimum SignAndEncrypt for all production OPC-UA connections (IEC 62443 requirement)',
		'Add EUInformation (engineering unit description) to all AnalogItemType nodes',
		'Use OPC-UA Methods (not Variable writes) for actuator commands -- they provide a call-response semantic with argument validation',
		'Log all write operations with timestamp and caller identity for IEC 62443 audit trail',
	],

	warningPatterns: [
		'Modbus address-to-NodeId mapping gaps -- raise blocking decision: all 125 holding registers must be explicitly mapped to named nodes with documented semantics',
		'Modbus CRC error handling -> OPC-UA Bad status codes -- raise decision: error propagation strategy needed (bad quality, null value, or alarm)',
		'Multiple masters -- raise decision: OPC-UA server handles multiple concurrent clients natively; document access control per client certificate',
		'High-frequency Modbus polling (< 100ms) -- raise decision: OPC-UA monitored item sampling interval must match; server capability check required',
	],
};


// --- NXP SDK / MCUXpresso C Migration ----------------------------------------

const REGISTER_DIRECT_TO_NXP_SDK: ILanguagePairProfile = {
	sourceLang: 'c',
	targetLang: 'c',
	label: 'Register-direct C -> NXP SDK / MCUXpresso',
	targetFramework: 'NXP MCUXpresso SDK v2.x',
	targetTestFramework: 'Unity + MCUXpresso IDE HIL',
	targetFileExtension: 'c',

	systemPersona: `You are a senior NXP MCU firmware architect specialising in migrating bare-metal register-direct code to the NXP MCUXpresso SDK. You have deep knowledge of NXP Kinetis, LPC, i.MX RT, and S32K register maps, and how they map to MCUXpresso SDK HAL/LL driver APIs. You understand FRDM board BSP configurations, clock management (CLOCK_EnableClock, CLOCK_AttachClk), and the SDK's hardware abstraction for GPIO, UART, SPI, I2C, ADC, DMA, and FlexCAN. You are familiar with AUTOSAR compliance requirements for NXP S32K automotive MCUs and NXP's S32 Design Studio.`,

	idiomMap: [
		{ sourceConstruct: 'SIM->SCGC5 |= SIM_SCGC5_PORTA_MASK;  // Kinetis clock gate', targetConstruct: 'CLOCK_EnableClock(kCLOCK_PortA);', notes: 'NXP SDK clock gating via CLOCK_EnableClock() from fsl_clock.h' },
		{ sourceConstruct: 'GPIOA->PDOR |= (1U << pin);  // set high',                  targetConstruct: 'GPIO_PinWrite(GPIOA, pin, 1U);', notes: 'GPIO_PinWrite from fsl_gpio.h' },
		{ sourceConstruct: 'GPIOA->PDDR |= (1U << pin);  // output direction',           targetConstruct: 'gpio_pin_config_t cfg = {kGPIO_DigitalOutput, 0}; GPIO_PinInit(GPIOA, pin, &cfg);', notes: '' },
		{ sourceConstruct: 'UART0->D = byte;  // Kinetis UART transmit',                 targetConstruct: 'UART_WriteByte(UART0, byte);  // or UART_WriteBlocking()', notes: 'NXP SDK UART from fsl_uart.h; use _IRQ or _EDMA variants for DMA' },
		{ sourceConstruct: 'SPI0->D = txByte; while(!(SPI0->S & SPI_S_SPRF_MASK)); rx = SPI0->D;', targetConstruct: 'SPI_MasterTransferBlocking(SPI0, &xfer);', notes: 'Build spi_transfer_t with txData/rxData pointers; non-blocking: SPI_MasterTransferNonBlocking' },
		{ sourceConstruct: 'ADC0->SC1[0] = channel; while(!(ADC0->SC1[0] & ADC_SC1_COCO_MASK)); val = ADC0->R[0];', targetConstruct: 'ADC_DoAutoCalibration(ADC0); ADC_SetChannelConfig(ADC0, 0, &adc_cfg); val = ADC_GetChannelConversionValue(ADC0, 0);', notes: 'Always run DoAutoCalibration first; use ADC_EnableHardwareTrigger for production' },
		{ sourceConstruct: 'FlexCAN: CAN0->MCR = CAN_MCR_MDIS_MASK;  // disable',       targetConstruct: 'FLEXCAN_Init(CAN0, &flexcan_config, CLOCK_GetFreq(kCLOCK_BusClk));', notes: 'NXP FlexCAN from fsl_flexcan.h; use FLEXCAN_SetRxMbConfig + FLEXCAN_SetTxMbConfig for mailbox setup' },
		{ sourceConstruct: 'PIT->CHANNEL[0].LDVAL = period - 1; PIT->MCR = 0;',         targetConstruct: 'PIT_SetTimerPeriod(PIT, kPIT_Chnl_0, USEC_TO_COUNT(period_us, CLOCK_GetBusClkFreq())); PIT_StartTimer(PIT, kPIT_Chnl_0);', notes: '' },
		{ sourceConstruct: 'NVIC_EnableIRQ(UART0_IRQn); NVIC_SetPriority(UART0_IRQn, pri);', targetConstruct: 'EnableIRQ(UART0_IRQn); NVIC_SetPriority(UART0_IRQn, pri);', notes: 'NXP SDK wraps NVIC via EnableIRQ / DisableIRQ from fsl_common.h' },
	],

	conventionNotes: [
		'All peripherals gated by CLOCK_EnableClock() before any register access',
		'Pin muxing via PORT_SetPinMux(PORT, pin, kPORT_MuxAlt2) from fsl_port.h',
		'DMA transfers use EDMA driver (fsl_edma.h) with EDMA_CreateHandle and EDMA_SubmitTransfer',
		'Use PRINTF() macro for debug output (redirected via SDK debug console to UART)',
		'Wrap all SDK calls in status-code checks: assert(kStatus_Success == result)',
	],

	warningPatterns: [
		'Raw FlexCAN mailbox arbitration -- raise decision: NXP SDK FlexCAN requires explicit mailbox configuration per message ID',
		'Clock configuration conflict between bus and peripheral clock -- raise decision: verify CLOCK_AttachClk matches the peripheral\'s expected clock source',
		'Kinetis DMA mux channel conflicts -- raise note: each DMA channel can only service one peripheral; document channel assignments',
		'Mixing Kinetis register-direct and NXP SDK API on same peripheral -- raise blocking decision; inconsistency will cause silent failures',
	],
};


// --- AUTOSAR Classic SWC -> AUTOSAR Adaptive (Enhanced) -----------------------

const AUTOSAR_CP_TO_AP_ENHANCED: ILanguagePairProfile = {
	sourceLang: 'autosar',
	targetLang: 'cpp',
	label: 'AUTOSAR Classic SWC -> Adaptive (Full Migration)',
	targetFramework: 'AUTOSAR Adaptive Platform R22-11 (ara::com, ara::exec, ara::diag)',
	targetTestFramework: 'GoogleTest + vECU / SIL simulation (Vector vVIRTUALtarget)',
	targetFileExtension: 'cpp',

	systemPersona: `You are an AUTOSAR Adaptive Platform migration expert with production experience in SOP-grade automotive software at Tier 1 suppliers. You know the full AUTOSAR AP R22-11 stack: ara::com (SOME/IP, DDS), ara::exec (Adaptive Application lifecycle, Process manifest), ara::diag (UDS diagnostic monitor), ara::log (DLT logging), ara::per (Key-Value Store, File Storage), ara::crypto, and ara::iam. You translate Classic CP SWC arxml port interfaces to AP Service Interface ARXML manifests and generate the corresponding Skeleton/Proxy C++ code structure. You understand E2E protection transformer configuration in AP and how it maps to com::E2EXf in CP.`,

	idiomMap: [
		{ sourceConstruct: 'Rte_Read_<PortName>_<SignalName>(&value)',                   targetConstruct: 'auto result = proxy_->signalName.Get(); if (result.HasValue()) value = result.Value();', notes: 'CP Rte_Read -> AP field Get() on ara::com Proxy; handle ara::core::Result<T> error' },
		{ sourceConstruct: 'Rte_Write_<PortName>_<SignalName>(value)',                   targetConstruct: 'skeleton_->signalName.Update(value);  // ara::com Skeleton field Update triggers SOME/IP notification', notes: '' },
		{ sourceConstruct: 'Rte_Call_<PortName>_<Op>(<args>)',                           targetConstruct: 'auto future = proxy_->Op(args); auto result = future.get();  // or fire-forget: proxy_->Op.Fire(args)', notes: 'method call returns ara::core::Future<Output>; use .get() for synchronous result' },
		{ sourceConstruct: 'Dem_SetEventStatus(eventId, DEM_EVENT_STATUS_FAILED)',       targetConstruct: 'diagnosticMonitor_->ReportMonitorAction(MonitorAction::kFailed);', notes: 'AP diagnostic monitor registered in manifest; action types: kFailed, kPassed, kPrepFailed, kPrepPassed' },
		{ sourceConstruct: 'NvM_ReadBlock(blockId, &buffer)',                            targetConstruct: 'auto kv = ara::per::OpenKeyValueStorage("appData").Value(); auto val = kv->GetValue<T>("key").Value();', notes: 'NvM block -> ara::per KVS; key names defined in per::KvsDatabase manifest element' },
		{ sourceConstruct: 'Com_SendSignal(signalId, &value)',                           targetConstruct: 'skeleton_->event.Send(value);  // ara::com event; subscriber callbacks triggered automatically', notes: '' },
		{ sourceConstruct: 'OsTask_10ms: TASK(My10msTask)',                              targetConstruct: 'class MyApplication : public ara::exec::ExecutionClient { void Run() override { while (!shutdownRequested_) { doWork(); k_msleep(10); } } }', notes: 'CP OS task -> AP Run() with internal timing; or use ExecutionClient::RequestState(kRunning)' },
		{ sourceConstruct: 'E2E_P02Protect(&p02State, &headerConfig, dataPtr, length)', targetConstruct: '// Configured via ara::com E2EXf transformer in service manifest -- automatic at serialisation', notes: 'AP E2E protection is manifest-driven; raise decision if manual E2E control required' },
		{ sourceConstruct: 'Dcm_ReadDataByIdentifier(did, response)',                   targetConstruct: 'class DidReadHandler : public ara::diag::GenericUDSService { ara::core::Result<ara::diag::ByteVector> HandleMessage(const ara::diag::UDSRequestContext&) override; };', notes: 'DID handlers registered in diag::DiagnosticServer manifest element' },
	],

	conventionNotes: [
		'Every AP Service Interface must have a complete ARXML ServiceInterface + ProvidedSomeipServiceInstance manifest before generating Skeleton/Proxy code',
		'Use ara::core::Result<T, ErrorCode> for all fallible operations; never use exceptions on the safety path',
		'ara::log replaces all DLT_LOG calls; use LogStream: logger_.LogInfo() << "message" << value',
		'Process manifest (EXEC) must declare ExecutionDependency for init order and ResourceGroup for CPU/memory budget',
		'AP crypto operations use ara::crypto::cryp::CryptoProvider; do not use OpenSSL directly',
		'All SOME/IP method calls must have timeout configuration in the service manifest',
	],

	warningPatterns: [
		'CP SWC with multiple concurrent runnables sharing IVR -- raise design decision: AP executables are single-threaded by default; use std::mutex or message queues',
		'High-rate runnable (< 1ms) -- raise decision: AP scheduler minimum granularity is platform-dependent; characterise jitter on target HW',
		'SWC with vendor-specific RTE extensions (e.g. Vector RTE, EB tresos) -- raise blocking decision: vendor RTE extensions have no direct AP equivalent',
		'DEM events with SIL 3+ ASIL classification -- raise blocking decision: AP diagnostic monitor requires type approval for ASIL-D paths',
		'Dual-fuel SOME/IP + CAN transport -- raise design decision: AP supports SOME/IP over Ethernet only; legacy CAN signals require AP Gateway Proxy pattern',
	],
};


// --- CAN DBC -> CANopen / CAN-FD ----------------------------------------------

const CAN_DBC_TO_CANOPEN: ILanguagePairProfile = {
	sourceLang: 'can-dbc',
	targetLang: 'c',
	label: 'CAN DBC Legacy -> CANopen / CAN-FD C',
	targetFramework: 'CANopen (CiA 301 / DS-402) + CAN-FD',
	targetTestFramework: 'CANalyzer / CAPL + Unity',
	targetFileExtension: 'c',

	systemPersona: `You are a CAN network architect with deep expertise in migrating legacy fixed-frame CAN DBC signal databases to CANopen (CiA 301/302) object dictionary designs and CAN-FD extended frames. You understand signal scaling (factor/offset), byte order (Intel/Motorola), PDO mapping, SDO configuration, NMT state machines, and CANopen Safety (CiA 304) for functional safety applications. You translate DBC messages to CANopen PDOs with correct TPDO/RPDO mapping, SDO parameters, and heartbeat/SYNC producer configuration.`,

	idiomMap: [
		{ sourceConstruct: 'BO_ 0x181 StatusMsg: 8 ECU1  // DBC message definition',    targetConstruct: '/* CANopen TPDO 1: Node 0x01, COB-ID 0x181 */ OD_entry_t TPDO1_mapping[] = {{0x6041, 0}, {0x6064, 0}};', notes: 'DBC message COB-ID -> CANopen PDO COB-ID; map signals to object dictionary sub-indices' },
		{ sourceConstruct: 'SG_ MotorSpeed : 0|16@1+ (0.1,0) [0|6000] "rpm" ECU2',     targetConstruct: '/* OD Index 0x6041: Statusword UINT16 / 0x6064: Position INT32 */ -- raise decision for exact mapping', notes: 'DBC signal -> OD object: choose standard CiA 402 index or manufacturer-specific 0x2000+ range' },
		{ sourceConstruct: 'BO_ 0x201 ControlMsg: 2 ECU2  // command message',           targetConstruct: '/* CANopen RPDO 1: COB-ID 0x201 */ OD_entry_t RPDO1_mapping[] = {{0x6040, 0}};  // Controlword', notes: 'Command DBC message -> RPDO; write to controlword (0x6040) for CiA 402 motion profile' },
		{ sourceConstruct: 'cycle_time = 10ms;  // DBC message attribute',               targetConstruct: '/* TPDO comm param 0x1800: transmission type = 0xFE (event-driven) or 0x01 (every SYNC) + inhibit time + event timer */', notes: 'Set OD 0x1800 sub-3 (inhibit time) and sub-5 (event timer) to match legacy cycle time' },
		{ sourceConstruct: 'VALUE_TABLE SG_ StatusCode 0 "OK" 1 "Warning" 2 "Fault"',  targetConstruct: '/* OD 0x6041 bit field: bit0=Ready, bit1=Switched_On, bit2=OP_Enabled, bit3=Fault */',  notes: 'Map DBC enum values to CiA 402 Statusword bit definitions' },
		{ sourceConstruct: 'signal_factor = 0.01; signal_offset = -100;  // DBC SG_',  targetConstruct: '/* OD ComAxis: value * 0.01 - 100 -- store raw INT value, document scaling in description string */', notes: 'CANopen has no built-in scale/offset; document conversion in object description and apply in application layer' },
		{ sourceConstruct: 'Checksum: SG_ CRC : 56|8@1+',                              targetConstruct: '/* CANopen Safety: CiA 304 -- add SCET or SNODE for SIL 2/3 messages */', notes: 'DBC CRC field -> CANopen Safety payload; raise decision for SIL certification scope' },
	],

	conventionNotes: [
		'All standard drive objects must use CiA 402 (DS-402) device profile index range 0x6000-0x9FFF',
		'Manufacturer-specific objects go in range 0x2000-0x5FFF with full description string',
		'NMT boot sequence: Boot -> Pre-Operational (configure PDO/SDO) -> Operational',
		'Each CANopen node must produce a heartbeat (0x700 + NodeID) with period <= 1000ms',
		'SYNC producer sets COB-ID 0x80; SYNC consumers set synchronous window length at 0x1007',
		'CAN-FD frames use DLC > 8: map large DBC payloads to CAN-FD Extended Frame with BRS bit',
	],

	warningPatterns: [
		'DBC multiplexed signals -- raise design decision: CANopen has no native multiplex; use separate PDOs or SDO segmented transfer',
		'Messages with cycle time < 1ms -- raise decision: CANopen SYNC minimum cycle 0.1ms; verify CAN bus load at 1Mbit/s',
		'More than 8 TPDO/RPDO per node -- raise design decision: CiA 301 supports 512 PDOs; but most slave implementations limit to 4-8',
		'DBC signals crossing byte boundaries with Motorola byte order -- raise note: ensure CANopen PDO mapping preserves byte order',
		'Safety-classified signals -- raise blocking decision: CANopen Safety (CiA 304) requires SIL analysis and dedicated FSCP/SCET protocol',
	],
};


// --- IEC 61850 / Energy -> OPC-UA / MQTT --------------------------------------

const IEC61850_TO_OPCUA_MQTT: ILanguagePairProfile = {
	sourceLang: 'iec61131',
	targetLang: 'cpp',
	label: 'IEC 61850 Substation / SCADA -> OPC-UA + MQTT',
	targetFramework: 'open62541 OPC-UA + Mosquitto MQTT + IEC 62443 security',
	targetTestFramework: 'GoogleTest + OPC-UA CTT + Wireshark trace',
	targetFileExtension: 'cpp',

	systemPersona: `You are a critical infrastructure systems architect with deep expertise in IEC 61850 substation automation, DNP3, and IEC 62443 industrial cybersecurity. You migrate IEC 61850 SCL/SSD models and DNP3 data point databases to OPC-UA information models and MQTT-based OT/IT convergence architectures. You understand GOOSE and Sampled Values multicast semantics, SCADA RTU/MTU polling patterns, and how to bridge them to OPC-UA publish-subscribe and MQTT SparkplugB. You are meticulous about IEC 62443 Zone/Conduit security models, TLS certificate chains, and role-based access control for OPC-UA sessions.`,

	idiomMap: [
		{ sourceConstruct: 'XCBR1.Pos.stVal = TRUE;  // IEC 61850 logical node status',  targetConstruct: 'UA_Variant_setScalar(&val, &stVal, &UA_TYPES[UA_TYPES_BOOLEAN]); UA_Server_writeValue(server, nodeId_XCBR1_Pos, val);', notes: 'IEC 61850 logical node attribute -> OPC-UA Variable node; maintain naming XCBR1/Pos in NodeId string' },
		{ sourceConstruct: 'GoosePublisher_publish(publisher, dataset)',                  targetConstruct: 'UA_Server_createSubscription(server, UA_SubscriptionParameters_default, ...);  // or MQTT retain publish', notes: 'GOOSE multicast publish -> OPC-UA event or MQTT retained topic; raise decision on latency requirements' },
		{ sourceConstruct: 'DNP3_UpdateAnalog(outstation, index, value, DNP3_QUALITY_ONLINE)', targetConstruct: 'UA_Server_writeValue(server, analogNodeId, val); // + quality StatusCode', notes: 'DNP3 analog point -> OPC-UA Variable with StatusCode (UA_STATUSCODE_GOOD / UNCERTAIN_SENSOR_FAILURE)' },
		{ sourceConstruct: 'IedServer_handleWriteAccess(server, dataAttribute, callback)', targetConstruct: 'UA_MethodCallback writeCallback; UA_Server_addMethodNode(server, nodeId, ..., writeCallback, ...);', notes: 'IEC 61850 controlled attributes -> OPC-UA Method node (select-before-operate = two-step method call)' },
		{ sourceConstruct: 'scada_rtu_poll(rtu_addr, fc03, start_reg, count, buffer)',   targetConstruct: 'UA_Client_Subscriptions_create(client, params, NULL, NULL, NULL);  // event-driven subscription replaces polling', notes: 'RTU Modbus FC03 polling -> OPC-UA monitored item subscription; set publishingInterval = legacy poll period' },
		{ sourceConstruct: 'GOOSE cbName="LLN0$GO$gcbAlarm" appId=0x0001',             targetConstruct: 'mqtt_publish(client, "plant/substationA/alarms/XCBR1", payload, qos2, retain=true);  // SparkplugB DDATA', notes: 'GOOSE -> MQTT SparkplugB DDATA message; preserve appId -> metric tag' },
		{ sourceConstruct: 'IEC_62443_ZoneConduit: Control Zone -> DMZ -> IT Network',  targetConstruct: '/* OPC-UA SecurityMode=SignAndEncrypt, TLS 1.3, mTLS client certs per zone boundary */', notes: 'Map IEC 62443 Zone/Conduit model to OPC-UA SecurityPolicy; raise decision for firewall rule set' },
	],

	conventionNotes: [
		'OPC-UA NodeIds for IEC 61850 attributes must follow the companion specification IEC 62541-200 naming convention',
		'All control operations (XCBR trip/close) must use OPC-UA Method with SelectBeforeOperate for SBO mode',
		'Apply IEC 62443 SecurityLevel >= SL2: TLS 1.3, certificate pinning, RBAC user/role authorisation',
		'MQTT broker: use mTLS client certs per zone; subscribe ACLs restrict each device to its own topic tree',
		'Historian tag writes must include source timestamp (ServerTimestamp + SourceTimestamp in OPC-UA)',
		'GOOSE latency <= 4ms: if replacing with OPC-UA/MQTT cannot meet this, retain GOOSE for protection relay paths',
	],

	warningPatterns: [
		'GOOSE protection trip messages (t-class 1/2) -- raise BLOCKING decision: OPC-UA over Ethernet cannot guarantee < 4ms; retain IEC 61850 GOOSE',
		'More than 10,000 OPC-UA nodes -- raise design decision: server startup time and browse performance; consider namespace partitioning',
		'DNP3 quality flags (ONLINE/RESTART/COMM_LOST) -- raise decision: map to OPC-UA StatusCode explicitly; do not lose quality info',
		'Unauthenticated SCADA legacy connection -- raise IEC 62443 blocking decision: all new connections must use TLS + certificate auth',
		'SIS/ESD signals bridged to MQTT/cloud -- raise BLOCKING decision: safety instrumented systems must never have cloud write-back paths',
	],
};


// --- TTCN-3 / Telecom Protocol Testing ---------------------------------------

const TTCN3_TO_PYTEST_RF: ILanguagePairProfile = {
	sourceLang: 'c',
	targetLang: 'python',
	label: 'TTCN-3 / Telecom Protocol Testing -> PyTest + Scapy / Robot Framework',
	targetFramework: 'PyTest + Scapy + Robot Framework + Open5GS / srsRAN',
	targetTestFramework: 'PyTest CI + RF CTRF reporter',
	targetFileExtension: 'py',

	systemPersona: `You are a 5G/LTE protocol testing architect migrating TTCN-3 conformance test suites to Python-based integration test frameworks. You understand TTCN-3 module structure, altstep, testcase, port types (PCO/TSI), and verdict handling. You translate TTCN-3 message templates to Scapy or a 3GPP ASN.1 Python codec, map TTCN-3 port communication to socket/gRPC, and translate verdict: pass/fail/inconc to pytest assertion patterns. You are familiar with 3GPP TS 36.523 (LTE) and TS 38.523 (5G NR) test specification structure.`,

	idiomMap: [
		{ sourceConstruct: 'testcase TC_RRC_001() runs on MTC_CT { ... verdict := pass; setverdict(pass); }', targetConstruct: 'def test_rrc_001(ue_simulator, gnb_fixture):\n    # test body\n    assert result == expected, "RRC setup failed"', notes: 'TTCN-3 testcase -> PyTest test function; verdict pass = assert passes; inconc = pytest.skip()' },
		{ sourceConstruct: 'altstep as_Receive() { [] pco.receive(msg) { ... } [] T_guard.timeout { setverdict(fail); }', targetConstruct: 'result = pco.recv(timeout=T_GUARD_SEC)\nif result is None: pytest.fail("Timeout waiting for message")', notes: 'TTCN-3 alt with timer guard -> Python recv with timeout' },
		{ sourceConstruct: 'template RRC_SetupRequest t_rrc_req := {ue_identity := {c_rnti := ?}, cause := mt_access};', targetConstruct: 'def make_rrc_setup_req(rnti, cause="mt-Access"):\n    return RRCSetupRequest(ue_identity={"c-rnti": rnti}, establishment_cause=cause)', notes: 'TTCN-3 template with wildcard -> Python factory function; wildcard ? -> pytest.approx or isinstance check' },
		{ sourceConstruct: 'pco.send(rrc_msg) to ue;',                                  targetConstruct: 'gnb.send_rrc(ue_id, rrc_msg)',  notes: 'TTCN-3 port send to component -> call simulator/stub send method' },
		{ sourceConstruct: 'module RRC_Tests { import from RRC_Templates all; }',       targetConstruct: 'from rrc_templates import *  # Python module import',  notes: 'TTCN-3 module import -> Python module import' },
		{ sourceConstruct: 'timer T_RRC_Setup := 5.0; T_RRC_Setup.start; ... T_RRC_Setup.stop;', targetConstruct: 'import time; t_start = time.monotonic(); ...; elapsed = time.monotonic() - t_start; assert elapsed < 5.0', notes: '' },
		{ sourceConstruct: 'execute(TC_RRC_001(), 60.0);  // test control',             targetConstruct: 'pytest.main(["-v", "test_rrc.py::test_rrc_001", "--timeout=60"])',  notes: '' },
	],

	conventionNotes: [
		'Use pytest-timeout plugin for per-test execution time limits matching TTCN-3 guard timers',
		'3GPP ASN.1 codec: use pyasn1 or asn1tools for encoding/decoding NAS/RRC messages',
		'Test verdicts: pass = assertion success, inconc = pytest.skip(), fail = assertion failure or exception',
		'Port communication: mock with unittest.mock or use real srsRAN/Open5GS integration fixtures',
		'Use Robot Framework for acceptance test suites targeting operators; PyTest for unit/integration tests',
	],

	warningPatterns: [
		'TTCN-3 parallel test components (PTC) -- raise decision: Python async/threading needed; use pytest-asyncio',
		'Vendor-specific TTCN-3 codecs (TTworkbench, Eclipse Titan) -- raise decision: need Python equivalent codec',
		'ASN.1 SEQUENCE OF with unbounded size -- raise decision: memory limit in Python codec differs from TTCN-3 runtime',
		'TTCN-3 external functions (C EF) -- raise design decision: wrap C EF in Python ctypes / cffi',
	],
};


// --- 3GPP LTE/5G Stack Migration ---------------------------------------------

const LTE_STACK_TO_ORAN: ILanguagePairProfile = {
	sourceLang: 'c',
	targetLang: 'cpp',
	label: '3GPP LTE Monolithic Stack -> O-RAN Disaggregated C/C++',
	targetFramework: 'O-RAN Alliance WG4 (CU/DU Split) + srsRAN / OpenAirInterface',
	targetTestFramework: 'GoogleTest + ORAN-SC CI + RF Tester',
	targetFileExtension: 'cpp',

	systemPersona: `You are a 5G RAN software architect with experience disaggregating monolithic LTE eNB stacks into O-RAN-compliant CU (Central Unit) and DU (Distributed Unit) components. You understand the F1-AP (CU-DU), E1-AP (CU-CP/CU-UP), and NG-AP (CU-CN) interface protocols, the ORAN fronthaul Category A/B split, and how to map legacy tightly-coupled L1/L2/L3 function boundaries to the O-RAN functional split. You are familiar with PDCP/RLC/MAC layer API design, HARQ process management, and timing-critical L1 scheduling in DPDK/FPGA-offload environments.`,

	idiomMap: [
		{ sourceConstruct: 'enb_process_rrc_msg(msg, ue_context)',                       targetConstruct: 'CU_CP::RRCHandler::handleMessage(const F1AP_ULRRCMessage&, UEContext&)',  notes: 'Monolithic RRC -> CU-CP RRC entity receiving via F1-AP UL RRC Transfer' },
		{ sourceConstruct: 'pdcp_rx_deliver_to_upper(pdu, rb_id)',                       targetConstruct: 'CU_UP::PDCPEntity::deliverToUpper(const PDCP_SDU&, RadioBearerId)',  notes: 'PDCP RX in monolith -> CU-UP PDCP entity; user plane splits CU-CP from CU-UP at E1-AP' },
		{ sourceConstruct: 'rlc_tx_enqueue(sdu, lcid)',                                  targetConstruct: 'DU::RLCEntity::enqueueTx(const RLC_SDU&, LogicalChannelId)',  notes: 'RLC entity stays in DU; CU sends PDCP PDUs to DU via F1-U (GTP-U over UDP)' },
		{ sourceConstruct: 'mac_schedule_ue(ue_id, tbs, mcs)',                           targetConstruct: 'DU::MACScheduler::scheduleUE(RNTI, uint32_t tbs, MCSIndex mcs)',  notes: 'MAC scheduler in DU; HARQ process IDs must be tracked per UE per cell' },
		{ sourceConstruct: 'phy_send_dl_grant(rnti, prb_alloc)',                         targetConstruct: 'DU::L1Interface::sendDLGrant(RNTI, const PRBAllocation&)',  notes: 'L1 interface in DU; if FPGA-offload, L1 is below the DU fronthaul interface (Category A)' },
		{ sourceConstruct: 'security_apply_enc(pdu, key, alg)',                          targetConstruct: 'CU::SecurityContext::applyEncryption(PDCP_PDU&, const SecurityKey&, EEAAlgorithm)',  notes: 'Encryption in CU-UP PDCP entity; key material from CU-CP via E1-AP Security Context' },
		{ sourceConstruct: 'ue_attach_req_handler(nas_pdu)',                             targetConstruct: 'CU_CP::NGAPHandler::forwardToAMF(const InitialUEMessage&)',  notes: 'NAS forwarding: CU-CP receives from DU (F1-AP) and forwards to AMF (NG-AP Initial UE Message)' },
	],

	conventionNotes: [
		'CU-CP / CU-UP / DU are separate processes communicating over F1-AP/E1-AP/NG-AP (SCTP/UDP)',
		'All timing-critical paths (L1 scheduling, HARQ retx) must be deterministic: use SCHED_FIFO + mlockall in DU',
		'Security keys are CU-CP managed; never pass key material below the F1 interface in plaintext',
		'O-RAN M-Plane (management) uses NETCONF/YANG over TLS; C-Plane/U-Plane use eCPRI or RoE over Ethernet',
		'Use DPDK for high-throughput F1-U GTP-U forwarding in CU-UP; avoid kernel networking on data path',
	],

	warningPatterns: [
		'Tight L1-L2 timing loops (< 0.5ms) -- raise design decision: O-RAN split 7-2x requires FH latency < 150uss; characterise on target HW',
		'Shared global UE context between RRC/PDCP/RLC/MAC -- raise blocking decision: CU/DU split requires explicit context synchronisation over F1-AP',
		'Custom proprietary MAC scheduler -- raise decision: O-RAN-SC SCF022 E2 interface allows external RAN Intelligent Controller to override scheduler',
		'L2 measurements (RSRP, SINR) used in RRC decisions -- raise design decision: measurement reporting goes DU->CU via F1-AP MEASUREMENT_REPORT',
	],
};


// --- Generic Firmware Fallback ------------------------------------------------

const GENERIC_FIRMWARE_FALLBACK: ILanguagePairProfile = {
	sourceLang: 'c',
	targetLang: 'c',
	label: 'Generic Embedded Firmware Translation',
	targetFramework: 'Target-specific (specify in session options)',
	targetTestFramework: 'Unity / HIL',
	targetFileExtension: 'c',

	systemPersona: `You are a senior embedded systems engineer with expertise across multiple MCU families (ARM Cortex-M, RISC-V, AVR, PIC, ESP32), RTOS platforms (FreeRTOS, Zephyr, RTX, VxWorks), and embedded communication protocols (UART, SPI, I2C, CAN, Modbus, OPC-UA). You translate embedded C/C++ firmware with meticulous attention to hardware timing constraints, interrupt safety, watchdog requirements, and safety-critical compliance (IEC 61508, MISRA-C:2012). When context is insufficient to make a precise translation, you raise a decision rather than guess.`,

	idiomMap: [
		{ sourceConstruct: 'volatile uint32_t *reg = (volatile uint32_t*)ADDR',      targetConstruct: '/* BSP accessor */ uint32_t bsp_read_reg(uint32_t addr)',           notes: 'Isolate all MMIO into BSP layer; never scatter raw casts through application code' },
		{ sourceConstruct: 'void __attribute__((interrupt)) ISR_Name(void)',          targetConstruct: 'void ISR_Name_IRQHandler(void)  /* CMSIS naming */  -- deferred via queue', notes: 'ISR should be minimal: post event to queue and return; deferred processing in task' },
		{ sourceConstruct: 'while(!(REG & FLAG));  // polling busy-wait',             targetConstruct: '/* Replace with interrupt / DMA or timeout-guarded loop */',        notes: 'Raise decision: polling loops block other work; consider ISR + semaphore or DMA' },
		{ sourceConstruct: 'HAL_IWDG_Refresh() / WDT_Feed()',                        targetConstruct: 'Called from dedicated watchdog task or at fixed points in control loop', notes: 'Watchdog refresh must be architecturally guaranteed; document refresh strategy' },
		{ sourceConstruct: 'assert(expr)',                                            targetConstruct: 'configASSERT(expr) / __ASSERT(expr, msg) / MISRA-compliant handler', notes: 'Replace C assert() with RTOS or MISRA-specific assert macro' },
	],

	conventionNotes: [
		'Always specify the target MCU family and HAL/RTOS in session options before translating -- guidance adapts accordingly',
		'Every ISR must have documented maximum execution time',
		'All shared variables between ISR and task/main context must use atomic access or critical sections',
		'Zero-initialise all stack and static variables; never rely on undefined initial state',
	],

	warningPatterns: [
		'Raw peripheral register access outside BSP layer -- raise decision: isolate in BSP',
		'Missing watchdog refresh coverage after translation -- raise safety decision',
		'Shared mutable state between multiple interrupt levels -- raise concurrency decision',
	],
};


// --- IEC 61850 SCL/GOOSE/SV -> OPC-UA C++ (open62541) ------------------------

const IEC61850_SCL_TO_OPCUA_CPP: ILanguagePairProfile = {
	sourceLang: 'iec61850',
	targetLang: 'cpp',
	label: 'IEC 61850 SCL/GOOSE/SV -> OPC-UA C++ (open62541)',
	targetFramework: 'open62541 v1.3+ / OPC-UA Part 8 (PubSub) / IEC 62351 TLS',
	targetTestFramework: 'GoogleTest + OPC-UA CTT + Wireshark GOOSE trace',
	targetFileExtension: 'cpp',

	systemPersona: `You are a critical-infrastructure communications architect with production experience translating IEC 61850 Edition 2 substation automation systems (SCL/SSD/SCD, GOOSE, Sampled Values, MMS) to OPC-UA C++ using the open62541 SDK. You understand IEC 61850 Logical Node (LN) naming, Data Objects, Data Attributes, the SCL instantiation model, GOOSE publisher/subscriber semantics, and Sampled Values multicast. You know how to map LN classes to OPC-UA ObjectNodes, functional constraints (ST/MX/CO/SP/CF) to OPC-UA Variable access levels, and GOOSE/SV multicast to OPC-UA PubSub. You are meticulous about protection relay timing constraints (GOOSE t-class <= 4ms) and know which paths must never be migrated to OPC-UA.`,

	idiomMap: [
		{ sourceConstruct: 'XCBR1/LLN0$CO$Pos$Oper  // IEC 61850 breaker control attribute', targetConstruct: 'UA_NodeId nodeId = UA_NODEID_STRING(nsIdx, "XCBR1_Pos_Oper"); UA_Server_addMethodNode(server, nodeId, ...)', notes: 'CO (control) functional constraint -> OPC-UA Method with select-before-operate pattern; NEVER map protection trip to standard Variable write' },
		{ sourceConstruct: 'XCBR1/Pos.stVal  // status value read',                           targetConstruct: 'UA_NodeId stValNode = UA_NODEID_STRING(nsIdx, "XCBR1_Pos_stVal"); UA_Server_writeValueAttribute(server, stValNode, &variant);', notes: 'ST (status) data attribute -> OPC-UA Variable node; update on change with UA_Server_writeValueAttribute' },
		{ sourceConstruct: 'iedSetGooseEnable(gooseConfig, TRUE)  // enable GOOSE publisher', targetConstruct: 'UA_Server_addMethodNode(server, nodeId_GOOSEEnable, ...);  // monitoring notification only -- NOT for protection', notes: 'GOOSE enable -> OPC-UA server-side method or event notification; raise BLOCKING decision if used on protection relay path' },
		{ sourceConstruct: 'GoosePublisher_publish(publisher, dataset)  // GOOSE multicast', targetConstruct: 'UA_Server_triggerEvent(server, eventNodeId, UA_NODEID_NUMERIC(0, UA_NS0ID_SERVER), &eventAttr, UA_FALSE);', notes: 'GOOSE dataset publish -> OPC-UA event trigger on monitoring path only; t-class 1/2 GOOSE must stay IEC 61850; raise BLOCKING decision' },
		{ sourceConstruct: 'SampledValuesReceiver_subscribe(subscriber, cb)  // IEC 61850-9-2 SV', targetConstruct: 'UA_Server_addMonitoredItem_DataChange(server, subscId, itemReq, ...);  // UA PubSub Subscriber ReaderGroup', notes: 'SV multicast subscriber -> OPC-UA PubSub DataSetReader; map ASDU count to PublishingInterval' },
		{ sourceConstruct: 'MmsServer_getNameList(mmsServer, domain)  // MMS GetNameList',  targetConstruct: 'UA_Client_getEndpoints(client, "opc.tcp://host:4840", &endpointCount, &endpoints);', notes: 'MMS GetNameList service -> OPC-UA Browse / GetEndpoints; domain -> Namespace' },
		{ sourceConstruct: 'MmsValue_getBoolean(mmsValue)  // MMS data value read',          targetConstruct: 'UA_Variant val; UA_Client_readValueAttribute(client, nodeId, &val); bool v = *(UA_Boolean*)val.data;', notes: 'MMS typed value -> OPC-UA Variant with DataType matching IEC 61850 basic type' },
		{ sourceConstruct: 'IedServer_handleWriteAccess(server, da, accessHandler, ctx)',    targetConstruct: 'UA_MethodCallback writeHandler; UA_Server_setMethodNodeCallback(server, methodNodeId, writeHandler);', notes: 'IEC 61850 write-access handler -> OPC-UA Method callback with argument validation' },
		{ sourceConstruct: 'SCL LogicalNode class XCBR -- IEC 61850-7-4 LN definition',      targetConstruct: 'UA_ObjectNode mapped to IEC 62541-200 companion spec NodeId NS=http://opcfoundation.org/UA/IEC61850/', notes: 'LN class -> OPC-UA ObjectNode; use IEC 62541-200 OPC-UA IEC 61850 companion specification NodeIds for interoperability' },
		{ sourceConstruct: 'IEC 61850 Edition 1 MMS client -- MMS_Connect()',                targetConstruct: 'UA_Client *client = UA_Client_new(); UA_ClientConfig_setDefault(UA_Client_getConfig(client));', notes: 'Edition 1 MMS -> open62541 OPC-UA Client; map to Edition 2 open62541 API; raise decision on edition transition compatibility' },
		{ sourceConstruct: 'IED_CONNECT(ied, host, port)  // libIEC61850 client connect',   targetConstruct: 'UA_Client_connect(client, "opc.tcp://host:4840")  // OPC-UA SecureChannel + Session', notes: 'TLS: configure UA_ClientConfig.securityMode = UA_MESSAGESECURITYMODE_SIGNANDENCRYPT per IEC 62351-4' },
		{ sourceConstruct: 'stNum / sqNum  // GOOSE state/sequence numbers',                 targetConstruct: '// OPC-UA EventNotifier: SequenceNumber field in EventNotification; raise design decision for mapping', notes: 'GOOSE state number semantics differ from OPC-UA event sequence; document transition protocol' },
		{ sourceConstruct: 'IEC 61850 quality bit: validity=QUESTIONABLE',                  targetConstruct: 'UA_StatusCode = UA_STATUSCODE_UNCERTAINSENSORFAILURE  // OPC-UA quality code', notes: 'Map IEC 61850 quality flags to OPC-UA StatusCode per IEC 62541-200 Table A.1' },
	],

	conventionNotes: [
		'Use the IEC 62541-200 OPC-UA / IEC 61850 companion specification NodeIds for all LN, DO, and DA nodes -- do not invent custom naming',
		'Control operations (CO functional constraint) MUST use OPC-UA Method with SBO (Select-Before-Operate) -- never plain Variable write',
		'Apply IEC 62351-4 (MMS/OPC-UA security) and IEC 62351-8 (RBAC): SecurityMode=SignAndEncrypt, mTLS client certificates per LN access group',
		'GOOSE t-class 1 and 2 (protection relay) paths must NEVER be replaced by OPC-UA over Ethernet -- retain IEC 61850 GOOSE',
		'Sampled Values (9-2LE) path latency <= 1ms: OPC-UA PubSub over TSN may be acceptable; raise decision with latency evidence',
		'Edition 1 -> Edition 2 migration: namespace changes in SCL LN instantiation must be explicitly reconciled in the NodeId mapping table',
		'Every LN Variable node must carry a EUInformation extension object for engineering units per OPC-UA AnalogItemType',
	],

	warningPatterns: [
		'GOOSE t-class 1/2 (protection trip/close) -- raise BLOCKING decision: OPC-UA cannot guarantee <= 4ms; must retain IEC 61850 GOOSE',
		'SV stream with >80 ASDU/frame -- raise decision: OPC-UA PubSub DataSetReader must match SV publication rate; verify TSN shaper config',
		'IEC 61850 access control via ACL -- raise blocking decision: map to OPC-UA RolePermissionType with equivalent granularity',
		'Multi-IED configuration (SCL SCD with >50 IEDs) -- raise design decision: OPC-UA Aggregation Server or Namespace-per-IED strategy',
		'Hardcoded IED IP in SCL IEDName/IPAddress -- raise decision: replace with OPC-UA EndpointURL configuration discovery',
		'Edition 1 dataset with free-form FCDA -- raise note: Edition 2 restricts FCDA to typed DOs; verify schema compliance before migration',
	],
};


// --- DNP3 RTU C -> IEC 60870-5-104 over TLS (C) -------------------------------

const DNP3_TO_IEC104_TLS: ILanguagePairProfile = {
	sourceLang: 'c',
	targetLang: 'c',
	label: 'DNP3 RTU C -> IEC 60870-5-104 over TLS',
	targetFramework: 'lib60870-C v2 (MZ Automation) + OpenSSL TLS 1.3',
	targetTestFramework: 'Unity + Wireshark IEC 104 dissector + TLS interop test',
	targetFileExtension: 'c',

	systemPersona: `You are a SCADA communications specialist with deep expertise in migrating DNP3 (IEEE 1815) outstation and master C implementations to IEC 60870-5-104 (IEC 104) over TLS 1.3 using the lib60870-C open-source library. You understand DNP3 application layer (AL) function codes, object group/variation model, quality flags (ONLINE/RESTART/COMM_LOST/REMOTE_FORCED), and how they map to IEC 104 TypeIDs, ASDUs, information object addresses (IOA), and quality bits (IV/NT/SB/BL/OV). You know the IEC 104 APCI framing (I/S/U frames, supervisory acknowledgement, T1/T2/T3 timers) and how to configure TLS 1.3 mutual authentication per IEC 62351-3.`,

	idiomMap: [
		{ sourceConstruct: 'DNP3_FC_READ (0x01)  // DNP3 function code Read',               targetConstruct: 'IEC104_TypeID_M_SP_NA_1 (1)  // Single-point information, no time tag',  notes: 'DNP3 FC_READ of Binary Input Gr1 -> IEC 104 M_SP_NA_1; with time tag: M_SP_TB_1 (30)' },
		{ sourceConstruct: 'DNP3_Grp30_Var1  // 32-bit analog input with flag',             targetConstruct: 'IEC104_TypeID_M_ME_NB_1 (11)  // Measured value, scaled, no time tag',   notes: 'DNP3 Group 30 Var 1 analog -> IEC 104 M_ME_NB_1 (scaled) or M_ME_NC_1 (float, TypeID 13)' },
		{ sourceConstruct: 'DNP3_QUALITY_ONLINE | DNP3_QUALITY_RESTART  // quality flags',  targetConstruct: 'IEC104_QUALITY_IV | IEC104_QUALITY_NT  // Invalid + Non-Topical quality bits', notes: 'DNP3 RESTART bit -> IEC 104 NT (Non-Topical); DNP3 COMM_LOST -> IEC 104 IV (Invalid)' },
		{ sourceConstruct: 'dnp3_outstation_send_response(session, rsp)',                   targetConstruct: 'CS104_Slave_enqueueASDU(slave, asdu);  // lib60870-C slave enqueue', notes: 'DNP3 outstation response -> IEC 104 slave ASDU enqueue; spontaneous = CS104_COT_SPONTANEOUS (3)' },
		{ sourceConstruct: 'dnp3_master_send_request(master, fc, objHdr)',                  targetConstruct: 'CS104_Connection_sendInterrogationCommand(con, CS101_COT_ACTIVATION, CA_ALL, IEC60870_QOI_STATION);', notes: 'DNP3 FC_READ Class 1/2/3 -> IEC 104 General Interrogation (TypeID C_IC_NA_1, 100)' },
		{ sourceConstruct: 'DNP3_FC_DIRECT_OP (0x03)  // Direct Operate',                  targetConstruct: 'CS104_Connection_sendControlCommand(con, CS101_COT_ACTIVATION, 0, asdu);  // C_SC_NA_1 (45) Single Command', notes: 'DNP3 Direct Operate -> IEC 104 C_SC_NA_1 (Single Command) COT=Activation; await COT=Activation_Confirmation' },
		{ sourceConstruct: 'dnp3_transport_layer_segment(pkt, fir, fin)',                   targetConstruct: '/* IEC 104 APCI handles framing -- I-frames with send/receive counters (VS/VR) */', notes: 'DNP3 transport layer FIR/FIN fragmentation -> IEC 104 APCI I-frame sequence numbering (k/w window)' },
		{ sourceConstruct: 'DNP3_SAv5_challenge(session, challenge_data)',                  targetConstruct: 'SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, NULL); /* TLS 1.3 mTLS replaces SAv5 */', notes: 'DNP3 Secure Authentication v5 (SAv5) challenge-response -> IEC 62351-3 TLS 1.3 mutual auth; raise decision on certificate management' },
		{ sourceConstruct: 'dnp3_app_layer_confirm(session)',                               targetConstruct: '/* IEC 104 S-frame supervisory ACK: CS104_Connection_sendStartDT(con) + implicit ACK window */', notes: 'DNP3 AL confirmation -> IEC 104 supervisory (S-frame) acknowledgement; T1 timeout triggers link restart' },
		{ sourceConstruct: 'DNP3_Grp12_Var1  // Control Relay Output Block (CROB)',         targetConstruct: 'CS101_DoubleCommand_create(NULL, ioa, IEC60870_DOUBLE_POINT_ON);  // C_DC_NA_1 (46)', notes: 'DNP3 CROB -> IEC 104 Double Command (C_DC_NA_1); match TRIP/CLOSE to DCS=1/2' },
		{ sourceConstruct: 'dnp3_event_buffer_overflow(outstation)',                        targetConstruct: 'CS104_ASDU_setCOT(asdu, CS101_COT_SPONTANEOUS);  // raise event count monitoring at master', notes: 'DNP3 event buffer overflow -> monitor IEC 104 spontaneous ASDU backlog at master; raise design decision' },
		{ sourceConstruct: 'dnp3_link_layer_reset(session)',                                targetConstruct: 'CS104_Connection_close(con); CS104_Connection_connect(con);  // reconnect TCP session', notes: 'DNP3 link reset -> IEC 104 TCP reconnect + STARTDT_ACT to restart data transfer' },
	],

	conventionNotes: [
		'Use lib60870-C CS104_Slave / CS104_Connection APIs consistently; do not mix with raw socket send',
		'TLS 1.3 mutual authentication per IEC 62351-3: configure SSL_CTX with CA chain, device cert, and private key for both master and outstation',
		'ASDU cause of transmission (COT): spontaneous (3) for events, periodic (1) for cyclic, interrogated (20) for GI response',
		'Information Object Address (IOA) allocation: define a fixed IOA table matching legacy DNP3 index assignments; document in engineering database',
		'IEC 104 timers: T1=15s (unconfirmed I-frame timeout), T2=10s (S-frame ACK), T3=20s (test frame); match to DNP3 link-layer timeouts',
		'General Interrogation (GI) response: outstation must respond with all data points before COT=Activation_Termination',
		'Clock synchronisation: C_CS_NA_1 (TypeID 103) replaces DNP3 Delay Measurement (FC 23); validate +/-1s accuracy',
	],

	warningPatterns: [
		'DNP3 unsolicited responses with short deadbands (< 50ms) -- raise decision: IEC 104 spontaneous ASDU congestion; size k/w window appropriately',
		'SAv5 HMAC key management -- raise blocking decision: TLS 1.3 certificate PKI must be provisioned before migration; no fallback to unauthenticated',
		'DNP3 Group 122 (security statistics) -- raise decision: no direct IEC 104 equivalent; log to SIEM instead',
		'Multiple DNP3 master connections to same outstation -- raise design decision: IEC 104 supports only one TCP master per slave by default (lib60870 single-connection model)',
		'DNP3 analog deadband (Group 34) -- raise decision: IEC 104 has no native deadband; implement in application layer before ASDU enqueue',
		'CROB pulse duration < 100ms -- raise decision: IEC 104 double command has no built-in pulse duration; requires separate command to reset output',
	],
};


// --- AUTOSAR Classic CP SWC C -> AUTOSAR Adaptive Executable C++14 ------------

const AUTOSAR_CP_SWC_TO_AP_FULL: ILanguagePairProfile = {
	sourceLang: 'autosar',
	targetLang: 'cpp',
	label: 'AUTOSAR Classic CP SWC -> Adaptive Executable (Full API Surface)',
	targetFramework: 'AUTOSAR Adaptive Platform R22-11 (ara::com, ara::exec, ara::diag, ara::per, ara::crypto)',
	targetTestFramework: 'GoogleTest + vECU + AUTOSAR AP SIL Simulation',
	targetFileExtension: 'cpp',

	systemPersona: `You are an AUTOSAR Classic-to-Adaptive migration specialist at a Tier 1 automotive supplier with production SOP experience on ISO 26262 ASIL-D projects. You cover the full CP->AP API surface: Rte_Read/Write -> ara::com Proxy/Skeleton, Rte_Call -> ara::com method, DEM -> ara::diag, NvM -> ara::per, Com with E2E -> E2EPW wrapper, AUTOSAR OS Task -> std::thread+Executor, WdgM -> ara::exec Watchdog, SchM_Enter/Exit -> std::mutex. You understand E2E protection transformer manifest configuration, ara::exec ExecutionClient lifecycle, and ara::per KeyValueStorage/FileStorage APIs. You enforce C++14 compliance (no C++17 structured bindings, no if-constexpr), MISRA-C++:2008 rules, and AUTOSAR AP C++14 guidelines.`,

	idiomMap: [
		{ sourceConstruct: 'Rte_Read_<Port>_<Elem>(&value)',                                targetConstruct: 'auto result = proxy_->Elem.Get(); if (result.HasValue()) { value = result.Value(); }', notes: 'CP Rte_Read -> AP ara::com Proxy field Get(); handle ara::core::Result<T> -- never call .Value() without HasValue() check' },
		{ sourceConstruct: 'Rte_Write_<Port>_<Elem>(value)',                                targetConstruct: 'skeleton_->Elem.Update(value);  // ara::com Skeleton field Update; triggers SOME/IP notification', notes: '' },
		{ sourceConstruct: 'Rte_Call_<Port>_<Op>(<args>)',                                  targetConstruct: 'ara::core::Future<Output> fut = proxy_->Op(args); Output out = fut.get();', notes: 'CP client-server port -> AP ara::com Method; for fire-and-forget: proxy_->Op.Fire(args)' },
		{ sourceConstruct: 'Rte_Send_<Port>_<Elem>(value)  // sender-receiver queued',      targetConstruct: 'skeleton_->Elem.Send(value);  // ara::com Event send; subscribers get callback', notes: 'Queued sender-receiver -> ara::com Event; set EventBufferSize in service manifest' },
		{ sourceConstruct: 'Rte_Receive_<Port>_<Elem>(&value)  // queued receive',          targetConstruct: 'proxy_->Elem.Subscribe(1); proxy_->Elem.GetNewSamples([&](auto sample){ value = *sample; }, 1);', notes: 'Queued receive -> ara::com Event Subscribe + GetNewSamples; sampleCount=1 for simple dequeue' },
		{ sourceConstruct: 'Dem_SetEventStatus(eventId, DEM_EVENT_STATUS_FAILED)',          targetConstruct: 'monitor_->ReportMonitorAction(ara::diag::MonitorAction::kFailed);', notes: 'DEM event -> ara::diag::Monitor::ReportMonitorAction; register in DiagnosticServer manifest' },
		{ sourceConstruct: 'NvM_ReadBlock(blockId, &dataBuffer)',                           targetConstruct: 'auto kvs = ara::per::OpenKeyValueStorage("blockName").Value(); auto val = kvs->GetValue<T>("key").Value();', notes: 'NvM block -> ara::per KeyValueStorage; block name and key defined in per::KvsDatabase manifest' },
		{ sourceConstruct: 'NvM_WriteBlock(blockId, &dataBuffer)',                          targetConstruct: 'kvs->SetValue("key", value); kvs->SyncToStorage();', notes: 'NvM write + NvM_WriteAll -> ara::per SetValue + SyncToStorage; call SyncToStorage before shutdown' },
		{ sourceConstruct: 'Com_SendSignal(signalId, &data)  // with E2E profile P02',      targetConstruct: 'E2EPW_Write(&e2e_state, &e2e_config, dataPtr, dataLen);  // then skeleton_->Signal.Update(data)', notes: 'CP Com with E2E -> explicit E2EPW_Write wrapper call before ara::com Send/Update; or configure E2EXf transformer in AP manifest' },
		{ sourceConstruct: 'AUTOSAR OS: TASK(My10msTask)  // periodic OS task',             targetConstruct: 'class MyApplication : public ara::exec::ExecutionClient { void Run() { while (!shutdown_) { doWork(); std::this_thread::sleep_for(std::chrono::milliseconds(10)); } } };', notes: 'CP OS task -> AP Run() main loop; timing via sleep_for or platform executor; raise decision if < 1ms needed' },
		{ sourceConstruct: 'WdgM_SetMode(WDGM_MODE_SUPERVISION, supervisedEntityId)',      targetConstruct: 'ara::exec::ExecutionClient::RequestState(ara::exec::ApplicationState::kRunning);  // Execution Management watchdog', notes: 'WdgM alive supervision -> ara::exec EM watchdog; configure WatchdogInformation in Process manifest' },
		{ sourceConstruct: 'SchM_Enter_<Module>_<ExclusiveArea>()',                         targetConstruct: 'std::lock_guard<std::mutex> lock(exclusiveAreaMutex_);', notes: 'SchM exclusive area -> std::mutex lock_guard; one mutex per former exclusive area; document mapping' },
		{ sourceConstruct: 'SchM_Exit_<Module>_<ExclusiveArea>()',                          targetConstruct: '// Automatic: lock_guard destructor releases mutex at scope exit', notes: '' },
		{ sourceConstruct: 'Rte_IRead_<Runnable>_<Port>_<Elem>()  // inter-runnable variable read', targetConstruct: 'return irvValue_;  // class member read; protected by mutex if accessed from multiple threads', notes: 'IRV -> class member variable; if cross-process IRV raise design decision for ara::com field' },
		{ sourceConstruct: 'Rte_IWrite_<Runnable>_<Port>_<Elem>(value)  // IRV write',     targetConstruct: 'std::lock_guard<std::mutex> lk(irvMutex_); irvValue_ = value;', notes: '' },
		{ sourceConstruct: 'Dcm_RespondToReset(resetType)  // ECU reset via diagnostic',   targetConstruct: 'ara::exec::ExecutionClient::RequestState(ara::exec::ApplicationState::kTerminating);', notes: 'Diagnostic ECU reset -> AP EM RequestState(Terminating); EM triggers platform reset sequence' },
		{ sourceConstruct: 'Bfx_SetBit_u32u8(&reg, bitPos)  // AUTOSAR Bfx bit manipulation', targetConstruct: 'reg |= (1U << bitPos);  // or std::bitset<32> with set(bitPos)', notes: 'Bfx library -> plain C++ bit operations or std::bitset; no heap allocation' },
		{ sourceConstruct: 'Det_ReportError(moduleId, instanceId, apiId, errorId)',         targetConstruct: 'ara::log::LogStream log = logger_.LogError(); log << "ModuleError" << ara::log::HexFormat(errorId);', notes: 'DET error reporting -> ara::log error stream; configure log level in Application manifest' },
		{ sourceConstruct: 'ComM_RequestComMode(user, COMM_FULL_COMMUNICATION)',            targetConstruct: '// ara::com service discovery handles communication mode -- no explicit COMM_FULL equivalent; raise design decision', notes: 'ComM full/no-comm mode has no direct AP equivalent; model via ara::com service availability events' },
		{ sourceConstruct: 'Crypto_RandomGenerate(&buffer, length)  // CSM random',        targetConstruct: 'auto crypto = ara::crypto::cryp::LoadCryptoProvider("someProvider").Value(); auto rng = crypto->CreateRandomGeneratorCtx().Value(); rng->Generate(span);', notes: 'AUTOSAR CSM random -> ara::crypto RandomGeneratorCtx; provider name configured in crypto manifest' },
	],

	conventionNotes: [
		'Every AP Service Interface must have a complete ARXML ServiceInterface + ProvidedSomeipServiceInstance manifest before Skeleton/Proxy code generation',
		'Use ara::core::Result<T, ErrorCode> for all fallible API calls; never use exceptions on the safety path (ASIL-B+)',
		'ara::log replaces all Det_ReportError and Dlt calls: LOG_MODULE_INIT(ctxId, "description") in constructor',
		'Process manifest must declare ExecutionDependency for startup ordering and ResourceGroup for CPU/memory budget',
		'E2E protection: prefer manifest-driven E2EXf transformer over manual E2EPW_Write calls for new code',
		'ara::per SyncToStorage must be called explicitly before application termination to ensure persistence',
		'C++14 only: no structured bindings, no std::optional (use ara::core::Optional), no if-constexpr, no std::variant',
		'All ara::com field/event/method names must exactly match the ARXML ServiceInterface element names (case-sensitive)',
	],

	warningPatterns: [
		'ASIL-D runnables with < 1ms cycle time -- raise decision: AP scheduler minimum granularity is platform-dependent; characterise jitter on target ECU',
		'CP SWC with multiple runnables sharing large IVR state -- raise design decision: AP is single-threaded by default; explicit mutex required for concurrent access',
		'DEM events with ASIL-D classification -- raise blocking decision: ara::diag monitor requires type approval evidence for ASIL-D paths',
		'NvM block with write frequency > 1/min -- raise decision: ara::per flash wear levelling; document write cycle budget',
		'Vendor-specific RTE extensions (Vector RTE, EB tresos) -- raise BLOCKING decision: no direct AP equivalent; custom bridges required',
		'AUTOSAR CP Inter-ECU signals over CAN via Com -- raise design decision: AP uses SOME/IP over Ethernet; legacy CAN requires AP Gateway Proxy pattern',
		'WdgM with hardware watchdog direct kick -- raise decision: AP EM manages watchdog; direct hardware WDT kick must be moved to platform-specific EM plugin',
	],
};


// --- LTE eNB Monolithic C -> O-RAN Disaggregated CU/DU C++ -------------------

const LTE_ENB_TO_ORAN_CUDU: ILanguagePairProfile = {
	sourceLang: 'c',
	targetLang: 'cpp',
	label: 'LTE eNB Monolithic C -> O-RAN Disaggregated CU/DU C++',
	targetFramework: 'O-RAN Alliance WG4 (CU-CP/CU-UP/DU) + F1-AP/E1-AP/NG-AP + srsRAN / OAI',
	targetTestFramework: 'GoogleTest + O-RAN-SC CI + RF Tester + Wireshark F1-AP dissector',
	targetFileExtension: 'cpp',

	systemPersona: `You are a 5G RAN disaggregation architect with hands-on production experience splitting monolithic LTE eNB C codebases into O-RAN-compliant CU-CP, CU-UP, and DU components. You understand F1-AP (3GPP TS 38.473), E1-AP (TS 38.463), NG-AP (TS 38.413), and Xn-AP (TS 38.423) interface protocols, O-RAN WG4 fronthaul Category A/B/C splits, eCPRI framing, and FAPI (SCF222) MAC-PHY interface. You know PDCP/RLC/MAC/PHY layer API boundaries, HARQ process management, UE context split between CU and DU, and how to design timing-critical L1 scheduling for DPDK and FPGA-offload environments. You enforce deterministic latency requirements: DU scheduling < 0.5ms, F1-U latency < 1ms.`,

	idiomMap: [
		{ sourceConstruct: 'enb_process_rrc_connection_req(msg, ue_ctx)',                   targetConstruct: 'CuCp::RrcHandler::handleInitialULRRCMessage(const F1AP_InitialULRRCMessageTransfer&, UeContext&)', notes: 'Monolithic RRC -> CU-CP RRC entity; UE initial attach arrives via F1-AP InitialULRRCMessageTransfer' },
		{ sourceConstruct: 'enb_s1ap_send_initial_ue_message(s1ap, nas_pdu)',               targetConstruct: 'CuCp::NgapHandler::sendInitialUEMessage(const NgAP_InitialUEMessage_IEs&)', notes: 'eNB S1-AP InitialUEMessage -> CU-CP NG-AP InitialUEMessage to AMF (5GC); update UE NGAP ID' },
		{ sourceConstruct: 'enb_x2ap_handover_request(x2ap, ue_ctx, target_enb)',          targetConstruct: 'CuCp::XnApHandler::sendHandoverRequest(const XnAP_HandoverRequest&, XnNeighbourCellId)', notes: 'eNB X2-AP handover -> CU-CP Xn-AP handover procedure (TS 38.423); UE context forwarded over Xn-U' },
		{ sourceConstruct: 'pdcp_rx_reorder_deliver(pdcp_entity, pdu, sn)',                 targetConstruct: 'CuUp::PdcpEntity::rxDeliverToHigher(const PdcpSdu& pdu, PdcpSn sn)', notes: 'PDCP entity moves to CU-UP; user plane data flows DU -> CU-UP via F1-U (GTP-U/UDP)' },
		{ sourceConstruct: 'rlc_tx_enqueue_sdu(rlc_entity, sdu, lcid)',                    targetConstruct: 'Du::RlcEntity::txEnqueue(const RlcSdu& sdu, LogicalChannelId lcid)', notes: 'RLC entity stays in DU; PDCP PDUs delivered to DU RLC via F1-C UL RRC Transfer (SRBs) or F1-U (DRBs)' },
		{ sourceConstruct: 'mac_ul_harq_nack(ue_id, harq_pid)',                            targetConstruct: 'Du::HarqManager::reportNack(RNTI rnti, HarqProcessId pid)', notes: 'HARQ process management remains in DU MAC; CU-CP not involved in HARQ retransmission' },
		{ sourceConstruct: 'phy_dl_config_req(phy, dl_config)',                            targetConstruct: 'Du::FapiInterface::sendDlConfigRequest(const FAPI_DL_CONFIG_Request&)', notes: 'PHY DL config -> DU L1 FAPI (SCF222) DL_CONFIG.request; if FPGA-offload below Category A split' },
		{ sourceConstruct: 'enb_gtp_send_dl_data(teid, pdu)',                              targetConstruct: 'CuUp::GtpUTunnel::sendDownlink(GtpTeid teid, const GtpPdu& pdu)', notes: 'eNB GTP-U tunnel -> CU-UP GTP-U tunnel; TEID allocated by CU-UP reported to SMF via N4 PFCP session' },
		{ sourceConstruct: 'enb_security_apply_pdcp_enc(pdu, key, alg)',                   targetConstruct: 'CuUp::SecurityContext::applyEncryption(PdcpPdu& pdu, const SecurityKey& key, EeaAlgorithm alg)', notes: 'Ciphering in CU-UP PDCP; key material managed by CU-CP, passed to CU-UP via E1-AP Security Info IE' },
		{ sourceConstruct: 'enb_measurement_report_handler(meas_rpt, ue_id)',              targetConstruct: 'CuCp::MeasurementHandler::handleMeasReport(const F1AP_ULRRCMessageTransfer& rrcMsg, UeContext& ue)', notes: 'UE measurement report: DU forwards RRC msg to CU-CP via F1-AP UL RRC Transfer; RRC decodes MeasurementReport IE' },
		{ sourceConstruct: 'enb_ue_context_release(ue_ctx, cause)',                        targetConstruct: 'CuCp::UeContextManager::releaseUe(NgapUeId id, NgAP_Cause cause)', notes: 'UE release: CU-CP sends UEContextReleaseRequest on NG-AP, then F1-AP UEContextRelease to DU' },
		{ sourceConstruct: 'enb_ran_slice_config(slice_id, prb_alloc)',                    targetConstruct: 'Du::MacScheduler::configureSlice(SliceId id, PrbAllocation alloc)  // + O-RAN E2 RAN Intelligent Controller override', notes: 'RAN slicing config -> DU MAC scheduler; O-RAN E2 (E2SM-RC) allows RIC to override per-slice PRB allocation' },
		{ sourceConstruct: 'enb_ecpri_send_iq(port, symbol, iq_data)',                     targetConstruct: 'Du::EcpriTransport::sendIqData(EcpriPort port, OranSymbol sym, const IqSamples& iq)', notes: 'eCPRI IQ data -> DU L1 eCPRI U-Plane Category A fronthaul (O-RAN WG4 CUS-Plane spec)' },
		{ sourceConstruct: 'enb_pcfich_encode(subframe, cfi)',                             targetConstruct: '// Absorbed into DU L1 FAPI DL_CONFIG.request -- PCFICH is implicit in LTE; not exposed in NR', notes: 'LTE-specific control channels: map to equivalent NR PDCCH CORESET configuration in DU L1' },
		{ sourceConstruct: 'lte_s1ap_erab_setup_req(s1ap, erab_list)',                     targetConstruct: 'CuCp::NgapHandler::sendPduSessionResourceSetupRequest(const NgAP_PDUSessionResourceSetupRequest&)', notes: 'LTE E-RAB -> 5G PDU Session; S1-AP E-RABSetupRequest -> NG-AP PDUSessionResourceSetupRequest to SMF' },
	],

	conventionNotes: [
		'CU-CP, CU-UP, and DU run as separate processes (or containers) communicating over SCTP for F1-AP/E1-AP/NG-AP and UDP for F1-U/GTP-U',
		'DU timing-critical threads (L1 scheduling, HARQ) must use SCHED_FIFO priority >= 90 with mlockall; characterise worst-case latency',
		'Key material is CU-CP property only -- never pass security keys below the F1 interface in plaintext; use E1-AP Security Info IE',
		'O-RAN M-Plane (management) uses NETCONF/YANG over TLS; configure in DU O1 interface handler separately from data-plane code',
		'DPDK for high-throughput GTP-U forwarding in CU-UP: use DPDK rte_eth_rx_burst / rte_eth_tx_burst on data path',
		'O-RAN E2 interface (E2SM-RC, E2SM-KPM) enables external RAN Intelligent Controller to read KPIs and override scheduling decisions',
		'F1-AP message encoding uses ASN.1 PER: use asn1c or OpenAirInterface5G asn1 library; do not hand-encode TLVs',
	],

	warningPatterns: [
		'Tight L1-L2 timing loop < 0.5ms -- raise BLOCKING decision: O-RAN split 7-2x requires FH roundtrip <= 150uss; characterise on target NIC + switch',
		'Shared global UE context between RRC/PDCP/RLC/MAC -- raise BLOCKING decision: CU/DU split requires explicit state synchronisation over F1-AP; no shared memory across process boundaries',
		'Proprietary MAC scheduler with closed interface -- raise design decision: O-RAN SCF022 FAPI and E2 SM-RC are the standardised interfaces for DU MAC; scheduler must expose FAPI API',
		'LTE-specific procedures without NR equivalent (e.g. PCFICH, PHICH) -- raise note: map to closest NR equivalent or remove; document per 3GPP migration TS',
		'S1-AP direct GTP path (S-GW collocated) -- raise design decision: in 5GC, GTP-U terminates at UPF; CU-UP handles N3 interface via PFCP; re-architect bearer model',
		'PDCP COUNT rollover handling not ported -- raise blocking decision: COUNT wrap-around triggers re-keying; must be preserved in CU-UP PDCP entity',
	],
};


// --- IEC 61131-3 Ladder/ST PLC -> Linux-RT C++ IPC ----------------------------

const IEC61131_PLC_TO_LINUXRT_CPP: ILanguagePairProfile = {
	sourceLang: 'iec61131',
	targetLang: 'cpp',
	label: 'IEC 61131-3 PLC (LD/ST/FBD) -> Linux-RT C++ IPC',
	targetFramework: 'PREEMPT-RT Linux 6.x + POSIX + open62541 + spdlog',
	targetTestFramework: 'GoogleTest + SIL simulation (CODESYS SoftPLC) + RT latency cyclictest',
	targetFileExtension: 'cpp',

	systemPersona: `You are an industrial automation architect specialising in migrating IEC 61131-3 PLC programs (Ladder Diagram, Structured Text, Function Block Diagram) to real-time Linux (PREEMPT-RT) C++ IPC applications. You master POSIX real-time APIs (SCHED_FIFO, clock_nanosleep, mlockall, POSIX message queues), the IEC 61131-3 execution model (scan-cycle, EN/ENO, function block instance semantics, RETAIN variables), and PLCopen safety function block contracts. You know how to implement IEC 61131-3 standard function blocks (TON/TOF/TP, CTU/CTD, R_TRIG/F_TRIG, PID) as C++ classes that exactly preserve scan-cycle update semantics, and how to map PLC I/O image to shared memory or EtherCAT master image. You are familiar with IEC 62443 OT cybersecurity for Linux-based controllers.`,

	idiomMap: [
		{ sourceConstruct: 'PROGRAM Main  (* cyclic scan, 10ms period *)',                 targetConstruct: 'class ScanCycleThread { void run(); };  // SCHED_FIFO pthread + clock_nanosleep(CLOCK_MONOTONIC, &next, NULL)', notes: 'PLC scan program -> POSIX periodic thread; clock_nanosleep for deterministic 10ms period; measure jitter with CLOCK_MONOTONIC' },
		{ sourceConstruct: 'FUNCTION_BLOCK TonFb  VAR_INPUT IN: BOOL; PT: TIME; END_VAR', targetConstruct: 'class TonTimer { public: bool update(bool in, std::chrono::milliseconds pt) noexcept; bool q{}; private: bool lastIn_{}; std::chrono::steady_clock::time_point start_{}; };', notes: 'IEC 61131-3 TON FB -> C++ class; call update() once per scan; return Q output; class preserves elapsed state across calls' },
		{ sourceConstruct: 'ton1(IN := StartCond, PT := T#5S); q1 := ton1.Q;',            targetConstruct: 'q1 = ton1_.update(startCond, std::chrono::seconds(5));', notes: 'FB instance call -> C++ class member call; instance variable becomes class member ton1_' },
		{ sourceConstruct: 'VAR_GLOBAL i_StartButton AT %I*: BOOL; END_VAR',              targetConstruct: 'struct IoImage { bool startButton{}; bool motorRun{}; };  // mapped from EtherCAT PDO or Modbus coil image', notes: 'PLC I/O image -> shared IoImage struct; IO thread populates, scan thread reads; protected with std::mutex or std::atomic' },
		{ sourceConstruct: 'FUNCTION_BLOCK  (* EN/ENO *) EN: BOOL; ENO: BOOL;',           targetConstruct: 'explicit operator bool() const noexcept { return valid_; }  // ENO -> validity flag; EN -> constructor argument guard', notes: 'EN/ENO -> C++ constructor validation + operator bool(); skip execution if EN=FALSE maps to early return in update()' },
		{ sourceConstruct: 'VAR_INPUT param: INT; END_VAR  (* input variable *)',          targetConstruct: 'void update(int param) noexcept;  // const ref for large types', notes: 'VAR_INPUT -> const value/ref parameter to update(); matches IEC 61131-3 input formal parameter' },
		{ sourceConstruct: 'VAR_OUTPUT result: INT; END_VAR',                             targetConstruct: 'int result{};  // public member read by caller after update()', notes: 'VAR_OUTPUT -> public member variable read after update() call; or out-param reference' },
		{ sourceConstruct: 'RETAIN VAR retainedCounter: INT; END_VAR',                    targetConstruct: 'nlohmann::json state; state["retainedCounter"] = retainedCounter_; std::ofstream("/var/persist/state.json") << state;', notes: 'RETAIN variables -> JSON or SQLite persistence; write on clean shutdown and SIGTERM; restore in constructor' },
		{ sourceConstruct: 'SF_EmergencyStop(S_EStopIn := EStopButton, S_StartReset := ResetBtn)', targetConstruct: 'class SafetyEmergencyStop { public: bool update(bool sEStopIn, bool sStartReset) noexcept; bool safetyActive{}; uint16_t diagCode{}; };', notes: 'PLCopen SF_EmergencyStop -> safety C++ class with identical state machine; raise BLOCKING decision: requires independent SIL certification evidence' },
		{ sourceConstruct: 'TASK Cyclic WITH INTERVAL := T#10ms, PRIORITY := 1',          targetConstruct: 'struct sched_param sp{.sched_priority=90}; pthread_setschedparam(tid, SCHED_FIFO, &sp);  // clock_nanosleep 10ms period', notes: 'IEC 61131-3 task with INTERVAL -> SCHED_FIFO pthread with clock_nanosleep; PRIORITY 1 (highest) -> Linux priority 90-99' },
		{ sourceConstruct: 'ARRAY[1..N] OF INT  (* IEC 61131-3 array *)',                 targetConstruct: 'std::array<int16_t, N> arr{};  // fixed-size, no heap', notes: 'IEC 61131-3 ARRAY -> std::array<> with explicit size; zero-initialise with {} always' },
		{ sourceConstruct: 'STRING[80] sLabel;  (* PLC string *)',                        targetConstruct: 'std::string_view label;  // or std::array<char,81> label{} for mutable fixed buffer', notes: 'PLC STRING -> std::string_view for read-only or fixed char array for mutable; avoid std::string (heap) in RT context' },
		{ sourceConstruct: 'STRUCT Point XPOS: REAL; YPOS: REAL; END_STRUCT',            targetConstruct: 'struct Point { float xpos{}; float ypos{}; };', notes: 'PLC STRUCT -> plain C++ struct with value-initialisation; no virtual methods, no inheritance' },
		{ sourceConstruct: 'Modbus_TCP_Write(IP:="192.168.1.10", Reg:=40001, Val:=cmd)', targetConstruct: 'modbus_write_register(modbusCtx_, 40001 - 40001, static_cast<int>(cmd));  // libmodbus; run in IO thread', notes: 'PLC Modbus FB -> libmodbus in dedicated IO thread; protected shared state with scan thread via mutex + IO image' },
		{ sourceConstruct: 'OPCUA_Write(NodeId:="ns=2;i=1001", Value:=speed)',            targetConstruct: 'UA_Variant val; UA_Variant_setScalar(&val, &speed, &UA_TYPES[UA_TYPES_FLOAT]); UA_Client_writeValueAttribute(client_, nodeId_, &val);', notes: 'OPC-UA write in separate OPC-UA thread; copy value to shared struct with mutex before posting' },
		{ sourceConstruct: 'IEC 62443 Zone separation: Control Zone / DMZ',               targetConstruct: '/* OPC-UA SecurityMode=SignAndEncrypt; TLS 1.3 mTLS per zone boundary; no direct write-back from DMZ to control image */', notes: 'Apply IEC 62443 Zone/Conduit: OPC-UA server in DMZ zone; control loop in isolated RT process; no shared memory across zone boundary' },
		{ sourceConstruct: '(* PLC rung comment -- safety rationale *)',                   targetConstruct: '// IEC 61131-3 rung: <original comment preserved> -- required for IEC 61508 design documentation traceability', notes: 'Preserve ALL rung and network comments as C++ line comments with "IEC 61131-3 rung:" prefix for traceability' },
		{ sourceConstruct: 'PLCopen MC_Power(Axis:=Axis1, Enable:=driveEnable)',          targetConstruct: 'class McPower { public: bool update(bool enable) noexcept; bool status{}; bool error{}; uint16_t errorId{}; };', notes: 'PLCopen Motion FB -> C++ class; raise decision: axis type and drive interface (EtherCAT CiA 402 / FESTO / Siemens) must match' },
	],

	conventionNotes: [
		'Call mlockall(MCL_CURRENT | MCL_FUTURE) at process startup to prevent page faults in RT scan thread',
		'Scan thread: SCHED_FIFO priority 80-99; IO thread (Modbus/OPC-UA): SCHED_FIFO priority 50-70; logging thread: SCHED_OTHER',
		'Measure scan jitter with clock_gettime(CLOCK_MONOTONIC); log to spdlog async if jitter > 10% of period',
		'IO image struct: use std::atomic<bool> for single-bit I/O or std::mutex + copy-on-write for multi-field images',
		'Safety FBs (SF_ prefix) must be called every scan cycle unconditionally -- mirror the IEC 61131-3 mandatory-call requirement',
		'Logging: use spdlog async logger (non-blocking ring buffer) in RT threads -- never std::cout or printf in scan thread',
		'IEC 62443 OT: OPC-UA over untrusted network requires SecurityMode=SignAndEncrypt + RBAC UserIdentityToken per operator role',
		'Prefer std::array<> over raw arrays and std::string_view over std::string in all RT-path code',
	],

	warningPatterns: [
		'Safety function blocks (SF_ prefix) -- raise BLOCKING decision: C++ replacement must have independently assessed SIL evidence; cannot be auto-generated',
		'Scan period < 1ms -- raise decision: PREEMPT-RT jitter under load must be characterised with cyclictest on target hardware under full load',
		'Large PLC program (> 500 rungs / > 50 FBs) -- raise design decision: decompose into subsystem C++ classes with defined update() calling order',
		'RETAIN variable written > 1/min -- raise decision: flash/eMMC wear; use RAM-backed tmpfs with battery-backed SRAM or journalling filesystem',
		'OPC-UA server in same process as RT scan thread -- raise decision: OPC-UA stack may introduce latency spikes; isolate in separate thread with SCHED_OTHER',
		'PLCopen Motion FBs (MC_ prefix) -- raise decision: drive interface (EtherCAT CiA 402, Modbus, proprietary) determines C++ motion class internals; cannot be translated without drive spec',
	],
};


// --- CANopen CiA 301 C -> EtherCAT CoE C -------------------------------------

const CANOPEN_TO_ETHERCAT_COE: ILanguagePairProfile = {
	sourceLang: 'c',
	targetLang: 'c',
	label: 'CANopen CiA 301 C -> EtherCAT CoE C',
	targetFramework: 'EtherCAT CoE (CiA 301 over EtherCAT) + SOEM or IgH EtherCAT Master',
	targetTestFramework: 'Unity + EtherCAT Conformance Test Tool (ETG.1300) + TwinCAT Scope',
	targetFileExtension: 'c',

	systemPersona: `You are an industrial fieldbus migration specialist with hands-on experience porting CANopen (CiA 301/302/402) C stacks to EtherCAT CoE (CAN Application Protocol over EtherCAT, ETG.1000.6) using the Simple Open EtherCAT Master (SOEM) or IgH EtherCAT master libraries. You understand CANopen NMT state machine, Object Dictionary (OD) structure (Index/Sub-Index, PDO mapping, SDO upload/download), Heartbeat producer/consumer, Emergency object (EMCY), SYNC/TIME producer, and how each maps to EtherCAT ESM (EtherCAT State Machine), CoE SDO mailbox, PDO assignment, and AL Status code. You know the EtherCAT physical layer distinctions (daisy-chain topology, distributed clock, process data watchdog) and how they replace CANopen bus timing.`,

	idiomMap: [
		{ sourceConstruct: 'CO_OD_init()  // CANopen Object Dictionary initialisation',    targetConstruct: 'ec_init(ifname); ec_config_init(FALSE);  // SOEM: scan EtherCAT bus and read CoE OD', notes: 'CANopen OD init -> SOEM ec_init + ec_config; slave CoE OD read via ec_SDOread() during configuration' },
		{ sourceConstruct: 'CO_PDO_map(txpdo, index, subindex, bitLen)',                    targetConstruct: 'ec_slave[slaveIdx].outputs + byteOffset;  // SOEM process image mapped from CoE PDO assignment (0x1C12/0x1C13)', notes: 'CANopen PDO mapping -> EtherCAT CoE PDO assignment objects 0x1C12 (RxPDO) / 0x1C13 (TxPDO); SOEM maps to process image automatically' },
		{ sourceConstruct: 'CO_SDO_read(node, index, subindex, &value, len)',               targetConstruct: 'ec_SDOread(slaveIdx, index, subindex, FALSE, &len, &value, EC_TIMEOUTRXM);', notes: 'CANopen SDO upload -> EtherCAT CoE SDO mailbox read via ec_SDOread(); use EC_TIMEOUTSAFE for safety-critical reads' },
		{ sourceConstruct: 'CO_SDO_write(node, index, subindex, &value, len)',              targetConstruct: 'ec_SDOwrite(slaveIdx, index, subindex, FALSE, len, &value, EC_TIMEOUTRXM);', notes: 'CANopen SDO download -> EtherCAT CoE SDO mailbox write via ec_SDOwrite(); check return for EC_TIMEOUTRET' },
		{ sourceConstruct: 'CO_NMT_sendCommand(node, CO_NMT_ENTER_OPERATIONAL)',           targetConstruct: 'ec_slave[slaveIdx].state = EC_STATE_OPERATIONAL; ec_writestate(slaveIdx);', notes: 'CANopen NMT state -> EtherCAT ESM state; EC_STATE_INIT -> EC_STATE_PRE_OP -> EC_STATE_SAFE_OP -> EC_STATE_OPERATIONAL sequence' },
		{ sourceConstruct: 'CO_TPDO_send(tpdo, data)  // transmit PDO',                    targetConstruct: 'memcpy(ec_slave[slaveIdx].outputs + offset, &data, size); ec_send_processdata();', notes: 'CANopen TPDO -> write to SOEM process image output buffer + ec_send_processdata(); EtherCAT master distributes in one cycle' },
		{ sourceConstruct: 'CO_RPDO_receive(rpdo, &data)  // receive PDO',                 targetConstruct: 'ec_receive_processdata(EC_TIMEOUTRET); memcpy(&data, ec_slave[slaveIdx].inputs + offset, size);', notes: 'CANopen RPDO -> read from SOEM process image input buffer after ec_receive_processdata()' },
		{ sourceConstruct: 'CO_HB_producer_init(heartbeatPeriodMs)',                       targetConstruct: '// EtherCAT replaces heartbeat with process data watchdog (PDI Watchdog); configure via CoE 0x10F9', notes: 'CANopen Heartbeat producer -> EtherCAT process data watchdog timeout (0x10F9 sub-1); no explicit HB send needed' },
		{ sourceConstruct: 'CO_EMCY_send(errorCode, errorRegister, msCodes)',              targetConstruct: 'ec_SDOwrite(slaveIdx, 0x1003, 0x01, FALSE, 4, &errorCode, EC_TIMEOUTRXM);  // or CoE EMCY PDO', notes: 'CANopen EMCY object -> CoE Emergency object (0x1014) or AL Status code in EtherCAT register 0x0134; raise design decision for application layer error reporting' },
		{ sourceConstruct: 'CO_SYNC_producer(syncPeriodUs)',                               targetConstruct: 'ec_configdc(); ec_dcsync0(slaveIdx, TRUE, syncPeriodNs, 0);  // EtherCAT Distributed Clock SYNC0', notes: 'CANopen SYNC producer -> EtherCAT Distributed Clock (DC) SYNC0 pulse via ec_dcsync0(); sub-microsecond synchronisation replaces CAN SYNC latency' },
		{ sourceConstruct: 'CO_OD_entry_t {.index=0x6041, .subIndex=0, .dataType=CO_UINT16}', targetConstruct: 'ec_SDOread(slave, 0x6041, 0x00, FALSE, &len, &statusword, timeout);  // CiA 402 Statusword', notes: 'CANopen CiA 402 OD objects (0x6000-0x9FFF) are identical in CoE; index/subindex mapping unchanged' },
		{ sourceConstruct: 'CO_LSS_IdentifySlave(lss, vendorId)',                         targetConstruct: '// EtherCAT uses SII EEPROM (Station Alias + Vendor ID/Product Code) for slave identification -- no LSS protocol', notes: 'CANopen LSS -> EtherCAT SII EEPROM identification; configure Station Alias via ec_eeprom_write if needed' },
	],

	conventionNotes: [
		'EtherCAT topology is daisy-chain: slave indices (1..n) are positional; document slave index to device mapping in engineering database',
		'PDO offset calculation: use ec_slave[i].Obytes (output bytes before this slave) to compute process image offsets; generate a header with #define per signal',
		'EtherCAT cycle time must be set to match the legacy CANopen SYNC period; use SOEM osal_usleep between ec_send_processdata and ec_receive_processdata',
		'Distributed Clock: call ec_configdc() after ec_config_map(); SYNC0 period must be exact integer multiple of bus cycle time',
		'CoE SDO mailbox access is slow (> 100ms typical): use only for configuration and diagnostics, never in the real-time cycle',
		'Check ec_slave[i].state after each ec_statecheck() call; log AL Status Code on EC_STATE_SAFE_OP stall for diagnostics',
		'EtherCAT watchdog: configure PDI watchdog timeout (CoE 0x10F9 or register 0x0400) <= 3x bus cycle time to detect cable loss',
	],

	warningPatterns: [
		'CANopen LSS node addressing replaced by SII positional addressing -- raise design decision: slave positions may differ from legacy CANopen node IDs; update all node ID references',
		'CANopen multi-master configuration -- raise BLOCKING decision: EtherCAT has exactly one master; re-architect to master-slave topology',
		'RPDO cycle time < 1ms -- raise decision: EtherCAT cycle must match; characterise SOEM jitter on RT Linux target with cyclictest',
		'More than 4 RPDO/TPDO per slave mapped -- raise note: most CoE slaves support 8+ PDOs but EL terminal slaves may have fixed PDO layout; consult ESI (EtherCAT Slave Information) file',
		'CANopen Safety (CiA 304 FSCP) -- raise BLOCKING decision: CoE safety uses FSoE (Fail Safe over EtherCAT, ETG.5100); independent SIL analysis required',
		'Emergency objects used for production alarming -- raise decision: redesign as CoE Diagnosis Messages or map to OPC-UA alarms in higher layer',
	],
};


// --- SS7 ISUP/MAP C -> Diameter/SIP C++ --------------------------------------

const SS7_ISUP_MAP_TO_DIAMETER_SIP: ILanguagePairProfile = {
	sourceLang: 'c',
	targetLang: 'cpp',
	label: 'SS7 ISUP/MAP C -> Diameter / SIP C++',
	targetFramework: 'Diameter (RFC 6733 / 3GPP TS 29.272) + SIP (RFC 3261) + SCTP / SIGTRAN',
	targetTestFramework: 'GoogleTest + SIPp + Wireshark Diameter/SS7 dissector',
	targetFileExtension: 'cpp',

	systemPersona: `You are a carrier-grade telephony migration architect with deep expertise in porting SS7 (ISUP, TCAP/MAP, SCCP/MTP3) C implementations to modern IP-based Diameter and SIP C++ stacks. You understand SS7 ISUP call control messages (IAM, ACM, ANM, REL, RLC), MAP services (SendAuthInfo, UpdateLocation, InsertSubscriberData, SendRoutingInfo), TCAP component model (Begin/Continue/End, Invoke/ReturnResult), SCCP global title addressing, and SIGTRAN (MTP3 over SCTP with IUA/M3UA/M2UA). You map these to SIP INVITE/183/200/BYE/CANCEL call flows, P-Asserted-Identity, SIP REFER for transfer, Diameter AVPs (S6a/SWx SAR/UAR/AIR/CLR), and SCTP multi-homing transport.`,

	idiomMap: [
		{ sourceConstruct: 'isup_send_iam(circuit, cpc, called_num, calling_num)',         targetConstruct: 'sip::InviteRequest invite; invite.setRequestUri(calledNum); invite.addHeader("P-Asserted-Identity", callingNum); sipStack_->send(invite);', notes: 'SS7 IAM -> SIP INVITE; CPC (Calling Party Category) -> SIP P-Asserted-Identity header; Called/Calling DN -> Request-URI / From' },
		{ sourceConstruct: 'isup_send_acm(circuit, bci)',                                  targetConstruct: 'sip::Response resp183 = sip::Response::create(inviteReq_, 183, "Session Progress"); sipStack_->send(resp183);', notes: 'SS7 ACM (Address Complete) -> SIP 183 Session Progress with SDP early media' },
		{ sourceConstruct: 'isup_send_anm(circuit)',                                       targetConstruct: 'sip::Response resp200 = sip::Response::create(inviteReq_, 200, "OK"); resp200.setSdpBody(answerSdp_); sipStack_->send(resp200);', notes: 'SS7 ANM (Answer) -> SIP 200 OK with SDP answer; triggers RTP media path establishment' },
		{ sourceConstruct: 'isup_send_rel(circuit, causeCode)',                            targetConstruct: 'sip::ByeRequest bye; bye.addHeader("Reason", mapCauseToQ850(causeCode)); sipStack_->send(bye);', notes: 'SS7 REL -> SIP BYE with Reason header (Q.850 cause mapped to SIP Reason: cause=<Q850>); or CANCEL if pre-answer' },
		{ sourceConstruct: 'isup_send_rlc(circuit)  // Release Complete',                  targetConstruct: '// SIP: 200 OK to BYE from peer -- no explicit RLC equivalent; BYE is confirmed by 200 OK', notes: 'SS7 RLC implicit in SIP BYE 200 OK; circuit state machine -> SIP dialog state (Early/Confirmed/Terminated)' },
		{ sourceConstruct: 'map_send_auth_info(imsi, numTrip, callback)',                  targetConstruct: 'Diameter::AIA aia; // S6a: AIR (Authentication-Information-Request) -> AIR AVPs: User-Name=IMSI, Requested-EUTRAN-Authentication-Info', notes: 'MAP SendAuthInfo -> Diameter S6a Authentication-Information-Request (AIR) / Answer (AIA); AVP 1408 Requested-EUTRAN-Authentication-Info' },
		{ sourceConstruct: 'map_update_location(imsi, vlrAddr, callback)',                 targetConstruct: 'Diameter::ULR ulr; ulr.setAvp(AVP_USER_NAME, imsi); ulr.setAvp(AVP_VISITED_PLMN_ID, visitedPlmn_); diameter_->send(ulr, S6A_REALM);', notes: 'MAP UpdateLocation -> Diameter S6a Update-Location-Request (ULR) to HSS; response ULA carries subscription data' },
		{ sourceConstruct: 'map_send_routing_info(msisdn, callback)',                      targetConstruct: 'Diameter::SRR srr; srr.setAvp(AVP_USER_NAME, msisdn); diameter_->send(srr, S6A_REALM);  // SLh Send-Routing-Info-Request', notes: 'MAP SRI -> Diameter SLh SRR; response SRA carries MSRN/IMSI for MT call routing' },
		{ sourceConstruct: 'tcap_send_begin(ssn, gt, component)',                          targetConstruct: '/* Diameter: session establishment implicit in CCR/CCA or RAR/RAA exchange -- no explicit TCAP layer */', notes: 'TCAP Begin/Continue/End -> Diameter session model (Session-Id AVP); component model -> AVP grouping in one request/answer' },
		{ sourceConstruct: 'sccp_send_unitdata(ssn, gt_calledParty, data)',                targetConstruct: 'sctp::Endpoint ep; ep.connect(peerAddr_, port_); ep.send(m3uaPayload_);  // M3UA over SCTP per RFC 4666', notes: 'SCCP unitdata -> SIGTRAN M3UA over SCTP; MTP3 label (OPC/DPC/SLS) -> M3UA Routing Context and Network Appearance' },
		{ sourceConstruct: 'mtp3_send(dpc, opc, sls, payload)',                           targetConstruct: 'm3ua::TransferMessage tmsg; tmsg.setRoutingLabel(opc_, dpc_, sls_); m3uaStack_->send(tmsg);', notes: 'MTP3 Transfer -> M3UA Transfer message; MTP3 routed by SS7 STP; M3UA routed by SCTP association + Routing Context' },
		{ sourceConstruct: 'isup_cpc_t cpc = ISUP_CPC_ORDINARY  // Calling Party Category', targetConstruct: 'const std::string pai = "sip:+" + e164Calling_ + "@" + domain_; invite.addHeader("P-Asserted-Identity", pai);', notes: 'ISUP CPC maps to P-Asserted-Identity trust domain; raise decision: CPC categories (payphone, operator) may need additional SIP Privacy headers' },
		{ sourceConstruct: 'ss7_load_balance_cic(circuit_group)',                         targetConstruct: 'sctp::MultihomingConfig mhcfg; mhcfg.addLocalAddr(addr1_); mhcfg.addLocalAddr(addr2_); // SCTP multi-homing', notes: 'SS7 CIC load balancing over MTP links -> SCTP multi-homing for transport redundancy; application-level load balance via SIP forking' },
		{ sourceConstruct: 'isup_continuity_check(circuit)',                              targetConstruct: '// SIP: no equivalent -- RTP RTCP statistics replace circuit continuity check; raise design decision', notes: 'ISUP Continuity Check (CON/CCR) -> RTCP statistics monitoring; raise decision on continuity test procedure replacement' },
		{ sourceConstruct: 'map_insert_subscriber_data(imsi, subscriberData, callback)',  targetConstruct: 'Diameter::IDR idr; idr.setAvp(AVP_USER_NAME, imsi); idr.setAvp(AVP_SUBSCRIPTION_DATA, subscData_); diameter_->send(idr, S6A_REALM);', notes: 'MAP InsertSubscriberData -> Diameter S6a Insert-Data-Request (IDR); HSS-initiated push to MME' },
	],

	conventionNotes: [
		'SS7 circuit state machine (Idle/Busy/Resetting) -> SIP dialog state (Initial/Early/Confirmed/Terminated); enforce strict state machine with enum class',
		'SCTP multi-homing: configure at least 2 local and 2 remote IP addresses per association for carrier-grade redundancy',
		'Diameter session-id must be globally unique: use "<FQDN>;<timestamp>;<unique-counter>" format per RFC 6733 S.8.8',
		'SIP trust domain for P-Asserted-Identity: configure TLS with SIP Identity (RFC 8224) for inter-carrier scenarios',
		'MAP to Diameter AVP mapping: follow 3GPP TS 29.002 (MAP) and TS 29.272 (S6a) column-by-column; document every non-obvious mapping',
		'SIGTRAN M3UA: configure Application Server (AS) and Application Server Process (ASP) states per RFC 4666 S.4.3 before sending Transfer messages',
		'Diameter watchdog: configure DWR/DWA timer (RFC 6733 S.5.5.3) <= 30s to detect peer failures; implement reconnect with exponential backoff',
	],

	warningPatterns: [
		'SS7 circuit group reset (GRS/GRA) -- raise design decision: no SIP equivalent; implement as batch BYE + re-REGISTER on link restore',
		'ISUP overlap dialling (SAM messages) -- raise decision: SIP en-bloc sending required for most modern interconnects; raise if overlap signalling must be preserved',
		'MAP CAMEL trigger detection -- raise BLOCKING design decision: Diameter has no CAMEL equivalent; requires dedicated gsmSCF/IMS Application Server integration',
		'MTP3 link changeover/changeback (COO/CBA) -- raise design decision: SCTP handles path failover automatically via multi-homing; MTP3 link management becomes SCTP heartbeat management',
		'SS7 accounting (Billing Detail Records) via ISUP/MAP -- raise design decision: map to Diameter Ro/Rf charging interfaces; requires CDR format re-design',
		'SCCP global title translation (GTT) -- raise BLOCKING decision: GTT is carrier-internal routing; must be replicated in SIP/Diameter routing table or DNS-based E.164-to-SIP translation (ENUM RFC 6116)',
	],
};


// --- TTCN-3 Protocol Test Suite -> PyTest + Scapy Python ----------------------

const TTCN3_TO_PYTEST_SCAPY: ILanguagePairProfile = {
	sourceLang: 'ttcn3',
	targetLang: 'python',
	label: 'TTCN-3 Protocol Test Suite -> PyTest + Scapy Python',
	targetFramework: 'PyTest + Scapy + pyasn1 / asn1tools + asyncio',
	targetTestFramework: 'PyTest CI + pytest-timeout + pytest-asyncio + Wireshark / tshark capture',
	targetFileExtension: 'py',

	systemPersona: `You are a protocol test automation architect migrating TTCN-3 (Testing and Test Control Notation 3, ETSI ES 201 873) conformance test suites to Python using PyTest, Scapy, and 3GPP ASN.1 codecs. You understand the full TTCN-3 execution model: module imports, component type declarations (MTC/PTC), port type bindings (PCO/TSI), template matching (wildcards ?, omit, complement, superset), altstep pattern, verdict handling (pass/fail/inconc/error), timer semantics, and module parameters. You translate TTCN-3 testcases to pytest functions, altsteps to helper functions or fixtures, templates to Scapy packet classes or pyasn1/asn1tools decode calls, and TTCN-3 verdicts to pytest assertion patterns. You reference 3GPP TS 36.523 (LTE protocol conformance) and ETSI TS 102 641 (TTCN-3 core language) for normative context.`,

	idiomMap: [
		{ sourceConstruct: 'module MyProtocolTests { import from MyTemplates all; }',     targetConstruct: '# test_my_protocol.py\nimport pytest\nfrom my_templates import *\nfrom scapy.all import *', notes: 'TTCN-3 module -> Python test module; module import -> Python import; place conftest.py at suite root' },
		{ sourceConstruct: 'testcase TC_PROTO_001() runs on MTC_CT { ... setverdict(pass); }', targetConstruct: 'def test_proto_001(ue_fixture, gnb_fixture):\n    # test body\n    assert result == expected, "TC_PROTO_001: condition failed"', notes: 'TTCN-3 testcase -> pytest test function; verdict pass = implicit (all asserts pass); fixtures inject component equivalents' },
		{ sourceConstruct: 'setverdict(inconc);  // inconclusive verdict',                targetConstruct: 'pytest.skip("INCONC: " + reason + " -- 3GPP TS 36.523 clause 6.3.1")', notes: 'TTCN-3 inconc -> pytest.skip() with reference to TS clause; must not be treated as pass or fail' },
		{ sourceConstruct: 'setverdict(fail, "expected ACK not received");',              targetConstruct: 'pytest.fail("expected ACK not received")', notes: 'TTCN-3 fail verdict -> pytest.fail() with descriptive message' },
		{ sourceConstruct: 'altstep as_ReceiveOrTimeout() { [] pco.receive(t_msg) { ... } [] T_guard.timeout { setverdict(fail, "timeout"); } }', targetConstruct: 'def receive_or_timeout(pco, timeout_s, t_msg_type):\n    result = pco.recv(timeout=timeout_s)\n    if result is None:\n        pytest.fail(f"Timeout after {timeout_s}s waiting for {t_msg_type.__name__}")\n    return result', notes: 'TTCN-3 altstep with timer guard -> Python helper function with timeout; raise pytest.fail on timeout' },
		{ sourceConstruct: 'template RRC_SetupRequest t_rrc_req := { ue_identity := { c_rnti := ? }, cause := mt_access };', targetConstruct: 'class RrcSetupRequestTemplate:\n    def matches(self, pkt) -> bool:\n        return isinstance(pkt, RRCSetupRequest) and pkt.establishment_cause == "mt-Access"', notes: 'TTCN-3 template with wildcard ? -> Python matcher class with matches() method; omit -> field absent check' },
		{ sourceConstruct: 'pco.send(rrc_setup_req) to ue_component;',                   targetConstruct: 'gnb.send_rrc(ue_id, rrc_setup_req)', notes: 'TTCN-3 port send to component -> call simulator/stub send method on fixture; port binding -> fixture parameter' },
		{ sourceConstruct: 'pco.receive(template t_expected) -> value rxMsg',            targetConstruct: 'rx_msg = pco.recv(timeout=T_GUARD)\nassert t_expected.matches(rx_msg), f"Unexpected message: {rx_msg}"', notes: 'TTCN-3 port receive with template match -> recv() + assertion against matcher' },
		{ sourceConstruct: 'timer T_Proc := 5.0; T_Proc.start; ... T_Proc.stop;',       targetConstruct: 'import asyncio\nasync def test_with_timer():\n    async with asyncio.timeout(5.0):\n        await do_procedure()', notes: 'TTCN-3 timer -> asyncio.timeout() in async pytest function (pytest-asyncio); or time.monotonic() for sync tests' },
		{ sourceConstruct: 'modulepar integer PX_MAX_RETRIES := 3;  // module parameter', targetConstruct: 'PX_MAX_RETRIES = int(pytest.ini_get("px_max_retries", default=3))  // or conftest.py variable', notes: 'TTCN-3 module parameters -> pytest.ini / conftest.py constants or pytest fixtures with default values' },
		{ sourceConstruct: 'execute(TC_PROTO_001(), 60.0);  // test execution with timeout', targetConstruct: '@pytest.mark.timeout(60)\ndef test_proto_001(): ...', notes: 'TTCN-3 execute with timeout -> @pytest.mark.timeout(N) decorator from pytest-timeout plugin' },
		{ sourceConstruct: 'component type MTC_CT { var integer v_count; port MyPort pco; }', targetConstruct: '@pytest.fixture\ndef mtc_fixture():\n    ctx = MtcContext(count=0)\n    yield ctx.pco', notes: 'TTCN-3 component type with vars and ports -> pytest fixture yielding port/context object' },
		{ sourceConstruct: 'template PDU t_pdu := { hdr := { version := 2, flags := ? }, payload := omit }', targetConstruct: 'def check_pdu(pkt) -> bool:\n    return pkt.version == 2 and pkt.payload is None', notes: 'Template omit -> field is None / absent check; wildcard ? -> any value accepted (isinstance check sufficient)' },
		{ sourceConstruct: 'log("Sending RRC: ", t_rrc_req);  // TTCN-3 log statement',  targetConstruct: 'logging.getLogger(__name__).debug("Sending RRC: %s", rrc_setup_req)', notes: 'TTCN-3 log() -> Python logging.debug/info; configure pytest logging plugin (--log-cli-level=DEBUG) for verbose output' },
	],

	conventionNotes: [
		'Map every TTCN-3 module to one Python test file (test_<module_name>.py); place shared templates/fixtures in conftest.py',
		'Verdict mapping: pass (implicit) = all asserts succeed; fail = pytest.fail() or AssertionError; inconc = pytest.skip(); error = pytest.raises(Exception)',
		'Use pyasn1 or asn1tools for encoding/decoding 3GPP ASN.1 messages (NAS-PDU, RRC-PDU, RANAP); load ASN.1 schema from 3GPP TS spec annexes',
		'Scapy layers: define custom Scapy Packet subclasses for proprietary/non-standard protocol messages; use Ether()/IP()/UDP() for standard frames',
		'TTCN-3 parallel test components (PTC) -> pytest-asyncio async fixtures with asyncio.gather() for concurrent component simulation',
		'Install: pytest-timeout, pytest-asyncio, scapy, pyasn1, asn1tools; pin versions in requirements-test.txt',
		'Preserve all TTCN-3 test purpose comments as Python docstrings in the test function -- required for 3GPP conformance documentation',
	],

	warningPatterns: [
		'TTCN-3 parallel test components (PTC) with complex alt patterns -- raise decision: requires pytest-asyncio and careful coroutine design; sync tests cannot model true PTC parallelism',
		'Vendor-specific TTCN-3 codecs (TTworkbench ETS, Eclipse Titan) -- raise decision: proprietary ASN.1/codec extensions need replacement with pyasn1/asn1tools + custom additions',
		'ASN.1 SEQUENCE OF with extensibility markers (...)  -- raise decision: asn1tools handles extensions but must be configured with correct ASN.1 extension mode',
		'TTCN-3 external functions (C EF declarations) -- raise design decision: wrap each C EF in Python ctypes or cffi; document EF interface contract',
		'TTCN-3 test configuration with dynamic component creation (mtc.create) -- raise decision: map to pytest fixture factory pattern or asyncio task creation',
		'Timer precision < 10ms -- raise decision: Python time.monotonic() / asyncio resolution is OS-dependent (typically 1-10ms); not suitable for sub-10ms protocol timing',
	],
};


// --- Registry -----------------------------------------------------------------

/**
 * All supported language pair profiles, in priority order.
 * The lookup function searches this array from first to last and returns the
 * first profile matching the (sourceLang, targetLang, profileId?) query.
 */


// --- Generic fallback ---------------------------------------------------------

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
		'Any construct with no clear target equivalent -- raise a rule-interpretation decision',
		'Any data type with precision/scale requirements -- raise a type-mapping decision',
		'Any external call without a visible interface -- raise a naming decision',
	],
};


// --- Registry -----------------------------------------------------------------

/** All registered language pair profiles. Order matters for fallback resolution. */
const PROFILES: ILanguagePairProfile[] = [
	// -- COBOL targets ------------------------------------------------------
	COBOL_TO_JAVA,
	COBOL_TO_TYPESCRIPT,
	COBOL_TO_PYTHON,
	COBOL_TO_GO,

	// -- PL/SQL targets -----------------------------------------------------
	PLSQL_TO_TYPESCRIPT,
	PLSQL_TO_JAVA,
	PLSQL_TO_PYTHON,

	// -- IBM i / RPG --------------------------------------------------------
	RPG_TO_JAVA,

	// -- Java platform ------------------------------------------------------
	JAVAEE_TO_SPRINGBOOT,

	// -- Web / UI -----------------------------------------------------------
	ANGULARJS_TO_ANGULAR,
	COLDFUSION_TO_TYPESCRIPT,

	// -- Enterprise legacy --------------------------------------------------
	PL1_TO_JAVA,
	VB6_TO_CSHARP,
	ABAP_TO_TYPESCRIPT,
	POWERBUILDER_TO_JAVA,

	// -- Low-level ----------------------------------------------------------
	ASSEMBLER_TO_C,
	ADA_TO_CPP,
	FORTRAN_TO_CPP,

	// -- Scientific / data --------------------------------------------------
	FORTRAN_TO_PYTHON,

	// -- Scripting / 4GL ---------------------------------------------------
	NATURAL_TO_JAVA,
	NATURAL_TO_PYTHON,

	// -- Healthcare ---------------------------------------------------------
	MUMPS_TO_PYTHON,

	// -- Firmware: Bare-metal / RTOS ------------------------------------------
	BARE_METAL_C_TO_FREERTOS,
	BARE_METAL_C_TO_ZEPHYR,
	EMBEDDED_C_TO_CPP_MISRA,
	ASSEMBLY_TO_EMBEDDED_C,
	REGISTER_DIRECT_TO_STM32_HAL,
	REGISTER_DIRECT_TO_NXP_SDK,
	FREERTOS_TO_ZEPHYR,
	GENERIC_FIRMWARE_FALLBACK,

	// -- Automotive ------------------------------------------------------------
	AUTOSAR_CLASSIC_TO_ADAPTIVE,
	AUTOSAR_CP_TO_AP_ENHANCED,
	AUTOSAR_CP_SWC_TO_AP_FULL,
	CAN_DBC_TO_CANOPEN,

	// -- Industrial & OT -------------------------------------------------------
	LADDER_TO_STRUCTURED_TEXT,
	PLC_TO_LINUX_RT,
	IEC61131_PLC_TO_LINUXRT_CPP,
	MODBUS_TO_OPCUA,
	IEC61850_TO_OPCUA_MQTT,
	IEC61850_SCL_TO_OPCUA_CPP,
	DNP3_TO_IEC104_TLS,
	CANOPEN_TO_ETHERCAT_COE,

	// -- Telecom & 5G ----------------------------------------------------------
	TTCN3_TO_PYTEST_RF,
	LTE_STACK_TO_ORAN,
	LTE_ENB_TO_ORAN_CUDU,
	SS7_ISUP_MAP_TO_DIAMETER_SIP,
	TTCN3_TO_PYTEST_SCAPY,
];

/**
 * Look up the language pair profile for a given source->target pair.
 * Falls back to the generic profile if no specific pair is registered.
 *
 * Both `sourceLang` and `targetLang` are normalised via `canonicaliseLanguage()`
 * before lookup so aliases resolve correctly (e.g. 'cbl' -> 'cobol').
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

	// Same target, any source -> use generic but inherit target conventions from closest match
	const targetMatch = PROFILES.find(p => canonicaliseLanguage(p.targetLang) === tgt);
	if (targetMatch) {
		return {
			...GENERIC_FALLBACK,
			sourceLang: src,
			targetLang: tgt,
			label: `${src.toUpperCase()} -> ${tgt.toUpperCase()} (generic)`,
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
