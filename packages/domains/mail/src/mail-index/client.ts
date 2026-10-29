/**
 * `MailIndex` lookup, the only place that should call `idFromName` for it
 * (mirrors `mailboxStub`'s planned role for `MailboxObject`, design doc §2).
 * Always EU-jurisdiction: correspondents and the address index hold email
 * addresses (MAIL-009).
 */

import type { MailIndex } from './mail-index';

export interface MailIndexBindingEnv {
  /** Bound by mail-api once its `wrangler.toml` lands the object (a later task). Optional everywhere else so a worker that hasn't bound it yet keeps working. */
  MAIL_INDEX?: DurableObjectNamespace<MailIndex>;
}

export function mailIndexKeyFor(workspaceId: string): string {
  return `mbxidx:${workspaceId}`;
}

/** The workspace's `MailIndex` stub, or `null` when the binding isn't present (unmigrated workers, tests without it wired). */
export function mailIndexFor(env: MailIndexBindingEnv, workspaceId: string): DurableObjectStub<MailIndex> | null {
  if (!env.MAIL_INDEX) return null;
  const eu = env.MAIL_INDEX.jurisdiction('eu');
  return eu.get(eu.idFromName(mailIndexKeyFor(workspaceId)));
}
