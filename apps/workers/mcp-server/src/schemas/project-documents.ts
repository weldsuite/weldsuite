// AUTO-COPIED from @weldsuite/core-api-client/schemas/project-documents
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

import { z } from 'zod';

// Inline page schema used within a multi-page document.
export const documentPageSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  order: z.number().optional(),
});

export type DocumentPage = z.infer<typeof documentPageSchema>;

// Body for create / update (PATCH).
export const createProjectDocumentSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  contentJson: z.array(z.record(z.unknown())).nullable().optional(),
  contentType: z.enum(['html', 'markdown', 'json']).optional(),
  coverImage: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  position: z.number().optional(),
  pages: z.array(documentPageSchema).nullable().optional(),
  activePageId: z.string().nullable().optional(),
});

export const updateProjectDocumentSchema = z.object({
  title: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  contentJson: z.array(z.record(z.unknown())).nullable().optional(),
  contentType: z.enum(['html', 'markdown', 'json']).optional(),
  coverImage: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  position: z.number().optional(),
  pages: z.array(documentPageSchema).nullable().optional(),
  activePageId: z.string().nullable().optional(),
});

export const moveProjectDocumentSchema = z.object({
  parentId: z.string().nullable(),
  position: z.number().default(0),
});

export const listProjectDocumentsQuerySchema = z.object({
  projectId: z.string().min(1),
});

export type CreateProjectDocumentInput = z.infer<typeof createProjectDocumentSchema>;
export type UpdateProjectDocumentInput = z.infer<typeof updateProjectDocumentSchema>;
export type MoveProjectDocumentInput = z.infer<typeof moveProjectDocumentSchema>;
export type ListProjectDocumentsQuery = z.infer<typeof listProjectDocumentsQuerySchema>;

export interface ProjectDocument {
  id: string;
  projectId: string;
  title: string;
  content: string | null;
  contentType: string;
  contentJson: Record<string, unknown>[] | null;
  pages: DocumentPage[] | null;
  activePageId: string | null;
  parentId: string | null;
  position: number;
  coverImage: string | null;
  icon: string | null;
  isPublished: boolean;
  publishedAt: Date | null;
  lastEditedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}
