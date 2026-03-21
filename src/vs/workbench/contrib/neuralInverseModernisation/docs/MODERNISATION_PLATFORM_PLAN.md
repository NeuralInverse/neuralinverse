# NeuralInverse Modernisation Platform — Complete Build Plan

> One step at a time. A to Z. Universal.

---

## 0. The Core Insight Before Building Anything

Before any code: understand what AI actually does when it modernises a codebase.

When someone asks Claude Code to modernise a COBOL program today, it reads the file
and immediately hits a wall:

```cobol
WORKING-STORAGE SECTION.
    COPY CUSTMAST.
    COPY ACCTBAL.

PROCEDURE DIVISION.
    PERFORM 3000-VALIDATE-CUSTOMER.
    CALL 'DBRT0010' USING WS-CUST-REC.
```

`COPY CUSTMAST` — Claude does not have the copybook. It sees a reference to 40 fields
and has no idea what they are.

`CALL 'DBRT0010'` — Claude does not know what that program does or what interface it
expects.

`PERFORM 3000-VALIDATE-CUSTOMER` — that paragraph might be 300 lines down in the same
file, or in a different file entirely.

So the AI produces a guess. For isolated toy programs it works. For a real 500-program
banking system it fails immediately.

**The same problem exists in every language:**

- Java EE: `@EJB UserSessionBean bean` — what does that bean do?
- Angular 1: `UserService.getAccount()` — what shape does that return?
- PL/SQL: `CALL pkg_billing.calc_fee(acct_id)` — what package, what logic?
- RPG: `CALL 'GLPGM'` — what program, what data structure?

The AI is not the bottleneck. **Missing context is the bottleneck.**

The Modernisation Console exists to solve this. It is not a wizard. It is not a dashboard
with stats. It is the **agent's working memory for the entire migration** — built once,
queried continuously, updated as decisions are made.

---

## 1. What The Modernisation Console Actually Is

### Not This

```
[Step 1: Discovery] → [Step 2: Planning] → [Step 3: Migration] → [Step 4: Validation] → [Step 5: Cutover]
```

A linear wizard forces humans to follow a sequence. Real migrations don't work like that.
A COBOL shop runs 500 programs in production. They migrate 10 at a time over 18 months.
Discovery and migration happen simultaneously. Some units are done. Some are blocked.
Some need human decisions before the AI can proceed.

### This

The Console is a **persistent knowledge workspace** with three roles:

**1. Data Store for Agents**
Everything the AI needs to translate a unit is here:
- The unit's resolved source (with all dependencies expanded inline)
- Every decision already made (type mappings, naming conventions, rule interpretations)
- The business rules extracted from similar units already processed
- The interfaces of units that are already translated

An agent translating unit X asks the Console: "Give me everything you know about X."
The Console answers. The agent translates. The result is consistent with everything
that came before because it drew from the same knowledge base.

**2. Control Surface for Humans**
Humans don't translate code. Humans make decisions that the AI cannot:
- "This field name `WS-ACCT-BAL` means account balance in the billing domain"
- "This rounding logic must use COMP-3 semantics, not IEEE 754 float"
- "This paragraph handles regulatory reporting — compliance officer must approve"

These decisions are recorded in the Console once and applied everywhere automatically.

**3. Progress State**
What is done. What is in-progress. What is blocked and why. What needs a human decision
before the AI can proceed. This is the single source of truth for the entire migration.

---

## 2. Universal — Every Modernisation Type

The platform handles any source language to any target language. The mechanism is
identical. Only the parsers and decomposers change.

### Source Languages Supported (Day 1 Target)

| Language | Unit Type | Key Dependency | Hard Problem |
|----------|-----------|----------------|--------------|
| **COBOL (IBM z/OS)** | Paragraph, Section, Program | Copybooks, JCL | COMP-3 rounding, CICS context |
| **COBOL (Open/MicroFocus)** | Paragraph, Section, Program | Copybooks | Dialect differences |
| **PL/SQL (Oracle)** | Package, Procedure, Function, Trigger | Package specs, types | Autonomous transactions, cursors |
| **RPG (ILE/RPG IV)** | Procedure, Module, Program | Binding directories, service programs | Data structures, pointers |
| **Java EE (JBoss/WAS)** | EJB, Servlet, MDB | JNDI resources, deployment descriptors | Container-managed transactions |
| **Spring (legacy)** | Service, Repository, Controller | XML config, property files | XML context wiring |
| **Angular 1.x** | Controller, Service, Directive | Module dependencies | Scope model, $digest cycle |
| **PL/1** | Procedure, Function | Include files | Storage classes, string handling |
| **Assembler (z/OS)** | CSECT, DSECT | Macros, copybooks | Register conventions, PSW |
| **C (legacy embedded)** | Function, Module | Headers, makefiles | Pointer arithmetic, platform ABI |
| **NATURAL (Adabas)** | Program, Subprogram, Map | Data areas, DDMs | Adabas calls, reporting syntax |
| **Fortran** | Subroutine, Function, Module | Common blocks, include | Precision, array indexing |

