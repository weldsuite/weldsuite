import { z } from 'zod';

/**
 * Response shapes of /api/helpcenter-settings (desk-api): the help center's
 * singleton settings and its custom domains.
 */

/**
 * A `helpcenter_settings` row. Before the help center was ever saved, GET
 * answers the defaults without the row's own columns (id and timestamps).
 */
export const helpcenterSettingsSchema = z
  .object({
    id: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    deletedAt: z.string().nullable().optional(),
    isEnabled: z.number().nullable(),
    siteName: z.string().nullable(),
    logo: z.string().nullable(),
    logoDark: z.string().nullable(),
    favicon: z.string().nullable(),
    primaryColor: z.string().nullable(),
    accentColor: z.string().nullable(),
    heroTitle: z.string().nullable(),
    heroSubtitle: z.string().nullable(),
    showSearch: z.number().nullable(),
    showCategories: z.number().nullable(),
    portalEnabled: z.number().nullable(),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
    ogImage: z.string().nullable(),
    footerText: z.string().nullable(),
    socialLinks: z.record(z.string()).nullable(),
    customCss: z.string().nullable(),
    googleAnalyticsId: z.string().nullable(),
    defaultSubdomain: z.string().nullable(),
    customDomain: z.string().nullable(),
  })
  .passthrough();

/** POST /enable: the `{slug}.welddesk.org` subdomain the help center now answers on. */
export const helpcenterEnabledSchema = z.object({
  domain: z.string(),
  slug: z.string(),
  enabled: z.literal(true),
});

/** A `helpcenter_domains` row. */
export const helpcenterDomainSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    helpcenterSettingsId: z.string(),
    domain: z.string(),
    subdomain: z.string().nullable(),
    rootDomain: z.string().nullable(),
    domainType: z.string().nullable(),
    isPrimary: z.number().nullable(),
    isVerified: z.number().nullable(),
    isActive: z.number().nullable(),
    verificationMethod: z.string().nullable(),
    verificationToken: z.string().nullable(),
    verifiedAt: z.string().nullable(),
    lastVerificationAttempt: z.string().nullable(),
    verificationError: z.string().nullable(),
    dnsConfig: z.array(z.record(z.unknown())).nullable(),
    dnsStatus: z.string().nullable(),
    sslStatus: z.string().nullable(),
  })
  .passthrough();

/** GET /host-domains: a WeldHost domain with a Cloudflare zone, ready for one-click attach. */
export const helpcenterHostDomainSchema = z.object({
  id: z.string(),
  fullDomain: z.string(),
  hasZone: z.literal(true),
});

/** POST /domains/:id/verify. */
export const helpcenterDomainVerifySchema = z.object({
  verified: z.boolean(),
  domain: z.string(),
});

/** DELETE /domains/:id. */
export const helpcenterDomainRefSchema = z.object({ id: z.string() });
