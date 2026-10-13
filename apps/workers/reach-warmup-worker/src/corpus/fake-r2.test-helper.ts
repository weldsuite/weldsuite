/** In-memory stand-in for the R2 bucket, for the corpus tests. */

export interface FakeR2 {
  bucket: R2Bucket;
  /** Object key to stored text. */
  store: Map<string, string>;
  /** Keys in the order they were written. */
  puts: string[];
  /** Number of `get` calls. */
  gets: () => number;
}

interface FakeR2Options {
  /** Make every `get` reject. */
  failGet?: boolean;
  /** Make every `put` reject. */
  failPut?: boolean;
}

export function createFakeR2(initial: Record<string, string> = {}, options: FakeR2Options = {}): FakeR2 {
  const store = new Map<string, string>(Object.entries(initial));
  const puts: string[] = [];
  let getCount = 0;

  const bucket = {
    async get(key: string) {
      getCount += 1;
      if (options.failGet) throw new Error('R2 unavailable');
      const text = store.get(key);
      return text === undefined ? null : { text: async () => text };
    },
    async put(key: string, value: string) {
      if (options.failPut) throw new Error('R2 write failed');
      store.set(key, value);
      puts.push(key);
      return null;
    },
  };

  return { bucket: bucket as unknown as R2Bucket, store, puts, gets: () => getCount };
}
