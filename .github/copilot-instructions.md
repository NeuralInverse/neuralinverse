# NeuralInverse CE Codebase AI Agent Instructions

## Overview
NeuralInverse CE is an open-source AI-native IDE built on VS Code, focused on legacy modernization, firmware development, and regulated codebase migration. CE-specific code lives in `src/vs/workbench/contrib/`.

## Architecture

### Core Structure
- **Browser Process** (`src/vs/workbench/contrib/void/browser/`): UI components, React-based interfaces, editor integrations
- **Common** (`src/vs/workbench/contrib/void/common/`): Shared services and types used by both processes
- **Electron Main** (`src/vs/workbench/contrib/void/electron-main/`): Backend services, LLM communication, file system operations

<<<<<<< HEAD
### Key Modules
- `contrib/void/` - AI chat and agent infrastructure
- `contrib/powerMode/` - Power Mode agentic workflows
- `contrib/neuralInverseModernisation/` - Legacy code modernization platform
- `contrib/neuralInverseFirmware/` - Firmware datasheet knowledge base
=======
### Core Architecture (`src/` folder)
- `src/vs/base/` - Foundation utilities and cross-platform abstractions
- `src/vs/platform/` - Platform services and dependency injection infrastructure
- `src/vs/editor/` - Text editor implementation with language services, syntax highlighting, and editing features
- `src/vs/workbench/` - Main application workbench for web and desktop
  - `workbench/browser/` - Core workbench UI components (parts, layout, actions)
  - `workbench/services/` - Service implementations
  - `workbench/contrib/` - Feature contributions (git, debug, search, terminal, etc.)
  - `workbench/api/` - Extension host and VS Code API implementation
- `src/vs/code/` - Electron main process specific implementation
- `src/vs/server/` - Server specific implementation

The core architecture follows these principles:
- **Layered architecture** - from `base`, `platform`, `editor`, to `workbench`
- **Dependency injection** - Services are injected through constructor parameters
- **Contribution model** - Features contribute to registries and extension points
- **Cross-platform compatibility** - Abstractions separate platform-specific code

### Built-in Extensions (`extensions/` folder)
The `extensions/` directory contains first-party extensions that ship with VS Code:
- **Language support** - `typescript-language-features/`, `html-language-features/`, `css-language-features/`, etc.
- **Core features** - `git/`, `debug-auto-launch/`, `emmet/`, `markdown-language-features/`
- **Themes** - `theme-*` folders for default color themes
- **Development tools** - `extension-editing/`, `vscode-api-tests/`

Each extension follows the standard VS Code extension structure with `package.json`, TypeScript sources, and contribution points to extend the workbench through the Extension API.

### Finding Related Code
1. **Semantic search first**: Use file search for general concepts
2. **Grep for exact strings**: Use grep for error messages or specific function names
3. **Follow imports**: Check what files import the problematic module
4. **Check test files**: Often reveal usage patterns and expected behavior

## Validating TypeScript changes

You MUST check compilation output before running ANY script or declaring work complete!

1. **ALWAYS** check the `VS Code - Build` watch task output for compilation errors
2. **NEVER** run tests if there are compilation errors
3. **NEVER** use `npm run compile` to compile TypeScript files, always check task output
4. **FIX** all compilation errors before moving forward

### TypeScript compilation steps
- Monitor the `VS Code - Build` task outputs for real-time compilation errors as you make changes
- This task runs `Core - Build` and `Ext - Build` to incrementally compile VS Code TypeScript sources and built-in extensions
- Start the task if it's not already running in the background

### TypeScript validation steps
- Use run test tool or `scripts/test.sh` (`scripts\test.bat` on Windows) for unit tests (add `--grep <pattern>` to filter tests)
- Use `scripts/test-integration.sh` (or `scripts\test-integration.bat` on Windows) for integration tests
- Use `npm run valid-layers-check` to check for layering issues

## Coding Guidelines

### Indentation

We use tabs, not spaces.

### Naming Conventions

- Use PascalCase for `type` names
- Use PascalCase for `enum` values
- Use camelCase for `function` and `method` names
- Use camelCase for `property` names and `local variables`
- Use whole words in names when possible

### Types

- Do not export `types` or `functions` unless you need to share it across multiple components
- Do not introduce new `types` or `values` to the global namespace

### Comments

- Use JSDoc style comments for `functions`, `interfaces`, `enums`, and `classes`

### Strings

- Use "double quotes" for strings shown to the user that need to be externalized (localized)
- Use 'single quotes' otherwise
- All strings visible to the user need to be externalized

### UI labels
- Use title-style capitalization for command labels, buttons and menu items (each word is capitalized).
- Don't capitalize prepositions of four or fewer letters unless it's the first or last word (e.g. "in", "with", "for").

