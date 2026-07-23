// AUTO-COPIED from @weldsuite/core-api-client/schemas/domains
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

/**
 * Domain schemas (Zod v3)
 *
 * Single source of truth for the `/api/domains/*` surface on `app-api`.
 * Supersedes the older `weldhost.ts` and `host-domains.ts` schemas.
 */

import { z } from 'zod';

// ============================================================================
// Contact — fields Cloudflare Registrar accepts on registration
// ============================================================================

export const contactSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  organization: z.string().optional(),
  email: z.string().email(),
  phone: z.string().min(1),
  address1: z.string().min(1),
  address2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().optional(),
  postalCode: z.string().min(1),
  country: z.string().length(2),
});

export type ContactInput = z.infer<typeof contactSchema>;

// ============================================================================
// Input schemas
// ============================================================================

export const listDomainsQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
  search: z.string().optional(),
  status: z.enum(['all', 'active', 'pending', 'expired', 'suspended', 'cancelled']).optional(),
  sortBy: z.enum(['fullDomain', 'status', 'expiresAt', 'createdAt']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const domainSearchQuery = z.object({
  q: z.string().min(2),
  limit: z.coerce.number().min(1).max(50).optional().default(20),
});

export const domainCheckInput = z.object({
  domains: z.array(z.string().min(1)).min(1).max(20),
});

export const createDomainSchema = z.object({
  name: z.string().min(1).max(255),
  tld: z.string().min(1).max(50),
  fullDomain: z.string().min(1).max(255),
  status: z.enum(['active', 'pending', 'expired', 'suspended', 'cancelled']).optional().default('pending'),
  registrar: z.string().max(255).optional(),
  nameservers: z.array(z.string()).optional(),
  customNameservers: z.boolean().optional().default(false),
  autoRenew: z.boolean().optional().default(true),
  privacyProtection: z.boolean().optional().default(false),
  locked: z.boolean().optional().default(true),
  notes: z.string().optional(),
});

export const updateDomainSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  tld: z.string().min(1).max(50).optional(),
  fullDomain: z.string().min(1).max(255).optional(),
  status: z.enum(['active', 'pending', 'expired', 'suspended', 'cancelled']).optional(),
  registrar: z.string().max(255).optional(),
  externalRegistrarId: z.string().max(255).nullish(),
  registrarStatus: z.string().max(100).optional(),
  registrarSyncedAt: z.string().datetime().optional(),
  registeredAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  renewedAt: z.string().datetime().optional(),
  nameservers: z.array(z.string()).optional(),
  customNameservers: z.boolean().optional(),
  nameserverVerified: z.boolean().optional(),
  nameserverVerificationPending: z.boolean().optional(),
  autoRenew: z.boolean().optional(),
  privacyProtection: z.boolean().optional(),
  locked: z.boolean().optional(),
  sslEnabled: z.boolean().optional(),
  emailForwardingEnabled: z.boolean().optional(),
  authCode: z.string().max(255).optional(),
  authCodeExpiresAt: z.string().datetime().optional(),
  registrantContact: z.record(z.unknown()).optional(),
  adminContact: z.record(z.unknown()).optional(),
  techContact: z.record(z.unknown()).optional(),
  billingContact: z.record(z.unknown()).optional(),
  notes: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const externalDomainSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(253)
    .regex(
      /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/,
      'Enter a valid fully-qualified domain name (e.g. example.com)',
    ),
  registrar: z.string().max(255).optional(),
});

export const checkoutInput = z.object({
  domain: z.string().min(3),
  contact: contactSchema.optional(),
  autoRenew: z.boolean().optional().default(true),
  privacyProtection: z.boolean().optional().default(false),
  years: z.coerce.number().int().min(1).max(10).optional().default(1),
  /** Optional Stripe price override; price is resolved server-side from the pricing table by default. */
  stripePriceId: z.string().nullish(),
});

export const toggleAutoRenewInput = z.object({
  enabled: z.boolean(),
});

export const togglePrivacyInput = z.object({
  enabled: z.boolean(),
});

export const toggleLockInput = z.object({
  locked: z.boolean(),
});

export const completeRegistrationInput = z.object({
  contactInfo: z.record(z.unknown()).optional(),
});

// ============================================================================
// Inferred input types
// ============================================================================

