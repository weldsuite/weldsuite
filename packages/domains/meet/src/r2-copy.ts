/**
 * Stream an HTTP response body into R2 without holding the whole file.
 *
 * RealtimeKit recordings are hundreds of MB. Two paths:
 *  - known length (and no content-encoding): `FixedLengthStream` into a single
 *    `put`, zero buffering;
 *  - otherwise: multipart upload with fixed 8 MiB parts (R2 needs every part
 *    but the last to be the same size, >= 5 MiB).
 */

/** R2 multipart part size. All parts except the last are exactly this. */
export const MULTIPART_PART_BYTES = 8 * 1024 * 1024;

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

async function putMultipart(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array>,
  contentType: string,
): Promise<number> {
  const reader = body.getReader();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let size = 0;
  const parts: R2UploadedPart[] = [];
  let upload: R2MultipartUpload | null = null;

  const flush = async (bytes: Uint8Array) => {
    upload ??= await bucket.createMultipartUpload(key, { httpMetadata: { contentType } });
    parts.push(await upload.uploadPart(parts.length + 1, bytes));
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value && value.length > 0) {
        pending.push(value);
        pendingBytes += value.length;
        size += value.length;
        while (pendingBytes >= MULTIPART_PART_BYTES) {
          const whole = concat(pending, pendingBytes);
          await flush(whole.subarray(0, MULTIPART_PART_BYTES));
          const rest = whole.subarray(MULTIPART_PART_BYTES);
          pending = rest.length > 0 ? [rest] : [];
          pendingBytes = rest.length;
        }
      }
      if (done) break;
    }

    if (!upload) {
      // Smaller than one part: a plain put.
      await bucket.put(key, concat(pending, pendingBytes), { httpMetadata: { contentType } });
      return size;
    }
    if (pendingBytes > 0) await flush(concat(pending, pendingBytes));
    await (upload as R2MultipartUpload).complete(parts);
    return size;
  } catch (err) {
    try {
      await (upload as R2MultipartUpload | null)?.abort();
    } catch {
      /* the original error matters more */
    }
    throw err;
  }
}

/**
 * Copy `res.body` to `bucket/key`. Returns the stored size in bytes. Throws on a
 * non-2xx response, a missing body or any R2 failure, leaving no partial object
 * behind for the multipart path (aborted).
 */
export async function copyResponseToR2(
  bucket: R2Bucket,
  key: string,
  res: Response,
  contentType: string,
): Promise<number> {
  if (!res.ok) throw new Error(`Download failed with HTTP ${res.status}`);
  if (!res.body) throw new Error('Download returned no body');

  const length = Number(res.headers.get('content-length'));
  const encoded = Boolean(res.headers.get('content-encoding'));
  if (length > 0 && !encoded && typeof FixedLengthStream !== 'undefined') {
    const fixed = new FixedLengthStream(length);
    const piped = res.body.pipeTo(fixed.writable);
    await bucket.put(key, fixed.readable, { httpMetadata: { contentType } });
    await piped;
    return length;
  }
  return putMultipart(bucket, key, res.body, contentType);
}
