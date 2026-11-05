/**
 * Fractional indexes for z-order: string keys that sort lexicographically,
 * with a key between any two. Reordering one element changes only its own
 * key, so two people reordering at once never renumber each other's
 * elements. Two concurrent inserts between the same neighbours can produce
 * the same key; `compareOrder` breaks that tie by element id, so every
 * replica draws the same stack.
 *
 * Keys are an integer part (a head letter giving its length, then digits)
 * and a fraction with no trailing zero, in base 62, so appending on top over
 * and over grows the key by one character only every few thousand appends.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS[0]!;
const SMALLEST_INTEGER = 'A' + ZERO.repeat(26);
const MAX_KEY = 128;

function integerLength(head: string): number | null {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2;
  if (head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2;
  return null;
}

function integerPart(key: string): string {
  const length = integerLength(key[0] ?? '');
  if (length === null || length > key.length) throw new Error(`invalid order key: ${key}`);
  return key.slice(0, length);
}

/** Whether `key` is a well-formed order key. */
export function isOrderKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY) return false;
  for (const ch of key) if (!DIGITS.includes(ch)) return false;
  const length = integerLength(key[0]!);
  if (length === null || length > key.length) return false;
  if (key === SMALLEST_INTEGER) return false;
  const fraction = key.slice(length);
  return !fraction.endsWith(ZERO);
}

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]!) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round((digitA + digitB) / 2)]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA]! + midpoint(a.slice(1), null);
}

function incrementInteger(x: string): string | null {
  const head = x[0]!;
  const digits = x.slice(1).split('');
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]!) + 1;
    if (d === DIGITS.length) digits[i] = ZERO;
    else {
      digits[i] = DIGITS[d]!;
      carry = false;
    }
  }
  if (!carry) return head + digits.join('');
  if (head === 'Z') return 'a' + ZERO;
  if (head === 'z') return null;
  const next = String.fromCharCode(head.charCodeAt(0) + 1);
  if (next > 'a') digits.push(ZERO);
  else digits.pop();
  return next + digits.join('');
}

function decrementInteger(x: string): string | null {
  const head = x[0]!;
  const digits = x.slice(1).split('');
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]!) - 1;
    if (d === -1) digits[i] = DIGITS[DIGITS.length - 1]!;
    else {
      digits[i] = DIGITS[d]!;
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join('');
  if (head === 'a') return 'Z' + DIGITS[DIGITS.length - 1]!;
  if (head === 'A') return null;
  const next = String.fromCharCode(head.charCodeAt(0) - 1);
  if (next < 'Z') digits.push(DIGITS[DIGITS.length - 1]!);
  else digits.pop();
  return next + digits.join('');
}

/**
 * A key strictly between `a` and `b` (null: no bound on that side). Throws
 * when `a >= b`.
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) throw new Error(`order keys out of order: ${a} >= ${b}`);
  if (a === null) {
    if (b === null) return 'a' + ZERO;
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) return ib + midpoint('', fb);
    if (ib < b) return ib;
    const res = decrementInteger(ib);
    if (res === null) throw new Error('order key underflow');
    return res;
  }
  if (b === null) {
    const ia = integerPart(a);
    const fa = a.slice(ia.length);
    const next = incrementInteger(ia);
    return next === null ? ia + midpoint(fa, null) : next;
  }
  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const next = incrementInteger(ia);
  if (next === null) throw new Error('order key overflow');
  if (next < b) return next;
  return ia + midpoint(fa, null);
}

/** `count` increasing keys between `a` and `b`. */
export function keysBetween(a: string | null, b: string | null, count: number): string[] {
  if (count <= 0) return [];
  if (count === 1) return [keyBetween(a, b)];
  if (b === null) {
    const keys: string[] = [];
    let prev = a;
    for (let i = 0; i < count; i++) {
      prev = keyBetween(prev, null);
      keys.push(prev);
    }
    return keys;
  }
  if (a === null) {
    const keys: string[] = [];
    let next = b;
    for (let i = 0; i < count; i++) {
      next = keyBetween(null, next);
      keys.push(next);
    }
    return keys.reverse();
  }
  const mid = Math.floor(count / 2);
  const c = keyBetween(a, b);
  return [...keysBetween(a, c, mid), c, ...keysBetween(c, b, count - mid - 1)];
}

/** Stacking order: by key, ties by id. */
export function compareOrder(a: { order: string; id: string }, b: { order: string; id: string }): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}
