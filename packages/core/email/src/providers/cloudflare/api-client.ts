/**
 * Cloudflare Email Routing + Email Sending client.
 *
 * Backed by the official `cloudflare` SDK so the routes, parameter names and
 * response shapes come from Cloudflare's generated types instead of hand-written
 * strings. Pulled in through `cloudflare/tree-shakable` — instantiating the full
 * `new Cloudflare()` client bundles every resource in the API (~2 MB), while the
 * two resource trees below cost a fraction of that.
 *
 * The method surface and the `Cf*` return types are unchanged, so callers
 * (`domain.ts` and the workers behind it) are untouched.
 *
 * Spec: https://developers.cloudflare.com/api/resources/email_routing/
 *       https://developers.cloudflare.com/api/resources/email_sending/
 * SDK:  https://github.com/cloudflare/cloudflare-typescript
 */

import { createClient } from 'cloudflare/tree-shakable';
import { APIError } from 'cloudflare/core/error';
import type { ClientOptions } from 'cloudflare/client';
import { EmailRouting } from 'cloudflare/resources/email-routing/email-routing';
import { Subdomains } from 'cloudflare/resources/email-sending/subdomains/subdomains';
import type { Settings } from 'cloudflare/resources/email-routing/email-routing';
import type { DNSGetResponse, DNSRecord } from 'cloudflare/resources/email-routing/dns';
import type { EmailRoutingRule } from 'cloudflare/resources/email-routing/rules/rules';
import type { Address } from 'cloudflare/resources/email-routing/addresses';
import type {
  SubdomainCreateResponse,
  SubdomainGetResponse,
  SubdomainListResponse,
} from 'cloudflare/resources/email-sending/subdomains/subdomains';

import { PermanentProviderError, ProviderConfigError, TransientProviderError } from '../../core/errors';
import type {
  CfDestinationAddress,
  CfDnsRecord,
  CfRoutingRule,
  CfRoutingSettings,
  CfSendingSubdomain,
} from './types';

const PROVIDER = 'cloudflare';

/**
 * `GET /zones/{id}/email/routing/dns` is the one endpoint whose response shape
 * depends on the query: for the zone apex `result` is a bare record array, but
 * for a subdomain request it is a `{ errors, record }` object (`errors` there
 * lists missing or unpropagated records, not failures). The SDK models both
 * arms and — uniquely among these resources — hands back the whole envelope
 * rather than unwrapping `result`. This collapses either arm to a record list.
 */
function normalizeDnsResult(response: DNSGetResponse | undefined): CfDnsRecord[] {
  const result = response?.result;
  if (!result) return [];
  if (Array.isArray(result)) return result.map(toDnsRecord);
  return ((result as { record?: DNSRecord[] }).record ?? []).map(toDnsRecord);
}

function toDnsRecord(r: DNSRecord): CfDnsRecord {
  return {
    type: r.type ?? 'TXT',
    name: r.name ?? '',
    content: r.content ?? '',
    ttl: typeof r.ttl === 'number' ? r.ttl : undefined,
    priority: r.priority,
  };
}

function toRoutingSettings(s: Settings): CfRoutingSettings {
  return {
    enabled: s.enabled,
    name: s.name,
    tag: s.tag,
    status: s.status,
    modified: s.modified,
    created: s.created,
    skip_wizard: s.skip_wizard,
  };
}

function toRoutingRule(r: EmailRoutingRule): CfRoutingRule {
  return {
    id: r.id ?? '',
    name: r.name,
    enabled: r.enabled ?? false,
    matchers: (r.matchers ?? []) as CfRoutingRule['matchers'],
    actions: (r.actions ?? []) as CfRoutingRule['actions'],
    priority: r.priority,
  };
}

function toDestinationAddress(a: Address): CfDestinationAddress {
  return {
    id: a.id ?? '',
    email: a.email ?? '',
    verified: a.verified ?? null,
    created: a.created ?? '',
    modified: a.modified ?? '',
  };
}

function toSendingSubdomain(
  s: SubdomainCreateResponse | SubdomainGetResponse | SubdomainListResponse,
): CfSendingSubdomain {
  return {
    tag: s.tag,
    name: s.name,
    enabled: s.enabled,
    dkim_selector: s.dkim_selector,
    return_path_domain: s.return_path_domain,
    created: s.created,
    modified: s.modified,
  };
}

/** The SDK's `fetch` signature, re-exported so tests can type their stub. */
export type CloudflareFetch = NonNullable<ClientOptions['fetch']>;

export class CloudflareApiClient {
  private readonly client: ReturnType<typeof createEmailClient>;

  /**
   * `fetch` overrides the SDK's transport. Tests inject a stub through it — the
   * SDK holds its own `fetch` reference, so patching `globalThis.fetch` does
   * not intercept it and a test that tries would hit api.cloudflare.com for
   * real.
   */
  constructor(apiToken: string, fetch?: CloudflareFetch) {
    if (!apiToken) throw new ProviderConfigError(PROVIDER, 'apiToken');
    this.client = createEmailClient(apiToken, fetch);
  }

