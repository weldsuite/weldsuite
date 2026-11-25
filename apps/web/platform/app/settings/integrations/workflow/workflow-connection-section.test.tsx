import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: en, language: 'en', format: interpolate }) };
});

const { toast, perms, data, calls } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  perms: { granted: true },
  data: {
    loading: false,
    catalog: [] as unknown[],
    rows: [] as Array<{ id: string; type: string; status: string; connectedAt: string | null; lastError: string | null }>,
    linkStatus: 'connected' as 'connected' | 'needs_install',
    testResult: { success: true, message: '' },
    fail: false,
  },
  calls: { oauth: [] as unknown[], link: 0, test: [] as string[], disconnect: [] as string[] },
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ canAny: () => perms.granted, isLoading: false }) }));

type Callbacks<T> = { onSuccess?: (result: T) => void; onError?: (err: unknown) => void };
vi.mock('@/hooks/queries/use-workflow-integration-queries', () => ({
  useIntegrationCatalog: () => ({ isLoading: data.loading, data: { data: data.catalog } }),
  useWorkflowIntegrations: () => ({ isLoading: data.loading, data: { data: data.rows } }),
  useConnectWorkflowProvider: () => ({
    isPending: false,
    mutate: (input: unknown, cb?: Callbacks<unknown>) => {
      calls.oauth.push(input);
      if (data.fail) cb?.onError?.(new Error('nope'));
    },
  }),
  useConnectWorkflowProviderApiKey: () => ({ isPending: false, mutate: vi.fn() }),
  useLinkGithubInstallation: () => ({
    isPending: false,
    mutate: (_: unknown, cb?: Callbacks<{ data: { status: string } }>) => {
      calls.link += 1;
      if (data.fail) cb?.onError?.(new Error('nope'));
      else cb?.onSuccess?.({ data: { status: data.linkStatus } });
    },
  }),
  useDisconnectWorkflowIntegration: () => ({
    isPending: false,
    mutate: (id: string, cb?: Callbacks<unknown>) => {
      calls.disconnect.push(id);
      if (data.fail) cb?.onError?.(new Error('nope'));
      else cb?.onSuccess?.({});
    },
  }),
  useTestWorkflowIntegration: () => ({
    isPending: false,
    mutate: (id: string, cb?: Callbacks<{ data: { success: boolean; message: string } }>) => {
      calls.test.push(id);
      if (data.fail) cb?.onError?.(new Error('nope'));
      else cb?.onSuccess?.({ data: data.testResult });
    },
  }),
}));

import { en } from '@weldsuite/i18n/locales/en';
import { WorkflowConnectionSection } from './workflow-connection-section';

const copy = en.settings.integrations.workflowConnections;

const SLACK = {
  id: 'slack',
  type: 'slack',
  label: 'Slack',
  description: 'Slack',
  category: 'communication',
  icon: 'slack',
  auth: { kind: 'oauth2' },
  actions: [{ id: 'slack.post_message', name: 'Post Message' }],
  triggers: [{ id: 'slack.message', name: 'New message' }],
};
const GITHUB = { ...SLACK, id: 'github', type: 'github', label: 'GitHub', auth: { kind: 'app_installation' }, triggers: [] };

afterEach(() => {
  perms.granted = true;
  data.loading = false;
  data.catalog = [];
  data.rows = [];
  data.linkStatus = 'connected';
  data.testResult = { success: true, message: '' };
  data.fail = false;
  calls.oauth = [];
  calls.link = 0;
  calls.test = [];
  calls.disconnect = [];
  vi.clearAllMocks();
});

