// The sandbox agent's own checks, run with `node --test test/` (no
// dependencies, no browser or desktop needed): auth, paths, caps, addresses,
// page text, the desktop's action plans, and the HTTP server end to end on
// a temporary workspace.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import zlib from 'node:zlib';

import { waitMs } from '../lib/browser.mjs';
import { pauseMs, plan } from '../lib/desktop.mjs';
import { egress } from '../lib/egress.mjs';
import { commandTimeoutMs } from '../lib/exec.mjs';
import { checkUrl, fetchPage, htmlToText, parseUrl } from '../lib/fetch.mjs';
import { createProxy } from '../lib/proxy.mjs';
import {
  BadRequest,
  Capped,
  bounded,
  cap,
  checkedLookup,
  isPublicIp,
  parseTarget,
  publicLookup,
  resolveWorkspacePath,
} from '../lib/util.mjs';
import { authorized, createServer } from '../server.mjs';

const LOOPBACK_ONLY = (ip) => ip === '127.0.0.1';

/** An HTTP server on 127.0.0.1 answering with `handler`, counting requests. */
async function local(handler = (_request, response) => response.end('local')) {
  const server = http.createServer((request, response) => {
    server.hits += 1;
    handler(request, response);
  });
  server.hits = 0;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.port = server.address().port;
  return server;
}

function lookupOnce(lookup, hostname, options) {
  return new Promise((resolve) => {
    lookup(hostname, options, (error, address, family) => resolve({ error, address, family }));
  });
}

const TOKEN = 'a'.repeat(64);
const DIGEST = createHash('sha256').update(TOKEN).digest('hex');

describe('auth', () => {
  it('takes the token whose digest the pod holds, and nothing else', () => {
    assert.equal(authorized(`Bearer ${TOKEN}`, DIGEST), true);
    assert.equal(authorized(`Bearer ${TOKEN}x`, DIGEST), false);
    assert.equal(authorized(`Basic ${TOKEN}`, DIGEST), false);
    assert.equal(authorized(undefined, DIGEST), false);
    assert.equal(authorized(`Bearer ${TOKEN}`, 'not-a-digest'), false);
  });
});

describe('paths', () => {
  it('keeps every path under the workspace', () => {
    assert.equal(resolveWorkspacePath('notes.txt', '/workspace'), '/workspace/notes.txt');
    assert.equal(resolveWorkspacePath('/workspace/a/./b/', '/workspace'), '/workspace/a/b');
    assert.equal(resolveWorkspacePath('', '/workspace'), '/workspace');
    for (const bad of ['../etc/passwd', '/etc/passwd', '/workspace/../etc', 'a\0b', '/workspacex/a']) {
      assert.throws(() => resolveWorkspacePath(bad, '/workspace'), BadRequest, bad);
    }
  });
});

describe('caps', () => {
  it('cuts and says so', () => {
    assert.deepEqual(cap('abc', 5), { text: 'abc', truncated: false });
    assert.match(cap('x'.repeat(10), 4).text, /^xxxx\n…\[truncated 6 characters\]$/);
    const out = new Capped(4);
    out.push(Buffer.from('hello'));
    out.push(Buffer.from('world'));
    assert.equal(out.text(), 'hell\n…[truncated 6 bytes]');
  });
});

