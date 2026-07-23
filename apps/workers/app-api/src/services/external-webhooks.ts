/**
 * External webhooks service — pure functions used by `/api/external-webhooks/*`
 * routes. Backs customer-configured outbound webhook subscriptions
 * (`external_webhooks` + `webhook_deliveries`), distinct from the inbound
 * WeldConnect trigger webhooks in `apps/workers/app-api/src/routes/workflow-webhooks`.
 */

import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { deliverWebhookEvent, listAllEvents } from '@weldsuite/entity-events';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';

const { externalWebhooks, webhookDeliveries } = schema;

export type ExternalWebhook = typeof externalWebhooks.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;

/** Public shape — never leaks the HMAC secret except right after create/rotate. */
export type ExternalWebhookPublic = Omit<ExternalWebhook, 'secret'>;

function toPublic(row: ExternalWebhook): ExternalWebhookPublic {
  const { secret: _secret, ...rest } = row;
  return rest;
}

function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `whsec_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Every event the catalog knows about — used to validate `events[]` on create/update. */
export function getSubscribableEvents(): readonly string[] {
  return listAllEvents();
}

export interface ListWebhooksParams {
  cursor?: string;
  limit?: number;
  status?: string;
}

export interface ListWebhooksResult {
  data: ExternalWebhookPublic[];
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

export async function listExternalWebhooks(
  db: Database,
  params: ListWebhooksParams,
): Promise<ListWebhooksResult> {
  const limit = Math.min(params.limit ?? 25, 100);
  const filterConditions = [isNull(externalWebhooks.deletedAt)];
  if (params.status) filterConditions.push(eq(externalWebhooks.status, params.status));

  const conditions = [...filterConditions];
  if (params.cursor) conditions.push(lt(externalWebhooks.id, params.cursor));

  const [rows, countRes] = await Promise.all([
    db
      .select()
      .from(externalWebhooks)
      .where(and(...conditions))
      .orderBy(desc(externalWebhooks.createdAt), desc(externalWebhooks.id))
      .limit(limit + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(externalWebhooks)
      .where(and(...filterConditions)),
  ]);

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && sliced.length > 0 ? sliced[sliced.length - 1].id : null;

  return {
    data: sliced.map(toPublic),
    totalCount: Number(countRes[0]?.count ?? 0),
    hasMore,
    cursor,
  };
}

export async function getExternalWebhookById(
  db: Database,
  id: string,
): Promise<ExternalWebhookPublic | null> {
  const [row] = await db
    .select()
    .from(externalWebhooks)
    .where(and(eq(externalWebhooks.id, id), isNull(externalWebhooks.deletedAt)))
    .limit(1);
  return row ? toPublic(row) : null;
}

/** Internal helper — includes the secret. Only used by rotate/test-send. */
async function getExternalWebhookRow(db: Database, id: string): Promise<ExternalWebhook | null> {
  const [row] = await db
    .select()
    .from(externalWebhooks)
    .where(and(eq(externalWebhooks.id, id), isNull(externalWebhooks.deletedAt)))
    .limit(1);
  return row ?? null;
}

export interface CreateWebhookInput {
  name: string;
  description?: string;
  url: string;
  events: string[];
  headers?: Record<string, string>;
  createdBy: string;
}

export interface CreateWebhookResult {
  webhook: ExternalWebhookPublic;
  /** Shown once — callers must copy it immediately. */
  secret: string;
}

export async function createExternalWebhook(
  db: Database,
  input: CreateWebhookInput,
): Promise<CreateWebhookResult> {
  const id = generateId('ewh');
  const secret = generateWebhookSecret();
  const now = new Date();
  const [row] = await db
    .insert(externalWebhooks)
    .values({
      id,
      name: input.name,
      description: input.description ?? null,
      url: input.url,
      events: input.events,
      secret,
      headers: input.headers ?? null,
      status: 'active',
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return { webhook: toPublic(row), secret };
}

export interface UpdateWebhookInput {
  name?: string;
  description?: string;
  url?: string;
  events?: string[];
  headers?: Record<string, string>;
  status?: string;
}

export async function updateExternalWebhook(
  db: Database,
  id: string,
  input: UpdateWebhookInput,
): Promise<ExternalWebhookPublic | null> {
  const existing = await getExternalWebhookRow(db, id);
  if (!existing) return null;

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.url !== undefined) updates.url = input.url;
  if (input.events !== undefined) updates.events = input.events;
  if (input.headers !== undefined) updates.headers = input.headers;
  if (input.status !== undefined) updates.status = input.status;

  const [row] = await db
    .update(externalWebhooks)
    .set(updates)
    .where(eq(externalWebhooks.id, id))
    .returning();
  return toPublic(row);
}

export async function softDeleteExternalWebhook(db: Database, id: string): Promise<boolean> {
  const existing = await getExternalWebhookRow(db, id);
  if (!existing) return false;
  await db
    .update(externalWebhooks)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(externalWebhooks.id, id));
  return true;
}

export interface RotateSecretResult {
  webhook: ExternalWebhookPublic;
  secret: string;
}

export async function rotateExternalWebhookSecret(
  db: Database,
  id: string,
): Promise<RotateSecretResult | null> {
  const existing = await getExternalWebhookRow(db, id);
  if (!existing) return null;
  const secret = generateWebhookSecret();
  const [row] = await db
    .update(externalWebhooks)
    .set({ secret, updatedAt: new Date() })
    .where(eq(externalWebhooks.id, id))
    .returning();
  return { webhook: toPublic(row), secret };
}

export interface ListDeliveriesParams {
  cursor?: string;
  limit?: number;
}

export interface ListDeliveriesResult {
  data: WebhookDelivery[];
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

export async function listWebhookDeliveries(
  db: Database,
  webhookId: string,
  params: ListDeliveriesParams,
): Promise<ListDeliveriesResult> {
  const limit = Math.min(params.limit ?? 25, 100);
  const filterConditions = [eq(webhookDeliveries.webhookId, webhookId)];

  const conditions = [...filterConditions];
  if (params.cursor) conditions.push(lt(webhookDeliveries.id, params.cursor));

  const [rows, countRes] = await Promise.all([
    db
      .select()
      .from(webhookDeliveries)
      .where(and(...conditions))
      .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
      .limit(limit + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(webhookDeliveries)
      .where(and(...filterConditions)),
  ]);

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && sliced.length > 0 ? sliced[sliced.length - 1].id : null;

  return {
    data: sliced,
    totalCount: Number(countRes[0]?.count ?? 0),
    hasMore,
    cursor,
  };
}

export interface SendTestWebhookResult {
  delivered: boolean;
  responseStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
}

/** Sends a single synthetic `webhook.test` event through the real delivery path. */
export async function sendTestWebhook(
  db: Database,
  id: string,
  workspaceId: string,
): Promise<SendTestWebhookResult | null> {
  const webhook = await getExternalWebhookRow(db, id);
  if (!webhook) return null;

  const testEventId = generateId('evt');
  return deliverWebhookEvent({
    db,
    webhook,
    eventId: testEventId,
    eventType: 'webhook.test',
    workspaceId,
    data: {
      message: 'This is a test event from WeldSuite.',
      webhookId: webhook.id,
    },
  });
}
