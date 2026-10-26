/**
 * Deep links from a record chat to the record in its own mobile app. Only the
 * apps whose URL scheme and routes exist today:
 *
 * - WeldCRM (`weldcrm`, apps/mobile/weldcrm-app): `company/[id]`, `person/[id]`
 * - WeldFlow (`weldflow`, apps/mobile/weldflow-app): `project/[projectId]`,
 *   `task/[projectId]/[taskId]` (a task needs its project's id)
 *
 * Domains have no mobile app, so they get no link.
 */

export type RecordApp = 'WeldCRM' | 'WeldFlow';

export interface RecordAppLink {
  app: RecordApp;
  url: string;
}

/** The app a record type opens in, or null when there is none. */
export function recordAppFor(type: string): RecordApp | null {
  switch (type) {
    case 'company':
    case 'person':
      return 'WeldCRM';
    case 'project':
    case 'task':
      return 'WeldFlow';
    default:
      return null;
  }
}

/** A task's link needs its project, which only the record detail has. */
export function linkNeedsDetail(type: string): boolean {
  return type === 'task';
}

/**
 * The URL that opens a record in its app, or null when there is no app for
 * the type, or (a task) its project is not known.
 */
export function recordAppLink(
  type: string,
  entityId: string,
  detail?: { projectId?: string | null } | null,
): RecordAppLink | null {
  const id = encodeURIComponent(entityId);
  switch (type) {
    case 'company':
      return { app: 'WeldCRM', url: `weldcrm://company/${id}` };
    case 'person':
      return { app: 'WeldCRM', url: `weldcrm://person/${id}` };
    case 'project':
      return { app: 'WeldFlow', url: `weldflow://project/${id}` };
    case 'task': {
      const projectId = detail?.projectId;
      if (!projectId) return null;
      return { app: 'WeldFlow', url: `weldflow://task/${encodeURIComponent(projectId)}/${id}` };
    }
    default:
      return null;
  }
}
