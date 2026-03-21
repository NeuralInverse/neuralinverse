# FingerprintService — Architecture & Developer Guide

## What Is a Compliance Fingerprint?

A compliance fingerprint is **not** a hash. It is a structured JSON artifact that represents what a unit of code does from a regulatory perspective. It answers:

- Which regulated fields does this unit touch? (account balances, card numbers, tax amounts…)
- What logical constraints must survive translation? (COMP-3 rounding, transaction atomicity…)
- What business rules does it implement? (calculates late fee at 1.5% after 30 days…)
- Which compliance domains does it belong to? (fee_calculation, settlement, PCI-DSS…)

Two fingerprints are compared **structurally** to determine whether regulatory meaning changed during translation. The LLM builds the fingerprint — it never compares it.

---

## Two-Layer Extraction Architecture

```
Source Code
    │
    ├──► Layer 1: Deterministic Extractor       (fast, no LLM, regex + structural)
    │       │   COMP-3 fields, PIC S9 clauses,
    │       │   field name pattern matching,
    │       │   CICS operations, paragraph names
    │       │
    │       └──► IRegulatedField[]  +  ILogicalInvariant[]
    │
    └──► Layer 2: LLM Semantic Extractor        (slower, LLM call, language-agnostic)
            │   Given source + Layer 1 fields,
            │   asks LLM to explain what it DOES
            │   in compliance terms
            │
            └──► ISemanticRule[]  +  string[] complianceDomains  +  ILogicalInvariant[]
                         │
                         └──► Assembled into IComplianceFingerprint
```

Layer 1 runs first, always, synchronously. It produces deterministic results with no LLM call. Layer 2 enriches the fingerprint with semantic meaning. If the LLM call fails, the fingerprint is still valid — `llmExtractionComplete: false` signals that Layer 2 is pending.

---

## Module Structure

```
browser/engine/fingerprint/
├── docs/
│   └── FINGERPRINT_SERVICE.md          ← You are here
│
├── impl/
│   ├── languageRegistry.ts             Language profiles: aliases, Layer 1 support, terminology
│   ├── fingerprintCache.ts             Content-hash + schema-version cache (FNV-1a key)
│   ├── fingerprintAssembler.ts         Merges Layer 1 + Layer 2 → IComplianceFingerprint
│   ├── fingerprintScheduler.ts         Priority queue + concurrency control for LLM jobs
│   ├── fingerprintVersioning.ts        Schema versioning; invalidates stale fingerprints
│   ├── progressEmitter.ts              Progress events during batch fingerprinting
│   ├── batchFingerprintEngine.ts       Batch-processes all units in a KB session
│   └── businessRuleAdapter.ts         ISemanticRule[] + ILogicalInvariant[] → IBusinessRule[] for KB
│
├── deterministicExtractor.ts           Layer 1 (existing)
├── llmSemanticExtractor.ts             Layer 2 (existing)
│
├── service.ts                          IFingerprintService public interface
├── FingerprintServiceImpl.ts           Full implementation
└── index.ts                            DI registration + re-exports
```

---

## IFingerprintService — Key Methods

### Single-Unit Methods

| Method | Description |
|---|---|
| `fingerprintKBUnit(unitId)` | Full pipeline: Layer 1 + Layer 2 → writes fingerprint + business rules to KB |
| `compareKBUnit(unitId)` | Fingerprints target text, compares to source fingerprint, writes result to KB |
| `fingerprintSource(unitId, source, lang, name)` | Raw extraction — returns fingerprint without touching KB |
| `getCached(contentHash)` | Read cache by content hash — no extraction |
| `invalidate(unitId)` | Remove unit's cached fingerprint (e.g. after source drift alert) |

### Batch Methods

| Method | Description |
|---|---|
| `batchFingerprintKB(options?)` | Fingerprint all un-fingerprinted units in the active KB |
| `cancelBatch()` | Abort in-progress batch |
| `onDidFingerprintUnit` | Event fires for every unit completed during batch |
| `onDidCompleteBatch` | Event fires when batch finishes or is cancelled |

---

## Fingerprint Cache

Cache key: `FNV-1a(sourceText) + ':' + schemaVersion`

This means:
- If the source text changes → cache miss → re-extract
- If the extraction schema version bumps → cache miss → re-extract
- If neither changes → cache hit → instant return, no LLM call

The cache stores up to **10,000 entries**. LRU eviction applies when full. The cache is **in-memory only** — it does NOT persist across IDE restarts. The KB itself (via `IKnowledgeBaseService`) is the persistent store. The cache is purely a runtime performance optimisation to avoid duplicate LLM calls during a session.

---

## Schema Versioning

`FINGERPRINT_SCHEMA_VERSION` is the single source of truth. It is incremented when:
- New patterns are added to `legacyPatternRegistry.ts`
- New invariant types are added
- The LLM prompt changes significantly

At service startup, the KB is scanned for fingerprints with an older schema version. Those units are added to the re-fingerprint queue at low priority.

`migrateSchema(kb)` performs this scan and schedules re-extraction. It does NOT block startup — re-fingerprinting runs as background work.

---

## Batch Fingerprinting — Order and Concurrency

Units are fingerprinted in this priority order:
1. `critical` risk units
2. `high` risk units
3. `medium` risk units
4. `low` risk units

