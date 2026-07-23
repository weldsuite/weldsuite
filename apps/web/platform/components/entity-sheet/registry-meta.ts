import type { EntitySheetRegistry, EntitySheetType } from './types';

/**
 * The entity types that have a sheet renderer registered in
 * DEFAULT_ENTITY_SHEET_REGISTRY (registry.tsx). Kept here — without importing
 * the renderer components — so lightweight consumers like chat mention chips
 * can answer "does this type open in a sheet?" without pulling the entire
 * renderer tree into their module graph (that static edge created an
 * entity-chat → chip → registry → panels → entity-chat import cycle).
 * registry.tsx `satisfies`-checks itself against this list, so the two cannot
 * drift apart without a compile error.
 */
export const ENTITY_SHEET_RENDERER_TYPES = [
  'ticket',
  'invoice',
  'bill',
  'domain',
  'task',
  'lead',
  'opportunity',
  'project',
  'article',
] as const satisfies readonly EntitySheetType[];

export type EntitySheetRendererType = (typeof ENTITY_SHEET_RENDERER_TYPES)[number];

/**
 * Whether a sheet renderer is registered for the given entity type.
 * Callers (search dropdowns, list rows, chat tag clicks) use this to decide
 * whether to open the sheet or navigate to the full page directly — avoids the
 * URL flicker of "open sheet → host detects no renderer → fall back to navigate".
 */
export function hasEntitySheetRenderer(
  type: string | undefined | null,
  registry?: EntitySheetRegistry,
): type is EntitySheetType {
  if (!type) return false;
  if (registry) return type in registry;
  return (ENTITY_SHEET_RENDERER_TYPES as readonly string[]).includes(type);
}

/**
 * Full-page URL for an entity, or `null` when the entity has no standalone
 * page and is viewed exclusively through its entity-sheet panel. `lead` and
 * `opportunity` lost their `/weldcrm/*` detail routes — callers must treat a
 * `null` result as "no full page; stay in the sheet."
 */
export function pageHrefForEntity(type: EntitySheetType, id: string): string | null {
  switch (type) {
    case 'ticket':
      return `/welddesk/tickets/${id}`;
    case 'article':
      return `/welddesk/articles/${id}`;
    case 'invoice':
      return `/weldbooks/invoices/${id}`;
    case 'bill':
      return `/weldbooks/bills/${id}`;
    case 'project':
      return `/weldflow/projects/${id}`;
    case 'task':
      return `/weldflow/tasks/${id}`;
    case 'domain':
      return `/weldhost/domains/${id}`;
    default:
      return null;
  }
}
