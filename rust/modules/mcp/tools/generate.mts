/**
 * Generates the MCP server's catalog from the TypeScript worker
 * (apps/workers/mcp-server) itself:
 *
 * - `catalog/tools.json`: what the worker answers to `initialize`,
 *   `tools/list` (every static tool, as an all-permission member sees it),
 *   `resources/list` and `resources/templates/list`, each tool's routing into
 *   `/v1` (scope, method, path, path params, exactId), and the routes the
 *   worker's own copy of the `/v1` API mounts (`apiRoutes`);
 * - `src/args_gen.rs`: each tool's input shape as a Zod `Z` tree (external-api's
 *   interpreter, `weldsuite_external_api::zod`), which the SDK validates the
 *   arguments with; what a schema computes in JavaScript (`.refine`,
 *   `.transform`, `z.preprocess`) is a hook in `src/hooks.rs`, written by hand;
 * - `catalog/tables.json`: every tenant table's properties in Drizzle's order,
 *   the order JavaScript prints a row's keys in (`src/present.rs`).
 *
 *   pnpm --filter mcp-server exec tsx ../../../rust/modules/mcp/tools/generate.mts
 *
 * Commit the output.
 */

import { register } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const worker = path.join(repo, 'apps/workers/mcp-server');

// The Workers-only modules the worker's imports reach, mapped onto the stubs
// its vitest config uses.
const stubs: Record<string, string> = {
  'cloudflare:email': path.join(repo, 'packages/core/worker-email/src/testing/cloudflare-email-stub.ts'),
  'cloudflare:sockets': path.join(repo, 'packages/core/smtp/src/testing/cloudflare-sockets-stub.ts'),
  'cloudflare:workers': path.join(repo, 'packages/domains/mail/src/testing/cloudflare-workers-stub.ts'),
};
const hook = `
const stubs = ${JSON.stringify(Object.fromEntries(Object.entries(stubs).map(([k, v]) => [k, pathToFileURL(v).href])))};
export async function resolve(specifier, context, next) {
  if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true };
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const src = (file: string) => import(pathToFileURL(path.join(worker, 'src', file)).href);
const { createMcpServer } = await src('lib/mcp-server.ts');
const { serveMcpRequest } = await src('lib/mcp-transport.ts');
const { allTools } = await src('tools/registry.ts');
const { apiApp } = await src('api/app.ts');

// ---------------------------------------------------------------------------
// What the worker answers
// ---------------------------------------------------------------------------

const session = {
  tokenId: 'oat_generate',
  userId: 'user_generate',
  clerkOrgId: 'org_generate',
  workspaceId: 'ws_generate',
  workspaceName: 'Generate',
  tier: 'enterprise',
  // Nothing listens here: the dynamic loaders (WeldApps, WeldObjects) fail
  // and register nothing, as they do when the workspace has none.
  databaseUrl: 'postgres://generate:generate@127.0.0.1:1/generate',
  permissions: ['*'],
  permissionDenies: [],
  role: 'OWNER',
  clientId: null,
  licensedApps: null,
};
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };

async function call(method: string, params?: unknown): Promise<unknown> {
  // No CLERK_SECRET_KEY: `submit_feedback` is registered at run time only.
  const server = await createMcpServer(session, {}, ctx);
  const response: Response = await serveMcpRequest(
    server,
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
    }),
    undefined,
  );
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (!body.result) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

const initialize = await call('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'generate', version: '0' },
});
const listed = (await call('tools/list')) as { tools: Array<{ name: string }> };
const resources = await call('resources/list');
const resourceTemplates = await call('resources/templates/list');

const definitions = new Map(listed.tools.map((tool) => [tool.name, tool]));
if (definitions.size !== allTools.length) {
  throw new Error(`tools/list has ${definitions.size} tools, the registry ${allTools.length}`);
}

const tools = allTools.map((tool: any) => ({
  name: tool.name,
  scope: tool.scope,
  method: tool.method,
  path: tool.path,
  pathParams: Object.entries(tool.pathParams ?? {}),
  exactId: tool.exactId ?? false,
  definition: definitions.get(tool.name),
}));

const apiRoutes = (apiApp.routes as Array<{ method: string; path: string }>)
  .filter((route) => route.method !== 'ALL')
  .map((route) => [route.method, route.path]);

mkdirSync(path.join(here, '../catalog'), { recursive: true });
writeFileSync(
  path.join(here, '../catalog/tools.json'),
  JSON.stringify({ initialize, resources, resourceTemplates, tools, apiRoutes }, null, 1) + '\n',
);

// ---------------------------------------------------------------------------
// Argument shapes as Zod data (the same `Z` as external-api's schemas_gen.rs)
// ---------------------------------------------------------------------------

const warnings: string[] = [];
const hookNames = new Map<unknown, string>();
const hookList: string[] = [];

const rustStr = (text: string) => JSON.stringify(text);
const msg = (message: unknown) => (typeof message === 'string' ? `Some(${rustStr(message)})` : 'None');
const num = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));
const snake = (text: string) =>
  text
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replaceAll(/[^A-Za-z0-9]+/g, '_')
    .replaceAll(/^_|_$/g, '')
    .toLowerCase();

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
      case 'email':
        out.push(`S::Email(${msg(c.message)})`);
        break;
      case 'url':
        out.push(`S::Url(${msg(c.message)})`);
        break;
      case 'uuid':
        out.push(`S::Uuid(${msg(c.message)})`);
        break;
      case 'datetime':
        if (c.precision != null || c.local) warnings.push(`${where}: datetime precision/local not supported`);
        out.push(`S::Datetime { offset: ${!!c.offset}, msg: ${msg(c.message)} }`);
        break;
      case 'regex': {
        const re = c.regex as RegExp;
        const flags = re.flags.includes('i') ? '(?i)' : '';
        out.push(`S::Regex(${rustStr(flags + re.source)}, ${msg(c.message)})`);
        break;
      }
      case 'startsWith':
        out.push(`S::StartsWith(${rustStr(c.value)}, ${msg(c.message)})`);
        break;
      case 'endsWith':
        out.push(`S::EndsWith(${rustStr(c.value)}, ${msg(c.message)})`);
        break;
      case 'trim':
        out.push('S::Trim');
        break;
      case 'toLowerCase':
        out.push('S::Lower');
        break;
      case 'toUpperCase':
        out.push('S::Upper');
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

/** One hook per JavaScript function, named after the first field that uses it. */
function hookFor(kind: string, fn: unknown, name: string): string {
  const known = hookNames.get(fn);
  if (known) return known;
  const hookName = `${kind}_${snake(name)}`;
  hookNames.set(fn, hookName);
  hookList.push(`${hookName}: ${String(fn).replaceAll(/\s+/g, ' ').slice(0, 300)}`);
  return hookName;
}

/** A Zod schema as a Rust `Z` expression. `name` names hooks. */
function emit(s: any, name: string): string {
  const def = s?._def;
  if (!def) return `compile_error!("${name}: not a Zod schema")`;
  if (def.errorMap && !def.coerce && !['ZodEffects', 'ZodOptional', 'ZodNullable', 'ZodDefault', 'ZodObject'].includes(def.typeName)) {
    warnings.push(`${name}: ${def.typeName} has an errorMap (a custom message): check by hand`);
  }
  switch (def.typeName) {
    case 'ZodString':
      return `Z::${def.coerce ? 'CoerceStr' : 'Str'}(${stringChecks(def.checks ?? [], name)})`;
    case 'ZodNumber':
      return `Z::${def.coerce ? 'CoerceNum' : 'Num'}(${numberChecks(def.checks ?? [], name)})`;
    case 'ZodBoolean':
      return def.coerce ? 'Z::CoerceBool' : 'Z::Bool';
    case 'ZodDate':
      if ((def.checks ?? []).length) warnings.push(`${name}: date checks not supported`);
      return def.coerce ? 'Z::CoerceDate' : 'Z::Date';
    case 'ZodEnum':
      return `Z::Enum(&[${(def.values as string[]).map(rustStr).join(', ')}], None)`;
    case 'ZodNativeEnum': {
      const values = Object.values(def.values).filter((v) => typeof v === 'string') as string[];
      return `Z::Enum(&[${values.map(rustStr).join(', ')}], None)`;
    }
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
      const min = def.exactLength ?? def.minLength;
      if (def.exactLength) warnings.push(`${name}: exact array length treated as min`);
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
      if (effect.type === 'refinement') {
        return `Z::Refine(&${emit(def.schema, name)}, hooks::${hookFor('refine', effect.refinement, name)})`;
      }
      if (effect.type === 'transform') {
        return `Z::Transform(&${emit(def.schema, name)}, hooks::${hookFor('transform', effect.transform, name)})`;
      }
      if (effect.type === 'preprocess') {
        return `Z::Pre(hooks::${hookFor('preprocess', effect.transform, name)}, &${emit(def.schema, name)})`;
      }
      return `compile_error!("${name}: effect ${effect.type}")`;
    }
    default:
      warnings.push(`${name}: ${def.typeName} not supported`);
      return `compile_error!("${name}: ${def.typeName}")`;
  }
}

let argsOut = `//! Generated by \`tools/generate.mts\` from the TypeScript worker's tool
//! definitions; don't edit. Each tool's input shape as the [\`Z\`] tree the SDK
//! validates its arguments with (\`z.object(shape)\`); what it computes in
//! JavaScript is a hook in [\`crate::hooks\`].