### Target Languages Supported

Any modern language. The platform is target-agnostic. The agent is given the target
language and framework as context. Common targets:

- TypeScript / Node.js
- Java 17+ / Spring Boot / Quarkus
- Python 3 / FastAPI / Django
- Go
- Kotlin / Spring
- C# / .NET 6+
- Rust (for embedded/systems rewrites)

### Migration Patterns Handled

Every migration pattern reduces to the same problem: take a unit of business logic,
understand what it does, produce an equivalent in the target language, verify it.

The pattern determines:
- How units are decomposed (one class at a time vs one microservice at a time)
- What "dependency" means (import vs network call vs message)
- What "equivalence" means (byte-for-byte vs semantic vs contract-level)

The Console stores the pattern and uses it to configure every step. The AI is not
pattern-specific. The routing logic is.

---

## 3. How the AI Actually Translates a Unit

This is the core loop. Everything else — the Console, the tools, the knowledge base —
exists to make this loop work reliably at scale.

### The Translation Loop (Per Unit)

```
1. RESOLVE
   Console expands the unit: inline all dependencies
   (copybooks, imports, includes, called interfaces)
   Result: self-contained unit text the AI can read without needing other files

2. LOAD CONTEXT
   Console provides:
   - All type-mapping decisions already made
   - All naming decisions already made
   - Interfaces of units already translated (so calls to them are correct)
   - Business rules extracted from this unit in plain English (Stage 1 result)
   - Compliance fingerprint of this unit (what must be preserved)

3. TRANSLATE
   Agent receives: resolved unit + full context
   Agent produces: target language equivalent
   Agent writes result to draft buffer (not committed yet)

4. VERIFY
   Fingerprint comparison: legacy fingerprint vs modern fingerprint
   Result: pass / warning / blocked
   If blocked: human reviews, makes decision, decision recorded in Console

5. RECORD
   Console updates:
   - Unit status: in-progress → approved / flagged
   - Any new decisions extracted from this translation
   - Modern interface (so subsequent units can call it correctly)
   - Equivalence test result when available
```

### What Makes This Work At Scale

The key is step 2: **context accumulation**. The first unit translated gets minimal
context. The 100th unit translated gets:
- 99 type-mapping decisions already made
- 99 naming decisions already made
- 99 translated interfaces available
- Business patterns recognised from similar units

The AI gets smarter about this specific codebase as the migration progresses because
the Console accumulates decisions and the agent draws from them.

A human making a single decision — "in this codebase, PIC 9(15)V99 always maps to
BigDecimal" — propagates to every remaining unit automatically through the context
injection at step 2.

---

## 4. The Knowledge Base — Core Data Model

This is the central data structure the Console maintains. Everything else reads from
and writes to it.

### IModernisationKnowledgeBase

```typescript
interface IModernisationKnowledgeBase {
    sessionId:   string;
    createdAt:   number;
    updatedAt:   number;

    // The codebase
    units:       Map<string, IKnowledgeUnit>;
    files:       Map<string, IKnowledgeFile>;

    // Decisions made (by humans or AI, recorded once, applied everywhere)
    decisions:   IDecisionLog;

    // What the AI has extracted about business rules
    glossary:    IBusinessGlossary;

    // Progress
    progress:    IProgressState;

    // Audit trail (every change recorded)
    auditLog:    IKnowledgeAuditEntry[];
}
```

### IKnowledgeUnit — The Atom of Migration

