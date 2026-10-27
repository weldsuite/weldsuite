/**
 * The script-tag path: stub, loader, `init()`. Each client started here can't
 * be destroyed from outside, so every test opts it out at the end, which
 * stops it sending anything in later tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WeldPanel } from './client';
import { init } from './index';
import { installSnippet, STUB } from './install';
import { bootSnippet } from './snippet';
import { HOST, installNetwork, onCleanup, resetPage, TOKEN } from './test/harness';

afterEach(resetPage);

type Global = { weldpanel?: WeldPanel & { q?: unknown[] } };
const global = window as unknown as Global;

/** Let the config request resolve and the client start. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function retire(api: WeldPanel | undefined): void {
  onCleanup(() => api?.optOut());
}

function scriptTag(attrs: Record<string, string> = { 'data-project': TOKEN }): HTMLScriptElement {
  const script = document.createElement('script');
  script.src = `${HOST}/s.js`;
  for (const key of Object.keys(attrs)) script.setAttribute(key, attrs[key]);
  document.head.appendChild(script);
  onCleanup(() => script.remove());
  return script;
}

function runStub(): void {
  // The exact text sites paste, run as a classic script would.
  new Function(STUB)();
}

describe('snippet', () => {
  it('replays calls made on the stub before the script loaded, consent first', async () => {
    const net = installNetwork({ config: { consentMode: 'required' } });
    runStub();
    const early = global.weldpanel!;
    early.track('Viewed pricing', { plan: 'pro' });
    early.consent.grant();
    expect(early.q).toHaveLength(2);

    const api = bootSnippet(scriptTag());
    retire(api);
    expect(net.fetchMock).toHaveBeenCalledWith(`${HOST}/c/${TOKEN}`, expect.objectContaining({ credentials: 'omit' }));
    // Upgraded in place: a reference kept from before the load keeps working.
    expect(global.weldpanel).toBe(early);
    expect(early.q).toBeUndefined();
    expect(early.version).toBe(api?.version);

    await settle();
    early.track('After load');
    await early.flush();
    const sent = await net.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${HOST}/e`);
    expect(sent[0].batch.consent).toBe(true);
    expect(sent[0].batch.events.map((e) => [e.name, !!e.anon_id])).toEqual([
      ['$pageview', true],
      ['Viewed pricing', true],
      ['After load', true],
    ]);
    expect(sent[0].batch.events[1].props).toEqual({ plan: 'pro' });
  });

  it('works without the stub and without document.currentScript', async () => {
    const net = installNetwork();
    scriptTag();
    const api = bootSnippet(null);
    retire(api);
    await settle();
    await api?.flush();
    expect(await net.names()).toEqual(['$pageview']);
  });

  it('a second copy of the script does nothing', async () => {
    const net = installNetwork();
    const first = bootSnippet(scriptTag());
    retire(first);
    const second = bootSnippet(scriptTag());
    expect(second).toBe(global.weldpanel);
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the stub leaves a loaded SDK alone', () => {
    installNetwork();
    const api = bootSnippet(scriptTag());
    retire(api);
    const track = global.weldpanel!.track;
    runStub();
    expect(global.weldpanel!.track).toBe(track);
    expect(global.weldpanel!.q).toBeUndefined();
  });

  it('warns when the tag has no data-project', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installNetwork();
    expect(bootSnippet(scriptTag({}))).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('installSnippet() is the stub plus the async tag', () => {
    const html = installSnippet(TOKEN, `${HOST}/`);
    expect(html).toBe(`<script>${STUB}</script>\n<script async src="${HOST}/s.js" data-project="${TOKEN}"></script>`);
  });
});

describe('init()', () => {
  it('fetches the config from the host and starts', async () => {
    const net = installNetwork({ config: { consentMode: 'none' } });
    const api = init({ token: TOKEN, host: `${HOST}/` });
    retire(api);
    api.track('Before config');
    expect(net.fetchMock).toHaveBeenCalledWith(`${HOST}/c/${TOKEN}`, expect.anything());
    await settle();
    await api.flush();
    const [sent] = await net.sent();
    expect(sent.batch.consent).toBe(true);
    expect(sent.batch.events.map((e) => e.name)).toEqual(['$pageview', 'Before config']);
  });

  it('collects nothing when the token is unknown', async () => {
    const net = installNetwork({ config: null });
    const api = init({ token: TOKEN, host: HOST });
    retire(api);
    await settle();
    api.track('Lost');
    await api.flush();
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage).toHaveLength(0);
  });

  it('does nothing without a token', async () => {
    const net = installNetwork();
    const api = init({ token: '' });
    api.track('Nothing');
    await api.flush();
    expect(net.fetchMock).not.toHaveBeenCalled();
  });
});
