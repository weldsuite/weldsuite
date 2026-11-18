/**
 * Generates rust/modules/panel/src/schemas_gen.rs: the Zod schemas panel-api's
 * ported routes validate with, as `weldsuite_zod::Z` trees, so a Rust route
 * answers a bad body with Zod's own issues (codes, paths, messages, order).
 *
 * - Every schema exported by the WeldPanel client schema modules that a
 *   generated schema uses is its own constant, named after the export
 *   (`panelFilterSchema` → `PANEL_FILTER`), and referenced where it is used.
 * - What a schema computes in JavaScript (`.refine`, `.superRefine`) is a call
 *   to a hook in `src/hooks.rs`, named after the export
 *   (`refine_panel_event_ref`) or, for an inline one, after where it sits;
 *   hooks are written by hand. A missing hook fails the build.
 * - Patterns are written for Rust's `regex`: JavaScript's `\d` and `\w` are
 *   ASCII, so they become explicit classes.
 *
 *   pnpm --filter panel-api exec tsx ../../../rust/modules/panel/tools/generate.mts
 *   pnpm rust:fmt
 *
 * Commit the output, and check it against Zod with `tools/zod-cases.mts`
 * (the `hooks::tests` cases).
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');

// Packages resolve from panel-api, which depends on them.
const requireFrom = createRequire(path.join(repo, 'apps/workers/panel-api/package.json'));
const load = (specifier: string) => import(pathToFileURL(requireFrom.resolve(specifier)).href);

const MODULES = [
  '@weldsuite/app-api-client/schemas/weldpanel-query',
  '@weldsuite/app-api-client/schemas/weldpanel-collab',
  '@weldsuite/app-api-client/schemas/weldpanel-objects',
];

/** The schemas to generate, by export name. */
const ROOTS = [
  'panelQuerySpecSchema',
  'panelCohortFilterSchema',
  'panelCustomEventDefinitionSchema',
  'panelComputedPropertyDefinitionSchema',
  'updatePanelLexiconSchema',
];

/* eslint-disable @typescript-eslint/no-explicit-any */

const constNames = new Map<unknown, string>();
const exportsByName = new Map<string, unknown>();
for (const specifier of MODULES) {
  const mod = await load(specifier);
  for (const [name, value] of Object.entries(mod)) {
    if (!value || typeof value !== 'object' || !('_def' in (value as object))) continue;
    if (constNames.has(value)) continue;
    const constName = name
      .replace(/Schema$/, '')
      .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toUpperCase();
    constNames.set(value, constName);
    exportsByName.set(name, value);
  }
}

const warnings: string[] = [];
const hooks = new Set<string>();
/** Constants to write: name → expression. */
const constants = new Map<string, string>();
const pending: unknown[] = [];

const rustStr = (text: string) => JSON.stringify(text);
const msg = (message: unknown) => (typeof message === 'string' ? `Some(${rustStr(message)})` : 'None');
const num = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));
const snake = (text: string) =>
  text
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replaceAll(/[^A-Za-z0-9]+/g, '_')
    .replaceAll(/^_|_$/g, '')
    .toLowerCase();

/** A JavaScript pattern for Rust's `regex`, where `\d` and `\w` are Unicode. */
function rustPattern(source: string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '\\' && i + 1 < source.length) {
      const next = source[i + 1]!;
      if (next === 'd') out += inClass ? '0-9' : '[0-9]';
      else if (next === 'w') out += inClass ? 'A-Za-z0-9_' : '[A-Za-z0-9_]';
      else out += c + next;
      i++;
      continue;
    }
    if (c === '[' && !inClass) inClass = true;
    else if (c === ']' && inClass) inClass = false;
    out += c;
  }
  return out;
}

function stringChecks(checks: any[], where: string): string {
  const out: string[] = [];
  for (const c of checks) {
    switch (c.kind) {
      case 'min':
        out.push(`S::Min(${c.value}, ${msg(c.message)})`);
        break;
      case 'max':
        out.push(`S::Max(${c.value}, ${msg(c.message)})`);
        break;
      case 'length':
        out.push(`S::Len(${c.value}, ${msg(c.message)})`);
        break;
      case 'regex': {
        const re = c.regex as RegExp;
        const flags = re.flags.includes('i') ? '(?i)' : '';
        out.push(`S::Regex(${rustStr(flags + rustPattern(re.source))}, ${msg(c.message)})`);
        break;
      }
      case 'trim':
        out.push('S::Trim');
        break;
      case 'toLowerCase':
        out.push('S::Lower');
        break;
      case 'datetime':
        out.push(`S::Datetime { offset: ${!!c.offset}, msg: ${msg(c.message)} }`);
        break;
      default:
        warnings.push(`${where}: string check ${c.kind} not supported`);
        out.push(`compile_error!("${where}: string check ${c.kind}")`);
    }
  }
  return `&[${out.join(', ')}]`;
}

function numberChecks(checks: any[], where: string): string {
  const out: string[] = [];
  for (const c of checks) {
    switch (c.kind) {
      case 'int':
        out.push(`N::Int(${msg(c.message)})`);
        break;
      case 'min':
        out.push(`N::Min(${num(c.value)}, ${!!c.inclusive}, ${msg(c.message)})`);
        break;
      case 'max':
        out.push(`N::Max(${num(c.value)}, ${!!c.inclusive}, ${msg(c.message)})`);
        break;
      case 'finite':
        out.push(`N::Finite(${msg(c.message)})`);
        break;
      default:
        warnings.push(`${where}: number check ${c.kind} not supported`);
        out.push(`compile_error!("${where}: number check ${c.kind}")`);
    }
  }
  return `&[${out.join(', ')}]`;
}

