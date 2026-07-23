/**
 * Provider-agnostic email types.
 *
 * Every concrete provider in `packages/email/src/providers/<name>/` implements
 * one or more of these interfaces. The registry (./registry.ts) wires them
 * together; consumers (api-worker, mail-inbound-worker, workspace-worker,
 * platform) only ever import these interfaces, never a specific provider.
 */

// ---- common ----------------------------------------------------------------

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface EmailAttachment {
  filename: string;
  content: ArrayBuffer | Uint8Array | string;
  contentType?: string;
  cid?: string;
}

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  size: number;
  content: ArrayBuffer;
  cid?: string;
}

export type DnsRecordType = 'MX' | 'TXT' | 'CNAME' | 'A' | 'AAAA';
export type DnsRecordStatus = 'pending' | 'verified' | 'failed';
export type DnsRecordPurpose = 'spf' | 'dkim' | 'dmarc' | 'mx' | 'verification' | 'other';

export interface MailDnsRecord {
  type: DnsRecordType;
  name: string;
  value: string;
  priority?: number;
  ttl?: number;
  status?: DnsRecordStatus;
  purpose?: DnsRecordPurpose;
}

// ---- send ------------------------------------------------------------------

export interface SendOptions {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress;
  subject: string;
  text?: string;
  html?: string;
  attachments?: EmailAttachment[];
  headers?: Record<string, string>;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  priority?: 'low' | 'normal' | 'high';
}

export interface SendResult {
  messageId: string;
  providerMessageId?: string;
  /** Provider-specific extras (rule id, submission id, ...). */
  metadata?: Record<string, unknown>;
}

export interface SendCapabilities {
  /** Provider can deliver to recipients it has never seen before, with no setup. */
  firstTouchToUnverified: boolean;
  /** Provider supports bulk / list sends (campaign-grade rate limits). */
  bulk: boolean;
  /** Provider injects open/click tracking pixels. */
  tracking: boolean;
  /** Provider can attach files. */
  attachments: boolean;
}

export interface IEmailSendProvider {
  readonly name: string;
  readonly capabilities: SendCapabilities;
  /**
   * Send an email. Throws PendingVerificationError when the recipient must
   * complete a provider-side verification flow before the send can proceed.
   */
  send(options: SendOptions): Promise<SendResult>;
  verifyConnection?(): Promise<{ ok: boolean; error?: string }>;
}

// ---- receive ---------------------------------------------------------------

export interface ParsedInboundEmail {
  messageId: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  textBody?: string;
  htmlBody?: string;
  attachments: ParsedAttachment[];
  headers: Record<string, string>;
  receivedAt: Date;
  /** Raw RFC 5322 source, preserved for re-delivery / archival. */
  rawEmail?: ArrayBuffer | string;
  size: number;
  inReplyTo?: string;
  references?: string[];
  spfStatus?: 'pass' | 'fail' | 'softfail' | 'none';
  dkimStatus?: 'pass' | 'fail' | 'none';
  dmarcStatus?: 'pass' | 'fail' | 'none';
  /** Provider-specific extras (Cloudflare ForwardableEmailMessage etc.). */
  metadata?: Record<string, unknown>;
}

/**
 * Receive providers parse a provider-specific input into a ParsedInboundEmail.
 * - Cloudflare: input is a ForwardableEmailMessage.
 * - HTTP webhook (legacy): input is a Request.
 */
export interface IEmailReceiveProvider<TInput = unknown> {
  readonly name: string;
  parse(input: TInput): Promise<ParsedInboundEmail>;
  /** Optional signature check for HTTP-webhook providers. */
  verifySignature?(input: TInput): Promise<boolean>;
}

// ---- domain ----------------------------------------------------------------

export interface ProvisionDomainOptions {
  /** Worker name to deliver inbound mail to (provider-specific). */
  receiveWorkerName?: string;
  /** Optional explicit catch-all forward address (mutually exclusive with receiveWorkerName). */
  catchAllForward?: string;
  /** Provider-specific extras (CF zone id, etc.). */
  metadata?: Record<string, unknown>;
}

export interface ProvisionDomainResult {
  ok: boolean;
  /** Provider's external id for the routing config (e.g. CF rule id). */
  externalRuleId?: string;
  dnsRecords: MailDnsRecord[];
  /** Provider-specific extras. */
  metadata?: Record<string, unknown>;
}

export interface IMailDomainProvider {
  readonly name: string;
  provisionDomain(domain: string, options?: ProvisionDomainOptions): Promise<ProvisionDomainResult>;
  deprovisionDomain(domain: string): Promise<void>;
  getDnsRecords(domain: string): Promise<MailDnsRecord[]>;
  /** Optional — providers that own DNS verification can implement this. */
  verifyDomain?(domain: string): Promise<{ verified: boolean; records: MailDnsRecord[] }>;
}

// ---- account (per-mailbox lifecycle, optional) -----------------------------

export interface CreateAccountOptions {
  password?: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}

export interface IMailAccountProvider {
  readonly name: string;
  createAccount?(email: string, options: CreateAccountOptions): Promise<void>;
  deleteAccount?(email: string): Promise<void>;
  resetPassword?(email: string, newPassword: string): Promise<void>;
}

// ---- helpers ---------------------------------------------------------------

export function formatEmailAddress(addr: EmailAddress): string {
  if (addr.name) {
    const escaped = addr.name.replace(/"/g, '\\"');
    return `"${escaped}" <${addr.email}>`;
  }
  return addr.email;
}

export function parseEmailAddress(
  input: string | { address?: string; email?: string; name?: string } | null | undefined,
): EmailAddress {
  if (!input) return { email: 'unknown@unknown.com' };
  if (typeof input === 'object') {
    return { email: input.email || input.address || 'unknown@unknown.com', name: input.name };
  }
  const match = input.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
  if (match) {
    const email = match[2]!.trim();
    const name = match[1]!.trim();
    return { email, name: name || undefined };
  }
  return { email: input.trim() };
}

export function parseEmailAddresses(
  input: string | Array<string | { address?: string; email?: string; name?: string }> | null | undefined,
): EmailAddress[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.map(parseEmailAddress);
  return input.split(',').map((s) => parseEmailAddress(s.trim()));
}
