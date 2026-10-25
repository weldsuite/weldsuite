import { describe, expect, it } from 'vitest';
import { ContentBuilder } from '../../model/builder';
import type { Content } from '../../model/content';
import { DocModel } from '../../model/document';
import { BODY, type ImageObject } from '../../model/objects';
import { applyOp } from '../../ops/apply';
import { DocLayout } from '../../layout/document-layout';
import { pageDisplay } from '../../layout/display';
import { MetricsMeasurer } from '../../layout/measure';
import { ByteReader, fromLatin1 } from './bytes';
import { exportPdf, type PdfExportOptions } from './export-pdf';
import { parseJpeg, readImage } from './images';
import { decodePng } from './png';
import { winAnsiCode } from './standard-fonts';
import { FontSubset, tableChecksum } from './subset';
import { ADVANCES, GLYPHS, buildTestFont, makeJpeg, makePng, testGlyphData } from './test-fixtures';
import { PdfDict, PdfName, PdfReader, PdfRef, PdfString, shownStrings, type PdfValue } from './test-reader';
import { glyphComponents, parseTrueType } from './truetype';

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.';

function docOf(content: Content): DocModel {
  const doc = DocModel.create();
  applyOp(doc, { type: 'insert', story: BODY, at: 0, content });
  return doc;
}

function layoutPageCount(doc: DocModel): number {
  return new DocLayout(doc, { measurer: new MetricsMeasurer() }).update().length;
}

const name = (v: PdfValue | undefined): string | undefined => (v instanceof PdfName ? v.name : undefined);

interface Exported {
  bytes: Uint8Array;
  pdf: PdfReader;
  /** Inflated content stream of each page, as characters 0–255. */
  contents: string[];
  /** Every object as a dictionary (streams by their dictionary), by number. */
  dicts: Map<number, PdfDict>;
}

async function exported(doc: DocModel, options: PdfExportOptions = {}): Promise<Exported> {
  const bytes = await exportPdf(doc, { date: new Date(Date.UTC(2026, 9, 25, 12, 0, 0)), ...options });
  const pdf = new PdfReader(bytes);
  const contents: string[] = [];
  for (const page of pdf.pages()) {
    const ref = page.dict.get('Contents');
    if (!(ref instanceof PdfRef)) throw new Error('Contents must be a reference');
    contents.push(fromLatin1(await pdf.streamOf(ref.n)));
  }
  const dicts = new Map<number, PdfDict>();
  for (const n of pdf.objectNumbers()) {
    const v = pdf.object(n).value;
    if (v instanceof PdfDict) dicts.set(n, v);
  }
  return { bytes, pdf, contents, dicts };
}

function ofType(e: Exported, key: string, value: string): [number, PdfDict][] {
  return [...e.dicts].filter(([, d]) => name(d.get(key)) === value);
}

const allText = (e: Exported): string => e.contents.flatMap((c) => shownStrings(c).map((s) => s.text)).join('\n');

// ---------------------------------------------------------------- file structure

