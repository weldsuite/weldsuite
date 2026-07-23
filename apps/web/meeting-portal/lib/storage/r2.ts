import { AwsClient } from 'aws4fetch';

/**
 * Lightweight R2 client for meeting-portal (Next.js / Node runtime).
 *
 * Uses aws4fetch (~10 KB) to sign S3-compatible PUT requests against the
 * Cloudflare R2 endpoint. Mirrors `apps/api-worker/src/lib/r2-presigner.ts`
 * and the avatar-upload path used by the participant resolver and
 * mail-inbound-worker, so anything we write here lands at the same URL
 * pattern as contacts created elsewhere in the platform.
 *
 * Required env vars:
 *   R2_ACCOUNT_ID
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_BUCKET_NAME
 *   R2_PUBLIC_URL  (e.g. https://weldsuite-storage-test.weldsuite.org)
 */

let cachedClient: AwsClient | null = null;

function getAwsClient(): AwsClient {
  if (cachedClient) return cachedClient;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials missing: R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.');
  }
  cachedClient = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: 's3',
    region: 'auto',
  });
  return cachedClient;
}

export function getR2PublicUrl(): string | undefined {
  return process.env.R2_PUBLIC_URL;
}

export function isR2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID
      && process.env.R2_ACCESS_KEY_ID
      && process.env.R2_SECRET_ACCESS_KEY
      && process.env.R2_BUCKET_NAME
      && process.env.R2_PUBLIC_URL,
  );
}

/**
 * PUT an object to R2 and return the public URL.
 * Throws when R2 is not configured or when the upload fails.
 */
export async function uploadToR2(
  key: string,
  body: string | ArrayBuffer | Uint8Array,
  contentType: string,
): Promise<string> {
  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET_NAME;
  const publicUrl = process.env.R2_PUBLIC_URL;
  if (!accountId || !bucket || !publicUrl) {
    throw new Error('R2 not configured: R2_ACCOUNT_ID / R2_BUCKET_NAME / R2_PUBLIC_URL missing.');
  }

  const aws = getAwsClient();
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${encodedKey}`;

  const res = await aws.fetch(endpoint, {
    method: 'PUT',
    body: body as BodyInit,
    headers: { 'Content-Type': contentType },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`R2 PUT ${key} failed: ${res.status} ${res.statusText} ${text}`);
  }

  return `${publicUrl}/${key}`;
}
