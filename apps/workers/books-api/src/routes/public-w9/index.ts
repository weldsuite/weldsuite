/**
 * Public W-9 form for vendors: /public/w9/:token. No Clerk auth: the random
 * token in the path is the credential (see services/w9-requests.ts), mounted
 * before the auth middleware in src/index.ts.
 *
 *   GET  /:token   {payer: {name}, vendor: {displayName}, expiresAt} and nothing else
 *   POST /:token   the W-9: names, federal tax classification, address, TIN type
 *                  and TIN, signature and certification. One use.
 *
 * Unknown, expired, completed and cancelled tokens all answer the same bare
 * 404. Bodies over 10 KB are refused. The TIN is validated, encrypted into the
 * vendor and never echoed or logged; the entity event for the completed
 * request carries no personal data. CORS is the platform's origin list
 * (createModuleApi), no wildcard.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { normalizePostalAddress } from '@weldsuite/books-domain/accounting-address';
import { isUsAddressStateCode } from '@weldsuite/books-domain/jurisdictions/us/states';
import { validateZip } from '@weldsuite/books-domain/jurisdictions/us/identifiers';
import { isCorporationClassification } from '@weldsuite/books-domain/us-compliance/form-1099-compute';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { getWorkspaceContextForOrg, schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import {
  buildVendorTaxChange,
  VendorTaxError,
  VendorTaxKeyError,
  W9_FEDERAL_CLASSIFICATIONS,
} from '../../services/vendor-tax-data';
import { sha256Hex, w9EventData, w9KvKey, type W9KvEntry } from '../../services/w9-requests';

export const W9_MAX_BODY_BYTES = 10 * 1024;

type PublicContext = Context<{ Bindings: Env; Variables: Variables }>;

export interface PublicW9Deps {
  /** Opens the tenant behind a request. Tests swap this for a pglite database. */
  openTenant(env: Env, orgId: string): Promise<{ db: Database; workspaceId: string; suspended: boolean }>;
}

const defaultDeps: PublicW9Deps = {
  openTenant: async (env, orgId) => {
    const ctx = await getWorkspaceContextForOrg(env, orgId);
    return { db: ctx.db, workspaceId: ctx.id, suspended: ctx.suspended };
  },
};

const submissionSchema = z
  .object({
    legalName: z.string().trim().min(1).max(100),
    businessName: z.string().trim().max(100).optional(),
    federalTaxClassification: z.enum(W9_FEDERAL_CLASSIFICATIONS),
    llcTaxClassification: z.enum(['C', 'S', 'P']).optional(),
    exemptPayeeCode: z.string().trim().max(2).optional(),
    fatcaCode: z.string().trim().max(2).optional(),
    address: z.object({
      line1: z.string().trim().min(1).max(100),
      line2: z.string().trim().max(100).optional(),
      city: z.string().trim().min(1).max(60),
      state: z.string().trim().length(2),
      postalCode: z.string().trim().min(5).max(10),
    }),
    tinType: z.enum(['ein', 'ssn', 'itin']),
    tin: z.string().trim().min(9).max(11),
    signedName: z.string().trim().min(2).max(100),
    certify: z.literal(true, { errorMap: () => ({ message: 'You must certify the form' }) }),
  })
  .strict();

const notFound = (c: PublicContext) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
};

interface ResolvedRequest {
  db: Database;
  workspaceId: string;
  hash: string;
  request: typeof schema.w9Requests.$inferSelect;
  party: typeof schema.parties.$inferSelect;
}

