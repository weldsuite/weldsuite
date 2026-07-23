import { z } from 'zod';

// `/api/documents` — project documents (backed by `project_documents`).

export const createDocumentSchema = z.object({
  title: z.string().min(1).max(500).default('Untitled'),
  projectId: z.string().nullish(),
  body: z.string().optional(),
  bodyHtml: z.string().optional(),
  authorId: z.string().nullish(),
  parentId: z.string().nullish(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateDocumentSchema = createDocumentSchema.partial();
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;
