import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { push, signOut, setTheme, openPanel } = vi.hoisted(() => ({
  push: vi.fn(),
  signOut: vi.fn(),
  setTheme: vi.fn(),
  openPanel: vi.fn(),
}));

const access = vi.hoisted(() => ({
  isOwner: false,
  allowAll: true,
  grants: new Set<string>(),
  appEnforced: false,
}));

const route = vi.hoisted(() => ({ pathname: '/' }));

/** What each `useGlobalSearch` call asked for: the opt-in WeldBooks types are searched by a request that names them. */
const search = vi.hoisted(() => ({ calls: [] as Array<{ q: string; types?: string[]; enabled?: boolean }> }));

const WELDCRM = {
  id: 'weldcrm',
  workspaceId: '',
  appCode: 'weldcrm',
  name: 'WeldCRM',
  status: 'active' as const,
  installedAt: '',
  displayOrder: 0,
  appType: 'system' as const,
};

const WELDBOOKS = { ...WELDCRM, id: 'weldbooks', appCode: 'weldbooks', name: 'WeldBooks' };

const installedState = vi.hoisted(() => ({
  apps: [] as Array<typeof WELDCRM>,
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en }) };
});

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push }),
  usePathname: () => route.pathname,
}));

vi.mock('@clerk/clerk-react', () => ({
  useOrganization: () => ({ organization: { id: 'org_test' } }),
  useAuth: () => ({ signOut }),
}));

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({
    isOwner: access.isOwner,
    isLoading: false,
    appEnforced: access.appEnforced,
    permissions: access.allowAll ? ['*'] : [...access.grants],
    denies: [],
  }),
}));

vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({
    features: { vatReturn: false, gstReturn: false, brTaxReturn: false, fiscalDocuments: false, form1099: false, salesTax: false },
    isResolved: true,
    isError: false,
  }),
}));

vi.mock('@/hooks/use-installed-apps', () => ({
  useInstalledApps: () => ({
    data: installedState.apps,
    isLoading: false,
  }),
}));

vi.mock('@/hooks/queries/use-global-search-queries', () => ({
  useGlobalSearch: (q: string, opts?: { enabled?: boolean; types?: string[] }) => {
    search.calls.push({ q, types: opts?.types, enabled: opts?.enabled });
    if (opts?.types?.includes('bank_transaction')) {
      return {
        data:
          (opts.enabled ?? true) && q.trim().length >= 2
            ? {
                data: [
                  {
                    type: 'bank_transaction',
                    items: [{ id: 'btx_1', type: 'bank_transaction', title: 'Paper Co', subtitle: '221.00', url: '/weldbooks/banking/transactions?stack=bank_transaction:btx_1' }],
                  },
                  {
                    type: 'accounting_contact',
                    items: [{ id: 'prt_1', type: 'accounting_contact', title: 'Paper Co BV', subtitle: null, url: '/weldbooks/contacts?stack=weldbooks_contact:prt_1' }],
                  },
                  {
                    type: 'accounting_document',
                    items: [{ id: 'doc_1', type: 'accounting_document', title: 'receipt.pdf', subtitle: null, url: '/weldbooks/documents?document=doc_1' }],
                  },
                ],
              }
            : undefined,
        isFetching: false,
        isPlaceholderData: false,
      };
    }
    return {
    data:
      (opts?.enabled ?? true) && q.trim().length >= 2
        ? {
            data: [
              {
                type: 'customer',
                items: [
                  {
                    id: 'cus_acme',
                    type: 'customer',
                    title: 'Acme Industries',
                    subtitle: 'Customer',
                    url: '/weldcrm/companies/cus_acme',
                  },
                ],
              },
              ...(q.includes('budget')
                ? [
                    {
                      type: 'sheet',
                      items: [
                        {
                          id: 'sht_1',
                          type: 'sheet',
                          title: 'Budget 2026',
                          subtitle: null,
                          url: '/weldsheets/sht_1',
                        },
                      ],
                    },
                  ]
                : []),
            ],
          }
        : undefined,
    isFetching: false,
    isPlaceholderData: false,
    };
  },
}));

vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ resolvedTheme: 'light', setTheme }),
}));

