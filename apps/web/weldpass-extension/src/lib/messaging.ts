/**
 * How extension pages (popup, settings, the inline menu, the save bar) talk
 * to the service worker. The worker answers an `Envelope`; a failure arrives
 * as a code and becomes a `RemoteError` here.
 */

import type {
  Envelope,
  MenuRequest,
  MenuResponses,
  PageRequest,
  PageResponses,
  PromptRequest,
  PromptResponses,
} from './protocol';

export class RemoteError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(code);
    this.name = 'RemoteError';
  }
}

async function send<T>(message: unknown): Promise<T> {
  let envelope: Envelope<T> | undefined;
  try {
    envelope = (await chrome.runtime.sendMessage(message)) as Envelope<T> | undefined;
  } catch {
    throw new RemoteError('worker');
  }
  if (!envelope) throw new RemoteError('worker');
  if (!envelope.ok) throw new RemoteError(envelope.error.code, envelope.error.status);
  return envelope.value;
}

export function request<K extends PageRequest['type']>(
  message: Extract<PageRequest, { type: K }>,
): Promise<PageResponses[K]> {
  return send<PageResponses[K]>(message);
}

export function menuRequest<K extends MenuRequest['type']>(
  message: Extract<MenuRequest, { type: K }>,
): Promise<MenuResponses[K]> {
  return send<MenuResponses[K]>(message);
}

export function promptRequest<K extends PromptRequest['type']>(
  message: Extract<PromptRequest, { type: K }>,
): Promise<PromptResponses[K]> {
  return send<PromptResponses[K]>(message);
}

/** Calls `listener` when the worker says the session, workspace or server changed. */
export function onStateChanged(listener: () => void): () => void {
  const handler = (message: unknown, sender: chrome.runtime.MessageSender) => {
    if (sender.id !== chrome.runtime.id) return;
    if ((message as { type?: unknown } | null)?.type === 'state:changed') listener();
  };
  chrome.runtime.onMessage.addListener(handler);
  return () => chrome.runtime.onMessage.removeListener(handler);
}

/** The nonce and flags a framed page was opened with (`#n=…&k=1`). */
export function frameParams(): { nonce: string; keyboard: boolean } {
  const params = new URLSearchParams(location.hash.slice(1));
  return { nonce: params.get('n') ?? '', keyboard: params.get('k') === '1' };
}
