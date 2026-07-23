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
  matchers: Array<{ type: 'literal' | 'all'; field?: string; value?: string }>;
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

export interface CfRoutingSettings {
  enabled: boolean;
  name: string;
  tag: string;
  status: 'ready' | 'unconfigured' | 'misconfigured';
  modified: string;
  created: string;
  skip_wizard: boolean;
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
