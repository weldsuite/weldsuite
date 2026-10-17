/**
 * WeldBooks Brazil: the monthly tax apuração, the SPED ECD export and the
 * withholding suggestion (`/api/br-tax`, books-api).
 *
 *   GET  /br-tax/apuracao?period=YYYY-MM         what the entity owes for a month, worked out from the tax ledger
 *   POST /br-tax/apuracao/book                   books the month's obligations as a tax return and a journal entry
 *   POST /br-tax/ecd                             the SPED ECD file of a year (ISO-8859-1 text download)
 *   GET  /br-tax/withholdings/suggest            the withholdings a service taker usually applies
 *
 * Mirrors `BrApuracao` in `@weldsuite/books-domain/jurisdictions/br` (the
 * platform doesn't import the domain package).
 */
import { weldbooksApi, type BlobResult } from '../weldbooks-client';

export type BrTaxRegime = 'mei' | 'simples_nacional' | 'lucro_presumido' | 'lucro_real';
export type BrSimplesAnexo = 'I' | 'II' | 'III' | 'IV' | 'V';
export type BrTaxCode = 'iss' | 'icms' | 'ipi' | 'pis' | 'cofins' | 'cbs' | 'ibs';
export type BrWithholdingCode = 'irrf' | 'csrf' | 'inss' | 'iss';

/** One annex of the month's DAS. */
export interface SimplesDasLine {
  anexo: BrSimplesAnexo;
  revenue: number;
  /** Bracket (faixa) of the RBT12: 1 to 6. */
  faixa: number;
  nominalRate: number;
  deduction: number;
  effectiveRate: number;
  amount: number;
  /** The DAS split per tax (irpj, csll, cofins, pis, cpp, icms, ipi, iss). */
  byTax: Partial<Record<string, number>>;
}

export interface SimplesDas {
  /** Revenue of the last 12 months. */
  rbt12: number;
  fatorR: number | null;
  lines: SimplesDasLine[];
  total: number;
  /** RBT12 is over the sublimit: ICMS / ISS are owed outside the DAS. */
  overSublimit: boolean;
  /** RBT12 is over the Simples limit: the company has to leave the regime. */
  overLimit: boolean;
  dueDate: string;
}

export interface MeiDas {
  amount: number;
  inss: number;
  icms: number;
  iss: number;
  dueDate: string;
}

export interface BrTaxLine {
  code: BrTaxCode;
  debits: number;
  credits: number;
  /** Withheld by customers (ISS retido) or offset from withholdings. */
  offsets: number;
  payable: number;
  dueDate: string | null;
}

export interface BrWithholdingLine {
  code: BrWithholdingCode;
  base: number;
  amount: number;
  dueDate: string;
  /** DARF revenue code where there is one. */
  darfCode?: string;
}

export interface BrQuarterlyIncomeTax {
  quarter: number;
  irpjBase: number;
  csllBase: number;
  irpj: number;
  irpjAdditional: number;
  csll: number;
  irrfOffset: number;
  csllOffset: number;
  irpjPayable: number;
  csllPayable: number;
  dueDate: string;
  /** The LC 224/2025 surcharge on the presumed margin was applied. */
  lc224Applied: boolean;
}

export interface BrApuracao {
  period: string;
  regime: BrTaxRegime;
  simples: SimplesDas | null;
  mei: MeiDas | null;
  taxes: BrTaxLine[];
  withholdingsToPay: BrWithholdingLine[];
  /** What customers withheld in the month, by tax: credits against the entity's own taxes. */
  withheldByCustomers: Record<'irrf' | 'pis' | 'cofins' | 'csll' | 'inss' | 'iss', number>;
  quarterly: BrQuarterlyIncomeTax | null;
  /** CBS / IBS of the 2026 test year, shown on documents only. */
  informational: { cbs: number; ibs: number };
  /** Everything payable this period. */
  total: number;
  /** Notes of the engine (plain sentences). */
  warnings: string[];
}

/** The apuração of a month plus whether it has been booked. */
export interface BrApuracaoResult extends BrApuracao {
  status: 'open' | 'booked';
  taxReturnId?: string;
  journalEntryId?: string;
}

export interface BookApuracaoResult {
  taxReturnId: string;
  journalEntryId: string;
}

/** A signatory of the ECD (contador, legal representative). Mirrors `EcdSignatory`. */
export interface EcdSignatory {
  name: string;
  /** CPF or CNPJ, digits only. */
  taxId: string;
  /** 900 = contador; 205 administrador, 203 diretor, 801 empresário, ... */
  code: string;
  qualification: string;
  crc?: string;
  crcUf?: string;
  email?: string;
  phone?: string;
  legalRepresentative: boolean;
}

export interface EcdExport extends BlobResult {
  /** The engine's notes about the file (the `X-Warnings` header, URL-encoded JSON). */
  warnings: string[];
}

export type WithholdingServiceKind = 'professional' | 'cleaning_security' | 'other';

export interface SuggestedWithholdings {
  iss?: number;
  irrf?: number;
  csrf?: boolean;
  inss?: number;
}

/** The notes of an ECD download: `X-Warnings` holds a URL-encoded JSON array of strings. */
export function parseWarningsHeader(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export const brTaxApi = {
  apuracao: (period: string) =>
    weldbooksApi.get<{ data: BrApuracaoResult }>(`/br-tax/apuracao?period=${encodeURIComponent(period)}`),
  bookApuracao: (period: string) =>
    weldbooksApi.post<{ data: BookApuracaoResult }>('/br-tax/apuracao/book', { period }),
  /** The SPED ECD file of a year, with the notes the server attached. */
  ecd: async (year: number, signatories: EcdSignatory[]): Promise<EcdExport> => {
    const result = await weldbooksApi.postBlob('/br-tax/ecd', { year, signatories });
    return { ...result, warnings: parseWarningsHeader(result.headers.get('X-Warnings')) };
  },
  suggestWithholdings: (params: { contactId?: string | null; serviceKind?: WithholdingServiceKind }) => {
    const query = new URLSearchParams();
    if (params.contactId) query.set('contactId', params.contactId);
    if (params.serviceKind) query.set('serviceKind', params.serviceKind);
    const qs = query.toString();
    const search = qs ? `?${qs}` : '';
    return weldbooksApi.get<{ data: SuggestedWithholdings }>(`/br-tax/withholdings/suggest${search}`);
  },
};
