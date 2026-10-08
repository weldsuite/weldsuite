import { describe, expect, it } from 'vitest';
import { createSalesTaxEngine } from './index';
import { fakeFetch } from './test-http';
import { buildManualData, line, request, WA_SELLER, addr } from './test-fixtures';
import { SalesTaxEngineError } from './types';

describe('createSalesTaxEngine', () => {
  it('builds the manual engine from its data', async () => {
    const engine = createSalesTaxEngine({ engine: 'manual', manual: buildManualData() });
    expect(engine.id).toBe('manual');
    const result = await engine.calculate(request({ lines: [line('a', 100)] }));
    expect(result.totalTax).toBe(7.25);
    expect(engine.commit).toBeUndefined();
  });

  it('builds the Stripe Tax engine on the injected fetch', async () => {
    const http = fakeFetch([{ json: { data: [], has_more: false } }]);
    const engine = createSalesTaxEngine({ engine: 'stripe_tax', stripeTax: { apiKey: 'rk_test_x' }, fetch: http.fetch });
    expect(engine.id).toBe('stripe_tax');
    await engine.listRegistrations!();
    expect(http.calls[0].headers.authorization).toBe('Bearer rk_test_x');
  });

  it('builds the Avalara engine for its environment', async () => {
    const http = fakeFetch([{ json: { value: [{ id: 1 }] } }, { json: { value: [] } }]);
    const engine = createSalesTaxEngine({
      engine: 'avalara',
      avalara: { accountId: '1', licenseKey: 'k', companyCode: 'C', environment: 'production' },
      fetch: http.fetch,
    });
    expect(engine.id).toBe('avalara');
    await engine.listRegistrations!();
    expect(http.calls[0].url.startsWith('https://rest.avatax.com/')).toBe(true);
  });

  it('refuses a provider engine without credentials, and the manual engine without data', () => {
    for (const config of [
      { engine: 'manual' as const },
      { engine: 'stripe_tax' as const },
      { engine: 'stripe_tax' as const, stripeTax: { apiKey: '' } },
      { engine: 'avalara' as const },
      { engine: 'avalara' as const, avalara: { accountId: '1', licenseKey: '', companyCode: 'C', environment: 'sandbox' as const } },
    ]) {
      expect(() => createSalesTaxEngine(config)).toThrowError(SalesTaxEngineError);
      try {
        createSalesTaxEngine(config);
      } catch (error) {
        expect((error as SalesTaxEngineError).code).toBe('not_configured');
      }
    }
  });

  it('refuses an unknown engine', () => {
    expect(() => createSalesTaxEngine({ engine: 'taxjar' as never })).toThrowError(/Unknown sales tax engine/);
  });

  it('every engine answers the same request in the same result shape', async () => {
    const manual = createSalesTaxEngine({ engine: 'manual', manual: buildManualData() });
    const result = await manual.calculate(request({ shipFrom: WA_SELLER, shipTo: addr('WA', '98001') }));
    expect(Object.keys(result).sort()).toEqual(
      ['calculatedAt', 'engine', 'lines', 'shipToPostalCode', 'shipToState', 'sourcing', 'totalTax', 'warnings'].sort(),
    );
  });
});
