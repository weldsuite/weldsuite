/**
 * Realtime Register client.
 *
 * Thin fetch-based wrapper over the Realtime Register REST API
 * (https://dm.realtimeregister.com/docs/api/). The official npm SDK
 * (`@realtimeregister/api`) depends on axios, which is a poor fit for
 * Cloudflare Workers — this package mirrors the same endpoints with
 * injectable `fetch` so Workers and tests share one client.
 *
 * Auth: `Authorization: ApiKey <key>`
 * Base: prod `https://api.yoursrs.com/v2/` · OTE `https://api.yoursrs-ote.com/v2/`
 */

import { RealtimeRegistrarError } from './errors';
import {
  ADAC_REQUEST_TIMEOUT_MS,
  collapseAdacResults,
  postAdacAction,
} from './adac';
import { parseDomainPricelist, type DomainWholesalePrice } from './pricelist';

export type RegistrarFetch = typeof fetch;
export { RealtimeRegistrarError } from './errors';
export {
  parseDomainPricelist,
  centsToMajorUnits,
  missingDomainPricingFromPricelist,
  normalizeTld,
  type DomainWholesalePrice,
  type DomainPricingBackfillRow,
} from './pricelist';

// ============================================================================
// Public types
// ============================================================================

export type DomainUnavailableReason =
  | 'domain_unavailable'
  | 'extension_not_supported'
  | 'domain_premium'
  | 'check_failed'
  | 'unknown';

/** Default request timeout for Realtime Register HTTP calls. */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export interface DomainCheckResult {
  name: string;
  available: boolean;
  premium: boolean;
  /**
   * Wholesale registration/transfer price in **cents** when the API returns
   * one (premium domains). Standard TLD prices often omit this — callers
   * fall back to `domain_pricing`.
   */
  priceCents?: number;
  /** Wholesale renewal price in cents when provided. */
  renewalPriceCents?: number;
  currency?: string;
  reason?: DomainUnavailableReason | string;
}

