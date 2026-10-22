/**
 * Enterprise single sign-on (SSO): a workspace signs its members in through its
 * own identity provider with a Clerk SAML connection on a domain it proved it
 * owns (master `workspace_sso`, docs in packages/core/db/src/schema/workspace-sso.ts).
 *
 * Shared by app-api (`/api/sso`, configuration), billing-worker
 * (`/api/billing/sso`, the add-on subscription; `/api/internal/admin/.../sso`,
 * staff pricing), the platform settings page and the admin console.
 *
 * SSO is included in plans whose `features.sso` is true (Enterprise). Every
 * other paid, directly billed workspace can buy it as a flat monthly add-on;
 * staff can set a workspace's price, 0 meaning free.
 */

import { z } from 'zod';

// ============================================================================
// Providers
// ============================================================================

/** Clerk's SAML IdP slugs. Kept equal to `SSO_PROVIDERS` in `@weldsuite/db/schema/workspace-sso`. */
export const SSO_PROVIDER_IDS = ['saml_okta', 'saml_microsoft', 'saml_google', 'saml_custom'] as const;
export type SsoProviderId = (typeof SSO_PROVIDER_IDS)[number];

// ============================================================================
// Add-on price
// ============================================================================

/** The add-on's list price per month, in minor units. */
export const SSO_ADDON_PRICE_CENTS = 10_000;
/** The list price's own currency; `usd` is a currency option for customers billed in dollars. */
export const SSO_ADDON_CURRENCY = 'eur';
export const SSO_ADDON_USD_PRICE_CENTS = 10_000;

/** Currencies a staff price can be set in (the ones customers are billed in). */
export const SSO_PRICE_CURRENCIES = ['eur', 'usd'] as const;
export type SsoPriceCurrency = (typeof SSO_PRICE_CURRENCIES)[number];

/** Highest staff price per month, in minor units (a typo guard, not a business rule). */
export const SSO_MAX_PRICE_CENTS = 10_000_000;

/**
 * The list price for a customer billed in `currency` (the Stripe customer's
 * currency). A customer without a currency yet gets the price's own (EUR).
 */
export function ssoAddonListPrice(currency: string | null | undefined): { unitAmountCents: number; currency: SsoPriceCurrency } {
  return currency?.toLowerCase() === 'usd'
    ? { unitAmountCents: SSO_ADDON_USD_PRICE_CENTS, currency: 'usd' }
    : { unitAmountCents: SSO_ADDON_PRICE_CENTS, currency: SSO_ADDON_CURRENCY };
}

// ============================================================================
// Entitlement
// ============================================================================

/** Why a workspace may use SSO: its plan, a free staff grant, or the paid add-on. */
export const SSO_ENTITLEMENT_SOURCES = ['plan', 'free', 'subscription'] as const;
export type SsoEntitlementSource = (typeof SSO_ENTITLEMENT_SOURCES)[number];

export interface SsoEntitlement {
  entitled: boolean;
  source: SsoEntitlementSource | null;
}

export interface SsoEntitlementInput {
  /** `plans.features.sso` of the workspace's plan. */
  planIncludesSso: boolean;
  /** `workspaces.is_active` (false while an admin deletion is pending) and not deleted. */
  workspaceActive: boolean;
  priceOverrideCents: number | null | undefined;
  /** `workspace_sso.subscription_status`. */
  subscriptionStatus: string | null | undefined;
}

/**
 * Whether the workspace may use SSO right now. A past-due add-on still counts
 * while Stripe retries the payment: a failed card must not lock a company out
 * of signing in. Once Stripe gives up the status becomes `canceled`.
 */
export function resolveSsoEntitlement(input: SsoEntitlementInput): SsoEntitlement {
  if (!input.workspaceActive) return { entitled: false, source: null };
  if (input.planIncludesSso) return { entitled: true, source: 'plan' };
  if (input.priceOverrideCents === 0) return { entitled: true, source: 'free' };
  if (input.subscriptionStatus === 'active' || input.subscriptionStatus === 'past_due') {
    return { entitled: true, source: 'subscription' };
  }
  return { entitled: false, source: null };
}

/** `plans.features.sso`, tolerating a missing or malformed features object. */
export function planIncludesSso(features: Record<string, unknown> | null | undefined): boolean {
  return features?.sso === true;
}

// ============================================================================
// Domain ownership
// ============================================================================

/** The TXT record that proves a workspace owns its domain: `_weldsuite-sso.<domain>`. */
export const SSO_DNS_RECORD_PREFIX = '_weldsuite-sso';
const SSO_DNS_VALUE_PREFIX = 'weldsuite-sso-verification=';

export function ssoDnsRecordName(domain: string): string {
  return `${SSO_DNS_RECORD_PREFIX}.${domain}`;
}

export function ssoDnsRecordValue(token: string): string {
  return `${SSO_DNS_VALUE_PREFIX}${token}`;
}

