/**
 * Cloudflare Registrar API Client (Beta, April 2026)
 *
 * Shared package so both app-api and billing-worker can use the same
 * typed wrapper without cross-worker imports.
 *
 * Docs: https://developers.cloudflare.com/registrar/
 * Base: https://api.cloudflare.com/client/v4
 */

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

// ============================================================================
// Error type
// ============================================================================

export class CloudflareApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly errors?: { code: number; message: string }[],
  ) {
    super(message);
    this.name = 'CloudflareApiError';
  }
}

// ============================================================================
// Internal API types
// ============================================================================

interface CfApiResponse<T = unknown> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

interface CfDomainSearchResult {
  name: string;
  available: boolean;
  premium: boolean;
  price?: number;
  currency?: string;
}

interface CfDomainCheckResult {
  name: string;
  available: boolean;
  premium: boolean;
  price?: number;
  currency?: string;
}

interface CfRegistrationResult {
  id: string;
  name: string;
  status: string;
  expires_at?: string;
  auto_renew: boolean;
  locked: boolean;
  registrant_contact?: Record<string, unknown>;
}

interface CfDomain {
  id: string;
  name: string;
  status: string;
  expires_at?: string;
  auto_renew: boolean;
  locked: boolean;
  name_servers?: string[];
  registrant_contact?: Record<string, unknown>;
}

// ============================================================================
// Public output types
// ============================================================================

export interface DomainSearchResult {
  name: string;
  available: boolean;
  premium: boolean;
  price?: number;
  currency?: string;
}

export interface DomainCheckResult {
  name: string;
  available: boolean;
  premium: boolean;
  price?: number;
  currency?: string;
}

export interface RegisteredDomain {
  id: string;
  name: string;
  status: string;
  expiresAt?: string;
  autoRenew: boolean;
  locked: boolean;
  nameservers?: string[];
  registrantContact?: Record<string, unknown>;
}

export type RegisterResult =
  | { status: 'completed'; domain: RegisteredDomain }
  | { status: 'pending'; workflowUrl: string; pollAfter: number };

