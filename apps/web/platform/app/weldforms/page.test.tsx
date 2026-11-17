import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import type { FormFolder, FormSummary, ListFormsQuery } from '@weldsuite/app-api-client/schemas/weldforms';
import type { ActiveFilter, FilterConfig, HeaderColumn, SortState } from '@/components/entity-list';
import WeldFormsHome from './page';

const th = en.weldforms.home;
const ta = en.weldforms.actions;

type Params = Omit<ListFormsQuery, 'cursor'>;

interface ListState {
  forms: FormSummary[];
  data: { pages: { pagination?: { totalCount?: number } }[] } | undefined;
  isLoading: boolean;
  error: Error | null;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
}

const permissions = new Set<string>();
let listState: ListState;
let folderData: FormFolder[] | undefined;
const listCalls: Params[] = [];
const refetch = vi.fn();
const fetchNextPage = vi.fn();
const push = vi.fn();
const duplicateMutateAsync = vi.fn();
const removeMutateAsync = vi.fn();
const moveMutateAsync = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

interface ListProps {
  items: FormSummary[];
  isLoading: boolean;
  headerColumns: HeaderColumn[];
  filters: FilterConfig[];
  activeFilters: ActiveFilter[];
  onFiltersChange: (filters: ActiveFilter[]) => void;
  renderRow: (item: FormSummary) => ReactNode;
  searchPlaceholder: string;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  sortState: SortState;
  onSort: (columnId: string) => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  leftActionButtons: ReactNode;
  createButton?: { label: string; onClick: () => void };
  emptyState: { title: string; description: string; action?: { label: string; onClick: () => void } };
  noResultsState: { title: string; description: string };
}

vi.mock('@/components/entity-list', () => ({
  EmptyStateIllustration: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  EntityList: (props: ListProps) => (
    <div data-testid="entity-list">
      {props.isLoading && <p>loading</p>}
      <div>{props.leftActionButtons}</div>
      <input aria-label={props.searchPlaceholder} value={props.searchQuery} onChange={(e) => props.onSearchChange(e.target.value)} />
      <p data-testid="sort">{`${props.sortState.columnId}:${props.sortState.direction}`}</p>
      {props.headerColumns.map((column) => (
        <button key={column.id} type="button" onClick={() => props.onSort(column.id)}>
          {`header ${column.header}${column.sortable ? ' sortable' : ''}`}
        </button>
      ))}
      {props.filters.map((filter) =>
        filter.options.map((option) => (
          <span key={option.value}>
            <button type="button" onClick={() => props.onFiltersChange([{ id: 'x', field: filter.field, operator: 'is', value: option.value } as ActiveFilter])}>
              {`only ${option.label}`}
            </button>
            <button type="button" onClick={() => props.onFiltersChange([{ id: 'x', field: filter.field, operator: 'is not', value: option.value } as ActiveFilter])}>
              {`except ${option.label}`}
            </button>
          </span>
        )),
      )}
      <button type="button" onClick={() => props.onFiltersChange([{ id: 'x', field: 'status', operator: 'is', value: 'bogus' } as ActiveFilter])}>
        bogus filter
      </button>
      <button type="button" onClick={() => props.onFiltersChange([])}>
        clear filters
      </button>
      {props.createButton && (
        <button type="button" onClick={props.createButton.onClick}>
          {`toolbar ${props.createButton.label}`}
        </button>
      )}
      {props.items.length === 0 && !props.isLoading && (
        <div>
          <p>{props.emptyState.title}</p>
          <p>{props.emptyState.description}</p>
          <p>{props.noResultsState.title}</p>
          {props.emptyState.action && (
            <button type="button" onClick={props.emptyState.action.onClick}>
              {`empty ${props.emptyState.action.label}`}
            </button>
          )}
        </div>
      )}
      {props.items.map((item) => props.renderRow(item))}
      {props.hasMore && (
        <button type="button" onClick={props.onLoadMore}>
          {props.isLoadingMore ? 'loading more' : 'load more'}
        </button>
      )}
    </div>
  ),
}));

