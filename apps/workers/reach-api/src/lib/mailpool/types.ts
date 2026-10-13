/**
 * Hand-written types for the slice of the Mailpool public API WeldReach uses
 * (spec: `https://app.mailpool.io/v1/api`, OpenAPI export `Mailpool-API.yaml`).
 *
 * Only the endpoints reach-api calls are modelled (domains, mailboxes, slots;
 * warmup is WeldSuite's own network, not Mailpool's). The API is loose about
 * ids (domain ids are numbers, mailbox ids are strings in the schema) and about
 * ports (strings for `shared` mailboxes), so the response types accept both and
 * the client normalises where it matters.
 */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export type MailpoolMailboxType = 'google' | 'shared' | 'private' | 'outlook';

/** Types WeldReach provisions in v1 (see docs/plans/weldreach.md, Decisions). */
export type MailpoolProvisionedType = 'google' | 'shared';

export type MailpoolDmarcPolicy = 'none' | 'quarantine' | 'reject';

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export type MailpoolDomainStatus = 'active' | 'pending' | 'inactive';

/** `DomainError.code`: 1xx disabled by Mailpool, 2xx registry, 3xx registrar. */
export interface MailpoolDomainError {
  code: number;
  message: string;
}

export interface MailpoolDomain {
  id: number | string;
  domain: string;
  status: MailpoolDomainStatus;
  type?: MailpoolMailboxType | 'unassigned';
  createdAt?: string;
  expireAt?: string;
  nameservers?: string[];
  error?: MailpoolDomainError;
}

export type MailpoolDnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'SRV';

/** One DNS record as Mailpool lists it. `key` is '@', a relative label or an FQDN. */
export interface MailpoolDnsRecord {
  type: MailpoolDnsRecordType;
  key?: string;
  value: string;
  priority?: number;
  weight?: number;
  port?: number;
}

// ---------------------------------------------------------------------------
// Cloudflare connect (WeldHost domains live in WeldSuite's Cloudflare account)
//
// These two calls exist today only in Mailpool's web app; Mailpool is adding
// them to the public API. Shapes follow the web-app versions.
// ---------------------------------------------------------------------------

export interface MailpoolCloudflareZone {
  id: string;
  name: string;
  status: string;
  nameServers: string[];
  alreadyConnected: boolean;
  unavailable: boolean;
}

export interface MailpoolCloudflareZonesResponse {
  zones: MailpoolCloudflareZone[];
}

export interface MailpoolConnectedDomain {
  /** Mailpool domain id. */
  id: number;
  domain: string;
  status: string;
  dnsType?: string;
  nameservers?: string[];
}

export interface MailpoolSkippedDomain {
  domain?: string;
  name?: string;
  reason?: string;
}

export interface MailpoolCloudflareConnectResponse {
  connected: MailpoolConnectedDomain[];
  skipped: MailpoolSkippedDomain[];
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

export type MailpoolMailboxStatus = 'active' | 'pending' | 'inactive';

/**
 * `MailboxError.code`:
 *   101 domain already in use in Google Workspace
 *   201 admin two-factor changed, 202 admin password changed
 *   301 invalid domain
 *   401 account disabled for spam, 402 admin account disabled for spam
 */
export interface MailpoolMailboxError {
  code: number;
  message: string;
}

export interface CreateMailpoolMailboxInput {
  email: string;
  firstName: string;
  lastName: string;
  type: MailpoolMailboxType;
  signature?: string;
  forwardTo?: string;
  avatar?: string;
}

export interface UpdateMailpoolMailboxInput {
  firstName?: string;
  lastName?: string;
  signature?: string;
  forwardTo?: string;
  avatar?: string | null;
}

/**
 * A mailbox as Mailpool returns it. Google, shared and private mailboxes carry
 * SMTP and IMAP logins; ports are numbers for google and strings for shared.
 */
export interface MailpoolMailbox {
  id: number | string;
  type: MailpoolMailboxType;
  email: string;
  firstName?: string;
  lastName?: string;
  signature?: string;
  forwardTo?: string;
  status: MailpoolMailboxStatus;
  error?: MailpoolMailboxError;
  scheduledDeletionAt?: string;
  domain?: MailpoolDomain;
  smtpHost?: string;
  smtpPort?: number | string;
  smtpTLS?: boolean;
  smtpUsername?: string;
  smtpPassword?: string;
  imapHost?: string;
  imapPort?: number | string;
  imapTLS?: boolean;
  imapUsername?: string;
  imapPassword?: string;
}

// ---------------------------------------------------------------------------
// Subscription slots
// ---------------------------------------------------------------------------

/**
 * Slot types of `/subscriptions/*`. The published enum is google | private |
 * outlook; `shared` is included so a shared slot count can be managed the day
 * Mailpool reports one (see ensureSlotAvailable).
 */
export type MailpoolSlotType = 'google' | 'shared' | 'private' | 'outlook';

export interface MailpoolSubscriptionSlots {
  /** Mailboxes in use per slot type. */
  mailboxes: Partial<Record<string, number>>;
  /** Slots paid for per type. */
  slots: Partial<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** Events Mailpool can send. WeldReach acts on the domain and mailbox ones. */
export const MAILPOOL_WEBHOOK_EVENTS = [
  'domains.registered',
  'domains.updated',
  'mailboxes.created',
  'mailboxes.updated',
  'mailboxes.deleted',
] as const;
export type MailpoolWebhookEvent = (typeof MAILPOOL_WEBHOOK_EVENTS)[number];
