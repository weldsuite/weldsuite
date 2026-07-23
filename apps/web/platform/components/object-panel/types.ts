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
   * Horizontal offset (pixels) from the right edge of the content area.
   * Populated by `ObjectPanelHost` so panels in a stack cascade left as
   * newer ones push in from the right. Top-of-stack gets `0`.
   */
  rightOffset?: number;
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
}

export interface ObjectPanelTabDescriptor {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  count?: number;
  hidden?: boolean;
}