describe('WorkflowConnectionSection', () => {
  it('shows nothing for a provider the catalog lacks', () => {
    const { container } = render(<WorkflowConnectionSection type="slack" providerName="Slack" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('waits while the catalog loads', () => {
    data.loading = true;
    render(<WorkflowConnectionSection type="slack" providerName="Slack" />);
    expect(screen.getByRole('heading', { name: copy.sectionTitle })).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('connects over OAuth and comes back to this page', () => {
    data.catalog = [SLACK];
    render(<WorkflowConnectionSection type="slack" providerName="Slack" />);
    expect(screen.getByText('Post Message')).toBeInTheDocument();
    expect(screen.getByText('New message')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.connect }));
    expect(calls.oauth).toEqual([{ provider: 'slack', returnTo: window.location.pathname }]);
  });

  it('says when the OAuth start fails', () => {
    data.catalog = [SLACK];
    data.fail = true;
    render(<WorkflowConnectionSection type="slack" providerName="Slack" />);
    fireEvent.click(screen.getByRole('button', { name: copy.connect }));
    expect(toast.error).toHaveBeenCalledWith(copy.toasts.connectFailed);
  });

  it('offers no connect without the permission', () => {
    data.catalog = [SLACK];
    perms.granted = false;
    render(<WorkflowConnectionSection type="slack" providerName="Slack" />);
    expect(screen.queryByRole('button', { name: copy.connect })).toBeNull();
  });

  it('links the GitHub App installation, and says when it must be installed first', () => {
    data.catalog = [GITHUB];
    render(<WorkflowConnectionSection type="github" providerName="GitHub" connectLabel={copy.useInWorkflows} />);
    fireEvent.click(screen.getByRole('button', { name: copy.useInWorkflows }));
    expect(toast.success).toHaveBeenCalledWith(copy.toasts.connected);
    data.linkStatus = 'needs_install';
    fireEvent.click(screen.getByRole('button', { name: copy.useInWorkflows }));
    expect(toast.info).toHaveBeenCalledWith(copy.toasts.needsInstall);
    data.fail = true;
    fireEvent.click(screen.getByRole('button', { name: copy.useInWorkflows }));
    expect(toast.error).toHaveBeenCalledWith(copy.toasts.connectFailed);
    expect(calls.link).toBe(3);
  });

  it('tests the live connection and reports what the provider said', () => {
    data.catalog = [SLACK];
    data.rows = [
      { id: 'int_old', type: 'slack', status: 'disconnected', connectedAt: '2026-01-01T00:00:00Z', lastError: null },
      { id: 'int_live', type: 'slack', status: 'connected', connectedAt: '2026-11-20T10:00:00Z', lastError: null },
    ];
    render(<WorkflowConnectionSection type="slack" providerName="Slack" />);
    expect(screen.getByText(copy.connected)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.test }));
    expect(calls.test).toEqual(['int_live']);
    expect(toast.success).toHaveBeenCalledWith(copy.toasts.testSuccess);

    data.testResult = { success: false, message: 'token revoked' };
    fireEvent.click(screen.getByRole('button', { name: copy.test }));
    expect(toast.error).toHaveBeenCalledWith('token revoked');

    data.fail = true;
    fireEvent.click(screen.getByRole('button', { name: copy.test }));
    expect(toast.error).toHaveBeenCalledWith(copy.toasts.testFailed);
  });

  it('shows a failing connection with its error', () => {
    data.catalog = [SLACK];
    data.rows = [{ id: 'int_1', type: 'slack', status: 'connected', connectedAt: null, lastError: 'invalid_auth' }];
    render(<WorkflowConnectionSection type="slack" providerName="Slack" />);
    expect(screen.getByText(copy.error)).toBeInTheDocument();
    expect(screen.getByText('invalid_auth')).toBeInTheDocument();
  });

  it('disconnects after confirming', async () => {
    data.catalog = [SLACK];
    data.rows = [{ id: 'int_1', type: 'slack', status: 'connected', connectedAt: '2026-11-20T10:00:00Z', lastError: null }];
    render(<WorkflowConnectionSection type="slack" providerName="Slack" />);
    fireEvent.click(screen.getByRole('button', { name: copy.disconnect }));
    fireEvent.click(await screen.findByRole('button', { name: copy.disconnectConfirm.confirmLabel }));
    await waitFor(() => expect(calls.disconnect).toEqual(['int_1']));
    expect(toast.success).toHaveBeenCalledWith(copy.toasts.disconnected);
  });

  it('says when the disconnect fails', async () => {
    data.catalog = [SLACK];
    data.rows = [{ id: 'int_1', type: 'slack', status: 'connected', connectedAt: null, lastError: null }];
    data.fail = true;
    render(<WorkflowConnectionSection type="slack" providerName="Slack" />);
    fireEvent.click(screen.getByRole('button', { name: copy.disconnect }));
    fireEvent.click(await screen.findByRole('button', { name: copy.disconnectConfirm.confirmLabel }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(copy.toasts.disconnectFailed));
  });

  it('leaves the connection alone without the permission to manage it', () => {
    data.catalog = [SLACK];
    data.rows = [{ id: 'int_1', type: 'slack', status: 'connected', connectedAt: null, lastError: null }];
    perms.granted = false;
    render(<WorkflowConnectionSection type="slack" providerName="Slack" />);
    expect(screen.queryByRole('button', { name: copy.disconnect })).toBeNull();
    expect(screen.queryByRole('button', { name: copy.test })).toBeNull();
  });
});
