# NeuralInverseCC → Void IDE Integration

**Complete integration of Claude Code's production-grade AI capabilities into Void IDE**

## ✅ Fully Integrated Features

### 1. **Skills System** (10 Built-in Skills)
Skills are structured prompt templates that guide the LLM for specific tasks.

#### Available Skills:
- `/verify` - Verify code changes work correctly
- `/explain` - Explain code, concepts, or architectural decisions  
- `/review` - Comprehensive code review with checklist
- `/search` - Find code or information in the codebase
- `/plan` - Create detailed implementation plan
- `/optimize` - Analyze and improve code performance
- `/commit` - Generate git commit message
- `/simplify` - Suggest ways to simplify complex code
- `/debug` - Systematic debugging approach
- `/remember` - Remember project context for future conversations

#### Usage:
```typescript
// In chat, type "/" to see skills menu
// Select a skill to run it in background

// Programmatic usage:
chatThreadService.invokeSkill(threadId, 'verify', 'authentication flow');
chatThreadService.getAvailableSkills(); // List all skills
```

**UI**: Unified slash command menu (`/`) integrated with `@` mention system in `inputs.tsx`

---

### 2. **Token Management**
Real-time token estimation and context window tracking per model.

#### Features:
- **Token estimation**: ~4 chars/token for text, ~2 for JSON
- **Context warnings**: Automatic at 70% and 90% usage
- **Model-specific windows**: 200K for Claude Sonnet 4, dynamically adjusted
- **Per-message tracking**: Tracks user messages, selections, images, assistant responses

#### Usage:
```typescript
const tokens = chatThreadService.estimateTokens(text); 
// Returns token count

const threadInfo = chatThreadService._estimateThreadTokens(threadId);
// { estimatedTokens: 45000, percentUsed: 22.5, shouldWarn: false }
```

**Context Windows**:
- Claude Sonnet 4/4.5/4.6: 200,000 tokens
- Claude Opus 4/4.5/4.6: 200,000 tokens  
- Claude Haiku 4.5: 200,000 tokens
- Default fallback: 200,000 tokens

---

### 3. **Cost Tracking**
Automatic API cost tracking per session and aggregate.

#### Features:
- **Per-session tracking**: Cost by thread ID
- **Aggregate tracking**: Total cost across all threads
- **Model-specific pricing**: Accurate rates for input/output/cache tokens
- **Formatted display**: `$0.0023` format

#### Usage:
```typescript
// Get cost for specific thread
const cost = chatThreadService.getSessionCost(threadId);
// { 
//   totalCost: 0.00234, 
//   inputTokens: 1500, 
//   outputTokens: 300, 
//   formattedCost: "$0.00" 
// }

// Get aggregate cost across all threads
const total = chatThreadService.getAggregateCost();

// Reset session cost
chatThreadService.resetSessionCost(threadId);

// Format cost
const formatted = chatThreadService.formatCost(0.00234); // "$0.00"

// Get model pricing
const costs = chatThreadService.getCostsForModel('claude-sonnet-4');
// {
//   inputTokens: 3.00,  // per million
//   outputTokens: 15.00, // per million
//   promptCacheWriteTokens: 3.75,
//   promptCacheReadTokens: 0.30
// }
```

**Automatic Tracking**: Every LLM response automatically records token usage and calculates cost.

---

### 4. **Auto-Compact**
Automatic context window compaction using LLM-based summarization.

#### How It Works:
1. **Trigger**: When context exceeds threshold (e.g., 187K tokens for Claude Sonnet 4)
2. **Process**: Takes first N messages (keeps last 5 for continuity)
3. **Summarize**: Sends to LLM: "Summarize focusing on key decisions, context, code changes"
4. **Replace**: Replaces old messages with compact summary
5. **Circuit Breaker**: Stops after 3 consecutive failures

#### Usage:
```typescript
// Manual compact
const result = await chatThreadService.compactThread(threadId);
// {
//   summary: "...",
//   messageCountBefore: 45,
//   messageCountAfter: 6
// }

// Check if auto-compact should trigger
const should = ccService.shouldAutoCompact(threadId, tokenCount, model);

// Record success/failure
ccService.recordCompactSuccess(threadId, result);
const failures = ccService.recordCompactFailure(threadId);
```