/** Whether any of the TXT values found is the expected one (whitespace and quotes tolerated). */
export function ssoDnsRecordMatches(values: readonly string[], token: string): boolean {
  const expected = ssoDnsRecordValue(token);
  return values.some((value) => value.replace(/^"|"$/g, '').trim() === expected);
}

const HOSTNAME_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * A domain as typed by a person ("Acme.com", "https://acme.com/", "@acme.com",
 * "jane@acme.com") to its bare lowercase form, or null when it is not a
 * registrable-looking hostname. IP addresses and single labels are refused.
 * Internationalised names must be entered in their `xn--` form.
 */
export function normalizeSsoDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.slice(value.lastIndexOf('@') + 1);
  value = value.split(/[/?#:]/)[0] ?? '';
  value = value.replace(/\.$/, '');
  if (value.startsWith('www.')) value = value.slice(4);

  if (value.length < 3 || value.length > 253) return null;
  const labels = value.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((label) => HOSTNAME_LABEL.test(label))) return null;
  // The top-level label is never all digits (rules out IPv4 addresses).
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null;
  return value;
}

/**
 * Domains of public mailbox providers. Nobody can verify them anyway (the DNS
 * check needs control of the zone), but a claim is refused early with a clear
 * message instead of a verification that can never pass.
 */
export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'gmx.de', 'web.de',
  'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'hey.com', 'fastmail.com',
  'tutanota.com', 'tuta.io', 'qq.com', '163.com', '126.com', 'naver.com',
  'hotmail.nl', 'live.nl', 'outlook.nl', 'hotmail.be', 'live.be', 'outlook.be',
  'hotmail.fr', 'live.fr', 'outlook.fr', 'hotmail.de', 'outlook.de', 'hotmail.co.uk',
  'live.co.uk', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'ziggo.nl', 'kpnmail.nl',
  'planet.nl', 'home.nl', 'hetnet.nl', 'telenet.be', 'skynet.be', 'orange.fr',
  'free.fr', 'wanadoo.fr', 'laposte.net', 't-online.de', 'btinternet.com',
]);

export function isPublicEmailDomain(domain: string): boolean {
  return PUBLIC_EMAIL_DOMAINS.has(domain);
}

// ============================================================================
// Error codes
// ============================================================================

export const SSO_ERRORS = {
  /** No plan, free grant or add-on covers SSO. */
  NOT_ENTITLED: 'SSO_NOT_ENTITLED',
  DOMAIN_INVALID: 'SSO_DOMAIN_INVALID',
  DOMAIN_PUBLIC: 'SSO_DOMAIN_PUBLIC',
  /** Another workspace verified this domain. */
  DOMAIN_IN_USE: 'SSO_DOMAIN_IN_USE',
  DOMAIN_MISSING: 'SSO_DOMAIN_MISSING',
  /** The TXT record was not found (yet). */
  DOMAIN_NOT_VERIFIED: 'SSO_DOMAIN_NOT_VERIFIED',
  /** The domain cannot change while a connection uses it. */
  DOMAIN_LOCKED: 'SSO_DOMAIN_LOCKED',
  DNS_LOOKUP_FAILED: 'SSO_DNS_LOOKUP_FAILED',
  CONNECTION_MISSING: 'SSO_CONNECTION_MISSING',
  /** Activating needs the IdP's metadata (URL or XML) or its entity id, SSO URL and certificate. */
  IDP_INCOMPLETE: 'SSO_IDP_INCOMPLETE',
  /** Clerk refused the IdP details (bad metadata URL, malformed certificate, …). */
  IDP_REJECTED: 'SSO_IDP_REJECTED',
  /** The identity provider (Clerk) could not be reached or does not offer enterprise SSO. */
  PROVIDER_UNAVAILABLE: 'SSO_PROVIDER_UNAVAILABLE',
  /** The add-on cannot be bought (free plan, partner-managed, included, free grant). */
  ADDON_UNAVAILABLE: 'SSO_ADDON_UNAVAILABLE',
  ALREADY_SUBSCRIBED: 'SSO_ALREADY_SUBSCRIBED',
  NOT_SUBSCRIBED: 'SSO_NOT_SUBSCRIBED',
  PAYMENT_METHOD_REQUIRED: 'PAYMENT_METHOD_REQUIRED',
  BILLING_ADMIN_REQUIRED: 'BILLING_ADMIN_REQUIRED',
} as const;

// ============================================================================
// Requests
// ============================================================================

export const ssoDomainInputSchema = z.object({
  domain: z.string().trim().min(1).max(300),
});
export type SsoDomainInput = z.infer<typeof ssoDomainInputSchema>;

const httpsUrl = z
  .string()
  .trim()
  .url()
  .max(2000)
  .refine((value) => value.startsWith('https://'), 'Use an https:// URL');

/**
 * Create or update the connection. Every IdP field is optional: the connection
 * can be created first (to get the ACS URL and entity id to enter in the IdP)
 * and completed later. `null` clears a field.
 */
