/**
 * SMTP submission over cloudflare:sockets (RFC 5321 / 3207 / 4954).
 *
 * One call = one connection = one message:
 *   connect → greeting → EHLO → [STARTTLS → EHLO] → AUTH → MAIL → RCPT… → DATA → QUIT
 *
 * `sendMail` never throws for anything the network or the server does; it
 * returns an SmtpSendResult that says whether to retry (permanent), where it
 * failed (stage) and why (reply code, enhanced code, hard-bounce and
 * bad-credentials flags). Only programming errors escape as exceptions.
 *
 * Credentials never travel in cleartext: on a non-secure connection the client
 * requires STARTTLS and refuses to authenticate when the server does not offer it.
 */
import { connect as cloudflareConnect } from 'cloudflare:sockets';
import { ReplyFormatError, ReplyParser, type SmtpReply } from './reply';
import type {
  SendMailOptions,
  SmtpConfig,
  SmtpEnvelope,
  SmtpSendResult,
  SmtpSocket,
  SmtpSocketFactory,
  SmtpStage,
} from './types';
import { toBase64, utf8 } from './util';

type SmtpFailure = Extract<SmtpSendResult, { ok: false }>;

const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
/** Bounded waits for the courtesy QUIT and for closing the socket, so cleanup cannot hang a send. */
const QUIT_TIMEOUT_MS = 3_000;
const CLOSE_TIMEOUT_MS = 2_000;

/** Replies to AUTH that mean "these credentials / this mechanism will not work". */
const AUTH_FAILURE_CODES = new Set([530, 534, 535, 538]);