describe('exportPdf: structure', () => {
  it('writes a well-formed file whose xref points at every object', async () => {
    const b = new ContentBuilder();
    b.addText('Hello World').endParagraph();
    const e = await exported(docOf(b.build()), { title: 'Résumé 2026', author: 'Ada' });
    const head = fromLatin1(e.bytes.subarray(0, 20));
    expect(head.startsWith('%PDF-1.7\n%')).toBe(true);
    // The binary comment: four bytes above 127.
    expect([...e.bytes.subarray(10, 14)].every((b) => b > 127)).toBe(true);
    expect(fromLatin1(e.bytes.subarray(e.bytes.length - 6))).toBe('%%EOF\n');
    // Every object is where the xref says (object() checks `n 0 obj` and endobj/endstream).
    const numbers = e.pdf.objectNumbers();
    expect(numbers.length).toBe(Number(e.pdf.trailer.get('Size')) - 1);
    for (const n of numbers) expect(() => e.pdf.object(n)).not.toThrow();
    // The xref entries are 20 bytes each.
    const xref = e.pdf.text.slice(e.pdf.startxref);
    expect(xref).toMatch(/^xref\n0 \d+\n0000000000 65535 f \n(\d{10} 00000 n \n)+trailer/);

    const info = e.pdf.dict(e.pdf.trailer.get('Info'));
    expect((info.get('Producer') as PdfString).bytes).toBe('WeldDocs');
    expect((info.get('Author') as PdfString).bytes).toBe('Ada');
    expect((info.get('CreationDate') as PdfString).bytes).toBe('D:20261025120000Z');
    // Non-ASCII titles are UTF-16BE with a byte order mark.
    expect((info.get('Title') as PdfString).bytes).toBe('\xfe\xff\0R\0\xe9\0s\0u\0m\0\xe9\0 \x002\x000\x002\x006');
    const root = e.pdf.dict(e.pdf.trailer.get('Root'));
    expect(name(root.get('Type'))).toBe('Catalog');
  });

  it('has one page per layout page, each with the layout page size', async () => {
    const b = new ContentBuilder();
    for (let i = 0; i < 40; i++) b.addText(`${i + 1}. ${LOREM}`).endParagraph({ align: 'justify' });
    const doc = docOf(b.build());
    doc.props.section = { ...doc.props.section, pageWidth: 612, pageHeight: 792 };
    const e = await exported(doc);
    const pages = e.pdf.pages();
    expect(pages.length).toBe(layoutPageCount(doc));
    expect(pages.length).toBeGreaterThan(2);
    for (const p of pages) expect(p.dict.get('MediaBox')).toEqual([0, 0, 612, 792]);
    const count = e.pdf.dict(e.pdf.dict(e.pdf.trailer.get('Root')).get('Pages')).get('Count');
    expect(count).toBe(pages.length);
    // The last paragraph is on the last page, justified lines use word spacing.
    expect(shownStrings(e.contents[e.contents.length - 1]!).some((s) => s.text.startsWith('40.'))).toBe(true);
    expect(e.contents[0]).toMatch(/\d[\d.]* Tw\n/);
  });
});

// ---------------------------------------------------------------- text

