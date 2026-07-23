import { DomainPanel } from '@/components/objects/domain';
import type { EntitySheetRendererProps } from '../types';

export function DomainSheet({ entityId, view, onClose, onToggleView }: EntitySheetRendererProps) {
  return (
    <DomainPanel
      id={entityId}
      isOpen
      onClose={onClose}
      mode={view === 'full' ? 'fullscreen' : 'panel'}
      onModeChange={() => onToggleView()}
    />
  );
}