export interface DomainContactInput {
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

export interface RegisteredDomain {
  id: string;
  name: string;
  status: string[];
  expiresAt?: string;
  autoRenew: boolean;
  locked: boolean;
  privacyProtect: boolean;
  authCode?: string;
  nameservers?: string[];
  registrant?: string;
}

export type ProcessResult =
  | { status: 'completed'; domain: RegisteredDomain; processId?: number }
  | { status: 'pending'; processId: number; pollAfter: number }
  | { status: 'failed'; code: string; message: string; processId?: number };

export interface RegisterInput {
  name: string;
  registrant: string;
  contacts?: Array<{ role: 'ADMIN' | 'BILLING' | 'TECH'; handle: string }>;
  nameservers?: string[];
  autoRenew?: boolean;
  privacyProtect?: boolean;
  /** Registration period in months (RTR uses months, not years). */
  periodMonths?: number;
  authCode?: string;
  billables?: Array<{ product: string; action: string; quantity?: number }>;
}

export interface TransferInput {
  name: string;
  registrant: string;
  authCode?: string;
  contacts?: Array<{ role: 'ADMIN' | 'BILLING' | 'TECH'; handle: string }>;
  nameservers?: string[];
  autoRenew?: boolean;
  privacyProtect?: boolean;
  periodMonths?: number;
  designatedAgent?: 'NONE' | 'OLD' | 'NEW' | 'BOTH';
  billables?: Array<{ product: string; action: string; quantity?: number }>;
}

export interface TransferResult {
  domainName: string;
  status: string;
  processId: number;
  type: 'IN' | 'OUT';
  requestedDate?: string;
  expiryDate?: string;
}

export interface UpdateDomainInput {
  autoRenew?: boolean;
  privacyProtect?: boolean;
  /** When set, replaces the domain status list (used for transfer lock). */
  status?: string[];
  nameservers?: string[];
  authCode?: string;
  registrant?: string;
}

export interface CreateContactInput {
  handle: string;
  name: string;
  addressLine: string[];
  postalCode: string;
  city: string;
  country: string;
  email: string;
  /** E.164a, e.g. `+31.384530759` */
  voice: string;
  organization?: string;
  state?: string;
  fax?: string;
}

export interface ProcessInfo {
  id: number;
  status: string;
  action?: string;
  identifier?: string;
  message?: string;
}

export interface QuoteBillable {
  product: string;
  action: string;
  quantity?: number;
  price?: number;
  currency?: string;
}

// ============================================================================
// Helpers
// ============================================================================

const TRANSFER_LOCK_STATUSES = new Set([
  'CLIENT_TRANSFER_PROHIBITED',
  'SERVER_TRANSFER_PROHIBITED',
  'REGISTRAR_TRANSFER_PROHIBITED',
]);

function isLocked(status: string[] | undefined): boolean {
  return (status ?? []).some((s) => TRANSFER_LOCK_STATUSES.has(s));
}

function mapCheck(name: string, data: {
  available?: boolean;
  reason?: string;
  premium?: boolean;
  currency?: string;
  price?: number;
  renewPrice?: number;
  renewprice?: number;
}): DomainCheckResult {
  return {
    name,
    available: Boolean(data.available),
    premium: Boolean(data.premium),
    priceCents: typeof data.price === 'number' ? data.price : undefined,
    renewalPriceCents:
      typeof data.renewPrice === 'number'
        ? data.renewPrice
        : typeof data.renewprice === 'number'
          ? data.renewprice
          : undefined,
    currency: data.currency,
    reason: data.available
      ? undefined
      : (data.reason ?? (data.premium ? 'domain_premium' : 'domain_unavailable')),
  };
}

function adacToCheckResult(r: {
  name: string;
  available: boolean;
  premium: boolean;
  priceCents?: number;
  currency?: string;
  reason?: string;
}): DomainCheckResult {
  return {
    name: r.name,
    available: r.available,
    premium: r.premium,
    priceCents: r.priceCents,
    currency: r.currency,
    reason: r.reason,
  };
}

function mapDomain(data: {
  domainName: string;
  status?: string[];
  expiryDate?: string;
  autoRenew?: boolean;
  privacyProtect?: boolean;
  authcode?: string;
  ns?: string[];
  registrant?: string;
}): RegisteredDomain {
  const status = data.status ?? [];
  return {
    id: data.domainName,
    name: data.domainName,
    status,
    expiresAt: data.expiryDate,
    autoRenew: data.autoRenew ?? true,
    locked: isLocked(status),
    privacyProtect: Boolean(data.privacyProtect),
    authCode: data.authcode,
    nameservers: data.ns,
    registrant: data.registrant,
  };
}

/**
 * ISO 3166-1 alpha-2 → ITU calling code. Used to format RTR E164a phones
 * (`+cc.national`) without pulling in a full phone-number library.
 * Cover the markets WeldHost targets; unknown countries return null.
 */
const CALLING_CODES: Record<string, string> = {
  US: '1', CA: '1',
  NL: '31', BE: '32', DE: '49', FR: '33', GB: '44', IE: '353',
  LU: '352', AT: '43', CH: '41', ES: '34', IT: '39', PT: '351',
  SE: '46', NO: '47', DK: '45', FI: '358', PL: '48', CZ: '420',
  AU: '61', NZ: '64', IN: '91', SG: '65', JP: '81', KR: '82',
  BR: '55', MX: '52', ZA: '27', AE: '971',
};

/**
 * Normalise a phone into RTR's E164a form (`+cc.nationalNumber`).
 * Prefer an already-dotted E164a value; otherwise require `countryCode`
 * (ISO alpha-2) so the calling code is not guessed from digit length.
 */
export function toE164a(
  phone: string | undefined | null,
  countryCode?: string | null,
): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (/^\+[0-9]{1,3}\.[0-9]{1,14}$/.test(trimmed)) return trimmed;

