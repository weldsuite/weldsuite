import { afterEach, describe, expect, it, vi } from 'vitest';
import { deadClickCandidate, excessiveScroll, exceptionInfo, quickBackFrom, rageClicks } from './frustration';
import { stateKey } from './storage';
import { defineOn, onCleanup, resetPage, setup, TOKEN } from './test/harness';
import type { WireEvent } from './wire';

afterEach(resetPage);

const byName = (events: WireEvent[], name: string) => events.filter((e) => e.name === name);

function click(el: Element, clientX = 110, clientY = 220, init: MouseEventInit = {}): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX, clientY, ...init }));
}

/** jsdom lays nothing out: give an element a box. */
function box(el: Element, left = 100, top = 200, width = 40, height = 20): void {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
}

describe('detectors', () => {
  it('rage clicks: the third click within 700 ms and 30 px, once per burst', () => {
    const rage = rageClicks();
    expect(rage(0, 10, 10)).toBe(false);
    expect(rage(200, 20, 15)).toBe(false);
    expect(rage(400, 12, 30)).toBe(true);
    expect(rage(500, 12, 30)).toBe(false);
    // Too slow, or too far apart.
    const slow = rageClicks();
    expect([0, 400, 800, 1200].map((t) => slow(t, 0, 0))).toEqual([false, false, false, false]);
    const far = rageClicks();
    expect([0, 100, 200].map((t, i) => far(t, i * 40, 0))).toEqual([false, false, false]);
  });

  it('excessive scrolling: four turns past three window heights within 20 s', () => {
    const scroll = excessiveScroll();
    const ys = [0, 400, 0, 400, 0, 400];
    expect(ys.map((y, i) => scroll(i * 1000, y, 500))).toEqual([false, false, false, false, false, true]);
    // Over more than 20 seconds it doesn't add up.
    const slow = excessiveScroll();
    expect(ys.map((y, i) => slow(i * 8000, y, 500)).some(Boolean)).toBe(false);
    // Turning often over a short distance isn't it either.
    const jiggle = excessiveScroll();
    expect([0, 50, 0, 50, 0, 50, 0].map((y, i) => jiggle(i * 100, y, 500)).some(Boolean)).toBe(false);
  });

  it('quick back: back on the page before within 7 seconds', () => {
    const last = { k: 'https://x/b', p: '/b', t: 1000, b: 'https://x/a' };
    expect(quickBackFrom(last, 'https://x/a', 7999)).toBe('/b');
    expect(quickBackFrom(last, 'https://x/a', 8000)).toBeNull();
    expect(quickBackFrom(last, 'https://x/c', 2000)).toBeNull();
    expect(quickBackFrom(null, 'https://x/a', 2000)).toBeNull();
  });

  it('dead click candidates look clickable and are not fields, labels or app links', () => {
    document.body.innerHTML =
      '<button id="b"><span id="in-b">Go</span></button><div id="ptr" style="cursor:pointer">Card</div><div id="plain">Text</div>' +
      '<label id="l"><input id="cb" type="checkbox"></label><a id="mail" href="mailto:a@b.co">Mail</a><input id="sub" type="submit">';
    const $ = (id: string) => document.getElementById(id)!;
    expect(deadClickCandidate($('in-b'))).toBe($('b'));
    expect(deadClickCandidate($('ptr'))).toBe($('ptr'));
    expect(deadClickCandidate($('sub'))).toBe($('sub'));
    for (const id of ['plain', 'l', 'cb', 'mail']) expect(deadClickCandidate($(id))).toBeNull();
  });

  it('reads errors and rejections, masking addresses and dropping query strings', () => {
    const error = new ErrorEvent('error', { message: 'Bad email jane@example.com', filename: 'https://shop.example.com/app.js?v=3&token=x', lineno: 12, colno: 7 });
    expect(exceptionInfo(error)).toEqual({ message: 'Bad email *', source: 'https://shop.example.com/app.js', line: 12, col: 7 });

    const err = new TypeError('x is undefined');
    err.stack = 'TypeError: x is undefined\n    at run (https://shop.example.com/main.js:40:13)\n    at https://shop.example.com/other.js:1:1';
    const rejection = Object.assign(new Event('unhandledrejection'), { reason: err });
    expect(exceptionInfo(rejection)).toEqual({ message: 'TypeError: x is undefined', source: 'https://shop.example.com/main.js', line: 40, col: 13 });
    expect(exceptionInfo(Object.assign(new Event('unhandledrejection'), { reason: 'nope' }))).toEqual({ message: 'Unhandled rejection: nope' });
    expect(exceptionInfo(new ErrorEvent('error', { message: '' }))).toBeNull();
  });
});

