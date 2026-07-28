/**
 * Cloudflare Registrar client.
 *
 * Thin wrapper over the official `cloudflare` SDK so routes, parameter names
 * and response shapes come from Cloudflare's own generated types rather than
 * from hand-written string paths. The previous hand-rolled version decoded a
 * payload Cloudflare never sent (`result` as a flat array of
 * `{ available, premium, price }`) and posted `name`/`contact` to the
 * registration endpoint, which takes `domain_name`/`contacts` — every one of
 * those is now the SDK's problem, and a drift becomes a compile error here.
 *
 * The SDK is pulled in through `cloudflare/tree-shakable`: instantiating the
 * full `new Cloudflare()` client bundles every resource in the API (~2 MB),
 * while the four registrar resources below cost ~73 KB.
 *
 * Docs: https://developers.cloudflare.com/registrar/registrar-api/
 * SDK:  https://github.com/cloudflare/cloudflare-typescript
 */

import { createClient } from 'cloudflare/tree-shakable';
import { APIConnectionError, APIError } from 'cloudflare/core/error';
import type { ClientOptions } from 'cloudflare/client';
import { BaseRegistrar } from 'cloudflare/resources/registrar/registrar';
import { BaseRegistrations } from 'cloudflare/resources/registrar/registrations';
import { BaseRegistrationStatus } from 'cloudflare/resources/registrar/registration-status';
import { BaseDomains } from 'cloudflare/resources/registrar/domains';
import type {
  Registration,
  RegistrarCheckResponse,
  RegistrarSearchResponse,
  WorkflowStatus,
} from 'cloudflare/resources/registrar/registrar';

// ============================================================================
// Error type
// ============================================================================

/**
 * Normalised registrar failure. The SDK's `APIError` is translated into this so
 * callers never have to import the SDK, and so the HTTP status plus
 * Cloudflare's own error codes survive into logs — the original client threw an
 * error whose only useful content was a stack trace.
 */
export class CloudflareApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly errors?: { code: number; message: string }[],
    /** Registrar operation that failed, e.g. `domain-search`. */
    public readonly endpoint?: string,
  ) {
    super(message);
    this.name = 'CloudflareApiError';
  }
}

/**
 * Run an SDK call, converting `APIError` into {@link CloudflareApiError}.
 *
 * `APIConnectionError` and its timeout subclass extend `APIError` despite
 * carrying no HTTP status, so they have to be excluded explicitly — otherwise a
 * dropped socket is reported as "Cloudflare API 0", which reads like a response
 * we never got. Those, and anything that is not an API error at all, are
 * re-thrown untouched: they are not Cloudflare telling us something.
 */
async function translateErrors<T>(endpoint: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof APIConnectionError) throw err;
    if (!(err instanceof APIError)) throw err;
    const errors = (err.errors ?? []).map((e) => ({
      code: Number(e.code ?? 0),
      message: String(e.message ?? ''),
    }));
    const detail = errors.length
      ? errors.map((e) => `${e.message} (code ${e.code})`).join('; ')
      : (err.message ?? 'no error detail returned');
    throw new CloudflareApiError(
      err.status ?? 0,
      errors[0] ? String(errors[0].code) : 'CF_ERROR',
      `Cloudflare API ${err.status ?? '(no status)'} on ${endpoint}: ${detail}`,
      errors,
      endpoint,
    );
  }
}

// ============================================================================
// Public output types
// ============================================================================

/**
 * Why a domain came back non-registrable. Only `domain_unavailable` means
 * "someone else has it" — the rest are API-beta limitations, so the UI should
 * not present them as "taken".
 */
export type DomainUnavailableReason =
  | 'extension_not_supported_via_api'
  | 'extension_not_supported'
  | 'extension_disallows_registration'
  | 'domain_premium'
  | 'domain_unavailable';

export interface DomainSearchResult {
  name: string;
  /** Cloudflare's `registrable` — for search this is cached, not authoritative. */
  available: boolean;
  premium: boolean;
  /** First-year registration cost in currency units (not cents). */
  price?: number;
  /** Per-year renewal cost in currency units (not cents). */
  renewalPrice?: number;
  currency?: string;
  /** Present only when `available` is false. */
  reason?: DomainUnavailableReason;
}

export type DomainCheckResult = DomainSearchResult;

export interface RegisteredDomain {
  /**
   * The FQDN. Cloudflare's registration resource has no separate surrogate key
   * — the docs call the domain name the registration's natural identity — so
   * `id` and `name` are deliberately the same value.
   */
  id: string;
  name: string;
  status: Registration['status'];
  expiresAt?: string;
  autoRenew: boolean;
  locked: boolean;
  privacyMode?: Registration['privacy_mode'];
}

/**
 * Registration is asynchronous: Cloudflare answers with a workflow, not a
 * finished domain. `pending` covers every non-terminal state — poll
 * {@link CloudflareRegistrar.getRegistrationStatus} until `completed` or
 * `failed`. `actionRequired` is surfaced separately because polling will never
 * resolve it on its own.
 */
