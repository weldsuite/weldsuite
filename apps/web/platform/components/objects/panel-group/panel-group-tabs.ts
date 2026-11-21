import { ChartNoAxesGantt, SquareActivity, Users } from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/** Object-panel type of a WeldPanel group (a company, a workspace…), the `stack=` value of its deep links. */
export const PANEL_GROUP_TYPE = 'panel_group';

export type PanelGroupTabId = 'overview' | 'members' | 'activity';

export const PANEL_GROUP_TAB_ICONS: Record<PanelGroupTabId, ObjectPanelTabDescriptor['icon']> = {
  overview: ChartNoAxesGantt,
  members: Users,
  activity: SquareActivity,
};

export function isPanelGroupTabId(value: string | undefined): value is PanelGroupTabId {
  return !!value && Object.hasOwn(PANEL_GROUP_TAB_ICONS, value);
}

/** URI-encoding plus `~`, which `encodeURIComponent` leaves as it is. */
function encodePart(value: string): string {
  return encodeURIComponent(value).replace(/~/g, '%7E');
}

/**
 * A group is a key of a group type within a project, so the panel id carries
 * all three: `<projectId>~<type>~<key>`, type and key URI-encoded to keep `:`,
 * `,` and `~` out of it. An empty project means "the project picked in the
 * sidebar".
 */
export function panelGroupId(projectId: string, groupType: string, groupKey: string): string {
  return `${projectId}~${encodePart(groupType)}~${encodePart(groupKey)}`;
}

export function parsePanelGroupId(id: string): { projectId: string; groupType: string; groupKey: string } {
  const [projectId = '', groupType = '', groupKey = ''] = id.split('~');
  return { projectId, groupType: decodeURIComponent(groupType), groupKey: decodeURIComponent(groupKey) };
}

/**
 * Where the old group profile URL now lands: the Groups list of that type with
 * the group's panel open in fullscreen, on the tab the link asked for.
 */
export function panelGroupHref(projectId: string, groupType: string, groupKey: string, tab?: string): string {
  const parts = [PANEL_GROUP_TYPE, encodeURIComponent(panelGroupId(projectId, groupType, groupKey)), 'fullscreen'];
  if (isPanelGroupTabId(tab)) parts.push(`tab=${tab}`);
  return `/weldpanel/groups?type=${encodeURIComponent(groupType)}&stack=${parts.join(':')}`;
}