describe('rage clicks', () => {
  it('sends one $rageclick with the element and where in it the clicks landed', async () => {
    document.body.innerHTML = '<div id="hero"><p id="text">Not a link</p></div>';
    const text = document.getElementById('text')!;
    box(text);
    const { client, net } = setup({ maskingLevel: 'balanced' });
    for (let i = 0; i < 5; i++) click(text, 110 + i, 210);
    await client.api.flush();
    const rages = byName(await net.events(), '$rageclick');
    expect(rages).toHaveLength(1);
    expect(rages[0]).toMatchObject({ el: { tag: 'p', selector: 'p#text', text: 'Not a link', action: 'click' }, x: 112, y: 210, rel_x: 0.3, rel_y: 0.5 });
    // Cookieless: no ids, like every event before consent.
    expect(rages[0].anon_id).toBeUndefined();
  });

  it('not inside data-panel-block, and not with autocapture off', async () => {
    document.body.innerHTML = '<div data-panel-block><p id="secret">x</p></div><p id="open">y</p>';
    const off = setup({ autocapture: false });
    for (let i = 0; i < 3; i++) click(document.getElementById('open')!);
    await off.client.api.flush();
    expect(byName(await off.net.events(), '$rageclick')).toHaveLength(0);
    off.client.destroy();

    const on = setup();
    for (let i = 0; i < 3; i++) click(document.getElementById('secret')!);
    await on.client.api.flush();
    expect(byName(await on.net.events(), '$rageclick')).toHaveLength(0);
  });
});

describe('autocapture position', () => {
  it('adds rel_x / rel_y to clicks', async () => {
    document.body.innerHTML = '<button id="buy">Buy</button>';
    box(document.getElementById('buy')!, 100, 200, 50, 40);
    const { client, net } = setup();
    click(document.getElementById('buy')!, 125, 230);
    await client.api.flush();
    const [event] = byName(await net.events(), '$autocapture');
    expect(event).toMatchObject({ x: 125, y: 230, rel_x: 0.5, rel_y: 0.75 });
  });
});

describe('dead clicks', () => {
  async function scenario(html: string, id: string, onClick?: (el: HTMLElement) => void) {
    vi.useFakeTimers();
    document.body.innerHTML = html;
    const el = document.getElementById(id)!;
    if (onClick) el.addEventListener('click', () => onClick(el));
    // jsdom can't follow links.
    const stay = (e: Event) => e.preventDefault();
    document.addEventListener('click', stay);
    onCleanup(() => document.removeEventListener('click', stay));
    const { client, net } = setup();
    // A moment after the page has loaded.
    await vi.advanceTimersByTimeAsync(50);
    click(el);
    await vi.advanceTimersByTimeAsync(999);
    // The SDK's own request isn't the page reacting.
    await client.api.flush();
    const early = byName(await net.events(), '$deadclick').length;
    await vi.advanceTimersByTimeAsync(1);
    await client.api.flush();
    return { early, dead: byName(await net.events(), '$deadclick') };
  }

  it('a button that does nothing for a second', async () => {
    const { early, dead } = await scenario('<main><button id="go" class="cta">Go</button></main>', 'go');
    expect(early).toBe(0);
    expect(dead).toHaveLength(1);
    expect(dead[0].el).toEqual({ tag: 'button', selector: 'button#go', text: 'Go', action: 'click' });
  });

  it('not when the page changes', async () => {
    const { dead } = await scenario('<button id="go">Go</button><div id="out"></div>', 'go', () => {
      document.getElementById('out')!.textContent = 'Done';
    });
    expect(dead).toHaveLength(0);
  });

  it('not when the page starts a request', async () => {
    const { dead } = await scenario('<button id="go">Go</button>', 'go', () => {
      void fetch('https://shop.example.com/api/cart', { method: 'POST' });
    });
    expect(dead).toHaveLength(0);
  });

  it('not when the page navigates', async () => {
    const { dead } = await scenario('<a id="go" href="#">Next</a>', 'go', () => history.pushState(null, '', '/next'));
    expect(dead).toHaveLength(0);
  });

  it('not on fields and links that open another app; yes on anything with a pointer cursor', async () => {
    expect((await scenario('<a id="go" href="mailto:a@b.co">Mail</a>', 'go')).dead).toHaveLength(0);
    resetPage();
    expect((await scenario('<div id="go" style="cursor: pointer">Card</div>', 'go')).dead).toHaveLength(1);
  });
});

