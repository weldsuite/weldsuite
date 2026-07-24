
import React, { useEffect } from 'react';
import { useRouter, useSearchParams, Link } from '@/lib/router';
import { Settings } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useChannelIntegrationStatus } from '@/hooks/queries/use-helpdesk-integration-queries';
import { ChannelConnectButton } from '../components/channel-connect-button';
import { HELPDESK_PROVIDERS } from '@/lib/integrations/helpdesk-providers';
import { EmptyStateIllustration } from '@/components/entity-list';

export default function SlackInboxPage() {
  const { t } = useI18n();
  const ip = t.helpdesk.inboxPages;
  const router = useRouter();
  const searchParams = useSearchParams();

  const providerId = 'slack';
  const providerConfig = HELPDESK_PROVIDERS[providerId];

  const { data: integration, isLoading: integrationLoading, refetch: refetchIntegration } = useChannelIntegrationStatus(providerId);

  // Handle OAuth callback query params (success/error)
  useEffect(() => {
    const connected = searchParams.get('connected');
    const error = searchParams.get('error');

    if (connected === 'true') {
      toast.success(t.helpdesk.inbox.connectedSuccessfully.replace('{name}', providerConfig?.name || 'Slack'));
      router.replace('/welddesk/inbox/slack');
      refetchIntegration();
    } else if (error) {
      toast.error(error);
      router.replace('/welddesk/inbox/slack');
    }
  }, [searchParams, providerConfig?.name, refetchIntegration, router, t.helpdesk.inbox.connectedSuccessfully]);

  // Show loading state
  if (integrationLoading) {
    return (
      <div className="h-full flex-1 hidden md:flex flex-col items-center justify-center text-center px-6 bg-white dark:bg-background/30">
        <EmptyStateIllustration>
          <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M30 24h62a8 8 0 018 8v36a8 8 0 01-8 8H52l-10 10v-10h-12a8 8 0 01-8-8V32a8 8 0 018-8z" className="fill-white dark:fill-white/[0.03]" />
            <path d="M30 24h62a8 8 0 018 8v36a8 8 0 01-8 8H52l-10 10v-10h-12a8 8 0 01-8-8V32a8 8 0 018-8z" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
            <rect x="34" y="40" width="52" height="3" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
            <rect x="34" y="48" width="38" height="3" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
            <rect x="34" y="56" width="24" height="3" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
          </svg>
        </EmptyStateIllustration>
        <h3 className="text-[15px] font-semibold text-foreground mb-1.5">{ip.loadingTitle}</h3>
        <p className="text-sm text-muted-foreground max-w-[320px] leading-relaxed">{ip.checkingSlack}</p>
      </div>
    );
  }

  // Show integration setup if not connected
  if (!integration?.status) {
    return (
      <div className="bg-white dark:bg-background/30 flex flex-col h-full overflow-hidden flex-1 items-center justify-center">
        <Card className="w-full max-w-md border-dashed">
          <CardHeader className="text-center pb-2">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-2"
              style={{ backgroundColor: '#4A154B' }}
            >
              <svg className="h-6 w-6 text-white" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
              </svg>
            </div>
            <CardTitle className="text-lg">{ip.slackIntegrationTitle}</CardTitle>
            <CardDescription>{ip.slackIntegrationDesc}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Connect Button */}
            <ChannelConnectButton
              provider={providerId}
              integration={integration}
              onConnectionChange={() => refetchIntegration()}
              className="w-full"
              hideIcon
              buttonColor="#000000"
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  // Show default empty state when connected
  return (
    <div className="h-full flex-1 hidden md:flex flex-col items-center justify-center text-center px-6 bg-white dark:bg-background/30 relative">
      <div className="absolute top-4 right-4 flex items-center gap-1">
        <ChannelConnectButton
          provider={providerId}
          integration={integration}
          onConnectionChange={() => refetchIntegration()}
          variant="compact"
        />
        <Link
          href="/welddesk/settings/integrations/slack"
          className="inline-flex items-center justify-center rounded-md text-sm font-medium h-8 w-8 hover:bg-accent hover:text-accent-foreground text-muted-foreground transition-colors"
          title={ip.slackSettingsTitle}
        >
          <Settings className="h-4 w-4" />
        </Link>
      </div>
      <EmptyStateIllustration>
        <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M30 24h62a8 8 0 018 8v36a8 8 0 01-8 8H52l-10 10v-10h-12a8 8 0 01-8-8V32a8 8 0 018-8z" className="fill-white dark:fill-white/[0.03]" />
          <path d="M30 24h62a8 8 0 018 8v36a8 8 0 01-8 8H52l-10 10v-10h-12a8 8 0 01-8-8V32a8 8 0 018-8z" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
          <rect x="34" y="40" width="52" height="3" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
          <rect x="34" y="48" width="38" height="3" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
          <rect x="34" y="56" width="24" height="3" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
        </svg>
      </EmptyStateIllustration>
      <h3 className="text-[15px] font-semibold text-foreground mb-1.5">{ip.noSlackSelectedTitle}</h3>
      <p className="text-sm text-muted-foreground max-w-[320px] leading-relaxed">{ip.noSlackSelectedDesc}</p>
    </div>
  );
}
