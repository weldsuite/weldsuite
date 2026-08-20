/**
 * Realtime Register ADAC (Advanced Domain Availability Checker).
 *
 * Separate from the registrar REST API: different host, different API key
 * (`REALTIME_REGISTER_ADAC_API_KEY`), check-only. The REST `GET /v2/domains/{name}/check`
 * fan-out is a poor substitute — ADAC returns a TLD set in one POST. Suggestion
 * tools stay disabled on search; WeldHost only shows the typed name across TLDs.
 *
 * REST: POST https://adac.api.yoursrs.com/action
 * Body: { action: "input" | "check", api_key, data: { input, tld_set_token? } }
 * Response: JSON array of { action, data } events (chunked until complete).
 *
 * @see https://dm.realtimeregister.com/docs/api/adac
 */

import { RealtimeRegistrarError } from './errors';

export const ADAC_ACTION_URL = 'https://adac.api.yoursrs.com/action';
export const ADAC_REQUEST_TIMEOUT_MS = 30_000;

/** ADAC `data.status` — https://dm.realtimeregister.com/docs/api/adac/input */
export const ADAC_STATUS = {
  WAITING: 0,
  AVAILABLE: 1,
  TAKEN: 2,
  INVALID: 3,
  ERROR: 4,
  UNKNOWN: 5,
} as const;

export type AdacActionName = 'input' | 'check';

/** Pass `false` per tool so ADAC `input` does not emit similar-name suggestions. */
export const ADAC_DISABLE_SUGGESTION_HINTS = {
  domainsbot: false,
  sidn: false,
  rns: false,
  'prefixes-suffixes': false,
  namesuggestion: false,
} as const;

export interface AdacDomainData {
  domain_name: string;
  suffix: string;
  status: number;
  source?: string;
  type?: string;
  currency?: string;
  price?: number;
}

export interface AdacEvent {
  action: string;
  data: AdacDomainData | string;
}

export interface AdacMappedResult {
  name: string;
  available: boolean;
  premium: boolean;
  priceCents?: number;
  currency?: string;
  reason?: string;
}

export function parseAdacEvents(text: string): AdacEvent[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed as AdacEvent[];
    if (parsed && typeof parsed === 'object') return [parsed as AdacEvent];
  } catch {
    // Chunked/NDJSON fallback — one JSON value per line.
  }

  const events: AdacEvent[] = [];
  for (const line of trimmed.split('\n')) {
    const row = line.trim();
    if (!row) continue;
    try {
      const parsed = JSON.parse(row) as unknown;
      if (Array.isArray(parsed)) events.push(...(parsed as AdacEvent[]));
      else if (parsed && typeof parsed === 'object') events.push(parsed as AdacEvent);
    } catch {
      // Skip a malformed chunk rather than failing the whole search.
    }
  }
  return events;
}

function isDomainData(data: AdacEvent['data']): data is AdacDomainData {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof data.domain_name === 'string' &&
    typeof data.status === 'number'
  );
}

/**
 * Map one ADAC event. Waiting (0) is skipped so a later status for the same
 * name can win. Error events are handled by the caller before mapping.
 */
export function mapAdacEvent(event: AdacEvent): AdacMappedResult | null {
  if (event.action !== 'domain_status') return null;
  if (!isDomainData(event.data)) return null;
  if (event.data.status === ADAC_STATUS.WAITING) return null;

  const available = event.data.status === ADAC_STATUS.AVAILABLE;
  const premium = event.data.type === 'premium';
  const reason = available
    ? undefined
    : event.data.status === ADAC_STATUS.TAKEN
      ? 'domain_unavailable'
      : event.data.status === ADAC_STATUS.ERROR
        ? 'check_failed'
        : event.data.status === ADAC_STATUS.INVALID
          ? 'unknown'
          : 'unknown';

  return {
    name: event.data.domain_name.toLowerCase(),
    available,
    premium,
    priceCents: typeof event.data.price === 'number' ? event.data.price : undefined,
    currency: event.data.currency,
    reason,
  };
}

/** Collapse streaming duplicates: last non-waiting status per domain wins. */
export function collapseAdacResults(events: AdacEvent[]): AdacMappedResult[] {
  const error = events.find((e) => e.action === 'error');
  if (error) {
    const message = typeof error.data === 'string' ? error.data : 'ADAC error';
    throw new RealtimeRegistrarError(400, 'ADAC_ERROR', message, 'adac', error);
  }

  const order: string[] = [];
  const byName = new Map<string, AdacMappedResult>();
  for (const event of events) {
    const mapped = mapAdacEvent(event);
    if (!mapped) continue;
    if (!byName.has(mapped.name)) order.push(mapped.name);
    byName.set(mapped.name, mapped);
  }
  return order.map((name) => byName.get(name)!);
}

export async function postAdacAction(
  fetchImpl: typeof fetch,
  opts: {
    apiKey: string;
    action: AdacActionName;
    input: string;
    tldSetToken?: string;
    timeoutMs?: number;
    hints?: Record<string, unknown>;
  },
): Promise<AdacEvent[]> {
  const timeoutMs = opts.timeoutMs ?? ADAC_REQUEST_TIMEOUT_MS;
  const body: Record<string, unknown> = {
    action: opts.action,
    api_key: opts.apiKey,
    data: {
      input: opts.input,
      ...(opts.tldSetToken ? { tld_set_token: opts.tldSetToken } : {}),
      ...(opts.hints ? { hints: opts.hints } : {}),
    },
  };

  const signal =
    typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
      ? AbortSignal.timeout(timeoutMs)
      : undefined;

  let res: Response;
  try {
    res = await fetchImpl(ADAC_ACTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const aborted =
      (err instanceof Error && err.name === 'AbortError') ||
      (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'TimeoutError');
    throw new RealtimeRegistrarError(
      0,
      aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
      `ADAC ${aborted ? 'timeout' : 'network error'}: ${err instanceof Error ? err.message : String(err)}`,
      'adac',
    );
  }

  const text = await res.text();
  if (!res.ok) {
    let message = `ADAC returned ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { data?: unknown; message?: string };
      if (typeof parsed.message === 'string') message = parsed.message;
      else if (typeof parsed.data === 'string') message = parsed.data;
    } catch {
      if (text) message = text.slice(0, 300);
    }
    throw new RealtimeRegistrarError(res.status, `HTTP_${res.status}`, message, 'adac', text);
  }

  return parseAdacEvents(text);
}
