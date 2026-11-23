import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CliError } from '../api.js';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { bold, cyan, dim, info, success } from '../log.js';
import { type BundleFile, collectFiles, detectRunner, formatBytes, mimeType, runBuild } from './deploy.js';

export const help = `${bold('weld storefront deploy')} — upload a shop you built to WeldCommerce's hosting

Builds the project (npm/pnpm/yarn run build), collects the static output and
uploads it as a new deployment of the sales channel the deploy key belongs to.
Every deployment gets a preview address; ${cyan('--prod')} also makes it the live shop.

Options:
  --dir <dir>            Output directory to upload (default: dist)
  --prod                 Make this deployment live (the shop must be set to host your own code)
  --skip-build           Upload the existing output without building
  --config <file>        Hosting settings (default: weldstorefront.json, when present)

Environment:
  WELDCOMMERCE_DEPLOY_KEY   The channel's deploy key (wcd_…), from Settings → Apps →
                            WeldCommerce → Channels → Keys. Never commit it.
  WELDCOMMERCE_API_URL      Your WeldSuite server, e.g. https://app.weldsuite.eu

weldstorefront.json (all optional):
  { "spa": false, "cleanUrls": true,
    "redirects": [{ "from": "/old", "to": "/new", "status": 301 }],
    "headers": [{ "source": "/assets/*", "headers": { "Cache-Control": "public, max-age=31536000, immutable" } }] }

Limits: 2,000 files, 200 MiB per deployment, 25 MiB per file; an index.html at the root.
`;

export const MAX_FILES = 2000;
export const MAX_BYTES = 200 * 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Files the server refuses, left out: hidden files and folders but `.well-known/`. */
export function uploadable(path: string): boolean {
  return !path.split('/').some((segment) => segment.startsWith('.') && segment !== '.well-known');
}

/** The deploy endpoint of a WeldSuite server. */
export function deployUrl(apiUrl: string, production: boolean): string {
  const base = apiUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) {
    throw new CliError(`WELDCOMMERCE_API_URL must be an http(s) address, not ${JSON.stringify(apiUrl)}`);
  }
  return `${base}/storefront-deploy/v1/deployments${production ? '?production=true' : ''}`;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: { fields?: Record<string, string> } & Record<string, unknown> };
}

/** The server's error answer as one readable message. */
export function describeError(status: number, body: unknown): string {
  const error = (body as ApiErrorBody | undefined)?.error;
  if (!error) return `The server answered ${status}.`;
  const fields = error.details?.fields;
  const lines = [`${error.message ?? 'The deployment was refused'} (${error.code ?? status})`];
  if (fields) {
    for (const [path, message] of Object.entries(fields)) lines.push(`  ${path}: ${message}`);
  }
  return lines.join('\n');
}

/** What the upload checks before sending anything. */
export function checkBundle(files: BundleFile[]): void {
  if (files.length === 0) throw new CliError('Nothing to upload: the output directory is empty.');
  if (!files.some((file) => file.path === 'index.html')) {
    throw new CliError('The output has no index.html at its root.');
  }
  if (files.length > MAX_FILES) {
    throw new CliError(`${files.length} files: a deployment has at most ${MAX_FILES}.`);
  }
  const large = files.find((file) => file.bytes.byteLength > MAX_FILE_BYTES);
  if (large) throw new CliError(`${large.path} is larger than 25 MiB.`);
  const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (total > MAX_BYTES) throw new CliError(`${formatBytes(total)}: a deployment is at most 200 MiB.`);
}

interface Deployment {
  id: string;
  status: string;
  fileCount: number;
  totalBytes: number;
  isProduction: boolean;
  previewUrl: string | null;
}

export async function run(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();
  const key = process.env.WELDCOMMERCE_DEPLOY_KEY?.trim();
  if (!key?.startsWith('wcd_')) {
    throw new CliError('Set WELDCOMMERCE_DEPLOY_KEY to the channel\'s deploy key (wcd_…).');
  }
  const apiUrl = process.env.WELDCOMMERCE_API_URL?.trim();
  if (!apiUrl) {
    throw new CliError('Set WELDCOMMERCE_API_URL to your WeldSuite server, e.g. https://app.weldsuite.eu');
  }
  const production = flagBool(args.flags, 'prod');
  const url = deployUrl(apiUrl, production);

  if (!flagBool(args.flags, 'skip-build')) {
    const runner = detectRunner(cwd);
    info(`Building with ${cyan(`${runner} run build`)} …`);
    await runBuild(runner, cwd);
  }

  const outputDir = resolve(cwd, flagString(args.flags, 'dir') ?? 'dist');
  const isDir = await stat(outputDir).then((s) => s.isDirectory(), () => false);
  if (!isDir) throw new CliError(`${outputDir} does not exist — did the build write a dist/ folder? Use --dir otherwise.`);
  const files = (await collectFiles(outputDir)).filter((file) => uploadable(file.path));
  checkBundle(files);

  const form = new FormData();
  const configPath = flagString(args.flags, 'config') ?? (existsSync(join(cwd, 'weldstorefront.json')) ? 'weldstorefront.json' : undefined);
  if (configPath) {
    const raw = await readFile(resolve(cwd, configPath), 'utf8').catch(() => {
      throw new CliError(`${configPath} can't be read.`);
    });
    try {
      JSON.parse(raw);
    } catch {
      throw new CliError(`${configPath} is not valid JSON.`);
    }
    form.append('config', new Blob([raw], { type: 'application/json' }), 'weldstorefront.json');
  }
  for (const file of files) {
    form.append('files', new Blob([new Uint8Array(file.bytes)], { type: mimeType(file.path) }), file.path);
  }
  const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  info(`Uploading ${bold(String(files.length))} files (${formatBytes(total)}) …`);

  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form }).catch(
    (cause: unknown) => {
      throw new CliError(`Could not reach ${apiUrl}: ${cause instanceof Error ? cause.message : String(cause)}`);
    },
  );
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new CliError(describeError(response.status, body));
  const deployment = (body as { data?: Deployment } | undefined)?.data;
  if (!deployment) throw new CliError('The server answered without a deployment.');

  success(`Deployed ${bold(deployment.id)}${deployment.isProduction ? ' — live' : ''}`);
  if (deployment.previewUrl) info(`Preview: ${cyan(deployment.previewUrl)}`);
  if (!deployment.isProduction) {
    info(dim(`Make it live with ${cyan('weld storefront deploy --prod')}, or promote it in Settings → Apps → WeldCommerce → Online store.`));
  }
}
