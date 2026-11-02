/**
 * System mail in conformance mode. The TypeScript side's mail is what a
 * test's `memoryTransport()` (`@weldsuite/emails/transports/memory`)
 * received; the Rust side's what its recording transport did. Both are
 * compared as `MailRecord`s, and afterwards the test's transport holds
 * Rust's mail instead of TypeScript's, as its response is Rust's too.
 *
 * Compared: sender, recipients, Reply-To, subject, headers, attachments
 * (name, type, size) and the plain text with whitespace collapsed. Not the
 * HTML: weldsuite-emails' own tests check it renders the same bytes as the
 * React templates. Random values that differ per run by construction (link
 * tokens, ids, six-digit codes) are masked.
 */

/** `OutgoingEmail` from `@weldsuite/emails`, as far as the harness needs it. */
export interface OutgoingEmailLike {
  from: { email: string; name?: string };
  to: Array<{ email: string; name?: string }>;
  cc?: Array<{ email: string; name?: string }>;
  bcc?: Array<{ email: string; name?: string }>;
  replyTo?: { email: string; name?: string };
  subject: string;
  html: string;
  text: string;
  attachments?: Array<{ filename: string; content: string | Uint8Array; contentType: string }>;
  headers?: Record<string, string>;
}

interface MemoryTransportLike {
  sent: OutgoingEmailLike[];
}

/** What the Rust server's `/__conformance/side-effects` reports per email. */
export interface RustMail {
  from: { email: string; name?: string };
  to: Array<{ email: string; name?: string }>;
  cc: Array<{ email: string; name?: string }>;
  bcc: Array<{ email: string; name?: string }>;
  replyTo: { email: string; name?: string } | null;
  subject: string;
  html: string;
  text: string;
  attachments: Array<{ filename: string; contentType: string; contentBase64: string }>;
  headers: Record<string, string>;
}

export interface MailRecord {
  from: { email: string; name: string | null };
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string | null;
  subject: string;
  text: string;
  headers: Record<string, string>;
  attachments: Array<{ filename: string; contentType: string; size: number }>;
}

/** An email the TypeScript run sent, and the transport that holds it. */
export interface SentByTypeScript {
  transport: MemoryTransportLike;
  email: OutgoingEmailLike;
}

const MEMORY_TRANSPORTS = Symbol.for('weldsuite.emails.memoryTransports');

function transports(): MemoryTransportLike[] {
  const set = (globalThis as { [MEMORY_TRANSPORTS]?: Set<MemoryTransportLike> })[MEMORY_TRANSPORTS];
  return set ? [...set] : [];
}

/** Masks what differs per run by construction. */
function mask(text: string): string {
  return text.replace(/[A-Za-z0-9_-]{20,}/g, '<token>').replace(/\b\d{6}\b/g, '<code>');
}

function normalizeText(text: string): string {
  return mask(text.replace(/\s+/g, ' ').trim());
}

function byteLength(content: string | Uint8Array): number {
  return typeof content === 'string' ? new TextEncoder().encode(content).byteLength : content.byteLength;
}

export function mailRecord(email: OutgoingEmailLike): MailRecord {
  return {
    from: { email: email.from.email, name: email.from.name ?? null },
    to: email.to.map((m) => m.email),
    cc: (email.cc ?? []).map((m) => m.email),
    bcc: (email.bcc ?? []).map((m) => m.email),
    replyTo: email.replyTo?.email ?? null,
    subject: mask(email.subject),
    text: normalizeText(email.text),
    headers: email.headers ?? {},
    attachments: (email.attachments ?? []).map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      size: byteLength(a.content),
    })),
  };
}

/** Rust's email as the transport would have received it from TypeScript. */
export function fromRust(mail: RustMail): OutgoingEmailLike {
  return {
    from: mail.from,
    to: mail.to,
    ...(mail.cc.length ? { cc: mail.cc } : {}),
    ...(mail.bcc.length ? { bcc: mail.bcc } : {}),
    ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    ...(mail.attachments.length
      ? {
          attachments: mail.attachments.map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            content: new Uint8Array(Buffer.from(a.contentBase64, 'base64')),
          })),
        }
      : {}),
    ...(Object.keys(mail.headers).length ? { headers: mail.headers } : {}),
  };
}

/**
 * Collects what the test's memory transports received since the last call.
 * One per side-effect recorder.
 */
export function createMailCollector() {
  const seen = new WeakMap<MemoryTransportLike, number>();
  return {
    take(): SentByTypeScript[] {
      const out: SentByTypeScript[] = [];
      for (const transport of transports()) {
        const from = seen.get(transport) ?? 0;
        for (const email of transport.sent.slice(from)) out.push({ transport, email });
        seen.set(transport, transport.sent.length);
      }
      return out;
    },
    /**
     * Put Rust's mail where TypeScript's went: the transport TypeScript sent
     * through, else the newest one. The test then reads what Rust sent.
     */
    adopt(typescript: SentByTypeScript[], rust: RustMail[]): void {
      for (const { transport, email } of typescript) {
        const at = transport.sent.indexOf(email);
        if (at >= 0) transport.sent.splice(at, 1);
      }
      const target = typescript[0]?.transport ?? transports().at(-1);
      if (target) target.sent.push(...rust.map(fromRust));
      for (const transport of transports()) seen.set(transport, transport.sent.length);
    },
  };
}

export type MailCollector = ReturnType<typeof createMailCollector>;
