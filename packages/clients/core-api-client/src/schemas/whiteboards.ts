import { z } from 'zod';

// `/api/whiteboards` — backed by `project_whiteboards`.

export const createWhiteboardSchema = z.object({
  name: z.string().max(255).default('Main Whiteboard'),
  projectId: z.string().nullish(),
  data: z.unknown().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateWhiteboardSchema = createWhiteboardSchema.partial();
export type CreateWhiteboardInput = z.infer<typeof createWhiteboardSchema>;
export type UpdateWhiteboardInput = z.infer<typeof updateWhiteboardSchema>;
