/** The profile page of a group (`/weldpanel/groups/<type>/<key>`), for the current project. */
export function groupHref(groupType: string, groupKey: string, projectId: string): string {
  return `/weldpanel/groups/${encodeURIComponent(groupType)}/${encodeURIComponent(groupKey)}?project=${encodeURIComponent(projectId)}`;
}
