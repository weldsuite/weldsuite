/**
 * A recording fetch for the provider tests: answers each call from a list of
 * canned responses (recorded fixtures) and keeps what was sent.
 */

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface CannedResponse {
  status?: number;
  json?: unknown;
  /** Throw instead of answering: a network failure. */
  throws?: Error;
}

export interface FakeFetch {
  fetch: typeof fetch;
  calls: RecordedCall[];
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  new Headers(headers).forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** Responses are used in order; a function answers by the call that came in. */
export function fakeFetch(responses: Array<CannedResponse | ((call: RecordedCall) => CannedResponse)>): FakeFetch {
  const calls: RecordedCall[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: headerRecord(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const next = responses[calls.length - 1] ?? responses[responses.length - 1];
    if (!next) throw new Error(`Unexpected call ${call.method} ${call.url}`);
    const canned = typeof next === 'function' ? next(call) : next;
    if (canned.throws) throw canned.throws;
    return new Response(canned.json === undefined ? '' : JSON.stringify(canned.json), {
      status: canned.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetch: impl as typeof fetch, calls };
}

export function formBody(call: RecordedCall): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(call.body ?? ''));
}

export function jsonBody<T = Record<string, unknown>>(call: RecordedCall): T {
  return JSON.parse(call.body ?? '{}') as T;
}
