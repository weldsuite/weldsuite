/**
 * Destroys a deleted workspace's mail held outside Postgres: every mailbox's
 * `MailboxStoreObject` (R2 bodies under `mail/<ws>/<acc>/`, its own SQLite
 * tables — the object stages this in the background via its own alarm, see
 * `@weldsuite/mail-domain/mailbox-object`'s `destroy.ts`) and the workspace's
 * `MailIndex` (correspondents, the address index).
 *
 * Runs unconditionally, regardless of the `weldmail-mailbox-store` flag or
 * mode — a mailbox object can exist from an earlier shadow/object period even
 * if the workspace reads as `postgres` today, and `destroy`/`forgetMailData`
 * are both no-ops against data that was never written (design
 * docs/plans/weldmail-mailbox-store-design.md §7).
 *
 * Called from both:
 *   - `routes/webhooks/clerk.ts`'s `handleOrganizationDeleted`, before the
 *     Neon database teardown. Throws on any mailbox or index failure so the
 *     Clerk webhook answers non-2xx and Svix redelivers — the Neon database
 *     teardown must never run ahead of the mail destroy, because the mailbox
 *     list below is read from the tenant DB while it (usually) still exists.
 *   - `services/teardown-sweep.ts`'s `retryTeardown`, the same ordering, as
 *     the backstop once Svix gives up (~27.6h).
 *
 * Idempotent and safe to retry in full: `MailboxStoreObject.destroy` is a
 * no-op once a destroy is already in progress or done, and
 * `MailIndex.forgetMailData` wipes an already-empty object harmlessly. A
 * failed run is simply retried whole by its caller (clerk.ts via Svix
 * redelivery, the sweep via its own batch requeue) — this module keeps no
 * partial-progress state of its own.
 *
 * Never wakes a tenant DB on a timer (DATA-008): both call sites only ever
 * run this against a workspace already marked for deletion, through the
 * existing teardown flow — not on a schedule of this module's own.
 */

import { eq } from 'drizzle-orm';
import { mailAccountRegistry } from '@weldsuite/db/schema/master';
import { mailAccounts } from '@weldsuite/db/schema/mail-accounts';
import { mailboxStubFor, type MailboxStoreNamespaceEnv } from '@weldsuite/mail-domain/store/object';
import { mailIndexFor, type MailIndexBindingEnv } from '@weldsuite/mail-domain/mail-index/client';
import type { MailboxRef } from '@weldsuite/mail-domain/store/types';
import { getTenantDbForWorkspace, type MasterDatabase } from '../db';
import type { Env } from '../index';

export interface DestroyWorkspaceMailResult {
  /** Distinct mailboxes (account ids) found for the workspace, across the tenant DB and the master registry. */
  mailboxCount: number;
  /** Mailboxes whose `destroy` RPC call was accepted. */
  destroyed: number;
  /** Account ids whose `destroy` RPC call failed — logged, and surfaced as a thrown error below. */
  failedAccountIds: string[];
  /** Whether `MailIndex.forgetMailData` ran and succeeded. */
  indexForgotten: boolean;
  /** True when neither `MAILBOX_STORE` nor `MAIL_INDEX` is configured on this environment: nothing to do, not a failure. */
  skipped: boolean;
}

type DestroyMailEnv = Env & MailboxStoreNamespaceEnv & MailIndexBindingEnv;

/**
 * Every mailbox the master registry still knows for this workspace, any
 * `isActive` — a registry row survives its tenant account's soft delete
 * (`services/mail/accounts.ts` in mail-api only soft-deletes the tenant row),
 * and it is the only source left once the tenant database itself is gone.
 */
async function registryAccountIds(masterDb: MasterDatabase, workspaceId: string): Promise<string[]> {
  const rows = await masterDb
    .select({ accountId: mailAccountRegistry.accountId })
    .from(mailAccountRegistry)
    .where(eq(mailAccountRegistry.workspaceId, workspaceId));
  return rows.map((row) => row.accountId);
}

/**
 * Every mailbox the tenant DB still has, soft-deleted ones included (no
 * `deletedAt` filter — a soft-deleted mail account's object may still hold
 * data). Best effort: a tenant DB that is already gone (an earlier deletion
 * that predates this teardown step, or one whose Neon teardown already
 * finished) falls back to the registry alone rather than failing the whole
 * destroy.
 */
async function tenantAccountIds(env: DestroyMailEnv, workspaceId: string): Promise<string[]> {
  try {
    const tenantDb = await getTenantDbForWorkspace(env, workspaceId);
    const rows = await tenantDb.select({ id: mailAccounts.id }).from(mailAccounts);
    return rows.map((row) => row.id);
  } catch (err) {
    console.warn(
      `[WorkspaceMailDestroy] Could not read tenant mail_accounts for workspace ${workspaceId} (continuing with the master registry only):`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

export async function destroyWorkspaceMail(
  env: DestroyMailEnv,
  masterDb: MasterDatabase,
  workspaceId: string,
): Promise<DestroyWorkspaceMailResult> {
  if (!env.MAILBOX_STORE && !env.MAIL_INDEX) {
    console.log(
      `[WorkspaceMailDestroy] MAILBOX_STORE/MAIL_INDEX are not configured; skipping the mail teardown of workspace ${workspaceId}`,
    );
    return { mailboxCount: 0, destroyed: 0, failedAccountIds: [], indexForgotten: false, skipped: true };
  }

  const [registryIds, tenantIds] = await Promise.all([
    registryAccountIds(masterDb, workspaceId),
    tenantAccountIds(env, workspaceId),
  ]);
  const accountIds = [...new Set([...registryIds, ...tenantIds])];

  let destroyed = 0;
  const failedAccountIds: string[] = [];
  if (env.MAILBOX_STORE) {
    for (const accountId of accountIds) {
      const ref: MailboxRef = { workspaceId, accountId };
      try {
        await mailboxStubFor(env, ref).destroy(ref);
        destroyed++;
      } catch (err) {
        failedAccountIds.push(accountId);
        console.error(
          `[WorkspaceMailDestroy] destroy() failed for mailbox ${workspaceId}:${accountId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } else if (accountIds.length > 0) {
    console.warn(
      `[WorkspaceMailDestroy] ${accountIds.length} mailbox(es) found for workspace ${workspaceId} but MAILBOX_STORE is not configured; skipping their destroy()`,
    );
  }

  let indexForgotten = false;
  let indexFailed = false;
  const index = mailIndexFor(env, workspaceId);
  if (index) {
    try {
      await index.forgetMailData(workspaceId);
      indexForgotten = true;
    } catch (err) {
      indexFailed = true;
      console.error(`[WorkspaceMailDestroy] MailIndex.forgetMailData failed for workspace ${workspaceId}:`, err instanceof Error ? err.message : err);
    }
  }

  if (failedAccountIds.length > 0 || indexFailed) {
    throw new Error(
      `destroyWorkspaceMail: workspace ${workspaceId} mail teardown incomplete ` +
        `(${failedAccountIds.length} of ${accountIds.length} mailbox(es) failed` +
        (indexFailed ? '; MailIndex.forgetMailData failed' : '') +
        ') — will be retried',
    );
  }

  return { mailboxCount: accountIds.length, destroyed, failedAccountIds, indexForgotten, skipped: false };
}
