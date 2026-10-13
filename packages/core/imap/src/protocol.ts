/**
 * Building blocks for the commands the client sends: string quoting, literals,
 * UID sets, flags, mailbox arguments. Pure functions, no I/O.
 */
import { ImapError } from './types';
import { encodeMailboxName } from './utf7';

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * An argument that has to travel as a literal (`{n}` CRLF, wait for the
 * server's `+`, then the bytes) because it cannot be written as a quoted string.
 */
export class Literal {
  constructor(readonly value: string) {}
}

/** One argument of a command: raw text (already syntactically valid) or a literal. */
export type CommandPart = string | Literal;

/** Printable ASCII (0x20-0x7e): the only characters a quoted string carries here. */
export function isPrintableAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/** `"..."` with `\` and `"` escaped. The caller guarantees printable ASCII. */
export function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** A free-form string argument: quoted when it can be, a literal when it contains CR/LF/control/8-bit characters. */
export function stringPart(value: string): CommandPart {
  return isPrintableAscii(value) ? quote(value) : new Literal(value);
}

/** A mailbox argument: modified UTF-7, which is always printable ASCII, so always a quoted string. */
export function mailboxPart(name: string): string {
  return quote(encodeMailboxName(name));
}

const MAX_UID = 4_294_967_295;

/**
 * `1:3,7`: sorted, de-duplicated UIDs with consecutive runs collapsed into
 * ranges. Throws on anything that is not a valid UID.
 */
export function compressUids(uids: readonly number[]): string {
  for (const uid of uids) {
    if (!Number.isInteger(uid) || uid < 1 || uid > MAX_UID) {
      throw new ImapError('command', `Invalid UID: ${String(uid)}`);
    }
  }
  const sorted = [...new Set(uids)].sort((a, b) => a - b);

  const ranges: string[] = [];
  let start = 0;
  while (start < sorted.length) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end += 1;
    ranges.push(end > start ? `${sorted[start]}:${sorted[end]}` : String(sorted[start]));
    start = end + 1;
  }
  return ranges.join(',');
}

const FLAG = /^\\?[A-Za-z0-9$_.-]+$/;

/** `(\Seen \Flagged)`; throws on a flag that is not a plain system flag or keyword. */
export function flagList(flags: readonly string[]): string {
  for (const flag of flags) {
    if (!FLAG.test(flag)) throw new ImapError('command', `Invalid flag: ${JSON.stringify(flag.slice(0, 40))}`);
  }
  return `(${flags.join(' ')})`;
}
