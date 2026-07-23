/**
 * Help center settings routes — /api/helpcenter-settings/* surface.
 * Singleton config in `helpcenterSettings`; custom domains in `helpcenterDomains`.
 * Domain registration/verification also updates the master `helpcenterDomainRegistry`.
 *
 * Permissions: settings:read | settings:create | settings:update | settings:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { getMasterDb, masterSchema, schema } from '../../db';
import { createDnsRecordInZone, deleteDnsRecordInZone, CloudflareZoneError } from '../../lib/cloudflare-zones';
import { addHelpcenterDomain, removeHelpcenterDomain, isVercelConfigured, VercelError, VERCEL_CNAME_TARGET } from '../../lib/vercel';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Where a custom help-center domain's CNAME must point. The helpcenter app runs
 * on Vercel, so custom hostnames CNAME to Vercel's edge (`cname.vercel-dns.com`)
 * AND must be registered on the Vercel project (see lib/vercel.ts) for routing +
 * TLS. The `{slug}.welddesk.org` default subdomain is served by a wildcard domain
 * configured once on the Vercel project.
 */
const HELPCENTER_CNAME_TARGET = VERCEL_CNAME_TARGET;

/**
 * Confirm a CNAME actually resolves to our help-center target using
 * Cloudflare's public DNS-over-HTTPS resolver. No extra bindings required.
 * Records we create are unproxied, so the CNAME is publicly visible.
 */
