import { apiRequest, loadConfig, resolveAppId, type UserAppSummary } from '../api.js';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { bold, cyan, info, success } from '../log.js';
import { loadManifest, type Manifest } from '../manifest.js';

export const help = `${bold('weld app update')} — patch app metadata

Updates the registered app via PATCH /v1/user-apps/:id. By default syncs
name, description, icon, category, and listing fields from weldapp.json.
Pass flags to override individual fields without rewriting the file.

Options:
  --from-manifest       Sync metadata from weldapp.json (default when no field flags)
  --name <name>
  --description <text>
  --icon <name>
  --category <text>
  --website-url <url>   Empty string clears
  --privacy-url <url>   Empty string clears
  --webhook-url <url>   Empty string clears
  --active / --inactive Toggle isActive

Requires weld login (or WELD_API_KEY).
`;

function nullableUrl(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === '') return null;
  return value;
}

const FIELD_FLAGS = [
  'name',
  'description',
  'icon',
  'category',
  'website-url',
  'privacy-url',
  'webhook-url',
  'active',
  'inactive',
];

/** Manifest fields synced by `--from-manifest` (after `name`, which is always sent). */
const MANIFEST_SYNC_FIELDS = [
  'description',
  'icon',
  'category',
  'websiteUrl',
  'privacyUrl',
  'screenshots',
  'webhookUrl',
] as const;

/** Plain string flags that map straight onto a body field. */
const STRING_FLAGS: ReadonlyArray<readonly [flag: string, field: string]> = [
  ['name', 'name'],
  ['description', 'description'],
  ['icon', 'icon'],
  ['category', 'category'],
];

/** URL flags where an empty string clears the field (sent as `null`). */
const URL_FLAGS: ReadonlyArray<readonly [flag: string, field: string]> = [
  ['website-url', 'websiteUrl'],
  ['privacy-url', 'privacyUrl'],
  ['webhook-url', 'webhookUrl'],
];

function bodyFromManifest(manifest: Manifest): Record<string, unknown> {
  const body: Record<string, unknown> = { name: manifest.name };
  for (const field of MANIFEST_SYNC_FIELDS) {
    if (manifest[field] !== undefined) body[field] = manifest[field];
  }
  return body;
}

function applyFlagOverrides(body: Record<string, unknown>, flags: ParsedArgs['flags']): void {
  for (const [flag, field] of STRING_FLAGS) {
    const value = flagString(flags, flag);
    if (value !== undefined) body[field] = value;
  }
  for (const [flag, field] of URL_FLAGS) {
    const value = nullableUrl(flagString(flags, flag));
    if (value !== undefined) body[field] = value;
  }
  if (flagBool(flags, 'active')) body.isActive = true;
  if (flagBool(flags, 'inactive')) body.isActive = false;
}

export async function run(args: ParsedArgs): Promise<void> {
  const config = loadConfig();
  const manifest = await loadManifest();
  const appId = await resolveAppId(config, manifest.code);

  const hasFieldFlag = FIELD_FLAGS.some((name) => args.flags[name] !== undefined);
  const fromManifest = flagBool(args.flags, 'from-manifest') || !hasFieldFlag;

  const body: Record<string, unknown> = fromManifest ? bodyFromManifest(manifest) : {};
  applyFlagOverrides(body, args.flags);

  if (Object.keys(body).length === 0) {
    info(`Nothing to update. Pass field flags or edit weldapp.json and re-run ${cyan('weld app update')}.`);
    return;
  }

  const updated = await apiRequest<UserAppSummary>(
    config,
    'PATCH',
    `/v1/user-apps/${encodeURIComponent(appId)}`,
    { body },
  );

  success(`Updated ${bold(updated?.name ?? manifest.name)} (${manifest.code})`);
}
