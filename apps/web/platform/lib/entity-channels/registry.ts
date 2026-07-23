/**
 * Client-side entity channel registry.
 *
 * Pairs with the server-side registry at apps/api-worker/src/services/entity-channels.
 * Server decides membership + permissions; this client map only provides
 * label / icon / deep-link URL for the WeldChat sidebar and entity badges.
 * Add a new entity type here when its provider is added on the server.
 */

export interface EntityTypeInfo {
  /** Matches EntityChannelProvider.type on the server. */
  type: string;
  /** Group header label in the WeldChat sidebar (e.g. "Tasks"). */
  label: string;
  /** Lucide icon name, rendered by the sidebar consumer. */
  icon: string;
  /** Platform-local URL that deep-links back to the entity. */
  urlFor: (entityId: string, displayName?: string | null) => string;
}

const entityTypes: Record<string, EntityTypeInfo> = {
  task: {
    type: 'task',
    label: 'Tasks',
    icon: 'SquareCheck',
    // Tasks open via the task detail panel using the `taskId` query param.
    // The generic task route works regardless of project — opened routes
    // use the Open in Task button to jump to a project-scoped view.
    urlFor: (entityId) => `/task?taskId=${encodeURIComponent(entityId)}`,
  },
  project: {
    type: 'project',
    label: 'Projects',
    icon: 'FolderOpen',
    urlFor: (entityId) => `/weldflow/project/${encodeURIComponent(entityId)}`,
  },
  customer: {
    type: 'customer',
    label: 'Companies',
    icon: 'User',
    // Companies have no detail page — deep-link opens the object panel on the
    // companies surface via the `?stack=` param.
    urlFor: (entityId) => `/weldcrm/companies?stack=company:${encodeURIComponent(entityId)}:panel`,
  },
  contact: {
    type: 'contact',
    label: 'People',
    icon: 'User',
    // People have no detail page — deep-link opens the object panel on the
    // people surface via the `?stack=` param.
    urlFor: (entityId) => `/weldcrm/people?stack=person:${encodeURIComponent(entityId)}:panel`,
  },
};

export function getEntityTypeInfo(type: string): EntityTypeInfo | null {
  return entityTypes[type] ?? null;
}

export function listEntityTypes(): EntityTypeInfo[] {
  return Object.values(entityTypes);
}
