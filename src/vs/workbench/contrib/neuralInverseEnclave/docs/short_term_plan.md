# Enclave: Short-Term Implementation Plan

This document outlines the step-by-step technical plan for the immediate phase of the Enclave system implementation.

## Objective
Establish the core Enclave infrastructure: the Context Firewall, the initial Sandbox constraints, and the UI integration to make these operations visible to the user.

## Step 1: Enclave Firewall Service (`enclaveFirewallService.ts`)

1. **Create the Service Interface**:
   - Define `IEnclaveFirewallService` with methods like `validatePrompt(text: string): { blocked: boolean, reason?: string }`.

2. **Implement Basic Secret Detection**:
   - Add regex patterns for common secrets (e.g., AWS Access Keys, RSA Private Keys, GitHub Tokens).
   - Implement an entropy scanner for general high-entropy string detection.

3. **Hook into LLM Messaging (`sendLLMMessageService.ts`)**:
   - Modify the `sendLLMMessage` pipeline to pass outbound prompts through the Firewall.
   - If blocked, return a specific error to the UI/Agent indicating a Firewall violation.

## Step 2: Enclave Sandbox Service (`enclaveSandboxService.ts`)

1. **Create the Service Interface**:
   - Define `IEnclaveSandboxService` with methods like `executeCommand(cmd: string)` and `validateFileAccess(uri: URI)`.

2. **Implement File Access Restrictions**:
   - Create a mechanism that checks if a file URI is within the authorized workspace before allowing an Agentic write operation.
   - Prevent access to system directories (e.g., `/etc/`, `~/.ssh/`).

3. **Implement Command Timeouts**:
   - Wrap any terminal/shell commands executed by the AI with strict timeouts to prevent runaway processes.

## Step 3: Enclave Manager UI (`enclaveManagerPart.ts`)

1. **Update React Components**:
   - The current `enclaveManagerPart.ts` uses a basic HTML string for the webview. We need to upgrade this to use robust UI components (matching the rest of the IDE).

2. **Telemetry Display**:
   - Connect the UI to the `enclaveFirewallService` to display real-time counters for "Prompts Scanned" and "Blocked Requests".
   - Connect the UI to the `auditTrailService` to show recent AI actions.
   - Establish UI to show current Active Sandbox status.

## Current Priorities (What we are doing NOW)
1. Creating these documentation files.
2. Reviewing the initial Enclave implementation plan (Artifact) with the user.
3. Once approved, beginning actual code implementation, likely starting with the `enclaveFirewallService.ts`.