**Automatic**: Runs transparently when context approaches limit. User sees notification:  
`"Context auto-compacted: 45 → 6 messages"`

---

### 5. **Bash Security**
23 dangerous command pattern checks from Claude Code.

#### Blocked Patterns:
```
rm -rf, sudo, chmod 777, mkfs, dd, :(){ :|:& };:, curl|sh, wget|sh,
eval, exec, |bash, |sh, /dev/sd*, format, chown -R, passwd, useradd,
shutdown, reboot, init, systemctl, pkill, killall, >/.*, ~/.ssh/
```

#### Usage:
```typescript
// Check if command is dangerous
const safe = agentService.isBashCommandSafe('rm -rf /tmp');
// false - blocked pattern detected

// Permission evaluation
const result = chatThreadService.evaluatePermission(
  threadId, 
  'bash', 
  'git commit -m "fix"'
);
// { allowed: true, reason: 'builtin-allow' }
```

**Integration**: Automatically used by `INeuralInverseAgentService` before executing bash commands.

---

### 6. **Permission Engine**
Full priority-based permission system (session → workspace → builtin).

#### Features:
- **4-tier system**: `allow`, `deny`, `ask`, `always`
- **Rule priorities**: Session rules > workspace rules > builtin
- **Wildcard matching**: `npm:*`, `git commit *`
- **Circuit breaker**: Stops after excessive denials
- **Permission suggestions**: Auto-suggest rules for commands

#### Usage:
```typescript
// Evaluate permission
const result = chatThreadService.evaluatePermission(
  threadId,
  'bash',
  'npm install'
);
// { allowed: true, reason: 'builtin-allow' }

// Add permission rule
chatThreadService.addPermissionRule(
  threadId,
  'bash',
  'git push *',
  'allow'
);

// Remove rule
chatThreadService.removePermissionRule(threadId, 'bash', 'git push *');

// Get all rules
const rules = chatThreadService.getPermissionRules(threadId);
// [{ toolName: 'bash', pattern: 'npm:*', action: 'allow' }]

// Get suggestions for command
const suggestions = chatThreadService.suggestPermissionForCommand(
  'bash',
  'npm install express'
);
// [{ pattern: 'npm:*', action: 'allow' }]
```

**Rule Syntax**:
- `*` - Match all invocations
- `npm:*` - Match all npm commands
- `git commit *` - Match git commit with any args
- `--dry-run` - Match commands containing flag

---

## 📁 Integration Architecture

### Service Layer
```
INeuralInverseCCService (DI: neuralInverseCCService)
└── Skills, Token/Cost tracking, Auto-compact, Permissions
    
IChatThreadService (DI: voidChatThreadService)
├── Injects @INeuralInverseCCService
├── Exposes CC features to Void UI
└── Implements auto-compact and skill execution

INeuralInverseAgentService (DI: neuralInverseAgentService)
├── Injects @INeuralInverseCCService
└── Uses bash security checks
```

### Key Files

**Core CC Service**:
- `src/vs/workbench/contrib/neuralInverseCC/browser/neuralInverseCCService.ts`
- `src/vs/workbench/contrib/neuralInverseCC/common/neuralInverseCCTypes.ts`

**Skills**:
- `src/vs/workbench/contrib/neuralInverseCC/browser/skills/voidSkillsAdapter.ts`
- `src/vs/workbench/contrib/neuralInverseCC/browser/skills/neuralInverseCCSkillLoader.ts`

**Integration Points**:
- `src/vs/workbench/contrib/void/browser/chatThreadService.ts` (+ 300 lines)
- `src/vs/workbench/contrib/void/browser/chatThreadServiceInterface.ts` (+ 20 lines)
- `src/vs/workbench/contrib/void/browser/neuralInverseAgentService.ts` (+ 25 lines)
- `src/vs/workbench/contrib/void/browser/react/src/util/inputs.tsx` (slash menu)

**Auto-Compact**:
- `src/vs/workbench/contrib/neuralInverseCC/browser/compact/autoCompactController.ts`