describe('exportPdf: text', () => {
  it('writes styled runs in the matching standard fonts, WinAnsi-encoded', async () => {
    const b = new ContentBuilder();
    b.addText('Plain ').addText('Bold', { bold: true }).addText(' and ').addText('italic', { italic: true }).endParagraph();
    b.addText('Serif text', { font: 'Times New Roman' }).addText(' code', { font: 'Courier New', bold: true }).endParagraph();
    b.addText('Price: €5 “quoted” – done… • ok').endParagraph();
    b.addText('Red underlined', { color: '#ff0000', underline: true }).addText(' struck', { strike: true }).endParagraph();
    b.addText('Spaced', { spacing: 2 }).endParagraph();
    const e = await exported(docOf(b.build()));
    const shown = shownStrings(e.contents[0]!);
    const texts = shown.map((s) => s.text);
    expect(texts).toContain('Plain ');
    expect(texts).toContain('Bold');
    expect(texts).toContain('Serif text');
    expect(texts).toContain('Price: \x805 \x93quoted\x94 \x96 done\x85 \x95 ok');

    const fonts = new Map<string, string>();
    const resources = e.pdf.dict(e.pdf.pages()[0]!.dict.get('Resources'));
    for (const [res, ref] of e.pdf.dict(resources.get('Font')).entries) fonts.set(res, name(e.pdf.dict(ref).get('BaseFont'))!);
    const fontOf = (text: string): string => fonts.get(shown.find((s) => s.text === text)!.font)!;
    expect(fontOf('Plain ')).toBe('Helvetica');
    expect(fontOf('Bold')).toBe('Helvetica-Bold');
    expect(fontOf('italic')).toBe('Helvetica-Oblique');
    expect(fontOf('Serif text')).toBe('Times-Roman');
    expect(fontOf(' code')).toBe('Courier-Bold');

    // Standard fonts carry the layout's widths, so the viewer places characters where the layout did.
    for (const [, d] of ofType(e, 'Subtype', 'Type1')) {
      expect(name(d.get('Encoding'))).toBe('WinAnsiEncoding');
      const widths = d.get('Widths') as number[];
      expect(widths.length).toBe(224);
      if (name(d.get('BaseFont')) === 'Helvetica') {
        expect(widths[65 - 32]).toBe(667); // A
        expect(widths[0x80 - 32]).toBeGreaterThan(0); // €
      }
      if (name(d.get('BaseFont'))?.startsWith('Courier')) expect(new Set(widths.filter((w) => w > 0))).toEqual(new Set([600]));
    }

    // Colour, decorations and character spacing.
    expect(e.contents[0]).toContain('1 0 0 rg');
    expect(e.contents[0]).toMatch(/2 Tc\n/);
    const rects = e.contents[0]!.match(/re\nf/g) ?? [];
    expect(rects.length).toBeGreaterThanOrEqual(2);
  });

  it('places runs at the layout positions, with the baseline flipped to PDF space', async () => {
    const b = new ContentBuilder();
    b.addText('First line').endParagraph();
    const doc = docOf(b.build());
    const e = await exported(doc);
    const first = shownStrings(e.contents[0]!).find((s) => s.text === 'First line')!;
    const s = doc.props.section;
    expect(first.x).toBeCloseTo(s.marginLeft, 3);
    const dl = new DocLayout(doc, { measurer: new MetricsMeasurer() });
    const item = pageDisplay(dl, dl.update()[0]!).find((d) => d.kind === 'text')!;
    expect(item.kind === 'text' && item.text).toBe('First line');
    expect(first.y).toBeCloseTo(s.pageHeight - (item.kind === 'text' ? item.baseline : 0), 3);
    expect(first.y).toBeLessThan(s.pageHeight - s.marginTop);
  });

  it('shows characters the standard fonts lack as ? when no font is provided', async () => {
    const b = new ContentBuilder();
    b.addText('Ωμέγα and 中文').endParagraph();
    const e = await exported(docOf(b.build()));
    expect(allText(e)).toContain('????? and ??');
    expect(ofType(e, 'Subtype', 'Type0')).toHaveLength(0);
  });

  it('embeds a subset of a provided TrueType font for the other characters', async () => {
    const font = buildTestFont();
    const asked: string[] = [];
    const b = new ContentBuilder();
    b.addText('Ω and 中 😀', { bold: true }).endParagraph();
    const e = await exported(docOf(b.build()), {
      fonts: async (family, bold, italic) => {
        asked.push(`${family}|${bold}|${italic}`);
        return family === 'fallback' ? font : null;
      },
    });
    expect(asked.slice(0, 2)).toEqual(['Arial|true|false', 'fallback|true|false']);

    const type0 = ofType(e, 'Subtype', 'Type0');
    expect(type0).toHaveLength(1);
    const t0 = type0[0]![1];
    expect(name(t0.get('Encoding'))).toBe('Identity-H');
    expect(name(t0.get('BaseFont'))).toMatch(/^[A-Z]{6}\+TestSans-Regular$/);
    const cid = e.pdf.dict((t0.get('DescendantFonts') as PdfValue[])[0]);
    expect(name(cid.get('Subtype'))).toBe('CIDFontType2');
    expect(name(cid.get('CIDToGIDMap'))).toBe('Identity');
    // CIDs 0 (.notdef), Ω, 中, 😀, then the composite's component: widths from hmtx.
    const w = cid.get('W') as PdfValue[];
    expect(w[0]).toBe(0);
    expect(w[1]).toEqual([500, 700, 300, 300, 300]);

    const descriptor = e.pdf.dict(cid.get('FontDescriptor'));
    expect(descriptor.get('Ascent')).toBe(800);
    expect(descriptor.get('Descent')).toBe(-200);
    expect(descriptor.get('CapHeight')).toBe(700);
    expect(descriptor.get('FontBBox')).toEqual([0, 0, 900, 700]);
    const file = descriptor.get('FontFile2') as PdfRef;
    const subset = parseTrueType(await e.pdf.streamOf(file.n))!;
    expect(subset).not.toBeNull();
    expect(subset.numGlyphs).toBe(5);
    expect(subset.glyphIndex(0x3a9)).toBe(1);
    expect(subset.glyphIndex(0x4e2d)).toBe(2);
    expect(subset.glyphIndex(0x1f600)).toBe(3);
    expect(subset.glyphIndex(0x416)).toBe(0); // Ж was never used
    expect(glyphComponents(subset.glyphData(2)).map((c) => c.gid)).toEqual([4, 1]);

    const toUnicode = fromLatin1(await e.pdf.streamOf((t0.get('ToUnicode') as PdfRef).n));
    expect(toUnicode).toContain('<0001> <03A9>');
    expect(toUnicode).toContain('<0002> <4E2D>');
    expect(toUnicode).toContain('<0003> <D83DDE00>');

    // The CID runs are hex strings in the embedded font; the Latin between them stays in Helvetica.
    const shown = shownStrings(e.contents[0]!);
    const cidRuns = shown.filter((s) => s.font === 'E1').map((s) => s.text);
    expect(cidRuns).toEqual(['\0\x01', '\0\x02', '\0\x03']);
    expect(shown.some((s) => s.text === ' and ')).toBe(true);
  });
});

