import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useChannels } from '@/hooks/queries/use-weldchat-queries';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { useLastWeldChatPage } from './hooks/use-last-weldchat-page';

export default function ChatPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const router = useRouter();
  const { data, isLoading } = useChannels();
  // Reopen the page the user last had open here; a deep link to a WeldChat page
  // never comes through this route, so it always wins.
  const lastPage = useLastWeldChatPage();

  useEffect(() => {
    if (lastPage === undefined) return;
    if (lastPage) {
      router.replace(lastPage);
      return;
    }
    if (!isLoading && data?.data) {
      const defaultChannel =
        data.data.find((ch) => ch.isDefault) || data.data[0];
      if (defaultChannel) {
        navigate({
          to: '/weldchat/$channelId',
          params: { channelId: defaultChannel.id },
          replace: true,
        });
      }
    }
  }, [lastPage, data, isLoading, navigate, router]);

  if (isLoading || lastPage === undefined) return <PageLoader fullScreen={false} />;

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
