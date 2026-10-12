/**
 * A scripted stand-in for the master DB handle, for tests of services that
 * talk to tables pglite does not have (the partner tables have no migration
 * yet). Every query builder call returns a chainable that records what it was
 * given and resolves to the next scripted result:
 *
 *   select / selectDistinct   -> the next array of `selects`
 *   insert / update / delete  -> the next array of `returns` (default [])
 *
 * `calls` lists every query with its chain of builder steps
 * (`['set', [{ status: 'paid' }]]`, `['where', […]]`, …), so a test can assert
 * what was written. The scripts are consumed in the order the code runs its
 * queries.
 */

export interface FakeCall {
  op: 'select' | 'insert' | 'update' | 'delete';
  steps: Array<[string, unknown[]]>;
}

export interface FakeDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  calls: FakeCall[];
  /** The arguments of the first `.set(...)`/`.values(...)` of every write of this kind, in order. */
  written: (op: 'insert' | 'update') => unknown[];
}

export function createFakeDb(script: { selects?: unknown[][]; returns?: unknown[][] } = {}): FakeDb {
  const selects = [...(script.selects ?? [])];
  const returns = [...(script.returns ?? [])];
  const calls: FakeCall[] = [];

  const make = (op: FakeCall['op'], result: unknown[]) => {
    const call: FakeCall = { op, steps: [] };
    calls.push(call);
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              Promise.resolve(result).then(resolve, reject);
          }
          return (...args: unknown[]) => {
            call.steps.push([String(prop), args]);
            return proxy;
          };
        },
      },
    );
    return proxy;
  };

  const db = {
    select: () => make('select', selects.shift() ?? []),
    selectDistinct: () => make('select', selects.shift() ?? []),
    insert: () => make('insert', returns.shift() ?? []),
    update: () => make('update', returns.shift() ?? []),
    delete: () => make('delete', returns.shift() ?? []),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };

  return {
    db,
    calls,
    written: (op) =>
      calls
        .filter((c) => c.op === op)
        .map((c) => c.steps.find(([name]) => name === 'set' || name === 'values')?.[1][0]),
  };
}
