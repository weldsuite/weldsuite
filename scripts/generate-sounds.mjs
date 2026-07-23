/**
 * Generate short notification WAV sound files for helpdesk messaging.
 * Run with: node scripts/generate-sounds.mjs
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const SAMPLE_RATE = 22050;

function generateWav(samples) {
  const numSamples = samples.length;
  const byteRate = SAMPLE_RATE * 2; // 16-bit mono
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample

  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const val = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(val * 32767), 44 + i * 2);
  }

  return buffer;
}

function envelope(t, attack, sustain, release, totalDuration) {
  if (t < attack) return t / attack;
  if (t < attack + sustain) return 1;
  const releaseStart = attack + sustain;
  if (t < releaseStart + release) return 1 - (t - releaseStart) / release;
  return 0;
}

// Message Sent: happy upward "bloop" — ascending with a bouncy round character (~180ms)
function generateSentSound() {
  const duration = 0.18;
  const numSamples = Math.floor(SAMPLE_RATE * duration);
  const samples = new Float64Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const p = t / duration;

    // Ascending freq from ~500Hz to ~900Hz — happy upward swoop
    const freq = 500 + p * 400;
    const env = envelope(t, 0.006, 0.05, 0.124, duration);

    const fundamental = Math.sin(2 * Math.PI * freq * t);
    // Soft sub for body without making it too bassy
    const sub = Math.sin(2 * Math.PI * (freq * 0.5) * t) * 0.15;
    // Light upper harmonic for brightness
    const harm = Math.sin(2 * Math.PI * freq * 1.5 * t) * 0.06 * (1 - p);

    samples[i] = (fundamental + sub + harm) * env * 0.45;
  }

  return generateWav(Array.from(samples));
}

// Message Received: happy two-tone "bloop bloop" — Intercom-style, warm but bright (~280ms)
function generateReceivedSound() {
  const duration = 0.3;
  const numSamples = Math.floor(SAMPLE_RATE * duration);
  const samples = new Float64Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;

    // First bloop: quick ascending sweep 520Hz→680Hz
    if (t < 0.13) {
      const p1 = t / 0.13;
      const freq1 = 520 + p1 * 160;
      const env1 = envelope(t, 0.005, 0.035, 0.09, 0.13);
      const tone1 = Math.sin(2 * Math.PI * freq1 * t);
      const sub1 = Math.sin(2 * Math.PI * (freq1 * 0.5) * t) * 0.15;
      samples[i] += (tone1 + sub1) * env1 * 0.4;
    }

    // Second bloop: higher ascending sweep 660Hz→880Hz, starts at t=0.11
    const t2 = t - 0.11;
    if (t2 > 0 && t2 < 0.17) {
      const p2 = t2 / 0.17;
      const freq2 = 660 + p2 * 220;
      const env2 = envelope(t2, 0.005, 0.04, 0.125, 0.17);
      const tone2 = Math.sin(2 * Math.PI * freq2 * t2);
      const sub2 = Math.sin(2 * Math.PI * (freq2 * 0.5) * t2) * 0.15;
      samples[i] += (tone2 + sub2) * env2 * 0.4;
    }
  }

  return generateWav(Array.from(samples));
}

const sentWav = generateSentSound();
const receivedWav = generateReceivedSound();

const outputs = [
  join(root, 'apps/web/platform/public/sounds/message-sent.wav'),
  join(root, 'apps/web/platform/public/sounds/message-received.wav'),
  join(root, 'apps/web/helpdesk-widget/public/sounds/message-sent.wav'),
  join(root, 'apps/web/helpdesk-widget/public/sounds/message-received.wav'),
];

writeFileSync(outputs[0], sentWav);
writeFileSync(outputs[1], receivedWav);
writeFileSync(outputs[2], sentWav);
writeFileSync(outputs[3], receivedWav);

console.log('Generated sound files:');
outputs.forEach(p => console.log(`  ${p} (${(writeFileSync, sentWav.length)} bytes)`));
console.log('Done!');
