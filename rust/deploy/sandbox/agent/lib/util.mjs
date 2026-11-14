// Shared helpers of the sandbox agent: errors, caps, paths and addresses.

import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
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

/**
 * A number the caller chose (a timeout, a wait) held between `min` and
 * `max`; `fallback` when it is missing, zero or not a number. Every timer a
 * request can set takes its duration from here, so none outlasts its route.
 */
export function bounded(value, fallback, min, max) {
  const number = Number(value) || fallback;
  if (number > max) return max;
  if (number < min) return min;
  return number;
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

// The addresses that aren't the public internet. The pod's network policy
// drops the private and link-local ranges but not its own loopback, where
// Chromium's DevTools listen, so this list is what keeps a fetch off it.
const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network", unspecified
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // shared address space (carrier NAT)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relays
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
]) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64: an IPv4 address through the network's translator
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001::', 23], // IETF protocol assignments (Teredo, benchmarking, ORCHID)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4: an IPv4 address through a relay
  ['3fff::', 20], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link local
  ['fec0::', 10], // site local (deprecated)
  ['ff00::', 8], // multicast
]) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv6');
}
// IPv6 is public only in global unicast; the rest of the space is reserved.
const GLOBAL_UNICAST = new BlockList();
GLOBAL_UNICAST.addSubnet('2000::', 3, 'ipv6');

/** The eight 16-bit groups of an IPv6 address `isIP` took, dotted tail included. */
function ipv6Groups(ip) {
  const groups = (part) =>
    part
      ? part.split(':').flatMap((piece) => {
          if (!piece.includes('.')) return [parseInt(piece, 16)];
          const [a, b, c, d] = piece.split('.').map(Number);
          return [(a << 8) | b, (c << 8) | d];
        })
      : [];
  const [head, tail] = ip.split('::');
  const left = groups(head);
  if (tail === undefined) return left;
  const right = groups(tail);
  return [...left, ...new Array(8 - left.length - right.length).fill(0), ...right];
}

/**
 * The IPv4 address an IPv6 one stands for: IPv4-mapped (`::ffff:0:0/96`) or
 * IPv4-compatible (`::/96`, which `::` and `::1` are part of), in either the
 * dotted or the hex form (`URL` writes `[::ffff:127.0.0.1]` as
 * `[::ffff:7f00:1]`). Null for any other address.
 */
function embeddedIpv4(groups) {
  if (groups.slice(0, 5).some(Boolean) || (groups[5] !== 0 && groups[5] !== 0xffff)) return null;
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
}

/**
 * Whether `ip` is a globally routable address (the twin of `is_public_ip`).
 * An IPv6 address that carries an IPv4 one is judged as that IPv4 address.
 */
export function isPublicIp(ip) {
  const address = String(ip ?? '');
  const kind = isIP(address);
  if (kind === 4) return !NOT_PUBLIC.check(address, 'ipv4');
  // A zone (`fe80::1%eth0`) only goes with a link-local address.
  if (kind !== 6 || address.includes('%')) return false;
  const groups = ipv6Groups(address.toLowerCase());
  const v4 = embeddedIpv4(groups);
  if (v4) return isPublicIp(v4);
  const full = groups.map((group) => group.toString(16)).join(':');
  return GLOBAL_UNICAST.check(full, 'ipv6') && !NOT_PUBLIC.check(full, 'ipv6');
}

/**
 * A `dns.lookup` for a socket's `lookup` option that answers only names
 * whose every address passes `allowed`, and refuses the rest with a
 * `BadRequest`. The socket connects to the address this answered, so the
 * address checked is the address reached: no second lookup a short-lived DNS
 * answer could change (rebinding). Sockets skip `lookup` for an IP literal,
 * which the caller checks itself.
 */
export function checkedLookup(allowed = isPublicIp) {
  return function lookup(hostname, options, callback) {
    const done = typeof options === 'function' ? options : callback;
    let wanted = {};
    if (typeof options === 'number') wanted = { family: options };
    else if (options && typeof options === 'object') wanted = options;
    dnsLookup(hostname, { ...wanted, all: true }, (error, addresses) => {
      if (error) return done(error);
      if (addresses.length === 0 || !addresses.every((a) => allowed(a.address))) {
        return done(new BadRequest(`${hostname} is not on the public internet.`));
      }
      if (wanted.all) return done(null, addresses);
      return done(null, addresses[0].address, addresses[0].family);
    });
  };
}

/** `checkedLookup` for the public internet. */
export const publicLookup = checkedLookup(isPublicIp);

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