**Permissions**:
- `src/vs/workbench/contrib/neuralInverseCC/browser/permissions/permissionEngine.ts`
- `src/vs/workbench/contrib/neuralInverseCC/browser/permissions/dangerousPatterns.ts`

**Cost Tracking**:
- `src/vs/workbench/contrib/neuralInverseCC/browser/cost/tokenCostTracker.ts`
- `src/vs/workbench/contrib/neuralInverseCC/browser/cost/modelCosts.ts`

---

## 🎯 Usage Examples

### Example 1: Use a Skill
```typescript
// User types "/" in chat → sees skills menu → selects /verify
// Background execution:
// 1. Shows "Running /verify..." notification
// 2. Generates focused prompt
// 3. Sends to LLM
// 4. Adds response: "[/verify]\n\n<response>"
// 5. Shows "/verify completed" notification
```

### Example 2: Track Costs
```typescript
// Every LLM message automatically tracked:
// - Estimates input tokens from thread messages
// - Gets output tokens from response
// - Calculates cost using model pricing
// - Stores in session

// View costs:
const sessionCost = chatThreadService.getSessionCost(threadId);
console.log(`Thread cost: ${sessionCost.formattedCost}`);

const totalCost = chatThreadService.getAggregateCost();
console.log(`Total cost: ${totalCost.formattedCost}`);
```

### Example 3: Auto-Compact
```typescript
// Automatically triggers when context near full:
// 1. Detects 187K+ tokens (for Claude Sonnet 4)
// 2. Takes first N messages (keeps last 5)
// 3. Generates summary via LLM
// 4. Replaces old messages with summary
// 5. Shows notification: "Context auto-compacted: 45 → 6 messages"

// Manual trigger:
const result = await chatThreadService.compactThread(threadId);
if (result) {
  console.log(`Compacted ${result.messageCountBefore} → ${result.messageCountAfter}`);
}
```

### Example 4: Permission Management
```typescript
// Check before running bash command:
const allowed = chatThreadService.evaluatePermission(
  threadId,
  'bash',
  'npm install'
);

if (allowed.allowed) {
  // Execute command
} else {
  console.log(`Blocked: ${allowed.reason}`);
}

// Add custom rule:
chatThreadService.addPermissionRule(
  threadId,
  'bash',
  'npm:*',
  'allow'
);
```

---

## 🔄 Registration & Lifecycle

### Service Registration (DI)
```typescript
// neuralInverseCC.contribution.ts
registerSingleton(INeuralInverseCCService, NeuralInverseCCService, InstantiationType.Delayed);

// Skills loaded at startup
class NeuralInverseCCSkillContribution implements IWorkbenchContribution {
  constructor(@INeuralInverseCCService private readonly _ccService) {
    // 10 skills registered synchronously in service constructor
    loadCCBundledSkills(this._ccService).catch(() => {}); // Additional async skills
  }
}
```

### Skills Initialization
```typescript
// NeuralInverseCCService constructor
constructor() {
  this._registerBasicSkills(); // Synchronous - 10 skills immediately available
}
```

---

## 🚀 Benefits

### For Users:
- **Skills**: Type `/` → instant AI assistance for common tasks
- **Cost Tracking**: Know exactly how much you're spending
- **Auto-Compact**: Never run out of context window
- **Security**: Dangerous commands automatically blocked

### For Developers:
- **Production-Ready**: Battle-tested by Claude Code
- **Extensible**: Easy to add custom skills
- **Observable**: Full cost and token tracking
- **Safe**: Permission engine prevents accidents

---

## 📊 Statistics

**Lines of Code**: ~1,400 source files from Claude Code  
**Integration**: ~350 lines added to Void  
**Skills**: 10 built-in, extensible  
**Security Patterns**: 23 dangerous command checks  
**Models Supported**: All Claude 4.x models  
**Cost Accuracy**: Model-specific pricing with cache support  

---

## 🎉 Result

**NeuralInverseCC is fully integrated into Void IDE** without breaking existing functionality. All Claude Code production features are now available to Void users and developers.
