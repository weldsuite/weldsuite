import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: en, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ canAny: () => true, isLoading: false }) }));

const calls = vi.hoisted(() => ({ apiKey: [] as unknown[], oauth: [] as unknown[] }));
const idleMutation = { mutate: vi.fn(), isPending: false };
vi.mock('@/hooks/queries/use-workflow-integration-queries', () => ({
  useIntegrationCatalog: () => ({
    isLoading: false,
    data: {
      data: [
        {
          id: 'airtable',
          type: 'airtable',
          label: 'Airtable',
          description: 'Airtable',
          category: 'productivity',
          icon: 'table',
          auth: { kind: 'api_key', fields: [{ key: 'token', label: 'Personal Access Token', secret: true }] },
          actions: [{ id: 'airtable.create_record', name: 'Create record' }],
          triggers: [],
        },
      ],
    },
  }),
  useWorkflowIntegrations: () => ({ isLoading: false, data: { data: [] } }),
  useConnectWorkflowProvider: () => ({ ...idleMutation, mutate: (input: unknown) => calls.oauth.push(input) }),
  useConnectWorkflowProviderApiKey: () => ({ ...idleMutation, mutate: (input: unknown) => calls.apiKey.push(input) }),
  useLinkGithubInstallation: () => idleMutation,
  useDisconnectWorkflowIntegration: () => idleMutation,
  useTestWorkflowIntegration: () => idleMutation,
}));

import { WorkflowProviderPage } from './workflow-provider-page';
import { sharedPageProviderBySlug, workflowProviderByType } from './providers';

describe('WorkflowProviderPage', () => {
  it('connects an API-key provider with the form, not an OAuth redirect', async () => {
    // Airtable has no steps in the editor yet, so Settings doesn't list it; its page works the same once it does.
    render(<WorkflowProviderPage provider={workflowProviderByType('airtable')!} />);
    expect(screen.getByRole('heading', { name: 'Airtable' })).toBeInTheDocument();
    expect(screen.getByText('Create record')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    fireEvent.change(await screen.findByLabelText('Personal Access Token'), { target: { value: 'pat123' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Connect' }).at(-1)!);

    await waitFor(() => expect(calls.apiKey).toEqual([{ provider: 'airtable', credentials: { token: 'pat123' } }]));
    expect(calls.oauth).toEqual([]);
  });

  it('opens only for the providers the shared page serves', () => {
    expect(sharedPageProviderBySlug('google-sheets')?.type).toBe('google_sheets');
    expect(sharedPageProviderBySlug('gmail')?.type).toBe('gmail');
    // No steps in the editor yet: not offered.
    expect(sharedPageProviderBySlug('microsoft-teams')).toBeUndefined();
    // Slack, Google Calendar and GitHub have their own page.
    expect(sharedPageProviderBySlug('slack')).toBeUndefined();
    expect(sharedPageProviderBySlug('github')).toBeUndefined();
  });
});
