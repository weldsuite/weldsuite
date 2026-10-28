/**
 * In-memory R2 bucket for tests: the subset of `R2Bucket` mail code needs
 * (`put`/`get`/`head`/`delete`/`list`), enough to unit test body storage
 * (`mail/<ws>/<account>/<message>/{body.html,body.txt,raw.eml}`, task A4) and
 * R2-backed subscription header reads without a real bucket or Miniflare.
 *
 * Style follows `./d1.ts`: build a small, honestly-typed implementation, then
 * cast it to the real ambient `R2Bucket` type (`@cloudflare/workers-types`,
 * already global in this package's tsconfig) at the boundary.
 *
 * Deviations from real R2, called out here and in the worktree's final report:
 *   - No multipart upload (`createMultipartUpload`/`resumeMultipartUpload`):
 *     not part of the subset mail code uses.
 *   - No conditional requests (`onlyIf`): `get`/`put` accept the option but
 *     ignore it rather than evaluating `R2Conditional`/`Headers` preconditions.
 *   - `list()` ignores `delimiter`; `delimitedPrefixes` is always `[]`.
 *   - Checksums (`R2Checksums`) are not computed; `checksums.toJSON()` returns
 *     `{}`. `etag`/`httpEtag` are a real MD5 of the stored bytes, since mail
 *     code doesn't rely on R2's exact (also MD5-based, but multipart-aware)
 *     etag format.
 *   - `list()`'s cursor is the last returned key, not R2's opaque token
 *     format; it is still only meant to be round-tripped back into `list()`.
 */

import { createHash } from 'node:crypto';

interface StoredObject {
  key: string;
  value: Uint8Array;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
  uploaded: Date;
  version: string;
}

type PutValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob;

async function toBytes(value: PutValue): Promise<Uint8Array> {
  if (value === null) return new Uint8Array(0);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof Blob !== 'undefined' && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ReadableStream) {
    const chunks: Uint8Array[] = [];
    const reader = value.getReader();
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- draining a stream is inherently sequential
      const { done, value: chunk } = await reader.read();
      if (done) break;
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBufferLike));
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
  throw new TypeError('createMemoryR2(): put() received an unsupported value type.');
}

function etagOf(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex');
}

function resolveRange(size: number, range?: R2Range | Headers): { offset: number; length: number } | undefined {
  if (!range) return undefined;
  if (range instanceof Headers) {
    const header = range.get('range');
    const match = header ? /bytes=(\d*)-(\d*)/.exec(header) : null;
    if (!match) return undefined;
    const [, startText, endText] = match;
    if (startText === '' && endText !== '') {
      const suffix = Number(endText);
      return { offset: Math.max(0, size - suffix), length: Math.min(suffix, size) };
    }
    const start = startText === '' ? 0 : Number(startText);
    const end = endText === '' ? size - 1 : Number(endText);
    return { offset: start, length: Math.max(0, end - start + 1) };
  }
  if ('suffix' in range) {
    return { offset: Math.max(0, size - range.suffix), length: Math.min(range.suffix, size) };
  }
  const offset = range.offset ?? 0;
  const length = range.length ?? size - offset;
  return { offset, length };
}

function writeHttpMetadata(httpMetadata: R2HTTPMetadata | undefined, headers: Headers): void {
  if (!httpMetadata) return;
  if (httpMetadata.contentType !== undefined) headers.set('content-type', httpMetadata.contentType);
  if (httpMetadata.contentLanguage !== undefined) headers.set('content-language', httpMetadata.contentLanguage);
  if (httpMetadata.contentDisposition !== undefined) headers.set('content-disposition', httpMetadata.contentDisposition);
  if (httpMetadata.contentEncoding !== undefined) headers.set('content-encoding', httpMetadata.contentEncoding);
  if (httpMetadata.cacheControl !== undefined) headers.set('cache-control', httpMetadata.cacheControl);
  if (httpMetadata.cacheExpiry !== undefined) headers.set('cache-expiry', httpMetadata.cacheExpiry.toUTCString());
}

