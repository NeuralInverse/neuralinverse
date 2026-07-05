# NeuralInverse CE Codebase AI Agent Instructions

## Overview
NeuralInverse CE is an open-source AI-native IDE built on VS Code, focused on legacy modernization, firmware development, and regulated codebase migration. CE-specific code lives in `src/vs/workbench/contrib/`.

## Architecture

### Core Structure
- **Browser Process** (`src/vs/workbench/contrib/void/browser/`): UI components, React-based interfaces, editor integrations
- **Common** (`src/vs/workbench/contrib/void/common/`): Shared services and types used by both processes
- **Electron Main** (`src/vs/workbench/contrib/void/electron-main/`): Backend services, LLM communication, file system operations

### Key Modules
- `contrib/void/` - AI chat and agent infrastructure
- `contrib/powerMode/` - Power Mode agentic workflows
- `contrib/neuralInverseModernisation/` - Legacy code modernization platform
- `contrib/neuralInverseFirmware/` - Firmware datasheet knowledge base

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