export const ssoConnectionInputSchema = z.object({
  provider: z.enum(SSO_PROVIDER_IDS),
  idpMetadataUrl: httpsUrl.nullable().optional(),
  idpMetadata: z.string().trim().max(200_000).nullable().optional(),
  idpEntityId: z.string().trim().max(2000).nullable().optional(),
  idpSsoUrl: httpsUrl.nullable().optional(),
  idpCertificate: z.string().trim().max(20_000).nullable().optional(),
});
export type SsoConnectionInput = z.infer<typeof ssoConnectionInputSchema>;

/** Whether the IdP details are enough for Clerk to sign anyone in. */
export function isIdpConfigured(idp: {
  metadataUrl: string | null;
  hasMetadata: boolean;
  entityId: string | null;
  ssoUrl: string | null;
  hasCertificate: boolean;
}): boolean {
  if (idp.metadataUrl || idp.hasMetadata) return true;
  return Boolean(idp.entityId && idp.ssoUrl && idp.hasCertificate);
}

// ============================================================================
// Views
// ============================================================================

const entitlementSchema = z.object({
  entitled: z.boolean(),
  source: z.enum(SSO_ENTITLEMENT_SOURCES).nullable(),
});

/** `GET /api/sso`: the workspace's SSO configuration. */
export const ssoConfigViewSchema = z.object({
  entitlement: entitlementSchema,
  domain: z
    .object({
      name: z.string(),
      verified: z.boolean(),
      verifiedAt: z.string().nullable(),
      /** The record to add at the DNS host. */
      dnsRecord: z.object({ type: z.literal('TXT'), name: z.string(), value: z.string() }),
    })
    .nullable(),
  connection: z
    .object({
      provider: z.enum(SSO_PROVIDER_IDS),
      /** The admin switched it on. */
      enabled: z.boolean(),
      /** Clerk is sending the domain's users to the IdP right now (enabled and entitled). */
      active: z.boolean(),
      idp: z.object({
        metadataUrl: z.string().nullable(),
        hasMetadata: z.boolean(),
        entityId: z.string().nullable(),
        ssoUrl: z.string().nullable(),
        hasCertificate: z.boolean(),
      }),
      idpConfigured: z.boolean(),
      /** What the IdP needs from us. */
      sp: z.object({
        acsUrl: z.string().nullable(),
        entityId: z.string().nullable(),
        metadataUrl: z.string().nullable(),
      }),
      /** Users who signed in through the connection; null when Clerk could not be asked. */
      userCount: z.number().int().nonnegative().nullable(),
      updatedAt: z.string().nullable(),
    })
    .nullable(),
  /** The caller may change the configuration (`sso:manage`). */
  canManage: z.boolean(),
});
export type SsoConfigView = z.infer<typeof ssoConfigViewSchema>;

/** Why the add-on cannot be bought. */
export const SSO_ADDON_UNAVAILABLE_REASONS = ['INCLUDED_IN_PLAN', 'FREE_GRANT', 'FREE_PLAN', 'PARTNER_MANAGED'] as const;
export type SsoAddonUnavailableReason = (typeof SSO_ADDON_UNAVAILABLE_REASONS)[number];

/** `GET /api/sso/billing`: the add-on, priced for this workspace. */
export const ssoBillingViewSchema = z.object({
  entitlement: entitlementSchema,
  price: z.object({
    unitAmountCents: z.number().int().nonnegative(),
    currency: z.string(),
    /** A price staff set for this workspace rather than the list price. */
    custom: z.boolean(),
  }),
  purchasable: z.boolean(),
  unavailableReason: z.enum(SSO_ADDON_UNAVAILABLE_REASONS).nullable(),
  subscription: z
    .object({
      status: z.enum(['active', 'past_due', 'canceled']),
      currentPeriodEnd: z.string().nullable(),
      cancelAtPeriodEnd: z.boolean(),
    })
    .nullable(),
  hasPaymentMethod: z.boolean(),
});
export type SsoBillingView = z.infer<typeof ssoBillingViewSchema>;

/** The admin console's view of a workspace's SSO (billing-worker `GET /api/internal/admin/workspaces/:id/sso`). */
export interface SsoAdminView {
  entitlement: SsoEntitlement;
  planIncludesSso: boolean;
  billingMode: 'direct' | 'partner';
  listPrice: { unitAmountCents: number; currency: string };
  priceOverride: {
    unitAmountCents: number;
    currency: string | null;
    setBy: string | null;
    setAt: string | null;
    reason: string | null;
  } | null;
  subscription: {
    id: string;
    status: 'active' | 'past_due' | 'canceled';
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    /** What Stripe charges per month now; null when Stripe could not be asked. */
    unitAmountCents: number | null;
    currency: string | null;
  } | null;
  domain: { name: string; verified: boolean } | null;
  connection: { provider: string; enabled: boolean; active: boolean; updatedBy: string | null; updatedAt: string | null } | null;
}
