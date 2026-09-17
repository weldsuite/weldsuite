import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { deleteDevSession, loadConfig, putDevSession, resolveAppId, CliError } from '../api.js';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { bold, cyan, dim, info, success, warn } from '../log.js';
import { loadManifest } from '../manifest.js';

export const help = `${bold('weld app dev')} — run the app locally inside WeldSuite

Starts the Vite dev server and registers a per-user preview URL so the
platform iframe at /apps/{code} loads your local build (hot reload). Other
workspace members keep seeing the published bundle.

HTTPS mixed content: the hosted platform cannot iframe http://localhost.
Use ${cyan('--tunnel')} (Cloudflare quick tunnel) when developing against
app-test.weldsuite.org / app.weldsuite.org. Skip the tunnel when the
platform itself is on localhost:3000.

Options:
  --port <n>         Vite port (default: 5173)
  --tunnel           Expose Vite over HTTPS via cloudflared
  --user-id <id>     Clerk user id that should see the preview (required
                     with a workspace API key; personal keys infer it)

Requires weld login or WELD_API_KEY. Optional WELD_DEV_USER_ID is equivalent to --user-id.
`;

const HEARTBEAT_MS = 30_000;

function detectRunner(cwd: string): string {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function parsePort(raw: string | undefined): number {
  if (!raw) return 5173;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1 || value > 65535) {
    throw new CliError(`Invalid --port "${raw}"`);
  }
  return value;
}

function waitForPort(port: number, host = '127.0.0.1', timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const attempt = () => {
      const socket = createServer();
      socket.once('error', () => {
        socket.close();
        resolvePromise();
      });
      socket.once('listening', () => {
        socket.close();
        if (Date.now() - started > timeoutMs) {
          rejectPromise(new CliError(`Timed out waiting for Vite on port ${port}`));
          return;
        }
        setTimeout(attempt, 250);
      });
      socket.listen(port, host);
    };
    attempt();
  });
}

function startVite(cwd: string, port: number): ChildProcess {
  const runner = detectRunner(cwd);
  const args = runner === 'npm' ? ['run', 'dev', '--', '--port', String(port), '--host', '--strictPort'] : ['run', 'dev', '--port', String(port), '--host', '--strictPort'];
  const child = spawn(runner, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, BROWSER: 'none' },
  });
  child.on('error', (cause) => {
    throw new CliError(`Failed to start Vite: ${cause.message}`);
  });
  return child;
}

function startCloudflared(localUrl: string): Promise<{ url: string; process: ChildProcess }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('cloudflared', ['tunnel', '--url', localUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const buffer: string[] = [];
    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      buffer.push(text);
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !settled) {
        settled = true;
        resolvePromise({ url: match[0], process: child });
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (cause) => {
      if (settled) return;
      settled = true;
      rejectPromise(
        new CliError(
          `Could not start cloudflared (${cause.message}).\nInstall it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ then retry with --tunnel.`,
        ),
      );
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      rejectPromise(
        new CliError(`cloudflared exited with code ${code ?? 'unknown'}.\n${buffer.join('')}`),
      );
    });
  });
}

function killProcess(child: ChildProcess | undefined): void {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
}

export async function run(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();
  const config = loadConfig();
  const manifest = await loadManifest(cwd);
  const appId = await resolveAppId(config, manifest.code);
  const port = parsePort(flagString(args.flags, 'port'));
  const useTunnel = flagBool(args.flags, 'tunnel');
  const userId = flagString(args.flags, 'user-id') ?? process.env.WELD_DEV_USER_ID;

  const vite = startVite(cwd, port);
  let tunnel: ChildProcess | undefined;
  let stopped = false;

  const cleanup = async () => {
    if (stopped) return;
    stopped = true;
    killProcess(vite);
    killProcess(tunnel);
    try {
      await deleteDevSession(config, appId, userId);
    } catch {
      // Best-effort — the session TTL will expire it anyway.
    }
  };

  process.once('SIGINT', () => {
    void cleanup().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void cleanup().finally(() => process.exit(0));
  });

  try {
    await waitForPort(port);
    const localUrl = `http://localhost:${port}`;
    let previewUrl = localUrl;
    if (useTunnel) {
      info('Starting Cloudflare quick tunnel…');
      const started = await startCloudflared(localUrl);
      tunnel = started.process;
      previewUrl = started.url;
    }

    await putDevSession(config, appId, previewUrl, userId);
    success(`Preview registered for ${bold(manifest.name)} (${manifest.code})`);
    info(`Open ${cyan(`/apps/${manifest.code}`)} in WeldSuite to load this server.`);
    if (!useTunnel) {
      info(dim('Developing against the hosted platform? Re-run with --tunnel so the iframe is HTTPS.'));
    }
    info(dim('Ctrl+C stops Vite and clears the preview session.'));

    const beat = async () => {
      if (stopped) return;
      try {
        await putDevSession(config, appId, previewUrl, userId);
      } catch (cause) {
        warn(cause instanceof Error ? cause.message : String(cause));
      }
    };
    const timer = setInterval(() => {
      void beat();
    }, HEARTBEAT_MS);

    await new Promise<void>((resolvePromise) => {
      vite.on('exit', () => {
        clearInterval(timer);
        resolvePromise();
      });
    });
  } finally {
    await cleanup();
  }
}
