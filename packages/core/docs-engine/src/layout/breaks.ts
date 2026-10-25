/**
 * Where a line may break: a small, practical subset of Unicode line breaking
 * (UAX #14). After spaces, after hyphens between letters, after soft
 * hyphens and zero-width spaces, and around CJK characters, but never before
 * closing punctuation or after opening punctuation.
 */

import { isWide } from './measure';

const SPACE = /[  - 　]/;
const HYPHENS = new Set(['-', '‐', '‒', '–']);
const NO_BREAK_BEFORE = new Set([...'.,;:!?)]}»”’、。，．：；！？）」』】〕〉》〗〙〛ー々〻ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ%']);
const NO_BREAK_AFTER = new Set([...'([{«“‘（「『【〔〈《〗〘〚$£€¥']);

function isAlnum(ch: string | undefined): boolean {
  return !!ch && /[\p{L}\p{N}]/u.test(ch);
}

/**
 * True when a line may break between `text[i - 1]` and `text[i]` (a break
 * before position `i`). Positions are code units; never inside a surrogate
 * pair.
 */
export function canBreakBefore(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return false;
  const code = text.charCodeAt(i);
  if (code >= 0xdc00 && code <= 0xdfff) return false;
  const prev = text[i - 1]!;
  const next = text[i]!;
  if (SPACE.test(next)) return false;
  if (NO_BREAK_BEFORE.has(next) || NO_BREAK_AFTER.has(prev)) return false;
  if (SPACE.test(prev) || prev === '​' || prev === '­') return true;
  if (HYPHENS.has(prev) && isAlnum(text[i - 2]) && isAlnum(next)) return true;
  if (prev === '—' || prev === '/') return isAlnum(next) && i >= 2;
  const prevCode = text.codePointAt(i - 1 >= 1 && isLowSurrogate(text.charCodeAt(i - 1)) ? i - 2 : i - 1)!;
  const nextCode = text.codePointAt(i)!;
  return isWide(prevCode) || isWide(nextCode);
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function isSpaceChar(ch: string): boolean {
  return SPACE.test(ch);
}
