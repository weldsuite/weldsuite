// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frameParams, menuRequest, onStateChanged, promptRequest, RemoteError, request } from './messaging';

type Listener = (message: unknown, sender: chrome.runtime.MessageSender) => void;

let sendMessage: ReturnType<typeof vi.fn>;
let listeners: Listener[];

beforeEach(() => {
  listeners = [];
  sendMessage = vi.fn();
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'weldpass-id',
      sendMessage,
      onMessage: {
        addListener: (listener: Listener) => listeners.push(listener),
        removeListener: (listener: Listener) => {
          listeners = listeners.filter((item) => item !== listener);
        },
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  location.hash = '';
});

describe('requests to the worker', () => {
  it('unwraps an answer', async () => {
    sendMessage.mockResolvedValue({ ok: true, value: { inlineMenus: true } });
    await expect(request({ type: 'settings:get' })).resolves.toEqual({ inlineMenus: true });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'settings:get' });
    sendMessage.mockResolvedValue({ ok: true, value: null });
    await expect(menuRequest({ type: 'menu:init', nonce: 'n' })).resolves.toBeNull();
    await expect(promptRequest({ type: 'prompt:init', nonce: 'n' })).resolves.toBeNull();
  });

  it('turns a refusal into a RemoteError with its code and status', async () => {
    sendMessage.mockResolvedValue({ ok: false, error: { code: 'api', status: 403 } });
    const error = await request({ type: 'state:get' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RemoteError);
    expect(error).toMatchObject({ code: 'api', status: 403, name: 'RemoteError' });
  });

  it('reports a worker that is gone or answers nothing', async () => {
    sendMessage.mockRejectedValue(new Error('Could not establish connection'));
    await expect(request({ type: 'state:get' })).rejects.toMatchObject({ code: 'worker' });
    sendMessage.mockResolvedValue(undefined);
    await expect(request({ type: 'state:get' })).rejects.toMatchObject({ code: 'worker' });
  });
});

describe('onStateChanged', () => {
  it('calls back for this extension\'s state changes only, until unsubscribed', () => {
    const listener = vi.fn();
    const stop = onStateChanged(listener);
    const [handler] = listeners;
    handler!({ type: 'state:changed' }, { id: 'weldpass-id' });
    handler!({ type: 'state:changed' }, { id: 'another-extension' });
    handler!({ type: 'other' }, { id: 'weldpass-id' });
    handler!(null, { id: 'weldpass-id' });
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    expect(listeners).toEqual([]);
  });
});

describe('frameParams', () => {
  it('reads the nonce and the keyboard flag from the hash', () => {
    location.hash = '#n=abc&k=1';
    expect(frameParams()).toEqual({ nonce: 'abc', keyboard: true });
    location.hash = '#n=abc&k=0';
    expect(frameParams()).toEqual({ nonce: 'abc', keyboard: false });
    location.hash = '';
    expect(frameParams()).toEqual({ nonce: '', keyboard: false });
  });
});
