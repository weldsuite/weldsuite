/**
 * Text measurement, behind an interface so the same layout runs in the
 * browser (canvas `measureText`) and in Node or a worker (built-in metrics),
 * where the server lays a document out for PDF export and tests run.
 *
 * All sizes are points: a font of size N is measured as if it were N px, so
 * widths come back in the same unit as the size.
 */

export interface FontSpec {
  family: string;
  /** Points. */
  size: number;
  bold: boolean;
  italic: boolean;
}

export interface FontMetrics {
  /** Distance from the baseline up to the top of the line box, points. */
  ascent: number;
  /** Distance from the baseline down to the bottom of the line box, points. */
  descent: number;
}

export interface TextMeasurer {
  /** Advance width of `text`, points. */
  measure(text: string, font: FontSpec): number;
  metrics(font: FontSpec): FontMetrics;
}

export function fontKey(font: FontSpec): string {
  return `${font.italic ? 'i' : ''}${font.bold ? 'b' : ''}${font.size}|${font.family}`;
}

/** The CSS `font` shorthand for a font spec at `scale` px per point. */
export function cssFont(font: FontSpec, scale = 1): string {
  const family = /^[a-z-]+$/i.test(font.family) ? font.family : `"${font.family.replace(/["\\]/g, '')}"`;
  return `${font.italic ? 'italic ' : ''}${font.bold ? 'bold ' : ''}${font.size * scale}px ${family}, sans-serif`;
}

/**
 * Remembers widths, since a document repeats the same words in the same
 * fonts. Bounded: it is cleared when it grows past `max` entries.
 */
export class CachedMeasurer implements TextMeasurer {
  private readonly widths = new Map<string, number>();
  private readonly fontMetrics = new Map<string, FontMetrics>();

  constructor(
    private readonly inner: TextMeasurer,
    private readonly max = 200_000,
  ) {}

  measure(text: string, font: FontSpec): number {
    if (!text) return 0;
    const key = `${fontKey(font)}\u0000${text}`;
    let w = this.widths.get(key);
    if (w === undefined) {
      if (this.widths.size >= this.max) this.widths.clear();
      w = this.inner.measure(text, font);
      this.widths.set(key, w);
    }
    return w;
  }

  metrics(font: FontSpec): FontMetrics {
    const key = fontKey(font);
    let m = this.fontMetrics.get(key);
    if (!m) {
      m = this.inner.metrics(font);
      this.fontMetrics.set(key, m);
    }
    return m;
  }
}

// ---------------------------------------------------------------- built-in metrics

// Advance widths of ASCII 32–126 in 1/1000 em, from the standard (Adobe
// base-14) font metrics. Arial and Liberation Sans share Helvetica's widths;
// Times New Roman shares Times'.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278,
  278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722,
  667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556,
  556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333,
  333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722,
  667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611,
  611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
const TIMES = [
  250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278,
  278, 564, 564, 564, 444, 921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556, 722, 667, 556, 611, 722,
  722, 944, 722, 722, 611, 333, 278, 333, 469, 500, 333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500, 500,
  500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541,
];

interface Face {
  widths: number[] | null;
  /** Width of every character in a monospaced face. */
  mono?: number;
  ascent: number;
  descent: number;
}

const FACES: Record<string, Face> = {
  sans: { widths: HELVETICA, ascent: 0.905, descent: 0.212 },
  sansBold: { widths: HELVETICA_BOLD, ascent: 0.905, descent: 0.212 },
  serif: { widths: TIMES, ascent: 0.891, descent: 0.216 },
  mono: { widths: null, mono: 600, ascent: 0.833, descent: 0.3 },
};

const SERIF = /times|georgia|garamond|cambria|serif|merriweather|playfair|lora|book/i;
const MONO = /courier|mono|consolas|menlo|code/i;

function faceOf(font: FontSpec): Face {
  if (MONO.test(font.family)) return FACES.mono!;
  if (SERIF.test(font.family) && !/sans/i.test(font.family)) return FACES.serif!;
  return font.bold ? FACES.sansBold! : FACES.sans!;
}

/**
 * Metrics without a browser: standard font widths for Latin text, an em for
 * CJK and emoji, the base letter's width for accented letters. Close to what
 * a browser shows for the common fonts, and exactly reproducible.
 */
export class MetricsMeasurer implements TextMeasurer {
  measure(text: string, font: FontSpec): number {
    const face = faceOf(font);
    let units = 0;
    for (const ch of text) units += charUnits(ch, face, font.bold);
    return (units / 1000) * font.size;
  }

  metrics(font: FontSpec): FontMetrics {
    const face = faceOf(font);
    return { ascent: face.ascent * font.size, descent: face.descent * font.size };
  }
}

function charUnits(ch: string, face: Face, bold: boolean): number {
  if (face.mono) return face.mono;
  const code = ch.codePointAt(0)!;
  if (code >= 32 && code <= 126) {
    const w = face.widths![code - 32]!;
    // Serif bold is a little wider than the regular widths we have.
    return face === FACES.serif && bold ? w * 1.04 : w;
  }
  if (code === 0xa0) return face.widths![0]!;
  if (isWide(code)) return 1000;
  const base = ch.normalize('NFD')[0]!;
  if (base !== ch && base.charCodeAt(0) >= 32 && base.charCodeAt(0) <= 126) return face.widths![base.charCodeAt(0) - 32]!;
  return 556;
}

/** CJK, Hangul, fullwidth forms and emoji: one em wide. */
export function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

// ---------------------------------------------------------------- canvas

interface MeasureContext {
  font: string;
  measureText(text: string): { width: number; fontBoundingBoxAscent?: number; fontBoundingBoxDescent?: number };
}

/**
 * Measures with a 2D canvas context (the browser, a Web Worker with
 * OffscreenCanvas). Fonts are measured at 100 px and scaled, so small sizes
 * do not lose precision to rounding.
 */
export class CanvasMeasurer implements TextMeasurer {
  private static readonly SCALE = 100;
  private current = '';

  constructor(private readonly ctx: MeasureContext) {}

  private use(font: FontSpec): number {
    const css = cssFont({ ...font, size: CanvasMeasurer.SCALE });
    if (css !== this.current) {
      this.ctx.font = css;
      this.current = css;
    }
    return font.size / CanvasMeasurer.SCALE;
  }

  measure(text: string, font: FontSpec): number {
    const k = this.use(font);
    return this.ctx.measureText(text).width * k;
  }

  metrics(font: FontSpec): FontMetrics {
    const k = this.use(font);
    const m = this.ctx.measureText('Hg');
    const ascent = m.fontBoundingBoxAscent ?? CanvasMeasurer.SCALE * 0.9;
    const descent = m.fontBoundingBoxDescent ?? CanvasMeasurer.SCALE * 0.22;
    return { ascent: ascent * k, descent: descent * k };
  }
}
