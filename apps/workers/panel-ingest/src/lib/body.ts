/**
 * Reads a request body, but never more than `limit` bytes: the collector is
 * public, so a Content-Length that lies (or a chunked body with none) must not
 * make it buffer an arbitrary amount.
 */

/** The body bytes, or null when it is larger than `limit` bytes. */
export async function readBytesLimited(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The body text, or null when it is larger than `limit` bytes. */
export async function readTextLimited(request: Request, limit: number): Promise<string | null> {
  const bytes = await readBytesLimited(request, limit);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}
