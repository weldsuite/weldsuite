/**
 * Values an action's config form shows as pre-selected (a Select rendered with
 * `config.method || 'GET'`) but which a freshly added step does not yet carry.
 * A Select only fires on a *change*, so choosing the value it already shows
 * (GET) never stored it, and the step stayed incomplete in the checklist.
 *
 * New steps start with these stored, so what the form displays is what is
 * saved. Keep in step with the `|| 'default'` fallbacks of the matching forms
 * in components/action-config-form.tsx.
 */
export const ACTION_INPUT_DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  http_request: { method: 'GET' },
  condition: { operator: 'eq' },
  create_customer: { status: 'active' },
  log_activity: { type: 'note' },
  create_task: { priority: 'medium' },
  send_notification: { category: 'task', severity: 'info' },
};

/** `config` with the action's displayed defaults filled in; values already set are kept. */
export function withActionDefaults(actionType: string, config: Record<string, unknown> = {}): Record<string, unknown> {
  const defaults = Object.hasOwn(ACTION_INPUT_DEFAULTS, actionType) ? ACTION_INPUT_DEFAULTS[actionType] : undefined;
  if (!defaults) return config;
  const merged: Record<string, unknown> = { ...config };
  for (const [key, value] of Object.entries(defaults)) {
    if (merged[key] === undefined || merged[key] === null || merged[key] === '') merged[key] = value;
  }
  return merged;
}
