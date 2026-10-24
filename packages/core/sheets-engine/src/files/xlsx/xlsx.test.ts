import { describe, expect, it } from 'vitest';
import { Engine } from '../../calc/engine';
import { styleKey, type CellStyle } from '../../model/styles';
import type { Chart } from '../../model/charts';
import type { WorkbookSnapshot } from '../../model/workbook';
import { err, type Scalar } from '../../values';
import { ImportError } from '../types';
import { openZip, writeZip } from '../zip';
import { applyTint } from './colors';
import { readXlsx } from './read';
import { writeXlsx } from './write';

const OPTIONS = { now: () => 46000, random: () => 0.5, timezoneOffset: () => 0 };
const DATE = new Date(Date.UTC(2026, 9, 24, 12));

const BOLD: CellStyle = { bold: true, fill: '#ffeb9c', borderBottom: { style: 'thin', color: '#ff0000' } };
const MONEY: CellStyle = { numFmt: '"€" #,##0.00', hAlign: 'right', fontFamily: 'Georgia', fontSize: 12, color: '#1f4e79' };
const DAY: CellStyle = { numFmt: 'dd-mm-yyyy' };
const WRAP: CellStyle = { wrap: 'wrap', vAlign: 'top', indent: 2, italic: true, underline: true, strike: true, rotation: -30 };
const COLUMN: CellStyle = { fill: '#e2efda' };
const k = (s: CellStyle) => styleKey(s)!;

function source(): WorkbookSnapshot {
  return {
    version: 1,
    sheets: [
      {
        id: 's1',
        name: 'Sales 2026',
        rowCount: 1000,
        colCount: 26,
        rows: { defaultSize: 21, sizes: [[0, 40]], hidden: [7] },
        cols: { defaultSize: 100, sizes: [[0, 150]], hidden: [9], styles: [[8, k(COLUMN)]] },
        cells: [
          [0, 0, { v: 'Item', s: k(BOLD) }],
          [0, 1, { v: 'Price', s: k(BOLD) }],
          [0, 2, { v: 'When', s: k(BOLD) }],
          [1, 0, { v: 'Coffee' }],
          [1, 1, { v: 3.5, s: k(MONEY) }],
          [1, 2, { v: 46037, s: k(DAY) }],
          [2, 0, { v: 'Tea' }],
          [2, 1, { v: 2.25, s: k(MONEY) }],
          [2, 2, { v: 46038, s: k(DAY) }],
          [3, 0, { v: 'Juice' }],
          [3, 1, { v: 4, s: k(MONEY) }],
          [4, 0, { v: 'Total' }],
          [4, 1, { v: null, f: 'SUBTOTAL(9,B2:B4)', s: k(MONEY) }],
          [5, 0, { v: 'ctl\u0001 _x0041_ "q" <&>', s: k(WRAP) }],
          [5, 1, { v: true }],
          [5, 2, { v: err('#N/A') }],
          [6, 0, { v: null, f: 'A2&" & "&A3' }],
          [6, 3, { v: null, f: 'SEQUENCE(3)' }],
          [9, 0, { v: null, f: 'XLOOKUP("Tea",A2:A4,B2:B4)' }],
          [10, 0, { v: null, f: 'Lists!A2' }],
          [11, 0, { v: null, f: 'Rate*2' }],
          [11, 8, { v: 'styled by its column' }],
        ],
        merges: [{ r1: 12, c1: 0, r2: 13, c2: 1 }],
        freeze: { rows: 1, cols: 1 },
        props: { tabColor: '#ff0000', gridlines: false },
        filter: {
          range: { r1: 0, c1: 0, r2: 4, c2: 2 },
          columns: [
            { col: 0, hiddenValues: ['s:Juice'] },
            { col: 1, condition: { type: 'greater', value: 1 } },
          ],
        },
        conditionalFormats: [
          {
            id: 'a',
            order: 1,
            ranges: [{ r1: 1, c1: 1, r2: 3, c2: 1 }],
            rule: { type: 'condition', condition: { type: 'greater', value: 3 }, style: { bold: true, fill: '#c6efce', color: '#006100' } },
          },
          { id: 'b', order: 2, ranges: [{ r1: 1, c1: 0, r2: 3, c2: 0 }], rule: { type: 'condition', condition: { type: 'textContains', value: 'e' }, style: { italic: true } } },
          {
            id: 'c',
            order: 3,
            ranges: [{ r1: 1, c1: 1, r2: 3, c2: 1 }],
            rule: {
              type: 'colorScale',
              points: [
                { kind: 'min', color: '#f8696b' },
                { kind: 'percentile', value: 50, color: '#ffeb84' },
                { kind: 'max', color: '#63be7b' },
              ],
            },
          },
          { id: 'd', order: 4, ranges: [{ r1: 1, c1: 2, r2: 3, c2: 2 }], rule: { type: 'condition', condition: { type: 'formula', formula: 'C2>$B$1' }, style: { strike: true } } },
        ],
        validations: [
          { id: 'v1', ranges: [{ r1: 20, c1: 0, r2: 30, c2: 0 }], criteria: { type: 'list', values: ['Coffee', 'Tea'] }, strict: true, dropdown: true, help: 'Pick a drink' },
          { id: 'v2', ranges: [{ r1: 20, c1: 1, r2: 30, c2: 1 }], criteria: { type: 'listRange', source: 'Lists!$A$1:$A$3' }, strict: false, dropdown: false },
          { id: 'v3', ranges: [{ r1: 20, c1: 2, r2: 30, c2: 2 }], criteria: { type: 'checkbox' }, strict: true },
          { id: 'v4', ranges: [{ r1: 20, c1: 3, r2: 30, c2: 3 }], criteria: { type: 'condition', condition: { type: 'between', min: 1, max: 10 } }, strict: true },
          { id: 'v5', ranges: [{ r1: 20, c1: 4, r2: 30, c2: 4 }], criteria: { type: 'condition', condition: { type: 'textStartsWith', value: 'WS-' } }, strict: false },
        ],
      },
      {
        id: 's2',
        name: 'Lists',
        rowCount: 1000,
        colCount: 26,
        rows: { defaultSize: 21 },
        cols: { defaultSize: 100 },
        cells: [
          [0, 0, { v: 'Red' }],
          [1, 0, { v: 'Green' }],
          [2, 0, { v: 'Blue' }],
          [0, 1, { v: 0.21 }],
        ],
        props: { hidden: true },
      },
    ],
    names: [
      { name: 'Rate', formula: 'Lists!$B$1' },
      { name: 'Local', formula: "'Sales 2026'!$A$1", sheetId: 's1' },
    ],
  };
}

