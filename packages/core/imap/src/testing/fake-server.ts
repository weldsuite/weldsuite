/**
 * A scripted IMAP server for tests. It implements `ImapSocket` over
 * ReadableStream/WritableStream pairs, so the client is exercised through the
 * same interface it uses on Workers.
 *
 * The script is a list of steps. Each step names the command the client must
 * send next (without its tag) and the reply to play; `$TAG` in a reply stands
 * for the tag the client chose. A command that does not match is recorded in
 * `errors` and answered with a tagged BAD, so a test fails loudly. `LOGOUT` is
 * answered automatically and is not part of the script.
 *
 * Client literals: when a command line ends in `{n}` the server answers
 * `+ Ready for literal data` (or the step's `refuseLiteral`), reads n bytes and
 * carries on with the rest of the command line. The command a step matches is
 * the first line without its tag, with each literal on a line of its own:
 *
 *   A001 LOGIN "user" {9}CRLF pässword CRLF   →   'LOGIN "user" {9}\npässword'
 */
import type { ImapSocket, ImapSocketFactory } from '../types';

type Lines = string | string[] | null;

export interface ScriptStep {
  /** The command without its tag, literals inlined (see the file header), or a pattern for it. */
  expect: string | RegExp;
  /** Reply lines (without CRLF). null = stay silent, so the client times out. */
  reply: Lines;
  /** Deliver this reply in pieces of this many bytes. */
  chunkSize?: number;
  /** Answer the client's literal announcement with this instead of `+`; the command then ends there. */
  refuseLiteral?: Lines;
  /** Close the connection (cleanly) after the reply. */
  hangUp?: boolean;
  /** Fail the connection with an error instead of replying. */
  reset?: boolean;
}

export interface FakeServerOptions {
  /** Banner sent on connect. null = silence. Default: "* OK [CAPABILITY IMAP4rev1] fake IMAP ready". */
  greeting?: Lines;
  script: ScriptStep[];
  /** Default piece size for every reply (steps may override). */
  chunkSize?: number;
  /** Never answer LOGOUT, so the client's bounded wait runs out. */
  ignoreLogout?: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class FakeSocket implements ImapSocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly closed: Promise<void>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private resolveClosed!: () => void;
  private ended = false;

  constructor(private readonly server: FakeImapServer) {
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        server.receive(chunk);
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
    this.end();
  }
}

interface PendingCommand {
  tag: string;
  /** Physical lines of the command, markers of client literals still attached. */
  lines: string[];
  literals: string[];
}

export class FakeImapServer {
  /** Every command received, tag removed, literals inlined (see the file header), in order. LOGOUT included. */
  readonly commands: string[] = [];
  /** The first physical line of every command, tag included (`A001 LOGIN ...`). */
  readonly wire: string[] = [];
  /** Literal payloads sent by the client, in order. */
  readonly literals: string[] = [];
  /** Protocol violations by the client or script mismatches. Empty on a clean run. */
  readonly errors: string[] = [];
  readonly connects: Array<{
    address: { hostname: string; port: number };
    options: { secureTransport: 'on'; allowHalfOpen: boolean };
  }> = [];
  closeCalls = 0;

  private readonly script: ScriptStep[];
  private readonly greeting: Lines;
  private readonly defaultChunkSize: number | undefined;
  private readonly ignoreLogout: boolean;
  private position = 0;
  private active: FakeSocket | null = null;
  private inbox = new Uint8Array(0);
  private command: PendingCommand | null = null;
  private literalBytes: number | null = null;

  constructor(options: FakeServerOptions) {
    this.script = options.script;
    this.greeting = options.greeting === undefined ? '* OK [CAPABILITY IMAP4rev1] fake IMAP ready' : options.greeting;
    this.defaultChunkSize = options.chunkSize;
    this.ignoreLogout = options.ignoreLogout ?? false;
  }

  /** Pass as `options.connect` to `connectImap`. */
  readonly connect: ImapSocketFactory = (address, options) => {
    this.connects.push({ address, options });
    const socket = new FakeSocket(this);
    this.active = socket;
    this.emit(this.greeting, '', this.defaultChunkSize);
    return socket;
  };

  /** Script steps the client never reached. */
  get unconsumed(): ScriptStep[] {
    return this.script.slice(this.position);
  }

