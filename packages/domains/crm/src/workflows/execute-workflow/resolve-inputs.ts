/**
 * Template variable resolution for workflow step inputs.
 *
 * Ported verbatim from apps/api-worker/src/workflows/execute-workflow/
 * resolve-inputs.ts (W4 legacy-worker phase-out). No worker-specific imports.
 *
 * Supports:
 *  - {{steps.stepId.field}} — previous step output
 *  - {{trigger.field}}      — trigger data
 *  - {{variables.name}}     — workflow variables
 *  - {{contact.field}}      — contact/customer data
 */
import { asText } from '@weldsuite/text';

interface ResolveSources {
  previousResults: Record<string, unknown>;
  triggerData: unknown;
  variables: Record<string, unknown>;
  contactData: Record<string, unknown>;
}

function getNested(root: unknown, props: string[]): unknown {
  return props.reduce<unknown>(
    (obj, prop) => (obj as Record<string, unknown> | null | undefined)?.[prop],
    root,
  );
}

/** Look up a `steps.` / `trigger.` / `variables.` / `contact.` reference; undefined when unknown. */
function lookupReference(path: string, sources: ResolveSources): unknown {
  if (path.startsWith('steps.')) {
    const [, stepId, ...rest] = path.split('.');
    return getNested(sources.previousResults[stepId], rest);
  }
  if (path.startsWith('trigger.')) return getNested(sources.triggerData, path.slice(8).split('.'));
  if (path.startsWith('variables.')) return sources.variables[path.slice(10)];
  if (path.startsWith('contact.')) return sources.contactData[path.slice(8)];
  return undefined;
}

function resolveString(value: string, sources: ResolveSources): unknown {
  if (!(value.includes('{{') && value.includes('}}'))) return value;

  let resolved: unknown = value.replace(/\{\{([^{}]+)\}\}/g, (match, path: string) => {
    const result = lookupReference(path.trim(), sources);
    if (result !== undefined) return asText(result);
    console.warn(`Unresolved template: ${match}`);
    return '';
  });

  // If the entire value was a single expression, preserve original type
  if (/^\{\{[^{}]+\}\}$/.test(value)) {
    const result = lookupReference(value.slice(2, -2).trim(), sources);
    if (result !== undefined) resolved = result;
  }
  return resolved;
}

function resolveValue(value: unknown, sources: ResolveSources): unknown {
  if (typeof value === 'string') return resolveString(value, sources);
  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === 'object' && item !== null
        ? resolveWithSources(item as Record<string, unknown>, sources)
        : item,
    );
  }
  if (typeof value === 'object' && value !== null) {
    return resolveWithSources(value as Record<string, unknown>, sources);
  }
  return value;
}

function resolveWithSources(
  inputs: Record<string, unknown>,
  sources: ResolveSources,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    resolved[key] = resolveValue(value, sources);
  }
  return resolved;
}

export function resolveInputs(
  inputs: Record<string, unknown>,
  previousResults: Record<string, unknown>,
  triggerData: unknown,
  variables: Record<string, unknown>,
  contactData: Record<string, unknown>,
): Record<string, unknown> {
  return resolveWithSources(inputs, { previousResults, triggerData, variables, contactData });
}
