import { z } from 'zod';

// `/api/knowledge` — WeldKnow workspace wiki (spaces + nested pages).

/** Space visibility: workspace-wide or private to the creator. */
export const KNOWLEDGE_SPACE_VISIBILITIES = ['workspace', 'private'] as const;
export type KnowledgeSpaceVisibility = (typeof KNOWLEDGE_SPACE_VISIBILITIES)[number];

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

export const createKnowledgeSpaceSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  icon: z.string().max(100).nullish(),
  color: z.string().max(50).nullish(),
  visibility: z.enum(KNOWLEDGE_SPACE_VISIBILITIES).optional(),
  sortOrder: z.number().int().optional(),
});

export const updateKnowledgeSpaceSchema = createKnowledgeSpaceSchema.partial();

export type CreateKnowledgeSpaceInput = z.infer<typeof createKnowledgeSpaceSchema>;
export type UpdateKnowledgeSpaceInput = z.infer<typeof updateKnowledgeSpaceSchema>;

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export const createKnowledgePageSchema = z.object({
  spaceId: z.string().min(1),
  parentId: z.string().nullish(),
  title: z.string().max(500).optional(),
  icon: z.string().max(100).nullish(),
  coverImage: z.string().max(1000).nullish(),
  contentJson: z.array(z.record(z.unknown())).optional(),
});

/** Metadata-only update — content goes through PUT /pages/:id/content. */
export const updateKnowledgePageSchema = z.object({
  title: z.string().max(500).optional(),
  icon: z.string().max(100).nullish(),
  coverImage: z.string().max(1000).nullish(),
  isLocked: z.boolean().optional(),
});

/** Autosave payload: blocks + a plain-text extraction the client derives for search. */
export const saveKnowledgePageContentSchema = z.object({
  contentJson: z.array(z.record(z.unknown())),
  contentText: z.string().optional(),
});

export const moveKnowledgePageSchema = z.object({
  parentId: z.string().nullable(),
  spaceId: z.string().optional(),
  position: z.number().int().min(0).optional(),
});

export const createKnowledgePageVersionSchema = z.object({
  label: z.string().max(255).nullish(),
});

export const addKnowledgeFavoriteSchema = z.object({
  pageId: z.string().min(1),
});

export type CreateKnowledgePageInput = z.infer<typeof createKnowledgePageSchema>;
export type UpdateKnowledgePageInput = z.infer<typeof updateKnowledgePageSchema>;
export type SaveKnowledgePageContentInput = z.infer<typeof saveKnowledgePageContentSchema>;
export type MoveKnowledgePageInput = z.infer<typeof moveKnowledgePageSchema>;