export type ListDomainsQuery = z.input<typeof listDomainsQuery>;
export type DomainSearchQuery = z.infer<typeof domainSearchQuery>;
export type DomainCheckInput = z.infer<typeof domainCheckInput>;
export type CreateDomainInput = z.infer<typeof createDomainSchema>;
export type UpdateDomainInput = z.infer<typeof updateDomainSchema>;
export type ExternalDomainInput = z.infer<typeof externalDomainSchema>;
export type CheckoutInput = z.infer<typeof checkoutInput>;
export type ToggleAutoRenewInput = z.infer<typeof toggleAutoRenewInput>;
export type TogglePrivacyInput = z.infer<typeof togglePrivacyInput>;
export type ToggleLockInput = z.infer<typeof toggleLockInput>;
export type CompleteRegistrationInput = z.infer<typeof completeRegistrationInput>;

// ============================================================================
// Response types
// ============================================================================

/**
 * Domain search / availability result. Mirrors the legacy shape used by the
 * domain-availability-checker component, so call sites do not change.
 */
export interface DomainSearchResult {
  domain_name: string;
  suffix: string;
  /** 1 = available, 2 = unavailable */
  status: 1 | 2;
  premium: boolean;
  /** Final price in cents (CF at-cost + markup) */
  price: number | null;
  currency: string | null;
  /** Same as domain_name — backwards compat alias */
  domain: string;
  available: boolean;
}

export interface DomainDnsZone {
  id: string;
  name: string;
  status: string;
  provider: string;
  externalZoneId: string | null;
  externalNameservers: string[] | null;
  syncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Domain {
  id: string;
  name: string;
  tld: string;
  fullDomain: string;

  status: string;
  registrationStatus: string | null;

  registrar: string | null;
  externalRegistrarId: string | null;
  registrarStatus: string | null;
  registrarSyncedAt: string | null;
  workflowUrl: string | null;

  registeredAt: string | null;
  expiresAt: string | null;
  renewedAt: string | null;

  nameservers: string[] | null;
  customNameservers: boolean | null;
  nameserverVerified: boolean | null;
  nameserverVerificationPending: boolean | null;

  autoRenew: boolean | null;
  privacyProtection: boolean | null;
  locked: boolean | null;
  sslEnabled: boolean | null;
  emailForwardingEnabled: boolean | null;

  authCode: string | null;
  authCodeExpiresAt: string | null;

  registrantContact: Record<string, unknown> | null;
  adminContact: Record<string, unknown> | null;
  techContact: Record<string, unknown> | null;
  billingContact: Record<string, unknown> | null;

  notes: string | null;
  metadata: Record<string, unknown> | null;

  createdAt: string;
  updatedAt: string;

  dnsZone?: DomainDnsZone | null;
}

export interface CheckoutResponse {
  checkoutSessionId: string | null;
  checkoutUrl: string | null;
  registrationIds: string[];
}

export interface DashboardStats {
  totalDomains: number;
  activeDomains: number;
  pendingDomains: number;
  expiredDomains: number;
  expiringSoon: number;
  sslEnabled: number;
  autoRenewEnabled: number;
}

export interface ChartDataPoint {
  date: string;
  registrations: number;
  renewals: number;
  expirations: number;
}

export interface DomainListResponse {
  domains: Domain[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  stats: {
    total: number;
    active: number;
    pending: number;
    expired: number;
  };
}

export interface VerifyNameserversResponse {
  success: boolean;
  verified: boolean;
  requiredNameservers: string[];
  currentNameservers: string[];
  message: string;
}

export interface VerifyOwnershipResponse extends Domain {
  nameservers: string[];
  dnsZone: DomainDnsZone | null;
}

export interface RefreshZoneStatusResponse {
  zoneStatus: 'active' | 'pending' | 'error' | string;
  domainStatus: string;
  cloudflareStatus: string | null;
  nameservers?: string[];
}

export interface AuthCodeResponse {
  success: boolean;
  authCode: string;
  expiresAt: string;
}

export interface RegistrationStatusResponse {
  registrationId: string;
  domainId: string | null;
  domainName: string;
  status: 'pending' | 'payment_complete' | 'registering' | 'completed' | 'failed';
  totalPrice: number | null;
  failureReason: string | null;
}