  // ---- zone-scoped: email routing settings ---------------------------------

  async enableRouting(zoneId: string): Promise<CfRoutingSettings> {
    return call(() =>
      this.client.emailRouting.enable({ zone_id: zoneId, body: {} }).then(toRoutingSettings),
    );
  }

  async disableRouting(zoneId: string): Promise<CfRoutingSettings> {
    return call(() =>
      this.client.emailRouting.disable({ zone_id: zoneId, body: {} }).then(toRoutingSettings),
    );
  }

  async getRoutingSettings(zoneId: string): Promise<CfRoutingSettings> {
    return call(() => this.client.emailRouting.get({ zone_id: zoneId }).then(toRoutingSettings));
  }

  // ---- zone-scoped: required DNS -------------------------------------------

  async getRoutingDns(zoneId: string, subdomain?: string): Promise<CfDnsRecord[]> {
    return call(async () => {
      const result = await this.client.emailRouting.dns.get({
        zone_id: zoneId,
        ...(subdomain ? { subdomain } : {}),
      });
      return normalizeDnsResult(result);
    });
  }

  /**
   * Re-create / refresh the locked MX + SPF records. Pass `name` (a FQDN inside
   * the zone, e.g. "sub.example.com") to register that subdomain for Email
   * Routing instead of the zone apex — the API behind the dashboard's "Add
   * subdomain" flow.
   *
   * Returns the routing settings, which is what Cloudflare actually answers
   * with. The previous hand-rolled version claimed to return the DNS records;
   * read them back with {@link getRoutingDns} if you need them.
   */
  async configureRoutingDns(zoneId: string, name?: string): Promise<CfRoutingSettings> {
    return call(() =>
      this.client.emailRouting.dns
        .create({ zone_id: zoneId, ...(name ? { name } : {}) })
        .then(toRoutingSettings),
    );
  }

  // ---- zone-scoped: routing rules ------------------------------------------

  /**
   * The SDK has no `rules.list` (it exposes create/get/update/delete only), so
   * this is the one place that still names a path. It still goes through the
   * SDK transport — auth, retries and error shape are shared — and unwraps the
   * `result` envelope the way the generated resources do.
   */
  async listRoutingRules(zoneId: string): Promise<CfRoutingRule[]> {
    return call(async () => {
      const body = await this.client.get<{ result?: EmailRoutingRule[] }>(
        `/zones/${zoneId}/email/routing/rules`,
      );
      return (body.result ?? []).map(toRoutingRule);
    });
  }

  async getRoutingRule(zoneId: string, ruleId: string): Promise<CfRoutingRule> {
    return call(() =>
      this.client.emailRouting.rules.get(ruleId, { zone_id: zoneId }).then(toRoutingRule),
    );
  }

  async createRoutingRule(zoneId: string, body: Omit<CfRoutingRule, 'id'>): Promise<CfRoutingRule> {
    return call(() =>
      this.client.emailRouting.rules
        .create({
          zone_id: zoneId,
          actions: body.actions,
          matchers: body.matchers,
          enabled: body.enabled,
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
        })
        .then(toRoutingRule),
    );
  }

  async updateRoutingRule(
    zoneId: string,
    ruleId: string,
    body: Omit<CfRoutingRule, 'id'>,
  ): Promise<CfRoutingRule> {
    return call(() =>
      this.client.emailRouting.rules
        .update(ruleId, {
          zone_id: zoneId,
          actions: body.actions,
          matchers: body.matchers,
          enabled: body.enabled,
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
        })
        .then(toRoutingRule),
    );
  }

  async deleteRoutingRule(zoneId: string, ruleId: string): Promise<void> {
    await call(() => this.client.emailRouting.rules.delete(ruleId, { zone_id: zoneId }));
  }

  // ---- zone-scoped: catch-all ----------------------------------------------

  async getCatchAll(zoneId: string): Promise<CfRoutingRule> {
    return call(() =>
      this.client.emailRouting.rules.catchAlls.get({ zone_id: zoneId }).then(toRoutingRule),
    );
  }

  async putCatchAll(
    zoneId: string,
    body: { name?: string; enabled: boolean; matchers: CfRoutingRule['matchers']; actions: CfRoutingRule['actions'] },
  ): Promise<CfRoutingRule> {
    return call(() =>
      this.client.emailRouting.rules.catchAlls
        .update({
          zone_id: zoneId,
          // The catch-all only accepts an `all` matcher; the wider rule matcher
          // type is narrowed here rather than at every call site.
          matchers: body.matchers.map(() => ({ type: 'all' as const })),
          actions: body.actions.map((a) => ({ type: a.type, ...(a.value ? { value: a.value } : {}) })),
          enabled: body.enabled,
          ...(body.name !== undefined ? { name: body.name } : {}),
        })
        .then(toRoutingRule),
    );
  }

