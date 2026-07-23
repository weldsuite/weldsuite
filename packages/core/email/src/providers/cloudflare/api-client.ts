/**
 * Tiny typed fetch client for the Cloudflare REST API endpoints we use.
 * Spec: https://developers.cloudflare.com/api/resources/email_routing/
 */

import { PermanentProviderError, ProviderConfigError, TransientProviderError } from '../../core/errors';
import type {
  CfDestinationAddress,
  CfDnsRecord,
  CfRoutingRule,
  CfRoutingSettings,
  CfSendingSubdomain,
} from './types';

const PROVIDER = 'cloudflare';
const BASE = 'https://api.cloudflare.com/client/v4';

interface CfEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
  messages?: Array<{ code: number; message: string }>;
}

/**
 * GET/POST /zones/{id}/email/routing/dns returns a bare record array for the
 * zone apex, but a `{ errors, record }` query-response object for subdomain
 * requests (`errors` there lists missing/unpropagated records, not failures).
 */
type CfDnsResult = CfDnsRecord[] | { record?: CfDnsRecord[] } | null | undefined;

function normalizeDnsResult(result: CfDnsResult): CfDnsRecord[] {
  if (Array.isArray(result)) return result;
  return result?.record ?? [];
}

export class CloudflareApiClient {
  constructor(private readonly apiToken: string) {
    if (!apiToken) throw new ProviderConfigError(PROVIDER, 'apiToken');
  }

  // ---- zone-scoped: email routing settings ---------------------------------

  async enableRouting(zoneId: string): Promise<CfRoutingSettings> {
    return this.fetch<CfRoutingSettings>(`/zones/${zoneId}/email/routing/enable`, { method: 'POST' });
  }

  async disableRouting(zoneId: string): Promise<CfRoutingSettings> {
    return this.fetch<CfRoutingSettings>(`/zones/${zoneId}/email/routing/disable`, { method: 'POST' });
  }

  async getRoutingSettings(zoneId: string): Promise<CfRoutingSettings> {
    return this.fetch<CfRoutingSettings>(`/zones/${zoneId}/email/routing`);
  }

  // ---- zone-scoped: required DNS -------------------------------------------

  async getRoutingDns(zoneId: string, subdomain?: string): Promise<CfDnsRecord[]> {
    const qs = subdomain ? `?subdomain=${encodeURIComponent(subdomain)}` : '';
    const result = await this.fetch<CfDnsResult>(`/zones/${zoneId}/email/routing/dns${qs}`);
    return normalizeDnsResult(result);
  }

  /**
   * Re-create / refresh the locked MX + SPF records. Pass `name` (a FQDN
   * inside the zone, e.g. "sub.example.com") to register that subdomain for
   * Email Routing instead of the zone apex — the API behind the dashboard's
   * "Add subdomain" flow.
   */
  async configureRoutingDns(zoneId: string, name?: string): Promise<CfDnsRecord[]> {
    const result = await this.fetch<CfDnsResult>(`/zones/${zoneId}/email/routing/dns`, {
      method: 'POST',
      ...(name ? { body: JSON.stringify({ name }) } : {}),
    });
    return normalizeDnsResult(result);
  }

  // ---- zone-scoped: routing rules ------------------------------------------

  async listRoutingRules(zoneId: string): Promise<CfRoutingRule[]> {
    return this.fetch<CfRoutingRule[]>(`/zones/${zoneId}/email/routing/rules`);
  }

  async getRoutingRule(zoneId: string, ruleId: string): Promise<CfRoutingRule> {
    return this.fetch<CfRoutingRule>(`/zones/${zoneId}/email/routing/rules/${ruleId}`);
  }

