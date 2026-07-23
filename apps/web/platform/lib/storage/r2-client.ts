import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Singleton R2 client
let r2Client: S3Client | null = null;

function getR2Client(): S3Client {
  if (r2Client) {
    return r2Client;
  }

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing R2 configuration. Please set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY environment variables.');
  }

  r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  return r2Client;
}

function getBucketName(): string {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) {
    throw new Error('Missing R2_BUCKET_NAME environment variable.');
  }
  return bucket;
}

export function getPublicUrl(): string | undefined {
  return process.env.R2_PUBLIC_URL;
}

async function generatePresignedPutUrl(
  key: string,
  contentType: string,
  expiresIn: number = 3600 // 1 hour default
): Promise<string> {
  const client = getR2Client();
  const bucket = getBucketName();

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(client, command, { expiresIn });
}

async function generatePresignedGetUrl(
  key: string,
  expiresIn: number = 3600 // 1 hour default
): Promise<string> {
  const client = getR2Client();
  const bucket = getBucketName();

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  return getSignedUrl(client, command, { expiresIn });
}

async function fileExists(key: string): Promise<boolean> {
  const client = getR2Client();
  const bucket = getBucketName();

  try {
    await client.send(new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    }));
    return true;
  } catch (error: any) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

async function getFileMetadata(key: string): Promise<{
  contentType?: string;
  contentLength?: number;
  lastModified?: Date;
  etag?: string;
} | null> {
  const client = getR2Client();
  const bucket = getBucketName();

  try {
    const response = await client.send(new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    }));

    return {
      contentType: response.ContentType,
      contentLength: response.ContentLength,
      lastModified: response.LastModified,
      etag: response.ETag,
    };
  } catch (error: any) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw error;
  }
}

async function deleteFile(key: string): Promise<void> {
  const client = getR2Client();
  const bucket = getBucketName();

  await client.send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  }));
}

/**
 * Upload a file from a URL directly to R2
 * Downloads the file from the source URL and uploads it to R2
 */
async function uploadFileFromUrl(
  sourceUrl: string,
  key: string,
  options?: {
    contentType?: string;
    timeout?: number;
  }
): Promise<{ success: boolean; error?: string; size?: number }> {
  const client = getR2Client();
  const bucket = getBucketName();

  try {
    // Fetch the file from the source URL
    const response = await fetch(sourceUrl, {
      signal: AbortSignal.timeout(options?.timeout || 300000), // 5 min default timeout
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Failed to fetch source URL: ${response.status} ${response.statusText}`,
      };
    }

    // Get the content type from response or options
    const contentType = options?.contentType || response.headers.get('content-type') || 'application/octet-stream';

    // Read the entire body as a buffer
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Upload to R2
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }));

    return {
      success: true,
      size: buffer.length,
    };
  } catch (error: any) {
    console.error('Failed to upload file from URL:', error);
    return {
      success: false,
      error: error.message || 'Failed to upload file',
    };
  }
}

/**
 * Upload a buffer directly to R2
 */
export async function uploadBuffer(
  buffer: Buffer,
  key: string,
  contentType: string
): Promise<{ success: boolean; error?: string }> {
  const client = getR2Client();
  const bucket = getBucketName();

  try {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }));

    return { success: true };
  } catch (error: any) {
    console.error('Failed to upload buffer:', error);
    return {
      success: false,
      error: error.message || 'Failed to upload',
    };
  }
}

// Allowed MIME types for file uploads
const ALLOWED_MIME_TYPES = new Set([
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/tiff',

  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'text/html',
  'text/markdown',

  // Archives
  'application/zip',
  'application/x-rar-compressed',
  'application/x-7z-compressed',
  'application/gzip',
  'application/x-tar',

  // Video
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',

  // Audio
  'audio/mpeg',
  'audio/wav',
  'audio/webm',
  'audio/ogg',

  // Code
  'application/json',
  'application/xml',
  'text/javascript',
  'text/css',
]);

function isAllowedMimeType(mimeType: string): boolean {
  return ALLOWED_MIME_TYPES.has(mimeType);
}

/**
 * Download a file from R2 as a Buffer
 */
export async function downloadFile(key: string): Promise<{
  buffer: Buffer;
  contentType?: string;
  contentLength?: number;
} | null> {
  const client = getR2Client();
  const bucket = getBucketName();

  try {
    const response = await client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }));

    if (!response.Body) {
      return null;
    }

    // Convert stream to buffer
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    return {
      buffer,
      contentType: response.ContentType,
      contentLength: response.ContentLength,
    };
  } catch (error: any) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw error;
  }
}
