import type { Database } from '@weldsuite/worker-kit/db';

/**
 * Does the acting user hold this workspace permission? Route handlers answer
 * from the request's resolved permissions (app- and deny-aware); background
 * paths, such as checking a user who was @mentioned, resolve them from the
 * tenant DB (see ./permissions).
 */
export type PermissionCheck = (permission: string) => Promise<boolean>;

export interface EntityVisibilityContext {
  db: Database;
  actingUserId: string;
  can: PermissionCheck;
}

export interface EntityChannelContext extends EntityVisibilityContext {
  entityId: string;
}

export interface ResolvedEntityInfo {
  displayName: string;
  defaultMemberIds: string[];
  icon?: string;
}

export interface EntityChannelProvider {
  /** Unique entity type key (e.g. 'task', 'ticket', 'deal'). Becomes chatChannels.entityType. */
  type: string;

  /** Human-readable label for the group header in UIs (e.g. 'Tasks'). */
  label: string;

  /**
   * Workspace permission that opens this type's records (e.g. `companies:read`).
   * Checked together with `canAccess` by {@link canAccessEntity}, never alone.
   */
  requiredPermission: string;

  /**
   * An old type name kept only so existing channels stay reachable. Left out of
   * the record chat lists and summary.
   */
  legacy?: boolean;

  /**
   * Resolve display name + default members for a brand-new channel. Called
   * only on lazy creation. Returns null if the entity doesn't exist / caller
   * shouldn't see it.
   */
  resolve(ctx: EntityChannelContext): Promise<ResolvedEntityInfo | null>;

  /**
   * May the acting user see this record (and so its chat)? Only the record
   * check: the workspace permission is `requiredPermission`. False for missing
   * or deleted records.
   */
  canAccess(ctx: EntityChannelContext): Promise<boolean>;

  /**
   * Batch form of `canAccess`: the ids out of `entityIds` the acting user may
   * see. Records that are deleted or missing are left out. Used by the record
   * chat lists, so a deleted company's chat never lingers in a sidebar.
   */
  filterVisible(ctx: EntityVisibilityContext, entityIds: string[]): Promise<Set<string>>;

  /**
   * Optional: return arbitrary entity details for display in the right-side
   * panel inside WeldChat. Shape is provider-specific.
   */
  resolveDetail?(ctx: EntityChannelContext): Promise<Record<string, unknown> | null>;
}

const providers = new Map<string, EntityChannelProvider>();

export function registerEntityProvider(provider: EntityChannelProvider): void {
  providers.set(provider.type, provider);
}

export function getEntityProvider(type: string): EntityChannelProvider | undefined {
  return providers.get(type);
}

/** Every registered provider, in registration order (the sidebar's group order). */
export function listEntityProviders(): EntityChannelProvider[] {
  return Array.from(providers.values());
}

/** The providers that have a record chat group: every one except the legacy names. */
export function listRecordChatProviders(): EntityChannelProvider[] {
  return listEntityProviders().filter((p) => !p.legacy);
}

/**
 * The full read check for one record's chat: the workspace permission for the
 * type, then the provider's record check.
 */
export async function canAccessEntity(
  provider: EntityChannelProvider,
  ctx: EntityChannelContext,
): Promise<boolean> {
  if (!(await ctx.can(provider.requiredPermission))) return false;
  return provider.canAccess(ctx);
}

/** `canAccess` in terms of `filterVisible`, so a provider's single and batch checks cannot drift. */
export async function canAccessViaFilter(
  provider: Pick<EntityChannelProvider, 'filterVisible'>,
  ctx: EntityChannelContext,
): Promise<boolean> {
  const visible = await provider.filterVisible(ctx, [ctx.entityId]);
  return visible.has(ctx.entityId);
}
