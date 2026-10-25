/**
 * List numbering: counts list paragraphs in document order and renders each
 * one's marker from its list level's template (`%1.`, `%1.%2.`, a bullet).
 */

import type { ListDef, ListFormat, ListLevel, ParaProps } from './styles';

export function formatNumber(n: number, format: ListFormat): string {
  switch (format) {
    case 'decimal':
      return String(n);
    case 'lowerAlpha':
      return alpha(n);
    case 'upperAlpha':
      return alpha(n).toUpperCase();
    case 'lowerRoman':
      return roman(n).toLowerCase();
    case 'upperRoman':
      return roman(n);
    default:
      return '';
  }
}

function alpha(n: number): string {
  let out = '';
  for (let v = Math.max(1, n); v > 0; v = Math.floor((v - 1) / 26)) out = String.fromCharCode(97 + ((v - 1) % 26)) + out;
  return out;
}

const ROMAN: [number, string][] = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

function roman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  let out = '';
  let v = n;
  for (const [value, sym] of ROMAN) {
    while (v >= value) {
      out += sym;
      v -= value;
    }
  }
  return out;
}

export function isOrdered(level: ListLevel | undefined): boolean {
  return !!level && level.format !== 'bullet' && level.format !== 'check' && level.format !== 'none';
}

/** A bullet's own text; a checklist item shows its box, ticked or not. */
function unorderedMarker(level: ListLevel, props: ParaProps): string {
  if (level.format !== 'check') return level.text;
  return props.checked ? '☑' : '☐';
}

/**
 * Feed it every paragraph in document order; it returns the marker text of
 * list paragraphs (and '' for others). A deeper level restarts when a
 * shallower one advances, as in Word and Google Docs.
 */
export class ListCounter {
  private readonly counters = new Map<string, number[]>();

  constructor(private readonly lists: (id: string) => ListDef | undefined) {}

  next(props: ParaProps): { marker: string; level: ListLevel } | null {
    if (!props.list) return null;
    const def = this.lists(props.list.id);
    const level = def?.levels[props.list.level];
    if (!def || !level) return null;
    const lvl = props.list.level;
    let counts = this.counters.get(props.list.id);
    if (!counts) {
      counts = [];
      this.counters.set(props.list.id, counts);
    }
    counts[lvl] = (counts[lvl] ?? (level.start ?? 1) - 1) + 1;
    counts.length = lvl + 1;
    if (!isOrdered(level)) return { marker: unorderedMarker(level, props), level };
    const marker = level.text.replace(/%([1-9])/g, (_, d: string) => {
      const i = Number(d) - 1;
      const l = def.levels[i];
      return formatNumber(counts![i] ?? l?.start ?? 1, l?.format ?? 'decimal');
    });
    return { marker, level };
  }
}
