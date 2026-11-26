import { describe, expect, it } from 'vitest';
import { readCheckpoint, writeCheckpoint } from './checkpoint';
import { FakeBucket } from './test-support/fakes';

const KEY = 'workspaces/ws_1/docs/doc_1/document.json.gz';

describe('checkpoints in R2', () => {
  it('reads back what it wrote, gzipped, and reports its size', async () => {
    const bucket = new FakeBucket();
    const checkpoint = { revision: 7, doc: { text: 'Hello '.repeat(100) } };
    const size = await writeCheckpoint(bucket.asBinding(), KEY, checkpoint);
    expect(size).toBe(bucket.objects.get(KEY)!.byteLength);
    expect(size).toBeLessThan(JSON.stringify(checkpoint).length);
    expect(await readCheckpoint(bucket.asBinding(), KEY)).toEqual(checkpoint);
  });

  it('has nothing to read before the first checkpoint', async () => {
    expect(await readCheckpoint(new FakeBucket().asBinding(), KEY)).toBeNull();
  });

  it('writes only to an empty key when asked to', async () => {
    const bucket = new FakeBucket();
    expect(await writeCheckpoint(bucket.asBinding(), KEY, { revision: 0 }, { onlyIfAbsent: true })).toEqual(expect.any(Number));
    expect(await writeCheckpoint(bucket.asBinding(), KEY, { revision: 1 }, { onlyIfAbsent: true })).toBeNull();
    expect(await readCheckpoint(bucket.asBinding(), KEY)).toEqual({ revision: 0 });
    // A plain write replaces it, whatever the bucket answers.
    const quiet = { put: async (key: string, body: ArrayBuffer) => void (await bucket.put(key, body)), get: bucket.get.bind(bucket) };
    expect(await writeCheckpoint(quiet as unknown as R2Bucket, KEY, { revision: 2 })).toEqual(expect.any(Number));
    expect(await readCheckpoint(bucket.asBinding(), KEY)).toEqual({ revision: 2 });
  });
});