  /** Plays a line the server volunteers outside any command (for unsolicited responses, BYE, ...). */
  push(lines: Lines): void {
    this.emit(lines, '', this.defaultChunkSize);
  }

  /** Closes the connection from the server side. */
  hangUp(): void {
    this.active?.end();
  }

  receive(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.inbox.length + chunk.length);
    merged.set(this.inbox);
    merged.set(chunk, this.inbox.length);
    this.inbox = merged;
    this.pump();
  }

  private pump(): void {
    for (;;) {
      if (this.literalBytes !== null) {
        if (this.inbox.length < this.literalBytes) return;
        const payload = decoder.decode(this.inbox.subarray(0, this.literalBytes));
        this.inbox = this.inbox.slice(this.literalBytes);
        this.literalBytes = null;
        this.literals.push(payload);
        this.command?.literals.push(payload);
        continue;
      }

      const eol = this.findCrlf();
      if (eol === -1) return;
      const line = decoder.decode(this.inbox.subarray(0, eol));
      this.inbox = this.inbox.slice(eol + 2);
      this.onLine(line);
    }
  }

  private findCrlf(): number {
    for (let i = 0; i + 1 < this.inbox.length; i++) {
      if (this.inbox[i] === 0x0d && this.inbox[i + 1] === 0x0a) return i;
    }
    return -1;
  }

  private onLine(line: string): void {
    if (this.command === null) {
      this.wire.push(line);
      this.command = { tag: line.split(' ')[0] ?? '', lines: [], literals: [] };
    }
    this.command.lines.push(line);

    const size = literalSize(line);
    if (size === null) {
      this.finishCommand();
      return;
    }

    const refusal = this.script[this.position]?.refuseLiteral;
    if (refusal !== undefined) {
      this.finishCommand(refusal);
      return;
    }
    this.emit('+ Ready for literal data', this.command.tag, undefined);
    this.literalBytes = size;
  }

  private finishCommand(refusal?: Lines): void {
    const command = this.command;
    this.command = null;
    if (command === null) return;

    const logical = logicalCommand(command);
    this.commands.push(logical);
    const socket = this.active;
    if (socket === null) return;

    if (logical === 'LOGOUT') {
      if (this.ignoreLogout) return;
      this.emit(['* BYE Logging out', '$TAG OK LOGOUT completed'], command.tag, this.defaultChunkSize);
      socket.end();
      return;
    }

    const step = this.script[this.position];
    if (!step) {
      this.errors.push(`unexpected command after the end of the script: ${logical}`);
      this.emit('$TAG BAD unexpected command', command.tag, undefined);
      return;
    }
    this.position += 1;

    const matches = typeof step.expect === 'string' ? step.expect === logical : step.expect.test(logical);
    if (!matches) {
      this.errors.push(`expected ${String(step.expect)} but received ${logical}`);
      this.emit('$TAG BAD script mismatch', command.tag, undefined);
      return;
    }

    if (step.reset) {
      socket.fail(new Error('read ECONNRESET'));
      return;
    }
    this.emit(refusal ?? step.reply, command.tag, step.chunkSize ?? this.defaultChunkSize);
    if (step.hangUp) socket.end();
  }

  private emit(reply: Lines, tag: string, chunkSize: number | undefined): void {
    if (reply === null || this.active === null) return;
    const lines = Array.isArray(reply) ? reply : [reply];
    const bytes = encoder.encode(lines.map((line) => `${line.replaceAll('$TAG', tag)}\r\n`).join(''));
    const size = chunkSize ?? bytes.length;
    for (let offset = 0; offset < bytes.length; offset += size) {
      this.active.send(bytes.slice(offset, offset + size));
    }
  }
}

/** First line without its tag, then each literal and the line continuing after it, newline-separated. */
function logicalCommand(command: PendingCommand): string {
  const [first = '', ...rest] = command.lines;
  const parts = [first.slice(command.tag.length + 1)];
  rest.forEach((line, index) => {
    parts.push(command.literals[index] ?? '', line);
  });
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts.join('\n');
}

/** n of a trailing `{n}` or `{n+}`, else null. */
function literalSize(line: string): number | null {
  if (!line.endsWith('}')) return null;
  const open = line.lastIndexOf('{');
  if (open === -1) return null;
  const digits = line.slice(open + 1, line.length - 1).replace('+', '');
  return /^\d+$/.test(digits) ? Number(digits) : null;
}
