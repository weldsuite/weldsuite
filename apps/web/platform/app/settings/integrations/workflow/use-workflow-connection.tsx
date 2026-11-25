import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { usePermissions } from '@weldsuite/permissions/react';
import { useI18n } from '@/lib/i18n/provider';
import {
  useConnectWorkflowProvider,
  useConnectWorkflowProviderApiKey,
  useDisconnectWorkflowIntegration,
  useIntegrationCatalog,
  useLinkGithubInstallation,
  useTestWorkflowIntegration,
  useWorkflowIntegrations,
  type IntegrationDef,
  type WorkflowIntegration,
} from '@/hooks/queries/use-workflow-integration-queries';
import { ApiKeyDialog } from './api-key-dialog';
import { liveConnection } from './providers';

export interface WorkflowConnection {
  def: IntegrationDef | undefined;
  connection: WorkflowIntegration | undefined;
  isLoading: boolean;
  canConnect: boolean;
  canManage: boolean;
  /** A connect, test or disconnect is running. */
  working: boolean;
  testing: boolean;
  connect: () => void;
  test: () => void;
  /** Asks first, then disconnects. */
  disconnect: () => void;
  /** The API-key form and the disconnect confirmation; render it once. */
  dialogs: ReactNode;
}

/**
 * One provider's workflow connection (`/api/workflow-integrations`): what the
 * catalog says about it, the workspace's live connection, and connect, test
 * and disconnect. OAuth providers leave for the provider and come back through
 * `/settings/integrations/callback`; API-key providers open a form; GitHub
 * links the workspace's GitHub App installation.
 */
export function useWorkflowConnection(type: string, providerName: string): WorkflowConnection {
  const { t } = useI18n();
  const copy = t.settings.integrations.workflowConnections;
  const { canAny } = usePermissions();
  const canConnect = canAny('integrations:create', 'weldconnect:integrations:create');
  const canManage = canAny('integrations:update', 'weldconnect:integrations:update');

  const catalog = useIntegrationCatalog();
  const connections = useWorkflowIntegrations();
  const connectOAuth = useConnectWorkflowProvider();
  const connectApiKey = useConnectWorkflowProviderApiKey();
  const linkGithub = useLinkGithubInstallation();
  const disconnectMutation = useDisconnectWorkflowIntegration();
  const testMutation = useTestWorkflowIntegration();

  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const def = useMemo(() => catalog.data?.data.find((entry) => entry.type === type), [catalog.data, type]);
  const connection = useMemo(() => liveConnection(connections.data?.data ?? [], type), [connections.data, type]);

  const connect = () => {
    if (!def) return;
    if (def.auth.kind === 'api_key') {
      setApiKeyOpen(true);
      return;
    }
    if (def.auth.kind === 'app_installation') {
      linkGithub.mutate(undefined, {
        onSuccess: (result) => {
          if (result.data.status === 'needs_install') toast.info(copy.toasts.needsInstall);
          else toast.success(copy.toasts.connected);
        },
        onError: () => toast.error(copy.toasts.connectFailed),
      });
      return;
    }
    connectOAuth.mutate(
      { provider: type, returnTo: window.location.pathname },
      { onError: () => toast.error(copy.toasts.connectFailed) },
    );
  };

  const submitApiKey = (credentials: Record<string, string>) => {
    connectApiKey.mutate(
      { provider: type, credentials },
      {
        onSuccess: () => {
          toast.success(copy.toasts.connected);
          setApiKeyOpen(false);
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : copy.toasts.connectFailed),
      },
    );
  };

  const test = () => {
    if (!connection) return;
    testMutation.mutate(connection.id, {
      onSuccess: (result) => {
        if (result.data.success) toast.success(result.data.message || copy.toasts.testSuccess);
        else toast.error(result.data.message || copy.toasts.testFailed);
      },
      onError: () => toast.error(copy.toasts.testFailed),
    });
  };

  const confirmDisconnect = () => {
    if (!connection) return;
    disconnectMutation.mutate(connection.id, {
      onSuccess: () => {
        toast.success(copy.toasts.disconnected);
        setConfirmOpen(false);
      },
      onError: () => {
        toast.error(copy.toasts.disconnectFailed);
        setConfirmOpen(false);
      },
    });
  };

  const dialogs = (
    <>
      <ApiKeyDialog
        open={apiKeyOpen}
        onOpenChange={setApiKeyOpen}
        providerName={providerName}
        fields={def?.auth.fields ?? []}
        pending={connectApiKey.isPending}
        onSubmit={submitApiKey}
      />
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={copy.disconnectConfirm.title}
        description={copy.disconnectConfirm.description}
        confirmLabel={copy.disconnectConfirm.confirmLabel}
        variant="destructive"
        loading={disconnectMutation.isPending}
        onConfirm={confirmDisconnect}
      />
    </>
  );

  return {
    def,
    connection,
    isLoading: catalog.isLoading || connections.isLoading,
    canConnect,
    canManage,
    working: connectOAuth.isPending || connectApiKey.isPending || linkGithub.isPending || disconnectMutation.isPending,
    testing: testMutation.isPending,
    connect,
    test,
    disconnect: () => setConfirmOpen(true),
    dialogs,
  };
}
