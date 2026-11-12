/**
 * Hold audio for callers waiting in the WeldDesk phone queue: a ringback tone
 * generated here, so no asset or licence is involved. Telnyx fetches it from
 * `GET /public/webhooks/telnyx/ringback.wav` and loops it.
 *
 * 8 kHz mono 16-bit PCM, a 425 Hz tone for 1 s then 4 s of silence (the
 * European ringback cadence). Deterministic: the same bytes on every call.
 */

import { originForPathFrom } from '@weldsuite/api-modules';
import { getHelpdeskWorkerUrl, type HelpdeskUrlEnv } from '@weldsuite/desk-domain/helpdesk-integrations';

export const RINGBACK_PATH = '/public/webhooks/telnyx/ringback.wav';

const SAMPLE_RATE = 8000;
const TONE_HZ = 425;
const TONE_SECONDS = 1;
const CYCLE_SECONDS = 5;
const AMPLITUDE = 0.25 * 32767;
/** Samples faded in and out at each end of the tone, so it does not click. */
const FADE_SAMPLES = 80;

let cached: Uint8Array<ArrayBuffer> | null = null;

/** The WAV file: a 44-byte RIFF header and 5 s of 16-bit little-endian samples. */
export function ringbackWav(): Uint8Array<ArrayBuffer> {
  if (cached) return cached;
  const total = SAMPLE_RATE * CYCLE_SECONDS;
  const toneSamples = SAMPLE_RATE * TONE_SECONDS;
  const dataBytes = total * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < toneSamples; i += 1) {
    const fade = Math.min(1, i / FADE_SAMPLES, (toneSamples - 1 - i) / FADE_SAMPLES);
    const sample = Math.round(Math.sin((2 * Math.PI * TONE_HZ * i) / SAMPLE_RATE) * AMPLITUDE * fade);
    view.setInt16(44 + i * 2, sample, true);
  }
  cached = bytes;
  return bytes;
}

/** The URL Telnyx fetches the ringback from: this worker's own host (not app-api's forwarder). */
export function ringbackUrl(env: HelpdeskUrlEnv): string {
  return `${originForPathFrom(getHelpdeskWorkerUrl(env), RINGBACK_PATH)}${RINGBACK_PATH}`;
}