```typescript
interface IKnowledgeUnit {
    id:           string;

    // Source
    sourceFile:   string;
    sourceRange:  ICodeRange;
    sourceLang:   string;           // 'cobol' | 'plsql' | 'rpg' | 'java' | ...
    sourceText:   string;           // Raw source text
    resolvedText: string;           // Source with all dependencies expanded inline

    // Identity
    name:         string;           // e.g. 'CALC-LATE-FEE', 'UserService.getUser'
    unitType:     UnitType;         // 'paragraph'|'function'|'class'|'procedure'|...
    riskLevel:    RiskLevel;        // 'low'|'medium'|'high'|'critical'

    // Relationships
    dependsOn:    string[];         // IDs of units this unit calls/imports/copies
    usedBy:       string[];         // IDs of units that call/import/copy this unit

    // What the AI knows about this unit
    businessRules:    IBusinessRule[];    // Plain English: what this unit does
    fingerprint:      IComplianceFingerprint | undefined;

    // Translation state
    status:           UnitStatus;
    targetFile?:      string;
    targetRange?:     ICodeRange;
    targetText?:      string;             // Draft or committed translated code
    targetInterface?: IUnitInterface;     // The public interface after translation

    // Verification
    fingerprintComparison?: IFingerprintComparison;
    equivalenceResult?:     IEquivalenceResult;

    // Approvals
    approvals:        IApprovalRecord[];
    blockedReason?:   string;
}

type UnitType =
    | 'paragraph'       // COBOL
    | 'section'         // COBOL
    | 'program'         // COBOL / RPG
    | 'copybook'        // COBOL
    | 'jcl-step'        // JCL
    | 'procedure'       // PL/SQL / RPG / stored proc
    | 'function'        // PL/SQL / most languages
    | 'package'         // PL/SQL / Java
    | 'class'           // Java / C# / TypeScript
    | 'module'          // TypeScript / Go / Python
    | 'component'       // Angular / React
    | 'service'         // Angular / Spring
    | 'controller'      // Spring / Angular
    | 'trigger'         // PL/SQL / DB
    | 'macro'           // Assembler / C
    | 'subroutine'      // Fortran / RPG
    | 'include';        // Any (shared header / copybook equivalent)

type UnitStatus =
    | 'pending'         // Not started
    | 'resolving'       // Dependencies being expanded
    | 'ready'           // Resolved and ready for AI translation
    | 'translating'     // Agent is working on it
    | 'review'          // Draft complete, awaiting human review
    | 'flagged'         // Fingerprint divergence — needs approval
    | 'approved'        // Translation approved, ready to commit
    | 'committed'       // Written to disk and committed to VCS
    | 'validating'      // Equivalence test running
    | 'validated'       // Equivalence test passed
    | 'complete'        // All done
    | 'skipped'         // Deliberately excluded
    | 'blocked';        // Cannot proceed — human action required

type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
```

### IDecisionLog — Human Decisions That Apply Everywhere

```typescript
interface IDecisionLog {
    typeMapping:    ITypeMappingDecision[];
    naming:         INamingDecision[];
    ruleInterpret:  IRuleInterpretation[];
    exclusions:     IExclusionDecision[];
    patternOverrides: IPatternOverride[];
}

// "PIC 9(15)V99 always maps to BigDecimal"
interface ITypeMappingDecision {
    id:          string;
    sourceType:  string;    // e.g. 'PIC 9(15)V99', 'NUMBER(15,2)', 'DECIMAL(10,4)'
    targetType:  string;    // e.g. 'BigDecimal', 'decimal', 'Decimal'
    rationale:   string;
    appliesTo:   string[];  // [] means all units
    decidedBy:   string;
    decidedAt:   number;
}

// "WS-ACCT-BAL → accountBalance, domain: billing"
interface INamingDecision {
    id:          string;
    sourceName:  string;
    targetName:  string;
    domain:      string;
    decidedBy:   string;
    decidedAt:   number;
}

// "This PERFORM loop is the commission calculation, not an error handler"
interface IRuleInterpretation {
    id:         string;
    unitId:     string;
    sourceText: string;     // The specific code or pattern
    meaning:    string;     // Plain English interpretation
    domain:     string;     // Business domain
    decidedBy:  string;
    decidedAt:  number;
}

// "DBRT0010 is a utility — translate as a static helper, not a service"
interface IPatternOverride {
    id:           string;
    pattern:      string;   // regex or exact name
    overrideType: string;   // 'translation-strategy' | 'risk-level' | 'unit-type'
    value:        string;
    decidedBy:    string;
    decidedAt:    number;
}
```

### IBusinessGlossary — What The AI Has Learned About This Codebase

```typescript
interface IBusinessGlossary {
    terms: IBusinessTerm[];
    domains: IBusinessDomain[];
    patterns: IRecognisedPattern[];
}

// A named concept extracted from the codebase
interface IBusinessTerm {
    term:        string;     // e.g. 'CUSTMAST', 'WS-ACCT-BAL', 'DBRT0010'
    meaning:     string;     // Plain English
    domain:      string;     // e.g. 'billing', 'customer', 'settlement'
    sourceLocs:  string[];   // Unit IDs where this term appears
    extractedBy: 'ai' | 'human';
    confidence:  number;     // 0–1
}

// A domain extracted from the codebase
interface IBusinessDomain {
    name:        string;     // e.g. 'fee_calculation', 'audit_trail'
    description: string;
    units:       string[];   // Unit IDs that belong to this domain
    regulated:   boolean;    // Whether this domain has GRC implications
}

// A pattern the AI recognised across multiple units
interface IRecognisedPattern {
    name:        string;     // e.g. 'end-of-day-settlement', 'input-validation'
    description: string;
    examples:    string[];   // Unit IDs where this pattern appears
    targetPattern?: string;  // What this becomes in the target language
}
```

