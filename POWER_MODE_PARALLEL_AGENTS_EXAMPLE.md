# Power Mode Parallel Sub-Agents - Usage Guide

## Overview

Power Mode now supports **true agentic parallelism** — spawn temporary sub-agents that execute concurrently while the parent agent continues working. This enables divide-and-conquer workflows, background research, and parallel execution patterns.

## Key Concepts

### Non-Blocking Execution
- `spawn_agent` returns **immediately** with an agent ID
- The sub-agent runs in the **background** (separate chat thread)
- Parent agent can continue working or spawn more agents
- Use `wait_for_agent` only when you need the result

### Sub-Agent Roles

Each role has specific tool access:

| Role | Tools | Use Case |
|------|-------|----------|
| **explorer** | read, search, list | Read-only research and exploration |
| **editor** | read, edit, write | Code changes (can be scoped to files) |
| **verifier** | read, bash, tests | Run tests, lint checks, validation |
| **compliance** | read, GRC tools | Compliance analysis and scanning |
| **checks-agent** | Full GRC agent | Delegated to Checks Agent service |
| **power-mode** | Full coding agent | Delegated to Power Mode service |

### Parent Context

Sub-agents automatically inherit parent context from:
1. Current Power Mode session (preferred)
2. Active Agent mode task (fallback)

Both Power Mode and Agent mode can spawn sub-agents.

## Available Tools

### 1. spawn_agent (NON-BLOCKING)

Spawns a sub-agent that runs in parallel.

```typescript
spawn_agent(
  role: 'explorer' | 'editor' | 'verifier' | 'compliance' | 'checks-agent' | 'power-mode',
  goal: string,
  scopedFiles?: string  // comma-separated file paths for editor role
)
```

**Returns immediately** with:
- Agent ID
- Role
- Goal
- Status: 'pending' or 'running'

### 2. get_agent_status (NON-BLOCKING)

Check a sub-agent's status without blocking.

```typescript
get_agent_status(agentId: string)
```

Returns:
- Status: pending | running | completed | failed | cancelled
- Result (if completed)
- Error (if failed)
- Timestamps

### 3. wait_for_agent (BLOCKING)

Wait for a sub-agent to complete. Polls every 2 seconds, 5-minute timeout.

```typescript
wait_for_agent(agentId: string)
```

Returns final result or error.

### 4. list_agents (NON-BLOCKING)

List all spawned sub-agents and their status.

```typescript
list_agents()
```

Shows running, pending, completed, and failed agents.

## Usage Patterns

### Pattern 1: Parallel Research

```
> explore the codebase in parallel

[Claude spawns 3 explorer agents:]
spawn_agent(role='explorer', goal='Map out the authentication flow')
spawn_agent(role='explorer', goal='Find all database access points')
spawn_agent(role='explorer', goal='Identify external API integrations')

[Continue with other work...]

[Later, collect results:]
wait_for_agent(agent_id_1)
wait_for_agent(agent_id_2)
wait_for_agent(agent_id_3)
```

### Pattern 2: Background Testing

```
> fix the bug in auth.ts and verify it works

[Fix the code first:]
edit_file(...)

[Spawn verifier in background:]
spawn_agent(role='verifier', goal='Run auth tests and report results')

[Continue with other tasks while tests run...]

[Check when ready:]
get_agent_status(agent_id)  # Non-blocking check
wait_for_agent(agent_id)     # Block when you need results
```

### Pattern 3: Divide and Conquer

```
> fix bugs in these 5 files simultaneously

[Spawn 5 editor agents, each scoped to one file:]
spawn_agent(role='editor', goal='Fix null pointer bug', scopedFiles='src/a.ts')
spawn_agent(role='editor', goal='Fix race condition', scopedFiles='src/b.ts')
spawn_agent(role='editor', goal='Fix memory leak', scopedFiles='src/c.ts')
spawn_agent(role='editor', goal='Fix validation error', scopedFiles='src/d.ts')
spawn_agent(role='editor', goal='Fix API timeout', scopedFiles='src/e.ts')

[Wait for all to complete:]
list_agents()  # See progress
wait_for_agent(agent_1)
wait_for_agent(agent_2)
...
```

### Pattern 4: Delegated Specialists

```
> analyze compliance and plan the fix

[Delegate to Checks Agent (full GRC loop):]
spawn_agent(role='checks-agent', goal='Scan codebase and identify all blocking violations')

[Delegate to Power Mode (full coding loop):]
spawn_agent(role='power-mode', goal='Research the best approach to fix authentication flow')

[These run via their respective services, not chat threads]
wait_for_agent(checks_agent_id)
wait_for_agent(power_mode_id)
```

