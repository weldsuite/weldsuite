import { LeadPanel } from '@/components/objects/lead';
import type { EntitySheetRendererProps } from '../types';

export function LeadSheet({ entityId, onClose }: Readonly<EntitySheetRendererProps>) {
  return <LeadPanel id={entityId} isOpen onClose={onClose} />;
}
