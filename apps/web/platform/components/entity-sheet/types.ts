import type { ComponentType } from 'react';
import type { SearchEntityType } from '@weldsuite/core-api-client/schemas/search';

export type EntitySheetType = SearchEntityType;

export type EntitySheetView = 'default' | 'full';

export interface EntitySheetRendererProps {
  entityType: EntitySheetType;
  entityId: string;
  view: EntitySheetView;
  onClose: () => void;
  onToggleView: () => void;
  /** Full-page route for this entity, if it has one. Absent for entities
   *  (lead, opportunity) that are viewed only through the sheet. */
  openHref?: string;
}

type EntitySheetRenderer = ComponentType<EntitySheetRendererProps>;

export type EntitySheetRegistry = Partial<Record<EntitySheetType, EntitySheetRenderer>>;

export interface EntitySheetTarget {
  type: EntitySheetType;
  id: string;
}
