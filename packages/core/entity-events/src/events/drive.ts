/**
 * WeldDrive (files + folders) entity events.
 */
export const DRIVE_ENTITY_EVENTS = {
  /** `shared` / `unshared`: a teammate gained, changed or lost a role on the item (`drive_shares`). */
  file: ['created', 'updated', 'deleted', 'moved', 'starred', 'pinned', 'restored', 'purged', 'shared', 'unshared'],
  folder: ['created', 'updated', 'deleted', 'moved', 'restored', 'purged', 'shared', 'unshared'],
  /** Native rich-text document content (the `docs` table). */
  doc: ['created', 'updated', 'deleted'],
} as const;
