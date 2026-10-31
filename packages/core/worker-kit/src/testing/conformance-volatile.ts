/**
 * Response values that differ between the two runs of a request by
 * construction, beyond what `normalizeForDiff` already masks (generated ids,
 * ISO timestamps, epoch milliseconds in strings): secrets drawn from the
 * random source (a device code, a key's display prefix), a `Date.now()` as a
 * number, a signed link whose expiry is in seconds.
 *
 * Keyed by method and the Hono route pattern, like ./conformance-schemas.ts.
 * Each entry names a dot path into the body (`data.deviceCode`) and either
 * masks the whole value or, with `pattern`, only the parts that match. A
 * masked value keeps its type (`<volatile:string>`), so a field that one side
 * leaves out or answers with a different type still differs.
 */

export interface VolatileField {
  /** Dot path from the body's root; numeric segments index arrays. */
  path: string;
  /** Mask only the matches (a global pattern) instead of the whole value; strings only. */
  pattern?: RegExp;
  /** What a match becomes (default `<volatile>`). */
  replacement?: string;
}

interface VolatileRoute {
  method: string;
  route: string;
  fields: VolatileField[];
  /**
   * The same values where the request publishes them: dot paths into each
   * `ENTITY_EVENTS` message it sends (`data.duration`).
   */
  events?: VolatileField[];
}

const ROUTES: VolatileRoute[] = [
  // WeldApps: a signed bundle link (`/s/<exp>.<workspace>.<sig>/`) carries its
  // expiry in seconds, so it differs when the runs straddle a second.
  {
    method: 'POST',
    route: '/api/user-apps/code/:code/bundle-url',
    fields: [{ path: 'data.path', pattern: /\/s\/[^/]+\//g, replacement: '/s/<volatile>/' }],
  },
  // A version's bundle lives under its new id (`user-apps/<app>/<version>`).
  {
    method: 'POST',
    route: '/api/user-apps/:id/versions',
    fields: [{ path: 'data.bundleKey', pattern: /uav_[0-9a-z]+/g, replacement: '<id>' }],
  },
  // CLI login: a fresh device code and user code per run.
  {
    method: 'POST',
    route: '/api/cli-auth/device',
    fields: [{ path: 'data.deviceCode' }, { path: 'data.userCode' }, { path: 'data.verificationUriComplete' }],
  },
  // The minted key's display prefix (`wsk_` + 8 random hex characters).
  { method: 'POST', route: '/api/cli-auth/approve', fields: [{ path: 'data.keyPrefix' }] },
  // A scheduled message's Message-ID carries its new id (`<msg_…@scheduled…>`).
  {
    method: 'POST',
    route: '/api/mail-scheduled',
    fields: [{ path: 'data.smtpMessageId', pattern: /msg_[0-9a-z]+/g, replacement: '<id>' }],
  },
  // `Date.now() + 120s`, a number.
  { method: 'POST', route: '/api/auth-desktop/ticket', fields: [{ path: 'data.expiresAt' }] },
  // WeldDesk OAuth starts: a fresh state nonce (`crypto.randomUUID()`) per run.
  ...['discord', 'slack'].map((provider) => ({
    method: 'POST',
    route: `/api/helpdesk-integrations/${provider}/connect`,
    fields: [{ path: 'data.authUrl', pattern: /state=[0-9a-f-]{36}/g, replacement: 'state=<volatile>' }],
  })),
  // The widget's realtime token: an HS256 JWT whose `iat` is the second it was
  // minted, so its payload and signature differ per run. Its content is checked
  // by the test itself. The route is the prefixed one Rust serves the worker at.
  { method: 'POST', route: '/public/helpdesk-widget/api/realtime/token', fields: [{ path: 'data.token' }] },
  // The widget worker's health check stamps the time it answered.
  { method: 'GET', route: '/public/helpdesk-widget/health', fields: [{ path: 'timestamp' }] },
  // WeldFlow's timer: a stopped entry's duration is the minutes since it
  // started, to two decimals (`minutesBetween`), so it ticks every 0.6 s and
  // the two runs can straddle a tick. The whole minutes are still compared,
  // in the answer and in the entry's `project_time_entry` event.
  {
    method: 'POST',
    route: '/api/time-entries/timer/stop',
    fields: [{ path: 'data.duration', pattern: /\.\d+$/, replacement: '.<volatile>' }],
    events: [{ path: 'data.duration', pattern: /\.\d+$/, replacement: '.<volatile>' }],
  },
];

function mask(value: unknown, field: VolatileField): unknown {
  if (field.pattern && typeof value === 'string') return value.replace(field.pattern, field.replacement ?? '<volatile>');
  return `<volatile:${value === null ? 'null' : typeof value}>`;
}

function maskAt(value: unknown, segments: readonly string[], field: VolatileField): unknown {
  if (segments.length === 0) return mask(value, field);
  if (!value || typeof value !== 'object') return value;
  const [head, ...rest] = segments as [string, ...string[]];
  if (Array.isArray(value)) {
    const index = Number(head);
    if (!Number.isInteger(index) || index < 0 || index >= value.length) return value;
    const copy = [...value];
    copy[index] = maskAt(copy[index], rest, field);
    return copy;
  }
  const record = value as Record<string, unknown>;
  if (!(head in record)) return value;
  return { ...record, [head]: maskAt(record[head], rest, field) };
}

function entryFor(method: string, route: string | null): VolatileRoute | undefined {
  return route ? ROUTES.find((r) => r.method === method && r.route === route) : undefined;
}

/** `body` with the route's volatile values masked; unchanged for other routes. */
export function maskVolatile(method: string, route: string | null, body: unknown): unknown {
  const entry = entryFor(method, route);
  if (!entry) return body;
  return entry.fields.reduce((masked, field) => maskAt(masked, field.path.split('.'), field), body);
}

/** The request's entity events with the route's volatile values masked. */
export function maskVolatileEvents(method: string, route: string | null, events: unknown[]): unknown[] {
  const fields = entryFor(method, route)?.events;
  if (!fields?.length) return events;
  return events.map((event) => fields.reduce((masked, field) => maskAt(masked, field.path.split('.'), field), event));
}
