import { z } from 'zod';

// `/api/helpdesk-announcements` — backed by `helpdesk_announcements`: status
// banners on the help center and in the chat widget.

export const ANNOUNCEMENT_TYPES = ['info', 'warning', 'success', 'error'] as const;
export type AnnouncementType = (typeof ANNOUNCEMENT_TYPES)[number];

export const ANNOUNCEMENT_STATUSES = ['draft', 'published', 'archived'] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];

/**
 * `public`: every reader · `specific_groups`: readers at one of `targetGroups`
 * (CRM company ids, matched through the reader's verified email, like an
 * article's `groups`) · `internal`: never shown outside the team.
 */
export const ANNOUNCEMENT_VISIBILITIES = ['public', 'internal', 'specific_groups'] as const;
export type AnnouncementVisibility = (typeof ANNOUNCEMENT_VISIBILITIES)[number];

/**
 * The columns a write may set. The author is the caller; `publishedAt` is
 * stamped when the announcement is published without one. A published
 * announcement shows from `publishedAt` until `expiresAt` (none = until it is
 * archived).
 */
export const createHelpdeskAnnouncementSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string(),
  excerpt: z.string().nullish(),
  type: z.enum(ANNOUNCEMENT_TYPES).optional(),
  status: z.enum(ANNOUNCEMENT_STATUSES).optional(),
  visibility: z.enum(ANNOUNCEMENT_VISIBILITIES).optional(),
  targetGroups: z.array(z.string().min(1).max(30)).max(100).nullish(),
  featuredImage: z.string().max(500).nullish(),
  authorName: z.string().max(255).nullish(),
  publishedAt: z.string().datetime().nullish(),
  expiresAt: z.string().datetime().nullish(),
  isPinned: z.boolean().optional(),
});

export const updateHelpdeskAnnouncementSchema = createHelpdeskAnnouncementSchema.partial();

export type CreateHelpdeskAnnouncementInput = z.infer<typeof createHelpdeskAnnouncementSchema>;
export type UpdateHelpdeskAnnouncementInput = z.infer<typeof updateHelpdeskAnnouncementSchema>;

/** A `helpdesk_announcements` row, as /api/helpdesk-announcements returns it. */
export const helpdeskAnnouncementSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    title: z.string(),
    content: z.string(),
    excerpt: z.string().nullable(),
    type: z.string(),
    status: z.string(),
    visibility: z.string(),
    targetGroups: z.unknown(),
    featuredImage: z.string().nullable(),
    authorId: z.string(),
    authorName: z.string().nullable(),
    publishedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    isPinned: z.boolean().nullable(),
    viewCount: z.number().nullable(),
  })
  .passthrough();
