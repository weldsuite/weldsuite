// Shared helpers of the sandbox agent: errors, caps, paths and addresses.

import { isIP } from 'node:net';
import path from 'node:path';

/** A refusal the caller can act on: answered as 400 with its message. */
export class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequest';
  }
}

/** `text` cut to `max` characters, with how much was left out. */
export function cap(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, max)}\n…[truncated ${value.length - max} characters]`,
    truncated: true,
  };
}

/** Collects a stream's bytes up to `max`, counting what it drops. */
export class Capped {
  constructor(max) {
    this.max = max;
    this.chunks = [];
    this.size = 0;
    this.dropped = 0;
  }

  push(chunk) {
    const room = this.max - this.size;
    if (room <= 0) {
      this.dropped += chunk.length;
      return;
    }
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(kept);
    this.size += kept.length;
    this.dropped += chunk.length - kept.length;
  }

  text() {
    const body = Buffer.concat(this.chunks).toString('utf8');
    return this.dropped > 0 ? `${body}\n…[truncated ${this.dropped} bytes]` : body;
  }
}

/** The sandbox's working directory (`SANDBOX_WORKSPACE`, tests only). */
export function workspaceRoot() {
  return process.env.SANDBOX_WORKSPACE || '/workspace';
}

/**
 * A path under the workspace, or a refusal: no `..`, no NUL, nothing outside.
 * Relative paths are taken from the workspace (the twin of agent-runtime's
 * `resolveWorkspacePath`).
 */
export function resolveWorkspacePath(input, root = workspaceRoot()) {
  const raw = String(input ?? '').trim() || root;
  const normalized = raw.replaceAll('\\', '/');
  if (normalized.includes('\0') || normalized.split('/').includes('..')) {
    throw new BadRequest('Invalid path');
  }
  const absolute = normalized.startsWith('/') ? normalized : `${root}/${normalized}`;
  const clean = path.posix.normalize(absolute).replace(/\/+$/, '') || '/';
  if (clean !== root && !clean.startsWith(`${root}/`)) {
    throw new BadRequest(`Paths must be under ${root}`);
  }
  return clean;
}

/** Whether `ip` is a globally routable address (the twin of `is_public_ip`). */
export function isPublicIp(ip) {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b < 128) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b < 32) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIp(mapped[1]);
    if (lower === '::' || lower === '::1') return false;
    const first = parseInt(lower.split(':')[0] || '0', 16);
    return !(
      (first & 0xfe00) === 0xfc00 || // unique local
      (first & 0xffc0) === 0xfe80 || // link local
      (first & 0xff00) === 0xff00 || // multicast
      lower.startsWith('2001:db8:')
    );
  }
  return false;
}

/** `host:port` or `[v6]:port`, or null. */
export function parseTarget(target) {
  const value = String(target ?? '').trim();
  const v6 = value.match(/^\[([^\]]+)\]:(\d+)$/);
  const plain = value.match(/^([^:\s]+):(\d+)$/);
  const found = v6 ?? plain;
  if (!found) return null;
  const port = Number(found[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: found[1], port };
}

/** The environment of the commands the model runs: never the agent's own. */
export function childEnv(extra = {}) {
  const home = process.env.HOME || '/home/sandbox';
  return {
    PATH: `${home}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    HOME: home,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TERM: 'dumb',
    TMPDIR: '/tmp',
    PYTHONUNBUFFERED: '1',
    PYTHONUSERBASE: `${home}/.local`,
    PIP_USER: '1',
    PIP_BREAK_SYSTEM_PACKAGES: '1',
    MPLCONFIGDIR: `${home}/.config/matplotlib`,
    ...extra,
  };
}
