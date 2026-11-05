/**
 * WeldFlow project tab visibility: which of a project's tabs (Tasks, Gantt,
 * Finance, ...) a person sees. Stored in `projects.settings.tabs`
 * (`ProjectTabSettings` in `@weldsuite/db/schema/project-settings`) and
 * written whole by `PUT /api/projects/:id/tabs`.
 *
 * Three layers, applied by `hiddenProjectTabs`:
 *   1. `hidden`: off for the whole project, admins included.
 *   2. `roles.member` / `roles.viewer`: the default for that project role.
 *   3. `members`: one person's own list, in place of their role's default.
 * Project owners, admins, the project manager and workspace admins skip 2 and
 * 3, and always keep the Settings tab, so nobody locks themselves out.
 *
 * Every list names HIDDEN tabs, so a tab added later shows until someone turns
 * it off. Tab ids are not checked against a fixed list on the server: an
 * unknown id is ignored by the client.
 *
 * This shapes the tab bar and redirects a hidden tab's URL; it is not an
 * access boundary for the data behind a tab (tasks, files, ... stay reachable
 * through My Tasks, search and the API).
 */

import { z } from 'zod';

/** The project tabs, in their default order. `table` is the Sheets tab. */
export const PROJECT_TAB_IDS = [
  'tasks',
  'gantt',
  'table',
  'whiteboard',
  'workload',
  'files',
  'timesheet',
  'pipeline',
  'documents',
  'goals',
  'raid',
  'governance',
  'scope',
  'finance',
  'analytics',
  'settings',
] as const;
export type ProjectTabId = (typeof PROJECT_TAB_IDS)[number];

/** The tab a project admin always keeps. */
export const ALWAYS_VISIBLE_ADMIN_TAB = 'settings';

/** The most tab ids one list may hold. */
export const MAX_TAB_IDS = 50;
/** The most members with their own list. */
export const MAX_TAB_MEMBERS = 1000;

const tabId = z.string().min(1).max(40);
const tabList = z.array(tabId).max(MAX_TAB_IDS);

/** The body of `PUT /api/projects/:id/tabs`, and what it answers. */
export const projectTabSettingsSchema = z
  .object({
    hidden: tabList,
    roles: z.object({ member: tabList, viewer: tabList }).strict(),
    members: z
      .array(z.object({ userId: z.string().min(1).max(255), hidden: tabList }).strict())
      .max(MAX_TAB_MEMBERS),
  })
  .strict();
export type ProjectTabSettings = z.infer<typeof projectTabSettingsSchema>;
export type ProjectTabRole = keyof ProjectTabSettings['roles'];

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * The stored form of a valid body: each list without repeats, and one entry
 * per member (the first one given). The server stores and answers this.
 */
export function normalizeProjectTabSettings(input: ProjectTabSettings): ProjectTabSettings {
  const seen = new Set<string>();
  const members: ProjectTabSettings['members'] = [];
  for (const entry of input.members) {
    if (seen.has(entry.userId)) continue;
    seen.add(entry.userId);
    members.push({ userId: entry.userId, hidden: unique(entry.hidden) });
  }
  return {
    hidden: unique(input.hidden),
    roles: { member: unique(input.roles.member), viewer: unique(input.roles.viewer) },
    members,
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? unique(value.filter((item): item is string => typeof item === 'string')) : [];
}

/**
 * `projects.settings.tabs` read leniently: a project that never set it, or a
 * malformed value, reads as nothing hidden.
 */
export function projectTabSettingsOf(settings: unknown): ProjectTabSettings {
  const tabs = (settings as { tabs?: unknown } | null | undefined)?.tabs;
  if (!tabs || typeof tabs !== 'object') {
    return { hidden: [], roles: { member: [], viewer: [] }, members: [] };
  }
  const raw = tabs as { hidden?: unknown; roles?: { member?: unknown; viewer?: unknown } | null; members?: unknown };
  const members = Array.isArray(raw.members)
    ? raw.members.flatMap((entry: unknown) => {
        const member = entry as { userId?: unknown; hidden?: unknown } | null;
        return member && typeof member.userId === 'string'
          ? [{ userId: member.userId, hidden: stringList(member.hidden) }]
          : [];
      })
    : [];
  return normalizeProjectTabSettings({
    hidden: stringList(raw.hidden),
    roles: { member: stringList(raw.roles?.member), viewer: stringList(raw.roles?.viewer) },
    members,
  });
}

/** True when the settings hide anything for anyone. */
export function hasTabRestrictions(settings: ProjectTabSettings): boolean {
  return (
    settings.hidden.length > 0 ||
    settings.roles.member.length > 0 ||
    settings.roles.viewer.length > 0 ||
    settings.members.length > 0
  );
}

/** The project role whose default applies to a non-admin: viewers, else members. */
export function tabRoleOf(role: string | null | undefined): ProjectTabRole {
  return role?.toLowerCase() === 'viewer' ? 'viewer' : 'member';
}

export interface ProjectTabViewer {
  userId: string | null | undefined;
  /** The project role (`owner`, `admin`, `member`, `viewer`), or null. */
  role: string | null | undefined;
  /** Owner / admin / project manager / workspace admin (`GET /projects/:id/permissions`). */
  isAdmin: boolean;
}

/** The tabs one person does not see in this project. */
export function hiddenProjectTabs(settings: ProjectTabSettings, viewer: ProjectTabViewer): Set<string> {
  const hidden = new Set(settings.hidden);
  if (viewer.isAdmin) {
    hidden.delete(ALWAYS_VISIBLE_ADMIN_TAB);
    return hidden;
  }
  const own = viewer.userId ? settings.members.find((entry) => entry.userId === viewer.userId) : undefined;
  for (const id of own ? own.hidden : settings.roles[tabRoleOf(viewer.role)]) hidden.add(id);
  return hidden;
}
