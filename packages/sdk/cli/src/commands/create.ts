import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { apiRequest, loadConfig, CliError, type UserAppSummary } from '../api.js';
import { type ParsedArgs } from '../args.js';
import { bold, cyan, info, success } from '../log.js';
import { loadManifest } from '../manifest.js';
import * as appInit from './init.js';

export const help = `${bold('weld app create [dir]')} — scaffold (if needed) and register the app

If weldapp.json is missing (or you pass a directory), this first scaffolds
a Vite + React app like ${cyan('weld app init')}, then registers it in your
workspace via POST /v1/user-apps.

When weldapp.json already exists, it only registers (run once per app;
afterwards use ${cyan('weld app deploy')} to upload versions).

Requires WELD_API_KEY for the register step.
`;

export async function run(args: ParsedArgs): Promise<void> {
  const targetDir = resolve(process.cwd(), args.positionals[0] ?? '.');
  const manifestPath = resolve(targetDir, 'weldapp.json');

  if (!existsSync(manifestPath)) {
    info('No weldapp.json yet — scaffolding first…');
    await appInit.run(args);
  }

  let config;
  try {
    config = loadConfig();
  } catch (cause) {
    if (cause instanceof CliError) {
      info('');
      info('App files are ready. Set WELD_API_KEY and re-run weld app create to register it.');
      throw cause;
    }
    throw cause;
  }

  const manifest = await loadManifest(targetDir);

  const app = await apiRequest<UserAppSummary>(config, 'POST', '/v1/user-apps', {
    body: {
      code: manifest.code,
      name: manifest.name,
      description: manifest.description,
      icon: manifest.icon,
      category: manifest.category,
      websiteUrl: manifest.websiteUrl,
      privacyUrl: manifest.privacyUrl,
      screenshots: manifest.screenshots,
      webhookUrl: manifest.webhookUrl,
    },
  });

  success(`Created app ${bold(manifest.name)} (${manifest.code})${app?.id ? ` — id ${app.id}` : ''}`);
  info(`Start a live preview with ${cyan('weld app dev')} or deploy with ${cyan('weld app deploy')}.`);
}
