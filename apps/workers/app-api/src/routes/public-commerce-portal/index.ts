/**
 * Public B2B commerce portal — /public/commerce-portal/*
 *
 * UNAUTHENTICATED mount (no Clerk). Tenant is resolved from `?slug=` /
 * `X-Workspace-Slug`. Buyer session is a hashed KV token. Every data query
 * is scoped to the buyer's company party.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray, isNull, like, ne, or, sql } from 'drizzle-orm';
import {
  commercePortalAuthRequestSchema,
  commercePortalAuthVerifySchema,
  commercePortalCreateReturnSchema,
  commercePortalPlaceOrderSchema,
  commercePortalSelectCompanySchema,
} from '@weldsuite/app-api-client/schemas/commerce-portal';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { commercePortalSlugMiddleware } from '../../middleware/commerce-portal-slug';
import { commercePortalAuthMiddleware } from '../../middleware/commerce-portal-auth';
import {
  consumeRateLimit,
  deleteChallenge,
  kvDelete,
  kvGetJson,
  kvPutJson,
  otpKvKey,
  OTP_TTL_SECONDS,
  pickerKvKey,
  randomOtp,
  randomToken,
  sessionKvKey,
  SESSION_TTL_SECONDS,
  sha256Hex,
  storeChallenge,
  type PortalChallenge,
  type PortalPicker,
  type PortalSession,
} from '../../lib/commerce-portal-tokens';
import { sendPortalMagicLinkEmail } from '../../services/commerce-portal-mail';
import { findCompanyParty, isPortalEnabled, loadPortalSettings } from '../../services/commerce-portal';
import { placePortalOrder, PortalOrderError } from '../../services/commerce-portal-orders';
import { loadPortalInvoice, renderPortalInvoiceHtml } from '../../services/commerce-portal-invoices';
import type { Database } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', commercePortalSlugMiddleware());

const GENERIC_AUTH_OK = { ok: true as const };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

async function requireEnabled(db: Database) {
  const settings = await loadPortalSettings(db);
  return isPortalEnabled(settings) ? settings : null;
}

app.get('/config', async (c) => {
  const db = c.get('tenantDb');
  try {
    const settings = await loadPortalSettings(db);
    if (!isPortalEnabled(settings)) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Portal is not enabled' } }, 404);
    }
    return success(c, {
      displayName: settings!.displayName,
      logo: settings!.logo,
      primaryColor: settings!.primaryColor,
      accentColor: settings!.accentColor,
    });
  } catch (err) {
    console.error('[app-api/public-commerce-portal] config failed:', err);
    return error.internal(c, 'Failed to load portal config');
  }
});

app.post('/auth/request', zValidator('json', commercePortalAuthRequestSchema), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const { email: rawEmail } = c.req.valid('json');
  const email = normalizeEmail(rawEmail);
  const slug = c.req.query('slug') || c.req.header('X-Workspace-Slug') || '';

  try {
    const settings = await requireEnabled(db);
    if (!settings || !workspaceId) return success(c, GENERIC_AUTH_OK);

    const emailAllowed = await consumeRateLimit(c.env, workspaceId, `e:${email}`);
    const ipAllowed = await consumeRateLimit(c.env, workspaceId, `ip:${clientIp(c)}`);
    if (!emailAllowed || !ipAllowed) return success(c, GENERIC_AUTH_OK);

    const accessRows = await db
      .select()
      .from(schema.commercePortalAccess)
      .where(
        and(
          eq(schema.commercePortalAccess.email, email),
          inArray(schema.commercePortalAccess.status, ['invited', 'active']),
        ),
      );

    if (accessRows.length === 0) return success(c, GENERIC_AUTH_OK);

    const token = randomToken();
    const otp = randomOtp();
    const challenge: PortalChallenge = {
      tokenHash: await sha256Hex(token),
      otpHash: await sha256Hex(otp),
      email,
      workspaceId,
      accessIds: accessRows.map((r) => r.id),
      attempts: 0,
    };
    await storeChallenge(c.env, challenge, email);

    const [company] = accessRows[0]
      ? await db.select({ displayName: schema.companies.displayName }).from(schema.companies).where(eq(schema.companies.id, accessRows[0].companyId)).limit(1)
      : [null];

    if (slug) {
      await sendPortalMagicLinkEmail(c.env, {
        to: email,
        workspaceSlug: slug,
        token,
        otp,
        companyName: company?.displayName,
      });
    }

    return success(c, GENERIC_AUTH_OK);
  } catch (err) {
    console.error('[app-api/public-commerce-portal] auth request failed:', err);
    return success(c, GENERIC_AUTH_OK);
  }
});

async function mintSession(
  env: Env,
  session: PortalSession,
): Promise<string> {
  const token = randomToken();
  const hash = await sha256Hex(token);
  await kvPutJson(env, sessionKvKey(hash), session, SESSION_TTL_SECONDS);
  return token;
}

async function accessToSession(
  db: Database,
  workspaceId: string,
  access: typeof schema.commercePortalAccess.$inferSelect,
): Promise<PortalSession | null> {
  const party = await findCompanyParty(db, access.companyId);
  if (!party) return null;
  return {
    workspaceId,
    personId: access.personId,
    companyId: access.companyId,
    partyId: party.id,
    accessId: access.id,
    email: access.email,
  };
}

async function activateAccess(db: Database, accessId: string) {
  await db
    .update(schema.commercePortalAccess)
    .set({ status: 'active', lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.commercePortalAccess.id, accessId));
}

app.post('/auth/verify', zValidator('json', commercePortalAuthVerifySchema), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const body = c.req.valid('json');
  if (!workspaceId) return error.unauthorized(c, 'Invalid or expired code');

  try {
    const settings = await requireEnabled(db);
    if (!settings) return error.unauthorized(c, 'Invalid or expired code');

    // Challenges are stored per-email. We don't know the email from a token
    // alone, so scan isn't possible — callers send email via the OTP path, and
    // magic-link tokens include the email by looking up... we stored email
    // inside the challenge keyed by email. Magic-link verify therefore needs
    // the email OR we store a reverse index.
    //
    // Reverse index: cportal:tok:{tokenHash} → email. Written alongside the challenge.

    const presented = body.token || body.otp;
    if (!presented) return error.unauthorized(c, 'Invalid or expired code');
    const presentedHash = await sha256Hex(presented);

    let email: string | undefined;
    // Prefer reverse lookup for magic-link tokens.
    const reverse = await kvGetJson<{ email: string }>(c.env, `cportal:tok:${presentedHash}`);
    email = reverse?.email;

    // OTP path: client may retry without email. Scan isn't available; require
    // that request() wrote a reverse index for both token and otp hashes.
    if (!email) {
      const otpReverse = await kvGetJson<{ email: string }>(c.env, `cportal:otpidx:${presentedHash}`);
      email = otpReverse?.email;
    }
    if (!email) return error.unauthorized(c, 'Invalid or expired code');

    const challenge = await kvGetJson<PortalChallenge>(c.env, otpKvKey(workspaceId, email));
    if (!challenge) return error.unauthorized(c, 'Invalid or expired code');
    if (challenge.attempts >= 8) {
      await kvDelete(c.env, otpKvKey(workspaceId, email));
      return error.unauthorized(c, 'Invalid or expired code');
    }

    const tokenOk = body.token && challenge.tokenHash === presentedHash;
    const otpOk = body.otp && challenge.otpHash === presentedHash;
    if (!tokenOk && !otpOk) {
      await kvPutJson(c.env, otpKvKey(workspaceId, email), { ...challenge, attempts: challenge.attempts + 1 }, OTP_TTL_SECONDS);
      return error.unauthorized(c, 'Invalid or expired code');
    }

    const accessRows = await db
      .select()
      .from(schema.commercePortalAccess)
      .where(
        and(
          inArray(schema.commercePortalAccess.id, challenge.accessIds),
          inArray(schema.commercePortalAccess.status, ['invited', 'active']),
        ),
      );

    if (accessRows.length === 0) return error.unauthorized(c, 'Invalid or expired code');

    await deleteChallenge(c.env, challenge);

    if (body.accessId) {
      const chosen = accessRows.find((r) => r.id === body.accessId);
      if (!chosen) return error.badRequest(c, 'Unknown company');
      const session = await accessToSession(db, workspaceId, chosen);
      if (!session) return error.badRequest(c, 'Company has no commercial party record');
      await activateAccess(db, chosen.id);
      const token = await mintSession(c.env, session);
      return success(c, { token, needsCompanyPicker: false, companies: [] });
    }

    if (accessRows.length === 1) {
      const session = await accessToSession(db, workspaceId, accessRows[0]!);
      if (!session) return error.badRequest(c, 'Company has no commercial party record');
      await activateAccess(db, accessRows[0]!.id);
      const token = await mintSession(c.env, session);
      return success(c, { token, needsCompanyPicker: false, companies: [] });
    }

    const pickerToken = randomToken();
    const pickerHash = await sha256Hex(pickerToken);
    const picker: PortalPicker = {
      workspaceId,
      email,
      accessIds: accessRows.map((r) => r.id),
    };
    await kvPutJson(c.env, pickerKvKey(pickerHash), picker, OTP_TTL_SECONDS);

    const companies = await Promise.all(
      accessRows.map(async (row) => {
        const [company] = await db
          .select({ id: schema.companies.id, displayName: schema.companies.displayName })
          .from(schema.companies)
          .where(eq(schema.companies.id, row.companyId))
          .limit(1);
        return { accessId: row.id, companyId: row.companyId, name: company?.displayName ?? row.companyId };
      }),
    );

    return success(c, { token: null, pickerToken, needsCompanyPicker: true, companies });
  } catch (err) {
    console.error('[app-api/public-commerce-portal] auth verify failed:', err);
    return error.internal(c, 'Failed to verify sign-in');
  }
});

app.post('/auth/select-company', zValidator('json', commercePortalSelectCompanySchema), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const { pickerToken, companyId } = c.req.valid('json');
  if (!workspaceId) return error.unauthorized(c, 'Invalid or expired code');

  try {
    const pickerHash = await sha256Hex(pickerToken);
    const picker = await kvGetJson<PortalPicker>(c.env, pickerKvKey(pickerHash));
    if (!picker || picker.workspaceId !== workspaceId) return error.unauthorized(c, 'Invalid or expired code');

    const [access] = await db
      .select()
      .from(schema.commercePortalAccess)
      .where(
        and(
          inArray(schema.commercePortalAccess.id, picker.accessIds),
          eq(schema.commercePortalAccess.companyId, companyId),
          inArray(schema.commercePortalAccess.status, ['invited', 'active']),
        ),
      )
      .limit(1);
    if (!access) return error.badRequest(c, 'Unknown company');

    const session = await accessToSession(db, workspaceId, access);
    if (!session) return error.badRequest(c, 'Company has no commercial party record');
    await activateAccess(db, access.id);
    await kvDelete(c.env, pickerKvKey(pickerHash));
    const token = await mintSession(c.env, session);
    return success(c, { token });
  } catch (err) {
    console.error('[app-api/public-commerce-portal] select company failed:', err);
    return error.internal(c, 'Failed to select company');
  }
});

app.post('/auth/logout', async (c) => {
  const header = c.req.header('Authorization');
  const raw = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined;
  if (raw) {
    const hash = await sha256Hex(raw);
    await kvDelete(c.env, sessionKvKey(hash));
  }
  return noContent(c);
});

const authed = new Hono<{ Bindings: Env; Variables: Variables }>();
authed.use('*', commercePortalAuthMiddleware());

authed.get('/me', async (c) => {
  const db = c.get('tenantDb');
  const personId = c.get('portalPersonId')!;
  const companyId = c.get('portalCompanyId')!;
  const partyId = c.get('portalPartyId')!;
  try {
    const settings = await requireEnabled(db);
    if (!settings) return error.unauthorized(c, 'Portal is not enabled');

    const [[person], [company], [party]] = await Promise.all([
      db.select().from(schema.people).where(eq(schema.people.id, personId)).limit(1),
      db.select().from(schema.companies).where(eq(schema.companies.id, companyId)).limit(1),
      db.select().from(schema.parties).where(eq(schema.parties.id, partyId)).limit(1),
    ]);

    return success(c, {
      person: person
        ? { id: person.id, displayName: person.displayName, email: person.email }
        : { id: personId, displayName: c.get('portalEmail'), email: c.get('portalEmail') },
      company: company
        ? { id: company.id, displayName: company.displayName }
        : { id: companyId, displayName: null },
      party: party
        ? {
            id: party.id,
            paymentTerms: party.paymentTerms,
            creditLimit: party.creditLimit,
            outstandingBalance: party.outstandingBalance,
            currency: party.currency,
            billingAddress: party.billingAddress,
            shippingAddress: party.shippingAddress,
          }
        : null,
    });
  } catch (err) {
    console.error('[app-api/public-commerce-portal] me failed:', err);
    return error.internal(c, 'Failed to load profile');
  }
});

authed.get('/products', async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);
  const t = schema.products;
  try {
    const conditions = [
      isNull(t.deletedAt),
      eq(t.status, 'active'),
      or(eq(t.visibility, 'visible'), isNull(t.visibility)),
    ];
    if (q.search) conditions.push(like(t.name, `%${q.search}%`));
    if (q.cursor) {
      const [cur] = await db.select({ createdAt: t.createdAt, id: t.id }).from(t).where(eq(t.id, q.cursor)).limit(1);
      if (cur?.createdAt) {
        conditions.push(
          sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`,
        );
      }
    }
    const where = and(...conditions);
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(
        and(isNull(t.deletedAt), eq(t.status, 'active'), or(eq(t.visibility, 'visible'), isNull(t.visibility))),
      ),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
    return list(c, data, cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/public-commerce-portal] list products failed:', err);
    return error.internal(c, 'Failed to list products');
  }
});

authed.get('/products/:id', async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db
      .select()
      .from(schema.products)
      .where(
        and(
          eq(schema.products.id, id),
          isNull(schema.products.deletedAt),
          eq(schema.products.status, 'active'),
        ),
      )
      .limit(1);
    if (!row || (row.visibility && row.visibility !== 'visible')) return error.notFound(c, 'Product', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/public-commerce-portal] get product failed:', err);
    return error.internal(c, 'Failed to fetch product');
  }
});

authed.get('/categories', async (c) => {
  const db = c.get('tenantDb');
  try {
    const rows = await db
      .select()
      .from(schema.categories)
      .where(and(isNull(schema.categories.deletedAt), eq(schema.categories.isActive, 1)))
      .orderBy(schema.categories.depth, schema.categories.position, schema.categories.name);
    return list(c, rows, cursorPagination(rows.length, false, null));
  } catch (err) {
    console.error('[app-api/public-commerce-portal] list categories failed:', err);
    return error.internal(c, 'Failed to list categories');
  }
});

authed.get('/orders', async (c) => {
  const db = c.get('tenantDb');
  const partyId = c.get('portalPartyId')!;
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);
  const t = schema.orders;
  try {
    const conditions = [isNull(t.deletedAt), eq(t.counterpartyId, partyId)];
    if (q.cursor) {
      const [cur] = await db.select({ createdAt: t.createdAt, id: t.id }).from(t).where(eq(t.id, q.cursor)).limit(1);
      if (cur?.createdAt) {
        conditions.push(
          sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`,
        );
      }
    }
    const where = and(...conditions);
    const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(and(...filterConditions)),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
    return list(c, data, cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/public-commerce-portal] list orders failed:', err);
    return error.internal(c, 'Failed to list orders');
  }
});

authed.get('/orders/:id', async (c) => {
  const db = c.get('tenantDb');
  const partyId = c.get('portalPartyId')!;
  const id = c.req.param('id');
  try {
    const [order] = await db
      .select()
      .from(schema.orders)
      .where(and(eq(schema.orders.id, id), eq(schema.orders.counterpartyId, partyId), isNull(schema.orders.deletedAt)))
      .limit(1);
    if (!order) return error.notFound(c, 'Order', id);
    const items = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, id)).orderBy(schema.orderItems.id);
    return success(c, { ...order, items });
  } catch (err) {
    console.error('[app-api/public-commerce-portal] get order failed:', err);
    return error.internal(c, 'Failed to fetch order');
  }
});

authed.post('/orders', zValidator('json', commercePortalPlaceOrderSchema), async (c) => {
  const db = c.get('tenantDb');
  const input = c.req.valid('json');
  try {
    const settings = await requireEnabled(db);
    if (!settings) return error.unauthorized(c, 'Portal is not enabled');

    const [person] = await db.select().from(schema.people).where(eq(schema.people.id, c.get('portalPersonId')!)).limit(1);
    const placed = await placePortalOrder(db, {
      personId: c.get('portalPersonId')!,
      companyId: c.get('portalCompanyId')!,
      partyId: c.get('portalPartyId')!,
      personEmail: person?.email ?? c.get('portalEmail'),
      personName: person?.displayName ?? null,
      input,
    });
    publishEntityEvent({
      c,
      entityType: 'commerce_order',
      entityId: placed.order.id,
      action: 'placed',
      data: {
        id: placed.order.id,
        orderNumber: placed.order.orderNumber,
        status: placed.order.status,
        total: placed.order.total,
        currency: placed.order.currency,
        source: placed.order.source,
      },
    });
    return success(c, { ...placed.order, items: placed.items }, 201);
  } catch (err) {
    if (err instanceof PortalOrderError) {
      return c.json({ error: { code: err.status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST', message: err.message } }, err.status);
    }
    console.error('[app-api/public-commerce-portal] place order failed:', err);
    return error.internal(c, 'Failed to place order');
  }
});

authed.get('/invoices', async (c) => {
  const db = c.get('tenantDb');
  const partyId = c.get('portalPartyId')!;
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);
  const t = schema.invoices;
  try {
    const conditions = [isNull(t.deletedAt), eq(t.counterpartyId, partyId), ne(t.status, 'draft')];
    if (q.cursor) {
      const [cur] = await db.select({ createdAt: t.createdAt, id: t.id }).from(t).where(eq(t.id, q.cursor)).limit(1);
      if (cur?.createdAt) {
        conditions.push(
          sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`,
        );
      }
    }
    const where = and(...conditions);
    const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(and(...filterConditions)),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
    return list(c, data, cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/public-commerce-portal] list invoices failed:', err);
    return error.internal(c, 'Failed to list invoices');
  }
});

authed.get('/invoices/:id/pdf', async (c) => {
  const db = c.get('tenantDb');
  const partyId = c.get('portalPartyId')!;
  const id = c.req.param('id');
  try {
    const rendered = await renderPortalInvoiceHtml(db, id, partyId);
    if (!rendered) return error.notFound(c, 'Invoice', id);
    return new Response(rendered.html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `inline; filename="${rendered.filename}"`,
      },
    });
  } catch (err) {
    console.error('[app-api/public-commerce-portal] invoice pdf failed:', err);
    return error.internal(c, 'Failed to generate invoice document');
  }
});

authed.get('/invoices/:id', async (c) => {
  const db = c.get('tenantDb');
  const partyId = c.get('portalPartyId')!;
  const id = c.req.param('id');
  try {
    const invoice = await loadPortalInvoice(db, id, partyId);
    if (!invoice) return error.notFound(c, 'Invoice', id);
    const items = await db
      .select()
      .from(schema.invoiceItems)
      .where(and(eq(schema.invoiceItems.invoiceId, id), isNull(schema.invoiceItems.deletedAt)))
      .orderBy(schema.invoiceItems.sortOrder);
    return success(c, { ...invoice, items });
  } catch (err) {
    console.error('[app-api/public-commerce-portal] get invoice failed:', err);
    return error.internal(c, 'Failed to fetch invoice');
  }
});

authed.get('/return-reasons', async (c) => {
  const db = c.get('tenantDb');
  try {
    const rows = await db
      .select()
      .from(schema.returnReasons)
      .where(isNull(schema.returnReasons.deletedAt))
      .orderBy(schema.returnReasons.displayOrder, schema.returnReasons.label);
    return list(c, rows, cursorPagination(rows.length, false, null));
  } catch (err) {
    console.error('[app-api/public-commerce-portal] list return reasons failed:', err);
    return error.internal(c, 'Failed to list return reasons');
  }
});

authed.get('/returns', async (c) => {
  const db = c.get('tenantDb');
  const partyId = c.get('portalPartyId')!;
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);
  try {
    const companyOrders = await db
      .select({ id: schema.orders.id })
      .from(schema.orders)
      .where(and(eq(schema.orders.counterpartyId, partyId), isNull(schema.orders.deletedAt)));
    const orderIds = companyOrders.map((o) => o.id);
    if (orderIds.length === 0) return list(c, [], cursorPagination(0, false, null));

    const t = schema.returns;
    const conditions = [isNull(t.deletedAt), inArray(t.originalOrderId, orderIds)];
    if (q.cursor) {
      const [cur] = await db.select({ createdAt: t.createdAt, id: t.id }).from(t).where(eq(t.id, q.cursor)).limit(1);
      if (cur?.createdAt) {
        conditions.push(
          sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`,
        );
      }
    }
    const where = and(...conditions);
    const rows = await db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
    return list(c, data, cursorPagination(data.length, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/public-commerce-portal] list returns failed:', err);
    return error.internal(c, 'Failed to list returns');
  }
});

authed.get('/returns/:id', async (c) => {
  const db = c.get('tenantDb');
  const partyId = c.get('portalPartyId')!;
  const id = c.req.param('id');
  try {
    const [ret] = await db
      .select()
      .from(schema.returns)
      .where(and(eq(schema.returns.id, id), isNull(schema.returns.deletedAt)))
      .limit(1);
    if (!ret?.originalOrderId) return error.notFound(c, 'Return', id);
    const [order] = await db
      .select({ id: schema.orders.id })
      .from(schema.orders)
      .where(and(eq(schema.orders.id, ret.originalOrderId), eq(schema.orders.counterpartyId, partyId)))
      .limit(1);
    if (!order) return error.notFound(c, 'Return', id);
    return success(c, ret);
  } catch (err) {
    console.error('[app-api/public-commerce-portal] get return failed:', err);
    return error.internal(c, 'Failed to fetch return');
  }
});

authed.post('/returns', zValidator('json', commercePortalCreateReturnSchema), async (c) => {
  const db = c.get('tenantDb');
  const partyId = c.get('portalPartyId')!;
  const personId = c.get('portalPersonId')!;
  const body = c.req.valid('json');
  try {
    const [order] = await db
      .select()
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.id, body.originalOrderId),
          eq(schema.orders.counterpartyId, partyId),
          isNull(schema.orders.deletedAt),
        ),
      )
      .limit(1);
    if (!order) return error.notFound(c, 'Order', body.originalOrderId);

    const orderItems = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, order.id));
    const allowedQty = new Map<string, number>();
    for (const item of orderItems) {
      const key = item.productId || item.name;
      allowedQty.set(key, (allowedQty.get(key) ?? 0) + item.quantity);
    }
    for (const line of body.items) {
      const key = line.productId || line.productName;
      const max = allowedQty.get(key);
      if (max == null || line.quantity > max) {
        return error.badRequest(c, 'Return items must be a subset of the original order');
      }
    }

    const [person] = await db.select().from(schema.people).where(eq(schema.people.id, personId)).limit(1);
    const id = generateId('ret');
    const now = new Date();
    const returnNumber = `RMA-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    await db.insert(schema.returns).values({
      id,
      createdAt: now,
      updatedAt: now,
      returnNumber,
      status: 'requested',
      originalOrderId: order.id,
      customerId: partyId,
      customerName: person?.displayName ?? order.customerName,
      customerEmail: person?.email ?? order.customerEmail,
      reason: body.reason,
      reasonDetails: body.reasonDetails,
      items: body.items,
      customerNotes: body.customerNotes,
      approvalStatus: 'pending',
    });

    const [created] = await db.select().from(schema.returns).where(eq(schema.returns.id, id)).limit(1);
    publishEntityEvent({
      c,
      entityType: 'return',
      entityId: id,
      action: 'created',
      data: { id, returnNumber, originalOrderId: order.id, status: 'requested' },
    });
    return success(c, created, 201);
  } catch (err) {
    console.error('[app-api/public-commerce-portal] create return failed:', err);
    return error.internal(c, 'Failed to create return');
  }
});

app.route('/', authed);

export const publicCommercePortalRoutes = app;