export type RegisterResult =
  | { status: 'completed'; domain: RegisteredDomain }
  | { status: 'pending'; workflowUrl: string; pollAfter: number; actionRequired: boolean }
  | { status: 'failed'; code: string; message: string };

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

/** The SDK's `fetch` signature, re-exported so tests can type their stub. */
export type RegistrarFetch = NonNullable<ClientOptions['fetch']>;

// ============================================================================
// Mapping helpers
// ============================================================================

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}

type CfDomainResult = RegistrarSearchResponse.Domain | RegistrarCheckResponse.Domain;

function mapDomainResult(r: CfDomainResult): DomainSearchResult {
  return {
    name: r.name,
    available: r.registrable,
    premium: r.tier === 'premium',
    price: toNumber(r.pricing?.registration_cost),
    renewalPrice: toNumber(r.pricing?.renewal_cost),
    currency: r.pricing?.currency,
    reason: r.reason,
  };
}

function mapRegistration(r: Registration): RegisteredDomain {
  return {
    id: r.domain_name,
    name: r.domain_name,
    status: r.status,
    expiresAt: r.expires_at ?? undefined,
    autoRenew: r.auto_renew,
    locked: r.locked,
    privacyMode: r.privacy_mode,
  };
}

/**
 * Cloudflare wants a single `registrant` contact with a nested postal address.
 * Our callers still hold the flat legacy shape, so translate here rather than
 * making every call site learn the registry layout. A contact missing any
 * required field is dropped entirely — a partial `registrant` is rejected by
 * the API, and omitting it lets Cloudflare fall back to the account's default
 * registrant contact, which is what the registration flow relies on today.
 */
function mapContacts(contact: RegisterInput['contact']) {
  if (!contact) return undefined;
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
  const street = [contact.address1, contact.address2].filter(Boolean).join(', ').trim();

  // Cloudflare's registrant schema types every one of these as required —
  // including `state`, which many ccTLD addresses (NL, BE, DE, …) do not have.
  // We cannot omit it, and inventing a value would falsify a registry record,
  // so an address without one still falls back to the account default
  // registrant. Log which fields were missing: the fallback is otherwise
  // invisible, and "the WHOIS shows the wrong registrant" is a miserable thing
  // to debug from no signal at all.
  const required = {
    name,
    street,
    email: contact.email,
    phone: contact.phone,
    city: contact.city,
    state: contact.state,
    postalCode: contact.postalCode,
    country: contact.country,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([field]) => field);

  if (missing.length) {
    console.warn(
      `[cloudflare-registrar] registrant contact incomplete (missing: ${missing.join(', ')}) — ` +
        'falling back to the account default registrant',
    );
    return undefined;
  }

  // Every value is a non-empty string past the guard above.
  const r = required as { [K in keyof typeof required]: string };

  return {
    registrant: {
      email: r.email,
      phone: r.phone,
      postal_info: {
        name: r.name,
        ...(contact.organization ? { organization: contact.organization } : {}),
        address: {
          street: r.street,
          city: r.city,
          state: r.state,
          postal_code: r.postalCode,
          country_code: r.country,
        },
      },
    },
  };
}

/** The registration Cloudflare attaches to a succeeded workflow, if it did. */
function workflowRegistration(w: WorkflowStatus): Registration | undefined {
  return (w.context as { registration?: Registration } | undefined)?.registration;
}

/**
 * Map a workflow to a caller-facing result.
 *
 * `succeeded` without an attached registration is deliberately NOT reported as
 * completed here — there is no domain to hand back. {@link register} returns
 * `pending` for it, and {@link getRegistrationStatus} resolves it by re-reading
 * the registration; see the note there. Returning `completed` with a
 * half-empty domain would write a bad row.
 */
function mapWorkflow(w: WorkflowStatus): RegisterResult {
  if (w.state === 'succeeded') {
    const registration = workflowRegistration(w);
    if (registration) return { status: 'completed', domain: mapRegistration(registration) };
    return { status: 'pending', workflowUrl: w.links.self, pollAfter: 0, actionRequired: false };
  }
  if (w.state === 'failed') {
    return {
      status: 'failed',
      code: w.error?.code ?? 'REGISTRATION_FAILED',
      message: w.error?.message ?? 'Cloudflare could not complete the registration',
    };
  }
  return {
    status: 'pending',
    workflowUrl: w.links.self,
    pollAfter: 5000,
    actionRequired: w.state === 'action_required',
  };
}

// ============================================================================
// Client class
// ============================================================================

export class CloudflareRegistrar {
  private readonly accountId: string;
  private readonly client: ReturnType<typeof createRegistrarClient>;

  constructor({
    accountId,
    apiToken,
    fetch,
  }: {
    accountId: string;
    apiToken: string;
    /**
     * Override the SDK's `fetch`. Tests inject a stub here — the SDK holds its
     * own reference, so patching `globalThis.fetch` does not intercept it and
     * a test that tries would hit api.cloudflare.com for real.
     */
    fetch?: RegistrarFetch;
  }) {
    this.accountId = accountId;
    this.client = createRegistrarClient(apiToken, fetch);
  }

