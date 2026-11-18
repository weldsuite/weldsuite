import { afterEach, describe, expect, it, vi } from 'vitest';
import { autoInit, readElementOptions } from './auto';
import { createPopup, createWidget } from './index';
import { embedUrl, isPortalMessage, parseHiddenAttribute, portalMessage, postToHost, PROTOCOL_VERSION } from './protocol';

afterEach(() => {
  document.body.innerHTML = '';
  document.body.style.overflow = '';
  window.localStorage.clear();
  vi.useRealTimers();
});

/** Delivers a message to the window as if the iframe sent it. */
function deliver(iframe: HTMLIFrameElement, data: unknown, origin = 'https://forms.weldsuite.org') {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source: iframe.contentWindow }));
}

describe('protocol', () => {
  it('accepts well-formed portal messages only', () => {
    expect(isPortalMessage(portalMessage('ready', 'frm_1', {}))).toBe(true);
    expect(isPortalMessage(portalMessage('height', 'frm_1', { height: 420 }))).toBe(true);
    expect(isPortalMessage(portalMessage('submitted', 'frm_1', { responseId: 'r_1' }))).toBe(true);
    expect(isPortalMessage(portalMessage('redirect', 'frm_1', { url: 'https://example.com' }))).toBe(true);
    expect(isPortalMessage({ source: 'other', version: PROTOCOL_VERSION, type: 'ready', publicId: 'x' })).toBe(false);
    expect(isPortalMessage({ source: 'weldforms', version: 99, type: 'ready', publicId: 'x' })).toBe(false);
    expect(isPortalMessage({ source: 'weldforms', version: PROTOCOL_VERSION, type: 'height', publicId: 'x', height: -1 })).toBe(false);
    expect(isPortalMessage({ source: 'weldforms', version: PROTOCOL_VERSION, type: 'nope', publicId: 'x' })).toBe(false);
    expect(isPortalMessage('weldforms')).toBe(false);
    expect(isPortalMessage(null)).toBe(false);
  });

  it('posts to the parent window with the envelope', () => {
    const target = { postMessage: vi.fn() };
    postToHost('submitted', 'frm_1', { responseId: 'r_9' }, target);
    expect(target.postMessage).toHaveBeenCalledWith(
      { source: 'weldforms', version: PROTOCOL_VERSION, type: 'submitted', publicId: 'frm_1', responseId: 'r_9' },
      '*',
    );
  });

  it('builds the iframe URL with the mode and hidden fields', () => {
    const url = new URL(embedUrl({ publicId: 'frm 1', mode: 'popup', hidden: { source: 'pricing', embed: 'x' }, baseUrl: 'https://f.example.com/' }));
    expect(url.origin).toBe('https://f.example.com');
    expect(url.pathname).toBe('/f/frm%201');
    expect(url.searchParams.get('embed')).toBe('popup');
    expect(url.searchParams.get('source')).toBe('pricing');
  });

  it('parses the hidden-fields attribute', () => {
    expect(parseHiddenAttribute('a=1, b=two,c=x=y,=bad,9no=1,,d')).toEqual({ a: '1', b: 'two', c: 'x=y' });
    expect(parseHiddenAttribute(null)).toEqual({});
  });
});

describe('createWidget', () => {
  it('mounts an iframe and follows the reported height', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const onReady = vi.fn();
    const onSubmit = vi.fn();
    const widget = createWidget({ publicId: 'frm_1', container, hidden: { a: '1' }, onReady, onSubmit });
    const iframe = widget.iframe as HTMLIFrameElement;
    expect(container.contains(iframe)).toBe(true);
    expect(iframe.src).toContain('/f/frm_1?embed=inline&a=1');

    deliver(iframe, portalMessage('ready', 'frm_1', {}));
    expect(onReady).toHaveBeenCalledTimes(1);
    deliver(iframe, portalMessage('height', 'frm_1', { height: 612.4 }));
    expect(iframe.style.height).toBe('613px');
    deliver(iframe, portalMessage('submitted', 'frm_1', { responseId: 'r_1' }));
    expect(onSubmit).toHaveBeenCalledWith({ publicId: 'frm_1', responseId: 'r_1' });
  });

  it('ignores messages from another origin, window or form', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const onReady = vi.fn();
    const widget = createWidget({ publicId: 'frm_1', container, onReady });
    const iframe = widget.iframe as HTMLIFrameElement;
    deliver(iframe, portalMessage('ready', 'frm_1', {}), 'https://evil.example.com');
    deliver(iframe, portalMessage('ready', 'frm_other', {}));
    window.dispatchEvent(new MessageEvent('message', { data: portalMessage('ready', 'frm_1', {}), origin: 'https://forms.weldsuite.org', source: window }));
    expect(onReady).not.toHaveBeenCalled();
  });

  it('keeps a fixed height without autoResize', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const widget = createWidget({ publicId: 'frm_1', container, autoResize: false, height: 300 });
    const iframe = widget.iframe as HTMLIFrameElement;
    deliver(iframe, portalMessage('height', 'frm_1', { height: 900 }));
    expect(iframe.style.height).toBe('300px');
  });

  it('removes everything on destroy', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const widget = createWidget({ publicId: 'frm_1', container });
    widget.destroy();
    expect(container.querySelector('iframe')).toBeNull();
  });
});

