/**
 * Cloudflare Email Worker → IEmailReceiveProvider.
 *
 * The Worker entry point is:
 *
 *   import { createCloudflareEmailHandler } from '@weldsuite/email/providers/cloudflare';
 *   export default {
 *     async email(message, env, ctx) {
 *       const parsed = await receiveProvider.parse(message);
 *       await processInboundEmail(env, parsed);
 *     },
 *   };
 */

import type { IEmailReceiveProvider, ParsedInboundEmail } from '../../core/types';
import { parseRawEmail } from '../../core/parse';

const PROVIDER = 'cloudflare';

/** Subset of the runtime `ForwardableEmailMessage` used by this module. */
export interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly headers: Headers;
  readonly rawSize: number;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<void>;
  reply?(message: unknown): Promise<void>;
}

export class CloudflareReceiveProvider implements IEmailReceiveProvider<ForwardableEmailMessage> {
  readonly name = PROVIDER;

  async parse(message: ForwardableEmailMessage): Promise<ParsedInboundEmail> {
    // Drain the stream into an ArrayBuffer once — postal-mime needs the full
    // buffer and the stream is single-use.
    const raw = await streamToArrayBuffer(message.raw);
    const parsed = await parseRawEmail(raw, {
      metadata: {
        envelopeFrom: message.from,
        envelopeTo: message.to,
        rawSize: message.rawSize,
      },
    });
    // Cloudflare puts SPF/DKIM/DMARC results in headers — pull them through
    // even if postal-mime didn't surface them on the parsed email.
    const auth = message.headers.get('authentication-results') ?? '';
    if (!parsed.spfStatus && /spf=(\w+)/i.exec(auth)) {
      parsed.spfStatus = (/spf=(\w+)/i.exec(auth)?.[1] as ParsedInboundEmail['spfStatus']) ?? undefined;
    }
    if (!parsed.dkimStatus && /dkim=(\w+)/i.exec(auth)) {
      parsed.dkimStatus = (/dkim=(\w+)/i.exec(auth)?.[1] as ParsedInboundEmail['dkimStatus']) ?? undefined;
    }
    if (!parsed.dmarcStatus && /dmarc=(\w+)/i.exec(auth)) {
      parsed.dmarcStatus = (/dmarc=(\w+)/i.exec(auth)?.[1] as ParsedInboundEmail['dmarcStatus']) ?? undefined;
    }
    return parsed;
  }
}

/**
 * Convenience handler factory. Returns a function shaped like the Worker
 * `email(message, env, ctx)` runtime handler. Pass it your downstream
 * processor; the provider parses, you store.
 */
export function createCloudflareEmailHandler<TEnv>(
  process: (parsed: ParsedInboundEmail, env: TEnv, ctx: ExecutionContext, raw: ForwardableEmailMessage) => Promise<void>,
): (message: ForwardableEmailMessage, env: TEnv, ctx: ExecutionContext) => Promise<void> {
  const provider = new CloudflareReceiveProvider();
  return async (message, env, ctx) => {
    const parsed = await provider.parse(message);
    await process(parsed, env, ctx, message);
  };
}

async function streamToArrayBuffer(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}
