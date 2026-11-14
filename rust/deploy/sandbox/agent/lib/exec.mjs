// Commands, files and code in the workspace.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { BadRequest, Capped, bounded, cap, childEnv, resolveWorkspacePath, workspaceRoot } from './util.mjs';

const STDOUT_BYTES = 200_000;
const STDERR_BYTES = 80_000;
const READ_BYTES = 400_000;
const WRITE_CHARS = 500_000;
const MAX_TIMEOUT_MS = 120_000;

/** A command's time limit: 60 s unless asked, between 1 s and 2 minutes. */
export function commandTimeoutMs(value) {
  return bounded(value, 60_000, 1_000, MAX_TIMEOUT_MS);
}

/**
 * Runs `file args` in `cwd` with the children's environment, killed (its
 * whole process group) after `timeoutMs`. Output is capped while it is read.
 */
export function run(file, args, { cwd, timeoutMs = 60_000, env = {}, stdin } = {}) {
  const timeout = commandTimeoutMs(timeoutMs);
  return new Promise((resolve) => {
    const stdout = new Capped(STDOUT_BYTES);
    const stderr = new Capped(STDERR_BYTES);
    let timedOut = false;
    const child = spawn(file, args, {
      cwd,
      env: childEnv(env),
      detached: process.platform !== 'win32',
      stdio: [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeout);
    if (stdin != null) child.stdin.end(stdin);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout: '', stderr: String(error.message), timedOut: false, truncated: false });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Whatever the command left running in the background goes too.
      kill();
      resolve({
        exitCode: code ?? (signal ? 128 + 9 : 1),
        stdout: stdout.text(),
        stderr: timedOut ? `${stderr.text()}\n[killed after ${timeout} ms]` : stderr.text(),
        timedOut,
        truncated: stdout.dropped > 0 || stderr.dropped > 0,
      });
    });
  });
}

/** An existing directory under the workspace. */
async function workingDirectory(input) {
  const cwd = resolveWorkspacePath(input);
  await fs.mkdir(workspaceRoot(), { recursive: true });
  const stat = await fs.stat(cwd).catch(() => null);
  if (!stat?.isDirectory()) throw new BadRequest(`${cwd} is not a directory`);
  return cwd;
}

/** `POST /v1/exec`: a bash command. */
export async function exec(body) {
  const command = String(body.command ?? '');
  if (!command.trim() || command.length > 8000) throw new BadRequest('command is required (at most 8000 characters)');
  const cwd = await workingDirectory(body.cwd);
  const result = await run('bash', ['-lc', command], { cwd, timeoutMs: body.timeoutMs });
  return { ok: result.exitCode === 0, ...result };
}

/** `POST /v1/code`: Python or JavaScript, from a file of its own in /tmp. */
export async function code(body) {
  const source = String(body.code ?? '');
  if (!source.trim() || source.length > 100_000) throw new BadRequest('code is required (at most 100000 characters)');
  const language = body.language === 'javascript' ? 'javascript' : 'python';
  const file = path.join('/tmp', `agent-run-${randomBytes(6).toString('hex')}.${language === 'python' ? 'py' : 'mjs'}`);
  await fs.writeFile(file, source, { mode: 0o600 });
  try {
    const cwd = await workingDirectory(undefined);
    const result = await run(language === 'python' ? 'python3' : 'node', [file], { cwd, timeoutMs: body.timeoutMs ?? 120_000 });
    return { ok: result.exitCode === 0, language, ...result };
  } finally {
    await fs.rm(file, { force: true });
  }
}

/** The real path of `file` (or of its parent when it doesn't exist yet), which must stay in the workspace. */
async function insideWorkspace(file) {
  const root = await fs.realpath(workspaceRoot());
  let real;
  try {
    real = await fs.realpath(file);
  } catch {
    const parent = await fs.realpath(path.posix.dirname(file)).catch(() => null);
    if (!parent) return file;
    real = path.posix.join(parent, path.posix.basename(file));
  }
  const normalized = real.replaceAll('\\', '/');
  const rootNormalized = root.replaceAll('\\', '/');
  if (normalized !== rootNormalized && !normalized.startsWith(`${rootNormalized}/`)) {
    throw new BadRequest(`Paths must be under ${workspaceRoot()} (a link points outside it)`);
  }
  return file;
}

/** `POST /v1/files/read`: a text file (capped); binary files are said to be binary. */
export async function readFile(body) {
  const file = await insideWorkspace(resolveWorkspacePath(body.path));
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) throw new BadRequest(`${file} does not exist`);
  if (!stat.isFile()) throw new BadRequest(`${file} is not a file`);
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, READ_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.subarray(0, 8000).includes(0)) {
      return { path: file, content: '', binary: true, bytes: stat.size };
    }
    const content = cap(bytes.toString('utf8'), READ_BYTES);
    return { path: file, content: content.text, bytes: stat.size, truncated: stat.size > READ_BYTES || content.truncated };
  } finally {
    await handle.close();
  }
}

/** `POST /v1/files/write`: replaces the file, creating its directory. */
export async function writeFile(body) {
  const content = String(body.content ?? '');
  if (content.length > WRITE_CHARS) throw new BadRequest(`content is at most ${WRITE_CHARS} characters`);
  const file = resolveWorkspacePath(body.path);
  if (file === workspaceRoot()) throw new BadRequest('path must name a file');
  await fs.mkdir(path.posix.dirname(file), { recursive: true });
  await insideWorkspace(file);
  await fs.writeFile(file, content);
  return { ok: true, path: file, bytes: Buffer.byteLength(content) };
}

/** `POST /v1/files/list`: `ls -la` of a directory. */
export async function listFiles(body) {
  const dir = await insideWorkspace(resolveWorkspacePath(body.path));
  await fs.mkdir(workspaceRoot(), { recursive: true });
  const result = await run('ls', ['-la', '--', dir], { cwd: workspaceRoot(), timeoutMs: 10_000 });
  const listing = cap(result.stdout || result.stderr, 50_000);
  return { path: dir, listing: listing.text, exitCode: result.exitCode };
}
