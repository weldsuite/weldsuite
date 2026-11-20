// The agent inside a WeldAgent sandbox pod (ADR AI-012 phase 5): an HTTP
// API on port 8080 for the server's sandbox tools (`rust/crates/sandbox`,
// `agent.rs` lists the routes). Every request carries the pod's bearer token;
// the pod knows only its SHA-256 (`SANDBOX_TOKEN_SHA256`). After
// `SANDBOX_IDLE_TIMEOUT_SECONDS` without a request the agent exits and the
// pod ends; Kubernetes ends it at its hard lifetime whatever it does.

import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

import * as browser from './lib/browser.mjs';
import { desktop, stopDesktop } from './lib/desktop.mjs';
import { egress } from './lib/egress.mjs';
import { code, exec, listFiles, readFile, writeFile } from './lib/exec.mjs';
import { fetchPage } from './lib/fetch.mjs';
import { BadRequest } from './lib/util.mjs';

export const VERSION = '1.0.0';
const MAX_BODY = 4 * 1024 * 1024;

const ROUTES = {
  'POST /v1/exec': exec,
  'POST /v1/code': code,
  'POST /v1/files/read': readFile,
  'POST /v1/files/write': writeFile,
  'POST /v1/files/list': listFiles,
  'POST /v1/fetch': fetchPage,
  'POST /v1/browser/open': browser.open,
  'POST /v1/browser/act': browser.act,
  'POST /v1/browser/close': browser.close,
  'POST /v1/desktop': desktop,
  'POST /v1/selftest/egress': egress,
  'GET /healthz': async () => ({ ok: true, version: VERSION }),
};

/** Whether `header` is `Bearer <token>` for the digest `expected`. */
export function authorized(header, expected) {
  const match = /^Bearer (\S+)$/.exec(String(header ?? ''));
  if (!match || !/^[0-9a-f]{64}$/.test(expected)) return false;
  const digest = createHash('sha256').update(match[1]).digest();
  return timingSafeEqual(digest, Buffer.from(expected, 'hex'));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new BadRequest('The request is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(body && typeof body === 'object' && !Array.isArray(body) ? body : {});
      } catch {
        reject(new BadRequest('The body must be JSON'));
      }
    });
    request.on('error', reject);
  });
}

function answer(response, status, body) {
  const json = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
  response.end(json);
}

/** The server for the token digest `digest`; `onActivity` on every request. */
export function createServer(digest, onActivity = () => undefined) {
  let inFlight = 0;
  const server = http.createServer(async (request, response) => {
    onActivity();
    if (!authorized(request.headers.authorization, digest)) {
      answer(response, 401, { error: 'Unauthorized' });
      return;
    }
    const route = ROUTES[`${request.method} ${new URL(request.url, 'http://agent').pathname}`];
    if (!route) {
      answer(response, 404, { error: 'Not found' });
      return;
    }
    inFlight += 1;
    try {
      const body = request.method === 'POST' ? await readBody(request) : {};
      answer(response, 200, await route(body));
    } catch (error) {
      if (error instanceof BadRequest) {
        answer(response, 400, { error: error.message });
      } else {
        console.error(JSON.stringify({ level: 'error', route: request.url, message: String(error?.message ?? error) }));
        answer(response, 500, { error: String(error?.message ?? 'The sandbox failed').slice(0, 300) });
      }
    } finally {
      inFlight -= 1;
      onActivity();
    }
  });
  server.busy = () => inFlight > 0;
  return server;
}

function main() {
  const digest = String(process.env.SANDBOX_TOKEN_SHA256 ?? '').toLowerCase();
  // The commands the model runs never see it.
  delete process.env.SANDBOX_TOKEN_SHA256;
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    console.error('SANDBOX_TOKEN_SHA256 is not set: the sandbox refuses to start');
    process.exit(1);
  }
  const idleMs = Math.max(Number(process.env.SANDBOX_IDLE_TIMEOUT_SECONDS) || 900, 30) * 1000;
  let last = Date.now();
  const server = createServer(digest, () => {
    last = Date.now();
  });
  const port = Number(process.env.SANDBOX_AGENT_PORT) || 8080;
  server.listen(port, () => console.log(JSON.stringify({ level: 'info', message: 'sandbox agent ready', port, version: VERSION })));
  const shutdown = async (why) => {
    console.log(JSON.stringify({ level: 'info', message: `sandbox agent stopping: ${why}` }));
    server.close();
    await browser.close().catch(() => undefined);
    stopDesktop();
    process.exit(0);
  };
  setInterval(() => {
    if (!server.busy() && Date.now() - last > idleMs) void shutdown('idle');
  }, 15_000).unref();
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.mjs')) {
  main();
}