async function roundTrip(): Promise<{ before: Engine; after: Engine; bytes: Uint8Array; warnings: string[] }> {
  const before = Engine.fromSnapshot(source(), OPTIONS);
  const bytes = await writeXlsx(before, { date: DATE });
  const { workbook, warnings } = await readXlsx(bytes, { sheetId: (i) => ['s1', 's2'][i]! });
  return { before, after: Engine.fromSnapshot(workbook, OPTIONS), bytes, warnings };
}

describe('xlsx round trip', () => {
  it('keeps values, formulas and what they compute', async () => {
    const { before, after, warnings } = await roundTrip();
    expect(warnings).toEqual([]);
    expect(after.workbook.sheets.map((s) => [s.id, s.name, !!s.props.hidden])).toEqual([
      ['s1', 'Sales 2026', false],
      ['s2', 'Lists', true],
    ]);
    const grid = (e: Engine) => Array.from({ length: 13 }, (_, r) => Array.from({ length: 9 }, (_, c) => e.getValue('s1', r, c)));
    expect(grid(after)).toEqual(grid(before));
    expect(after.getValue('s1', 4, 1)).toBe(5.75); // SUBTOTAL leaves out the filtered Juice row
    expect([6, 7, 8].map((r) => after.getValue('s1', r, 3))).toEqual([1, 2, 3]); // SEQUENCE spills again
    expect(after.getValue('s1', 11, 0)).toBeCloseTo(0.42);
    const formulas = (e: Engine) => e.workbook.getSheet('s1')!.cells;
    for (const [r, c] of [
      [4, 1],
      [6, 0],
      [6, 3],
      [9, 0],
      [10, 0],
      [11, 0],
    ] as const) {
      expect(formulas(after).get(r, c)?.f).toBe(formulas(before).get(r, c)?.f);
    }
    expect(formulas(after).get(7, 3)).toBeUndefined(); // spilled cells are not stored
    expect(after.workbook.names).toEqual(before.workbook.names);
  });

  it('keeps styles, sizes, merges, frozen panes and sheet settings', async () => {
    const { after } = await roundTrip();
    const sheet = after.workbook.getSheet('s1')!;
    const style = (r: number, c: number) => after.workbook.style(sheet, r, c);
    expect(style(0, 0)).toEqual(BOLD);
    expect(style(1, 1)).toEqual(MONEY);
    expect(style(1, 2)).toEqual(DAY);
    expect(style(5, 0)).toEqual(WRAP);
    expect(style(11, 8)).toEqual(COLUMN);
    expect(sheet.cols.styles.get(8)).toBe(k(COLUMN));
    expect(sheet.rows.sizeOf(0)).toBe(40);
    expect(sheet.rows.defaultSize).toBe(21);
    expect(sheet.cols.sizeOf(0)).toBe(150);
    expect(sheet.cols.defaultSize).toBe(100);
    expect(sheet.rows.isHidden(7)).toBe(true);
    expect(sheet.cols.isHidden(9)).toBe(true);
    // The row the filter hides comes back filtered, not hidden by hand.
    expect([sheet.rows.isFiltered(3), sheet.rows.isHidden(3)]).toEqual([true, false]);
    expect(sheet.merges).toEqual([{ r1: 12, c1: 0, r2: 13, c2: 1 }]);
    expect(sheet.freeze).toEqual({ rows: 1, cols: 1 });
    expect(sheet.props).toEqual({ tabColor: '#ff0000', gridlines: false });
  });

  it('keeps the filter, conditional formats and validation rules', async () => {
    const { after } = await roundTrip();
    const sheet = after.workbook.getSheet('s1')!;
    expect(sheet.filter).toEqual(source().sheets[0]!.filter);
    const strip = <T extends { id: string }>(list: T[]) => list.map(({ id: _id, ...rest }) => rest);
    expect(strip(sheet.conditionalFormats)).toEqual(strip(source().sheets[0]!.conditionalFormats!));
    const [v1, v2, v3, v4, v5] = strip(sheet.validations);
    const original = strip(source().sheets[0]!.validations!);
    expect([v1, v2, v3, v4]).toEqual(original.slice(0, 4));
    // A text test has no named form in Excel's validation: it travels as a formula.
    expect(v5).toEqual({ ...original[4], criteria: { type: 'condition', condition: { type: 'formula', formula: 'LEFT(E21,LEN("WS-"))="WS-"' } } });
  });

  it('writes the parts Excel expects', async () => {
    const { bytes } = await roundTrip();
    const zip = openZip(bytes);
    expect(zip.names().sort()).toEqual(
      [
        '[Content_Types].xml',
        '_rels/.rels',
        'docProps/app.xml',
        'docProps/core.xml',
        'xl/_rels/workbook.xml.rels',
        'xl/metadata.xml',
        'xl/sharedStrings.xml',
        'xl/styles.xml',
        'xl/workbook.xml',
        'xl/worksheets/sheet1.xml',
        'xl/worksheets/sheet2.xml',
      ].sort(),
    );
    const sheet = (await zip.readText('xl/worksheets/sheet1.xml'))!;
    expect(sheet).toContain('<c r="D7" cm="1"><f t="array" ref="D7:D9">_xlfn.SEQUENCE(3)</f><v>1</v></c>');
    expect(sheet).toContain('<f>_xlfn.XLOOKUP(&quot;Tea&quot;,A2:A4,B2:B4)</f>');
    expect(sheet).toContain('<row r="4" hidden="1">');
    // Element order matters to Excel.
    const order = ['<sheetPr', '<dimension', '<sheetViews', '<sheetFormatPr', '<cols', '<sheetData', '<autoFilter', '<mergeCells', '<conditionalFormatting', '<dataValidations', '<pageMargins'];
    const at = order.map((tag) => sheet.indexOf(tag));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const workbook = (await zip.readText('xl/workbook.xml'))!;
    expect(workbook).toContain('fullCalcOnLoad="1"');
    expect(workbook).toContain('<sheet name="Lists" sheetId="2" state="hidden" r:id="rId2"/>');
    expect(workbook).toContain('<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">\'Sales 2026\'!$A$1:$C$5</definedName>');
    expect(await zip.readText('xl/sharedStrings.xml')).toContain('ctl_x0001_ _x005F_x0041_ &quot;q&quot; &lt;&amp;&gt;');
  });
});

