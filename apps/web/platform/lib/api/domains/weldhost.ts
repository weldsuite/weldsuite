/**
 * Host Domain Types
 *
 * Domain type definitions shared by the WeldHost surfaces and the domain object panel.
 *
 * This module previously also exposed a host client bound to the obsolete api-worker
 * transport. That client was dead code: it was never exported, and every consumer of
 * this module imports types only. The live domain surfaces are served by app-api
 * under `/api/domains`, `/api/dns-zones` and
 * `/api/domain-transfers`. The dead client was removed as part of the api-worker
 * phase-out; no call sites changed.
 */

export interface HostDomain {
  id: string;
  workspaceId: string;
  name: string;
  tld: string;
  fullDomain: string;
  status: 'active' | 'pending' | 'expired' | 'suspended' | 'cancelled';
  registrationStatus?: 'pending_registration' | 'registered' | 'pending_transfer' | 'transferred' | 'pending_renewal' | 'renewed' | 'failed';
  registrar?: string;
  externalRegistrarId?: string;
  registrarStatus?: string;
  registrarSyncedAt?: string;
  registeredAt?: string;
  expiresAt?: string;
  renewedAt?: string;
  nameservers?: string[];
  customNameservers: boolean;
  nameserverVerified: boolean;
  nameserverVerificationPending: boolean;
  nameserverVerificationToken?: string;
  autoRenew: boolean;
  privacyProtection: boolean;
  locked: boolean;
  sslEnabled: boolean;
  emailForwardingEnabled: boolean;
  authCode?: string;
  authCodeExpiresAt?: string;
  registrantContact?: DomainContact;
  adminContact?: DomainContact;
  techContact?: DomainContact;
  billingContact?: DomainContact;
  notes?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface DomainContact {
  firstName?: string;
  lastName?: string;
  organization?: string;
  email?: string;
  phone?: string;
  fax?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}
