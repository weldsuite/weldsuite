/**
 * Export of the responses table as CSV or XLSX, server-side, from the same
 * column model and filters as the list. CSV follows RFC 4180 (CRLF, quoted
 * fields) with a UTF-8 byte order mark so Excel opens it right; XLSX is a
 * minimal SpreadsheetML package written with `@weldsuite/zip-xml`. File answers
 * carry a link into the app, never a public URL. At most
 * `FORM_LIMITS.maxExportRows` rows.
 */


import { schema } from '@weldsuite/worker-kit/db';
import { attrs, esc, isXmlUnsafe, writeZip, XML_HEADER } from '@weldsuite/zip-xml';
import { isFileField, type FieldBlock } from '@weldsuite/forms-engine';
import { FORM_LIMITS, type ExportFormResponsesQuery, type FormResponseColumn } from '@weldsuite/app-api-client/schemas/weldforms';
import type { WorkspaceCtx } from './context';
import {
  answerCell,
  buildColumns,
  isAbandoned,
  latestFields,
  loadVersions,
  responseConditions,
  responseOrder,
  type ResponseRow,
  type VersionInfo,
} from './response-model';

const { formResponses } = schema;

type Cell = string | number | null;

export interface ExportFile {
  body: Uint8Array;
  contentType: string;
  filename: string;
}

const CSV_TYPE = 'text/csv; charset=utf-8';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A link to the response in the platform, for the files it holds. */
const appLink = (env: { PLATFORM_URL?: string }, formId: string, responseId: string) =>
  `${(env.PLATFORM_URL || 'https://app.weldsuite.org').replace(/\/$/, '')}/weldforms/${formId}/results?tab=responses&response=${responseId}`;

function metaValue(column: FormResponseColumn, row: ResponseRow, version: VersionInfo | undefined, now: number): Cell {
  switch (column.key) {
    case 'number':
      return row.number;
    case 'submittedAt':
      return row.submittedAt ? row.submittedAt.toISOString() : null;
    case 'startedAt':
      return row.startedAt.toISOString();
    case 'email':
      return row.respondentEmail;
    case 'score':
      return row.score;
    case 'duration':
      return row.durationMs === null ? null : Math.round(row.durationMs / 1000);
    case 'status':
      return isAbandoned(row, now) ? 'abandoned' : row.status;
    case 'version':
      return version?.number ?? null;
    case 'source':
      return row.metadata?.source ?? null;
    case 'device':
      return row.metadata?.device ?? null;
    case 'country':
      return row.metadata?.country ?? null;
    case 'referrer':
      return row.metadata?.referrer ?? null;
    default:
      return row.hidden?.[column.key] ?? null;
  }
}

/** The table as header + rows; the shared model of both formats. */
export async function exportTable(
  ctx: Pick<WorkspaceCtx, 'db' | 'env'>,
  formId: string,
  query: Omit<ExportFormResponsesQuery, 'format'>,
): Promise<{ header: string[]; rows: Cell[][] }> {
  const versions = await loadVersions(ctx.db, formId);
  const byVersion = new Map(versions.map((v) => [v.id, v]));
  const fallback = latestFields(versions);
  const columns = buildColumns(versions);
  const where = responseConditions(formId, query, fallback);
  const rows = await ctx.db
    .select()
    .from(formResponses)
    .where(where)
    .orderBy(...responseOrder(query.sort ?? 'oldest'))
    .limit(FORM_LIMITS.maxExportRows);
  const now = Date.now();

  const table = rows.map((row): Cell[] => {
    const version = byVersion.get(row.versionId);
    return columns.map((column) => {
      if (!column.blockId) return metaValue(column, row, version, now);
      const field: FieldBlock | undefined = version?.fields.get(column.blockId) ?? fallback.get(column.blockId);
      const raw = (row.answers ?? {})[column.blockId];
      if (raw === undefined) return null;
      if (field && isFileField(field)) {
        const names = answerCell(field, raw);
        return names ? `${names} (${appLink(ctx.env, formId, row.id)})` : null;
      }
      return answerCell(field, raw, column.part) || null;
    });
  });
  return { header: columns.map((c) => c.label), rows: table };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** A spreadsheet reads a leading `=`, `+`, `-` or `@` as a formula: defuse it (a plain negative number stays one). */
function defuse(text: string): string {
  return /^[=+@\t\r]/.test(text) || (/^-/.test(text) && !/^-\d+(\.\d+)?$/.test(text)) ? `'${text}` : text;
}

function csvField(cell: Cell): string {
  if (cell === null) return '';
  const text = typeof cell === 'number' ? String(cell) : defuse(cell);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: Cell[][]): string {
  const lines = [header, ...rows].map((r) => r.map(csvField).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** Text safe for XML 1.0 element content. */
function xmlText(text: string): string {
  let out = '';
  for (const ch of text) out += isXmlUnsafe(ch.codePointAt(0)!) ? '' : ch;
  return esc(out);
}

function sheetCell(cell: Cell, ref: string, style?: number): string {
  if (cell === null || cell === '') return '';
  const s = style ? attrs({ s: style }) : '';
  if (typeof cell === 'number' && Number.isFinite(cell)) return `<c r="${ref}"${s}><v>${cell}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlText(String(cell))}</t></is></c>`;
}

export async function toXlsx(header: string[], rows: Cell[][], now = new Date()): Promise<Uint8Array> {
  const sheetRows = [header, ...rows].map((cells, r) => `<row r="${r + 1}">${cells.map((cell, c) => sheetCell(cell, `${columnName(c)}${r + 1}`, r === 0 ? 1 : undefined)).join('')}</row>`);
  const files = [
    {
      name: '[Content_Types].xml',
      data: `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `${XML_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Responses" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      data: `${XML_HEADER}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`,
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: `${XML_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${sheetRows.join('')}</sheetData></worksheet>`,
    },
  ];
  return writeZip(files, { date: now });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const safeFilename = (title: string) => title.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'form';

export async function exportResponses(
  ctx: Pick<WorkspaceCtx, 'db' | 'env'>,
  form: { id: string; title: string },
  query: ExportFormResponsesQuery,
  now = new Date(),
): Promise<ExportFile> {
  const { format, ...filters } = query;
  const { header, rows } = await exportTable(ctx, form.id, filters);
  const base = `${safeFilename(form.title)}-responses-${now.toISOString().slice(0, 10)}`;
  if (format === 'csv') return { body: new TextEncoder().encode(toCsv(header, rows)), contentType: CSV_TYPE, filename: `${base}.csv` };
  return { body: await toXlsx(header, rows, now), contentType: XLSX_TYPE, filename: `${base}.xlsx` };
}

