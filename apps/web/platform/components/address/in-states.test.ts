import { describe, expect, it } from 'vitest';
import { GST_SELECTABLE_STATES } from '../../../../../packages/domains/books/src/jurisdictions/in/states';
import { IN_STATES, findInState, toInStateName } from './in-states';

describe('in-states mirror of the books domain', () => {
  it('lists the same states with the same GST codes', () => {
    expect(IN_STATES).toEqual(GST_SELECTABLE_STATES.map(({ code, name, abbr }) => ({ code, name, abbr })));
  });

  it('finds a state by name, GST code or ISO suffix', () => {
    expect(findInState('Maharashtra')?.code).toBe('27');
    expect(findInState(' karnataka ')?.code).toBe('29');
    expect(findInState('29')?.name).toBe('Karnataka');
    expect(findInState('MH')?.code).toBe('27');
    expect(findInState('IN-TN')?.code).toBe('33');
    expect(findInState('Atlantis')).toBeUndefined();
  });

  it('turns an older free-text state into the name the picker stores', () => {
    expect(toInStateName('MH')).toBe('Maharashtra');
    expect(toInStateName('Somewhere')).toBe('Somewhere');
    expect(toInStateName(undefined)).toBe('');
  });
});
