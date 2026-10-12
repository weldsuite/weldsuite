/**
 * Mailpool webhooks: `POST /public/reach/webhooks/mailpool`.
 *
 * Mailpool signs each delivery with `X-Signature`, the hex HMAC-SHA256 of
 * `JSON.stringify(<parsed body>)` (NOT the raw body bytes) under the shared
 * secret. After verification the event is routed by its Mailpool id through the
 * master `reach_routes` table to the workspace's tenant DB, where the mailbox
 * or domain row is updated:
 *
 *   mailboxes.created / .updated   status + error -> active (start warming),
 *                                  suspended / error (needs attention), stored logins
 *   mailboxes.deleted              deleted at Mailpool behind our back -> error
 *   domains.registered / .updated  status + error -> connecting / active / error
 *
 * Everything else (spam checks, blacklist checks, inbox placements) and ids we
 * do not know are acknowledged with 200 and ignored, so Mailpool never retries
 * what we cannot use.
 *
 * Billing is not touched here: a webhook has no caller token for billing-worker.
 * A mailbox deleted outside WeldReach lands in `error` and is removed (and
 * released from Stripe) through the normal delete in the UI.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { publishEntityEventRaw, type EntityEventPublisherEnv } from '@weldsuite/entity-events';
import type { EntityType } from '@weldsuite/entity-events/events';
import { omitSensitive } from '@weldsuite/db/lib/sensitive-columns';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { sealMailServerCredentials } from '../lib/credentials';
import { imapCredentialsOf, smtpCredentialsOf } from '../lib/mailpool';
import type { MailpoolClient } from '../lib/mailpool/client';
import type { MailpoolMailbox } from '../lib/mailpool/types';
import { beginWarming, resumeStatusFor, searchWarmupLookup } from './warmup';

type MailboxRow = typeof schema.reachMailboxes.$inferSelect;
type DomainRow = typeof schema.reachDomains.$inferSelect;

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * Whether `signature` is the HMAC-SHA256 of `JSON.stringify(payload)` under
 * `secret`. Uses `crypto.subtle.verify`, which compares in constant time.
 */
export async function verifyMailpoolSignature(
  secret: string,
  signature: string | null | undefined,
  payload: unknown,
): Promise<boolean> {
  if (!secret || !signature) return false;
  const bytes = hexToBytes(signature.trim().replace(/^sha256=/i, ''));
  if (!bytes) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(JSON.stringify(payload)));
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export interface MailpoolWebhookMessage {
  event: string;
  data: Record<string, unknown>;
}

const EVENT_KEYS = ['event', 'type', 'eventType', 'name'] as const;
const DATA_KEYS = ['data', 'payload', 'body', 'object'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Pull the event name and its object out of a delivery. Mailpool's webhook
 * reference is not in the OpenAPI export, so this accepts the usual envelope
 * spellings; a body with neither is ignored upstream.
 */
export function parseMailpoolWebhook(body: unknown): MailpoolWebhookMessage | null {
  if (!isRecord(body)) return null;
  const event = EVENT_KEYS.map((key) => body[key]).find((value): value is string => typeof value === 'string' && value !== '');
  if (!event) return null;
  const nested = DATA_KEYS.map((key) => body[key]).find(isRecord);
  return { event, data: nested ?? body };
}

function mailpoolIdOf(data: Record<string, unknown>): string | null {
  const id = data.id;
  if (typeof id === 'string' && id !== '') return id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return null;
}

function remoteStatusOf(data: Record<string, unknown>): 'active' | 'pending' | 'inactive' | null {
  const status = typeof data.status === 'string' ? data.status.toLowerCase() : '';
  return status === 'active' || status === 'pending' || status === 'inactive' ? status : null;
}

function errorOf(data: Record<string, unknown>): { code: number | null; message: string | null } {
  const error = data.error;
  if (!isRecord(error)) return { code: null, message: null };
  return {
    code: typeof error.code === 'number' ? error.code : null,
    message: typeof error.message === 'string' ? error.message : null,
  };
}

/** Mailbox error codes that need the customer or staff to fix the account itself (not an abuse suspension). */
const CONFIGURATION_ERROR_CODES = new Set([101, 201, 202, 301]);

// ---------------------------------------------------------------------------
// Handling
// ---------------------------------------------------------------------------

export interface WebhookDeps {
  env: EntityEventPublisherEnv & { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string };
  master: MasterDatabase;
  openTenant: (clerkOrgId: string) => Promise<Database>;
  /** Null when MAILPOOL_API_KEY is not set: warmup is then left to the daily pass. */
  mailpool: MailpoolClient | null;
  now?: () => Date;
}

export type WebhookOutcome = { handled: true; changed: boolean } | { handled: false; reason: string };

const ignored = (reason: string): WebhookOutcome => ({ handled: false, reason });

export async function handleMailpoolWebhook(deps: WebhookDeps, message: MailpoolWebhookMessage): Promise<WebhookOutcome> {
  switch (message.event) {
    case 'mailboxes.created':
    case 'mailboxes.updated':
      return onMailboxUpdated(deps, message.data);
    case 'mailboxes.deleted':
      return onMailboxDeleted(deps, message.data);
    case 'domains.registered':
    case 'domains.updated':
      return onDomainUpdated(deps, message.data);
    default:
      return ignored('event_not_used');
  }
}

async function findRoute(deps: WebhookDeps, kind: 'mailpool_mailbox' | 'mailpool_domain', externalId: string) {
  const [route] = await deps.master
    .select()
    .from(masterSchema.reachRoutes)
    .where(
      and(
        eq(masterSchema.reachRoutes.kind, kind),
        eq(masterSchema.reachRoutes.externalId, externalId),
        eq(masterSchema.reachRoutes.status, 'active'),
      ),
    )
    .limit(1);
  return route ?? null;
}

async function emit(
  deps: WebhookDeps,
  clerkOrgId: string,
  entityType: Extract<EntityType, 'reach_mailbox' | 'reach_domain'>,
  action: 'updated' | 'suspended',
  entityId: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await publishEntityEventRaw({
      env: deps.env,
      workspaceId: clerkOrgId,
      userId: 'mailpool',
      entityType,
      action,
      entityId,
      data,
      source: 'system',
    });
  } catch (err) {
    console.warn('[reach-webhook] entity event failed:', err);
  }
}

