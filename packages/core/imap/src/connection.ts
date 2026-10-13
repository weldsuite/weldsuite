/**
 * One IMAP connection: tagged commands, literals in both directions, a
 * deadline per command, and the mapping of I/O trouble to ImapError kinds.
 *
 * Commands run one at a time (calls are queued), because a response can only
 * be matched to its command by order. After a timeout, a dropped connection or
 * a protocol violation the connection is `broken`: nothing more is sent to it.
 */
import { classify, parseStatusText, type Response } from './parse';
import { utf8, type CommandPart } from './protocol';
import { ResponseBuffer } from './reader';
import { ImapError, type ImapErrorKind, type ImapSocket } from './types';

/** Bounded waits for the courtesy LOGOUT and for closing the socket, so cleanup cannot hang. */
const LOGOUT_TIMEOUT_MS = 3_000;
const CLOSE_TIMEOUT_MS = 2_000;

export interface CommandResult {
  status: 'OK' | 'NO' | 'BAD';
  /** `[CODE ...]` of the tagged completion, upper-case code word. */
  code: string | null;
  codeData: string;
  /** Human text after the code. */
  text: string;
  /** Everything after the status word, code included; what an ImapError reports as `response`. */
  rest: string;
  /** The untagged responses received while the command ran, in order. */
  untagged: Response[];
}

class TimeoutSignal extends Error {
  constructor() {
    super('timed out');
    this.name = 'TimeoutSignal';
  }
}

