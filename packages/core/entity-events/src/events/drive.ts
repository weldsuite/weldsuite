/**
 * WeldDrive (files + folders) entity events.
 */
export const DRIVE_ENTITY_EVENTS = {
  file: ['created', 'updated', 'deleted', 'moved', 'starred', 'pinned', 'restored', 'purged'],
  folder: ['created', 'updated', 'deleted', 'moved', 'restored', 'purged'],
  /** Native rich-text document content (the `docs` table). */
  doc: ['created', 'updated', 'deleted'],
} as const;