### IProgressState

```typescript
interface IProgressState {
    totalUnits:     number;
    byStatus:       Record<UnitStatus, number>;
    byRisk:         Record<RiskLevel, number>;
    byPhase:        IPhaseProgress[];
    blockedUnits:   string[];   // Unit IDs that need human action
    pendingDecisions: IPendingDecision[];  // Decisions the AI needs a human to make
}

interface IPendingDecision {
    id:          string;
    unitId:      string;
    type:        'type-mapping' | 'naming' | 'rule-interpretation' | 'approval';
    question:    string;    // What the AI is asking the human
    context:     string;    // Why it cannot decide alone
    options?:    string[];  // Suggested answers
    priority:    'low' | 'medium' | 'high' | 'blocking';
}
```

---

## 5. The Agent Tool Set

These are the tools registered in the Console that agents call. Not stats. Data.

### Read Tools (Agent → Console)

```typescript
// Get a unit with all dependencies resolved inline, ready to translate
get_unit_context(unitId: string): {
    unit: IKnowledgeUnit;
    resolvedSource: string;   // source + all copybooks/imports expanded
    decisions: IDecisionLog;  // all decisions made so far
    relatedRules: IBusinessRule[];  // rules from similar units already done
    calledInterfaces: IUnitInterface[];  // interfaces of units this calls, already translated
}

// Get the dependency graph for a unit (what must be done before this)
get_dependencies(unitId: string): {
    directDeps: IKnowledgeUnit[];
    transitiveDeps: IKnowledgeUnit[];
    blockedBy: string[];    // dep IDs not yet translated
    readyToTranslate: boolean;
}

// Get all decisions made so far (type mappings, naming, interpretations)
get_decisions(): IDecisionLog;

// Get what the AI has already learned about the codebase
get_glossary(domain?: string): IBusinessGlossary;

// Get the next unit to work on (dependency-ordered, risk-ordered)
get_next_unit(options?: { riskLevel?: RiskLevel; domain?: string }): IKnowledgeUnit | null;

// Get all units in a given state
get_units_by_status(status: UnitStatus): IKnowledgeUnit[];

// Get all units blocked waiting for human decisions
get_blocked_units(): { unit: IKnowledgeUnit; reason: string; pendingDecision: IPendingDecision }[];

// Search units by name, domain, or pattern
search_units(query: string): IKnowledgeUnit[];

// Get the fingerprint for a unit (legacy)
get_fingerprint(unitId: string): IComplianceFingerprint | null;
```

### Write Tools (Agent → Console)

```typescript
// Record the translation result for a unit
record_translation(unitId: string, targetCode: string, targetFile: string): void;

// Record a business rule extracted from a unit
record_business_rule(unitId: string, rule: IBusinessRule): void;

// Record a term in the business glossary
record_glossary_term(term: IBusinessTerm): void;

// Record a decision (the AI can propose, human confirms, or agent records human choice)
record_decision(decision: ITypeMappingDecision | INamingDecision | IRuleInterpretation): void;

// Update unit status
set_unit_status(unitId: string, status: UnitStatus, reason?: string): void;

// Flag a unit as blocked, with the question needing a human answer
flag_blocked(unitId: string, pendingDecision: IPendingDecision): void;

// Record equivalence test result
record_equivalence(unitId: string, result: IEquivalenceResult): void;
```

### Human Decision Tools (Console → Human)

These surface in the Console UI as decision prompts:

```typescript
// Asks human: "How should PIC 9(15)V99 be represented in TypeScript?"
request_type_mapping(sourceType: string, context: string, suggestions: string[]): Promise<string>;

// Asks human: "What does WS-ACCT-BAL mean? Suggest: accountBalance (billing domain)"
request_naming_decision(sourceName: string, context: string): Promise<{ name: string; domain: string }>;

// Asks human: "Is this paragraph a fee calculation or an error handler?"
request_rule_interpretation(unitId: string, question: string, options: string[]): Promise<string>;

// Asks human: "This fingerprint divergence requires compliance approval"
request_compliance_approval(unitId: string, divergence: IFingerprintDivergence): Promise<IApprovalRecord>;
```

---

## 6. The Console UI — What It Actually Shows

Not stats. Not a progress wizard. A **data workspace** with four views:

