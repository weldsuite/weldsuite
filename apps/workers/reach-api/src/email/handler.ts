/**
 * `email()` handler: replies, auto-replies and bounces of WeldReach mailboxes.
 *
 * Each Mailpool mailbox forwards its incoming mail to
 * `reply+<inboundToken>@<REACH_INBOUND_DOMAIN>` (reply.weldreach.com); Cloudflare
 * Email Routing's catch-all rule delivers it here. The token in the recipient
 * address resolves through master `reach_routes` to the workspace and the
 * mailbox row; `services/inbound.ts` does the rest.
 *
 * Mailpool forwards *all* incoming mail of a mailbox, and that includes the
 * warmup mail the WeldSuite warmup network sends it. Before the tenant is
 * opened, the message's Message-ID, In-Reply-To and References are looked up in
 * the master `reach_warmup_messages`; a hit is dropped without a trace (no R2
 * copy, no row, no events), so warmup never reaches the reply inbox or stops a
 * campaign. That lookup is best effort: if it fails the message is processed as
 * usual.
 *
 * This handler never rejects or bounces a message. Mail for an unknown token
 * is dropped silently (a bounce would go back to the forwarder and from there
 * to whoever wrote to the prospect's mailbox), and a failure while processing
 * is logged and the raw message parked in R2 for replay instead of surfacing as
 * an SMTP error.
 */

