import { MessagesSquare } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { Link } from '@/lib/router';
import { useIsAppInstalled } from '@/hooks/use-is-app-installed';
import { getRecordChatTypeInfo, recordChatHref } from '../lib/record-chat-types';
import { RecordChatFollowButton } from './record-chat-follow-button';

interface RecordChatPanelBarProps {
  entityType: string;
  entityId: string;
  /** The record's chat; null until its first message creates it. */
  channelId: string | null | undefined;
}

/**
 * Slim bar above a record panel's chat: follow / unfollow the chat and open it
 * in WeldChat. Shown for the record types WeldChat lists, once the chat
 * exists, and only in a workspace that has WeldChat.
 */
export function RecordChatPanelBar({ entityType, entityId, channelId }: Readonly<RecordChatPanelBarProps>) {
  const st = useTranslations();
  const chatInstalled = useIsAppInstalled('weldchat');
  const info = getRecordChatTypeInfo(entityType);
  if (!info || !channelId || !chatInstalled) return null;

  return (
    <div className="flex h-10 flex-shrink-0 items-center justify-end gap-1 border-b px-2">
      <RecordChatFollowButton entityType={info.type} entityId={entityId} channelId={channelId} />
      <Button
        asChild
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
      >
        <Link href={recordChatHref(channelId)} data-testid="record-chat-open-in-weldchat">
          <MessagesSquare className="h-4 w-4" />
          {st('sweep.weldchat.recordChats.openInWeldChat')}
        </Link>
      </Button>
    </div>
  );
}