### View 1: Unit Index
Every unit in the codebase. Filter by status, risk, domain, language. Click a unit to
see its full context: resolved source, business rules, decisions that apply, translation
status, fingerprint comparison. This is the map of the entire migration.

### View 2: Pending Decisions
Everything waiting for a human. Ordered by priority (blocking first). Each item shows:
the question, the context (which units are blocked waiting for this), and suggested
answers. Human answers one decision and potentially unblocks 50 units.

### View 3: Decision Log
Every decision ever made. Type mappings. Naming conventions. Rule interpretations.
Approval records. Searchable. Reversible (with impact analysis showing which units
would be affected by changing a decision).

### View 4: Progress
Not a progress bar. A breakdown: X units pending, Y translating, Z flagged, W blocked.
Grouped by phase (dependency-ordered phases from the plan). Agents use this to pick
what to work on next.

### The Two-Window Editor (Per Unit)
When working on a specific unit: legacy source left (read-only, with dependencies
expanded), modern draft right. Compliance strip at bottom shows fingerprint comparison
in real time. Unit navigator on the left rail.

---

## 7. Build Plan — A to Z

One step at a time. Each step is independently valuable. Each step builds on the last.

---

### Phase 0: Knowledge Base Foundation
*Goal: The data structure that everything else depends on.*

| Step | What | File |
|------|------|------|
| 0.1 | `IModernisationKnowledgeBase` and all sub-types | `common/knowledgeBaseTypes.ts` |
| 0.2 | `IKnowledgeBaseService` — CRUD + query + persistence | `browser/knowledgeBaseService.ts` |
| 0.3 | `IKnowledgeBaseService` registered as DI singleton | `neuralInverseModernisation.contribution.ts` |
| 0.4 | Persistence: save/load from workspace storage (survives reload) | `browser/knowledgeBaseService.ts` |
| 0.5 | Unit tests: CRUD, filtering, serialisation | `test/knowledgeBaseService.test.ts` |

**Gate:** Knowledge base persists across IDE restarts. Querying 10,000 units is fast.

---

### Phase 1: Universal Parser + Dependency Resolver
*Goal: Take any source file and produce resolved, self-contained units.*

| Step | What | File |
|------|------|------|
| 1.1 | `ILanguageParser` interface + `IParserRegistry` | `browser/engine/parsers/parserRegistry.ts` |
| 1.2 | `IDependencyResolver` interface | `browser/engine/parsers/dependencyResolver.ts` |
| 1.3 | COBOL parser: programs, paragraphs, sections, working-storage | `browser/engine/parsers/cobolParser.ts` |
| 1.4 | COBOL copybook resolver: expand COPY statements inline | `browser/engine/parsers/cobolCopybookResolver.ts` |
| 1.5 | COBOL JCL parser: job steps, DD cards, program calls | `browser/engine/parsers/jclParser.ts` |
| 1.6 | PL/SQL parser: packages, procedures, functions, triggers | `browser/engine/parsers/plsqlParser.ts` |
| 1.7 | Java parser: classes, methods, EJBs, Spring beans | `browser/engine/parsers/javaParser.ts` |
| 1.8 | TypeScript/JavaScript parser: modules, classes, functions | `browser/engine/parsers/typescriptParser.ts` |
| 1.9 | RPG parser: procedures, modules, service programs | `browser/engine/parsers/rpgParser.ts` |
| 1.10 | Generic AST fallback parser (tree-sitter) for other languages | `browser/engine/parsers/genericParser.ts` |
| 1.11 | `IUnitDecomposer`: language → `IKnowledgeUnit[]` (uses parser + resolver) | `browser/engine/unitDecomposer.ts` |
| 1.12 | `IDependencyGraphBuilder`: build `dependsOn`/`usedBy` maps | `browser/engine/dependencyGraphBuilder.ts` |

**Gate:** Point at a COBOL program with 10 copybook dependencies. Get back a
`IKnowledgeUnit` whose `resolvedText` contains the full expanded source. Do the same
for a Java EE project. Same interface, different parser.

---

### Phase 2: Business Rule Extraction
*Goal: For every unit, extract what it does in plain English and which business domains it touches.*

| Step | What | File |
|------|------|------|
| 2.1 | `IBusinessRuleExtractor` interface | `browser/engine/businessRuleExtractor.ts` |
| 2.2 | Deterministic extractor: field names, constants, known patterns → rules | `browser/engine/deterministicRuleExtractor.ts` |
| 2.3 | LLM extractor: `sendOneShotQuery` on resolved unit → structured rules | `browser/engine/llmRuleExtractor.ts` |
| 2.4 | Domain classifier: which GRC/business domains does this unit touch? | `browser/engine/domainClassifier.ts` |
| 2.5 | Risk scorer: Low/Medium/High/Critical based on domains + regulated fields | `browser/engine/riskScorer.ts` |
| 2.6 | Glossary builder: extract named terms + domains from units | `browser/engine/glossaryBuilder.ts` |
| 2.7 | Rate limiter + batch queue (LLM calls, same pattern as ContractReasonService) | built into 2.3 |

