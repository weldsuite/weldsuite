/**
 * Leads service — pre-qualified contacts, ahead of the People/Companies
 * identity layer.
 *
 * Pure business logic; no Hono context. Shared by the crm-api leads routes
 * and WeldConnect's `create_lead` workflow action, so both paths insert the
 * same row shape and publish the same `lead:created` event payload.
 */

import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { CreateLeadInput } from '@weldsuite/core-api-client/schemas/leads';
import type { DataFor } from '@weldsuite/entity-events';

type LeadEventData = DataFor<'lead'>;

type LeadRow = typeof schema.crmLeads.$inferSelect;
type LeadInsert = typeof schema.crmLeads.$inferInsert;

/**
 * The lead fields carried by `created` / `updated` events: the contact card a
 * workflow needs (`{{trigger.record.companyName}}`), not the whole row. The
 * free-text qualification fields (notes, need, budget, …) stay out of the
 * event bus, which also feeds webhooks and analytics. Keep in sync with the
 * `lead` entry in apps/web/platform/app/weldconnect/record-fields.ts.
 */
export const LEAD_EVENT_FIELDS = [
  'firstName',
  'lastName',
  'fullName',
  'companyName',
  'title',
  'phone',
  'mobile',
  'website',
  'address',
  'source',
  'rating',
  'score',
  'ownerId',
] as const;

/**
 * The LEAD_EVENT_FIELDS projection of a lead row. A superset of
 * `LeadEventData`'s optional fields (plus columns the catalog type doesn't
 * pin down, e.g. `companyName`, `phone`) — callers that publish to the
 * entity-event bus merge in `id`/`email`/`status` to get a full `LeadEventData`.
 */
export interface LeadEventFields {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  companyName: string | null;
  title: string | null;
  phone: string | null;
  mobile: string | null;
  website: string | null;
  address: unknown;
  source: string | null;
  rating: string | null;
  score: number | null;
  ownerId: string | null;
}

export function leadEventFields(lead: Partial<LeadRow | LeadInsert>): LeadEventFields {
  return Object.fromEntries(LEAD_EVENT_FIELDS.map((field) => [field, lead[field] ?? null])) as unknown as LeadEventFields;
}

export interface CreateLeadResult {
  id: string;
  /** The inserted row's values (not re-fetched — matches what the insert wrote). */
  row: LeadInsert;
  /** `lead:created` event payload, ready to publish. */
  eventData: LeadEventData;
}

/**
 * Insert a lead row. `ownerId` defaults to `actingUserId` when the input
 * doesn't specify one — the CRM route's caller for a normal create, or the
 * workflow's owner for WeldConnect's `create_lead` step.
 */
export async function createLead(
  db: Database,
  input: CreateLeadInput,
  actingUserId?: string,
): Promise<CreateLeadResult> {
  const { crmLeads } = schema;
  const id = generateId('lead');
  const now = new Date();
  const fullName =
    input.firstName || input.lastName
      ? `${input.firstName ?? ''} ${input.lastName ?? ''}`.trim()
      : undefined;
  const values: LeadInsert = {
    id,
    firstName: input.firstName,
    lastName: input.lastName,
    fullName,
    email: input.email,
    companyName: input.companyName,
    title: input.title,
    phone: input.phone,
    mobile: input.mobile,
    website: input.website,
    address: input.address as
      | { line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; country?: string }
      | null
      | undefined,
    source: input.source ?? 'other',
    channel: input.channel,
    campaign: input.campaign,
    medium: input.medium,
    status: input.status ?? 'new',
    rating: input.rating,
    score: input.score ?? 0,
    ownerId: input.ownerId ?? actingUserId,
    productInterest: input.productInterest,
    budget: input.budget as { amount: number; currency: string } | null | undefined,
    timeline: input.timeline,
    authority: input.authority,
    need: input.need,
    notes: input.notes,
    nextAction: input.nextAction,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(crmLeads).values(values);
  const eventData: LeadEventData = {
    ...leadEventFields(values),
    id,
    email: values.email ?? '',
    status: values.status ?? 'new',
  };
  return { id, row: values, eventData };
}
