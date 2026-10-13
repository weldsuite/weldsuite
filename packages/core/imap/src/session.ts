/**
 * The authenticated session: the mailbox commands the warmup engine needs.
 * Built by `connectImap` once LOGIN and CAPABILITY are done.
 */
import type { CommandResult, ImapConnection } from './connection';
import { parseListEntry, parseSearchNumbers, parseStatusText, type Response } from './parse';
import { compressUids, flagList, isPrintableAscii, Literal, mailboxPart, quote, type CommandPart } from './protocol';
import { ImapError, type ImapMailboxInfo, type ImapSelectResult, type ImapSession, type ImapSpecialUse } from './types';
import { decodeMailboxName } from './utf7';

const SPECIAL_USES: readonly ImapSpecialUse[] = ['\\Junk', '\\Trash', '\\Sent', '\\Drafts', '\\Archive', '\\All'];

/** Well-known folder names, in order of preference, for servers that do not label them with SPECIAL-USE. */
const FALLBACK_NAMES: Record<ImapSpecialUse, readonly string[]> = {
  '\\Junk': ['junk', 'spam', '[gmail]/spam', 'junk e-mail', 'junk email', 'bulk mail'],
  '\\Trash': ['trash', 'deleted items', 'deleted messages', 'deleted', '[gmail]/trash', 'bin', '[gmail]/bin'],
  '\\Sent': ['sent', 'sent items', 'sent messages', 'sent mail', '[gmail]/sent mail'],
  '\\Drafts': ['drafts', 'draft', '[gmail]/drafts'],
  '\\Archive': ['archive', 'archives'],
  '\\All': ['all mail', '[gmail]/all mail'],
};

export class ImapClientSession implements ImapSession {
  private mailboxCache: ImapMailboxInfo[] | null = null;

  constructor(
    private readonly connection: ImapConnection,
    readonly capabilities: ReadonlySet<string>,
  ) {}

  async listMailboxes(): Promise<ImapMailboxInfo[]> {
    const result = await this.list();
    const mailboxes = result.untagged.filter((response) => response.word === 'LIST').map(toMailboxInfo);
    this.mailboxCache = mailboxes.filter((mailbox) => mailbox.name !== '');
    return [...this.mailboxCache];
  }

  async findSpecialUse(use: ImapSpecialUse): Promise<string | null> {
    const mailboxes = this.mailboxCache ?? (await this.listMailboxes());
    const selectable = mailboxes.filter(isSelectable);
    const labelled = selectable.find((mailbox) => mailbox.specialUse === use);
    if (labelled) return labelled.name;
    return findByName(selectable, FALLBACK_NAMES[use])?.name ?? null;
  }

  async select(mailbox: string): Promise<ImapSelectResult> {
    const result = await this.ok('SELECT', [mailboxPart(mailbox)]);
    let exists: number | null = null;
    let uidValidity: number | null = null;
    for (const response of result.untagged) {
      if (response.word === 'EXISTS' && response.number !== null) {
        exists = response.number;
      } else if (response.word === 'OK') {
        const status = parseStatusText(response.rest);
        if (status.code === 'UIDVALIDITY') uidValidity = toNumber(status.codeData);
      }
    }
    if (exists === null) throw new ImapError('protocol', 'The SELECT reply did not report the message count', { command: 'SELECT' });
    return { exists, uidValidity };
  }

  async searchByMessageId(messageId: string): Promise<number[]> {
    const value = bracketed(messageId);
    // A Message-ID is ASCII; anything else needs an explicit charset and a literal.
    const args: CommandPart[] = isPrintableAscii(value)
      ? ['HEADER', 'Message-ID', quote(value)]
      : ['CHARSET', 'UTF-8', 'HEADER', 'Message-ID', new Literal(value)];

    const result = await this.ok('UID SEARCH', args);
    const found = result.untagged.filter((response) => response.word === 'SEARCH').flatMap(parseSearchNumbers);
    return [...new Set(found)].sort((a, b) => a - b);
  }

  async addFlags(uids: number[], flags: string[]): Promise<void> {
    if (uids.length === 0 || flags.length === 0) return;
    await this.ok('UID STORE', [compressUids(uids), '+FLAGS.SILENT', flagList(flags)]);
  }

