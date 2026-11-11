/**
 * The postMessage protocol between the embed SDK (on the host page) and the
 * portal's embed view (forms-portal `/f/<publicId>?embed=<mode>`, in an
 * iframe). The SDK and the portal change in lockstep: bump `PROTOCOL_VERSION`
 * for anything incompatible. See docs/plans/weldforms.md ("Embeds").
 *
 * Messages go from the portal to the host only; the host configures the form
 * through the iframe URL (`embedUrl`), so nothing the host page sends is ever
 * trusted by the portal.
 */

export const PROTOCOL_VERSION = 1;
export const MESSAGE_SOURCE = 'weldforms';

/** `inline`, `popup`, `slider` (side panel), `popover` (floating button), `fullpage`. */
export const EMBED_MODES = ['inline', 'popup', 'slider', 'popover', 'fullpage'] as const;
export type EmbedMode = (typeof EMBED_MODES)[number];

export function isEmbedMode(value: unknown): value is EmbedMode {
  return typeof value === 'string' && (EMBED_MODES as readonly string[]).includes(value);
}

interface Envelope<T extends string> {
  source: typeof MESSAGE_SOURCE;
  version: typeof PROTOCOL_VERSION;
  type: T;
  publicId: string;
}

/** The form loaded and shows its first screen. */
export type ReadyMessage = Envelope<'ready'>;
/** The content height in CSS pixels, for `autoResize`. */
export type HeightMessage = Envelope<'height'> & { height: number };
/** The respondent submitted. */
export type SubmittedMessage = Envelope<'submitted'> & { responseId: string };
/** The respondent asked to close the form (a Close button on the ending). */
export type CloseMessage = Envelope<'close'>;
/** The ending wants to send the visitor to `url`; only the host page may navigate its own window. */
export type RedirectMessage = Envelope<'redirect'> & { url: string };

export type PortalMessage = ReadyMessage | HeightMessage | SubmittedMessage | CloseMessage | RedirectMessage;
export type PortalMessageType = PortalMessage['type'];

/** Narrows an event payload to a portal message (any other page's postMessage is ignored). */
export function isPortalMessage(data: unknown): data is PortalMessage {
  if (typeof data !== 'object' || data === null) return false;
  const m = data as Record<string, unknown>;
  if (m.source !== MESSAGE_SOURCE || m.version !== PROTOCOL_VERSION || typeof m.publicId !== 'string') return false;
  switch (m.type) {
    case 'ready':
    case 'close':
      return true;
    case 'height':
      return typeof m.height === 'number' && Number.isFinite(m.height) && m.height >= 0;
    case 'submitted':
      return typeof m.responseId === 'string';
    case 'redirect':
      return typeof m.url === 'string';
    default:
      return false;
  }
}

/** Builds a message (the portal side). */
export function portalMessage<T extends PortalMessageType>(
  type: T,
  publicId: string,
  payload: Omit<Extract<PortalMessage, { type: T }>, 'source' | 'version' | 'type' | 'publicId'>,
): Extract<PortalMessage, { type: T }> {
  return { source: MESSAGE_SOURCE, version: PROTOCOL_VERSION, type, publicId, ...payload } as Extract<PortalMessage, { type: T }>;
}

/** Sends a message from the portal's embed view to the host page. */
export function postToHost<T extends PortalMessageType>(
  type: T,
  publicId: string,
  payload: Omit<Extract<PortalMessage, { type: T }>, 'source' | 'version' | 'type' | 'publicId'>,
  target: Pick<Window, 'postMessage'> | null = typeof window === 'undefined' || window.parent === window ? null : window.parent,
): void {
  // The host's origin is unknown (any allowed site embeds the form) and the messages carry nothing secret.
  target?.postMessage(portalMessage(type, publicId, payload), '*');
}

export const DEFAULT_BASE_URL = 'https://forms.weldsuite.org';

/** Drops every trailing slash with a single scan (a `/\/+$/` regex backtracks quadratically on long runs). */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

/** The iframe URL of a form: `<base>/f/<publicId>?embed=<mode>&<hidden fields>`. */
export function embedUrl(options: {
  baseUrl?: string;
  publicId: string;
  mode: EmbedMode;
  hidden?: Record<string, string>;
}): string {
  const base = stripTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL);
  const url = new URL(`${base}/f/${encodeURIComponent(options.publicId)}`);
  url.searchParams.set('embed', options.mode);
  for (const [name, value] of Object.entries(options.hidden ?? {})) {
    // `embed` is ours; a hidden field of that name would be dropped by the portal anyway.
    if (name !== 'embed') url.searchParams.set(name, value);
  }
  return url.toString();
}

/** `a=1,b=two` as `{ a: '1', b: 'two' }`; the part after the first `=` is the value (`=` allowed inside). */
export function parseHiddenAttribute(text: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  for (const part of text.split(',')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    if (!/^[a-zA-Z_]\w*$/.test(name)) continue;
    out[name] = part.slice(at + 1).trim();
  }
  return out;
}