// ---------------------------------------------------------------------------
// A file as Excel writes it
// ---------------------------------------------------------------------------

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rel = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`;
const rels = (...items: string[]) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`;

const EXCEL_SHEET = `<x:worksheet xmlns:x="${MAIN}" xmlns:r="${REL}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">
<x:sheetPr><x:tabColor theme="4"/></x:sheetPr>
<x:sheetViews><x:sheetView workbookViewId="0"><x:pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></x:sheetView></x:sheetViews>
<x:sheetFormatPr baseColWidth="10" defaultRowHeight="15"/>
<x:cols><x:col min="2" max="3" width="20.7109375" customWidth="1"/><x:col min="5" max="16384" width="9.140625" hidden="1"/></x:cols>
<x:sheetData>
<x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1" t="s"><x:v>3</x:v></x:c></x:row>
<x:row r="2" ht="30" customHeight="1"><x:c r="A2" t="s" s="1"><x:v>1</x:v></x:c><x:c r="B2" s="1"><x:v>10</x:v></x:c><x:c r="C2"><x:f t="shared" ref="C2:C4" si="0">B2*2</x:f><x:v>20</x:v></x:c></x:row>
<x:row r="3" hidden="1"><x:c r="A3" t="inlineStr"><x:is><x:t>Inline &amp; plain</x:t></x:is></x:c><x:c r="B3"><x:v>5</x:v></x:c><x:c r="C3"><x:f t="shared" si="0"/><x:v>10</x:v></x:c></x:row>
<x:row r="4" hidden="1"><x:c r="A4" t="s"><x:v>2</x:v></x:c><x:c r="B4" t="e"><x:v>#DIV/0!</x:v></x:c><x:c r="C4"><x:f t="shared" si="0"/><x:v>0</x:v></x:c></x:row>
<x:row r="6"><x:c r="A6" s="2"><x:v>0</x:v></x:c><x:c r="B6" t="d"><x:v>2026-01-15T12:00:00</x:v></x:c><x:c r="C6" t="b"><x:v>1</x:v></x:c><x:c r="D6" t="str"><x:f>_xlfn.CONCAT("a","b")</x:f><x:v>ab</x:v></x:c></x:row>
<x:row r="8"><x:c r="A8"><x:f t="array" ref="A8:A10">ROW(A1:A3)</x:f><x:v>1</x:v></x:c></x:row>
<x:row r="9"><x:c r="A9"><x:v>2</x:v></x:c></x:row>
<x:row r="10"><x:c r="A10" s="4"><x:v>3</x:v></x:c></x:row>
<x:row r="11"><x:c r="A11"><x:f>SUM(Table1[Amount])</x:f><x:v>42</x:v></x:c><x:c r="B11"><x:f>Tax*100</x:f><x:v>21</x:v></x:c></x:row>
</x:sheetData>
<x:autoFilter ref="A1:B4"><x:filterColumn colId="0"><x:filters><x:filter val="Rich text"/><x:filter val="Tab&#9;bed"/></x:filters></x:filterColumn><x:filterColumn colId="1"><x:customFilters><x:customFilter operator="greaterThanOrEqual" val="5"/></x:customFilters></x:filterColumn></x:autoFilter>
<x:mergeCells count="1"><x:mergeCell ref="D1:E2"/></x:mergeCells>
<x:conditionalFormatting sqref="B2:B4"><x:cfRule type="cellIs" dxfId="0" priority="2" operator="between"><x:formula>1</x:formula><x:formula>9</x:formula></x:cfRule><x:cfRule type="dataBar" priority="1"><x:dataBar><x:cfvo type="min"/><x:cfvo type="max"/><x:color rgb="FF638EC6"/></x:dataBar></x:cfRule></x:conditionalFormatting>
<x:conditionalFormatting sqref="A2:A4 C2:C4"><x:cfRule type="beginsWith" dxfId="0" priority="3" operator="beginsWith" text="Ri"><x:formula>LEFT(A2,LEN("Ri"))="Ri"</x:formula></x:cfRule><x:cfRule type="cellIs" dxfId="0" priority="4" operator="greaterThan"><x:formula>$B$2</x:formula></x:cfRule></x:conditionalFormatting>
<x:dataValidations count="3"><x:dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" showDropDown="1" sqref="F1:F5" prompt="Choose"><x:formula1>"Yes,No"</x:formula1></x:dataValidation><x:dataValidation type="whole" operator="greaterThan" errorStyle="warning" showErrorMessage="1" sqref="G1:G5"><x:formula1>0</x:formula1></x:dataValidation><x:dataValidation type="textLength" operator="lessThanOrEqual" showErrorMessage="1" sqref="H1"><x:formula1>5</x:formula1></x:dataValidation></x:dataValidations>
<x:drawing r:id="rId1"/>
<x:extLst><x:ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}"><x14:dataValidations count="1"><x14:dataValidation type="list" allowBlank="1" showErrorMessage="1"><x14:formula1><xm:f>Hidden!$A$1:$A$2</xm:f></x14:formula1><xm:sqref>I1:I9</xm:sqref></x14:dataValidation></x14:dataValidations></x:ext></x:extLst>
</x:worksheet>`;

