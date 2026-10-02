import { describe, expect, it } from 'vitest';
import {
  alignMp3Chunk,
  findFrameStart,
  id3v2Size,
  isMp3,
  mp3ChunkCount,
  mp3ChunkWindow,
  mp3DurationSeconds,
  parseFrameHeader,
} from './mp3';

/** MPEG1 Layer III, 128 kbps, 44.1 kHz, no padding: 417-byte frames of 1152 samples. */
const FRAME_LEN = 417;
const FRAME_SECONDS = 1152 / 44100;

function frames(count: number): Uint8Array {
  const out = new Uint8Array(count * FRAME_LEN);
  for (let i = 0; i < count; i++) {
    out.set([0xff, 0xfb, 0x90, 0x00], i * FRAME_LEN);
  }
  return out;
}

function withId3(audio: Uint8Array, tagBody = 100): Uint8Array {
  const tag = new Uint8Array(10 + tagBody);
  tag.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, tagBody & 0x7f]);
  const out = new Uint8Array(tag.length + audio.length);
  out.set(tag);
  out.set(audio, tag.length);
  return out;
}

describe('parseFrameHeader', () => {
  it('decodes a 128 kbps / 44.1 kHz MPEG1 Layer III header', () => {
    expect(parseFrameHeader(frames(1), 0)).toEqual({
      frameLength: FRAME_LEN,
      sampleRate: 44100,
      samplesPerFrame: 1152,
    });
  });

  it('rejects non-Layer-III and garbage', () => {
    expect(parseFrameHeader(new Uint8Array([0xff, 0xfd, 0x90, 0x00]), 0)).toBeNull(); // Layer II
    expect(parseFrameHeader(new Uint8Array([0x00, 0x00, 0x00, 0x00]), 0)).toBeNull();
    expect(parseFrameHeader(new Uint8Array([0xff, 0xfb, 0xf0, 0x00]), 0)).toBeNull(); // bad bitrate
  });
});

describe('isMp3 / id3v2Size', () => {
  it('accepts raw frames and frames behind an ID3v2 tag', () => {
    expect(isMp3(frames(4))).toBe(true);
    const tagged = withId3(frames(4), 100);
    expect(id3v2Size(tagged)).toBe(110);
    expect(isMp3(tagged)).toBe(true);
  });

  it('rejects other audio (an MP4/AAC container, zeros)', () => {
    expect(isMp3(new Uint8Array(2048))).toBe(false);
    const mp4 = new Uint8Array(2048);
    mp4.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
    expect(isMp3(mp4)).toBe(false);
  });
});

describe('findFrameStart', () => {
  it('finds the first frame at or after an arbitrary offset', () => {
    const data = frames(10);
    expect(findFrameStart(data, 0)).toBe(0);
    expect(findFrameStart(data, 1)).toBe(FRAME_LEN);
    expect(findFrameStart(data, FRAME_LEN + 1)).toBe(2 * FRAME_LEN);
  });
});

describe('mp3DurationSeconds', () => {
  it('counts whole frames', () => {
    expect(mp3DurationSeconds(frames(100))).toBeCloseTo(100 * FRAME_SECONDS, 6);
    expect(mp3DurationSeconds(withId3(frames(100)))).toBeCloseTo(100 * FRAME_SECONDS, 6);
  });
});

describe('chunking', () => {
  const total = 200; // frames
  const file = withId3(frames(total), 50);
  const chunkBytes = 10_000;

  it('plans windows whose aligned clips tile the audio without gap or overlap', () => {
    const n = mp3ChunkCount(file.length, chunkBytes);
    let seconds = 0;
    let bytes = 0;
    for (let k = 0; k < n; k++) {
      const w = mp3ChunkWindow(file.length, chunkBytes, k);
      const clip = alignMp3Chunk(file.subarray(w.offset, w.offset + w.length), chunkBytes, {
        index: k,
        isLast: w.isLast,
      });
      expect(clip.length % FRAME_LEN).toBe(0);
      seconds += mp3DurationSeconds(clip);
      bytes += clip.length;
    }
    expect(bytes).toBe(total * FRAME_LEN);
    expect(seconds).toBeCloseTo(total * FRAME_SECONDS, 6);
  });

  it('treats a file smaller than one chunk as a single last chunk', () => {
    expect(mp3ChunkCount(500, chunkBytes)).toBe(1);
    expect(mp3ChunkWindow(500, chunkBytes, 0)).toEqual({ offset: 0, length: 500, isLast: true });
  });

  it('returns an empty clip when no frame can be found', () => {
    expect(alignMp3Chunk(new Uint8Array(100), 50, { index: 1, isLast: true }).length).toBe(0);
  });
});