  async move(uids: number[], destination: string): Promise<void> {
    if (uids.length === 0) return;
    const set = compressUids(uids);
    const target = mailboxPart(destination);

    if (this.capabilities.has('MOVE')) {
      await this.ok('UID MOVE', [set, target]);
      return;
    }
    await this.ok('UID COPY', [set, target]);
    await this.deleteAndExpunge(set);
  }

  async deleteMessages(uids: number[]): Promise<void> {
    if (uids.length === 0) return;
    await this.deleteAndExpunge(compressUids(uids));
  }

  async logout(): Promise<void> {
    await this.connection.logout();
  }

  // -- Helpers --------------------------------------------------------------

  /**
   * Marks the UIDs `\Deleted` and expunges them. UID EXPUNGE touches only those
   * messages; without UIDPLUS a plain EXPUNGE also removes any other message
   * already flagged `\Deleted` in the selected mailbox.
   */
  private async deleteAndExpunge(set: string): Promise<void> {
    await this.ok('UID STORE', [set, '+FLAGS.SILENT', '(\\Deleted)']);
    if (this.capabilities.has('UIDPLUS')) {
      await this.ok('UID EXPUNGE', [set]);
    } else {
      await this.ok('EXPUNGE');
    }
  }

  /** LIST with the SPECIAL-USE return option when advertised; plain LIST when the server refuses it. */
  private async list(): Promise<CommandResult> {
    const base: CommandPart[] = ['""', '"*"'];
    if (this.capabilities.has('SPECIAL-USE')) {
      const extended = await this.connection.execute('LIST', [...base, 'RETURN', '(SPECIAL-USE)']);
      if (extended.status === 'OK') return extended;
    }
    return this.ok('LIST', base);
  }

  private async ok(verb: string, args: CommandPart[] = []): Promise<CommandResult> {
    const result = await this.connection.execute(verb, args);
    if (result.status !== 'OK') {
      throw new ImapError('command', `${verb} failed: ${result.status} ${result.rest}`.trim(), { command: verb, response: result.rest });
    }
    return result;
  }
}

function toMailboxInfo(response: Response): ImapMailboxInfo {
  const entry = parseListEntry(response);
  return {
    name: decodeMailboxName(entry.name),
    delimiter: entry.delimiter,
    attributes: entry.attributes,
    specialUse: specialUseOf(entry.attributes),
  };
}

function specialUseOf(attributes: readonly string[]): ImapSpecialUse | null {
  for (const attribute of attributes) {
    const lower = attribute.toLowerCase();
    const match = SPECIAL_USES.find((use) => use.toLowerCase() === lower);
    if (match) return match;
  }
  return null;
}

function isSelectable(mailbox: ImapMailboxInfo): boolean {
  return !mailbox.attributes.some((attribute) => {
    const lower = attribute.toLowerCase();
    return lower === '\\noselect' || lower === '\\nonexistent';
  });
}

/** The first candidate, in order, that names a mailbox: by whole name first, then by last path segment. */
function findByName(mailboxes: readonly ImapMailboxInfo[], candidates: readonly string[]): ImapMailboxInfo | undefined {
  for (const candidate of candidates) {
    const exact = mailboxes.find((mailbox) => mailbox.name.toLowerCase() === candidate);
    if (exact) return exact;
  }
  for (const candidate of candidates) {
    const nested = mailboxes.find((mailbox) => lastSegment(mailbox).toLowerCase() === candidate);
    if (nested) return nested;
  }
  return undefined;
}

function lastSegment(mailbox: ImapMailboxInfo): string {
  const delimiter = mailbox.delimiter;
  if (delimiter === null || delimiter === '') return mailbox.name;
  return mailbox.name.slice(mailbox.name.lastIndexOf(delimiter) + 1);
}

/** `<id@host>`: the angle brackets are added when missing. Throws on an empty id. */
function bracketed(messageId: string): string {
  let inner = messageId.trim();
  if (inner.startsWith('<')) inner = inner.slice(1);
  if (inner.endsWith('>')) inner = inner.slice(0, -1);
  if (inner === '' || inner.includes('\r') || inner.includes('\n') || inner.includes('\0')) {
    throw new ImapError('command', 'Invalid Message-ID', { command: 'UID SEARCH' });
  }
  return `<${inner}>`;
}

function toNumber(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() !== '' && Number.isInteger(value) ? value : null;
}
