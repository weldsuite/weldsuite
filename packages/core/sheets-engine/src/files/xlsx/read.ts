/**
 * Reading an .xlsx file (Office Open XML SpreadsheetML) into a WeldSheets
 * workbook snapshot: sheets with their cells, formulas and last values,
 * styles, sizes, merges, frozen panes, filters, conditional formats, data
 * validation and defined names. What WeldSheets has no counterpart for is
 * left out and reported in `warnings`.
 *
 * Formulas come with the values Excel last computed; the engine that loads
 * the snapshot works them out again.
 */

import { child, childrenOf, openZip, parseXml, scanXml, XmlError, ZipError, type XmlElement, type ZipReader } from '@weldsuite/zip-xml';
import { EN_LOCALE, isDateFormat } from '../../format/number-format';
import type { DefinedName, SheetSnapshot } from '../../model/workbook';
import { styleKey } from '../../model/styles';
import { ImportError, type ImportResult, type ImportWarning, type ReadXlsxOptions } from '../types';
import { decodeEscapes } from './text';
import { readTheme } from './colors';
import { fromExcelFormula } from './formulas';
import { readWorksheet } from './sheet-read';
import { readStyles } from './styles';

/** Cells read at most when the caller sets no limit. */
const DEFAULT_MAX_CELLS = 5_000_000;

interface Relationship {
  id: string;
  type: string;
  target: string;
}

export async function readXlsx(data: Uint8Array, options: ReadXlsxOptions = {}): Promise<ImportResult> {
  let zip: ZipReader;
  try {
    zip = openZip(data, options.limits);
  } catch (e) {
    throw importError(e);
  }
  try {
    return await readPackage(zip, options);
  } catch (e) {
    throw importError(e);
  }
}

function importError(e: unknown): ImportError {
  if (e instanceof ImportError) return e;
  if (e instanceof ZipError) {
    if (e.code === 'not_zip') return new ImportError('This file is not an Excel workbook', 'not_spreadsheet');
    return new ImportError(e.message, e.code === 'too_large' ? 'too_large' : e.code);
  }
  if (e instanceof XmlError) return new ImportError('The workbook is damaged', 'corrupt');
  throw e;
}

async function readPackage(zip: ZipReader, options: ReadXlsxOptions): Promise<ImportResult> {
  const locale = options.locale ?? EN_LOCALE;
  const warnings = new Set<ImportWarning>();
  const workbookPath = (await relationships(zip, ''))?.find((r) => r.type.endsWith('/officeDocument'))?.target ?? 'xl/workbook.xml';
  const workbook = await readTree(zip, workbookPath);
  if (!workbook || workbook.name !== 'workbook') throw new ImportError('This file is not an Excel workbook', 'not_spreadsheet');
  const rels = (await relationships(zip, workbookPath)) ?? [];
  const target = (suffix: string) => rels.find((r) => r.type.endsWith(suffix))?.target;

  const theme = readTheme(await readTree(zip, target('/theme')));
  const styles = readStyles(await readTree(zip, target('/styles')), theme, locale);
  const sharedStrings = await readSharedStrings(zip, target('/sharedStrings'), warnings);
  if (rels.some((r) => r.type.endsWith('/externalLink'))) warnings.add('externalLinks');
  if (zip.names().some((n) => /vbaProject\.bin$/i.test(n))) warnings.add('macros');

  const pr = child(workbook, 'workbookPr')?.attrs;
  const date1904 = pr?.date1904 === '1' || pr?.date1904 === 'true';
  const xfKeys = styles.xfs.map((s) => styleKey(s));
  const dateXfs = styles.xfs.map((s) => isDateFormat(s?.numFmt));
  const budget = { cells: options.maxCells ?? DEFAULT_MAX_CELLS };

  const sheets: SheetSnapshot[] = [];
  /** Sheet ids by position in the workbook, for sheet-scoped names. */
  const idAt = new Map<number, string>();
  for (const [i, el] of childrenOf(child(workbook, 'sheets'), 'sheet').entries()) {
    const rel = rels.find((r) => r.id === el.attrs.id);
    if (!rel) continue;
    if (!rel.type.endsWith('/worksheet')) {
      warnings.add('chartSheets');
      continue;
    }
    const xml = await zip.readText(rel.target);
    if (xml === null) continue;
    const id = options.sheetId?.(sheets.length) ?? `sheet${sheets.length + 1}`;
    const name = uniqueName(el.attrs.name || `Sheet${sheets.length + 1}`, sheets);
    const sheet = readWorksheet(xml, { id, name, styles, xfKeys, dateXfs, sharedStrings, theme, locale, date1904, warnings, budget });
    if (el.attrs.state === 'hidden' || el.attrs.state === 'veryHidden') sheet.props = { ...sheet.props, hidden: true };
    await notePartsOf(zip, rel.target, warnings);
    idAt.set(i, id);
    sheets.push(sheet);
  }
  if (sheets.length === 0) throw new ImportError('The workbook has no sheets WeldSheets can open', 'empty');
  // Every sheet hidden is not a state WeldSheets can show: the first comes back.
  if (sheets.every((s) => s.props?.hidden)) delete sheets[0]!.props!.hidden;

  const names = definedNames(workbook, idAt);
  return { workbook: { version: 1, sheets, ...(names.length ? { names } : {}) }, warnings: [...warnings].sort() };
}

