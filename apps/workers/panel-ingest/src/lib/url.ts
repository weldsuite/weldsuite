/**
 * Page and referrer URLs as they are stored: no credentials, no fragment and
 * no query parameter that looks like a secret, because password-reset and
 * magic-link URLs would otherwise sit in the event table for as long as the
 * project keeps data. Also the `host`, `path` and `utm_*` columns, and the
 * `settings.excludedUrls` matcher.
 */

/**
 * Words that mark a query parameter as sensitive. A name is split into words
 * (`resetToken`, `api_key` and `access-token` all give `token` or `key`), so
 * `keyword` and `author` are left alone.
 */
const SECRET_WORDS = new Set([
  'token', 'key', 'secret', 'password', 'passwd', 'pwd', 'pass', 'passcode', 'auth', 'authorization',
  'code', 'email', 'mail', 'otp', 'jwt', 'sig', 'signature', 'sid', 'session', 'credential', 'credentials',
]);
/** Run-together names (`accesstoken`, `apikey`) end in one of these. */
const SECRET_SUFFIXES = ['token', 'secret', 'password', 'apikey'];

/** `a@b.c` without whitespace: one `@` with something before it and a dot with something after it. */
function looksLikeEmail(value: string): boolean {
  const at = value.indexOf('@');
  const dot = value.lastIndexOf('.');
  return !/\s/.test(value) && at > 0 && at === value.lastIndexOf('@') && dot > at + 1 && dot < value.length - 1;
}

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return part;
  }
}

/** Whether the query parameter `name=value` must not be stored. */
export function isSecretParam(name: string, value: string): boolean {
  if (words(name).some((word) => SECRET_WORDS.has(word))) return true;
  const squashed = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SECRET_SUFFIXES.some((suffix) => squashed.endsWith(suffix))) return true;
  return looksLikeEmail(value);
}

/** `?a=1&b=2` without the secret parameters, original encoding kept. */
function stripSecretParams(search: string): string {
  if (search.length <= 1) return '';
  const kept = search
    .slice(1)
    .split('&')
    .filter((pair) => {
      if (!pair) return false;
      const eq = pair.indexOf('=');
      const name = decode(eq === -1 ? pair : pair.slice(0, eq));
      const value = eq === -1 ? '' : decode(pair.slice(eq + 1));
      return !isSecretParam(name, value);
    });
  return kept.length > 0 ? `?${kept.join('&')}` : '';
}

/** A parsed http(s) URL cleaned for storage, or null for anything else (`file:`, `javascript:`, garbage). */
function cleanUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.username = '';
  url.password = '';
  url.hash = '';
  url.search = stripSecretParams(url.search);
  return url;
}

export interface PageUrl {
  /** The cleaned URL. */
  url: string;
  host: string;
  path: string;
  utm: Record<'source' | 'medium' | 'campaign' | 'content' | 'term', string | null>;
}

const MAX_UTM = 256;

function utmValue(params: URLSearchParams, name: string): string | null {
  const value = params.get(name)?.trim();
  return value ? value.slice(0, MAX_UTM) : null;
}

export function parsePageUrl(raw: string): PageUrl | null {
  const url = cleanUrl(raw);
  if (!url) return null;
  return {
    url: url.href,
    host: url.hostname,
    path: url.pathname,
    utm: {
      source: utmValue(url.searchParams, 'utm_source'),
      medium: utmValue(url.searchParams, 'utm_medium'),
      campaign: utmValue(url.searchParams, 'utm_campaign'),
      content: utmValue(url.searchParams, 'utm_content'),
      term: utmValue(url.searchParams, 'utm_term'),
    },
  };
}

/** The referrer cleaned like a page URL; empty or unparseable referrers give nulls. */
export function parseReferrer(raw: string | undefined): { referrer: string | null; host: string | null } {
  if (!raw) return { referrer: null, host: null };
  const url = cleanUrl(raw);
  return url ? { referrer: url.href, host: url.hostname } : { referrer: null, host: null };
}

// ---------------------------------------------------------------------------
// Excluded URLs
// ---------------------------------------------------------------------------

const MAX_PATTERN_LENGTH = 256;

function patternSource(pattern: string): string {
  return pattern
    .replace(/\*+/g, '*')
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
}

/**
 * A predicate for `settings.excludedUrls`, built the way the SDK builds its own
 * (packages/sdk/panel-sdk/src/config.ts), so both sides agree: a pattern must
 * match the whole path, `*` stands for any characters (`/admin/*`, which does
 * not match `/admin` itself), and the path is tried as the browser encodes it
 * and decoded, so `/über/*` works. Compiled once per request.
 */
export function excludedPathMatcher(patterns: string[]): (path: string) => boolean {
  const usable = patterns.filter((p) => p.length > 0 && p.length <= MAX_PATTERN_LENGTH);
  if (usable.length === 0) return () => false;
  const re = new RegExp(`^(?:${usable.map(patternSource).join('|')})$`);
  return (path) => {
    if (re.test(path)) return true;
    try {
      return re.test(decodeURI(path));
    } catch {
      return false;
    }
  };
}
