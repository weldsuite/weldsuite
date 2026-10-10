/**
 * A printable document described as data: the jaaropgaaf, a W-2 copy, a 941
 * worksheet, a loonaangifte summary. Builders in nl/ and us/ return one; the
 * renderer in payslip-pdf.ts turns any of them into a PDF. Keeping layout out
 * of the builders keeps them testable and lets the UI show the same content
 * as HTML.
 *
 * Text is already in the document's language; amounts are already formatted.
 */

export interface DocumentField {
  label: string;
  value: string;
  /** Printed bold (totals, amounts due). */
  emphasis?: boolean;
}

export type DocumentSection =
  | { kind: 'fields'; title?: string; fields: DocumentField[] }
  | {
      kind: 'table';
      title?: string;
      columns: string[];
      /** Columns (by index) to right-align, typically amounts. */
      alignRight?: number[];
      rows: string[][];
      /** Optional totals row, printed bold. */
      totals?: string[];
    }
  | { kind: 'text'; title?: string; paragraphs: string[] };

export interface PayrollDocument {
  title: string;
  subtitle?: string;
  language: 'en' | 'nl';
  /** Top-left block (issuer) and top-right block (recipient). */
  from?: string[];
  to?: string[];
  sections: DocumentSection[];
  /** Small print at the bottom of every page. */
  footer?: string[];
  /** Diagonal text, e.g. "DRAFT" / "CONCEPT". */
  watermark?: string | null;
}

/** A generated file (XML, CSV, text) next to its printable summary. */
export interface GeneratedFile {
  fileName: string;
  contentType: string;
  content: string;
}
