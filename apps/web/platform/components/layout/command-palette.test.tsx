import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { push, signOut, setTheme } = vi.hoisted(() => ({
  push: vi.fn(),
  signOut: vi.fn(),
  setTheme: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en }) };
});

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('@clerk/clerk-react', () => ({
  useOrganization: () => ({ organization: { id: 'org_test' } }),
  useClerk: () => ({ signOut }),
}));

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: () => true, isOwner: false }),
}));

vi.mock('@/hooks/use-installed-apps', () => ({
  useInstalledApps: () => ({
    data: [
      {
        id: 'weldcrm',
        workspaceId: '',
        appCode: 'weldcrm',
        name: 'WeldCRM',
        status: 'active',
        installedAt: '',
        displayOrder: 0,
        appType: 'system',
      },
    ],
    isLoading: false,
  }),
}));

vi.mock('@/hooks/queries/use-global-search-queries', () => ({
  useGlobalSearch: (q: string, opts?: { enabled?: boolean }) => ({
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
            ],
          }
        : undefined,
    isFetching: false,
    isPlaceholderData: false,
  }),
}));

vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ resolvedTheme: 'light', setTheme }),
}));

vi.mock('@/components/entity-sheet', () => ({
  useEntitySheet: () => ({ open: vi.fn() }),
  hasEntitySheetRenderer: () => false,
}));

import { CommandPalette, CommandPaletteTrigger, setCommandPaletteOpen } from './command-palette';

function openWithShortcut() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
}

describe('CommandPalette', () => {
  beforeEach(() => {
    push.mockReset();
    signOut.mockReset();
    setTheme.mockReset();
    setCommandPaletteOpen(false);
    window.localStorage.clear();
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
    expect(screen.queryByText('Customers')).not.toBeInTheDocument();
    expect(screen.queryByText('Acme Industries')).not.toBeInTheDocument();
  });

  it('filters to a page and navigates when that command is chosen', async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);
    openWithShortcut();

    const input = await screen.findByTestId('cmdk-input');
    await user.type(input, 'companies');

    expect(screen.getByText('Acme Industries')).toBeVisible();
    const option = await screen.findByRole('option', { name: /Companies/ });
    fireEvent.click(option);

    expect(push).toHaveBeenCalledWith('/weldcrm/companies');
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
  });

  it('toggles the theme from the actions group', async () => {
    render(<CommandPalette />);
    openWithShortcut();
    fireEvent.click(await screen.findByRole('option', { name: /Switch to dark mode/ }));
    expect(setTheme).toHaveBeenCalledWith('dark');
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
