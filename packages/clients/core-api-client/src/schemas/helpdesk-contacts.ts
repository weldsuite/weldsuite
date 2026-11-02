import { z } from 'zod';

// `/api/helpdesk-contacts` — the helpdesk view of the shared `people` table.

/** A row of GET /api/helpdesk-contacts: the picked `people` columns and a conversation count. */
export const helpdeskContactListItemSchema = z.object({
  id: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  fullName: z.string().nullable(),
  email: z.string().nullable(),
  directPhone: z.string().nullable(),
  mobilePhone: z.string().nullable(),
  status: z.string(),
  notes: z.string().nullable(),
  interests: z.array(z.string()).nullable(),
  lastContactedAt: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  conversationCount: z.number(),
});

/** A row of GET /api/helpdesk-contacts/search. */
export const helpdeskContactSearchResultSchema = z.object({
  id: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  fullName: z.string().nullable(),
  email: z.string().nullable(),
  directPhone: z.string().nullable(),
  mobilePhone: z.string().nullable(),
  status: z.string(),
  avatarUrl: z.string().nullable(),
});

/** GET /api/helpdesk-contacts/:id: the whole `people` row. */
export const helpdeskContactSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    version: z.number(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    fullName: z.string().nullable(),
    displayName: z.string(),
    email: z.string().nullable(),
    directPhone: z.string().nullable(),
    mobilePhone: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    status: z.string(),
    notes: z.string().nullable(),
    tags: z.array(z.string()).nullable(),
    interests: z.array(z.string()).nullable(),
    customFields: z.record(z.unknown()).nullable(),
    lastContactedAt: z.string().nullable(),
    isSupplier: z.boolean(),
    isLead: z.boolean(),
    isFavorite: z.boolean(),
    inCrm: z.boolean(),
  })
  .passthrough();
