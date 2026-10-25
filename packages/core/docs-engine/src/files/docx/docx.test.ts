import { describe, expect, it } from 'vitest';
import { openZip, parseXml, writeZip } from '@weldsuite/zip-xml';
import { ContentBuilder, type TableCellInput } from '../../model/builder';
import { LINE_BREAK, PARA, TAB } from '../../model/chars';
import type { Content, StoryContent } from '../../model/content';
import { BUILT_IN_STYLES, bulletList, checkList, numberedList } from '../../model/defaults';
import { DocModel, type DocSnapshot } from '../../model/document';
import { BODY, DEFAULT_SECTION, footnoteStoryId, type ObjectData, type SectionBreakObject } from '../../model/objects';
import { toBlocks, type Block, type Inline } from '../../serialize/blocks';
import { caretAt } from '../../editing/commands';
import { suggestionRanges, threadsOf } from '../../editing/review';
import { insertToc } from '../../editing/toc';
import { applyOp } from '../../ops/apply';
import { isWellFormedOp } from '../../ops/shape';
import { counterIds } from '../../test-support';
import { DocxImportError, readDocx, writeDocx } from './index';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const DATE = new Date(Date.UTC(2026, 9, 25, 12));

// ---------------------------------------------------------------- helpers

function inlineText(inlines: Inline[]): string {
  return inlines
    .map((i) => (i.type === 'text' ? i.text : i.type === 'tab' ? '→' : i.type === 'break' ? '↵' : i.type === 'object' ? `[${i.data.kind}]` : ''))
    .join('');
}

/** A story's structure without ids: paragraph text, style and list; table shape, spans and header rows. */
function shape(snapshot: DocSnapshot, storyId: string): unknown[] {
  const story = snapshot.stories[storyId];
  if (!story) return [];
  return toBlocks({ ...story, tables: snapshot.tables, stories: snapshot.stories }).blocks.map(blockShape);
}

function blockShape(b: Block): unknown {
  if (b.type === 'paragraph') {
    const out: Record<string, unknown> = { text: inlineText(b.inlines), style: b.props.style ?? 'normal' };
    if (b.props.list) out.list = `${b.props.list.id}:${b.props.list.level}${b.props.checked ? ':checked' : ''}`;
    return out;
  }
  return {
    widths: b.data.cols.map((c) => c.width),
    header: b.data.rows.map((r) => !!r.header),
    rows: b.rows.map((r) =>
      r.map((c) => (c.covered ? 'covered' : { span: `${c.props.colSpan ?? 1}x${c.props.rowSpan ?? 1}`, blocks: c.blocks.map(blockShape) })),
    ),
  };
}

function objectsOf(story: StoryContent | undefined, kind: ObjectData['kind']): ObjectData[] {
  return (story?.objects ?? []).map(([, o]) => o).filter((o) => o.kind === kind);
}

function cell(text: string, props?: TableCellInput['props']): TableCellInput {
  return { content: { text: `${text}${PARA}` }, ...(props ? { props } : {}) };
}

