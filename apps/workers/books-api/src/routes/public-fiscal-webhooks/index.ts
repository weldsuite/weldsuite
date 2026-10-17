/**
 * Fiscal provider webhooks (Focus NFe): /public/fiscal-webhooks/:token. No
 * Clerk auth, mounted before the auth middleware in src/index.ts.
 *
 *   POST /:token   a document changed (NF-e, NFS-e, NFS-e Nacional): re-read it from Focus and store it
 *
 * Focus signs nothing: it echoes the `authorization` value it was given when
 * the hook was registered (services/br-fiscal/settings.ts). The token in the
 * path finds the tenant through a KV index, the echoed secret is checked
 * against its stored hash in constant time, and the payload itself is never
 * trusted: it only names the reference, and the status comes from a fresh GET.
 *
 * Unknown tokens answer 404, a wrong secret 401, an unknown reference 200 with
 * nothing done (so Focus does not retry a delivery that can never match). The
 * answer is sent before the document is refreshed. Bodies over 64 KB are refused.
 */

import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { getWorkspaceContextForOrg, schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import { fiscalDocumentEventData, refreshFiscalDocument } from '../../services/br-fiscal/fiscal-documents';
import {
  fiscalHookKvKey,
  timingSafeEqualHex,
  type FiscalHookKvEntry,
} from '../../services/br-fiscal/settings';
import { sha256Hex } from '../../services/w9-requests';

export const FISCAL_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

type PublicContext = Context<{ Bindings: Env; Variables: Variables }>;

export interface PublicFiscalWebhookDeps {
  /** Opens the tenant behind a request. Tests swap this for a pglite database. */
  openTenant(env: Env, orgId: string): Promise<{ db: Database; workspaceId: string; suspended: boolean }>;
  /** Injected by tests; the provider client uses the global fetch otherwise. */
  fetch?: typeof fetch;
}

const defaultDeps: PublicFiscalWebhookDeps = {
  openTenant: async (env, orgId) => {
    const ctx = await getWorkspaceContextForOrg(env, orgId);
    return { db: ctx.db, workspaceId: ctx.id, suspended: ctx.suspended };
  },
};

/** The secret Focus echoes, with an optional "Bearer " prefix removed. */
function echoedSecret(c: PublicContext): string {
  return (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
}

/** Run after the response is sent, or inline where there is no execution context (tests). */
async function afterResponse(c: PublicContext, work: Promise<void>): Promise<void> {
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    await work;
  }
}

export function createPublicFiscalWebhookRoutes(deps: PublicFiscalWebhookDeps = defaultDeps) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Robots-Tag', 'noindex, nofollow');
  });

  // POST /:token
  app.post('/:token', async (c) => {
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > FISCAL_WEBHOOK_MAX_BODY_BYTES) {
      return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'The payload is too large' } }, 413);
    }
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > FISCAL_WEBHOOK_MAX_BODY_BYTES) {
      return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'The payload is too large' } }, 413);
    }

    // Hash first and always, so every token takes the same path to the KV lookup.
    const tokenHash = await sha256Hex(c.req.param('token'));
    const entry = (await c.env.WORKSPACE_CACHE.get(fiscalHookKvKey(tokenHash), 'json')) as FiscalHookKvEntry | null;
    if (!entry?.orgId || !entry.entityId || !entry.secretHash) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
    }
    if (!timingSafeEqualHex(await sha256Hex(echoedSecret(c)), entry.secretHash)) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
    }

    let ref: string | null = null;
    try {
      const body = JSON.parse(text) as { ref?: unknown };
      if (typeof body.ref === 'string' && body.ref !== '') ref = body.ref;
    } catch {
      // Not JSON: nothing to look up.
    }
    if (ref) {
      await afterResponse(c, refreshFromWebhook(c, deps, entry, ref));
    }
    return c.json({ data: { received: true } });
  });

  return app;
}

/** Re-read the document behind `ref` from Focus and publish what changed. Never throws: the delivery is already answered. */
async function refreshFromWebhook(c: PublicContext, deps: PublicFiscalWebhookDeps, entry: FiscalHookKvEntry, ref: string): Promise<void> {
  try {
    const tenant = await deps.openTenant(c.env, entry.orgId);
    if (tenant.suspended) return;
    const [doc] = await tenant.db
      .select()
      .from(schema.fiscalDocuments)
      .where(
        and(
          eq(schema.fiscalDocuments.entityId, entry.entityId),
          eq(schema.fiscalDocuments.provider, 'focus_nfe'),
          eq(schema.fiscalDocuments.providerRef, ref),
          eq(schema.fiscalDocuments.environment, entry.environment),
        ),
      )
      .limit(1);
    if (!doc) return;

    const { document, changed, previousStatus } = await refreshFiscalDocument(tenant.db, c.env, doc, { fetch: deps.fetch });
    if (!changed) return;
    await writeAccountingAudit(c, tenant.db, {
      accountingEntityId: document.entityId,
      entityType: 'fiscal_document',
      entityId: document.id,
      action: 'refreshed',
      changes: { status: { old: previousStatus, new: document.status } },
    });
    await publishEntityEventRaw({
      env: c.env,
      workspaceId: tenant.workspaceId,
      userId: 'fiscal-webhook',
      entityType: 'fiscal_document',
      action: document.status === 'cancelled' ? 'cancelled' : 'updated',
      entityId: document.id,
      data: fiscalDocumentEventData(document),
      source: 'api',
    });
  } catch (err) {
    console.error('[books-api/public-fiscal-webhooks] refresh failed:', err instanceof Error ? err.message : 'unknown error');
  }
}

export const publicFiscalWebhooksRoutes = createPublicFiscalWebhookRoutes();
