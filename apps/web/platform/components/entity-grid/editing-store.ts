
import { useSyncExternalStore } from 'react';

export interface EditingCell {
  rowId: string;
  fieldId: string;
}

/**
 * External store for the currently-editing cell. Lives outside of React context so that
 * only the specific cells whose `isEditing` state changes re-render (old editing cell +
 * new editing cell), not every cell in the grid.
 */
let currentEditing: EditingCell | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): EditingCell | null {
  return currentEditing;
}

export function getEditingCellValue(): EditingCell | null {
  return currentEditing;
}

export function setEditingCellValue(next: EditingCell | null): void {
  if (
    next?.rowId === currentEditing?.rowId &&
    next?.fieldId === currentEditing?.fieldId
  ) {
    return;
  }
  currentEditing = next;
  listeners.forEach((l) => l());
}

function useEditingCell(): EditingCell | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Subscribe to whether a specific cell (rowId + fieldId) is the editing cell.
 * Only re-renders the consumer when the boolean flips, so other cells stay idle.
 */
export function useIsCellEditing(rowId: string, fieldId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () =>
      currentEditing?.rowId === rowId && currentEditing?.fieldId === fieldId,
    () => false,
  );
}
