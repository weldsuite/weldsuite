import { useParams, useNavigate } from '@tanstack/react-router';
import { MessageList } from '../components/message-list';
import { MessageInput } from '../components/message-input';
import { X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useChannel } from '@/hooks/queries/use-weldchat-queries';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

export default function ThreadPage() {
  const { t } = useI18n();
  const st = useTranslations();
  const { channelId, messageId } = useParams({
    from: '/weldchat/$channelId/thread/$messageId',
  });
  const navigate = useNavigate();
  const { data } = useChannel(channelId);
  const channel = data?.data;

  useBreadcrumbs([
    { label: st('sweep.weldchat.breadcrumb.chat'), href: '/weldchat' },
    ...(channel ? [{ label: `${channel.type === 'private' ? '' : '#'}${channel.name}`, href: `/weldchat/${channelId}` }] : []),
    { label: t.weldchat.thread.title },
  ]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <h3 className="font-semibold">{t.weldchat.thread.title}</h3>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
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
