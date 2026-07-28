/**
 * Cloudflare provider config + binding types.
 */

import type { SendEmail } from './send-binding';

/** Bindings the Cloudflare provider needs. Only `apiToken` and `accountId`
 *  are required for the domain provider; `sendEmail` is required for sends;
 *  the receive provider needs no env at all. */
export interface CloudflareProviderEnv {
  /** Cloudflare API token with `Zone.Email Routing` + `Account.Email Routing Addresses` permissions. */
  apiToken?: string;
  /** Cloudflare account id (for destination-address management). */
  accountId?: string;
  /** Worker `[[send_email]]` binding. */
  sendEmail?: SendEmail;
  /** Default Worker name to route inbound mail to. */
  defaultReceiveWorker?: string;
}

export interface CfRoutingRule {
  id: string;
  name?: string;
  enabled: boolean;
  /** `field` is `'to'` — the only field Cloudflare matches routing rules on. */
  matchers: Array<{ type: 'literal' | 'all'; field?: 'to'; value?: string }>;
  actions: Array<{ type: 'forward' | 'worker' | 'drop'; value?: string[] }>;
  priority?: number;
}

export interface CfDestinationAddress {
  id: string;
  email: string;
  verified: string | null;
  created: string;
  modified: string;
}

/**
 * Everything but `enabled` and `name` is optional on the wire, and the status
 * set is wider than the three values this used to declare — Cloudflare also
 * reports `misconfigured/locked` and `unlocked`. Callers check for `'ready'`,
 * so the extra states just need to not be silently narrowed away.
 */
export interface CfRoutingSettings {
  enabled: boolean;
  name: string;
  tag?: string;
  status?: 'ready' | 'unconfigured' | 'misconfigured' | 'misconfigured/locked' | 'unlocked';
  modified?: string;
  created?: string;
  skip_wizard?: boolean;
}

export interface CfDnsRecord {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
}

export interface CfSendingSubdomain {
  /** Cloudflare's internal id for this subdomain (used in URL paths). */
  tag: string;
  /** Fully-qualified subdomain, e.g. "send.example.com". */
  name: string;
  enabled: boolean;
  dkim_selector?: string;
  return_path_domain?: string;
  created?: string;
  modified?: string;
}
