import { BillPanel } from '@/components/objects/bill';
import type { EntitySheetRendererProps } from '../types';

export function BillSheet({ entityId, onClose }: Readonly<EntitySheetRendererProps>) {
  return <BillPanel id={entityId} isOpen onClose={onClose} />;
}
