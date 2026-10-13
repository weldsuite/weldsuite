/**
 * Public types of @weldsuite/smtp. reach-api codes against these; change them
 * only together with their callers.
 */

export interface SmtpConfig {
  host: string;
  /** 465 = implicit TLS, 587 = STARTTLS. */
  port: number;
  /**
   * true = TLS from the first byte (465). false = plain connect + mandatory
   * STARTTLS (587); a server that does not offer STARTTLS is refused, so
   * credentials never travel in cleartext.
   */
  secure: boolean;
  username: string;
  password: string;
  /** EHLO name; defaults to the sender's domain. */
  heloName?: string;
  /** Per-command timeout, default 20 s. */
  commandTimeoutMs?: number;
}

export interface MailAddress {
  email: string;
  name?: string;
}

export interface SmtpEnvelope {
  /** MAIL FROM. */
  from: string;
  /** RCPT TO (one or more). */
  to: string[];
}

export interface OutgoingMessage {
  from: MailAddress;
  to: MailAddress[];
  replyTo?: MailAddress;
  subject: string;
  /** Plain-text body (required; cold email is text-first). */
  text: string;
  /** Optional HTML alternative. */
  html?: string;
  /** Without angle brackets, e.g. "abc123@getacme.com". */
  messageId: string;
  /** Without angle brackets. */
  inReplyTo?: string;
  /** Without angle brackets, oldest first. */
  references?: string[];
  /** Extra headers, e.g. List-Unsubscribe. Never set Message-ID/Date/From/To here. */
  headers?: Record<string, string>;
  /** Defaults to now. */
  date?: Date;
}

export type SmtpStage =
  | 'connect'
  | 'greeting'
  | 'ehlo'
  | 'starttls'
  | 'auth'
  | 'mail'
  | 'rcpt'
  | 'data'
  | 'timeout';

export type SmtpSendResult =
  | {
      ok: true;
      /** Final server reply to DATA, e.g. "250 2.0.0 OK 1700000000 abc - gsmtp". */
      response: string;
      /** Recipients the server accepted. */
      accepted: string[];
    }
  | {
      ok: false;
      /** 5xx (or a refused/insecure connection): do not retry. 4xx/timeouts: retry later. */
      permanent: boolean;
      stage: SmtpStage;
      /** SMTP reply code, when the server answered. */
      code?: number;
      /** Enhanced status code (RFC 3463), e.g. "5.1.1". */
      enhancedCode?: string;
      response: string;
      /** The failure was the server rejecting a recipient (RCPT 550 5.1.x etc.): a hard bounce. */
      recipientRejected: boolean;
      /** Login failed (535 / 534): the mailbox credentials or the account need attention. */
      authFailed: boolean;
      /**
       * Set when the connection failed or timed out after the whole message was
       * sent but before the server's final reply: the server may have accepted
       * (and will deliver) it. Never retry such a send automatically; record it
       * as unknown. Absent for every failure where the server definitely did not
       * take the message.
       */
      deliveryUncertain?: boolean;
    };

/** A duplex byte stream, shaped like the `Socket` from `cloudflare:sockets`. */
export interface SmtpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  closed: Promise<void>;
  close(): Promise<void>;
  /** STARTTLS upgrade; returns the new (TLS) socket. */
  startTls(): SmtpSocket;
}

export type SmtpSocketFactory = (
  address: { hostname: string; port: number },
  options: { secureTransport: 'on' | 'off' | 'starttls'; allowHalfOpen: boolean },
) => SmtpSocket;

export interface SendMailOptions {
  /** Defaults to `connect` from `cloudflare:sockets`. Tests inject a scripted server. */
  connect?: SmtpSocketFactory;
}