**Gate:** Take a COBOL paragraph that calculates a late fee. The extractor produces:
"Calculates late fee when account balance exceeds credit limit after grace period.
Touches domains: fee_calculation, account_management. Risk: High."

---

### Phase 3: Fingerprint Engine
*Goal: Build and compare compliance fingerprints for any unit in any language.*

| Step | What | File |
|------|------|------|
| 3.1 | `IComplianceFingerprint` types (universal — already partially in `modernisationTypes.ts`) | `common/fingerprintTypes.ts` |
| 3.2 | Deterministic fingerprint extractor: regulated fields, invariants | `browser/engine/fingerprint/deterministicExtractor.ts` (exists, extend) |
| 3.3 | LLM semantic fingerprint extractor: semantic rules, domain classification | `browser/engine/fingerprint/llmSemanticExtractor.ts` (exists, extend) |
| 3.4 | Fingerprint comparison engine: structural diff, match %, divergences | `browser/engine/fingerprint/fingerprintComparisonService.ts` (exists, extend) |
| 3.5 | Language-specific regulated field patterns: COBOL PIC, SQL column types, Java annotations | `browser/engine/fingerprint/regulatedFieldPatterns.ts` |
| 3.6 | Invariant extraction: mathematical rules that must hold across translation | `browser/engine/fingerprint/invariantExtractor.ts` |

**Gate:** Translate a COBOL fee calculation paragraph. Introduce a deliberate rounding
error. The fingerprint comparison catches it (blocked). Fix the rounding. Comparison
passes. Works the same for a PL/SQL procedure.

---

### Phase 4: Translation Engine
*Goal: Translate any unit given its resolved context. The AI loop.*

| Step | What | File |
|------|------|------|
| 4.1 | `ITranslationEngine` interface | `browser/engine/translation/translationEngine.ts` |
| 4.2 | Context assembler: unit + decisions + glossary + interfaces → prompt | `browser/engine/translation/contextAssembler.ts` |
| 4.3 | Prompt builder: structured prompt per source→target language pair | `browser/engine/translation/promptBuilder.ts` |
| 4.4 | LLM caller: streamed generation via `sendLLMMessage` | `browser/engine/translation/llmCaller.ts` |
| 4.5 | Output parser: extract translated code from LLM response | `browser/engine/translation/outputParser.ts` |
| 4.6 | Interface extractor: derive the public interface of the translated unit | `browser/engine/translation/interfaceExtractor.ts` |
| 4.7 | Decision harvester: extract new type mappings / naming decisions from the translation | `browser/engine/translation/decisionHarvester.ts` |
| 4.8 | Draft buffer: hold translated code as pending until approved | `browser/engine/translation/draftBuffer.ts` |
| 4.9 | Translation loop orchestrator: resolve → context → translate → fingerprint → record | `browser/engine/translation/translationOrchestrator.ts` |
| 4.10 | Retry logic: if fingerprint blocked, try translation again with divergence as context | built into 4.9 |

**Gate:** Point the engine at a single COBOL paragraph. It resolves dependencies, builds
context from the knowledge base, translates, compares fingerprints, and records the
result. Works without any human involvement for a low-risk unit.

---

### Phase 5: Knowledge Base Agent Tools
*Goal: Register all read/write tools so agents can query and update the knowledge base.*

| Step | What | File |
|------|------|------|
| 5.1 | `get_unit_context` tool | `browser/tools/knowledgeTools.ts` |
| 5.2 | `get_dependencies` tool | `browser/tools/knowledgeTools.ts` |
| 5.3 | `get_decisions` tool | `browser/tools/knowledgeTools.ts` |
| 5.4 | `get_glossary` tool | `browser/tools/knowledgeTools.ts` |
| 5.5 | `get_next_unit` tool | `browser/tools/knowledgeTools.ts` |
| 5.6 | `get_units_by_status` tool | `browser/tools/knowledgeTools.ts` |
| 5.7 | `search_units` tool | `browser/tools/knowledgeTools.ts` |
| 5.8 | `record_translation` tool | `browser/tools/knowledgeTools.ts` |
| 5.9 | `record_business_rule` tool | `browser/tools/knowledgeTools.ts` |
| 5.10 | `record_decision` tool | `browser/tools/knowledgeTools.ts` |
| 5.11 | `set_unit_status` tool | `browser/tools/knowledgeTools.ts` |
| 5.12 | `flag_blocked` tool | `browser/tools/knowledgeTools.ts` |
| 5.13 | Register all tools with `IVoidInternalToolService` + PowerMode + Checks | `browser/knowledgeToolsContrib.ts` |

