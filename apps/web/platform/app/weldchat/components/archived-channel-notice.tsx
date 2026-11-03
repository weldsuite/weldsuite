import { Archive, ArchiveRestore } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { useUnarchiveChannel } from '@/hooks/queries/use-weldchat-queries';

/**
 * Takes the composer's place in an archived channel: the API refuses new
 * messages there, so the channel is read-only until someone unarchives it.
 * Unarchiving is up to the channel's owners and admins; the API answers
 * anyone else with a 403, shown as a toast.
 */
export function ArchivedChannelNotice({ channelId }: { channelId: string }) {
  const st = useTranslations();
  const { mutate: unarchive, isPending } = useUnarchiveChannel();

  return (
    <div className="border-t px-4 py-3" data-testid="archived-channel-notice">
      <div className="flex flex-wrap items-center gap-3 rounded-md bg-muted/60 px-3 py-2.5 text-sm text-muted-foreground">
        <Archive className="h-4 w-4 shrink-0" aria-hidden />
        <p className="min-w-0 flex-1">{st('sweep.weldchat.channelPage.archivedNotice')}</p>
        <Button
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={() =>
            unarchive(channelId, {
              onError: () => toast.error(st('sweep.weldchat.channelPage.unarchiveFailed')),
            })
          }
        >
          <ArchiveRestore className="h-4 w-4" aria-hidden />
          {st('sweep.weldchat.channelPage.unarchive')}
        </Button>
      </div>
    </div>
  );
}