async function cnameResolvesToTarget(domain: string, target: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=CNAME`,
      { headers: { accept: 'application/dns-json' } },
    );
    if (!res.ok) return false;
    const body = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
    const normalized = target.replace(/\.$/, '').toLowerCase();
    return (body.Answer ?? []).some(
      (a) => a.type === 5 && a.data.replace(/\.$/, '').toLowerCase() === normalized,
    );
  } catch {
    return false;
  }
}

// ============================================================================
// Schemas
// ============================================================================

const updateSettingsSchema = z.object({
  siteName: z.string().max(255).optional().nullable(),
  logo: z.string().max(500).optional().nullable(),
  logoDark: z.string().max(500).optional().nullable(),
  favicon: z.string().max(500).optional().nullable(),
  primaryColor: z.string().max(20).optional().nullable(),
  accentColor: z.string().max(20).optional().nullable(),
  heroTitle: z.string().optional().nullable(),
  heroSubtitle: z.string().optional().nullable(),
  showSearch: z.number().min(0).max(1).optional(),
  showCategories: z.number().min(0).max(1).optional(),
  metaTitle: z.string().max(255).optional().nullable(),
  metaDescription: z.string().optional().nullable(),
  ogImage: z.string().max(500).optional().nullable(),
  footerText: z.string().optional().nullable(),
  socialLinks: z.record(z.string()).optional().nullable(),
  customCss: z.string().optional().nullable(),
  googleAnalyticsId: z.string().max(50).optional().nullable(),
});

// Custom domains must be owned in WeldHost first. The caller picks a WeldHost
// domain (`hostDomainId`) and a `subdomain` label; we create the CNAME in its
// Cloudflare zone. There is no manual / unmanaged-domain path.
const addDomainSchema = z.object({
  hostDomainId: z.string().min(1),
  subdomain: z
    .string()
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i, 'Invalid subdomain label')
    .optional(),
});

// ============================================================================
// GET / — fetch helpcenter settings (with default fallback)
// ============================================================================

app.get('/', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const { helpcenterSettings } = schema;
  try {
    const [settings] = await db
      .select()
      .from(helpcenterSettings)
      .where(isNull(helpcenterSettings.deletedAt))
      .orderBy(asc(helpcenterSettings.createdAt), asc(helpcenterSettings.id))
      .limit(1);
    if (!settings) {
      return success(c, {
        isEnabled: 0,
        siteName: null,
        logo: null,
        logoDark: null,
        favicon: null,
        primaryColor: null,
        accentColor: null,
        heroTitle: null,
        heroSubtitle: null,
        showSearch: 1,
        showCategories: 1,
        metaTitle: null,
        metaDescription: null,
        ogImage: null,
        footerText: null,
        socialLinks: null,
        customCss: null,
        googleAnalyticsId: null,
        defaultSubdomain: null,
        customDomain: null,
      });
    }
    return success(c, settings);
  } catch (err) {
    console.error('[app-api/helpcenter-settings] get failed:', err);
    return error.internal(c, 'Failed to fetch helpcenter settings');
  }
});

// ============================================================================
// PUT / — upsert helpcenter settings
// ============================================================================

app.put('/', requirePermission('settings:update'), zValidator('json', updateSettingsSchema), async (c) => {
  const db = c.get('tenantDb');
  const { helpcenterSettings } = schema;
  const data = c.req.valid('json');
  try {
    const [existing] = await db.select({ id: helpcenterSettings.id }).from(helpcenterSettings).where(isNull(helpcenterSettings.deletedAt)).orderBy(asc(helpcenterSettings.createdAt), asc(helpcenterSettings.id)).limit(1);
    if (existing) {
      await db.update(helpcenterSettings).set({ ...data, updatedAt: new Date() }).where(eq(helpcenterSettings.id, existing.id));
      publishEntityEvent({ c, entityType: 'helpcenter_settings', entityId: existing.id, action: 'updated', data: { id: existing.id, ...data } });
      const [updated] = await db.select().from(helpcenterSettings).where(eq(helpcenterSettings.id, existing.id)).limit(1);
      return success(c, updated);
    } else {
      const id = generateId('hcs');
      await db.insert(helpcenterSettings).values({ id, ...data, updatedAt: new Date() } as unknown as typeof helpcenterSettings.$inferInsert);
      publishEntityEvent({ c, entityType: 'helpcenter_settings', entityId: id, action: 'updated', data: { id, ...data } });
      const [created] = await db.select().from(helpcenterSettings).where(eq(helpcenterSettings.id, id)).limit(1);
      return success(c, created, 201);
    }
  } catch (err) {
    console.error('[app-api/helpcenter-settings] update failed:', err);
    return error.internal(c, 'Failed to update helpcenter settings');
  }
});

// ============================================================================
// POST /enable — enable help center + auto-register subdomain
// ============================================================================

app.post('/enable', requirePermission('settings:update'), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  const { helpcenterSettings } = schema;
  try {
    const masterDb = getMasterDb(c.env);
    const [workspace] = await masterDb
      .select({ id: masterSchema.workspaces.id, slug: masterSchema.workspaces.slug })
      .from(masterSchema.workspaces)
      .where(eq(masterSchema.workspaces.clerkOrgId, orgId!))
      .limit(1);
    if (!workspace) return error.notFound(c, 'Workspace');

    const fullDomain = `${workspace.slug}.welddesk.org`;

    const [existingDomain] = await masterDb
      .select({ id: masterSchema.helpcenterDomainRegistry.id, workspaceId: masterSchema.helpcenterDomainRegistry.workspaceId })
      .from(masterSchema.helpcenterDomainRegistry)
      .where(eq(masterSchema.helpcenterDomainRegistry.domain, fullDomain))
      .limit(1);

    if (existingDomain && existingDomain.workspaceId !== workspace.id) {
      return error.conflict(c, 'This subdomain is already taken');
    }

    if (existingDomain) {
      await masterDb
        .update(masterSchema.helpcenterDomainRegistry)
        .set({ isActive: 1, updatedAt: new Date() })
        .where(eq(masterSchema.helpcenterDomainRegistry.id, existingDomain.id));
    } else {
      await masterDb.insert(masterSchema.helpcenterDomainRegistry).values({
        id: generateId('hcreg'),
        domain: fullDomain,
        domainType: 'subdomain',
        workspaceId: workspace.id,
        isVerified: 1,
        isActive: 1,
        verifiedAt: new Date(),
      } as unknown as typeof masterSchema.helpcenterDomainRegistry.$inferInsert);
    }

    const [existing] = await db.select({ id: helpcenterSettings.id }).from(helpcenterSettings).where(isNull(helpcenterSettings.deletedAt)).orderBy(asc(helpcenterSettings.createdAt), asc(helpcenterSettings.id)).limit(1);
    if (existing) {
      await db.update(helpcenterSettings).set({ isEnabled: 1, defaultSubdomain: fullDomain, updatedAt: new Date() }).where(eq(helpcenterSettings.id, existing.id));
      publishEntityEvent({ c, entityType: 'helpcenter_settings', entityId: existing.id, action: 'updated', data: { id: existing.id, isEnabled: 1 } });
    } else {
      const id = generateId('hcs');
      await db.insert(helpcenterSettings).values({
        id,
        isEnabled: 1,
        defaultSubdomain: fullDomain,
        heroTitle: 'How can we help?',
        heroSubtitle: 'Search our knowledge base or browse categories below.',
        updatedAt: new Date(),
      } as unknown as typeof helpcenterSettings.$inferInsert);
      publishEntityEvent({ c, entityType: 'helpcenter_settings', entityId: id, action: 'updated', data: { id, isEnabled: 1 } });
    }

    return success(c, { domain: fullDomain, slug: workspace.slug, enabled: true }, 201);
  } catch (err) {
    console.error('[app-api/helpcenter-settings] enable failed:', err);
    return error.internal(c, 'Failed to enable helpcenter');
  }
});

// ============================================================================
// GET /domains — list tenant helpcenter domains
// ============================================================================

app.get('/domains', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const { helpcenterDomains } = schema;
  try {
    const domains = await db.select().from(helpcenterDomains).where(isNull(helpcenterDomains.deletedAt));
    return success(c, domains);
  } catch (err) {
    console.error('[app-api/helpcenter-settings] list domains failed:', err);
    return error.internal(c, 'Failed to list helpcenter domains');
  }
});

// ============================================================================
// GET /host-domains — WeldHost domains eligible for one-click attach
// ============================================================================

app.get('/host-domains', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const { hostDomains, hostDnsZones } = schema;
  try {
    const rows = await db
      .select({
        id: hostDomains.id,
        fullDomain: hostDomains.fullDomain,
        status: hostDomains.status,
        zoneId: hostDnsZones.externalZoneId,
        zoneProvider: hostDnsZones.provider,
      })
      .from(hostDomains)
      .leftJoin(hostDnsZones, eq(hostDnsZones.domainId, hostDomains.id))
      .where(isNull(hostDomains.deletedAt));

    // Only domains that are active AND have a Cloudflare zone can be provisioned
    // automatically (we need a zone we can write the CNAME into).
    const eligible = rows
      .filter((r) => r.status === 'active' && r.zoneProvider === 'cloudflare' && !!r.zoneId)
      .map((r) => ({ id: r.id, fullDomain: r.fullDomain, hasZone: true }));
    return success(c, eligible);
  } catch (err) {
    console.error('[app-api/helpcenter-settings] list host domains failed:', err);
    return error.internal(c, 'Failed to list WeldHost domains');
  }
});

// ============================================================================
// POST /domains — attach a custom domain
//   WeldHost one-click: { hostDomainId, subdomain? } → creates the CNAME for you
//   Manual:            { domain }                    → pending until DNS verifies
// ============================================================================

app.post('/domains', requirePermission('settings:create'), zValidator('json', addDomainSchema), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  const { helpcenterDomains, helpcenterSettings, hostDomains, hostDnsZones } = schema;
  const input = c.req.valid('json');
  try {
    const masterDb = getMasterDb(c.env);
    const [workspace] = await masterDb
      .select({ id: masterSchema.workspaces.id })
      .from(masterSchema.workspaces)
      .where(eq(masterSchema.workspaces.clerkOrgId, orgId!))
      .limit(1);
    if (!workspace) return error.notFound(c, 'Workspace');

    const [settings] = await db.select({ id: helpcenterSettings.id }).from(helpcenterSettings).where(isNull(helpcenterSettings.deletedAt)).orderBy(asc(helpcenterSettings.createdAt), asc(helpcenterSettings.id)).limit(1);
    if (!settings) return c.json({ error: { code: 'BAD_REQUEST', message: 'Help center must be enabled first' } }, 400);

    // ── Resolve the WeldHost domain + the Cloudflare zone to write the CNAME into ──
    const [host] = await db
      .select({
        id: hostDomains.id,
        fullDomain: hostDomains.fullDomain,
        status: hostDomains.status,
        zoneId: hostDnsZones.externalZoneId,
        zoneProvider: hostDnsZones.provider,
      })
      .from(hostDomains)
      .leftJoin(hostDnsZones, eq(hostDnsZones.domainId, hostDomains.id))
      .where(and(eq(hostDomains.id, input.hostDomainId), isNull(hostDomains.deletedAt)))
      .limit(1);
    if (!host) return error.notFound(c, 'WeldHost domain', input.hostDomainId);
    if (host.status !== 'active') return c.json({ error: { code: 'BAD_REQUEST', message: 'Domain is not active yet' } }, 400);
    if (host.zoneProvider !== 'cloudflare' || !host.zoneId) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'This domain has no Cloudflare DNS zone WeldSuite can manage' } }, 400);
    }
    const subdomainLabel = (input.subdomain ?? 'help').toLowerCase();
    const rootDomain = host.fullDomain;
    const domain = `${subdomainLabel}.${host.fullDomain}`;
    const zoneId = host.zoneId;

    const [existingMaster] = await masterDb
      .select({ id: masterSchema.helpcenterDomainRegistry.id })
      .from(masterSchema.helpcenterDomainRegistry)
      .where(eq(masterSchema.helpcenterDomainRegistry.domain, domain))
      .limit(1);
    if (existingMaster) return error.conflict(c, 'This domain is already registered');

    const apiToken = c.env.CLOUDFLARE_API_TOKEN;
    if (!apiToken) return error.internal(c, 'Cloudflare is not configured');
    if (!isVercelConfigured(c.env)) return error.internal(c, 'Help center hosting (Vercel) is not configured');

    // ── 1. Register the hostname on the Vercel project (so it routes + gets TLS) ──
    try {
      await addHelpcenterDomain(c.env, domain);
    } catch (vErr) {
      const msg = vErr instanceof VercelError ? vErr.message : 'Failed to register domain with the help center host';
      console.error('[app-api/helpcenter-settings] Vercel add-domain failed:', vErr);
      return c.json({ error: { code: 'HOST_PROVISION_FAILED', message: msg } }, 502);
    }

    // ── 2. Create the CNAME in the WeldHost Cloudflare zone → Vercel edge ──
    let provisioned = false;
    let cfRecordId: string | null = null;
    try {
      const result = await createDnsRecordInZone(apiToken, zoneId, {
        type: 'CNAME',
        name: domain,
        content: HELPCENTER_CNAME_TARGET,
        comment: 'WeldDesk help center',
      });
      provisioned = result.created || result.duplicate;
      cfRecordId = result.record?.id ?? null;
    } catch (cfErr) {
      // Roll back the Vercel registration so a retry starts clean.
      await removeHelpcenterDomain(c.env, domain).catch(() => {});
      const msg = cfErr instanceof CloudflareZoneError ? cfErr.message : 'Failed to create DNS record';
      console.error('[app-api/helpcenter-settings] CNAME provisioning failed:', cfErr);
      return c.json({ error: { code: 'DNS_PROVISION_FAILED', message: msg } }, 502);
    }

    const verificationToken = `welddesk-verify-${generateId('')}`;
    const domainId = generateId('hcd');
    const now = new Date();

    await db.insert(helpcenterDomains).values({
      id: domainId,
      helpcenterSettingsId: settings.id,
      domain,
      subdomain: subdomainLabel,
      rootDomain,
      domainType: 'custom',
      isPrimary: 0,
      // When we created the record ourselves it's immediately wired up; manual
      // domains stay unverified until the customer points DNS at us.
      isVerified: provisioned ? 1 : 0,
      isActive: provisioned ? 1 : 0,
      verificationMethod: 'dns_cname',
      verificationToken,
      verifiedAt: provisioned ? now : null,
      dnsConfig: [
        { type: 'CNAME', name: domain, value: HELPCENTER_CNAME_TARGET, zoneId: zoneId ?? undefined, recordId: cfRecordId ?? undefined },
      ],
      dnsStatus: provisioned ? 'active' : 'pending',
      sslStatus: provisioned ? 'provisioning' : 'pending',
    } as unknown as typeof helpcenterDomains.$inferInsert);

    await masterDb.insert(masterSchema.helpcenterDomainRegistry).values({
      id: generateId('hcreg'),
      domain,
      domainType: 'custom',
      workspaceId: workspace.id,
      isVerified: provisioned ? 1 : 0,
      isActive: provisioned ? 1 : 0,
      verificationToken,
      verifiedAt: provisioned ? now : null,
    } as unknown as typeof masterSchema.helpcenterDomainRegistry.$inferInsert);

    if (provisioned) {
      await db.update(helpcenterSettings).set({ customDomain: domain, updatedAt: now }).where(eq(helpcenterSettings.id, settings.id));
      publishEntityEvent({ c, entityType: 'helpcenter_settings', entityId: settings.id, action: 'updated', data: { id: settings.id, customDomain: domain } });
    }

    const [created] = await db.select().from(helpcenterDomains).where(eq(helpcenterDomains.id, domainId)).limit(1);
    return success(c, created, 201);
  } catch (err) {
    console.error('[app-api/helpcenter-settings] add domain failed:', err);
    return error.internal(c, 'Failed to add domain');
  }
});

// ============================================================================
// POST /domains/:id/verify — verify DNS
// ============================================================================

app.post('/domains/:id/verify', requirePermission('settings:update'), async (c) => {
  const db = c.get('tenantDb');
  const { helpcenterDomains, helpcenterSettings } = schema;
  const domainId = c.req.param('id');
  try {
    const [domainRecord] = await db
      .select()
      .from(helpcenterDomains)
      .where(and(eq(helpcenterDomains.id, domainId), isNull(helpcenterDomains.deletedAt)))
      .limit(1);
    if (!domainRecord) return error.notFound(c, 'Domain', domainId);

    const now = new Date();
    // Real check: does the domain's CNAME actually point at our helpcenter?
    // (A record we provisioned ourselves usually resolves immediately, but DNS
    // propagation can lag, so a self-provisioned record is treated as verified.)
    const selfProvisioned = Array.isArray(domainRecord.dnsConfig)
      && (domainRecord.dnsConfig as Array<{ recordId?: string }>).some((r) => !!r.recordId);
    const resolved = await cnameResolvesToTarget(domainRecord.domain, HELPCENTER_CNAME_TARGET);
    const verified = resolved || selfProvisioned;

    await db
      .update(helpcenterDomains)
      .set({
        isVerified: verified ? 1 : 0,
        isActive: verified ? 1 : 0,
        verifiedAt: verified ? now : null,
        lastVerificationAttempt: now,
        verificationError: verified ? null : `CNAME for ${domainRecord.domain} does not point to ${HELPCENTER_CNAME_TARGET} yet`,
        dnsStatus: verified ? 'active' : 'pending',
        sslStatus: verified ? 'provisioning' : 'pending',
        updatedAt: now,
      })
      .where(eq(helpcenterDomains.id, domainId));

    try {
      const masterDb = getMasterDb(c.env);
      await masterDb
        .update(masterSchema.helpcenterDomainRegistry)
        .set({ isVerified: verified ? 1 : 0, isActive: verified ? 1 : 0, verifiedAt: verified ? now : null, updatedAt: now })
        .where(eq(masterSchema.helpcenterDomainRegistry.domain, domainRecord.domain));
    } catch { /* registry update non-fatal */ }

    if (verified) {
      await db.update(helpcenterSettings).set({ customDomain: domainRecord.domain, updatedAt: now }).where(eq(helpcenterSettings.id, domainRecord.helpcenterSettingsId));
    }
    return success(c, { verified, domain: domainRecord.domain });
  } catch (err) {
    console.error('[app-api/helpcenter-settings] verify domain failed:', err);
    return error.internal(c, 'Failed to verify domain');
  }
});

// ============================================================================
// DELETE /domains/:id — soft-delete + deactivate in registry
// ============================================================================

app.delete('/domains/:id', requirePermission('settings:delete'), async (c) => {
  const db = c.get('tenantDb');
  const { helpcenterDomains, helpcenterSettings } = schema;
  const domainId = c.req.param('id');
  try {
    const [domainRecord] = await db
      .select()
      .from(helpcenterDomains)
      .where(and(eq(helpcenterDomains.id, domainId), isNull(helpcenterDomains.deletedAt)))
      .limit(1);
    if (!domainRecord) return error.notFound(c, 'Domain', domainId);
    const now = new Date();
    await db.update(helpcenterDomains).set({ deletedAt: now, updatedAt: now }).where(eq(helpcenterDomains.id, domainId));

    // Best-effort: tear down the CNAME we created in the customer's CF zone.
    const dnsEntry = Array.isArray(domainRecord.dnsConfig)
      ? (domainRecord.dnsConfig as Array<{ zoneId?: string; recordId?: string }>).find((r) => r.zoneId && r.recordId)
      : undefined;
    if (dnsEntry?.zoneId && dnsEntry.recordId && c.env.CLOUDFLARE_API_TOKEN) {
      try {
        await deleteDnsRecordInZone(c.env.CLOUDFLARE_API_TOKEN, dnsEntry.zoneId, dnsEntry.recordId);
      } catch (cfErr) {
        console.error('[app-api/helpcenter-settings] CNAME teardown failed:', cfErr);
      }
    }

    // Best-effort: de-register the hostname from the Vercel project.
    if (isVercelConfigured(c.env)) {
      try {
        await removeHelpcenterDomain(c.env, domainRecord.domain);
      } catch (vErr) {
        console.error('[app-api/helpcenter-settings] Vercel remove-domain failed:', vErr);
      }
    }

    try {
      const masterDb = getMasterDb(c.env);
      await masterDb.delete(masterSchema.helpcenterDomainRegistry).where(eq(masterSchema.helpcenterDomainRegistry.domain, domainRecord.domain));
    } catch { /* registry delete non-fatal */ }
    await db.update(helpcenterSettings).set({ customDomain: null, updatedAt: now }).where(eq(helpcenterSettings.customDomain, domainRecord.domain));
    try {
      await c.env.WORKSPACE_CACHE.delete(`hc:${domainRecord.domain}`);
    } catch { /* KV delete non-fatal */ }
    return success(c, { id: domainId });
  } catch (err) {
    console.error('[app-api/helpcenter-settings] delete domain failed:', err);
    return error.internal(c, 'Failed to delete domain');
  }
});

export const helpcenterSettingsRoutes = app;
