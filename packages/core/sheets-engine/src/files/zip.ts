/**
 * ZIP container, the package format of .xlsx files.
 *
 * Built on the platform's CompressionStream / DecompressionStream with
 * 'deflate-raw', so it runs unchanged in browsers, Workers and Node. Reads
 * stored and deflated entries, including ZIP64 sizes and offsets; writes
 * deflated entries (no ZIP64: nothing we write comes near 4 GB).
 *
 * Reading never trusts the sizes an archive declares: every entry is
 * inflated against a byte budget, so a small file that expands to gigabytes
 * (a zip bomb) stops with an error instead of exhausting memory.
 */

export type ZipErrorCode = 'not_zip' | 'unsupported' | 'too_large' | 'corrupt';

export class ZipError extends Error {
  constructor(
    message: string,
    readonly code: ZipErrorCode,
  ) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipLimits {
  /** Largest uncompressed entry, in bytes (default 256 MB). */
  maxEntrySize?: number;
  /** Most bytes the entries read may expand to together (default 512 MB). */
  maxTotalSize?: number;
  /** Most entries in the archive (default 10,000). */
  maxEntries?: number;
}

const DEFAULT_LIMITS: Required<ZipLimits> = {
  maxEntrySize: 256 * 1024 * 1024,
  maxTotalSize: 512 * 1024 * 1024,
  maxEntries: 10_000,
};

interface Entry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export interface ZipReader {
  /** Entry names as stored (without a leading '/'). */
  names(): string[];
  has(name: string): boolean;
  /** The entry's bytes, or null when there is no such entry. Names match without regard to case. */
  read(name: string): Promise<Uint8Array | null>;
  readText(name: string): Promise<string | null>;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

/** Opens an archive held in memory. Throws `ZipError` for anything that is not a readable ZIP. */
export function openZip(data: Uint8Array, limits: ZipLimits = {}): ZipReader {
  const max = { ...DEFAULT_LIMITS, ...limits };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const entries = readDirectory(data, view, max.maxEntries);
  const byName = new Map(entries.map((e) => [normalizeName(e.name), e]));
  let budget = max.maxTotalSize;

  const read = async (name: string): Promise<Uint8Array | null> => {
    const entry = byName.get(normalizeName(name));
    if (!entry) return null;
    const limit = Math.min(max.maxEntrySize, budget);
    if (entry.size > limit) throw new ZipError(`${entry.name} is too large to read`, 'too_large');
    const bytes = await extract(data, view, entry, limit);
    budget -= bytes.byteLength;
    return bytes;
  };

  return {
    names: () => entries.map((e) => e.name),
    has: (name) => byName.has(normalizeName(name)),
    read,
    readText: async (name) => {
      const bytes = await read(name);
      return bytes ? decodeText(bytes) : null;
    },
  };
}

function normalizeName(name: string): string {
  return name.replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase();
}

function readDirectory(data: Uint8Array, view: DataView, maxEntries: number): Entry[] {
  const end = findEnd(view);
  if (end < 0) throw new ZipError('This is not a ZIP archive', 'not_zip');
  let count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (count === MAX_U16 || offset === MAX_U32) {
    const z64 = readEnd64(view, end);
    count = z64.count;
    offset = z64.offset;
  }
  if (count > maxEntries) throw new ZipError('The archive has too many entries', 'too_large');

  const entries: Entry[] = [];
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > view.byteLength || view.getUint32(p, true) !== SIG_CENTRAL) throw new ZipError('The archive directory is damaged', 'corrupt');
    const flags = view.getUint16(p + 8, true);
    if (flags & 1) throw new ZipError('Encrypted archives are not supported', 'unsupported');
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const entry: Entry = {
      name: decodeText(data.subarray(p + 46, p + 46 + nameLength)),
      method: view.getUint16(p + 10, true),
      crc: view.getUint32(p + 16, true),
      compressedSize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      localOffset: view.getUint32(p + 42, true),
    };
    applyZip64Extra(view, p + 46 + nameLength, extraLength, entry);
    entries.push(entry);
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Offset of the end-of-central-directory record, searched from the end (it may carry a comment). */
function findEnd(view: DataView): number {
  const last = view.byteLength - 22;
  const first = Math.max(0, last - MAX_U16);
  for (let p = last; p >= first; p--) {
    if (view.getUint32(p, true) === SIG_END) return p;
  }
  return -1;
}

function readEnd64(view: DataView, end: number): { count: number; offset: number } {
  const locator = end - 20;
  if (locator < 0 || view.getUint32(locator, true) !== SIG_LOCATOR64) throw new ZipError('The ZIP64 directory is missing', 'corrupt');
  const at = readU64(view, locator + 8);
  if (at + 56 > view.byteLength || view.getUint32(at, true) !== SIG_END64) throw new ZipError('The ZIP64 directory is damaged', 'corrupt');
  return { count: readU64(view, at + 32), offset: readU64(view, at + 48) };
}

/** Sizes and offsets too big for 32 bits live in the ZIP64 extra field, in this order. */
function applyZip64Extra(view: DataView, start: number, length: number, entry: Entry): void {
  if (entry.size !== MAX_U32 && entry.compressedSize !== MAX_U32 && entry.localOffset !== MAX_U32) return;
  let p = start;
  while (p + 4 <= start + length) {
    const id = view.getUint16(p, true);
    const size = view.getUint16(p + 2, true);
    if (id === 1) {
      let q = p + 4;
      if (entry.size === MAX_U32) [entry.size, q] = [readU64(view, q), q + 8];
      if (entry.compressedSize === MAX_U32) [entry.compressedSize, q] = [readU64(view, q), q + 8];
      if (entry.localOffset === MAX_U32) entry.localOffset = readU64(view, q);
      return;
    }
    p += 4 + size;
  }
}

function readU64(view: DataView, p: number): number {
  return view.getUint32(p, true) + view.getUint32(p + 4, true) * 2 ** 32;
}

async function extract(data: Uint8Array, view: DataView, entry: Entry, limit: number): Promise<Uint8Array> {
  const p = entry.localOffset;
  if (p + 30 > view.byteLength || view.getUint32(p, true) !== SIG_LOCAL) throw new ZipError(`${entry.name} is damaged`, 'corrupt');
  const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true);
  const end = start + entry.compressedSize;
  if (end > data.byteLength) throw new ZipError(`${entry.name} is cut short`, 'corrupt');
  const raw = data.subarray(start, end);

