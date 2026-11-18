import { StrictMode, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CREATE_INTENT_PARAM, useCreateIntent, withCreateIntent } from './use-create-intent';

const navigate = vi.fn();
let search: Record<string, unknown> = {};

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => search,
  useNavigate: () => navigate,
}));

const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;

describe('useCreateIntent', () => {
  beforeEach(() => {
    navigate.mockReset();
    search = {};
  });

  it('fires once for ?new=1, even under StrictMode', () => {
    search = { [CREATE_INTENT_PARAM]: '1' };
    const onCreate = vi.fn();
    const { rerender } = renderHook(() => useCreateIntent(onCreate), { wrapper: strict });
    rerender();
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('accepts the numeric 1 the router parses from ?new=1', () => {
    search = { [CREATE_INTENT_PARAM]: 1 };
    const onCreate = vi.fn();
    renderHook(() => useCreateIntent(onCreate));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('does not fire without the param or for another kind', () => {
    const onCreate = vi.fn();
    const { rerender } = renderHook(() => useCreateIntent(onCreate, { kind: 'dm' }));
    expect(onCreate).not.toHaveBeenCalled();
    search = { [CREATE_INTENT_PARAM]: 'channel' };
    rerender();
    expect(onCreate).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    search = { [CREATE_INTENT_PARAM]: 'dm' };
    rerender();
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('waits for ready and keeps the param until then', () => {
    search = { [CREATE_INTENT_PARAM]: '1' };
    const onCreate = vi.fn();
    const { rerender } = renderHook(({ ready }) => useCreateIntent(onCreate, { ready }), {
      initialProps: { ready: false },
    });
    expect(onCreate).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    rerender({ ready: true });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('drops the param with a replace navigation', () => {
    search = { [CREATE_INTENT_PARAM]: '1', folderId: 'f1' };
    renderHook(() => useCreateIntent(vi.fn()));
    const arg = navigate.mock.calls[0]![0] as {
      to: string;
      replace: boolean;
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(arg.replace).toBe(true);
    expect(arg.to).toBe('.');
    expect(arg.search({ folderId: 'f1', [CREATE_INTENT_PARAM]: '1' })).toEqual({
      folderId: 'f1',
      [CREATE_INTENT_PARAM]: undefined,
    });
  });

  it('fires again after the param went away and came back', () => {
    const onCreate = vi.fn();
    search = { [CREATE_INTENT_PARAM]: '1' };
    const { rerender } = renderHook(() => useCreateIntent(onCreate));
    expect(onCreate).toHaveBeenCalledTimes(1);
    search = {};
    act(() => rerender());
    search = { [CREATE_INTENT_PARAM]: '1' };
    rerender();
    expect(onCreate).toHaveBeenCalledTimes(2);
  });
});

describe('withCreateIntent', () => {
  it('appends the param to a plain or queried href', () => {
    expect(withCreateIntent('/welddocs')).toBe('/welddocs?new=1');
    expect(withCreateIntent('/weldchat', 'dm')).toBe('/weldchat?new=dm');
    expect(withCreateIntent('/x?a=1')).toBe('/x?a=1&new=1');
  });
});
