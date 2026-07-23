import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { apiRequest, CliError, loadConfig, resolveAppId } from '../api.js';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { bold, cyan, dim, info, success } from '../log.js';
import { loadManifest } from '../manifest.js';

export const help = `${bold('weld app deploy')} — build and upload a new version

Validates weldapp.json, runs the project build, collects the bundle and
uploads it as a new version (POST /v1/user-apps/:id/versions) together with
the manifest. The version number comes from weldapp.json's "version".

Options:
  --dir <dir>            Bundle directory to upload (default: dist)
  --changelog <text>     Changelog entry for this version
  --skip-build           Upload the existing bundle without rebuilding

Requires WELD_API_KEY. The app must exist — run ${cyan('weld app create')} first.
`;

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.mjs': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function mimeType(path: string): string {
  const dot = path.lastIndexOf('.');
  const extension = dot === -1 ? '' : path.slice(dot).toLowerCase();
  return MIME_TYPES[extension] ?? 'application/octet-stream';
}

/** Pick the package runner matching the project's lockfile. */
function detectRunner(cwd: string): string {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (existsSync(join(cwd, 'yarn.lock'))) {
    return 'yarn';
  }
  return 'npm';
}

function runBuild(runner: string, cwd: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(runner, ['run', 'build'], {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', (cause) => {
      rejectPromise(new CliError(`Failed to start "${runner} run build": ${cause.message}`));
    });
    child.on('exit', (exitCode) => {
      if (exitCode === 0) {
        resolvePromise();
      } else {
        rejectPromise(new CliError(`"${runner} run build" exited with code ${exitCode ?? 'unknown'}.`));
      }
    });
  });
}

interface BundleFile {
  /** Bundle-relative path with forward slashes — becomes the uploaded file name. */
  path: string;
  bytes: Buffer;
}

async function collectFiles(root: string, dir = root): Promise<BundleFile[]> {
  const files: BundleFile[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, fullPath)));
    } else if (entry.isFile()) {
      files.push({
        path: relative(root, fullPath).split('\\').join('/'),
        bytes: await readFile(fullPath),
      });
    }
  }
  return files;
}

function formatBytes(total: number): string {
  if (total < 1024) {
    return `${total} B`;
  }
  if (total < 1024 * 1024) {
    return `${(total / 1024).toFixed(1)} KB`;
  }
  return `${(total / (1024 * 1024)).toFixed(2)} MB`;
}

export async function run(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();
  const config = loadConfig();
  const manifest = await loadManifest(cwd);
  const appId = await resolveAppId(config, manifest.code);

  if (!flagBool(args.flags, 'skip-build')) {
    const runner = detectRunner(cwd);
    info(`Building with ${cyan(`${runner} run build`)} …`);
    await runBuild(runner, cwd);
  }

  const bundleDir = resolve(cwd, flagString(args.flags, 'dir') ?? 'dist');
  try {
    const stats = await stat(bundleDir);
    if (!stats.isDirectory()) {
      throw new Error('not a directory');
    }
  } catch {
    throw new CliError(`Bundle directory ${bundleDir} does not exist — did the build produce a dist/ folder?`);
  }

  const files = await collectFiles(bundleDir);
  if (files.length === 0) {
    throw new CliError(`Bundle directory ${bundleDir} is empty — nothing to upload.`);
  }
  const totalBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  info(`Uploading ${bold(String(files.length))} files (${formatBytes(totalBytes)}) as version ${bold(manifest.version)} …`);

  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));
  const changelog = flagString(args.flags, 'changelog');
  if (changelog) {
    form.append('changelog', changelog);
  }
  for (const file of files) {
    // File name = bundle-relative path, so the server can reconstruct the tree.
    form.append('files', new Blob([new Uint8Array(file.bytes)], { type: mimeType(file.path) }), file.path);
  }

  const version = await apiRequest<{ version?: string; status?: string } | undefined>(
    config,
    'POST',
    `/v1/user-apps/${encodeURIComponent(appId)}/versions`,
    { form },
  );

  success(
    `Deployed ${bold(manifest.name)} ${bold(version?.version ?? manifest.version)}` +
      (version?.status ? ` — status: ${version.status}` : ''),
  );
  info(dim(`${files.length} files, ${formatBytes(totalBytes)} total`));
}
