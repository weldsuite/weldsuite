/**
 * Mobile entity-channel registry.
 *
 * Mirrors apps/web/platform/lib/entity-channels/registry.ts. The server (app-api
 * `/api/channels`) returns entity-linked channels with type='entity' plus
 * `entityType` / `entityId` / `entityDisplayName`. This map only provides the
 * sidebar group label + icon per entity type — one group per type, matching
 * the platform's WeldChat sidebar (Tasks / Projects / Companies / People).
 *
 * Add a new entry here when a new entity provider is added on the server.
 */

import { SquareCheck, FolderOpen, User, Hash } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';

export interface EntityTypeInfo {
  /** Matches the server EntityChannelProvider.type / chatChannels.entityType. */
  type: string;
  /** Group header label in the sidebar (e.g. "Tasks"). */
  label: string;
  /** Icon rendered for the group's channel rows. */
  Icon: LucideIcon;
}

const entityTypes: Record<string, EntityTypeInfo> = {
  task: { type: 'task', label: 'Tasks', Icon: SquareCheck },
  project: { type: 'project', label: 'Projects', Icon: FolderOpen },
  customer: { type: 'customer', label: 'Companies', Icon: User },
  contact: { type: 'contact', label: 'People', Icon: User },
};

export function getEntityTypeInfo(type: string): EntityTypeInfo | null {
  return entityTypes[type] ?? null;
}

/** Ordered list of entity types — drives sidebar group order. */
export function listEntityTypes(): EntityTypeInfo[] {
  return Object.values(entityTypes);
}

/** Fallback icon for an unknown entity type. */
export const FallbackEntityIcon = Hash;
