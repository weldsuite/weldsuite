/**
 * The preview bridge between the online store editor and the shop preview in
 * its iframe (`postMessage`, objects with `source: 'weldsuite-storefront'`).
 *
 * The editor only reads messages from its own iframe's window and from the
 * preview's exact origin (scheme, host and port, from the preview URL the API
 * handed out), and only sends to that origin, never `*`. Origins are compared
 * after parsing with `URL`, rejecting the opaque `"null"` origin, as the
 * Modern Web Guidance `validate-origins` guide does where the `Origin` API is
 * not available (it is not Baseline yet).
 */

import { GROUP_NAMES, TEMPLATE_NAMES, type ListName } from '@weldsuite/storefront-theme/catalog';

export const BRIDGE_SOURCE = 'weldsuite-storefront';

export type EditorMessage = { type: 'refresh' } | { type: 'highlight'; sectionId: string | null } | { type: 'navigate'; path: string };

export type PreviewMessage = { type: 'ready'; path: string } | { type: 'select'; sectionId: string; list: ListName };

const LIST_NAMES: readonly string[] = [...TEMPLATE_NAMES, ...GROUP_NAMES, 'content'];

/** The origin of an `http(s)` URL, or `null` for anything else (including opaque origins). */
export function previewOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.origin === 'null' ? null : parsed.origin;
  } catch {
    return null;
  }
}

/** True when `candidate` (a `MessageEvent.origin`) is exactly `trusted`. */
export function isSameOrigin(candidate: string, trusted: string): boolean {
  if (candidate === 'null' || trusted === 'null') return false;
  const a = previewOrigin(candidate);
  const b = previewOrigin(trusted);
  return a !== null && a === b;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * The bridge message in `event`, or `null` when it is not one, or does not
 * come from the preview's window and origin.
 */
export function readPreviewMessage(
  event: Pick<MessageEvent, 'origin' | 'data' | 'source'>,
  expected: { origin: string | null; source: MessageEventSource | null },
): PreviewMessage | null {
  if (!expected.origin || !expected.source || event.source !== expected.source) return null;
  if (!isSameOrigin(event.origin, expected.origin)) return null;
  const data: unknown = event.data;
  if (typeof data !== 'object' || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.source !== BRIDGE_SOURCE) return null;
  if (message.type === 'ready') return { type: 'ready', path: isString(message.path) ? message.path : '/' };
  if (message.type === 'select' && isString(message.sectionId) && isString(message.list) && LIST_NAMES.includes(message.list)) {
    return { type: 'select', sectionId: message.sectionId, list: message.list as ListName };
  }
  return null;
}

/** Posts `message` to the preview, addressed to its origin only. False when there is no preview to post to. */
export function sendToPreview(target: Pick<Window, 'postMessage'> | null | undefined, origin: string | null, message: EditorMessage): boolean {
  if (!target || !origin) return false;
  target.postMessage({ source: BRIDGE_SOURCE, ...message }, origin);
  return true;
}
