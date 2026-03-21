# NeuralInverse Agents System - Complete Guide

## Overview

The NeuralInverse Agents system is similar to Claude Code (me!). It allows you to deploy **temporary specialized agents** that run autonomously with their own:
- LLM model selection (can use different models per agent)
- System instructions
- Tool permissions
- Execution limits

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  .inverse/agents/                                   │
│  ├── code-reviewer.json                             │
│  ├── test-generator.json                            │
│  ├── dependency-auditor.json                        │
│  ├── release-manager.json                           │
│  ├── docs-generator.json                            │
│  └── <custom-agent>.json                            │
└─────────────────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│  IAgentStoreService                                 │
│  - Loads agent definitions from disk                │
│  - Watches for file changes                         │
│  - Provides agent CRUD operations                   │
└─────────────────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│  IWorkflowAgentService                              │
│  - Executes agents with full LLM+tool loop          │
│  - Manages concurrent runs                          │
│  - Tracks execution history                         │
└─────────────────────────────────────────────────────┘
```

## Agent Definition Structure

Each agent is defined in `.inverse/agents/<id>.json`:

```json
{
  "id": "code-reviewer",
  "name": "Code Reviewer",
  "description": "Reviews code for bugs, security, quality",
  "model": {
    "providerName": "anthropic",
    "modelName": "claude-sonnet-4-6"
  },
  "systemInstructions": "You are an expert code reviewer...",
  "allowedTools": [
    "gitStatus",
    "gitDiff",
    "readFile",
    "searchCode"
  ],
  "maxIterations": 8,
  "tags": ["code-quality", "git", "review"],
  "isBuiltin": true,
  "createdAt": 1700000000000,
  "updatedAt": 1700000000000
}
```

### Key Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique slug (auto-generated from name) |
| `name` | string | Display name |
| `description` | string | What this agent does |
| `model` | object | `{ providerName, modelName }` - **ANY model!** |
| `systemInstructions` | string | Full system prompt for the agent |
| `allowedTools` | string[] | Whitelist of tool names from registry |
| `maxIterations` | number | Max LLM+tool loop iterations (default: 20) |
| `tags` | string[] | For filtering/organization |
| `isBuiltin` | boolean | True if from built-in library |

## Built-in Agents

### 1. **code-reviewer**
- Reviews diffs and files for bugs, security, quality
- Tools: `gitStatus`, `gitDiff`, `readFile`, `searchCode`
- Max iterations: 8

### 2. **test-generator**
- Generates unit/integration tests matching project patterns
- Tools: `readFile`, `writeFile`, `listDirectory`, `searchCode`
- Max iterations: 12

### 3. **dependency-auditor**
- Audits for vulnerabilities, outdated packages, licensing
- Tools: `readFile`, `listDirectory`, `runCommand`
- Max iterations: 6

### 4. **release-manager**
- Automates releases: changelog, version bump, commit
- Tools: `readFile`, `writeFile`, `gitLog`, `gitStatus`, `gitDiff`, `gitAdd`, `gitCommit`
- Max iterations: 10

### 5. **docs-generator**
- Generates/updates JSDoc and README docs
- Tools: `readFile`, `writeFile`, `searchCode`
- Max iterations: 12

## How to Use Agents

### From Chat (via Copilot/Agent mode)

Use the `query_ni_agent` tool:

```typescript
// List available agents
query_ni_agent({ agent_id: "list", input: "" })

