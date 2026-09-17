import { apiRequest, loadConfig, resolveAppId } from '../api.js';
import { flagString, type ParsedArgs } from '../args.js';
import { bold, info, renderTable } from '../log.js';
import { loadManifest } from '../manifest.js';

export const help = `${bold('weld app versions')} — list uploaded versions

Shows version, status, date and bundle size from
GET /v1/user-apps/:id/versions.

Options:
  --code <code>     App code (default: weldapp.json)

Requires weld login (or WELD_API_KEY).
`;

interface VersionRow {
  version?: string;
  status?: string;
  createdAt?: string;
  bundleSize?: number | null;
}

function formatBytes(total: number | null | undefined): string {
  if (total == null) return '-';
  if (total < 1024) return `${total} B`;
  if (total < 1024 * 1024) return `${(total / 1024).toFixed(1)} KB`;
  return `${(total / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(raw: string | undefined): string {
  if (!raw) return '-';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toISOString().slice(0, 10);
}

export async function run(args: ParsedArgs): Promise<void> {
  const config = loadConfig();
  const codeFlag = flagString(args.flags, 'code');
  const code = codeFlag ?? (await loadManifest()).code;
  const appId = await resolveAppId(config, code);
  const versions = await apiRequest<VersionRow[]>(
    config,
    'GET',
    `/v1/user-apps/${encodeURIComponent(appId)}/versions`,
  );

  if (!versions || versions.length === 0) {
    info(`No versions yet for ${bold(code)}. Deploy with \`weld app deploy\`.`);
    return;
  }

  const rows = versions.map((v) => [
    v.version ?? '-',
    v.status ?? '-',
    formatDate(v.createdAt),
    formatBytes(v.bundleSize),
  ]);
  info(renderTable(['VERSION', 'STATUS', 'DATE', 'SIZE'], rows));
}
