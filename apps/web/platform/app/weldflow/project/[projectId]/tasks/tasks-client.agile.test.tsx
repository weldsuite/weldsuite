import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { ApiError } from '@weldsuite/api-client';
import { ProjectPermissionContext } from '@/app/weldflow/contexts/project-permission-context';
import { deliveryFor } from './backlog/_components/backlog-test-fixtures';
import { TasksClient } from './tasks-client';

const m = vi.hoisted(() => ({
  delivery: null as unknown,
  mutate: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: m.toastError, success: vi.fn() } }));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => ({ userId: 'user_1' }) }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ projectId: 'p1' }),
  usePathname: () => '/weldflow/project/p1/tasks',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/contexts/breadcrumb-context', () => ({ useOptionalBreadcrumbs: () => {} }));
vi.mock('@/components/objects/company/use-company-data', () => ({
  useCompanies: () => ({ data: { data: [] } }),
}));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: vi.fn() }),
  useObjectPanelNavigationReporter: () => () => {},
}));
vi.mock('@/hooks/queries/use-feature-flags-queries', () => ({ useFeatureFlag: () => false }));
vi.mock('@/hooks/queries/use-flow-agile-queries', () => ({
  useProjectDelivery: () => m.delivery,
  useUpdateTaskAgile: () => ({ mutate: m.mutate }),
}));
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useWorkspaceMemberDirectory: () => ({ data: { data: [] } }),
}));
vi.mock('@/app/weldflow/lib/api-client', () => ({
  tasksApi: { createGlobal: vi.fn(), create: vi.fn(), update: vi.fn(), listSubtasks: vi.fn(async () => ({ success: true, data: [] })) },
  membersApi: { list: vi.fn(async () => ({ success: true, data: [] })) },
  labelsApi: { list: vi.fn(async () => ({ success: true, data: [] })), create: vi.fn() },
  stagesApi: { list: vi.fn(async () => ({ success: true, data: [] })) },
}));
vi.mock('@/app/weldcrm/task-dialog', () => ({ TaskDialog: () => null }));

const permissions = {
  permissions: null,
  isLoading: false,
  error: null,
  refetch: async () => {},
  canRead: true,
  canWrite: true,
  isAdmin: true,
  isViewer: false,
  role: 'admin',
};

function task(over: Record<string, unknown>) {
  return {
    id: 't1',
    title: 'Fix the login',
    status: 'todo',
    priority: 'medium',
    createdAt: '2026-10-10T08:00:00.000Z',
    ...over,
  };
}

function renderTasks(tasks: unknown[]) {
  return render(
    <I18nProvider initialLanguage="en">
      <ProjectPermissionContext.Provider value={permissions}>
        <TasksClient projectId="p1" initialTasks={tasks as never} />
      </ProjectPermissionContext.Provider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  m.delivery = deliveryFor('scrum');
});

describe('TasksClient on an agile project', () => {
  it('shows the type badge and the points chip, and the List · Backlog switch', async () => {
    renderTasks([task({ type: 'bug', storyPoints: 5 })]);
    expect(await screen.findByText('Fix the login')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'Bug' }).length).toBeGreaterThan(0);
    expect(screen.getByTitle('5 points')).toHaveTextContent('5');
    const backlog = screen.getAllByRole('link', { name: 'Backlog' })[0]!;
    expect(backlog).toHaveAttribute('href', '/weldflow/project/p1/tasks/backlog');
    expect(screen.getAllByRole('link', { name: 'List' })[0]).toHaveAttribute('aria-current', 'page');
  });

  it('shows no chip for an item without points', async () => {
    renderTasks([task({ type: 'story', storyPoints: null })]);
    await screen.findByText('Fix the login');
    expect(screen.queryByTitle(/points?$/)).toBeNull();
  });

  it('changes the type from the row menu, at once', async () => {
    const user = userEvent.setup();
    renderTasks([task({ type: 'story' })]);
    await user.click(await screen.findByRole('button', { name: 'Actions for Fix the login' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Change type' }));
    const bug = await screen.findByRole('menuitem', { name: /Bug/ });
    fireEvent.click(bug);
    expect(m.mutate).toHaveBeenCalledTimes(1);
    expect(m.mutate.mock.calls[0]![0]).toEqual({ taskId: 't1', input: { type: 'bug' } });
  });

  it('sends an epic out of its sprint and epic, and rolls back when the server refuses', async () => {
    const user = userEvent.setup();
    renderTasks([task({ type: 'story', sprintId: 's1', epicId: 'e1' })]);
    await user.click(await screen.findByRole('button', { name: 'Actions for Fix the login' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Change type' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Epic/ }));
    const [vars, options] = m.mutate.mock.calls[0]!;
    expect(vars).toEqual({ taskId: 't1', input: { type: 'epic', sprintId: null, epicId: null } });
    options.onError(new ApiError('The epic has a conflicting state', 409));
    await waitFor(() => expect(m.toastError).toHaveBeenCalledWith('The epic has a conflicting state'));
    options.onError(new Error('x'));
    expect(m.toastError).toHaveBeenLastCalledWith('The type couldn’t be changed.');
  });

  it('leaves the list alone on a task list project', async () => {
    m.delivery = deliveryFor('tasklist');
    renderTasks([task({ type: 'bug', storyPoints: 5 })]);
    await screen.findByText('Fix the login');
    expect(screen.queryByTitle('5 points')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Backlog' })).toBeNull();
  });

  it('leaves the list alone where agile delivery is unavailable', async () => {
    m.delivery = deliveryFor('scrum', false);
    renderTasks([task({ type: 'bug', storyPoints: 5 })]);
    await screen.findByText('Fix the login');
    expect(screen.queryByRole('link', { name: 'Backlog' })).toBeNull();
  });
});
