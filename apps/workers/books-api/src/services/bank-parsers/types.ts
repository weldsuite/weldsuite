export type BankFileFormat = 'mt940' | 'camt053' | 'csv' | 'ofx' | 'qfx' | 'qbo' | 'bai2';

export const BANK_FILE_FORMATS: readonly BankFileFormat[] = ['mt940', 'camt053', 'csv', 'ofx', 'qfx', 'qbo', 'bai2'];

export interface ParsedBankTransaction {
  /** Calendar date, `YYYY-MM-DD`, never shifted by a time zone. */
  date: string;
  valueDate?: string;
  description: string;
  /** Signed from the account holder's side: money in positive, money out negative (a card purchase is negative). */
  amount: number;
  runningBalance?: number;
  counterpartyName?: string;
  counterpartyIban?: string;
  counterpartyBic?: string;
  reference?: string;
  transactionCode?: string;
  checkNumber?: string;
  endToEndId?: string;
  mandateId?: string;
  /** The bank's own id for the line (OFX FITID); lines with the same id, amount and date are duplicates. */
  externalId?: string;
  rawData?: Record<string, unknown>;
}

/** The account a statement file says it belongs to. */
export interface ParsedStatementAccount {
  /** Full account number as the file carries it (some banks mask it). */
  accountNumber?: string;
  /** ABA routing number (OFX BANKID). */
  routingNumber?: string;
  /** checking | savings | credit_card | money_market | line_of_credit */
  accountType?: string;
  currency?: string;
}

export interface BankFileParseResult {
  format: BankFileFormat;
  accountIban?: string;
  /** The account the file belongs to (OFX / QFX / QBO / BAI2). */
  account?: ParsedStatementAccount;
  /** Every account section in the file; `transactions` holds the selected one. */
  accounts?: ParsedStatementAccount[];
  currency?: string;
  openingBalance?: number;
  closingBalance?: number;
  availableBalance?: number;
  /** The date the closing balance is as of. */
  balanceDate?: string;
  dateRange?: { from: string; to: string };
  transactions: ParsedBankTransaction[];
  errors: Array<{ line?: number; message: string }>;
}

/** Options every parser may use; formats that don't need one ignore it. */
export interface BankParseOptions {
  /** Original file name; its extension tells .qfx / .qbo from .ofx. */
  fileName?: string;
  /** Explicit CSV layout; required for CSV unless the file is a known Dutch bank export. */
  csvFormat?: CsvFormat;
  /** Last four digits of the bank account's number, to pick the right account out of a multi-account file. */
  accountLast4?: string;
}

export type CsvDateFormat = 'MDY' | 'DMY' | 'YMD';
export type CsvNegativeStyle = 'minus' | 'parentheses' | 'debit_credit_columns' | 'trailing_minus';

/** A CSV column: header text (when the file has a header row) or a zero-based index. */
export type CsvColumnRef = string | number;

export interface CsvFormat {
  dateFormat: CsvDateFormat;
  decimalSeparator: '.' | ',';
  thousandsSeparator: ',' | '.' | ' ' | '';
  negativeStyle: CsvNegativeStyle;
  columns: {
    date: CsvColumnRef;
    description: CsvColumnRef;
    /** One signed amount column; or `debit` + `credit` columns (negativeStyle `debit_credit_columns`). */
    amount?: CsvColumnRef;
    debit?: CsvColumnRef;
    credit?: CsvColumnRef;
    checkNumber?: CsvColumnRef;
    payee?: CsvColumnRef;
    reference?: CsvColumnRef;
  };
  hasHeader: boolean;
  /** Non-blank rows to skip before the header (bank preambles). */
  skipRows: number;
  /** Field delimiter; read from the header line when left out. */
  delimiter?: ',' | ';' | '\t' | '|';
}

/** Raised when a CSV has no known bank layout and the caller gave no explicit format. */
export class CsvFormatRequiredError extends Error {
  constructor(
    message: string,
    readonly proposal: CsvFormatProposal,
  ) {
    super(message);
    this.name = 'CsvFormatRequiredError';
  }
}

export interface CsvFormatProposal {
  format: CsvFormat;
  /** Header cells (or `Column 1…`) the columns refer to. */
  headers: string[];
  /** The first rows, split into cells, for the confirmation screen. */
  sampleRows: string[][];
  /** True when the date order could not be told from the data (every part ≤ 12); the UI should ask. */
  dateOrderAmbiguous: boolean;
  warnings: string[];
}