vi.mock('@/components/entity-sheet', () => ({
  useEntitySheet: () => ({ open: vi.fn() }),
  hasEntitySheetRenderer: () => false,
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

import { setRuntimeConfig } from '@/lib/runtime-config';
import { CommandPalette, CommandPaletteTrigger, setCommandPaletteOpen } from './command-palette';

function openWithShortcut() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
}

describe('CommandPalette', () => {
  beforeEach(() => {
    push.mockReset();
    signOut.mockReset();
    setTheme.mockReset();
    openPanel.mockReset();
    access.isOwner = false;
    access.allowAll = true;
    access.grants = new Set();
    access.appEnforced = false;
    route.pathname = '/';
    installedState.apps = [{ ...WELDCRM }];
    setCommandPaletteOpen(false);
    window.localStorage.clear();
    search.calls = [];
    setRuntimeConfig(null);
  });

  it('opens a centered dialog of commands from Ctrl+K, not a record list', async () => {
    render(
      <>
        <CommandPaletteTrigger />
        <CommandPalette />
      </>,
    );

    expect(screen.getByTestId('cmdk-trigger')).toBeVisible();
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();

    openWithShortcut();

    const dialog = await screen.findByTestId('command-palette');
    expect(dialog.className).toContain('top-[50%]');
    expect(dialog.className).toContain('left-[50%]');
    expect(screen.getByTestId('cmdk-input')).toHaveFocus();
    expect(screen.getByText('WeldCRM')).toBeVisible();
    expect(screen.getByText('Switch to dark mode')).toBeVisible();
    expect(screen.queryByText('Companies')).not.toBeInTheDocument();
    expect(screen.queryByText('Acme Industries')).not.toBeInTheDocument();
  });

  it('leaves Ctrl+K to a focused editor that already used it (a link in WeldDocs)', () => {
    render(<CommandPalette />);
    const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
  });

  it('filters to a page and navigates when that command is chosen', async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);
    openWithShortcut();

    const input = await screen.findByTestId('cmdk-input');
    await user.type(input, 'companies');

    expect(screen.getByText('Acme Industries')).toBeVisible();
    const option = await screen.findByRole('option', { name: /^Companies/ });
    fireEvent.click(option);

    expect(push).toHaveBeenCalledWith('/weldcrm/companies');
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
  });

  it('lists a company record under Companies and opens it in the company panel', async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);
    openWithShortcut();

    await user.type(await screen.findByTestId('cmdk-input'), 'acme');

    const record = within(await screen.findByRole('group', { name: 'Companies' })).getByRole('option', {
      name: /Acme Industries/,
    });
    expect(screen.queryByRole('group', { name: 'Customers' })).not.toBeInTheDocument();
    fireEvent.click(record);

    expect(openPanel).toHaveBeenCalledWith({ type: 'company', id: 'cus_acme' });
    expect(push).not.toHaveBeenCalled();
  });

  it('groups records by type and opens a spreadsheet on its page, since it has no entity sheet', async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);
    openWithShortcut();

    await user.type(await screen.findByTestId('cmdk-input'), 'budget');

    expect(await screen.findByRole('group', { name: 'Companies' })).toBeVisible();
    const record = within(screen.getByRole('group', { name: 'Spreadsheets' })).getByRole('option', {
      name: /Budget 2026/,
    });
    fireEvent.click(record);

    expect(push).toHaveBeenCalledWith('/weldsheets/sht_1');
    expect(openPanel).not.toHaveBeenCalled();
  });

  describe('WeldBooks records', () => {
    const BOOKS_TYPES = ['bank_transaction', 'accounting_contact', 'accounting_document'];
    const type = async (text: string) => {
      const user = userEvent.setup();
      render(<CommandPalette />);
      openWithShortcut();
      await user.type(await screen.findByTestId('cmdk-input'), text);
      return user;
    };

    it('asks for bank lines, contacts and inbox documents where WeldBooks is installed and the edition serves them', async () => {
      setRuntimeConfig({ backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] });
      installedState.apps = [{ ...WELDCRM }, { ...WELDBOOKS }];
      await type('paper');
      expect(search.calls.some((call) => call.enabled && call.types?.join() === BOOKS_TYPES.join())).toBe(true);
      // The usual search still runs, without a list of types: the opt-in ones are an extra request.
      expect(search.calls.some((call) => call.enabled && call.types === undefined)).toBe(true);
    });

    it('does not ask for them without WeldBooks, or on an edition without the to-process backend', async () => {
      setRuntimeConfig({ backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] });
      installedState.apps = [{ ...WELDCRM }];
      await type('paper');
      expect(search.calls.filter((call) => call.enabled && call.types?.length)).toEqual([]);
    });

    it('opens a bank line in its panel, in place', async () => {
      setRuntimeConfig({ backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] });
      installedState.apps = [{ ...WELDCRM }, { ...WELDBOOKS }];
      const user = await type('paper');

      expect(screen.getByText('Bank transactions')).toBeVisible();
      await user.click(screen.getByText('Paper Co'));
      expect(openPanel).toHaveBeenCalledWith({ type: 'bank_transaction', id: 'btx_1' });
    });

    it('opens a contact in the contact panel', async () => {
      setRuntimeConfig({ backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] });
      installedState.apps = [{ ...WELDCRM }, { ...WELDBOOKS }];
      const user = await type('paper');
      await user.click(screen.getByText('Paper Co BV'));
      expect(openPanel).toHaveBeenCalledWith({ type: 'weldbooks_contact', id: 'prt_1' });
    });

    it('opens an inbox document on the documents page, which opens its dialog', async () => {
      setRuntimeConfig({ backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] });
      installedState.apps = [{ ...WELDCRM }, { ...WELDBOOKS }];
      const user = await type('paper');
      await user.click(screen.getByText('receipt.pdf'));
      expect(push).toHaveBeenCalledWith('/weldbooks/documents?document=doc_1');
    });
  });

  it('toggles the theme from the actions group', async () => {
    render(<CommandPalette />);
    openWithShortcut();
    fireEvent.click(await screen.findByRole('option', { name: /Switch to dark mode/ }));
    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  it('offers create company and create person when the member and the installed apps allow it', async () => {
    render(<CommandPalette />);
    openWithShortcut();
    expect(await screen.findByRole('option', { name: 'Create company' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'Create person' })).toBeVisible();
  });

  it('hides a create action the member cannot perform, and hides both when no installed app uses that record', async () => {
    access.allowAll = false;
    access.grants = new Set(['people:create']);
    const { unmount } = render(<CommandPalette />);
    openWithShortcut();
    expect(await screen.findByRole('option', { name: 'Create person' })).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Create company' })).not.toBeInTheDocument();
    unmount();
    setCommandPaletteOpen(false);

    access.isOwner = true;
    installedState.apps = [{ ...WELDCRM, id: 'weldstash', appCode: 'weldstash', name: 'WeldStash' }];
    render(<CommandPalette />);
    openWithShortcut();
    expect(await screen.findByRole('option', { name: /Switch to dark mode/ })).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Create company' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Create person' })).not.toBeInTheDocument();
  });

  it('opens the quick-add dialog and then the new company', async () => {
    render(<CommandPalette />);
    openWithShortcut();
    fireEvent.click(await screen.findByRole('option', { name: 'Create company' }));
    fireEvent.click(await screen.findByTestId('create-company-dialog'));
    expect(openPanel).toHaveBeenCalledWith({ type: 'company', id: 'com_1' });
  });

  it("offers every installed app's Create actions when typing and opens that app's page to start it", async () => {
    const user = userEvent.setup();
    installedState.apps = [{ ...WELDCRM }, { ...WELDCRM, id: 'welddocs', appCode: 'welddocs', name: 'WeldDocs' }];
    route.pathname = '/weldcrm';
    render(<CommandPalette />);
    openWithShortcut();

    expect(await screen.findByRole('option', { name: /Create task/ })).toBeVisible();
    expect(screen.queryByRole('option', { name: /Create document/ })).not.toBeInTheDocument();

    await user.type(screen.getByTestId('cmdk-input'), 'create doc');
    fireEvent.click(await screen.findByRole('option', { name: /Create document/ }));
    expect(push).toHaveBeenCalledWith('/welddocs?new=1');
  });

  it("checks a Create action's permission in the app it creates in, not the current one", async () => {
    const user = userEvent.setup();
    installedState.apps = [{ ...WELDCRM }, { ...WELDCRM, id: 'welddocs', appCode: 'welddocs', name: 'WeldDocs' }];
    route.pathname = '/weldcrm';
    access.allowAll = false;
    access.appEnforced = true;
    access.grants = new Set(['welddocs:docs:create']);
    const { unmount } = render(<CommandPalette />);
    openWithShortcut();
    await user.type(await screen.findByTestId('cmdk-input'), 'create');
    expect(await screen.findByRole('option', { name: /Create document/ })).toBeVisible();
    unmount();
    setCommandPaletteOpen(false);

    access.grants = new Set(['weldcrm:docs:create']);
    render(<CommandPalette />);
    openWithShortcut();
    await user.type(await screen.findByTestId('cmdk-input'), 'create');
    expect(screen.queryByRole('option', { name: /Create document/ })).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);
    openWithShortcut();
    expect(await screen.findByTestId('command-palette')).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
  });
});
