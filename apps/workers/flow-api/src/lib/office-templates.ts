/**
 * Build a minimal-but-valid empty .docx on demand.
 *
 * Used when a WeldFlow document is created — we PUT the empty file to R2
 * immediately so the row is downloadable before the editor's first
 * auto-save. Without this, freshly-created documents 404 in the drive
 * download flow. (Project sheets are WeldSheets spreadsheets, created by
 * sheets-api.)
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

