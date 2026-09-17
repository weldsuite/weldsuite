/**
 * RFC 2369 `List-Unsubscribe` / RFC 8058 `List-Unsubscribe-Post` helpers.
 *
 * Pure functions, shared by mail-inbound-worker (live ingest) and app-api
 * (backfill from stored raw messages + performing the unsubscribe).
 */

export interface ListUnsubscribeInfo {
  /** First https URL in the header, if any. Plain http is ignored. */
  url: string | null;
  /** First mailto: URI in the header, if any. */
  mailto: string | null;
  /** Sender supports RFC 8058 one-click (POST to `url`). */
  oneClick: boolean;
  /** `List-Id` header value with the angle brackets stripped. */
  listId: string | null;
}

export interface MailtoTarget {
  to: string;
  subject: string;
  body: string;
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * Parse the unsubscribe targets out of a message's headers. Returns null
 * when the message has no usable `List-Unsubscribe` header.
 */
export function parseListUnsubscribe(headers: Record<string, string> | undefined): ListUnsubscribeInfo | null {
  const raw = headerValue(headers, 'list-unsubscribe');
  if (!raw) return null;

  let url: string | null = null;
  let mailto: string | null = null;
  const entries = [...raw.matchAll(/<([^>]+)>/g)].map((m) => m[1]!.trim());
  // Some senders omit the angle brackets around a single URI.
  if (entries.length === 0) entries.push(...raw.split(',').map((s) => s.trim()));

  for (const entry of entries) {
    const lower = entry.toLowerCase();
    if (!url && lower.startsWith('https://') && isSafeUnsubscribeUrl(entry)) url = entry;
    else if (!mailto && lower.startsWith('mailto:') && parseMailto(entry)) mailto = entry;
  }
  if (!url && !mailto) return null;

  const post = headerValue(headers, 'list-unsubscribe-post') ?? '';
  const oneClick = Boolean(url) && /list-unsubscribe\s*=\s*one-click/i.test(post);
  const listIdRaw = headerValue(headers, 'list-id');
  const listId = listIdRaw ? (/<([^>]+)>/.exec(listIdRaw)?.[1] ?? listIdRaw).trim().slice(0, 500) : null;

  return { url, mailto, oneClick, listId };
}

/**
 * Only public https URLs may be requested server-side. Rejects IP
 * literals, localhost and internal-looking hostnames.
 */
export function isSafeUnsubscribeUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  if (!host.includes('.')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return false;
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home|corp)$/.test(host)) return false;
  return true;
}

/** Split a `mailto:` URI into recipient, subject and body. */
export function parseMailto(value: string): MailtoTarget | null {
  if (!/^mailto:/i.test(value)) return null;
  const rest = value.slice('mailto:'.length);
  const [addressPart = '', query = ''] = rest.split('?', 2);
  let to: string;
  try {
    to = decodeURIComponent(addressPart).trim();
  } catch {
    return null;
  }
  if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(to)) return null;

  const params = new URLSearchParams(query);
  return {
    to,
    subject: params.get('subject')?.trim() || 'unsubscribe',
    body: params.get('body')?.trim() || 'unsubscribe',
  };
}

/**
 * Pull the header block out of a raw RFC 5322 message and unfold it into a
 * name → value map. Used to backfill subscriptions from stored messages.
 * When a header repeats, the first occurrence wins.
 */
