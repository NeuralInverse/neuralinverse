# Neural Inverse Enclave: Architecture & Vision

## Overview
The Enclave is the third critical pillar of the Neural Inverse IDE (alongside Agentic and Checks). While the Agentic system drives velocity (code generation) and the Checks system ensures correctness (compliance & quality), the **Enclave guarantees security, legality, and trust**.

In regulated environments (e.g., healthcare, defense, finance), enterprises cannot legally deploy autonomous AI agents without strict containment, data loss prevention, and cryptographic auditability. The Enclave acts as the "Warden," ensuring all AI operations are mathematically secure and legally compliant.

---

## Core Pillars of the Enclave

### 1. Context Firewall (Data Loss Prevention)
**Problem:** A hallucinating AI might accidentally include passwords, API keys, Protected Health Information (PHI), or proprietary intellectual property in a prompt sent to an external LLM (like OpenAI or Anthropic).
**Solution:** The Context Firewall intercepts every outbound LLM request from the IDE. It uses local regex patterns, entropy checks, and lightweight ML models to scan and sanitize prompts *before* they leave the machine, guaranteeing zero data exfiltration.

### 2. Isolated Execution Sandbox (Containment)
**Problem:** Autonomous agents (Agentic system) need to execute terminal commands, run tests, and modify files. Allowing an AI raw access to a developer's machine is a massive security risk (e.g., running `rm -rf`, modifying production config, opening network ports).
**Solution:** The Sandbox forces all AI-initiated commands and file modifications to run in a strictly controlled environment. It restricts network access, limits file system operations to authorized directories, and can kill runaway processes instantly.

### 3. Cryptographic Provenance (Auditing & Traceability)
**Problem:** Regulations like DO-178C (Aviation) or FDA standards require strict traceability. If a critical bug occurs, auditors must know exactly who authored the code.
**Solution:** The Enclave maintains an immutable, cryptographically signed audit trail. It explicitly watermarks every single line of AI-generated or AI-modified code, providing a legally verifiable "chain of custody."

---

## Implementation Roadmap

### Phase 1: Short-Term (Immediate Focus)
*The immediate goal is to establish the foundation of the Enclave, focusing on observability and basic containment.*

1. **Enclave Dashboard UI (`enclaveManagerPart.ts`)**
   - Enhance the existing Enclave webview to display real-time metrics.
   - Show status of the Firewall (active/inactive, blocked requests count).
   - Display a live feed of the Audit Trail.

2. **Basic Context Firewall (`enclaveFirewallService.ts`)**
   - Implement interceptors in the `sendLLMMessageService`.
   - Add rudimentary regex-based filtering for common secrets (AWS keys, private keys, generic high-entropy strings).
   - Log blocked attempts to the Enclave UI.

3. **Audit Trail Watermarking (`auditTrailService.ts` enhancement)**
   - Ensure every edit initiated by an Agentic action or an AI Fix is explicitly logged.
   - Store these logs in the `.inverse/audit` directory (already partially implemented).

### Phase 2: Medium-Term
1. **Isolated Sandbox (`enclaveSandboxService.ts`)**
   - Introduce a restricted execution context for Agentic terminal commands.
   - Implement a virtualized file system layer or strict permissions checking before allowing the AI to write files.
   - Create a timeout mechanism for AI-spawned processes.

2. **Advanced Firewall Rules**
   - Integrate PII/PHI detection.
   - Allow enterprise admins to define custom compliance vocabularies that must not leave the machine.

### Phase 3: Long-Term (Enterprise Vision)
1. **Cryptographic Signing (IMPLEMENTED)**
   - Integrated with hardware security modules (HSM) / local native OS keychains to cryptographically sign the AI audit logs, making them tamper-proof against malicious developers. The ECDSA private key is now protected by `ISecretStorageService`.

2. **Remote Enclave Policies**
   - Allow Enterprise CISOs to centrally manage Enclave policies (Firewall rules, Sandbox permissions) and push them to all developers' IDEs in real-time.

3. **Zero-Trust AI Networking**
   - Run AI execution environments in fully isolated Docker containers or microVMs directly orchestrated by the IDE.
