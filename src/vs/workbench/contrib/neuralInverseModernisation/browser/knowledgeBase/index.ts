/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Public exports for the Knowledge Base module.
 *
 * Consumers import from this file \u2014 not from internal modules directly.
 * Import the DI registration side-effect:
 *   import '...neuralInverseModernisation/browser/knowledgeBase/index.js';
 */

// Public interface + types
export { IKnowledgeBaseService }             from './service.js';
export type {
	// Context & query
	IResolvedUnitContext,
	IKnowledgeBaseStats,
	IDependencyNode,
	IKnowledgeBaseSessionIndex,
	IUnitFilterCriteria,
	IDecisionImpactResult,
	IBudgetedUnitContext,
	// Organisational
	IWorkPackage,
	IStaleUnitReport,
	// Phases
	IPhaseProgress,
	// Locking
	IUnitLock,
	// Source drift
	ISourceFileVersion,
	ISourceDriftAlert,
	// Decision analysis
	IDecisionConflict,
	// Annotations & tags
	IUnitAnnotation,
	IUnitTag,
	// Compliance
	IComplianceGateResult,
	// Checkpoints
	IKnowledgeBaseCheckpoint,
	// Velocity
	IVelocityMetrics,
	// Health
	IKBHealthReport,
} from './service.js';

// DI registration (side-effect import)
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { IKnowledgeBaseService } from './service.js';
import { KnowledgeBaseImpl }     from './KnowledgeBaseImpl.js';

registerSingleton(IKnowledgeBaseService, KnowledgeBaseImpl, InstantiationType.Eager);
