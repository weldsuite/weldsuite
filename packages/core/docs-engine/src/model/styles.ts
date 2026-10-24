/**
 * Formatting: character styles, paragraph properties, named styles and list
 * definitions.
 *
 * Direct formatting is stored as overrides only: a character's style lists
 * just what was set on it, and everything else comes from its paragraph's
 * named style (and that style's `basedOn` chain, ending at `normal`), as in
 * Word. Sizes and distances are in points.
 */

export type ScriptPosition = 'super' | 'sub';

/** Character formatting set directly on text. */
export interface TextStyle {
  font?: string;
  /** Points. */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** CSS hex colour, `#rrggbb`. */
  color?: string;
  /** Background behind the text, `#rrggbb`. */
  highlight?: string;
  script?: ScriptPosition;
  smallCaps?: boolean;
  allCaps?: boolean;
  /** Extra space between characters, points. */
  spacing?: number;
  /** Hyperlink target: a URL, or `#bookmarkId` / `#heading:<anchor id>` inside the document. */
  link?: string;
  /**
   * Suggested change this text belongs to (suggesting mode). Insertions show
   * until accepted; deletions show struck through until accepted.
   */
  suggestion?: { id: string; kind: 'insert' | 'delete' | 'format' };
}

/**
 * Link targets a document may hold: web, mail and phone addresses, and
 * places in the document. Anything else (javascript:, data:, …) is refused
 * wherever links come in: ops from outside, pasted HTML, Markdown.
 */
export const SAFE_LINK = /^(https?:|mailto:|tel:|#)/i;

export function isSafeLink(url: string): boolean {
  return SAFE_LINK.test(url.trim());
}

export type Align = 'left' | 'center' | 'right' | 'justify';

export interface TabStop {
  /** From the paragraph's left indent, points. */
  pos: number;
  align: 'left' | 'center' | 'right' | 'decimal';
  leader?: 'none' | 'dot' | 'hyphen' | 'underscore';
}

export interface BorderLine {
  /** Points; 0 = none. */
  width: number;
  color: string;
  style?: 'solid' | 'dashed' | 'dotted' | 'double';
}

export interface ParaBorders {
  top?: BorderLine;
  bottom?: BorderLine;
  left?: BorderLine;
  right?: BorderLine;
}

/** Paragraph formatting, held by the paragraph mark. */
export interface ParaProps {
  /** Named style id; `normal` when absent. */
  style?: string;
  align?: Align;
  indentLeft?: number;
  indentRight?: number;
  /** First-line indent; negative for a hanging indent. */
  indentFirst?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  /** Line height as a multiple of single spacing (1, 1.15, 1.5, 2…). */
  lineHeight?: number;
  /** Exact line height in points; wins over `lineHeight`. */
  lineHeightExact?: number;
  /** Paragraph is in a list at this level (0–8). */
  list?: { id: string; level: number };
  /** A checklist item that is ticked. */
  checked?: boolean;
  keepNext?: boolean;
  keepLines?: boolean;
  pageBreakBefore?: boolean;
  /** Widow and orphan control; on unless set to false. */
  widowControl?: boolean;
  tabs?: TabStop[];
  borders?: ParaBorders;
  /** Background, `#rrggbb`. */
  shading?: string;
  direction?: 'ltr' | 'rtl';
  /** Stable id for links to a heading (set when one is linked to). */
  anchorId?: string;
}

/** Sets keys (a value) or removes them (`null`); keys not mentioned stay. */
export type Patch<T> = { [K in keyof T]?: T[K] | null };

export type TextStylePatch = Patch<TextStyle>;
export type ParaPatch = Patch<ParaProps>;

export interface NamedStyle {
  /** Display name; the built-in ones are translated by the UI from their id. */
  name: string;
  basedOn?: string;
  /** Style of the paragraph Enter makes after this one (default: the same style). */
  next?: string;
  text?: TextStyle;
  para?: Omit<ParaProps, 'style' | 'list' | 'checked' | 'anchorId'>;
  /** Level in the document outline (1 = Heading 1); title counts as 0. */
  outline?: number;
}

export type ListFormat = 'bullet' | 'check' | 'decimal' | 'lowerAlpha' | 'upperAlpha' | 'lowerRoman' | 'upperRoman' | 'none';

export interface ListLevel {
  format: ListFormat;
  /**
   * The marker: for bullets the glyph, for numbers a template where `%1`…`%9`
   * are the counters of levels 1–9 (`%1.`, `%1.%2.`).
   */
  text: string;
  /** Left indent of the text, points. */
  indent: number;
  /** How far the marker hangs left of the text, points. */
  hanging: number;
  start?: number;
  /** Marker formatting (font for bullet glyphs, colour). */
  style?: TextStyle;
}

export interface ListDef {
  levels: ListLevel[];
}

export const LIST_LEVELS = 9;

export function applyPatch<T extends object>(base: T, patch: Patch<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (v !== undefined) out[k] = v;
  }
  return out as T;
}

/** The patch that turns `after` back into `before` (every key either names, so it is a full replacement of those keys). */
export function inversePatch<T extends object>(before: T, patch: Patch<T>): Patch<T> {
  const out: Record<string, unknown> = {};
  const b = before as Record<string, unknown>;
  for (const k of Object.keys(patch)) out[k] = k in b ? b[k] : null;
  return out as Patch<T>;
}

/** A patch that replaces `from` with `to` entirely. */
export function replacingPatch<T extends object>(from: T, to: T): Patch<T> {
  const out: Record<string, unknown> = {};
  const a = from as Record<string, unknown>;
  const b = to as Record<string, unknown>;
  for (const k of Object.keys(a)) if (!(k in b)) out[k] = null;
  for (const [k, v] of Object.entries(b)) if (!sameValue(a[k], v)) out[k] = v;
  return out as Patch<T>;
}

/** Deterministic JSON (sorted keys), so equal values give equal strings. */
export function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableKey(obj[k])}`).join(',')}}`;
}

export function sameValue(a: unknown, b: unknown): boolean {
  return a === b || stableKey(a) === stableKey(b);
}

export function isEmptyObject(o: object): boolean {
  for (const k in o) if ((o as Record<string, unknown>)[k] !== undefined) return false;
  return true;
}

/**
 * Character styles interned to small ids, so a story holds one number per
 * character. Ids are local to one replica (they depend on the order styles
 * were first seen) and never leave it: ops and snapshots carry the styles.
 */
export class TextStyleTable {
  private readonly styles: TextStyle[] = [{}];
  private readonly ids = new Map<string, number>([['{}', 0]]);

  intern(style: TextStyle): number {
    const key = stableKey(style);
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.styles.length;
      this.styles.push(Object.freeze({ ...style }));
      this.ids.set(key, id);
    }
    return id;
  }

  get(id: number): TextStyle {
    return this.styles[id] ?? {};
  }

  /** The id of style `id` with `patch` applied. */
  patched(id: number, patch: TextStylePatch): number {
    return this.intern(applyPatch(this.get(id), patch));
  }

  get size(): number {
    return this.styles.length;
  }
}
