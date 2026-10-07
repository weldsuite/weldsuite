import { ProjectPanel } from '@/components/objects/project';
import type { EntitySheetRendererProps } from '../types';

export function ProjectSheet({ entityId, onClose }: Readonly<EntitySheetRendererProps>) {
  return <ProjectPanel id={entityId} isOpen onClose={onClose} />;
}
