/**
 * Partial-failure policy for `ObjectWorkspaceMailStore`'s cross-mailbox reads
 * (design §5): one mailbox's Durable Object being unreachable must not take
 * down a unified-inbox read of every OTHER mailbox the caller can see.
 *
 * Chosen policy (documented here once, applied everywhere in
 * `workspace-store.ts`): every fan-out call tolerates individual mailbox
 * failures and proceeds with whichever mailboxes answered. `WorkspaceMailStore`
 * (`../types`, task A3 — not owned by this task) has no `partial`/
 * `failedAccountIds` field on `ThreadPage`/`MessagePage`/`MessageStats`/etc.
 * to surface which mailboxes were dropped, and widening every one of those
 * shared return shapes for this one caller isn't a "minimal" change to
 * `store/types.ts` — so a failed mailbox's absence is logged here
 * (`console.error`, matching `mail-index/mail-index.ts`'s own style) but not
 * returned to the caller. Only when EVERY mailbox in a fan-out fails does the
 * call throw (`MailboxFanoutError`), propagating up instead of silently
 * returning an empty, misleadingly-successful page.
 */

import { mapWithConcurrency } from './concurrency';

export interface FanoutResult<T> {
  /** One entry per mailbox that answered, in no particular order (callers merge/sum as needed). */
  succeeded: Array<{ accountId: string; value: T }>;
  /** Account ids whose call threw, in no particular order. */
  failedAccountIds: string[];
}

/** Thrown by `fanOutToMailboxes` only when `accountIds` is non-empty and every single one failed. */
export class MailboxFanoutError extends Error {
  constructor(
    readonly failedAccountIds: string[],
    readonly causes: unknown[],
  ) {
    super(
      `ObjectWorkspaceMailStore: every mailbox in the fan-out failed (${failedAccountIds.join(', ')}): ` +
        `${causes.map((c) => (c instanceof Error ? c.message : String(c))).join('; ')}`,
    );
    this.name = 'MailboxFanoutError';
  }
}

/**
 * Calls `run(accountId)` for every id in `accountIds`, at most `concurrency`
 * at a time, tolerating individual failures (see this file's header comment
 * for the policy). Throws `MailboxFanoutError` only when nothing succeeded.
 */
export async function fanOutToMailboxes<T>(
  accountIds: readonly string[],
  concurrency: number,
  run: (accountId: string) => Promise<T>,
): Promise<FanoutResult<T>> {
  type Settled = { accountId: string; ok: true; value: T } | { accountId: string; ok: false; err: unknown };

  const settled = await mapWithConcurrency<string, Settled>(accountIds, concurrency, async (accountId) => {
    try {
      return { accountId, ok: true, value: await run(accountId) };
    } catch (err) {
      console.error(`[mail-store/object] mailbox fan-out failed for account ${accountId}:`, err);
      return { accountId, ok: false, err };
    }
  });

  const succeeded: Array<{ accountId: string; value: T }> = [];
  const failedAccountIds: string[] = [];
  const causes: unknown[] = [];
  for (const entry of settled) {
    if (entry.ok) succeeded.push({ accountId: entry.accountId, value: entry.value });
    else {
      failedAccountIds.push(entry.accountId);
      causes.push(entry.err);
    }
  }

  if (succeeded.length === 0 && failedAccountIds.length > 0) {
    throw new MailboxFanoutError(failedAccountIds, causes);
  }
  return { succeeded, failedAccountIds };
}