describe('addresses', () => {
  it('knows what is public', () => {
    for (const ip of ['1.1.1.1', '9.9.9.9', '192.0.78.9', '203.0.114.5', '2a01:4f8::1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '::ffff:808:808', '::808:808']) {
      assert.equal(isPublicIp(ip), true, ip);
    }
    for (const ip of [
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '192.0.0.8',
      '192.0.2.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.5',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fd00::1',
      'fe80::1',
      'fe80::1%eth0',
      'fec0::1',
      'ff02::1',
      '2001:db8::1',
      '3fff::1',
      '2001::1',
      '4000::1',
      'nonsense',
      undefined,
    ]) {
      assert.equal(isPublicIp(ip), false, ip);
    }
  });

  it('judges an IPv6 address that carries an IPv4 one as that IPv4 address', () => {
    for (const ip of [
      '::ffff:10.0.0.1', // IPv4-mapped, dotted
      '::ffff:127.0.0.1',
      '::ffff:7f00:1', // IPv4-mapped, hex: how URL writes [::ffff:127.0.0.1]
      '0:0:0:0:0:ffff:7f00:1',
      '::ffff:a9fe:a9fe', // the metadata service
      '::127.0.0.1', // IPv4-compatible, dotted
      '::7f00:1', // IPv4-compatible, hex
      '::a00:1',
      '64:ff9b::7f00:1', // NAT64
      '64:ff9b::808:808',
      '64:ff9b:1::1', // local-use NAT64
      '2002:7f00:1::', // 6to4
      '2002:808:808::1',
      '100::1', // discard
      '::ffff:0:7f00:1', // SIIT
    ]) {
      assert.equal(isPublicIp(ip), false, ip);
    }
  });

  it('refuses every way a URL can write a loopback or private host', () => {
    for (const raw of [
      'http://[::ffff:127.0.0.1]:9222/json/list',
      'http://[::ffff:7f00:1]:9222/json/list',
      'http://[::7f00:1]:9222/',
      'http://[::127.0.0.1]/',
      'http://[64:ff9b::7f00:1]/',
      'http://[2002:7f00:1::]/',
      'http://[100::1]/',
      'http://[::]/',
      'http://127.1/',
      'http://0x7f000001/',
      'http://2130706433/',
      'http://0177.0.0.1/',
      'http://[::ffff:a9fe:a9fe]/latest/',
    ]) {
      assert.throws(() => parseUrl(raw), BadRequest, raw);
    }
    assert.equal(parseUrl('https://example.com/a?b').toString(), 'https://example.com/a?b');
    assert.throws(() => parseUrl('ftp://example.com/'), BadRequest);
    assert.throws(() => parseUrl('http://user:pw@example.com/'), BadRequest);
  });

  it('refuses a name whose address is not public, on the lookup a socket makes', async () => {
    for (const options of [{}, { all: true }, 4, { family: 0, all: true, hints: 0 }]) {
      const { error } = await lookupOnce(publicLookup, 'localhost', options);
      assert.ok(error instanceof BadRequest, JSON.stringify(options));
      assert.match(error.message, /not on the public internet/);
    }
    await assert.rejects(checkUrl('http://localhost:9222/json/list'), /not on the public internet/);
    // Allowed, the answer is the address the socket then connects to.
    const one = await lookupOnce(checkedLookup(() => true), 'localhost', { family: 4 });
    assert.deepEqual([one.error, one.address, one.family], [null, '127.0.0.1', 4]);
    const all = await lookupOnce(checkedLookup(() => true), 'localhost', { all: true, family: 4 });
    assert.deepEqual(all.address, [{ address: '127.0.0.1', family: 4 }]);
  });

  it('parses targets', () => {
    assert.deepEqual(parseTarget('169.254.169.254:80'), { host: '169.254.169.254', port: 80 });
    assert.deepEqual(parseTarget('[fd00::1]:443'), { host: 'fd00::1', port: 443 });
    assert.equal(parseTarget('nohost'), null);
    assert.equal(parseTarget('a:99999'), null);
  });

  it('reports what a connection reaches', async () => {
    const server = (await import('node:net')).createServer().listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const open = `127.0.0.1:${server.address().port}`;
    const result = await egress({ targets: [open, '127.0.0.1:1'], timeoutMs: 500 });
    server.close();
    assert.deepEqual(result, { checked: 2, reachable: [open] });
    await assert.rejects(egress({ targets: ['bad'] }), BadRequest);
  });
});

describe('page text', () => {
  it('drops scripts and markup, keeps the words', () => {
    const { title, text } = htmlToText(
      '<html><head><title>T &amp; T</title><style>x{}</style></head><body><script>steal()</script><h1>Hello</h1><p>World&nbsp;&#33;</p><!-- hidden --><ul><li>a</li><li>b</li></ul></body></html>',
    );
    assert.equal(title, 'T & T');
    assert.equal(text.includes('steal'), false);
    assert.equal(text.includes('hidden'), false);
    assert.match(text, /Hello\s+World !/);
    assert.match(text, /- a\s+- b/);
  });
});

describe('web_fetch', () => {
  let site;

  before(async () => {
    site = await local((request, response) => {
      const html = '<html><head><title>Hi</title></head><body><p>Hello there</p></body></html>';
      if (request.url === '/start') {
        response.writeHead(302, { location: '/page' });
        response.end();
      } else if (request.url === '/page') {
        response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        response.end(zlib.gzipSync(html));
      } else if (request.url === '/br') {
        response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'br' });
        response.end(zlib.brotliCompressSync('x'.repeat(5000)));
      } else if (request.url === '/away') {
        response.writeHead(301, { location: `http://127.0.0.2:${site.port}/page` });
        response.end();
      } else {
        response.end('local');
      }
    });
  });

  after(() => site.close());

  it('follows redirects and decodes what it reads', async () => {
    const page = await fetchPage({ url: `http://127.0.0.1:${site.port}/start` }, { allowed: LOOPBACK_ONLY });
    assert.equal(page.status, 200);
    assert.equal(page.ok, true);
    assert.equal(page.url, `http://127.0.0.1:${site.port}/page`);
    assert.equal(page.title, 'Hi');
    assert.match(page.text, /Hello there/);
    const capped = await fetchPage({ url: `http://127.0.0.1:${site.port}/br`, maxBytes: 1000 }, { allowed: LOOPBACK_ONLY });
    assert.equal(capped.truncated, true);
    assert.equal(capped.text, 'x'.repeat(1000));
  });

  it('checks every redirect', async () => {
    await assert.rejects(fetchPage({ url: `http://127.0.0.1:${site.port}/away` }, { allowed: LOOPBACK_ONLY }), /127\.0\.0\.2 is not on the public internet/);
  });

  it('checks a name as it connects, over http and https', async () => {
    const before = site.hits;
    for (const url of [`http://localhost:${site.port}/`, `https://localhost:${site.port}/`]) {
      await assert.rejects(fetchPage({ url }), /localhost is not on the public internet/, url);
    }
    assert.equal(site.hits, before);
  });
});

