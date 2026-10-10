/**
 * Test helper: a complete `StateCalcInput` with neutral defaults, so a test
 * only spells out what it is about. Not used by the engine.
 */

import type { UsStateCertificateInput } from '../../types';
import type { StateCalcInput } from './types';

export function stateInput(state: string, overrides: Partial<StateCalcInput> = {}): StateCalcInput {
  return {
    state,
    taxYear: 2026,
    payDate: '2026-03-13',
    periodStart: '2026-03-01',
    periodEnd: '2026-03-07',
    periodsPerYear: 52,
    regularWagesCents: 0,
    supplementalWagesCents: 0,
    pretax: { retirement401kCents: 0, section125Cents: 0, hsaCents: 0, dependentCareCents: 0 },
    certificate: null,
    federalW4: null,
    suiRatePercent: 2,
    extraRates: {},
    employeeCountEstimate: 100,
    ytd: {},
    residenceState: null,
    exemptFromSui: false,
    ...overrides,
  };
}

export function certificate(overrides: Partial<UsStateCertificateInput> = {}): UsStateCertificateInput {
  return { filingStatus: null, allowances: null, values: {}, extraWithholding: null, exempt: false, ...overrides };
}
