/**
 * The buttons at the top of a sent request. Each one shows only when the server
 * says the caller may use it (`mySignerId`, `canRemind`, `canVoid`), so a
 * recipient who is not an owner sees the request and nothing to act on.
 */

import { Ban, BellRing, Download, Eye, PenLine } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import type { SignEnvelopeDetail } from '@weldsuite/app-api-client/schemas/weldsign';
import { useI18n } from '@/lib/i18n/provider';
import { useDownloadSignedPdf, useRemindSignEnvelope, useSignSigningLink } from '@/hooks/queries/use-weldsign-queries';
import { isConflict, lifecycleErrorMessage } from '../lib/errors';

interface OverviewActionsProps {
  envelope: SignEnvelopeDetail;
  onViewDocuments: () => void;
  onVoid: () => void;
}

export function OverviewActions({ envelope, onViewDocuments, onVoid }: Readonly<OverviewActionsProps>) {
  const { t, format } = useI18n();
  const to = t.weldsign.overview;
  const download = useDownloadSignedPdf(envelope.id);
  const signLink = useSignSigningLink(envelope.id, (err) => toast.error(lifecycleErrorMessage(err, to.signNowFailed, to.notOpen)));
  // A 409 here almost always means everyone was reminded a moment ago.
  const remind = useRemindSignEnvelope(envelope.id, (err) =>
    toast.error(isConflict(err) ? to.remindedRecently : lifecycleErrorMessage(err, to.remindFailed, to.notOpen)),
  );

  const signNow = () => {
    // Open the tab on the click itself: Safari blocks a window opened once the request is back.
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    signLink.mutate(undefined, {
      onSuccess: (url) => {
        if (tab) tab.location.href = url;
        else window.open(url, '_blank', 'noopener');
      },
      onError: () => tab?.close(),
    });
  };
  const sendReminders = () =>
    remind.mutate(undefined, {
      onSuccess: (count) => {
        if (count === 0) toast.info(to.remindedRecently);
        else toast.success(format(count === 1 ? to.remindedOne : to.remindedMany, { count }));
      },
    });

  return (
    <div className="flex flex-wrap gap-2">
      {envelope.mySignerId && (
        <Button size="sm" disabled={signLink.isPending} onClick={signNow}>
          <PenLine />
          {to.signNow}
        </Button>
      )}
      {envelope.canRemind && (
        <Button variant="outline" size="sm" disabled={remind.isPending} onClick={sendReminders}>
          <BellRing />
          {to.remind}
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={onViewDocuments}>
        <Eye />
        {to.viewDocuments}
      </Button>
      {envelope.canVoid && (
        <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={onVoid}>
          <Ban />
          {to.void.action}
        </Button>
      )}
      {envelope.status === 'completed' && (
        <Button
          size="sm"
          disabled={download.isPending}
          onClick={() => download.mutate(envelope.title, { onError: () => toast.error(to.downloadFailed) })}
        >
          <Download />
          {to.download}
        </Button>
      )}
    </div>
  );
}
