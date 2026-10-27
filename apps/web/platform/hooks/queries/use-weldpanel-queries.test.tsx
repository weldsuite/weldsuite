import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { makeInstall, makeProject } from '@/app/weldpanel/test-fixtures';

const api = vi.hoisted(() => ({
  weldpanel: {
    projects: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateSettings: vi.fn(),
      remove: vi.fn(),
      rotateToken: vi.fn(),
      install: vi.fn(),
    },
  },
}));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));

import {
  INSTALL_POLL_MS,
  useCreateWeldPanelProject,
  useDeleteWeldPanelProject,
  useRotateWeldPanelToken,
  useUpdateWeldPanelProject,
  useUpdateWeldPanelProjectSettings,
  useWeldPanelInstall,
  useWeldPanelProject,
  useWeldPanelProjects,
  weldpanelKeys,
} from './use-weldpanel-queries';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const invalidated = () => invalidate.mock.calls.map(([filters]) => filters?.queryKey);
  return { client, wrapper, invalidated };
}

const projects = api.weldpanel.projects;

beforeEach(() => {
  for (const fn of Object.values(projects)) fn.mockReset();
});

describe('keys', () => {
  it('nest the install check under its project and the project under the module root', () => {
    expect(weldpanelKeys.install('wpp_1').slice(0, weldpanelKeys.project('wpp_1').length)).toEqual(weldpanelKeys.project('wpp_1'));
    expect(weldpanelKeys.project('wpp_1').slice(0, weldpanelKeys.all.length)).toEqual(weldpanelKeys.all);
    // The list is not under any project, so a project refetch does not refetch the list.
    expect(weldpanelKeys.projectList().slice(0, weldpanelKeys.project('wpp_1').length)).not.toEqual(weldpanelKeys.project('wpp_1'));
  });
});

describe('queries', () => {
  it('lists the projects as plain data', async () => {
    projects.list.mockResolvedValue({ data: [makeProject()], pagination: { totalCount: 1, hasMore: false, cursor: null } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useWeldPanelProjects(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([makeProject()]));
  });

  it('does not fetch a project without an id', () => {
    const { wrapper } = setup();
    renderHook(() => useWeldPanelProject(''), { wrapper });
    expect(projects.get).not.toHaveBeenCalled();
  });

  describe('install check', () => {
    function pollFor(data: unknown) {
      projects.install.mockResolvedValue({ data: makeInstall() });
      const { wrapper, client } = setup();
      renderHook(() => useWeldPanelInstall('wpp_1'), { wrapper });
      const observer = client.getQueryCache().find({ queryKey: weldpanelKeys.install('wpp_1') })!.observers[0]!;
      const interval = observer.options.refetchInterval as (query: unknown) => number | false;
      return interval({ state: { data } });
    }

    it('polls every 10 seconds while no event has arrived', () => {
      expect(INSTALL_POLL_MS).toBe(10_000);
      expect(pollFor({ data: makeInstall({ status: 'waiting' }) })).toBe(10_000);
    });

    it('stops polling once events arrive', () => {
      expect(pollFor({ data: makeInstall({ status: 'receiving' }) })).toBe(false);
    });

    it('is kept out of the persisted cache', () => {
      projects.install.mockResolvedValue({ data: makeInstall() });
      const { wrapper, client } = setup();
      renderHook(() => useWeldPanelInstall('wpp_1'), { wrapper });
      expect(client.getQueryCache().find({ queryKey: weldpanelKeys.install('wpp_1') })!.meta).toEqual({ persist: false });
    });

    it('stays quiet when disabled', () => {
      const { wrapper } = setup();
      renderHook(() => useWeldPanelInstall('wpp_1', false), { wrapper });
      expect(projects.install).not.toHaveBeenCalled();
    });
  });
});

describe('mutations', () => {
  it('create puts the project in the cache and refreshes the list', async () => {
    const created = makeProject({ id: 'wpp_new' });
    projects.create.mockResolvedValue({ data: created });
    const { wrapper, client, invalidated } = setup();
    const { result } = renderHook(() => useCreateWeldPanelProject(), { wrapper });

    await result.current.mutateAsync({ name: 'Docs' });

    expect(projects.create).toHaveBeenCalledWith({ name: 'Docs' });
    expect(client.getQueryData(weldpanelKeys.project('wpp_new'))).toEqual({ data: created });
    expect(invalidated()).toContainEqual(weldpanelKeys.projectList());
  });

  it('update and updateSettings go to their own calls and store the result', async () => {
    const changed = makeProject({ name: 'Renamed' });
    projects.update.mockResolvedValue({ data: changed });
    projects.updateSettings.mockResolvedValue({ data: changed });
    const { wrapper, client, invalidated } = setup();

    const update = renderHook(() => useUpdateWeldPanelProject('wpp_1'), { wrapper });
    await update.result.current.mutateAsync({ name: 'Renamed' });
    expect(projects.update).toHaveBeenCalledWith('wpp_1', { name: 'Renamed' });

    const settings = renderHook(() => useUpdateWeldPanelProjectSettings('wpp_1'), { wrapper });
    await settings.result.current.mutateAsync({ status: 'paused' });
    expect(projects.updateSettings).toHaveBeenCalledWith('wpp_1', { status: 'paused' });

    expect(client.getQueryData(weldpanelKeys.project('wpp_1'))).toEqual({ data: changed });
    expect(invalidated()).toContainEqual(weldpanelKeys.projectList());
  });

  it('rotating the token also refreshes the install check, whose snippets carry it', async () => {
    projects.rotateToken.mockResolvedValue({ data: makeProject({ token: 'wpk_new' }) });
    const { wrapper, client, invalidated } = setup();
    const { result } = renderHook(() => useRotateWeldPanelToken('wpp_1'), { wrapper });

    await result.current.mutateAsync();

    expect(projects.rotateToken).toHaveBeenCalledWith('wpp_1');
    expect(client.getQueryData<{ data: { token: string } }>(weldpanelKeys.project('wpp_1'))?.data.token).toBe('wpk_new');
    expect(invalidated()).toContainEqual(weldpanelKeys.install('wpp_1'));
  });

  it('delete drops the project and its install check from the cache and refreshes the list', async () => {
    projects.remove.mockResolvedValue(undefined);
    const { wrapper, client, invalidated } = setup();
    client.setQueryData(weldpanelKeys.project('wpp_1'), { data: makeProject() });
    client.setQueryData(weldpanelKeys.install('wpp_1'), { data: makeInstall() });
    const { result } = renderHook(() => useDeleteWeldPanelProject(), { wrapper });

    await result.current.mutateAsync('wpp_1');

    expect(projects.remove).toHaveBeenCalledWith('wpp_1');
    expect(client.getQueryData(weldpanelKeys.project('wpp_1'))).toBeUndefined();
    expect(client.getQueryData(weldpanelKeys.install('wpp_1'))).toBeUndefined();
    expect(invalidated()).toContainEqual(weldpanelKeys.projectList());
  });
});
