/**
 * A scripted SMTP server for tests. It implements `SmtpSocket` over
 * ReadableStream/WritableStream pairs, so the client is exercised through the
 * same interface it uses on Workers, including the STARTTLS upgrade
 * (`startTls()` hands back a second socket that continues the same script).
 *
 * The script is a list of steps. Each step names the command line the client
 * must send next and the reply to play. A command that does not match is
 * recorded in `errors` and answered with `503`, so a test fails loudly.
 * `QUIT` is answered automatically and is not part of the script.
 */
import type { SmtpSocket, SmtpSocketFactory } from '../types';

type Lines = string | string[] | null;

export interface ScriptStep {
  /** Exact command line (without CRLF), or a pattern for it. */
  expect: string | RegExp;
  /** Reply lines (without CRLF). null = stay silent, so the client times out. */
  reply: Lines;
  /** Deliver this reply in pieces of this many bytes. */
  chunkSize?: number;
  /** The client must call startTls() next; the script continues on the new socket. */
  upgrade?: boolean;
  /**
   * Message body phase: the server waits for CRLF.CRLF and then plays this
   * reply (and optionally drops the connection, cleanly or with an error).
   */
  data?: { reply: Lines; chunkSize?: number; hangUp?: boolean; reset?: boolean };
  /** Close the connection (cleanly) after the reply. */
  hangUp?: boolean;
  /** Fail the connection with an error instead of delivering anything further. */
  reset?: boolean;
}

export interface FakeServerOptions {
  /** Banner sent on connect. null = silence. Default: "220 fake.example.test ESMTP". */
  greeting?: Lines;
  script: ScriptStep[];
  /** Default piece size for every reply (steps may override). */
  chunkSize?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class FakeSocket implements SmtpSocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly closed: Promise<void>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private resolveClosed!: () => void;
  private ended = false;

  constructor(private readonly server: FakeSmtpServer) {
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        server.receive(this, decoder.decode(chunk));
      },
    });
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  send(bytes: Uint8Array): void {
    if (!this.ended) this.controller.enqueue(bytes);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.controller.close();
    this.resolveClosed();
  }

  fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.controller.error(error);
    this.resolveClosed();
  }

  async close(): Promise<void> {
    this.server.closeCalls += 1;
    if (!this.ended) {
      this.ended = true;
      this.controller.close();
      this.resolveClosed();
    }
  }

  startTls(): SmtpSocket {
    return this.server.upgradeFrom(this);
  }
}

export class FakeSmtpServer {
  /** Every command line received, in order (QUIT included). */
  readonly commands: string[] = [];
  /** Protocol violations by the client or script mismatches. Empty on a clean run. */
  readonly errors: string[] = [];
  /** Message bodies received between DATA and CRLF.CRLF, exactly as sent on the wire. */
  readonly bodies: string[] = [];
  /** Everything the client sent before the connection was encrypted. */
  cleartext = '';
  readonly connects: Array<{
    address: { hostname: string; port: number };
    options: { secureTransport: 'on' | 'off' | 'starttls'; allowHalfOpen: boolean };
  }> = [];
  upgrades = 0;
  closeCalls = 0;

  private readonly script: ScriptStep[];
  private readonly greeting: Lines;
  private readonly defaultChunkSize: number | undefined;
  private position = 0;
  private active: FakeSocket | null = null;
  private encrypted = false;
  private upgradePending = false;
  private pendingData: ScriptStep['data'] | null = null;
  private inbox = '';

  constructor(options: FakeServerOptions) {
    this.script = options.script;
    this.greeting = options.greeting === undefined ? '220 fake.example.test ESMTP' : options.greeting;
    this.defaultChunkSize = options.chunkSize;
  }

  /** Pass as `options.connect` to `sendMail`. */
  readonly connect: SmtpSocketFactory = (address, options) => {
    this.connects.push({ address, options });
    const socket = new FakeSocket(this);
    this.active = socket;
    this.encrypted = options.secureTransport === 'on';
    this.emit(socket, this.greeting, this.defaultChunkSize);
    return socket;
  };

  /** Script steps the client never reached. */
  get unconsumed(): ScriptStep[] {
    return this.script.slice(this.position);
  }

  receive(from: FakeSocket, text: string): void {
    if (from !== this.active) {
      this.errors.push(`data written to a socket that was already upgraded: ${JSON.stringify(text)}`);
      return;
    }
    if (!this.encrypted) this.cleartext += text;
    this.inbox += text;
    this.pump(from);
  }

  upgradeFrom(from: FakeSocket): SmtpSocket {
    if (!this.upgradePending || from !== this.active) {
      this.errors.push('startTls() called although no STARTTLS was accepted');
      throw new Error('fake server: unexpected startTls()');
    }
    this.upgradePending = false;
    this.encrypted = true;
    this.upgrades += 1;
    this.inbox = '';
    const next = new FakeSocket(this);
    this.active = next;
    return next;
  }

  private pump(socket: FakeSocket): void {
    for (;;) {
      if (this.pendingData) {
        const end = this.inbox.indexOf('\r\n.\r\n');
        if (end === -1) return;
        this.bodies.push(this.inbox.slice(0, end + 2));
        this.inbox = this.inbox.slice(end + 5);
        const { reply, chunkSize, hangUp, reset } = this.pendingData;
        this.pendingData = null;
        this.emit(socket, reply, chunkSize ?? this.defaultChunkSize);
        if (reset) socket.fail(new Error('read ECONNRESET'));
        else if (hangUp) socket.end();
        continue;
      }

      const newline = this.inbox.indexOf('\r\n');
      if (newline === -1) return;
      const line = this.inbox.slice(0, newline);
      this.inbox = this.inbox.slice(newline + 2);
      this.dispatch(socket, line);
    }
  }

  private dispatch(socket: FakeSocket, line: string): void {
    this.commands.push(line);

    if (line.toUpperCase() === 'QUIT') {
      this.emit(socket, '221 2.0.0 Bye', this.defaultChunkSize);
      socket.end();
      return;
    }

    const step = this.script[this.position];
    if (!step) {
      this.errors.push(`unexpected command after the end of the script: ${line}`);
      this.emit(socket, '503 5.5.1 unexpected command', undefined);
      return;
    }
    this.position += 1;

    const matches = typeof step.expect === 'string' ? step.expect === line : step.expect.test(line);
    if (!matches) {
      this.errors.push(`expected ${String(step.expect)} but received ${line}`);
      this.emit(socket, '503 5.5.1 script mismatch', undefined);
      return;
    }

    if (step.reset) {
      socket.fail(new Error('read ECONNRESET'));
      return;
    }
    this.emit(socket, step.reply, step.chunkSize ?? this.defaultChunkSize);
    if (step.upgrade) this.upgradePending = true;
    if (step.data) this.pendingData = step.data;
    if (step.hangUp) socket.end();
  }

  private emit(socket: FakeSocket, reply: Lines, chunkSize: number | undefined): void {
    if (reply === null) return;
    const lines = Array.isArray(reply) ? reply : [reply];
    const bytes = encoder.encode(lines.map((line) => `${line}\r\n`).join(''));
    const size = chunkSize ?? bytes.length;
    for (let offset = 0; offset < bytes.length; offset += size) {
      socket.send(bytes.slice(offset, offset + size));
    }
  }
}
