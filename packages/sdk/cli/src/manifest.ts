import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CliError } from './api.js';

/**
 * weldapp.json manifest schema.
 *
 * SYNC WARNING: this is a copy of `userAppManifestSchema` in
 * `packages/app-api-client/src/schemas/user-apps.ts` — the server validates
 * uploads against that schema. Any change there MUST be mirrored here (and
 * vice versa) so `weld app deploy` gives identical validation offline.
 */

export const appCodeSchema = z
  .string()
  .min(3)
  .max(50)
  .regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and dashes, starting with a letter');

const scopeSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9_-]*:(\*|[a-z][a-z0-9_:-]*)$|^\*$/, 'scope must look like resource:action, resource:* or *');

export const agentToolActionSchema = z.object({
  type: z.enum(['storage.list', 'storage.create', 'storage.update', 'storage.delete', 'api.request']),
  /** Storage collection the tool operates on (storage.* actions). */
  collection: z.string().max(100).optional(),
  /** HTTP method + external-api path (api.request actions). */
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).optional(),
  path: z.string().max(500).optional(),
});

export const agentToolSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, 'lowercase snake_case'),
  description: z.string().min(1).max(1000),
  /** JSON Schema for the tool input. */
  parameters: z.record(z.unknown()).optional(),
  action: agentToolActionSchema,
});

export const manifestSchema = z.object({
  code: appCodeSchema,
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  icon: z.string().max(50).optional(),
  category: z.string().max(50).optional(),
  version: z
    .string()
    .max(20)
    .regex(/^\d+\.\d+\.\d+$/, 'semver (e.g. 1.0.0)'),
  entrypoint: z.string().max(255).optional(),
  scopes: z.array(scopeSchema).max(50).default([]),
  collections: z
    .array(
      z.object({
        name: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z][a-z0-9_-]*$/, 'lowercase letters, digits, dashes, underscores'),
        description: z.string().max(500).optional(),
      }),
    )
    .max(50)
    .optional(),
  agentTools: z.array(agentToolSchema).max(50).optional(),
  pricing: z
    .object({
      type: z.enum(['free', 'subscription']),
      monthlyPrice: z.number().min(0).max(10000).optional(),
      currency: z.string().length(3).optional(),
    })
    .optional(),
  /** Reserved — v1 renders on the web platform only. */
  mobile: z.boolean().optional(),
});

export type Manifest = z.infer<typeof manifestSchema>;

/** Read and validate `weldapp.json` from `dir`, with friendly errors. */
export async function loadManifest(dir: string = process.cwd()): Promise<Manifest> {
  const manifestPath = join(dir, 'weldapp.json');

  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    throw new CliError(
      `No weldapp.json found in ${dir}.\nRun \`weld app init\` to scaffold an app, or cd into your app directory.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new CliError(`weldapp.json is not valid JSON: ${detail}`);
  }

  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
      .join('\n');
    throw new CliError(`weldapp.json failed validation:\n${issues}`);
  }
  return result.data;
}
