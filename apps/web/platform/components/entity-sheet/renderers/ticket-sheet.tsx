import { TicketPanel } from '@/components/objects/ticket';
import type { EntitySheetRendererProps } from '../types';

export function TicketSheet({ entityId, onClose }: EntitySheetRendererProps) {
  return <TicketPanel id={entityId} isOpen onClose={onClose} />;
}
