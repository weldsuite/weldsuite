// AUTO-COPIED from @weldsuite/core-api-client/schemas/knowledge (external-api variant)
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

import { z } from 'zod';

// `/v1/knowledge-spaces` + `/v1/knowledge-pages` — WeldKnow workspace wiki.

/** Teamspace visibility: open (everyone reads), closed (listed, members read), private (members only). */
export const KNOWLEDGE_SPACE_VISIBILITIES = ['open', 'closed', 'private'] as const;
export type KnowledgeSpaceVisibility = (typeof KNOWLEDGE_SPACE_VISIBILITIES)[number];

export const createKnowledgeSpaceSchema = z.object({
  name: z.string().min(1).max(255).describe('Teamspace name'),
  description: z.string().optional().describe('What this teamspace is for'),
  icon: z.string().max(100).nullish().describe('Emoji or icon identifier'),
  color: z.string().max(50).nullish().describe('Accent color'),
  visibility: z
    .enum(KNOWLEDGE_SPACE_VISIBILITIES)
    .optional()
    .describe(
      "'open' (everyone can read; default), 'closed' (listed for everyone, only members read) or 'private' (only members see it). Workspace API keys can only use 'open'.",
    ),
  sortOrder: z.number().int().optional().describe('Sidebar sort order'),
});

export const updateKnowledgeSpaceSchema = createKnowledgeSpaceSchema.partial();

export const createKnowledgePageSchema = z.object({
  spaceId: z.string().min(1).describe('The knowledge space to create the page in'),
  parentId: z.string().nullish().describe('Parent page ID for a nested sub-page (omit for a top-level page)'),
  title: z.string().max(500).optional().describe("Page title (defaults to 'Untitled')"),
  icon: z.string().max(100).nullish().describe('Emoji shown next to the title'),
  coverImage: z.string().max(1000).nullish().describe('Cover image URL'),
  content: z
    .string()
    .optional()
    .describe(
      'Page body as plain text / light markdown. Supported: # / ## / ### headings, - bullets, 1. numbered items; blank lines separate paragraphs.',
    ),
});

export const updateKnowledgePageSchema = z.object({
  title: z.string().max(500).optional().describe('New page title'),
  icon: z.string().max(100).nullish().describe('Emoji shown next to the title'),
  coverImage: z.string().max(1000).nullish().describe('Cover image URL'),
  isLocked: z.boolean().optional().describe('Lock/unlock the page (locked pages reject content edits)'),
  content: z
    .string()
    .optional()
    .describe(
      'REPLACES the page body. Plain text / light markdown: # / ## / ### headings, - bullets, 1. numbered items.',
    ),
});

export const moveKnowledgePageSchema = z.object({
  parentId: z.string().nullable().describe('New parent page ID, or null to move to the space top level'),
  spaceId: z.string().optional().describe('Target space ID when moving across spaces (subtree moves along)'),
  position: z.number().int().min(0).optional().describe('Position among siblings (appends when omitted)'),
});

export type CreateKnowledgeSpaceInput = z.infer<typeof createKnowledgeSpaceSchema>;
export type CreateKnowledgePageInput = z.infer<typeof createKnowledgePageSchema>;
export type UpdateKnowledgePageInput = z.infer<typeof updateKnowledgePageSchema>;
export type MoveKnowledgePageInput = z.infer<typeof moveKnowledgePageSchema>;
