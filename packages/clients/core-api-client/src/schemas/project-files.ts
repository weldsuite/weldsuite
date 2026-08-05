import { z } from 'zod';

const parentIdSchema = z.string().min(1).nullable().optional();

export const createProjectFileSchema = z.object({
  projectId: z.string(),
  fileName: z.string().max(500),
  contentType: z.string().max(255).optional(),
  size: z.number().int().optional(),
  url: z.string().max(2000).optional(),
  storageKey: z.string().max(500).optional(),
  uploadedBy: z.string().optional(),
  metadata: z.unknown().optional(),
  /** Parent folder id; null/omitted = project root. */
  parentId: parentIdSchema,
  isFolder: z.boolean().optional(),
  fileType: z.string().max(50).optional(),
}).passthrough();

export const updateProjectFileSchema = createProjectFileSchema.partial().extend({
  /** Explicit null moves the file/folder back to the project root. */
  parentId: parentIdSchema,
});

export const createProjectFolderSchema = z.object({
  projectId: z.string(),
  name: z.string().trim().min(1).max(500),
  parentId: parentIdSchema,
});

export type CreateProjectFileInput = z.infer<typeof createProjectFileSchema>;
export type UpdateProjectFileInput = z.infer<typeof updateProjectFileSchema>;
export type CreateProjectFolderInput = z.infer<typeof createProjectFolderSchema>;