import { and, eq } from 'drizzle-orm';
import { getMasterDb, masterSchema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit';
import { reachMailboxes } from '@weldsuite/db/schema';
import { findWarmupMessageIds } from '@weldsuite/reach-domain/warmup-pool';
import { parseInboundToken } from '../lib/inbound/token';
import { sha256Hex } from '../lib/inbound/message-id';
import { parseInbound } from '../lib/inbound/mime';
import type { ParsedInbound } from '../lib/inbound/types';
import { openTenantDb } from '../lib/tenant';
import { deliverInbound, type DeliverInboundResult, type InboundMailbox } from '../services/inbound';
import type { Env } from '../types';

/** Messages above this size are dropped: replies are text, and Workers memory is limited. */
export const MAX_INBOUND_BYTES = 10 * 1024 * 1024;

export interface InboundRoute {
  clerkOrgId: string;
  mailboxId: string;
}

/** The seams of the handler, replaced in tests. */
export interface InboundHandlerDeps {
  resolveRoute: (env: Env, token: string) => Promise<InboundRoute | null>;
  /** Which of these Message-IDs (no angle brackets) belong to warmup mail. */
  findWarmupIds: (env: Env, messageIds: string[]) => Promise<Set<string>>;
  openDb: (env: Env, clerkOrgId: string) => Promise<Database>;
  deliver: typeof deliverInbound;
}

/** Master lookup: an active `inbound_token` route. */
export async function resolveInboundRoute(env: Env, token: string): Promise<InboundRoute | null> {
  const master = getMasterDb(env);
  const [route] = await master
    .select({ clerkOrgId: masterSchema.reachRoutes.clerkOrgId, mailboxId: masterSchema.reachRoutes.tenantEntityId })
    .from(masterSchema.reachRoutes)
    .where(
      and(
        eq(masterSchema.reachRoutes.kind, 'inbound_token'),
        eq(masterSchema.reachRoutes.externalId, token),
        eq(masterSchema.reachRoutes.status, 'active'),
      ),
    )
    .limit(1);
  return route ?? null;
}

/** Master lookup in `reach_warmup_messages`. */
export async function findInboundWarmupIds(env: Env, messageIds: string[]): Promise<Set<string>> {
  return findWarmupMessageIds(getMasterDb(env), messageIds);
}

const defaultDeps: InboundHandlerDeps = {
  resolveRoute: resolveInboundRoute,
  findWarmupIds: findInboundWarmupIds,
  openDb: openTenantDb,
  deliver: deliverInbound,
};

/** Read a stream into memory, giving up as soon as it passes `maxBytes`. Null when it is too large. */
export async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function loadMailbox(db: Database, mailboxId: string, token: string): Promise<InboundMailbox | null> {
  const [row] = await db
    .select({ id: reachMailboxes.id, email: reachMailboxes.email, deletedAt: reachMailboxes.deletedAt })
    .from(reachMailboxes)
    .where(and(eq(reachMailboxes.id, mailboxId), eq(reachMailboxes.inboundToken, token)))
    .limit(1);
  return row && row.deletedAt === null ? { id: row.id, email: row.email } : null;
}

/** Keep the bytes of a message that could not be processed, so it can be replayed. Best effort. */
async function parkFailed(env: Env, clerkOrgId: string, raw: Uint8Array): Promise<void> {
  if (!env.STORAGE) return;
  try {
    await env.STORAGE.put(`reach/${clerkOrgId}/_failed/${await sha256Hex(raw)}.eml`, raw, {
      httpMetadata: { contentType: 'message/rfc822' },
    });
  } catch (err) {
    console.error('[reach-inbound] could not park the failed message:', err instanceof Error ? err.message : err);
  }
}

/** References beyond this many (newest first) are not looked up: a long list thread is not warmup. */
const MAX_REFERENCE_LOOKUPS = 20;

/** The ids a warmup message can be recognised by: its own, what it answers, and its thread. */
export function threadingIdsOf(parsed: ParsedInbound): string[] {
  const ids = [parsed.messageId, parsed.inReplyTo, ...parsed.references.slice(-MAX_REFERENCE_LOOKUPS)];
  return [...new Set(ids.filter((id): id is string => id !== null && id !== ''))];
}

/**
 * Parse the message once and ask master whether it is warmup mail. Best effort:
 * a message that cannot be parsed here, or a master that cannot answer, is not
 * a reason to lose a real reply, so the result is then "not warmup" and the
 * normal pipeline (which parks what it cannot process) takes over.
 */
async function screenForWarmup(
  raw: Uint8Array,
  env: Env,
  deps: InboundHandlerDeps,
): Promise<{ warmup: boolean; parsed: ParsedInbound | null }> {
  let parsed: ParsedInbound;
  try {
    parsed = await parseInbound(raw);
  } catch (err) {
    console.error('[reach-inbound] warmup screening could not parse the message:', err instanceof Error ? err.message : err);
    return { warmup: false, parsed: null };
  }

  const ids = threadingIdsOf(parsed);
  if (ids.length === 0) return { warmup: false, parsed };
  try {
    return { warmup: (await deps.findWarmupIds(env, ids)).size > 0, parsed };
  } catch (err) {
    console.error('[reach-inbound] warmup lookup failed, processing the message normally:', err instanceof Error ? err.message : err);
    return { warmup: false, parsed };
  }
}

/** Process one forwarded message; the result says what was done (tests and logs). Never throws. */
export async function processInboundEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
  deps: InboundHandlerDeps = defaultDeps,
): Promise<DeliverInboundResult | null> {
  const token = parseInboundToken(message.to, env.REACH_INBOUND_DOMAIN);
  if (!token) {
    console.warn('[reach-inbound] dropped: recipient is not an inbound address');
    return null;
  }
  if (message.rawSize > MAX_INBOUND_BYTES) {
    console.warn(`[reach-inbound] dropped: ${message.rawSize} bytes is over the ${MAX_INBOUND_BYTES} byte cap`);
    return null;
  }

  let route: InboundRoute | null;
  try {
    route = await deps.resolveRoute(env, token);
  } catch (err) {
    console.error('[reach-inbound] route lookup failed:', err instanceof Error ? err.message : err);
    return null;
  }
  if (!route) {
    console.warn('[reach-inbound] dropped: unknown inbound token');
    return null;
  }

  const raw = await readCapped(message.raw, MAX_INBOUND_BYTES);
  if (!raw) {
    console.warn('[reach-inbound] dropped: message is over the size cap');
    return null;
  }

  // Warmup mail is dropped before the tenant is opened: no R2 write, no row, no events.
  const screened = await screenForWarmup(raw, env, deps);
  if (screened.warmup) {
    console.warn('[reach-inbound] dropped: warmup network mail');
    return null;
  }

  try {
    const db = await deps.openDb(env, route.clerkOrgId);
    const mailbox = await loadMailbox(db, route.mailboxId, token);
    if (!mailbox) {
      console.warn('[reach-inbound] dropped: the mailbox of this route no longer exists');
      return null;
    }
    return await deps.deliver({
      env,
      db,
      clerkOrgId: route.clerkOrgId,
      mailbox,
      raw,
      parsed: screened.parsed ?? undefined,
      waitUntil: (promise) => ctx.waitUntil(promise.catch(() => undefined)),
    });
  } catch (err) {
    console.error('[reach-inbound] processing failed:', err instanceof Error ? err.message : err);
    await parkFailed(env, route.clerkOrgId, raw);
    return null;
  }
}

/** The Workers `email()` entry point (wired in `src/index.ts`). */
export async function handleInboundEmail(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
  await processInboundEmail(message, env, ctx);
}
