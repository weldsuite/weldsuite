/**
 * ChatGPT Ads measurement pixel (`oaiq`).
 *
 * Unlike the marketing site, the pixel is not loaded app-wide here: this is a
 * signed-in product, and an ads pixel has no business on a customer's workspace
 * pages. It is loaded on the registration surfaces only (see useOpenAIPixel)
 * and sends exactly one event, `registration_completed`.
 *
 * Attribution still works because the SDK writes its click id cookie
 * (`__oppref`) on the broadest writable domain — weldsuite.org — so a click id
 * captured on www.weldsuite.org is readable here on app.weldsuite.org without
 * any passthrough on the link between them.
 *
 * That same cookie is the gate: an account created by someone who never
 * clicked a ChatGPT ad sends nothing to OpenAI.
 */

import { getEnv } from './env';

const DEFAULT_PIXEL_ID = 'BQ7Wj5bsQxGnWBzaBAFgaN';
const PIXEL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SDK_URL = 'https://bzrcdn.openai.com/sdk/oaiq.min.js';

// The marketing site mirrors its cookie-banner answer into this cookie on
// .weldsuite.org (see lib/analytics/consent.ts there) precisely so the other
// properties can honour it. localStorage could not cross the subdomain.
const CONSENT_COOKIE = 'ws_cookie_consent';

export type OpenAIEventType = 'contents' | 'customer_action' | 'plan_enrollment' | 'custom';

export interface OpenAIContent {
  id?: string;
  name?: string;
  content_type?: string;
  quantity?: number;
  amount?: number;
  currency?: string;
}

// The SDK rejects an amount without a currency, so the two travel together.
type Money = { amount: number; currency: string } | { amount?: undefined; currency?: undefined };

type ContentsData = Money & { contents?: OpenAIContent[] };
type CustomerActionData = Money;
type PlanEnrollmentData = Money & { plan_id?: string; contents?: OpenAIContent[] };

interface EventDataMap {
  page_viewed: ContentsData;
  contents_viewed: ContentsData;
  items_added: ContentsData;
  checkout_started: ContentsData;
  order_created: ContentsData;
  lead_created: CustomerActionData;
  appointment_scheduled: CustomerActionData;
  registration_completed: CustomerActionData;
  subscription_created: PlanEnrollmentData;
  trial_started: PlanEnrollmentData;
}

export type OpenAIStandardEvent = keyof EventDataMap;

const EVENT_TYPES: Record<OpenAIStandardEvent, OpenAIEventType> = {
  page_viewed: 'contents',
  contents_viewed: 'contents',
  items_added: 'contents',
  checkout_started: 'contents',
  order_created: 'contents',
  lead_created: 'customer_action',
  appointment_scheduled: 'customer_action',
  registration_completed: 'customer_action',
  subscription_created: 'plan_enrollment',
  trial_started: 'plan_enrollment',
};

export interface MeasureOptions {
  // Shared with a server-side Conversions API call to deduplicate the pair.
  event_id?: string;
  opt_out?: boolean;
}

interface OaiqStub {
  (...args: unknown[]): void;
  q: unknown[][];
}

declare global {
  interface Window {
    oaiq?: ((...args: unknown[]) => void) | OaiqStub;
  }
}

function pixelId(): string {
  return getEnv('VITE_OPENAI_PIXEL_ID') || DEFAULT_PIXEL_ID;
}

// OpenAI stamps `?oppref=<click id>` on every ad click; the SDK keeps it in
// this cookie for 30 days, shared across weldsuite.org subdomains. The query
// param is checked too, for the invite links that land straight on this app.
const CLICK_PARAM = 'oppref';
const CLICK_COOKIE = '__oppref';

function hasOpenAIClick(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    if (new URLSearchParams(window.location.search).get(CLICK_PARAM)) return true;
  } catch {
    // Malformed query string — fall through to the cookie.
  }

  // The SDK clears the cookie by blanking it, so an empty value is not a click.
  return document.cookie
    .split('; ')
    .some(
      (entry) => entry.startsWith(`${CLICK_COOKIE}=`) && entry.length > CLICK_COOKIE.length + 1,
    );
}

function consentDeclined(): boolean {
  if (typeof document === 'undefined') return false;
  return document.cookie
    .split('; ')
    .some((entry) => entry === `${CONSENT_COOKIE}=declined`);
}

/**
 * Injects OpenAI's loader and initialises the pixel. Idempotent — the OpenAI
 * reference is explicit that repeated initialisation during client-side
 * navigation must be guarded against, and this is a single-page app.
 *
 * init sends nothing on its own; it only reads the click id. The first ping
 * leaves the browser when an event is measured.
 */
export function loadOpenAIPixel(): void {
  if (typeof window === 'undefined' || window.oaiq) return;

  const id = pixelId();
  if (!PIXEL_ID_PATTERN.test(id) || consentDeclined() || !hasOpenAIClick()) return;

  // Stub window.oaiq with a queue, exactly as OpenAI's loader snippet does, so
  // calls made before the SDK lands are replayed rather than dropped.
  const stub = ((...args: unknown[]) => {
    stub.q.push(args);
  }) as OaiqStub;
  stub.q = [];
  window.oaiq = stub;

  const script = document.createElement('script');
  script.async = true;
  script.src = SDK_URL;
  document.head.appendChild(script);

  window.oaiq?.('init', { pixelId: id, debug: import.meta.env.DEV });
}

/**
 * Fires a standard conversion event. Call it where the action actually
 * completes — after the account exists, not when the form is submitted.
 */
export function measure<E extends OpenAIStandardEvent>(
  event: E,
  data?: EventDataMap[E],
  options?: MeasureOptions,
): void {
  if (typeof window === 'undefined') return;
  const oaiq = window.oaiq;
  if (!oaiq || consentDeclined() || !hasOpenAIClick()) return;
  try {
    oaiq('measure', event, { type: EVENT_TYPES[event], ...data }, options);
  } catch {
    // Measurement must never break the flow it is measuring.
  }
}

const REGISTERED_KEY = 'oaiq_registration_measured';

/**
 * Fires `registration_completed` at most once per account. Both signup paths
 * (email verification and Google SSO) end up here, and the Google one can be
 * re-entered by a browser back navigation, so the account id is recorded.
 */
export function measureRegistrationCompleted(userId: string): void {
  if (!userId) return;

  try {
    const seen = localStorage.getItem(REGISTERED_KEY);
    if (seen === userId) return;
    localStorage.setItem(REGISTERED_KEY, userId);
  } catch {
    // Storage unavailable (private browsing) — measure anyway rather than lose
    // the conversion; a duplicate is the cheaper failure.
  }

  measure('registration_completed');
}

const SIGNUP_INTENT_KEY = 'oaiq_signup_intent';

/**
 * Records that the visitor left for an OAuth provider from the *register*
 * page. Clerk routes sign-in and sign-up through the same SSO callback, so
 * without this the callback cannot tell a new account from a returning login.
 */
export function markSignupIntent(): void {
  try {
    sessionStorage.setItem(SIGNUP_INTENT_KEY, '1');
  } catch {
    // Non-fatal: the SSO conversion is simply not attributed.
  }
}

/** Reads and clears the signup intent left by markSignupIntent. */
export function consumeSignupIntent(): boolean {
  try {
    const found = sessionStorage.getItem(SIGNUP_INTENT_KEY) === '1';
    sessionStorage.removeItem(SIGNUP_INTENT_KEY);
    return found;
  } catch {
    return false;
  }
}
