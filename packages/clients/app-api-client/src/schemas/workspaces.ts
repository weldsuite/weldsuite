import { z } from 'zod';

// ============================================================================
// Workspaces: GET /api/workspaces, the workspaces the caller is an active
// member of (the workspace switcher). `id` is the Clerk org id clients switch
// with (the workspace id for a legacy row without one); `workspaceId` is
// `workspaces.id`. The answer is `{ data: WorkspaceSummary[] }`, no pagination.
// ============================================================================

export const workspaceSummarySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  slug: z.string(),
  imageUrl: z.string().nullable(),
  role: z.string(),
});

export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
