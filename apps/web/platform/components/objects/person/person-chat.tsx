/**
 * Person chat sidebar. Self-contained: channel + message hooks live in
 * `./use-person-data` and target `apps/workers/app-api` directly.
 */

import { useCallback } from 'react';
import {
  ObjectChatShell,
  type ObjectChannel,
} from '@/components/objects/_shared/object-chat';
import { usePersonChannel, useSendPersonMessage, personKeys } from './use-person-data';

interface PersonChatProps {
  personId: string;
  personName?: string;
}

export function PersonChat({ personId, personName }: PersonChatProps) {
  const channelQuery = usePersonChannel(personId);
  const sendMutation = useSendPersonMessage(personId);

  const handleSendFirstMessage = useCallback(
    async (payload: { content: string; mentions: string[] }) => {
      const result = await sendMutation.mutateAsync({
        content: payload.content,
        mentions: payload.mentions,
      });
      return {
        channel: result.data.channel as unknown as ObjectChannel,
        message: result.data.message,
      };
    },
    [sendMutation],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex min-h-0 flex-1 flex-col">
        <ObjectChatShell
          channelQuery={channelQuery as never}
          onSendFirstMessage={handleSendFirstMessage}
          channelQueryKey={personKeys.channel(personId)}
          fallbackName={personName}
          hideHeader
        />
      </div>
    </div>
  );
}
