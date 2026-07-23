
import React, { useEffect } from 'react';
import { useRouter, useSearchParams, Link } from '@/lib/router';
import { MessageCircle, Settings } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useChannelIntegrationStatus } from '@/hooks/queries/use-helpdesk-integration-queries';
import { ChannelConnectButton } from '../components/channel-connect-button';
import { HELPDESK_PROVIDERS } from '@/lib/integrations/helpdesk-providers';
import { EmptyStateIllustration } from '@/components/entity-list';

export default function DiscordInboxPage() {
  const { t } = useI18n();
  const ip = t.helpdesk.inboxPages;
  const router = useRouter();
  const searchParams = useSearchParams();

  const providerId = 'discord';
  const providerConfig = HELPDESK_PROVIDERS[providerId];

  const { data: integration, isLoading: integrationLoading, refetch: refetchIntegration } = useChannelIntegrationStatus(providerId);

  // Handle OAuth callback query params (success/error)
  useEffect(() => {
    const connected = searchParams.get('connected');
    const error = searchParams.get('error');

    if (connected === 'true') {
      toast.success(t.helpdesk.inbox.connectedSuccessfully.replace('{name}', providerConfig?.name || 'Discord'));
      router.replace('/welddesk/inbox/discord');
      refetchIntegration();
    } else if (error) {
      toast.error(error);
      router.replace('/welddesk/inbox/discord');
    }
  }, [searchParams]);

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
        <p className="text-sm text-muted-foreground max-w-[320px] leading-relaxed">{ip.checkingDiscord}</p>
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
              style={{ backgroundColor: '#5865F2' }}
            >
              <svg className="h-6 w-6 text-white" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <path d="M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.36-.76-.54-1.09c-.01-.02-.04-.03-.07-.03c-1.5.26-2.93.71-4.27 1.33c-.01 0-.02.01-.03.02c-2.72 4.07-3.47 8.03-3.1 11.95c0 .02.01.04.03.05c1.8 1.32 3.53 2.12 5.24 2.65c.03.01.06 0 .07-.02c.4-.55.76-1.13 1.07-1.74c.02-.04 0-.08-.04-.09c-.57-.22-1.11-.48-1.64-.78c-.04-.02-.04-.08-.01-.11c.11-.08.22-.17.33-.25c.02-.02.05-.02.07-.01c3.44 1.57 7.15 1.57 10.55 0c.02-.01.05-.01.07.01c.11.09.22.17.33.26c.04.03.04.09-.01.11c-.52.31-1.07.56-1.64.78c-.04.01-.05.06-.04.09c.32.61.68 1.19 1.07 1.74c.03.01.06.02.09.01c1.72-.53 3.45-1.33 5.25-2.65c.02-.01.03-.03.03-.05c.44-4.53-.73-8.46-3.1-11.95c-.01-.01-.02-.02-.04-.02zM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12c0 1.17-.84 2.12-1.89 2.12zm6.97 0c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12c0 1.17-.83 2.12-1.89 2.12z" />
              </svg>
            </div>
            <CardTitle className="text-lg">{ip.discordIntegrationTitle}</CardTitle>
            <CardDescription>{ip.discordIntegrationDesc}</CardDescription>
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
          href="/welddesk/settings/integrations/discord"
          className="inline-flex items-center justify-center rounded-md text-sm font-medium h-8 w-8 hover:bg-accent hover:text-accent-foreground text-muted-foreground transition-colors"
          title={ip.discordSettingsTitle}
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
      <h3 className="text-[15px] font-semibold text-foreground mb-1.5">{ip.noDiscordSelectedTitle}</h3>
      <p className="text-sm text-muted-foreground max-w-[320px] leading-relaxed">{ip.noDiscordSelectedDesc}</p>
    </div>
  );
}
