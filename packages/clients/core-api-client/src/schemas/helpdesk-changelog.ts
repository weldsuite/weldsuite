import { z } from 'zod';

// `/api/helpdesk-changelog` — read-only, backed by `helpdesk_changelog`.

/** A `helpdesk_changelog` row, as /api/helpdesk-changelog returns it. */
export const helpdeskChangelogEntrySchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    version: z.string(),
    title: z.string(),
    description: z.string(),
    releaseDate: z.string(),
    status: z.string(),
    type: z.string(),
    changes: z.unknown(),
    authorId: z.string(),
    authorName: z.string().nullable(),
  })
  .passthrough();