const EXCEL_STYLES = `<styleSheet xmlns="${MAIN}">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.000"/></numFmts>
<fonts count="3"><font><sz val="11"/><color theme="1"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFF0000"/><name val="Calibri"/></font><font><i/><sz val="14"/><color theme="4" tint="0.39997558519241921"/><name val="Cambria"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor indexed="13"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="hair"><color indexed="64"/></left><right/><top/><bottom style="mediumDashed"><color rgb="FF00B050"/></bottom><diagonal/></border></borders>
<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="164" fontId="1" fillId="2" borderId="1" applyNumberFormat="1"><alignment horizontal="centerContinuous" vertical="center" wrapText="1" textRotation="135"/></xf><xf numFmtId="14" fontId="2" fillId="0" borderId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="9" fontId="0" fillId="0" borderId="0"/></cellXfs>
<dxfs count="1"><dxf><font><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf></dxfs>
</styleSheet>`;

const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const DML = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const CHART_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';

/** A chart (B6, 3 columns and 10 rows) and a picture. */
const EXCEL_DRAWING = `<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${DML}">
<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>1</xdr:col><xdr:colOff>95250</xdr:colOff><xdr:row>5</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>4</xdr:col><xdr:colOff>95250</xdr:colOff><xdr:row>15</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${CHART_NS}"><c:chart xmlns:c="${CHART_NS}" xmlns:r="${REL}" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>
<xdr:oneCellAnchor><xdr:from><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="952500" cy="952500"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="Logo"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="${REL}" r:embed="rId2"/></xdr:blipFill><xdr:spPr/></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>
</xdr:wsDr>`;

