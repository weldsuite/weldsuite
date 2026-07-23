import { z } from 'zod';

// ============================================================================
// Task Digest Settings — singleton workspace-level configuration for the daily
// task digest email. There is at most one row per tenant; the route exposes
// GET / + PUT / (no resource /:id lifecycle).
//
// Backed by the `task_digest_settings` table (tenant DB) plus a dual-write of
// schedule metadata into `digest_schedules` (master DB) so the cron runner can
// fan out without a tenant lookup.
// Permission prefix: `settings:*` (org-level settings object).
// ============================================================================

export const updateDigestSettingsSchema = z.object({
  enabled: z.boolean(),
  sendHour: z.number().int().min(0).max(23),
  taskTypes: z.object({
    projectTasks: z.boolean(),
    personalTasks: z.boolean(),
  }),
  sections: z.object({
    overdue: z.boolean(),
    dueToday: z.boolean(),
    dueThisWeek: z.boolean(),
  }),
});

export type UpdateDigestSettingsInput = z.infer<typeof updateDigestSettingsSchema>;