// ---------------------------------------------------------------- links, tables, lists, outlines

describe('exportPdf: links, tables, lists, bookmarks', () => {
  it('adds URI link annotations for web, mail and phone links only', async () => {
    const b = new ContentBuilder();
    b.addText('Visit ').addText('our site', { link: 'https://weldsuite.org/a b' }).addText(' or ');
    b.addText('mail', { link: 'mailto:hi@weldsuite.org' }).addText(' ').addText('bad', { link: 'javascript:alert(1)' });
    b.addText(' ').addText('inside', { link: '#heading:x' }).endParagraph();
    const e = await exported(docOf(b.build()));
    const annots = e.pdf.pages()[0]!.dict.get('Annots') as PdfValue[];
    expect(annots).toHaveLength(2);
    const uris = annots.map((a) => {
      const d = e.pdf.dict(a);
      expect(name(d.get('Subtype'))).toBe('Link');
      expect((d.get('Rect') as number[]).length).toBe(4);
      return (e.pdf.dict(d.get('A')).get('URI') as PdfString).bytes;
    });
    expect(uris).toEqual(['https://weldsuite.org/a%20b', 'mailto:hi@weldsuite.org']);
  });

  it('turns a link to a bookmark into a jump to its page', async () => {
    const b = new ContentBuilder();
    b.addText('Go to the end', { link: '#end' }).endParagraph();
    b.addObject({ kind: 'pageBreak' }).endParagraph();
    b.addText('The end').endParagraph();
    const doc = docOf(b.build());
    const at = doc.body.text().indexOf('The end');
    applyOp(doc, { type: 'patchAnchors', set: [{ id: 'end', kind: 'bookmark', story: BODY, from: at, to: at + 7 }] });
    const e = await exported(doc);
    const annots = e.pdf.pages()[0]!.dict.get('Annots') as PdfValue[];
    expect(annots).toHaveLength(1);
    const action = e.pdf.dict(e.pdf.dict(annots[0]!).get('A'));
    expect(name(action.get('S'))).toBe('GoTo');
    const target = (action.get('D') as PdfValue[])[0] as PdfRef;
    expect(target.n).toBe(e.pdf.pages()[1]!.n);
  });

  it('draws tables with their cell text and borders', async () => {
    const cell = (text: string): { content: Content } => ({ content: new ContentBuilder().addText(text).endParagraph().build() });
    const b = new ContentBuilder();
    b.addText('Before').endParagraph();
    b.addTable([
      [cell('A1'), cell('B1')],
      [cell('A2'), cell('B2')],
    ]);
    b.endParagraph();
    const e = await exported(docOf(b.build()));
    const texts = shownStrings(e.contents[0]!).map((s) => s.text);
    for (const t of ['A1', 'B1', 'A2', 'B2']) expect(texts).toContain(t);
    // 2×2 cells, four borders each.
    expect((e.contents[0]!.match(/ l S\n/g) ?? []).length).toBeGreaterThanOrEqual(16);
    expect(e.contents[0]).toContain('0.75 w 2 J [] 0 d');
  });

  it('draws list markers: numbers as text, bullets as shapes, checkboxes as boxes', async () => {
    const b = new ContentBuilder();
    b.addText('One').endParagraph({ list: { id: 'numbered', level: 0 } });
    b.addText('Two').endParagraph({ list: { id: 'numbered', level: 0 } });
    b.addText('Dot').endParagraph({ list: { id: 'bullet', level: 0 } });
    b.addText('Ring').endParagraph({ list: { id: 'bullet', level: 1 } });
    b.addText('Done').endParagraph({ list: { id: 'check', level: 0 }, checked: true });
    const e = await exported(docOf(b.build()));
    const texts = shownStrings(e.contents[0]!).map((s) => s.text);
    expect(texts).toContain('1.');
    expect(texts).toContain('2.');
    expect(texts.join('')).not.toContain('?');
    // Filled and stroked circles (Bézier paths), and a ticked box.
    expect(e.contents[0]).toMatch(/ c h\n[^\n]* rg\nf\n/);
    expect(e.contents[0]).toMatch(/ c h\n[^\n]* RG\n[^\n]* w \[\] 0 d s\n/);
    expect(e.contents[0]).toMatch(/ l S\n0 j/);
  });

  it('turns headings into nested bookmarks pointing at their page', async () => {
    const b = new ContentBuilder();
    b.addText('Chapter one').endParagraph({ style: 'heading1' });
    b.addText('Section a').endParagraph({ style: 'heading2' });
    b.addText(LOREM).endParagraph();
    b.addText('Chapter two').endParagraph({ style: 'heading1', pageBreakBefore: true });
    const e = await exported(docOf(b.build()));
    const root = e.pdf.dict(e.pdf.trailer.get('Root'));
    expect(name(root.get('PageMode'))).toBe('UseOutlines');
    const outlines = e.pdf.dict(root.get('Outlines'));
    expect(outlines.get('Count')).toBe(3);
    const first = e.pdf.dict(outlines.get('First'));
    expect((first.get('Title') as PdfString).bytes).toBe('Chapter one');
    expect((e.pdf.dict(first.get('First')).get('Title') as PdfString).bytes).toBe('Section a');
    const second = e.pdf.dict(first.get('Next'));
    expect((second.get('Title') as PdfString).bytes).toBe('Chapter two');
    const pages = e.pdf.pages();
    expect(((first.get('Dest') as PdfValue[])[0] as PdfRef).n).toBe(pages[0]!.n);
    expect(((second.get('Dest') as PdfValue[])[0] as PdfRef).n).toBe(pages[1]!.n);
  });
});

