import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NO_JURISDICTION_FEATURES } from '@/lib/weldbooks/jurisdiction';

const mocks = vi.hoisted(() => ({
  processing: false,
  selected: null as string | null,
  setEntityId: vi.fn(),
  setWeldbooksEntityId: vi.fn(),
  resetQueries: vi.fn(),
  entities: [] as Array<{ id: string }>,
}));

vi.mock('@tanstack/react-router', async () => {
  const { RouteLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: RouteLink };
});
vi.mock('@/hooks/use-current-accounting-entity', () => ({
  useCurrentAccountingEntity: () => ({ entityId: mocks.selected, setEntityId: mocks.setEntityId }),
}));
vi.mock('@/hooks/use-current-entity-currency', () => ({
  useAccountingEntities: () => ({ data: mocks.entities }),
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingSettings: () => ({ data: { data: { emailSettings: {} } }, isLoading: false }),
  resetEntityScopedAccountingQueries: mocks.resetQueries,
}));
vi.mock('@/lib/edition', () => ({ isFeatureAvailable: () => mocks.processing }));
vi.mock('./components/entity-inbox-card', () => ({
  EntityInboxCard: ({ entityId }: { entityId: string }) => <div data-testid="entity-inbox-card">{entityId}</div>,
}));
vi.mock('./components/differences-card', () => ({ DifferencesCard: () => <div data-testid="differences-card" /> }));
vi.mock('./components/email-templates-card', () => ({ EmailTemplatesCard: () => <div data-testid="email-templates-card" /> }));
vi.mock('./components/reminders-card', () => ({ RemindersCard: () => <div data-testid="reminders-settings-card" /> }));
vi.mock('@/lib/api/weldbooks-client', () => ({ setWeldbooksEntityId: mocks.setWeldbooksEntityId }));
vi.mock('@/lib/api/domains/weldbooks', () => ({ accountingApi: {} }));
vi.mock('./components/ledger-catch-up-card', () => ({ LedgerCatchUpCard: () => <div data-testid="ledger-catch-up" /> }));
vi.mock('./components/fiscal-settings-card', () => ({ FiscalSettingsCard: () => <div data-testid="fiscal-settings" /> }));
vi.mock('../vat/components/ecd-export-dialog', () => ({ EcdExportDialog: () => null }));
vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});

import { WeldbooksEntitySettings } from './entity-settings';

const entity = { id: 'ent_b', name: 'Beta BV' };

function renderSettings(features = NO_JURISDICTION_FEATURES) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <WeldbooksEntitySettings entity={entity} features={features} />
    </QueryClientProvider>,
  );
}

describe('WeldbooksEntitySettings', () => {
  beforeEach(() => {
    mocks.processing = false;
    mocks.selected = 'ent_b';
    mocks.entities = [{ id: 'ent_b' }];
    mocks.setEntityId.mockReset();
    mocks.setWeldbooksEntityId.mockReset();
    mocks.resetQueries.mockReset();
  });

  it('selects the entity in WeldBooks and waits for it when another entity is selected', () => {
    mocks.selected = 'ent_a';
    renderSettings();

    expect(mocks.setWeldbooksEntityId).toHaveBeenCalledWith('ent_b');
    expect(mocks.setEntityId).toHaveBeenCalledWith('ent_b');
    expect(mocks.resetQueries).toHaveBeenCalledTimes(1);
    // Nothing is fetched or shown for the previous entity.
    expect(screen.queryByTestId('ledger-catch-up')).not.toBeInTheDocument();
  });

  it('shows the settings of the selected entity and opens the dimensions and template pages', () => {
    renderSettings();

    expect(mocks.setEntityId).not.toHaveBeenCalled();
    expect(mocks.resetQueries).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Manage' })).toHaveAttribute('href', '/settings/apps/weldbooks');
    expect(screen.getByRole('link', { name: 'Manage templates' })).toHaveAttribute(
      'href',
      '/settings/entities/ent_b/invoice-templates',
    );
    expect(screen.getByTestId('ledger-catch-up')).toBeInTheDocument();
    expect(screen.getByText('Email Inbox')).toBeInTheDocument();
    expect(screen.getByText('Workflow templates')).toBeInTheDocument();
    // One entity: nothing to say about which one WeldBooks works in.
    expect(screen.queryByText(/WeldBooks now works in/)).not.toBeInTheDocument();
  });

  it('says which entity WeldBooks works in when the workspace has more than one', () => {
    mocks.entities = [{ id: 'ent_a' }, { id: 'ent_b' }];
    renderSettings();

    expect(screen.getByText(/WeldBooks now works in Beta BV/)).toBeInTheDocument();
  });

  it('shows the jurisdiction cards only for the features of the entity', () => {
    const { unmount } = renderSettings();
    expect(screen.queryByText('Auditfile (XAF 4.0)')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fiscal-settings')).not.toBeInTheDocument();
    unmount();

    renderSettings({ ...NO_JURISDICTION_FEATURES, xafExport: true, fiscalDocuments: true });
    expect(screen.getByText('Auditfile (XAF 4.0)')).toBeInTheDocument();
    expect(screen.getByTestId('fiscal-settings')).toBeInTheDocument();
  });

  it('shows the e-mail texts and the reminder workflow only where the edition has them', () => {
    renderSettings();
    expect(screen.queryByTestId('email-templates-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reminders-settings-card')).not.toBeInTheDocument();
    cleanup();

    mocks.processing = true;
    renderSettings();
    expect(screen.getByTestId('email-templates-card')).toBeInTheDocument();
    expect(screen.getByTestId('reminders-settings-card')).toBeInTheDocument();
  });

  it('shows the payment differences card only where the edition has bank processing', () => {
    const { unmount } = renderSettings();
    expect(screen.queryByTestId('differences-card')).not.toBeInTheDocument();
    unmount();
    mocks.processing = true;
    renderSettings();
    expect(screen.getByTestId('differences-card')).toBeInTheDocument();
  });

  it('shows the inbox address of the entity where the edition has receipts, else the single scan inbox', () => {
    const { unmount } = renderSettings();
    expect(screen.queryByTestId('entity-inbox-card')).not.toBeInTheDocument();
    expect(screen.getByText('Email Inbox')).toBeInTheDocument();
    unmount();
    mocks.processing = true;
    renderSettings();
    expect(screen.getByTestId('entity-inbox-card')).toHaveTextContent('ent_b');
    expect(screen.queryByText('Email Inbox')).not.toBeInTheDocument();
  });
});
