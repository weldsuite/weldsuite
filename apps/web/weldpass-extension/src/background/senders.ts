/**
 * Who sent a message. The worker answers by sender, never by what a message
 * claims about itself:
 *
 * - `page`: the popup or the settings page. Everything is allowed.
 * - `menu` / `prompt`: the inline menu or the save bar, extension pages framed
 *   into a web page. Only their own requests, for a nonce registered to the
 *   same tab.
 * - `content`: a content script in a web page. Its frame's origin comes from
 *   the sender's URL, which the browser sets; a page can't forge it.
 *
 * Web pages can't message the worker at all: the manifest has no
 * `externally_connectable`.
 */

export type SenderKind =
  | { kind: 'page' }
  | { kind: 'menu'; tabId: number }
  | { kind: 'prompt'; tabId: number }
  | {
      kind: 'content';
      tabId: number;
      frameId: number;
      documentId: string | undefined;
      /** The frame's own URL: its origin is what the fill policy judges. */
      url: string;
    };

export interface SenderLike {
  id?: string;
  url?: string;
  tab?: { id?: number };
  frameId?: number;
  documentId?: string;
}

const PAGES = new Set(['/popup.html', '/settings.html']);

export function senderKind(sender: SenderLike, extensionId: string): SenderKind | null {
  if (sender.id !== extensionId || !sender.url) return null;

  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return null;
  }

  if (url.protocol === 'chrome-extension:') {
    // `use_dynamic_url` serves framed pages from a per-session host, so the
    // path, not the host, says which page this is. Only this extension's
    // pages can carry its id (checked above).
    if (PAGES.has(url.pathname)) return { kind: 'page' };
    const tabId = sender.tab?.id;
    if (tabId === undefined || tabId < 0) return null;
    if (url.pathname === '/menu.html') return { kind: 'menu', tabId };
    if (url.pathname === '/prompt.html') return { kind: 'prompt', tabId };
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const tabId = sender.tab?.id;
  if (tabId === undefined || tabId < 0 || typeof sender.frameId !== 'number') return null;
  return { kind: 'content', tabId, frameId: sender.frameId, documentId: sender.documentId, url: sender.url };
}

const PREFIX: Record<Exclude<SenderKind['kind'], 'page'>, string> = {
  menu: 'menu:',
  prompt: 'prompt:',
  content: 'content:',
};

/** Whether a sender of this kind may send a message of this type. */
export function allowed(sender: SenderKind, type: string): boolean {
  if (sender.kind === 'page') {
    return !type.startsWith('menu:') && !type.startsWith('prompt:') && !type.startsWith('content:');
  }
  return type.startsWith(PREFIX[sender.kind]);
}
