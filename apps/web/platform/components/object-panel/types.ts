import type { ComponentType } from 'react';

/**
 * Object types known to the panel registry. Permissive `string` so callers
 * can register new types without modifying this union — the registry is the
 * single source of truth at runtime.
 */
export type ObjectType =
  | 'customer'
  | 'contact'
  | 'deal'
  | 'task'
  | 'product'
  | 'order'
  | (string & {});

export interface ObjectPanelComponentProps {
  id: string;
  isOpen: boolean;
  onClose: () => void;
  /** Set when this panel was opened on top of another (back chevron). */
  onBack?: () => void;
  /** Optional initial tab — supports deep-links like `?open=cus_x&tab=contacts`. */
  initialTab?: string;
  /**
   * Controlled mode + change handler. When the host renders the panel from a
   * stack, these are populated so the panel's expand button toggles the
   * entry in the stack (and, via the URL sync, the address bar).
   */
  mode?: 'panel' | 'fullscreen';
  onModeChange?: (next: 'panel' | 'fullscreen') => void;
  /**
   * Previous / next object in the list the panel was opened from. Set by the
   * host when that list is known; `useObjectPanelShell` turns it into the
   * header arrows.
   */
  navigation?: ObjectPanelNavigation;
}

export interface ObjectPanelNavigation {
  /** Undefined at the start of the list. */
  onPrevious?: () => void;
  /** Undefined at the end of the list (nothing more to load). */
  onNext?: () => void;
}

export interface ObjectPanelDefinition {
  type: ObjectType;
  /** Display label used by the host / devtools / future breadcrumbs. */
  label: string;
  /** The actual panel component. */
  component: ComponentType<ObjectPanelComponentProps>;
}

export interface ObjectPanelHandle {
  type: ObjectType;
  id: string;
  initialTab?: string;
  /** Per-panel mode — each entry in the stack can be panel or fullscreen. */
  mode: 'panel' | 'fullscreen';
  /** Stack position — opening a child panel pushes a new handle. */
  depth: number;
  /**
   * The list the panel was opened from (see `use-object-panel-navigation`),
   * captured at open so previous / next keep working once that list is gone,
   * e.g. a related list in the panel underneath. Not part of the URL.
   */
  openedFrom?: ObjectPanelListSnapshot;
}

export interface ObjectPanelRef {
  type: ObjectType;
  id: string;
}

export interface ObjectPanelListSnapshot {
  /** The registration it was taken from, to follow it while it's mounted. */
  sourceKey: string;
  objects: readonly ObjectPanelRef[];
}

export interface ObjectPanelTabDescriptor {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  count?: number;
  hidden?: boolean;
}
