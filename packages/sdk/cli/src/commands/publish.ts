import { apiRequest, loadConfig, resolveAppId } from '../api.js';
import { flagString, type ParsedArgs } from '../args.js';
import { bold, info, success } from '../log.js';
import { loadManifest } from '../manifest.js';

export const help = `${bold('weld app publish')} — submit the app for public-store review

Submits the app (resolved from weldapp.json's code) via
POST /v1/user-apps/:id/submit.

Options:
  --notes <text>     Notes for the review team

Requires WELD_API_KEY.
`;

export async function run(args: ParsedArgs): Promise<void> {
  const config = loadConfig();
  const manifest = await loadManifest();
  const appId = await resolveAppId(config, manifest.code);

  const notes = flagString(args.flags, 'notes');
  const result = await apiRequest<{ reviewStatus?: string; status?: string } | undefined>(
    config,
    'POST',
    `/v1/user-apps/${encodeURIComponent(appId)}/submit`,
    { body: notes ? { notes } : {} },
  );

  const status = result?.reviewStatus ?? result?.status ?? 'submitted';
  success(`Submitted ${bold(manifest.name)} (${manifest.code}) for review — status: ${status}`);
  info('You will be notified in WeldSuite once the review completes.');
}