  async createRoutingRule(zoneId: string, body: Omit<CfRoutingRule, 'id'>): Promise<CfRoutingRule> {
    return this.fetch<CfRoutingRule>(`/zones/${zoneId}/email/routing/rules`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async updateRoutingRule(zoneId: string, ruleId: string, body: Omit<CfRoutingRule, 'id'>): Promise<CfRoutingRule> {
    return this.fetch<CfRoutingRule>(`/zones/${zoneId}/email/routing/rules/${ruleId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  async deleteRoutingRule(zoneId: string, ruleId: string): Promise<void> {
    await this.fetch<unknown>(`/zones/${zoneId}/email/routing/rules/${ruleId}`, { method: 'DELETE' });
  }

  // ---- zone-scoped: catch-all ----------------------------------------------

  async getCatchAll(zoneId: string): Promise<CfRoutingRule> {
    return this.fetch<CfRoutingRule>(`/zones/${zoneId}/email/routing/rules/catch_all`);
  }

  async putCatchAll(
    zoneId: string,
    body: { name?: string; enabled: boolean; matchers: CfRoutingRule['matchers']; actions: CfRoutingRule['actions'] },
  ): Promise<CfRoutingRule> {
    return this.fetch<CfRoutingRule>(`/zones/${zoneId}/email/routing/rules/catch_all`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  // ---- zone-scoped: email sending subdomains -------------------------------
  //
  // Spec: https://developers.cloudflare.com/api/resources/email_sending
  // Separate from Email Routing. Authorises a domain (or subdomain of the
  // zone) for outbound sending via `/accounts/*/email/sending/send` and the
  // `[[send_email]]` Worker binding, and publishes the DKIM / return-path
  // records needed for deliverability.

  async listSendingSubdomains(zoneId: string): Promise<CfSendingSubdomain[]> {
    return this.fetch<CfSendingSubdomain[]>(`/zones/${zoneId}/email/sending/subdomains`);
  }

  async getSendingSubdomain(zoneId: string, subdomainTag: string): Promise<CfSendingSubdomain> {
    return this.fetch<CfSendingSubdomain>(`/zones/${zoneId}/email/sending/subdomains/${subdomainTag}`);
  }

  /**
   * Authorise `name` for outbound sending on this zone. `name` must be the
   * zone apex or a subdomain of the zone (e.g. "example.com" or
   * "send.example.com").
   */
  async createSendingSubdomain(zoneId: string, name: string): Promise<CfSendingSubdomain> {
    return this.fetch<CfSendingSubdomain>(`/zones/${zoneId}/email/sending/subdomains`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  async deleteSendingSubdomain(zoneId: string, subdomainTag: string): Promise<void> {
    await this.fetch<unknown>(`/zones/${zoneId}/email/sending/subdomains/${subdomainTag}`, { method: 'DELETE' });
  }

  async getSendingSubdomainDns(zoneId: string, subdomainTag: string): Promise<CfDnsRecord[]> {
    return this.fetch<CfDnsRecord[]>(`/zones/${zoneId}/email/sending/subdomains/${subdomainTag}/dns`);
  }

  // ---- account-scoped: destination addresses --------------------------------

  async listDestinationAddresses(
    accountId: string,
    options: { verified?: boolean; page?: number; per_page?: number } = {},
  ): Promise<CfDestinationAddress[]> {
    const params = new URLSearchParams();
    if (options.verified !== undefined) params.set('verified', String(options.verified));
    if (options.page) params.set('page', String(options.page));
    if (options.per_page) params.set('per_page', String(options.per_page));
    const qs = params.toString();
    return this.fetch<CfDestinationAddress[]>(
      `/accounts/${accountId}/email/routing/addresses${qs ? `?${qs}` : ''}`,
    );
  }

  async getDestinationAddress(accountId: string, addressId: string): Promise<CfDestinationAddress> {
    return this.fetch<CfDestinationAddress>(`/accounts/${accountId}/email/routing/addresses/${addressId}`);
  }

  /**
   * Enqueue a verification email to `email`. Cloudflare returns the
   * destination row immediately with `verified: null`; the recipient must
   * click the link before sends to that address will succeed.
   */
  async createDestinationAddress(accountId: string, email: string): Promise<CfDestinationAddress> {
    return this.fetch<CfDestinationAddress>(`/accounts/${accountId}/email/routing/addresses`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }

  async deleteDestinationAddress(accountId: string, addressId: string): Promise<void> {
    await this.fetch<unknown>(`/accounts/${accountId}/email/routing/addresses/${addressId}`, { method: 'DELETE' });
  }

  // ---- low level ----------------------------------------------------------

  private async fetch<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    let body: CfEnvelope<T>;
    try {
      body = text ? (JSON.parse(text) as CfEnvelope<T>) : ({ success: res.ok, result: undefined as unknown as T });
    } catch {
      throw new PermanentProviderError(`Cloudflare API ${res.status}: non-JSON body: ${text.slice(0, 200)}`, PROVIDER);
    }

    if (!res.ok || body.success === false) {
      const msg = body.errors?.map((e) => `${e.code}:${e.message}`).join('; ') || `HTTP ${res.status}`;
      const Err = res.status >= 500 || res.status === 429 ? TransientProviderError : PermanentProviderError;
      throw new Err(`Cloudflare API ${res.status}: ${msg}`, PROVIDER);
    }

    return body.result;
  }
}
