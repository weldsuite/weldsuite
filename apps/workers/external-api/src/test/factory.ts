/**
 * Deterministic Zod → sample-value factory for tests.
 *
 * Walks a Zod v3 schema's `_def` and produces a MINIMAL, valid payload:
 *   - required fields only (optional fields are omitted to keep bodies
 *     small and constraint-safe);
 *   - required FK-id fields become the `REQUIRED_FK` sentinel so callers
 *     can detect entities that need a parent row seeded;
 *   - values are fixed (no randomness) so test runs are reproducible.
 *
 * This is the deterministic sibling of the Requestly collection generator's
 * walker. Body shapes therefore match what the public API actually accepts.
 */

import type { ZodTypeAny } from 'zod';

/** Marker left in place of a *required* foreign-key id we can't fabricate. */
export const REQUIRED_FK = '__REQUIRED_FK__';

const FIXED_UUID = '00000000-0000-0000-0000-000000000000';
const FIXED_DATE = '2025-01-15T12:00:00.000Z';

function isIdKey(key: string): boolean {
  return key === 'id' || /Id$/.test(key) || /_id$/.test(key);
}

/** Fixed string value derived from the field name; null when no heuristic matches. */
function namedString(key: string): string | null {
  const k = key.toLowerCase();
  if (k.includes('email')) return 'test@example.com';
  if (k.includes('firstname')) return 'Test';
  if (k.includes('lastname') || k === 'surname') return 'User';
  if (k === 'name' || k.includes('fullname') || k.includes('displayname') || k === 'title' || k.includes('subject')) return 'Test Record';
  if (k.includes('company') || k.includes('organization') || k.includes('organisation') || k.includes('tradingname')) return 'Test Co';
  if (k.includes('website') || k.includes('url') || k.includes('link')) return 'https://example.com';
  if (k.includes('domain')) return 'example.com';
  if (k.includes('phone') || k.includes('mobile') || k.includes('tel') || k.includes('fax')) return '+31 6 12 345 678';
  if (k.includes('slug') || k === 'handle' || k === 'key' || k === 'code') return 'test-code';
  if (k.includes('color') || k.includes('colour')) return '#3366ff';
  if (k.includes('currency')) return 'EUR';
  if (k.includes('country')) return 'NL';
  if (k.includes('locale') || k === 'language' || k === 'lang') return 'en';
  if (k.includes('timezone') || k === 'tz') return 'Europe/Amsterdam';
  if (k.includes('description') || k.includes('notes') || k.includes('note') || k.includes('summary') || k.includes('bio') || k.includes('message') || k.includes('content') || k.includes('body') || k.includes('text') || k.includes('comment')) return 'Test content';
  return null;
}

interface Optionality {
  optional: boolean;
  nullable: boolean;
}
export function optionality(schema: any): Optionality {
  let s = schema;
  let optional = false;
  let nullable = false;
  for (let i = 0; i < 8 && s?._def; i++) {
    const t = s._def.typeName;
    if (t === 'ZodOptional' || t === 'ZodDefault') { optional = true; s = s._def.innerType; }
    else if (t === 'ZodNullable') { nullable = true; s = s._def.innerType; }
    else if (t === 'ZodEffects') { s = s._def.schema; }
    else if (t === 'ZodReadonly' || t === 'ZodBranded') { s = s._def.innerType; }
    else break;
  }
  return { optional, nullable };
}

/** Sample value for any schema node. `key` carries the field name for heuristics. */
function sample(schema: any, key = '', depth = 0): unknown {
  const def = schema?._def;
  if (!def) return null;
  switch (def.typeName) {
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodReadonly':
    case 'ZodBranded':
      return sample(def.innerType, key, depth);
    case 'ZodDefault':
      try { return def.defaultValue(); } catch { return sample(def.innerType, key, depth); }
    case 'ZodCatch':
      return sample(def.innerType, key, depth);
    case 'ZodEffects':
      return sample(def.schema, key, depth);
    case 'ZodPipeline':
      return sample(def.in, key, depth);
    case 'ZodLazy':
      try { return sample(def.getter(), key, depth); } catch { return null; }
    case 'ZodObject':
      return buildObject(def, depth);
    case 'ZodArray':
      // Provide one element only if the inner type yields a usable value.
      if (depth > 3) return [];
      {
        const el = sample(def.type, key, depth + 1);
        return el === null || el === REQUIRED_FK ? [] : [el];
      }
    case 'ZodTuple':
      return (def.items ?? []).map((i: any) => sample(i, key, depth + 1));
    case 'ZodRecord':
      return {};
    case 'ZodString':
      return stringSample(def, key);
    case 'ZodNumber':
      return numberSample(def, key);
    case 'ZodBigInt':
      return 1;
    case 'ZodBoolean':
      return false;
    case 'ZodDate':
      return FIXED_DATE;
    case 'ZodLiteral':
      return def.value;
    case 'ZodEnum':
      return def.values?.[0] ?? 'option';
    case 'ZodNativeEnum':
      return Object.values(def.values ?? { a: 'option' })[0];
    case 'ZodUnion': {
      const opts = def.options instanceof Map ? [...def.options.values()] : def.options ?? [];
      const nonNull = opts.filter((o: any) => !['ZodNull', 'ZodUndefined'].includes(o?._def?.typeName));
      return sample((nonNull[0] ?? opts[0]), key, depth);
    }
    case 'ZodDiscriminatedUnion': {
      const opts = def.options instanceof Map ? [...def.options.values()] : def.options ?? [];
      return sample(opts[0], key, depth);
    }
    case 'ZodIntersection':
      return { ...(sample(def.left, key, depth) as object), ...(sample(def.right, key, depth) as object) };
    default:
      return null;
  }
}

