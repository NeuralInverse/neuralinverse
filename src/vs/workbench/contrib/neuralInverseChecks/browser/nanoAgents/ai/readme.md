AI Agent Architecture - Development View
Goal Description
To transform the current "Nano Agents" static analysis framework into a fully autonomous AI Agent capability within the IDE. This document outlines the essential components required for a robust AI Agent from a development perspective.

Current State Analysis
Existing

NanoAgents
 infrastructure provides a strong foundation for Perception and State:

Collectors: LSP, AST,

Metrics
,

Capabilities
 provide deep code understanding.
Persistence: .inverse directory with encryption and Shadow Git provides secure history and state tracking.
Dashboard:

NanoAgentsControl
 provides a UI for visualization.
Missing: Cognition (Brain), Actuation (Tools), and Planning.

Proposed System Architecture
A complete AI Agent in an IDE requires the following 5 Pillars:

1. The Core (Brain)
The central processing unit that manages the decision loop.

LLM Client: Interface to models (Gemini, GPT-4, etc.) with streaming support.
Prompt Engine: Manages system prompts, context windowing, and persona handling.
Agent Loop: The Think -> Plan -> Act -> Observe cycle (ReAct or similar).
2. Perception (Context Engine)
How the agent "sees" the world. Building on existing NanoAgents.

Static Context: utilizing

ProjectAnalyzer
 data (AST, dependencies, capabilities).
Dynamic Context:
Open Files/Cursor: What the user is looking at.
LSP Diagnostics: Errors and warnings.
Terminal Output: Reading command results.
Git Status: Diffs and branch info.
3. Actuation (Tool Use)
How the agent affects the world.

Editor Ops: insert, replace,

delete
 text in files.
File System:

create
,

delete
,

move
 files/folders.
Terminal Ops: run_command (compile, test, deploy).
IDE Control: Open tabs, switch views, show notifications.
4. Memory (State Management)
Short-term: Current conversation history.
Working Memory: modifying the

task.md
 or similar scratchpad.
Long-term:
Vector Database: Embeddings of the codebase for semantic search (RAG).
Experience Replay: Remembering past fixes (utilizing HistoryService).
5. Safety & Control (GRC)
Ensuring the agent is helpful, not harmful.

Sandboxing: Limiting where the agent can write (already started with .inverse locking).
Human-in-the-loop: User approval for destructive actions (checks).
Secret Redaction: Preventing API keys from leaking to the LLM (already hinted at with

CapabilitiesCollector
 finding secrets).
Roadmap Structure
Phase 1: Cognitive Injection
Integrate an LLM Client into

NanoAgentsControl
.
Create a chat interface in the Webview.
Feed

ProjectAnalyzer
 data as context to the LLM.
Phase 2: Active Tools (Governance)
Expose Read-Only IFileService tools (read_file, list_dir).
Expose ITerminalService for running verification commands (e.g. linters, tests).
Security Constraint: No write access to codebase. The Agent validates and reports, but does not modify.
Phase 3: Memory & Retrieval
Implement Session Persistence: Save agent conversation history via StorageService.
Implement SearchTool: Expose greedy_search (keywords/regex) as a lightweight RAG replacement.
User Reviews Required
Review existing

ProjectAnalyzer
 performance impact: continuous analysis might be heavy.
Confirm security model: Should the agent have unchecked terminal access? (Recommended: User approval flow).
