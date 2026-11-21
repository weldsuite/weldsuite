import { useEffect } from 'react';
import { useParams, useNavigate } from '@tanstack/react-router';
import { MessageList } from '../components/message-list';
import { MessageInput } from '../components/message-input';
import { useChatContext } from '../components/chat-context';
import { X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useChannel } from '@/hooks/queries/use-weldchat-queries';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

/**
 * A thread's link (`/weldchat/<channel>/thread/<message>`, from a draft, a
 * notification or a bookmark). A channel's thread opens in the side panel
 * beside the channel, as a click on "N replies" does: this page hands it to
 * the panel and replaces itself with the channel's own URL. A DM shows no side
 * panel, so a DM's thread keeps this page of its own.
 */
export default function ThreadPage() {
  const { t } = useI18n();
  const st = useTranslations();
  const { channelId, messageId } = useParams({
    from: '/weldchat/$channelId/thread/$messageId',
  });
  const navigate = useNavigate();
  const { openThread } = useChatContext();
  const { data, isError } = useChannel(channelId);
  const channel = data?.data;
  const opensInPanel = !!channel && channel.type !== 'dm';

  useEffect(() => {
    if (!opensInPanel) return;
    openThread(messageId);
    void navigate({ to: '/weldchat/$channelId', params: { channelId }, replace: true });
  }, [opensInPanel, channelId, messageId, openThread, navigate]);

  useBreadcrumbs([
    { label: st('sweep.weldchat.breadcrumb.chat'), href: '/weldchat' },
    ...(channel ? [{ label: `${channel.type === 'private' ? '' : '#'}${channel.name}`, href: `/weldchat/${channelId}` }] : []),
    { label: t.weldchat.thread.title },
  ]);

  // Nothing while the channel loads; a DM's thread, or one whose channel can't
  // be loaded, shows on this page.
  if (opensInPanel || (!channel && !isError)) return null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <h3 className="font-semibold">{t.weldchat.thread.title}</h3>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label={t.weldchat.threadPanel.close}
          onClick={() =>
            navigate({
              to: '/weldchat/$channelId',
              params: { channelId },
            })
          }
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-auto">
        <MessageList channelId={channelId} parentId={messageId} />
      </div>
      <MessageInput channelId={channelId} parentId={messageId} />
    </div>
  );
}