  let bytes: Uint8Array;
  if (entry.method === 0) bytes = raw;
  else if (entry.method === 8) bytes = await inflate(raw, limit, entry.name);
  else throw new ZipError(`${entry.name} uses a compression method that is not supported`, 'unsupported');
  if (bytes.byteLength > limit) throw new ZipError(`${entry.name} is too large to read`, 'too_large');
  if (crc32(bytes) !== entry.crc) throw new ZipError(`${entry.name} is damaged (checksum mismatch)`, 'corrupt');
  return bytes;
}

async function inflate(raw: Uint8Array, limit: number, name: string): Promise<Uint8Array> {
  try {
    return await readAll(streamOf(raw).pipeThrough(new DecompressionStream('deflate-raw')), limit);
  } catch (err) {
    if (err === TOO_LARGE) throw new ZipError(`${name} is too large to read`, 'too_large');
    throw new ZipError(`${name} is damaged`, 'corrupt');
  }
}

const TOO_LARGE = new Error('too large');

/** Everything `stream` yields, stopping (with TOO_LARGE) past `limit` bytes. */
async function readAll(stream: ReadableStream<Uint8Array>, limit = Infinity): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw TOO_LARGE;
    }
    chunks.push(value);
  }
  return concat(chunks, total);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface ZipFile {
  name: string;
  data: Uint8Array | string;
}

/** Packs `files` (deflated, UTF-8 names) into one archive. */
export async function writeZip(files: ZipFile[], options: { date?: Date } = {}): Promise<Uint8Array> {
  const { time, date } = dosDateTime(options.date ?? new Date());
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const bytes = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    const crc = crc32(bytes);
    const compressed = await deflate(bytes);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, SIG_LOCAL, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 8, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, compressed.byteLength, true);
    local.setUint32(22, bytes.byteLength, true);
    local.setUint16(26, name.byteLength, true);
    parts.push(new Uint8Array(local.buffer), name, compressed);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, SIG_CENTRAL, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 8, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, compressed.byteLength, true);
    entry.setUint32(24, bytes.byteLength, true);
    entry.setUint16(28, name.byteLength, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);

    offset += 30 + name.byteLength + compressed.byteLength;
  }

  const directorySize = central.reduce((n, b) => n + b.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, SIG_END, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  return concat(all, offset + directorySize + 22);
}

function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  return readAll(streamOf(bytes).pipeThrough(new CompressionStream('deflate-raw')));
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function streamOf(bytes: Uint8Array): ReadableStream<BufferSource> {
  // Streams take ArrayBuffer-backed views; view the same memory rather than copy it.
  const buffer = bytes.buffer;
  const view = buffer instanceof ArrayBuffer ? new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(view);
      controller.close();
    },
  });
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]!.byteLength === total) return chunks[0]!;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.byteLength;
  }
  return out;
}

/** UTF-8, with a byte-order mark dropped (TextDecoder's default). */
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

let crcTable: Uint32Array | null = null;

export function crc32(bytes: Uint8Array): number {
  crcTable ??= makeCrcTable();
  let crc = MAX_U32;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ MAX_U32) >>> 0;
}

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
