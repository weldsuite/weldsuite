import { describe, expect, it } from 'vitest';
import { allowed, senderKind } from './senders';

const ID = 'nlmnjlkgeoeklbahlemmlcfnlfgdimnp';

describe('senderKind', () => {
  it('knows the popup and the settings page', () => {
    expect(senderKind({ id: ID, url: `chrome-extension://${ID}/popup.html` }, ID)).toEqual({ kind: 'page' });
    expect(senderKind({ id: ID, url: `chrome-extension://${ID}/settings.html#server`, tab: { id: 4 } }, ID)).toEqual({
      kind: 'page',
    });
  });

  it('knows the framed pages by path, also at a dynamic URL, and only inside a tab', () => {
    expect(senderKind({ id: ID, url: 'chrome-extension://0123-dynamic/menu.html#n=x', tab: { id: 9 } }, ID)).toEqual({
      kind: 'menu',
      tabId: 9,
    });
    expect(senderKind({ id: ID, url: `chrome-extension://${ID}/prompt.html`, tab: { id: 2 } }, ID)).toEqual({
      kind: 'prompt',
      tabId: 2,
    });
    expect(senderKind({ id: ID, url: `chrome-extension://${ID}/menu.html` }, ID)).toBeNull();
    expect(senderKind({ id: ID, url: `chrome-extension://${ID}/other.html`, tab: { id: 2 } }, ID)).toBeNull();
  });

  it('takes a content script frame and origin from the browser-set sender', () => {
    expect(
      senderKind({ id: ID, url: 'https://login.example.com/', tab: { id: 3 }, frameId: 7, documentId: 'd' }, ID),
    ).toEqual({ kind: 'content', tabId: 3, frameId: 7, documentId: 'd', url: 'https://login.example.com/' });
  });

  it('answers nobody else', () => {
    expect(senderKind({ id: 'another-extension', url: 'https://example.com/', tab: { id: 1 }, frameId: 0 }, ID)).toBeNull();
    expect(senderKind({ id: ID, url: 'https://example.com/', frameId: 0 }, ID)).toBeNull();
    expect(senderKind({ id: ID, url: 'file:///etc/passwd', tab: { id: 1 }, frameId: 0 }, ID)).toBeNull();
    expect(senderKind({ id: ID }, ID)).toBeNull();
  });
});

describe('allowed', () => {
  const content = { kind: 'content' as const, tabId: 1, frameId: 0, documentId: undefined, url: 'https://a.example/' };

  it('lets a content script send only content messages: never a reveal', () => {
    expect(allowed(content, 'content:capture')).toBe(true);
    for (const type of ['item:reveal', 'items:list', 'menu:fill', 'prompt:save', 'auth:sign-out', 'settings:set']) {
      expect(allowed(content, type)).toBe(false);
    }
  });

  it('lets the menu and the save bar send only their own messages', () => {
    expect(allowed({ kind: 'menu', tabId: 1 }, 'menu:fill')).toBe(true);
    expect(allowed({ kind: 'menu', tabId: 1 }, 'item:reveal')).toBe(false);
    expect(allowed({ kind: 'menu', tabId: 1 }, 'prompt:save')).toBe(false);
    expect(allowed({ kind: 'prompt', tabId: 1 }, 'prompt:save')).toBe(true);
    expect(allowed({ kind: 'prompt', tabId: 1 }, 'menu:fill')).toBe(false);
  });

  it("keeps the popup out of the frames' messages", () => {
    expect(allowed({ kind: 'page' }, 'item:reveal')).toBe(true);
    expect(allowed({ kind: 'page' }, 'menu:fill')).toBe(false);
    expect(allowed({ kind: 'page' }, 'content:capture')).toBe(false);
  });
});
