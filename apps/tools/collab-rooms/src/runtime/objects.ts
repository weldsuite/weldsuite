/**
 * Object storage for the rooms: the S3 API (any S3 store, the same bucket
 * and keys the Rust server uses), and an in-memory twin for tests. On top of
 * it, `r2Bucket` gives the room classes the R2 binding shape they were
 * written against (`env.PRIVATE_STORAGE.get/put/delete`).
 */

import { AwsClient } from 'aws4fetch';

export interface StoredObject {
  bytes: Uint8Array;
  contentType: string | null;
  metadata: Record<string, string>;
}

export interface PutOptions {
  contentType?: string;
  metadata?: Record<string, string>;
  /** Fail with `'exists'` when the key is taken (`If-None-Match: *`). */
  createOnly?: boolean;
}

/** One bucket. */
export interface ObjectStore {
  get(key: string): Promise<StoredObject | null>;
  put(key: string, bytes: Uint8Array, options?: PutOptions): Promise<'ok' | 'exists'>;
  delete(key: string): Promise<void>;
  /** Every key under `prefix`, in key order. */
  list(prefix: string): Promise<string[]>;
}

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, StoredObject>();

  async get(key: string): Promise<StoredObject | null> {
    const object = this.objects.get(key);
    return object ? { ...object, bytes: object.bytes.slice() } : null;
  }

  async put(key: string, bytes: Uint8Array, options: PutOptions = {}): Promise<'ok' | 'exists'> {
    if (options.createOnly && this.objects.has(key)) return 'exists';
    this.objects.set(key, { bytes: bytes.slice(), contentType: options.contentType ?? null, metadata: { ...options.metadata } });
    return 'ok';
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `endpoint/bucket/key` rather than `bucket.endpoint/key`. */
  forcePathStyle: boolean;
}

const META = 'x-amz-meta-';

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: AwsClient;
  private readonly base: string;

  constructor(config: S3Config) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: 's3',
      region: config.region,
    });
    const endpoint = new URL(config.endpoint);
    this.base = config.forcePathStyle
      ? `${endpoint.origin}/${config.bucket}`
      : `${endpoint.protocol}//${config.bucket}.${endpoint.host}`;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    return this.client.fetch(url, init);
  }

  async get(key: string): Promise<StoredObject | null> {
    const res = await this.send(`${this.base}/${encodeKey(key)}`, { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 GET ${key}: ${res.status}`);
    const metadata: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      if (name.toLowerCase().startsWith(META)) metadata[name.slice(META.length).toLowerCase()] = value;
    });
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type'), metadata };
  }

  async put(key: string, bytes: Uint8Array, options: PutOptions = {}): Promise<'ok' | 'exists'> {
    const headers: Record<string, string> = {};
    if (options.contentType) headers['content-type'] = options.contentType;
    for (const [name, value] of Object.entries(options.metadata ?? {})) headers[`${META}${name}`] = value;
    if (options.createOnly) headers['if-none-match'] = '*';
    const res = await this.send(`${this.base}/${encodeKey(key)}`, { method: 'PUT', headers, body: bytes });
    if (options.createOnly && (res.status === 412 || res.status === 409)) return 'exists';
    if (!res.ok) throw new Error(`S3 PUT ${key}: ${res.status} ${await res.text()}`);
    return 'ok';
  }

  async delete(key: string): Promise<void> {
    const res = await this.send(`${this.base}/${encodeKey(key)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${key}: ${res.status}`);
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | null = null;
    do {
      const query = new URLSearchParams({ 'list-type': '2', prefix });
      if (token) query.set('continuation-token', token);
      const res = await this.send(`${this.base}/?${query.toString()}`, { method: 'GET' });
      if (!res.ok) throw new Error(`S3 LIST ${prefix}: ${res.status}`);
      const xml = await res.text();
      for (const match of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) keys.push(decodeXml(match[1]!));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? decodeXml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '') || null
        : null;
    } while (token);
    return keys.sort();
  }
}

async function bytesOf(value: unknown): Promise<Uint8Array> {
  if (value === null || value === undefined) return new Uint8Array();
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
  throw new Error('Unsupported object body');
}

function objectBody(key: string, object: StoredObject) {
  const { bytes } = object;
  return {
    key,
    size: bytes.byteLength,
    httpMetadata: object.contentType ? { contentType: object.contentType } : {},
    customMetadata: object.metadata,
    get body(): ReadableStream {
      return new Blob([bytes]).stream();
    },
    arrayBuffer: async () => bytes.slice().buffer,
    bytes: async () => bytes.slice(),
    text: async () => new TextDecoder().decode(bytes),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
  };
}

interface R2PutOptions {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

/** The R2 binding shape the room classes use, over one bucket. */
export function r2Bucket(store: ObjectStore) {
  return {
    async get(key: string) {
      const object = await store.get(key);
      return object ? objectBody(key, object) : null;
    },
    async head(key: string) {
      const object = await store.get(key);
      return object ? objectBody(key, object) : null;
    },
    async put(key: string, value: unknown, options: R2PutOptions = {}) {
      const bytes = await bytesOf(value);
      await store.put(key, bytes, { contentType: options.httpMetadata?.contentType, metadata: options.customMetadata });
      return { key, size: bytes.byteLength };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) await store.delete(key);
    },
    async list(options: { prefix?: string } = {}) {
      const keys = await store.list(options.prefix ?? '');
      return { objects: keys.map((key) => ({ key })), truncated: false, delimitedPrefixes: [] };
    },
  };
}
