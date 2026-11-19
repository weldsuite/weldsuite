import { ChartNoAxesGantt, SquareActivity, Video } from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/** Object-panel type of a WeldPanel person, the `stack=` value of its deep links. */
export const PANEL_PERSON_TYPE = 'panel_person';

export type PanelPersonTabId = 'overview' | 'activity' | 'recordings';

export const PANEL_PERSON_TAB_ICONS: Record<PanelPersonTabId, ObjectPanelTabDescriptor['icon']> = {
  overview: ChartNoAxesGantt,
  activity: SquareActivity,
  recordings: Video,
};

export function isPanelPersonTabId(value: string | undefined): value is PanelPersonTabId {
  return !!value && Object.hasOwn(PANEL_PERSON_TAB_ICONS, value);
}

/**
 * A person is a distinct id within a project, so the panel id carries both:
 * `<projectId>~<distinct id, URI-encoded>`. The encoding keeps `:` and `,` out
 * of the id, which the `stack=` URL splits on. An empty project means "the
 * project picked in the sidebar".
 */
export function panelPersonId(projectId: string, distinctId: string): string {
  return `${projectId}~${encodeURIComponent(distinctId)}`;
}

export function parsePanelPersonId(id: string): { projectId: string; distinctId: string } {
  const split = id.indexOf('~');
  if (split === -1) return { projectId: '', distinctId: id };
  return { projectId: id.slice(0, split), distinctId: decodeURIComponent(id.slice(split + 1)) };
}

/**
 * Where the old profile URL now lands: the Users list with the person's panel
 * open in fullscreen, on the tab the link asked for.
 */
export function panelPersonHref(projectId: string, distinctId: string, tab?: string): string {
  const parts = [PANEL_PERSON_TYPE, encodeURIComponent(panelPersonId(projectId, distinctId)), 'fullscreen'];
  if (isPanelPersonTabId(tab)) parts.push(`tab=${tab}`);
  return `/weldpanel/users?stack=${parts.join(':')}`;
}
