/**
 * Non-JSON answers that differ between the two runs of a request by
 * construction, compared in a canonical form instead of byte for byte.
 *
 * - PDFs: pdf-lib (TypeScript) writes compressed object and cross-reference
 *   streams, a creation date and a random suffix on every font resource
 *   name; the Rust renderer writes the same drawing operators uncompressed.
 *   What is compared is the drawing: every content stream, inflated, with
 *   the font suffixes taken off (`/Helvetica-Bold-123` → `/Helvetica-Bold`),
 *   in file order.
 * - Generated payroll files (WeldHR's SEPA and NACHA payment files and
 *   filings): the moment they were made (`createdAt`: an ISO timestamp, the
 *   NACHA file header's creation date and time) is masked.
 * - Workbooks (.xlsx, a zip): each entry inflated, in archive order, with
 *   the moment the file was written masked (the entries' DOS times and the
 *   core properties' `dcterms:created`/`modified`), as WeldSheets'
 *   exports are written at the second each run asks.
 */

import { inflateRawSync, inflateSync } from 'node:zlib';

const SKIPPED_STREAM_TYPES = /\/Type\s*\/(XRef|ObjStm|Metadata)\b/;

/** The drawing operators of a PDF, as described above. */
export function pdfDrawing(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString('latin1');
  const parts: string[] = [];
  const keyword = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = keyword.exec(text))) {
    const at = match.index;
    // `endstream` itself contains `stream`: only a keyword after a dictionary opens one.
    if (text.slice(Math.max(0, at - 3), at) === 'end') continue;
    const dictStart = text.lastIndexOf(' obj', at);
    const dict = dictStart >= 0 ? text.slice(dictStart, at) : '';
    const dataStart = at + match[0].length;
    const end = text.indexOf('endstream', dataStart);
    if (end < 0) break;
    keyword.lastIndex = end + 'endstream'.length;
    if (SKIPPED_STREAM_TYPES.test(dict)) continue;
    let data = text.slice(dataStart, end);
    if (/\/FlateDecode\b/.test(dict)) {
      try {
        data = inflateSync(Buffer.from(data, 'latin1')).toString('latin1');
      } catch {
        // Not a stream we can read: compared as stored.
      }
    } else {
      data = data.replace(/\r?\n$/, '');
    }
    parts.push(data.replace(/^\/([A-Za-z-]+?)-\d+ /gm, '/$1 '));
  }
  return parts.join('\n');
}

/** An ISO date and time; the zone after it is masked apart (`ZONE_AFTER_MASK`). */
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?/g;
const ZONE_AFTER_MASK = /<timestamp>(?:Z|[+-]\d{2}:?\d{2})/g;

/** A NACHA file: 94-character records, the first a file header (`101`). */
function maskNachaHeader(text: string): string {
  if (!text.startsWith('101')) return text;
  const newline = text.indexOf('\n');
  const first = newline < 0 ? text : text.slice(0, newline).replace(/\r$/, '');
  if (first.length !== 94) return text;
  // Positions 24-33: file creation date (YYMMDD) and time (HHMM).
  return `${first.slice(0, 23)}<created>${first.slice(33)}${newline < 0 ? '' : text.slice(text.indexOf('\n'))}`;
}

const ZIP_LOCAL_HEADER = 0x04034b50;

/**
 * A zip's entries, read from their local headers (the archive's writers put
 * the sizes there: no data descriptors), each as its name and content with
 * timestamps masked; null when it does not read that way.
 */
function zipEntries(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: string[] = [];
  let at = 0;
  while (at + 30 <= bytes.byteLength && view.getUint32(at, true) === ZIP_LOCAL_HEADER) {
    const flags = view.getUint16(at + 6, true);
    const method = view.getUint16(at + 8, true);
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);
    if (flags & 0x08) return null;
    const start = at + 30 + nameLength + extraLength;
    const name = Buffer.from(bytes.subarray(at + 30, at + 30 + nameLength)).toString('utf8');
    const data = bytes.subarray(start, start + size);
    let content: string;
    try {
      content = (method === 8 ? inflateRawSync(data) : Buffer.from(data)).toString('latin1');
    } catch {
      return null;
    }
    entries.push(`${name}\n${content.replace(ISO_TIMESTAMP, '<timestamp>').replace(ZONE_AFTER_MASK, '<timestamp>')}`);
    at = start + size;
  }
  return entries.length > 0 ? entries.join('\n\n') : null;
}

/** Routes whose generated files carry the moment they were made. */
function generatesFiles(route: string | null): boolean {
  return !!route && (route.startsWith('/api/weldhr/payroll/') || route.startsWith('/api/weldhr/me/'));
}

/** The form two non-JSON answers are compared in. */
export function canonicalBody(route: string | null, bytes: Uint8Array): string | Uint8Array {
  if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-') return `pdf:${pdfDrawing(bytes)}`;
  if (bytes.byteLength >= 4 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) === ZIP_LOCAL_HEADER) {
    const entries = zipEntries(bytes);
    if (entries !== null) return `zip:${entries}`;
  }
  if (!generatesFiles(route)) return bytes;
  const text = new TextDecoder().decode(bytes);
  return maskNachaHeader(text).replace(ISO_TIMESTAMP, '<timestamp>').replace(ZONE_AFTER_MASK, '<timestamp>');
}

/** Whether two non-JSON answers say the same thing. */
export function sameBody(route: string | null, a: Uint8Array, b: Uint8Array): boolean {
  const left = canonicalBody(route, a);
  const right = canonicalBody(route, b);
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  return Buffer.compare(left, right) === 0;
}
