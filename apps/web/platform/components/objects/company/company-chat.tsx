/**
 * Company chat sidebar. Self-contained: channel + message hooks live in
 * `./use-company-data` and target `apps/workers/app-api` directly. The shared
 * `ObjectChatShell` just renders the loading → empty composer → live
 * channel state machine.
 */

import { useCallback } from 'react';
import {
  ObjectChatShell,
  type ObjectChannel,
} from '@/components/objects/_shared/object-chat';
import { useCompanyChannel, useSendCompanyMessage, companyKeys } from './use-company-data';

interface CompanyChatProps {
  companyId: string;
  companyName?: string;
}

export function CompanyChat({ companyId, companyName }: CompanyChatProps) {
  const channelQuery = useCompanyChannel(companyId);
  const sendMutation = useSendCompanyMessage(companyId);

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
          channelQueryKey={companyKeys.channel(companyId)}
          fallbackName={companyName}
          hideHeader
        />
      </div>
    </div>
  );
}
