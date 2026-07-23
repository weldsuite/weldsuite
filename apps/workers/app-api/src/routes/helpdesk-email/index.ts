/**
 * Helpdesk email routes — /api/helpdesk-email/* surface.
 * Manages inbound/outbound email addresses connected to the helpdesk.
 * Reads from master `mailAccountRegistry` for registry entries and tenant
 * `mailAccounts` for mail-module accounts flagged with helpdeskEnabled.
 *
 * Permissions: settings:read | settings:create | settings:delete.
 * No PATCH /:id — addresses are either connected or disconnected.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull, like, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { getMasterDb, masterSchema, schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================================
// Schemas
// ============================================================================

const connectEmailSchema = z.object({
  email: z.string().email(),
});

// ============================================================================
// GET /addresses — list connected helpdesk email addresses
// ============================================================================

app.get('/addresses', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  const { mailAccounts } = schema;
  try {
    const masterDb = getMasterDb(c.env);
    const registryAddresses = await masterDb
      .select({
        id: masterSchema.mailAccountRegistry.id,
        email: masterSchema.mailAccountRegistry.email,
        accountId: masterSchema.mailAccountRegistry.accountId,
        isActive: masterSchema.mailAccountRegistry.isActive,
        createdAt: masterSchema.mailAccountRegistry.createdAt,
      })
      .from(masterSchema.mailAccountRegistry)
      .where(
        and(
          eq(masterSchema.mailAccountRegistry.workspaceId, orgId!),
          like(masterSchema.mailAccountRegistry.accountId, 'helpdesk_%'),
        ),
      );

    const helpdeskMailAccounts = await db
      .select({ id: mailAccounts.id, email: mailAccounts.email, createdAt: mailAccounts.createdAt })
      .from(mailAccounts)
      .where(
        and(
          eq(mailAccounts.status, 'active'),
          isNull(mailAccounts.deletedAt),
          sql`${mailAccounts.metadata}->>'helpdeskEnabled' = 'true'`,
        ),
      );

    const seen = new Set<string>();
    const addresses: Array<{ id: string; email: string; accountId: string; isActive: boolean; createdAt: Date | null; source: string }> = [];
    for (const reg of registryAddresses) {
      if (!seen.has(reg.email)) {
        seen.add(reg.email);
        addresses.push({ ...reg, source: 'registry' });
      }
    }
    for (const ma of helpdeskMailAccounts) {
      if (!seen.has(ma.email)) {
        seen.add(ma.email);
        addresses.push({ id: ma.id, email: ma.email, accountId: `helpdesk_mail_${ma.id}`, isActive: true, createdAt: ma.createdAt, source: 'mail_account' });
      }
    }

    return success(c, addresses);
  } catch (err) {
    console.error('[app-api/helpdesk-email] list addresses failed:', err);
    return error.internal(c, 'Failed to list email addresses');
  }
});

// ============================================================================
// GET /mail-accounts — list mail accounts available to link
// ============================================================================

app.get('/mail-accounts', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const { mailAccounts } = schema;
  try {
    const accounts = await db
      .select({ id: mailAccounts.id, name: mailAccounts.name, email: mailAccounts.email, displayName: mailAccounts.displayName, provider: mailAccounts.provider, status: mailAccounts.status, metadata: mailAccounts.metadata })
      .from(mailAccounts)
      .where(and(eq(mailAccounts.status, 'active'), isNull(mailAccounts.deletedAt)));
    return success(c, accounts.map((a) => {
      const meta = (a.metadata as Record<string, unknown>) ?? {};
      return { ...a, isLinkedToHelpdesk: meta.helpdeskEnabled === true };
    }));
  } catch (err) {
    console.error('[app-api/helpdesk-email] list mail accounts failed:', err);
    return error.internal(c, 'Failed to list mail accounts');
  }
});

// ============================================================================
// GET /domains — list verified mail domains available for helpdesk
// ============================================================================

app.get('/domains', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const { mailDomains } = schema;
  try {
    const domains = await db
      .select({ id: mailDomains.id, domainName: mailDomains.domainName, dnsStatus: mailDomains.dnsStatus, isActive: mailDomains.isActive })
      .from(mailDomains)
      .where(and(eq(mailDomains.isActive, true), eq(mailDomains.dnsStatus, 'verified'), isNull(mailDomains.deletedAt)));
    return success(c, domains);
  } catch (err) {
    console.error('[app-api/helpdesk-email] list domains failed:', err);
    return error.internal(c, 'Failed to list email domains');
  }
});

// ============================================================================
// POST /addresses — connect an email address to helpdesk
// ============================================================================

app.post('/addresses', requirePermission('settings:create'), zValidator('json', connectEmailSchema), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  const { mailAccounts, mailDomains } = schema;
  const { email } = c.req.valid('json');
  const emailLower = email.toLowerCase();

  try {
    const masterDb = getMasterDb(c.env);

    // Check if this email is already an active mail account flagged for helpdesk
    const [existingMailAccount] = await db
      .select({ id: mailAccounts.id, email: mailAccounts.email, metadata: mailAccounts.metadata })
      .from(mailAccounts)
      .where(and(eq(mailAccounts.email, emailLower), eq(mailAccounts.status, 'active'), isNull(mailAccounts.deletedAt)))
      .limit(1);

    if (existingMailAccount) {
      const meta = (existingMailAccount.metadata as Record<string, unknown>) ?? {};
      if (meta.helpdeskEnabled) return error.conflict(c, `Email "${emailLower}" is already connected to helpdesk.`);
      await db.update(mailAccounts).set({ metadata: { ...meta, helpdeskEnabled: true }, updatedAt: new Date() }).where(eq(mailAccounts.id, existingMailAccount.id));
      // Ensure registry entry
      const [existingReg] = await masterDb.select({ id: masterSchema.mailAccountRegistry.id }).from(masterSchema.mailAccountRegistry).where(eq(masterSchema.mailAccountRegistry.email, emailLower)).limit(1);
      if (!existingReg) {
        const helpdeskAccountId = `helpdesk_${generateId('hd')}`;
        await masterDb.insert(masterSchema.mailAccountRegistry).values({
          id: generateId('mreg'),
          email: emailLower,
          workspaceId: orgId!,
          accountId: helpdeskAccountId,
          isActive: true,
        } as unknown as typeof masterSchema.mailAccountRegistry.$inferInsert);
      }
      publishEntityEvent({ c, entityType: 'helpdesk_email', entityId: existingMailAccount.id, action: 'created', data: { id: existingMailAccount.id, email: emailLower } });
      return success(c, { id: existingMailAccount.id, email: emailLower, accountId: `helpdesk_mail_${existingMailAccount.id}`, isActive: true, source: 'mail_account' }, 201);
    }

    // Check if already registered as helpdesk in master
    const [existingHelpdesk] = await masterDb
      .select({ id: masterSchema.mailAccountRegistry.id })
      .from(masterSchema.mailAccountRegistry)
      .where(and(eq(masterSchema.mailAccountRegistry.email, emailLower), like(masterSchema.mailAccountRegistry.accountId, 'helpdesk_%'), eq(masterSchema.mailAccountRegistry.isActive, true)))
      .limit(1);
    if (existingHelpdesk) return error.conflict(c, `Email "${emailLower}" is already connected to helpdesk.`);

    // Validate domain is verified
    const domain = emailLower.split('@')[1];
    const [verifiedDomain] = await db
      .select({ id: mailDomains.id })
      .from(mailDomains)
      .where(and(eq(mailDomains.domainName, domain), eq(mailDomains.isActive, true), eq(mailDomains.dnsStatus, 'verified'), isNull(mailDomains.deletedAt)))
      .limit(1);
    if (!verifiedDomain) {
      return c.json({ error: { code: 'BAD_REQUEST', message: `Domain "${domain}" is not verified. Please verify it in Mail settings first.` } }, 400);
    }

    const registryId = generateId('mreg');
    const helpdeskAccountId = `helpdesk_${generateId('hd')}`;
    await masterDb.insert(masterSchema.mailAccountRegistry).values({
      id: registryId,
      email: emailLower,
      workspaceId: orgId!,
      accountId: helpdeskAccountId,
      isActive: true,
    } as unknown as typeof masterSchema.mailAccountRegistry.$inferInsert);

    publishEntityEvent({ c, entityType: 'helpdesk_email', entityId: registryId, action: 'created', data: { id: registryId, email: emailLower } });
    return success(c, { id: registryId, email: emailLower, accountId: helpdeskAccountId, isActive: true }, 201);
  } catch (err) {
    console.error('[app-api/helpdesk-email] connect address failed:', err);
    return error.internal(c, 'Failed to connect email address');
  }
});

// ============================================================================
// DELETE /addresses/:id — disconnect an email address
// ============================================================================

app.delete('/addresses/:id', requirePermission('settings:delete'), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  const { mailAccounts } = schema;
  const addressId = c.req.param('id');
  try {
    const masterDb = getMasterDb(c.env);

    // Try helpdesk registry entry first
    const [registryEntry] = await masterDb
      .select({ id: masterSchema.mailAccountRegistry.id, workspaceId: masterSchema.mailAccountRegistry.workspaceId })
      .from(masterSchema.mailAccountRegistry)
      .where(and(eq(masterSchema.mailAccountRegistry.id, addressId), eq(masterSchema.mailAccountRegistry.workspaceId, orgId!), like(masterSchema.mailAccountRegistry.accountId, 'helpdesk_%')))
      .limit(1);
    if (registryEntry) {
      await masterDb.update(masterSchema.mailAccountRegistry).set({ isActive: false, updatedAt: new Date() }).where(eq(masterSchema.mailAccountRegistry.id, addressId));
      publishEntityEvent({ c, entityType: 'helpdesk_email', entityId: addressId, action: 'deleted', data: { id: addressId } });
      return success(c, { id: addressId, isActive: false });
    }

    // Try mail account with helpdeskEnabled flag
    const [mailAccount] = await db
      .select({ id: mailAccounts.id, metadata: mailAccounts.metadata })
      .from(mailAccounts)
      .where(and(eq(mailAccounts.id, addressId), isNull(mailAccounts.deletedAt)))
      .limit(1);
    if (mailAccount) {
      const meta = { ...((mailAccount.metadata as Record<string, unknown>) ?? {}) };
      delete meta.helpdeskEnabled;
      await db.update(mailAccounts).set({ metadata: meta, updatedAt: new Date() }).where(eq(mailAccounts.id, addressId));
      publishEntityEvent({ c, entityType: 'helpdesk_email', entityId: addressId, action: 'deleted', data: { id: addressId } });
      return success(c, { id: addressId, isActive: false });
    }

    return error.notFound(c, 'Email address', addressId);
  } catch (err) {
    console.error('[app-api/helpdesk-email] disconnect address failed:', err);
    return error.internal(c, 'Failed to disconnect email address');
  }
});

export const helpdeskEmailRoutes = app;
