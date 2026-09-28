/**
 * Build minimal-but-valid empty Office Open XML files (docx / xlsx) on demand.
 *
 * Used when a WeldFlow document or sheet is created — we PUT the empty file to
 * R2 immediately so the row is downloadable before the editor's first
 * auto-save. Without this, freshly-created docs/sheets 404 in the drive
 * download flow.
 *
 * fflate is the only zip dependency that works inside Cloudflare Workers
 * (no Node-only APIs, no WASM).
 */

import { zipSync, strToU8 } from 'fflate';

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const DOCX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCX_DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p/>
    <w:sectPr/>
  </w:body>
</w:document>`;

export function buildEmptyDocx(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(DOCX_CONTENT_TYPES),
    '_rels/.rels': strToU8(DOCX_RELS),
    'word/document.xml': strToU8(DOCX_DOCUMENT),
  });
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

const XLSX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

const XLSX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const XLSX_WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Sheet1" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

const XLSX_WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

const XLSX_SHEET1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData/>
</worksheet>`;

export function buildEmptyXlsx(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(XLSX_CONTENT_TYPES),
    '_rels/.rels': strToU8(XLSX_RELS),
    'xl/workbook.xml': strToU8(XLSX_WORKBOOK),
    'xl/_rels/workbook.xml.rels': strToU8(XLSX_WORKBOOK_RELS),
    'xl/worksheets/sheet1.xml': strToU8(XLSX_SHEET1),
  });
}