/** A document using most of what the engine has. */
function sampleDoc(): DocModel {
  const ids = counterIds('x');
  const b = new ContentBuilder(ids);
  b.addText('Quarterly report').endParagraph({ style: 'title' });
  b.addText('Introduction').endParagraph({ style: 'heading1' });
  b.addText('Plain ')
    .addText('bold', { bold: true })
    .addText(' and ')
    .addText('italic red', { italic: true, color: '#ff0000' })
    .addText(' with ')
    .addText('a link', { link: 'https://weldsuite.org/docs', color: '#1155cc', underline: true })
    .addText(', ')
    .addText('marked', { highlight: '#ffff00' })
    .addText(', ')
    .addText('shaded', { highlight: '#fce5cd', font: 'Georgia', size: 14 })
    .addText(' and x')
    .addText('2', { script: 'super' })
    .endParagraph({ align: 'justify', spaceAfter: 6, lineHeight: 1.5 });
  b.addText('Name').addText(TAB).addText('Value').endParagraph({ tabs: [{ pos: 144, align: 'right', leader: 'dot' }] });
  b.addText('One').endParagraph({ list: { id: 'numbered', level: 0 } });
  b.addText('One a').endParagraph({ list: { id: 'numbered', level: 1 } });
  b.addText('Two').endParagraph({ list: { id: 'numbered', level: 0 } });
  b.addText('Bullet').endParagraph({ list: { id: 'bullet', level: 0 } });
  b.addText('Deep bullet').endParagraph({ list: { id: 'bullet', level: 2 } });
  b.addText('To do').endParagraph({ list: { id: 'check', level: 0 } });
  b.addText('Done').endParagraph({ list: { id: 'check', level: 0 }, checked: true });
  b.addText('Line one').addText(LINE_BREAK).addText('line two with a note').addObject({ kind: 'footnote', id: 'fn1' }).endParagraph();
  b.addObject({ kind: 'pageBreak' }).endParagraph();
  b.addObject({ kind: 'hr' }).endParagraph();
  b.addText('Logo: ').addObject({ kind: 'image', id: 'img1', src: 'file:logo', width: 100, height: 50, alt: 'The logo' }).endParagraph();

  const nested = new ContentBuilder(ids);
  nested.addTable([[cell('n1'), cell('n2')]], { widths: [40, 40] });
  nested.endParagraph();
  b.addTable(
    [
      [cell('H1'), cell('H2'), cell('H3')],
      [cell('Wide', { colSpan: 2, background: '#eeeeee' }), cell(''), cell('Tall', { rowSpan: 2, vAlign: 'middle' })],
      [{ content: nested.build() }, cell('x'), cell('')],
    ],
    { widths: [100, 150, 200], headerRows: 1 },
  );
  b.endParagraph();
  const portrait: SectionBreakObject = { kind: 'sectionBreak', id: 's1', start: 'nextPage', section: { ...DEFAULT_SECTION } };
  b.addText('End of part one').addObject(portrait).endParagraph();
  b.addText('Landscape part').endParagraph({ style: 'heading2' });
  const body: Content = b.build();

  const { tables, stories, ...bodyStory } = body;
  const footer = new ContentBuilder(ids).addText('Page ').addObject({ kind: 'field', field: 'page' }).addText(' of ').addObject({ kind: 'field', field: 'pages' }).endParagraph().build();
  const base = DocModel.create().toSnapshot();
  const snapshot: DocSnapshot = {
    ...base,
    props: { section: { ...DEFAULT_SECTION, pageWidth: DEFAULT_SECTION.pageHeight, pageHeight: DEFAULT_SECTION.pageWidth, titlePage: true, pageNumberStart: 3 } },
    stories: {
      ...stories,
      [BODY]: bodyStory,
      [footnoteStoryId('fn1')]: { text: `A footnote.${PARA}` },
      'hdr:s1:default': { text: `First part header${PARA}` },
      'hdr:final:default': { text: `Landscape header${PARA}`, runs: [[9, { bold: true }]] },
      'hdr:final:first': { text: `Cover header${PARA}` },
      'ftr:final:default': footer as StoryContent,
    },
    tables: tables ?? {},
  };
  return DocModel.fromSnapshot(snapshot);
}

async function images(src: string) {
  return src === 'file:logo' ? { bytes: PNG, mime: 'image/png' } : null;
}

// ---------------------------------------------------------------- round trip

