/**
 * zlib compression through the platform's `CompressionStream`, which exists
 * in browsers, Node 18+ and Cloudflare Workers, so the writer needs no
 * library. PDF's FlateDecode and PNG's IDAT are both the zlib format
 * (`'deflate'`), not raw deflate (`'deflate-raw'`).
 */

export function deflate(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new CompressionStream('deflate'));
}

/** Throws on corrupt data. */
export function inflate(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new DecompressionStream('deflate'));
}

async function pipe(data: Uint8Array, transform: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  // Write and read at the same time: awaiting the write first would stall on backpressure.
  const written = writer.write(data as Uint8Array<ArrayBuffer>).then(() => writer.close());
  const [out] = await Promise.all([new Response(transform.readable).arrayBuffer(), written]);
  return new Uint8Array(out);
}
