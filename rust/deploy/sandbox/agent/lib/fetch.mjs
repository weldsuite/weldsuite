// `web_fetch`: a page or document as text, fetched from the sandbox, never
// from the server's pod. The network policy keeps the pod off the cluster's
// private ranges but not off its own loopback, so this checks the address of
// every connection, redirects included, and connects to the address it
// checked. Node's `http`, not `fetch`: only its sockets take a `lookup`.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { pipeline } from 'node:stream';
import zlib from 'node:zlib';

import { run } from './exec.mjs';
import { BadRequest, cap, checkedLookup, isPublicIp } from './util.mjs';

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

/** The host of `url` as a socket takes it: an IPv6 literal without brackets. */
export function hostOf(url) {
  return url.hostname.replace(/^\[|\]$/g, '');
}

/**
 * `raw` as an http(s) URL without credentials, or a refusal. A host that is
 * an IP address must pass `allowed` here, since sockets don't look those up;
 * a name is checked as the connection resolves it (`checkedLookup`).
 */
export function parseUrl(raw, allowed = isPublicIp) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequest(`${raw} is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BadRequest('Only http and https URLs can be fetched.');
  if (url.username || url.password) throw new BadRequest('URLs with a user name or password can’t be fetched.');
  const host = hostOf(url);
  if (isIP(host) && !allowed(host)) throw new BadRequest(`${host} is not on the public internet.`);
  return url;
}

/**
 * `parseUrl`, with the host's name resolved now to refuse a private one with
 * a clear message before the URL is handed on (the browser). Only a first
 * answer: whatever connects checks the address again as it connects.
 */
export async function checkUrl(raw, allowed = isPublicIp) {
  const url = parseUrl(raw, allowed);
  const host = hostOf(url);
  if (isIP(host)) return url;
  await new Promise((resolve, reject) => {
    checkedLookup(allowed)(host, { all: true }, (error) => {
      if (!error) resolve();
      else reject(error instanceof BadRequest ? error : new BadRequest(`${host} could not be resolved.`));
    });
  });
  return url;
}

/** A failed request as the caller should hear it. */
function failure(error, host, signal) {
  if (error instanceof BadRequest) return error;
  if (signal.aborted) return new BadRequest(`${host} did not answer in time.`);
  if (['ENOTFOUND', 'EAI_AGAIN', 'ENODATA'].includes(error?.code)) return new BadRequest(`${host} could not be resolved.`);
  return error;
}

/** One GET of `url` on a socket whose address `lookup` checked. */
function get(url, lookup, signal) {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: 'GET',
        agent: false,
        lookup,
        signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,text/plain,application/json,application/pdf;q=0.9,*/*;q=0.5',
          'accept-language': 'en,nl;q=0.8,*;q=0.5',
          'accept-encoding': 'gzip, br',
        },
      },
      resolve,
    );
    request.once('error', reject);
    request.end();
  });
}

// Lenient on a body cut short, as `fetch` is.
const ZLIB_FLUSH = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH };
const BROTLI_FLUSH = { flush: zlib.constants.BROTLI_OPERATION_FLUSH, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH };
const DECODERS = {
  gzip: () => zlib.createGunzip(ZLIB_FLUSH),
  'x-gzip': () => zlib.createGunzip(ZLIB_FLUSH),
  deflate: () => zlib.createInflate(ZLIB_FLUSH),
  br: () => zlib.createBrotliDecompress(BROTLI_FLUSH),
};

/** The body of `response`, decoded, cut at `max` bytes. */
async function readCapped(response, max) {
  const encoding = String(response.headers['content-encoding'] ?? '').trim().toLowerCase();
  let stream = response;
  if (encoding && encoding !== 'identity') {
    const decoder = DECODERS[encoding];
    if (!decoder) throw new BadRequest(`The page is sent ${encoding}-encoded, which can't be read.`);
    stream = pipeline(response, decoder(), () => undefined);
  }
  const chunks = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream) {
    if (size + chunk.length > max) {
      chunks.push(chunk.subarray(0, max - size));
      truncated = true;
      break;
    }
    chunks.push(chunk);
    size += chunk.length;
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

/**
 * `POST /v1/fetch`. `allowed` is for the tests, which serve pages on
 * loopback; the route always takes the public internet.
 */
export async function fetchPage(body, { allowed = isPublicIp } = {}) {
  const maxBytes = Math.min(Math.max(Number(body.maxBytes) || 2_000_000, 1_000), MAX_BYTES);
  const lookup = checkedLookup(allowed);
  let url = parseUrl(String(body.url ?? ''), allowed);
  let response;
  let signal;
  for (let hop = 0; ; hop += 1) {
    signal = AbortSignal.timeout(20_000);
    const target = url;
    response = await get(target, lookup, signal).catch((error) => {
      throw failure(error, hostOf(target), signal);
    });
    const { location } = response.headers;
    if (response.statusCode >= 300 && response.statusCode < 400 && location) {
      response.destroy();
      if (hop >= MAX_REDIRECTS) throw new BadRequest('Too many redirects.');
      url = parseUrl(new URL(location, url).toString(), allowed);
      continue;
    }
    break;
  }
  const status = response.statusCode ?? 0;
  const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
  let read;
  try {
    read = await readCapped(response, maxBytes);
  } catch (error) {
    throw failure(error, hostOf(url), signal);
  } finally {
    response.destroy();
  }
  const { bytes, truncated } = read;
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
    ok: status >= 200 && status < 300,
    status,
    url: url.toString(),
    contentType: contentType.split(';')[0],
    title,
    text: capped.text,
    truncated: truncated || capped.truncated,
  };
}