describe('docx round trip', () => {
  it('writes a package with the required parts, all well-formed XML', async () => {
    const bytes = await writeDocx(sampleDoc(), { title: 'Q3 report', images, date: DATE });
    const zip = openZip(bytes);
    for (const part of [
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/core.xml',
      'docProps/app.xml',
      'word/document.xml',
      'word/_rels/document.xml.rels',
      'word/styles.xml',
      'word/numbering.xml',
      'word/settings.xml',
      'word/footnotes.xml',
      'word/header1.xml',
      'word/footer1.xml',
      'word/media/image1.png',
    ]) {
      expect(zip.has(part), part).toBe(true);
    }
    for (const name of zip.names()) {
      if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
      const xml = (await zip.readText(name))!;
      expect(() => parseXml(xml), name).not.toThrow();
    }
    const doc = (await zip.readText('word/document.xml'))!;
    expect(doc).toContain('<w:vMerge w:val="restart"/>');
    expect(doc).toContain('<w:gridSpan w:val="2"/>');
    expect(doc).toContain('<w:tblHeader/>');
    expect(doc).toContain('w:orient="landscape"');
    expect(doc).toContain('<w:br w:type="page"/>');
    expect(doc).toContain('<w:footnoteReference w:id="1"/>');
    const settings = (await zip.readText('word/settings.xml'))!;
    expect(settings).toContain('<w:footnotePr>');
    expect(await zip.readText('docProps/core.xml')).toContain('<dc:title>Q3 report</dc:title>');
    expect(await zip.read('word/media/image1.png')).toEqual(PNG);
  });

  it('reads back what it wrote', async () => {
    const doc = sampleDoc();
    const original = doc.toSnapshot();
    const read = await readDocx(await writeDocx(doc, { title: 'Q3 report', images, date: DATE }), { makeId: counterIds('r') });
    const s = read.snapshot;
    expect(read.warnings).toEqual([]);
    expect(read.title).toBe('Q3 report');

    expect(shape(s, BODY)).toEqual(shape(original, BODY));

    // Formatting of runs and paragraphs.
    const blocks = toBlocks({ ...s.stories[BODY]!, tables: s.tables, stories: s.stories }).blocks;
    const para = blocks[2]!;
    expect(para.type === 'paragraph' && para.props).toEqual({ align: 'justify', spaceAfter: 6, lineHeight: 1.5 });
    const styles = para.type === 'paragraph' ? para.inlines.filter((i) => i.type === 'text').map((i) => i.style) : [];
    expect(styles).toEqual([
      {},
      { bold: true },
      {},
      { italic: true, color: '#ff0000' },
      {},
      { link: 'https://weldsuite.org/docs', color: '#1155cc', underline: true },
      {},
      { highlight: '#ffff00' },
      {},
      { highlight: '#fce5cd', font: 'Georgia', size: 14 },
      {},
      { script: 'super' },
    ]);
    const tabs = blocks[3]!;
    expect(tabs.type === 'paragraph' && tabs.props.tabs).toEqual([{ pos: 144, align: 'right', leader: 'dot' }]);

    // Named styles and lists come back as they were.
    for (const id of Object.keys(BUILT_IN_STYLES)) expect(s.styles[id], id).toEqual(BUILT_IN_STYLES[id]);
    expect(s.lists.bullet).toEqual(bulletList());
    expect(s.lists.numbered).toEqual(numberedList());
    expect(s.lists.check).toEqual(checkList());

    // The table: widths, header row, merges, a table in a cell.
    const table = Object.values(s.tables).find((t) => t.cols.length === 3)!;
    expect(table.cols.map((c) => c.width)).toEqual([100, 150, 200]);
    const spans = Object.values(table.cells ?? {}).map((c) => [c.colSpan ?? 1, c.rowSpan ?? 1, c.background, c.vAlign]);
    expect(spans).toEqual(
      expect.arrayContaining([
        [2, 1, '#eeeeee', undefined],
        [1, 2, undefined, 'middle'],
      ]),
    );
    expect(Object.values(s.tables).some((t) => t.cols.length === 2 && t.cols[0]!.width === 40)).toBe(true);

    // Footnote, image.
    const note = objectsOf(s.stories[BODY], 'footnote')[0];
    expect(note && note.kind === 'footnote' && s.stories[footnoteStoryId(note.id)]?.text).toBe(`A footnote.${PARA}`);
    const img = objectsOf(s.stories[BODY], 'image')[0];
    expect(img).toMatchObject({ kind: 'image', src: 'docx-image:image1.png', width: 100, height: 50, alt: 'The logo' });
    expect(read.images).toEqual([{ src: 'docx-image:image1.png', bytes: PNG, mime: 'image/png', name: 'image1.png' }]);

    // Sections: a portrait first part, the landscape last one with its headers and footer.
    const brk = objectsOf(s.stories[BODY], 'sectionBreak')[0] as SectionBreakObject;
    expect(brk.start).toBe('nextPage');
    expect(brk.section).toEqual(DEFAULT_SECTION);
    expect(s.props.section).toEqual(original.props.section);
    expect(s.stories[`hdr:${brk.id}:default`]?.text).toBe(`First part header${PARA}`);
    expect(s.stories['hdr:final:default']).toEqual({ text: `Landscape header${PARA}`, runs: [[9, { bold: true }]] });
    expect(s.stories['hdr:final:first']?.text).toBe(`Cover header${PARA}`);
    expect(shape(s, 'ftr:final:default')).toEqual([{ text: 'Page [field] of [field]', style: 'normal' }]);
    expect(objectsOf(s.stories['ftr:final:default'], 'field')).toEqual([
      { kind: 'field', field: 'page' },
      { kind: 'field', field: 'pages' },
    ]);

    // The result is a valid document.
    expect(() => DocModel.fromSnapshot(s)).not.toThrow();
    for (const [id, story] of Object.entries(s.stories)) expect(story.text.endsWith(PARA), id).toBe(true);
  });

  it('leaves out an image whose bytes it cannot get', async () => {
    const bytes = await writeDocx(sampleDoc(), { date: DATE });
    const read = await readDocx(bytes);
    expect(objectsOf(read.snapshot.stories[BODY], 'image')).toEqual([]);
    expect(read.images).toEqual([]);
  });

  it('keeps a table of contents, its bookmarks and links, and floating images', async () => {
    const doc = DocModel.create();
    const b = new ContentBuilder(counterIds('c'));
    b.addText('Intro').endParagraph({ style: 'heading1' });
    b.addObject({ kind: 'image', id: 'i1', src: 'file:logo', width: 120, height: 60, wrap: 'square', offsetX: 30, offsetY: 6, alt: 'A' });
    b.addText('Wrapped text').endParagraph();
    b.addObject({ kind: 'image', id: 'i2', src: 'file:logo', width: 50, height: 50, wrap: 'behind' });
    b.endParagraph();
    applyOp(doc, { type: 'insert', story: BODY, at: 0, content: b.build() });
    applyOp(doc, insertToc(doc, caretAt(BODY, 0), 'None', counterIds('t')).op);

    const read = await readDocx(await writeDocx(doc, { date: DATE, images }));
    const s = read.snapshot;
    const mark = s.anchors.find((a) => !a.id.startsWith('toc'))!;
    expect(s.stories[BODY]!.text.slice(mark.from, mark.to)).toBe('Intro');
    const fields = objectsOf(s.stories[BODY], 'field');
    expect(fields).toEqual([{ kind: 'field', field: 'pageRef', ref: mark.id }]);
    const link = s.stories[BODY]!.runs?.find(([, style]) => style.link)?.[1].link;
    expect(link).toBe(`#${mark.id}`);
    expect(objectsOf(s.stories[BODY], 'image')).toMatchObject([
      { width: 120, height: 60, wrap: 'square', offsetX: 30, offsetY: 6, alt: 'A' },
      { width: 50, height: 50, wrap: 'behind' },
    ]);
    expect(read.warnings).toEqual([]);
  });

  it('keeps landscape and odd/even settings on the section', async () => {
    const doc = DocModel.create();
    doc.props.section = { ...DEFAULT_SECTION, evenAndOdd: true, columns: 2, columnGap: 18, pageNumberFormat: 'lowerRoman', background: '#fafafa' };
    const read = await readDocx(await writeDocx(doc, { date: DATE }));
    expect(read.snapshot.props.section).toEqual(doc.props.section);
  });
});

