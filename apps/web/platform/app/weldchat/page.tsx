import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useChannels } from '@/hooks/queries/use-weldchat-queries';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

export default function ChatPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { data, isLoading } = useChannels();

  useEffect(() => {
    if (!isLoading && data?.data) {
      const defaultChannel =
        data.data.find((ch) => ch.isDefault) || data.data[0];
      if (defaultChannel) {
        navigate({
          to: '/weldchat/$channelId',
          params: { channelId: defaultChannel.id },
        });
      }
    }
  }, [data, isLoading, navigate]);

  if (isLoading) return <PageLoader fullScreen={false} />;

  // No channels yet - show welcome
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center space-y-4">
        <h2 className="text-2xl font-semibold">{t.weldchat.page.welcome}</h2>
        <p className="text-muted-foreground">
          {t.weldchat.page.welcomeHint}
        </p>
      </div>
    </div>
  );
}