const EXCEL_CHART = `<c:chartSpace xmlns:c="${CHART_NS}" xmlns:a="${DML}" xmlns:r="${REL}"><c:chart>
<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Amount </a:t></a:r><a:r><a:t>by item</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>
<c:plotArea><c:layout/><c:barChart><c:barDir val="bar"/><c:grouping val="stacked"/><c:varyColors val="0"/>
<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Data!$B$1</c:f></c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></c:spPr><c:cat><c:strRef><c:f>Data!$A$2:$A$4</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Data!$B$2:$B$4</c:f></c:numRef></c:val></c:ser>
<c:ser><c:idx val="1"/><c:order val="1"/><c:tx><c:v>Plan</c:v></c:tx><c:cat><c:strRef><c:f>Data!$A$2:$A$4</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Data!$C$2:$C$4</c:f></c:numRef></c:val></c:ser>
<c:axId val="1"/><c:axId val="2"/></c:barChart>
<c:catAx><c:axId val="1"/><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Item</a:t></a:r></a:p></c:rich></c:tx></c:title><c:crossAx val="2"/></c:catAx>
<c:valAx><c:axId val="2"/><c:crossAx val="1"/></c:valAx></c:plotArea>
<c:legend><c:legendPos val="r"/></c:legend></c:chart></c:chartSpace>`;

