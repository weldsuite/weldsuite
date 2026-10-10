import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { RecordSelectionModal } from './record-selection-modal';

const get = vi.fn(async (url: string) => {
  if (url.startsWith('/companies')) {
    return { data: [{ id: 'co_1', displayName: 'Acme BV' }] };
  }
  return { data: [{ id: 'pe_1', displayName: 'Jane Doe', email: 'jane@acme.test' }] };
});
const client = { get };
const getClient = async () => client;

vi.mock('@/lib/api/use-app-api', () => ({
  // A new function identity on every render, like an unstable auth callback.
  useAppApiClient: () => ({ getClient: async () => getClient() }),
}));

vi.mock('@/app/weldcrm/people/components/quick-add-person-dialog', () => ({
  QuickAddPersonDialog: () => null,
}));

describe('RecordSelectionModal', () => {
  it('shows recent companies and people on open with an empty search', async () => {
    render(
      <I18nProvider initialLanguage="en">
        <RecordSelectionModal open onOpenChange={() => {}} onSelectRecord={() => {}} />
      </I18nProvider>,
    );

    expect(await screen.findByText('Acme BV')).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.queryByText(/Searching/)).not.toBeInTheDocument();
    // No search term: no `search` param, the API's default order is newest first.
    expect(get).toHaveBeenCalledWith('/companies?limit=50');
  });

  it('selects the record when its name text is clicked', async () => {
    const user = userEvent.setup();
    const onSelectRecord = vi.fn();
    render(
      <I18nProvider initialLanguage="en">
        <RecordSelectionModal open onOpenChange={() => {}} onSelectRecord={onSelectRecord} />
      </I18nProvider>,
    );

    await user.click(await screen.findByText('Acme BV'));
    expect(onSelectRecord).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'co_1', kind: 'company', displayName: 'Acme BV' }),
    );
  });
});
