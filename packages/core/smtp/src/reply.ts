/**
 * SMTP reply parsing (RFC 5321 section 4.2).
 *
 * A reply is one or more lines `250-text` ... `250 text`; the line with a space
 * (or nothing) after the code is the last. TCP delivers these in arbitrary
 * pieces, so the parser buffers text and hands out a reply only once it is
 * complete. Several replies may arrive in one chunk; the surplus stays buffered.
 */

export interface SmtpReply {
  code: number;
  /** RFC 3463 status from the first line, e.g. "5.1.1", when it matches the reply class. */
  enhancedCode?: string;
  /** Text of each line without the code prefix. */
  lines: string[];
  /** Code plus all line texts joined by spaces, e.g. "250 2.0.0 OK 1700000000 abc - gsmtp". */
  text: string;
}

export class ReplyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplyFormatError';
  }
}

/** A server that never ends a line must not be able to grow our buffer without bound. */
const MAX_BUFFER_CHARS = 64 * 1024;
const MAX_TEXT_CHARS = 1000;

const LINE_PATTERN = /^(\d{3})(?:([ -])(.*))?$/;
const ENHANCED_PATTERN = /^([245])\.(\d{1,3})\.(\d{1,3})(?=\s|$)/;
const ENHANCED_PREFIX_PATTERN = /^[245]\.\d{1,3}\.\d{1,3}\s+/;

export class ReplyParser {
  private buffer = '';

  push(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_BUFFER_CHARS) {
      throw new ReplyFormatError('SMTP reply exceeds the maximum accepted size');
    }
  }

  /** Characters received but not yet consumed by a complete reply. */
  get pendingLength(): number {
    return this.buffer.length;
  }

  /** The next complete reply, or null when more input is needed. */
  take(): SmtpReply | null {
    let position = 0;
    const lines: string[] = [];
    let code = 0;

    for (;;) {
      const newline = this.buffer.indexOf('\n', position);
      if (newline === -1) return null;
      const rawLine = this.buffer.slice(position, newline).replace(/\r$/, '');
      position = newline + 1;

      const match = LINE_PATTERN.exec(rawLine);
      if (!match) {
        throw new ReplyFormatError(`Malformed SMTP reply line: ${JSON.stringify(rawLine.slice(0, 80))}`);
      }
      code = Number(match[1]);
      lines.push(match[3] ?? '');

      if (match[2] !== '-') {
        this.buffer = this.buffer.slice(position);
        return buildReply(code, lines);
      }
    }
  }
}

function buildReply(code: number, lines: string[]): SmtpReply {
  const enhanced = ENHANCED_PATTERN.exec(lines[0] ?? '');
  const enhancedCode = enhanced && enhanced[1] === String(code)[0] ? `${enhanced[1]}.${enhanced[2]}.${enhanced[3]}` : undefined;

  const message = lines
    .map((line, index) => (index === 0 ? line : line.replace(ENHANCED_PREFIX_PATTERN, '')))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  let text = message ? `${code} ${message}` : String(code);
  if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}...`;

  return { code, ...(enhancedCode ? { enhancedCode } : {}), lines, text };
}