// ---------------------------------------------------------------- foreign files

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function run(text: string, rPr = ''): string {
  return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}

async function handWritten(): Promise<Uint8Array> {
  const anchorImage =
    '<w:r><w:drawing><wp:anchor behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1" relativeHeight="1" simplePos="0" distT="0" distB="0" distL="0" distR="0">' +
    '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
    '<wp:extent cx="1270000" cy="635000"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="7" name="Pic" descr="Chart picture"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rIdImg"/><a:srcRect l="10000"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>' +
    '</wp:anchor></w:drawing></w:r>';
  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>` +
    `<w:p><w:pPr><w:pStyle w:val="Kop1"/></w:pPr>${run('Themed heading')}</w:p>` +
    `<w:p>${run('Display', '<w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/>')}${run(' auto', '<w:color w:val="auto"/>')}${run(' emphasised', '<w:rStyle w:val="Emphasis"/>')}</w:p>` +
    '<w:p>' +
    run('Page ') +
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    run('3') +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
    run(', see ') +
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> REF _Ref1 \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    run('section 2') +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
    run(' and ') +
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>HYPERLINK "https://example.com"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    run('the site') +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
    '</w:p>' +
    `<w:p><w:del w:id="1" w:author="A"><w:r><w:delText>gone </w:delText></w:r></w:del><w:ins w:id="2" w:author="B">${run('kept')}</w:ins><w:commentRangeStart w:id="0"/>${run(' text')}<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>` +
    `<w:sdt><w:sdtPr/><w:sdtContent><w:p>${run('In a content control')}</w:p></w:sdtContent></w:sdt>` +
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr>${run('Symbol bullet')}</w:p>` +
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="6"/></w:numPr></w:pPr>${run('Restarted')}</w:p>` +
    '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
    `<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p>${run('Merged')}</w:p></w:tc><w:tc><w:p>${run('B1')}</w:p></w:tc></w:tr>` +
    `<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p>${run('B2')}</w:p></w:tc></w:tr>` +
    '</w:tbl><w:p/>' +
    `<w:p>${run('Picture: ')}${anchorImage}</w:p>` +
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>' +
    '</w:body></w:document>';
  const styles =
    `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}>` +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Standaard"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Kop1"><w:name w:val="heading 1"/><w:basedOn w:val="Standaard"/><w:next w:val="Standaard"/><w:pPr><w:keepNext/><w:spacing w:before="240"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:color w:val="2F5496"/><w:sz w:val="32"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Aside"><w:name w:val="Aside note"/><w:basedOn w:val="Standaard"/><w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="Emphasis"><w:name w:val="Emphasis"/><w:rPr><w:i/><w:color w:val="C00000"/></w:rPr></w:style>' +
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>' +
    '</w:styles>';
  const numbering =
    `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}>` +
    '<w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val=""/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr></w:lvl></w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="4"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="%1)"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>' +
    '<w:num w:numId="5"><w:abstractNumId w:val="3"/></w:num>' +
    '<w:num w:numId="6"><w:abstractNumId w:val="4"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="4"/></w:lvlOverride></w:num>' +
    '</w:numbering>';
  const theme =
    '<?xml version="1.0" encoding="UTF-8"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements><a:fontScheme name="Office">' +
    '<a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>';
  const rels =
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId2" Type="${R}/numbering" Target="/word/numbering.xml"/>` +
    `<Relationship Id="rId3" Type="${R}/theme" Target="theme/theme1.xml"/>` +
    `<Relationship Id="rIdImg" Type="${R}/image" Target="media/chart.png"/>` +
    '</Relationships>';
  return writeZip([
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data: rels },
    { name: 'word/styles.xml', data: styles },
    { name: 'word/numbering.xml', data: numbering },
    { name: 'word/theme/theme1.xml', data: theme },
    { name: 'word/media/chart.png', data: PNG },
  ]);
}

