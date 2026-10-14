/** Message-ID helpers: normalising, splitting `References`, and a stable id for mail that has none. */

import { trimEdges } from '@weldsuite/reach-domain/inbound/strings';

const MAX_ID_LENGTH = 255;

/** `<abc@host>` to `abc@host`; null for an empty value. */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const bracketed = /<([^<>\s]+)>/.exec(raw);
  const value = (bracketed ? bracketed[1]! : trimEdges(raw.trim(), '<>')).trim();
  if (value === '') return null;
  return value.slice(0, MAX_ID_LENGTH);
}

/** Every Message-ID in an `In-Reply-To` / `References` value, in order, without brackets. */
export function parseMessageIdList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const bracketed = [...raw.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]!);
  const ids = bracketed.length > 0 ? bracketed : raw.split(/\s+/).filter((s) => s.includes('@'));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const normalized = id.trim().slice(0, MAX_ID_LENGTH);
    if (normalized === '' || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 hex of the raw message. */
export async function sha256Hex(raw: Uint8Array): Promise<string> {
  // `raw.buffer` may be a larger shared buffer: hash exactly the view's bytes.
  const copy = new Uint8Array(raw.byteLength);
  copy.set(raw);
  return toHex(await crypto.subtle.digest('SHA-256', copy));
}

/**
 * A stable stand-in for a message that has no Message-ID header, so a
 * redelivery of the same bytes de-duplicates. Never collides with a real id
 * (`.invalid` is a reserved TLD).
 */
export async function syntheticMessageId(raw: Uint8Array): Promise<string> {
  return `raw-${(await sha256Hex(raw)).slice(0, 40)}@reach.invalid`;
}
