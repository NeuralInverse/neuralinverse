/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { IWorkflowComposerService } from './service.js';
import { WorkflowComposerServiceImpl } from './WorkflowComposerServiceImpl.js';

registerSingleton(IWorkflowComposerService, WorkflowComposerServiceImpl, InstantiationType.Delayed);

export { IWorkflowComposerService } from './service.js';
export { ComposerModel } from './model/composerModel.js';
export type { IComposerNode, IComposerEdge, IViewport, NodeType, IPortDefinition } from './model/composerModel.js';
export { ComposerHistory } from './model/composerHistory.js';
export { ComposerSerializer } from './model/composerSerializer.js';
export { EdgeValidator } from './edges/edgeValidator.js';
export type { IGraphValidationResult, IEdgeValidationResult } from './edges/edgeValidator.js';
export { NodeRegistry } from './nodes/nodeRegistry.js';
export type { INodeTypeDefinition } from './nodes/nodeRegistry.js';
export { WorkflowCanvas } from './canvas/workflowCanvas.js';
export { CanvasRenderer } from './canvas/canvasRenderer.js';
export { CanvasLayout } from './canvas/canvasLayout.js';
export { CanvasInteraction } from './canvas/canvasInteraction.js';
export { NodePalette } from './panels/nodePalette.js';
export { PropertyPanel } from './panels/propertyPanel.js';
export { TriggerPanel } from './panels/triggerPanel.js';
export { RunPanel } from './panels/runPanel.js';
