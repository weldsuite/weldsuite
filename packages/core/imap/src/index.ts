/**
 * @weldsuite/imap — a small IMAP4rev1 client for Cloudflare Workers over TCP
 * sockets (`cloudflare:sockets`, port 993, implicit TLS, LOGIN).
 *
 * Just enough IMAP for the WeldReach warmup network: find a message by its
 * Message-ID in INBOX or the Junk folder, move it, flag it, delete it. See
 * docs/plans/weldreach-warmup.md. The socket is injectable so the protocol is
 * unit-tested against scripted servers, like @weldsuite/smtp.
 *
 * CONTRACT (other packages code against these names; keep them stable):
 *   connectImap(config, options?) → ImapSession (throws ImapError)
 */

export {
  ImapError,
  type ConnectImapOptions,
  type ImapConfig,
  type ImapErrorKind,
  type ImapMailboxInfo,
  type ImapSelectResult,
  type ImapSession,
  type ImapSocket,
  type ImapSocketFactory,
  type ImapSpecialUse,
} from './types';
export { connectImap } from './client';