Within each risk tier, units with more dependents are fingerprinted before units with fewer (widest blast radius first).

Default concurrency: **3 parallel LLM calls**. Configurable via `IBatchFingerprintOptions.maxConcurrency`. The deterministic Layer 1 runs inline (no concurrency limit needed — it's synchronous regex).

---

## Business Rule Adapter

After Layer 2 extraction, the `businessRuleAdapter` converts `ISemanticRule[]` → `IBusinessRule[]` in the KB format and:
1. Calls `kb.recordBusinessRules(unitId, rules)` — persists to KB
2. Calls `kb.assignUnitToDomain(unitId, domain)` for each compliance domain — populates domain index
3. Updates the glossary if new terms are identified

This is the bridge that makes the fingerprint engine feed the Knowledge Base. Without this adapter, the fingerprint lives only on the unit record but the KB's domain index, business rule queries, and `getBusinessRulesForDomain()` would return empty.

---

## Fingerprint Comparison Flow

```
Source Unit          Target Unit
(legacy code)        (translated code)
     │                    │
     ▼                    ▼
fingerprintSource()  fingerprintTarget()
     │                    │
     └──────────┬─────────┘
                ▼
     FingerprintComparisonService.compare()
                │
                ▼
     IFingerprintComparison
         matchPercentage: 95
         overallResult: 'pass' | 'warning' | 'blocked'
         divergences: IFingerprintDivergence[]
                │
                ▼
     kb.recordFingerprintComparison(unitId, comparison)
                │
     if result === 'blocked' → kb.setUnitStatus(unitId, 'flagged')
```

A `blocked` result sets the unit to `'flagged'` status and creates a pending decision for a compliance officer to review. A `warning` result is informational — the developer can approve. A `pass` result allows the unit to advance normally.

---

## Language Support

| Language | Layer 1 Patterns | Layer 2 (LLM) | Notes |
|---|---|---|---|
| COBOL (IBM z/OS) | ✅ Full | ✅ | Primary target. COMP-3, PIC, CICS patterns. |
| PL/SQL (Oracle) | ✅ Full | ✅ | NUMBER(p,s), COMMIT/ROLLBACK, DBMS_AUDIT |
| RPG (AS/400) | ✅ Full | ✅ | Packed decimal P-spec, COMMIT/ROLBK |
| NATURAL/ADABAS | ✅ Full | ✅ | Packed numeric, ADABAS FIND/STORE |
| Java EE | ✅ Full | ✅ | BigDecimal, @Transactional, JPA annotations |
| Python 2 | ✅ Full | ✅ | Decimal import, db commit |
| VB6 / VBA | ✅ Full | ✅ | Currency type, ADO transactions |
| PL/1 | ⚠️ Layer 2 only | ✅ | FIXED DECIMAL patterns — TODO Layer 1 |
| NATURAL/z (BS2000) | ⚠️ Layer 2 only | ✅ | Similar to NATURAL |
| Assembler (z/OS) | ⚠️ Layer 2 only | ✅ | Pattern matching non-trivial |
| Fortran 77/90 | ⚠️ Layer 2 only | ✅ | DOUBLE PRECISION + COMMON blocks |
| Angular 1 (JS) | ⚠️ Layer 2 only | ✅ | JS/TS patterns — TODO Layer 1 |
| C / C++ | ⚠️ Layer 2 only | ✅ | Double/float monetary — TODO Layer 1 |

Languages without Layer 1 patterns still get full semantic extraction via the LLM (Layer 2). Layer 1 just adds the deterministic, zero-cost structural check.

---

## Adding a New Language

1. Add field patterns, structural patterns, and procedure/function patterns to `legacyPatternRegistry.ts`
2. Add a `ILanguageProfile` entry in `impl/languageRegistry.ts`
3. No changes needed anywhere else — the FingerprintService automatically picks up new registry entries

---

## Error Handling

| Failure Mode | Behaviour |
|---|---|
| Layer 2 LLM call fails (network, timeout) | Fingerprint is stored with `llmExtractionComplete: false`. Unit is not blocked. Layer 2 retried on next `fingerprintKBUnit()` call. |
| Layer 2 returns invalid JSON | `parseExtractionResponse` returns empty arrays. Fingerprint stored as Layer 1 only. |
| Unit not found in KB | `fingerprintKBUnit()` throws `Error('[FingerprintService] Unit not found: <id>')` |
| No source text on unit | Returns Layer 1 only fingerprint with empty results. Never throws. |
| LLM quota exhausted | Scheduler backs off (exponential) and re-queues. Reports `failed` in batch result. |

---

## Integration with NeuralInverseChecks

The FingerprintService fires `onDidFingerprintUnit` events. The NeuralInverseChecks GRC engine can listen to this event and trigger re-evaluation of GRC rules that depend on compliance domain assignments.

---

## Integration with Source Drift

When the KnowledgeBaseService raises a `drift-detected` event:
1. `FingerprintServiceImpl` listens and calls `invalidate(unitId)` for all units in the drifted file
2. Those units are re-queued for fingerprinting at high priority
3. After re-fingerprinting, if the unit already had a modern translation, `compareKBUnit()` is called automatically