### Style

- Use arrow functions `=>` over anonymous function expressions
- Only surround arrow function parameters when necessary. For example, `(x) => x + x` is wrong but the following are correct:
>>>>>>> 1.104.0

### Key Services
All services follow the VS Code singleton pattern:
```typescript
registerSingleton(IServiceName, ServiceClass, InstantiationType.Eager);
```

Essential services include:
- `IEditCodeService`: Handles code modifications and diff visualization
- `ILLMMessageService`: Manages AI provider communication
- `IVoidSettingsService`: Stores provider configs, model selections, and preferences
- `IVoidModelService`: Handles file writing and model operations

### AI Integration
- LLM requests routed through main process to bypass browser CSP restrictions
- Supports Anthropic, OpenAI, Ollama, Mistral, Google GenAI providers
- Messages use structured types: `LLMChatMessage[]` with role/content format
- Streaming responses handled via event hooks (`onText`, `onFinalMessage`, `onError`)

## Development Workflow

### Building
Use npm scripts with deemon for persistent watching:
```bash
npm run watch-clientd      # Watch core TypeScript compilation
npm run watch-extensionsd  # Watch extension compilation
npm run watchreactd        # Watch React UI components
```

React components require custom build script:
```bash
cd src/vs/workbench/contrib/void/browser/react/
node build.js --watch
```

### Running
```bash
./scripts/code.sh          # Launch development instance
./scripts/code-server.sh   # Run code server
```

### Testing
```bash
npm run test               # Run test suite
./scripts/test.sh          # Integration tests
```

## Code Modification Patterns

### Apply System
Two code modification approaches are supported:

**Fast Apply** (preferred):
- Uses search-replace blocks with conflict markers:
```typescript
<<<<<<< ORIGINAL
// existing code
=======
// replacement code
>>>>>>> UPDATED
```
- Enables precise, incremental changes
- Supports streaming diffs during AI generation

**Slow Apply**:
- Rewrites entire file contents
- Used when Fast Apply fails or for complete file transformations

### File Operations
- Write to `ITextModel` instances via URI, not direct file I/O
- Use `IVoidModelService` for model operations
- Changes trigger automatic diff zone creation and visualization

### UI Components
- React components bundled for browser process
- Mount via VS Code's webview system
- Use `mountCtrlK()` pattern for component integration

## Communication Patterns

### Main <-> Browser IPC
- Services communicate via channels (e.g., `sendLLMMessageChannel`)
- Browser requests route to main process for privileged operations
- Events flow back through registered hooks

### Service Dependencies
Services inject via decorators:
```typescript
constructor(
  @ILLMMessageService private readonly llmMessageService: ILLMMessageService,
  @IVoidSettingsService private readonly settingsService: IVoidSettingsService,
) {}
```

## Key Files & Directories

### Core Services
- `editCodeService.ts`: Code modification and diff handling
- `sendLLMMessageService.ts`: AI provider abstraction
- `voidSettingsService.ts`: Configuration management
- `voidModelService.ts`: File/model operations

### UI Components
- `react/`: React-based UI components
- `sidebarPane.ts`: Main AI chat interface
- `quickEditActions.ts`: Ctrl+K inline editing

### Backend
- `electron-main/llmMessage/`: Provider implementations
- `sendLLMMessage.impl.ts`: SDK integrations (Anthropic, OpenAI, etc.)

### Configuration
- `modelCapabilities.ts`: Model specifications and capabilities
- `voidSettingsTypes.ts`: TypeScript interfaces for settings

## Best Practices

### Service Registration
- Register all services in `void.contribution.ts`
- Use `InstantiationType.Eager` for critical services
- Import service files to trigger registration

### String Literals
- All TypeScript/JavaScript string literals must be ASCII only
- Non-ASCII characters break the release build (esbuild limitation)

### Error Handling
- LLM operations use try/catch with `onError` callbacks
- Network failures handled at provider level
- User-facing errors displayed via `INotificationService`

### State Management
- Settings persisted via `IVoidSettingsService`
- UI state managed through React components
- File changes tracked via diff zones and snapshots

### Performance
- Use streaming for large AI responses
- Debounce UI updates during rapid changes
- Background compilation with deemon watchers

## Common Patterns

### Adding New Providers
1. Add provider types to `voidSettingsTypes.ts`
2. Implement in `sendLLMMessage.impl.ts`
3. Update `modelCapabilities.ts`
4. Add UI configuration in settings pane

### Creating New Services
1. Define interface with `createDecorator`
2. Implement class with dependency injection
3. Register with `registerSingleton`
4. Import in `void.contribution.ts`

### Extending UI
1. Create React component in `react/` directory
2. Build with custom script
3. Mount via VS Code webview APIs
4. Connect to services via context or props
