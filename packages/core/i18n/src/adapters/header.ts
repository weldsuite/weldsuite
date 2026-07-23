import type { LocaleAdapter } from '../adapter';
import { languages, type Language } from '../locales';

const COOKIE_NAME = 'locale';

export interface HeaderAdapterInput {
  acceptLanguage?: string | null;
  cookie?: string | null;
}

function parseCookie(cookieHeader: string | null | undefined): Language | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]*)`));
  if (!match || match[1] === undefined) return undefined;
  const decoded = decodeURIComponent(match[1]);
  return (languages as readonly string[]).includes(decoded) ? (decoded as Language) : undefined;
}

function parseAcceptLanguage(header: string | null | undefined): Language | undefined {
  if (!header) return undefined;
  const tags = header
    .toLowerCase()
    .split(',')
    .map(part => part.trim().split(';')[0])
    .filter((tag): tag is string => Boolean(tag));
  for (const tag of tags) {
    const match = languages.find(l => tag === l || tag.startsWith(`${l}-`));
    if (match) return match;
  }
  return undefined;
}

/**
 * Server-side adapter for SSR (Next.js Server Components, Cloudflare Workers,
 * etc). Reads from a per-request `cookie` / `accept-language` snapshot supplied
 * by the consumer. Writes are no-ops — persistence is the client's job.
 *
 * Usage (Next.js Server Component):
 *   const adapter = createHeaderAdapter({
 *     cookie: cookies().toString(),
 *     acceptLanguage: headers().get('accept-language'),
 *   });
 */
export function createHeaderAdapter(input: HeaderAdapterInput): LocaleAdapter {
  return {
    read() {
      return parseCookie(input.cookie) ?? parseAcceptLanguage(input.acceptLanguage);
    },
    write() {
      // Server adapter has no persistence — the client will set the cookie.
    },
  };
}
