import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from './client';
import { LIB_VERSION } from './event';
import { OPT_OUT_KEY, stateKey, type VisitorState } from './storage';
import { defineOn, installNetwork, onCleanup, resetPage, setup, HOST, TOKEN } from './test/harness';
import type { WireEvent } from './wire';

afterEach(resetPage);

function click(el: Element, clientX = 10, clientY = 20): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX, clientY }));
}

function stored(): VisitorState | null {
  const raw = localStorage.getItem(stateKey(TOKEN));
  return raw ? (JSON.parse(raw) as VisitorState) : null;
}

const byName = (events: WireEvent[], name: string) => events.filter((e) => e.name === name);

describe('batching', () => {
  it('sends as soon as 20 events are waiting', async () => {
    const { client, net } = setup();
    // The initial pageview is the first of the 20.
    for (let i = 0; i < 18; i++) client.api.track('Added to cart');
    expect(net.fetchMock).not.toHaveBeenCalled();
    client.api.track('Added to cart');
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
    const [first] = await net.sent();
    expect(first.batch.events).toHaveLength(20);
  });

  it('sends waiting events after 5 seconds', async () => {
    vi.useFakeTimers();
    const { net } = setup();
    await vi.advanceTimersByTimeAsync(4999);
    expect(net.fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await net.names()).toEqual(['$pageview']);
  });

  it('flush() sends right away and an empty queue sends nothing', async () => {
    const { client, net } = setup();
    await client.api.flush();
    await client.api.flush();
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('splits a queue that is over 64 KiB into several batches', async () => {
    const { client, net } = setup();
    const big = { a: 'x'.repeat(2048), b: 'y'.repeat(2048), c: 'z'.repeat(2048) };
    for (let i = 0; i < 15; i++) client.api.track('Big', big);
    await client.api.flush();
    const sent = await net.sent();
    expect(sent.length).toBeGreaterThan(1);
    for (const s of sent) expect(new TextEncoder().encode(JSON.stringify(s.batch)).length).toBeLessThanOrEqual(64 * 1024);
    expect(byName(await net.events(), 'Big')).toHaveLength(15);
  });
});

describe('cookieless (no consent yet)', () => {
  it('sends no ids and writes nothing to storage or cookies', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { client, net } = setup({ consentMode: 'required' });
    document.body.innerHTML = '<button>Buy</button><form><button type="submit">Send</button></form>';
    click(document.querySelector('button')!);
    client.api.track('Signed up', { plan: 'pro' });
    history.pushState(null, '', '/next');
    window.dispatchEvent(new Event('pagehide'));
    await client.api.flush();

    const sent = await net.sent();
    const events = await net.events();
    expect(events.map((e) => e.name)).toEqual(['$pageview', '$autocapture', 'Signed up', '$pageleave', '$pageview', '$pageleave']);
    expect(sent.every((s) => s.batch.consent === false)).toBe(true);
    for (const e of events) {
      expect(e.anon_id).toBeUndefined();
      expect(e.session_id).toBeUndefined();
    }
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });
});

describe('consent', () => {
  it('grant() starts ids, stored under one key; events before it leave without them', async () => {
    const { client, net } = setup();
    client.api.track('Before');
    client.api.consent.grant();
    client.api.track('After');
    await client.api.flush();

    const sent = await net.sent();
    expect(sent.map((s) => [s.batch.consent, s.batch.events.map((e) => e.name)])).toEqual([
      [false, ['$pageview', 'Before']],
      [true, ['After']],
    ]);
    const after = sent[1].batch.events[0];
    expect(after.anon_id).toMatch(/^a_[0-9a-f-]{36}$/);
    expect(after.session_id).toMatch(/^s_[0-9a-f-]{36}$/);
    expect(Object.keys(localStorage)).toEqual([stateKey(TOKEN)]);
    expect(stored()).toMatchObject({ a: after.anon_id, s: after.session_id, g: 1 });
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });

  it('remembers a grant on the next page load', async () => {
    const first = setup();
    first.client.api.consent.grant();
    const anon = stored()!.a;
    first.client.destroy();

    const { client, net } = setup();
    await client.api.flush();
    const [pageview] = await net.events();
    expect(pageview.anon_id).toBe(anon);
  });

  it('revoke() deletes what was stored and goes back to cookieless', async () => {
    const { client, net } = setup();
    client.api.consent.grant();
    client.api.track('Consented');
    client.api.consent.revoke();
    client.api.track('Revoked');
    await client.api.flush();

    const sent = await net.sent();
    expect(sent.map((s) => [s.batch.consent, s.batch.events.map((e) => e.name)])).toEqual([
      [false, ['$pageview']],
      [true, ['Consented']],
      [false, ['Revoked']],
    ]);
    expect(sent[2].batch.events[0].anon_id).toBeUndefined();
    expect(localStorage.length).toBe(0);
  });

  it('a revoke or opt-out in another tab holds in this one', async () => {
    const { client, net } = setup({ consentMode: 'none' });
    // Another tab revokes: the key goes, and the browser tells this tab.
    localStorage.removeItem(stateKey(TOKEN));
    window.dispatchEvent(new StorageEvent('storage', { key: stateKey(TOKEN), oldValue: '{}', newValue: null }));
    client.api.track('After revoke');
    await client.api.flush();
    expect(localStorage.length).toBe(0);
    const [revoked] = byName(await net.events(), 'After revoke');
    expect(revoked.anon_id).toBeUndefined();

    localStorage.setItem(OPT_OUT_KEY, '1');
    window.dispatchEvent(new StorageEvent('storage', { key: OPT_OUT_KEY, oldValue: null, newValue: '1' }));
    client.api.track('After opt-out');
    await client.api.flush();
    expect(byName(await net.events(), 'After opt-out')).toHaveLength(0);
  });

  it('starts a new session after 30 minutes without events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T10:00:00Z'));
    const { client, net } = setup({ consentMode: 'none' });
    vi.setSystemTime(new Date('2026-10-27T10:29:00Z'));
    client.api.track('Same visit');
    vi.setSystemTime(new Date('2026-10-27T11:00:00Z'));
    client.api.track('Next visit');
    await client.api.flush();

    const [pageview, same, next] = await net.events();
    expect(same.session_id).toBe(pageview.session_id);
    expect(next.session_id).not.toBe(pageview.session_id);
    expect(next.anon_id).toBe(pageview.anon_id);
  });

  it('consentMode none: ids from the start, consent true', async () => {
    const { client, net } = setup({ consentMode: 'none' });
    await client.api.flush();
    const [sent] = await net.sent();
    expect(sent.batch.consent).toBe(true);
    expect(sent.batch.events[0].anon_id).toMatch(/^a_/);
    expect(stored()).toMatchObject({ g: 0 });
  });

  it('drops ids kept without a grant once the project requires consent', async () => {
    setup({ consentMode: 'none' }).client.destroy();
    expect(stored()).not.toBeNull();

    const { client, net } = setup({ consentMode: 'required' });
    await client.api.flush();
    const [pageview] = await net.events();
    expect(pageview.anon_id).toBeUndefined();
    expect(localStorage.length).toBe(0);
  });

  it('a Global Privacy Control signal means no consent until grant(), even when the project needs none', async () => {
    defineOn(navigator, 'globalPrivacyControl', true);
    const { client, net } = setup({ consentMode: 'none' });
    client.api.track('Before');
    expect(localStorage.length).toBe(0);
    client.api.consent.grant();
    client.api.track('After');
    await client.api.flush();

    const sent = await net.sent();
    expect(sent.map((s) => s.batch.consent)).toEqual([false, true]);
    expect(sent[0].batch.events.every((e) => !e.anon_id)).toBe(true);
    expect(sent[1].batch.events[0].anon_id).toMatch(/^a_/);
  });
});

