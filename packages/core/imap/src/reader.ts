/**
 * Splits the byte stream from the server into complete responses.
 *
 * A response is one CRLF-terminated line. A data response can carry literals:
 * a line ending in `{n}` is followed by exactly n raw bytes and then by the rest
 * of the same response line (RFC 3501 section 4.3). Literals are counted in
 * bytes, so the buffer stays binary until a line or a literal is complete.
 */
import { ImapError } from './types';

/**
 * One response as received. `lines[i]` is the text before the i-th literal (its
 * trailing `{n}` marker removed); the last line is the text after the final
 * literal, so `lines.length === literals.length + 1`.
 */
export interface RawResponse {
  lines: string[];
  literals: string[];
}

/** Bounds, so a hostile or broken server cannot make the client buffer without limit. */
export const MAX_LITERAL_BYTES = 1_048_576;
export const MAX_LINE_BYTES = 1_048_576;

const STATUS_WORDS = new Set(['OK', 'NO', 'BAD', 'BYE', 'PREAUTH']);

export class ResponseBuffer {
  private buffer: Uint8Array = new Uint8Array(0);
  private readonly decoder = new TextDecoder();

  /** Bytes received but not yet returned as part of a response. */
  get pendingLength(): number {
    return this.buffer.length;
  }

  push(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
  }

  /** The next complete response, or null while more bytes are needed. Throws ImapError('protocol') on oversize input. */
  take(): RawResponse | null {
    const parsed = this.parse();
    if (parsed === null) return null;
    this.buffer = this.buffer.slice(parsed.consumed);
    return parsed.response;
  }

  /**
   * Parses from the start of the buffer without consuming anything, so a
   * response that is still incomplete (a literal cut mid-way) is simply parsed
   * again when more bytes arrive.
   */
  private parse(): { response: RawResponse; consumed: number } | null {
    const lines: string[] = [];
    const literals: string[] = [];
    let pos = 0;
    let carriesLiterals = false;

    for (;;) {
      const eol = this.findCrlf(pos);
      if (eol === -1) return this.needMoreBytes(pos);
      const line = this.decoder.decode(this.buffer.subarray(pos, eol));
      pos = eol + 2;
      if (lines.length === 0) carriesLiterals = mayCarryLiterals(line);

      const size = carriesLiterals ? literalSize(line) : null;
      if (size === null) {
        lines.push(line);
        return { response: { lines, literals }, consumed: pos };
      }
      checkLiteralSize(size);
      if (this.buffer.length < pos + size) return null;

      lines.push(line.slice(0, line.lastIndexOf('{')));
      literals.push(this.decoder.decode(this.buffer.subarray(pos, pos + size)));
      pos += size;
    }
  }

  /** Nothing complete yet; fails only when the unfinished line is already longer than any line may be. */
  private needMoreBytes(lineStart: number): null {
    if (this.buffer.length - lineStart > MAX_LINE_BYTES) {
      throw new ImapError('protocol', 'The server sent a response line that is too long');
    }
    return null;
  }

  private findCrlf(from: number): number {
    const last = this.buffer.length - 1;
    for (let i = from; i < last; i++) {
      if (this.buffer[i] === 0x0d && this.buffer[i + 1] === 0x0a) return i;
    }
    return -1;
  }
}

function checkLiteralSize(size: number): void {
  if (size > MAX_LITERAL_BYTES) {
    throw new ImapError('protocol', `The server sent a literal of ${size} bytes, over the ${MAX_LITERAL_BYTES} byte limit`);
  }
}

/**
 * Only data responses (`* LIST ...`, `* 1 FETCH ...`) carry literals. Status
 * lines, tagged completions and continuation requests are plain text, even if
 * their text happens to end in something that looks like `{5}`.
 */
function mayCarryLiterals(firstLine: string): boolean {
  if (!firstLine.startsWith('* ')) return false;
  const space = firstLine.indexOf(' ', 2);
  const word = space === -1 ? firstLine.slice(2) : firstLine.slice(2, space);
  return !STATUS_WORDS.has(word.toUpperCase());
}

/** n of a trailing `{n}`, or null when the line does not end in a literal marker. */
function literalSize(line: string): number | null {
  if (!line.endsWith('}')) return null;
  const open = line.lastIndexOf('{');
  if (open === -1) return null;
  const digits = line.slice(open + 1, line.length - 1);
  if (digits === '' || digits.length > 12) return null;
  for (let i = 0; i < digits.length; i++) {
    const code = digits.charCodeAt(i);
    if (code < 0x30 || code > 0x39) return null;
  }
  return Number(digits);
}
