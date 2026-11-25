import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { HrSelfAnnouncement } from '@weldsuite/app-api-client/domains/weldhr';
import { AnnouncementReadState, MyAnnouncementsList, useMarkMyAnnouncementRead } from './announcements-tab';

interface StubColumn {
  id: string;
  header: string;
  render: (row: HrSelfAnnouncement) => ReactNode;
}
interface StubFilter {
  field: string;
  options: Array<{ value: string; label: string }>;
}
interface StubProps {
  items: HrSelfAnnouncement[];
  isLoading: boolean;
  error: Error | null;
  columns: StubColumn[];
  filters: StubFilter[];
  groups: Array<{ id: string; label: string; filter: (row: HrSelfAnnouncement) => boolean }>;
  applyFilters: (rows: HrSelfAnnouncement[], active: Array<{ field: string; value: string }>) => HrSelfAnnouncement[];
  onRowClick: (row: HrSelfAnnouncement) => void;
  rowMenu: (row: HrSelfAnnouncement) => ReactNode;
  emptyState: { title: string };
}

const mocks = vi.hoisted(() => ({ open: vi.fn(), mutate: vi.fn(), toastError: vi.fn() }));
let data: { announcements: HrSelfAnnouncement[]; unread: number } | undefined;
let loading = false;
let failure: Error | null = null;

