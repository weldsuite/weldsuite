import { describe, expect, it } from 'vitest';
import { applyVisibleOrder, rememberAppCodes, sortByAppOrder } from './app-rail-order';

const apps = (...codes: string[]) => codes.map((appCode) => ({ appCode }));
const codes = (list: { appCode: string }[]) => list.map((a) => a.appCode);

describe('app rail order', () => {
  it('puts a reinstalled app back in its old slot', () => {
    let known = rememberAppCodes([], ['weldcrm', 'weldcall', 'weldmail']);
    // Uninstall WeldCall: it disappears from the visible list but keeps its slot.
    known = rememberAppCodes(known, ['weldcrm', 'weldmail']);
    expect(codes(sortByAppOrder(apps('weldcrm', 'weldmail'), known))).toEqual(['weldcrm', 'weldmail']);
    // Reinstall: the server may now list it last.
    known = rememberAppCodes(known, ['weldcrm', 'weldmail', 'weldcall']);
    expect(codes(sortByAppOrder(apps('weldcrm', 'weldmail', 'weldcall'), known))).toEqual([
      'weldcrm',
      'weldcall',
      'weldmail',
    ]);
  });

  it('inserts a brand-new app after its predecessor in the server order', () => {
    const known = rememberAppCodes(['weldcrm', 'weldmail'], ['weldcrm', 'weldchat', 'weldmail']);
    expect(known).toEqual(['weldcrm', 'weldchat', 'weldmail']);
    expect(rememberAppCodes(['weldmail'], ['weldcrm', 'weldmail'])).toEqual(['weldcrm', 'weldmail']);
  });

  it('keeps hidden apps in their slots when the visible ones are dragged', () => {
    const known = ['weldcrm', 'weldcall', 'weldmail', 'weldchat'];
    // WeldCall is uninstalled; the user drags WeldChat to the top.
    const next = applyVisibleOrder(known, ['weldchat', 'weldcrm', 'weldmail']);
    expect(next).toEqual(['weldchat', 'weldcall', 'weldcrm', 'weldmail']);
  });

  it('leaves apps without a known position at the end in their own order', () => {
    expect(codes(sortByAppOrder(apps('b', 'x', 'a', 'y'), ['a', 'b']))).toEqual(['a', 'b', 'x', 'y']);
  });
});
