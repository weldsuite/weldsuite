import { FileText, Globe } from 'lucide-react';
import { IntegrationDetailLayout } from '@/components/settings';
import { useI18n } from '@/lib/i18n/provider';
import { isFeatureAvailable, isModuleOffered } from '@/lib/edition';
import { useAppAccess } from '@/hooks/use-app-access';
import { HelpdeskSlackSection } from '@/app/welddesk/settings/integrations/slack/helpdesk-slack-section';
import { WorkflowConnectionSection } from '../workflow/workflow-connection-section';

/**
 * Slack on Settings → Integrations: WeldDesk's helpdesk channel (where
 * WeldDesk is installed and the edition runs it) and the connection
 * WeldConnect workflows post with. Each has its own connect.
 */
export default function SlackIntegrationPage() {
  const { t } = useI18n();
  const settings = t.settings.integrations;
  const desk = useAppAccess('welddesk');
  const showHelpdesk =
    isFeatureAvailable('integration-sync') && isModuleOffered('desk') && !desk.isLoading && desk.isInstalled;

  return (
    <IntegrationDetailLayout
      name="Slack"
      description={settings.list.descriptions.slack}
      category={settings.list.categories.communication}
      icon={
        <img
          src="https://upload.wikimedia.org/wikipedia/commons/d/d5/Slack_icon_2019.svg"
          alt="Slack"
          className="h-[26px] w-[26px]"
        />
      }
      connected={false}
      canManage={false}
      provider="Slack"
      resources={[
        { label: settings.website, href: 'https://slack.com', icon: Globe },
        { label: settings.documentation, href: 'https://api.slack.com', icon: FileText },
      ]}
      overview={settings.slackPage.overview}
    >
      {showHelpdesk ? <HelpdeskSlackSection /> : null}
      <WorkflowConnectionSection type="slack" providerName="Slack" />
    </IntegrationDetailLayout>
  );
}
