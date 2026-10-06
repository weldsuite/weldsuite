import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const openPanel = vi.hoisted(() => vi.fn());
const permissions = vi.hoisted(() => ({
  isLoading: false,
  isOwner: false,
  grants: new Set<string>(['companies:create', 'people:create']),
  can: (key: string) => new Set<string>(['companies:create', 'people:create']).has(key),
}));

vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (key: string) =>
    ({
      'sweep.shared.searchAnythingPlaceholder': 'Search anything',
      'sweep.shared.recent': 'Recent',
      'sweep.shared.noResultsFound': 'No results found.',
      'sweep.shared.searching': 'Searching…',
      'sweep.shared.actions': 'Actions',
      'companies.actions.create': 'Create company',
      'people.actions.create': 'Create person',
      'crm.quickAddCompany.dialogTitle': 'Add company',
      'crm.quickAddPerson.dialogTitle': 'Add person',
    })[key] ?? key,
}));

vi.mock('@clerk/clerk-react', () => ({
  useOrganization: () => ({ organization: { id: 'org_1' } }),
}));

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/hooks/queries/use-global-search-queries', () => ({
  useGlobalSearch: () => ({ data: undefined, isFetching: false }),
}));

vi.mock('@/lib/search/recents', () => ({
  getRecents: () => [],
  pushRecent: vi.fn(),
}));

vi.mock('@/components/entity-sheet', () => ({
  useEntitySheet: () => ({ open: vi.fn() }),
  hasEntitySheetRenderer: () => false,
}));

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => permissions,
}));

vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: openPanel }),
}));

vi.mock('@/app/weldcrm/companies/components/quick-add-company-dialog', () => ({
  QuickAddCompanyDialog: ({
    open,
    onCreated,
  }: {
    open: boolean;
    onCreated?: (company: { id: string }) => void;
  }) =>
    open ? (
      <button type="button" data-testid="create-company-dialog" onClick={() => onCreated?.({ id: 'com_1' })}>
        save company
      </button>
    ) : null,
}));

vi.mock('@/app/weldcrm/people/components/quick-add-person-dialog', () => ({
  QuickAddPersonDialog: ({
    open,
    onCreated,
  }: {
    open: boolean;
    onCreated?: (person: { id: string }) => void;
  }) =>
    open ? (
      <button type="button" data-testid="create-person-dialog" onClick={() => onCreated?.({ id: 'per_1' })}>
        save person
      </button>
    ) : null,
}));

import { CommandPalette } from './command-palette';

function openPalette() {
  render(<CommandPalette />);
  const input = screen.getByTestId('cmdk-input');
  fireEvent.focus(input);
  return input;
}

describe('CommandPalette actions', () => {
  beforeEach(() => {
    openPanel.mockClear();
    permissions.isLoading = false;
    permissions.isOwner = false;
    permissions.grants = new Set(['companies:create', 'people:create']);
    permissions.can = (key: string) => permissions.grants.has(key);
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
  });

  it('offers create company and create person when the palette opens', () => {
    openPalette();
    expect(screen.getByText('Actions')).toBeInTheDocument();
    expect(screen.getByTestId('cmdk-action-company')).toHaveTextContent('Create company');
    expect(screen.getByTestId('cmdk-action-person')).toHaveTextContent('Create person');
  });

  it('narrows actions as the query is typed and ignores record searches', () => {
    const input = openPalette();
    fireEvent.change(input, { target: { value: 'create co' } });
    expect(screen.getByTestId('cmdk-action-company')).toBeInTheDocument();
    expect(screen.queryByTestId('cmdk-action-person')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'acme' } });
    expect(screen.queryByTestId('cmdk-action-company')).not.toBeInTheDocument();
    expect(screen.getByText('No results found.')).toBeInTheDocument();
  });

  it('hides an action the user cannot perform', () => {
    permissions.grants = new Set(['people:create']);
    openPalette();
    expect(screen.queryByTestId('cmdk-action-company')).not.toBeInTheDocument();
    expect(screen.getByTestId('cmdk-action-person')).toBeInTheDocument();
  });

  it('shows both actions for a workspace owner', () => {
    permissions.grants = new Set();
    permissions.isOwner = true;
    openPalette();
    expect(screen.getByTestId('cmdk-action-company')).toBeInTheDocument();
    expect(screen.getByTestId('cmdk-action-person')).toBeInTheDocument();
  });

  it('opens the company dialog and then the new company', () => {
    openPalette();
    fireEvent.click(screen.getByTestId('cmdk-action-company'));
    fireEvent.click(screen.getByTestId('create-company-dialog'));
    expect(openPanel).toHaveBeenCalledWith({ type: 'company', id: 'com_1' });
  });

  it('opens the person dialog and then the new person', () => {
    openPalette();
    fireEvent.click(screen.getByTestId('cmdk-action-person'));
    fireEvent.click(screen.getByTestId('create-person-dialog'));
    expect(openPanel).toHaveBeenCalledWith({ type: 'person', id: 'per_1' });
  });
});
