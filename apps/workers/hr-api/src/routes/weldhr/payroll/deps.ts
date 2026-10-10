/**
 * Builds the payroll services' dependencies from a request: the real engines
 * and PDF renderer, R2, the WeldBooks service binding, the billing meter and
 * the (optional) Digipoort gateway.
 */

import { keyringFromEnv } from '@weldsuite/db/lib/crypto';
import { getMasterDb, getWorkspaceForOrg } from '@weldsuite/worker-kit/db';
import { createBooksBridge, defaultEngines, defaultPdf, type PayrollDeps } from '../../../services/weldhr/payroll/deps';
import { createDigipoortGateway } from '../../../services/weldhr/payroll/digipoort';
import { digipoortAvailable } from '../../../services/weldhr/payroll/filings';
import { createPayrollNotifier } from '../../../services/weldhr/payroll/notifier';
import { writeUsageEvents } from '../../../services/weldhr/payroll/usage';
import { flagOn } from './flag';
import { workspaceIdOf, type HrContext } from '../helpers';

export function payrollDeps(c: HrContext): PayrollDeps {
  const workspaceKey = workspaceIdOf(c);
  const deps: PayrollDeps = {
    engines: defaultEngines,
    pdf: defaultPdf,
    keyring: keyringFromEnv(c.env),
    bucket: c.env.STORAGE ?? null,
    workspaceKey,
    // The billing ledger keys on the master workspace id; the Clerk org id is the fallback.
    usageWorkspaceId: async () => {
      try {
        return (await getWorkspaceForOrg(c.env, workspaceKey)).id;
      } catch {
        return workspaceKey;
      }
    },
    books: createBooksBridge(c.env.BOOKS_INTERNAL),
    meter: (events) => writeUsageEvents(getMasterDb(c.env), events),
    digipoort: createDigipoortGateway(c.env),
    nlSoftwareRelationNumber: c.env.NL_SOFTWARE_RELATION_NUMBER ?? null,
    notifier: createPayrollNotifier(c),
    now: () => new Date(),
  };
  return { ...deps, ...(c.get('payrollDepsOverride') ?? {}) };
}

/** Whether the loonaangifte can be sent from WeldSuite: the Digipoort flag is on and a connection is configured. */
export async function sendingAvailable(c: HrContext): Promise<{ flagOn: boolean; available: boolean }> {
  const on = await flagOn(c, 'weldhr-payroll-digipoort');
  return { flagOn: on, available: digipoortAvailable(on, payrollDeps(c)) };
}
