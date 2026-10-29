/**
 * A PGlite handle that answers the Postgres wire protocol the way a real
 * server does, for the conformance harness's socket server
 * (`@electric-sql/pglite-socket`, see ./conformance.ts).
 *
 * pglite-socket hands pglite one frontend message at a time. When a message
 * of the extended query protocol fails (a Parse with a syntax error, an
 * Execute that hits a unique violation), pglite 0.4 answers it with
 * ErrorResponse *and* ReadyForQuery, and then answers the client's Sync with
 * a second ReadyForQuery. A real server sends ErrorResponse, discards
 * messages until Sync, and sends exactly one ReadyForQuery for that Sync.
 *
 * A client that counts one ReadyForQuery per Sync (sqlx does) takes the extra
 * one as the reply to its next message, and every later query on that
 * connection fails ("expected ParseComplete, got ReadyForQuery"). So this
 * wrapper drops ReadyForQuery from the reply to any extended-protocol
 * message: Parse, Bind, Describe, Execute, Close and Flush never get one from
 * a real server; only Sync, a simple Query, a FunctionCall, the end of a
 * simple-query COPY and the startup do, and those pass through untouched.
 * pglite already discards the messages up to Sync itself.
 */

import type { PGlite } from '@electric-sql/pglite';

/** Frontend message types of the extended query protocol, minus Sync. */
const EXTENDED_QUERY = new Set(['P', 'B', 'D', 'E', 'C', 'H'].map((type) => type.codePointAt(0)));
const READY_FOR_QUERY = 'Z'.codePointAt(0);

type RawStreamOptions = NonNullable<Parameters<PGlite['execProtocolRawStream']>[1]>;

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** The backend messages in `data`, without the ReadyForQuery ones. */
export function withoutReadyForQuery(data: Uint8Array): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const kept: Uint8Array[] = [];
  let offset = 0;
  while (offset + 5 <= data.length) {
    const end = offset + 1 + view.getInt32(offset + 1);
    if (data[offset] !== READY_FOR_QUERY) kept.push(data.subarray(offset, end));
    offset = end;
  }
  // A partial message cannot happen (the reply to one message is complete);
  // pass any tail through rather than lose bytes.
  if (offset < data.length) kept.push(data.subarray(offset));
  return concat(kept);
}

/** `client` for pglite-socket, with one ReadyForQuery per Sync. */
export function wireCompatiblePglite(client: PGlite): PGlite {
  const execProtocolRawStream = async (message: Uint8Array, options: RawStreamOptions): Promise<void> => {
    if (!EXTENDED_QUERY.has(message[0])) return client.execProtocolRawStream(message, options);
    const onRawData = options.onRawData;
    const chunks: Uint8Array[] = [];
    // The reply is small for every message but Execute; buffering it keeps a
    // ReadyForQuery split across two chunks from slipping through.
    await client.execProtocolRawStream(message, { ...options, onRawData: (data) => chunks.push(data.slice()) });
    const reply = withoutReadyForQuery(concat(chunks));
    if (reply.length > 0) onRawData(reply);
  };
  return new Proxy(client, {
    get(target, property) {
      if (property === 'execProtocolRawStream') return execProtocolRawStream;
      // Methods run on the real client: PGlite keeps private state.
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
