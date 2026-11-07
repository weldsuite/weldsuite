/**
 * SMTP transport, for Node code that sends system email through a relay: the
 * staff admin console on the Kubernetes editions (EU, self-hosted), where the
 * Rust server sends its own system mail through the same relay.
 *
 * Node only: nodemailer opens sockets. Never import it from a Worker, and keep
 * it out of `./env`, which Workers and Worker-bundled code import. Node callers
 * pick it from the environment with `transportFromNodeEnv` (`./node-env`).
 *
 * Configured by one URL, `SMTP_URL`, read the way the Rust server's lettre
 * reads it (`rust/crates/adapters-oss/src/smtp.rs`), so both take one value:
 *
 * - `smtp://user:password@relay.example.com:587?tls=required`: STARTTLS,
 *   refused when the server does not offer it
 * - `smtp://user:password@relay.example.com?tls=opportunistic`: STARTTLS when
 *   the server offers it, plain otherwise (not for production)
 * - `smtps://user:password@relay.example.com:465`: TLS from the first byte
 * - `smtp://mailpit:1025`: plain, for a relay inside the cluster or tests
 *
 * Without a port: 25 for plain `smtp`, 587 with a `tls` parameter, 465 for
 * `smtps`. A path names the host sent in EHLO (`smtp://relay/mail.example.eu`).
 * The user name and password are percent-decoded and used only when the URL
 * has a password. Certificates are checked against Node's CA store.
 */

import { createTransport, type SendMailOptions, type SMTPTransportOptions, type Transporter } from 'nodemailer';
import type { EmailTransport, Mailbox, OutgoingEmail, SendResult } from '../transport';

export interface SmtpTransportOptions {
  /** The relay, as `SMTP_URL` gives it (see the module docs). */
  url: string;
}

/**
 * How the connection is secured: `tls` from the first byte (`smtps`),
 * `starttls` required, `opportunistic` STARTTLS, or `none` (plain).
 */
export type SmtpSecurity = 'tls' | 'starttls' | 'opportunistic' | 'none';

/** An `SMTP_URL`, parsed. */
export interface SmtpRelay {
  host: string;
  port: number;
  security: SmtpSecurity;
  auth?: { user: string; pass: string };
  /** The host name sent in EHLO; nodemailer's default (the machine's) when unset. */
  helloName?: string;
}

const PORTS: Record<SmtpSecurity, number> = { none: 25, starttls: 587, opportunistic: 587, tls: 465 };

/**
 * Parse an `SMTP_URL` the way lettre does. Throws on anything lettre refuses:
 * another scheme, no host, or an unknown `tls` value. Errors never repeat the
 * URL, which holds the relay password.
 */
export function parseSmtpUrl(value: string): SmtpRelay {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('SMTP_URL is not a valid URL');
  }

  const scheme = url.protocol.replace(/:$/, '');
  const tls = url.searchParams.get('tls');
  let security: SmtpSecurity;
  if (scheme === 'smtps') security = 'tls';
  else if (scheme === 'smtp' && tls === null) security = 'none';
  else if (scheme === 'smtp' && tls === 'required') security = 'starttls';
  else if (scheme === 'smtp' && tls === 'opportunistic') security = 'opportunistic';
  else {
    throw new Error(
      `SMTP_URL: unknown scheme '${scheme}' or tls parameter '${tls ?? ''}' ` +
        '(use smtp://, smtp://…?tls=required, smtp://…?tls=opportunistic or smtps://)',
    );
  }

  // An IPv6 literal keeps its brackets in `hostname`; sockets want it bare.
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (!host) throw new Error('SMTP_URL: the relay host is missing');

  const relay: SmtpRelay = { host, port: url.port ? Number(url.port) : PORTS[security], security };
  if (url.password) {
    relay.auth = { user: decode(url.username), pass: decode(url.password) };
  }
  const helloName = trimSlashes(url.pathname);
  if (helloName) relay.helloName = helloName;
  return relay;
}

/** Leading and trailing slashes off, as lettre's `trim_matches('/')`. */
function trimSlashes(path: string): string {
  let start = 0;
  let end = path.length;
  while (start < end && path[start] === '/') start += 1;
  while (end > start && path[end - 1] === '/') end -= 1;
  return path.slice(start, end);
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new Error('SMTP_URL: the user name or password is not valid percent-encoding');
  }
}

/** nodemailer's SMTP options for a relay. One connection per message, no pool. */
export function smtpOptions(relay: SmtpRelay): SMTPTransportOptions {
  return {
    host: relay.host,
    port: relay.port,
    secure: relay.security === 'tls',
    requireTLS: relay.security === 'starttls',
    // lettre's plain `smtp://` never upgrades, even when the relay offers STARTTLS.
    ignoreTLS: relay.security === 'none',
    ...(relay.auth ? { auth: { user: relay.auth.user, pass: relay.auth.pass } } : {}),
    ...(relay.helloName ? { name: relay.helloName } : {}),
    // A send runs inside a request: fail in seconds, not nodemailer's minutes.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    // Attachments carry their bytes; never let a message read a file or a URL.
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

/** A mailbox for nodemailer, cleaning the display name as `formatMailbox` does. */
function address({ email, name }: Mailbox): { name: string; address: string } | string {
  const clean = name?.replace(/["\\<>\r\n]/g, '').trim();
  return clean ? { name: clean, address: email } : email;
}

/** The message nodemailer builds the MIME from: text and HTML as alternatives, attachments around them. */
export function smtpMessage(email: OutgoingEmail): SendMailOptions {
  return {
    from: address(email.from),
    to: email.to.map(address),
    ...(email.cc?.length ? { cc: email.cc.map(address) } : {}),
    ...(email.bcc?.length ? { bcc: email.bcc.map(address) } : {}),
    ...(email.replyTo ? { replyTo: address(email.replyTo) } : {}),
    subject: email.subject,
    text: email.text,
    html: email.html,
    ...(email.headers ? { headers: email.headers } : {}),
    ...(email.attachments?.length
      ? {
          attachments: email.attachments.map((a) => ({
            filename: a.filename,
            content:
              typeof a.content === 'string'
                ? a.content
                : Buffer.from(a.content.buffer, a.content.byteOffset, a.content.byteLength),
            contentType: a.contentType,
          })),
        }
      : {}),
  };
}

/**
 * Wrap any nodemailer transporter as an `EmailTransport`. `smtpTransport`
 * passes an SMTP one; tests pass nodemailer's stream or JSON transport.
 */
export function nodemailerTransport(transporter: Transporter, name = 'smtp'): EmailTransport {
  return {
    name,
    async send(email: OutgoingEmail): Promise<SendResult> {
      // The SMTP transport's info; the stream and JSON ones carry the same fields or none.
      const info = (await transporter.sendMail(smtpMessage(email))) as {
        messageId?: string;
        rejected?: Array<string | { address: string }>;
      };
      const rejected = (info.rejected ?? []).map((r) => (typeof r === 'string' ? r : r.address));
      return {
        messageId: info.messageId ?? '',
        transport: name,
        ...(rejected.length ? { rejected } : {}),
      };
    },
  };
}

/** System email through an SMTP relay. Throws on a malformed `url` (see `parseSmtpUrl`). */
export function smtpTransport(options: SmtpTransportOptions): EmailTransport {
  // The URL picks the encryption, as on the Rust server: plain only for a bare
  // `smtp://` (a relay inside the cluster, Mailpit); `?tls=required` or `smtps://` otherwise.
  // eslint-disable-next-line sonarjs/no-clear-text-protocols
  return nodemailerTransport(createTransport(smtpOptions(parseSmtpUrl(options.url))));
}
