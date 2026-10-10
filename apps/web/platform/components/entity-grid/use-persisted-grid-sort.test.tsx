import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  readStoredGridSort,
  usePersistedGridSort,
  writeStoredGridSort,
} from './use-persisted-grid-sort';

const { replace, state } = vi.hoisted(() => ({
  replace: vi.fn(),
  state: { search: '' },
}));

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(state.search),
}));

beforeEach(() => {
  localStorage.clear();
  replace.mockReset();
  state.search = '';
});

describe('stored grid sort', () => {
  it('round-trips a sort and forgets it when cleared', () => {
    writeStoredGridSort('company', { field: 'name', direction: 'asc' });
    expect(readStoredGridSort('company')).toEqual({ sort: 'name', sortDir: 'asc' });
    expect(readStoredGridSort('person')).toBeNull();

    writeStoredGridSort('company', { field: null, direction: null });
    expect(readStoredGridSort('company')).toBeNull();
  });

  it('ignores a corrupt entry', () => {
    localStorage.setItem('weldsuite:grid-sort:company', '{nope');
    expect(readStoredGridSort('company')).toBeNull();
    localStorage.setItem('weldsuite:grid-sort:company', JSON.stringify({ field: 5 }));
    expect(readStoredGridSort('company')).toBeNull();
  });
});

describe('usePersistedGridSort', () => {
  it('uses the sort in the URL and leaves the URL alone', () => {
    state.search = 'sort=email&sortDir=desc';
    writeStoredGridSort('company', { field: 'name', direction: 'asc' });
    const { result } = renderHook(() => usePersistedGridSort('company'));
    expect(result.current).toEqual({ sort: 'email', sortDir: 'desc' });
    expect(replace).not.toHaveBeenCalled();
  });

  it('restores the remembered sort when the page opens without one, and puts it in the URL', () => {
    writeStoredGridSort('company', { field: 'name', direction: 'asc' });
    state.search = 'search=acme';
    const { result } = renderHook(() => usePersistedGridSort('company'));
    // Requested from the first render, so the first fetch is already sorted.
    expect(result.current).toEqual({ sort: 'name', sortDir: 'asc' });
    expect(replace).toHaveBeenCalledWith('?search=acme&sort=name&sortDir=asc');
  });

  it('does not bring the sort back once the user cleared it', () => {
    writeStoredGridSort('company', { field: 'name', direction: 'asc' });
    const { result, rerender } = renderHook(() => usePersistedGridSort('company'));
    expect(result.current.sort).toBe('name');

    // The URL catches up with the restored sort ...
    state.search = 'sort=name&sortDir=asc';
    rerender();
    expect(result.current.sort).toBe('name');

    // ... then the user clears it: the URL loses it and so does the page.
    writeStoredGridSort('company', { field: null, direction: null });
    state.search = '';
    rerender();
    expect(result.current).toEqual({});
  });

  it('keeps grids apart', () => {
    writeStoredGridSort('company', { field: 'name', direction: 'asc' });
    const { result } = renderHook(() => usePersistedGridSort('person'));
    expect(result.current).toEqual({});
    expect(replace).not.toHaveBeenCalled();
  });
});
