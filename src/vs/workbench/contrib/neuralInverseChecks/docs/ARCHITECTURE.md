# Neural Inverse Checks — Architecture

## Overview

`neuralInverseChecks` is a **framework-agnostic GRC (Governance, Risk, Compliance) execution engine** embedded in the Neural Inverse IDE. It enforces compliance standards in real-time during development.

## Core Principle

> **The IDE does not define GRC rules. The developer/enterprise does.**

Enterprises import their compliance frameworks in a standardized JSON format. The IDE loads, validates, and enforces them in real-time — with inline editor diagnostics, a dedicated Checks panel, and a full Checks Manager window.

## How It Works

```
Enterprise drops framework JSON → IDE loads it → Engine evaluates code → Violations appear inline
```

1. **Framework Import**: Enterprises create `.inverse/frameworks/{name}.json` files defining their rules
2. **Framework Registry**: The `IFrameworkRegistry` service loads, validates, and indexes all frameworks
3. **GRC Engine**: The `IGRCEngineService` evaluates code against all active framework rules
4. **Rule Router**: Rules are routed to the correct analyzer based on their `type`:
   - `regex` — simple pattern matching (existing)
   - `ast` — TypeScript AST structural analysis
   - `dataflow` — taint tracking, source-to-sink analysis
   - `import-graph` — circular dependencies, layer violations
   - `external` — delegate to any CLI tool
5. **Diagnostics**: Violations appear as squiggly underlines in the editor
6. **Audit Trail**: All violations are logged to `.inverse/audit/` with hash-chain integrity

## Directory Structure

```
neuralInverseChecks/
├── docs/                          # Documentation (you are here)
│   ├── ARCHITECTURE.md
│   └── IMPLEMENTATION_PLAN.md
│
├── browser/
│   ├── engine/                    # Core GRC engine
│   │   ├── frameworkSchema.ts     # Framework import JSON schema types
│   │   ├── frameworkRegistry.ts   # Loads/validates/indexes frameworks
│   │   ├── grcEngineService.ts    # Main evaluation engine + rule router
│   │   ├── grcTypes.ts            # Core type definitions
│   │   ├── grcConfigLoader.ts     # User config (.inverse/grc-rules.json)
│   │   ├── builtinRules.ts        # Default framework (ships with IDE)
│   │   ├── auditTrailService.ts   # Violation logging
│   │   ├── checkViewHtml.ts       # HTML generation for webview panels
│   │   ├── astAnalyzer.ts         # AST-aware rule execution
│   │   ├── dataFlowAnalyzer.ts    # Taint tracking
│   │   ├── importGraphAnalyzer.ts # Architecture analysis
│   │   └── externalCheckRunner.ts # External CLI tool integration
│   │
│   ├── diagnostics/               # Real-time editor integration
│   │   └── grcDiagnosticsContribution.ts
│   │
│   ├── securityAsCode/            # Security domain view
│   ├── complianceAsCode/          # Compliance domain view
│   ├── architectureAsCode/        # Architecture domain view
│   ├── dataIntegrity/             # Data integrity domain view
│   ├── failSafeDefaults/          # Fail-safe domain view
│   ├── codeAsPolicy/              # Policy domain view
│   ├── formalVerification/        # Formal verification domain view
│   ├── auditAndEvidence/          # Audit trail view
│   ├── nanoAgents/                # AI-powered analysis agents
│   ├── context/                   # FIM/autocomplete policy context
│   │
│   ├── checksManagerPart.ts       # Checks Manager window (auxiliary window)
│   ├── checksViewPane.ts          # Checks panel (bottom panel)
│   └── neuralInverseChecks.contribution.ts  # Registration + keybindings
```

## Framework Import Format

See `engine/frameworkSchema.ts` for the full TypeScript schema.

Frameworks are JSON files placed in `.inverse/frameworks/`. Each defines:
- **Metadata**: name, version, authority, applicable languages
- **Rules**: each with a check definition (regex, AST, dataflow, import-graph, or external)
- **Categories**: map to the IDE's subsystem views (Security, Compliance, etc.)
- **Severity Levels**: custom severity with commit/deploy blocking behavior

## Services

| Service | ID | Purpose |
|---------|-----|---------|
| `IGRCEngineService` | `neuralInverseGRCEngineService` | Core evaluation engine |
| `IAuditTrailService` | `neuralInverseAuditTrailService` | Violation logging |
| `IFrameworkRegistry` | `neuralInverseFrameworkRegistry` | Framework loading/indexing |
| `IPolicyService` | `neuralInversePolicyService` | FIM autocomplete policy |

## Key Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| `neuralInverse.openChecksManager` | `Ctrl+Alt+C` | Open Checks Manager window |
