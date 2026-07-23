import { apiRequest, loadConfig, type UserAppSummary } from '../api.js';
import { type ParsedArgs } from '../args.js';
import { bold, cyan, info, success } from '../log.js';
import { loadManifest } from '../manifest.js';

export const help = `${bold('weld app create')} — register the app from weldapp.json

Reads weldapp.json in the current directory and creates the app in your
workspace via POST /v1/user-apps. Run once per app; afterwards use
${cyan('weld app deploy')} to upload versions.

Requires WELD_API_KEY.
`;

export async function run(_args: ParsedArgs): Promise<void> {
  const config = loadConfig();
  const manifest = await loadManifest();

  const app = await apiRequest<UserAppSummary>(config, 'POST', '/v1/user-apps', {
    body: {
      code: manifest.code,
      name: manifest.name,
      description: manifest.description,
      icon: manifest.icon,
      category: manifest.category,
    },
  });

  success(`Created app ${bold(manifest.name)} (${manifest.code})${app?.id ? ` — id ${app.id}` : ''}`);
  info(`Deploy your first version with ${cyan('weld app deploy')}.`);
}
