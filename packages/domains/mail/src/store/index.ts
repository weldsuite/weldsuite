/**
 * Public surface of the mailbox store contracts (design §2) and the factory
 * every caller builds a workspace's mail access through: `getWorkspaceMail`
 * (task C3). `store/types.ts`'s own header comment reserves this — `MailAccess`,
 * `WorkspaceMail`, `MailStoreEnv` and the factory — for whichever task builds
 * the router, the KV directory and the object client, since it depends on all
 * three; that's this task, and this file is where they come together.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createDrizzlePermissionQueries } from '@weldsuite/permissions/server';
import { resolveEffectivePermissionsCached, type PermissionsCacheEnv } from '@weldsuite/worker-kit/permission-cache';
import type { MailPrincipal } from '../access';
import { ObjectMailAccess, PostgresMailAccess, type MailAccess } from './access';
import { getMailDirectory, type MailDirectoryEnv } from './directory';
import { resolveMailStoreMode, type MailStoreModeEnv } from './mode';
import { ObjectWorkspaceMailStore, type ObjectWorkspaceMailStoreEnv } from './object';
import { parseParitySampleRate } from './parity';
import { PostgresWorkspaceMailStore } from './postgres';
import { RoutedWorkspaceMailStore } from './router';
import type { MailStoreMode, WorkspaceMailStore } from './types';

export * from './types';
export { ObjectMailAccess, PostgresMailAccess, type MailAccess, type ResolveIsAdmin } from './access';
export {
  buildMailDirectory,
  bumpMailboxDirectory,
  getMailDirectory,
  loadAllDirectoryAccounts,
  loadAllDirectoryLabels,
  loadDirectoryAccountsByIds,
  loadDirectoryLabelsForAccounts,
  type DirectoryAccount,
  type DirectoryLabel,
  type MailDirectoryEnv,
  type MailDirectoryEntry,
} from './directory';
export {
  DEFAULT_PARITY_SAMPLE_RATE,
  ParitySampler,
  bodiesPresenceEqual,
  compareMailboxStats,
  compareThreadPage,
  logParityMismatch,
  parseParitySampleRate,
  shouldSampleParity,
  type ParityDiff,
  type ParityKind,
  type ParityMismatch,
  type ParityMismatchHandler,
  type ParitySampleRateEnv,
  type ParitySamplerOptions,
} from './parity';
export {
  MAILBOX_DRIFT_TTL_SECONDS,
  RoutedMailboxStore,
  RoutedWorkspaceMailStore,
  __resetMailRouterStateForTests,
  getSecondaryFailureCount,
  markMailboxDrift,
  noteReadinessFromWrite,
  rewriteOpForSecondary,
  type MailboxDriftMarker,
  type RoutedMailboxStoreDeps,
  type RoutedWorkspaceMailStoreDeps,
  type SecondaryDirection,
} from './router';

/**
 * Every binding `getWorkspaceMail` needs, across every mode. `MAIL_STORAGE`
 * is required (not optional) because `ObjectMailboxStoreEnv` (task C2)
 * already declares it that way — a worker that only ever runs `postgres`
 * mode for now still needs the binding wired (unused) for this to type-check,
 * same as it needs `MAILBOX_STORE` bound at deploy time per design §8, even
 * though neither is ever called while every workspace resolves to `postgres`.
 */
export interface MailStoreEnv extends ObjectWorkspaceMailStoreEnv, MailStoreModeEnv, MailDirectoryEnv, PermissionsCacheEnv {
  MAILBOX_PARITY_SAMPLE_RATE?: string;
}

export interface WorkspaceMail {
  mode: MailStoreMode;
  store: WorkspaceMailStore;
  access: MailAccess;
}

export interface GetWorkspaceMailOptions {
  /** `workspaces.id` (`ws_…`) — never the Clerk org id (ADR SEC-011). */
  workspaceId: string;
  clerkOrgId: string;
  db: Database;
  waitUntil: (p: Promise<unknown>) => void;
  /** Shorthand for `principal: { kind: 'user', userId }`. One of `userId`/`principal` is required. */
  userId?: string;
  principal?: MailPrincipal;
  /**
   * Pre-resolved role (e.g. `getPermissionsFromContext(c)?.role`, already
   * resolved by the route's own `requirePermission`), so `MailAccess.isAdmin()`
   * in `object`/`object-only` modes costs nothing beyond what the route
   * already paid for. Omitted ⇒ resolved lazily via
   * `resolveEffectivePermissionsCached` (design §6: "External API and MCP
   * user principals take the role from `resolveEffectivePermissionsCached`").
   * Ignored for a `workspace` principal, which is never an admin.
   */
  role?: string | null;
  /** Override for a caller that already knows the mode (tests, a workflow step continuing one it resolved earlier). Omitted ⇒ `resolveMailStoreMode(env, workspaceId)`. */
  mode?: MailStoreMode;
  now?: () => number;
}

