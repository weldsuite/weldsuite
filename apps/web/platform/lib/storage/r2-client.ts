import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  S3ServiceException,
} from '@aws-sdk/client-s3';

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
  } catch (error) {
    console.error('Failed to upload buffer:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to upload',
    };
  }
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
  } catch (error) {
    if (error instanceof S3ServiceException && (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404)) {
      return null;
    }
    throw error;
  }
}