const SAFE_RECIPIENT = /^[^\s<>"\\@\x00-\x1f\x7f-\uffff]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

export async function sendMail(
  config: SmtpConfig,
  envelope: SmtpEnvelope,
  raw: string,
  options: SendMailOptions = {},
): Promise<SmtpSendResult> {
  const preflight = checkRequest(config, envelope);
  if (!preflight.ok) return preflight.failure;

  const connectSocket: SmtpSocketFactory = options.connect ?? cloudflareConnect;
  const timeoutMs = config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  let socket: SmtpSocket;
  try {
    socket = connectSocket(
      { hostname: config.host, port: config.port },
      { secureTransport: config.secure ? 'on' : 'starttls', allowHalfOpen: false },
    );
  } catch (error) {
    return makeFailure({
      permanent: false,
      stage: 'connect',
      response: `Could not connect to ${config.host}:${config.port}: ${describeError(error)}`,
    });
  }

  const session = new SmtpSession(socket, timeoutMs);
  try {
    return await runTransaction(session, config, envelope, preflight.recipients, raw);
  } catch (error) {
    if (error instanceof SmtpAbort) return error.failure;
    throw error;
  } finally {
    await session.dispose();
  }
}

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

async function runTransaction(
  session: SmtpSession,
  config: SmtpConfig,
  envelope: SmtpEnvelope,
  recipients: string[],
  raw: string,
): Promise<SmtpSendResult> {
  const heloName = sanitizeHeloName(config.heloName ?? domainOf(envelope.from));

  await session.readGreeting();
  let capabilities = await session.ehlo(heloName);

  if (!config.secure) {
    if (!capabilities.starttls) {
      throw new SmtpAbort(
        makeFailure({
          permanent: true,
          stage: 'starttls',
          response:
            'Server does not offer STARTTLS on a non-secure connection; refusing to continue because credentials would be sent in cleartext',
        }),
      );
    }
    await session.startTls();
    capabilities = await session.ehlo(heloName);
  }

  if (config.username !== '') await session.authenticate(config.username, config.password, capabilities);

  await session.mailFrom(envelope.from);
  const accepted = await session.rcptTo(recipients);
  const response = await session.data(prepareData(raw));

  return { ok: true, response, accepted };
}

// ---------------------------------------------------------------------------
// Session: one TCP connection
// ---------------------------------------------------------------------------

/** Internal control flow: carries a finished failure result out of the protocol steps. */
class SmtpAbort extends Error {
  constructor(readonly failure: SmtpFailure) {
    super(failure.response);
    this.name = 'SmtpAbort';
  }
}

class TimeoutError extends Error {
  constructor() {
    super('timed out');
    this.name = 'TimeoutError';
  }
}

interface Capabilities {
  starttls: boolean;
  /** Upper-case SASL mechanism names from the AUTH extension. */
  auth: Set<string>;
}

class SmtpSession {
  private socket: SmtpSocket;
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private writer!: WritableStreamDefaultWriter<Uint8Array>;
  private decoder = new TextDecoder();
  private parser = new ReplyParser();
  private stage: SmtpStage = 'connect';
  /** The connection is gone, timed out or violated the protocol: nothing more can be said to it. */
  private broken = false;
  /** The whole message body was sent and the server's verdict has not arrived. */
  private awaitingFinalReply = false;
  private quitSent = false;

  constructor(
    socket: SmtpSocket,
    private timeoutMs: number,
  ) {
    this.socket = socket;
    this.attach(socket);
  }

  private attach(socket: SmtpSocket): void {
    // A failing connection also rejects `closed` / `opened`; the stream errors are what we act on,
    // so keep those promises from surfacing as unhandled rejections.
    socket.closed.catch(ignore);
    const opened: unknown = Reflect.get(socket, 'opened');
    if (opened instanceof Promise) opened.catch(ignore);

    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.decoder = new TextDecoder();
    this.parser = new ReplyParser();
  }

  // -- I/O ------------------------------------------------------------------

  private async write(data: string, what: string): Promise<void> {
    try {
      await raceTimeout(this.writer.write(utf8(data)), this.timeoutMs);
    } catch (error) {
      throw error instanceof TimeoutError ? this.timeoutFailure(what) : this.ioFailure(error, `sending ${what}`);
    }
  }

  private async readReply(what: string): Promise<SmtpReply> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const reply = this.takeReply();
      if (reply) return reply;

      const remaining = deadline - Date.now();
      if (remaining <= 0) throw this.timeoutFailure(what);

      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await raceTimeout(this.reader.read(), remaining);
      } catch (error) {
        throw error instanceof TimeoutError ? this.timeoutFailure(what) : this.ioFailure(error, `waiting for ${what}`);
      }
      if (chunk.done) throw this.ioFailure(new Error('connection closed by server'), `waiting for ${what}`);

      try {
        this.parser.push(this.decoder.decode(chunk.value, { stream: true }));
      } catch (error) {
        throw this.protocolFailure(error);
      }
    }
  }

  private takeReply(): SmtpReply | null {
    try {
      return this.parser.take();
    } catch (error) {
      throw this.protocolFailure(error);
    }
  }

  private async command(line: string, what: string): Promise<SmtpReply> {
    await this.write(`${line}\r\n`, what);
    return this.readReply(`the reply to ${what}`);
  }

  // -- Failure construction -------------------------------------------------

  private ioFailure(error: unknown, action: string): SmtpAbort {
    this.broken = true;
    return new SmtpAbort(
      makeFailure({
        permanent: false,
        stage: this.stage,
        response: `Connection error while ${action}: ${describeError(error)}`,
        deliveryUncertain: this.awaitingFinalReply,
      }),
    );
  }

  private timeoutFailure(what: string): SmtpAbort {
    this.broken = true;
    return new SmtpAbort(
      makeFailure({
        permanent: false,
        stage: 'timeout',
        response: `Timed out after ${this.timeoutMs} ms waiting for ${what}`,
        deliveryUncertain: this.awaitingFinalReply,
      }),
    );
  }

  /** The peer is not speaking SMTP (wrong port, TLS mismatch, hostile server): retrying will not help. */
  private protocolFailure(error: unknown): SmtpAbort {
    this.broken = true;
    return new SmtpAbort(
      makeFailure({
        permanent: true,
        stage: this.stage === 'connect' ? 'greeting' : this.stage,
        response: describeError(error),
        deliveryUncertain: this.awaitingFinalReply,
      }),
    );
  }

  // -- Protocol steps -------------------------------------------------------

  async readGreeting(): Promise<void> {
    // I/O errors before the greeting are connection errors (stage 'connect').
    const reply = await this.readReply('the server greeting');
    this.stage = 'greeting';
    if (reply.code !== 220) throw abortFromReply('greeting', reply);
  }

  async ehlo(name: string): Promise<Capabilities> {
    this.stage = 'ehlo';
    const reply = await this.command(`EHLO ${name}`, 'EHLO');
    if (reply.code !== 250) throw abortFromReply('ehlo', reply);
    return parseCapabilities(reply);
  }

  async startTls(): Promise<void> {
    this.stage = 'starttls';
    const reply = await this.command('STARTTLS', 'STARTTLS');
    if (reply.code !== 220) throw abortFromReply('starttls', reply);

    // Anything already buffered after the 220 was sent in cleartext by whoever
    // sits on the wire: refuse it (STARTTLS command-injection defence).
    if (this.parser.pendingLength > 0) {
      this.broken = true;
      throw new SmtpAbort(
        makeFailure({
          permanent: true,
          stage: 'starttls',
          response: 'Server sent data between the STARTTLS reply and the TLS handshake; refusing to upgrade',
        }),
      );
    }

    let upgraded: SmtpSocket;
    try {
      this.reader.releaseLock();
      this.writer.releaseLock();
      upgraded = this.socket.startTls();
    } catch (error) {
      throw this.ioFailure(error, 'upgrading the connection to TLS');
    }
    this.attach(upgraded);
  }

  async authenticate(username: string, password: string, capabilities: Capabilities): Promise<void> {
    this.stage = 'auth';

    if (capabilities.auth.has('PLAIN')) {
      const token = toBase64(utf8(`\u0000${username}\u0000${password}`));
      const reply = await this.command(`AUTH PLAIN ${token}`, 'AUTH PLAIN');
      if (reply.code !== 235) throw abortFromReply('auth', reply);
      return;
    }

    if (capabilities.auth.has('LOGIN')) {
      let reply = await this.command('AUTH LOGIN', 'AUTH LOGIN');
      if (reply.code !== 334) throw abortFromReply('auth', reply);
      reply = await this.command(toBase64(utf8(username)), 'the AUTH LOGIN username');
      if (reply.code !== 334) throw abortFromReply('auth', reply);
      reply = await this.command(toBase64(utf8(password)), 'the AUTH LOGIN password');
      if (reply.code !== 235) throw abortFromReply('auth', reply);
      return;
    }

    const offered = capabilities.auth.size > 0 ? [...capabilities.auth].join(' ') : 'none';
    throw new SmtpAbort(
      makeFailure({
        permanent: true,
        stage: 'auth',
        response: `Server offers no supported AUTH mechanism (need PLAIN or LOGIN; offered: ${offered})`,
      }),
    );
  }

  async mailFrom(sender: string): Promise<void> {
    this.stage = 'mail';
    const reply = await this.command(`MAIL FROM:<${sender}>`, 'MAIL FROM');
    if (reply.code !== 250) throw abortFromReply('mail', reply);
  }

  /** Returns the accepted recipients; throws when none were. */
  async rcptTo(recipients: string[]): Promise<string[]> {
    this.stage = 'rcpt';
    const accepted: string[] = [];
    const rejections: SmtpFailure[] = [];

    for (const recipient of recipients) {
      const reply = await this.command(`RCPT TO:<${recipient}>`, 'RCPT TO');
      if (reply.code === 250 || reply.code === 251) {
        accepted.push(recipient);
        continue;
      }
      const failure = failureFromReply('rcpt', reply);
      // 421 means the server is closing the channel: stop, do not try more recipients.
      if (reply.code === 421) throw new SmtpAbort(failure);
      rejections.push(failure);
    }

    if (accepted.length > 0) return accepted;

    // Nothing accepted. A temporary deferral anywhere makes the whole send retryable;
    // otherwise every recipient was permanently refused.
    const temporary = rejections.find((failure) => !failure.permanent);
    if (temporary) throw new SmtpAbort(temporary);
    const [first] = rejections;
    throw new SmtpAbort({ ...first, recipientRejected: rejections.some((failure) => failure.recipientRejected) });
  }

  /** Sends the (already dot-stuffed and terminated) message and returns the server's final reply. */
  async data(payload: string): Promise<string> {
    this.stage = 'data';
    const go = await this.command('DATA', 'DATA');
    if (go.code !== 354) throw abortFromReply('data', go);

    await this.write(payload, 'the message data');
    // From here the server may accept the message even if we never hear about it.
    this.awaitingFinalReply = true;
    const final = await this.readReply('the server to accept the message');
    this.awaitingFinalReply = false;
    if (final.code !== 250) throw abortFromReply('data', final);
    return final.text;
  }

  /** Courtesy QUIT; the outcome of the send is already decided, so nothing here can change it. */
  private async quit(): Promise<void> {
    if (this.broken || this.quitSent) return;
    this.quitSent = true;
    const previous = this.timeoutMs;
    this.timeoutMs = Math.min(previous, QUIT_TIMEOUT_MS);
    try {
      await this.command('QUIT', 'QUIT');
    } catch {
      // The server may drop the connection right after QUIT; irrelevant.
    } finally {
      this.timeoutMs = previous;
    }
  }

  /** QUIT on a healthy connection, then close. Called once the outcome is decided; never throws. */
  async dispose(): Promise<void> {
    await this.quit();
    try {
      await raceTimeout(Promise.resolve(this.socket.close()), CLOSE_TIMEOUT_MS);
    } catch {
      // Already closed or unresponsive; nothing left to do.
    }
  }
}

