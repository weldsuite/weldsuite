import type { FunctionSpec } from '../types';

const registry = new Map<string, FunctionSpec>();

export function registerFunctions(specs: readonly FunctionSpec[]): void {
  for (const spec of specs) registry.set(spec.name.toUpperCase(), spec);
}

export function getFunction(name: string): FunctionSpec | undefined {
  return registry.get(name.toUpperCase());
}

/** Every registered function name, sorted (autocomplete, docs). */
export function functionNames(): string[] {
  return [...registry.keys()].sort();
}