  // ---- zone-scoped: email sending subdomains -------------------------------
  //
  // Separate from Email Routing. Authorises a domain (or subdomain of the zone)
  // for outbound sending via the `[[send_email]]` Worker binding, and publishes
  // the DKIM / return-path records needed for deliverability.

  async listSendingSubdomains(zoneId: string): Promise<CfSendingSubdomain[]> {
    return call(async () => {
      const out: CfSendingSubdomain[] = [];
      const page = await this.client.emailSending.subdomains.list({ zone_id: zoneId });
      for await (const subdomain of page) out.push(toSendingSubdomain(subdomain));
      return out;
    });
  }

  async getSendingSubdomain(zoneId: string, subdomainTag: string): Promise<CfSendingSubdomain> {
    return call(() =>
      this.client.emailSending.subdomains
        .get(subdomainTag, { zone_id: zoneId })
        .then(toSendingSubdomain),
    );
  }

  /**
   * Authorise `name` for outbound sending on this zone. `name` must be the zone
   * apex or a subdomain of the zone (e.g. "example.com" or "send.example.com").
   */
  async createSendingSubdomain(zoneId: string, name: string): Promise<CfSendingSubdomain> {
    return call(() =>
      this.client.emailSending.subdomains
        .create({ zone_id: zoneId, name })
        .then(toSendingSubdomain),
    );
  }

  async deleteSendingSubdomain(zoneId: string, subdomainTag: string): Promise<void> {
    await call(() =>
      this.client.emailSending.subdomains.delete(subdomainTag, { zone_id: zoneId }),
    );
  }

  async getSendingSubdomainDns(zoneId: string, subdomainTag: string): Promise<CfDnsRecord[]> {
    return call(async () => {
      const out: CfDnsRecord[] = [];
      const page = await this.client.emailSending.subdomains.dns.get(subdomainTag, {
        zone_id: zoneId,
      });
      for await (const record of page) out.push(toDnsRecord(record));
      return out;
    });
  }

  // ---- account-scoped: destination addresses --------------------------------

  async listDestinationAddresses(
    accountId: string,
    options: { verified?: boolean; page?: number; per_page?: number } = {},
  ): Promise<CfDestinationAddress[]> {
    return call(async () => {
      const result = await this.client.emailRouting.addresses.list({
        account_id: accountId,
        ...(options.verified !== undefined ? { verified: options.verified } : {}),
        ...(options.page !== undefined ? { page: options.page } : {}),
        ...(options.per_page !== undefined ? { per_page: options.per_page } : {}),
      });
      return (result.result ?? []).map(toDestinationAddress);
    });
  }

  async getDestinationAddress(accountId: string, addressId: string): Promise<CfDestinationAddress> {
    return call(() =>
      this.client.emailRouting.addresses
        .get(addressId, { account_id: accountId })
        .then(toDestinationAddress),
    );
  }

  /**
   * Enqueue a verification email to `email`. Cloudflare returns the destination
   * row immediately with `verified: null`; the recipient must click the link
   * before sends to that address will succeed.
   */
  async createDestinationAddress(accountId: string, email: string): Promise<CfDestinationAddress> {
    return call(() =>
      this.client.emailRouting.addresses
        .create({ account_id: accountId, email })
        .then(toDestinationAddress),
    );
  }

  async deleteDestinationAddress(accountId: string, addressId: string): Promise<void> {
    await call(() =>
      this.client.emailRouting.addresses.delete(addressId, { account_id: accountId }),
    );
  }
}

/**
 * Preserve the transient/permanent split callers retry on. A connection-level
 * failure arrives with no status — that is retryable, so it counts as
 * transient rather than falling through to permanent.
 */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof APIError)) {
      throw new PermanentProviderError(
        err instanceof Error ? err.message : String(err),
        PROVIDER,
      );
    }
    const detail =
      (err.errors ?? []).map((e) => `${e.code}:${e.message}`).join('; ') ||
      err.message ||
      `HTTP ${err.status ?? 'unknown'}`;
    const transient = err.status === undefined || err.status >= 500 || err.status === 429;
    const Err = transient ? TransientProviderError : PermanentProviderError;
    throw new Err(`Cloudflare API ${err.status ?? '(no status)'}: ${detail}`, PROVIDER);
  }
}

/**
 * Only the Email Routing and Email Sending trees are registered, so the bundle
 * carries those surfaces instead of the whole Cloudflare API.
 */
function createEmailClient(apiToken: string, fetch?: CloudflareFetch) {
  return createClient({
    apiToken,
    maxRetries: 2,
    timeout: 15_000,
    ...(fetch ? { fetch } : {}),
    resources: [EmailRouting, Subdomains],
  });
}
