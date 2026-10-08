import 'server-only';

import { masterSchema } from './db';

const APP_CATEGORIES = masterSchema.APP_CATEGORIES as readonly string[];

export type CatalogInput = {
  code?: unknown;
  name?: unknown;
  description?: unknown;
  icon?: unknown;
  category?: unknown;
  path?: unknown;
  overview?: unknown;
  features?: unknown;
  howItWorks?: unknown;
  isActive?: unknown;
  isPublished?: unknown;
  isBeta?: unknown;
  sortOrder?: unknown;
  version?: unknown;
  provider?: unknown;
  verified?: unknown;
  releasedAt?: unknown;
  websiteUrl?: unknown;
  documentationUrl?: unknown;
  contactUrl?: unknown;
};

export type ParsedHowItWorks = { title: string; description: string };

export interface ParsedCatalog {
  code: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  path: string;
  overview: string | null;
  features: string[];
  howItWorks: ParsedHowItWorks[];
  isActive: boolean;
  isPublished: boolean;
  isBeta: boolean;
  sortOrder: number;
  version: string;
  provider: string;
  verified: boolean;
  releasedAt: Date | null;
  websiteUrl: string | null;
  documentationUrl: string | null;
  contactUrl: string | null;
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

function parseOptionalUrl(
  value: unknown,
  label: string,
): { ok: true; data: string | null } | { ok: false; message: string } {
  if (value === null || value === '' || value === undefined) return { ok: true, data: null };
  if (!isStr(value)) return { ok: false, message: `${label} must be a string or null` };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, data: null };
  if (trimmed.length > 500) return { ok: false, message: `${label} max 500 chars` };
  try {
    new URL(trimmed);
  } catch {
    return { ok: false, message: `${label} must be a valid URL` };
  }
  return { ok: true, data: trimmed };
}

type ParsedOut = Partial<ParsedCatalog>;

/**
 * One validation step per field (or field group). Returns an error message,
 * or null when the field is valid (writing the parsed value into `out`).
 * Steps run in declaration order and the first error wins.
 */
type Section = (body: CatalogInput, out: ParsedOut, partial: boolean) => string | null;

function missingField(name: string, partial: boolean): string | null {
  return partial ? null : `${name} is required`;
}

const parseCode: Section = (body, out, partial) => {
  if (body.code === undefined) return missingField('code', partial);
  if (!isStr(body.code)) return 'code must be a string';
  const code = body.code.trim();
  if (!/^[a-z0-9_-]{2,50}$/.test(code)) return 'code must be 2–50 chars of [a-z0-9_-]';
  out.code = code;
  return null;
};

/** Required, non-blank text field with an optional max length (untrimmed). */
function requiredText(key: 'name' | 'description' | 'icon', maxLength?: number): Section {
  return (body, out, partial) => {
    const value = body[key];
    if (value === undefined) return missingField(key, partial);
    if (!isStr(value) || !value.trim()) return `${key} is required`;
    if (maxLength !== undefined && value.length > maxLength) return `${key} max ${maxLength} chars`;
    out[key] = value.trim();
    return null;
  };
}

const parseCategory: Section = (body, out, partial) => {
  if (body.category === undefined) return missingField('category', partial);
  if (!isStr(body.category) || !APP_CATEGORIES.includes(body.category)) {
    return `category must be one of: ${APP_CATEGORIES.join(', ')}`;
  }
  out.category = body.category;
  return null;
};

const parsePath: Section = (body, out, partial) => {
  if (body.path === undefined) return missingField('path', partial);
  if (!isStr(body.path) || !body.path.startsWith('/')) return 'path must start with /';
  if (body.path.length > 100) return 'path max 100 chars';
  out.path = body.path.trim();
  return null;
};

const parseOverview: Section = (body, out) => {
  if (body.overview === undefined) return null;
  if (body.overview === null || body.overview === '') {
    out.overview = null;
    return null;
  }
  if (!isStr(body.overview)) return 'overview must be a string or null';
  out.overview = body.overview;
  return null;
};

const parseFeatures: Section = (body, out, partial) => {
  if (body.features === undefined) {
    if (!partial) out.features = [];
    return null;
  }
  if (!Array.isArray(body.features) || !body.features.every(isStr)) {
    return 'features must be an array of strings';
  }
  const features = (body.features as string[]).map((f) => f.trim()).filter(Boolean);
  if (features.some((f) => f.length > 200)) return 'each feature max 200 chars';
  out.features = features;
  return null;
};

