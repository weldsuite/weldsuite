import { FileText, Globe } from 'lucide-react';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { IntegrationDetailLayout } from '@/components/settings';
import { useI18n } from '@/lib/i18n/provider';
import type { TranslationNamespaces } from '@/lib/i18n';
import { workflowProviderIconUrl, type WorkflowProviderMeta } from './providers';
import { useWorkflowConnection } from './use-workflow-connection';
import { WorkflowConnectionDetails } from './workflow-connection-section';

type ListStrings = TranslationNamespaces['settings']['integrations']['list'];

const CATEGORY_KEYS: Record<WorkflowProviderMeta['category'], keyof ListStrings['categories']> = {
  Communication: 'communication',
  Productivity: 'productivity',
  Calendar: 'calendar',
  'Developer Tools': 'developerTools',
};

/**
 * A provider only workflow steps use (Gmail, Google Sheets, Microsoft Teams,
 * Twilio, Notion, Airtable, Asana): connect it here once, and every workflow
 * in the workspace can use it.
 */
export function WorkflowProviderPage({ provider }: Readonly<{ provider: WorkflowProviderMeta }>) {
  const { t, format } = useI18n();
  const settings = t.settings.integrations;
  const copy = settings.workflowConnections;
  const state = useWorkflowConnection(provider.type, provider.name);

  if (state.isLoading) return <PageLoader fullScreen={false} />;

  if (!state.def) {
    return (
      <div className="mx-auto w-full max-w-4xl p-6">
        <EmptyState title={settings.list.noneOfferedTitle} description={settings.list.noneOfferedDescription} />
      </div>
    );
  }

  const connected = Boolean(state.connection);

  return (
    <>
      <IntegrationDetailLayout
        name={provider.name}
        description={settings.list.descriptions[provider.descriptionKey]}
        category={settings.list.categories[CATEGORY_KEYS[provider.category]]}
        icon={
          <img
            src={workflowProviderIconUrl(provider)}
            alt={provider.name}
            className="h-7 w-7 rounded-[4px]"
            loading="lazy"
          />
        }
        connected={connected}
        canManage={connected ? state.canManage : state.canConnect}
        isWorking={state.working}
        connectLabel={copy.connect}
        disconnectLabel={copy.disconnect}
        onConnect={state.connect}
        onDisconnect={state.disconnect}
        provider={provider.name}
        resources={[
          { label: settings.documentation, href: provider.docs, icon: FileText },
          { label: settings.website, href: provider.website, icon: Globe },
        ]}
        overview={format(copy.overview, { provider: provider.name })}
      >
        <WorkflowConnectionDetails state={state} />
      </IntegrationDetailLayout>
      {state.dialogs}
    </>
  );
}
