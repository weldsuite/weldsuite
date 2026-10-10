import { z } from 'zod';

/** Canonical project statuses, as stored in `projects.status`. */
export const PROJECT_STATUSES = ['Planning', 'Active', 'On Hold', 'Completed', 'Cancelled'] as const;
export type CanonicalProjectStatus = (typeof PROJECT_STATUSES)[number];

const PROJECT_STATUS_BY_KEY: Record<string, CanonicalProjectStatus> = {
  planning: 'Planning',
  active: 'Active',
  onhold: 'On Hold',
  completed: 'Completed',
  cancelled: 'Cancelled',
  canceled: 'Cancelled',
};

/**
 * Map any spelling of a project status ("planning", "ON_HOLD", "on-hold", "OnHold")
 * to its canonical stored form ("Planning", "On Hold", ...). Unknown values are
 * returned unchanged so custom statuses keep working.
 */
export function normalizeProjectStatus(value: string): string {
  const key = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  return PROJECT_STATUS_BY_KEY[key] ?? value;
}

export const createProjectSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  status: z.string().max(30).transform(normalizeProjectStatus).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  ownerId: z.string().nullish(),
  color: z.string().max(50).optional(),
  icon: z.string().max(100).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateProjectSchema = createProjectSchema.partial();
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
