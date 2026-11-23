import { describe, expect, it } from 'vitest';
import { recordTypeScriptLedgerCalls } from './ledger-bridge';

type Stub = Record<string, (...args: unknown[]) => Promise<unknown>>;
type Namespace = { idFromName(name: string): unknown; get(id: unknown): Stub; calls?: Record<string, unknown[]> };

/** A fake `OUTBOUND_LEDGER` that logs its calls, on itself when `exposeLog`. */
function fakeLedger(exposeLog: boolean) {
  const calls = { reserve: [] as unknown[][], commit: [] as unknown[][] };
  const stub: Stub = {
    reserve: async (...args) => {
      calls.reserve.push(args);
      return { allow: true };
    },
    commit: async (...args) => {
      calls.commit.push(args);
    },
  };
  const namespace: Namespace = { idFromName: (name) => name, get: () => stub };
  if (exposeLog) namespace.calls = calls;
  return { namespace, calls };
}

/** One TypeScript run through the wrapped env: a reserve, then a commit. */
async function run(env: Record<string, unknown>) {
  const ns = env.OUTBOUND_LEDGER as Namespace;
  const stub = ns.get(ns.idFromName('ws_1'));
  expect(await stub.reserve!('ws_1', ['a@example.com'])).toEqual({ allow: true });
  await stub.commit!('res_1', ['a@example.com']);
}

describe('recordTypeScriptLedgerCalls', () => {
  it('records the run and drops its entries from a call log the fake keeps on itself', async () => {
    const { namespace, calls } = fakeLedger(true);
    calls.reserve.push(['earlier']);
    const recorded = recordTypeScriptLedgerCalls({ OUTBOUND_LEDGER: namespace });
    await run(recorded.env);
    expect(calls.reserve).toHaveLength(2);

    const seen = recorded.finish();
    expect(seen.map((call) => [call.binding, call.name, call.method])).toEqual([
      ['OUTBOUND_LEDGER', 'ws_1', 'reserve'],
      ['OUTBOUND_LEDGER', 'ws_1', 'commit'],
    ]);
    // What the test logged before the run stays; the run's own calls go.
    expect(calls.reserve).toEqual([['earlier']]);
    expect(calls.commit).toEqual([]);
  });

  it('leaves a fake without a call log on itself as it is', async () => {
    const { namespace, calls } = fakeLedger(false);
    const recorded = recordTypeScriptLedgerCalls({ OUTBOUND_LEDGER: namespace });
    await run(recorded.env);
    expect(recorded.finish()).toHaveLength(2);
    expect(calls.reserve).toHaveLength(1);
  });

  it('wraps nothing when no ledger is bound', () => {
    const env = { OTHER: 1 };
    const recorded = recordTypeScriptLedgerCalls(env);
    expect(recorded.env).toBe(env);
    expect(recorded.finish()).toEqual([]);
  });
});