async function updateMailbox(db: Database, id: string, patch: Partial<typeof schema.reachMailboxes.$inferInsert>, now: Date) {
  const [row] = await db
    .update(schema.reachMailboxes)
    .set({ ...patch, updatedAt: now })
    .where(eq(schema.reachMailboxes.id, id))
    .returning();
  return row;
}

async function onMailboxUpdated(deps: WebhookDeps, data: Record<string, unknown>): Promise<WebhookOutcome> {
  const mailpoolId = mailpoolIdOf(data);
  if (!mailpoolId) return ignored('no_id');
  const route = await findRoute(deps, 'mailpool_mailbox', mailpoolId);
  if (!route) return ignored('unknown_id');

  const db = await deps.openTenant(route.clerkOrgId);
  const [mailbox] = await db.select().from(schema.reachMailboxes).where(eq(schema.reachMailboxes.id, route.tenantEntityId)).limit(1);
  if (!mailbox || mailbox.status === 'deleting' || mailbox.status === 'deleted') return ignored('mailbox_gone');

  const now = deps.now ? deps.now() : new Date();
  const remote = remoteStatusOf(data);
  const remoteMailbox = data as unknown as MailpoolMailbox;

  if (remote === 'inactive') {
    const { code, message } = errorOf(data);
    const status = code !== null && CONFIGURATION_ERROR_CODES.has(code) ? 'error' : 'suspended';
    const reason = message ?? (status === 'error' ? 'The mailbox provider reported a problem with this mailbox.' : 'Suspended by the mailbox provider.');
    if (mailbox.status === status && mailbox.lastError === reason) return { handled: true, changed: false };

    const updated = await updateMailbox(db, mailbox.id, { status, pausedReason: status === 'suspended' ? reason : null, lastError: reason }, now);
    // Both mean "needs attention": the platform and workflows hear it as a suspension.
    if (updated) await emit(deps, route.clerkOrgId, 'reach_mailbox', 'suspended', updated.id, omitSensitive('reach_mailboxes', updated));
    return { handled: true, changed: true };
  }

  if (remote === 'active') {
    if (mailbox.status === 'provisioning') {
      const warmed = await beginWarming(
        {
          db,
          mailpool: deps.mailpool,
          env: deps.env,
          now,
          lookup: deps.mailpool ? searchWarmupLookup(deps.mailpool) : { find: async () => null },
        },
        mailbox,
        remoteMailbox,
      );
      await emit(deps, route.clerkOrgId, 'reach_mailbox', 'updated', warmed.id, omitSensitive('reach_mailboxes', warmed));
      return { handled: true, changed: true };
    }

    if (mailbox.status === 'suspended' || mailbox.status === 'error') {
      const restored = await updateMailbox(db, mailbox.id, { status: resumeStatusFor(mailbox), pausedReason: null, lastError: null }, now);
      if (restored) await emit(deps, route.clerkOrgId, 'reach_mailbox', 'updated', restored.id, omitSensitive('reach_mailboxes', restored));
      return { handled: true, changed: true };
    }

    // Logins that were not ready at create time arrive with a later update.
    if (!mailbox.smtpCredentials) return fillCredentials(deps, db, mailbox, remoteMailbox, now);
  }

  return { handled: true, changed: false };
}

async function fillCredentials(
  deps: WebhookDeps,
  db: Database,
  mailbox: MailboxRow,
  remote: MailpoolMailbox,
  now: Date,
): Promise<WebhookOutcome> {
  const smtp = smtpCredentialsOf(remote);
  if (!smtp) return { handled: true, changed: false };
  const imap = imapCredentialsOf(remote);
  await updateMailbox(
    db,
    mailbox.id,
    {
      smtpCredentials: await sealMailServerCredentials(deps.env, smtp),
      ...(imap ? { imapCredentials: await sealMailServerCredentials(deps.env, imap) } : {}),
    },
    now,
  );
  return { handled: true, changed: true };
}

