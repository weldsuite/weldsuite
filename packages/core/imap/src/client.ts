/**
 * IMAP over cloudflare:sockets (RFC 3501): port 993, implicit TLS, LOGIN.
 *
 *   connect → greeting → LOGIN → CAPABILITY → … commands … → LOGOUT
 *
 * `connectImap` throws an ImapError (never a bare Error) for anything the
 * network or the server does, with `kind` saying whether it is worth retrying:
 * 'auth' needs a person, 'connect' / 'timeout' are usually transient.
 */
import { connect as cloudflareConnect } from 'cloudflare:sockets';
import { ImapConnection, type CommandResult } from './connection';
import { parseCapabilities } from './parse';
import { stringPart } from './protocol';
import { ImapClientSession } from './session';
import { ImapError, type ConnectImapOptions, type ImapConfig, type ImapSession, type ImapSocket, type ImapSocketFactory } from './types';

const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
const IMAPS_PORT = 993;

export async function connectImap(config: ImapConfig, options: ConnectImapOptions = {}): Promise<ImapSession> {
  checkConfig(config);

  const connectSocket: ImapSocketFactory = options.connect ?? cloudflareConnect;
  let socket: ImapSocket;
  try {
    socket = connectSocket({ hostname: config.host, port: config.port }, { secureTransport: 'on', allowHalfOpen: false });
  } catch (error) {
    throw new ImapError('connect', `Could not connect to ${config.host}:${config.port}: ${describeError(error)}`);
  }

  const connection = new ImapConnection(socket, config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  try {
    const greeting = await connection.readGreeting();
    const capabilities = await authenticate(connection, config, greeting);
    return new ImapClientSession(connection, capabilities);
  } catch (error) {
    await connection.close();
    throw error;
  }
}

function checkConfig(config: ImapConfig): void {
  if (config.port !== IMAPS_PORT) {
    throw new ImapError('connect', `Port ${config.port} is not supported: IMAP is spoken over implicit TLS on port ${IMAPS_PORT} only`);
  }
  if (config.host.trim() === '') throw new ImapError('connect', 'No IMAP server host given');
  if (config.username.includes('\0') || config.password.includes('\0')) {
    throw new ImapError('auth', 'IMAP credentials cannot contain NUL characters', { command: 'LOGIN' });
  }
}

/** LOGIN (unless the server greeted with PREAUTH) and the capabilities that apply afterwards. */
async function authenticate(connection: ImapConnection, config: ImapConfig, greeting: 'OK' | 'PREAUTH'): Promise<ReadonlySet<string>> {
  let capabilities: Set<string> | null = null;
  if (greeting === 'OK') {
    const result = await connection.execute('LOGIN', [stringPart(config.username), stringPart(config.password)]);
    if (result.status !== 'OK') throw loginError(result);
    capabilities = capabilitiesOf(result);
  }
  return capabilities ?? (await fetchCapabilities(connection));
}

function loginError(result: CommandResult): ImapError {
  const kind = result.status === 'NO' ? 'auth' : 'command';
  return new ImapError(kind, `IMAP login rejected: ${result.status} ${result.rest}`.trim(), { command: 'LOGIN', response: result.rest });
}

/** Capabilities the server volunteered with the login reply: a `[CAPABILITY ...]` code or an untagged CAPABILITY. */
function capabilitiesOf(result: CommandResult): Set<string> | null {
  const text =
    result.code === 'CAPABILITY' ? result.codeData : result.untagged.find((response) => response.word === 'CAPABILITY')?.rest;
  if (text === undefined) return null;
  const atoms = parseCapabilities(text);
  return atoms.length > 0 ? new Set(atoms) : null;
}

async function fetchCapabilities(connection: ImapConnection): Promise<Set<string>> {
  const result = await connection.execute('CAPABILITY');
  if (result.status !== 'OK') {
    throw new ImapError('command', `CAPABILITY failed: ${result.status} ${result.rest}`.trim(), { command: 'CAPABILITY', response: result.rest });
  }
  const listed = result.untagged.find((response) => response.word === 'CAPABILITY');
  return new Set(parseCapabilities(listed?.rest ?? ''));
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}