**Gate:** An agent in Void or Power Mode can call `get_unit_context('CALC-LATE-FEE')`
and receive the full resolved source, all relevant decisions, and the business rules.
It can call `record_translation(...)` and the Console updates immediately.

---

### Phase 6: Scanning + Discovery (connects Phase 1+2+3 to knowledge base)
*Goal: Scan a codebase and populate the knowledge base.*

| Step | What | File |
|------|------|------|
| 6.1 | `IModernisationScanService` — orchestrates full codebase scan | `browser/modernisationScanService.ts` |
| 6.2 | Walk files → parse → decompose → build graph → extract rules → fingerprint | built into scan service |
| 6.3 | Progress events: `onDidProgress` per file, per unit, per phase | built into scan service |
| 6.4 | Incremental scan: only re-scan changed files | built into scan service |
| 6.5 | Scan result stored in knowledge base | built into scan service |
| 6.6 | Connect to existing `IDiscoveryService` (feed results in) | `browser/modernisationScanService.ts` |

**Gate:** Scan a COBOL project with 50 programs and 100 copybooks. Knowledge base
populated with all units, resolved text, business rules, fingerprints, dependency graph.
Scan a Java EE project. Same result, different parsers.

---

### Phase 7: Console UI — Data Workspace
*Goal: The four views. Data for humans and agents, not stats.*

| Step | What | File |
|------|------|------|
| 7.1 | Unit Index view: filterable list of all units, status, risk, domain | `browser/ui/views/unitIndexView.ts` |
| 7.2 | Unit detail panel: resolved source, business rules, decisions, fingerprint | `browser/ui/views/unitDetailPanel.ts` |
| 7.3 | Pending Decisions view: blocking decisions ordered by impact | `browser/ui/views/pendingDecisionsView.ts` |
| 7.4 | Decision input widgets: type mapping, naming, rule interpretation forms | `browser/ui/views/decisionInputWidgets.ts` |
| 7.5 | Decision Log view: all decisions, searchable, reversible with impact analysis | `browser/ui/views/decisionLogView.ts` |
| 7.6 | Progress view: units by status/risk/phase (breakdown, not progress bar) | `browser/ui/views/progressView.ts` |
| 7.7 | Console shell: tab/panel layout connecting all four views | `browser/ui/modernisationConsole.ts` |
| 7.8 | Replace current `ModernisationPart` wizard flow with Console shell | `browser/ui/modernisationPart.ts` |

---

### Phase 8: Two-Window Editor (Per-Unit Translation UI)
*Goal: Side-by-side unit translation with live fingerprint comparison.*

| Step | What | File |
|------|------|------|
| 8.1 | `ModernisationUnitEditorInput`: custom editor owning both panes | `browser/ui/editor/modernisationUnitEditorInput.ts` |
| 8.2 | Legacy pane: read-only, resolved source, highlights regulated fields | `browser/ui/editor/legacyEditorPane.ts` |
| 8.3 | Modern pane: draft buffer, target language, live fingerprint overlay | `browser/ui/editor/modernEditorPane.ts` |
| 8.4 | Compliance strip widget: fingerprint match %, divergence list, approve/block | `browser/ui/editor/complianceStripWidget.ts` |
| 8.5 | Unit navigator: left rail, all units, status badges, click to navigate | `browser/ui/editor/unitNavigator.ts` |
| 8.6 | Semantic scroll sync: navigate by unit, not by line | `browser/ui/editor/semanticScrollSync.ts` |
| 8.7 | Draft buffer visual treatment: pending background + approval banner | built into 8.3 |

---

### Phase 9: Planning Engine (connects knowledge base to roadmap)
*Goal: Use the knowledge base to generate an ordered migration plan.*

| Step | What | File |
|------|------|------|
| 9.1 | Dependency-ordered phase builder (uses `dependsOn` graph from KB) | existing `engine/planning/phaseBuilder.ts` — connect to KB |
| 9.2 | Risk-ordered sequencing within phases | existing planning engine — connect to KB |
| 9.3 | Compliance gate insertion (High/Critical units get approval gates) | existing planning engine — connect to KB |
| 9.4 | Plan stored in knowledge base (not separate state) | update `modernisationSessionService.ts` |
| 9.5 | Plan approval recorded in knowledge base audit log | update approval flow |

---