#![allow(clippy::doc_markdown, clippy::too_many_lines, clippy::large_stack_arrays, dead_code)]

use crate::hooks;
use weldsuite_external_api::zod::{Keys, Lit, N, S, Z};

/// A tool's input shape, by tool name.
pub(crate) fn args(tool: &str) -> Option<&'static Z> {
    match tool {
`;
for (const tool of allTools as any[]) {
  const fields = Object.keys(tool.inputSchema).map(
    (k) => `(${rustStr(k)}, ${emit(tool.inputSchema[k], `${tool.name}_${k}`)})`,
  );
  argsOut += `        ${rustStr(tool.name)} => Some(&Z::Obj(&[${fields.join(', ')}], Keys::Strip)),\n`;
}
argsOut += `        _ => None,
    }
}
`;
writeFileSync(path.join(here, '../src/args_gen.rs'), argsOut);

// ---------------------------------------------------------------------------
// Tables: each tenant table's properties, in Drizzle's order
// ---------------------------------------------------------------------------

const { createRequire } = await import('node:module');
const requireFrom = createRequire(path.join(worker, 'package.json'));
const load = (specifier: string) => import(pathToFileURL(requireFrom.resolve(specifier)).href);
const { getTableColumns, getTableName, is } = await load('drizzle-orm');
const { PgTable } = await load('drizzle-orm/pg-core');
const schema = await load('@weldsuite/db/schema');

const tables: Record<string, string[]> = {};
for (const value of Object.values(schema)) {
  if (!is(value, PgTable)) continue;
  tables[getTableName(value)] = Object.keys(getTableColumns(value));
}
writeFileSync(
  path.join(here, '../catalog/tables.json'),
  JSON.stringify(Object.fromEntries(Object.entries(tables).sort(([a], [b]) => a.localeCompare(b)))) + '\n',
);

console.log(`${tools.length} tools, ${apiRoutes.length} api routes, ${Object.keys(tables).length} tables`);
console.log(`hooks to write in src/hooks.rs (${hookList.length}):\n  ${hookList.join('\n  ')}`);
if (warnings.length) console.log(`warnings:\n  ${warnings.join('\n  ')}`);
process.exit(0);
