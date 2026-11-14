// The isolation check (`POST /v1/selftest/egress`): which of the given
// `host:port` a TCP connection from inside the pod reaches. The server asks
// for the cloud metadata service and the Kubernetes API; a sandbox that
// reaches either is not isolated, and the server hands out none.

import net from 'node:net';

import { BadRequest, parseTarget } from './util.mjs';

function reaches({ host, port }, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** `POST /v1/selftest/egress`. */
export async function egress(body) {
  const targets = Array.isArray(body.targets) ? body.targets.slice(0, 20) : [];
  const parsed = targets.map((target) => ({ target: String(target), parsed: parseTarget(target) }));
  const bad = parsed.find((t) => !t.parsed);
  if (bad) throw new BadRequest(`${bad.target} is not host:port`);
  const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 2000, 200), 5000);
  const results = await Promise.all(parsed.map(async (t) => ((await reaches(t.parsed, timeoutMs)) ? t.target : null)));
  return { checked: parsed.length, reachable: results.filter(Boolean) };
}
