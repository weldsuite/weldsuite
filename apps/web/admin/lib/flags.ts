/**
 * Feature flags on the Kubernetes editions: the catalog in
 * `@weldsuite/feature-flags` and the values in master
 * `feature_flag_overrides`, which the Rust server reads every 30 seconds
 * (`FEATURE_FLAGS=master-db`). A workspace's row wins over the row for
 * everyone (`workspace_id` null), which wins over the catalog default.
 * Global evaluates flags in Cloudflare Flagship instead.
 *
 * Pure: the console's screen and actions and their tests share it.
 */

import { FLAGS, type FlagDefinition, type FlagKey } from '@weldsuite/feature-flags/flags';

export type FlagType = FlagDefinition['type'];

export interface CatalogFlag {
  key: FlagKey;
  type: FlagType;
  default: unknown;
}

/** Every flag in the catalog, by key. */
export function catalogFlags(): CatalogFlag[] {
  return (Object.keys(FLAGS) as FlagKey[])
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({ key, type: FLAGS[key].type, default: FLAGS[key].default }));
}

export function catalogFlag(key: string): CatalogFlag | null {
  return Object.hasOwn(FLAGS, key) ? catalogFlags().find((flag) => flag.key === key) ?? null : null;
}

const MAX_TEXT = 500;
const MAX_JSON = 2000;

export type ParsedFlagValue =
  | { ok: true; value: unknown }
  | { ok: false; error: 'notBoolean' | 'notNumber' | 'notJson' | 'tooLong' };

/** A value typed in the console, as its flag's type: `true`/`false`, a finite number, text, or JSON. */
export function parseFlagValue(type: FlagType, input: string): ParsedFlagValue {
  const text = input.trim();
  switch (type) {
    case 'boolean':
      if (text === 'true') return { ok: true, value: true };
      if (text === 'false') return { ok: true, value: false };
      return { ok: false, error: 'notBoolean' };
    case 'number': {
      const value = Number(text);
      return text !== '' && Number.isFinite(value) ? { ok: true, value } : { ok: false, error: 'notNumber' };
    }
    case 'string':
      return input.length <= MAX_TEXT ? { ok: true, value: input } : { ok: false, error: 'tooLong' };
    case 'json': {
      if (text.length > MAX_JSON) return { ok: false, error: 'tooLong' };
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        return { ok: false, error: 'notJson' };
      }
    }
  }
}

/** A stored value as the console shows it and pre-fills the editor with. */
export function formatFlagValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value);
}