/**
 * A Zod schema as a Rust `Z` expression. An exported schema other than
 * `root` is referenced by its constant; `name` names inline hooks.
 */
function emit(s: any, name: string, root?: unknown): string {
  const constName = constNames.get(s);
  if (constName && s !== root) {
    if (!constants.has(constName) && !pending.includes(s)) pending.push(s);
    return constName;
  }
  const def = s?._def;
  if (!def) return `compile_error!("${name}: not a Zod schema")`;
  if (def.errorMap && !['ZodEffects', 'ZodOptional', 'ZodNullable', 'ZodDefault', 'ZodObject'].includes(def.typeName)) {
    warnings.push(`${name}: ${def.typeName} has an errorMap (a custom message): check by hand`);
  }
  switch (def.typeName) {
    case 'ZodString':
      return `Z::Str(${stringChecks(def.checks ?? [], name)})`;
    case 'ZodNumber':
      return `Z::Num(${numberChecks(def.checks ?? [], name)})`;
    case 'ZodBoolean':
      return 'Z::Bool';
    case 'ZodEnum':
      return `Z::Enum(&[${(def.values as string[]).map(rustStr).join(', ')}], None)`;
    case 'ZodLiteral': {
      const v = def.value;
      if (typeof v === 'string') return `Z::Lit(Lit::Str(${rustStr(v)}))`;
      if (typeof v === 'number') return `Z::Lit(Lit::Num(${num(v)}))`;
      if (typeof v === 'boolean') return `Z::Lit(Lit::Bool(${v}))`;
      return `compile_error!("${name}: literal ${String(v)}")`;
    }
    case 'ZodAny':
    case 'ZodUnknown':
      return 'Z::Any';
    case 'ZodNull':
      return 'Z::Null';
    case 'ZodArray': {
      if (def.exactLength) warnings.push(`${name}: exact array length treated as min`);
      const min = def.exactLength ?? def.minLength;
      const bound = (b: any) => (b ? `Some((${b.value}, ${msg(b.message)}))` : 'None');
      return `Z::Arr(&${emit(def.type, `${name}_item`)}, ${bound(min)}, ${bound(def.maxLength)})`;
    }
    case 'ZodRecord':
      return `Z::Rec(&${emit(def.valueType, `${name}_value`)})`;
    case 'ZodObject': {
      const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
      const catchall = def.catchall?._def?.typeName;
      if (catchall && catchall !== 'ZodNever') warnings.push(`${name}: catchall not supported`);
      const keys = def.unknownKeys === 'passthrough' ? 'Passthrough' : def.unknownKeys === 'strict' ? 'Strict' : 'Strip';
      const fields = Object.keys(shape).map((k) => `(${rustStr(k)}, ${emit(shape[k], `${name}_${k}`)})`);
      return `Z::Obj(&[${fields.join(', ')}], Keys::${keys})`;
    }
    case 'ZodUnion': {
      const options = def.options as any[];
      return `Z::Union(&[${options.map((o, i) => emit(o, `${name}_or${i}`)).join(', ')}])`;
    }
    case 'ZodDiscriminatedUnion': {
      const options = (def.options instanceof Map ? [...def.options.values()] : def.options) as any[];
      return `Z::Disc(${rustStr(def.discriminator)}, &[${options.map((o, i) => emit(o, `${name}_or${i}`)).join(', ')}])`;
    }
    case 'ZodOptional':
      return `Z::Opt(&${emit(def.innerType, name)})`;
    case 'ZodNullable':
      return `Z::Nul(&${emit(def.innerType, name)})`;
    case 'ZodDefault':
      return `Z::Def(&${emit(def.innerType, name)}, ${rustStr(JSON.stringify(def.defaultValue()))})`;
    case 'ZodBranded':
    case 'ZodReadonly':
      return emit(def.innerType ?? def.type, name);
    case 'ZodEffects': {
      const effect = def.effect;
      if (effect.type !== 'refinement') return `compile_error!("${name}: effect ${effect.type}")`;
      const hook = `refine_${snake(constName ?? name)}`;
      hooks.add(hook);
      return `Z::Refine(&${emit(def.schema, `${name}_inner`)}, hooks::${hook})`;
    }
    default:
      warnings.push(`${name}: ${def.typeName} not supported`);
      return `compile_error!("${name}: ${def.typeName}")`;
  }
}

for (const root of ROOTS) {
  const schema = exportsByName.get(root);
  if (!schema) throw new Error(`no export ${root}`);
  pending.push(schema);
}
while (pending.length > 0) {
  const schema = pending.shift();
  const name = constNames.get(schema)!;
  if (constants.has(name)) continue;
  constants.set(name, '');
  constants.set(name, emit(schema, name.toLowerCase(), schema));
}

let out = `//! Generated by \`tools/generate.mts\` from \`@weldsuite/app-api-client\`'s
//! WeldPanel schemas; don't edit. Each exported schema as a [\`Z\`] tree; what
//! it computes in JavaScript is a hook in [\`crate::hooks\`].

#![allow(
    clippy::doc_markdown,
    clippy::too_many_lines,
    clippy::unreadable_literal,
    dead_code
)]

use weldsuite_zod::{Keys, Lit, N, S, Z};

use crate::hooks;
`;
for (const name of [...constants.keys()].sort()) {
  const exported = [...exportsByName.entries()].find(([, value]) => constNames.get(value) === name)?.[0];
  out += `\n/// \`${exported}\`.\npub(crate) const ${name}: Z = ${constants.get(name)};\n`;
}

writeFileSync(path.join(here, '../src/schemas_gen.rs'), out);
console.log(`wrote ${constants.size} schemas; hooks:\n  ${[...hooks].sort().join('\n  ')}`);
if (warnings.length > 0) console.warn(`warnings:\n  ${warnings.join('\n  ')}`);
