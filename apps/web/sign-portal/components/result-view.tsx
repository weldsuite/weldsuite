import { useState } from 'react';
import { Ban, CheckCircle2, Clock, Download, FileCheck2, FileX, Hourglass, Loader2, ShieldCheck } from 'lucide-react';
import type { SignPortalClosedReason, SignPortalEnvelope } from '@weldsuite/app-api-client/schemas/weldsign';
import { PortalNetworkError, portalBytes } from '@/lib/portal-client';
import { Button } from '@weldsuite/ui/components/button';
import { BrandButton } from './brand-button';
import { usePortal } from './portal-context';
import { StatusCard } from './status-card';

/** The request can no longer be opened or signed. */
export function ClosedView({ reason, declinedByYou }: Readonly<{ reason: SignPortalClosedReason | null; declinedByYou?: boolean }>) {
  const { t } = usePortal();
  if (declinedByYou) return <StatusCard icon={FileX} tone="neutral" title={t.closed.youDeclined.title} body={t.closed.youDeclined.body} />;
  switch (reason) {
    case 'expired':
      return <StatusCard icon={Clock} tone="warning" title={t.closed.expired.title} body={t.closed.expired.body} />;
    case 'voided':
      return <StatusCard icon={Ban} tone="neutral" title={t.closed.voided.title} body={t.closed.voided.body} />;
    default:
      return <StatusCard icon={FileX} tone="danger" title={t.closed.declined.title} body={t.closed.declined.body} />;
  }
}

/** The signer is done, or it is not their turn yet. */
export function WaitingView({ envelope }: Readonly<{ envelope: SignPortalEnvelope }>) {
  const { t } = usePortal();
  const signed = envelope.recipient.status === 'signed';
  return (
    <StatusCard
      icon={signed ? CheckCircle2 : Hourglass}
      tone={signed ? 'success' : 'neutral'}
      title={signed ? t.result.signedTitle : t.result.notYetTitle}
      body={signed ? t.result.signedBody : t.result.notYetBody}
    >
      <Summary envelope={envelope} />
    </StatusCard>
  );
}

/** Everyone signed; the signed PDF is ready. */
export function CompletedView({
  envelope,
  withSession,
}: Readonly<{ envelope: SignPortalEnvelope; withSession: <T>(run: () => Promise<T>) => Promise<T> }>) {
  const { t } = usePortal();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The evidence report exists for a request with advanced or qualified signers.
  const hasEvidence = envelope.hasEvidence ?? envelope.signatureLevel !== undefined;
  const [evidenceBusy, setEvidenceBusy] = useState(false);

  async function download(path = '/api/portal/download', suffix = '') {
    const setWorking = path === '/api/portal/download' ? setBusy : setEvidenceBusy;
    setWorking(true);
    setError(null);
    try {
      const bytes = await withSession(() => portalBytes(path));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${envelope.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'document'}${suffix}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Give the browser a moment to start the download before the URL goes away.
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(err instanceof PortalNetworkError ? t.error.network : t.error.generic);
    } finally {
      setWorking(false);
    }
  }

  return (
    <StatusCard icon={CheckCircle2} tone="success" title={t.result.completedTitle} body={t.result.completedBody}>
      <Summary envelope={envelope} />
      <BrandButton size="lg" onClick={() => void download()} disabled={busy}>
        {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
        {t.result.download}
      </BrandButton>
      {hasEvidence ? (
        <Button variant="outline" size="lg" onClick={() => void download('/api/portal/evidence', ' - evidence')} disabled={evidenceBusy}>
          {evidenceBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <FileCheck2 aria-hidden="true" />}
          {t.eidas.evidence}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </StatusCard>
  );
}

function Summary({ envelope }: Readonly<{ envelope: SignPortalEnvelope }>) {
  const { t } = usePortal();
  return (
    <div className="rounded-md bg-muted/60 p-3 text-left text-sm">
      <p className="font-medium">{envelope.title}</p>
      {envelope.senderName ? <p className="text-xs text-muted-foreground">{t.result.sentBy(envelope.senderName)}</p> : null}
      {envelope.signatureLevel && envelope.recipient.status === 'signed' ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
          <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
          {t.eidas.signedWith[envelope.signatureLevel]}
        </p>
      ) : null}
    </div>
  );
}
