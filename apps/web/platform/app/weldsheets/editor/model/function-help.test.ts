import { describe, expect, it } from 'vitest';
import { functionNames, getFunction } from '@weldsuite/sheets-engine';
import { weldsheetsFunctions as en, type SheetFunctionHelp } from '@weldsuite/i18n/locales/en/weldsheets-functions';
import { weldsheetsFunctions as nl } from '@weldsuite/i18n/locales/nl/weldsheets-functions';
import { argumentCounts } from './formula-edit';

/** Functions taking this many arguments or more are listed with a repeating "…". */
const VARIADIC = 250;

describe.each([
  ['en', en],
  ['nl', nl],
] as const)('function help (%s)', (_locale, help: Record<string, SheetFunctionHelp>) => {
  it('describes every function the engine has, and only those', () => {
    expect(Object.keys(help).sort()).toEqual(functionNames());
  });

  it.each(functionNames())('%s lists the arguments the engine takes', (name) => {
    const spec = getFunction(name)!;
    const [args, description] = help[name]!;
    const counts = argumentCounts(args);
    expect(description.trim()).not.toBe('');
    expect(counts.required).toBe(spec.minArgs);
    if (counts.repeats) expect(spec.maxArgs).toBeGreaterThanOrEqual(VARIADIC);
    else expect(counts.total).toBe(spec.maxArgs);
  });
});

describe('help in nl', () => {
  it('has the same argument layout as en', () => {
    for (const name of functionNames()) {
      const a = argumentCounts((en as Record<string, SheetFunctionHelp>)[name]![0]);
      const b = argumentCounts((nl as Record<string, SheetFunctionHelp>)[name]![0]);
      expect(b, name).toEqual(a);
    }
  });
});