function uniqueName(name: string, taken: SheetSnapshot[]): string {
  const clean = name.slice(0, 100);
  const used = (n: string) => taken.some((s) => s.name.toLowerCase() === n.toLowerCase());
  if (!used(clean)) return clean;
  for (let i = 2; ; i++) if (!used(`${clean} (${i})`)) return `${clean} (${i})`;
}

/** Names the user made; Excel's own (`_xlnm.…`, print areas, filter ranges) are left out. */
function definedNames(workbook: XmlElement, idAt: Map<number, string>): DefinedName[] {
  const names: DefinedName[] = [];
  for (const el of childrenOf(child(workbook, 'definedNames'), 'definedName')) {
    const name = el.attrs.name ?? '';
    if (!name || name.startsWith('_xlnm.') || !/^[A-Za-z_\\][A-Za-z0-9_.]*$/.test(name)) continue;
    const formula = fromExcelFormula(el.text.trim());
    if (formula === null || formula.includes('#REF!')) continue;
    const scope = el.attrs.localSheetId === undefined ? undefined : idAt.get(Number(el.attrs.localSheetId));
    if (el.attrs.localSheetId !== undefined && !scope) continue;
    names.push(scope ? { name, formula, sheetId: scope } : { name, formula });
  }
  return names;
}

async function readTree(zip: ZipReader, path: string | undefined): Promise<XmlElement | null> {
  if (!path) return null;
  const xml = await zip.readText(path);
  return xml === null ? null : parseXml(xml);
}

/** The relationships of the part at `path` ('' for the package's own). */
async function relationships(zip: ZipReader, path: string): Promise<Relationship[] | null> {
  const slash = path.lastIndexOf('/');
  const dir = slash < 0 ? '' : path.slice(0, slash + 1);
  const relsPath = `${dir}_rels/${path.slice(slash + 1)}.rels`;
  const root = await readTree(zip, relsPath);
  if (!root) return null;
  return childrenOf(root, 'Relationship')
    .filter((r) => r.attrs.TargetMode !== 'External')
    .map((r) => ({ id: r.attrs.Id ?? '', type: r.attrs.Type ?? '', target: resolvePath(dir, r.attrs.Target ?? '') }));
}

/** A relationship target, relative to the folder of the part that names it (or absolute with a leading '/'). */
export function resolvePath(dir: string, target: string): string {
  const parts = (target.startsWith('/') ? target.slice(1) : dir + target).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part !== '.' && part !== '') out.push(part);
  }
  return out.join('/');
}

async function readSharedStrings(zip: ZipReader, path: string | undefined, warnings: Set<ImportWarning>): Promise<string[]> {
  const xml = path ? await zip.readText(path) : null;
  if (xml === null) return [];
  const out: string[] = [];
  let current: string | null = null;
  let inText = false;
  let phonetic = 0;
  scanXml(xml, {
    open(name) {
      if (name === 'si') current = '';
      else if (name === 'rPh') phonetic++;
      else if (name === 'r' && current !== null) warnings.add('richText');
      else if (name === 't' && current !== null && phonetic === 0) inText = true;
    },
    close(name) {
      if (name === 'si') {
        out.push(decodeEscapes(current ?? ''));
        current = null;
      } else if (name === 'rPh') {
        phonetic--;
      } else if (name === 't') {
        inText = false;
      }
    },
    text(t) {
      if (inText && current !== null) current += t;
    },
  });
  return out;
}

/** What a sheet links to that WeldSheets leaves out: drawings, comments, pivot tables, tables. */
async function notePartsOf(zip: ZipReader, sheetPath: string, warnings: Set<ImportWarning>): Promise<void> {
  for (const r of (await relationships(zip, sheetPath)) ?? []) {
    if (r.type.endsWith('/drawing')) warnings.add('drawings');
    else if (r.type.endsWith('/comments')) warnings.add('comments');
    else if (r.type.endsWith('/pivotTable')) warnings.add('pivotTables');
    else if (r.type.endsWith('/table')) warnings.add('tables');
  }
}
