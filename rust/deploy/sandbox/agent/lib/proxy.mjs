// Chromium's way out: an HTTP proxy on 127.0.0.1 that the browser sends
// every connection through (`--proxy-server`, loopback included), so it
// reaches only what web_fetch may: public addresses, checked as each
// connection is made and connected to as checked. Redirects, subresources
// and a page's own requests take the same road; checking the URL handed to
// `browser_open` alone would leave those to Chromium.

import http from 'node:http';
import net from 'node:net';

import { BadRequest, checkedLookup, isPublicIp, parseTarget } from './util.mjs';

const CONNECT_TIMEOUT_MS = 15_000;
// Headers about the hop to the proxy, not the request.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
]);

function withoutHopHeaders(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i += 2) {
    if (!HOP_BY_HOP.has(raw[i].toLowerCase())) out.push(raw[i], raw[i + 1]);
  }
  return out;
}

function refusal(error) {
  return error instanceof BadRequest ? [403, error.message] : [502, 'The site could not be reached.'];
}

/** A plain-http request (`GET http://host/path`): checked, then passed on. */
function forward(request, response, allowed, lookup) {
  const deny = (status, message) => {
    if (response.headersSent) return response.destroy();
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
    return response.end(`Blocked by the sandbox: ${message}`);
  };
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return deny(400, 'not a proxy request.');
  }
  if (url.protocol !== 'http:') return deny(400, 'only http goes through as a request.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !allowed(host)) return deny(403, `${host} is not on the public internet.`);
  const upstream = http.request(
    {
      host,
      port: url.port || 80,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: withoutHopHeaders(request.rawHeaders),
      lookup,
      agent: false,
    },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.statusMessage, withoutHopHeaders(answer.rawHeaders));
      answer.pipe(response);
    },
  );
  upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error('timeout')));
  upstream.on('error', (error) => deny(...refusal(error)));
  response.on('close', () => upstream.destroy());
  request.pipe(upstream);
  return undefined;
}

/** A tunnel (`CONNECT host:443`, https and WebSockets): checked, then joined. */
function tunnel(request, client, head, allowed, lookup) {
  client.on('error', () => undefined);
  const deny = ([status, message]) => {
    const head = `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\ncontent-type: text/plain\r\nconnection: close`;
    client.end(`${head}\r\n\r\nBlocked by the sandbox: ${message}`);
  };
  const target = parseTarget(request.url);
  if (!target) return deny([400, 'not host:port.']);
  if (net.isIP(target.host) && !allowed(target.host)) return deny([403, `${target.host} is not on the public internet.`]);
  let joined = false;
  const upstream = net.connect({ host: target.host, port: target.port, lookup });
  upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error('timeout')));
  upstream.once('connect', () => {
    joined = true;
    upstream.setTimeout(0);
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on('error', (error) => {
    if (joined) client.destroy();
    else deny(refusal(error));
  });
  client.on('close', () => upstream.destroy());
  return undefined;
}

/**
 * The proxy server, not yet listening. `allowed` is for the tests, which
 * serve on loopback; the browser always gets the public internet.
 */
export function createProxy({ allowed = isPublicIp } = {}) {
  const lookup = checkedLookup(allowed);
  const server = http.createServer((request, response) => forward(request, response, allowed, lookup));
  server.on('connect', (request, client, head) => tunnel(request, client, head, allowed, lookup));
  server.on('clientError', (_error, socket) => socket.destroy());
  return server;
}

let listening = null;

/** The running proxy's `http://127.0.0.1:port`, started on first use. */
export function proxyUrl() {
  listening ??= new Promise((resolve, reject) => {
    const server = createProxy();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  }).catch((error) => {
    listening = null;
    throw error;
  });
  return listening;
}
