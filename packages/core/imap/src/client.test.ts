import { describe, expect, it, vi } from 'vitest';
import { connectImap } from './client';
import { FakeImapServer, type ScriptStep } from './testing/fake-server';
import { ImapError, type ImapConfig, type ImapSession, type ImapSocketFactory } from './types';

const USERNAME = 'user@acme.test';
const PASSWORD = 'secret';

const config: ImapConfig = {
  host: 'imap.example.test',
  port: 993,
  username: USERNAME,
  password: PASSWORD,
  commandTimeoutMs: 1000,
};
/** For the tests that wait for a timeout to fire. */
const quick: ImapConfig = { ...config, commandTimeoutMs: 50 };

const GMAIL_CAPS =
  'IMAP4rev1 UNSELECT IDLE NAMESPACE QUOTA ID XLIST CHILDREN X-GM-EXT-1 UIDPLUS COMPRESS=DEFLATE ENABLE MOVE CONDSTORE ESEARCH UTF8=ACCEPT LIST-EXTENDED LIST-STATUS LITERAL- SPECIAL-USE APPENDLIMIT=36700160';
const BASIC_CAPS = 'IMAP4rev1 LITERAL+ AUTH=PLAIN';
const UIDPLUS_CAPS = 'IMAP4rev1 UIDPLUS';

const LOGIN = `LOGIN "${USERNAME}" "${PASSWORD}"`;
const LIST_EXTENDED = 'LIST "" "*" RETURN (SPECIAL-USE)';
const LIST_PLAIN = 'LIST "" "*"';

const loginStep = (caps = GMAIL_CAPS): ScriptStep => ({
  expect: LOGIN,
  reply: `$TAG OK [CAPABILITY ${caps}] ${USERNAME} authenticated (Success)`,
});
const done = (verb: string, expect: string): ScriptStep => ({ expect, reply: `$TAG OK ${verb} completed` });

const GMAIL_LIST = [
  '* LIST (\\HasNoChildren) "/" "INBOX"',
  '* LIST (\\HasNoChildren \\Drafts) "/" "[Gmail]/Drafts"',
  '* LIST (\\HasChildren \\Noselect) "/" "[Gmail]"',
  '* LIST (\\All \\HasNoChildren) "/" "[Gmail]/All Mail"',
  '* LIST (\\HasNoChildren \\Junk) "/" "[Gmail]/Spam"',
  '* LIST (\\HasNoChildren \\Sent) "/" "[Gmail]/Sent Mail"',
  '* LIST (\\HasNoChildren \\Trash) "/" "[Gmail]/Trash"',
  '$TAG OK Success',
];

function selectStep(wireName: string, exists: number): ScriptStep {
  return {
    expect: `SELECT "${wireName}"`,
    reply: [
      '* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)',
      '* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Flags permitted.',
      '* OK [UIDVALIDITY 3857529045] UIDs valid.',
      `* ${exists} EXISTS`,
      '* 0 RECENT',
      '* OK [UIDNEXT 4392] Predicted next UID.',
      '$TAG OK [READ-WRITE] SELECT completed',
    ],
  };
}

interface Opened {
  server: FakeImapServer;
  session: ImapSession;
}

async function open(script: ScriptStep[], options: { caps?: string; chunkSize?: number; config?: ImapConfig } = {}): Promise<Opened> {
  const server = new FakeImapServer({ script: [loginStep(options.caps), ...script], chunkSize: options.chunkSize });
  const session = await connectImap(options.config ?? config, { connect: server.connect });
  return { server, session };
}

function expectClean(server: FakeImapServer): void {
  expect(server.errors).toEqual([]);
  expect(server.unconsumed).toEqual([]);
}

async function failureOf(promise: Promise<unknown>): Promise<ImapError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ImapError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

/** The commands after the login, so tests need not repeat it. */
function commandsAfterLogin(server: FakeImapServer): string[] {
  return server.commands.slice(1);
}