function buildObjectFields(entry: StoredObject, range?: { offset: number; length: number }) {
  const bytes = range ? entry.value.slice(range.offset, range.offset + range.length) : entry.value;
  const etag = etagOf(entry.value);
  return {
    key: entry.key,
    version: entry.version,
    size: bytes.length,
    etag,
    httpEtag: `"${etag}"`,
    checksums: { toJSON: () => ({}) },
    uploaded: entry.uploaded,
    httpMetadata: entry.httpMetadata,
    customMetadata: entry.customMetadata ?? {},
    range,
    storageClass: 'Standard',
    writeHttpMetadata: (headers: Headers) => writeHttpMetadata(entry.httpMetadata, headers),
  };
}

function buildObjectBody(entry: StoredObject, range?: { offset: number; length: number }) {
  const bytes = range ? entry.value.slice(range.offset, range.offset + range.length) : entry.value;
  let bodyUsed = false;
  const markUsed = <T>(value: T): T => {
    bodyUsed = true;
    return value;
  };
  return {
    ...buildObjectFields(entry, range),
    get body(): ReadableStream {
      bodyUsed = true;
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    get bodyUsed(): boolean {
      return bodyUsed;
    },
    arrayBuffer: async () => markUsed(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    bytes: async () => markUsed(bytes),
    text: async () => markUsed(new TextDecoder().decode(bytes)),
    json: async <T>() => markUsed(JSON.parse(new TextDecoder().decode(bytes)) as T),
    blob: async () => markUsed(typeof Blob !== 'undefined' ? new Blob([bytes]) : (bytes as unknown as Blob)),
  };
}

interface MemoryR2ListOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
  startAfter?: string;
}

/** Builds an in-memory `R2Bucket` fake. One bucket per call; independent state. */
export function createMemoryR2(): R2Bucket {
  const objects = new Map<string, StoredObject>();

  const bucket = {
    async head(key: string) {
      const entry = objects.get(key);
      return entry ? buildObjectFields(entry) : null;
    },

    async get(key: string, options?: { range?: R2Range | Headers }) {
      const entry = objects.get(key);
      if (!entry) return null;
      const range = resolveRange(entry.value.length, options?.range);
      return buildObjectBody(entry, range);
    },

    async put(key: string, value: PutValue, options?: { httpMetadata?: R2HTTPMetadata | Headers; customMetadata?: Record<string, string> }) {
      const bytes = await toBytes(value);
      const httpMetadata =
        options?.httpMetadata instanceof Headers
          ? {
              contentType: options.httpMetadata.get('content-type') ?? undefined,
              contentLanguage: options.httpMetadata.get('content-language') ?? undefined,
              contentDisposition: options.httpMetadata.get('content-disposition') ?? undefined,
              contentEncoding: options.httpMetadata.get('content-encoding') ?? undefined,
              cacheControl: options.httpMetadata.get('cache-control') ?? undefined,
            }
          : options?.httpMetadata;
      const entry: StoredObject = {
        key,
        value: bytes,
        httpMetadata,
        customMetadata: options?.customMetadata,
        uploaded: new Date(),
        version: crypto.randomUUID(),
      };
      objects.set(key, entry);
      return buildObjectFields(entry);
    },

    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },

    async list(options: MemoryR2ListOptions = {}) {
      const limit = Math.min(options.limit ?? 1000, 1000);
      let keys = [...objects.keys()].sort();
      if (options.prefix !== undefined) keys = keys.filter((k) => k.startsWith(options.prefix as string));
      const after = options.cursor ?? options.startAfter;
      if (after !== undefined) keys = keys.filter((k) => k > after);
      const page = keys.slice(0, limit);
      const truncated = keys.length > page.length;
      const result = page.map((key) => buildObjectFields(objects.get(key) as StoredObject));
      return truncated
        ? { objects: result, delimitedPrefixes: [], truncated: true as const, cursor: page[page.length - 1] as string }
        : { objects: result, delimitedPrefixes: [], truncated: false as const };
    },
  };

  return bucket as unknown as R2Bucket;
}
