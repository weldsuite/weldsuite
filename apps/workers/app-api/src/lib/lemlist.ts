/**
 * Lemlist database API client.
 *
 * Thin server-side wrapper around Lemlist's B2B lead database. The API key
 * (`LEMLIST_API_KEY`) is a single shared WeldSuite worker secret and never
 * leaves the worker — the platform only ever talks to app-api.
 *
 * Endpoints (https://api.lemlist.com/api):
 *   POST /database/people     — search the people database
 *   POST /database/companies  — search the companies database
 *   GET  /database/filters    — discover available filters + their values
 *
 * Auth: HTTP Basic, API key as the password (username blank).
 * Rate limit: ~20 requests / 2s — a single 429 retry with backoff is applied.
 *
 * Caching: Lemlist's database is global (one shared WeldSuite key, the same B2B
 * data for every tenant), so search pages and the filter catalog are cached in
 * KV (`WORKSPACE_CACHE`) keyed only by the request — never by workspace. This
 * keeps repeated searches (paging back and forth, re-running the same filters)
 * off the Lemlist API so we stay well under the rate limit. Caching is
 * best-effort: any KV read/write error falls through to a live call.
 */

import type {
  LemlistFilter,
  LemlistFilterCatalog,
  LemlistFilterDefinition,
  LemlistFilterInputType,
  LemlistSearchResult,
  LemlistSearchRow,
} from '@weldsuite/app-api-client/schemas/welddata';

const LEMLIST_API_BASE = 'https://api.lemlist.com/api';

export class LemlistError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LemlistError';
  }
}

export class LemlistNotConfiguredError extends Error {
  constructor() {
    super('Lemlist is not configured (missing LEMLIST_API_KEY)');
    this.name = 'LemlistNotConfiguredError';
  }
}

function authHeader(apiKey: string): string {
  // Basic auth with a blank username and the API key as the password.
  return `Basic ${btoa(`:${apiKey}`)}`;
}

// ---------------------------------------------------------------------------
// KV caching — Lemlist data is global, so cache keys are workspace-agnostic.
// Bump CACHE_VERSION whenever the cached shape changes to invalidate old keys.
// ---------------------------------------------------------------------------

const CACHE_VERSION = 'v1';
const CACHE_PREFIX = `lemlist:${CACHE_VERSION}:`;
/** Search pages change slowly; an hour keeps paging/refiltering off the API. */
const SEARCH_TTL_SECONDS = 60 * 60;
/** The filter catalog is near-static; refresh once a day. */
const FILTERS_TTL_SECONDS = 60 * 60 * 24;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Read-through cache around a producer. Best-effort: a missing binding or any
 * KV error degrades to a live call so caching can never break a request.
 */
async function withCache<T>(
  kv: KVNamespace | undefined,
  key: string,
  ttlSeconds: number,
  produce: () => Promise<T>,
): Promise<T> {
  if (!kv) return produce();
  try {
    const cached = await kv.get<T>(key, 'json');
    if (cached !== null) return cached;
  } catch {
    // Cache read failed — fall through to a live call.
  }
  const value = await produce();
  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
  } catch {
    // Cache write failed — the caller still gets the fresh value.
  }
  return value;
}

async function lemlistRequest<T>(
  apiKey: string | undefined,
  path: string,
  init: RequestInit,
): Promise<T> {
  if (!apiKey) throw new LemlistNotConfiguredError();

  const url = `${LEMLIST_API_BASE}${path}`;
  const doFetch = () =>
    fetch(url, {
      ...init,
      headers: {
        Authorization: authHeader(apiKey),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });

  let res = await doFetch();
  if (res.status === 429) {
    // Single backoff retry to respect the 20 req / 2s ceiling.
    await new Promise((r) => setTimeout(r, 1500));
    res = await doFetch();
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new LemlistError(
      `Lemlist API ${res.status}: ${body.slice(0, 300)}`,
      res.status,
    );
  }

  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Normalisation — the external payload is loose, so we surface the known
// fields with fallbacks while always keeping the raw row.
// ---------------------------------------------------------------------------

function str(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null) return row[k];
  }
  return undefined;
}

/** A lead's company facts live on the matching entry in `experiences[]` (the
 * one whose company matches `current_exp_company_name`, falling back to the
 * first/most-recent experience). */
function currentExperience(row: Record<string, unknown>): Record<string, unknown> {
  const exps = Array.isArray(row.experiences)
    ? (row.experiences as Record<string, unknown>[])
    : [];
  const currentName = str(pick(row, 'current_exp_company_name'));
  const match = currentName
    ? exps.find((e) => str(pick(e, 'company_name')) === currentName)
    : undefined;
  return match ?? exps[0] ?? {};
}

/** Build a company-logo URL from a domain when the provider didn't give one —
 * a small favicon is better than a blank avatar. */