async function onMailboxDeleted(deps: WebhookDeps, data: Record<string, unknown>): Promise<WebhookOutcome> {
  const mailpoolId = mailpoolIdOf(data);
  if (!mailpoolId) return ignored('no_id');
  const route = await findRoute(deps, 'mailpool_mailbox', mailpoolId);
  if (!route) return ignored('unknown_id');

  const db = await deps.openTenant(route.clerkOrgId);
  const [mailbox] = await db.select().from(schema.reachMailboxes).where(eq(schema.reachMailboxes.id, route.tenantEntityId)).limit(1);
  // Our own delete: the row is already deleting / deleted.
  if (!mailbox || mailbox.status === 'deleting' || mailbox.status === 'deleted') return ignored('mailbox_gone');

  const now = deps.now ? deps.now() : new Date();
  const updated = await updateMailbox(
    db,
    mailbox.id,
    { status: 'error', pausedReason: null, lastError: 'The mailbox was deleted at the mailbox provider. Delete it here to stop billing.' },
    now,
  );
  if (updated) await emit(deps, route.clerkOrgId, 'reach_mailbox', 'suspended', updated.id, omitSensitive('reach_mailboxes', updated));
  return { handled: true, changed: true };
}

const DOMAIN_PAUSE_REASON = 'domain_error';

async function onDomainUpdated(deps: WebhookDeps, data: Record<string, unknown>): Promise<WebhookOutcome> {
  const mailpoolId = mailpoolIdOf(data);
  if (!mailpoolId) return ignored('no_id');
  const route = await findRoute(deps, 'mailpool_domain', mailpoolId);
  if (!route) return ignored('unknown_id');

  const db = await deps.openTenant(route.clerkOrgId);
  const [domain] = await db.select().from(schema.reachDomains).where(eq(schema.reachDomains.id, route.tenantEntityId)).limit(1);
  if (!domain || domain.status === 'disconnecting') return ignored('domain_gone');

  const remote = remoteStatusOf(data);
  if (!remote) return { handled: true, changed: false };

  const now = deps.now ? deps.now() : new Date();
  const { message } = errorOf(data);
  const status: DomainRow['status'] = remote === 'active' ? 'active' : remote === 'pending' ? 'connecting' : 'error';
  const lastError = remote === 'inactive' ? (message ?? 'The mailbox provider disabled this domain.') : null;
  if (status === domain.status && lastError === domain.lastError) return { handled: true, changed: false };

  const [updated] = await db
    .update(schema.reachDomains)
    .set({ status, lastError, updatedAt: now })
    .where(eq(schema.reachDomains.id, domain.id))
    .returning();
  if (updated) await emit(deps, route.clerkOrgId, 'reach_domain', 'updated', updated.id, { ...updated });

  if (status === 'error') await pauseDomainMailboxes(deps, db, route.clerkOrgId, domain.id, now);
  else if (status === 'active' && domain.status === 'error') await resumeDomainMailboxes(deps, db, route.clerkOrgId, domain.id, now);
  return { handled: true, changed: true };
}

/** A domain Mailpool disabled cannot send: park its mailboxes until it is back. */
async function pauseDomainMailboxes(deps: WebhookDeps, db: Database, clerkOrgId: string, domainId: string, now: Date): Promise<void> {
  const live = await db
    .select({ id: schema.reachMailboxes.id })
    .from(schema.reachMailboxes)
    .where(
      and(
        eq(schema.reachMailboxes.domainId, domainId),
        isNull(schema.reachMailboxes.deletedAt),
        inArray(schema.reachMailboxes.status, ['warming', 'active']),
      ),
    );
  for (const { id } of live) {
    const paused = await updateMailbox(db, id, { status: 'paused', pausedReason: DOMAIN_PAUSE_REASON }, now);
    if (paused) await emit(deps, clerkOrgId, 'reach_mailbox', 'updated', id, omitSensitive('reach_mailboxes', paused));
  }
}

async function resumeDomainMailboxes(deps: WebhookDeps, db: Database, clerkOrgId: string, domainId: string, now: Date): Promise<void> {
  const parked = await db
    .select()
    .from(schema.reachMailboxes)
    .where(
      and(
        eq(schema.reachMailboxes.domainId, domainId),
        eq(schema.reachMailboxes.status, 'paused'),
        eq(schema.reachMailboxes.pausedReason, DOMAIN_PAUSE_REASON),
      ),
    );
  for (const mailbox of parked) {
    const resumed = await updateMailbox(db, mailbox.id, { status: resumeStatusFor(mailbox), pausedReason: null }, now);
    if (resumed) await emit(deps, clerkOrgId, 'reach_mailbox', 'updated', mailbox.id, omitSensitive('reach_mailboxes', resumed));
  }
}
