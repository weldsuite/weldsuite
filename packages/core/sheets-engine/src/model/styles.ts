/**
 * Cell styles.
 *
 * Styles are flat (one level of keys) so a toolbar action is a simple patch,
 * and they are content-addressed: the key is the canonical JSON of the style.
 * Two clients that bold the same cell independently therefore produce the
 * same key without coordinating ids, which keeps ops transformable.
 */

export interface BorderSide {
  style: 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double';
  color?: string;
}

export interface CellStyle {
  fontFamily?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Text colour, CSS hex (#rrggbb). */
  color?: string;
  /** Background colour, CSS hex. */
  fill?: string;
  hAlign?: 'left' | 'center' | 'right' | 'justify';
  vAlign?: 'top' | 'middle' | 'bottom';
  wrap?: 'overflow' | 'wrap' | 'clip';
  indent?: number;
  /** Degrees, -90..90. */
  rotation?: number;
  borderTop?: BorderSide;
  borderRight?: BorderSide;
  borderBottom?: BorderSide;
  borderLeft?: BorderSide;
  /** Excel number format code, e.g. "#,##0.00", "0%", "dd-mm-yyyy". */
  numFmt?: string;
}

/** A style change: a key set to `null` removes that property. */
export type StylePatch = { [K in keyof CellStyle]?: CellStyle[K] | null };

const STYLE_KEYS: (keyof CellStyle)[] = [
  'fontFamily',
  'fontSize',
  'bold',
  'italic',
  'underline',
  'strike',
  'color',
  'fill',
  'hAlign',
  'vAlign',
  'wrap',
  'indent',
  'rotation',
  'borderTop',
  'borderRight',
  'borderBottom',
  'borderLeft',
  'numFmt',
];

export function applyStylePatch(base: CellStyle | undefined, patch: StylePatch): CellStyle {
  const out: Record<string, unknown> = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === false) delete out[k];
    else out[k] = v;
  }
  return out as CellStyle;
}

/** Canonical key; `undefined` for the empty style. */
export function styleKey(style: CellStyle | undefined): string | undefined {
  if (!style) return undefined;
  const parts: string[] = [];
  for (const k of STYLE_KEYS) {
    const v = style[k];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${canonical(v)}`);
  }
  return parts.length ? `{${parts.join(',')}}` : undefined;
}

function canonical(v: unknown): string {
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Interns styles so every cell with the same look shares one object. */
export class StyleTable {
  private readonly byKey = new Map<string, CellStyle>();

  intern(style: CellStyle | undefined): string | undefined {
    const key = styleKey(style);
    if (key !== undefined && !this.byKey.has(key)) this.byKey.set(key, Object.freeze({ ...style }) as CellStyle);
    return key;
  }

  get(key: string | undefined): CellStyle | undefined {
    if (key === undefined) return undefined;
    let style = this.byKey.get(key);
    if (!style) {
      // Keys are self-describing, so a key from another client always resolves.
      style = Object.freeze(JSON.parse(key) as CellStyle);
      this.byKey.set(key, style);
    }
    return style;
  }

  patch(key: string | undefined, patch: StylePatch): string | undefined {
    return this.intern(applyStylePatch(this.get(key), patch));
  }
}
