/**
 * IMAP over cloudflare:sockets. Implemented in the WeldReach warmup build.
 */
import type { ConnectImapOptions, ImapConfig, ImapSession } from './types';

export async function connectImap(_config: ImapConfig, _options: ConnectImapOptions = {}): Promise<ImapSession> {
  throw new Error('@weldsuite/imap connectImap: not implemented yet');
}
