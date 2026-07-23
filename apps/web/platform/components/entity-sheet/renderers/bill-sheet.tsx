import { BillPanel } from '@/components/objects/bill';
import type { EntitySheetRendererProps } from '../types';

export function BillSheet({ entityId, onClose }: EntitySheetRendererProps) {
  return <BillPanel id={entityId} isOpen onClose={onClose} />;
}