describe('opt-out', () => {
  it('optOut() sends nothing, keeps only the flag, and holds on the next load until optIn()', async () => {
    const first = setup({ consentMode: 'none' });
    first.client.api.optOut();
    first.client.api.track('Ignored');
    first.client.api.consent.grant();
    history.pushState(null, '', '/elsewhere');
    window.dispatchEvent(new Event('pagehide'));
    await first.client.api.flush();
    expect(first.net.fetchMock).not.toHaveBeenCalled();
    expect(Object.keys(localStorage)).toEqual([OPT_OUT_KEY]);
    first.client.destroy();

    const { client, net } = setup({ consentMode: 'none' });
    client.api.track('Still ignored');
    await client.api.flush();
    expect(net.fetchMock).not.toHaveBeenCalled();

    client.api.optIn();
    client.api.track('Counted');
    await client.api.flush();
    expect(await net.names()).toEqual(['Counted']);
    expect(localStorage.getItem(OPT_OUT_KEY)).toBeNull();
  });
});

describe('pageviews', () => {
  it('sends the referrer with the first pageview of the page load only', async () => {
    defineOn(document, 'referrer', 'https://www.google.com/');
    document.title = 'Home';
    const { client, net } = setup();
    history.pushState(null, '', '/pricing');
    await client.api.flush();
    const [first, , second] = await net.events();
    expect(first).toMatchObject({ name: '$pageview', url: 'https://shop.example.com/', title: 'Home', referrer: 'https://www.google.com/' });
    expect(second.name).toBe('$pageview');
    expect(second.referrer).toBeUndefined();
  });

  it('counts SPA navigation once per URL', async () => {
    const { client, net } = setup();
    history.pushState(null, '', '/pricing');
    history.pushState(null, '', '/pricing');
    history.replaceState({ scroll: 1 }, '', '/pricing');
    history.pushState(null, '', '/pricing#faq');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    history.pushState(null, '', '/pricing?plan=pro');
    history.pushState(null, '', '/#/settings');
    history.pushState(null, '', '/#/billing');
    await client.api.flush();

    const events = await net.events();
    expect(byName(events, '$pageview').map((e) => e.url)).toEqual([
      'https://shop.example.com/',
      'https://shop.example.com/pricing',
      'https://shop.example.com/pricing?plan=pro',
      'https://shop.example.com/#/settings',
      'https://shop.example.com/#/billing',
    ]);
    expect(byName(events, '$pageleave').map((e) => e.url)).toEqual([
      'https://shop.example.com/',
      'https://shop.example.com/pricing',
      'https://shop.example.com/pricing?plan=pro',
      'https://shop.example.com/#/settings',
    ]);
  });

  it('counts back navigation (popstate)', async () => {
    const { client, net } = setup();
    history.pushState(null, '', '/a');
    history.back();
    await new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    await client.api.flush();
    expect(byName(await net.events(), '$pageview').map((e) => new URL(e.url).pathname)).toEqual(['/', '/a', '/']);
  });

  it('a page restored from the back/forward cache is a new pageview', async () => {
    const { client, net } = setup();
    window.dispatchEvent(new Event('pagehide'));
    const restored = new Event('pageshow');
    Object.defineProperty(restored, 'persisted', { value: true });
    window.dispatchEvent(restored);
    await client.api.flush();
    expect(await net.names()).toEqual(['$pageview', '$pageleave', '$pageview']);
  });
});