async function excelFile(): Promise<Uint8Array> {
  return writeZip([
    { name: '_rels/.rels', data: rels(rel('rId1', 'officeDocument', 'xl/workbook.xml')) },
    {
      name: 'xl/workbook.xml',
      data: `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><workbookPr date1904="1"/><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Chart1" sheetId="2" r:id="rId2"/><sheet name="Hidden" sheetId="3" state="veryHidden" r:id="rId3"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Data!$A$1:$B$4</definedName><definedName name="Tax">0.21</definedName><definedName name="Broken">#REF!</definedName></definedNames></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: rels(
        rel('rId1', 'worksheet', 'worksheets/sheet1.xml'),
        rel('rId2', 'chartsheet', 'chartsheets/sheet1.xml'),
        rel('rId3', 'worksheet', '/xl/worksheets/sheet3.xml'),
        rel('rId4', 'styles', 'styles.xml'),
        rel('rId5', 'sharedStrings', 'sharedStrings.xml'),
        rel('rId6', 'theme', 'theme/theme1.xml'),
      ),
    },
    {
      name: 'xl/theme/theme1.xml',
      data: '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme></a:themeElements></a:theme>',
    },
    { name: 'xl/styles.xml', data: EXCEL_STYLES },
    {
      name: 'xl/sharedStrings.xml',
      data: `<sst xmlns="${MAIN}" count="4" uniqueCount="4"><si><t>Item</t></si><si><r><rPr><b/></rPr><t>Rich </t></r><r><t xml:space="preserve">text</t></r><rPh sb="0" eb="1"><t>ignored</t></rPh></si><si><t>Tab_x0009_bed</t></si><si><t>Amount</t></si></sst>`,
    },
    { name: 'xl/worksheets/sheet1.xml', data: EXCEL_SHEET },
    { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: rels(rel('rId1', 'drawing', '../drawings/drawing1.xml'), rel('rId2', 'comments', '../comments1.xml')) },
    { name: 'xl/drawings/drawing1.xml', data: EXCEL_DRAWING },
    { name: 'xl/drawings/_rels/drawing1.xml.rels', data: rels(rel('rId1', 'chart', '../charts/chart1.xml'), rel('rId2', 'image', '../media/image1.png')) },
    { name: 'xl/charts/chart1.xml', data: EXCEL_CHART },
    { name: 'xl/worksheets/sheet3.xml', data: `<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>` },
  ]);
}

describe('reading a file as Excel writes it', () => {
  it('reads cells, shared formulas, arrays, strings and dates, and says what it left out', async () => {
    const { workbook, warnings } = await readXlsx(await excelFile());
    expect(warnings).toEqual(['chartSheets', 'comments', 'conditionalFormats', 'drawings', 'formulas', 'richText']);
    expect(workbook.sheets.map((s) => [s.id, s.name, !!s.props?.hidden])).toEqual([
      ['sheet1', 'Data', false],
      ['sheet2', 'Hidden', true],
    ]);
    expect(workbook.names).toEqual([{ name: 'Tax', formula: '0.21' }]);
    const cells = new Map(workbook.sheets[0]!.cells.map(([r, c, cell]) => [`${r}:${c}`, cell]));
    const value = (at: string) => cells.get(at)?.v;
    expect(['0:0', '0:1', '1:0', '2:0', '3:0'].map(value)).toEqual(['Item', 'Amount', 'Rich text', 'Inline & plain', 'Tab\tbed']);
    expect(value('3:1')).toEqual(err('#DIV/0!'));
    expect(['1:2', '2:2', '3:2'].map((at) => cells.get(at)?.f)).toEqual(['B2*2', 'B3*2', 'B4*2']);
    expect(value('5:0')).toBe(1462); // 1904 date system, moved to 1900
    expect(value('5:1')).toBe(46037.5);
    expect(value('5:2')).toBe(true);
    expect(cells.get('5:3')).toEqual({ v: 'ab', f: 'CONCAT("a","b")' });
    expect(cells.get('7:0')?.f).toBe('ROW(A1:A3)');
    expect(cells.has('8:0')).toBe(false); // an array formula's copied result
    expect(cells.get('9:0')).toEqual({ v: null, s: styleKey({ numFmt: '0%' }) });
    expect(cells.get('10:0')).toEqual({ v: 42 }); // a table reference: the value stays
    expect(cells.get('10:1')?.f).toBe('Tax*100');

    const engine = Engine.fromSnapshot(workbook, OPTIONS);
    expect(engine.getValue('sheet1', 10, 1)).toBeCloseTo(21);
    expect([7, 8, 9].map((r) => engine.getValue('sheet1', r, 0))).toEqual([1, 2, 3]);
  });

  it('reads styles, theme colours, sizes and sheet settings', async () => {
    const { workbook } = await readXlsx(await excelFile());
    const sheet = workbook.sheets[0]!;
    const styleAt = (r: number, c: number) => JSON.parse(sheet.cells.find(([rr, cc]) => rr === r && cc === c)![2].s!) as CellStyle;
    expect(styleAt(1, 0)).toEqual({
      bold: true,
      color: '#ff0000',
      fill: '#ffff00',
      borderLeft: { style: 'thin' },
      borderBottom: { style: 'dashed', color: '#00b050' },
      numFmt: '0.000',
      hAlign: 'center',
      vAlign: 'middle',
      wrap: 'wrap',
      rotation: -45,
    });
    expect(styleAt(5, 0)).toEqual({ italic: true, fontFamily: 'Cambria', fontSize: 14, color: `#${applyTint('4472c4', 0.39997558519241921)}`, numFmt: 'm/d/yyyy' });
    expect(sheet.props).toEqual({ tabColor: '#4472c4' });
    expect(sheet.freeze).toEqual({ rows: 1, cols: 0 });
    expect(sheet.merges).toEqual([{ r1: 0, c1: 3, r2: 1, c2: 4 }]);
    expect(sheet.rows).toEqual({ defaultSize: 20, sizes: [[1, 40]] });
    expect(sheet.cols.defaultSize).toBe(80);
    expect(sheet.cols.sizes?.slice(0, 3)).toEqual([
      [1, 145],
      [2, 145],
      [4, 64],
    ]);
    expect(sheet.cols.hidden?.[0]).toBe(4);
    expect(sheet.cols.hidden?.length).toBe(sheet.colCount - 4);
  });

  it('reads charts, and leaves out pictures', async () => {
    const { workbook, warnings } = await readXlsx(await excelFile());
    expect(warnings).toContain('drawings');
    expect(workbook.sheets[0]!.charts).toEqual([
      {
        id: 'ch1',
        type: 'bar',
        stacking: 'stacked',
        categories: 'Data!$A$2:$A$4',
        series: [
          { name: 'Data!$B$1', values: 'Data!$B$2:$B$4', color: '#ff0000' },
          { name: '"Plan"', values: 'Data!$C$2:$C$4' },
        ],
        title: 'Amount by item',
        legend: 'right',
        xTitle: 'Item',
        // From B6 + 10 px to E16 + 10 px: columns B and C (145 px each) and D (80 px); ten rows of 20 px.
        anchor: { row: 5, col: 1, dx: 10, dy: 0 },
        width: 370,
        height: 200,
      },
    ]);
  });

  it('reads the filter, conditional formats and validation, from the extension list too', async () => {
    const { workbook } = await readXlsx(await excelFile());
    const sheet = workbook.sheets[0]!;
    expect(sheet.filter).toEqual({
      range: { r1: 0, c1: 0, r2: 3, c2: 1 },
      columns: [
        { col: 0, hiddenValues: ['s:Inline & plain'] },
        { col: 1, condition: { type: 'greaterOrEqual', value: 5 } },
      ],
    });
    // The rows the filter hid are its own, not hidden by hand.
    expect(sheet.rows.hidden).toBeUndefined();
    const red = { color: '#9c0006', fill: '#ffc7ce' };
    expect(sheet.conditionalFormats).toEqual([
      { id: 'cf1', order: 2, ranges: [{ r1: 1, c1: 1, r2: 3, c2: 1 }], rule: { type: 'condition', condition: { type: 'between', min: 1, max: 9 }, style: red } },
      {
        id: 'cf2',
        order: 3,
        ranges: [
          { r1: 1, c1: 0, r2: 3, c2: 0 },
          { r1: 1, c1: 2, r2: 3, c2: 2 },
        ],
        rule: { type: 'condition', condition: { type: 'textStartsWith', value: 'Ri' }, style: red },
      },
      {
        id: 'cf3',
        order: 4,
        ranges: [
          { r1: 1, c1: 0, r2: 3, c2: 0 },
          { r1: 1, c1: 2, r2: 3, c2: 2 },
        ],
        rule: { type: 'condition', condition: { type: 'formula', formula: 'A2>($B$2)' }, style: red },
      },
    ]);
    expect(sheet.validations).toEqual([
      { id: 'dv1', ranges: [{ r1: 0, c1: 5, r2: 4, c2: 5 }], criteria: { type: 'list', values: ['Yes', 'No'] }, strict: true, dropdown: false, help: 'Choose' },
      { id: 'dv2', ranges: [{ r1: 0, c1: 6, r2: 4, c2: 6 }], criteria: { type: 'condition', condition: { type: 'greater', value: 0 } }, strict: false },
      { id: 'dv3', ranges: [{ r1: 0, c1: 7, r2: 0, c2: 7 }], criteria: { type: 'condition', condition: { type: 'formula', formula: 'LEN(H1)<=(5)' } }, strict: true },
      { id: 'dv4', ranges: [{ r1: 0, c1: 8, r2: 8, c2: 8 }], criteria: { type: 'listRange', source: 'Hidden!$A$1:$A$2' }, strict: true, dropdown: true },
    ]);
  });

  it('refuses what is not a workbook, and more cells than allowed', async () => {
    await expect(readXlsx(new TextEncoder().encode('nope'))).rejects.toMatchObject({ code: 'not_spreadsheet' });
    const notExcel = await writeZip([{ name: 'readme.txt', data: 'hi' }]);
    await expect(readXlsx(notExcel)).rejects.toBeInstanceOf(ImportError);
    await expect(readXlsx(await excelFile(), { maxCells: 5 })).rejects.toMatchObject({ code: 'too_large' });
  });
});

