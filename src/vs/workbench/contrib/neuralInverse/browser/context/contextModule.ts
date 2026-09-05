/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import './index/index.js';
import './tracker/index.js';
import './relevance/index.js';
import './packer/index.js';
import './search/persistentStore.js';
import './search/bm25Index.js';
import './search/trigramIndex.js';
import './search/embeddingService.js';
import './search/hybridSearchService.js';
import './search/ledgerRecallService.js';

export { IWorkspaceSymbolIndexService } from './index/workspaceSymbolIndex.js';
export type { IIndexedSymbol, IFileIndex } from './index/workspaceSymbolIndex.js';
export { IChangeTrackerService } from './tracker/changeTracker.js';
export type { IEditEvent, IFileEditProfile } from './tracker/changeTracker.js';
export { IRelevanceScorerService } from './relevance/relevanceScorer.js';
export type { IRelevanceQuery, IScoredItem, RelevanceReason } from './relevance/relevanceScorer.js';
export { IContextPackerService } from './packer/contextPacker.js';
export type { IPackRequest, IPackedContext, IContextSection, ContextMode } from './packer/contextPacker.js';
export { IPersistentContextStore } from './search/persistentStore.js';
export { IWorkspaceBM25Service } from './search/bm25Index.js';
export type { IBM25Result } from './search/bm25Index.js';
export { ITrigramIndexService } from './search/trigramIndex.js';
export type { ITrigramMatch } from './search/trigramIndex.js';
export { IEmbeddingService } from './search/embeddingService.js';
export { IHybridSearchService } from './search/hybridSearchService.js';
export { ILedgerRecallService } from './search/ledgerRecallService.js';
export type { IHybridSearchResult } from './search/hybridSearchService.js';
