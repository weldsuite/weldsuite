/**
 * App-level catch-all helpers for inbound routing.
 *
 * Cloudflare already delivers every address on a zone to this worker.
 * Exact `mail_account_registry` matches win; unmatched custom-domain
 * addresses fall back to a master sentinel `*@domain` when catch-all
 * is enabled for that domain.
 */

/** Master registry key for an enabled catch-all on `domain`. */
export function catchAllRegistryEmail(domain: string): string {
  return `*@${domain.toLowerCase()}`;
}

export function isSharedWeldMailDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return d === 'weldmail.com' || d.endsWith('.weldmail.com');
}

/**
 * For recipient addresses that did not exact-match the registry, build
 * candidate `*@domain` sentinel emails (custom domains only).
 */
export function expandCatchAllCandidates(
  recipientEmails: string[],
  matchedEmails: ReadonlySet<string>,
): string[] {
  const candidates = new Set<string>();
  for (const email of recipientEmails) {
    const normalized = email.trim().toLowerCase();
    if (!normalized || matchedEmails.has(normalized)) continue;
    const at = normalized.lastIndexOf('@');
    if (at <= 0 || at === normalized.length - 1) continue;
    const domain = normalized.slice(at + 1);
    if (isSharedWeldMailDomain(domain)) continue;
    candidates.add(catchAllRegistryEmail(domain));
  }
  return [...candidates];
}

/** True when a registry email is a catch-all sentinel (`*@domain`). */
export function isCatchAllRegistryEmail(email: string): boolean {
  return email.startsWith('*@');
}
