/**
 * Company logos, without telling a third party who the workspace's customers are.
 *
 * The platform used to point every company avatar at a public favicon service,
 * which handed the workspace's customer list to that service on each page view.
 * Instead the browser asks `POST /api/company-logos/resolve`, and this module
 * answers from the workspace's own R2 storage. A logo that is not stored yet is
 * fetched ONCE, from the company's own website, never from an aggregator.
 *
 * Storage: `workspaces/<workspaceId>/company-logos/<domain>`, one object per
 * domain, keyed per workspace like the other avatars so one tenant's lookups
 * are invisible to another. The object's `customMetadata` is the index:
 *   status     'hit' (the body is the image) or 'miss' (empty marker)
 *   expiresAt  epoch ms after which it is looked up again
 * Misses are stored too, so a company without a logo costs one cheap R2 head
 * per page view instead of a fetch.
 *
 * The fetch is the dangerous part, since the target is a user-supplied host:
 *   - the domain must be a public DNS name (shared `isPublicHostname`: no IPs,
 *     `localhost`, single-label or reserved hosts), https on 443 only, and every
 *     redirect hop is re-checked the same way;
 *   - redirects are followed by hand (3 hops), each request has a timeout and
 *     the whole lookup a budget;
 *   - bodies are read through a byte cap (logo 256 KB, page 128 KB);
 *   - what is stored is decided by the image's magic bytes, never by the
 *     upstream `Content-Type`; SVG is refused (it would run script if opened
 *     directly from the storage domain), so is anything that is not an image.
 */

import { coreOriginFrom } from '@weldsuite/api-modules';
import { isPublicHostname, normalizeLogoDomain } from '@weldsuite/app-api-client/schemas/company-logos';
import { logSafe } from '@weldsuite/worker-kit/log-safe';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A logo is looked up again after a month. */
export const LOGO_HIT_TTL_MS = 30 * DAY_MS;
/** A site that answered but has no usable icon is not asked again for 3 days. */
export const LOGO_MISS_TTL_MS = 3 * DAY_MS;
/** A site that timed out or errored is retried after 6 hours. */
export const LOGO_ERROR_TTL_MS = 6 * HOUR_MS;

export const LOGO_MAX_BYTES = 256 * 1024;
const PAGE_MAX_BYTES = 128 * 1024;
/** Smaller than any real icon; 1x1 tracking pixels and error stubs fall here. */
const LOGO_MIN_BYTES = 100;

const REQUEST_TIMEOUT_MS = 3_000;
const DOMAIN_BUDGET_MS = 7_000;
const BATCH_BUDGET_MS = 12_000;
const MAX_REDIRECTS = 3;
const MAX_ICON_LINKS = 2;
const CONCURRENCY = 6;

const USER_AGENT = 'WeldSuiteLogoFetcher/1.0 (+https://weldsuite.org)';
const LOGO_CACHE_CONTROL = 'public, max-age=86400';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface CompanyLogoDeps {
  storage: R2Bucket;
  /** Public hostname serving the bucket, e.g. `https://weldsuite-storage.weldsuite.org`. */
  r2PublicUrl: string;
  workspaceId: string;
  /** Defaults to the global `fetch`, read at call time. */
  fetcher?: FetchLike;
  now?: () => number;
}

interface LookupContext {
  storage: R2Bucket;
  publicBase: string;
  workspaceId: string;
  fetcher: FetchLike;
  now: () => number;
  /** When the whole request stops starting new fetches. */
  batchDeadline: number;
}

export function logoObjectKey(workspaceId: string, domain: string): string {
  return `workspaces/${workspaceId}/company-logos/${domain}`;
}

/**
 * The URL prefix a browser loads a stored logo from. Deployed, that is the
 * bucket's public hostname. Under local `wrangler dev` that hostname serves the
 * REMOTE bucket, which never has an object written to the local simulator, so
 * the image would 404 (and log it); app-api streams local objects back through
 * `GET /api/storage/public/*` instead, the same fallback its own avatar uploads
 * use.
 */
export function logoPublicBase(requestUrl: string, r2PublicUrl: string): string {
  const origin = new URL(requestUrl).origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
    return `${coreOriginFrom(origin)}/api/storage/public`;
  }
  return r2PublicUrl;
}

// ---------------------------------------------------------------------------
// Image sniffing
// ---------------------------------------------------------------------------

/**
 * The image type of `bytes` by its magic number, or null when it is not a
 * raster format a browser shows in an `<img>`. SVG is excluded on purpose.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp';
  }
  // ICO: reserved 0, type 1, then the number of images (at least one).
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && ((b[4] ?? 0) | ((b[5] ?? 0) << 8)) >= 1) {
    return 'image/x-icon';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Icon discovery in a page's <head>
// ---------------------------------------------------------------------------

const LINK_TAG = /<link\b[^>]*>/gi;
const ATTRIBUTE = /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

function largestSize(sizes: string | undefined): number {
  let largest = 0;
  for (const match of (sizes ?? '').matchAll(/(\d+)x(\d+)/gi)) {
    largest = Math.max(largest, Number(match[1]), Number(match[2]));
  }
  return Math.min(largest, 512);
}

/**
 * The icons a page declares, best first: `apple-touch-icon` (usually a 180px
 * square logo) before `rel="icon"`, bigger before smaller. SVG icons and
 * `data:` URLs are skipped; the first two candidates are returned.
 */