/** Build an object including ONLY required fields. */
function buildObject(def: any, depth: number): Record<string, unknown> {
  if (depth > 4) return {};
  const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(shape)) {
    const field = shape[k];
    const { optional } = optionality(field);
    if (optional) continue; // minimal payload: skip everything optional
    if (isIdKey(k)) { out[k] = REQUIRED_FK; continue; }
    const v = sample(field, k, depth + 1);
    if (v === null) continue;
    out[k] = v;
  }
  return out;
}

function stringSample(def: any, key: string): string {
  for (const c of def.checks ?? []) {
    if (c.kind === 'email') return 'test@example.com';
    if (c.kind === 'url') return 'https://example.com';
    if (c.kind === 'uuid') return FIXED_UUID;
    if (c.kind === 'datetime') return FIXED_DATE;
    if (c.kind === 'cuid' || c.kind === 'cuid2') return 'ckxtest0000000000000000';
    if (c.kind === 'emoji') return '✅';
  }
  let v = namedString(key) ?? 'test';
  const min = (def.checks ?? []).find((c: any) => c.kind === 'min')?.value ?? 0;
  while (v.length < min) v += 'x';
  const max = (def.checks ?? []).find((c: any) => c.kind === 'length' || c.kind === 'max')?.value;
  if (typeof max === 'number' && v.length > max) v = v.slice(0, max);
  return v;
}

function numberSample(def: any, key: string): number {
  const min = (def.checks ?? []).find((c: any) => c.kind === 'min')?.value;
  if (typeof min === 'number' && min > 1) return min;
  return 1;
}

/** Minimal valid create payload (required fields only). */
export function buildCreateBody(schema: ZodTypeAny): Record<string, unknown> {
  const v = sample(schema);
  return (v && typeof v === 'object' && !Array.isArray(v)) ? (v as Record<string, unknown>) : {};
}

/** True if the create payload needs a required FK we can't fabricate. */
export function requiresParentFk(schema: ZodTypeAny): boolean {
  return JSON.stringify(buildCreateBody(schema)).includes(REQUIRED_FK);
}

/**
 * A small valid PATCH body that actually changes something: the first
 * top-level plain-string field (excluding ids). Falls back to `{}` (a valid
 * no-op for partial update schemas).
 */
export function buildUpdateBody(schema: ZodTypeAny): Record<string, unknown> {
  let s: any = schema;
  for (let i = 0; i < 8 && s?._def; i++) {
    const t = s._def.typeName;
    if (t === 'ZodObject') break;
    if (['ZodEffects', 'ZodOptional', 'ZodNullable', 'ZodDefault', 'ZodReadonly', 'ZodBranded'].includes(t)) {
      s = s._def.innerType ?? s._def.schema;
    } else break;
  }
  const def = s?._def;
  if (!def || def.typeName !== 'ZodObject') return {};
  const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
  for (const k of Object.keys(shape)) {
    if (isIdKey(k)) continue;
    // unwrap to find the base string type
    let inner: any = shape[k];
    for (let i = 0; i < 8 && inner?._def; i++) {
      const t = inner._def.typeName;
      if (t === 'ZodString') {
        return { [k]: stringSample(inner._def, k) };
      }
      if (['ZodOptional', 'ZodNullable', 'ZodDefault', 'ZodEffects', 'ZodReadonly', 'ZodBranded'].includes(t)) {
        inner = inner._def.innerType ?? inner._def.schema;
      } else break;
    }
  }
  return {};
}