describe('the browser proxy', () => {
  let site;
  let closed;
  let open;

  const listen = async (server) => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
  };

  const get = (proxyPort, target) =>
    new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: proxyPort, path: target, headers: { host: new URL(target).host } }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', reject);
      request.end();
    });

  const connect = (proxyPort, authority) =>
    new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: authority });
      request.on('connect', (response, socket) => resolve({ status: response.statusCode, socket }));
      request.on('error', reject);
      request.end();
    });

  before(async () => {
    site = await local((request, response) => response.end(`hello ${request.headers.host}`));
    closed = createProxy();
    open = createProxy({ allowed: LOOPBACK_ONLY });
    closed.port = await listen(closed);
    open.port = await listen(open);
  });

  after(() => {
    site.close();
    closed.close();
    open.close();
  });

  it('refuses loopback and private hosts, however written', async () => {
    for (const host of ['127.0.0.1', 'localhost', '[::ffff:7f00:1]', '[::7f00:1]', '[::1]', '169.254.169.254']) {
      const answer = await get(closed.port, `http://${host}:${site.port}/json/list`);
      assert.equal(answer.status, 403, host);
      assert.match(answer.body, /not on the public internet/, host);
      const tunnel = await connect(closed.port, `${host}:${site.port}`);
      tunnel.socket.destroy();
      assert.equal(tunnel.status, 403, host);
    }
    assert.equal(site.hits, 0);
  });

  it('passes on what it allows, to the address it checked', async () => {
    const answer = await get(open.port, `http://127.0.0.1:${site.port}/`);
    assert.deepEqual(answer, { status: 200, body: `hello 127.0.0.1:${site.port}` });
    const tunnel = await connect(open.port, `127.0.0.1:${site.port}`);
    assert.equal(tunnel.status, 200);
    const reply = await new Promise((resolve) => {
      const chunks = [];
      tunnel.socket.on('data', (chunk) => chunks.push(chunk));
      tunnel.socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      tunnel.socket.write(`GET / HTTP/1.1\r\nhost: tunnelled\r\nconnection: close\r\n\r\n`);
    });
    assert.match(reply, /^HTTP\/1\.1 200[\s\S]*hello tunnelled$/);
  });
});