  const cc = countryCode?.toUpperCase().slice(0, 2);
  const calling = cc ? CALLING_CODES[cc] : undefined;
  if (!calling) return null;

  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  // Strip a leading country calling code or a single trunk `0`.
  let national = digits;
  if (national.startsWith(calling)) {
    national = national.slice(calling.length);
  } else if (national.startsWith('0')) {
    national = national.replace(/^0+/, '');
  }
  if (national.length < 4 || national.length > 14) return null;
  return `+${calling}.${national}`;
}

/** Deterministic short fingerprint so distinct contacts cannot collide on handle. */
function contactFingerprint(input: DomainContactInput): string {
  const payload = [
    input.email,
    input.firstName,
    input.lastName,
    input.organization,
    input.phone,
    input.address1,
    input.address2,
    input.city,
    input.state,
    input.postalCode,
    input.country,
  ]
    .map((v) => (v ?? '').trim().toLowerCase())
    .join('|');
  let hash = 5381;
  for (let i = 0; i < payload.length; i++) {
    hash = ((hash << 5) + hash) ^ payload.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Build a stable contact handle from contact fields (max 40 chars, RTR charset).
 * Includes a fingerprint of the full contact so matching email local-part +
 * last name + country cannot overwrite another registrant.
 */
export function contactHandleFrom(input: DomainContactInput, prefix = 'ws'): string {
  const fingerprint = contactFingerprint(input);
  const raw = [
    prefix,
    (input.email ?? '').split('@')[0] ?? '',
    input.lastName ?? '',
    input.country ?? '',
    fingerprint,
  ]
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9\-_.@]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const base = raw.length >= 3 ? raw : `${prefix}-contact-${fingerprint}`;
  return base.slice(0, 40);
}

export function domainContactToCreateInput(
  handle: string,
  contact: DomainContactInput,
): CreateContactInput | null {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
  const address1 = (contact.address1 ?? '').trim();
  const country = contact.country?.toUpperCase().slice(0, 2);
  const voice = toE164a(contact.phone, country);
  if (
    !name ||
    !address1 ||
    !contact.postalCode ||
    !contact.city ||
    !country ||
    !contact.email ||
    !voice
  ) {
    return null;
  }
  const addressLine = [address1];
  if (contact.address2?.trim()) addressLine.push(contact.address2.trim());
  return {
    handle,
    name,
    addressLine,
    postalCode: contact.postalCode,
    city: contact.city,
    country,
    email: contact.email.toLowerCase(),
    voice,
    organization: contact.organization,
    state: contact.state,
    fax: toE164a(contact.fax, country) ?? undefined,
  };
}

// ============================================================================
// Client
// ============================================================================

export class RealtimeRegistrar {
  private readonly apiKey: string;
  private readonly customer: string;
  private readonly adacApiKey: string | undefined;
  private readonly adacTldSetToken: string | undefined;
  private readonly baseURL: string;
  private readonly fetchImpl: RegistrarFetch;
  private readonly timeoutMs: number;

  constructor({
    apiKey,
    customer,
    ote = false,
    baseURL,
    fetch: fetchImpl,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    adacApiKey,
    adacTldSetToken,
  }: {
    apiKey: string;
    customer: string;
    ote?: boolean;
    baseURL?: string;
    fetch?: RegistrarFetch;
    timeoutMs?: number;
    /** ADAC-only key from the ADAC management panel — not the registrar API key. */
    adacApiKey?: string;
    /** Optional TLD-set token from the ADAC panel. Omit to use the account default. */
    adacTldSetToken?: string;
  }) {
    this.apiKey = apiKey.trim();
    this.customer = customer.trim();
    this.adacApiKey = adacApiKey?.trim() || undefined;
    this.adacTldSetToken = adacTldSetToken?.trim() || undefined;
    this.baseURL =
      baseURL ??
      (ote ? 'https://api.yoursrs-ote.com/v2/' : 'https://api.yoursrs.com/v2/');
    this.fetchImpl = fetchImpl ?? fetch;
    this.timeoutMs = timeoutMs;
  }

  get customerHandle(): string {
    return this.customer;
  }

  get hasAdac(): boolean {
    return Boolean(this.adacApiKey);
  }

  private requireAdac(): string {
    if (!this.adacApiKey) {
      throw new RealtimeRegistrarError(
        503,
        'ADAC_NOT_CONFIGURED',
        'Realtime Register ADAC is not configured',
        'adac',
      );
    }
    return this.adacApiKey;
  }

  private url(path: string, query?: Record<string, string | boolean | number | undefined>): string {
    const base = this.baseURL.endsWith('/') ? this.baseURL : `${this.baseURL}/`;
    const u = new URL(path.replace(/^\//, ''), base);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  private async request<T>(
    endpoint: string,
    path: string,
    init: RequestInit & { query?: Record<string, string | boolean | number | undefined> } = {},
  ): Promise<{ data: T; status: number; processId?: number }> {
    const { query, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `ApiKey ${this.apiKey}`);
    }
    if (rest.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    let res: Response;
    try {
      const signal =
        rest.signal ??
        (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
          ? AbortSignal.timeout(this.timeoutMs)
          : undefined);
      res = await this.fetchImpl(this.url(path, query), { ...rest, headers, signal });
    } catch (err) {
      const aborted =
        (err instanceof Error && err.name === 'AbortError') ||
        (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'TimeoutError');
      throw new RealtimeRegistrarError(
        0,
        aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
        `Realtime Register ${aborted ? 'timeout' : 'network error'} on ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
        endpoint,
      );
    }

    const processHeader = res.headers.get('X-Process-Id') ?? res.headers.get('x-process-id');
    const processId = processHeader ? Number.parseInt(processHeader, 10) : undefined;

    const text = await res.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }

    if (!res.ok) {
      const errBody = body as { type?: string; message?: string; title?: string } | undefined;
      const code = errBody?.type ?? `HTTP_${res.status}`;
      const message =
        errBody?.message ??
        errBody?.title ??
        (typeof body === 'string' && body ? body : `Realtime Register ${res.status} on ${endpoint}`);
      throw new RealtimeRegistrarError(res.status, code, message, endpoint, body);
    }

    return {
      data: body as T,
      status: res.status,
      processId: Number.isFinite(processId) ? processId : undefined,
    };
  }

  // ---------- check / search ----------

  async checkDomain(name: string, opts?: { renewPrice?: boolean }): Promise<DomainCheckResult> {
    const { data } = await this.request<Parameters<typeof mapCheck>[1]>(
      'domain-check',
      `domains/${encodeURIComponent(name)}/check`,
      { method: 'GET', query: { renewPrice: opts?.renewPrice ? true : undefined } },
    );
    return mapCheck(name, data ?? {});
  }

  /**
   * Wholesale TLD prices for this customer (`GET /v2/customers/{handle}/pricelist`).
   * Used by the admin catalog backfill — search/checkout read `domain_pricing`,
   * not this endpoint.
   */
  async getPricelist(currency = 'EUR'): Promise<Map<string, DomainWholesalePrice>> {
    const { data } = await this.request<{ prices?: Array<{ product?: string; action?: string; currency?: string; price?: number }> }>(
      'pricelist',
      `customers/${encodeURIComponent(this.customer)}/pricelist`,
      { method: 'GET', query: { currency } },
    );
    return parseDomainPricelist(data.prices);
  }

  /**
   * ADAC `input` action — one POST returns TLD-set availability + suggestions.
   * `tlds` is accepted for call-site compatibility and used only as a suffix
   * filter when non-empty (ADAC already expands the query across its TLD set).
   */
  async searchDomains(
    query: string,
    tlds: string[] = [],
    limit = 20,
  ): Promise<DomainCheckResult[]> {
    const cleaned = query.trim().toLowerCase().replace(/\.$/, '');
    if (!cleaned) return [];

    const events = await postAdacAction(this.fetchImpl, {
      apiKey: this.requireAdac(),
      action: 'input',
      input: cleaned,
      tldSetToken: this.adacTldSetToken,
      timeoutMs: Math.max(this.timeoutMs, ADAC_REQUEST_TIMEOUT_MS),
    });
    let results = collapseAdacResults(events).map(adacToCheckResult);

    const suffixes = new Set(
      tlds.map((t) => t.replace(/^\./, '').toLowerCase()).filter(Boolean),
    );
    if (suffixes.size > 0) {
      results = results.filter((r) => suffixes.has(r.name.split('.').slice(1).join('.')));
    }

    return results
      .slice(0, limit)
      .sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name));
  }

  /**
   * ADAC `check` action per domain (single-name availability, including premium
   * price when ADAC returns one). Falls back to the registrar REST check when
   * ADAC is not configured.
   */
  async checkDomains(domains: string[]): Promise<DomainCheckResult[]> {
    const names = domains.map((d) => d.trim().toLowerCase()).filter(Boolean);
    if (names.length === 0) return [];

    if (!this.adacApiKey) {
      return this.checkDomainsViaRest(names);
    }

    const concurrency = 5;
    const out: DomainCheckResult[] = new Array(names.length);
    for (let i = 0; i < names.length; i += concurrency) {
      const batch = names.slice(i, i + concurrency);
      const settled = await Promise.allSettled(batch.map((d) => this.adacCheck(d)));
      for (let j = 0; j < settled.length; j++) {
        const s = settled[j]!;
        out[i + j] =
          s.status === 'fulfilled'
            ? s.value
            : {
                name: batch[j]!,
                available: false,
                premium: false,
                reason: 'check_failed',
              };
      }
    }
    return out;
  }

  private async adacCheck(name: string): Promise<DomainCheckResult> {
    const events = await postAdacAction(this.fetchImpl, {
      apiKey: this.requireAdac(),
      action: 'check',
      input: name,
      timeoutMs: Math.max(this.timeoutMs, ADAC_REQUEST_TIMEOUT_MS),
    });
    const [result] = collapseAdacResults(events);
    if (!result) {
      throw new RealtimeRegistrarError(
        502,
        'ADAC_EMPTY',
        `ADAC returned no status for ${name}`,
        'adac',
      );
    }
    return adacToCheckResult(result);
  }

  private async checkDomainsViaRest(names: string[]): Promise<DomainCheckResult[]> {
    const concurrency = 5;
    const out: DomainCheckResult[] = new Array(names.length);
    for (let i = 0; i < names.length; i += concurrency) {
      const batch = names.slice(i, i + concurrency);
      const settled = await Promise.allSettled(
        batch.map((d) => this.checkDomain(d, { renewPrice: true })),
      );
      for (let j = 0; j < settled.length; j++) {
        const s = settled[j]!;
        out[i + j] =
          s.status === 'fulfilled'
            ? s.value
            : {
                name: batch[j]!,
                available: false,
                premium: false,
                reason: 'check_failed',
              };
      }
    }
    return out;
  }

  // ---------- domains ----------

  async getDomain(name: string): Promise<RegisteredDomain> {
    const { data } = await this.request<Parameters<typeof mapDomain>[0]>(
      'domain-get',
      `domains/${encodeURIComponent(name)}`,
      { method: 'GET' },
    );
    return mapDomain(data);
  }

  /**
   * Fetch the EPP authcode for a domain we manage. Tries the domain get
   * response first, then the registry info call with `type=AUTHCODE`
   * (available on gateway accounts / registries that expose it).
   */
  async getAuthCode(name: string): Promise<string | null> {
    const domain = await this.getDomain(name);
    if (domain.authCode) return domain.authCode;
    try {
      const { data } = await this.request<{ authcode?: string }>(
        'domain-info-authcode',
        `domains/${encodeURIComponent(name)}/info`,
        { method: 'GET', query: { type: 'AUTHCODE' } },
      );
      return data.authcode ?? null;
    } catch (err) {
      if (err instanceof RealtimeRegistrarError && (err.status === 404 || err.status === 400)) {
        return null;
      }
      throw err;
    }
  }

  private requireProcessId(
    processId: number | undefined,
    endpoint: string,
  ): ProcessResult | { ok: true; processId: number } {
    if (processId !== undefined && Number.isFinite(processId) && processId > 0) {
      return { ok: true, processId };
    }
    return {
      status: 'failed',
      code: 'MISSING_PROCESS_ID',
      message: `Realtime Register returned an async response on ${endpoint} without an X-Process-Id`,
    };
  }

  async register(input: RegisterInput): Promise<ProcessResult> {
    const body = {
      customer: this.customer,
      registrant: input.registrant,
      contacts: input.contacts,
      period: input.periodMonths,
      ns: input.nameservers,
      privacyProtect: input.privacyProtect,
      autoRenew: input.autoRenew,
      authcode: input.authCode,
      billables: input.billables,
    };
    try {
      const { data, status, processId } = await this.request<{
        domainName?: string;
        expiryDate?: string;
        status?: string[];
      }>('domain-register', `domains/${encodeURIComponent(input.name)}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (status === 202 || processId) {
        const required = this.requireProcessId(processId, 'domain-register');
        if ('status' in required) return required;
        return {
          status: 'pending',
          processId: required.processId,
          pollAfter: 5000,
        };
      }

      const domain = mapDomain({
        domainName: data.domainName ?? input.name,
        status: data.status,
        expiryDate: data.expiryDate,
        autoRenew: input.autoRenew,
        privacyProtect: input.privacyProtect,
      });
      return { status: 'completed', domain, processId };
    } catch (err) {
      if (err instanceof RealtimeRegistrarError && err.code === 'BillableAcknowledgmentNeededException') {
        // Caller should quote + retry with billables; surface as failed with code.
        return {
          status: 'failed',
          code: err.code,
          message: err.message,
        };
      }
      throw err;
    }
  }

  /**
   * Quote a registration (validate + billables) without executing it.
   */
  async quoteRegister(input: RegisterInput): Promise<{ billables: QuoteBillable[] }> {
    const body = {
      customer: this.customer,
      registrant: input.registrant,
      contacts: input.contacts,
      period: input.periodMonths,
      ns: input.nameservers,
      privacyProtect: input.privacyProtect,
      autoRenew: input.autoRenew,
    };
    const { data } = await this.request<{ quote?: { billables?: QuoteBillable[] }; billables?: QuoteBillable[] }>(
      'domain-register-quote',
      `domains/${encodeURIComponent(input.name)}`,
      {
        method: 'POST',
        query: { quote: true },
        body: JSON.stringify(body),
      },
    );
    return { billables: data.quote?.billables ?? data.billables ?? [] };
  }

  async transfer(input: TransferInput): Promise<TransferResult> {
    const body = {
      customer: this.customer,
      registrant: input.registrant,
      contacts: input.contacts,
      period: input.periodMonths,
      ns: input.nameservers,
      privacyProtect: input.privacyProtect,
      autoRenew: input.autoRenew,
      authcode: input.authCode,
      designatedAgent: input.designatedAgent,
      billables: input.billables,
    };
    const { data, processId } = await this.request<{
      domainName: string;
      status: string;
      processId?: number;
      type?: 'IN' | 'OUT';
      requestedDate?: string;
      expiryDate?: string;
    }>('domain-transfer', `domains/${encodeURIComponent(input.name)}/transfer`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const resolvedId = data.processId ?? processId;
    if (resolvedId === undefined || !Number.isFinite(resolvedId) || resolvedId <= 0) {
      throw new RealtimeRegistrarError(
        502,
        'MISSING_PROCESS_ID',
        'Realtime Register transfer response did not include a process id',
        'domain-transfer',
      );
    }
    return {
      domainName: data.domainName ?? input.name,
      status: data.status,
      processId: resolvedId,
      type: data.type ?? 'IN',
      requestedDate: data.requestedDate,
      expiryDate: data.expiryDate,
    };
  }

  async renew(
    name: string,
    periodMonths: number,
    opts?: { billables?: Array<{ product: string; action: string; quantity?: number }>; expiryDate?: string },
  ): Promise<ProcessResult> {
    const { data, status, processId } = await this.request<{
      domainName?: string;
      expiryDate?: string;
      status?: string[];
    }>('domain-renew', `domains/${encodeURIComponent(name)}/renew`, {
      method: 'POST',
      body: JSON.stringify({
        period: periodMonths,
        billables: opts?.billables,
        expiryDate: opts?.expiryDate,
      }),
    });
    if (status === 202 || (processId && status !== 200 && status !== 201)) {
      const required = this.requireProcessId(processId, 'domain-renew');
      if ('status' in required) return required;
      return { status: 'pending', processId: required.processId, pollAfter: 5000 };
    }
    return {
      status: 'completed',
      domain: mapDomain({
        domainName: data.domainName ?? name,
        status: data.status,
        expiryDate: data.expiryDate,
      }),
      processId,
    };
  }

  async restore(name: string, reason: string): Promise<ProcessResult> {
    const { processId, status } = await this.request<unknown>(
      'domain-restore',
      `domains/${encodeURIComponent(name)}/restore`,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      },
    );
    if (status === 202 || processId) {
      const required = this.requireProcessId(processId, 'domain-restore');
      if ('status' in required) return required;
      return { status: 'pending', processId: required.processId, pollAfter: 5000 };
    }
    const domain = await this.getDomain(name);
    return { status: 'completed', domain, processId };
  }

  async updateDomain(name: string, update: UpdateDomainInput): Promise<ProcessResult> {
    const body: Record<string, unknown> = {};
    if (update.autoRenew !== undefined) body.autoRenew = update.autoRenew;
    if (update.privacyProtect !== undefined) body.privacyProtect = update.privacyProtect;
    if (update.status !== undefined) body.status = update.status;
    if (update.nameservers !== undefined) body.ns = update.nameservers;
    if (update.authCode !== undefined) body.authcode = update.authCode;
    if (update.registrant !== undefined) body.registrant = update.registrant;

    const { status, processId } = await this.request<unknown>(
      'domain-update',
      `domains/${encodeURIComponent(name)}/update`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
    if (status === 202 || processId) {
      const required = this.requireProcessId(processId, 'domain-update');
      if ('status' in required) return required;
      return { status: 'pending', processId: required.processId, pollAfter: 3000 };
    }
    const domain = await this.getDomain(name);
    return { status: 'completed', domain, processId };
  }

  /**
   * Toggle transfer lock via CLIENT_TRANSFER_PROHIBITED status.
   */
  async setTransferLock(name: string, locked: boolean): Promise<void> {
    const current = await this.getDomain(name);
    const without = current.status.filter((s) => s !== 'CLIENT_TRANSFER_PROHIBITED');
    const next = locked ? [...without, 'CLIENT_TRANSFER_PROHIBITED'] : without;
    await this.updateDomain(name, { status: next });
  }

  // ---------- contacts ----------

  async getContact(handle: string): Promise<Record<string, unknown>> {
    const { data } = await this.request<Record<string, unknown>>(
      'contact-get',
      `customers/${encodeURIComponent(this.customer)}/contacts/${encodeURIComponent(handle)}`,
      { method: 'GET' },
    );
    return data;
  }

  async createContact(input: CreateContactInput): Promise<void> {
    await this.request(
      'contact-create',
      `customers/${encodeURIComponent(this.customer)}/contacts/${encodeURIComponent(input.handle)}`,
      {
        method: 'POST',
        body: JSON.stringify({
          handle: input.handle,
          name: input.name,
          organization: input.organization,
          addressLine: input.addressLine,
          postalCode: input.postalCode,
          city: input.city,
          state: input.state,
          country: input.country,
          email: input.email,
          voice: input.voice,
          fax: input.fax,
        }),
      },
    );
  }

  async updateContact(handle: string, input: Omit<CreateContactInput, 'handle'>): Promise<void> {
    await this.request(
      'contact-update',
      `customers/${encodeURIComponent(this.customer)}/contacts/${encodeURIComponent(handle)}/update`,
      {
        method: 'POST',
        body: JSON.stringify({
          name: input.name,
          organization: input.organization,
          addressLine: input.addressLine,
          postalCode: input.postalCode,
          city: input.city,
          state: input.state,
          country: input.country,
          email: input.email,
          voice: input.voice,
          fax: input.fax,
        }),
      },
    );
  }

  /**
   * Create the contact if missing; update if it already exists.
   */
  async ensureContact(input: CreateContactInput): Promise<string> {
    try {
      await this.createContact(input);
      return input.handle;
    } catch (err) {
      if (
        err instanceof RealtimeRegistrarError &&
        (err.status === 409 ||
          err.code === 'ObjectExists' ||
          err.code.includes('ObjectExists') ||
          err.code.includes('Exists'))
      ) {
        try {
          await this.updateContact(input.handle, input);
        } catch (updateErr) {
          // Contact exists and update failed — still usable as handle.
          console.warn('[realtime-registrar] contact update after exists failed:', updateErr);
        }
        return input.handle;
      }
      throw err;
    }
  }

  /**
   * Ensure a registrant contact from WeldHost DomainContact JSON. Returns null
   * when the contact is too incomplete to satisfy RTR's required fields.
   */
  async ensureRegistrantFromDomainContact(
    contact: DomainContactInput,
    handlePrefix = 'ws',
  ): Promise<string | null> {
    const handle = contactHandleFrom(contact, handlePrefix);
    const create = domainContactToCreateInput(handle, contact);
    if (!create) return null;
    return this.ensureContact(create);
  }

  // ---------- processes ----------

  async getProcess(processId: number): Promise<ProcessInfo> {
    const { data } = await this.request<{
      id: number;
      status: string;
      action?: string;
      identifier?: string;
      message?: string;
    }>('process-get', `processes/${processId}`, { method: 'GET' });
    return {
      id: data.id ?? processId,
      status: data.status,
      action: data.action,
      identifier: data.identifier,
      message: data.message,
    };
  }

  /**
   * Map a process status into a coarse completed/pending/failed result.
   *
   * Documented RTR statuses: NEW, VALIDATED, RUNNING, COMPLETED, INVALID,
   * CANCELLED, FAILED, IN_DOUBT, SCHEDULED, SUSPENDED.
   */
  async pollProcess(processId: number): Promise<'completed' | 'pending' | 'failed'> {
    const info = await this.getProcess(processId);
    const s = (info.status ?? '').toUpperCase();
    if (s === 'COMPLETED') return 'completed';
    if (s === 'FAILED' || s === 'INVALID' || s === 'CANCELLED' || s === 'IN_DOUBT') {
      return 'failed';
    }
    if (
      s === 'NEW' ||
      s === 'VALIDATED' ||
      s === 'RUNNING' ||
      s === 'SCHEDULED' ||
      s === 'SUSPENDED'
    ) {
      return 'pending';
    }
    console.warn(`[realtime-registrar] Unknown process status "${info.status}" for ${processId}`);
    return 'pending';
  }
}