## Best Practices

### ✅ DO:
- Spawn agents and continue working (non-blocking by default)
- Use `get_agent_status` to check progress without blocking
- Only `wait_for_agent` when you need the result
- Scope editor agents to specific files to prevent conflicts
- Use explorer role for read-only research
- Spawn multiple agents for parallel work

### ❌ DON'T:
- Call `wait_for_agent` immediately after spawn (defeats the purpose)
- Spawn unlimited agents (max 3 concurrent by default)
- Use editor agents on overlapping files (may cause conflicts)
- Spawn agents for trivial tasks better done directly

## Concurrency Control

- **Max concurrent**: 3 sub-agents (configurable via `.neuralinverseagent`)
- **Queue behavior**: Additional spawns go to pending queue
- **Automatic drain**: When an agent completes, pending agents start

## Architecture

### Sub-Agent Service
- `INeuralInverseSubAgentService` manages all sub-agents
- Supports both Power Mode sessions and Agent mode tasks
- Each sub-agent gets a dedicated chat thread
- Tool access restricted by role

### Parent Context
```typescript
interface SubAgentParentContext {
  id: string;
  type: 'power-session' | 'agent-task';
}
```

Power Mode automatically sets parent context on:
- Session creation
- Session switch
- Session deletion

### Tool Integration

Power Mode tool registry includes:
```typescript
createSpawnAgentTool(subAgentService)
createGetAgentStatusTool(subAgentService)
createWaitForAgentTool(subAgentService)
createListAgentsTool(subAgentService)
```

## Example Workflow

```
User: analyze the codebase and fix any critical bugs

[Phase 1: Parallel exploration]
Agent: Let me explore in parallel...
  spawn_agent(role='explorer', goal='Find all critical bugs')
  spawn_agent(role='explorer', goal='Map dependencies and impact')
  spawn_agent(role='checks-agent', goal='Identify GRC violations')

[Phase 2: Continue with other work]
Agent: While those run, let me check the build system...
  read_file('package.json')
  list('scripts/')

[Phase 3: Collect results]
Agent: Exploration complete, gathering findings...
  wait_for_agent(explorer_1)  # Bug list
  wait_for_agent(explorer_2)  # Dependency map
  wait_for_agent(checks_agent) # GRC issues

[Phase 4: Parallel fixes]
Agent: I found 4 critical bugs. Fixing them in parallel...
  spawn_agent(role='editor', goal='Fix auth bug', scopedFiles='auth.ts')
  spawn_agent(role='editor', goal='Fix DB bug', scopedFiles='db.ts')
  spawn_agent(role='editor', goal='Fix API bug', scopedFiles='api.ts')
  spawn_agent(role='verifier', goal='Run full test suite')

[Phase 5: Verify]
Agent: Waiting for fixes and tests...
  wait_for_agent(editor_1)
  wait_for_agent(editor_2)
  wait_for_agent(editor_3)
  wait_for_agent(verifier_1)

Agent: ✓ All bugs fixed and tests passing!
```

## Technical Details

### Tool Scope Enforcement

Tool access is enforced at two levels:

1. **System prompt**: Sub-agent receives role-specific instructions
2. **Tool whitelist**: Only allowed tools are available in the registry

Example for `explorer` role:
```typescript
const toolScopeOfRole = {
  explorer: [
    'read_file',
    'ls_dir',
    'get_dir_tree',
    'search_pathnames_only',
    'search_for_files',
    'search_in_file',
    'read_lint_errors',
    'update_agent_status',
    'generate_document',
  ]
}
```

### Delegated Roles

`checks-agent` and `power-mode` roles don't use chat threads. They delegate to their respective services:

- **checks-agent**: Calls `IChecksAgentService.answerQuery()`
- **power-mode**: Calls `IPowerModeService.answerQuery()`

These services run their own full agent loops internally.

### Result Recording

Sub-agent results are automatically recorded in the parent agent's context:
```typescript
this._agentService.recordContext({
  type: 'search_result',
  summary: `Sub-agent [${role}] completed: ${result}`,
  importance: 4,
});
```

## Configuration

In `.neuralinverseagent`:
```json
{
  "constraints": {
    "maxConcurrentSubAgents": 3
  }
}
```

## Future Enhancements

- Sub-agent collaboration (agents coordinating with each other)
- Agent pools (pre-warmed agents ready to go)
- Agent templates (saved agent configurations)
- Agent metrics (execution time, success rate)
- Agent dependencies (wait for multiple agents)
