/**
 * The preview bridge's messages (contract "Preview bridge"): the platform's
 * editor frames the shop in preview mode and talks to it with postMessage.
 * Every message is an object with `source: 'weldsuite-storefront'`.
 */

import type { ListName } from '@weldsuite/storefront-theme';

export const BRIDGE_SOURCE = 'weldsuite-storefront';

/** Editor → shop. */
export type EditorMessage =
  | { type: 'refresh' }
  | { type: 'highlight'; sectionId: string | null }
  | { type: 'navigate'; path: string };

/** Shop → editor. */
export type ShopMessage = { type: 'ready'; path: string } | { type: 'select'; sectionId: string; list: ListName };

const SECTION_ID = /^[a-z0-9_-]{1,40}$/;

/** A message from the editor, or null for anything else. */
export function parseEditorMessage(data: unknown): EditorMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.source !== BRIDGE_SOURCE) return null;
  switch (message.type) {
    case 'refresh':
      return { type: 'refresh' };
    case 'highlight':
      if (message.sectionId === null) return { type: 'highlight', sectionId: null };
      return typeof message.sectionId === 'string' && SECTION_ID.test(message.sectionId) ? { type: 'highlight', sectionId: message.sectionId } : null;
    case 'navigate':
      // A path of this shop only, never another site.
      return typeof message.path === 'string' && message.path.startsWith('/') && !message.path.startsWith('//') && !message.path.startsWith('/\\')
        ? { type: 'navigate', path: message.path }
        : null;
    default:
      return null;
  }
}

/** The origin of `value` when it is an http(s) origin; null otherwise (including the opaque "null"). */
export function normalOrigin(value: string): string | null {
  if (!value || value === 'null') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** Whether a message's origin is one of the editor origins the install allows. */
export function isEditorOrigin(origin: string, allowed: readonly string[]): boolean {
  const normal = normalOrigin(origin);
  return normal !== null && allowed.some((entry) => normalOrigin(entry) === normal);
}
