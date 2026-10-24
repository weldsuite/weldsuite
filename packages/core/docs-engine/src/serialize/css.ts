/**
 * The bit of CSS the HTML reader needs: inline `style` declarations, colours
 * and lengths, converted to points.
 */

export function parseStyleAttr(style: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!style) return out;
  let i = 0;
  while (i < style.length) {
    // Split on ';' outside quotes and parentheses.
    let depth = 0;
    let quote = '';
    let j = i;
    for (; j < style.length; j++) {
      const ch = style[j]!;
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (ch === ';' && depth === 0) break;
    }
    const decl = style.slice(i, j);
    const colon = decl.indexOf(':');
    if (colon > 0) {
      const name = decl.slice(0, colon).trim().toLowerCase();
      const value = decl.slice(colon + 1).replace(/!important/i, '').trim();
      if (name && value) out.set(name, value);
    }
    i = j + 1;
  }
  return out;
}

const NAMED_COLORS: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
  gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000', olive: '#808000', lime: '#00ff00',
  aqua: '#00ffff', cyan: '#00ffff', teal: '#008080', navy: '#000080', fuchsia: '#ff00ff', magenta: '#ff00ff',
  purple: '#800080', orange: '#ffa500', pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9', lightgray: '#d3d3d3', lightgrey: '#d3d3d3', darkred: '#8b0000', darkblue: '#00008b',
  darkgreen: '#006400', lightblue: '#add8e6', lightgreen: '#90ee90', lightyellow: '#ffffe0', violet: '#ee82ee',
  indigo: '#4b0082', beige: '#f5f5dc', coral: '#ff7f50', crimson: '#dc143c', khaki: '#f0e68c', salmon: '#fa8072',
  tomato: '#ff6347', turquoise: '#40e0d0', windowtext: '#000000',
};

/** A colour as `#rrggbb`, or null for transparent / unreadable values. */
export function parseColor(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === 'transparent' || v === 'inherit' || v === 'initial' || v === 'none' || v === 'auto') return null;
  if (NAMED_COLORS[v]) return NAMED_COLORS[v]!;
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return `#${[...m[1]!].map((c) => c + c).join('')}`;
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(v);
  if (m) return `#${m[1]}`;
  m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (alpha === 0) return null;
    const channel = (s: string) => {
      const n = s.endsWith('%') ? (parseFloat(s) * 255) / 100 : parseFloat(s);
      return Math.max(0, Math.min(255, Math.round(n)));
    };
    return `#${[m[1]!, m[2]!, m[3]!].map((c) => channel(c).toString(16).padStart(2, '0')).join('')}`;
  }
  return null;
}

const FONT_SIZE_KEYWORDS: Record<string, number> = {
  'xx-small': 7, 'x-small': 7.5, small: 10, medium: 12, large: 13.5, 'x-large': 18, 'xx-large': 24, 'xxx-large': 36,
};

/**
 * A length in points. `em` and `%` are relative to `base` (points); returns
 * null for what cannot be read (auto, calc(), …).
 */
export function parseLength(value: string | undefined, base = 11): number | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (FONT_SIZE_KEYWORDS[v] !== undefined) return FONT_SIZE_KEYWORDS[v]!;
  const m = /^(-?[\d.]+)\s*(pt|px|em|rem|%|in|cm|mm|pc)?$/.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case 'pt':
      return n;
    case 'px':
    case undefined:
      return n * 0.75;
    case 'em':
      return n * base;
    case 'rem':
      return n * 12;
    case '%':
      return (n / 100) * base;
    case 'in':
      return n * 72;
    case 'cm':
      return (n * 72) / 2.54;
    case 'mm':
      return (n * 72) / 25.4;
    case 'pc':
      return n * 12;
    default:
      return null;
  }
}

/** First family of a `font-family` list, unquoted; generic families map to a real font. */
export function parseFontFamily(value: string | undefined): string | null {
  if (!value) return null;
  const first = value.split(',')[0]!.trim().replace(/^["']|["']$/g, '').trim();
  if (!first) return null;
  const generic: Record<string, string> = {
    serif: 'Times New Roman',
    'sans-serif': 'Arial',
    monospace: 'Courier New',
    cursive: 'Comic Sans MS',
    'system-ui': 'Arial',
    '-apple-system': 'Arial',
  };
  return generic[first.toLowerCase()] ?? first.slice(0, 100);
}
