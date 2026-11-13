// `web_fetch`: a page or document as text, fetched from the sandbox, never
// from the server's pod. The network policy keeps the pod to the public
// internet; this checks each address and redirect too.

import { lookup } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { isIP } from 'node:net';

import { run } from './exec.mjs';
import { BadRequest, cap, isPublicIp } from './util.mjs';

const MAX_BYTES = 5_000_000;
const TEXT_CHARS = 100_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) WeldSuiteAgent/1.0';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** HTML as readable text: no scripts, styles or markup; blocks on their own lines. */
export function htmlToText(html) {
  const source = String(html ?? '');
  const title = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  const text = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|object|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|header|footer|blockquote|pre|table|ul|ol)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');
  return { title: decode(title).replace(/\s+/g, ' ').trim(), text: tidy(decode(text)) };
}

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function tidy(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Refuses a URL that isn't http(s) or whose host isn't public. */
export async function checkUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequest(`${raw} is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BadRequest('Only http and https URLs can be fetched.');
  if (url.username || url.password) throw new BadRequest('URLs with a user name or password can’t be fetched.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw new BadRequest(`${host} could not be resolved.`);
  if (!addresses.every(isPublicIp)) throw new BadRequest(`${host} is not on the public internet.`);
  return url;
}

async function readCapped(response, max) {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: Buffer.alloc(0), truncated: false };
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > max) {
      chunks.push(Buffer.from(value.subarray(0, max - size)));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(Buffer.from(value));
    size += value.length;
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

async function pdfText(bytes) {
  const file = `/tmp/fetch-${randomBytes(6).toString('hex')}.pdf`;
  await fs.writeFile(file, bytes, { mode: 0o600 });
  try {
    const result = await run('pdftotext', ['-layout', '-q', file, '-'], { cwd: '/tmp', timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw new BadRequest('The PDF could not be read.');
    return result.stdout;
  } finally {
    await fs.rm(file, { force: true });
  }
}

/** `POST /v1/fetch`. */
export async function fetchPage(body) {
  const maxBytes = Math.min(Math.max(Number(body.maxBytes) || 2_000_000, 1_000), MAX_BYTES);
  let url = await checkUrl(String(body.url ?? ''));
  let response;
  for (let hop = 0; ; hop += 1) {
    response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,text/plain,application/json,application/pdf;q=0.9,*/*;q=0.5',
        'accept-language': 'en,nl;q=0.8,*;q=0.5',
      },
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) throw new BadRequest('Too many redirects.');
      await response.body?.cancel().catch(() => undefined);
      url = await checkUrl(new URL(location, url).toString());
      continue;
    }
    break;
  }
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const { bytes, truncated } = await readCapped(response, maxBytes);
  let title = '';
  let text;
  if (contentType.includes('html') || (!contentType && /^\s*</.test(bytes.subarray(0, 200).toString('utf8')))) {
    ({ title, text } = htmlToText(bytes.toString('utf8')));
  } else if (contentType.includes('pdf')) {
    if (truncated) throw new BadRequest('The PDF is too large to read.');
    text = await pdfText(bytes);
  } else if (/^(text\/|application\/(json|xml|xhtml|rss|atom|ld\+json|javascript))/.test(contentType) || contentType.includes('+json') || contentType.includes('+xml')) {
    text = bytes.toString('utf8');
  } else {
    throw new BadRequest(`This content (${contentType || 'unknown type'}) can't be read as text; download it with computer_exec instead.`);
  }
  const capped = cap(text, TEXT_CHARS);
  return {
    ok: response.ok,
    status: response.status,
    url: url.toString(),
    contentType: contentType.split(';')[0],
    title,
    text: capped.text,
    truncated: truncated || capped.truncated,
  };
}
