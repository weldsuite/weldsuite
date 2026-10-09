/**
 * The jaaropgaaf: the employee's annual statement (Handboek Loonheffingen §15).
 *
 * Placeholder: the signature is the contract hr-api codes against; the
 * implementation lands with the NL engine.
 */

import type { PayrollDocument } from '../documents';
import type { NlFilingData } from '../types';

export interface NlAnnualStatementInput {
  lang: 'en' | 'nl';
  year: number;
  employer: { name: string; loonheffingennummer: string | null; address: string[] };
  employee: {
    name: string;
    bsn: string | null;
    dateOfBirth: string | null;
    address: string[];
    employmentStart: string | null;
    employmentEnd: string | null;
    personnelNumber: string | null;
  };
  /** The year's final payslips, oldest first. */
  payslips: Array<{ payDate: string; filingData: NlFilingData; ytd: Record<string, number> }>;
}

export function nlAnnualStatement(_input: NlAnnualStatementInput): PayrollDocument {
  throw new Error('Jaaropgaaf is not implemented yet');
}
