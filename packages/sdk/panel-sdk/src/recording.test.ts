/** When the core starts, moves on and stops the recording plugin, and asks it for heatmap snapshots. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from './client';
import { RECORDER_GLOBAL, type PanelRecorder, type RecorderFactory } from './recorder-api';
import { recordingKey, stateKey } from './storage';
import { defineOn, installNetwork, onCleanup, resetPage, setup, HOST, TOKEN } from './test/harness';
import type { ClientConfig } from './wire';

afterEach(resetPage);

function fakeRecorder() {
  const recorder = {
    start: vi.fn<PanelRecorder['start']>(),
    stop: vi.fn<PanelRecorder['stop']>(),
    snapshot: vi.fn<PanelRecorder['snapshot']>(() => Promise.resolve()),
  };
  const factory = vi.fn<RecorderFactory>(() => recorder);
  return { recorder, factory };
}

const RECORDING: Partial<ClientConfig> = { consentMode: 'none', recordingSampleRate: 1, recordingBlocked: false };
/** Let the recorder promise settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const session = () => (JSON.parse(localStorage.getItem(stateKey(TOKEN))!) as { s: string }).s;

describe('starting the recorder', () => {
  it('never before consent', async () => {
    const { factory } = fakeRecorder();
    const { client } = setup({ ...RECORDING, consentMode: 'required' }, { recorder: factory });
    client.api.track('Browsing');
    await settle();
    expect(factory).not.toHaveBeenCalled();
    expect(localStorage).toHaveLength(0);
    expect(document.querySelector('script[src$="/rec.js"]')).toBeNull();

    client.api.consent.grant();
    await settle();
    expect(factory).toHaveBeenCalledWith({ host: HOST, token: TOKEN, maskingLevel: 'balanced', debug: undefined });
  });

  it('records a sampled session with the session id', async () => {
    const { factory, recorder } = fakeRecorder();
    setup(RECORDING, { recorder: factory });
    await settle();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(recorder.start).toHaveBeenLastCalledWith(session());
    expect(JSON.parse(localStorage.getItem(recordingKey(TOKEN))!)).toEqual({ s: session(), r: 1, q: 0 });
  });

  it('decides sampling once per session, and again for a new one', async () => {
    // The dice: a Uint32 draw, 0.9 or 0.1 of the range.
    let roll = 0.9 * 4294967296;
    const draws = vi.fn();
    const real = crypto.getRandomValues.bind(crypto);
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(((array: ArrayBufferView) => {
      if (array instanceof Uint32Array) {
        draws();
        array[0] = roll;
        return array;
      }
      return real(array as Uint8Array);
    }) as typeof crypto.getRandomValues);
    const { factory } = fakeRecorder();
    const { client } = setup({ ...RECORDING, recordingSampleRate: 0.5 }, { recorder: factory });
    client.api.track('One');
    client.api.track('Two');
    await settle();
    expect(draws).toHaveBeenCalledTimes(1);
    expect(factory).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(recordingKey(TOKEN))!)).toMatchObject({ r: 0 });
    client.destroy();

    // The same session on the next page keeps the decision, even if the dice would say yes now.
    roll = 0.1 * 4294967296;
    const next = setup({ ...RECORDING, recordingSampleRate: 0.5 }, { recorder: factory });
    await settle();
    expect(factory).not.toHaveBeenCalled();

    next.client.api.reset();
    await settle();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('not when recording is blocked or the rate is 0', async () => {
    const { factory } = fakeRecorder();
    setup({ ...RECORDING, recordingBlocked: true }, { recorder: factory }).client.destroy();
    setup({ ...RECORDING, recordingSampleRate: 0 }, { recorder: factory });
    await settle();
    expect(factory).not.toHaveBeenCalled();
  });

  it('not where the browser cannot gzip', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    const { factory } = fakeRecorder();
    setup(RECORDING, { recorder: factory });
    await settle();
    expect(factory).not.toHaveBeenCalled();
  });

  it('loads {collector}/rec.js when the app did not bundle the plugin', async () => {
    const { factory, recorder } = fakeRecorder();
    setup(RECORDING);
    const script = document.querySelector<HTMLScriptElement>('script[src$="/rec.js"]')!;
    onCleanup(() => script.remove());
    expect(script.src).toBe(`${HOST}/rec.js`);
    expect(script.async).toBe(true);

    (window as unknown as Record<string, unknown>)[RECORDER_GLOBAL] = factory;
    onCleanup(() => delete (window as unknown as Record<string, unknown>)[RECORDER_GLOBAL]);
    script.dispatchEvent(new Event('load'));
    await settle();
    expect(recorder.start).toHaveBeenCalledWith(session());
  });
});

describe('moving the recording on', () => {
  it('stops on an excluded page and starts again after it', async () => {
    const { factory, recorder } = fakeRecorder();
    setup({ ...RECORDING, excludedUrls: ['/checkout/*'] }, { recorder: factory });
    await settle();
    recorder.start.mockClear();
    history.pushState(null, '', '/checkout/pay');
    expect(recorder.stop).toHaveBeenCalled();
    expect(recorder.start).not.toHaveBeenCalled();
    history.pushState(null, '', '/thanks');
    expect(recorder.start).toHaveBeenCalledWith(session());
  });

  it('follows a new session after reset()', async () => {
    const { factory, recorder } = fakeRecorder();
    const { client } = setup(RECORDING, { recorder: factory });
    await settle();
    const before = session();
    client.api.reset();
    expect(session()).not.toBe(before);
    expect(recorder.start).toHaveBeenLastCalledWith(session());
  });

  it('stops for good when consent is withdrawn, and forgets the session state', async () => {
    const { factory, recorder } = fakeRecorder();
    const { client } = setup({ ...RECORDING, consentMode: 'required' }, { recorder: factory });
    client.api.consent.grant();
    await settle();
    recorder.start.mockClear();
    client.api.consent.revoke();
    client.api.track('After');
    expect(recorder.stop).toHaveBeenCalled();
    expect(recorder.start).not.toHaveBeenCalled();
    expect(localStorage.getItem(recordingKey(TOKEN))).toBeNull();
  });
});

describe('heatmap snapshots', () => {
  const SNAPSHOT: Partial<ClientConfig> = {
    consentMode: 'none',
    snapshot: { pageGroupId: 'pnh_products', urlPattern: '/products/*', deviceClass: 'desktop' },
  };

  it('takes one masked snapshot on a matching page and device class, once per tab session', async () => {
    vi.useFakeTimers();
    defineOn(window, 'innerWidth', 1280);
    history.replaceState(null, '', '/products/shoes');
    const { factory, recorder } = fakeRecorder();
    const { client } = setup(SNAPSHOT, { recorder: factory });
    await vi.advanceTimersByTimeAsync(1999);
    expect(recorder.snapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(recorder.snapshot).toHaveBeenCalledWith('pnh_products', 'desktop');
    // Not recorded: the snapshot alone doesn't start a recording.
    expect(recorder.start).not.toHaveBeenCalled();
    client.destroy();

    history.replaceState(null, '', '/products/hats');
    setup(SNAPSHOT, { recorder: factory });
    await vi.advanceTimersByTimeAsync(5000);
    expect(recorder.snapshot).toHaveBeenCalledTimes(1);
  });

  it('not on another page, another device class, or without consent', async () => {
    vi.useFakeTimers();
    const { factory, recorder } = fakeRecorder();
    defineOn(window, 'innerWidth', 1280);
    history.replaceState(null, '', '/blog/post');
    setup(SNAPSHOT, { recorder: factory }).client.destroy();
    history.replaceState(null, '', '/products/shoes');
    defineOn(window, 'innerWidth', 400);
    setup(SNAPSHOT, { recorder: factory }).client.destroy();
    defineOn(window, 'innerWidth', 1280);
    setup({ ...SNAPSHOT, consentMode: 'required' }, { recorder: factory });
    await vi.advanceTimersByTimeAsync(5000);
    expect(recorder.snapshot).not.toHaveBeenCalled();
  });

  it('waits for consent and the page to stay', async () => {
    vi.useFakeTimers();
    defineOn(window, 'innerWidth', 1280);
    history.replaceState(null, '', '/products/shoes');
    installNetwork();
    const { factory, recorder } = fakeRecorder();
    const client = createClient({ token: TOKEN, host: HOST, recorder: factory });
    onCleanup(() => client.destroy());
    client.start({ ...SNAPSHOT, consentMode: 'required' });
    client.api.consent.grant();
    await vi.advanceTimersByTimeAsync(500);
    history.pushState(null, '', '/about');
    await vi.advanceTimersByTimeAsync(5000);
    expect(recorder.snapshot).not.toHaveBeenCalled();
    history.pushState(null, '', '/products/bags');
    await vi.advanceTimersByTimeAsync(2000);
    expect(recorder.snapshot).toHaveBeenCalledTimes(1);
  });
});
