/**
 * Where a 400 `VALIDATION_ERROR` from a draft save points. The backend sends
 * `details.fields` as document path → message; the path is read leniently,
 * in dotted (`templates.home.2.settings.heading`), bracketed
 * (`templates.home[2].settings.heading`) and JSON Pointer
 * (`/templates/home/2/settings/heading`) form.
 */

import type { ListName } from '@weldsuite/storefront-theme/catalog';

export interface FieldErrorLocation {
  /** The list of the section, for section and block settings. */
  list?: ListName;
  sectionIndex?: number;
  blockIndex?: number;
  /** The setting id (in the section's or block's settings, or the key under `theme.settings`, `seo` or `settings`). */
  settingId?: string;
  /** For the document's own fields. */
  area?: 'theme' | 'seo' | 'settings';
}

function index(token: string | undefined): number | undefined {
  if (token === undefined || !/^\d+$/.test(token)) return undefined;
  return Number(token);
}

export function parseFieldPath(path: string): FieldErrorLocation {
  const tokens = path.split(/[.[\]/]+/).filter(Boolean);
  if (tokens[0] === 'document') tokens.shift();
  const [root, ...rest] = tokens;
  if (root === 'theme') return { area: 'theme', settingId: rest[0] === 'settings' ? rest.slice(1).join('.') : rest.join('.') };
  if (root === 'seo' || root === 'settings') return { area: root, settingId: rest.join('.') || undefined };
  if (root !== 'templates' && root !== 'groups' && root !== 'sections') return {};

  let cursor = 0;
  const location: FieldErrorLocation = {};
  if (root === 'sections') {
    location.list = 'content';
  } else {
    location.list = rest[0] as ListName;
    cursor = 1;
  }
  location.sectionIndex = index(rest[cursor]);
  cursor += 1;
  if (rest[cursor] === 'blocks') {
    location.blockIndex = index(rest[cursor + 1]);
    cursor += 2;
  }
  if (rest[cursor] === 'settings' && rest[cursor + 1]) location.settingId = rest[cursor + 1];
  return location;
}

/** The messages for one section's (or one of its blocks') settings, by setting id. */
export function settingErrors(
  fields: Record<string, string>,
  target: { list: ListName; sectionIndex: number; blockIndex?: number },
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [path, message] of Object.entries(fields)) {
    const location = parseFieldPath(path);
    if (
      location.list === target.list &&
      location.sectionIndex === target.sectionIndex &&
      location.blockIndex === target.blockIndex &&
      location.settingId
    ) {
      errors[location.settingId] = message;
    }
  }
  return errors;
}