export class ImapConnection {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly buffer = new ResponseBuffer();
  private tagCounter = 0;
  /** Timed out, dropped or out of sync: nothing more can be said to this connection. */
  private broken = false;
  private closed = false;
  /** The verb of the command in flight, for error context. */
  private verb: string | null = null;
  /** Text of the last untagged BYE, to explain a connection that closes right after. */
  private byeText: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly socket: ImapSocket,
    private readonly timeoutMs: number,
  ) {
    // A failing connection also rejects `closed` / `opened`; the stream errors are what we act on,
    // so keep those promises from surfacing as unhandled rejections.
    socket.closed.catch(ignore);
    const opened: unknown = Reflect.get(socket, 'opened');
    if (opened instanceof Promise) opened.catch(ignore);
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  // -- Public ---------------------------------------------------------------

  /** Reads the server greeting. Resolves with 'OK' or 'PREAUTH'; BYE and anything else throw. */
  async readGreeting(): Promise<'OK' | 'PREAUTH'> {
    this.verb = null;
    const response = await this.nextResponse(Date.now() + this.timeoutMs);
    if (response.kind !== 'untagged') throw this.protocolError('The server did not send an IMAP greeting');
    if (response.word === 'OK' || response.word === 'PREAUTH') return response.word;
    if (response.word === 'BYE') {
      throw this.fail('connect', `The server refused the connection: ${parseStatusText(response.rest).text}`);
    }
    throw this.protocolError(`Unexpected IMAP greeting: ${response.word}`);
  }

  /** Runs `VERB args...` and resolves with the tagged completion, whether OK, NO or BAD. Calls are serialised. */
  execute(verb: string, args: CommandPart[] = [], timeoutMs: number = this.timeoutMs): Promise<CommandResult> {
    const run = this.tail.then(() => this.runCommand(verb, args, timeoutMs));
    this.tail = run.catch(ignore);
    return run;
  }

  /** LOGOUT and close the socket. Never throws. */
  async logout(): Promise<void> {
    try {
      await this.execute('LOGOUT', [], Math.min(this.timeoutMs, LOGOUT_TIMEOUT_MS));
    } catch {
      // The server may drop the connection right after BYE, or the connection was already gone.
    }
    await this.close();
  }

  /** Close the socket without a LOGOUT. Never throws. */
  async close(): Promise<void> {
    this.closed = true;
    this.broken = true;
    try {
      await raceTimeout(Promise.resolve(this.socket.close()), CLOSE_TIMEOUT_MS);
    } catch {
      // Already closed or unresponsive; nothing left to do.
    }
  }

  // -- Commands -------------------------------------------------------------

  private async runCommand(verb: string, args: CommandPart[], timeoutMs: number): Promise<CommandResult> {
    this.verb = verb;
    if (this.broken || this.closed) throw this.fail('connect', 'The IMAP connection is no longer usable');

    this.tagCounter += 1;
    const tag = `A${String(this.tagCounter).padStart(3, '0')}`;
    const deadline = Date.now() + timeoutMs;
    const untagged: Response[] = [];

    const rejected = await this.send(tag, [verb, ...args], deadline, untagged);
    if (rejected) return rejected;
    return this.awaitCompletion(tag, deadline, untagged);
  }

  /**
   * Writes the command, pausing at each literal for the server's `+`. Resolves
   * with the completion when the server refuses a literal (or the command) before
   * the command is fully sent, otherwise null.
   */
  private async send(tag: string, parts: CommandPart[], deadline: number, untagged: Response[]): Promise<CommandResult | null> {
    let pending = tag;
    for (const part of parts) {
      if (typeof part === 'string') {
        pending += ` ${part}`;
        continue;
      }
      const bytes = utf8(part.value);
      await this.write(utf8(`${pending} {${bytes.length}}\r\n`), deadline);
      const rejected = await this.awaitContinuation(tag, deadline, untagged);
      if (rejected) return rejected;
      await this.write(bytes, deadline);
      pending = '';
    }
    await this.write(utf8(`${pending}\r\n`), deadline);
    return null;
  }

  private async awaitContinuation(tag: string, deadline: number, untagged: Response[]): Promise<CommandResult | null> {
    for (;;) {
      const response = await this.nextResponse(deadline);
      if (response.kind === 'continuation') return null;
      if (response.kind === 'tagged') return this.completion(response, tag, untagged);
      untagged.push(response);
    }
  }

  private async awaitCompletion(tag: string, deadline: number, untagged: Response[]): Promise<CommandResult> {
    for (;;) {
      const response = await this.nextResponse(deadline);
      if (response.kind === 'tagged') return this.completion(response, tag, untagged);
      if (response.kind === 'continuation') throw this.protocolError('The server asked for more data than the command carries');
      untagged.push(response);
    }
  }

  private completion(response: Response, tag: string, untagged: Response[]): CommandResult {
    if (response.tag !== tag) throw this.protocolError(`The server answered for an unknown command tag: ${response.tag ?? ''}`);
    const status = response.word;
    if (status !== 'OK' && status !== 'NO' && status !== 'BAD') throw this.protocolError(`Unexpected completion status: ${status}`);
    const { code, codeData, text } = parseStatusText(response.rest);
    return { status, code, codeData, text, rest: response.rest, untagged };
  }

  // -- I/O ------------------------------------------------------------------

  private async write(data: Uint8Array, deadline: number): Promise<void> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw this.timeoutError('the command to be sent');
    try {
      await raceTimeout(this.writer.write(data), remaining);
    } catch (error) {
      throw error instanceof TimeoutSignal ? this.timeoutError('the command to be sent') : this.ioError(error, 'sending the command');
    }
  }

  private async nextResponse(deadline: number): Promise<Response> {
    for (;;) {
      const response = this.takeResponse();
      if (response) {
        if (response.kind === 'untagged' && response.word === 'BYE') this.byeText = parseStatusText(response.rest).text;
        return response;
      }
      await this.fill(deadline);
    }
  }

  private takeResponse(): Response | null {
    try {
      const raw = this.buffer.take();
      return raw === null ? null : classify(raw);
    } catch (error) {
      this.broken = true;
      throw error;
    }
  }

  private async fill(deadline: number): Promise<void> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw this.timeoutError('the server reply');

    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await raceTimeout(this.reader.read(), remaining);
    } catch (error) {
      throw error instanceof TimeoutSignal ? this.timeoutError('the server reply') : this.ioError(error, 'waiting for the server reply');
    }
    if (chunk.done) throw this.ioError(new Error('connection closed by the server'), 'waiting for the server reply');
    this.buffer.push(chunk.value);
  }

  // -- Errors ---------------------------------------------------------------

  private fail(kind: ImapErrorKind, message: string): ImapError {
    return new ImapError(kind, message, this.verb === null ? {} : { command: this.verb });
  }

  private timeoutError(waitingFor: string): ImapError {
    this.broken = true;
    return this.fail('timeout', `Timed out after ${this.timeoutMs} ms waiting for ${waitingFor}`);
  }

  private ioError(error: unknown, action: string): ImapError {
    this.broken = true;
    const reason = describeError(error);
    const bye = this.byeText === null ? '' : ` (server said: ${this.byeText})`;
    return this.fail('connect', `Connection error while ${action}: ${reason}${bye}`);
  }

  /** The peer is not speaking IMAP (wrong port, hostile server): retrying will not help. */
  private protocolError(message: string): ImapError {
    this.broken = true;
    return this.fail('protocol', message);
  }
}

function ignore(): void {
  // Deliberately empty: used to mark a promise rejection as handled.
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/** Rejects with TimeoutSignal after `ms`; always clears its timer. */
function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutSignal()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