// Run an agent
query_ni_agent({
  agent_id: "code-reviewer",
  input: "Review the auth module for security issues"
})
```

### From Code (toolsService.ts)

Already implemented in `src/vs/workbench/contrib/void/browser/toolsService.ts`:

```typescript
query_ni_agent: async ({ agentId, input }) => {
  if (agentId === 'list') {
    const agents = this.workflowAgentService.getAgents();
    const list = agents.map(a =>
      `- ${a.name} (${a.id}): ${a.description}`
    ).join('\n');
    return { result: { result: `Available agents:\n${list}` } };
  }

  const run = await this.workflowAgentService.runAgent(agentId, input);
  return { result: { result: run.result || 'No result' } };
}
```

## Available Tools Registry

The agent system has its own tool registry (separate from Void chat):

### Filesystem Tools
- `readFile` - Read file contents
- `writeFile` - Write/create files
- `listDirectory` - List dir contents
- `searchCode` - Search codebase

### Terminal Tools
- `runCommand` - Execute shell commands
- `runCommandStreaming` - Execute with live output

### Git Tools
- `gitStatus` - Get working tree status
- `gitDiff` - Get diff output
- `gitLog` - Get commit history
- `gitAdd` - Stage files
- `gitCommit` - Create commit

### HTTP Tools
- `httpGet` - Fetch URLs
- `httpPost` - POST requests

### GRC Tools
- `getViolations` - Get compliance violations
- `getDomainSummary` - Get domain breakdown
- `runScan` - Trigger compliance scan

### Communication Tools
- `notify` - Show VS Code notification
- `showProgress` - Show progress indicator
- `setStatusBar` - Update status bar

## Creating Custom Agents

### Example: Explorer Agent with Haiku

Let's create a fast, cheap agent for exploring codebases using Claude Haiku:

```json
{
  "id": "codebase-explorer",
  "name": "Codebase Explorer",
  "description": "Fast exploration and analysis of code structure using Claude Haiku",
  "model": {
    "providerName": "anthropic",
    "modelName": "claude-haiku-4-5"
  },
  "systemInstructions": "You are a fast codebase explorer. Quickly scan files, identify patterns, and provide concise summaries. Be efficient and use minimal iterations.",
  "allowedTools": [
    "readFile",
    "listDirectory",
    "searchCode",
    "gitStatus"
  ],
  "maxIterations": 5,
  "tags": ["exploration", "fast", "analysis"]
}
```

### Example: Security Auditor with Opus

For deep security analysis:

```json
{
  "id": "security-auditor",
  "name": "Security Auditor",
  "description": "Deep security analysis using Claude Opus for thorough vulnerability detection",
  "model": {
    "providerName": "anthropic",
    "modelName": "claude-opus-4-6"
  },
  "systemInstructions": "You are a security expert. Perform exhaustive analysis for: SQL injection, XSS, CSRF, authentication flaws, authorization issues, crypto misuse, secrets exposure, and dependency vulnerabilities. Be thorough and cite OWASP references.",
  "allowedTools": [
    "readFile",
    "searchCode",
    "gitDiff",
    "runCommand"
  ],
  "maxIterations": 20,
  "tags": ["security", "thorough", "audit"]
}
```

### Example: Modernization Agent with GPT-4

Using OpenAI for legacy code migration:

```json
{
  "id": "modernizer",
  "name": "Code Modernizer",
  "description": "Migrates legacy code to modern patterns using GPT-4",
  "model": {
    "providerName": "openai",
    "modelName": "gpt-4-turbo"
  },
  "systemInstructions": "You refactor legacy code to modern standards. Convert callbacks to async/await, class components to hooks, outdated APIs to current ones. Always preserve behavior and add tests.",
  "allowedTools": [
    "readFile",
    "writeFile",
    "searchCode",
    "gitDiff"
  ],
  "maxIterations": 15,
  "tags": ["refactoring", "modernization"]
}
```

## Agent Execution Flow

```
1. User calls query_ni_agent()
              ↓
2. workflowAgentService.runAgent()
              ↓
3. AgentExecutor starts LLM loop:
   - Builds system prompt with allowed tools
   - Calls LLM with specified model
   - Parses tool calls
   - Validates against allowedTools
   - Executes approved tools
   - Returns results to LLM
   - Repeat until done or maxIterations
              ↓
4. Returns final result
```

## Key Differences from Chat

| Feature | Chat (Void/Copilot) | NeuralInverse Agents |
|---------|---------------------|---------------------|
| **Scope** | General purpose | Specialized tasks |
| **Model** | Global setting | Per-agent |
| **System Prompt** | Chat mode prompt | Agent-specific |
| **Tools** | All builtin tools | Whitelisted only |
| **Persistence** | Chat history | Run history only |
| **UI** | Sidebar chat | Agent Manager panel |
| **Invocation** | User messages | `query_ni_agent` tool |

## Multi-Model Strategy

You can have agents using different models for different tasks:

```
Fast Tasks (Haiku):
- codebase-explorer
- quick-formatter
- simple-refactor

Balanced Tasks (Sonnet):
- code-reviewer
- test-generator
- docs-generator

Deep Analysis (Opus):
- security-auditor
- architecture-analyzer
- complex-debugger

Alternative Providers:
- gpt-4-turbo for specific use cases
- gemini-pro for cost optimization
```

## Current Implementation Status

✅ **Implemented:**
- Agent store service (loads from `.inverse/agents/`)
- Workflow orchestrator (executes agents)
- Tool registry (FS, terminal, git, HTTP, GRC)
- Built-in agent library (5 agents)
- `query_ni_agent` tool in Void chat

❌ **Not Yet Implemented:**
- UI panel for agent management (partially done in agentManagerPart.ts)
- Agent creation wizard
- Visual run history/logs
- Agent debugging tools

## Next Steps for Your Use Case

Based on your question about "explore using different models":

1. **Create a Haiku-based explorer agent** in `.inverse/agents/explorer.json`
2. **Call it from chat:** `query_ni_agent({ agent_id: "explorer", input: "Map out the authentication flow" })`
3. **Compare with Sonnet agent** for the same task
4. **Benchmark cost/quality tradeoffs**

Want me to help you:
1. Create a custom agent definition?
2. Add UI for agent management?
3. Implement agent switching/comparison tools?
4. Build a multi-agent workflow?
