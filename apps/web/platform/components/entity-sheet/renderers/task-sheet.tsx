import { TaskPanel } from '@/components/objects/task';
import type { EntitySheetRendererProps } from '../types';

/**
 * Task renderer for the EntitySheet — delegates to the unified `TaskPanel`
 * (the same panel `useObjectPanel().open({ type: 'task' })` opens). The panel
 * fetches its own task + comments + subtasks + labels from app-api, so this
 * file is just a thin adapter between the entity-sheet host props and the
 * panel's `ObjectPanelComponentProps`.
 */
export function TaskSheet({ entityId, onClose }: EntitySheetRendererProps) {
  return <TaskPanel id={entityId} isOpen={true} onClose={onClose} />;
}
