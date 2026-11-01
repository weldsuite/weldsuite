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
  /**
   * Compare the value decoded instead of masking it: `base64-json` is a
   * base64 JSON string (Telnyx's `client_state`), whose new ids are then
   * normalised like any other.
   */
  decode?: 'base64-json';
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
  /** The same in each third-party call it makes: dot paths into `{ method, url, body }`. */
  outbound?: VolatileField[];
}

/** A desk phone tool token (`Bearer <claims>.<signature>`) at `path`. */
function toolToken(path: string): VolatileField {
  return { path, pattern: /^Bearer \S+$/g, replacement: 'Bearer <volatile>' };
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
  // WeldAds' Facebook OAuth start: a fresh state (`crypto.randomUUID()`) per run.
  {
    method: 'POST',
    route: '/api/ad-connections/facebook/authorize',
    fields: [
      { path: 'data.state' },
      { path: 'data.authorizeUrl', pattern: /state=[0-9a-f-]{36}/g, replacement: 'state=<volatile>' },
    ],
  },
  // A widget's new identity secret: 32 random bytes per run.
  { method: 'POST', route: '/api/desk/widget/:widgetId/identity', fields: [{ path: 'data.secret' }] },
  // The widget's realtime token: an HS256 JWT whose `iat` is the second it was
  // minted, so its payload and signature differ per run. Its content is checked
  // by the test itself. The route is the prefixed one Rust serves the worker at.
  { method: 'POST', route: '/public/helpdesk-widget/api/realtime/token', fields: [{ path: 'data.token' }] },
  // The widget's visitor token (POST /api/visitor): an HS256 JWT stamped with
  // the second it was issued, so it differs per run like the realtime token.
  // The visitor tests decode it and check its claims and signature.
  { method: 'POST', route: '/public/helpdesk-widget/api/visitor', fields: [{ path: 'data.visitorToken' }] },
  // The widget worker's health check stamps the time it answered.
  { method: 'GET', route: '/public/helpdesk-widget/health', fields: [{ path: 'timestamp' }] },
  // WeldStash numbers its pick lists, putaway tasks and transfers from
  // `Date.now()` in base 36 (`PL-…`, `PUT-…`, `TRF-…-<id>`), new per run.
  { method: 'POST', route: '/api/pick-lists', fields: [{ path: 'data.pickListNumber' }] },
  {
    method: 'POST',
    route: '/api/pick-lists/generate',
    fields: [{ path: 'data.pickListNumber' }],
    events: [{ path: 'data.pickListNumber' }],
  },
  {
    method: 'POST',
    route: '/api/putaway',
    fields: [{ path: 'data.movementNumber' }],
    events: [{ path: 'data.movementNumber' }],
  },
  {
    method: 'POST',
    route: '/api/inventory/transfer',
    fields: [{ path: 'data.movementNumber' }],
    events: [{ path: 'data.movementNumber' }],
  },
  // The activity summary's period ends now and starts N days before.
  {
    method: 'GET',
    route: '/api/wms-activity/summary',
    fields: [{ path: 'data.startDate' }, { path: 'data.endDate' }],
  },
  // WeldFlow's timer: a stopped entry's duration is the minutes since it
  // started, to two decimals (`minutesBetween`), so it ticks every 0.6 s and
  // the two runs can straddle a tick. The whole minutes are still compared,
  // in the answer and in the entry's `project_time_entry` event. The event
  // also carries the same duration as whole seconds and as hours to two
  // decimals (`timeEntryAnalyticsPayload`), which tick every second and every
  // 36 s.
  {
    method: 'POST',
    route: '/api/time-entries/timer/stop',
    fields: [{ path: 'data.duration', pattern: /\.\d+$/, replacement: '.<volatile>' }],
    events: [
      { path: 'data.duration', pattern: /\.\d+$/, replacement: '.<volatile>' },
      { path: 'data.durationSeconds' },
      { path: 'data.actualHours' },
    ],
  },
  // WeldCommerce: a webhook's drawn signing secret (`whksec_` + 32 random
  // characters), and how long its test delivery took.
  {
    method: 'POST',
    route: '/api/parcel-notifications/webhooks',
    fields: [{ path: 'data.secret', pattern: /^whksec_[A-Za-z0-9]{32}$/g, replacement: 'whksec_<volatile>' }],
  },
  { method: 'POST', route: '/api/parcel-notifications/webhooks/:id/test', fields: [{ path: 'data.responseTimeMs' }] },
  // `Date.now()` in base 36 plus random characters (`ORD-…-XXXX`, `RMA-…-XXXX`).
  { method: 'POST', route: '/api/orders', events: [{ path: 'data.orderNumber' }], fields: [] },
  {
    method: 'POST',
    route: '/public/commerce-portal/orders',
    fields: [{ path: 'data.orderNumber' }],
    events: [{ path: 'data.orderNumber' }],
  },
  {
    method: 'POST',
    route: '/public/commerce-portal/returns',
    fields: [{ path: 'data.returnNumber' }],
    events: [{ path: 'data.returnNumber' }],
  },
  // The order portal's buyer session and company-picker tokens: 32 random bytes per run.
  {
    method: 'POST',
    route: '/public/commerce-portal/auth/verify',
    fields: [{ path: 'data.token' }, { path: 'data.pickerToken' }],
  },
  { method: 'POST', route: '/public/commerce-portal/auth/select-company', fields: [{ path: 'data.token' }] },
  // WeldBooks: the exchange rates are stamped with the moment they were answered.
  { method: 'GET', route: '/api/accounting-settings/exchange-rates', fields: [{ path: 'data.fetchedAt' }] },
  { method: 'GET', route: '/api/accounting-settings/exchange-rate/:from/:to', fields: [{ path: 'data.fetchedAt' }] },
  // WeldCall: a voice agent's Telnyx assistant carries a tool token that
  // expires a day from the current second (and names the new call).
  ...['/api/desk/phone/agents', '/api/desk/phone/agents/:id'].map((route) => ({
    method: route.endsWith(':id') ? 'PATCH' : 'POST',
    route,
    fields: [],
    outbound: [toolToken('body.tools.1.webhook.headers.0.value')],
  })),
  // The Telnyx webhook routes an inbound call: its Call Control requests carry
  // the new call and conversation ids in base64 JSON (`client_state`), and
  // the voice agent's tool token.
  {
    method: 'POST',
    route: '/public/webhooks/telnyx',
    fields: [],
    outbound: [
      { path: 'body.client_state', decode: 'base64-json' },
      toolToken('body.assistant.tools.1.webhook.headers.0.value'),
    ],
  },
];

function mask(value: unknown, field: VolatileField): unknown {
  if (field.decode === 'base64-json' && typeof value === 'string') {
    try {
      return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as unknown;
    } catch {
      return value;
    }
  }
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

/** The request's third-party calls with the route's volatile values masked. */
export function maskVolatileOutbound<T>(method: string, route: string | null, calls: T[]): T[] {
  const fields = entryFor(method, route)?.outbound;
  if (!fields?.length) return calls;
  return calls.map((call) => fields.reduce<unknown>((masked, field) => maskAt(masked, field.path.split('.'), field), call) as T);
}

/** The request's entity events with the route's volatile values masked. */
export function maskVolatileEvents(method: string, route: string | null, events: unknown[]): unknown[] {
  const fields = entryFor(method, route)?.events;
  if (!fields?.length) return events;
  return events.map((event) => fields.reduce((masked, field) => maskAt(masked, field.path.split('.'), field), event));
}
