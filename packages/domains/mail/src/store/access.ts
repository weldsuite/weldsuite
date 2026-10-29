/**
 * `MailAccess` (design §2, §6): the one interface every caller asks "who may
 * open/manage this mailbox" through, regardless of store mode.
 *
 * - `postgres`/`shadow`: `PostgresMailAccess` wraps today's `../access.ts`
 *   rules unchanged, querying the tenant DB exactly as the routes do today.
 * - `object`/`object-only`: `ObjectMailAccess` decides from the KV directory
 *   (`./directory`) plus a caller-supplied admin check, with no tenant query
 *   on the common path. It calls the SAME pure rules — `hasAccessToAccount`,
 *   `principalHasAccess`, `canManageAccount` — on directory data instead of a
 *   DB row, per the design's explicit instruction not to fork them: a
 *   `DirectoryAccount` already carries the two fields those rules need
 *   (`isShared`, `assignedUserIds`), so no adapter is required.
 *
 * Both implementations return the exact same `DirectoryAccount`/
 * `DirectoryLabel` shape from `account()`/`accounts()`/`labels()` — new
 * surface this interface adds beyond today's `../access.ts`, answered by the
 * same `./directory` queries either way (cached in object modes, live in
 * postgres/shadow).
 */

import type { Database } from '@weldsuite/worker-kit/db';
import {
  accessibleAccountIds,
  canOpenAccount,
  checkAccountManageAccess,
  hasAccessToAccount,
  principalHasAccess,
  principalIsAdmin,
  type MailPrincipal,
} from '../access';
import {
  loadAllDirectoryAccounts,
  loadDirectoryAccountsByIds,
  loadDirectoryLabelsForAccounts,
  type DirectoryAccount,
  type DirectoryLabel,
  type MailDirectoryEntry,
} from './directory';

export interface MailAccess {
  isAdmin(): Promise<boolean>;
  canOpen(accountId: string): Promise<boolean>;
  canManage(accountId: string): Promise<boolean>;
  accessibleAccountIds(): Promise<string[]>;
  account(accountId: string): Promise<DirectoryAccount | null>;
  accounts(scope?: 'open' | 'manage'): Promise<DirectoryAccount[]>;
  labels(accountId: string): Promise<DirectoryLabel[]>;
  isShared(accountId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// postgres / shadow: wrap today's access.ts unchanged
// ---------------------------------------------------------------------------

export class PostgresMailAccess implements MailAccess {
  constructor(
    private readonly db: Database,
    private readonly principal: MailPrincipal,
  ) {}

  isAdmin(): Promise<boolean> {
    return principalIsAdmin(this.db, this.principal);
  }

  canOpen(accountId: string): Promise<boolean> {
    return canOpenAccount(this.db, accountId, this.principal);
  }

  async canManage(accountId: string): Promise<boolean> {
    if (this.principal.kind === 'workspace') return false; // a workspace key never manages account settings
    return checkAccountManageAccess(this.db, accountId, this.principal.userId);
  }

  accessibleAccountIds(): Promise<string[]> {
    return accessibleAccountIds(this.db, this.principal);
  }

  async account(accountId: string): Promise<DirectoryAccount | null> {
    const [row] = await loadDirectoryAccountsByIds(this.db, [accountId]);
    return row ?? null;
  }

  async accounts(scope: 'open' | 'manage' = 'open'): Promise<DirectoryAccount[]> {
    const ids = scope === 'manage' ? await this.manageableAccountIds() : await this.accessibleAccountIds();
    return loadDirectoryAccountsByIds(this.db, ids);
  }

  /** "Anyone who may open it, plus admins/owners" (`../access.ts`'s own doc comment on `canManageAccount`) — an admin manages every live account, not just assigned ones. */
  private async manageableAccountIds(): Promise<string[]> {
    if (this.principal.kind === 'workspace') return [];
    const isAdmin = await this.isAdmin();
    if (isAdmin) return (await loadAllDirectoryAccounts(this.db)).map((a) => a.id);
    return this.accessibleAccountIds();
  }

  async labels(accountId: string): Promise<DirectoryLabel[]> {
    const byAccount = await loadDirectoryLabelsForAccounts(this.db, [accountId]);
    return byAccount[accountId] ?? [];
  }

  async isShared(accountId: string): Promise<boolean> {
    return (await this.account(accountId))?.isShared === true;
  }
}

// ---------------------------------------------------------------------------
// object / object-only: directory + a resolved role, no tenant query
// ---------------------------------------------------------------------------

/**
 * `ObjectMailAccess` never resolves the admin/owner check itself — the
 * factory (`store/index.ts`) supplies it, either a pre-resolved role (the
 * platform already ran `requirePermission` before reaching here) or a
 * `resolveEffectivePermissionsCached` lookup for callers that haven't (design
 * §6: "External API and MCP user principals take the role from
 * `resolveEffectivePermissionsCached`"). Memoised here regardless of source,
 * since several `MailAccess` methods ask in the same request.
 */
export type ResolveIsAdmin = () => Promise<boolean>;

export class ObjectMailAccess implements MailAccess {
  private adminPromise: Promise<boolean> | undefined;

  constructor(
    private readonly directory: MailDirectoryEntry,
    private readonly principal: MailPrincipal,
    private readonly resolveIsAdmin: ResolveIsAdmin,
  ) {}

  isAdmin(): Promise<boolean> {
    // A workspace key is never an admin (mirrors `../access.ts`'s `principalIsAdmin`).
    if (this.principal.kind === 'workspace') return Promise.resolve(false);
    this.adminPromise ??= this.resolveIsAdmin();
    return this.adminPromise;
  }

  private findAccount(accountId: string): DirectoryAccount | null {
    return this.directory.accounts.find((a) => a.id === accountId && !a.deletedAt) ?? null;
  }

  private liveAccounts(): DirectoryAccount[] {
    return this.directory.accounts.filter((a) => !a.deletedAt);
  }

  async canOpen(accountId: string): Promise<boolean> {
    const account = this.findAccount(accountId);
    if (!account) return false;
    return principalHasAccess(account, this.principal, await this.isAdmin());
  }

  async canManage(accountId: string): Promise<boolean> {
    const account = this.findAccount(accountId);
    if (!account) return false;
    if (this.principal.kind === 'workspace') return false;
    if (await this.isAdmin()) return true;
    return hasAccessToAccount(account, this.principal.userId, false);
  }

  async accessibleAccountIds(): Promise<string[]> {
    const isAdmin = await this.isAdmin();
    return this.liveAccounts()
      .filter((a) => principalHasAccess(a, this.principal, isAdmin))
      .map((a) => a.id);
  }

  async account(accountId: string): Promise<DirectoryAccount | null> {
    return this.findAccount(accountId);
  }

  async accounts(scope: 'open' | 'manage' = 'open'): Promise<DirectoryAccount[]> {
    const live = this.liveAccounts();
    if (scope === 'manage') {
      const principal = this.principal;
      if (principal.kind === 'workspace') return [];
      if (await this.isAdmin()) return live;
      return live.filter((a) => hasAccessToAccount(a, principal.userId, false));
    }
    const isAdmin = await this.isAdmin();
    return live.filter((a) => principalHasAccess(a, this.principal, isAdmin));
  }

  async labels(accountId: string): Promise<DirectoryLabel[]> {
    return this.directory.labels[accountId] ?? [];
  }

  async isShared(accountId: string): Promise<boolean> {
    return this.findAccount(accountId)?.isShared === true;
  }
}
