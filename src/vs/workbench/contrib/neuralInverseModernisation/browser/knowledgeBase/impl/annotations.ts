/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit annotations and tags.
 *
 * Annotations are free-text notes attached to units by reviewers, agents, or
 * automated tools. They survive status transitions and provide a human-readable
 * audit trail complementary to the structured audit log.
 *
 * Tags are coloured label objects that can be attached to multiple units for
 * flexible organisation (e.g. "needs-domain-expert", "high-priority-sprint-1").
 */

import {
	IUnitAnnotation,
	IUnitTag,
	IKnowledgeBaseExtensions,
} from '../../../common/knowledgeBaseTypes.js';
import { makeId } from './helpers.js';

// ─── Annotation store ─────────────────────────────────────────────────────────

export interface IAnnotationStore {
	annotations: Map<string, IUnitAnnotation>; // annotationId → annotation
	tags:        Map<string, IUnitTag>;        // tagId → tag
	unitTags:    Map<string, Set<string>>;     // unitId → Set<tagId>
}

export function createAnnotationStore(): IAnnotationStore {
	return {
		annotations: new Map(),
		tags:        new Map(),
		unitTags:    new Map(),
	};
}

// ─── Annotations ─────────────────────────────────────────────────────────────

export function addAnnotation(
	store: IAnnotationStore,
	unitId: string,
	content: string,
	author: string,
	kind: IUnitAnnotation['kind'] = 'review-note',
): IUnitAnnotation {
	const annotation: IUnitAnnotation = {
		id:        makeId('an'),
		unitId,
		content,
		author,
		kind,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	store.annotations.set(annotation.id, annotation);
	return annotation;
}

export function updateAnnotation(
	store: IAnnotationStore,
	annotationId: string,
	content: string,
): void {
	const existing = store.annotations.get(annotationId);
	if (!existing) { return; }
	store.annotations.set(annotationId, {
		...existing,
		content,
		updatedAt: Date.now(),
	});
}

export function deleteAnnotation(
	store: IAnnotationStore,
	annotationId: string,
): void {
	store.annotations.delete(annotationId);
}

export function getAnnotations(
	store: IAnnotationStore,
	unitId: string,
): IUnitAnnotation[] {
	const result: IUnitAnnotation[] = [];
	for (const ann of store.annotations.values()) {
		if (ann.unitId === unitId) { result.push(ann); }
	}
	return result.sort((a, b) => a.createdAt - b.createdAt);
}

export function getContextAnnotations(
	store: IAnnotationStore,
	kind: IUnitAnnotation['kind'],
): IUnitAnnotation[] {
	const result: IUnitAnnotation[] = [];
	for (const ann of store.annotations.values()) {
		if (ann.kind === kind) { result.push(ann); }
	}
	return result.sort((a, b) => a.createdAt - b.createdAt);
}

// ─── Tags ─────────────────────────────────────────────────────────────────────

export function createTag(
	store: IAnnotationStore,
	tag: Omit<IUnitTag, 'id' | 'createdAt'>,
): IUnitTag {
	const newTag: IUnitTag = { ...tag, id: makeId('tg'), createdAt: Date.now() };
	store.tags.set(newTag.id, newTag);
	return newTag;
}

export function addTagToUnit(
	store: IAnnotationStore,
	unitId: string,
	tagId: string,
): void {
	if (!store.tags.has(tagId)) { return; }
	if (!store.unitTags.has(unitId)) { store.unitTags.set(unitId, new Set()); }
	store.unitTags.get(unitId)!.add(tagId);
}

export function removeTagFromUnit(
	store: IAnnotationStore,
	unitId: string,
	tagId: string,
): void {
	store.unitTags.get(unitId)?.delete(tagId);
}

export function deleteTag(
	store: IAnnotationStore,
	tagId: string,
): void {
	store.tags.delete(tagId);
	// Remove from all units
	for (const tagSet of store.unitTags.values()) {
		tagSet.delete(tagId);
	}
}

export function getTag(
	store: IAnnotationStore,
	tagId: string,
): IUnitTag | undefined {
	return store.tags.get(tagId);
}

export function getAllTags(store: IAnnotationStore): IUnitTag[] {
	return Array.from(store.tags.values());
}

export function getTagsForUnit(
	store: IAnnotationStore,
	unitId: string,
): IUnitTag[] {
	const tagIds = store.unitTags.get(unitId);
	if (!tagIds) { return []; }
	const result: IUnitTag[] = [];
	for (const id of tagIds) {
		const t = store.tags.get(id);
		if (t) { result.push(t); }
	}
	return result;
}

export function getUnitsByTag(
	store: IAnnotationStore,
	tagId: string,
): string[] {
	const unitIds: string[] = [];
	for (const [unitId, tagSet] of store.unitTags) {
		if (tagSet.has(tagId)) { unitIds.push(unitId); }
	}
	return unitIds;
}

// ─── Serialisation helpers ────────────────────────────────────────────────────

/** Convert annotation store to plain objects for KB serialisation */
export function annotationStoreToExt(
	store: IAnnotationStore,
): Pick<IKnowledgeBaseExtensions, 'annotations' | 'tags' | 'unitTags'> {
	return {
		annotations: Array.from(store.annotations.values()),
		tags:        Array.from(store.tags.values()),
		unitTags:    Object.fromEntries(
			Array.from(store.unitTags.entries())
				.map(([k, v]) => [k, Array.from(v)])
		),
	};
}

/** Restore annotation store from KB ext (after deserialisation) */
export function extToAnnotationStore(
	ext: Pick<IKnowledgeBaseExtensions, 'annotations' | 'tags' | 'unitTags'>,
): IAnnotationStore {
	const store = createAnnotationStore();
	for (const ann of (ext.annotations ?? [])) {
		store.annotations.set(ann.id, ann);
	}
	for (const tag of (ext.tags ?? [])) {
		store.tags.set(tag.id, tag);
	}
	const unitTagsRaw = (ext.unitTags as Record<string, string[]> | undefined) ?? {};
	for (const [unitId, tagIds] of Object.entries(unitTagsRaw)) {
		store.unitTags.set(unitId, new Set(tagIds));
	}
	return store;
}
