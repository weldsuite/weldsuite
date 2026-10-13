/**
 * Public types of @weldsuite/imap. The WeldReach warmup worker codes against
 * these; change them only together with their callers.
 */

export interface ImapConfig {
  host: string;
  /** 993 (implicit TLS). Plain 143 / STARTTLS is not supported. */
  port: number;
  username: string;
  password: string;
  /** Per-command timeout, default 20 s. */
  commandTimeoutMs?: number;
}

/** RFC 6154 SPECIAL-USE attributes the warmup engine cares about. */
export type ImapSpecialUse = '\\Junk' | '\\Trash' | '\\Sent' | '\\Drafts' | '\\Archive' | '\\All';

export interface ImapMailboxInfo {
  /** Full mailbox name as the server reports it (decoded from modified UTF-7). */
  name: string;
  delimiter: string | null;
  /** Attributes from LIST, e.g. `\HasNoChildren`, `\Junk`. */
  attributes: string[];
  specialUse: ImapSpecialUse | null;
}

export interface ImapSelectResult {
  exists: number;
  uidValidity: number | null;
}

export type ImapErrorKind =
  /** TCP/TLS connect failed or the connection dropped. */
  | 'connect'
  /** LOGIN rejected: credentials or account need attention. */
  | 'auth'
  /** The server answered NO/BAD to a command. */
  | 'command'
  /** The server's reply could not be parsed. */
  | 'protocol'
  /** No reply within commandTimeoutMs. */
  | 'timeout';

export class ImapError extends Error {
  readonly kind: ImapErrorKind;
  /** The command that failed, e.g. "UID MOVE". */
  readonly command: string | null;
  /** Server text of a NO/BAD reply. */
  readonly response: string | null;

  constructor(kind: ImapErrorKind, message: string, options: { command?: string; response?: string } = {}) {
    super(message);
    this.name = 'ImapError';
    this.kind = kind;
    this.command = options.command ?? null;
    this.response = options.response ?? null;
  }

  /** Login failures need a person (new password, unlocked account); retrying won't help. */
  get authFailed(): boolean {
    return this.kind === 'auth';
  }
}

/** An authenticated IMAP connection. Always `logout()` it (also on error) to free the socket. */
export interface ImapSession {
  /** CAPABILITY after login, upper-cased (e.g. "MOVE", "UIDPLUS", "SPECIAL-USE"). */
  readonly capabilities: ReadonlySet<string>;
  /** LIST "" "*" (with RETURN (SPECIAL-USE) when supported). */
  listMailboxes(): Promise<ImapMailboxInfo[]>;
  /**
   * The mailbox carrying a SPECIAL-USE attribute; falls back to well-known
   * names (Junk: "Junk", "Spam", "[Gmail]/Spam", "Junk E-mail", "Bulk Mail").
   * null when there is none.
   */
  findSpecialUse(use: ImapSpecialUse): Promise<string | null>;
  select(mailbox: string): Promise<ImapSelectResult>;
  /** UIDs in the selected mailbox whose Message-ID header matches (angle brackets optional). */
  searchByMessageId(messageId: string): Promise<number[]>;
  /** UID STORE +FLAGS (e.g. `\Seen`, `\Flagged`). */
  addFlags(uids: number[], flags: string[]): Promise<void>;
  /** UID MOVE when supported, else UID COPY + `\Deleted` + (UID) EXPUNGE. */
  move(uids: number[], destination: string): Promise<void>;
  /** Mark `\Deleted` and expunge only these UIDs (UID EXPUNGE when UIDPLUS, else EXPUNGE). */
  deleteMessages(uids: number[]): Promise<void>;
  /** LOGOUT and close the socket. Never throws. */
  logout(): Promise<void>;
}

/** A duplex byte stream, shaped like the `Socket` from `cloudflare:sockets`. */
export interface ImapSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  closed: Promise<void>;
  close(): Promise<void>;
}

export type ImapSocketFactory = (
  address: { hostname: string; port: number },
  options: { secureTransport: 'on'; allowHalfOpen: boolean },
) => ImapSocket;

export interface ConnectImapOptions {
  /** Defaults to `connect` from `cloudflare:sockets`. Tests inject a scripted server. */
  connect?: ImapSocketFactory;
}
