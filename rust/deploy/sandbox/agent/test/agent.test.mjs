// The sandbox agent's own checks, run with `node --test test/` (no
// dependencies, no browser or desktop needed): auth, paths, caps, addresses,
// page text, the desktop's action plans, and the HTTP server end to end on
// a temporary workspace.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { plan } from '../lib/desktop.mjs';
import { egress } from '../lib/egress.mjs';
import { htmlToText } from '../lib/fetch.mjs';
import { BadRequest, Capped, cap, isPublicIp, parseTarget, resolveWorkspacePath } from '../lib/util.mjs';
import { authorized, createServer } from '../server.mjs';

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
    for (const ip of ['1.1.1.1', '9.9.9.9', '2a01:4f8::1']) assert.equal(isPublicIp(ip), true, ip);
    for (const ip of ['10.0.0.1', '172.16.0.1', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'nonsense']) {
      assert.equal(isPublicIp(ip), false, ip);
    }
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
    for (const url of ['file:///etc/passwd', 'http://127.0.0.1:1/', 'http://169.254.169.254/latest/']) {
      const refused = await call('POST /v1/fetch', { url });
      assert.equal(refused.status, 400, url);
    }
  });
});
