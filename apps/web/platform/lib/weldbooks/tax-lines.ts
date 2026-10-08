import type { TaxLineCatalog, TaxLineDef } from '@/lib/api/domains/weldbooks';

/** `8 · Advertising`: the line number as printed on the form, then its name. */
export function taxLineName(def: Pick<TaxLineDef, 'line' | 'label'>): string {
  return `${def.line} · ${def.label}`;
}

/** The catalog entry of a stored line code; undefined for a line of another return or an unknown one. */
export function findTaxLine(catalog: TaxLineCatalog | undefined, code: string | null | undefined): TaxLineDef | undefined {
  return code ? catalog?.lines.find((line) => line.code === code) : undefined;
}

/** Name of a stored line code, or the code itself when the catalog doesn't know it. */
export function taxLineLabel(catalog: TaxLineCatalog | undefined, code: string | null | undefined): string {
  const def = findTaxLine(catalog, code);
  return def ? taxLineName(def) : (code ?? '');
}

export interface TaxLineGroup {
  key: string;
  label: string;
  lines: TaxLineDef[];
}

/** The catalog's lines grouped by section, in the catalog's order. */
export function groupTaxLines(catalog: TaxLineCatalog | undefined): TaxLineGroup[] {
  if (!catalog) return [];
  return catalog.sections
    .map((section) => ({
      key: section.key,
      label: section.label,
      lines: catalog.lines.filter((line) => line.section === section.key),
    }))
    .filter((group) => group.lines.length > 0);
}
