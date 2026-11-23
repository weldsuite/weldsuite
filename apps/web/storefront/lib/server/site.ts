/**
 * The site a request is for: `GET {API}/public/storefront/site?host=…`
 * with the renderer secret. A published version never changes, so its
 * document is kept by version id; the rest of the answer (locale, channel,
 * hosts) is kept per host for half a minute, or until the edge reports
 * another version for the host. A draft (preview) is never cached.
 */

import {
  defaultSiteDocument,
  TEMPLATE_NAMES,
  type PublishedDocument,
  type ShopChannel,
} from '@weldsuite/storefront-theme';
import { z } from 'zod';
import { rendererConfig } from './config';

export interface SiteResponse {
  workspaceId: string;
  channelId: string;
  siteId: string;
  host: string;
  primaryHost: string;
  /** `https://shop.example.com` (or `http://x.shop.localhost:8791` in dev): canonical URLs and payment links. */
  primaryOrigin: string;
  /** Every active host of the site, as an origin. */
  origins: string[];
  locale: string;
  visibility: string;
  preview: boolean;
  version: { id: string; number: number | null; document: PublishedDocument };
  channel: ShopChannel;
}

const envelope = z.object({
  data: z.object({
    workspaceId: z.string(),
    channelId: z.string(),
    siteId: z.string(),
    host: z.string(),
    primaryHost: z.string(),
    primaryOrigin: z.string().optional(),
    origins: z.array(z.string()).optional(),
    locale: z.string(),
    visibility: z.string(),
    preview: z.boolean(),
    version: z.object({ id: z.string(), number: z.number().nullable(), document: z.record(z.unknown()) }),
    channel: z.object({
      id: z.string(),
      name: z.string(),
      audience: z.enum(['b2c', 'b2b']),
      currency: z.string(),
      pricesIncludeTax: z.boolean(),
      guestCheckout: z.boolean(),
      paymentMethods: z.array(z.string()),
    }),
  }),
});

/** Why there is no site to draw: the host is unknown or nothing is published (404s), or the server failed. */
export class SiteUnavailableError extends Error {
  constructor(
    readonly code: 'SITE_NOT_FOUND' | 'NOT_PUBLISHED' | 'UPSTREAM_ERROR',
    readonly status: number,
  ) {
    super(`The storefront site is unavailable (${code})`);
    this.name = 'SiteUnavailableError';
  }
}

/**
 * The document with every part the theme needs: a template or group the
 * server left out (an older document) gets the theme's default.
 */
export function completeDocument(raw: Record<string, unknown>): PublishedDocument {
  const fallback = defaultSiteDocument();
  const doc = raw as Partial<PublishedDocument>;
  const templates = { ...fallback.templates };
  for (const name of TEMPLATE_NAMES) {
    const list = doc.templates?.[name];
    if (Array.isArray(list)) templates[name] = list;
  }
  return {
    schemaVersion: 1,
    theme: doc.theme?.settings ? doc.theme : fallback.theme,
    templates,
    groups: {
      header: Array.isArray(doc.groups?.header) ? doc.groups.header : fallback.groups.header,
      footer: Array.isArray(doc.groups?.footer) ? doc.groups.footer : fallback.groups.footer,
    },
    seo: doc.seo ?? {},
    settings: { ...fallback.settings, ...(doc.settings ?? {}) },
    pages: Array.isArray(doc.pages) ? doc.pages : [],
    menus: doc.menus && typeof doc.menus === 'object' ? doc.menus : {},
    redirects: Array.isArray(doc.redirects) ? doc.redirects : [],
  };
}

const HOST_TTL_MS = 30_000;
const MAX_HOSTS = 1_000;
const MAX_DOCUMENTS = 200;
const hosts = new Map<string, { at: number; site: SiteResponse }>();
const documents = new Map<string, PublishedDocument>();
const inFlight = new Map<string, Promise<SiteResponse>>();

function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  if (map.size >= max) map.delete(map.keys().next().value as K);
  map.set(key, value);
}

function originOf(host: string): string {
  return `https://${host}`;
}

async function fetchSite(host: string, previewToken: string | undefined): Promise<SiteResponse> {
  const config = rendererConfig();
  const query = new URLSearchParams({ host });
  if (previewToken) query.set('preview', previewToken);
  let response: Response;
  try {
    response = await fetch(`${config.apiUrl}/public/storefront/site?${query.toString()}`, {
      headers: { Authorization: `Bearer ${config.secret}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new SiteUnavailableError('UPSTREAM_ERROR', 503);
  }
  if (response.status === 404) {
    const body = (await response.json().catch(() => null)) as { error?: { code?: unknown } } | null;
    throw new SiteUnavailableError(body?.error?.code === 'NOT_PUBLISHED' ? 'NOT_PUBLISHED' : 'SITE_NOT_FOUND', 404);
  }
  if (!response.ok) throw new SiteUnavailableError('UPSTREAM_ERROR', 502);
  const parsed = envelope.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new SiteUnavailableError('UPSTREAM_ERROR', 502);
  const data = parsed.data.data;
  const versionId = data.version.id;
  let document = versionId !== 'draft' && !data.preview ? documents.get(versionId) : undefined;
  if (!document) {
    document = completeDocument(data.version.document);
    if (versionId !== 'draft' && !data.preview) remember(documents, versionId, document, MAX_DOCUMENTS);
  }
  return {
    ...data,
    primaryOrigin: data.primaryOrigin ?? originOf(data.primaryHost),
    origins: data.origins ?? [originOf(data.primaryHost)],
    channel: { ...data.channel, paymentMethods: data.channel.paymentMethods.filter((m): m is 'mollie' | 'invoice' => m === 'mollie' || m === 'invoice') },
    version: { id: versionId, number: data.version.number, document },
  };
}

export interface SiteRequest {
  host: string;
  previewToken?: string;
  /** `X-Storefront-Version`: the version the edge knows for the host. */
  versionHint?: string;
}

/** The site for a request (see the file comment for what is cached). */
export async function loadSite({ host, previewToken, versionHint }: SiteRequest): Promise<SiteResponse> {
  if (!host) throw new SiteUnavailableError('SITE_NOT_FOUND', 404);
  if (previewToken) return fetchSite(host, previewToken);
  const hit = hosts.get(host);
  if (hit && Date.now() - hit.at < HOST_TTL_MS && (!versionHint || hit.site.version.id === versionHint)) return hit.site;
  const pending = inFlight.get(host);
  if (pending) return pending;
  const request = fetchSite(host, undefined)
    .then((site) => {
      remember(hosts, host, { at: Date.now(), site }, MAX_HOSTS);
      return site;
    })
    .finally(() => inFlight.delete(host));
  inFlight.set(host, request);
  return request;
}

/** Forget everything (tests). */
export function clearSiteCache(): void {
  hosts.clear();
  documents.clear();
  inFlight.clear();
}
