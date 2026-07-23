import type { Database } from '../../../db';

export interface EntityChannelContext {
  db: Database;
  actingUserId: string;
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
   * Resolve display name + default members for a brand-new channel. Called
   * only on lazy creation. Returns null if the entity doesn't exist / caller
   * shouldn't see it.
   */
  resolve(ctx: EntityChannelContext): Promise<ResolvedEntityInfo | null>;

  /** Check whether the acting user may read/write the entity's channel. */
  canAccess(ctx: EntityChannelContext): Promise<boolean>;

  /**
   * Optional: return arbitrary entity details for display in the right-side
   * panel inside WeldChat. Shape is provider-specific.
   */
  resolveDetail?(ctx: EntityChannelContext): Promise<Record<string, unknown> | null>;

  /** Permission string that must be granted to the caller. Checked in the route layer. */
  requiredPermission?: string;
}

const providers = new Map<string, EntityChannelProvider>();

export function registerEntityProvider(provider: EntityChannelProvider): void {
  providers.set(provider.type, provider);
}

export function getEntityProvider(type: string): EntityChannelProvider | undefined {
  return providers.get(type);
}

export function listEntityProviders(): EntityChannelProvider[] {
  return Array.from(providers.values());
}
