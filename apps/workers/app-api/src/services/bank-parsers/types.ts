export interface ParsedBankTransaction {
  date: string;
  valueDate?: string;
  description: string;
  amount: number;
  runningBalance?: number;
  counterpartyName?: string;
  counterpartyIban?: string;
  counterpartyBic?: string;
  reference?: string;
  transactionCode?: string;
  endToEndId?: string;
  mandateId?: string;
  externalId?: string;
  rawData?: Record<string, unknown>;
}

export interface BankFileParseResult {
  format: 'mt940' | 'camt053' | 'csv';
  accountIban?: string;
  openingBalance?: number;
  closingBalance?: number;
  dateRange?: { from: string; to: string };
  transactions: ParsedBankTransaction[];
  errors: Array<{ line?: number; message: string }>;
}
