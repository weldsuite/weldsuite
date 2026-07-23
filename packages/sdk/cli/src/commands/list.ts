import { listApps, loadConfig } from '../api.js';
import { type ParsedArgs } from '../args.js';
import { bold, info, renderTable } from '../log.js';

export const help = `${bold('weld app list')} — list your workspace's apps

Shows code, name, visibility, review status and install count for every app
returned by GET /v1/user-apps.

Requires WELD_API_KEY.
`;

export async function run(_args: ParsedArgs): Promise<void> {
  const config = loadConfig();
  const apps = await listApps(config);

  if (apps.length === 0) {
    info('No apps yet. Scaffold one with `weld app init` and register it with `weld app create`.');
    return;
  }

  const rows = apps.map((app) => [
    app.code,
    app.name,
    app.visibility ?? 'private',
    app.reviewStatus ?? app.review_status ?? '-',
    String(app.installCount ?? app.installs ?? 0),
  ]);

  info(renderTable(['CODE', 'NAME', 'VISIBILITY', 'REVIEW', 'INSTALLS'], rows));
}
