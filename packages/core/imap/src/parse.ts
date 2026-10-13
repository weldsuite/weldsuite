/**
 * Reads the responses the reader hands over: tells untagged data, tagged
 * completions and continuation requests apart, splits status text and response
 * codes, and tokenizes the data responses the client acts on (LIST, SEARCH,
 * CAPABILITY).
 */
import type { RawResponse } from './reader';
import { ImapError } from './types';

export type ResponseKind = 'untagged' | 'tagged' | 'continuation';

export interface Response {
  kind: ResponseKind;
  /** The tag of a tagged completion. */
  tag: string | null;
  /**
   * Upper-case first word after the prefix: the status (OK, NO, BAD, BYE,
   * PREAUTH) of a status response, else the data keyword (LIST, SEARCH,
   * EXISTS, ...). Empty for a continuation request.
   */
  word: string;
  /** The message count of `* 172 EXISTS`. */
  number: number | null;
  /** The rest of the first line after `word`; for status responses it may start with a `[CODE ...]`. */
  rest: string;
  /** Where `rest` starts in `raw.lines[0]`, for tokenizing a data response. */
  restOffset: number;
  raw: RawResponse;
}

/** Classifies a raw response. Throws ImapError('protocol') for a line that is not IMAP. */
export function classify(raw: RawResponse): Response {
  const first = raw.lines[0] ?? '';
  if (first.startsWith('+')) {
    const rest = first.slice(1).trimStart();
    return { kind: 'continuation', tag: null, word: '', number: null, rest, restOffset: first.length - rest.length, raw };
  }
  if (first.startsWith('* ')) return classifyUntagged(raw, first);
  return classifyTagged(raw, first);
}

function classifyUntagged(raw: RawResponse, first: string): Response {
  let { word, next } = readWord(first, 2);
  let number: number | null = null;
  if (isDigits(word)) {
    number = Number(word);
    ({ word, next } = readWord(first, next));
  }
  return { kind: 'untagged', tag: null, word: word.toUpperCase(), number, rest: first.slice(next), restOffset: next, raw };
}

function classifyTagged(raw: RawResponse, first: string): Response {
  const { word: tag, next } = readWord(first, 0);
  const { word: status, next: restOffset } = readWord(first, next);
  const upper = status.toUpperCase();
  if (tag === '' || (upper !== 'OK' && upper !== 'NO' && upper !== 'BAD')) {
    throw new ImapError('protocol', `Unrecognized server response: ${JSON.stringify(first.slice(0, 80))}`);
  }
  return { kind: 'tagged', tag, word: upper, number: null, rest: first.slice(restOffset), restOffset, raw };
}

/** The word starting at `from` and the offset after the single space that ends it. */
function readWord(line: string, from: number): { word: string; next: number } {
  const space = line.indexOf(' ', from);
  if (space === -1) return { word: line.slice(from), next: line.length };
  return { word: line.slice(from, space), next: space + 1 };
}

function isDigits(value: string): boolean {
  if (value === '') return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x30 || code > 0x39) return false;
  }
  return true;
}

export interface StatusText {
  /** Upper-case response code, e.g. "CAPABILITY", "UIDVALIDITY", "AUTHENTICATIONFAILED". */
  code: string | null;
  /** Everything inside the brackets after the code word. */
  codeData: string;
  text: string;
}

/** Splits `[CODE data] human text`. */
export function parseStatusText(rest: string): StatusText {
  const close = rest.startsWith('[') ? rest.indexOf(']') : -1;
  if (close === -1) return { code: null, codeData: '', text: rest };

  const inner = rest.slice(1, close);
  const { word, next } = readWord(inner, 0);
  return { code: word.toUpperCase(), codeData: inner.slice(next), text: rest.slice(close + 1).trimStart() };
}