// ---------------------------------------------------------------- images

describe('exportPdf: images', () => {
  const image = (id: string, src: string, width = 40, height = 20, extra: Partial<ImageObject> = {}): ImageObject => ({ kind: 'image', id, src, width, height, ...extra });

  it('embeds PNGs (with a soft mask for alpha) and JPEGs, and draws a placeholder for the rest', async () => {
    const png = await makePng({
      width: 2,
      height: 2,
      colorType: 6,
      bitDepth: 8,
      rows: [new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128]), new Uint8Array([0, 0, 255, 0, 255, 255, 255, 255])],
      filters: [1, 4],
    });
    const jpeg = makeJpeg(3, 5, 3);
    const b = new ContentBuilder();
    b.addObject(image('i1', 'file:png')).addText(' ').addObject(image('i2', 'file:jpeg', 30, 50, { crop: { top: 0.1, right: 0, bottom: 0.1, left: 0.2 } }));
    b.addText(' ').addObject(image('i3', 'file:missing')).endParagraph();
    const e = await exported(docOf(b.build()), {
      images: async (src) => (src === 'file:png' ? { bytes: png, mime: 'image/png' } : src === 'file:jpeg' ? { bytes: jpeg, mime: 'image/jpeg' } : null),
    });
    const images = ofType(e, 'Subtype', 'Image');
    const pngObj = images.find(([, d]) => d.get('SMask') !== undefined)!;
    expect(pngObj[1].get('Width')).toBe(2);
    expect(pngObj[1].get('Height')).toBe(2);
    expect(name(pngObj[1].get('ColorSpace'))).toBe('DeviceRGB');
    expect([...(await e.pdf.streamOf(pngObj[0]))]).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const mask = (pngObj[1].get('SMask') as PdfRef).n;
    expect([...(await e.pdf.streamOf(mask))]).toEqual([255, 128, 0, 255]);

    const jpegObj = images.find(([, d]) => name(d.get('Filter')) === 'DCTDecode')!;
    expect(jpegObj[1].get('Width')).toBe(3);
    expect(jpegObj[1].get('Height')).toBe(5);
    expect(name(jpegObj[1].get('ColorSpace'))).toBe('DeviceRGB');
    expect([...(await e.pdf.streamOf(jpegObj[0]))]).toEqual([...jpeg]);

    const content = e.contents[0]!;
    expect(content).toMatch(/\/Im1 Do/);
    expect(content).toMatch(/\/Im2 Do/);
    // The cropped JPEG is clipped to its box.
    expect(content).toMatch(/re\nW n\n[^\n]* cm \/Im2 Do/);
    expect(content).toContain('0.91 0.91 0.91 rg');
    const xobjects = e.pdf.dict(e.pdf.dict(e.pdf.pages()[0]!.dict.get('Resources')).get('XObject'));
    expect([...xobjects.entries.keys()].sort()).toEqual(['Im1', 'Im2']);
  });

  it('reads data: URLs without a fetcher, and marks Adobe CMYK JPEGs inverted', async () => {
    const jpeg = makeJpeg(4, 4, 4, true);
    let bin = '';
    for (const byte of jpeg) bin += String.fromCharCode(byte);
    const b = new ContentBuilder();
    b.addObject(image('i1', `data:image/jpeg;base64,${btoa(bin)}`)).endParagraph();
    const e = await exported(docOf(b.build()));
    const [[, d]] = ofType(e, 'Subtype', 'Image') as [[number, PdfDict]];
    expect(name(d.get('ColorSpace'))).toBe('DeviceCMYK');
    expect(d.get('Decode')).toEqual([1, 0, 1, 0, 1, 0, 1, 0]);
  });
});