describe('reading a docx written elsewhere', () => {
  it('reads theme fonts, fields, revisions, merges, lists and a floating image', async () => {
    const read = await readDocx(await handWritten(), { makeId: counterIds('h') });
    const s = read.snapshot;
    expect(read.warnings).toEqual(['fields']);

    expect(shape(s, BODY)).toEqual([
      { text: 'Themed heading', style: 'heading1' },
      { text: 'Display auto emphasised', style: 'normal' },
      { text: 'Page [field], see section 2 and the site', style: 'normal' },
      // The deletion stays, marked as a suggested deletion.
      { text: 'gone kept text', style: 'normal' },
      { text: 'In a content control', style: 'normal' },
      { text: 'Symbol bullet', style: 'normal', list: 'list3:0' },
      { text: 'Restarted', style: 'normal', list: 'list4-6:0' },
      {
        widths: [100, 150],
        header: [false, false],
        rows: [
          [{ span: '1x2', blocks: [{ text: 'Merged', style: 'normal' }] }, { span: '1x1', blocks: [{ text: 'B1', style: 'normal' }] }],
          ['covered', { span: '1x1', blocks: [{ text: 'B2', style: 'normal' }] }],
        ],
      },
      // Not the last block, so the empty paragraph after the table is real content.
      { text: '', style: 'normal' },
      { text: 'Picture: [image]', style: 'normal' },
    ]);

    // Theme fonts: the defaults' minor font in normal, the major one on a run and in the heading style.
    expect(s.styles.normal?.text).toEqual({ font: 'Aptos', size: 12, color: '#000000' });
    expect(s.styles.normal?.para).toEqual({ lineHeight: 1.08, spaceBefore: 0, spaceAfter: 8 });
    expect(s.styles.heading1).toEqual({
      name: 'Heading 1',
      basedOn: 'normal',
      next: 'normal',
      text: { font: 'Aptos Display', color: '#2f5496', size: 16 },
      para: { keepNext: true, spaceBefore: 12 },
      outline: 1,
    });
    expect(s.styles.Aside).toEqual({ name: 'Aside note', basedOn: 'normal', text: { italic: true }, para: { indentLeft: 36 } });

    const blocks = toBlocks({ ...s.stories[BODY]!, tables: s.tables, stories: s.stories }).blocks;
    const runs = blocks[1]!.type === 'paragraph' ? blocks[1]!.inlines.map((i) => i.style) : [];
    expect(runs).toEqual([{ font: 'Aptos Display' }, {}, { italic: true, color: '#c00000' }]);
    const fields = blocks[2]!.type === 'paragraph' ? blocks[2]!.inlines : [];
    expect(fields.find((i) => i.type === 'object')).toMatchObject({ data: { kind: 'field', field: 'page' } });
    expect(fields.find((i) => i.type === 'text' && i.text === 'the site')?.style).toEqual({ link: 'https://example.com' });
    const revised = blocks[3]!.type === 'paragraph' ? blocks[3]!.inlines.map((i) => [i.type === 'text' ? i.text : '', i.style.suggestion?.kind]) : [];
    expect(revised).toEqual([
      ['gone ', 'delete'],
      ['kept', 'insert'],
      [' text', undefined],
    ]);
    expect(s.comments?.map((c) => [c.author.name, c.createdAt, c.suggestion === c.id])).toEqual([
      ['A', 0, true],
      ['B', 0, true],
    ]);

    // Lists: the Symbol-font bullet as a real bullet, the override as its own restarted list.
    expect(s.lists.list3!.levels[0]).toEqual({ format: 'bullet', text: '●', indent: 36, hanging: 18 });
    expect(s.lists['list4-6']!.levels[0]).toMatchObject({ format: 'upperRoman', text: '%1)', start: 4 });

    // The table takes its border from the table style.
    const table = Object.values(s.tables)[0]!;
    expect(table.props?.border).toEqual({ width: 0.5, color: '#000000' });

    expect(objectsOf(s.stories[BODY], 'image')[0]).toMatchObject({ src: 'docx-image:chart.png', width: 100, height: 50, alt: 'Chart picture', crop: { left: 0.1 }, wrap: 'square' });
    expect(read.images.map((i) => i.name)).toEqual(['chart.png']);
    expect(s.props.section).toMatchObject({ pageWidth: 612, pageHeight: 792, marginLeft: 72 });
  });

  it('refuses what is not a Word document', async () => {
    await expect(readDocx(new TextEncoder().encode('not a zip'))).rejects.toMatchObject({ code: 'not_docx' });
    const xlsx = await writeZip([{ name: 'xl/workbook.xml', data: '<workbook/>' }]);
    await expect(readDocx(xlsx)).rejects.toBeInstanceOf(DocxImportError);
  });

  it('refuses a package larger than the byte budget', async () => {
    await expect(readDocx(await handWritten(), { maxBytes: 1000 })).rejects.toMatchObject({ code: 'too_large' });
  });
});

