import { InvoicePanel } from '@/components/objects/invoice';
import type { EntitySheetRendererProps } from '../types';

export function InvoiceSheet({ entityId, onClose }: Readonly<EntitySheetRendererProps>) {
  return <InvoicePanel id={entityId} isOpen onClose={onClose} />;
}
