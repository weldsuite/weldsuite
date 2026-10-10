/**
 * Creating a workspace from a country a partner serves: the server answers
 * 409 PARTNER_TERRITORY and creates nothing, so the dialog shows who provides
 * WeldSuite there instead of an error.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { ApiError } from '@weldsuite/api-client';
import { CreateWorkspaceDialog } from './create-workspace-dialog';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  finalize: vi.fn(),
  submitRequest: vi.fn(),
}));

vi.mock('@/hooks/use-onboarding', () => ({
  useDatabaseStatus: () => ({ data: undefined }),
  useCreateWorkspace: () => ({ mutateAsync: mocks.create }),
  useFinalizeOnboarding: () => ({ mutateAsync: mocks.finalize }),
  useAvailableApps: () => ({
    isLoading: false,
    data: [{ code: 'crm', name: 'WeldCRM', description: '', icon: 'Users', category: 'sales', path: '/weldcrm' }],
  }),
}));
vi.mock('@/hooks/queries/use-partner-queries', () => ({
  useSubmitPartnerRequest: () => ({ mutateAsync: mocks.submitRequest, isPending: false }),
}));
vi.mock('@clerk/clerk-react', () => ({
  useOrganizationList: () => ({ setActive: vi.fn(), userMemberships: { revalidate: vi.fn() } }),
  useUser: () => ({ user: { primaryEmailAddress: { emailAddress: 'jane@customer.example' } } }),
}));

const territoryError = new ApiError('WeldSuite in Brazil is provided by Acme Partner', 409, {
  error: {
    code: 'PARTNER_TERRITORY',
    message: 'WeldSuite in Brazil is provided by Acme Partner',
    details: {
      country: 'BR',
      partner: {
        id: 'ptr_1',
        name: 'Acme Partner',
        logoUrl: null,
        websiteUrl: 'https://partner.example',
        supportEmail: 'help@partner.example',
        supportUrl: null,
      },
    },
  },
});

function renderDialog() {
  return render(
    <I18nProvider initialLanguage="en">
      <CreateWorkspaceDialog open onOpenChange={() => {}} />
    </I18nProvider>,
  );
}

async function fillAndCreate() {
  await userEvent.type(await screen.findByLabelText(/workspace name/i), 'Acme Industries');
  await userEvent.click(screen.getByRole('button', { name: /^create workspace$/i }));
}

describe('CreateWorkspaceDialog and partner territories', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.submitRequest.mockReset();
  });

  it('sends the chosen country with the new workspace', async () => {
    mocks.create.mockRejectedValue(new Error('stop here'));
    renderDialog();
    await fillAndCreate();

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    const body = mocks.create.mock.calls[0]![0] as { name: string; country?: string; selectedApps: string[] };
    expect(body.name).toBe('Acme Industries');
    expect(body.selectedApps).toEqual(['crm']);
    // Pre-filled from the browser locale; always an ISO-2 code.
    expect(body.country).toMatch(/^[A-Z]{2}$/);
  });

  it('shows the partner screen on 409 PARTNER_TERRITORY instead of an error', async () => {
    mocks.create.mockRejectedValue(territoryError);
    renderDialog();
    await fillAndCreate();

    expect(
      await screen.findByRole('heading', { name: 'WeldSuite in Brazil is provided by Acme Partner' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'help@partner.example' })).toBeInTheDocument();
    // The form is gone; the person is not left looking at a failed "Create".
    expect(screen.queryByRole('button', { name: /^create workspace$/i })).toBeNull();
  });

  it('files a request with the typed company and the chosen apps, then confirms it', async () => {
    mocks.create.mockRejectedValue(territoryError);
    mocks.submitRequest.mockResolvedValue({ data: { id: 'pwr_1' } });
    renderDialog();
    await fillAndCreate();

    await screen.findByRole('heading', { name: /provided by Acme Partner/ });
    await userEvent.click(screen.getByRole('button', { name: 'Send request' }));

    await waitFor(() =>
      expect(mocks.submitRequest).toHaveBeenCalledWith({
        companyName: 'Acme Industries',
        country: 'BR',
        selectedApps: ['crm'],
      }),
    );
    expect(await screen.findByText('Request sent')).toBeInTheDocument();
  });

  it('goes back to the form with the typed name intact', async () => {
    mocks.create.mockRejectedValue(territoryError);
    renderDialog();
    await fillAndCreate();
    await screen.findByRole('heading', { name: /provided by Acme Partner/ });

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(await screen.findByLabelText(/workspace name/i)).toHaveValue('Acme Industries');
  });
});