describe('timers', () => {
  it('holds every duration a caller sets between its bounds', () => {
    assert.equal(bounded(undefined, 5, 1, 10), 5);
    assert.equal(bounded('abc', 5, 1, 10), 5);
    assert.equal(bounded(0, 5, 1, 10), 5);
    assert.equal(bounded(7, 5, 1, 10), 7);
    assert.equal(bounded(-3, 5, 1, 10), 1);
    assert.equal(bounded(1e15, 5, 1, 10), 10);
    assert.equal(bounded('Infinity', 5, 1, 10), 10);
    assert.equal(bounded('-Infinity', 5, 1, 10), 1);
    assert.equal(commandTimeoutMs(undefined), 60_000);
    assert.equal(commandTimeoutMs(5_000), 5_000);
    assert.equal(commandTimeoutMs(1), 1_000);
    assert.equal(commandTimeoutMs(2 ** 40), 120_000);
    assert.equal(waitMs(undefined), 1000);
    assert.equal(waitMs(-50), 0);
    assert.equal(waitMs(2 ** 40), 30_000);
    assert.equal(pauseMs(undefined), 1000);
    assert.equal(pauseMs(2.5), 2500);
    assert.equal(pauseMs(-1), 0);
    assert.equal(pauseMs(1e12), 10_000);
  });
});

describe('desktop actions', () => {
  it('turns actions into xdotool steps and refuses the rest', () => {
    assert.deepEqual(plan({ action: 'left_click', coordinate: [10, 20] }), [
      ['mousemove', '--sync', '10', '20'],
      ['click', '--repeat', '1', '--delay', '80', '1'],
    ]);
    assert.deepEqual(plan({ action: 'key', text: 'ctrl+l Return' }), [['key', '--delay', '50', '--', 'ctrl+l', 'Return']]);
    assert.deepEqual(plan({ action: 'type', text: '--help; rm -rf /' })[0].slice(0, 4), ['type', '--delay', '12', '--']);
    assert.deepEqual(plan({ action: 'scroll', scrollDirection: 'up', scrollAmount: 2 }), [['click', '--repeat', '2', '--delay', '30', '4']]);
    assert.equal(plan({ action: 'wait' }), null);
    assert.throws(() => plan({ action: 'left_click', coordinate: [5000, 1] }), BadRequest);
    assert.throws(() => plan({ action: 'key', text: '$(reboot)' }), BadRequest);
    assert.throws(() => plan({ action: 'mouse_move' }), BadRequest);
    assert.throws(() => plan({ action: 'format_disk' }), BadRequest);
  });
});

describe('the server', () => {
  let server;
  let base;
  let workspace;

  before(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-agent-'));
    process.env.SANDBOX_WORKSPACE = workspace.replaceAll('\\', '/');
    server = createServer(DIGEST);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const call = async (route, body, token = TOKEN) => {
    const [method, pathname] = route.split(' ');
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };

  it('refuses a request without the token', async () => {
    assert.equal((await call('GET /healthz', null, 'wrong')).status, 401);
    assert.deepEqual((await call('GET /healthz')).body, { ok: true, version: '1.0.0' });
    assert.equal((await call('POST /v1/nothing')).status, 404);
  });

  it('writes, reads and refuses files outside the workspace', async () => {
    const root = process.env.SANDBOX_WORKSPACE;
    const written = await call('POST /v1/files/write', { path: 'dir/a.txt', content: 'héllo' });
    assert.equal(written.status, 200);
    assert.deepEqual(written.body, { ok: true, path: `${root}/dir/a.txt`, bytes: 6 });
    const read = await call('POST /v1/files/read', { path: 'dir/a.txt' });
    assert.equal(read.body.content, 'héllo');
    const outside = await call('POST /v1/files/read', { path: '../secret' });
    assert.equal(outside.status, 400);
    assert.equal(outside.body.error, 'Invalid path');
    await fs.writeFile(path.join(workspace, 'b.bin'), Buffer.from([0, 1, 2]));
    assert.equal((await call('POST /v1/files/read', { path: 'b.bin' })).body.binary, true);
  });

  it('refuses a fetch that is not the public web', async () => {
    const port = server.address().port;
    for (const url of [
      'file:///etc/passwd',
      'http://127.0.0.1:1/',
      'http://169.254.169.254/latest/',
      `http://[::ffff:127.0.0.1]:${port}/healthz`,
      `http://[::ffff:7f00:1]:${port}/healthz`,
      `http://[::7f00:1]:${port}/healthz`,
      `http://[64:ff9b::7f00:1]:${port}/healthz`,
      `http://localhost:${port}/healthz`,
    ]) {
      const refused = await call('POST /v1/fetch', { url });
      assert.equal(refused.status, 400, url);
    }
  });
});
