import { useCallback } from 'react';
import { toast } from 'sonner';
import { useSyncBankFeed } from '@/hooks/queries/use-weldbooks-bank-feeds-queries';
import { describeFeedError, feedErrorText } from './describe-error';
import { useFeedTexts } from './feed-texts';
import { describeSyncOutcome } from './sync-outcome';

/** A manual sync of one connection, answered with a toast. `refresh` asks the provider to fetch fresh data first. */
export function useSyncFeedAction(connectionId: string) {
  const { t, format, plural } = useFeedTexts();
  const { mutate, isPending } = useSyncBankFeed();

  const run = useCallback(
    (refresh = false) => {
      mutate(
        { connectionId, refresh },
        {
          onSuccess: ({ outcome }) => {
            const message = describeSyncOutcome(outcome, t, format, plural);
            if (message.kind === 'error') toast.error(message.text);
            else if (message.kind === 'info') toast.info(message.text);
            else toast.success(message.text);
          },
          onError: (err) => toast.error(feedErrorText(describeFeedError(err, t), t, format)),
        },
      );
    },
    [mutate, connectionId, t, format, plural],
  );

  return { run, isPending };
}
