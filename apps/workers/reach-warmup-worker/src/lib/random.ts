/**
 * Randomness for the warmup engine: send gaps, reply decisions, picks.
 *
 * Everything draws from an injectable `Rng` (uniform in [0, 1)) so tests can
 * script the outcome; the default is Web Crypto, never Math.random.
 */

export type Rng = () => number;

/** Uniform in [0, 1) from Web Crypto. */
export function randomFloat(): number {
  const [word] = crypto.getRandomValues(new Uint32Array(1));
  return (word ?? 0) / 4_294_967_296;
}

/** Uniform float in [min, max). */
export function randomBetween(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Uniform integer in [min, max], both inclusive. */
export function randomInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** true with probability `probability`. */
export function chance(rng: Rng, probability: number): boolean {
  return rng() < probability;
}

export function pickRandom<T>(rng: Rng, items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}

/** A shuffled copy (Fisher-Yates). */
export function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