export interface RegisterInput {
  name: string;
  contact?: {
    firstName?: string;
    lastName?: string;
    organization?: string;
    email?: string;
    phone?: string;
    address1?: string;
    address2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
  autoRenew?: boolean;
  years?: number;
}

export interface UpdateDomainInput {
  autoRenew?: boolean;
  locked?: boolean;
}

// ============================================================================
// HTTP helper
// ============================================================================

async function cfFetch<T>(
  apiToken: string,
  path: string,
  options: RequestInit = {},
): Promise<{ status: number; body: CfApiResponse<T>; headers: Headers }> {
  const res = await fetch(`${CF_API_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const body = (await res.json()) as CfApiResponse<T>;

  if (!res.ok && res.status !== 202) {
    const firstError = body.errors?.[0];
    throw new CloudflareApiError(
      res.status,
      firstError ? String(firstError.code) : 'CF_ERROR',
      firstError?.message ?? `Cloudflare API error ${res.status}`,
      body.errors,
    );
  }

  return { status: res.status, body, headers: res.headers };
}

function mapDomain(d: CfDomain): RegisteredDomain {
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    expiresAt: d.expires_at,
    autoRenew: d.auto_renew,
    locked: d.locked,
    nameservers: d.name_servers,
    registrantContact: d.registrant_contact,
  };
}

// ============================================================================
// Client class
// ============================================================================

export class CloudflareRegistrar {
  private readonly accountId: string;
  private readonly apiToken: string;

  constructor({ accountId, apiToken }: { accountId: string; apiToken: string }) {
    this.accountId = accountId;
    this.apiToken = apiToken;
  }

  private get base(): string {
    return `/accounts/${this.accountId}/registrar`;
  }

  /**
   * GET /accounts/{accountId}/registrar/domain-search
   * Suggestion-style search. Results are scoped to the TLDs Cloudflare exposes
   * through the API, which is narrower than the dashboard's catalogue — expect
   * fewer extensions here than a customer would see on cloudflare.com.
   * Prices are indicative; use {@link checkDomains} before taking payment.
   */
  async searchDomains(query: string, limit = 20): Promise<DomainSearchResult[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    const { body } = await cfFetch<CfDomainSearchResult[]>(
      this.apiToken,
      `${this.base}/domain-search?${params}`,
    );
    return (body.result ?? []).map((r) => ({
      name: r.name,
      available: r.available,
      premium: r.premium,
      price: r.price,
      currency: r.currency,
    }));
  }

  /**
   * POST /accounts/{accountId}/registrar/domain-check
   * Authoritative availability + price. Body: { domains: string[] } (≤ 20).
   */
  async checkDomains(domains: string[]): Promise<DomainCheckResult[]> {
    const { body } = await cfFetch<CfDomainCheckResult[]>(
      this.apiToken,
      `${this.base}/domain-check`,
      { method: 'POST', body: JSON.stringify({ domains }) },
    );
    return (body.result ?? []).map((r) => ({
      name: r.name,
      available: r.available,
      premium: r.premium,
      price: r.price,
      currency: r.currency,
    }));
  }

  /**
   * POST /accounts/{accountId}/registrar/registrations
   * Returns a discriminated union:
   *   - { status: 'completed', domain } when CF replies 200/201 synchronously
   *   - { status: 'pending', workflowUrl, pollAfter } when CF replies 202
   */
  async register(input: RegisterInput): Promise<RegisterResult> {
    const payload: Record<string, unknown> = { name: input.name };
    if (input.contact) payload.contact = input.contact;
    if (input.autoRenew !== undefined) payload.auto_renew = input.autoRenew;
    if (input.years !== undefined) payload.years = input.years;

    const { status, body, headers } = await cfFetch<CfRegistrationResult>(
      this.apiToken,
      `${this.base}/registrations`,
      { method: 'POST', body: JSON.stringify(payload) },
    );

    if (status === 202) {
      const workflowUrl =
        headers.get('Location') ??
        (body as unknown as { workflow_url?: string }).workflow_url ??
        '';
      const retryAfterHeader = headers.get('Retry-After');
      const pollAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 5000;
      return { status: 'pending', workflowUrl, pollAfter };
    }

    return { status: 'completed', domain: mapDomain(body.result as CfDomain) };
  }

  /**
   * GET /accounts/{accountId}/registrar/domains
   */
  async listDomains(): Promise<RegisteredDomain[]> {
    const { body } = await cfFetch<CfDomain[]>(this.apiToken, `${this.base}/domains`);
    return (body.result ?? []).map(mapDomain);
  }

  /**
   * GET /accounts/{accountId}/registrar/domains/{name}
   */
  async getDomain(name: string): Promise<RegisteredDomain> {
    const { body } = await cfFetch<CfDomain>(
      this.apiToken,
      `${this.base}/domains/${encodeURIComponent(name)}`,
    );
    return mapDomain(body.result);
  }

  /**
   * PUT /accounts/{accountId}/registrar/domains/{name}
   * Only `auto_renew` and `locked` are mutable. Cloudflare Registrar exposes
   * no API for transfers, explicit renewal, or contact/WHOIS updates.
   */
  async updateDomain(name: string, update: UpdateDomainInput): Promise<RegisteredDomain> {
    const payload: Record<string, unknown> = {};
    if (update.autoRenew !== undefined) payload.auto_renew = update.autoRenew;
    if (update.locked !== undefined) payload.locked = update.locked;

    const { body } = await cfFetch<CfDomain>(
      this.apiToken,
      `${this.base}/domains/${encodeURIComponent(name)}`,
      { method: 'PUT', body: JSON.stringify(payload) },
    );
    return mapDomain(body.result);
  }
}