### Phase 10: Validation Engine
*Goal: Run legacy and modern code against identical inputs, compare outputs.*

| Step | What | File |
|------|------|------|
| 10.1 | `IOutputEquivalenceService` — test harness runner | `browser/engine/validation/outputEquivalenceService.ts` |
| 10.2 | COBOL test runner: compile + run with test inputs via z/OS emulator or GnuCOBOL | `browser/engine/validation/cobolTestRunner.ts` |
| 10.3 | Generic test runner: execute arbitrary programs with stdin/stdout comparison | `browser/engine/validation/genericTestRunner.ts` |
| 10.4 | Divergence detector: value, rounding, record count, checksum | `browser/engine/validation/divergenceDetector.ts` |
| 10.5 | Evidence generator: test report included in audit package | `browser/engine/validation/equivalenceReportService.ts` |
| 10.6 | Connect equivalence results to unit status in knowledge base | built into 10.1 |

---

### Phase 11: Audit Trail + Cutover
*Goal: Tamper-evident log of everything. Full compliance report.*

| Step | What | File |
|------|------|------|
| 11.1 | `IModernisationAuditService`: hash-chained records, all migration events | `browser/audit/modernisationAuditService.ts` |
| 11.2 | Compliance report generator: full audit package from knowledge base + audit log | `browser/audit/complianceReportGenerator.ts` |
| 11.3 | Parallel run monitor: compare production outputs in real time | `browser/cutover/parallelRunMonitor.ts` |
| 11.4 | Rollback service: automatic on production divergence | `browser/cutover/rollbackService.ts` |

---

### Phase 12: Agent Integration
*Goal: Void Agent and Power Mode can drive the entire migration autonomously.*

| Step | What | File |
|------|------|------|
| 12.1 | All Phase 5 tools available in Void Agent + Power Mode (already done for discovery tools) | connect to knowledge tools |
| 12.2 | Agent workflow: `get_next_unit` → `get_unit_context` → translate → `record_translation` → `set_unit_status` | agent uses existing tool loop |
| 12.3 | Blocked unit handling: agent calls `flag_blocked`, Console surfaces decision to human, agent polls for resolution | `browser/engine/translation/translationOrchestrator.ts` |
| 12.4 | Multi-agent parallelism: multiple agents working on independent units simultaneously | via `INeuralInverseSubAgentService` (existing) |
| 12.5 | Agent decision harvesting: agent extracts decisions from its own translations and proposes them | built into `decisionHarvester.ts` |

---

## 8. What We Do NOT Build (Scope Boundaries)

| What | Why Not |
|------|---------|
| COBOL compiler | Use GnuCOBOL or IBM toolchain for equivalence testing |
| IDE for the target language | That is VS Code — it is already the IDE |
| CI/CD pipeline | Out of scope — the Console generates the audit package, customer plugs it into their pipeline |
| CICS emulator | Phase 10 initial version uses file-based test harnesses; CICS support is a future milestone |
| Web console for compliance officers | Phase 1 is in-IDE only. Web console is a separate future product |
| LLM training on legacy code | We use the LLM as-is via the Void layer. No fine-tuning in scope |

---

## 9. Key Design Principles

**1. The knowledge base is the product.**
Everything else — the UI, the agent tools, the parser, the fingerprint engine — exists to
populate and consume the knowledge base. A migrated codebase with a full knowledge base
is an asset the customer owns forever.

**2. Agents are optional accelerators, not the mechanism.**
A human can do every step manually using the Console. Agents make it faster. This is
important for regulated environments where every action must be auditable.

**3. One decision, applied everywhere.**
A human decides once how `PIC 9(15)V99` maps to a type. That decision propagates to
every remaining unit automatically. The value of the Console grows with every decision
made.

**4. Nothing gets committed without a fingerprint comparison.**
Low-risk units: automated comparison, auto-approved if pass. High-risk units: human
review required. Critical units: compliance officer approval required. This is
non-negotiable and cannot be bypassed.

**5. Universal from day 1.**
The parser is pluggable. The decomposer is language-specific but the output type
(`IKnowledgeUnit`) is universal. Every downstream service — fingerprint, translation,
validation, audit — speaks `IKnowledgeUnit` and is therefore language-agnostic.

**6. Progressive disclosure.**
Start with COBOL because it is the hardest case. Every other language is a subset.
If the fingerprint comparison is reliable for COBOL `COMP-3` rounding semantics, it
is reliable for everything.

---

## 10. First Step

Phase 0, Step 0.1: define `IModernisationKnowledgeBase` and all its sub-types in
`common/knowledgeBaseTypes.ts`.

Every subsequent step is a service or UI that reads from or writes to this type.
Get the type right and the rest follows.