function resolvePrincipal(options: GetWorkspaceMailOptions): MailPrincipal {
  if (options.principal) return options.principal;
  if (options.userId) return { kind: 'user', userId: options.userId };
  throw new Error('getWorkspaceMail: one of `principal` or `userId` is required');
}

function isAdminRole(role: string): boolean {
  const upper = role.toUpperCase();
  return upper === 'OWNER' || upper === 'ADMIN';
}

/** `createDrizzlePermissionQueries` + `resolveEffectivePermissionsCached`, the same pattern `@weldsuite/worker-kit/app`'s `requirePermission` wiring and `@weldsuite/chat-domain`'s `userPermissionCheck` use outside a request's own user. */
async function resolveIsAdminFromPermissions(
  env: PermissionsCacheEnv,
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const queries = createDrizzlePermissionQueries(db, schema, { eq, and, isNull });
  const resolved = await resolveEffectivePermissionsCached(env, workspaceId, userId, queries);
  return resolved.isOwner || isAdminRole(resolved.role);
}

async function resolveMailAccess(
  env: MailStoreEnv,
  mode: MailStoreMode,
  options: GetWorkspaceMailOptions,
  principal: MailPrincipal,
): Promise<MailAccess> {
  // postgres/shadow: wrap ../access.ts unchanged (design §6) — no directory, no KV.
  if (mode === 'postgres' || mode === 'shadow') return new PostgresMailAccess(options.db, principal);

  // object/object-only: directory + a resolved role, no tenant query on the common path.
  const directory = await getMailDirectory(env, options.workspaceId, options.db, options.now);
  const resolveIsAdmin = (): Promise<boolean> => {
    if (principal.kind === 'workspace') return Promise.resolve(false);
    if (options.role != null) return Promise.resolve(isAdminRole(options.role));
    return resolveIsAdminFromPermissions(env, options.db, options.workspaceId, principal.userId);
  };
  return new ObjectMailAccess(directory, principal, resolveIsAdmin);
}

/**
 * Builds one request's `{ mode, store, access }` (design §2's `WorkspaceMail`).
 * Resolves the mode once (`options.mode`, or a single `resolveMailStoreMode`
 * call) and reuses it for both the store and `MailAccess`, so the two never
 * disagree about what mode a request is running under.
 *
 * `postgres` mode (the default for every workspace) touches neither
 * `WORKSPACE_CACHE` nor `MAILBOX_STORE`: no directory build, no object
 * construction, no parity sampler, no `setMode`/`status()` probe — see
 * `store/router.ts`'s own mode table for the full byte-identical guarantee
 * this depends on.
 */
export async function getWorkspaceMail(env: MailStoreEnv, options: GetWorkspaceMailOptions): Promise<WorkspaceMail> {
  const principal = resolvePrincipal(options);
  const mode = options.mode ?? (await resolveMailStoreMode(env, options.workspaceId, { now: options.now }));

  const postgresWorkspace = new PostgresWorkspaceMailStore(options.db, options.workspaceId, options.clerkOrgId);
  const objectWorkspace =
    mode === 'postgres' ? undefined : new ObjectWorkspaceMailStore(env, options.workspaceId, options.clerkOrgId, mode);

  const store = new RoutedWorkspaceMailStore({
    workspaceId: options.workspaceId,
    clerkOrgId: options.clerkOrgId,
    mode,
    postgresWorkspace,
    objectWorkspace,
    adminEnv: mode === 'postgres' ? undefined : env,
    kv: mode === 'postgres' ? undefined : env.WORKSPACE_CACHE,
    waitUntil: options.waitUntil,
    parityRate: mode === 'postgres' ? undefined : parseParitySampleRate(env),
    now: options.now,
  });

  const access = await resolveMailAccess(env, mode, options, principal);

  return { mode, store, access };
}
