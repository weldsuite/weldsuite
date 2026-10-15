/**
 * Groups template fingerprints into near-duplicate clusters, the same rule
 * the outbound guard uses (`isSameTemplate`: Hamming distance at most
 * FINGERPRINT_MAX_DISTANCE). Pure.
 *
 * Comparing every new fingerprint with every cluster is quadratic, and a busy
 * workspace has tens of thousands of distinct one-to-one mails. The 64-bit
 * fingerprint is therefore split into FINGERPRINT_MAX_DISTANCE + 1 bands: two
 * fingerprints that differ in at most that many bits agree exactly on at least
 * one band (pigeonhole), so only clusters sharing a band are compared.
 */

import { FINGERPRINT_MAX_DISTANCE } from '@weldsuite/app-api-client/schemas/outbound-mail';
import { isSameTemplate } from '@weldsuite/mail-domain/outbound/fingerprint';

const HEX_CHARS = 16;

/** Start offsets (in hex characters) of each band. */
function bandOffsets(bands: number): number[] {
  const offsets: number[] = [];
  let start = 0;
  for (let i = 0; i < bands; i++) {
    offsets.push(start);
    start += Math.floor(HEX_CHARS / bands) + (i < HEX_CHARS % bands ? 1 : 0);
  }
  offsets.push(HEX_CHARS);
  return offsets;
}

const OFFSETS = bandOffsets(Math.min(FINGERPRINT_MAX_DISTANCE + 1, HEX_CHARS));

function bandKeys(fingerprint: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i + 1 < OFFSETS.length; i++) {
    keys.push(`${i}:${fingerprint.slice(OFFSETS[i], OFFSETS[i + 1])}`);
  }
  return keys;
}

export class TemplateClusterer {
  private readonly representatives: string[] = [];
  private readonly exact = new Map<string, number>();
  private readonly bands = new Map<string, number[]>();

  /** Cluster index for a fingerprint; a new cluster when nothing is close enough. */
  assign(fingerprint: string): number {
    const known = this.exact.get(fingerprint);
    if (known !== undefined) return known;

    const keys = bandKeys(fingerprint);
    const candidates = new Set<number>();
    for (const key of keys) for (const index of this.bands.get(key) ?? []) candidates.add(index);

    let match = -1;
    for (const index of [...candidates].sort((a, b) => a - b)) {
      if (isSameTemplate(this.representatives[index], fingerprint)) {
        match = index;
        break;
      }
    }

    if (match === -1) {
      match = this.representatives.length;
      this.representatives.push(fingerprint);
      for (const key of keys) {
        const list = this.bands.get(key);
        if (list) list.push(match);
        else this.bands.set(key, [match]);
      }
    }
    this.exact.set(fingerprint, match);
    return match;
  }

  representative(index: number): string {
    return this.representatives[index];
  }

  get size(): number {
    return this.representatives.length;
  }
}
