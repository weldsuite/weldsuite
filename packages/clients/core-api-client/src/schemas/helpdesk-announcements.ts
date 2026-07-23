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