  /**
   * GET /accounts/{accountId}/registrar/domain-search
   * Suggestion-style search. Results are scoped to the TLDs the Registrar API
   * beta can register, which is narrower than the dashboard's catalogue —
   * expect fewer extensions here than a customer would see on cloudflare.com,
   * flagged via {@link DomainSearchResult.reason}. Prices are indicative; use
   * {@link checkDomains} before taking payment.
   */
  async searchDomains(query: string, limit = 20): Promise<DomainSearchResult[]> {
    const res = await translateErrors('domain-search', () =>
      this.client.registrar.search({ account_id: this.accountId, q: query, limit }),
    );
    return (res.domains ?? []).map(mapDomainResult);
  }

  /**
   * POST /accounts/{accountId}/registrar/domain-check
   * Authoritative availability + price, max 20 domains per call.
   */
  async checkDomains(domains: string[]): Promise<DomainCheckResult[]> {
    const res = await translateErrors('domain-check', () =>
      this.client.registrar.check({ account_id: this.accountId, domains }),
    );
    return (res.domains ?? []).map(mapDomainResult);
  }

  /**
   * POST /accounts/{accountId}/registrar/registrations
   * Billable and non-refundable. Always starts a workflow — see
   * {@link RegisterResult} and {@link getRegistrationStatus}.
   */
  async register(input: RegisterInput): Promise<RegisterResult> {
    const workflow = await translateErrors('registrations', () =>
      this.client.registrar.registrations.create({
        account_id: this.accountId,
        domain_name: input.name,
        ...(input.autoRenew !== undefined ? { auto_renew: input.autoRenew } : {}),
        ...(input.years !== undefined ? { years: input.years } : {}),
        ...(mapContacts(input.contact) ? { contacts: mapContacts(input.contact)! } : {}),
      }),
    );
    return mapWorkflow(workflow);
  }

  /**
   * GET /accounts/{accountId}/registrar/registrations/{domain}/status
   * Poll after {@link register} returns `pending`. Stop on `action_required`:
   * that state needs a human and will not resolve by waiting.
   *
   * When the workflow reports `succeeded` but carries no registration in its
   * context, this re-reads the registration itself. Without that the poll would
   * answer `pending` on every call — a terminal state that never resolves — and
   * a paid domain would sit in `pending_workflow` forever.
   */
  async getRegistrationStatus(domainName: string): Promise<RegisterResult> {
    const workflow = await translateErrors('registration-status', () =>
      this.client.registrar.registrationStatus.get(domainName, { account_id: this.accountId }),
    );
    if (workflow.state === 'succeeded' && !workflowRegistration(workflow)) {
      return { status: 'completed', domain: await this.getDomain(domainName) };
    }
    return mapWorkflow(workflow);
  }

  /**
   * GET /accounts/{accountId}/registrar/registrations
   * Cursor-paginated; this walks every page.
   */
  async listDomains(): Promise<RegisteredDomain[]> {
    return translateErrors('registrations', async () => {
      const out: RegisteredDomain[] = [];
      const page = await this.client.registrar.registrations.list({ account_id: this.accountId });
      for await (const registration of page) out.push(mapRegistration(registration));
      return out;
    });
  }

  /**
   * GET /accounts/{accountId}/registrar/registrations/{domain}
   */
  async getDomain(name: string): Promise<RegisteredDomain> {
    const registration = await translateErrors('registrations', () =>
      this.client.registrar.registrations.get(name, { account_id: this.accountId }),
    );
    return mapRegistration(registration);
  }

  /**
   * Only `auto_renew` and `locked` are mutable, and they live on different
   * routes: `auto_renew` goes through the async registrations workflow
   * (PATCH /registrations/{domain}), `locked` only exists on the older
   * PUT /domains/{domain}. Renewals, transfers and contact updates have no API
   * in the beta at all.
   */
  async updateDomain(name: string, update: UpdateDomainInput): Promise<void> {
    if (update.autoRenew !== undefined) {
      await translateErrors('registrations', () =>
        this.client.registrar.registrations.edit(name, {
          account_id: this.accountId,
          auto_renew: update.autoRenew,
        }),
      );
    }
    if (update.locked !== undefined) {
      await translateErrors('domains', () =>
        this.client.registrar.domains.update(name, {
          account_id: this.accountId,
          locked: update.locked,
        }),
      );
    }
  }
}

/**
 * Only the registrar resources are registered, so the bundle carries the
 * registrar surface instead of the whole Cloudflare API. `maxRetries: 2` covers
 * the SDK's default retry on 429/5xx; search sits in a user-facing request path,
 * so the 30s default timeout is cut to 15s.
 */
function createRegistrarClient(apiToken: string, fetch?: RegistrarFetch) {
  return createClient({
    apiToken,
    maxRetries: 2,
    timeout: 15_000,
    ...(fetch ? { fetch } : {}),
    resources: [BaseRegistrar, BaseRegistrations, BaseRegistrationStatus, BaseDomains],
  });
}