// ---------------------------------------------------------------- comments and suggestions

const ANN = { id: 'u-ann', name: 'Ann Lee' };
const BOB = { id: 'u-bob', name: 'Bob' };
const T1 = Date.UTC(2026, 8, 1, 9, 30);
const T2 = Date.UTC(2026, 8, 2, 10);
const T3 = Date.UTC(2026, 8, 3, 11, 15, 20);

/**
 * A deletion running over two paragraphs (text, then a field), an insertion
 * with an inserted paragraph break, an insertion inside a link, a suggestion
 * whose thread is gone, and a resolved discussion with a reply.
 */
function reviewedDoc(): DocModel {
  const b = new ContentBuilder(counterIds('v'));
  b.addText('Hello ')
    .addText('brave ', { suggestion: { id: 'del1', kind: 'delete' } })
    .addText('new', { bold: true, suggestion: { id: 'ins1', kind: 'insert' } })
    .addText(' world')
    .endParagraph({}, { suggestion: { id: 'ins1', kind: 'insert' } });
  b.addText('Second line, ')
    .addText('linked', { link: 'https://weldsuite.org', suggestion: { id: 'ins2', kind: 'insert' } })
    .addText(' and page ')
    .addObject({ kind: 'field', field: 'page' }, { suggestion: { id: 'del1', kind: 'delete' } })
    .endParagraph();
  b.addText('Orphan', { suggestion: { id: 'gone', kind: 'insert' } }).endParagraph();
  const body = b.build();
  const from = body.text.indexOf('Second');
  return DocModel.fromSnapshot({
    ...DocModel.create().toSnapshot(),
    stories: { [BODY]: body },
    anchors: [{ id: 'c1', kind: 'comment', story: BODY, from, to: from + 'Second line'.length }],
    comments: [
      { id: 'del1', thread: 'del1', author: ANN, createdAt: T1, body: '', suggestion: 'del1' },
      { id: 'ins1', thread: 'ins1', author: BOB, createdAt: T2, body: '', suggestion: 'ins1' },
      { id: 'ins2', thread: 'ins2', author: ANN, createdAt: T3, body: '', suggestion: 'ins2' },
      { id: 'c1', thread: 'c1', author: ANN, createdAt: T1, body: 'Please check\nthe wording, @[Bob](u-bob)', mentions: ['u-bob'], resolved: true, quote: 'Second line' },
      { id: 'r1', thread: 'c1', author: BOB, createdAt: T3, body: 'Done' },
    ],
  });
}

/** Every discussion with what it is about: a suggestion's stretches of text, or a comment's text. */
function reviewOf(snapshot: DocSnapshot): unknown[] {
  const doc = DocModel.fromSnapshot(snapshot);
  const textOf = (story: string, from: number, to: number) => doc.stories.get(story)!.text(from, to);
  return threadsOf(doc).map((t) => ({
    author: t.root.author.name,
    createdAt: t.root.createdAt,
    ...(t.root.suggestion
      ? { suggestion: suggestionRanges(doc, t.root.suggestion).map((r) => `${r.kind}:${textOf(r.story, r.from, r.to)}`) }
      : { on: t.at && textOf(t.at.story, t.at.from, t.at.to), body: t.root.body, resolved: !!t.root.resolved }),
    replies: t.replies.map((r) => `${r.author.name}@${r.createdAt}: ${r.body}`),
  }));
}