export function createPublicW9Routes(deps: PublicW9Deps = defaultDeps) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Robots-Tag', 'noindex, nofollow');
    c.header('Referrer-Policy', 'no-referrer');
  });

  /** The pending, unexpired request behind a token, or null for any other state. */
  async function resolve(c: PublicContext, token: string): Promise<ResolvedRequest | null> {
    // Hash first and always, so every token takes the same path to the KV lookup.
    const hash = await sha256Hex(token);
    const entry = (await c.env.WORKSPACE_CACHE.get(w9KvKey(hash), 'json')) as W9KvEntry | null;
    if (!entry?.orgId || !entry.requestId) return null;

    const tenant = await deps.openTenant(c.env, entry.orgId);
    if (tenant.suspended) return null;
    const [request] = await tenant.db
      .select()
      .from(schema.w9Requests)
      .where(and(eq(schema.w9Requests.id, entry.requestId), eq(schema.w9Requests.tokenHash, hash)))
      .limit(1);
    if (!request || request.status !== 'pending' || request.expiresAt.getTime() <= Date.now()) return null;

    const [party] = await tenant.db
      .select()
      .from(schema.parties)
      .where(and(eq(schema.parties.id, request.partyId), isNull(schema.parties.deletedAt)))
      .limit(1);
    if (!party) return null;
    return { db: tenant.db, workspaceId: tenant.workspaceId, hash, request, party };
  }

  // GET /:token
  app.get('/:token', async (c) => {
    try {
      const resolved = await resolve(c, c.req.param('token'));
      if (!resolved) return notFound(c);
      const { db, request, party } = resolved;
      const [entity] = await db
        .select({ name: schema.entities.name, legalName: schema.entities.legalName })
        .from(schema.entities)
        .where(eq(schema.entities.id, request.entityId))
        .limit(1);
      return c.json({
        data: {
          payer: { name: entity?.legalName ?? entity?.name ?? '' },
          vendor: { displayName: party.displayName ?? '' },
          expiresAt: request.expiresAt.toISOString(),
        },
      });
    } catch (err) {
      console.error('[books-api/public-w9] load failed:', err instanceof Error ? err.message : 'unknown error');
      return notFound(c);
    }
  });

  // POST /:token
  app.post('/:token', async (c) => {
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > W9_MAX_BODY_BYTES) {
      return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'The form is too large' } }, 413);
    }
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > W9_MAX_BODY_BYTES) {
      return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'The form is too large' } }, 413);
    }

    try {
      const resolved = await resolve(c, c.req.param('token'));
      if (!resolved) return notFound(c);
      const { db, workspaceId, hash, request, party } = resolved;

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return c.json({ error: { code: 'BAD_REQUEST', message: 'The form is not valid JSON' } }, 400);
      }
      const parsed = submissionSchema.safeParse(body);
      if (!parsed.success) {
        // Issues carry paths and messages, never the submitted values.
        return c.json({ error: { code: 'BAD_REQUEST', message: 'Check the form', details: parsed.error.flatten() } }, 400);
      }
      const form = parsed.data;

      const state = form.address.state.toUpperCase();
      if (!isUsAddressStateCode(state)) {
        return c.json({ error: { code: 'BAD_REQUEST', message: 'Check the form', details: { fieldErrors: { 'address.state': ['Not a US state code'] } } } }, 400);
      }
      const zip = validateZip(form.address.postalCode);
      if (!zip.valid) {
        return c.json({ error: { code: 'BAD_REQUEST', message: 'Check the form', details: { fieldErrors: { 'address.postalCode': [zip.error ?? 'Not a ZIP code'] } } } }, 400);
      }
      const address = {
        line1: form.address.line1,
        ...(form.address.line2 ? { line2: form.address.line2 } : {}),
        city: form.address.city,
        state,
        postalCode: zip.formatted ?? form.address.postalCode,
        country: 'US',
      };

      const today = new Date().toISOString().slice(0, 10);
      const tax = await buildVendorTaxChange(
        party,
        {
          tinType: form.tinType,
          tin: form.tin,
          w9: {
            legalName: form.legalName,
            businessName: form.businessName,
            federalTaxClassification: form.federalTaxClassification,
            llcTaxClassification: form.llcTaxClassification,
            exemptPayeeCode: form.exemptPayeeCode,
            fatcaCode: form.fatcaCode,
            receivedAt: today,
            signedName: form.signedName,
            source: 'online',
          },
        },
        c.env,
      );

      // A corporation needs no 1099 (attorneys keep theirs): a vendor already flagged stays flagged.
      const corporation = isCorporationClassification(form.federalTaxClassification, form.llcTaxClassification);
      const hasAddress = Boolean(normalizePostalAddress(party.billingAddress)?.line1);
      const now = new Date();

      await atomically(db, (h) => [
        h
          .update(schema.parties)
          .set({
            ...tax.columns,
            is1099Vendor: Boolean(party.is1099Vendor) || !corporation,
            ...(hasAddress ? {} : { billingAddress: address }),
            updatedAt: now,
          })
          .where(eq(schema.parties.id, party.id)),
        h
          .update(schema.w9Requests)
          .set({ status: 'completed', completedAt: now, updatedAt: now })
          .where(and(eq(schema.w9Requests.id, request.id), eq(schema.w9Requests.status, 'pending'))),
      ]);
      await c.env.WORKSPACE_CACHE.delete(w9KvKey(hash));

      await writeAccountingAudit(c, db, {
        accountingEntityId: request.entityId,
        entityType: 'w9_request',
        entityId: request.id,
        action: 'completed',
        changes: { tin: { old: party.tinLast4 ? 'on file' : null, new: 'changed' } },
      });
      const completed = { ...request, status: 'completed', completedAt: now };
      const events = [
        publishEntityEventRaw({
          env: c.env,
          workspaceId,
          userId: 'w9-public',
          entityType: 'w9_request',
          action: 'completed',
          entityId: request.id,
          data: w9EventData(completed),
          source: 'api',
        }),
        publishEntityEventRaw({
          env: c.env,
          workspaceId,
          userId: 'w9-public',
          entityType: 'accounting_contact',
          action: 'updated',
          entityId: party.id,
          data: { id: party.id, w9Received: true },
          source: 'api',
        }),
      ];
      try {
        for (const event of events) c.executionCtx.waitUntil(event);
      } catch {
        await Promise.allSettled(events);
      }

      return c.json({ data: { completed: true } });
    } catch (err) {
      if (err instanceof VendorTaxError) {
        return c.json({ error: { code: 'BAD_REQUEST', message: err.message } }, 400);
      }
      if (err instanceof VendorTaxKeyError) {
        return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'The form cannot be saved right now' } }, 503);
      }
      console.error('[books-api/public-w9] submit failed:', err instanceof Error ? err.message : 'unknown error');
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'The form could not be saved' } }, 500);
    }
  });

  return app;
}

export const publicW9Routes = createPublicW9Routes();
