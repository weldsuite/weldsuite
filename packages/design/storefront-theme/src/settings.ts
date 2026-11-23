/**
 * Typed reads of a section's (or block's) settings, with the catalog's
 * defaults and limits applied, so a section never trusts a value's shape.
 */

import { SECTION_CATALOG, type SettingDefinition } from './catalog';
import type { SettingValues } from './types';

export interface SettingsReader {
  /** A text-like setting; '' when missing or not a string. */
  text(id: string): string;
  bool(id: string): boolean;
  /** A number, clamped to the setting's min and max. */
  number(id: string): number;
  /** A list setting (`products`, `categories`); [] otherwise. */
  list(id: string): string[];
  /** A select's value when it is one of `allowed`, else the setting's default (or the first allowed). */
  choice<T extends string>(id: string, allowed: readonly T[]): T;
}

function reader(values: SettingValues, definitions: SettingDefinition[]): SettingsReader {
  const definition = (id: string) => definitions.find((setting) => setting.id === id);
  const raw = (id: string) => (id in values ? values[id] : definition(id)?.default);
  return {
    text(id) {
      const value = raw(id);
      if (typeof value === 'string') return value;
      return typeof value === 'number' ? String(value) : '';
    },
    bool(id) {
      const value = raw(id);
      return typeof value === 'boolean' ? value : definition(id)?.default === true;
    },
    number(id) {
      const setting = definition(id);
      let value = raw(id);
      if (typeof value === 'string' && value.trim() !== '') value = Number(value);
      let n = typeof value === 'number' && Number.isFinite(value) ? value : Number(setting?.default ?? 0);
      if (!Number.isFinite(n)) n = 0;
      if (setting?.min !== undefined) n = Math.max(setting.min, n);
      if (setting?.max !== undefined) n = Math.min(setting.max, n);
      return n;
    },
    list(id) {
      const value = raw(id);
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : [];
    },
    choice<T extends string>(id: string, allowed: readonly T[]): T {
      const value = raw(id);
      if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
      const fallback = definition(id)?.default;
      if (typeof fallback === 'string' && (allowed as readonly string[]).includes(fallback)) return fallback as T;
      return allowed[0] as T;
    },
  };
}

/** The settings of a section of `type`. */
export function sectionSettings(type: string, values: SettingValues | undefined): SettingsReader {
  return reader(values ?? {}, SECTION_CATALOG[type]?.settings ?? []);
}

/** The settings of a block of `blockType` in a section of `type`. */
export function blockSettings(type: string, blockType: string, values: SettingValues | undefined): SettingsReader {
  return reader(values ?? {}, SECTION_CATALOG[type]?.blocks[blockType]?.settings ?? []);
}
