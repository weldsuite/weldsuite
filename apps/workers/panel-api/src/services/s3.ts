/**
 * The S3 API calls a raw export makes (PUT and DELETE of one object), signed
 * with AWS Signature Version 4. No SDK: the repo has no `aws4fetch` outside two
 * Node apps, and two calls do not justify one. Works with AWS S3, Cloudflare
 * R2, Google Cloud Storage (HMAC keys), MinIO and other S3-compatible stores.
 *
 * Keys are URI-encoded once (S3's rule: unreserved characters and `/` stay,
 * everything else becomes `%XX`), and the request is sent with the same
 * encoded path it was signed with, so the store sees exactly what was signed.
 * The payload hash is the real SHA-256 of the body.
 */

import { isPublicHostname, type ParsedPanelExportDestination } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export type S3Destination = Pick<ParsedPanelExportDestination, 'provider' | 'endpoint' | 'region' | 'bucket' | 'pathStyle'>;

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, encoder.encode(data));
}

/** RFC 3986 encoding as SigV4 wants it: only `A-Z a-z 0-9 - _ . ~` stay. */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** An object key as a path: each segment encoded, the slashes kept. */
export function encodeKey(key: string): string {
  return key.split('/').map(uriEncode).join('/');
}

/** Byte order, as SigV4 sorts query parameters (not locale order). */
function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export interface SignInput {
  method: string;
  /** Absolute URL; its path must already be encoded (see {@link encodeKey}). */
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string | null;
  credentials: S3Credentials;
  region: string;
  service?: string;
  now?: Date;
}

/**
 * The headers to send: the caller's, plus `host`, `x-amz-date`,
 * `x-amz-content-sha256` and `authorization`. Every header given is signed.
 */
export async function signRequest(input: SignInput): Promise<Record<string, string>> {
  const url = new URL(input.url);
  const service = input.service ?? 's3';
  const { amzDate, dateStamp } = amzDates(input.now ?? new Date());
  const payloadHash = await sha256Hex(input.body ?? '');

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = String(value).trim().replace(/\s+/g, ' ');
  headers.host = url.host;
  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = payloadHash;

  // SigV4 orders header names by byte (code unit), never by locale.
  const names = Object.keys(headers).sort((a, b) => (a < b ? -1 : Number(a > b)));
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, av], [b, bv]) => compareCodeUnits(a, b) || compareCodeUnits(av, bv))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [input.method.toUpperCase(), url.pathname || '/', query, canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const kDate = await hmac(encoder.encode(`AWS4${input.credentials.secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, input.region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = hex(await hmac(kSigning, stringToSign));

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * Where an object lives: AWS S3 virtual-hosted (`https://<bucket>.s3.<region>.amazonaws.com/<key>`),
 * or the destination's endpoint, path-style (`<endpoint>/<bucket>/<key>`) or virtual-hosted (`https://<bucket>.<endpoint host>/<key>`).
 */
export function objectUrl(dest: S3Destination, key: string): string {
  const path = encodeKey(key.replace(/^\/+/, ''));
  if (!dest.endpoint) {
    return dest.pathStyle
      ? `https://s3.${dest.region}.amazonaws.com/${dest.bucket}/${path}`
      : `https://${dest.bucket}.s3.${dest.region}.amazonaws.com/${path}`;
  }
  const endpoint = new URL(dest.endpoint);
  if (dest.pathStyle) return `${endpoint.origin}/${dest.bucket}/${path}`;
  return `${endpoint.protocol}//${dest.bucket}.${endpoint.host}/${path}`;
}

/** The store refused a request. `message` is its own short answer (`AccessDenied: …`). */
export class S3Error extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'S3Error';
  }
}

/** `Code: Message` from an S3 XML error body, else the status. */
async function s3Failure(res: Response): Promise<S3Error> {
  const body = await res.text().catch(() => '');
  const code = /<Code>([^<]{1,100})<\/Code>/.exec(body)?.[1];
  const message = /<Message>([^<]{1,300})<\/Message>/.exec(body)?.[1];
  let text = `The store answered ${res.status}`;
  if (code) text = message ? `${code}: ${message}` : code;
  return new S3Error(text, res.status);
}

/** The signed headers without `host`: fetch sets it from the URL (the same value that was signed). */
function sendable(signed: Record<string, string>): Record<string, string> {
  const rest = { ...signed };
  delete rest.host;
  return rest;
}

export interface S3CallOptions {
  fetch?: typeof fetch;
  now?: Date;
}

/**
 * The URL a request may go to: https, no credentials, and a public DNS host
 * name. The endpoint comes from the customer, so an IP literal, `localhost`,
 * an internal suffix or one of WeldSuite's own hosts is refused before any
 * request leaves the worker (the schema refuses them on save too; this is the
 * check at the point of use).
 */
export function safeObjectUrl(dest: S3Destination, key: string): string {
  const url = new URL(objectUrl(dest, key));
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || !isPublicHostname(url.hostname)) {
    throw new S3Error('The endpoint is not a public https host name', 400);
  }
  return url.toString();
}

export async function putObject(
  dest: S3Destination,
  credentials: S3Credentials,
  key: string,
  body: Uint8Array,
  headers: Record<string, string>,
  options: S3CallOptions = {},
): Promise<void> {
  const url = safeObjectUrl(dest, key);
  const signed = await signRequest({ method: 'PUT', url, headers, body, credentials, region: dest.region, now: options.now });
  // The customer chooses where their export goes, so no fixed host allow-list
  // fits; `safeObjectUrl` has just checked for a public https host name, and
  // the bucket and region were regex-checked on save (ADR PANEL-011).
  const res = await (options.fetch ?? fetch)(url, { method: 'PUT', headers: sendable(signed), body }); // NOSONAR: S5144 reviewed, see above
  if (!res.ok) throw await s3Failure(res);
}

export async function deleteObject(dest: S3Destination, credentials: S3Credentials, key: string, options: S3CallOptions = {}): Promise<void> {
  const url = safeObjectUrl(dest, key);
  const signed = await signRequest({ method: 'DELETE', url, credentials, region: dest.region, now: options.now });
  // Same customer-chosen, public-host-checked destination as `putObject`.
  const res = await (options.fetch ?? fetch)(url, { method: 'DELETE', headers: sendable(signed) }); // NOSONAR: S5144 reviewed, see putObject
  if (!res.ok && res.status !== 404) throw await s3Failure(res);
}

export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
