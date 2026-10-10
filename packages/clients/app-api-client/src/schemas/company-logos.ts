/**
 * `/api/company-logos` — company logos resolved server-side.
 *
 * The platform never asks a third party for a company logo: it posts the
 * domains it wants to see to this endpoint, which serves them from the
 * workspace's own storage and fetches a missing one once, from the company's
 * own website (apps/workers/crm-api/src/lib/company-logo.ts).
 *
 * `normalizeLogoDomain` lives here, in the shared schema package, so the client
 * and the worker agree on what a lookup key is. It is deliberately free of
 * runtime dependencies other than `URL` (IDN to punycode).
 */

import { z } from 'zod';

/** Most domains one `POST /api/company-logos/resolve` accepts. */
export const COMPANY_LOGO_BATCH_MAX = 25;

export const resolveCompanyLogosSchema = z.object({
  domains: z.array(z.string().min(1).max(300)).min(1).max(COMPANY_LOGO_BATCH_MAX),
});

export type ResolveCompanyLogosInput = z.infer<typeof resolveCompanyLogosSchema>;

/**
 * Keyed by the strings the caller sent. A value is the public URL of the
 * stored logo; `null` means there is none (and the caller shows its initials).
 */
export const companyLogosResultSchema = z.object({
  logos: z.record(z.string().nullable()),
});

export type CompanyLogosResult = z.infer<typeof companyLogosResultSchema>;

/**
 * Mailbox providers: an address at one of these says nothing about the
 * company, so its domain must never turn into a logo (it would be Gmail's).
 */
const FREE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'outlook.nl',
  'hotmail.com',
  'hotmail.nl',
  'hotmail.be',
  'hotmail.co.uk',
  'hotmail.fr',
  'hotmail.de',
  'live.com',
  'live.nl',
  'live.be',
  'live.co.uk',
  'msn.com',
  'yahoo.com',
  'yahoo.nl',
  'yahoo.co.uk',
  'yahoo.fr',
  'yahoo.de',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.net',
  'gmx.de',
  'web.de',
  't-online.de',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'mail.ru',
  'qq.com',
  '163.com',
  '126.com',
  'fastmail.com',
  'tutanota.com',
  'tuta.io',
  'hey.com',
  'ziggo.nl',
  'kpnmail.nl',
  'planet.nl',
  'xs4all.nl',
  'telenet.be',
  'skynet.be',
  'proximus.be',
  'orange.fr',
  'free.fr',
  'wanadoo.fr',
  'laposte.net',
  'btinternet.com',
  'sky.com',
  'virginmedia.com',
]);

/** Top-level names that never resolve on the public internet. */
const NON_PUBLIC_TLDS: ReadonlySet<string> = new Set([
  'local',
  'localhost',
  'localdomain',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'private',
  'test',
  'example',
  'invalid',
  'onion',
  'arpa',
]);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * A DNS name on the public internet: two or more valid labels and a real TLD.
 * IP literals (v4, v6, decimal), `localhost`, single-label intranet hosts and
 * reserved suffixes all fail, which is what keeps the server-side fetch from
 * being aimed at anything but a public website.
 */
export function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host.length < 4 || host.length > 253) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((label) => LABEL.test(label))) return false;
  const tld = labels[labels.length - 1] ?? '';
  return TLD.test(tld) && !NON_PUBLIC_TLDS.has(tld);
}

/**
 * Reduce a website, bare domain or email address to the lookup key for its
 * logo: lowercase, no scheme, credentials, port, path or leading `www.`, IDN as
 * punycode. Returns `null` when the input is not a public company domain
 * (empty, an IP, `localhost`, a free mailbox provider, ...).
 */
export function normalizeLogoDomain(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  let host = input.trim().toLowerCase();
  if (host.length === 0 || host.length > 300) return null;

  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  host = host.split(/[/?#\\]/, 1)[0] ?? '';
  // Credentials, or the local part of an email address.
  const at = host.lastIndexOf('@');
  if (at !== -1) host = host.slice(at + 1);
  host = host.replace(/:\d{0,5}$/, '');
  host = host.replace(/\.+$/, '');
  if (host.includes(':') || host.includes('[')) return null;

  if (/[^ -~]/.test(host)) {
    try {
      host = new URL(`https://${host}`).hostname;
    } catch {
      return null;
    }
  }

  host = host.replace(/^www\./, '');
  if (!isPublicHostname(host)) return null;
  return FREE_EMAIL_DOMAINS.has(host) ? null : host;
}
