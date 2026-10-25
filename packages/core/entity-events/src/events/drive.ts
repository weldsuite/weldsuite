/**
 * WeldDrive (files + folders) entity events.
 */
export const DRIVE_ENTITY_EVENTS = {
  /** `shared` / `unshared`: a teammate gained, changed or lost a role on the item (`drive_shares`). */
  file: ['created', 'updated', 'deleted', 'moved', 'starred', 'pinned', 'restored', 'purged', 'shared', 'unshared'],
  folder: ['created', 'updated', 'deleted', 'moved', 'restored', 'purged', 'shared', 'unshared'],
  /**
   * A document (the `docs` table). For a WeldDocs document, `updated` means
   * its name or content changed; content changes are reported when its room
   * checkpoints, not once per edit.
   */
  doc: ['created', 'updated', 'deleted'],
} as const;
