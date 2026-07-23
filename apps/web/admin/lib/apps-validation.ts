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

export function parseCatalog(
  body: CatalogInput,
  opts: { partial?: boolean } = {},
): { ok: true; data: Partial<ParsedCatalog> } | { ok: false; message: string } {
  const out: Partial<ParsedCatalog> = {};
  const partial = !!opts.partial;

  if (body.code !== undefined) {
    if (!isStr(body.code)) return { ok: false, message: 'code must be a string' };
    const code = body.code.trim();
    if (!/^[a-z0-9_-]{2,50}$/.test(code))
      return { ok: false, message: 'code must be 2–50 chars of [a-z0-9_-]' };
    out.code = code;
  } else if (!partial) return { ok: false, message: 'code is required' };

  if (body.name !== undefined) {
    if (!isStr(body.name) || !body.name.trim())
      return { ok: false, message: 'name is required' };
    if (body.name.length > 100) return { ok: false, message: 'name max 100 chars' };
    out.name = body.name.trim();
  } else if (!partial) return { ok: false, message: 'name is required' };

  if (body.description !== undefined) {
    if (!isStr(body.description) || !body.description.trim())
      return { ok: false, message: 'description is required' };
    out.description = body.description.trim();
  } else if (!partial) return { ok: false, message: 'description is required' };

  if (body.icon !== undefined) {
    if (!isStr(body.icon) || !body.icon.trim())
      return { ok: false, message: 'icon is required' };
    if (body.icon.length > 50) return { ok: false, message: 'icon max 50 chars' };
    out.icon = body.icon.trim();
  } else if (!partial) return { ok: false, message: 'icon is required' };

  if (body.category !== undefined) {
    if (!isStr(body.category) || !APP_CATEGORIES.includes(body.category)) {
      return { ok: false, message: `category must be one of: ${APP_CATEGORIES.join(', ')}` };
    }
    out.category = body.category;
  } else if (!partial) return { ok: false, message: 'category is required' };

  if (body.path !== undefined) {
    if (!isStr(body.path) || !body.path.startsWith('/'))
      return { ok: false, message: 'path must start with /' };
    if (body.path.length > 100) return { ok: false, message: 'path max 100 chars' };
    out.path = body.path.trim();
  } else if (!partial) return { ok: false, message: 'path is required' };

  if (body.overview !== undefined) {
    if (body.overview === null || body.overview === '') {
      out.overview = null;
    } else if (isStr(body.overview)) {
      out.overview = body.overview;
    } else {
      return { ok: false, message: 'overview must be a string or null' };
    }
  }

  if (body.features !== undefined) {
    if (!Array.isArray(body.features) || !body.features.every(isStr)) {
      return { ok: false, message: 'features must be an array of strings' };
    }
    const features = (body.features as string[]).map((f) => f.trim()).filter(Boolean);
    if (features.some((f) => f.length > 200))
      return { ok: false, message: 'each feature max 200 chars' };
    out.features = features;
  } else if (!partial) {
    out.features = [];
  }

  if (body.howItWorks !== undefined) {
    if (!Array.isArray(body.howItWorks))
      return { ok: false, message: 'howItWorks must be an array' };
    const items: ParsedHowItWorks[] = [];
    for (const item of body.howItWorks) {
      if (!item || typeof item !== 'object')
        return { ok: false, message: 'howItWorks item must be an object' };
      const i = item as { title?: unknown; description?: unknown };
      if (!isStr(i.title) || !i.title.trim())
        return { ok: false, message: 'howItWorks.title is required' };
      if (!isStr(i.description) || !i.description.trim())
        return { ok: false, message: 'howItWorks.description is required' };
      if (i.title.length > 100)
        return { ok: false, message: 'howItWorks.title max 100 chars' };
      if (i.description.length > 500)
        return { ok: false, message: 'howItWorks.description max 500 chars' };
      items.push({ title: i.title.trim(), description: i.description.trim() });
    }
    out.howItWorks = items;
  } else if (!partial) {
    out.howItWorks = [];
  }

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean')
      return { ok: false, message: 'isActive must be boolean' };
    out.isActive = body.isActive;
  } else if (!partial) {
    out.isActive = true;
  }

  if (body.isPublished !== undefined) {
    if (typeof body.isPublished !== 'boolean')
      return { ok: false, message: 'isPublished must be boolean' };
    out.isPublished = body.isPublished;
  } else if (!partial) {
    out.isPublished = false;
  }

  if (body.sortOrder !== undefined) {
    if (typeof body.sortOrder !== 'number' || !Number.isInteger(body.sortOrder)) {
      return { ok: false, message: 'sortOrder must be an integer' };
    }
    out.sortOrder = body.sortOrder;
  } else if (!partial) {
    out.sortOrder = 0;
  }

  if (body.version !== undefined) {
    if (!isStr(body.version)) return { ok: false, message: 'version must be a string' };
    if (body.version.length > 20) return { ok: false, message: 'version max 20 chars' };
    out.version = body.version.trim();
  } else if (!partial) {
    out.version = '1.0.0';
  }

  if (body.provider !== undefined) {
    if (!isStr(body.provider)) return { ok: false, message: 'provider must be a string' };
    if (body.provider.length > 100) return { ok: false, message: 'provider max 100 chars' };
    out.provider = body.provider.trim();
  } else if (!partial) {
    out.provider = 'WeldSuite';
  }

  if (body.verified !== undefined) {
    if (typeof body.verified !== 'boolean')
      return { ok: false, message: 'verified must be boolean' };
    out.verified = body.verified;
  } else if (!partial) {
    out.verified = false;
  }

  if (body.releasedAt !== undefined) {
    if (body.releasedAt === null || body.releasedAt === '') {
      out.releasedAt = null;
    } else if (isStr(body.releasedAt)) {
      const d = new Date(body.releasedAt);
      if (Number.isNaN(d.getTime()))
        return { ok: false, message: 'releasedAt must be a valid ISO date' };
      out.releasedAt = d;
    } else {
      return { ok: false, message: 'releasedAt must be an ISO date string or null' };
    }
  }

  for (const key of ['websiteUrl', 'documentationUrl', 'contactUrl'] as const) {
    if (body[key] !== undefined) {
      const result = parseOptionalUrl(body[key], key);
      if (!result.ok) return { ok: false, message: result.message };
      out[key] = result.data;
    }
  }

  return { ok: true, data: out };
}

export { APP_CATEGORIES };
