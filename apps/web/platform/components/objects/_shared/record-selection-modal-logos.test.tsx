import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { RecordSelectionModal } from './record-selection-modal';

const get = vi.fn(async (url: string) => {
  if (url.startsWith('/companies')) {
    return {
      data: [
        { id: 'co_1', displayName: 'Acme BV', website: 'https://www.acme.com/' },
        { id: 'co_2', displayName: 'Mailbox Co', email: 'owner@gmail.com' },
        { id: 'co_3', displayName: 'Own Image BV', website: 'own.example.org', avatarUrl: 'https://cdn.test/own.png' },
      ],
    };
  }
  return { data: [] };
});
const post = vi.fn(async (_path: string, body: { domains: string[] }) => ({
  data: { logos: Object.fromEntries(body.domains.map((d) => [d, null])) },
}));
const client = { get, post };
const getClient = async () => client;

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient }),
}));

vi.mock('@/app/weldcrm/people/components/quick-add-person-dialog', () => ({
  QuickAddPersonDialog: () => null,
}));

describe('RecordSelectionModal company logos', () => {
  it('looks company logos up through our own API, never a favicon service', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(
      <I18nProvider initialLanguage="en">
        <RecordSelectionModal open kind="company" onOpenChange={() => {}} onSelectRecord={() => {}} />
      </I18nProvider>,
    );

    expect(await screen.findByText('Acme BV')).toBeInTheDocument();
    // Only the company with a public website and no image of its own is looked up:
    // a mailbox-provider email and a company with its own avatar are not.
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith('/company-logos/resolve', { domains: ['acme.com'] });

    // No request to anything but the API, and no external image in the list.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.querySelector('img[src*="google"]')).toBeNull();
    fetchSpy.mockRestore();
  });
});
