/**
 * TASK-1085: on a hard reload the CRM sidebar showed only "My Tasks" plus empty
 * "Add list" / "Add pipeline" sections until the requests came back. While they
 * are pending the groups must say so (`loading`) so the sidebar draws skeleton
 * rows instead of the empty-state buttons.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { TrendingUp } from 'lucide-react';

vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (key: string) => key,
}));

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  lists: { current: { data: undefined, isPending: true } as { data: unknown; isPending: boolean } },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/api/use-app-api', () => {
  const client = { get: mocks.get, post: vi.fn() };
  const api = { getClient: () => Promise.resolve(client) };
  return { useAppApiClient: () => api };
});
vi.mock('@/hooks/queries/use-pipelines-queries', () => ({
  useCreatePipeline: () => ({ mutateAsync: vi.fn() }),
  useUpdatePipeline: () => ({ mutateAsync: vi.fn() }),
  useDeletePipeline: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@/hooks/queries/use-lists-queries', () => ({
  useLists: () => mocks.lists.current,
  useCreateList: () => ({ mutateAsync: vi.fn() }),
  useUpdateList: () => ({ mutateAsync: vi.fn() }),
  useDeleteList: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@/components/app-sidebar-layout', () => ({
  coloredSquareColors: [{ value: 'bg-blue-500' }],
  coloredSquareIcons: [{ label: 'TrendingUp', value: TrendingUp }],
}));
vi.mock('../components/pipeline-template-dialog', () => ({ PipelineTemplateDialog: () => null }));
vi.mock('../components/rename-dialog', () => ({ RenameDialog: () => null }));
vi.mock('../components/create-list-dialog', () => ({ CreateListDialog: () => null }));
vi.mock('@/components/confirm-dialog', () => ({ ConfirmDialog: () => null }));

import { useCrmSidebarItems } from './use-crm-sidebar-items';

describe('CRM sidebar loading state (TASK-1085)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lists.current = { data: undefined, isPending: true };
  });

  it('marks both groups as loading until their requests have settled', async () => {
    let finishPipelines: (value: { data: unknown[] }) => void = () => {};
    mocks.get.mockImplementation(
      () => new Promise((resolve) => { finishPipelines = resolve; }),
    );

    const { result, rerender } = renderHook(() => useCrmSidebarItems(true));
    const [lists, deals] = result.current.menuGroups;
    expect(lists!.loading).toBe(true);
    expect(deals!.loading).toBe(true);

    // Lists arrive (none yet) while pipelines are still on their way.
    mocks.lists.current = { data: { data: [] }, isPending: false };
    rerender();
    expect(result.current.menuGroups[0]!.loading).toBe(false);
    expect(result.current.menuGroups[1]!.loading).toBe(true);

    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/pipelines'));
    await act(async () => {
      finishPipelines({ data: [] });
    });
    await waitFor(() => expect(result.current.menuGroups[1]!.loading).toBe(false));
  });

  it('stops loading when the pipelines request fails, so the empty state can show', async () => {
    mocks.get.mockRejectedValue(new Error('network'));
    mocks.lists.current = { data: { data: [] }, isPending: false };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useCrmSidebarItems(true));
    await waitFor(() => expect(result.current.menuGroups[1]!.loading).toBe(false));
    consoleError.mockRestore();
  });
});
