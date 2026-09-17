import { apiRequest, loadConfig, resolveAppId, type UserAppSummary } from '../api.js';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { bold, cyan, info, success } from '../log.js';
import { loadManifest } from '../manifest.js';

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

export async function run(args: ParsedArgs): Promise<void> {
  const config = loadConfig();
  const manifest = await loadManifest();
  const appId = await resolveAppId(config, manifest.code);

  const fieldFlags = [
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
  const hasFieldFlag = fieldFlags.some((name) => args.flags[name] !== undefined);
  const fromManifest = flagBool(args.flags, 'from-manifest') || !hasFieldFlag;

  const body: Record<string, unknown> = {};

  if (fromManifest) {
    body.name = manifest.name;
    if (manifest.description !== undefined) body.description = manifest.description;
    if (manifest.icon !== undefined) body.icon = manifest.icon;
    if (manifest.category !== undefined) body.category = manifest.category;
    if (manifest.websiteUrl !== undefined) body.websiteUrl = manifest.websiteUrl;
    if (manifest.privacyUrl !== undefined) body.privacyUrl = manifest.privacyUrl;
    if (manifest.screenshots !== undefined) body.screenshots = manifest.screenshots;
    if (manifest.webhookUrl !== undefined) body.webhookUrl = manifest.webhookUrl;
  }

  const name = flagString(args.flags, 'name');
  if (name !== undefined) body.name = name;
  const description = flagString(args.flags, 'description');
  if (description !== undefined) body.description = description;
  const icon = flagString(args.flags, 'icon');
  if (icon !== undefined) body.icon = icon;
  const category = flagString(args.flags, 'category');
  if (category !== undefined) body.category = category;

  const websiteUrl = nullableUrl(flagString(args.flags, 'website-url'));
  if (websiteUrl !== undefined) body.websiteUrl = websiteUrl;
  const privacyUrl = nullableUrl(flagString(args.flags, 'privacy-url'));
  if (privacyUrl !== undefined) body.privacyUrl = privacyUrl;
  const webhookUrl = nullableUrl(flagString(args.flags, 'webhook-url'));
  if (webhookUrl !== undefined) body.webhookUrl = webhookUrl;

  if (flagBool(args.flags, 'active')) body.isActive = true;
  if (flagBool(args.flags, 'inactive')) body.isActive = false;

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
