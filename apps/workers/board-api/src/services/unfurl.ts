/**
 * What a link card shows: a page's title, description, image and site name,
 * read from its Open Graph and Twitter tags (else its <title>).
 *
 * The page is fetched from the worker, so the address someone pastes must
 * not reach anything private: only http(s) on the default ports, never a
 * private, loopback or link-local address or an internal host name, every
 * redirect checked again (at most three), five seconds and 256 KB of HTML at
 * most. Anything else gives an empty preview, never an error, so a link card
 * is still made.
 */

import type { UnfurlResult } from '@weldsuite/app-api-client/schemas/boards';

const MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 5000;

/** Whether the address may be fetched from the server. */
export function isFetchableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== '80' && url.port !== '443') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || !host.includes('.') || /(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(host)) return false;
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) return false;
  return true;
}

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(host: string): boolean {
  if (!host.includes(':')) return false;
  const h = host.toLowerCase();
  return h === '::' || h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:');
}

const empty = (url: string): UnfurlResult => ({ url, title: null, description: null, image: null, siteName: null });

/** Fetches the page (redirects checked one by one) and reads its preview. */
export async function unfurl(raw: string, fetcher: typeof fetch = fetch): Promise<UnfurlResult> {
  let url = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isFetchableUrl(url)) return empty(raw);
    let res: Response;
    try {
      res = await fetcher(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'WeldBoard-LinkPreview/1.0' },
      });
    } catch {
      return empty(raw);
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      if (!next) return empty(raw);
      url = new URL(next, url).toString();
      continue;
    }
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('html')) {
      await res.body?.cancel().catch(() => undefined);
      return empty(raw);
    }
    const html = await readCapped(res, MAX_BYTES);
    return { ...readPreview(html, url), url: raw };
  }
  return empty(raw);
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    out += decoder.decode(value, { stream: true });
    // The tags are in <head>: stop at its end, or at the cap.
    if (read >= max || /<\/head>/i.test(out)) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text: string): string {
  return text
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** The preview a page's HTML gives (exported for tests). */
export function readPreview(html: string, pageUrl: string): Omit<UnfurlResult, 'url'> {
  const meta = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
    const key = attr('property') ?? attr('name');
    const content = attr('content');
    if (!key || !content) continue;
    const k = (key[2] ?? key[3] ?? key[4] ?? '').toLowerCase();
    if (k && !meta.has(k)) meta.set(k, decode(content[2] ?? content[3] ?? content[4] ?? ''));
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const pick = (...keys: string[]) => keys.map((k) => meta.get(k)).find((v) => !!v) ?? null;
  const imageRaw = pick('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src');
  let image: string | null = null;
  if (imageRaw) {
    try {
      const resolved = new URL(imageRaw, pageUrl);
      if (resolved.protocol === 'https:') image = resolved.toString().slice(0, 4096);
    } catch {
      image = null;
    }
  }
  const clip = (s: string | null, n: number) => (s ? s.slice(0, n) : null);
  return {
    title: clip(pick('og:title', 'twitter:title') ?? (titleTag ? decode(titleTag) : null), 500),
    description: clip(pick('og:description', 'twitter:description', 'description'), 2000),
    image,
    siteName: clip(pick('og:site_name', 'application-name') ?? safeHost(pageUrl), 200),
  };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
