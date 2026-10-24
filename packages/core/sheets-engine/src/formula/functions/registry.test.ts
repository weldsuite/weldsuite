import { describe, expect, it } from 'vitest';
import { datetimeFunctions } from './datetime';
import { financialFunctions } from './financial';
import { functionNames } from './index';
import { infoFunctions } from './info';
import { logicalFunctions } from './logical';
import { lookupFunctions } from './lookup';
import { mathFunctions } from './math';
import { statsFunctions } from './stats';
import { textFunctions } from './text';

describe('function registry', () => {
  it('has no function defined by two families', () => {
    const all = [
      ...mathFunctions,
      ...statsFunctions,
      ...logicalFunctions,
      ...infoFunctions,
      ...textFunctions,
      ...datetimeFunctions,
      ...lookupFunctions,
      ...financialFunctions,
    ].map((f) => f.name.toUpperCase());
    expect(all.filter((n, i) => all.indexOf(n) !== i)).toEqual([]);
    expect(functionNames()).toHaveLength(all.length);
  });

  it('declares sane argument counts', () => {
    for (const fns of [mathFunctions, statsFunctions, textFunctions, lookupFunctions, datetimeFunctions, financialFunctions]) {
      for (const f of fns) {
        expect(f.minArgs, f.name).toBeGreaterThanOrEqual(0);
        expect(f.maxArgs, f.name).toBeGreaterThanOrEqual(f.minArgs);
      }
    }
  });
});
