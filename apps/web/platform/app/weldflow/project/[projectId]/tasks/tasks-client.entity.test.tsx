import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { TasksClient } from './tasks-client';

const { createGlobal } = vi.hoisted(() => ({
  createGlobal: vi.fn(async (data: Record<string, unknown>) => ({
    success: true,
    data: {
      id: 'task_new',
      title: data.title,
      status: data.status,
      priority: 'medium',
      createdAt: '2026-10-10T08:00:00.000Z',
      duration: data.duration ?? null,
    },
  })),
}));

vi.mock('@clerk/clerk-react', () => ({ useAuth: () => ({ userId: 'user_1' }) }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useOptionalBreadcrumbs: () => {} }));
vi.mock('@/components/objects/company/use-company-data', () => ({
  useCompanies: () => ({ data: { data: [] } }),
}));
vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: vi.fn() }) }));
vi.mock('@/hooks/queries/use-feature-flags-queries', () => ({ useFeatureFlag: () => false }));
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useWorkspaceMemberDirectory: () => ({ data: { data: [] } }),
}));
vi.mock('@/app/weldflow/lib/api-client', () => ({
  tasksApi: { createGlobal, create: vi.fn(), update: vi.fn() },
  membersApi: { list: vi.fn(async () => ({ success: true, data: [] })) },
  labelsApi: { list: vi.fn(async () => ({ success: true, data: [] })), create: vi.fn() },
  stagesApi: { list: vi.fn(async () => ({ success: true, data: [] })) },
}));
// The real dialog is a large form; all this test needs is its save callback.
vi.mock('@/app/weldcrm/task-dialog', () => ({
  TaskDialog: ({
    open,
    onSave,
  }: {
    open: boolean;
    onSave: (data: Record<string, unknown>) => void;
  }) =>
    open ? (
      <button type="button" onClick={() => onSave({ title: 'Call back', status: 'todo', duration: 30 })}>
        save-from-dialog
      </button>
    ) : null,
}));

describe('TasksClient in a company panel (entity mode)', () => {
  it('keeps the dialog duration when it creates a task for the company', async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider initialLanguage="en">
        <TasksClient projectId="" initialTasks={[]} entityScope={{ kind: 'company', id: 'co_1' }} />
      </I18nProvider>,
    );

    // The empty state's primary action opens the create dialog.
    await user.click((await screen.findAllByRole('button', { name: /add task/i }))[0]!);
    await user.click(await screen.findByRole('button', { name: 'save-from-dialog' }));

    await waitFor(() => expect(createGlobal).toHaveBeenCalledTimes(1));
    expect(createGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Call back', duration: 30, customerId: 'co_1', personId: undefined }),
    );
  });

  it('shows the empty-state text, not just an illustration, inside a panel', async () => {
    render(
      <I18nProvider initialLanguage="en">
        <TasksClient projectId="" initialTasks={[]} entityScope={{ kind: 'person', id: 'pe_1' }} />
      </I18nProvider>,
    );

    expect(await screen.findByText('No tasks found')).toBeInTheDocument();
    expect(screen.getByText('Create your first task to get started')).toBeInTheDocument();
  });
});