export function parseRawHeaders(rawMessage: string): Record<string, string> {
  const end = rawMessage.search(/\r?\n\r?\n/);
  const block = end === -1 ? rawMessage : rawMessage.slice(0, end);
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  const headers: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    if (!(name in headers)) headers[name] = line.slice(idx + 1).trim();
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Unsubscribe
// ---------------------------------------------------------------------------

export type UnsubscribeMethod = 'one_click' | 'mailto' | 'link';

export class UnsubscribeError extends Error {
  constructor(
    public readonly code: 'NO_UNSUBSCRIBE_METHOD' | 'UNSUBSCRIBE_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'UnsubscribeError';
  }
}

export interface UnsubscribeTargets {
  unsubscribeUrl: string | null;
  unsubscribeMailto: string | null;
  oneClick: boolean;
}

export interface UnsubscribeDeps {
  /** POST for RFC 8058 one-click. Injectable for tests. */
  fetch: typeof fetch;
  /** Send the mailto unsubscribe message from the mailbox itself. */
  sendMail: (input: MailtoTarget) => Promise<void>;
}

export interface UnsubscribeOutcome {
  method: UnsubscribeMethod;
  /** Set for `link`: the page the user must open to finish unsubscribing. */
  url: string | null;
}

/**
 * Pick and perform the best unsubscribe mechanism, Gmail-style:
 *   1. RFC 8058 one-click: POST to the https URL.
 *   2. mailto: send the unsubscribe email.
 *   3. Plain https link: hand the URL back for the client to open.
 * Throws `UnsubscribeError` when nothing works.
 */
export async function performUnsubscribe(
  targets: UnsubscribeTargets,
  deps: UnsubscribeDeps,
): Promise<UnsubscribeOutcome> {
  const url = targets.unsubscribeUrl && isSafeUnsubscribeUrl(targets.unsubscribeUrl) ? targets.unsubscribeUrl : null;
  const mailto = targets.unsubscribeMailto ? parseMailto(targets.unsubscribeMailto) : null;
  let lastError: unknown = null;

  if (url && targets.oneClick) {
    try {
      const res = await deps.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      // RFC 8058 senders answer 2xx; some redirect to a confirmation page.
      if (res.status >= 200 && res.status < 400) return { method: 'one_click', url: null };
      lastError = new Error(`One-click POST returned HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
  }

  if (mailto) {
    try {
      await deps.sendMail(mailto);
      return { method: 'mailto', url: null };
    } catch (err) {
      lastError = err;
    }
  }

  if (url) return { method: 'link', url };

  if (lastError) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new UnsubscribeError('UNSUBSCRIBE_FAILED', `Unsubscribe failed: ${detail}`);
  }
  throw new UnsubscribeError('NO_UNSUBSCRIBE_METHOD', 'This sender offers no way to unsubscribe');
}

// ---------------------------------------------------------------------------
// Backfill aggregation
// ---------------------------------------------------------------------------

export interface StoredMessageHeaders {
  from: { email?: string | null; name?: string | null } | null;
  subject: string | null;
  receivedAt: Date;
  /** Leading part of the raw RFC 5322 message; only the header block is read. */
  rawHeaders: string | null;
}

export interface SubscriptionAggregate {
  senderEmail: string;
  senderName: string | null;
  senderDomain: string | null;
  listId: string | null;
  unsubscribeUrl: string | null;
  unsubscribeMailto: string | null;
  oneClick: boolean;
  messageCount: number;
  lastSubject: string | null;
  firstReceivedAt: Date;
  lastReceivedAt: Date;
}

/**
 * Group stored messages by lower-cased sender into subscription rows.
 * Expects rows newest-first so the freshest unsubscribe targets win.
 */
export function aggregateSubscriptions(rows: StoredMessageHeaders[]): SubscriptionAggregate[] {
  const bySender = new Map<string, SubscriptionAggregate>();
  for (const row of rows) {
    const senderEmail = row.from?.email?.trim().toLowerCase();
    if (!senderEmail || !row.rawHeaders) continue;
    const info = parseListUnsubscribe(parseRawHeaders(row.rawHeaders));
    if (!info) continue;

    const agg = bySender.get(senderEmail);
    if (!agg) {
      bySender.set(senderEmail, {
        senderEmail,
        senderName: row.from?.name?.slice(0, 255) || null,
        senderDomain: senderEmail.split('@')[1] ?? null,
        listId: info.listId,
        unsubscribeUrl: info.url,
        unsubscribeMailto: info.mailto,
        oneClick: info.oneClick,
        messageCount: 1,
        lastSubject: row.subject?.slice(0, 998) ?? null,
        firstReceivedAt: row.receivedAt,
        lastReceivedAt: row.receivedAt,
      });
    } else {
      agg.messageCount += 1;
      if (row.receivedAt < agg.firstReceivedAt) agg.firstReceivedAt = row.receivedAt;
      if (row.receivedAt > agg.lastReceivedAt) agg.lastReceivedAt = row.receivedAt;
    }
  }
  return [...bySender.values()];
}
