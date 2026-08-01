import { LayoutGrid } from 'lucide-react';
import type { ComponentType } from 'react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/**
 * Tab helpers for object panels that are NOT CRM records.
 *
 * `SimpleObjectPanel` defaults to the CRM tab set — Activity, Emails, Calls,
 * Notes, Meetings, Tasks, Files, Audit Log — and renders `ComingSoonTab` for
 * every one it can't fill. On a product, order or warehouse that's a row of
 * tabs that neither mean anything nor do anything.
 *
 * These helpers build a tab list containing only what the panel can actually
 * render. The `_shared/*-tab.tsx` components are no help here: they're typed
 * `entityKind: 'company' | 'person'` and query CRM surfaces.
 */
export interface FocusedTab extends ObjectPanelTabDescriptor {
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

/** The Details tab every panel starts with — it renders `fields` + `extras`. */
export function detailsTab(label: string): FocusedTab {
  return {
    id: 'overview',
    label,
    icon: LayoutGrid,
    required: true,
    defaultVisibleInPanel: true,
    defaultVisibleInFullscreen: true,
  };
}

export function extraTab(
  id: string,
  label: string,
  icon: ComponentType<{ className?: string }>,
): FocusedTab {
  return {
    id,
    label,
    icon,
    defaultVisibleInPanel: true,
    defaultVisibleInFullscreen: true,
  };
}

/**
 * A panel with nothing beyond its record: one Details tab, so the tab strip
 * collapses to a single entry instead of eight dead ones.
 */
export function detailsOnlyTabs(label: string): FocusedTab[] {
  return [detailsTab(label)];
}
