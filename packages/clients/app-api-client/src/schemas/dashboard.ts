import { z } from 'zod';

// ============================================================================
// Dashboard — the workspace home's read-only sections (`/api/dashboard`).
//
//   GET  /chart                         → dashboardChartPointSchema[]
//   GET  /installed-apps                → string[] (app codes, rail order)
//   GET  /activity                      → dashboardActivitySchema[] (newest 20)
//   GET  /sidebar-badges                → sidebarBadgesSchema
//   GET  /onboarding-checklist          → onboardingChecklistSchema
//   POST /onboarding-checklist/dismiss  → onboardingChecklistDismissedSchema
//
// Each section reads only what the member may read: the chart's order and
// revenue figures need `orders:read`, its ticket counts `tickets:read`, the
// activity feed `activities:read`.
// ============================================================================

/** One day of the 30-day chart (`YYYY-MM-DD`), oldest first. */
export const dashboardChartPointSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  orders: z.number().int(),
  tickets: z.number().int(),
  revenue: z.number(),
});

export type DashboardChartPoint = z.infer<typeof dashboardChartPointSchema>;

/** An installed app code the member can open (`weldcrm`, `welddesk`, …). */
export const installedAppCodeSchema = z.string().min(1);

/** A CRM activity as the feed returns it (the whole row). */
export const dashboardActivitySchema = z.object({
  id: z.string(),
  type: z.string(),
  subject: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  priority: z.string().nullable(),
  assignedToId: z.string(),
  relatedTo: z.string().nullable(),
  relatedToId: z.string().nullable(),
  relatedToName: z.string().nullable(),
  customerId: z.string().nullable(),
  personId: z.string().nullable(),
  dueDate: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.null(),
});

export type DashboardActivity = z.infer<typeof dashboardActivitySchema>;

/** The nav badge counts; each is 0 when the member may not read its object. */
export const sidebarBadgesSchema = z.object({
  unreadMessages: z.number().int(),
  openTickets: z.number().int(),
  pendingOrders: z.number().int(),
});

export type SidebarBadges = z.infer<typeof sidebarBadgesSchema>;

/** The getting-started checklist: done per task key, and the apps it was dismissed for. */
export const onboardingChecklistSchema = z.object({
  dismissedApps: z.array(z.string()),
  items: z.record(z.boolean()),
});

export type OnboardingChecklist = z.infer<typeof onboardingChecklistSchema>;

export const onboardingChecklistDismissedSchema = z.object({ success: z.literal(true) });
