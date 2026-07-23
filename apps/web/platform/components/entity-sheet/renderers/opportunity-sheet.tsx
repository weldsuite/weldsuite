import { OpportunityPanel } from '@/components/objects/opportunity';
import type { EntitySheetRendererProps } from '../types';

/**
 * Opportunity renderer for the EntitySheet — delegates to the unified
 * `OpportunityPanel` (same panel `useObjectPanel().open({ type: 'opportunity' })`
 * opens). The panel fetches its own data, so this file is just a thin adapter
 * between the entity-sheet host props and the panel's `ObjectPanelComponentProps`.
 */
export function OpportunitySheet({ entityId, onClose }: EntitySheetRendererProps) {
  return <OpportunityPanel id={entityId} isOpen onClose={onClose} />;
}
