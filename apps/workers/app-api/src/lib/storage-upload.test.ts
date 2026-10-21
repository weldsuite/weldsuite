import { describe, expect, it } from 'vitest';
import {
  avatarExtension,
  buildUploadKey,
  isSafeEntityId,
  isSafeEntityType,
  isSafeFolder,
  readBodyOfExactSize,
  resolveStoredContent,
  sanitizeFileName,
} from './storage-upload';

describe('path segment rules', () => {
  it('accepts the folders callers send today', () => {
    for (const folder of [
      'uploads',
      'avatars',
      'projects',
      'drive',
      'branding',
      'documents/content',
      'weldbooks/documents',
      'mail-attachments',
      'accounting-documents',
    ]) {
      expect(isSafeFolder(folder), folder).toBe(true);
    }
  });

  it('rejects anything that could leave its prefix or be rewritten by a browser', () => {
    for (const folder of ['', '.', '..', 'a/..', '../a', '/a', 'a/', 'a//b', 'a.b', 'a\\b', '%2e%2e', 'A', 'a b']) {
      expect(isSafeFolder(folder), folder).toBe(false);
    }
  });

  it('accepts entity types and ids callers send today', () => {
    for (const type of ['task', 'accounting_document', 'customer-avatar', 'company', 'person']) {
      expect(isSafeEntityType(type), type).toBe(true);
    }
    for (const id of ['cust_lx3k9abc12', 'org_2AbCdEf', '0f8fad5b-d9cb-469f-a165-70867728950e']) {
      expect(isSafeEntityId(id), id).toBe(true);
    }
  });

  it('rejects dots, slashes and over-long ids', () => {
    expect(isSafeEntityType('a.b')).toBe(false);
    expect(isSafeEntityId('..')).toBe(false);
    expect(isSafeEntityId('a/b')).toBe(false);
    expect(isSafeEntityId('x'.repeat(65))).toBe(false);
    expect(isSafeEntityId('')).toBe(false);
  });
});

describe('file names and extensions', () => {
  it('sanitises names', () => {
    expect(sanitizeFileName('my file (1).pdf')).toBe('my_file__1_.pdf');
    expect(sanitizeFileName('..')).toBe('file');
    expect(sanitizeFileName('.')).toBe('file');
    expect(sanitizeFileName('.htaccess')).toBe('.htaccess');
  });

  it('keeps only a short alphanumeric avatar extension', () => {
    expect(avatarExtension('a.PNG')).toBe('png');
    expect(avatarExtension('noext')).toBe('png');
    expect(avatarExtension('a.b/c')).toBe('png');
    expect(avatarExtension('a.verylongextension')).toBe('png');
    expect(avatarExtension('archive.tar.gz')).toBe('gz');
  });
});

describe('buildUploadKey', () => {
  it('marks random-segment keys create-only and avatar keys replaceable', () => {
    const plain = buildUploadKey('org_a', { fileName: 'a.txt', folder: 'drive' });
    expect(plain.createOnly).toBe(true);
    expect(plain.fileKey).toMatch(/^workspaces\/org_a\/drive\/general\/\d+_[0-9a-f]{32}\/a\.txt$/);

    const avatar = buildUploadKey('org_a', { fileName: 'a.png', entityType: 'customer-avatar', entityId: 'c_1' });
    expect(avatar).toEqual({ fileKey: 'workspaces/org_a/avatars/customers/c_1/logo.png', createOnly: false });
  });
});

describe('resolveStoredContent', () => {
  it('keeps passive types and strips parameters', () => {
    expect(resolveStoredContent('image/png')).toEqual({ contentType: 'image/png' });
    expect(resolveStoredContent('Image/PNG')).toEqual({ contentType: 'image/png' });
    expect(resolveStoredContent('text/plain; charset=utf-7')).toEqual({ contentType: 'text/plain' });
    expect(resolveStoredContent('video/webm;codecs=vp8')).toEqual({ contentType: 'video/webm' });
  });

  it('turns everything else into an attachment octet-stream', () => {
    const fallback = { contentType: 'application/octet-stream', contentDisposition: 'attachment' };
    for (const declared of [
      'text/html',
      'image/svg+xml',
      'application/xml',
      'text/xml',
      'application/javascript',
      'application/octet-stream',
      'application/x-custom',
      'image/x-unknown',
      'video/',
      'audio',
      '',
      'video/mp4\nSet-Cookie: a=b',
    ]) {
      expect(resolveStoredContent(declared), declared).toEqual(fallback);
    }
  });
});

function requestWith(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request('http://localhost/upload', { method: 'PUT', body, headers });
}

describe('readBodyOfExactSize', () => {
  it('returns the bytes when the size matches', async () => {
    const result = await readBodyOfExactSize(requestWith(new Uint8Array([1, 2, 3])), 3);
    expect(result).toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3]) });
  });

  it('accepts an empty body for size 0', async () => {
    const result = await readBodyOfExactSize(requestWith(null), 0);
    expect(result).toEqual({ ok: true, bytes: new Uint8Array(0) });
  });

  it('reports a short body as a mismatch and a long one as too large', async () => {
    expect(await readBodyOfExactSize(requestWith(new Uint8Array(2)), 3)).toEqual({ ok: false, reason: 'size_mismatch' });
    expect(await readBodyOfExactSize(requestWith(new Uint8Array(4)), 3)).toEqual({ ok: false, reason: 'too_large' });
    expect(await readBodyOfExactSize(requestWith(null), 3)).toEqual({ ok: false, reason: 'size_mismatch' });
  });

  it('stops counting a chunked body as soon as it passes the expected size', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(4));
        if (pulled > 50) controller.close();
      },
    });
    // `duplex` is required for stream bodies in Node but absent from the lib types.
    const init = { method: 'PUT', body: stream, duplex: 'half' } as RequestInit;
    const request = new Request('http://localhost/upload', init);
    expect(await readBodyOfExactSize(request, 6)).toEqual({ ok: false, reason: 'too_large' });
    expect(pulled).toBeLessThan(10);
  });

  it('judges Content-Length before reading', async () => {
    expect(await readBodyOfExactSize(requestWith(new Uint8Array(3), { 'content-length': '9' }), 3)).toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(await readBodyOfExactSize(requestWith(new Uint8Array(3), { 'content-length': '1' }), 3)).toEqual({
      ok: false,
      reason: 'size_mismatch',
    });
    expect(await readBodyOfExactSize(requestWith(new Uint8Array(3), { 'content-length': '-1' }), 3)).toEqual({
      ok: false,
      reason: 'size_mismatch',
    });
  });
});
