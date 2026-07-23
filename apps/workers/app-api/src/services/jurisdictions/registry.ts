import type { JurisdictionAdapter } from './types';
import { nlAdapter } from './nl';

const adapters: Record<string, JurisdictionAdapter> = {
  NL: nlAdapter,
};

export function getAdapter(code: string): JurisdictionAdapter {
  const adapter = adapters[code.toUpperCase()];
  if (!adapter) {
    throw new Error(
      `No JurisdictionAdapter registered for '${code}'. Register it in services/jurisdictions/registry.ts.`,
    );
  }
  return adapter;
}

export function hasAdapter(code: string): boolean {
  return Boolean(adapters[code.toUpperCase()]);
}

export function listJurisdictions(): Array<{ code: string; name: string }> {
  return Object.values(adapters).map((a) => ({ code: a.code, name: a.name }));
}
