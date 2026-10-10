/**
 * Company logos for avatars, resolved by our own API.
 *
 * Avatars used to point straight at a public favicon service, which sent every
 * customer domain to that service on each page view and logged a 404 in the
 * console for each domain without an icon. Now the platform asks
 * `POST /api/company-logos/resolve` (crm-api), which answers from the workspace's
 * own storage and fetches a missing logo once from the company's own website.
 *
 * The answer is a URL only for a logo that EXISTS. An `<img>` therefore never
 * requests an unknown image (so no 404s in the console), and every company
 * without a logo keeps its initial-letter avatar without anything failing.
 *
 * Lookups are batched and cached in a module-level store rather than in React
 * Query: one grid asks for dozens of domains in the same tick (one request per
 * 25), several components ask for the same one, and the pickers that use this
 * render outside a QueryClientProvider in tests. A workspace switch reloads the
 * page, so the store never mixes tenants.
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ClientApi } from '@weldsuite/api-client/types';
import { createCompanyLogosApi } from '@weldsuite/app-api-client/domains/company-logos';
import { COMPANY_LOGO_BATCH_MAX, normalizeLogoDomain } from '@weldsuite/app-api-client/schemas/company-logos';
import { useAppApiClient } from '@/lib/api/use-app-api';

/** The server keeps the real cache (a month); this only avoids re-asking in a session. */
const RESOLVED_TTL_MS = 60 * 60 * 1000;
/** A failed batch (offline, no permission) is retried at most once a minute. */
const FAILED_RETRY_MS = 60 * 1000;
/** Lookups requested within this window travel in one request. */
const FLUSH_DELAY_MS = 20;

// ---------------------------------------------------------------------------
// Which domain a record's logo comes from
// ---------------------------------------------------------------------------

export interface CompanyLogoSource {
  website?: string | null;
  domain?: string | null;
  email?: string | null;
}

/**
 * The domain to look a company's logo up by: its website, else an explicit
 * domain, else the domain of its email address. Null when none of them is a
 * public company domain (empty, an IP, a free mailbox provider, ...).
 */
export function companyLogoDomain(source: CompanyLogoSource): string | undefined {
  return (
    normalizeLogoDomain(source.website) ??
    normalizeLogoDomain(source.domain) ??
    normalizeLogoDomain(source.email) ??
    undefined
  );
}

/**
 * `companyLogoDomain`, except for a record that already has an image of its own:
 * that one needs no lookup.
 */
export function logoDomainForCompany(
  company: CompanyLogoSource & { avatarUrl?: string | null; logoUrl?: string | null },
): string | undefined {
  if (company.avatarUrl || company.logoUrl) return undefined;
  return companyLogoDomain(company);
}

/**
 * A WeldData lead that has no photo or logo from the data provider: the logo of
 * its company's domain, if the company has one.
 */
export function logoDomainForLead(lead: { avatarUrl?: string | null; domain?: string | null }): string | undefined {
  if (lead.avatarUrl) return undefined;
  return normalizeLogoDomain(lead.domain) ?? undefined;
}

// ---------------------------------------------------------------------------
// Store: cache + batching
// ---------------------------------------------------------------------------

interface LogoEntry {
  url: string | null;
  at: number;
  failed: boolean;
}

type ClientLoader = () => Promise<ClientApi>;

const entries = new Map<string, LogoEntry>();
const inflight = new Set<string>();
const queued = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let loadClient: ClientLoader | null = null;

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getVersion(): number {
  return version;
}

function needsLookup(domain: string, now: number): boolean {
  if (inflight.has(domain) || queued.has(domain)) return false;
  const entry = entries.get(domain);
  if (!entry) return true;
  return now - entry.at >= (entry.failed ? FAILED_RETRY_MS : RESOLVED_TTL_MS);
}

async function fetchChunk(chunk: string[], loader: ClientLoader): Promise<void> {
  let logos: Record<string, string | null> | null = null;
  try {
    const client = await loader();
    logos = (await createCompanyLogosApi(client).resolve(chunk)).data.logos;
  } catch {
    // Offline, no permission, endpoint down: initials stay. Not worth a toast
    // or a console line for an avatar.
    logos = null;
  }
  const at = Date.now();
  for (const domain of chunk) {
    inflight.delete(domain);
    const url = logos?.[domain];
    if (url === undefined) {
      entries.set(domain, { url: entries.get(domain)?.url ?? null, at, failed: true });
    } else {
      entries.set(domain, { url, at, failed: false });
    }
  }
  emit();
}

