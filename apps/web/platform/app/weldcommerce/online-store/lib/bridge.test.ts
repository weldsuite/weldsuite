import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_SOURCE, isSameOrigin, previewOrigin, readPreviewMessage, sendToPreview } from './bridge';

const frame = {} as MessageEventSource;
const ORIGIN = 'https://myshop.weldshop.eu';
const expected = { origin: ORIGIN, source: frame };

function event(data: unknown, origin = ORIGIN, source: MessageEventSource | null = frame) {
  return { data, origin, source };
}

describe('preview origin', () => {
  it('is the scheme, host and port of an http(s) preview URL', () => {
    expect(previewOrigin('https://myshop.weldshop.eu/__preview?token=abc')).toBe(ORIGIN);
    expect(previewOrigin('http://myshop.shop.localhost:8791/__preview?token=abc')).toBe('http://myshop.shop.localhost:8791');
    expect(previewOrigin('https://myshop.weldshop.eu:443/x')).toBe(ORIGIN);
  });

  it('is nothing for other schemes, opaque origins and garbage', () => {
    expect(previewOrigin('javascript:alert(1)')).toBeNull();
    expect(previewOrigin('data:text/html,hi')).toBeNull();
    expect(previewOrigin('not a url')).toBeNull();
    expect(previewOrigin(null)).toBeNull();
  });

  it('compares exact origins only', () => {
    expect(isSameOrigin(ORIGIN, ORIGIN)).toBe(true);
    expect(isSameOrigin('https://myshop.weldshop.eu:443', ORIGIN)).toBe(true);
    expect(isSameOrigin('https://myshop.weldshop.eu.attacker.example', ORIGIN)).toBe(false);
    expect(isSameOrigin('http://myshop.weldshop.eu', ORIGIN)).toBe(false);
    expect(isSameOrigin('https://other.weldshop.eu', ORIGIN)).toBe(false);
    expect(isSameOrigin('https://myshop.weldshop.eu:8443', ORIGIN)).toBe(false);
    expect(isSameOrigin('null', 'null')).toBe(false);
  });
});

describe('reading messages from the preview', () => {
  it('reads ready and select from the preview frame and origin', () => {
    expect(readPreviewMessage(event({ source: BRIDGE_SOURCE, type: 'ready', path: '/products' }), expected)).toEqual({ type: 'ready', path: '/products' });
    expect(readPreviewMessage(event({ source: BRIDGE_SOURCE, type: 'select', sectionId: 'hero', list: 'home' }), expected)).toEqual({
      type: 'select',
      sectionId: 'hero',
      list: 'home',
    });
    expect(readPreviewMessage(event({ source: BRIDGE_SOURCE, type: 'select', sectionId: 'text', list: 'content' }), expected)?.type).toBe('select');
  });

  it('refuses a message from another origin, even a look-alike one', () => {
    const message = { source: BRIDGE_SOURCE, type: 'select', sectionId: 'hero', list: 'home' };
    expect(readPreviewMessage(event(message, 'https://evil.example'), expected)).toBeNull();
    expect(readPreviewMessage(event(message, 'https://myshop.weldshop.eu.evil.example'), expected)).toBeNull();
    expect(readPreviewMessage(event(message, 'http://myshop.weldshop.eu'), expected)).toBeNull();
    expect(readPreviewMessage(event(message, 'null'), expected)).toBeNull();
  });

  it('refuses a message from another window on the right origin (another tab of the shop)', () => {
    const message = { source: BRIDGE_SOURCE, type: 'ready', path: '/' };
    expect(readPreviewMessage(event(message, ORIGIN, {} as MessageEventSource), expected)).toBeNull();
    expect(readPreviewMessage(event(message, ORIGIN, null), expected)).toBeNull();
  });

  it('refuses everything while there is no preview', () => {
    const message = { source: BRIDGE_SOURCE, type: 'ready', path: '/' };
    expect(readPreviewMessage(event(message), { origin: null, source: frame })).toBeNull();
    expect(readPreviewMessage(event(message), { origin: ORIGIN, source: null })).toBeNull();
  });

  it('ignores other messages and malformed ones', () => {
    expect(readPreviewMessage(event('hello'), expected)).toBeNull();
    expect(readPreviewMessage(event({ type: 'ready', path: '/' }), expected)).toBeNull();
    expect(readPreviewMessage(event({ source: 'other', type: 'ready' }), expected)).toBeNull();
    expect(readPreviewMessage(event({ source: BRIDGE_SOURCE, type: 'select', sectionId: 3, list: 'home' }), expected)).toBeNull();
    expect(readPreviewMessage(event({ source: BRIDGE_SOURCE, type: 'select', sectionId: 'x', list: 'checkout' }), expected)).toBeNull();
    expect(readPreviewMessage(event({ source: BRIDGE_SOURCE, type: 'refresh' }), expected)).toBeNull();
  });
});

describe('sending to the preview', () => {
  it('posts to the preview origin only, never to every origin', () => {
    const target = { postMessage: vi.fn() };
    expect(sendToPreview(target, ORIGIN, { type: 'highlight', sectionId: 'hero' })).toBe(true);
    expect(target.postMessage).toHaveBeenCalledWith({ source: BRIDGE_SOURCE, type: 'highlight', sectionId: 'hero' }, ORIGIN);
    sendToPreview(target, ORIGIN, { type: 'refresh' });
    expect(target.postMessage).toHaveBeenLastCalledWith({ source: BRIDGE_SOURCE, type: 'refresh' }, ORIGIN);
    expect(target.postMessage.mock.calls.every(([, origin]) => origin !== '*')).toBe(true);
  });

  it('sends nothing without a frame or an origin', () => {
    const target = { postMessage: vi.fn() };
    expect(sendToPreview(null, ORIGIN, { type: 'refresh' })).toBe(false);
    expect(sendToPreview(target, null, { type: 'refresh' })).toBe(false);
    expect(target.postMessage).not.toHaveBeenCalled();
  });
});
