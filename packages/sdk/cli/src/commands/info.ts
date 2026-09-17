import { apiRequest, loadConfig, resolveAppId, type UserAppSummary } from '../api.js';
import { flagString, type ParsedArgs } from '../args.js';
import { bold, info } from '../log.js';
import { loadManifest } from '../manifest.js';

export const help = `${bold('weld app info')} — show one app's metadata

Resolves the app from weldapp.json's code (or --code) and prints
GET /v1/user-apps/:id fields used for manage / store listing.

Options:
  --code <code>     App code (default: weldapp.json)

Requires weld login (or WELD_API_KEY).
`;

export async function run(args: ParsedArgs): Promise<void> {
  const config = loadConfig();
  const codeFlag = flagString(args.flags, 'code');
  const code = codeFlag ?? (await loadManifest()).code;
  const appId = await resolveAppId(config, code);
  const app = await apiRequest<UserAppSummary & Record<string, unknown>>(
    config,
    'GET',
    `/v1/user-apps/${encodeURIComponent(appId)}`,
  );

  const lines = [
    `${bold('Name')}         ${app.name}`,
    `${bold('Code')}         ${app.code}`,
    `${bold('Id')}           ${app.id}`,
    `${bold('Visibility')}   ${app.visibility ?? 'private'}`,
    `${bold('Review')}       ${app.reviewStatus ?? app.review_status ?? '-'}`,
    `${bold('Active')}       ${app.isActive === false ? 'no' : 'yes'}`,
    `${bold('Installs')}     ${app.installCount ?? app.installs ?? 0}`,
  ];
  if (typeof app.description === 'string' && app.description) {
    lines.push(`${bold('Description')}  ${app.description}`);
  }
  if (typeof app.category === 'string' && app.category) {
    lines.push(`${bold('Category')}     ${app.category}`);
  }
  if (typeof app.websiteUrl === 'string' && app.websiteUrl) {
    lines.push(`${bold('Website')}      ${app.websiteUrl}`);
  }
  if (typeof app.privacyUrl === 'string' && app.privacyUrl) {
    lines.push(`${bold('Privacy')}      ${app.privacyUrl}`);
  }
  info(lines.join('\n'));
}