describe('createPopup', () => {
  it('opens lazily, locks scroll, closes on Escape and reports it', () => {
    const onClose = vi.fn();
    const popup = createPopup({ publicId: 'frm_1', onClose });
    expect(popup.iframe).toBeNull();
    popup.open();
    expect(popup.isOpen).toBe(true);
    expect(popup.iframe?.src).toContain('embed=popup');
    expect(document.body.style.overflow).toBe('hidden');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(popup.isOpen).toBe(false);
    expect(document.body.style.overflow).toBe('');
    expect(onClose).toHaveBeenCalledTimes(1);
    popup.destroy();
  });

  it('opens on load, and not again after a submit when hideAfterSubmit is on', () => {
    vi.useFakeTimers();
    const first = createPopup({ publicId: 'frm_1', openOn: 'load', hideAfterSubmit: true });
    vi.advanceTimersByTime(5);
    expect(first.isOpen).toBe(true);
    deliver(first.iframe as HTMLIFrameElement, portalMessage('submitted', 'frm_1', { responseId: 'r_1' }));
    first.destroy();

    const second = createPopup({ publicId: 'frm_1', openOn: 'load', hideAfterSubmit: true });
    vi.advanceTimersByTime(5);
    expect(second.isOpen).toBe(false);
    second.destroy();
  });

  it('closes when the form asks to', () => {
    const popup = createPopup({ publicId: 'frm_1' });
    popup.open();
    deliver(popup.iframe as HTMLIFrameElement, portalMessage('close', 'frm_1', {}));
    expect(popup.isOpen).toBe(false);
    popup.destroy();
  });

  it('lets the host handle a redirect', () => {
    const onRedirect = vi.fn(() => false);
    const popup = createPopup({ publicId: 'frm_1', onRedirect });
    popup.open();
    deliver(popup.iframe as HTMLIFrameElement, portalMessage('redirect', 'frm_1', { url: 'https://example.com/thanks' }));
    expect(onRedirect).toHaveBeenCalledWith('https://example.com/thanks');
    popup.destroy();
  });
});

describe('auto init', () => {
  it('reads the attributes of an element', () => {
    const el = document.createElement('div');
    el.setAttribute('data-wf', 'frm_1');
    el.setAttribute('data-wf-mode', 'popup');
    el.setAttribute('data-wf-hidden', 'a=1,b=2');
    el.setAttribute('data-wf-open', 'scroll:60');
    el.setAttribute('data-wf-hide-after-submit', 'true');
    const parsed = readElementOptions(el);
    expect(parsed?.mode).toBe('popup');
    expect(parsed?.base.publicId).toBe('frm_1');
    expect(parsed?.base.hidden).toEqual({ a: '1', b: '2' });
    expect(parsed?.layer).toEqual({ openOn: 'scroll', scrollPercent: 60, hideAfterSubmit: true });
  });

  it('falls back to a widget for an unknown mode', () => {
    const el = document.createElement('div');
    el.setAttribute('data-wf', 'frm_1');
    el.setAttribute('data-wf-mode', 'bogus');
    expect(readElementOptions(el)?.mode).toBe('inline');
    expect(readElementOptions(document.createElement('div'))).toBeNull();
  });

  it('mounts widgets once and turns a popup element into its trigger', () => {
    document.body.innerHTML =
      '<div id="a" data-wf="frm_1" data-wf-hidden="x=1"></div><button id="b" data-wf="frm_2" data-wf-mode="popup">Open</button>';
    const handles = autoInit();
    expect(handles).toHaveLength(2);
    expect(autoInit()).toHaveLength(0);
    expect(document.querySelector('#a iframe')?.getAttribute('src')).toContain('x=1');
    expect(handles[1]?.isOpen).toBe(false);
    document.getElementById('b')?.click();
    expect(handles[1]?.isOpen).toBe(true);
  });
});
