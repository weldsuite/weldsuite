/**
 * Conformance mode's customer-mailbox SMTP (WeldReach sends from a
 * workspace's own Mailpool mailbox with `@weldsuite/smtp`'s `sendMail`).
 *
 * A test that sends puts its SMTP double in `env.SMTP_SEND`: an object with
 * `sendMail(config, envelope, raw)` answering `sendMail`'s result (and the
 * same double stands in for `@weldsuite/smtp`'s `sendMail` on the TypeScript
 * side, through the test's module mock). The bridge serves it on loopback,
 * so the Rust server's transport (`bins/weldsuite/src/conformance.rs`) hands
 * it the same submission and gets the same answer:
 *
 *   POST /send   { config, envelope, raw }  ->  200 the result | 500 { message } (it threw)
 *
 * A double answers both runs, so it must answer by recipient, never by call
 * order. The raw messages differ by construction (Message-ID, boundaries,
 * folding); the rows the send writes are what the routes answer.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveOnLoopback } from './bucket-bridge';

export interface SmtpSendLike {
  sendMail(config: unknown, envelope: unknown, raw: string): Promise<unknown>;
}

export function isSmtpSendLike(value: unknown): value is SmtpSendLike {
  return !!value && typeof value === 'object' && typeof (value as SmtpSendLike).sendMail === 'function';
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function handle(binding: SmtpSendLike, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST' || new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/send') {
    res.writeHead(404).end();
    return;
  }
  const { config, envelope, raw } = JSON.parse(await readBody(req)) as { config: unknown; envelope: unknown; raw: string };
  try {
    const result = await binding.sendMail(config, envelope, raw);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  } catch (error) {
    res
      .writeHead(500, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
  }
}

const bridges = new WeakMap<object, Promise<string>>();

/** The bridge's URL for the test's `SMTP_SEND`, when it has one. */
export async function smtpUrl(env: Record<string, unknown>): Promise<string | undefined> {
  const binding = env.SMTP_SEND;
  if (!isSmtpSendLike(binding)) return undefined;
  let url = bridges.get(binding);
  if (!url) {
    url = serveOnLoopback((req, res) => handle(binding, req, res));
    bridges.set(binding, url);
  }
  return url;
}
