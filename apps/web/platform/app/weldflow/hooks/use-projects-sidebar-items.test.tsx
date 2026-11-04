import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../lib/api-client', () => ({
  projectsApi: { list: api.list, create: api.create },
  stagesApi: {},
}));

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ t: en, language: 'en' }),
}));

const prefs = vi.hoisted(() => ({
  order: null as string[] | null,
  setOrder: vi.fn(),
}));

vi.mock('@/lib/router', () => ({
  usePathname: () => '/weldflow/projects',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/hooks/queries/use-weldflow-preferences', () => ({
  useSidebarProjectOrder: () => ({ order: prefs.order, setOrder: prefs.setOrder, isLoaded: true }),
}));

const reviews = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/hooks/queries/use-flow-approvals-queries', () => ({
  useMyReviewsCount: () => ({ data: reviews.count }),
}));

vi.mock('@/lib/events/data-events', () => ({ useDataEvent: () => {} }));
vi.mock('@weldsuite/realtime/react', () => ({ useTopic: () => {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useProjectsSidebarItems } from './use-projects-sidebar-items';

function Harness() {
  const { menuGroups, dialogs } = useProjectsSidebarItems(true);
  const projectsGroup = menuGroups.find((g) => g.onAdd);
  return (
    <>
      <button type="button" onClick={() => projectsGroup?.onAdd?.()}>
        open-add-project
      </button>
      {dialogs}
    </>
  );
}

function OrderHarness() {
  const { menuGroups } = useProjectsSidebarItems(true);
  const projects = menuGroups.find((g) => g.onAdd)?.items ?? [];
  return (
    <>
      <ol>
        {projects.map((item) => (
          <li key={item.href}>{item.title}</li>
        ))}
      </ol>
      <button type="button" onClick={() => projects[0]?.onMoveDown?.()}>
        move-first-down
      </button>
    </>
  );
}

describe('useProjectsSidebarItems: project order', () => {
  const projects = [
    { id: 'p1', name: 'Alpha' },
    { id: 'p2', name: 'Beta' },
    { id: 'p3', name: 'Gamma' },
  ];

  beforeEach(() => {
    api.list.mockReset().mockResolvedValue({ success: true, data: projects });
    prefs.order = null;
    prefs.setOrder.mockReset();
  });

  it('lists projects in the saved order', async () => {
    prefs.order = ['p3', 'p1', 'p2'];
    render(<OrderHarness />);
    await act(async () => {});
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Gamma', 'Alpha', 'Beta']);
  });

  it('saves the new order when a project is moved (matching the real item href)', async () => {
    render(<OrderHarness />);
    await act(async () => {});
    fireEvent.click(screen.getByText('move-first-down'));
    expect(prefs.setOrder).toHaveBeenCalledWith(['p2', 'p1', 'p3']);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Beta', 'Alpha', 'Gamma']);
  });
});

describe('useProjectsSidebarItems: create project dialog', () => {
  beforeEach(() => {
    api.list.mockReset().mockResolvedValue({ success: true, data: [] });
    api.create.mockReset();
  });

  it('creates one project when Create is clicked repeatedly while the request is pending', async () => {
    let resolveCreate: (value: unknown) => void = () => {};
    api.create.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      })
    );

    render(<Harness />);
    await act(async () => {});

    fireEvent.click(screen.getByText('open-add-project'));
    const input = screen.getByPlaceholderText(en.projects.sidebar.namePlaceholder);
    fireEvent.change(input, { target: { value: 'Launch' } });

    const createButton = screen.getByRole('button', { name: en.projects.sidebar.createProject });
    fireEvent.click(createButton);
    fireEvent.click(createButton);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(api.create).toHaveBeenCalledTimes(1);
    expect(createButton).toBeDisabled();

    await act(async () => {
      resolveCreate({ success: true, data: { id: 'proj_1', name: 'Launch' } });
    });

    expect(api.create).toHaveBeenCalledTimes(1);
  });
});

function GeneralPagesHarness() {
  const { menuGroups } = useProjectsSidebarItems(true);
  const pages = menuGroups.find((g) => !g.onAdd)?.items ?? [];
  return (
    <ol>
      {pages.map((item) => (
        <li key={item.href} data-permission={String(item.permission ?? '')} data-badge={item.badge ?? ''} data-badge-label={item.badgeLabel ?? ''}>
          {item.title}
        </li>
      ))}
    </ol>
  );
}

describe('useProjectsSidebarItems: general pages', () => {
  beforeEach(() => {
    api.list.mockReset().mockResolvedValue({ success: true, data: [] });
    reviews.count = 0;
    window.localStorage.clear();
  });

  it('puts My reviews next to My tasks and groups the portfolio pages with the workspace-level ones', async () => {
    render(<GeneralPagesHarness />);
    await act(async () => {});
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      en.projects.sidebar.myTasks,
      en.projects.sidebar.myReviews,
      en.projects.sidebar.allProjects,
      en.projects.sidebar.workload,
      en.projects.sidebar.intake,
      en.projects.sidebar.capacity,
      en.projects.sidebar.templates,
      en.projects.sidebar.analytics,
    ]);
  });

  it('gates Intake and Capacity on portfolio:read and Templates on projects:read', async () => {
    render(<GeneralPagesHarness />);
    await act(async () => {});
    const permissionOf = (title: string) => screen.getByText(title).getAttribute('data-permission');
    expect(permissionOf(en.projects.sidebar.intake)).toBe('portfolio:read');
    expect(permissionOf(en.projects.sidebar.capacity)).toBe('portfolio:read');
    expect(permissionOf(en.projects.sidebar.templates)).toBe('projects:read');
    expect(permissionOf(en.projects.sidebar.myReviews)).toBe('');
  });

  it('shows no badge on My reviews while nothing waits', async () => {
    render(<GeneralPagesHarness />);
    await act(async () => {});
    expect(screen.getByText(en.projects.sidebar.myReviews)).toHaveAttribute('data-badge', '');
  });

  it('shows the waiting count, and a spoken label for it, on My reviews', async () => {
    reviews.count = 3;
    render(<GeneralPagesHarness />);
    await act(async () => {});
    const item = screen.getByText(en.projects.sidebar.myReviews);
    expect(item).toHaveAttribute('data-badge', '3');
    expect(item).toHaveAttribute('data-badge-label', en.projects.sidebar.myReviewsBadge.replace('{count}', '3'));
  });

  it('caps a long count at 99+', async () => {
    reviews.count = 140;
    render(<GeneralPagesHarness />);
    await act(async () => {});
    expect(screen.getByText(en.projects.sidebar.myReviews)).toHaveAttribute('data-badge', '99+');
  });

  it('adds the new pages for a user whose saved set of pages predates them', async () => {
    window.localStorage.setItem('visibleGeneralPages', JSON.stringify(['my-tasks', 'all-projects', 'workload']));
    render(<GeneralPagesHarness />);
    await act(async () => {});
    const titles = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(titles).toEqual(expect.arrayContaining([
      en.projects.sidebar.myReviews,
      en.projects.sidebar.intake,
      en.projects.sidebar.capacity,
      en.projects.sidebar.templates,
      en.projects.sidebar.analytics,
    ]));
  });
});
