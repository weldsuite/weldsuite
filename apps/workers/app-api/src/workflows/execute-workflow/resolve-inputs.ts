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

export function resolveInputs(
  inputs: Record<string, unknown>,
  previousResults: Record<string, unknown>,
  triggerData: unknown,
  variables: Record<string, unknown>,
  contactData: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(inputs)) {
    if (typeof value === 'string') {
      if (value.includes('{{') && value.includes('}}')) {
        resolved[key] = value.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
          const trimmedPath = path.trim();

          if (trimmedPath.startsWith('steps.')) {
            const [, stepId, ...rest] = trimmedPath.split('.');
            const stepOutput = previousResults[stepId] as Record<string, unknown>;
            const result = rest.reduce((obj: any, prop: string) => obj?.[prop], stepOutput);
            if (result !== undefined) return String(result);
            console.warn(`Unresolved template: ${match}`);
            return '';
          } else if (trimmedPath.startsWith('trigger.')) {
            const props = trimmedPath.slice(8).split('.');
            const result = props.reduce((obj: any, prop: string) => obj?.[prop], triggerData);
            if (result !== undefined) return String(result);
            console.warn(`Unresolved template: ${match}`);
            return '';
          } else if (trimmedPath.startsWith('variables.')) {
            const varName = trimmedPath.slice(10);
            const result = variables[varName];
            if (result !== undefined) return String(result);
            console.warn(`Unresolved template: ${match}`);
            return '';
          } else if (trimmedPath.startsWith('contact.')) {
            const prop = trimmedPath.slice(8);
            const result = contactData[prop];
            if (result !== undefined) return String(result);
            console.warn(`Unresolved template: ${match}`);
            return '';
          } else {
            console.warn(`Unresolved template: ${match}`);
            return '';
          }
        });

        // If the entire value was a single expression, preserve original type
        if (value.match(/^\{\{[^}]+\}\}$/)) {
          const path = value.slice(2, -2).trim();
          if (path.startsWith('steps.')) {
            const [, stepId, ...rest] = path.split('.');
            const stepOutput = previousResults[stepId] as Record<string, unknown>;
            const result = rest.reduce((obj: any, prop: string) => obj?.[prop], stepOutput);
            if (result !== undefined) resolved[key] = result;
          } else if (path.startsWith('trigger.')) {
            const props = path.slice(8).split('.');
            const result = props.reduce((obj: any, prop: string) => obj?.[prop], triggerData);
            if (result !== undefined) resolved[key] = result;
          } else if (path.startsWith('variables.')) {
            const varName = path.slice(10);
            const result = variables[varName];
            if (result !== undefined) resolved[key] = result;
          } else if (path.startsWith('contact.')) {
            const prop = path.slice(8);
            const result = contactData[prop];
            if (result !== undefined) resolved[key] = result;
          }
        }
      } else {
        resolved[key] = value;
      }
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      resolved[key] = resolveInputs(
        value as Record<string, unknown>,
        previousResults,
        triggerData,
        variables,
        contactData,
      );
    } else if (Array.isArray(value)) {
      resolved[key] = value.map((item) => {
        if (typeof item === 'object' && item !== null) {
          return resolveInputs(
            item as Record<string, unknown>,
            previousResults,
            triggerData,
            variables,
            contactData,
          );
        }
        return item;
      });
    } else {
      resolved[key] = value;
    }
  }

  return resolved;
}