describe('connectImap: connecting and logging in', () => {
  it('connects over implicit TLS on 993, logs in and reads the capabilities from the login reply', async () => {
    const server = new FakeImapServer({ script: [loginStep()] });

    const session = await connectImap(config, { connect: server.connect });

    expect(server.connects).toEqual([
      { address: { hostname: 'imap.example.test', port: 993 }, options: { secureTransport: 'on', allowHalfOpen: false } },
    ]);
    expect(server.commands).toEqual([LOGIN]);
    expect(server.wire).toEqual([`A001 ${LOGIN}`]);
    expect([...session.capabilities].sort()).toContain('MOVE');
    expect(session.capabilities.has('UIDPLUS')).toBe(true);
    expect(session.capabilities.has('SPECIAL-USE')).toBe(true);
    expect(session.capabilities.has('IMAP4REV1')).toBe(true);
    expectClean(server);
  });

  it('upper-cases the capabilities', async () => {
    const { session } = await open([], { caps: 'imap4rev1 Move uidplus' });
    expect([...session.capabilities].sort()).toEqual(['IMAP4REV1', 'MOVE', 'UIDPLUS']);
  });

  it('asks for CAPABILITY when the login reply carries none', async () => {
    const server = new FakeImapServer({
      script: [
        { expect: LOGIN, reply: '$TAG OK Logged in' },
        { expect: 'CAPABILITY', reply: ['* CAPABILITY IMAP4rev1 move UIDPLUS', '$TAG OK Capability completed'] },
      ],
    });

    const session = await connectImap(config, { connect: server.connect });

    expect([...session.capabilities].sort()).toEqual(['IMAP4REV1', 'MOVE', 'UIDPLUS']);
    expect(server.wire).toEqual([`A001 ${LOGIN}`, 'A002 CAPABILITY']);
    expectClean(server);
  });

  it('takes an untagged CAPABILITY that arrives before the login completion', async () => {
    const server = new FakeImapServer({
      script: [{ expect: LOGIN, reply: ['* CAPABILITY IMAP4rev1 MOVE', '$TAG OK Logged in'] }],
    });
    const session = await connectImap(config, { connect: server.connect });
    expect(session.capabilities.has('MOVE')).toBe(true);
    expect(server.commands).toEqual([LOGIN]);
  });

  it('skips LOGIN after a PREAUTH greeting', async () => {
    const server = new FakeImapServer({
      greeting: '* PREAUTH IMAP4rev1 ready, logged in as user',
      script: [{ expect: 'CAPABILITY', reply: ['* CAPABILITY IMAP4rev1 MOVE', '$TAG OK done'] }],
    });
    const session = await connectImap(config, { connect: server.connect });
    expect(server.commands).toEqual(['CAPABILITY']);
    expect(session.capabilities.has('MOVE')).toBe(true);
  });

  it('accepts a greeting that carries a capability code', async () => {
    const server = new FakeImapServer({
      greeting: '* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] Dovecot ready.',
      script: [loginStep(UIDPLUS_CAPS)],
    });
    const session = await connectImap(config, { connect: server.connect });
    expect(session.capabilities.has('AUTH=PLAIN')).toBe(false);
    expect(session.capabilities.has('UIDPLUS')).toBe(true);
  });

  it('numbers its commands A001, A002, ...', async () => {
    const { server, session } = await open([selectStep('INBOX', 1)]);
    await session.select('INBOX');
    expect(server.wire).toEqual([`A001 ${LOGIN}`, 'A002 SELECT "INBOX"']);
  });

  it('turns a BYE greeting into a connect error and closes the socket', async () => {
    const server = new FakeImapServer({ greeting: '* BYE Too many connections from your IP', script: [] });
    const error = await failureOf(connectImap(config, { connect: server.connect }));
    expect(error).toMatchObject({ kind: 'connect' });
    expect(error.message).toContain('Too many connections from your IP');
    expect(server.closeCalls).toBe(1);
    expect(server.commands).toEqual([]);
  });

  it('reports a server that does not speak IMAP as a protocol error', async () => {
    const server = new FakeImapServer({ greeting: '220 mail.example.test ESMTP', script: [] });
    expect(await failureOf(connectImap(config, { connect: server.connect }))).toMatchObject({ kind: 'protocol' });
    expect(server.closeCalls).toBe(1);
  });

  it('times out when the server never greets', async () => {
    const server = new FakeImapServer({ greeting: null, script: [] });
    expect(await failureOf(connectImap(quick, { connect: server.connect }))).toMatchObject({ kind: 'timeout' });
    expect(server.closeCalls).toBe(1);
  });

  it.each([143, 465, 587, 994, 0])('refuses port %i without connecting', async (port) => {
    const connect = vi.fn<ImapSocketFactory>();
    const error = await failureOf(connectImap({ ...config, port }, { connect }));
    expect(error.kind).toBe('connect');
    expect(error.message).toContain('993');
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuses an empty host without connecting', async () => {
    const connect = vi.fn<ImapSocketFactory>();
    expect(await failureOf(connectImap({ ...config, host: '  ' }, { connect }))).toMatchObject({ kind: 'connect' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuses credentials with a NUL without connecting', async () => {
    const connect = vi.fn<ImapSocketFactory>();
    const error = await failureOf(connectImap({ ...config, password: 'a\0b' }, { connect }));
    expect(error).toMatchObject({ kind: 'auth', command: 'LOGIN' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('turns a throwing socket factory into a connect error', async () => {
    const connect: ImapSocketFactory = () => {
      throw new Error('connect ECONNREFUSED');
    };
    const error = await failureOf(connectImap(config, { connect }));
    expect(error).toMatchObject({ kind: 'connect' });
    expect(error.message).toContain('ECONNREFUSED');
    expect(error.message).toContain('imap.example.test:993');
  });
});

describe('connectImap: LOGIN failures and quoting', () => {
  it('maps LOGIN NO to an auth error that carries the server text and never the password', async () => {
    const server = new FakeImapServer({
      script: [{ expect: LOGIN, reply: ['$TAG NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)'] }],
    });

    const error = await failureOf(connectImap(config, { connect: server.connect }));

    expect(error).toMatchObject({ kind: 'auth', command: 'LOGIN', authFailed: true });
    expect(error.response).toBe('[AUTHENTICATIONFAILED] Invalid credentials (Failure)');
    expect(error.message).toContain('Invalid credentials');
    expect(error.message).not.toContain(PASSWORD);
    expect(server.closeCalls).toBe(1);
    expectClean(server);
  });

  it('maps LOGIN BAD to a command error', async () => {
    const server = new FakeImapServer({ script: [{ expect: LOGIN, reply: '$TAG BAD Command syntax error' }] });
    const error = await failureOf(connectImap(config, { connect: server.connect }));
    expect(error).toMatchObject({ kind: 'command', command: 'LOGIN', authFailed: false });
  });

  it('times out when the login is never answered', async () => {
    const server = new FakeImapServer({ script: [{ expect: LOGIN, reply: null }] });
    const error = await failureOf(connectImap(quick, { connect: server.connect }));
    expect(error).toMatchObject({ kind: 'timeout', command: 'LOGIN' });
    expect(error.message).toContain('50 ms');
    expect(server.closeCalls).toBe(1);
  });

  it('reports a connection that drops during login, with the BYE text', async () => {
    const server = new FakeImapServer({
      script: [{ expect: LOGIN, reply: '* BYE Too many invalid login attempts', hangUp: true }],
    });
    const error = await failureOf(connectImap(config, { connect: server.connect }));
    expect(error.kind).toBe('connect');
    expect(error.message).toContain('Too many invalid login attempts');
  });

  it('reports a connection reset during login', async () => {
    const server = new FakeImapServer({ script: [{ expect: LOGIN, reply: null, reset: true }] });
    const error = await failureOf(connectImap(config, { connect: server.connect }));
    expect(error.kind).toBe('connect');
    expect(error.message).toContain('ECONNRESET');
  });

  it('escapes quotes and backslashes in the credentials', async () => {
    const server = new FakeImapServer({
      script: [{ expect: 'LOGIN "us\\"er\\\\x@acme.test" "pa\\"ss\\\\word"', reply: `$TAG OK [CAPABILITY ${BASIC_CAPS}] ok` }],
    });
    await connectImap({ ...config, username: 'us"er\\x@acme.test', password: 'pa"ss\\word' }, { connect: server.connect });
    expect(server.wire).toEqual(['A001 LOGIN "us\\"er\\\\x@acme.test" "pa\\"ss\\\\word"']);
    expect(server.literals).toEqual([]);
    expectClean(server);
  });

  it('sends a password with non-ASCII characters as a literal, waiting for the continuation', async () => {
    const server = new FakeImapServer({
      script: [{ expect: `LOGIN "${USERNAME}" {9}\npässword`, reply: `$TAG OK [CAPABILITY ${BASIC_CAPS}] ok` }],
    });

    await connectImap({ ...config, password: 'pässword' }, { connect: server.connect });

    expect(server.wire).toEqual([`A001 LOGIN "${USERNAME}" {9}`]);
    expect(server.literals).toEqual(['pässword']);
    expectClean(server);
  });

  it('sends a password with a line break as a literal', async () => {
    const server = new FakeImapServer({
      script: [{ expect: `LOGIN "${USERNAME}" {4}\na\r\nb`, reply: `$TAG OK [CAPABILITY ${BASIC_CAPS}] ok` }],
    });
    await connectImap({ ...config, password: 'a\r\nb' }, { connect: server.connect });
    expect(server.literals).toEqual(['a\r\nb']);
    expectClean(server);
  });

  it('sends both values as literals when both need it', async () => {
    const server = new FakeImapServer({
      script: [{ expect: 'LOGIN {5}\nüser\n {4}\na\r\nb', reply: `$TAG OK [CAPABILITY ${BASIC_CAPS}] ok` }],
    });
    await connectImap({ ...config, username: 'üser', password: 'a\r\nb' }, { connect: server.connect });
    expect(server.literals).toEqual(['üser', 'a\r\nb']);
    expect(server.wire).toEqual(['A001 LOGIN {5}']);
    expectClean(server);
  });

  it('stops when the server refuses a literal instead of sending the bytes', async () => {
    const server = new FakeImapServer({
      script: [
        {
          expect: `LOGIN "${USERNAME}" {9}`,
          reply: null,
          refuseLiteral: '$TAG NO [AUTHENTICATIONFAILED] literals not accepted here',
        },
      ],
    });

    const error = await failureOf(connectImap({ ...config, password: 'pässword' }, { connect: server.connect }));

    expect(error).toMatchObject({ kind: 'auth' });
    expect(server.literals).toEqual([]);
    expectClean(server);
  });
});

describe('listMailboxes and findSpecialUse', () => {
  it('lists with RETURN (SPECIAL-USE) when advertised and parses a Gmail-style reply', async () => {
    const { server, session } = await open([{ expect: LIST_EXTENDED, reply: GMAIL_LIST }]);

    const mailboxes = await session.listMailboxes();

    expect(mailboxes).toHaveLength(7);
    expect(mailboxes[0]).toEqual({ name: 'INBOX', delimiter: '/', attributes: ['\\HasNoChildren'], specialUse: null });
    expect(mailboxes[2]).toEqual({ name: '[Gmail]', delimiter: '/', attributes: ['\\HasChildren', '\\Noselect'], specialUse: null });
    expect(mailboxes[4]).toEqual({
      name: '[Gmail]/Spam',
      delimiter: '/',
      attributes: ['\\HasNoChildren', '\\Junk'],
      specialUse: '\\Junk',
    });
    expect(mailboxes.map((mailbox) => mailbox.specialUse)).toEqual([null, '\\Drafts', null, '\\All', '\\Junk', '\\Sent', '\\Trash']);
    expectClean(server);
  });

  it('finds the folder carrying a SPECIAL-USE attribute and lists only once', async () => {
    const { server, session } = await open([{ expect: LIST_EXTENDED, reply: GMAIL_LIST }]);

    expect(await session.findSpecialUse('\\Junk')).toBe('[Gmail]/Spam');
    expect(await session.findSpecialUse('\\Trash')).toBe('[Gmail]/Trash');
    expect(await session.findSpecialUse('\\Sent')).toBe('[Gmail]/Sent Mail');
    expect(await session.findSpecialUse('\\Drafts')).toBe('[Gmail]/Drafts');
    expect(await session.findSpecialUse('\\All')).toBe('[Gmail]/All Mail');
    expect(await session.findSpecialUse('\\Archive')).toBeNull();

    expect(commandsAfterLogin(server)).toEqual([LIST_EXTENDED]);
    expectClean(server);
  });

  it('lists a plain mailbox set without the return option when SPECIAL-USE is not advertised', async () => {
    const { server, session } = await open(
      [{ expect: LIST_PLAIN, reply: ['* LIST (\\HasNoChildren) "." "INBOX"', '* LIST (\\HasNoChildren) "." "Junk"', '$TAG OK done'] }],
      { caps: BASIC_CAPS },
    );

    expect(await session.findSpecialUse('\\Junk')).toBe('Junk');
    expect(commandsAfterLogin(server)).toEqual([LIST_PLAIN]);
    expectClean(server);
  });

  it.each([
    ['Spam', ['INBOX', 'Spam', 'Sent']],
    ['Junk', ['INBOX', 'Junk']],
    ['[Gmail]/Spam', ['INBOX', '[Gmail]', '[Gmail]/Spam']],
    ['Junk E-mail', ['INBOX', 'Junk E-mail', 'Sent Items']],
    ['Junk Email', ['INBOX', 'Junk Email']],
    ['Bulk Mail', ['INBOX', 'Bulk Mail']],
    ['junk', ['INBOX', 'junk']],
    ['SPAM', ['INBOX', 'SPAM']],
    ['INBOX.Junk', ['INBOX', 'INBOX.Junk', 'INBOX.Sent']],
    ['INBOX/Spam', ['INBOX', 'INBOX/Spam']],
  ])('falls back to the name %s when no folder is labelled', async (expected, names) => {
    const delimiter = expected.includes('.') ? '.' : '/';
    const lines = [...names.map((name) => `* LIST (\\HasNoChildren) "${delimiter}" "${name}"`), '$TAG OK done'];
    const { session } = await open([{ expect: LIST_EXTENDED, reply: lines }]);

    expect(await session.findSpecialUse('\\Junk')).toBe(expected);
  });

  it('returns null when nothing matches', async () => {
    const { session } = await open([
      { expect: LIST_EXTENDED, reply: ['* LIST () "/" "INBOX"', '* LIST () "/" "Receipts"', '* LIST () "/" "Junkyard"', '$TAG OK done'] },
    ]);
    expect(await session.findSpecialUse('\\Junk')).toBeNull();
  });

  it('prefers the attribute over a folder that merely has a junk-like name', async () => {
    const { session } = await open([
      { expect: LIST_EXTENDED, reply: ['* LIST () "/" "Junk"', '* LIST (\\Junk) "/" "Quarantine"', '$TAG OK done'] },
    ]);
    expect(await session.findSpecialUse('\\Junk')).toBe('Quarantine');
  });

  it('matches the attribute case-insensitively', async () => {
    const { session } = await open([{ expect: LIST_EXTENDED, reply: ['* LIST (\\JUNK) "/" "Quarantine"', '$TAG OK done'] }]);
    expect(await session.findSpecialUse('\\Junk')).toBe('Quarantine');
  });

  it('prefers a whole-name match over a nested one, and Junk over Spam', async () => {
    const { session } = await open([
      {
        expect: LIST_EXTENDED,
        reply: ['* LIST () "/" "Archive/Junk"', '* LIST () "/" "Spam"', '* LIST () "/" "Junk"', '$TAG OK done'],
      },
    ]);
    expect(await session.findSpecialUse('\\Junk')).toBe('Junk');
  });

  it('never returns a folder that cannot be selected', async () => {
    const { session } = await open([
      { expect: LIST_EXTENDED, reply: ['* LIST (\\Noselect \\Junk) "/" "Old"', '* LIST (\\NonExistent) "/" "Spam"', '* LIST () "/" "Bulk Mail"', '$TAG OK done'] },
    ]);
    expect(await session.findSpecialUse('\\Junk')).toBe('Bulk Mail');
  });

  it('has name fallbacks for the other uses', async () => {
    const { session } = await open([
      {
        expect: LIST_EXTENDED,
        reply: ['* LIST () "/" "INBOX"', '* LIST () "/" "Sent Items"', '* LIST () "/" "Deleted Items"', '* LIST () "/" "Drafts"', '* LIST () "/" "Archive"', '$TAG OK done'],
      },
    ]);
    expect(await session.findSpecialUse('\\Sent')).toBe('Sent Items');
    expect(await session.findSpecialUse('\\Trash')).toBe('Deleted Items');
    expect(await session.findSpecialUse('\\Drafts')).toBe('Drafts');
    expect(await session.findSpecialUse('\\Archive')).toBe('Archive');
  });

  it('retries a plain LIST when the server refuses the SPECIAL-USE return option', async () => {
    const { server, session } = await open([
      { expect: LIST_EXTENDED, reply: '$TAG BAD Unknown LIST return option' },
      { expect: LIST_PLAIN, reply: ['* LIST () "/" "Spam"', '$TAG OK done'] },
    ]);

    expect(await session.findSpecialUse('\\Junk')).toBe('Spam');
    expectClean(server);
  });

  it('reads mailbox names sent as literals, also in the middle of the response', async () => {
    const { session } = await open([
      {
        expect: LIST_EXTENDED,
        reply: [
          '* LIST (\\HasNoChildren) "/" {10}',
          'Spam "Box"',
          '* LIST (\\HasNoChildren) {1}',
          '/ "Plain"',
          '* LIST (\\Junk) {1}',
          '. {7}',
          'Bulk.Ju',
          '$TAG OK done',
        ],
      },
    ]);

    const mailboxes = await session.listMailboxes();

    expect(mailboxes.map((mailbox) => [mailbox.name, mailbox.delimiter])).toEqual([
      ['Spam "Box"', '/'],
      ['Plain', '/'],
      ['Bulk.Ju', '.'],
    ]);
  });

  it('decodes modified UTF-7 names and encodes them again when selecting', async () => {
    const { server, session } = await open([
      {
        expect: LIST_EXTENDED,
        reply: ['* LIST () "/" "Entw&APw-rfe"', '* LIST () "/" "&ZeVnLIqe-"', '* LIST () "/" "R&-D"', '$TAG OK done'],
      },
      selectStep('Entw&APw-rfe', 3),
    ]);

    const names = (await session.listMailboxes()).map((mailbox) => mailbox.name);
    expect(names).toEqual(['Entwürfe', '日本語', 'R&D']);

    await session.select('Entwürfe');
    expect(commandsAfterLogin(server).at(-1)).toBe('SELECT "Entw&APw-rfe"');
    expectClean(server);
  });

  it('reads a NIL delimiter and a backslash delimiter', async () => {
    const { session } = await open([
      { expect: LIST_EXTENDED, reply: ['* LIST (\\Noselect) NIL "Shared"', '* LIST () "\\\\" "a\\\\b"', '$TAG OK done'] },
    ]);
    const mailboxes = await session.listMailboxes();
    expect(mailboxes.map((mailbox) => mailbox.delimiter)).toEqual([null, '\\']);
    expect(mailboxes[1]?.name).toBe('a\\b');
  });

  it('skips a mailbox without a name', async () => {
    const { session } = await open([{ expect: LIST_EXTENDED, reply: ['* LIST (\\Noselect) "/" ""', '* LIST () "/" "INBOX"', '$TAG OK done'] }]);
    expect((await session.listMailboxes()).map((mailbox) => mailbox.name)).toEqual(['INBOX']);
  });

  it('lists again on request instead of using the cache', async () => {
    const { server, session } = await open([
      { expect: LIST_EXTENDED, reply: ['* LIST () "/" "INBOX"', '$TAG OK done'] },
      { expect: LIST_EXTENDED, reply: ['* LIST () "/" "INBOX"', '* LIST () "/" "Spam"', '$TAG OK done'] },
    ]);
    expect(await session.listMailboxes()).toHaveLength(1);
    expect(await session.listMailboxes()).toHaveLength(2);
    expect(await session.findSpecialUse('\\Junk')).toBe('Spam');
    expect(commandsAfterLogin(server)).toHaveLength(2);
  });

  it('reports a LIST that fails as a command error', async () => {
    const { session } = await open([{ expect: LIST_EXTENDED, reply: '$TAG NO LIST failed' }, { expect: LIST_PLAIN, reply: '$TAG NO LIST failed' }]);
    expect(await failureOf(session.listMailboxes())).toMatchObject({ kind: 'command', command: 'LIST', response: 'LIST failed' });
  });

  it('reports a malformed LIST line as a protocol error', async () => {
    const { session } = await open([{ expect: LIST_EXTENDED, reply: ['* LIST nonsense', '$TAG OK done'] }]);
    expect(await failureOf(session.listMailboxes())).toMatchObject({ kind: 'protocol' });
  });
});

describe('select', () => {
  it('parses EXISTS and UIDVALIDITY', async () => {
    const { server, session } = await open([selectStep('INBOX', 172)]);
    expect(await session.select('INBOX')).toEqual({ exists: 172, uidValidity: 3857529045 });
    expect(commandsAfterLogin(server)).toEqual(['SELECT "INBOX"']);
    expectClean(server);
  });

  it('reports a missing UIDVALIDITY as null and an empty mailbox as 0', async () => {
    const { session } = await open([{ expect: 'SELECT "INBOX"', reply: ['* 0 EXISTS', '* 0 RECENT', '$TAG OK [READ-WRITE] done'] }]);
    expect(await session.select('INBOX')).toEqual({ exists: 0, uidValidity: null });
  });

  it('uses the last EXISTS when the server volunteered an earlier one', async () => {
    const { session } = await open([{ expect: 'SELECT "INBOX"', reply: ['* 9 EXISTS', '* 4 EXISTS', '$TAG OK done'] }]);
    expect((await session.select('INBOX')).exists).toBe(4);
  });

  it('quotes the mailbox name', async () => {
    const { server, session } = await open([{ expect: 'SELECT "Say \\"hi\\" \\\\ ok"', reply: ['* 1 EXISTS', '$TAG OK done'] }]);
    await session.select('Say "hi" \\ ok');
    expectClean(server);
  });

  it('reports NO as a command error with the server text', async () => {
    const { session } = await open([{ expect: 'SELECT "Nope"', reply: '$TAG NO [NONEXISTENT] Unknown Mailbox: Nope' }]);
    const error = await failureOf(session.select('Nope'));
    expect(error).toMatchObject({ kind: 'command', command: 'SELECT', response: '[NONEXISTENT] Unknown Mailbox: Nope' });
    expect(error.message).toContain('Unknown Mailbox');
  });

  it('reports a reply without the message count as a protocol error', async () => {
    const { session } = await open([{ expect: 'SELECT "INBOX"', reply: '$TAG OK done' }]);
    expect(await failureOf(session.select('INBOX'))).toMatchObject({ kind: 'protocol', command: 'SELECT' });
  });
});

describe('searchByMessageId', () => {
  const search = (criteria: string, reply: string[]): ScriptStep => ({ expect: `UID SEARCH ${criteria}`, reply: [...reply, '$TAG OK SEARCH completed'] });

  it('searches the Message-ID header and adds the angle brackets', async () => {
    const { server, session } = await open([search('HEADER Message-ID "<abc.123@mail.example.test>"', ['* SEARCH 4 8 15'])]);
    expect(await session.searchByMessageId('abc.123@mail.example.test')).toEqual([4, 8, 15]);
    expectClean(server);
  });

  it('keeps angle brackets that are already there and trims whitespace', async () => {
    const { server, session } = await open([
      search('HEADER Message-ID "<abc@x.test>"', ['* SEARCH 7']),
      search('HEADER Message-ID "<abc@x.test>"', ['* SEARCH 7']),
    ]);
    expect(await session.searchByMessageId('<abc@x.test>')).toEqual([7]);
    expect(await session.searchByMessageId('  <abc@x.test>\n')).toEqual([7]);
    expectClean(server);
  });

  it('returns an empty list when nothing matches', async () => {
    const { session } = await open([search('HEADER Message-ID "<gone@x.test>"', ['* SEARCH'])]);
    expect(await session.searchByMessageId('gone@x.test')).toEqual([]);
  });

  it('returns an empty list when the reply has no SEARCH line at all', async () => {
    const { session } = await open([search('HEADER Message-ID "<gone@x.test>"', [])]);
    expect(await session.searchByMessageId('gone@x.test')).toEqual([]);
  });

  it('merges SEARCH lines, sorts and removes duplicates', async () => {
    const { session } = await open([search('HEADER Message-ID "<dup@x.test>"', ['* SEARCH 9 3', '* 12 EXISTS', '* SEARCH 3 5'])]);
    expect(await session.searchByMessageId('dup@x.test')).toEqual([3, 5, 9]);
  });

  it('escapes quotes and backslashes in the id', async () => {
    const { server, session } = await open([search('HEADER Message-ID "<a\\"b\\\\c@x.test>"', ['* SEARCH 2'])]);
    expect(await session.searchByMessageId('a"b\\c@x.test')).toEqual([2]);
    expectClean(server);
  });

  it('sends an id with non-ASCII characters as a UTF-8 literal', async () => {
    const { server, session } = await open([search('CHARSET UTF-8 HEADER Message-ID {11}\n<ü@x.test>', ['* SEARCH 5'])]);
    expect(await session.searchByMessageId('ü@x.test')).toEqual([5]);
    expect(server.literals).toEqual(['<ü@x.test>']);
    expectClean(server);
  });

  it.each([[''], ['<>'], ['   '], ['a\r\nb@x.test'], ['a\0b@x.test']])('refuses %j without sending anything', async (id) => {
    const { server, session } = await open([]);
    expect(await failureOf(session.searchByMessageId(id))).toMatchObject({ kind: 'command', command: 'UID SEARCH' });
    expect(commandsAfterLogin(server)).toEqual([]);
  });

  it('reports a SEARCH line with junk as a protocol error', async () => {
    const { session } = await open([search('HEADER Message-ID "<a@x.test>"', ['* SEARCH 1 two'])]);
    expect(await failureOf(session.searchByMessageId('a@x.test'))).toMatchObject({ kind: 'protocol' });
  });

  it('reports a failing search as a command error', async () => {
    const { session } = await open([{ expect: 'UID SEARCH HEADER Message-ID "<a@x.test>"', reply: '$TAG BAD Command received in Invalid state.' }]);
    expect(await failureOf(session.searchByMessageId('a@x.test'))).toMatchObject({ kind: 'command', command: 'UID SEARCH' });
  });
});

describe('addFlags', () => {
  it('stores the flags on the UIDs, as compressed ranges', async () => {
    const { server, session } = await open([done('STORE', 'UID STORE 1:3,7 +FLAGS.SILENT (\\Seen \\Flagged)')]);
    await session.addFlags([7, 3, 1, 2], ['\\Seen', '\\Flagged']);
    expectClean(server);
  });

  it('does nothing for an empty UID list or an empty flag list', async () => {
    const { server, session } = await open([]);
    await session.addFlags([], ['\\Seen']);
    await session.addFlags([1], []);
    expect(commandsAfterLogin(server)).toEqual([]);
  });

  it('refuses a flag that is not a plain flag or keyword, and sends nothing', async () => {
    const { server, session } = await open([]);
    expect(await failureOf(session.addFlags([1], ['\\Seen) (\\Deleted']))).toMatchObject({ kind: 'command' });
    expect(commandsAfterLogin(server)).toEqual([]);
  });

  it('refuses an invalid UID, and sends nothing', async () => {
    const { server, session } = await open([]);
    expect(await failureOf(session.addFlags([0], ['\\Seen']))).toMatchObject({ kind: 'command' });
    expect(await failureOf(session.addFlags([1.5], ['\\Seen']))).toMatchObject({ kind: 'command' });
    expect(commandsAfterLogin(server)).toEqual([]);
  });

  it('reports a NO as a command error', async () => {
    const { session } = await open([{ expect: 'UID STORE 4 +FLAGS.SILENT (\\Seen)', reply: '$TAG NO [READ-ONLY] Mailbox is read-only' }]);
    expect(await failureOf(session.addFlags([4], ['\\Seen']))).toMatchObject({ kind: 'command', command: 'UID STORE' });
  });
});

describe('move', () => {
  it('uses UID MOVE when the server advertises MOVE', async () => {
    const { server, session } = await open([
      { expect: 'UID MOVE 5,9:10 "[Gmail]/Spam"', reply: ['* OK [COPYUID 1 5,9:10 1:3] done', '* 4 EXPUNGE', '* 4 EXPUNGE', '* 4 EXPUNGE', '$TAG OK Moved'] },
    ]);
    await session.move([10, 5, 9], '[Gmail]/Spam');
    expect(commandsAfterLogin(server)).toEqual(['UID MOVE 5,9:10 "[Gmail]/Spam"']);
    expectClean(server);
  });

  it('encodes the destination as modified UTF-7', async () => {
    const { server, session } = await open([done('MOVE', 'UID MOVE 1 "Entw&APw-rfe"')]);
    await session.move([1], 'Entwürfe');
    expectClean(server);
  });

  it('falls back to COPY, STORE \\Deleted and UID EXPUNGE with UIDPLUS', async () => {
    const { server, session } = await open(
      [
        done('COPY', 'UID COPY 3:4 "INBOX"'),
        done('STORE', 'UID STORE 3:4 +FLAGS.SILENT (\\Deleted)'),
        done('UID EXPUNGE', 'UID EXPUNGE 3:4'),
      ],
      { caps: UIDPLUS_CAPS },
    );
    await session.move([3, 4], 'INBOX');
    expectClean(server);
  });

  it('falls back to a plain EXPUNGE without UIDPLUS', async () => {
    const { server, session } = await open(
      [done('COPY', 'UID COPY 3 "INBOX"'), done('STORE', 'UID STORE 3 +FLAGS.SILENT (\\Deleted)'), done('EXPUNGE', 'EXPUNGE')],
      { caps: BASIC_CAPS },
    );
    await session.move([3], 'INBOX');
    expectClean(server);
  });

  it('does nothing for an empty UID list', async () => {
    const { server, session } = await open([]);
    await session.move([], 'INBOX');
    expect(commandsAfterLogin(server)).toEqual([]);
  });

  it('reports a failing MOVE with the server text', async () => {
    const { session } = await open([{ expect: 'UID MOVE 5 "Nope"', reply: '$TAG NO [TRYCREATE] Mailbox does not exist' }]);
    const error = await failureOf(session.move([5], 'Nope'));
    expect(error).toMatchObject({ kind: 'command', command: 'UID MOVE', response: '[TRYCREATE] Mailbox does not exist' });
  });

  it('stops after a failing COPY: nothing is flagged or expunged', async () => {
    const { server, session } = await open([{ expect: 'UID COPY 5 "Nope"', reply: '$TAG NO [TRYCREATE] no such mailbox' }], {
      caps: UIDPLUS_CAPS,
    });
    expect(await failureOf(session.move([5], 'Nope'))).toMatchObject({ kind: 'command', command: 'UID COPY' });
    expect(commandsAfterLogin(server)).toEqual(['UID COPY 5 "Nope"']);
  });
});

describe('deleteMessages', () => {
  it('flags and expunges only the given UIDs with UIDPLUS', async () => {
    const { server, session } = await open([
      done('STORE', 'UID STORE 1:3,7 +FLAGS.SILENT (\\Deleted)'),
      done('UID EXPUNGE', 'UID EXPUNGE 1:3,7'),
    ]);
    await session.deleteMessages([3, 7, 1, 2]);
    expectClean(server);
  });

  it('uses a plain EXPUNGE without UIDPLUS', async () => {
    const { server, session } = await open([done('STORE', 'UID STORE 8 +FLAGS.SILENT (\\Deleted)'), done('EXPUNGE', 'EXPUNGE')], {
      caps: BASIC_CAPS,
    });
    await session.deleteMessages([8]);
    expectClean(server);
  });

  it('does nothing for an empty UID list', async () => {
    const { server, session } = await open([]);
    await session.deleteMessages([]);
    expect(commandsAfterLogin(server)).toEqual([]);
  });

  it('does not expunge when flagging fails', async () => {
    const { server, session } = await open([{ expect: 'UID STORE 8 +FLAGS.SILENT (\\Deleted)', reply: '$TAG NO Permission denied' }]);
    expect(await failureOf(session.deleteMessages([8]))).toMatchObject({ kind: 'command', command: 'UID STORE' });
    expect(commandsAfterLogin(server)).toEqual(['UID STORE 8 +FLAGS.SILENT (\\Deleted)']);
  });
});

describe('reading the connection', () => {
  const FULL_FLOW: ScriptStep[] = [
    {
      expect: LIST_EXTENDED,
      reply: ['* LIST (\\HasNoChildren) "/" "INBOX"', '* LIST (\\HasNoChildren \\Junk) "/" {6}', 'Boîte', '* LIST () "/" "Entw&APw-rfe"', '$TAG OK done'],
    },
    selectStep('INBOX', 12),
    { expect: 'UID SEARCH HEADER Message-ID "<a@x.test>"', reply: ['* 12 EXISTS', '* SEARCH 4 9', '$TAG OK done'] },
  ];

  it.each([1, 2, 3, 7, 64])('copes with replies delivered in pieces of %i bytes', async (chunkSize) => {
    const { server, session } = await open(FULL_FLOW, { chunkSize });

    expect((await session.listMailboxes()).map((mailbox) => mailbox.name)).toEqual(['INBOX', 'Boîte', 'Entwürfe']);
    expect(await session.findSpecialUse('\\Junk')).toBe('Boîte');
    expect(await session.select('INBOX')).toMatchObject({ exists: 12 });
    expect(await session.searchByMessageId('a@x.test')).toEqual([4, 9]);
    expectClean(server);
  });

  it('copes with a login reply that arrives in pieces too', async () => {
    const server = new FakeImapServer({ chunkSize: 1, greeting: '* OK [CAPABILITY IMAP4rev1] ready', script: [loginStep()] });
    const session = await connectImap(config, { connect: server.connect });
    expect(session.capabilities.has('MOVE')).toBe(true);
  });

  it('ignores unsolicited responses between and inside commands', async () => {
    const { server, session } = await open([
      {
        expect: 'UID SEARCH HEADER Message-ID "<a@x.test>"',
        reply: [
          '* 13 EXISTS',
          '* 1 FETCH (FLAGS (\\Seen))',
          '* 2 FETCH (BODY[TEXT] {5}',
          'hello)',
          '* OK [ALERT] System will shut down soon',
          '* SEARCH 6',
          '$TAG OK done',
        ],
      },
    ]);
    expect(await session.searchByMessageId('a@x.test')).toEqual([6]);
    expectClean(server);
  });

  it('serialises commands issued at the same time', async () => {
    const { server, session } = await open([
      selectStep('INBOX', 3),
      { expect: 'UID SEARCH HEADER Message-ID "<a@x.test>"', reply: ['* SEARCH 2', '$TAG OK done'] },
      done('STORE', 'UID STORE 2 +FLAGS.SILENT (\\Seen)'),
    ]);

    const [selected, found] = await Promise.all([
      session.select('INBOX'),
      session.searchByMessageId('a@x.test'),
      session.addFlags([2], ['\\Seen']),
    ]);

    expect(selected.exists).toBe(3);
    expect(found).toEqual([2]);
    expect(server.wire).toEqual([`A001 ${LOGIN}`, 'A002 SELECT "INBOX"', 'A003 UID SEARCH HEADER Message-ID "<a@x.test>"', 'A004 UID STORE 2 +FLAGS.SILENT (\\Seen)']);
    expectClean(server);
  });

  it('reports a reply for the wrong tag as a protocol error', async () => {
    const { session } = await open([{ expect: 'SELECT "INBOX"', reply: 'A999 OK done' }]);
    expect(await failureOf(session.select('INBOX'))).toMatchObject({ kind: 'protocol', command: 'SELECT' });
  });

  it('reports a line that is not IMAP as a protocol error', async () => {
    const { session } = await open([{ expect: 'SELECT "INBOX"', reply: 'what is this' }]);
    expect(await failureOf(session.select('INBOX'))).toMatchObject({ kind: 'protocol' });
  });

  it('reports a continuation request nobody asked for as a protocol error', async () => {
    const { session } = await open([{ expect: 'SELECT "INBOX"', reply: '+ send me something' }]);
    expect(await failureOf(session.select('INBOX'))).toMatchObject({ kind: 'protocol' });
  });

  it('refuses a literal over the size limit', async () => {
    const { session } = await open([{ expect: LIST_EXTENDED, reply: '* LIST () "/" {99999999}' }]);
    expect(await failureOf(session.listMailboxes())).toMatchObject({ kind: 'protocol' });
  });

  it('cannot be used after a protocol error', async () => {
    const { server, session } = await open([{ expect: 'SELECT "INBOX"', reply: 'A999 OK done' }]);
    await failureOf(session.select('INBOX'));
    expect(await failureOf(session.select('INBOX'))).toMatchObject({ kind: 'connect' });
    expect(commandsAfterLogin(server)).toEqual(['SELECT "INBOX"']);
  });
});

describe('timeouts and dropped connections', () => {
  it('times out when a command is not answered, then refuses further commands', async () => {
    const { server, session } = await open([{ expect: 'SELECT "INBOX"', reply: null }], { config: quick });

    const error = await failureOf(session.select('INBOX'));
    expect(error).toMatchObject({ kind: 'timeout', command: 'SELECT' });
    expect(error.message).toContain('50 ms');

    const next = await failureOf(session.searchByMessageId('a@x.test'));
    expect(next.kind).toBe('connect');
    expect(commandsAfterLogin(server)).toEqual(['SELECT "INBOX"']);
  });

  it('times out when the reply stops half-way', async () => {
    const { session } = await open([{ expect: 'SELECT "INBOX"', reply: ['* 3 EXISTS'] }], { config: quick });
    expect(await failureOf(session.select('INBOX'))).toMatchObject({ kind: 'timeout' });
  });

  it('times out when a literal is announced but never completed', async () => {
    const { session } = await open([{ expect: LIST_EXTENDED, reply: ['* LIST () "/" {50}', 'short'] }], { config: quick });
    expect(await failureOf(session.listMailboxes())).toMatchObject({ kind: 'timeout' });
  });

  it('reports a connection reset as a connect error', async () => {
    const { session } = await open([{ expect: 'SELECT "INBOX"', reply: null, reset: true }]);
    const error = await failureOf(session.select('INBOX'));
    expect(error.kind).toBe('connect');
    expect(error.message).toContain('ECONNRESET');
    expect(error.command).toBe('SELECT');
  });

  it('reports a server that hangs up mid-reply as a connect error', async () => {
    const { session } = await open([{ expect: 'SELECT "INBOX"', reply: ['* 3 EXISTS'], hangUp: true }]);
    const error = await failureOf(session.select('INBOX'));
    expect(error.kind).toBe('connect');
    expect(error.message).toContain('closed by the server');
  });

  it('includes the server BYE text when it hangs up after saying why', async () => {
    const { session } = await open([{ expect: 'SELECT "INBOX"', reply: ['* BYE Autologout; idle for too long'], hangUp: true }]);
    const error = await failureOf(session.select('INBOX'));
    expect(error.kind).toBe('connect');
    expect(error.message).toContain('Autologout; idle for too long');
  });

  it('reports a connection that was closed between commands on the next command', async () => {
    const { server, session } = await open([]);
    server.hangUp();
    expect(await failureOf(session.select('INBOX'))).toMatchObject({ kind: 'connect' });
  });
});

describe('logout', () => {
  it('sends LOGOUT and closes the socket', async () => {
    const { server, session } = await open([]);
    await session.logout();
    expect(commandsAfterLogin(server)).toEqual(['LOGOUT']);
    expect(server.wire.at(-1)).toBe('A002 LOGOUT');
    expect(server.closeCalls).toBe(1);
    expectClean(server);
  });

  it('may be called twice', async () => {
    const { server, session } = await open([]);
    await session.logout();
    await session.logout();
    expect(commandsAfterLogin(server)).toEqual(['LOGOUT']);
  });

  it('leaves the session unusable', async () => {
    const { session } = await open([]);
    await session.logout();
    expect(await failureOf(session.select('INBOX'))).toMatchObject({ kind: 'connect' });
  });

  it('never throws when the connection is already gone', async () => {
    const { server, session } = await open([]);
    server.hangUp();
    await expect(session.logout()).resolves.toBeUndefined();
    expect(server.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it('never throws after a timeout', async () => {
    const { server, session } = await open([{ expect: 'SELECT "INBOX"', reply: null }], { config: quick });
    await failureOf(session.select('INBOX'));
    await expect(session.logout()).resolves.toBeUndefined();
    expect(server.closeCalls).toBe(1);
  });

  it('never throws after a reset', async () => {
    const { session } = await open([{ expect: 'SELECT "INBOX"', reply: null, reset: true }]);
    await failureOf(session.select('INBOX'));
    await expect(session.logout()).resolves.toBeUndefined();
  });

  it('gives up waiting for the LOGOUT reply and still closes the socket', async () => {
    const server = new FakeImapServer({ script: [loginStep()], ignoreLogout: true });
    const session = await connectImap(quick, { connect: server.connect });
    const started = Date.now();
    await expect(session.logout()).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(server.closeCalls).toBe(1);
  });

  it('waits for a command in flight before logging out', async () => {
    const { server, session } = await open([selectStep('INBOX', 1)]);
    const selecting = session.select('INBOX');
    await session.logout();
    expect((await selecting).exists).toBe(1);
    expect(commandsAfterLogin(server)).toEqual(['SELECT "INBOX"', 'LOGOUT']);
  });
});
