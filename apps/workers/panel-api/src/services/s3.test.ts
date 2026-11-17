/**
 * SigV4 against AWS's own published S3 examples (Signature Version 4,
 * "Examples: Signature Calculations in AWS Signature Version 4"), and the
 * object addressing for S3, R2/GCS-style endpoints and path-style stores.
 */

import { describe, expect, it, vi } from 'vitest';
import { isPublicHostname } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { deleteObject, encodeKey, objectUrl, putObject, safeObjectUrl, sha256Hex, signRequest } from './s3';

const credentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const NOW = new Date('2013-05-24T00:00:00Z');
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('signRequest', () => {
  it('matches AWS’s GET Object example', async () => {
    const headers = await signRequest({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      headers: { Range: 'bytes=0-9' },
      credentials,
      region: 'us-east-1',
      now: NOW,
    });
    expect(headers['x-amz-content-sha256']).toBe(EMPTY_SHA);
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('matches AWS’s PUT Object example (payload hash, an encoded key, extra headers)', async () => {
    const body = 'Welcome to Amazon S3.';
    expect(await sha256Hex(body)).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    const headers = await signRequest({
      method: 'PUT',
      url: `https://examplebucket.s3.amazonaws.com/${encodeKey('test$file.text')}`,
      headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      body,
      credentials,
      region: 'us-east-1',
      now: NOW,
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
  });

  it('matches AWS’s GET Bucket lifecycle example (a query string)', async () => {
    const headers = await signRequest({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/?lifecycle', credentials, region: 'us-east-1', now: NOW });
    expect(headers.authorization).toContain('Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  });
});

describe('addressing', () => {
  it('encodes each key segment once and keeps the slashes', () => {
    expect(encodeKey('a b/dt=2026-11-14/x:y*(1).gz')).toBe('a%20b/dt%3D2026-11-14/x%3Ay%2A%281%29.gz');
  });

  const s3 = { provider: 's3' as const, endpoint: null, region: 'eu-west-1', bucket: 'acme', pathStyle: false };
  it('uses virtual-hosted AWS hosts by default', () => {
    expect(objectUrl(s3, 'weldpanel/events/a.gz')).toBe('https://acme.s3.eu-west-1.amazonaws.com/weldpanel/events/a.gz');
    expect(objectUrl({ ...s3, pathStyle: true }, '/a.gz')).toBe('https://s3.eu-west-1.amazonaws.com/acme/a.gz');
  });

  it('uses the endpoint for other stores, path-style or virtual-hosted', () => {
    const r2 = { provider: 'r2' as const, endpoint: 'https://acc.r2.cloudflarestorage.com', region: 'auto', bucket: 'raw', pathStyle: true };
    expect(objectUrl(r2, 'x/y.gz')).toBe('https://acc.r2.cloudflarestorage.com/raw/x/y.gz');
    expect(objectUrl({ ...r2, provider: 'gcs', endpoint: 'https://storage.googleapis.com', pathStyle: false }, 'y.gz')).toBe('https://raw.storage.googleapis.com/y.gz');
  });

  it('only sends to a public https host name', async () => {
    const minio = { provider: 'minio' as const, region: 'us-east-1', bucket: 'raw', pathStyle: true };
    expect(safeObjectUrl({ ...minio, endpoint: 'https://minio.example.com' }, 'a.gz')).toBe('https://minio.example.com/raw/a.gz');
    for (const endpoint of ['https://10.0.0.5', 'https://localhost', 'https://store.internal', 'https://app-api.weldsuite.org', 'https://[::1]']) {
      expect(() => safeObjectUrl({ ...minio, endpoint }, 'a.gz')).toThrow('public https host name');
    }
    const fetcher = vi.fn();
    const credentials = { accessKeyId: 'AKID', secretAccessKey: 'secret' };
    await expect(putObject({ ...minio, endpoint: 'https://169.254.169.254' }, credentials, 'a.gz', new Uint8Array(), {}, { fetch: fetcher })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('knows a public host name', () => {
    expect(isPublicHostname('acc.r2.cloudflarestorage.com')).toBe(true);
    expect(isPublicHostname('storage.googleapis.com.')).toBe(true);
    for (const host of ['localhost', 'nas', '192.168.1.2', 'printer.local', 'weldsuite.org', 'x.weldsuite.org', '[fe80::1]']) {
      expect(isPublicHostname(host)).toBe(false);
    }
  });
});

describe('putObject / deleteObject', () => {
  it('sends the signed request without a Host header, and reports the store’s own error', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      expect(headers.host).toBeUndefined();
      expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA/);
      if (init.method === 'PUT') return new Response('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>', { status: 403 });
      return new Response(null, { status: 404 });
    });
    const dest = { provider: 's3' as const, endpoint: null, region: 'us-east-1', bucket: 'acme', pathStyle: false };
    await expect(putObject(dest, credentials, 'a.txt', new Uint8Array([1]), {}, { fetch: fetchMock as unknown as typeof fetch })).rejects.toThrow('AccessDenied: Access Denied');
    // A missing object counts as deleted.
    await expect(deleteObject(dest, credentials, 'a.txt', { fetch: fetchMock as unknown as typeof fetch })).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]![0]).toBe('https://acme.s3.us-east-1.amazonaws.com/a.txt');
  });
});