describe('charts and pivot tables in xlsx', () => {
  const charts: Chart[] = [
    {
      id: 'a',
      type: 'column',
      stacking: 'stacked',
      categories: "'Sales 2026'!$A$2:$A$4",
      series: [
        { name: "'Sales 2026'!$B$1", values: "'Sales 2026'!$B$2:$B$4", color: '#4285f4' },
        { name: '"Target"', values: "'Sales 2026'!$C$2:$C$4", color: '#ea4335' },
      ],
      title: 'Prices',
      legend: 'bottom',
      xTitle: 'Item',
      yTitle: 'Euro',
      anchor: { row: 15, col: 4, dx: 5, dy: 3 },
      width: 300,
      height: 200,
    },
    { id: 'b', type: 'pie', categories: "'Sales 2026'!$A$2:$A$4", series: [{ values: "'Sales 2026'!$B$2:$B$4" }], legend: 'right', anchor: { row: 30, col: 0, dx: 0, dy: 0 }, width: 250, height: 250 },
    {
      id: 'c',
      type: 'scatter',
      series: [{ values: "'Sales 2026'!$B$2:$B$4", x: "'Sales 2026'!$C$2:$C$4", color: '#34a853' }],
      legend: 'none',
      anchor: { row: 30, col: 4, dx: 0, dy: 0 },
      width: 250,
      height: 250,
    },
  ];

  async function withCharts() {
    const snap = source();
    snap.sheets[0]!.charts = charts;
    snap.sheets[1]!.cells.push([0, 4, { v: null, f: 'PIVOT(\'Sales 2026\'!$A$1:$C$4,"Item","","SUM:Price")' }]);
    const engine = Engine.fromSnapshot(snap, OPTIONS);
    const bytes = await writeXlsx(engine, { date: DATE });
    return { engine, bytes, read: await readXlsx(bytes, { sheetId: (i) => ['s1', 's2'][i]! }) };
  }

  it('writes charts as drawings Excel reads, with their last values', async () => {
    const zip = openZip((await withCharts()).bytes);
    expect(zip.names().filter((n) => /drawing|chart/.test(n)).sort()).toEqual([
      'xl/charts/chart1.xml',
      'xl/charts/chart2.xml',
      'xl/charts/chart3.xml',
      'xl/drawings/_rels/drawing1.xml.rels',
      'xl/drawings/drawing1.xml',
    ]);
    expect(await zip.readText('xl/worksheets/sheet1.xml')).toMatch(/<pageMargins [^>]*\/><drawing r:id="rId1"\/><\/worksheet>$/);
    expect(await zip.readText('xl/worksheets/_rels/sheet1.xml.rels')).toContain('Target="../drawings/drawing1.xml"');
    expect(await zip.readText('[Content_Types].xml')).toContain('<Override PartName="/xl/charts/chart3.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>');
    const column = (await zip.readText('xl/charts/chart1.xml'))!;
    expect(column).toContain('<c:barChart><c:barDir val="col"/><c:grouping val="stacked"/>');
    expect(column).toContain(`<c:val><c:numRef><c:f>'Sales 2026'!$B$2:$B$4</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="3"/><c:pt idx="0"><c:v>3.5</c:v></c:pt>`);
    expect(column).toContain('<c:pt idx="1"><c:v>Tea</c:v></c:pt>');
    expect((await zip.readText('xl/charts/chart2.xml'))!).toContain('<c:pieChart><c:varyColors val="1"/>');
  });

  it('reads its own charts back as they were', async () => {
    const { read } = await withCharts();
    const back = read.workbook.sheets[0]!.charts!.map(({ id: _id, ...rest }) => rest);
    expect(back).toEqual(charts.map(({ id: _id, ...rest }) => rest));
  });

  it('writes a pivot table as the values it shows', async () => {
    const { bytes, engine, read } = await withCharts();
    expect(engine.getValue('s2', 4, 5)).toBe(9.75);
    const sheet2 = (await openZip(bytes).readText('xl/worksheets/sheet2.xml'))!;
    expect(sheet2).not.toContain('PIVOT');
    const cells = new Map(read.workbook.sheets[1]!.cells.map(([r, c, cell]) => [`${r}:${c}`, cell]));
    expect(cells.get('0:4')).toEqual({ v: 'Item' });
    expect(cells.get('4:5')).toEqual({ v: 9.75 });
  });
});

describe('xlsx values', () => {
  it('writes and reads back every kind of value', async () => {
    const values: Scalar[] = [0, -1.5, 1e-7, 123456789012345, 'text', '', true, false, err('#REF!'), err('#SPILL!')];
    const engine = Engine.fromSnapshot(
      {
        version: 1,
        sheets: [{ id: 'a', name: 'A', rowCount: 1000, colCount: 26, rows: { defaultSize: 21 }, cols: { defaultSize: 100 }, cells: values.map((v, i) => [i, 0, { v }]) }],
      },
      OPTIONS,
    );
    const { workbook } = await readXlsx(await writeXlsx(engine, { date: DATE }));
    const back = new Map(workbook.sheets[0]!.cells.map(([r, , cell]) => [r, cell.v]));
    expect(values.map((_, i) => back.get(i) ?? null)).toEqual(values);
  });
});
