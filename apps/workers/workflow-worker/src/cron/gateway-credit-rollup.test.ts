import { describe, expect, it } from 'vitest';
import { runGatewayCreditRollup } from './gateway-credit-rollup';

describe('runGatewayCreditRollup', () => {
  it('does not open the master database on test', async () => {
    const rolled = await runGatewayCreditRollup({
      ENVIRONMENT: 'test',
      // A real URL would be queried on any other environment. Reaching neon()
      // here would throw or hang; returning 0 means the guard held.
      DATABASE_URL_MASTER: 'postgres://master.example/weldsuite',
    });

    expect(rolled).toBe(0);
  });

  it('skips when the master URL is unset', async () => {
    expect(await runGatewayCreditRollup({ ENVIRONMENT: 'production' })).toBe(0);
  });
});