export function parseIconLinks(html: string, base: URL): URL[] {
  const scored: Array<{ url: URL; score: number }> = [];
  for (const tag of html.matchAll(LINK_TAG)) {
    const attrs = new Map<string, string>();
    for (const attr of tag[0].matchAll(ATTRIBUTE)) {
      attrs.set((attr[1] ?? '').toLowerCase(), attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
    const isApple = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed');
    if (!isApple && !rel.includes('icon')) continue;

    const href = (attrs.get('href') ?? '').trim().replace(/&amp;/gi, '&');
    if (!href || href.toLowerCase().startsWith('data:')) continue;
    if ((attrs.get('type') ?? '').toLowerCase().includes('svg') || /\.svg(?:[?#]|$)/i.test(href)) continue;

    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    scored.push({ url, score: (isApple ? 1000 : 0) + largestSize(attrs.get('sizes')) });
  }
  scored.sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const out: URL[] = [];
  for (const { url } of scored) {
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    out.push(url);
    if (out.length === MAX_ICON_LINKS) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fetching from a public site
// ---------------------------------------------------------------------------

type PublicFetch =
  | { kind: 'ok'; url: URL; contentType: string; body: Uint8Array }
  /** The site answered and there is nothing to use (404, too large, bad redirect...). */
  | { kind: 'none' }
  /** Timed out, refused, 5xx or 429: worth trying again soon. */
  | { kind: 'error' };

const NONE = { kind: 'none' } as const;
const ERROR = { kind: 'error' } as const;

/** https, the default port, no credentials, and a public DNS name. */
export function isAllowedFetchTarget(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    isPublicHostname(url.hostname)
  );
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is being thrown away; nothing to report.
  }
}

/** Reads at most `maxBytes`. Past it: `null`, or the bytes so far when `truncate`. */
async function readCapped(response: Response, maxBytes: number, truncate: boolean): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      await reader.cancel().catch(() => undefined);
      if (!truncate) return null;
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

interface FetchOptions {
  accept: string;
  maxBytes: number;
  /** Keep what fits instead of giving up on an oversized body (HTML pages). */
  truncate?: boolean;
  deadline: number;
}

async function fetchPublic(start: URL, opts: FetchOptions, ctx: LookupContext): Promise<PublicFetch> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedFetchTarget(current)) return NONE;
    const remaining = opts.deadline - ctx.now();
    if (remaining <= 0) return ERROR;

    // The timer stays armed until the body is read, so a server that stalls
    // mid-body cannot hold the lookup open.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remaining));
    try {
      const response = await ctx.fetcher(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: opts.accept },
      });

      if (response.status >= 300 && response.status < 400) {
        await discard(response);
        const location = response.headers.get('location');
        if (!location) return NONE;
        try {
          current = new URL(location, current);
        } catch {
          return NONE;
        }
        continue;
      }
      if (response.status >= 500 || response.status === 429) {
        await discard(response);
        return ERROR;
      }
      if (!response.ok) {
        await discard(response);
        return NONE;
      }

      const declared = Number(response.headers.get('content-length'));
      if (!opts.truncate && Number.isFinite(declared) && declared > opts.maxBytes) {
        await discard(response);
        return NONE;
      }
      const body = await readCapped(response, opts.maxBytes, opts.truncate ?? false);
      if (!body) return NONE;
      return { kind: 'ok', url: current, contentType: response.headers.get('content-type') ?? '', body };
    } catch {
      return ERROR;
    } finally {
      clearTimeout(timer);
    }
  }
  return NONE; // too many redirects
}

type LogoSearch =
  | { kind: 'logo'; bytes: Uint8Array; contentType: string }
  | { kind: 'none' }
  | { kind: 'error' };