describe('docx comments and suggestions', () => {
  it('writes suggestions as revisions and threads as comments', async () => {
    const zip = openZip(await writeDocx(reviewedDoc(), { date: DATE }));
    for (const name of zip.names()) {
      if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
      const xml = (await zip.readText(name))!;
      expect(() => parseXml(xml), name).not.toThrow();
    }
    const doc = (await zip.readText('word/document.xml'))!;
    // The inserted paragraph break (written first) and the insertion share the revision's id.
    expect(doc).toContain('<w:p><w:pPr><w:rPr><w:ins w:id="0" w:author="Bob" w:date="2026-09-02T10:00:00Z"/></w:rPr></w:pPr>');
    expect(doc).toContain('<w:ins w:id="0" w:author="Bob" w:date="2026-09-02T10:00:00Z"><w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">new</w:t></w:r></w:ins>');
    // Both stretches of the deletion, the second a field in its run form.
    expect(doc).toContain('<w:del w:id="1" w:author="Ann Lee" w:date="2026-09-01T09:30:00Z"><w:r><w:delText xml:space="preserve">brave </w:delText></w:r></w:del>');
    expect(doc).toMatch(/<w:del w:id="1"[^>]*><w:r><w:fldChar w:fldCharType="begin"\/><\/w:r><w:r><w:delInstrText xml:space="preserve"> PAGE <\/w:delInstrText>/);
    expect(doc).toMatch(/<w:hyperlink [^>]*><w:ins w:id="\d+"[^>]*><w:r>.*?linked.*?<\/w:ins><\/w:hyperlink>/);
    // A suggestion without its thread is plain text.
    expect(doc).toContain('<w:r><w:t xml:space="preserve">Orphan</w:t></w:r>');
    expect(doc.match(/<w:commentRangeStart /g)).toHaveLength(2);
    expect(doc.match(/<w:commentReference /g)).toHaveLength(2);

    const comments = (await zip.readText('word/comments.xml'))!;
    expect(comments).toContain('w:author="Ann Lee" w:date="2026-09-01T09:30:00Z" w:initials="AL"');
    expect(comments).toContain('<w:t xml:space="preserve">the wording, @Bob</w:t>');
    const extended = (await zip.readText('word/commentsExtended.xml'))!;
    expect(extended).toContain('<w15:commentEx w15:paraId="00000002" w15:done="1"/>');
    expect(extended).toContain('<w15:commentEx w15:paraId="00000003" w15:paraIdParent="00000002" w15:done="1"/>');
    const types = (await zip.readText('[Content_Types].xml'))!;
    expect(types).toContain('PartName="/word/comments.xml"');
    expect(types).toContain('PartName="/word/commentsExtended.xml"');
    const rels = (await zip.readText('word/_rels/document.xml.rels'))!;
    expect(rels).toContain('Target="comments.xml"');
    expect(rels).toContain('Target="commentsExtended.xml"');
  });

  it('reads back the suggestions and the discussion it wrote', async () => {
    const original = reviewedDoc();
    const read = await readDocx(await writeDocx(original, { date: DATE }), { makeId: counterIds('r') });
    const s = read.snapshot;
    expect(read.warnings).toEqual([]);
    expect(s.stories[BODY]!.text).toBe(original.body.text());

    expect(reviewOf(s)).toEqual([
      { author: 'Ann Lee', createdAt: T1, suggestion: ['delete:brave ', 'delete:￼'], replies: [] },
      { author: 'Bob', createdAt: T2, suggestion: ['insert:new', `insert:${PARA}`], replies: [] },
      {
        author: 'Ann Lee',
        createdAt: T1,
        on: 'Second line',
        body: 'Please check\nthe wording, @Bob',
        resolved: true,
        replies: [`Bob@${T3}: Done`],
      },
      { author: 'Ann Lee', createdAt: T3, suggestion: ['insert:linked'], replies: [] },
    ]);

    // Formatting, the link and the field keep their places alongside the marks.
    const blocks = toBlocks({ ...s.stories[BODY]!, tables: s.tables, stories: s.stories }).blocks;
    const inlines = blocks.flatMap((b) => (b.type === 'paragraph' ? b.inlines : []));
    expect(inlines.find((i) => i.type === 'text' && i.text === 'new')?.style).toMatchObject({ bold: true, suggestion: { kind: 'insert' } });
    expect(inlines.find((i) => i.type === 'text' && i.text === 'linked')?.style).toMatchObject({ link: 'https://weldsuite.org', suggestion: { kind: 'insert' } });
    expect(inlines.find((i) => i.type === 'object')).toMatchObject({ data: { kind: 'field', field: 'page' }, style: { suggestion: { kind: 'delete' } } });
    expect(inlines.find((i) => i.type === 'text' && i.text === 'Orphan')?.style).toEqual({});

    // Word knows people by name: the name is the author's id too.
    expect(new Set(s.comments!.map((c) => c.author.id))).toEqual(new Set(['Ann Lee', 'Bob']));
    expect(s.comments!.find((c) => c.thread === c.id && !c.suggestion)?.quote).toBe('Second line');
    expect(isWellFormedOp({ type: 'patchComments', set: s.comments })).toBe(true);
    expect(() => DocModel.fromSnapshot(s)).not.toThrow();
  });

  it('reads revisions and threaded comments from a file written elsewhere', async () => {
    const carol = 'w:id="7" w:author="Carol" w:date="2026-03-04T05:06:07Z"';
    const document =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>` +
      `<w:p><w:pPr><w:rPr><w:ins ${carol}/></w:rPr></w:pPr><w:commentRangeStart w:id="1"/><w:commentRangeStart w:id="2"/>${run('Start ')}` +
      `<w:ins ${carol}>${run('added')}</w:ins>` +
      '<w:commentRangeEnd w:id="1"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="1"/></w:r>' +
      '<w:commentRangeEnd w:id="2"/><w:r><w:commentReference w:id="2"/></w:r></w:p>' +
      '<w:p><w:del w:id="8" w:author="Dan" w:date="2026-03-05T00:00:00"><w:r><w:delText>removed</w:delText></w:r></w:del>' +
      '<w:moveFrom w:id="9" w:author="Dan"><w:r><w:delText xml:space="preserve"> moved</w:delText></w:r></w:moveFrom>' +
      `${run(' stays')}<w:moveTo w:id="10" w:author="Dan">${run(' moved')}</w:moveTo><w:r><w:commentReference w:id="3"/></w:r></w:p>` +
      '<w:sectPr/></w:body></w:document>';
    const w14 = 'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
    const comment = (id: number, who: string, paras: [string, string][]) =>
      `<w:comment w:id="${id}" ${who}>${paras.map(([pid, text], i) => `<w:p w14:paraId="${pid}">${i ? '' : '<w:r><w:annotationRef/></w:r>'}${run(text)}</w:p>`).join('')}</w:comment>`;
    const comments =
      `<?xml version="1.0" encoding="UTF-8"?><w:comments ${W} ${w14}>` +
      comment(1, 'w:author="Carol" w:date="2026-03-04T06:00:00Z" w:initials="C"', [
        ['1A2B3C4D', 'First line'],
        ['1A2B3C4E', 'second line'],
      ]) +
      comment(2, 'w:initials="DD" w:date="2026-03-04T07:00:00Z"', [['2A2B3C4D', 'A reply']]) +
      comment(3, 'w:author="Eve"', [['3A2B3C4D', 'On a point']]) +
      comment(4, 'w:author="Eve"', [['4A2B3C4D', 'Nowhere in the text']]) +
      '</w:comments>';
    const extended =
      '<?xml version="1.0" encoding="UTF-8"?><w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">' +
      '<w15:commentEx w15:paraId="1A2B3C4E" w15:done="1"/><w15:commentEx w15:paraId="2A2B3C4D" w15:paraIdParent="1A2B3C4E" w15:done="0"/>' +
      '</w15:commentsEx>';
    const rels =
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${R}/comments" Target="comments.xml"/>` +
      '<Relationship Id="rId2" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>' +
      '</Relationships>';
    const bytes = await writeZip([
      {
        name: '_rels/.rels',
        data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
      },
      { name: 'word/document.xml', data: document },
      { name: 'word/_rels/document.xml.rels', data: rels },
      { name: 'word/comments.xml', data: comments },
      { name: 'word/commentsExtended.xml', data: extended },
    ]);

    const read = await readDocx(bytes, { makeId: counterIds('w') });
    const s = read.snapshot;
    // The comment with no place in the text is left out.
    expect(read.warnings).toEqual(['comments']);
    expect(s.stories[BODY]!.text).toBe(`Start added${PARA}removed moved stays moved${PARA}`);
    expect(reviewOf(s)).toEqual([
      {
        author: 'Carol',
        createdAt: Date.UTC(2026, 2, 4, 6),
        on: 'Start added',
        body: 'First line\nsecond line',
        resolved: true,
        replies: [`DD@${Date.UTC(2026, 2, 4, 7)}: A reply`],
      },
      // The inserted text and the inserted paragraph break after it are one stretch.
      { author: 'Carol', createdAt: Date.UTC(2026, 2, 4, 5, 6, 7), suggestion: [`insert:added${PARA}`], replies: [] },
      // A date without a zone is UTC; a revision without a date is at 0.
      { author: 'Dan', createdAt: Date.UTC(2026, 2, 5), suggestion: ['delete:removed'], replies: [] },
      { author: 'Dan', createdAt: 0, suggestion: ['delete: moved'], replies: [] },
      { author: 'Dan', createdAt: 0, suggestion: ['insert: moved'], replies: [] },
      { author: 'Eve', createdAt: 0, on: '', body: 'On a point', resolved: false, replies: [] },
    ]);
    // The point comment sits where its mark is: at the end of the second paragraph.
    const point = s.anchors.find((a) => a.kind === 'comment' && s.comments!.find((c) => c.id === a.id)?.body === 'On a point')!;
    expect([point.from, point.to]).toEqual([s.stories[BODY]!.text.length - 1, s.stories[BODY]!.text.length - 1]);
    expect(isWellFormedOp({ type: 'patchComments', set: s.comments })).toBe(true);
  });
});