/** Upper-case capability atoms from `IMAP4rev1 MOVE UIDPLUS ...`. */
export function parseCapabilities(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((atom) => atom !== '')
    .map((atom) => atom.toUpperCase());
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export type Token =
  | { kind: 'atom'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'list'; items: Token[] };

/**
 * Tokenizes a data response from `restOffset` of its first line: atoms,
 * quoted strings, literals (as strings) and parenthesized lists, nested.
 */
export function tokenize(response: Response): Token[] {
  const { raw } = response;
  const root: Token[] = [];
  const stack: Token[][] = [root];

  raw.lines.forEach((line, index) => {
    scanLine(line, index === 0 ? response.restOffset : 0, stack);
    const literal = raw.literals[index];
    if (literal !== undefined) current(stack).push({ kind: 'string', value: literal });
  });

  if (stack.length !== 1) throw new ImapError('protocol', 'Unbalanced parentheses in a server response');
  return root;
}

function current(stack: Token[][]): Token[] {
  return stack[stack.length - 1];
}

function scanLine(line: string, from: number, stack: Token[][]): void {
  let i = from;
  while (i < line.length) {
    const char = line[i];
    if (char === ' ') {
      i += 1;
    } else if (char === '(') {
      const items: Token[] = [];
      current(stack).push({ kind: 'list', items });
      stack.push(items);
      i += 1;
    } else if (char === ')') {
      if (stack.length === 1) throw new ImapError('protocol', 'Unbalanced parentheses in a server response');
      stack.pop();
      i += 1;
    } else if (char === '"') {
      const quoted = readQuoted(line, i + 1);
      current(stack).push({ kind: 'string', value: quoted.value });
      i = quoted.next;
    } else {
      const end = atomEnd(line, i);
      current(stack).push({ kind: 'atom', value: line.slice(i, end) });
      i = end;
    }
  }
}

function atomEnd(line: string, from: number): number {
  let end = from;
  while (end < line.length && line[end] !== ' ' && line[end] !== '(' && line[end] !== ')') end += 1;
  return end;
}

/** The quoted string whose opening quote is just before `from`, backslash escapes resolved. */
function readQuoted(line: string, from: number): { value: string; next: number } {
  let value = '';
  let i = from;
  while (i < line.length) {
    const char = line[i];
    if (char === '"') return { value, next: i + 1 };
    if (char === '\\' && i + 1 < line.length) i += 1;
    value += line[i];
    i += 1;
  }
  throw new ImapError('protocol', 'Unterminated quoted string in a server response');
}

// ---------------------------------------------------------------------------
// Data responses
// ---------------------------------------------------------------------------

export interface ListEntry {
  attributes: string[];
  delimiter: string | null;
  /** The mailbox name as sent (modified UTF-7). */
  name: string;
}

/** `* LIST (\HasNoChildren \Junk) "/" "Junk"` */
export function parseListEntry(response: Response): ListEntry {
  const [attributes, delimiter, name] = tokenize(response);
  if (attributes?.kind !== 'list' || delimiter === undefined || name === undefined) throw malformed('LIST');

  const names = attributes.items.map((item) => (item.kind === 'list' ? '' : item.value));
  return { attributes: names.filter((attribute) => attribute !== ''), delimiter: delimiterOf(delimiter), name: nameOf(name) };
}

function delimiterOf(token: Token): string | null {
  if (token.kind === 'string') return token.value;
  if (token.kind === 'atom' && token.value.toUpperCase() === 'NIL') return null;
  throw malformed('LIST');
}

function nameOf(token: Token): string {
  if (token.kind === 'list') throw malformed('LIST');
  return token.value;
}

/** `* SEARCH 4 8 15` */
export function parseSearchNumbers(response: Response): number[] {
  const numbers: number[] = [];
  for (const atom of response.rest.split(' ')) {
    if (atom === '') continue;
    if (!isDigits(atom)) throw malformed('SEARCH');
    numbers.push(Number(atom));
  }
  return numbers;
}

function malformed(what: string): ImapError {
  return new ImapError('protocol', `Malformed ${what} response from the server`);
}