/** Look for an icon on one origin: what its home page declares, then `/favicon.ico`. */
async function findLogoAt(origin: URL, deadline: number, ctx: LookupContext): Promise<{ result: LogoSearch; reached: boolean }> {
  const page = await fetchPublic(
    origin,
    { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', maxBytes: PAGE_MAX_BYTES, truncate: true, deadline },
    ctx,
  );
  const reached = page.kind === 'ok';

  let base = origin;
  const candidates: URL[] = [];
  if (page.kind === 'ok') {
    base = page.url;
    if (/html/i.test(page.contentType)) {
      candidates.push(...parseIconLinks(new TextDecoder().decode(page.body), base));
    }
  }
  candidates.push(new URL('/favicon.ico', base));

  let sawError = page.kind === 'error';
  const tried = new Set<string>();
  for (const candidate of candidates) {
    if (tried.has(candidate.href)) continue;
    tried.add(candidate.href);

    const icon = await fetchPublic(candidate, { accept: 'image/*,*/*;q=0.5', maxBytes: LOGO_MAX_BYTES, deadline }, ctx);
    if (icon.kind === 'error') {
      sawError = true;
    } else if (icon.kind === 'ok' && icon.body.byteLength >= LOGO_MIN_BYTES) {
      const contentType = sniffImageType(icon.body);
      if (contentType) return { result: { kind: 'logo', bytes: icon.body, contentType }, reached };
    }
  }
  return { result: sawError ? ERROR : NONE, reached };
}

async function fetchLogoFromSite(domain: string, ctx: LookupContext): Promise<LogoSearch> {
  const deadline = Math.min(ctx.now() + DOMAIN_BUDGET_MS, ctx.batchDeadline);
  const apex = await findLogoAt(new URL(`https://${domain}/`), deadline, ctx);
  if (apex.result.kind === 'logo') return apex.result;
  // Some companies only run their site on www. Ask there too, but only when the
  // bare domain did not even serve a page (otherwise it has redirected already).
  if (apex.reached) return apex.result;
  const www = await findLogoAt(new URL(`https://www.${domain}/`), deadline, ctx);
  if (www.result.kind === 'logo') return www.result;
  return apex.result.kind === 'error' || www.result.kind === 'error' ? ERROR : NONE;
}

// ---------------------------------------------------------------------------
// Cache (R2) and resolution
// ---------------------------------------------------------------------------

interface StoredState {
  status: 'hit' | 'miss';
  fresh: boolean;
}

async function readState(ctx: LookupContext, key: string): Promise<StoredState | null> {
  const head = await ctx.storage.head(key);
  if (!head) return null;
  const meta = head.customMetadata ?? {};
  if (meta.status !== 'hit' && meta.status !== 'miss') return null;
  return { status: meta.status, fresh: Number(meta.expiresAt) > ctx.now() };
}

async function writeHit(ctx: LookupContext, key: string, logo: { bytes: Uint8Array; contentType: string }): Promise<void> {
  await ctx.storage.put(key, logo.bytes, {
    httpMetadata: { contentType: logo.contentType, cacheControl: LOGO_CACHE_CONTROL },
    customMetadata: { status: 'hit', expiresAt: String(ctx.now() + LOGO_HIT_TTL_MS) },
  });
}

async function writeMiss(ctx: LookupContext, key: string, ttlMs: number): Promise<void> {
  await ctx.storage.put(key, new Uint8Array(0), {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { status: 'miss', expiresAt: String(ctx.now() + ttlMs) },
  });
}

async function resolveDomain(domain: string, ctx: LookupContext): Promise<string | null> {
  const key = logoObjectKey(ctx.workspaceId, domain);
  const url = `${ctx.publicBase}/${key}`;

  const state = await readState(ctx, key);
  if (state?.fresh) return state.status === 'hit' ? url : null;
  // Out of time for this request: serve what is stored, fetch nothing more.
  if (ctx.now() >= ctx.batchDeadline) return state?.status === 'hit' ? url : null;

  const found = await fetchLogoFromSite(domain, ctx);
  if (found.kind === 'logo') {
    await writeHit(ctx, key, found);
    return url;
  }
  // The site could not be reached: keep a logo we already have rather than
  // replace it with a miss.
  if (found.kind === 'error' && state?.status === 'hit') return url;
  await writeMiss(ctx, key, found.kind === 'error' ? LOGO_ERROR_TTL_MS : LOGO_MISS_TTL_MS);
  return null;
}

async function mapLimit<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/**
 * Resolve logos for the given websites/domains. The result is keyed by the
 * strings that were passed in: a public URL when the company has a logo, `null`
 * when it has none, the input is not a public company domain, or the lookup
 * could not finish. Never throws for a single domain.
 */
export async function resolveCompanyLogos(
  inputs: readonly string[],
  deps: CompanyLogoDeps,
): Promise<Record<string, string | null>> {
  const now = deps.now ?? Date.now;
  const ctx: LookupContext = {
    storage: deps.storage,
    publicBase: deps.r2PublicUrl.replace(/\/+$/, ''),
    workspaceId: deps.workspaceId,
    fetcher: deps.fetcher ?? ((input, init) => fetch(input, init)),
    now,
    batchDeadline: now() + BATCH_BUDGET_MS,
  };

  const result: Record<string, string | null> = {};
  const inputsByDomain = new Map<string, string[]>();
  for (const input of inputs) {
    const domain = normalizeLogoDomain(input);
    if (!domain) {
      result[input] = null;
      continue;
    }
    const group = inputsByDomain.get(domain);
    if (group) group.push(input);
    else inputsByDomain.set(domain, [input]);
  }

  await mapLimit([...inputsByDomain.keys()], CONCURRENCY, async (domain) => {
    let url: string | null = null;
    try {
      url = await resolveDomain(domain, ctx);
    } catch (err) {
      console.warn('[company-logo] lookup failed for', logSafe(domain), err);
    }
    for (const input of inputsByDomain.get(domain) ?? []) result[input] = url;
  });
  return result;
}
