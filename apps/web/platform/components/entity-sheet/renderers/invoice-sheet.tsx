import { InvoicePanel } from '@/components/objects/invoice';
import type { EntitySheetRendererProps } from '../types';

export function InvoiceSheet({ entityId, onClose }: EntitySheetRendererProps) {
  return <InvoicePanel id={entityId} isOpen onClose={onClose} />;
}
