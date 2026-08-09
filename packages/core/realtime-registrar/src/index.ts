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

export type RegistrarFetch = typeof fetch;

export class RealtimeRegistrarError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly endpoint?: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'RealtimeRegistrarError';
  }
}

// ============================================================================
// Public types
// ============================================================================

export type DomainUnavailableReason =
  | 'domain_unavailable'
  | 'extension_not_supported'
  | 'domain_premium'
  | 'unknown';

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
 * Normalise a loose phone string into RTR's E164a form (`+cc.number`).
 * Returns null when we cannot produce a valid value.
 */
export function toE164a(phone: string | undefined | null): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (/^\+[0-9]{1,3}\.[0-9]{1,14}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/[^\d+]/g, '');
  const m = digits.match(/^\+?(\d{1,3})(\d{4,14})$/);
  if (!m) return null;
  return `+${m[1]}.${m[2]}`;
}

/**
 * Build a stable contact handle from contact fields (max 40 chars, RTR charset).
 */
export function contactHandleFrom(input: DomainContactInput, prefix = 'ws'): string {
  const raw = [
    prefix,
    (input.email ?? '').split('@')[0] ?? '',
    input.lastName ?? '',
    input.country ?? '',
  ]
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9\-_.@]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const base = raw.length >= 3 ? raw : `${prefix}-contact`;
  return base.slice(0, 40);
}

export function domainContactToCreateInput(
  handle: string,
  contact: DomainContactInput,
): CreateContactInput | null {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
  const address1 = (contact.address1 ?? '').trim();
  const voice = toE164a(contact.phone);
  if (
    !name ||
    !address1 ||
    !contact.postalCode ||
    !contact.city ||
    !contact.country ||
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
    country: contact.country.toUpperCase().slice(0, 2),
    email: contact.email.toLowerCase(),
    voice,
    organization: contact.organization,
    state: contact.state,
    fax: toE164a(contact.fax) ?? undefined,
  };
}

// ============================================================================
// Client
// ============================================================================

export class RealtimeRegistrar {
  private readonly apiKey: string;
  private readonly customer: string;
  private readonly baseURL: string;
  private readonly fetchImpl: RegistrarFetch;

  constructor({
    apiKey,
    customer,
    ote = false,
    baseURL,
    fetch: fetchImpl,
  }: {
    apiKey: string;
    customer: string;
    ote?: boolean;
    baseURL?: string;
    fetch?: RegistrarFetch;
  }) {
    this.apiKey = apiKey;
    this.customer = customer;
    this.baseURL =
      baseURL ??
      (ote ? 'https://api.yoursrs-ote.com/v2/' : 'https://api.yoursrs.com/v2/');
    this.fetchImpl = fetchImpl ?? fetch;
  }

  get customerHandle(): string {
    return this.customer;
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
      res = await this.fetchImpl(this.url(path, query), { ...rest, headers });
    } catch (err) {
      throw new RealtimeRegistrarError(
        0,
        'NETWORK_ERROR',
        `Realtime Register network error on ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
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
   * Fan-out availability checks across TLDs. RTR has no CF-style search; ADAC
   * is WebSocket-only and unsuitable for Workers.
   */
  async searchDomains(
    query: string,
    tlds: string[],
    limit = 20,
  ): Promise<DomainCheckResult[]> {
    const cleaned = query.trim().toLowerCase().replace(/\.$/, '');
    if (!cleaned) return [];

    const hasDot = cleaned.includes('.');
    const candidates: string[] = [];
    if (hasDot) {
      candidates.push(cleaned);
    } else {
      for (const tld of tlds) {
        const ext = tld.replace(/^\./, '').toLowerCase();
        candidates.push(`${cleaned}.${ext}`);
        if (candidates.length >= limit) break;
      }
    }

    const slice = candidates.slice(0, limit);
    const settled = await Promise.allSettled(slice.map((d) => this.checkDomain(d, { renewPrice: true })));
    const out: DomainCheckResult[] = [];
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i]!;
      if (s.status === 'fulfilled') {
        out.push(s.value);
      } else {
        out.push({
          name: slice[i]!,
          available: false,
          premium: false,
          reason: 'unknown',
        });
      }
    }
    // Available first, then name.
    return out.sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name));
  }

  async checkDomains(domains: string[]): Promise<DomainCheckResult[]> {
    const settled = await Promise.allSettled(
      domains.map((d) => this.checkDomain(d.toLowerCase(), { renewPrice: true })),
    );
    return settled.map((s, i) =>
      s.status === 'fulfilled'
        ? s.value
        : { name: domains[i]!, available: false, premium: false, reason: 'unknown' },
    );
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
        return {
          status: 'pending',
          processId: processId ?? 0,
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
    return {
      domainName: data.domainName ?? input.name,
      status: data.status,
      processId: data.processId ?? processId ?? 0,
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
      return { status: 'pending', processId: processId ?? 0, pollAfter: 5000 };
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
      return { status: 'pending', processId: processId ?? 0, pollAfter: 5000 };
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
      return { status: 'pending', processId: processId ?? 0, pollAfter: 3000 };
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
   */
  async pollProcess(processId: number): Promise<'completed' | 'pending' | 'failed'> {
    const info = await this.getProcess(processId);
    const s = (info.status ?? '').toLowerCase();
    if (['completed', 'complete', 'success', 'succeeded', 'ok', 'done'].includes(s)) {
      return 'completed';
    }
    if (['failed', 'error', 'cancelled', 'canceled', 'rejected', 'invalid'].includes(s)) {
      return 'failed';
    }
    return 'pending';
  }
}