function flush(): void {
  flushTimer = undefined;
  const loader = loadClient;
  const domains = [...queued];
  queued.clear();
  if (!loader || domains.length === 0) return;
  for (const domain of domains) inflight.add(domain);
  for (let i = 0; i < domains.length; i += COMPANY_LOGO_BATCH_MAX) {
    void fetchChunk(domains.slice(i, i + COMPANY_LOGO_BATCH_MAX), loader);
  }
}

/** Queue lookups for domains that are not cached; they go out in one batch shortly. */
export function requestCompanyLogos(domains: readonly string[], loader: ClientLoader): void {
  const now = Date.now();
  let added = false;
  for (const domain of domains) {
    if (needsLookup(domain, now)) {
      queued.add(domain);
      added = true;
    }
  }
  if (!added) return;
  loadClient = loader;
  flushTimer ??= setTimeout(flush, FLUSH_DELAY_MS);
}

/** The logo URL already known for a domain (no request is made). */
export function getCachedCompanyLogo(domain: string): string | undefined {
  return entries.get(domain)?.url ?? undefined;
}

/** Test seam: forget everything and cancel a pending flush. */
export function resetCompanyLogoStore(): void {
  entries.clear();
  inflight.clear();
  queued.clear();
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushTimer = undefined;
  loadClient = null;
  version = 0;
  for (const listener of listeners) listener();
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function domainsKey(domains: ReadonlyArray<string | null | undefined>): string {
  const unique = new Set<string>();
  for (const raw of domains) {
    const domain = normalizeLogoDomain(raw);
    if (domain) unique.add(domain);
  }
  return [...unique].sort().join(',');
}

/**
 * Resolve the logos for a set of websites/domains. Returns domain -> logo URL
 * for the ones that have a logo (so far); the map grows as lookups finish.
 * Keys are normalised domains (`normalizeLogoDomain`).
 */
export function useCompanyLogos(domains: ReadonlyArray<string | null | undefined>): ReadonlyMap<string, string> {
  const { getClient } = useAppApiClient();
  const loaderRef = useRef<ClientLoader>(getClient);
  useEffect(() => {
    loaderRef.current = getClient;
  }, [getClient]);

  const key = useMemo(() => domainsKey(domains), [domains]);
  const wanted = useMemo(() => (key ? key.split(',') : []), [key]);

  useEffect(() => {
    if (wanted.length > 0) requestCompanyLogos(wanted, () => loaderRef.current());
  }, [wanted]);

  const storeVersion = useSyncExternalStore(subscribe, getVersion, getVersion);
  return useMemo(() => {
    const found = new Map<string, string>();
    for (const domain of wanted) {
      const url = getCachedCompanyLogo(domain);
      if (url) found.set(domain, url);
    }
    return found;
    // `storeVersion` is not read above: it is the signal that the store changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, storeVersion]);
}

/** The logo for one website/domain, or undefined while unknown or when there is none. */
export function useCompanyLogo(source: string | null | undefined): string | undefined {
  const domains = useMemo(() => [source], [source]);
  const logos = useCompanyLogos(domains);
  const domain = normalizeLogoDomain(source);
  return domain ? logos.get(domain) : undefined;
}

/**
 * `rows` with a `logoUrl` property added to those whose domain has a logo (the
 * avatar getters of the grids read it). Rows keep their identity until a logo
 * arrives for them. `getDomain` returns the website or domain to look up
 * (undefined to skip, e.g. when the row has its own image) and must be a stable
 * function (module level, or memoised).
 */
export function useRowsWithCompanyLogos<T>(
  rows: readonly T[],
  getDomain: (row: T) => string | null | undefined,
): T[] {
  const domains = useMemo(() => rows.map((row) => normalizeLogoDomain(getDomain(row))), [rows, getDomain]);
  const logos = useCompanyLogos(domains);
  return useMemo(() => {
    if (logos.size === 0) return rows as T[];
    return rows.map((row, index) => {
      const domain = domains[index];
      const logoUrl = domain ? logos.get(domain) : undefined;
      return logoUrl ? { ...row, logoUrl } : row;
    });
  }, [rows, domains, logos]);
}
