import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { makeProject } from '../test-fixtures';
import WeldPanelProjectsPage from './page';

const state = vi.hoisted(() => ({
  locale: 'en' as 'en' | 'nl',
  canCreate: true,
  projects: [] as unknown[],
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { nl: dutch } = await import('@weldsuite/i18n/locales/nl');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: state.locale === 'nl' ? dutch : english, language: state.locale, format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.canCreate }));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: state.isError ? undefined : state.projects, isLoading: state.isLoading, isError: state.isError, refetch: state.refetch }),
  useCreateWeldPanelProject: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// The real list needs the whole app shell; this stand-in renders what the page hands it.
vi.mock('@/components/panel-entity-list', () => ({
  PanelEntityList: (props: {
    items: { id: string }[];
    columns: { id: string; header: string; render: (item: never) => ReactNode }[];
    onRowClick?: (item: never) => void;
    createButton?: { label: string; onClick: () => void };
    emptyState: { title: string; description: string; action?: { label: string; onClick: () => void } };
  }) => (
    <div>
      <div data-testid="header">{props.columns.map((col) => col.header).join('|')}</div>
      {props.createButton && <button onClick={props.createButton.onClick}>{props.createButton.label}</button>}
      {props.items.length === 0 && (
        <div data-testid="empty">
          <p>{props.emptyState.title}</p>
          <p>{props.emptyState.description}</p>
          {props.emptyState.action && <button onClick={props.emptyState.action.onClick}>{props.emptyState.action.label}</button>}
        </div>
      )}
      {props.items.map((item) => (
        <div key={item.id} data-testid="row" onClick={() => props.onRowClick?.(item as never)}>
          {props.columns.map((col) => (
            <span key={col.id}>{col.render(item as never)}</span>
          ))}
        </div>
      ))}
    </div>
  ),
}));

const tp = en.weldpanel.projects;

describe('WeldPanel projects', () => {
  beforeEach(() => {
    state.locale = 'en';
    state.canCreate = true;
    state.projects = [];
    state.isLoading = false;
    state.isError = false;
    state.refetch.mockReset();
    state.push.mockReset();
  });

  it('lists name, type, status, domains and creation date', () => {
    state.projects = [
      makeProject({ id: 'wpp_1', name: 'Marketing site', allowedDomains: ['example.com'] }),
      makeProject({ id: 'wpp_2', name: 'Web app', kind: 'app', status: 'paused', allowedDomains: [] }),
    ];
    render(<WeldPanelProjectsPage />);

    expect(screen.getByTestId('header').textContent).toBe(Object.values(tp.table).join('|'));
    const rows = screen.getAllByTestId('row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Marketing site');
    expect(rows[0]!.textContent).toContain(en.weldpanel.kinds.website);
    expect(rows[0]!.textContent).toContain(en.weldpanel.statuses.active);
    expect(rows[0]!.textContent).toContain('example.com');
    expect(rows[0]!.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-20T09:00:00.000Z');
    expect(rows[1]!.textContent).toContain(en.weldpanel.kinds.app);
    expect(rows[1]!.textContent).toContain(en.weldpanel.statuses.paused);
    expect(rows[1]!.textContent).toContain(tp.anySite);
  });

  it('names two domains and counts the rest', () => {
    state.projects = [makeProject({ allowedDomains: ['a.com', 'b.com', 'c.com', 'd.com'] })];
    render(<WeldPanelProjectsPage />);
    const row = screen.getByTestId('row');
    expect(row.textContent).toContain('a.com, b.com');
    expect(row.textContent).toContain('+2 more');
    expect(row.textContent).not.toContain('c.com');
  });

  it('opens a project when its row is clicked', async () => {
    state.projects = [makeProject({ id: 'wpp_9' })];
    render(<WeldPanelProjectsPage />);
    await userEvent.click(screen.getByTestId('row'));
    expect(state.push).toHaveBeenCalledWith('/weldpanel/projects/wpp_9');
  });

  it('shows an empty state with New project, which opens the create dialog', async () => {
    render(<WeldPanelProjectsPage />);
    expect(screen.getByText(tp.emptyTitle)).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: tp.newProject });
    await userEvent.click(buttons.at(-1)!);
    expect(await screen.findByRole('dialog', { name: en.weldpanel.createDialog.title })).toBeTruthy();
  });

  it('hides New project without panel_projects:create', () => {
    state.canCreate = false;
    render(<WeldPanelProjectsPage />);
    expect(screen.queryByRole('button', { name: tp.newProject })).toBeNull();
  });

  it('offers a retry when the list cannot be loaded', async () => {
    state.isError = true;
    render(<WeldPanelProjectsPage />);
    expect(screen.getByText(tp.loadFailed)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.retry }));
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });

  it('shows a loader while loading', () => {
    state.isLoading = true;
    render(<WeldPanelProjectsPage />);
    expect(screen.getByText(en.common.labels.loading)).toBeTruthy();
  });

  it('renders in Dutch', () => {
    state.locale = 'nl';
    state.projects = [makeProject({ allowedDomains: [] })];
    render(<WeldPanelProjectsPage />);
    expect(screen.getByTestId('header').textContent).toBe(Object.values(nl.weldpanel.projects.table).join('|'));
    expect(screen.getByTestId('row').textContent).toContain(nl.weldpanel.projects.anySite);
    expect(screen.getByTestId('row').textContent).toContain(nl.weldpanel.kinds.website);
  });
});
