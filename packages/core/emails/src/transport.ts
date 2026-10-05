/** A mailbox: bare address plus optional display name. */
export interface Mailbox {
  email: string;
  name?: string;
}

export interface OutgoingAttachment {
  filename: string;
  /** Text (sent as UTF-8) or raw bytes. Never pre-encoded base64. */
  content: string | Uint8Array;
  /** e.g. `text/calendar; method=REQUEST; charset=UTF-8`. */
  contentType: string;
}

/** A fully rendered email, ready for a transport. */
export interface OutgoingEmail {
  from: Mailbox;
  to: Mailbox[];
  cc?: Mailbox[];
  bcc?: Mailbox[];
  replyTo?: Mailbox;
  subject: string;
  html: string;
  text: string;
  attachments?: OutgoingAttachment[];
  headers?: Record<string, string>;
}

export interface SendResult {
  messageId: string;
  /** Which transport delivered it (`cloudflare-binding`, `cloudflare-rest`, …). */
  transport: string;
  /** Recipients the transport refused or that bounced permanently; the rest were accepted. */
  rejected?: string[];
}

/** Delivers a rendered email. Implementations live in `./transports/`. */
export interface EmailTransport {
  readonly name: string;
  send(email: OutgoingEmail): Promise<SendResult>;
}

/** `"Name" <a@b>`, quoting the name and dropping characters that break the header. */
export function formatMailbox({ email, name }: Mailbox): string {
  const clean = name?.replace(/["\\<>\r\n]/g, '').trim();
  return clean ? `"${clean}" <${email}>` : email;
}

export function attachmentBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** The MIME type without parameters (`text/calendar; method=REQUEST` → `text/calendar`). */
export function baseContentType(contentType: string): string {
  return contentType.split(';')[0]!.trim();
}

/**
 * Send through `transport` from another address than the system one. Only for
 * the migration: a worker whose Cloudflare sending domain is not onboarded yet
 * keeps its old verified sender (`SYSTEM_EMAIL_FROM`).
 */
export function withFromAddress(transport: EmailTransport, address: string | undefined): EmailTransport {
  const email = address?.trim();
  if (!email) return transport;
  return {
    name: transport.name,
    send: (message) => transport.send({ ...message, from: { ...message.from, email } }),
  };
}
