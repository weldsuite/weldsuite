/**
 * Turns a character's direct style plus its paragraph's named style into
 * what layout and drawing need (a font, colours, decorations). Cached per
 * paragraph style and character style, so a long document resolves each
 * combination once.
 */

import type { DocModel } from '../model/document';
import { resolveText } from '../model/resolve';
import type { ParaProps, TextStyle } from '../model/styles';
import type { RunStyle } from './types';

export const SCRIPT_SCALE = 0.65;

export class RunStyles {
  private readonly cache = new Map<string, RunStyle>();

  constructor(private readonly doc: DocModel) {}

  clear(): void {
    this.cache.clear();
  }

  /** Style of character style id `styleId` in a paragraph with (resolved or not) props `para`. */
  get(para: ParaProps, styleId: number): RunStyle {
    const key = `${para.style ?? ''}\u0000${styleId}`;
    let style = this.cache.get(key);
    if (!style) {
      style = toRunStyle(this.doc, para, this.doc.textStyles.get(styleId));
      this.cache.set(key, style);
    }
    return style;
  }

  /** For a text style that is not in the document's table (list markers). */
  fromStyle(para: ParaProps, text: TextStyle): RunStyle {
    return toRunStyle(this.doc, para, text);
  }
}

function toRunStyle(doc: DocModel, para: ParaProps, direct: TextStyle): RunStyle {
  const t = resolveText(doc, para, direct);
  let size = t.size;
  let baselineShift: number | undefined;
  if (t.script === 'super') {
    baselineShift = size * 0.33;
    size *= SCRIPT_SCALE;
  } else if (t.script === 'sub') {
    baselineShift = -size * 0.14;
    size *= SCRIPT_SCALE;
  }
  if (t.smallCaps) size *= 0.85;
  const style: RunStyle = {
    font: { family: t.font, size, bold: !!t.bold, italic: !!t.italic },
    color: t.color ?? '#000000',
  };
  if (t.highlight) style.highlight = t.highlight;
  if (t.underline) style.underline = true;
  if (t.strike) style.strike = true;
  if (baselineShift) style.baselineShift = baselineShift;
  if (t.link) style.link = t.link;
  if (t.suggestion) style.suggestion = t.suggestion;
  if (t.spacing) style.spacing = t.spacing;
  if (t.allCaps || t.smallCaps) style.caps = true;
  return style;
}

/** Text as drawn: upper-cased for all caps and small caps. */
export function displayText(text: string, style: RunStyle): string {
  return style.caps ? text.toUpperCase() : text;
}
