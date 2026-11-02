/**
 * Conformance mode's customer mail: a test's `SEND_EMAIL` binding (the
 * Cloudflare `send_email` binding the mail send paths call with
 * `new EmailMessage(from, to, raw)`) served over HTTP, so the Rust server's
 * `MailTransport` hands its envelopes to the same stub and gets the same
 * answers (accepted, or refused with Cloudflare's `E_*` code). The Rust
 * side is `rust/bins/weldsuite/src/conformance_mail.rs`.
 *
 *   POST /send?from=<from>&to=<recipient>   body: the raw RFC 5322 message
 *     204                                    the stub took it
 *     422 { code, name, message }            the stub threw (`code`: its `E_*`, or null)
 *
 * Both sides are recorded per envelope and compared as side effects, read
 * back the way a mail client reads them (./mime-record.ts). A stub with a
 * `sent` array (`createSendEmailStub()`) afterwards holds Rust's envelopes
 * only, as the test's response is Rust's; any other stub sees both runs, so
 * it must answer by recipient, not by call order.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveOnLoopback } from './bucket-bridge';
import { sendRecord, type SendRecord } from './mime-record';

/** The binding method the bridge uses. */
export interface SendEmailLike {
  send(message: { from: string; to: string; raw: unknown }): Promise<unknown>;
}

export function isSendEmailLike(value: unknown): value is SendEmailLike {
  return !!value && typeof value === 'object' && typeof (value as SendEmailLike).send === 'function';
}

/** One envelope a stub took: `{ from, to, raw }`. */
export interface SentEnvelope {
  from: string;
  to: string;
  raw: string;
}

/**
 * A `SEND_EMAIL` stub for tests: takes every envelope into `sent`, except
 * recipients in `refuse`, which throw an `Error` carrying that `code`
 * (`E_RECIPIENT_SUPPRESSED`, `E_DAILY_LIMIT_EXCEEDED`, …; `null`: no code).
 */
export function createSendEmailStub(refuse: Record<string, string | null> = {}) {
  const sent: SentEnvelope[] = [];
  return {
    sent,
    async send(message: { from: string; to: string; raw: unknown }): Promise<void> {
      const recipient = message.to.toLowerCase();
      if (recipient in refuse) {
        const error = new Error(`refused ${message.to}`) as Error & { code?: string };
        const code = refuse[recipient];
        if (code) error.code = code;
        throw error;
      }
      sent.push({ from: message.from, to: message.to, raw: rawText(message.raw) });
    },
  };
}

function rawText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  return String(raw);
}

const rustSends: SendRecord[] = [];

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function handle(binding: SendEmailLike, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (url.pathname !== '/send' || req.method !== 'POST' || from === null || to === null) {
    res.writeHead(404).end();
    return;
  }
  const raw = await readBody(req);
  rustSends.push(sendRecord(from, to, raw));
  try {
    await binding.send({ from, to, raw });
    res.writeHead(204).end();
  } catch (error) {
    const err = error as { code?: unknown; name?: unknown; message?: unknown };
    res.writeHead(422, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        code: typeof err.code === 'string' ? err.code : null,
        name: typeof err.name === 'string' ? err.name : 'Error',
        message: typeof err.message === 'string' ? err.message : String(error),
      }),
    );
  }
}

const bridges = new WeakMap<object, Promise<string>>();

/** The bridge's URL for the test's `SEND_EMAIL`, when it has one. */
export async function sendEmailUrl(env: Record<string, unknown>): Promise<string | undefined> {
  const binding = env.SEND_EMAIL;
  if (!isSendEmailLike(binding)) return undefined;
  let url = bridges.get(binding);
  if (!url) {
    url = serveOnLoopback((req, res) => handle(binding, req, res));
    bridges.set(binding, url);
  }
  return url;
}

/** What Rust sent through the bridge since the last call, clearing it. */
export function takeRustSends(): SendRecord[] {
  return rustSends.splice(0);
}

/**
 * `env` with its `SEND_EMAIL` recording what the TypeScript run sends, and a
 * `finish()` that returns the records and drops the run's envelopes from a
 * stub's `sent`.
 */
export function recordTypeScriptSends(env: Record<string, unknown>): {
  env: Record<string, unknown>;
  finish: () => SendRecord[];
} {
  const binding = env.SEND_EMAIL;
  if (!isSendEmailLike(binding)) return { env, finish: () => [] };
  const records: SendRecord[] = [];
  const sent = (binding as { sent?: unknown }).sent;
  const before = Array.isArray(sent) ? sent.length : 0;
  const wrapped: SendEmailLike = {
    async send(message) {
      records.push(sendRecord(message.from, message.to, message.raw));
      return binding.send(message);
    },
  };
  return {
    env: { ...env, SEND_EMAIL: wrapped },
    finish: () => {
      if (Array.isArray(sent)) sent.splice(before);
      return records;
    },
  };
}

/** The records in a stable order. */
export function sortSends(records: SendRecord[]): SendRecord[] {
  return [...records].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