// ---------------------------------------------------------------- decoders

describe('PNG decoding', () => {
  it('reverses every filter type', async () => {
    const rows = [0, 1, 2, 3, 4].map((f) => new Uint8Array([10 + f, 20, 30, 200 - f, 100, 50 + f * 10]));
    const png = await makePng({ width: 2, height: 5, colorType: 2, bitDepth: 8, rows, filters: [0, 1, 2, 3, 4] });
    const img = (await decodePng(png))!;
    expect(img.colors).toBe(3);
    expect(img.alpha).toBeNull();
    expect([...img.pixels]).toEqual(rows.flatMap((r) => [...r]));
  });

  it('expands 2-bit palettes with tRNS transparency', async () => {
    const palette = new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
    // Indices 0, 1, 2, 1 packed two bits each.
    const row = new Uint8Array([0b00011001]);
    const png = await makePng({ width: 4, height: 1, colorType: 3, bitDepth: 2, rows: [row], palette, trns: new Uint8Array([0]) });
    const img = (await decodePng(png))!;
    expect([...img.pixels]).toEqual([0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 0, 0]);
    expect([...img.alpha!]).toEqual([0, 255, 255, 255]);
  });

  it('reduces 16-bit grey to 8 bits and honours a grey colour key', async () => {
    const row = new Uint8Array([0x12, 0x34, 0xff, 0xff, 0x00, 0x00]);
    const png = await makePng({ width: 3, height: 1, colorType: 0, bitDepth: 16, rows: [row], trns: new Uint8Array([0xff, 0xff]) });
    const img = (await decodePng(png))!;
    expect(img.colors).toBe(1);
    expect([...img.pixels]).toEqual([0x12, 0xff, 0x00]);
    expect([...img.alpha!]).toEqual([255, 0, 255]);
  });

  it('scales 1-bit grey and decodes Adam7 interlacing', async () => {
    // 3×3 grey, 8-bit, interlaced: pass 1 has (0,0); pass 4 (2,0); pass 5 (0,2),(2,2); pass 6 (1,0),(1,2); pass 7 row 1.
    const v = (x: number, y: number): number => y * 3 + x + 1;
    const rows = [
      new Uint8Array([v(0, 0)]),
      new Uint8Array([v(2, 0)]),
      new Uint8Array([v(0, 2), v(2, 2)]),
      new Uint8Array([v(1, 0)]),
      new Uint8Array([v(1, 2)]),
      new Uint8Array([v(0, 1), v(1, 1), v(2, 1)]),
    ];
    const png = await makePng({ width: 3, height: 3, colorType: 0, bitDepth: 8, rows, interlace: true });
    const img = (await decodePng(png))!;
    expect([...img.pixels]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const bits = await makePng({ width: 3, height: 1, colorType: 0, bitDepth: 1, rows: [new Uint8Array([0b10100000])] });
    expect([...(await decodePng(bits))!.pixels]).toEqual([255, 0, 255]);
  });

  it('refuses broken or unknown data', async () => {
    expect(await decodePng(new Uint8Array([1, 2, 3]))).toBeNull();
    const good = await makePng({ width: 1, height: 1, colorType: 0, bitDepth: 8, rows: [new Uint8Array([5])] });
    expect(await decodePng(good.subarray(0, 40))).toBeNull();
    expect(await readImage(new TextEncoder().encode('GIF89a....'))).toBeNull();
  });
});

describe('JPEG frame header', () => {
  it('reads size and components', () => {
    expect(parseJpeg(makeJpeg(640, 480, 3))).toEqual({ width: 640, height: 480, components: 3, bitsPerComponent: 8, adobe: false });
    expect(parseJpeg(makeJpeg(1, 2, 1))?.components).toBe(1);
    expect(parseJpeg(makeJpeg(8, 8, 4, true))?.adobe).toBe(true);
    expect(parseJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});

// ---------------------------------------------------------------- TrueType

describe('TrueType parsing and subsetting', () => {
  it('reads metrics, both cmap formats and composite glyphs', () => {
    const font = parseTrueType(buildTestFont())!;
    expect(font.unitsPerEm).toBe(1000);
    expect(font.numGlyphs).toBe(7);
    expect(font.postScriptName).toBe('TestSans-Regular');
    expect(font.capHeight).toBe(700);
    expect(font.glyphIndex(0x20)).toBe(GLYPHS.space);
    expect(font.glyphIndex(0x416)).toBe(GLYPHS.zhe);
    expect(font.glyphIndex(0x1f600)).toBe(GLYPHS.smile);
    expect(font.glyphIndex(0x41)).toBe(0);
    expect(font.advance(GLYPHS.omega)).toBe(ADVANCES[GLYPHS.omega]);
    // Glyphs past numberOfHMetrics repeat the last advance.
    expect(font.advance(GLYPHS.smile)).toBe(ADVANCES[ADVANCES.length - 1]);
    expect(glyphComponents(font.glyphData(GLYPHS.zhong)).map((c) => c.gid)).toEqual([GLYPHS.part, GLYPHS.omega]);

    // Format 4 alone (the glyph id array path included); no emoji there.
    const f4 = parseTrueType(buildTestFont({ format12: false }))!;
    expect(f4.glyphIndex(0x416)).toBe(GLYPHS.zhe);
    expect(f4.glyphIndex(0x4e2d)).toBe(GLYPHS.zhong);
    expect(f4.glyphIndex(0x1f600)).toBe(0);
  });

  it('refuses CFF fonts and garbage', () => {
    expect(parseTrueType(new TextEncoder().encode('OTTO\0\0\0\0\0\0\0\0'))).toBeNull();
    expect(parseTrueType(new Uint8Array(8))).toBeNull();
  });

  it('writes a valid subset with renumbered glyphs, composites remapped and correct checksums', () => {
    const source = parseTrueType(buildTestFont())!;
    const subset = new FontSubset(source);
    expect(subset.use(0x4e2d)).toBe(1);
    expect(subset.use(0x416)).toBe(2);
    expect(subset.use(0x41)).toBeNull();
    const bytes = subset.build();
    const out = parseTrueType(bytes)!;
    // .notdef, 中, Ж, then 中's components part and Ω.
    expect(out.numGlyphs).toBe(5);
    expect(out.glyphIndex(0x4e2d)).toBe(1);
    expect(out.glyphIndex(0x416)).toBe(2);
    expect(out.glyphIndex(0x3a9)).toBe(0);
    expect(glyphComponents(out.glyphData(1)).map((c) => c.gid)).toEqual([3, 4]);
    const original = testGlyphData();
    const same = (gid: number, newGid: number): void => {
      const a = original[gid]!;
      expect([...out.glyphData(newGid).subarray(0, a.length)]).toEqual([...a]);
    };
    same(GLYPHS.zhe, 2);
    same(GLYPHS.part, 3);
    same(GLYPHS.omega, 4);
    same(GLYPHS.notdef, 0);
    expect([0, 1, 2, 3, 4].map((g) => out.advance(g))).toEqual([500, 300, 650, 300, 700]);

    // Directory checksums match the tables, and the whole font sums to the magic number.
    const r = new ByteReader(bytes);
    const numTables = r.u16(4);
    const tags: string[] = [];
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      const tag = r.tag(rec);
      tags.push(tag);
      const data = r.slice(r.u32(rec + 8), r.u32(rec + 8) + r.u32(rec + 12));
      if (tag !== 'head') expect(tableChecksum(data)).toBe(r.u32(rec + 4));
      expect(r.u32(rec + 8) % 4).toBe(0);
    }
    expect(tags).toEqual([...tags].sort());
    for (const t of ['OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post']) expect(tags).toContain(t);
    expect(tableChecksum(bytes)).toBe(0xb1b0afba);
  });
});

describe('WinAnsi', () => {
  it('maps the Windows-1252 punctuation and Latin-1, and nothing else', () => {
    expect(winAnsiCode('€'.codePointAt(0)!)).toBe(0x80);
    expect(winAnsiCode('‘'.codePointAt(0)!)).toBe(0x91);
    expect(winAnsiCode('’'.codePointAt(0)!)).toBe(0x92);
    expect(winAnsiCode('“'.codePointAt(0)!)).toBe(0x93);
    expect(winAnsiCode('”'.codePointAt(0)!)).toBe(0x94);
    expect(winAnsiCode('•'.codePointAt(0)!)).toBe(0x95);
    expect(winAnsiCode('–'.codePointAt(0)!)).toBe(0x96);
    expect(winAnsiCode('—'.codePointAt(0)!)).toBe(0x97);
    expect(winAnsiCode('…'.codePointAt(0)!)).toBe(0x85);
    expect(winAnsiCode('é'.codePointAt(0)!)).toBe(0xe9);
    expect(winAnsiCode('A'.codePointAt(0)!)).toBe(0x41);
    expect(winAnsiCode(0x81)).toBeNull();
    expect(winAnsiCode('Ω'.codePointAt(0)!)).toBeNull();
  });
});
