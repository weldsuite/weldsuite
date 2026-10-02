/**
 * MP3 frame helpers for chunking a stored recording before Whisper.
 *
 * RealtimeKit exports the audio-only recording as MP3 (we request
 * `audio_config.codec: 'MP3'`). MP3 can be cut on frame boundaries without
 * re-encoding, which is what lets a Worker split a one-hour file into
 * Whisper-sized clips: read a byte range from R2, align both ends to a frame
 * header, send it. AAC could not be sliced this way, so anything that is not
 * Layer III MPEG audio is reported as unsupported by {@link isMp3}.
 *
 * Only Layer III (the "MP3" layer) is understood; that is all RealtimeKit emits.
 */

/** How many bytes past a nominal chunk end a reader must fetch to find the next frame. */
export const MP3_ALIGN_SLACK_BYTES = 16 * 1024;

// Bitrates in kbps, indexed by the 4-bit header field. Index 0 (free) and 15 are invalid.
const BITRATES_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES: Record<number, [number, number, number]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};

export interface Mp3FrameHeader {
  /** Whole frame length in bytes, header included. */
  frameLength: number;
  sampleRate: number;
  /** PCM samples carried by the frame (1152 for MPEG1, 576 otherwise). */
  samplesPerFrame: number;
}

/** Decode the frame header at `i`, or null when the bytes there are not a Layer III header. */
export function parseFrameHeader(buf: Uint8Array, i: number): Mp3FrameHeader | null {
  if (i < 0 || i + 4 > buf.length) return null;
  const b0 = buf[i]!;
  const b1 = buf[i + 1]!;
  const b2 = buf[i + 2]!;
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  const versionBits = (b1 >> 3) & 0x3; // 0 = 2.5, 1 = reserved, 2 = MPEG2, 3 = MPEG1
  const layerBits = (b1 >> 1) & 0x3; // 1 = Layer III
  if (versionBits === 1 || layerBits !== 1) return null;

  const bitrateIdx = (b2 >> 4) & 0xf;
  const sampleRateIdx = (b2 >> 2) & 0x3;
  if (bitrateIdx === 0 || bitrateIdx === 15 || sampleRateIdx === 3) return null;

  const isMpeg1 = versionBits === 3;
  const bitrate = (isMpeg1 ? BITRATES_MPEG1_L3 : BITRATES_MPEG2_L3)[bitrateIdx]! * 1000;
  const sampleRate = SAMPLE_RATES[versionBits]![sampleRateIdx]!;
  const padding = (b2 >> 1) & 0x1;
  const samplesPerFrame = isMpeg1 ? 1152 : 576;
  const frameLength = Math.floor(((isMpeg1 ? 144 : 72) * bitrate) / sampleRate) + padding;
  if (frameLength < 4) return null;
  return { frameLength, sampleRate, samplesPerFrame };
}

/** A valid header whose successor is also a valid header (or the buffer ends first). */
function isFrameStart(buf: Uint8Array, i: number): Mp3FrameHeader | null {
  const header = parseFrameHeader(buf, i);
  if (!header) return null;
  const next = i + header.frameLength;
  if (next + 4 > buf.length) return header; // cannot look further; accept
  return parseFrameHeader(buf, next) ? header : null;
}

/** Index of the first frame start at or after `from`, or -1. */
export function findFrameStart(buf: Uint8Array, from: number): number {
  for (let i = Math.max(0, from); i + 4 <= buf.length; i++) {
    if (buf[i] === 0xff && isFrameStart(buf, i)) return i;
  }
  return -1;
}

/** Size in bytes of a leading ID3v2 tag (0 when there is none). */
export function id3v2Size(buf: Uint8Array): number {
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0;
  const size =
    ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f);
  return 10 + size;
}

/** True when `head` (the first bytes of a file) is Layer III MPEG audio. */
export function isMp3(head: Uint8Array): boolean {
  const skip = id3v2Size(head);
  return findFrameStart(head, skip) >= 0;
}

/** Playing time in seconds of the whole frames in `buf`. */
export function mp3DurationSeconds(buf: Uint8Array): number {
  let i = findFrameStart(buf, id3v2Size(buf));
  if (i < 0) return 0;
  let seconds = 0;
  while (i >= 0 && i + 4 <= buf.length) {
    const header = parseFrameHeader(buf, i);
    if (!header) {
      i = findFrameStart(buf, i + 1);
      continue;
    }
    seconds += header.samplesPerFrame / header.sampleRate;
    i += header.frameLength;
  }
  return seconds;
}

export interface Mp3ChunkWindow {
  /** Absolute byte offset of the first byte to fetch. */
  offset: number;
  /** Number of bytes to fetch (nominal chunk + alignment slack, clipped to the file). */
  length: number;
  /** True for the final chunk of the file. */
  isLast: boolean;
}

/**
 * The byte window to fetch for chunk `index`: a nominal `chunkBytes` plus slack
 * so the end can be aligned to the next frame. Chunk boundaries are defined as
 * "first frame start at or after `index * chunkBytes`", so adjacent chunks
 * share an exact boundary without overlap or gap.
 */
export function mp3ChunkWindow(totalBytes: number, chunkBytes: number, index: number): Mp3ChunkWindow {
  const offset = index * chunkBytes;
  const isLast = offset + chunkBytes >= totalBytes;
  const length = Math.min(totalBytes - offset, chunkBytes + (isLast ? 0 : MP3_ALIGN_SLACK_BYTES));
  return { offset, length, isLast };
}

/** Number of chunks a file of `totalBytes` splits into. */
export function mp3ChunkCount(totalBytes: number, chunkBytes: number): number {
  return Math.max(1, Math.ceil(totalBytes / chunkBytes));
}

/**
 * Cut the frame-aligned clip out of a fetched window. `window` is what
 * {@link mp3ChunkWindow} described. Returns a subarray (no copy) holding whole
 * frames only.
 */
export function alignMp3Chunk(
  window: Uint8Array,
  chunkBytes: number,
  { index, isLast }: { index: number; isLast: boolean },
): Uint8Array {
  // The first chunk may begin with an ID3v2 tag: skip it. Later chunks begin
  // mid-stream, so scan forward to the first frame.
  const from = index === 0 ? id3v2Size(window) : 0;
  const start = findFrameStart(window, from);
  if (start < 0) return new Uint8Array(0);
  const end = isLast ? window.length : findFrameStart(window, chunkBytes);
  return window.subarray(start, end < 0 ? window.length : end);
}
