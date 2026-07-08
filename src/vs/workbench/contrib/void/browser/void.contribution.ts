/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/


// shadow validation (diagnostics after AI edits)
import './shadowValidationService.js'

// register inline diffs
import './editCodeService.js'

// register Sidebar pane, state, actions (keybinds, menus) (Ctrl+L)
import './sidebarActions.js'
import './sidebarPane.js'

// register quick edit (Ctrl+K)
import './quickEditActions.js'


// register Autocomplete
import './autocompleteService.js'

// register Context services
// import './contextGatheringService.js'
// import './contextUserChangesService.js'

// settings pane
import './voidSettingsPane.js'

// custom artifact pane
import './neuralInverseArtifactPane.js'

// register css
// import './react/src/styles.css'

// update (frontend part, also see platform/)
import './voidUpdateActions.js'

import './convertToLLMMessageWorkbenchContrib.js'

// neural inverse
// import './neuralInverseService.js'

// register Extension Transfer Service
import './extensionTransferService.js'

// register MCP Service
import '../common/mcpService.js'

// internal tool registry (must load before chatThreadService and contributions that register tools)
import './voidInternalToolService.js'

// bridge void tools into VS Code's ILanguageModelToolsService (Copilot agent mode)
import './voidToolsBridge.js'

// bridge void models into ILanguageModelsService (Copilot model picker)
import './voidModelProvider.js'

// tools
import './externalCommandExecutor.js'
import './userInputRequestService.js'
import './toolsService.js'
import './terminalToolService.js'

// register Thread History
import './chatThreadService.js'

// terminal enhancements (command classification, process management, streaming)
import './terminalCommandClassifier.js'
import './terminalProcessManager.js'
import './terminalStreamingService.js'

// neural inverse agent (agentic execution engine — depends on chatThreadService)
import './neuralInverseAgentConfigService.js'
import './neuralInverseAgentService.js'
import './neuralInverseSubAgentService.js'

// agent autonomy services (scratchpad, rollback, task decomposition, memory)
import './agentScratchpadService.js'
import './agentRollbackService.js'
import './agentTaskDecomposer.js'
import './agentMemoryService.js'

// agent dashboard panel
import './neuralInverseAgentPane.js'

// ping
import './metricsPollService.js'

// helper services
import './helperServices/consistentItemService.js'

// register selection helper
import './voidSelectionHelperWidget.js'

// register tooltip service
import './tooltipService.js'

// register onboarding service
import './voidOnboardingService.js'

// register misc service
import './miscWokrbenchContrib.js'

// register file service (for explorer context menu)
import './fileService.js'

import './voidCommandBarService.js' // Register Command Bar Service

// register Auto-Connect (env var credential detection)
import './autoConnect/autoConnectService.js'

// register source control management
import './voidSCMService.js'

// ---------- common (unclear if these actually need to be imported, because they're already imported wherever they're used) ----------

// llmMessage
import '../common/sendLLMMessageService.js'

// voidSettings
import '../common/voidSettingsService.js'

// refreshModel
import '../common/refreshModelService.js'

// metrics
import '../common/metricsService.js'

// updates
import '../common/voidUpdateService.js'

// model service
import '../common/voidModelService.js'


