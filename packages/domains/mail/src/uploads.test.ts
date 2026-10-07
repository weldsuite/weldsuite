/**
 * Compose uploads: stored under the workspace's own prefix, resolved back into
 * send attachments, and never resolvable from another workspace or through a
 * crafted id.
 */

import { describe, it, expect } from 'vitest';
import { getMailUpload, MailUploadError, MAX_UPLOAD_BYTES, resolveMailUploads, storeMailUpload } from './uploads';
import { MailSendError } from './send';

/** Just enough of R2 for put / list(prefix) / head. */
function memoryBucket() {
  const objects = new Map<string, { body: ArrayBuffer; httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }>();
  const asObject = (key: string) => {
    const o = objects.get(key)!;
    return { key, size: o.body.byteLength, uploaded: new Date(), httpMetadata: o.httpMetadata, customMetadata: o.customMetadata };
  };
  const bucket = {
    objects,
    async put(key: string, body: ArrayBuffer, opts?: { httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }) {
      objects.set(key, { body, httpMetadata: opts?.httpMetadata, customMetadata: opts?.customMetadata });
      return asObject(key);
    },
    async list(opts: { prefix: string; limit?: number }) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(opts.prefix)).slice(0, opts.limit ?? 1000);
      return { objects: keys.map(asObject), truncated: false };
    },
    async head(key: string) {
      return objects.has(key) ? asObject(key) : null;
    },
  };
  return bucket;
}

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe('mail uploads', () => {
  it('stores under the workspace prefix and resolves to a send attachment', async () => {
    const STORAGE = memoryBucket();
    const env = { STORAGE: STORAGE as unknown as R2Bucket };
    const upload = await storeMailUpload(env, 'org_a', { filename: 'Q3 report.pdf', contentType: 'application/pdf', content: bytes('pdf') });

    expect(upload.id).toMatch(/^mupl_/);
    const [key] = [...STORAGE.objects.keys()];
    expect(key?.startsWith(`workspaces/org_a/mail/uploads/${upload.id}/`)).toBe(true);

    const [att] = await resolveMailUploads(env, 'org_a', [upload.id]);
    expect(att).toMatchObject({ filename: 'Q3 report.pdf', contentType: 'application/pdf', size: 3, fileKey: key });
    expect(await getMailUpload(env, 'org_a', upload.id)).toMatchObject({ id: upload.id, size: 3 });
  });

  it('an id from another workspace, or a crafted one, resolves to nothing', async () => {
    const env = { STORAGE: memoryBucket() as unknown as R2Bucket };
    const upload = await storeMailUpload(env, 'org_a', { filename: 'a.txt', content: bytes('a') });

    await expect(resolveMailUploads(env, 'org_b', [upload.id])).rejects.toBeInstanceOf(MailSendError);
    expect(await getMailUpload(env, 'org_b', upload.id)).toBeNull();
    expect(await getMailUpload(env, 'org_a', '../org_b/mupl_x')).toBeNull();
    expect(await getMailUpload(env, 'org_a', '')).toBeNull();
  });

  it('refuses empty and oversized files', async () => {
    const env = { STORAGE: memoryBucket() as unknown as R2Bucket };
    await expect(storeMailUpload(env, 'org_a', { filename: 'e', content: new ArrayBuffer(0) })).rejects.toBeInstanceOf(MailUploadError);
    await expect(
      storeMailUpload(env, 'org_a', { filename: 'big', content: new ArrayBuffer(MAX_UPLOAD_BYTES + 1) }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });
});
