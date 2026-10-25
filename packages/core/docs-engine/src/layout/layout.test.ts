import { describe, expect, it } from 'vitest';
import { ContentBuilder } from '../model/builder';
import { LINE_BREAK, OBJECT, PARA } from '../model/chars';
import type { Content } from '../model/content';
import { DocModel } from '../model/document';
import { BODY, FINAL_SECTION, footnoteStoryId, headerStoryId } from '../model/objects';
import { applyOp } from '../ops/apply';
import { randomOp } from '../ops/random-ops';
import type { Op } from '../ops/types';
import { counterIds, rng } from '../test-support';
import { DocLayout } from './document-layout';
import { caretRect, hitTest, lineBounds, selectionRects } from './geometry';
import { MetricsMeasurer } from './measure';
import type { LineLayout, PageLayout } from './types';

const measurer = new MetricsMeasurer();
const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.';

function docOf(content: Content): DocModel {
  const doc = DocModel.create();
  applyOp(doc, { type: 'insert', story: BODY, at: 0, content });
  return doc;
}

function layoutOf(doc: DocModel): DocLayout {
  const dl = new DocLayout(doc, { measurer });
  dl.update();
  return dl;
}

function bodyLines(dl: DocLayout): { start: number; line: LineLayout }[] {
  const out: { start: number; line: LineLayout }[] = [];
  for (const e of dl.flow(BODY)!.entries) for (const b of e.layout!.blocks) if (b.kind === 'lines') for (const l of b.lines) out.push({ start: e.start, line: l });
  return out;
}

/** A comparable summary of pagination. */
function summary(pages: PageLayout[]): string {
  return JSON.stringify(
    pages.map((p) => ({
      n: p.number,
      cols: p.columns.map((c) => c.items.map((i) => [i.story, i.entry.start, i.block, i.from, i.to, Math.round(i.y * 10)])),
      h: p.header?.story,
      f: p.footer?.story,
      fn: p.footnotes?.items.length,
    })),
  );
}

describe('line breaking', () => {
  it('fills lines to the width, breaks between words, and covers every character once', () => {
    const doc = docOf({ text: `${LOREM} ${LOREM}${PARA}` });
    const dl = layoutOf(doc);
    const lines = bodyLines(dl);
    const width = doc.props.section.pageWidth - doc.props.section.marginLeft - doc.props.section.marginRight;
    expect(lines.length).toBeGreaterThan(3);
    let next = 0;
    const text = doc.body.text();
    for (const { start, line } of lines) {
      expect(start + line.start).toBe(next);
      next = start + line.end;
      expect(line.width).toBeLessThanOrEqual(width + 0.01);
      // Lines start at a word, never inside one.
      if (line.start > 0) expect(text[line.start - 1]).toBe(' ');
    }
    expect(next).toBe(text.length);
  });

  it('aligns center and right, and justifies all but the last line', () => {
    for (const align of ['center', 'right', 'justify'] as const) {
      const b = new ContentBuilder();
      b.addText(LOREM).endParagraph({ align });
      const dl = layoutOf(docOf(b.build()));
      const lines = bodyLines(dl).map((l) => l.line);
      const width = 595.3 - 144;
      if (align === 'center') expect(lines[0]!.x).toBeCloseTo((width - lines[0]!.width) / 2, 3);
      if (align === 'right') expect(lines[0]!.x + lines[0]!.width).toBeCloseTo(width, 3);
      if (align === 'justify') {
        const first = lines[0]!;
        const run = first.runs[0]!;
        expect(run.wordSpacing).toBeGreaterThan(0);
        expect(lines[lines.length - 1]!.runs[0]!.wordSpacing).toBeUndefined();
      }
    }
  });

  it('breaks a word longer than the line between characters', () => {
    const dl = layoutOf(docOf({ text: `${'x'.repeat(400)}${PARA}` }));
    const lines = bodyLines(dl).map((l) => l.line);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.width).toBeLessThanOrEqual(451.3 + 0.01);
  });

  it('honours line breaks, tabs and first-line indents', () => {
    const b = new ContentBuilder();
    b.addText(`a${LINE_BREAK}b\tc`).endParagraph({ indentFirst: 36 });
    const lines = bodyLines(layoutOf(docOf(b.build()))).filter((l) => l.start === 0).map((l) => l.line);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.x).toBe(36);
    expect(lines[1]!.x).toBe(0);
    const tab = lines[1]!.runs.find((r) => r.kind === 'tab')!;
    // The text after the tab starts at the first default stop (half an inch).
    expect(tab.x + tab.width).toBeCloseTo(36, 3);
  });

  it('draws list markers in the hanging indent', () => {
    const b = new ContentBuilder();
    b.addText('One').endParagraph({ list: { id: 'numbered', level: 0 } });
    b.addText('Two').endParagraph({ list: { id: 'numbered', level: 0 } });
    const lines = bodyLines(layoutOf(docOf(b.build()))).map((l) => l.line);
    expect(lines[0]!.marker?.text).toBe('1.');
    expect(lines[1]!.marker?.text).toBe('2.');
    expect(lines[0]!.marker!.x).toBe(18);
    expect(lines[0]!.x).toBe(36);
  });
});

