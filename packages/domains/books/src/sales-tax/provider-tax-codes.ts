/**
 * The provider engines map a line's WeldBooks tax code with the tables in
 * `jurisdictions/us/tax-codes.ts`; the factory options can inject another
 * mapper (tests, a customer with its own code scheme).
 */

import { toAvalaraTaxCode, toStripeTaxCode } from '../jurisdictions/us/tax-codes';
import type { TaxCodeMapper } from './provider-common';

export const defaultStripeTaxCode: TaxCodeMapper = (code, use) => toStripeTaxCode(code, use);
export const defaultAvalaraTaxCode: TaxCodeMapper = (code, use) => toAvalaraTaxCode(code, use);