// ---------------------------------------------------------------------------
// Request checks and classification
// ---------------------------------------------------------------------------

type Preflight = { ok: true; recipients: string[] } | { ok: false; failure: SmtpFailure };

function checkRequest(config: SmtpConfig, envelope: SmtpEnvelope): Preflight {
  const refuse = (failure: Parameters<typeof makeFailure>[0]): Preflight => ({ ok: false, failure: makeFailure(failure) });

  if (config.port === 25) {
    return refuse({
      permanent: true,
      stage: 'connect',
      response:
        'Port 25 is not supported: Cloudflare Workers cannot open outbound connections on port 25. Use port 465 (implicit TLS) or 587 (STARTTLS).',
    });
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || config.host.trim() === '') {
    return refuse({ permanent: true, stage: 'connect', response: `Invalid SMTP server address ${config.host}:${config.port}` });
  }
  if (hasControlCharacters(config.username) || hasControlCharacters(config.password)) {
    return refuse({
      permanent: true,
      stage: 'auth',
      response: 'SMTP credentials contain control characters',
      authFailed: true,
    });
  }
  if (envelope.from !== '' && !SAFE_RECIPIENT.test(envelope.from)) {
    return refuse({ permanent: true, stage: 'mail', response: `Invalid sender address: ${printable(envelope.from)}` });
  }
  if (envelope.to.length === 0) {
    return refuse({ permanent: true, stage: 'rcpt', response: 'No recipients' });
  }

  const recipients = envelope.to.filter((address) => SAFE_RECIPIENT.test(address));
  if (recipients.length === 0) {
    const [first] = envelope.to;
    return refuse({
      permanent: true,
      stage: 'rcpt',
      response: `Invalid recipient address: ${printable(first)}`,
      recipientRejected: true,
    });
  }
  return { ok: true, recipients };
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

/** An address for an error message: no control characters, bounded length. */
function printable(value: string): string {
  return JSON.stringify(value.slice(0, 80));
}

function makeFailure(fields: {
  permanent: boolean;
  stage: SmtpStage;
  response: string;
  code?: number;
  enhancedCode?: string;
  recipientRejected?: boolean;
  authFailed?: boolean;
  deliveryUncertain?: boolean;
}): SmtpFailure {
  return {
    ok: false,
    permanent: fields.permanent,
    stage: fields.stage,
    ...(fields.code !== undefined ? { code: fields.code } : {}),
    ...(fields.enhancedCode ? { enhancedCode: fields.enhancedCode } : {}),
    response: fields.response,
    recipientRejected: fields.recipientRejected ?? false,
    authFailed: fields.authFailed ?? false,
    ...(fields.deliveryUncertain ? { deliveryUncertain: true } : {}),
  };
}

/**
 * Turns an unexpected server reply into a failure.
 *
 * 4xx is temporary (retry later). 5xx is permanent. A 2xx/3xx where something
 * else was required means the server is not following the protocol, which
 * retrying will not fix, so it is permanent too.
 */
function failureFromReply(stage: SmtpStage, reply: SmtpReply): SmtpFailure {
  return makeFailure({
    permanent: reply.code >= 500 || reply.code < 400,
    stage,
    code: reply.code,
    enhancedCode: reply.enhancedCode,
    response: reply.text,
    recipientRejected: stage === 'rcpt' && reply.code >= 500 && isRecipientStyleRejection(reply),
    authFailed: stage === 'auth' && AUTH_FAILURE_CODES.has(reply.code),
  });
}

function abortFromReply(stage: SmtpStage, reply: SmtpReply): SmtpAbort {
  return new SmtpAbort(failureFromReply(stage, reply));
}

/**
 * Whether a permanent RCPT failure is about the recipient (a hard bounce) as
 * opposed to our connection or the server (relay denied, protocol trouble).
 *
 * With an enhanced code: 5.1.x (bad destination address), 5.2.1 (mailbox
 * disabled) and 5.7.1 (delivery not authorized). Without one: 550, 551, 553.
 */
function isRecipientStyleRejection(reply: SmtpReply): boolean {
  const enhanced = reply.enhancedCode;
  if (enhanced) return enhanced.startsWith('5.1.') || enhanced === '5.2.1' || enhanced === '5.7.1';
  return reply.code === 550 || reply.code === 551 || reply.code === 553;
}

function parseCapabilities(reply: SmtpReply): Capabilities {
  const capabilities: Capabilities = { starttls: false, auth: new Set() };
  // The first line is the server's greeting to us; the extensions follow.
  for (const line of reply.lines.slice(1)) {
    const keyword = line.trim().toUpperCase();
    if (keyword === 'STARTTLS') {
      capabilities.starttls = true;
    } else if (keyword.startsWith('AUTH ') || keyword.startsWith('AUTH=')) {
      for (const mechanism of keyword.slice(5).split(/[\s=]+/)) {
        if (mechanism) capabilities.auth.add(mechanism);
      }
    }
  }
  return capabilities;
}

// ---------------------------------------------------------------------------
// DATA payload
// ---------------------------------------------------------------------------

/**
 * Normalises line endings to CRLF, dot-stuffs lines that start with "." (RFC
 * 5321 section 4.5.2) and appends the end-of-data marker CRLF.CRLF.
 */
export function prepareData(raw: string): string {
  const lines = raw.replace(/\r\n|\r|\n/g, '\r\n').split('\r\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const stuffed = lines.map((line) => (line.startsWith('.') ? `.${line}` : line));
  return `${stuffed.join('\r\n')}\r\n.\r\n`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ignore(): void {
  // Deliberately empty: used to mark a promise rejection as handled.
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1);
}

function sanitizeHeloName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9.\-[\]:]/g, '');
  return cleaned === '' ? 'localhost' : cleaned;
}

function describeError(error: unknown): string {
  if (error instanceof ReplyFormatError) return error.message;
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/** Rejects with TimeoutError after `ms`; always clears its timer. */
function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