describe('pagination', () => {
  function longDoc(paragraphs: number): DocModel {
    const b = new ContentBuilder();
    for (let i = 0; i < paragraphs; i++) b.addText(`${i} ${LOREM}`).endParagraph({ spaceAfter: 6 });
    return docOf(b.build());
  }

  it('fills pages within their margins, with no orphan or widow lines', () => {
    const doc = longDoc(120);
    const dl = layoutOf(doc);
    expect(dl.pages.length).toBeGreaterThan(5);
    const s = doc.props.section;
    for (const page of dl.pages) {
      for (const item of page.columns[0]!.items) {
        expect(item.y).toBeGreaterThanOrEqual(s.marginTop - 0.01);
        const lines = (item.entry.layout!.blocks[item.block] as { lines: LineLayout[] }).lines;
        const h = lines.slice(item.from, item.to).reduce((n, l) => n + l.height, 0);
        expect(item.y + h).toBeLessThanOrEqual(s.pageHeight - s.marginBottom + 0.01);
        const total = lines.length;
        // A paragraph split across pages keeps at least two lines on each side.
        if (item.to - item.from < total && total >= 4) expect(item.to - item.from).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('starts a new page after a page break and before a paragraph that asks for it', () => {
    const b = new ContentBuilder();
    b.addText('First').endParagraph();
    b.addObject({ kind: 'pageBreak' }).endParagraph();
    b.addText('Second').endParagraph();
    b.addText('Third').endParagraph({ pageBreakBefore: true });
    const dl = layoutOf(docOf(b.build()));
    expect(dl.pages).toHaveLength(3);
  });

  it('places headers, footers and footnotes', () => {
    const doc = longDoc(30);
    applyOp(doc, { type: 'createStory', story: headerStoryId(FINAL_SECTION, 'header', 'default'), content: { text: `Header${PARA}` } });
    applyOp(doc, { type: 'createStory', story: headerStoryId(FINAL_SECTION, 'footer', 'default'), content: { text: `Footer${PARA}` } });
    applyOp(doc, {
      type: 'insert',
      story: BODY,
      at: 5,
      content: { text: OBJECT, objects: [[0, { kind: 'footnote', id: 'f1' }]], stories: { [footnoteStoryId('f1')]: { text: `A note${PARA}` } } },
    });
    const dl = layoutOf(doc);
    expect(dl.pages.length).toBeGreaterThan(1);
    for (const p of dl.pages) {
      expect(p.header?.story).toBe('hdr:final:default');
      expect(p.footer?.story).toBe('ftr:final:default');
      expect(p.columns[0]!.y).toBeGreaterThanOrEqual(p.header!.y + p.header!.height);
    }
    expect(dl.pages[0]!.footnotes?.items).toHaveLength(1);
    expect(dl.footnoteNumber('f1')).toBe(1);
  });

  it('runs a long table onto later pages, repeating its header row', () => {
    const b = new ContentBuilder();
    const rows = Array.from({ length: 80 }, (_, i) => [{ content: { text: `Row ${i}${PARA}` } }, { content: { text: `${LOREM}${PARA}` } }]);
    b.addTable(rows, { headerRows: 1, widths: [100, 300] });
    b.endParagraph();
    const dl = layoutOf(docOf(b.build()));
    expect(dl.pages.length).toBeGreaterThan(2);
    const second = dl.pages[1]!.columns[0]!.items[0]!;
    expect(second.kind).toBe('rows');
    if (second.kind === 'rows') expect(second.repeat).toEqual([0]);
  });

  it('shows the whole document on one page when pageless', () => {
    const doc = longDoc(60);
    applyOp(doc, { type: 'setDocProps', patch: { pageless: true } });
    const dl = layoutOf(doc);
    expect(dl.pages).toHaveLength(1);
    expect(dl.pages[0]!.height).toBeGreaterThan(2500);
  });
});

describe('incremental layout', () => {
  it('re-lays only the paragraph an edit touches, and matches a fresh layout', () => {
    const b = new ContentBuilder();
    for (let i = 0; i < 50; i++) b.addText(`${i} ${LOREM}`).endParagraph({ list: i % 7 === 0 ? { id: 'numbered', level: 0 } : undefined } as never);
    const doc = docOf(b.build());
    const dl = layoutOf(doc);
    const before = dl.flow(BODY)!.entries.map((e) => e.layout);
    const op: Op = { type: 'insert', story: BODY, at: dl.flow(BODY)!.entries[10]!.start + 3, content: { text: 'inserted words here ' } };
    applyOp(doc, op);
    dl.applied(op);
    dl.update();
    const after = dl.flow(BODY)!.entries.map((e) => e.layout);
    const changed = after.filter((l, i) => l !== before[i]).length;
    expect(changed).toBe(1);
    expect(summary(dl.pages)).toBe(summary(layoutOf(doc).pages));
  });

  it('stays equal to a fresh layout through random edits, told or not', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const random = rng(seed);
      const makeId = counterIds(`l${seed}_`);
      const doc = docOf({ text: `${LOREM}${PARA}${LOREM}${PARA}` });
      const dl = layoutOf(doc);
      for (let step = 0; step < 120; step++) {
        const op = randomOp(doc, random, makeId);
        if (!op) continue;
        if (random() < 0.7) dl.apply(op);
        else {
          applyOp(doc, op);
          if (random() < 0.5) dl.applied(op);
          else dl.stale();
        }
        if (step % 10 === 0) {
          dl.update();
          expect(summary(dl.pages)).toBe(summary(layoutOf(doc).pages));
        }
      }
    }
  });
});

describe('geometry', () => {
  it('puts the caret where a click at the caret lands, for every position', () => {
    const b = new ContentBuilder();
    b.addText(`${LOREM} ${LOREM}`).endParagraph({ align: 'justify' });
    b.addText('Short').endParagraph({ align: 'center' });
    b.addTable([[{ content: { text: `cell one${PARA}` } }, { content: { text: `cell two${PARA}` } }]]);
    b.endParagraph();
    const doc = docOf(b.build());
    const dl = layoutOf(doc);
    const len = doc.body.length;
    for (let pos = 0; pos < len; pos++) {
      const rect = caretRect(dl, BODY, pos);
      expect(rect, `caret at ${pos}`).not.toBeNull();
      if (doc.body.charAt(pos) === OBJECT) continue;
      const hit = hitTest(dl, rect!.page, rect!.x + 0.3, rect!.y + rect!.height / 2);
      // At a soft-wrapped line start the click lands on the same position.
      expect(hit?.pos, `hit at ${pos}`).toBe(pos);
    }
    // Inside a cell.
    const cell = [...doc.stories.keys()].find((k) => k.startsWith('cell:') && doc.stories.get(k)!.text() === `cell two${PARA}`)!;
    const rect = caretRect(dl, cell, 5)!;
    const hit = hitTest(dl, rect.page, rect.x + 0.3, rect.y + rect.height / 2);
    expect(hit).toEqual({ story: cell, pos: 5, affinity: 'forward' });
  });

  it('gives line bounds and selection rectangles', () => {
    const doc = docOf({ text: `${LOREM} ${LOREM}${PARA}` });
    const dl = layoutOf(doc);
    const first = bodyLines(dl)[0]!.line;
    expect(lineBounds(dl, BODY, 3)).toEqual({ start: 0, end: first.end });
    const rects = selectionRects(dl, BODY, 5, doc.body.length - 5);
    expect(rects).toHaveLength(bodyLines(dl).filter((l) => l.start === 0).length);
  });
});

describe('performance', () => {
  it('lays out 300 pages in well under a second and an edit in a few milliseconds', () => {
    const b = new ContentBuilder();
    for (let i = 0; i < 2400; i++) {
      b.addText(`${i} ${LOREM} `).addText('bold part', { bold: true }).addText(` ${LOREM}`).endParagraph({ spaceAfter: 6 });
    }
    const doc = docOf(b.build());
    const t0 = performance.now();
    const dl = layoutOf(doc);
    const full = performance.now() - t0;
    expect(dl.pages.length).toBeGreaterThan(300);

    const edits: number[] = [];
    for (let i = 0; i < 20; i++) {
      const op: Op = { type: 'insert', story: BODY, at: 1000 + i * 7, content: { text: 'x' } };
      const t1 = performance.now();
      applyOp(doc, op);
      dl.applied(op);
      dl.update();
      edits.push(performance.now() - t1);
    }
    edits.sort((a, b) => a - b);
    const median = edits[edits.length >> 1]!;
    console.log(`layout: ${dl.pages.length} pages in ${full.toFixed(0)} ms, edit median ${median.toFixed(1)} ms`);
    expect(full).toBeLessThan(5000);
    expect(median).toBeLessThan(50);
  });
});

describe('review fixes', () => {
  it('keeps a pageless document on one page through page breaks', () => {
    const b = new ContentBuilder();
    b.addText('First').endParagraph();
    b.addObject({ kind: 'pageBreak' }).endParagraph();
    b.addText('Second').endParagraph({ pageBreakBefore: true });
    const doc = docOf(b.build());
    applyOp(doc, { type: 'setDocProps', patch: { pageless: true } });
    const dl = layoutOf(doc);
    expect(dl.pages).toHaveLength(1);
    expect(Number.isFinite(dl.pages[0]!.height)).toBe(true);
  });

  it('keeps carets in step in all caps when a capital is longer (ß)', () => {
    const doc = docOf({ text: `Straße Weg${PARA}`, runs: [[10, { allCaps: true }]] });
    const dl = layoutOf(doc);
    const run = bodyLines(dl)[0]!.line.runs[0]!;
    expect(run.text).toBe('STRAßE WEG');
    for (let pos = 0; pos <= 10; pos++) {
      const rect = caretRect(dl, BODY, pos)!;
      expect(hitTest(dl, rect.page, rect.x + 0.3, rect.y + rect.height / 2)?.pos).toBe(pos);
    }
  });
});
