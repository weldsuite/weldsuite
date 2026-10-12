/**
 * The inbound address `<token>@<REACH_INBOUND_DOMAIN>`: each WeldReach mailbox
 * forwards its incoming mail to its own random token, which is how a forwarded
 * message finds its workspace and mailbox.
 */

/** Lower-case letters, digits, `_` and `-`; at most 40 characters (`reach_mailboxes.inbound_token`). */
const TOKEN_RE = /^[a-z0-9][a-z0-9_-]{5,39}$/;

/** `Name <local@host>` or `local@host` to `local@host`, lower-cased. */
export function extractAddress(raw: string): string {
  const angle = /<([^<>]+)>/.exec(raw);
  return (angle ? angle[1]! : raw).trim().toLowerCase();
}

/**
 * The token in an envelope recipient, or null when the address is not one of
 * ours (wrong domain, malformed local part). A `+tag` suffix is ignored.
 * `inboundDomain` is REACH_INBOUND_DOMAIN; when unset any domain is accepted.
 */
export function parseInboundToken(recipient: string, inboundDomain: string | undefined): string | null {
  const address = extractAddress(recipient);
  const at = address.lastIndexOf('@');
  if (at <= 0) return null;
  const domain = address.slice(at + 1);
  if (inboundDomain && domain !== inboundDomain.trim().toLowerCase()) return null;
  let local = address.slice(0, at);
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  return TOKEN_RE.test(local) ? local : null;
}
