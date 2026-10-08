/**
 * The sales tax engine (docs/plans/weldbooks-us.md §3). `createSalesTaxEngine`
 * returns the engine an entity is configured for; `load.ts` builds that
 * config from the tenant DB, `to-tax-lines.ts` turns a result into what a
 * posted document stores.
 */

import { createAvalaraEngine } from './avalara';
import { createManualEngine } from './manual-engine';
import { createStripeTaxEngine } from './stripe-tax';
import { SalesTaxEngineError, type SalesTaxEngine, type SalesTaxEngineConfig } from './types';

export * from './types';
export { createManualEngine, type ManualEngineOptions } from './manual-engine';
export { createStripeTaxEngine, STRIPE_TAX_API_VERSION, type StripeTaxOptions } from './stripe-tax';
export { createAvalaraEngine, AVALARA_ENTITY_USE_CODE, type AvalaraOptions } from './avalara';
export { resolveExemptionCertificate, certificateExpiry, missingCertificateCureDeadline } from './exemptions';
export type { CertificateResolution, CertificateFailure } from './exemptions';
export { decideSourcing, stateCodeOf, zip5Of, type SourcingDecision } from './sourcing';
export {
  DEFAULT_ROUNDING,
  allocateCents,
  fromCents,
  roundHalfUp,
  roundTaxCells,
  toCents,
  type TaxCell,
} from './rounding';
export {
  breakdownTaxTotal,
  breakdownToTaxLineFields,
  reverseResultForCreditMemo,
  salesTaxResultToBreakdown,
  salesTaxResultToTaxLines,
  type SalesTaxLineFields,
  type TaxLineContext,
  type TaxLineFieldsContext,
} from './to-tax-lines';
export type { TaxCodeMapper } from './provider-common';

export function createSalesTaxEngine(config: SalesTaxEngineConfig): SalesTaxEngine {
  switch (config.engine) {
    case 'manual':
      if (!config.manual) {
        throw new SalesTaxEngineError('The manual engine has no rates or zones loaded', 'not_configured');
      }
      return createManualEngine(config.manual);
    case 'stripe_tax':
      if (!config.stripeTax?.apiKey) {
        throw new SalesTaxEngineError('The Stripe Tax engine needs an API key', 'not_configured');
      }
      return createStripeTaxEngine({ apiKey: config.stripeTax.apiKey, fetch: config.fetch });
    case 'avalara': {
      const a = config.avalara;
      if (!a?.accountId || !a.licenseKey || !a.companyCode) {
        throw new SalesTaxEngineError('The Avalara engine needs an account id, a license key and a company code', 'not_configured');
      }
      return createAvalaraEngine({ ...a, fetch: config.fetch });
    }
    default:
      throw new SalesTaxEngineError(`Unknown sales tax engine "${String(config.engine)}"`, 'not_configured');
  }
}
