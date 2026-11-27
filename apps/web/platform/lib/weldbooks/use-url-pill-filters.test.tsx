import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ActiveFilter } from '@/components/entity-list';

const url = vi.hoisted(() => ({ search: '', replace: vi.fn() }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ replace: url.replace, push: vi.fn() }),
  usePathname: () => '/weldbooks/invoices',
  useSearchParams: () => new URLSearchParams(url.search),
}));

import { useUrlParam } from './use-url-param';
import { useUrlPillFilters } from './use-url-pill-filters';

const FIELDS = ['status', 'show'] as const;
const ALLOWED = { status: ['draft', 'sent', 'overdue'], show: ['open', 'overdue'] };

const pill = (field: string, value: string, operator = 'is', id = `p_${field}`): ActiveFilter => ({ id, field, operator, value });

beforeEach(() => {
  url.search = '';
  url.replace.mockReset();
});

describe('useUrlPillFilters', () => {
  it('has no filter when the address carries none', () => {
    const { result } = renderHook(() => useUrlPillFilters(FIELDS, ALLOWED));
    expect(result.current.activeFilters).toEqual([]);
  });

  it('reads a finished pill from each filter parameter', () => {
    url.search = 'status=sent&show=open';
    const { result } = renderHook(() => useUrlPillFilters(FIELDS, ALLOWED));
    expect(result.current.activeFilters.map((f) => [f.field, f.operator, f.value])).toEqual([
      ['status', 'is', 'sent'],
      ['show', 'is', 'open'],
    ]);
  });

  it('ignores a value the list does not offer, so a mistyped link shows everything', () => {
    url.search = 'status=bogus&show=open';
    const { result } = renderHook(() => useUrlPillFilters(FIELDS, ALLOWED));
    expect(result.current.activeFilters.map((f) => f.field)).toEqual(['show']);
  });

  it('writes a chosen value to the address, replacing the history entry, and keeps the panel stack', () => {
    url.search = 'stack=bill:bil_1';
    const { result } = renderHook(() => useUrlPillFilters(FIELDS, ALLOWED));
    act(() => result.current.onFiltersChange([pill('status', 'overdue')]));
    expect(url.replace).toHaveBeenCalledTimes(1);
    const target = new URL(url.replace.mock.calls[0]![0] as string, 'http://x');
    expect(target.pathname).toBe('/weldbooks/invoices');
    expect(target.searchParams.get('status')).toBe('overdue');
    expect(target.searchParams.get('stack')).toBe('bill:bil_1');
  });

  it('removes the parameter when the pill is taken away, and leaves a bare path when nothing remains', () => {
    url.search = 'status=sent';
    const { result } = renderHook(() => useUrlPillFilters(FIELDS, ALLOWED));
    act(() => result.current.onFiltersChange([]));
    expect(url.replace).toHaveBeenCalledWith('/weldbooks/invoices');
  });

  it('does not rewrite the address when nothing it carries changed', () => {
    url.search = 'status=sent';
    const { result } = renderHook(() => useUrlPillFilters(FIELDS, ALLOWED));
    act(() => result.current.onFiltersChange([pill('status', 'sent', 'is', 'url:status')]));
    expect(url.replace).not.toHaveBeenCalled();
  });

  it('keeps an unfinished or negated pill in state, not in the address', () => {
    const { result, rerender } = renderHook(() => useUrlPillFilters(FIELDS, ALLOWED));
    act(() => result.current.onFiltersChange([pill('status', '', 'is', 'new'), pill('show', 'open', 'is not', 'neg')]));
    expect(url.replace).not.toHaveBeenCalled();
    rerender();
    expect(result.current.activeFilters.map((f) => [f.field, f.operator, f.value])).toEqual([
      ['status', 'is', ''],
      ['show', 'is not', 'open'],
    ]);
  });

  it('follows the address when a link changes it while the list is open', () => {
    const { result, rerender } = renderHook(() => useUrlPillFilters(FIELDS, ALLOWED));
    expect(result.current.activeFilters).toEqual([]);
    url.search = 'show=overdue';
    rerender();
    expect(result.current.activeFilters.map((f) => [f.field, f.value])).toEqual([['show', 'overdue']]);
  });
});

describe('useUrlParam', () => {
  it('reads an allowed value and treats any other as unset', () => {
    url.search = 'role=supplier';
    const { result, rerender } = renderHook(() => useUrlParam('role', ['customer', 'supplier'] as const));
    expect(result.current[0]).toBe('supplier');
    url.search = 'role=nobody';
    rerender();
    expect(result.current[0]).toBeUndefined();
  });

  it('writes the value with a replace, keeping the other parameters, and clears it for undefined', () => {
    url.search = 'stack=weldbooks_contact:prt_1&role=customer';
    const { result } = renderHook(() => useUrlParam('role', ['customer', 'supplier'] as const));
    act(() => result.current[1]('supplier'));
    const target = new URL(url.replace.mock.calls[0]![0] as string, 'http://x');
    expect(target.searchParams.get('role')).toBe('supplier');
    expect(target.searchParams.get('stack')).toBe('weldbooks_contact:prt_1');
    act(() => result.current[1](undefined));
    const cleared = new URL(url.replace.mock.calls[1]![0] as string, 'http://x');
    expect(cleared.searchParams.has('role')).toBe(false);
    expect(cleared.searchParams.get('stack')).toBe('weldbooks_contact:prt_1');
  });
});
