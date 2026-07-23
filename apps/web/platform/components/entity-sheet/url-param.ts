import { SEARCH_ENTITY_TYPES_SET } from '@weldsuite/core-api-client/schemas/search';
import type { EntitySheetTarget, EntitySheetType, EntitySheetView } from './types';

export const ENTITY_SHEET_PARAM = 'entity';
export const ENTITY_SHEET_VIEW_PARAM = 'view';

/** Re-exported for callers outside the entity-sheet folder (chat token classifier, etc.). */
export const VALID_TYPES = SEARCH_ENTITY_TYPES_SET;

export function encodeEntitySheetTarget(type: EntitySheetType, id: string): string {
  return `${type}:${id}`;
}

export function decodeEntitySheetParam(raw: string | null | undefined): EntitySheetTarget | null {
  if (!raw) return null;
  const sep = raw.indexOf(':');
  if (sep <= 0) return null;
  const type = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!id || !VALID_TYPES.has(type)) return null;
  return { type: type as EntitySheetType, id };
}

export function decodeEntitySheetView(raw: unknown): EntitySheetView {
  return raw === 'full' ? 'full' : 'default';
}
