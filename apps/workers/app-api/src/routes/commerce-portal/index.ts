/**
 * Staff commerce-portal routes — Clerk + workspace DB.
 *
 * Permissions: companies:read for GETs, companies:update for invite/revoke/settings.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  inviteCommercePortalAccessSchema,
  updateCommercePortalSettingsSchema,
} from '@weldsuite/app-api-client/schemas/commerce-portal';
import type { Env, Variables } from '../../types';
import { error, list, success, cursorPagination } from '../../lib/response';
import { generateId } from '../../lib/id';
import { getMasterDb, masterSchema, schema } from '../../db';
import {
  commercePortalOrigin,
  consumeRateLimit,
  randomOtp,
  randomToken,
  sha256Hex,
  storeChallenge,
  type PortalChallenge,
} from '../../lib/commerce-portal-tokens';
import { sendPortalMagicLinkEmail } from '../../services/commerce-portal-mail';
import { findCompanyParty, loadPortalSettings } from '../../services/commerce-portal';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

async function workspaceSlug(env: Env, workspaceId: string): Promise<string | null> {
  try {
    const masterDb = getMasterDb(env);
    const [row] = await masterDb
      .select({ slug: masterSchema.workspaces.slug })
      .from(masterSchema.workspaces)
      .where(eq(masterSchema.workspaces.id, workspaceId))
      .limit(1);
    return row?.slug ?? null;
  } catch (err) {
    console.warn('[app-api/commerce-portal] workspace slug lookup failed:', err);
    return null;
  }
}

function settingsPayload(
  row: typeof schema.commercePortalSettings.$inferSelect | null,
  extras: { portalUrl: string | null; workspaceSlug: string | null },
) {
  return {
    id: row?.id ?? null,
    isEnabled: row ? row.isEnabled === 1 : false,
    displayName: row?.displayName ?? null,
    logo: row?.logo ?? null,
    primaryColor: row?.primaryColor ?? null,
    accentColor: row?.accentColor ?? null,
    portalUrl: extras.portalUrl,
    workspaceSlug: extras.workspaceSlug,
  };
}

app.get('/settings', requirePermission('companies:read'), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  try {
    const row = await loadPortalSettings(db);
    const slug = workspaceId ? await workspaceSlug(c.env, workspaceId) : null;
    const portalUrl = slug ? `${commercePortalOrigin(c.env)}/${encodeURIComponent(slug)}` : null;
    return success(c, settingsPayload(row, { portalUrl, workspaceSlug: slug }));
  } catch (err) {
    console.error('[app-api/commerce-portal] get settings failed:', err);
    return error.internal(c, 'Failed to load portal settings');
  }
});

app.patch('/settings', requirePermission('companies:update'), zValidator('json', updateCommercePortalSettingsSchema), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const body = c.req.valid('json');
  const now = new Date();
  try {
    let row = await loadPortalSettings(db);
    if (!row) {
      const id = generateId('cps');
      await db.insert(schema.commercePortalSettings).values({
        id,
        createdAt: now,
        updatedAt: now,
        isEnabled: body.isEnabled === undefined ? 0 : body.isEnabled ? 1 : 0,
        displayName: body.displayName ?? undefined,
        logo: body.logo ?? undefined,
        primaryColor: body.primaryColor ?? undefined,
        accentColor: body.accentColor ?? undefined,
      });
      [row] = await db.select().from(schema.commercePortalSettings).where(eq(schema.commercePortalSettings.id, id)).limit(1);
    } else {
      const patch: Record<string, unknown> = { updatedAt: now };
      if (body.isEnabled !== undefined) patch.isEnabled = body.isEnabled ? 1 : 0;
      if (body.displayName !== undefined) patch.displayName = body.displayName;
      if (body.logo !== undefined) patch.logo = body.logo;
      if (body.primaryColor !== undefined) patch.primaryColor = body.primaryColor;
      if (body.accentColor !== undefined) patch.accentColor = body.accentColor;
      await db.update(schema.commercePortalSettings).set(patch).where(eq(schema.commercePortalSettings.id, row.id));
      [row] = await db.select().from(schema.commercePortalSettings).where(eq(schema.commercePortalSettings.id, row.id)).limit(1);
    }
    const slug = workspaceId ? await workspaceSlug(c.env, workspaceId) : null;
    const portalUrl = slug ? `${commercePortalOrigin(c.env)}/${encodeURIComponent(slug)}` : null;
    return success(c, settingsPayload(row ?? null, { portalUrl, workspaceSlug: slug }));
  } catch (err) {
    console.error('[app-api/commerce-portal] patch settings failed:', err);
    return error.internal(c, 'Failed to update portal settings');
  }
});

app.get('/access', requirePermission('companies:read'), async (c) => {
  const db = c.get('tenantDb');
  const companyId = c.req.query('companyId');
  if (!companyId) return error.badRequest(c, 'companyId is required');
  try {
    const rows = await db
      .select()
      .from(schema.commercePortalAccess)
      .where(eq(schema.commercePortalAccess.companyId, companyId))
      .orderBy(desc(schema.commercePortalAccess.updatedAt));
    return list(c, rows, cursorPagination(rows.length, false, null));
  } catch (err) {
    console.error('[app-api/commerce-portal] list access failed:', err);
    return error.internal(c, 'Failed to list portal access');
  }
});

async function issueChallengeAndEmail(opts: {
  env: Env;
  workspaceId: string;
  workspaceSlug: string | null;
  email: string;
  accessIds: string[];
  companyName?: string | null;
}): Promise<void> {
  const allowed = await consumeRateLimit(opts.env, opts.workspaceId, opts.email);
  if (!allowed) return;
  const token = randomToken();
  const otp = randomOtp();
  const challenge: PortalChallenge = {
    tokenHash: await sha256Hex(token),
    otpHash: await sha256Hex(otp),
    email: opts.email.trim().toLowerCase(),
    workspaceId: opts.workspaceId,
    accessIds: opts.accessIds,
    attempts: 0,
  };
  await storeChallenge(opts.env, challenge, opts.email);
  if (opts.workspaceSlug) {
    await sendPortalMagicLinkEmail(opts.env, {
      to: opts.email,
      workspaceSlug: opts.workspaceSlug,
      token,
      otp,
      companyName: opts.companyName,
    });
  }
}

app.post('/access/invite', requirePermission('companies:update'), zValidator('json', inviteCommercePortalAccessSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId');
  const { personId, companyId } = c.req.valid('json');
  const now = new Date();

  try {
    const [person] = await db
      .select()
      .from(schema.people)
      .where(and(eq(schema.people.id, personId), isNull(schema.people.deletedAt)))
      .limit(1);
    if (!person) return error.notFound(c, 'Person', personId);
    const email = person.email?.trim().toLowerCase();
    if (!email) return error.badRequest(c, 'Person must have an email address');

    const [company] = await db
      .select()
      .from(schema.companies)
      .where(and(eq(schema.companies.id, companyId), isNull(schema.companies.deletedAt)))
      .limit(1);
    if (!company) return error.notFound(c, 'Company', companyId);

    const [link] = await db
      .select()
      .from(schema.personCompanies)
      .where(
        and(
          eq(schema.personCompanies.personId, personId),
          eq(schema.personCompanies.companyId, companyId),
        ),
      )
      .limit(1);
    if (!link || link.endedAt) {
      return error.badRequest(c, 'Person is not an active contact at this company');
    }

    const party = await findCompanyParty(db, companyId);
    if (!party) return error.badRequest(c, 'Company has no commercial party record');

    const [existing] = await db
      .select()
      .from(schema.commercePortalAccess)
      .where(
        and(
          eq(schema.commercePortalAccess.personId, personId),
          eq(schema.commercePortalAccess.companyId, companyId),
        ),
      )
      .limit(1);

    let accessId: string;
    if (existing) {
      accessId = existing.id;
      await db
        .update(schema.commercePortalAccess)
        .set({
          email,
          status: existing.status === 'active' ? 'active' : 'invited',
          invitedBy: userId,
          invitedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.commercePortalAccess.id, existing.id));
    } else {
      accessId = generateId('cpa');
      await db.insert(schema.commercePortalAccess).values({
        id: accessId,
        createdAt: now,
        updatedAt: now,
        personId,
        companyId,
        email,
        status: 'invited',
        invitedBy: userId,
        invitedAt: now,
      });
    }

    const slug = workspaceId ? await workspaceSlug(c.env, workspaceId) : null;
    if (workspaceId) {
      await issueChallengeAndEmail({
        env: c.env,
        workspaceId,
        workspaceSlug: slug,
        email,
        accessIds: [accessId],
        companyName: company.displayName,
      });
    }

    const [row] = await db.select().from(schema.commercePortalAccess).where(eq(schema.commercePortalAccess.id, accessId)).limit(1);
    return success(c, row, existing ? 200 : 201);
  } catch (err) {
    console.error('[app-api/commerce-portal] invite failed:', err);
    return error.internal(c, 'Failed to invite portal user');
  }
});

app.post('/access/:id/revoke', requirePermission('companies:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(schema.commercePortalAccess).where(eq(schema.commercePortalAccess.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Portal access', id);
    await db
      .update(schema.commercePortalAccess)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(eq(schema.commercePortalAccess.id, id));
    const [row] = await db.select().from(schema.commercePortalAccess).where(eq(schema.commercePortalAccess.id, id)).limit(1);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/commerce-portal] revoke failed:', err);
    return error.internal(c, 'Failed to revoke portal access');
  }
});

app.post('/access/:id/resend', requirePermission('companies:update'), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(schema.commercePortalAccess).where(eq(schema.commercePortalAccess.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Portal access', id);
    if (existing.status === 'revoked') return error.badRequest(c, 'Access is revoked');
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, existing.companyId)).limit(1);
    const slug = workspaceId ? await workspaceSlug(c.env, workspaceId) : null;
    if (workspaceId) {
      await issueChallengeAndEmail({
        env: c.env,
        workspaceId,
        workspaceSlug: slug,
        email: existing.email,
        accessIds: [existing.id],
        companyName: company?.displayName,
      });
    }
    return success(c, { ok: true });
  } catch (err) {
    console.error('[app-api/commerce-portal] resend failed:', err);
    return error.internal(c, 'Failed to resend invite');
  }
});

export const commercePortalStaffRoutes = app;
