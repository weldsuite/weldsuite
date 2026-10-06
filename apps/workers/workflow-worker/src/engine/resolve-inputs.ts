/**
 * Template variable resolution for workflow step inputs.
 *
 * Expands `{{...}}` expressions inside string inputs (recursing into nested
 * objects and arrays):
 *   - {{steps.stepId.field.path}} — a previous step's output
 *   - {{trigger.field.path}}      — trigger data
 *   - {{variables.name}}          — a workflow/global variable
 *   - {{contact.field}}           — contact/customer context
 *   - {{loop.item}} / {{loop.index}} — the current item inside a loop body
 *
 * A value that is a single whole expression preserves the resolved value's
 * original type; an expression embedded in surrounding text coerces to string;
 * an unresolved expression becomes an empty string in embedded position.
 *
 * `options.escapeHtmlKeys` names top-level keys whose value is an HTML
 * template (e.g. send_email's `body`): values substituted into them are
 * HTML-escaped so record data can't inject markup, while the template's own
 * markup is left intact.
 */

export interface LoopScope {
  item: unknown;
  index: number;
}

export interface ResolveInputsOptions {
  escapeHtmlKeys?: readonly string[];
  /** Set inside a loop body: what `{{loop.item}}` / `{{loop.index}}` resolve to. */
  loop?: LoopScope;
}

/** Escape text for safe inclusion in HTML (email bodies). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const identity = (value: string) => value;

interface TemplateScope {
  previousResults: Record<string, unknown>;
  triggerData: unknown;
  variables: Record<string, unknown>;
  contactData: Record<string, unknown>;
  loop?: LoopScope;
}

/** Walk a dotted property path (already split) through a value, tolerating gaps. */
function getPath(root: unknown, props: string[]): unknown {
  return props.reduce<unknown>((obj, prop) => (obj as Record<string, unknown> | null | undefined)?.[prop], root);
}

/** Look up a `steps.` / `trigger.` / `variables.` / `contact.` path; undefined when unresolved. */
function lookupTemplatePath(path: string, scope: TemplateScope): unknown {
  if (path.startsWith('steps.')) {
    const [, stepId, ...rest] = path.split('.');
    return getPath(scope.previousResults[stepId], rest);
  }
  if (path.startsWith('trigger.')) return getPath(scope.triggerData, path.slice(8).split('.'));
  if (path.startsWith('variables.')) return scope.variables[path.slice(10)];
  if (path.startsWith('contact.')) return scope.contactData[path.slice(8)];
  if (path.startsWith('loop.') && scope.loop) {
    const [, prop, ...rest] = path.split('.');
    if (prop === 'index') return scope.loop.index;
    if (prop === 'item') return getPath(scope.loop.item, rest);
  }
  return undefined;
}

/**
 * Text form of a resolved value spliced into a larger string: objects and
 * arrays as compact JSON (not `[object Object]`), null as empty.
 */
function stringifyForTemplate(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** Expand `{{...}}` expressions in one string input. */
function resolveStringInput(
  key: string,
  value: string,
  scope: TemplateScope,
  options: ResolveInputsOptions | undefined,
): unknown {
  if (!(value.includes('{{') && value.includes('}}'))) return value;

  const escapeValue = options?.escapeHtmlKeys?.includes(key) ? escapeHtml : identity;
  let resolved: unknown = value.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
    const result = lookupTemplatePath(String(path).trim(), scope);
    if (result !== undefined) return escapeValue(stringifyForTemplate(result));
    console.warn(`Unresolved template: ${match}`);
    return '';
  });

  // If the entire value was a single expression, preserve original type.
  if (/^\{\{[^}]+\}\}$/.test(value)) {
    const result = lookupTemplatePath(value.slice(2, -2).trim(), scope);
    if (result !== undefined) resolved = typeof result === 'string' ? escapeValue(result) : result;
  }
  return resolved;
}

/** Recurse into nested objects and arrays (no per-key escaping options). */
function resolveNestedInput(value: unknown, scope: TemplateScope): unknown {
  const recurse = (obj: Record<string, unknown>) =>
    resolveInputs(
      obj,
      scope.previousResults,
      scope.triggerData,
      scope.variables,
      scope.contactData,
      scope.loop ? { loop: scope.loop } : undefined,
    );
  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === 'object' && item !== null ? recurse(item as Record<string, unknown>) : item,
    );
  }
  if (typeof value === 'object' && value !== null) return recurse(value as Record<string, unknown>);
  return value;
}

export function resolveInputs(
  inputs: Record<string, unknown>,
  previousResults: Record<string, unknown>,
  triggerData: unknown,
  variables: Record<string, unknown>,
  contactData: Record<string, unknown>,
  options?: ResolveInputsOptions,
): Record<string, unknown> {
  const scope: TemplateScope = { previousResults, triggerData, variables, contactData, loop: options?.loop };
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(inputs)) {
    resolved[key] =
      typeof value === 'string' ? resolveStringInput(key, value, scope, options) : resolveNestedInput(value, scope);
  }

  return resolved;
}