/** Parses one howItWorks entry: the item, or an error message string. */
function parseHowItWorksItem(item: unknown): ParsedHowItWorks | string {
  if (!item || typeof item !== 'object') return 'howItWorks item must be an object';
  const i = item as { title?: unknown; description?: unknown };
  if (!isStr(i.title) || !i.title.trim()) return 'howItWorks.title is required';
  if (!isStr(i.description) || !i.description.trim()) return 'howItWorks.description is required';
  if (i.title.length > 100) return 'howItWorks.title max 100 chars';
  if (i.description.length > 500) return 'howItWorks.description max 500 chars';
  return { title: i.title.trim(), description: i.description.trim() };
}

const parseHowItWorks: Section = (body, out, partial) => {
  if (body.howItWorks === undefined) {
    if (!partial) out.howItWorks = [];
    return null;
  }
  if (!Array.isArray(body.howItWorks)) return 'howItWorks must be an array';
  const items: ParsedHowItWorks[] = [];
  for (const item of body.howItWorks) {
    const parsed = parseHowItWorksItem(item);
    if (typeof parsed === 'string') return parsed;
    items.push(parsed);
  }
  out.howItWorks = items;
  return null;
};

/** Optional boolean field that defaults to `defaultValue` on a full (non-partial) parse. */
function booleanField(key: 'isActive' | 'isPublished' | 'isBeta' | 'verified', defaultValue: boolean): Section {
  return (body, out, partial) => {
    const value = body[key];
    if (value === undefined) {
      if (!partial) out[key] = defaultValue;
      return null;
    }
    if (typeof value !== 'boolean') return `${key} must be boolean`;
    out[key] = value;
    return null;
  };
}

const parseSortOrder: Section = (body, out, partial) => {
  if (body.sortOrder === undefined) {
    if (!partial) out.sortOrder = 0;
    return null;
  }
  if (typeof body.sortOrder !== 'number' || !Number.isInteger(body.sortOrder)) {
    return 'sortOrder must be an integer';
  }
  out.sortOrder = body.sortOrder;
  return null;
};

/** Optional short string field that defaults to `defaultValue` on a full parse. */
function shortTextField(
  key: 'version' | 'provider',
  maxLength: number,
  defaultValue: string,
): Section {
  return (body, out, partial) => {
    const value = body[key];
    if (value === undefined) {
      if (!partial) out[key] = defaultValue;
      return null;
    }
    if (!isStr(value)) return `${key} must be a string`;
    if (value.length > maxLength) return `${key} max ${maxLength} chars`;
    out[key] = value.trim();
    return null;
  };
}

const parseReleasedAt: Section = (body, out) => {
  const value = body.releasedAt;
  if (value === undefined) return null;
  if (value === null || value === '') {
    out.releasedAt = null;
    return null;
  }
  if (!isStr(value)) return 'releasedAt must be an ISO date string or null';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'releasedAt must be a valid ISO date';
  out.releasedAt = d;
  return null;
};

const parseUrls: Section = (body, out) => {
  for (const key of ['websiteUrl', 'documentationUrl', 'contactUrl'] as const) {
    if (body[key] === undefined) continue;
    const result = parseOptionalUrl(body[key], key);
    if (!result.ok) return result.message;
    out[key] = result.data;
  }
  return null;
};

/** Field validators in the order their errors are reported. */
const CATALOG_SECTIONS: readonly Section[] = [
  parseCode,
  requiredText('name', 100),
  requiredText('description'),
  requiredText('icon', 50),
  parseCategory,
  parsePath,
  parseOverview,
  parseFeatures,
  parseHowItWorks,
  booleanField('isActive', true),
  booleanField('isPublished', false),
  booleanField('isBeta', false),
  parseSortOrder,
  shortTextField('version', 20, '1.0.0'),
  shortTextField('provider', 100, 'WeldSuite'),
  booleanField('verified', false),
  parseReleasedAt,
  parseUrls,
];

export function parseCatalog(
  body: CatalogInput,
  opts: { partial?: boolean } = {},
): { ok: true; data: Partial<ParsedCatalog> } | { ok: false; message: string } {
  const out: ParsedOut = {};
  const partial = !!opts.partial;

  for (const section of CATALOG_SECTIONS) {
    const message = section(body, out, partial);
    if (message !== null) return { ok: false, message };
  }

  return { ok: true, data: out };
}

export { APP_CATEGORIES };
