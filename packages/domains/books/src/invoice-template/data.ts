/**
 * What a template prints, already translated and formatted.
 *
 * Each caller builds this from what it has: the platform from the invoice
 * detail payload and its i18n labels, books-api from the stored invoice and
 * the jurisdiction adapter. Jurisdiction rules (GST columns, US per-
 * jurisdiction tax rows, Brazil's tax groups and Pix, compliance notices)
 * stay with the callers that already know them; the engine only places the
 * result.
 */
import type { LineItemColumnKey, TemplateField } from './schema';

export type Align = 'left' | 'center' | 'right';

export interface PartyData {
  name: string;
  /** Address lines. */
  lines: string[];
  /** Email / phone / website (seller) or email (buyer). */
  contactLines?: string[];
  /** "VAT number: NL…", "GSTIN: …". */
  taxIdLines?: string[];
}

export interface TableColumnData {
  label: string;
  align?: Align;
  /** The jurisdiction requires this column (India: HSN/SAC and the tax split). Added when a template leaves it out. */
  required?: boolean;
}

export interface TableRowData {
  /** Cell text; `\n` starts a new line within the cell. */
  cells: Partial<Record<LineItemColumnKey, string>>;
  /** Muted lines under the description (Brazil: NCM / CFOP). */
  subLines?: string[];
}

export type TotalsRowKind = 'normal' | 'muted' | 'heading' | 'total' | 'balance';

export interface TotalsRowData {
  label: string;
  value: string;
  kind?: TotalsRowKind;
}

export interface LegalData {
  /** Compliance statements ("BTW verlegd"), the US exempt-sale notice, Brazil's regime notices. */
  notices: string[];
  /** Brazil: the authorised NF-e / NFS-e, as lines. */
  fiscalDocument?: string[] | null;
  /** Brazil: Pix QR code for the amount due. `matrix` is the QR modules (true = dark). */
  pix?: { title: string; key: string; payload: string; matrix: boolean[][] } | null;
  /** Footer text the jurisdiction requires. */
  requiredFooter?: string | null;
}

export interface InvoiceDocumentData {
  /** Pre-formatted values of `field` blocks and `{{placeholders}}`; empty values are not printed. */
  fields: Partial<Record<TemplateField, string | null>>;
  /** Translated labels of the fields ("Issue date", "Invoice number"). */
  fieldLabels: Partial<Record<TemplateField, string>>;
  labels: {
    from: string;
    billTo: string;
    shipTo: string;
    payment: string;
    notes: string;
    terms: string;
    /** "Page {page} of {total}". */
    page: string;
  };
  logoUrl?: string | null;
  seller: PartyData;
  billTo: PartyData;
  /** Only when the invoice ships to another address than it bills. */
  shipTo?: PartyData | null;
  table: {
    columns: Partial<Record<LineItemColumnKey, TableColumnData>>;
    rows: TableRowData[];
  };
  totals: TotalsRowData[];
  payment: {
    /** Bank lines ("IBAN: …", "BIC: …"). */
    bankLines: string[];
    instructions?: string | null;
  };
  notes?: string | null;
  terms?: string | null;
  legal: LegalData;
  /** A draft prints a banner and a watermark so it can't pass for the finalized invoice. */
  draft?: { banner: string; watermark: string } | null;
}
