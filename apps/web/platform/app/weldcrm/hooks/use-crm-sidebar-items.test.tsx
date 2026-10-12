/**
 * TASK-1087: the CRM sidebar's pipeline section.
 *  - toasts said "Deal created" / "Deal deleted" for a pipeline
 *  - the order flipped on reload (newest-first API, in-session creates appended)
 *  - an imported pipeline had exactly the original's name
 *  - a duplicate got a different icon than the original
 *  - the delete dialog said "has 0 deals. They will stay in your CRM…"
 *
 * Real English copy (not keys), so a wrong sentence fails the test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Handshake, Target, TrendingUp } from 'lucide-react';

vi.mock('@weldsuite/i18n/client', async () => {
  const { createTranslator } = await import('@weldsuite/i18n');
  const { en } = await import('@weldsuite/i18n/locales/en');
  const t = createTranslator(en as unknown as Record<string, unknown>);
  return { useTranslations: () => t };
});

const mocks = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  push: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  createPipeline: vi.fn(),
  createListDialogProps: [] as Record<string, unknown>[],
}));

vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/hooks/use-is-app-installed', () => ({ useIsAppInstalled: () => true }));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: mocks.push }) }));
// Stable references: the hook re-runs its fetch effects when these change.
vi.mock('@/lib/api/use-app-api', () => {
  const client = { get: mocks.get, post: mocks.post };
  const api = { getClient: async () => client };
  return { useAppApiClient: () => api };
});
vi.mock('@/hooks/queries/use-pipelines-queries', () => ({
  useCreatePipeline: () => ({ mutateAsync: mocks.createPipeline }),
  useUpdatePipeline: () => ({ mutateAsync: vi.fn() }),
  useDeletePipeline: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('@/hooks/queries/use-lists-queries', () => {
  const lists = { data: { data: [] } };
  return {
  useLists: () => lists,
  useCreateList: () => ({ mutateAsync: vi.fn() }),
  useUpdateList: () => ({ mutateAsync: vi.fn() }),
  useDeleteList: () => ({ mutateAsync: vi.fn() }),
  };
});
vi.mock('@/components/app-sidebar-layout', () => ({
  coloredSquareColors: [{ value: 'bg-blue-500' }],
  coloredSquareIcons: [
    { label: 'TrendingUp', value: TrendingUp },
    { label: 'Handshake', value: Handshake },
    { label: 'Target', value: Target },
  ],
}));
vi.mock('../components/pipeline-template-dialog', () => ({ PipelineTemplateDialog: () => null }));
vi.mock('../components/rename-dialog', () => ({ RenameDialog: () => null }));
vi.mock('../components/create-list-dialog', () => ({
  CreateListDialog: (props: Record<string, unknown>) => {
    mocks.createListDialogProps.push(props);
    return null;
  },
}));
vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: ({
    open,
    description,
    onConfirm,
  }: {
    open: boolean;
    description: string;
    onConfirm: () => void;
  }) =>
    open ? (
      <div>
        <p data-testid="confirm-description">{description}</p>
        <button type="button" onClick={onConfirm}>
          confirm
        </button>
      </div>
    ) : null,
}));

import { useCrmSidebarItems } from './use-crm-sidebar-items';

const pipelines = [
  { id: 'pl_a', name: 'Sales E2E', icon: 'Handshake', color: 'bg-green-500', createdAt: '2026-10-08T10:00:01.000Z' },
  { id: 'pl_b', name: 'QA Verify Pipeline', icon: 'Target', color: 'bg-red-500', createdAt: '2026-10-08T10:00:02.000Z' },
];

function pipelineMenu(result: { current: ReturnType<typeof useCrmSidebarItems> }) {
  return result.current.menuGroups.find((group) => group.items.some((item) => item.href?.includes('/pipeline/')))
    ?? result.current.menuGroups[1]!;
}

async function renderSidebar() {
  const view = renderHook(() => useCrmSidebarItems(true));
  await waitFor(() => expect(pipelineMenu(view.result).items.length).toBeGreaterThan(0));
  return view;
}

describe('CRM sidebar pipelines (TASK-1087)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createListDialogProps.length = 0;
    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/pipelines') return { data: [...pipelines].reverse() };
      if (path.startsWith('/pipelines/')) {
        return { data: pipelines.find((p) => path.endsWith(p.id)) };
      }
      if (path.startsWith('/pipeline-stages')) return { data: [] };
      if (path.startsWith('/opportunities')) return { pagination: { totalCount: 0 } };
      return { data: [] };
    });
    mocks.post.mockResolvedValue({});
    mocks.createPipeline.mockImplementation(async (input: Record<string, unknown>) => ({
      id: 'pl_new',
      name: input.name,
      icon: input.icon,
      color: input.color,
    }));
  });

  it('lists pipelines oldest first even when the API sends them newest first', async () => {
    const { result } = await renderSidebar();
    expect(pipelineMenu(result).items.map((item) => item.title)).toEqual(['Sales E2E', 'QA Verify Pipeline']);
  });

  it('says "Pipeline created", not "Deal created", when a pipeline is created', async () => {
    const { result } = await renderSidebar();
    render(<>{result.current.dialogs}</>);
    const { onCreateList } = mocks.createListDialogProps.find((props) => props.title === 'Create new pipeline') as {
      onCreateList: (name: string, color: string, icon: typeof Handshake) => Promise<void>;
    };

    await act(async () => {
      await onCreateList('Fresh pipeline', 'bg-blue-500', Target);
    });

    expect(mocks.toast.success).toHaveBeenCalledWith('Pipeline created');
    expect(mocks.toast.success).not.toHaveBeenCalledWith('Deal created');
    // Appended after the existing ones: the same place a reload puts it.
    expect(pipelineMenu(result).items.map((item) => item.title)).toEqual([
      'Sales E2E',
      'QA Verify Pipeline',
      'Fresh pipeline',
    ]);
  });

  it('says "Pipeline deleted", not "Deal deleted", when a pipeline is deleted', async () => {
    const { result } = await renderSidebar();
    await act(async () => {
      pipelineMenu(result).items[0]!.onDelete!();
    });
    // The confirm dialog opens first; confirm it through the rendered dialogs.
    render(<>{result.current.dialogs}</>);
    await waitFor(() => expect(screen.getByTestId('confirm-description')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'confirm' }));

    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith('Pipeline deleted'));
    expect(mocks.toast.success).not.toHaveBeenCalledWith('Deal deleted');
  });

  it('does not claim deals "will stay in your CRM" for a pipeline without deals', async () => {
    const { result } = await renderSidebar();
    await act(async () => {
      pipelineMenu(result).items[0]!.onDelete!();
    });
    const view = render(<>{result.current.dialogs}</>);
    await waitFor(() =>
      expect(screen.getByTestId('confirm-description')).toHaveTextContent(
        'This pipeline has no deals. Deleting it can’t be undone.',
      ),
    );
    expect(view.container).not.toHaveTextContent('They will stay');
    expect(view.container).not.toHaveTextContent('0 deals');
  });

  it('still warns about a pipeline that has deals', async () => {
    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/pipelines') return { data: pipelines };
      if (path.startsWith('/opportunities')) return { pagination: { totalCount: 3 } };
      return { data: [] };
    });
    const { result } = await renderSidebar();
    await act(async () => {
      pipelineMenu(result).items[0]!.onDelete!();
    });
    render(<>{result.current.dialogs}</>);
    await waitFor(() =>
      expect(screen.getByTestId('confirm-description')).toHaveTextContent(
        'This pipeline has 3 deals. They will stay in your CRM',
      ),
    );
  });

  it('keeps the original icon (in the sidebar and on the saved pipeline) when duplicating', async () => {
    const { result } = await renderSidebar();
    const original = pipelineMenu(result).items.find((item) => item.title === 'Sales E2E')!;
    expect(original.icon).toBe(Handshake);

    await act(async () => {
      await original.onDuplicate!();
    });

    expect(mocks.createPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Sales E2E (Copy)', icon: 'Handshake' }),
    );
    expect(mocks.toast.success).toHaveBeenCalledWith('Pipeline duplicated');
    const copy = pipelineMenu(result).items.find((item) => item.title === 'Sales E2E (Copy)')!;
    expect(copy.icon).toBe(Handshake);
    expect(copy.icon).not.toBe(TrendingUp);
  });

  it('suffixes an imported pipeline instead of reusing the original name', async () => {
    const { result } = await renderSidebar();

    // "Import pipeline" opens a file picker: capture the input it creates.
    const picker = document.createElement('input');
    const realCreateElement = document.createElement.bind(document);
    const createElement = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
      tag === 'input' ? picker : realCreateElement(tag)) as typeof document.createElement);
    vi.spyOn(picker, 'click').mockImplementation(() => undefined);
    pipelineMenu(result).items[0]!.onImport!();
    createElement.mockRestore();

    const exported = {
      pipeline: { name: 'Sales E2E', icon: 'Handshake', color: 'bg-green-500' },
      stages: [{ name: 'Lead', position: 0 }],
    };
    Object.defineProperty(picker, 'files', {
      value: [{ text: async () => JSON.stringify(exported) }],
    });
    await act(async () => {
      await (picker.onchange as unknown as (e: unknown) => Promise<void>)({ target: picker });
    });

    expect(mocks.createPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Sales E2E (Imported)', icon: 'Handshake' }),
    );
    expect(mocks.toast.success).toHaveBeenCalledWith('Pipeline imported successfully');
    expect(pipelineMenu(result).items.map((item) => item.title)).toContain('Sales E2E (Imported)');
  });

  it('keeps a long name within the 255 characters the column allows when suffixing', async () => {
    const longName = 'x'.repeat(255);
    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/pipelines') return { data: [{ ...pipelines[0], name: longName }] };
      if (path.startsWith('/pipelines/')) return { data: { ...pipelines[0], name: longName } };
      return { data: [] };
    });
    const { result } = await renderSidebar();
    await act(async () => {
      await pipelineMenu(result).items[0]!.onDuplicate!();
    });
    const sent = mocks.createPipeline.mock.calls[0]![0] as { name: string };
    expect(sent.name).toHaveLength(255);
    expect(sent.name.endsWith(' (Copy)')).toBe(true);
  });
});