vi.mock('sonner', () => ({ toast: { error: (message: string) => mocks.toastError(message), success: vi.fn() } }));
vi.mock('@weldsuite/ui/components/dropdown-menu', () => ({
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: mocks.open }) }));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrAnnouncements: () => ({ data, isLoading: loading, error: failure }),
  useMyHrMarkAnnouncementRead: () => ({ mutate: mocks.mutate }),
}));
vi.mock('@/components/panel-entity-list', async () => {
  const { useState } = await import('react');
  return {
    PanelEntityList: (props: StubProps) => {
      const [shown, setShown] = useState<HrSelfAnnouncement[] | null>(null);
      const rows = shown ?? props.items;
      if (props.isLoading) return <p>stub loading</p>;
      if (props.error) return <p>stub error: {props.error.message}</p>;
      return (
        <div>
          {props.filters.map((filter) =>
            filter.options.map((option) => (
              <button
                key={`${filter.field}-${option.value}`}
                type="button"
                onClick={() => setShown(props.applyFilters(props.items, [{ field: filter.field, value: option.value }]))}
              >
                filter {filter.field} {option.label}
              </button>
            )),
          )}
          <button
            type="button"
            onClick={() =>
              setShown(
                props.applyFilters(props.items, [
                  { field: 'status', value: '' },
                  { field: 'other', value: 'x' },
                ]),
              )
            }
          >
            filter ignored
          </button>
          {props.groups.map((group) => (
            <p key={group.id} data-testid={`group-${group.id}`}>
              {props.items
                .filter(group.filter)
                .map((row) => row.title)
                .join(',')}
            </p>
          ))}
          {rows.length === 0 && <p>{props.emptyState.title}</p>}
          <ul>
            {rows.map((row) => (
              <li key={row.id} data-testid={`row-${row.id}`}>
                {props.columns.map((column) => (
                  <span key={column.id} data-testid={`${row.id}-${column.id}`}>
                    {column.render(row)}
                  </span>
                ))}
                <button type="button" onClick={() => props.onRowClick(row)}>
                  open {row.title}
                </button>
                <span data-testid={`${row.id}-menu`}>{props.rowMenu(row)}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    },
  };
});

function announcement(extra: Partial<HrSelfAnnouncement> & { id: string; title: string }): HrSelfAnnouncement {
  return {
    body: 'Body',
    pinned: false,
    publishedAt: '2026-11-10T09:00:00.000Z',
    updatedAt: '2026-11-10T09:00:00.000Z',
    createdByName: null,
    readAt: null,
    ...extra,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider initialLanguage="en">{children}</I18nProvider>;
}

function renderList() {
  return render(<MyAnnouncementsList />, { wrapper });
}

beforeEach(() => {
  mocks.open.mockReset();
  mocks.mutate.mockReset();
  mocks.toastError.mockReset();
  loading = false;
  failure = null;
  data = {
    unread: 2,
    announcements: [
      announcement({ id: 'a1', title: 'Office closed', pinned: true, createdByName: 'Hanna HR' }),
      announcement({ id: 'a2', title: 'New policy', createdByName: 'Bram Boss', readAt: '2026-11-11T08:00:00.000Z' }),
      announcement({ id: 'a3', title: 'Picnic' }),
    ],
  };
});

describe('MyAnnouncementsList', () => {
  it('shows loading and the load error', () => {
    loading = true;
    const { unmount } = renderList();
    expect(screen.getByText('stub loading')).toBeInTheDocument();
    unmount();

    loading = false;
    data = undefined;
    failure = new Error('Server down');
    renderList();
    expect(screen.getByText('stub error: Server down')).toBeInTheDocument();
  });

  it('shows the empty state without announcements', () => {
    data = { announcements: [], unread: 0 };
    renderList();
    expect(screen.getByText('No announcements')).toBeInTheDocument();
  });

  it('renders pinned, read and unread rows with their optional fields', () => {
    renderList();

    expect(screen.getByTestId('group-pinned')).toHaveTextContent('Office closed');
    expect(screen.getByTestId('group-other')).toHaveTextContent('New policy,Picnic');
    expect(within(screen.getByTestId('a1-title')).getByLabelText('Pinned')).toBeInTheDocument();
    expect(within(screen.getByTestId('a2-title')).queryByLabelText('Pinned')).not.toBeInTheDocument();
    expect(screen.getByTestId('a1-postedBy')).toHaveTextContent('Hanna HR');
    expect(screen.getByTestId('a3-postedBy')).toHaveTextContent('—');
    expect(screen.getByTestId('a2-status')).toHaveTextContent('Read');
    expect(screen.getByTestId('a3-status')).toHaveTextContent('New');
    expect(screen.getByTestId('a1-published')).toHaveTextContent('2026');
  });

  it('narrows the rows with the status and posted-by filters', async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole('button', { name: 'filter status New' }));
    expect(screen.queryByTestId('row-a2')).not.toBeInTheDocument();
    expect(screen.getByTestId('row-a1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'filter status Read' }));
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(1);
    expect(screen.getByTestId('row-a2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'filter postedBy Bram Boss' }));
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(1);
    expect(screen.getByTestId('row-a2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'filter ignored' }));
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(3);
  });

  it('only offers a posted-by filter when someone posted', () => {
    data = { unread: 1, announcements: [announcement({ id: 'a3', title: 'Picnic' })] };
    renderList();
    expect(screen.queryByRole('button', { name: /filter postedBy/ })).not.toBeInTheDocument();
  });

  it('opens the announcement panel from a row', async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole('button', { name: 'open Picnic' }));
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ id: 'a3' }));
  });

  it('marks an unread announcement as read from its menu, and offers nothing for a read one', async () => {
    const user = userEvent.setup();
    renderList();

    expect(within(screen.getByTestId('a2-menu')).queryByRole('button')).not.toBeInTheDocument();
    await user.click(within(screen.getByTestId('a3-menu')).getByRole('button', { name: 'Mark as read' }));
    expect(mocks.mutate).toHaveBeenCalledWith('a3', expect.objectContaining({ onError: expect.any(Function) }));
  });
});

describe('AnnouncementReadState', () => {
  it('says Read or New', () => {
    const { rerender } = render(
      <AnnouncementReadState announcement={announcement({ id: 'x', title: 'X', readAt: '2026-11-11T08:00:00.000Z' })} />,
      { wrapper },
    );
    expect(screen.getByText('Read')).toBeInTheDocument();
    rerender(<AnnouncementReadState announcement={announcement({ id: 'x', title: 'X' })} />);
    expect(screen.getByText('New')).toBeInTheDocument();
  });
});

describe('useMarkMyAnnouncementRead', () => {
  it('sends a request once, skips read ones, and allows a retry after a failure with a toast', () => {
    const { result } = renderHook(() => useMarkMyAnnouncementRead(), { wrapper });
    const unread = announcement({ id: 'u1', title: 'U' });

    act(() => result.current(announcement({ id: 'r1', title: 'R', readAt: '2026-11-11T08:00:00.000Z' })));
    expect(mocks.mutate).not.toHaveBeenCalled();

    act(() => result.current(unread));
    act(() => result.current(unread));
    expect(mocks.mutate).toHaveBeenCalledTimes(1);

    const { onError } = mocks.mutate.mock.calls[0][1] as { onError: (err: Error) => void };
    act(() => onError(new Error('Nope')));
    expect(mocks.toastError).toHaveBeenCalledWith('Nope');

    act(() => result.current(unread));
    expect(mocks.mutate).toHaveBeenCalledTimes(2);
  });
});
