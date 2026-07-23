/**
 * Human-readable labels for WeldApps API scopes (e.g. `contacts:read` ->
 * "Read your contacts"). Backed by the `weldapps.scopes` i18n namespace so
 * translators can extend it; unknown scopes fall back to the raw string so a
 * newly-introduced scope never renders as a blank line in a consent dialog.
 */
export function formatScopeLabel(scopeLabels: Record<string, string>, scope: string): string {
  return scopeLabels[scope] ?? scope;
}
