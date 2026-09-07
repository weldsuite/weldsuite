import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { computerEnabled } from '../lib/auth';
import { getWorkspaceSandbox, resolveWorkspacePath, workspaceSandboxId } from '../lib/sandbox';

type AppEnv = { Bindings: Env };

const execSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  command: z.string().min(1).max(8000),
  cwd: z.string().max(500).optional(),
  timeoutMs: z.number().int().min(1000).max(120_000).optional(),
});

const fileSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  path: z.string().min(1).max(500),
});

const writeSchema = fileSchema.extend({
  content: z.string().max(500_000),
});

const codeSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  code: z.string().min(1).max(100_000),
  language: z.enum(['python', 'javascript']).default('python'),
});

const statusSchema = z.object({
  workspaceId: z.string().min(1).max(128),
});

export const computerRoutes = new Hono<AppEnv>();

computerRoutes.get('/status', async (c) => {
  if (!computerEnabled(c.env)) {
    return c.json({ enabled: false, reason: 'AGENT_COMPUTER_ENABLED=false' });
  }
  const workspaceId = c.req.query('workspaceId');
  if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
  return c.json({
    enabled: true,
    sandboxId: workspaceSandboxId(workspaceId),
    workspaceId,
  });
});

computerRoutes.post('/exec', async (c) => {
  if (!computerEnabled(c.env)) return c.json({ error: 'Computer disabled' }, 503);
  const body = execSchema.parse(await c.req.json());
  const sandbox = getWorkspaceSandbox(c.env, body.workspaceId);
  const cwd = body.cwd ? resolveWorkspacePath(body.cwd) : '/workspace';
  if (typeof cwd === 'object') return c.json(cwd, 400);

  const command = body.command;
  const result = await sandbox.exec(command, {
    timeout: body.timeoutMs,
    cwd: typeof cwd === 'string' ? cwd : '/workspace',
  });

  return c.json({
    ok: result.success ?? result.exitCode === 0,
    stdout: truncate(result.stdout ?? '', 50_000),
    stderr: truncate(result.stderr ?? '', 20_000),
    exitCode: result.exitCode ?? (result.success ? 0 : 1),
    sandboxId: workspaceSandboxId(body.workspaceId),
  });
});

computerRoutes.post('/files/read', async (c) => {
  if (!computerEnabled(c.env)) return c.json({ error: 'Computer disabled' }, 503);
  const body = fileSchema.parse(await c.req.json());
  const path = resolveWorkspacePath(body.path);
  if (typeof path === 'object') return c.json(path, 400);
  const sandbox = getWorkspaceSandbox(c.env, body.workspaceId);
  const file = await sandbox.readFile(path);
  return c.json({
    path,
    content: truncate(typeof file === 'string' ? file : (file.content ?? ''), 200_000),
  });
});

computerRoutes.post('/files/write', async (c) => {
  if (!computerEnabled(c.env)) return c.json({ error: 'Computer disabled' }, 503);
  const body = writeSchema.parse(await c.req.json());
  const path = resolveWorkspacePath(body.path);
  if (typeof path === 'object') return c.json(path, 400);
  const sandbox = getWorkspaceSandbox(c.env, body.workspaceId);
  await sandbox.writeFile(path, body.content);
  return c.json({ ok: true, path, bytes: body.content.length });
});

computerRoutes.post('/files/list', async (c) => {
  if (!computerEnabled(c.env)) return c.json({ error: 'Computer disabled' }, 503);
  const body = fileSchema.parse(await c.req.json());
  const path = resolveWorkspacePath(body.path);
  if (typeof path === 'object') return c.json(path, 400);
  const sandbox = getWorkspaceSandbox(c.env, body.workspaceId);
  const result = await sandbox.exec(`ls -la ${JSON.stringify(path)}`);
  return c.json({
    path,
    listing: truncate(result.stdout ?? '', 50_000),
    exitCode: result.exitCode ?? 0,
  });
});

computerRoutes.post('/code', async (c) => {
  if (!computerEnabled(c.env)) return c.json({ error: 'Computer disabled' }, 503);
  const body = codeSchema.parse(await c.req.json());
  const sandbox = getWorkspaceSandbox(c.env, body.workspaceId);

  try {
    const result = await sandbox.runCode(body.code, { language: body.language });
    return c.json({
      ok: true,
      language: body.language,
      stdout: truncate(String((result as { stdout?: string }).stdout ?? (result as { results?: unknown }).results ?? ''), 50_000),
      stderr: truncate(String((result as { error?: string }).error ?? ''), 20_000),
      raw: summarize(result),
    });
  } catch {
    const file =
      body.language === 'javascript' ? '/workspace/.agent_run.js' : '/workspace/.agent_run.py';
    await sandbox.writeFile(file, body.code);
    const cmd = body.language === 'javascript' ? `node ${file}` : `python3 ${file}`;
    const result = await sandbox.exec(cmd);
    return c.json({
      ok: result.success ?? result.exitCode === 0,
      language: body.language,
      stdout: truncate(result.stdout ?? '', 50_000),
      stderr: truncate(result.stderr ?? '', 20_000),
      exitCode: result.exitCode ?? 1,
    });
  }
});

computerRoutes.post('/destroy', async (c) => {
  if (!computerEnabled(c.env)) return c.json({ error: 'Computer disabled' }, 503);
  const body = statusSchema.parse(await c.req.json());
  const sandbox = getWorkspaceSandbox(c.env, body.workspaceId);
  if (typeof sandbox.destroy === 'function') {
    await sandbox.destroy();
  }
  return c.json({ ok: true, sandboxId: workspaceSandboxId(body.workspaceId) });
});

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

function summarize(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}
