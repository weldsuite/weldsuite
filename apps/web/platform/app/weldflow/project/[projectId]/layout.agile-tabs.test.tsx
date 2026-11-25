import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '@weldsuite/i18n/provider';

const state = vi.hoisted(() => ({
  pathname: '/weldflow/project/p1/tasks',
  tasksOpensOn: 'list' as 'list' | 'backlog',
}));

vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useParams: () => ({ projectId: 'p1' }),
  usePathname: () => state.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/components/project-chat/project-chat-panel', () => ({ ProjectChatPanel: () => null }));
vi.mock('@/components/object-panel', () => ({ useObjectPanelStack: () => [] }));
vi.mock('@/app/weldflow/components/project-actions-menu', () => ({ ProjectActionsMenu: () => null }));
vi.mock('@/app/weldflow/contexts/project-permission-context', () => ({
  ProjectPermissionProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/hooks/queries/use-projects-queries', () => ({
  useProject: () => ({ isError: false, data: { data: { name: 'Apollo' } } }),
}));
vi.mock('@/hooks/queries/use-flow-agile-queries', () => ({
  useProjectDelivery: () => ({ tasksOpensOn: state.tasksOpensOn }),
}));
vi.mock('@/hooks/queries/use-weldflow-preferences', () => ({
  useProjectTabPreference: () => ({ tabIds: null, setTabIds: vi.fn() }),
}));
vi.mock('@/app/weldflow/hooks/use-project-tabs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/weldflow/hooks/use-project-tabs')>();
  return {
    ...actual,
    useProjectTabAccess: (_projectId: string, offered: readonly string[]) => ({
      ready: true,
      allowed: offered,
      hidden: new Set<string>(),
    }),
  };
});

import ProjectLayout from './layout';

function renderLayout() {
  return render(
    <I18nProvider initialLanguage="en">
      <ProjectLayout>
        <p>page body</p>
      </ProjectLayout>
    </I18nProvider>,
  );
}

beforeEach(() => {
  state.pathname = '/weldflow/project/p1/tasks';
  state.tasksOpensOn = 'list';
});

describe('ProjectLayout tabs for an agile project', () => {
  it('opens the Tasks tab on the list of a project that is a task list', () => {
    renderLayout();
    expect(screen.getByRole('heading', { name: 'Apollo' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tasks' })).toHaveAttribute('href', '/weldflow/project/p1/tasks');
  });

  it('opens the Tasks tab on the Backlog of an agile project, and keeps the other tabs', () => {
    state.tasksOpensOn = 'backlog';
    renderLayout();
    expect(screen.getByRole('link', { name: 'Tasks' })).toHaveAttribute('href', '/weldflow/project/p1/tasks/backlog');
    expect(screen.getByRole('link', { name: 'Pipeline' })).toHaveAttribute('href', '/weldflow/project/p1/pipeline');
  });

  it('shows the page of a sprint, which is not a tab, without a tab selected by it', () => {
    state.pathname = '/weldflow/project/p1/sprints/s1/report';
    renderLayout();
    expect(screen.getByText('page body')).toBeInTheDocument();
  });
});