describe('$pageleave scroll depth', () => {
  it('reports the furthest point seen, as a percentage of the page height', async () => {
    defineOn(document.documentElement, 'scrollHeight', 2000);
    defineOn(window, 'innerHeight', 500);
    const { client, net } = setup();
    defineOn(window, 'scrollY', 1000);
    window.dispatchEvent(new Event('scroll'));
    defineOn(window, 'scrollY', 200);
    window.dispatchEvent(new Event('scroll'));
    history.pushState(null, '', '/next');
    // Scrolled to the bottom of /next without a scroll event, then the tab closes.
    defineOn(window, 'scrollY', 1500);
    window.dispatchEvent(new Event('pagehide'));
    await client.api.flush();

    const leaves = byName(await net.events(), '$pageleave');
    expect(leaves.map((e) => [new URL(e.url).pathname, e.scroll_depth])).toEqual([
      ['/', 75],
      ['/next', 100],
    ]);
  });

  it('a page shorter than the window is read to the end', async () => {
    const { client, net } = setup();
    window.dispatchEvent(new Event('pagehide'));
    await client.api.flush();
    expect(byName(await net.events(), '$pageleave')[0].scroll_depth).toBe(100);
  });
});

describe('autocapture', () => {
  async function captured(html: string, select: string, config = {}) {
    document.body.innerHTML = html;
    // jsdom can't submit forms; a click on a submit input would try.
    const block = (e: Event) => e.preventDefault();
    document.addEventListener('submit', block);
    onCleanup(() => document.removeEventListener('submit', block));
    const { client, net } = setup(config);
    click(document.querySelector(select)!);
    await client.api.flush();
    return { events: byName(await net.events(), '$autocapture'), body: JSON.stringify(await net.sent()) };
  }

  it('records the element, a short selector, its masked text and the position', async () => {
    defineOn(window, 'scrollY', 300);
    const { events } = await captured(
      '<section class="hero main"><div class="card x:y"><button class="btn btn-primary w-1/2">' +
        '<span>Pay 4242 4242 4242 4242</span> to jane.doe@example.com</button></div></section>',
      'span',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      el: {
        tag: 'button',
        selector: 'section.hero.main > div.card > button.btn.btn-primary',
        text: 'Pay * * * * to *',
        action: 'click',
      },
      x: 10,
      y: 320,
    });
  });

  it('stops the selector at an id', async () => {
    const { events } = await captured('<div class="card"><a id="buy" href="#buy">Buy <b>now</b></a></div>', 'b');
    expect(events[0].el).toEqual({ tag: 'a', selector: 'a#buy', text: 'Buy now', action: 'click' });
  });

  it('strict masking sends no text', async () => {
    const { events, body } = await captured('<button>Order 1234</button>', 'button', { maskingLevel: 'strict' });
    expect(events[0].el).toEqual({ tag: 'button', selector: 'button', action: 'click' });
    expect(body).not.toContain('Order');
  });

  it('relaxed masking still masks emails and numbers', async () => {
    const { events } = await captured('<a href="#">Mail me@example.com, ref 98765</a>', 'a', { maskingLevel: 'relaxed' });
    expect(events[0].el?.text).toBe('Mail * ref *');
  });

  it('never sends input values, not even a submit button label', async () => {
    const { events, body } = await captured(
      '<form><input type="email" value="jane@example.com"><input type="submit" value="Send secret"></form>',
      'input[type=submit]',
    );
    expect(events[0].el).toEqual({ tag: 'input', selector: 'form > input', action: 'click' });
    expect(body).not.toContain('jane');
    expect(body).not.toContain('secret');
  });

  it('leaves out text inside form fields within the clicked element', async () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const button = document.getElementById('go')!;
    const input = document.createElement('input');
    input.value = 'typed-value';
    const textarea = document.createElement('textarea');
    textarea.textContent = 'draft-text';
    const select = document.createElement('select');
    select.innerHTML = '<option>picked-option</option>';
    button.append(input, textarea, select);
    const { client, net } = setup();
    click(button);
    await client.api.flush();
    const [event] = byName(await net.events(), '$autocapture');
    expect(event.el?.text).toBe('Go');
  });

  it('honours data-panel-block and data-panel-mask', async () => {
    document.body.innerHTML =
      '<div data-panel-block><button id="blocked">Secret</button></div>' +
      '<button id="self" data-panel-block>Secret</button>' +
      '<button id="masked" data-panel-mask>Card</button>' +
      '<button id="partly">Hi <span data-panel-mask>Jane</span></button>';
    const { client, net } = setup();
    for (const id of ['blocked', 'self', 'masked', 'partly']) click(document.getElementById(id)!);
    await client.api.flush();
    const events = byName(await net.events(), '$autocapture');
    expect(events.map((e) => [e.el?.selector, e.el?.text])).toEqual([
      ['button#masked', undefined],
      ['button#partly', 'Hi'],
    ]);
  });

  it('uses the aria-label of an icon button and cuts long text to 255 characters', async () => {
    document.body.innerHTML = `<button id="icon" aria-label="Close dialog"><svg></svg></button><a id="long" href="#">${'word '.repeat(100)}</a>`;
    const { client, net } = setup();
    click(document.getElementById('icon')!);
    click(document.getElementById('long')!);
    await client.api.flush();
    const [icon, long] = byName(await net.events(), '$autocapture');
    expect(icon.el?.text).toBe('Close dialog');
    expect(long.el?.text?.length).toBeLessThanOrEqual(255);
  });

  it('ignores clicks on things that are not interactive', async () => {
    const { events } = await captured('<div id="plain"><p>Text</p></div>', 'p');
    expect(events).toHaveLength(0);
  });

  it('a keyboard click has no position', async () => {
    document.body.innerHTML = '<button>Next</button>';
    const { client, net } = setup();
    click(document.querySelector('button')!, 0, 0);
    await client.api.flush();
    const [event] = byName(await net.events(), '$autocapture');
    expect(event.x).toBeUndefined();
    expect(event.y).toBeUndefined();
  });

  it('records form submits with the submit button text, never the fields', async () => {
    document.body.innerHTML =
      '<form id="signup" class="auth"><input name="email" value="jane@example.com"><button type="submit">Sign up</button></form>';
    const { client, net } = setup();
    const submit = new Event('submit', { bubbles: true, cancelable: true });
    Object.defineProperty(submit, 'submitter', { value: document.querySelector('button') });
    document.getElementById('signup')!.dispatchEvent(submit);
    await client.api.flush();
    const [event] = byName(await net.events(), '$autocapture');
    expect(event.el).toEqual({ tag: 'form', selector: 'form#signup', text: 'Sign up', action: 'submit' });
    expect(event.x).toBeUndefined();
    expect(JSON.stringify(await net.sent())).not.toContain('jane');
  });

  it('is off when the project turns autocapture off', async () => {
    const { events } = await captured('<button>Buy</button>', 'button', { autocapture: false });
    expect(events).toHaveLength(0);
  });
});

