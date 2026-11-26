import '../shared/page.css';
import './server.css';
import { applyText, text } from '../shared/strings';

/** What "Connect" came back with (src/main/index.ts, `weldsuite:server:use`). */
type UseResult =
  | { status: 'ok' }
  | { status: 'invalid' }
  | { status: 'locked' }
  | { status: 'unreachable'; origin: string }
  | { status: 'not_weldsuite'; origin: string };

/** The bridge `src/preload/server.ts` exposes to this page only. */
interface ServerPageApi {
  get(): Promise<{ current: string; defaultUrl: string; fromEnvironment: boolean }>;
  use(address: string | null): Promise<UseResult>;
  close(): void;
}

declare global {
  interface Window {
    weldsuiteServer: ServerPageApi;
  }
}

const api = window.weldsuiteServer;

const form = document.querySelector<HTMLFormElement>('#server-form')!;
const choiceDefault = document.querySelector<HTMLInputElement>('#choice-default')!;
const choiceOther = document.querySelector<HTMLInputElement>('#choice-other')!;
const defaultHost = document.querySelector<HTMLSpanElement>('#default-host')!;
const address = document.querySelector<HTMLInputElement>('#address')!;
const addressError = document.querySelector<HTMLSpanElement>('#address-error')!;
const locked = document.querySelector<HTMLParagraphElement>('#locked')!;
const status = document.querySelector<HTMLOutputElement>('#status')!;
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;
const connect = document.querySelector<HTMLButtonElement>('#connect')!;

applyText();
document.title = text('serverTitle');

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Show or clear the address's error. It joins the field's description only
 * while shown, and the field moves focus to it, so a screen reader reads it.
 */
function setError(message: string | null): void {
  const describedBy = ['address-hint'];
  if (message) {
    addressError.textContent = message;
    addressError.hidden = false;
    address.setAttribute('aria-invalid', 'true');
    describedBy.push('address-error');
  } else {
    addressError.textContent = '';
    addressError.hidden = true;
    address.setAttribute('aria-invalid', 'false');
  }
  address.setAttribute('aria-describedby', describedBy.join(' '));
}

function setBusy(busy: boolean): void {
  connect.disabled = busy;
  form.setAttribute('aria-busy', String(busy));
}

// Typing an address means another server.
address.addEventListener('focus', () => {
  choiceOther.checked = true;
});
address.addEventListener('input', () => {
  choiceOther.checked = true;
  if (address.getAttribute('aria-invalid') === 'true') setError(null);
});
choiceDefault.addEventListener('change', () => setError(null));

cancel.addEventListener('click', () => api.close());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.close();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (connect.disabled) return;
  setError(null);

  const typed = choiceOther.checked ? address.value.trim() : null;
  if (typed === '') {
    setError(text('errorEmpty'));
    address.focus();
    return;
  }

  setBusy(true);
  let checking = defaultHost.textContent ?? '';
  if (typed !== null) checking = host(typed.includes('://') ? typed : `https://${typed}`);
  status.textContent = text('checking', { host: checking });
  let result: UseResult;
  try {
    result = await api.use(typed);
  } catch {
    result = { status: 'invalid' };
  }
  status.textContent = '';
  setBusy(false);

  // On success the shell closes this window.
  if (result.status === 'ok') return;
  const messages: Record<Exclude<UseResult['status'], 'ok'>, string> = {
    invalid: text('errorInvalid'),
    locked: text('errorLocked'),
    unreachable: text('errorUnreachable', { host: 'origin' in result ? host(result.origin) : '' }),
    not_weldsuite: text('errorNotWeldsuite', { host: 'origin' in result ? host(result.origin) : '' }),
  };
  choiceOther.checked = true;
  setError(messages[result.status]);
  address.focus();
});

async function start(): Promise<void> {
  const { current, defaultUrl, fromEnvironment } = await api.get();
  defaultHost.textContent = host(defaultUrl);
  if (current !== defaultUrl) {
    choiceOther.checked = true;
    address.value = host(current);
  }
  if (fromEnvironment) {
    locked.textContent = text('locked', { host: host(current) });
    locked.hidden = false;
    for (const control of [choiceDefault, choiceOther, address, connect]) control.disabled = true;
    cancel.focus();
    return;
  }
  (choiceOther.checked ? address : choiceDefault).focus();
}

void start();
