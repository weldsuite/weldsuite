import { describe, expect, it } from 'vitest';
import { MULTIPART_PART_BYTES, copyResponseToR2 } from './r2-copy';

interface FakeUpload {
  parts: Uint8Array[];
  completed: boolean;
  aborted: boolean;
}

function fakeBucket() {
  const puts: Array<{ key: string; size: number }> = [];
  const uploads: FakeUpload[] = [];
  const bucket = {
    async put(key: string, value: Uint8Array) {
      puts.push({ key, size: value.length });
    },
    async createMultipartUpload() {
      const state: FakeUpload = { parts: [], completed: false, aborted: false };
      uploads.push(state);
      return {
        async uploadPart(n: number, bytes: Uint8Array) {
          state.parts[n - 1] = bytes.slice();
          return { partNumber: n, etag: `e${n}` };
        },
        async complete() {
          state.completed = true;
        },
        async abort() {
          state.aborted = true;
        },
      };
    },
  };
  return { bucket: bucket as unknown as R2Bucket, puts, uploads };
}

function streamOf(total: number, chunk: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const n = Math.min(chunk, total - sent);
      controller.enqueue(new Uint8Array(n).fill(1));
      sent += n;
    },
  });
}

describe('copyResponseToR2', () => {
  it('refuses a non-2xx response', async () => {
    const { bucket } = fakeBucket();
    await expect(copyResponseToR2(bucket, 'k', new Response('no', { status: 403 }), 'video/mp4')).rejects.toThrow(
      /HTTP 403/,
    );
  });

  it('puts a small unknown-length body in one request', async () => {
    const { bucket, puts, uploads } = fakeBucket();
    const size = await copyResponseToR2(bucket, 'k', new Response(streamOf(1000, 300)), 'audio/mpeg');
    expect(size).toBe(1000);
    expect(puts).toEqual([{ key: 'k', size: 1000 }]);
    expect(uploads).toHaveLength(0);
  });

  it('streams a large unknown-length body as equal parts plus a remainder, then completes', async () => {
    const { bucket, puts, uploads } = fakeBucket();
    const total = MULTIPART_PART_BYTES * 2 + 123;
    const size = await copyResponseToR2(bucket, 'k', new Response(streamOf(total, 3 * 1024 * 1024)), 'video/mp4');
    expect(size).toBe(total);
    expect(puts).toHaveLength(0);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.completed).toBe(true);
    expect(uploads[0]!.parts.map((p) => p.length)).toEqual([MULTIPART_PART_BYTES, MULTIPART_PART_BYTES, 123]);
  });

  it('aborts the multipart upload when the stream fails', async () => {
    const { bucket, uploads } = fakeBucket();
    let pulls = 0;
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls > 4) controller.error(new Error('connection reset'));
        else controller.enqueue(new Uint8Array(MULTIPART_PART_BYTES));
      },
    });
    await expect(copyResponseToR2(bucket, 'k', new Response(failing), 'video/mp4')).rejects.toThrow(/connection reset/);
    expect(uploads[0]!.aborted).toBe(true);
    expect(uploads[0]!.completed).toBe(false);
  });
});