describe('excluded URLs', () => {
  it('sends nothing on matching pages', async () => {
    history.replaceState(null, '', '/admin/users');
    document.body.innerHTML = '<button>Delete</button>';
    const { client, net } = setup({ excludedUrls: ['/admin/*', '/internal'] });
    client.api.track('Admin action');
    click(document.querySelector('button')!);
    history.pushState(null, '', '/shop');
    history.pushState(null, '', '/admin');
    history.pushState(null, '', '/internal');
    history.pushState(null, '', '/internal/x');
    await client.api.flush();

    const events = await net.events();
    expect(events.map((e) => `${e.name} ${new URL(e.url).pathname}`)).toEqual([
      '$pageview /shop',
      '$pageleave /shop',
      '$pageview /admin',
      '$pageleave /admin',
      '$pageview /internal/x',
    ]);
  });
});

describe('transport', () => {
  it('POSTs text/plain JSON to {host}/e with keepalive and no credentials', async () => {
    const { client, net } = setup();
    await client.api.flush();
    const [sent] = await net.sent();
    expect(sent.url).toBe(`${HOST}/e`);
    expect(sent.init).toMatchObject({
      method: 'POST',
      keepalive: true,
      credentials: 'omit',
      headers: { 'Content-Type': 'text/plain' },
    });
    expect(sent.batch).toMatchObject({ token: TOKEN, lib: 'web', lib_version: LIB_VERSION, consent: false });
    expect(new Date(sent.batch.sent_at).toISOString()).toBe(sent.batch.sent_at);
    expect(sent.batch.events[0]).toMatchObject({ viewport_w: window.innerWidth });
    expect(sent.batch.events[0].event_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses sendBeacon with a text/plain Blob when the page is hidden', async () => {
    const { net } = setup({}, { beacon: true });
    defineOn(document, 'visibilityState', 'hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(net.beaconMock).toHaveBeenCalledTimes(1);
    expect(net.fetchMock).not.toHaveBeenCalled();
    const [sent] = await net.sent();
    expect(sent).toMatchObject({ via: 'beacon', url: `${HOST}/e`, blobType: 'text/plain' });
    expect(sent.batch.events.map((e) => e.name)).toEqual(['$pageview']);
  });

  it('sends $pageleave with the beacon on pagehide', async () => {
    const { net } = setup({}, { beacon: true });
    window.dispatchEvent(new Event('pagehide'));
    expect(await net.names()).toEqual(['$pageview', '$pageleave']);
    expect((await net.sent()).every((s) => s.via === 'beacon')).toBe(true);
  });

  it('falls back to fetch keepalive when sendBeacon refuses the body', async () => {
    const { net } = setup({}, { beacon: 'refuse' });
    window.dispatchEvent(new Event('pagehide'));
    expect(net.beaconMock).toHaveBeenCalledTimes(1);
    const [sent] = await net.sent();
    expect(sent.via).toBe('fetch');
    expect(sent.init?.keepalive).toBe(true);
  });

  it('retries once after a network failure, with the same events', async () => {
    vi.useFakeTimers();
    const { client, net } = setup({}, { networkFailures: 1 });
    const done = client.api.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(net.fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = net.fetchMock.mock.calls;
    expect(second[1]?.body).toBe(first[1]?.body);
    expect(await net.names()).toEqual(['$pageview']);
  });

  it('gives up after the retry fails too', async () => {
    vi.useFakeTimers();
    const { client, net } = setup({}, { networkFailures: 5 });
    const done = client.api.flush();
    await vi.advanceTimersByTimeAsync(10000);
    await done;
    expect(net.fetchMock).toHaveBeenCalledTimes(2);
    expect(await net.sent()).toEqual([]);
  });
});

describe('track()', () => {
  it('drops invalid names and properties, warning only in debug mode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client, net } = setup({}, { debug: false });
    client.api.track('$pageview');
    client.api.track('');
    client.api.track('Bad', { nested: { a: 1 }, 'bad-key': 1, nan: NaN, ok: 1, s: 'x'.repeat(3000) });
    await client.api.flush();
    expect(warn).not.toHaveBeenCalled();
    const [bad] = byName(await net.events(), 'Bad');
    expect(bad.props).toEqual({ ok: 1, s: 'x'.repeat(2048) });
    expect(await net.names()).toEqual(['$pageview', 'Bad']);
  });

  it('warns in debug mode', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client } = setup({}, { debug: true });
    client.api.track('$custom');
    client.api.track('Ok', { 'bad-key': 1 });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toBe('[weldpanel]');
  });
});

describe('before the config arrives', () => {
  it('keeps calls and applies consent before the first pageview', async () => {
    const net = installNetwork();
    const client = createClient({ token: TOKEN, host: HOST });
    onCleanup(() => client.destroy());
    client.api.track('Early');
    client.api.consent.grant();
    void client.api.flush();
    expect(net.fetchMock).not.toHaveBeenCalled();

    client.start({ consentMode: 'required' });
    await client.api.flush();
    const sent = await net.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0].batch.consent).toBe(true);
    expect(sent[0].batch.events.map((e) => [e.name, !!e.anon_id])).toEqual([
      ['$pageview', true],
      ['Early', true],
    ]);
  });

  it('collects nothing when the config cannot be loaded', async () => {
    const net = installNetwork();
    const client = createClient({ token: TOKEN, host: HOST });
    onCleanup(() => client.destroy());
    client.api.consent.grant();
    client.fail(new Error('404'));
    client.api.track('Lost');
    client.api.consent.grant();
    await client.api.flush();
    expect(net.fetchMock).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
});
