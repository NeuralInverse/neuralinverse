# NeuralInverse Community Edition

<div align="center">
	<img
		src="./src/vs/workbench/browser/parts/editor/media/neuralinverse_logo.png"
		alt="NeuralInverse"
		width="300"
		height="300"
	/>
</div>

NeuralInverse CE is a free, open-source AI-native IDE for developers who want powerful AI coding assistance without any cloud lock-in.

Bring your own LLM and get full AI chat, agentic coding, and Power Mode workflows - all running locally or against any provider you choose.

- 🌐 [Website](https://neuralinverse.com)
- 📧 [Contact](mailto:github@neuralinverse.com)
- 🏢 [Enterprise Edition](https://neuralinverse.com) - compliance, GRC, and legacy modernization for regulated industries

<iframe src="https://github.com/sponsors/NeuralInverse/button" title="Sponsor NeuralInverse" height="32" width="114" style="border: 0; border-radius: 6px;"></iframe>


## Install

**macOS / Linux**
```bash
curl -fsSL neuralinverse.com/sh | bash
```

**Windows** (PowerShell)
```powershell
irm neuralinverse.com/win | iex
```


## Features

### AI Chat & Agentic Coding
- Inline and sidebar chat with full codebase context
- **Power Mode**: autonomous multi-step agent that plans, edits, runs commands, and iterates without hand-holding
- **Bring Your Own LLM**: direct integration with Claude, GPT-4, Gemini, Ollama, Bedrock, and more - your API keys stay local, no proxy

### Firmware & Embedded Development
Purpose-built for embedded engineers - not just syntax highlighting:
- **MCU database**: 357 MCU variants across 11 manufacturers (STM32, NXP, ESP32, Nordic, Renesas, TI, Infineon, RP2040, AURIX, and more) with full specs, memory maps, and peripheral lists
- **SVD auto-load**: fetches CMSIS-SVD register maps on demand, parses peripheral trees with bit-field detail, handles `derivedFrom` inheritance
- **Datasheet intelligence**: drop in a PDF and the agent extracts register maps, timing constraints, errata, and pinouts - 3-tier pipeline with LLM reclassification, content-hash caching (zero re-processing on re-open), and page-level citations
- **22 `fw_*` agent tools**: register map queries, peripheral config, bit-field lookup, errata checks, timing constraints, build + flash, serial monitor, MISRA/CERT-C checks, GDB debug (breakpoints, step, memory read/write), binary size analysis, code generation for peripheral init / ISR / DMA / clock config
- **Platform knowledge packs**: STM32, ESP32, nRF (Zephyr), RP2040 - clock trees, DMA patterns, ISR constraints, toolchain quirks injected into every agent session
- **Build system support**: PlatformIO, CMake, ESP-IDF, Make, Zephyr, Arduino, Mbed, STM32CubeIDE - build and flash directly from the IDE
- **Serial monitor**: Web Serial API, 10,000-line ring buffer, baud auto-detection, debug probe auto-detection (ST-Link, J-Link, CMSIS-DAP, FTDI, CH340, and more)
- **Compliance-aware**: MISRA C:2012, CERT C, IEC 62304, ISO 26262 rules injected into the agent context so generated code respects safety constraints

### Legacy Modernization
Migrate legacy codebases to modern languages without losing business logic:
- **Discovery**: scans source trees across 20+ languages - COBOL, PL/SQL, RPG, Natural, FORTRAN, Assembler, AUTOSAR ARXML, CAN DBC, IEC 61131, TTCN-3, and more - extracting dependencies, complexity metrics, tech debt, and regulated data patterns
- **Semantic fingerprinting**: extracts business rules, type mappings, regulated fields (PCI-DSS, financial-core, tax-compliance), and naming conventions from legacy code using a deterministic + LLM two-layer pipeline
- **Migration planning**: CPM critical path scheduling across 7 phases (foundation through cutover), 12 blocker types, API compatibility gates, compliance ordering, effort estimation with safety-critical language surcharges
- **Translation engine**: language-pair profiles with idiom mappings (COBOL to Java: 32 idioms; PL/SQL to TypeScript; RPG to Java; Angular 1 to 18; and more), 6-priority context budget, verification checks, and decision tracking
- **Knowledge base**: persistent store for every translation decision, type mapping, glossary term, annotation, and compliance gate result - survives IDE restarts, importable/exportable
- **Cutover engine**: readiness gate checks, audit bundle export with chain integrity (FNV-1a hash), committed file writing to target tree

### Multi-model
Switch models per task - use a fast model for chat, a powerful one for agentic runs.


## What is not in CE

The following features are available in [NeuralInverse Enterprise](https://neuralinverse.com):

- neuralInverseChecks - real-time GRC and compliance enforcement (HIPAA, SOC2, FDA 21 CFR Part 11, ISO 26262, etc.)
- Checks Agent - AI agent with programmatic access to violations, rule explanations, and compliance reporting
- NeuralInverse auth and team collaboration features


## Credits

NeuralInverse CE is built on top of [Void](https://github.com/voideditor/void) - an open-source AI code editor. Void is itself forked from [VS Code](https://github.com/microsoft/vscode) by Microsoft. We are grateful to both projects and their contributors.


## Architecture

NeuralInverse CE is forked from [Void](https://github.com/voideditor/void), which itself is a fork of [VS Code](https://github.com/microsoft/vscode).

Key modules:
- `src/vs/workbench/contrib/void/` - AI agent and chat infrastructure
- `src/vs/workbench/contrib/powerMode/` - Power Mode agentic workflows
- `src/vs/workbench/contrib/neuralInverseModernisation/` - Legacy code modernization platform
- `src/vs/workbench/contrib/neuralInverseFirmware/` - Firmware datasheet knowledge base


## Building from source

```bash
npm install
npm run compile
```

See [HOW_TO_CONTRIBUTE.md](./HOW_TO_CONTRIBUTE.md) for full setup instructions including platform prerequisites and developer mode.


## License

Copyright 2025 Neural Inverse Inc. Licensed under the Apache License 2.0. See [License.txt](./License.txt) for details.


## Support

- Email: github@neuralinverse.com
- Website: https://neuralinverse.com