function faviconFor(domain: string | null): string | null {
  if (!domain) return null;
  const clean = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(clean)}&sz=64`;
}

function normalizePerson(row: Record<string, unknown>): LemlistSearchRow {
  const exp = currentExperience(row);
  const first = str(pick(row, 'firstName', 'first_name'));
  const last = str(pick(row, 'lastName', 'last_name'));
  const fullName =
    str(pick(row, 'full_name', 'name', 'fullName')) ||
    [first, last].filter(Boolean).join(' ') ||
    str(pick(row, 'canonical_shorthand_name')) ||
    null;
  return {
    id: str(pick(row, '_id', 'lead_id', 'id', 'leadId')) ?? crypto.randomUUID(),
    kind: 'person',
    name: fullName,
    // Lemlist's database search never returns the email — it is revealed
    // separately — so this is expected to be null here.
    email: str(pick(row, 'email')),
    title: str(pick(exp, 'title_normalized', 'title')),
    companyName: str(pick(row, 'current_exp_company_name'), pick(exp, 'company_name')),
    domain: str(pick(exp, 'company_domain')),
    industry: str(pick(exp, 'company_industry')),
    location: str(pick(row, 'location'), pick(exp, 'location'), pick(row, 'state')),
    country: str(pick(row, 'country')),
    companySize: str(pick(exp, 'company_size'), pick(exp, 'company_employee_count')),
    linkedinUrl: str(pick(row, 'lead_linkedin_url', 'linkedinUrl', 'linkedin_url')),
    // Person photo if the provider exposes one (the field name varies), else
    // the current company's logo as a stand-in.
    avatarUrl: str(
      pick(
        row,
        'lead_picture_url',
        'picture_url',
        'profile_picture_url',
        'profilePictureUrl',
        'picture',
        'photo',
        'photo_url',
        'avatar',
        'image',
      ),
      pick(exp, 'company_logo_url'),
    ),
    raw: row,
  };
}

function normalizeCompany(row: Record<string, unknown>): LemlistSearchRow {
  const domain = str(pick(row, 'company_domain', 'company_website_url', 'domain'));
  return {
    id: str(pick(row, '_id', 'company_id', 'id')) ?? crypto.randomUUID(),
    kind: 'company',
    name: str(pick(row, 'company_name', 'name')),
    email: str(pick(row, 'email')),
    title: null,
    companyName: str(pick(row, 'company_name', 'name')),
    domain,
    industry: str(pick(row, 'company_industry', 'company_subindustry', 'industry')),
    location: str(pick(row, 'company_location', 'company_headquarters_city')),
    country: str(pick(row, 'company_headquarters_country', 'country')),
    companySize: str(pick(row, 'company_size', 'company_employee_count')),
    linkedinUrl: str(pick(row, 'company_linkedin_url', 'linkedinUrl')),
    avatarUrl:
      str(pick(row, 'company_logo_url', 'logo_url', 'logo', 'companyLogoUrl')) ?? faviconFor(domain),
    raw: row,
  };
}

function extractRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  const obj = (payload ?? {}) as Record<string, unknown>;
  for (const key of ['hits', 'results', 'data', 'people', 'companies', 'leads']) {
    if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
  }
  return [];
}

function extractTotal(payload: unknown, fallback: number): number {
  const obj = (payload ?? {}) as Record<string, unknown>;
  for (const key of ['total', 'totalCount', 'count', 'nbHits']) {
    const v = obj[key];
    if (typeof v === 'number') return v;
  }
  return fallback;
}

interface SearchArgs {
  filters: LemlistFilter[];
  keyword?: string;
  page: number;
  size: number;
}

interface SearchOptions {
  /** The filter the free-text keyword box maps to. Neither database accepts a
   * top-level `keyword` field, so the keyword is folded into this filter:
   * `keyword` (profile-wide) for people, `keywordInCompany` for companies. */
  keywordFilterId: string;
}

async function search(
  apiKey: string | undefined,
  path: '/database/people' | '/database/companies',
  args: SearchArgs,
  normalize: (row: Record<string, unknown>) => LemlistSearchRow,
  opts: SearchOptions,
  cache?: KVNamespace,
): Promise<LemlistSearchResult> {
  // Lemlist expects each filter as { filterId, in: [...], out: [...] }; our wire
  // shape is { filterId, values }, so map the applied values into the inclusion
  // list. Slider/range filters arrive pre-encoded as a single "min|max" string
  // and pass straight through.
  const filters = args.filters.map((f) => ({
    filterId: f.filterId,
    in: f.values as (string | number)[],
    out: [] as (string | number)[],
  }));

  // Fold the free-text keyword into its filter, merging with an existing one of
  // the same id (e.g. the sidebar "keyword" filter) rather than duplicating it.
  const keyword = args.keyword?.trim();
  if (keyword) {
    const existing = filters.find((f) => f.filterId === opts.keywordFilterId);
    if (existing) existing.in = [...existing.in, keyword];
    else filters.push({ filterId: opts.keywordFilterId, in: [keyword], out: [] });
  }

  const body = { filters, page: args.page, size: args.size };

  // Cache key is the canonical request: filters sorted by id (each inclusion
  // list sorted too) + page + size, so the same search reorders to the same
  // key regardless of how the client ordered the filters.
  const canonical = JSON.stringify({
    filters: [...filters]
      .sort((a, b) => a.filterId.localeCompare(b.filterId))
      .map((f) => ({ filterId: f.filterId, in: [...f.in].map(String).sort() })),
    page: args.page,
    size: args.size,
  });
  const scope = path === '/database/people' ? 'people' : 'companies';
  const cacheKey = `${CACHE_PREFIX}search:${scope}:${await sha256Hex(canonical)}`;

  return withCache(cache, cacheKey, SEARCH_TTL_SECONDS, async () => {
    const payload = await lemlistRequest<unknown>(apiKey, path, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const rawRows = extractRows(payload);
    const rows = rawRows.map(normalize);
    const total = extractTotal(payload, (args.page - 1) * args.size + rows.length);
    return {
      rows,
      page: args.page,
      size: args.size,
      total,
      hasMore: rows.length >= args.size,
    };
  });
}

export function searchPeople(
  apiKey: string | undefined,
  args: SearchArgs,
  cache?: KVNamespace,
): Promise<LemlistSearchResult> {
  return search(
    apiKey,
    '/database/people',
    args,
    normalizePerson,
    { keywordFilterId: 'keyword' },
    cache,
  );
}

export function searchCompanies(
  apiKey: string | undefined,
  args: SearchArgs,
  cache?: KVNamespace,
): Promise<LemlistSearchResult> {
  return search(
    apiKey,
    '/database/companies',
    args,
    normalizeCompany,
    { keywordFilterId: 'keywordInCompany' },
    cache,
  );
}

/** Map Lemlist's free-form `type` string onto the affordances the UI knows
 * how to render. Lemlist is inconsistent (often just "text"), so we match
 * loosely and let the platform refine known filters further. */
function normalizeFilterType(raw: string | null, hasOptions: boolean): LemlistFilterInputType {
  const t = (raw ?? '').toLowerCase();
  if (t.includes('range')) return 'range';
  if (t.includes('multi')) return 'multiselect';
  if (t.includes('bool') || t.includes('checkbox')) return 'boolean';
  if (t.includes('number') || t.includes('integer') || t === 'int' || t === 'year') return 'number';
  if (t.includes('select') || t.includes('enum') || t.includes('dropdown') || t.includes('choice')) {
    return 'select';
  }
  // No explicit type but a concrete option list → treat as a single select.
  if (hasOptions && (!t || t === 'text')) return 'select';
  return 'text';
}

function normalizeFilterDefs(payload: unknown, scope: 'people' | 'companies'): LemlistFilterDefinition[] {
  const obj = (payload ?? {}) as Record<string, unknown>;
  // The catalog may key filters by scope, or return a flat list. Lemlist also
  // tags each filter with a `mode` array (['leads','companies']); when present
  // we keep only the filters valid for the requested scope.
  const scopeMode = scope === 'people' ? 'leads' : 'companies';
  const raw = (obj[scope] ?? obj.filters ?? payload) as unknown;
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .map((f) => {
      const def = f as Record<string, unknown>;
      const optionsRaw = (def.options ?? def.values ?? []) as unknown[];
      const options = optionsRaw.map((o) => {
        if (typeof o === 'string') return { value: o, label: o };
        const oo = o as Record<string, unknown>;
        const value = str(pick(oo, 'value', 'id')) ?? '';
        return { value, label: str(pick(oo, 'label', 'name')) ?? value };
      });
      const filterId = str(pick(def, 'filterId', 'id', 'key')) ?? 'unknown';
      const mode = Array.isArray(def.mode) ? (def.mode as unknown[]).map(String) : null;
      return {
        filterId,
        label: str(pick(def, 'label', 'name', 'title')) ?? filterId,
        type: normalizeFilterType(str(pick(def, 'type')), options.length > 0),
        description: str(pick(def, 'description')) ?? undefined,
        helper: str(pick(def, 'helper', 'hint', 'placeholder')) ?? undefined,
        options,
        _mode: mode,
      };
    })
    // Drop filters the provider says don't apply to this database.
    .filter((d) => !d._mode || d._mode.includes(scopeMode))
    .map(({ _mode, ...d }) => d);
}

export function getFilters(
  apiKey: string | undefined,
  cache?: KVNamespace,
): Promise<LemlistFilterCatalog> {
  return withCache(cache, `${CACHE_PREFIX}filters`, FILTERS_TTL_SECONDS, async () => {
    const payload = await lemlistRequest<unknown>(apiKey, '/database/filters', {
      method: 'GET',
    });
    return {
      people: normalizeFilterDefs(payload, 'people'),
      companies: normalizeFilterDefs(payload, 'companies'),
    };
  });
}
