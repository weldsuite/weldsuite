import { z } from 'zod';

// `/api/helpdesk-announcements` — backed by `helpdesk_announcements`.

export const createHelpdeskAnnouncementSchema = z.object({
  title: z.string().min(1).max(500),
  body: z.string().optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  isPublished: z.boolean().optional(),
  audience: z.string().max(50).optional(),
  metadata: z.unknown().optional(),
}).passthrough();

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