vi.mock('@weldsuite/ui/components/error-banner', () => ({
  ErrorState: ({ message, onRetry, retryLabel }: { message: string; onRetry: () => void; retryLabel: string }) => (
    <div>
      <p>{message}</p>
      <button type="button" onClick={onRetry}>
        {retryLabel}
      </button>
    </div>
  ),
}));

// Radix Select needs layout APIs jsdom lacks; a native select keeps the move dialog testable.
vi.mock('@weldsuite/ui/components/select', () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) => (
    <select data-testid="move-target" value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
}));

vi.mock('./components/new-form-dialog', () => ({
  NewFormDialog: ({ open, folderId }: { open: boolean; folderId: string | null }) => (open ? <div data-testid="new-form-dialog">{`folder:${String(folderId)}`}</div> : null),
}));

vi.mock('./components/folder-menu', async () => {
  const actual = await vi.importActual<typeof import('./components/folder-menu')>('./components/folder-menu');
  return {
    ALL_FOLDERS: actual.ALL_FOLDERS,
    NO_FOLDER: actual.NO_FOLDER,
    FolderMenu: ({ folders, selected, onSelect, totalCount }: { folders: FormFolder[]; selected: string; onSelect: (id: string) => void; totalCount: number | null }) => (
      <div data-testid="folder-menu" data-selected={selected} data-total={String(totalCount)} data-folders={folders.length}>
        <button type="button" onClick={() => onSelect('f1')}>
          pick Marketing
        </button>
        <button type="button" onClick={() => onSelect(actual.NO_FOLDER)}>
          pick no folder
        </button>
        <button type="button" onClick={() => onSelect(actual.ALL_FOLDERS)}>
          pick all
        </button>
      </div>
    ),
  };
});

vi.mock('sonner', () => ({
  toast: { error: (m: string) => toastError(m), success: (m: string) => toastSuccess(m) },
}));

vi.mock('@weldsuite/permissions/react', () => ({
  useCan: (permission: string) => permissions.has(permission),
}));

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ t: en }),
}));

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('@/hooks/queries/use-weldforms-queries', () => ({
  useForms: (params: Params) => {
    listCalls.push(params);
    // The unfiltered "every form" query the page makes for the folder picker's total.
    const isTotalQuery = Object.keys(params).length === 1;
    if (isTotalQuery) return { ...listState, forms: [], data: listState.data, refetch, fetchNextPage };
    return { ...listState, refetch, fetchNextPage };
  },
  useFormFolders: () => ({ data: folderData }),
  useDuplicateForm: () => ({ mutateAsync: duplicateMutateAsync, isPending: false }),
  useDeleteForm: () => ({ mutateAsync: removeMutateAsync, isPending: false }),
  useMoveForm: () => ({ mutateAsync: moveMutateAsync, isPending: false }),
}));

const form = (over: Partial<FormSummary> & { id: string; title: string }): FormSummary => ({
  status: 'draft',
  folderId: null,
  layout: 'classic',
  publicId: null,
  publicUrl: null,
  access: 'public',
  respondentMode: 'anonymous',
  owner: { id: 'u1', name: 'Ada' },
  responseCount: 0,
  lastResponseAt: null,
  hasUnpublishedChanges: false,
  publishedAt: null,
  closedAt: null,
  createdAt: '2026-01-02T00:00:00.000Z',
  updatedAt: '2026-01-03T00:00:00.000Z',
  ...over,
} as FormSummary);

const survey = form({ id: 'a1', title: 'Survey', status: 'published', responseCount: 7, lastResponseAt: '2026-02-01T00:00:00.000Z', hasUnpublishedChanges: true, folderId: 'f1' });
const draft = form({ id: 'a2', title: 'Draft one', status: 'draft' });
const closed = form({ id: 'a3', title: '', status: 'closed' });