describe('quick back', () => {
  it('in a single-page app: back on the previous route within 7 seconds', async () => {
    vi.useFakeTimers();
    const { client, net } = setup();
    history.pushState(null, '', '/pricing');
    await vi.advanceTimersByTimeAsync(3000);
    history.pushState(null, '', '/');
    // Too late to count, then somewhere new.
    await vi.advanceTimersByTimeAsync(8000);
    history.pushState(null, '', '/pricing');
    await vi.advanceTimersByTimeAsync(1000);
    history.pushState(null, '', '/about');
    await client.api.flush();
    const backs = byName(await net.events(), '$quickback');
    expect(backs).toHaveLength(1);
    expect(backs[0]).toMatchObject({ url: 'https://shop.example.com/', props: { $from: '/pricing' } });
  });

  it('across a full page load, with consent', async () => {
    const now = Date.now();
    sessionStorage.setItem(
      stateKey(TOKEN),
      JSON.stringify({ n: { k: 'https://shop.example.com/pricing', p: '/pricing', t: now - 2000, b: 'https://shop.example.com/' } }),
    );
    const { client, net } = setup({ consentMode: 'none' });
    await client.api.flush();
    expect(byName(await net.events(), '$quickback')[0]).toMatchObject({ props: { $from: '/pricing' } });
    // The record now says this page was shown, coming from /pricing.
    expect(JSON.parse(sessionStorage.getItem(stateKey(TOKEN))!).n).toMatchObject({ k: 'https://shop.example.com/', p: '/', b: 'https://shop.example.com/pricing' });
  });

  it('without consent nothing is kept between page loads', async () => {
    const { client, net } = setup({ consentMode: 'required' });
    history.pushState(null, '', '/pricing');
    await client.api.flush();
    expect(sessionStorage).toHaveLength(0);
    expect(byName(await net.events(), '$quickback')).toHaveLength(0);
  });
});

describe('excessive scrolling', () => {
  it('sends one $excessivescroll per page with the depth reached', async () => {
    defineOn(document.documentElement, 'scrollHeight', 4000);
    defineOn(window, 'innerHeight', 500);
    const { client, net } = setup();
    for (const y of [0, 600, 0, 600, 0, 600, 0, 600, 0, 600]) {
      defineOn(window, 'scrollY', y);
      window.dispatchEvent(new Event('scroll'));
    }
    await client.api.flush();
    const events = byName(await net.events(), '$excessivescroll');
    expect(events).toHaveLength(1);
    expect(events[0].scroll_depth).toBe(28);
  });
});

describe('$exception', () => {
  function fail(message: string, line = 12): void {
    window.dispatchEvent(new ErrorEvent('error', { message, filename: 'https://shop.example.com/app.js', lineno: line, colno: 3 }));
  }

  it('sends each error once, with its message, script and position', async () => {
    const { client, net } = setup();
    fail('Uncaught TypeError: x is undefined');
    fail('Uncaught TypeError: x is undefined');
    fail('Uncaught TypeError: x is undefined', 13);
    await client.api.flush();
    const errors = byName(await net.events(), '$exception');
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({
      error_message: 'Uncaught TypeError: x is undefined',
      props: { $source: 'https://shop.example.com/app.js', $line: 12, $col: 3 },
    });
  });

  it('with consent, once per session across page loads', async () => {
    const first = setup({ consentMode: 'none' });
    fail('Boom');
    await first.client.api.flush();
    first.client.destroy();

    const second = setup({ consentMode: 'none' });
    fail('Boom');
    fail('Other');
    await second.client.api.flush();
    expect(byName(await first.net.events(), '$exception')).toHaveLength(1);
    expect(byName(await second.net.events(), '$exception').map((e) => e.error_message)).toEqual(['Other']);
  });

  it('unhandled promise rejections too', async () => {
    const { client, net } = setup();
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new RangeError('too far') }));
    await client.api.flush();
    expect(byName(await net.events(), '$exception')[0].error_message).toBe('RangeError: too far');
  });

  it('nothing from excluded pages', async () => {
    history.replaceState(null, '', '/admin/x');
    const { client, net } = setup({ excludedUrls: ['/admin/*'] });
    fail('Boom');
    await client.api.flush();
    expect(net.fetchMock).not.toHaveBeenCalled();
  });
});
