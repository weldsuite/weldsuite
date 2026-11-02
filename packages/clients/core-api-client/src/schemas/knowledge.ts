import { z } from 'zod';

// `/api/knowledge` — WeldKnow workspace wiki (spaces + nested pages).

/**
 * Teamspace visibility (Notion model):
 *   open    — everyone can find and read it; joining makes you an editor
 *   closed  — everyone sees it exists; only members read it, owners add people
 *   private — only members know it exists
 */
export const KNOWLEDGE_SPACE_VISIBILITIES = ['open', 'closed', 'private'] as const;
export type KnowledgeSpaceVisibility = (typeof KNOWLEDGE_SPACE_VISIBILITIES)[number];

/** `personal` is each person's own Private section; `team` is a teamspace. */
export const KNOWLEDGE_SPACE_KINDS = ['personal', 'team'] as const;
export type KnowledgeSpaceKind = (typeof KNOWLEDGE_SPACE_KINDS)[number];

/** owner manages the teamspace, editor writes pages, viewer reads. */
export const KNOWLEDGE_SPACE_ROLES = ['owner', 'editor', 'viewer'] as const;
export type KnowledgeSpaceRole = (typeof KNOWLEDGE_SPACE_ROLES)[number];

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

export const createKnowledgeSpaceSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  icon: z.string().max(100).nullish(),
  color: z.string().max(50).nullish(),
  visibility: z.enum(KNOWLEDGE_SPACE_VISIBILITIES).optional(),
  /** Add every workspace member as an editor. Needs knowledge:manage. */
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const updateKnowledgeSpaceSchema = createKnowledgeSpaceSchema.partial();

export type CreateKnowledgeSpaceInput = z.infer<typeof createKnowledgeSpaceSchema>;
export type UpdateKnowledgeSpaceInput = z.infer<typeof updateKnowledgeSpaceSchema>;

// ---------------------------------------------------------------------------
// Teamspace members
// ---------------------------------------------------------------------------

/** Add a teammate, or change their role if they are already in. */
export const addKnowledgeSpaceMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(KNOWLEDGE_SPACE_ROLES),
});

export const updateKnowledgeSpaceMemberSchema = z.object({
  role: z.enum(KNOWLEDGE_SPACE_ROLES),
});

export type AddKnowledgeSpaceMemberInput = z.infer<typeof addKnowledgeSpaceMemberSchema>;
export type UpdateKnowledgeSpaceMemberInput = z.infer<typeof updateKnowledgeSpaceMemberSchema>;

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

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const blocksSchema = z.array(z.record(z.unknown()));

/** A `knowledge_spaces` row, as POST and PATCH /spaces return it. */
export const knowledgeSpaceRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  kind: z.enum(KNOWLEDGE_SPACE_KINDS),
  ownerId: z.string().nullable(),
  visibility: z.enum(KNOWLEDGE_SPACE_VISIBILITIES),
  isDefault: z.boolean(),
  sortOrder: z.number().int(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});

/** GET /spaces: the row plus what the caller may do in it. */
export const knowledgeSpaceSchema = knowledgeSpaceRowSchema.extend({
  role: z.enum(KNOWLEDGE_SPACE_ROLES).nullable(),
  isMember: z.boolean(),
  canRead: z.boolean(),
  canWrite: z.boolean(),
  canManage: z.boolean(),
  memberCount: z.number().int(),
});

export const knowledgeTeammateSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  picture: z.string().nullable(),
});

export const knowledgeSpaceMemberSchema = knowledgeTeammateSchema.extend({
  role: z.enum(KNOWLEDGE_SPACE_ROLES),
  addedBy: z.string().nullable(),
  createdAt: z.string(),
});

/** What the member, join and role routes answer. */
export const knowledgeMembershipSchema = z.object({
  spaceId: z.string(),
  userId: z.string(),
  role: z.enum(KNOWLEDGE_SPACE_ROLES),
});

/** A `knowledge_pages` row. */
export const knowledgePageSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  parentId: z.string().nullable(),
  position: z.number().int(),
  title: z.string(),
  contentJson: blocksSchema.nullable(),
  contentText: z.string().nullable(),
  icon: z.string().nullable(),
  coverImage: z.string().nullable(),
  isLocked: z.boolean(),
  createdBy: z.string().nullable(),
  lastEditedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});

/** GET /pages/tree: a page without its content. */
export const knowledgePageTreeNodeSchema = knowledgePageSchema.pick({
  id: true,
  spaceId: true,
  parentId: true,
  position: true,
  title: true,
  icon: true,
  updatedAt: true,
});

/** GET /trash. */
export const knowledgeTrashedPageSchema = knowledgePageSchema
  .pick({ id: true, spaceId: true, parentId: true, title: true, icon: true })
  .extend({ deletedAt: z.string() });

/** PUT /pages/:id/content. */
export const knowledgeSavedContentSchema = z.object({ id: z.string() });

export const knowledgePageVersionSummarySchema = z.object({
  id: z.string(),
  pageId: z.string(),
  label: z.string().nullable(),
  createdById: z.string().nullable(),
  createdAt: z.string(),
});

export const knowledgePageVersionSchema = knowledgePageVersionSummarySchema.extend({
  content: blocksSchema,
});

export const knowledgeFavoriteSchema = z.object({
  id: z.string(),
  pageId: z.string(),
  position: z.number().int(),
  title: z.string(),
  icon: z.string().nullable(),
  spaceId: z.string(),
});

/** POST /favorites. */
export const knowledgeFavoriteRefSchema = z.object({ id: z.string(), pageId: z.string() });
