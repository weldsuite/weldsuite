/**
 * How the project tab bar combines the project's tab settings (what someone
 * may see, `@weldsuite/app-api-client/schemas/project-tabs`) with the user's
 * own preference (which of those they show, and in what order). The
 * preference is shared by every project, so a project that hides a tab must
 * not drop that tab from the preference the other projects read.
 */

/**
 * The tabs to show, in order: the user's saved list kept to the allowed tabs,
 * or every allowed tab when the user never saved one (or none of theirs is
 * allowed here).
 */
export function shownTabIds(saved: readonly string[] | null, allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed);
  const shown = (saved ?? []).filter((id) => allowedSet.has(id));
  return shown.length > 0 ? [...new Set(shown)] : [...allowed];
}

/**
 * The preference to save after the user changed the shown tabs to `next` in a
 * project that allows only `allowed`. Tabs the preference holds but this
 * project does not allow are kept at their place, so they still show in the
 * projects that allow them. Without a saved preference, `defaults` (every tab,
 * in the default order) stands in for it.
 */
export function nextTabPreference(
  saved: readonly string[] | null,
  defaults: readonly string[],
  next: readonly string[],
  allowed: readonly string[],
): string[] {
  const allowedSet = new Set(allowed);
  const base = saved ?? defaults;
  const result = [...next];
  base.forEach((id, index) => {
    if (allowedSet.has(id) || result.includes(id)) return;
    // Right after the nearest tab before it that is still in the list.
    let at = 0;
    for (let before = index - 1; before >= 0; before--) {
      const position = result.indexOf(base[before]);
      if (position !== -1) {
        at = position + 1;
        break;
      }
    }
    result.splice(at, 0, id);
  });
  return result;
}

/** The tab a pathname belongs to (the project root is the tasks tab). */
export function activeTabFor(pathname: string, projectId: string): string {
  const basePath = `/weldflow/project/${projectId}`;
  if (pathname === basePath) return 'tasks';
  const segment = pathname.replace(basePath, '').split('/')[1];
  return segment || 'tasks';
}