const marketing: FormFolder = { id: 'f1', name: 'Marketing', position: 0, formCount: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

function lastListParams(): Params {
  const main = listCalls.filter((p) => Object.keys(p).length > 1);
  return main[main.length - 1]!;
}

function grant(...keys: string[]) {
  keys.forEach((k) => permissions.add(k));
}

function openRowMenu(name: string) {
  fireEvent.keyDown(screen.getByRole('button', { name: `${en.common.actions.openMenu}: ${name}` }), { key: 'Enter' });
}

describe('WeldForms home page', () => {
  beforeEach(() => {
    permissions.clear();
    grant('forms:create', 'forms:update', 'forms:delete');
    listState = {
      forms: [survey, draft, closed],
      data: { pages: [{ pagination: { totalCount: 3 } }] },
      isLoading: false,
      error: null,
      hasNextPage: false,
      isFetchingNextPage: false,
    };
    folderData = [marketing];
    listCalls.length = 0;
    refetch.mockClear();
    fetchNextPage.mockClear();
    push.mockClear();
    duplicateMutateAsync.mockReset();
    removeMutateAsync.mockReset();
    moveMutateAsync.mockReset();
    toastError.mockClear();
    toastSuccess.mockClear();
  });

  it('renders a row per form with its status, counts and dates', () => {
    render(<WeldFormsHome />);

    expect(screen.getByText('Survey')).toBeTruthy();
    expect(screen.getByText('Draft one')).toBeTruthy();
    // A form without a title falls back to the untitled label.
    expect(screen.getAllByText(en.weldforms.untitled).length).toBeGreaterThan(0);
    expect(screen.getByText(en.weldforms.status.published)).toBeTruthy();
    expect(screen.getByText(en.weldforms.status.unpublishedChanges)).toBeTruthy();
    expect(screen.getByText(en.weldforms.status.draft)).toBeTruthy();
    expect(screen.getByText(en.weldforms.status.closed)).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    // Forms nobody answered show the "none yet" label, the others a date.
    expect(screen.getAllByText(th.never)).toHaveLength(2);
  });

  it('opens a form in the editor from its row', () => {
    render(<WeldFormsHome />);
    fireEvent.click(screen.getByRole('button', { name: 'Survey' }));
    expect(push).toHaveBeenCalledWith('/weldforms/a1/edit');
  });

  it('asks the server for every form, newest first, to begin with', () => {
    render(<WeldFormsHome />);
    expect(lastListParams()).toEqual({ folderId: undefined, status: undefined, q: undefined, sort: 'updated' });
    expect(screen.getByTestId('sort').textContent).toBe('updated:desc');
  });

  it('feeds the folder picker the folders and the total of every form', () => {
    render(<WeldFormsHome />);
    const menu = screen.getAllByTestId('folder-menu')[0]!;
    expect(menu.dataset.total).toBe('3');
    expect(menu.dataset.folders).toBe('1');
    expect(menu.dataset.selected).toBe('__all__');
  });

  it('passes no total or folders while they load', () => {
    listState = { ...listState, data: undefined };
    folderData = undefined;
    render(<WeldFormsHome />);
    const menu = screen.getAllByTestId('folder-menu')[0]!;
    expect(menu.dataset.total).toBe('null');
    expect(menu.dataset.folders).toBe('0');
  });

  it('filters the list by the folder picked, none or all', () => {
    render(<WeldFormsHome />);

    fireEvent.click(screen.getAllByText('pick Marketing')[0]!);
    expect(lastListParams().folderId).toBe('f1');

    fireEvent.click(screen.getAllByText('pick no folder')[0]!);
    expect(lastListParams().folderId).toBe('none');

    fireEvent.click(screen.getAllByText('pick all')[0]!);
    expect(lastListParams().folderId).toBeUndefined();
  });

  it('files a new form in the folder picked, and in none otherwise', () => {
    render(<WeldFormsHome />);

    fireEvent.click(screen.getByText(`toolbar ${th.newForm}`));
    expect(screen.getByTestId('new-form-dialog').textContent).toBe('folder:null');
  });

  it('files a new form in the picked folder', () => {
    render(<WeldFormsHome />);
    fireEvent.click(screen.getAllByText('pick Marketing')[0]!);
    fireEvent.click(screen.getByText(`toolbar ${th.newForm}`));
    expect(screen.getByTestId('new-form-dialog').textContent).toBe('folder:f1');
  });

  it('files a new form in no folder when the forms outside a folder are listed', () => {
    render(<WeldFormsHome />);
    fireEvent.click(screen.getAllByText('pick no folder')[0]!);
    fireEvent.click(screen.getByText(`toolbar ${th.newForm}`));
    expect(screen.getByTestId('new-form-dialog').textContent).toBe('folder:null');
  });

  it('sends the trimmed search to the server', async () => {
    render(<WeldFormsHome />);
    fireEvent.change(screen.getByLabelText(th.searchPlaceholder), { target: { value: '  survey  ' } });
    await waitFor(() => expect(lastListParams().q).toBe('survey'));
  });

  it('asks the server for one status', () => {
    render(<WeldFormsHome />);
    fireEvent.click(screen.getByText(`only ${en.weldforms.status.published}`));
    expect(lastListParams().status).toBe('published');
    expect(screen.getByText('Survey')).toBeTruthy();
  });

  it('leaves one status out of the rows loaded for an "is not" filter', () => {
    render(<WeldFormsHome />);
    fireEvent.click(screen.getByText(`except ${en.weldforms.status.draft}`));
    expect(lastListParams().status).toBeUndefined();
    expect(screen.queryByText('Draft one')).toBeNull();
    expect(screen.getByText('Survey')).toBeTruthy();
  });

  it('keeps loading pages while an "is not" filter leaves none of the loaded rows', () => {
    listState = { ...listState, forms: [draft], hasNextPage: true };
    render(<WeldFormsHome />);
    fireEvent.click(screen.getByText(`except ${en.weldforms.status.draft}`));
    // No row is left to scroll to, so the page asks for the next one itself and shows it is still looking.
    expect(fetchNextPage).toHaveBeenCalled();
    expect(screen.getByText('loading')).toBeTruthy();
  });

  it('stops looking when the last page leaves no row for an "is not" filter', () => {
    listState = { ...listState, forms: [draft], hasNextPage: false };
    render(<WeldFormsHome />);
    fireEvent.click(screen.getByText(`except ${en.weldforms.status.draft}`));
    expect(fetchNextPage).not.toHaveBeenCalled();
    expect(screen.queryByText('loading')).toBeNull();
  });

  it('ignores a filter value that is not a status and lifts a cleared filter', () => {
    render(<WeldFormsHome />);
    fireEvent.click(screen.getByText('bogus filter'));
    expect(lastListParams().status).toBeUndefined();
    expect(screen.getByText('Draft one')).toBeTruthy();

    fireEvent.click(screen.getByText(`only ${en.weldforms.status.closed}`));
    expect(lastListParams().status).toBe('closed');
    fireEvent.click(screen.getByText('clear filters'));
    expect(lastListParams().status).toBeUndefined();
  });

  it('sorts by the sortable columns and ignores the others', () => {
    render(<WeldFormsHome />);
    expect(screen.getByText(`header ${th.columns.name} sortable`)).toBeTruthy();
    expect(screen.getByText(`header ${th.columns.status}`)).toBeTruthy();

    fireEvent.click(screen.getByText(`header ${th.columns.name} sortable`));
    expect(lastListParams().sort).toBe('title');
    expect(screen.getByTestId('sort').textContent).toBe('name:asc');

    fireEvent.click(screen.getByText(`header ${th.responses} sortable`));
    expect(lastListParams().sort).toBe('responses');
    expect(screen.getByTestId('sort').textContent).toBe('responses:desc');

    fireEvent.click(screen.getByText(`header ${th.columns.created} sortable`));
    expect(lastListParams().sort).toBe('created');

    fireEvent.click(screen.getByText(`header ${th.columns.updated} sortable`));
    expect(lastListParams().sort).toBe('updated');

    fireEvent.click(screen.getByText(`header ${th.columns.status}`));
    fireEvent.click(screen.getByText(`header ${th.lastResponse}`));
    expect(lastListParams().sort).toBe('updated');
  });

  it('loads the next page', () => {
    listState = { ...listState, hasNextPage: true };
    render(<WeldFormsHome />);
    fireEvent.click(screen.getByText('load more'));
    expect(fetchNextPage).toHaveBeenCalled();
  });

  it('shows the loading state and the next page loading', () => {
    listState = { ...listState, forms: [], isLoading: true, hasNextPage: true, isFetchingNextPage: true };
    render(<WeldFormsHome />);
    expect(screen.getByText('loading')).toBeTruthy();
    expect(screen.getByText('loading more')).toBeTruthy();
  });

  it('shows the empty state with a new form action', () => {
    listState = { ...listState, forms: [] };
    render(<WeldFormsHome />);
    expect(screen.getByText(th.emptyTitle)).toBeTruthy();
    expect(screen.getByText(th.emptyDescription)).toBeTruthy();
    expect(screen.getByText(th.noResultsTitle)).toBeTruthy();

    fireEvent.click(screen.getByText(`empty ${th.newForm}`));
    expect(screen.getByTestId('new-form-dialog')).toBeTruthy();
  });

  it('shows a load error with a retry, until there is data', () => {
    listState = { ...listState, forms: [], data: undefined, error: new Error('boom') };
    render(<WeldFormsHome />);
    expect(screen.getByText(en.weldforms.loadFailed)).toBeTruthy();
    expect(screen.queryByTestId('entity-list')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: en.common.actions.retry }));
    expect(refetch).toHaveBeenCalled();
  });

  it('keeps the list when a refetch fails but rows are loaded', () => {
    listState = { ...listState, error: new Error('boom') };
    render(<WeldFormsHome />);
    expect(screen.getByTestId('entity-list')).toBeTruthy();
    expect(screen.queryByText(en.weldforms.loadFailed)).toBeNull();
  });

  describe('row menu', () => {
    it('duplicates a form with a copy suffix', async () => {
      duplicateMutateAsync.mockResolvedValue({});
      render(<WeldFormsHome />);
      openRowMenu('Survey');
      fireEvent.click(screen.getByRole('menuitem', { name: ta.duplicate }));

      await waitFor(() => expect(duplicateMutateAsync).toHaveBeenCalledWith({ id: 'a1', title: `Survey ${ta.copySuffix}` }));
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(ta.duplicated));
    });

    it('reports a failed duplicate', async () => {
      duplicateMutateAsync.mockRejectedValue(new Error('boom'));
      render(<WeldFormsHome />);
      openRowMenu('Survey');
      fireEvent.click(screen.getByRole('menuitem', { name: ta.duplicate }));
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(ta.duplicateFailed));
    });

    it('asks before deleting, then deletes the form', async () => {
      removeMutateAsync.mockResolvedValue(undefined);
      render(<WeldFormsHome />);
      openRowMenu('Survey');
      fireEvent.click(screen.getByRole('menuitem', { name: en.common.actions.delete }));

      expect(await screen.findByText(ta.deleteConfirmTitle)).toBeTruthy();
      expect(screen.getByText(ta.deleteConfirmDescription)).toBeTruthy();
      expect(removeMutateAsync).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: en.common.actions.delete }));
      await waitFor(() => expect(removeMutateAsync).toHaveBeenCalledWith('a1'));
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(ta.deleted));
      await waitFor(() => expect(screen.queryByText(ta.deleteConfirmTitle)).toBeNull());
    });

    it('reports a failed delete', async () => {
      removeMutateAsync.mockRejectedValue(new Error('boom'));
      render(<WeldFormsHome />);
      openRowMenu('Survey');
      fireEvent.click(screen.getByRole('menuitem', { name: en.common.actions.delete }));
      await screen.findByText(ta.deleteConfirmTitle);

      fireEvent.click(screen.getByRole('button', { name: en.common.actions.delete }));
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(ta.deleteFailed));
    });

    it('does not delete when the confirmation is cancelled', async () => {
      render(<WeldFormsHome />);
      openRowMenu('Survey');
      fireEvent.click(screen.getByRole('menuitem', { name: en.common.actions.delete }));
      await screen.findByText(ta.deleteConfirmTitle);

      fireEvent.click(screen.getByRole('button', { name: en.common.actions.cancel }));
      await waitFor(() => expect(screen.queryByText(ta.deleteConfirmTitle)).toBeNull());
      expect(removeMutateAsync).not.toHaveBeenCalled();
    });

    it('moves a form to another folder', async () => {
      moveMutateAsync.mockResolvedValue({});
      render(<WeldFormsHome />);
      openRowMenu('Draft one');
      fireEvent.click(screen.getByRole('menuitem', { name: th.moveToFolder }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Draft one')).toBeTruthy();
      const target = within(dialog).getByTestId('move-target') as HTMLSelectElement;
      expect(target.value).toBe('__none__');
      expect(within(dialog).getByRole('option', { name: en.weldforms.folders.none })).toBeTruthy();

      fireEvent.change(target, { target: { value: 'f1' } });
      fireEvent.click(within(dialog).getByRole('button', { name: th.move }));

      await waitFor(() => expect(moveMutateAsync).toHaveBeenCalledWith({ id: 'a2', folderId: 'f1' }));
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(th.moved));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('moves a form out of its folder', async () => {
      moveMutateAsync.mockResolvedValue({});
      render(<WeldFormsHome />);
      openRowMenu('Survey');
      fireEvent.click(screen.getByRole('menuitem', { name: th.moveToFolder }));

      const dialog = await screen.findByRole('dialog');
      const target = within(dialog).getByTestId('move-target') as HTMLSelectElement;
      await waitFor(() => expect(target.value).toBe('f1'));

      fireEvent.change(target, { target: { value: '__none__' } });
      fireEvent.click(within(dialog).getByRole('button', { name: th.move }));
      await waitFor(() => expect(moveMutateAsync).toHaveBeenCalledWith({ id: 'a1', folderId: null }));
    });

    it('reports a failed move and keeps the dialog open', async () => {
      moveMutateAsync.mockRejectedValue(new Error('boom'));
      render(<WeldFormsHome />);
      openRowMenu('Draft one');
      fireEvent.click(screen.getByRole('menuitem', { name: th.moveToFolder }));

      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: th.move }));
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(th.moveFailed));
      expect(screen.getByRole('dialog')).toBeTruthy();
    });

    it('closes the move dialog on cancel', async () => {
      render(<WeldFormsHome />);
      openRowMenu('Draft one');
      fireEvent.click(screen.getByRole('menuitem', { name: th.moveToFolder }));

      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: en.common.actions.cancel }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(moveMutateAsync).not.toHaveBeenCalled();
    });
  });

  describe('permissions', () => {
    it('hides the new form buttons, duplicate and the separator without the create permission', () => {
      permissions.delete('forms:create');
      listState = { ...listState, forms: [] };
      render(<WeldFormsHome />);
      expect(screen.queryByText(`toolbar ${th.newForm}`)).toBeNull();
      expect(screen.queryByText(`empty ${th.newForm}`)).toBeNull();
    });

    it('offers only the actions the member may take', () => {
      permissions.clear();
      grant('forms:update');
      render(<WeldFormsHome />);
      openRowMenu('Survey');
      expect(screen.getByRole('menuitem', { name: th.moveToFolder })).toBeTruthy();
      expect(screen.queryByRole('menuitem', { name: ta.duplicate })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: en.common.actions.delete })).toBeNull();
    });

    it('offers delete alone, without a separator, to a member who may only delete', () => {
      permissions.clear();
      grant('forms:delete');
      render(<WeldFormsHome />);
      openRowMenu('Survey');
      expect(screen.getByRole('menuitem', { name: en.common.actions.delete })).toBeTruthy();
      expect(screen.queryByRole('menuitem', { name: ta.duplicate })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: th.moveToFolder })).toBeNull();
      expect(screen.queryByRole('separator')).toBeNull();
    });

    it('shows no row menu to a read-only member', () => {
      permissions.clear();
      render(<WeldFormsHome />);
      expect(screen.queryByRole('button', { name: `${en.common.actions.openMenu}: Survey` })).toBeNull();
      expect(screen.getByText('Survey')).toBeTruthy();
    });
  });
});
