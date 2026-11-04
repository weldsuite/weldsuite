/**
 * Ownership check for an external domain that is still pending.
 *
 * The "Add external domain" wizard shows the TXT record once; anyone who
 * leaves it before verifying lands here instead (domain panel and full page,
 * DNS tab). It shows the same record with copy buttons and runs the same
 * verify call. On success the wizard resumes at its import step.
 */

import { Copy, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import type { DomainVerificationRecord } from '@weldsuite/core-api-client/schemas/domains';
import { useVerifyDomainOwnership } from '@/hooks/queries/use-host-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';

interface DomainVerificationCardProps {
  domainId: string;
  domainName: string;
  record: DomainVerificationRecord;
}

export function DomainVerificationCard({
  domainId,
  domainName,
  record,
}: Readonly<DomainVerificationCardProps>) {
  const { t } = useI18n();
  const td = t.host.domainDetail;
  const router = useRouter();
  // host-api guards verify-ownership with domains:create, like adding the domain.
  const canVerify = useCan('weldhost:domains:create');
  const verifyOwnership = useVerifyDomainOwnership();

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(td.copiedToClipboard);
    } catch {
      toast.error(td.copyFailed);
    }
  };

  const handleVerify = async () => {
    try {
      await verifyOwnership.mutateAsync(domainId);
      toast.success(td.ownershipVerified);
      router.push(`/weldhost/domains/external?domain=${encodeURIComponent(domainId)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : td.ownershipVerifyFailed);
    }
  };

  const rows: Array<{ label: string; value: string }> = [
    { label: td.name, value: record.name },
    { label: td.type, value: record.type },
    { label: td.value, value: record.value },
  ];

  return (
    <section
      aria-labelledby={`verify-${domainId}`}
      className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40"
    >
      <div className="flex gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-700 dark:text-amber-300" />
        <div className="min-w-0 space-y-1">
          <h3 id={`verify-${domainId}`} className="text-sm font-medium text-amber-900 dark:text-amber-200">
            {td.pendingVerificationTitle.replace('{domain}', domainName)}
          </h3>
          <p className="text-sm text-amber-800 dark:text-amber-300">{td.pendingVerificationDescription}</p>
        </div>
      </div>

      <div className="mt-3 space-y-1.5">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center gap-2 rounded-md border border-border/60 bg-background px-2.5 py-1.5"
          >
            <span className="w-12 flex-shrink-0 text-xs text-muted-foreground">{row.label}</span>
            <code className="min-w-0 flex-1 break-all font-mono text-sm text-foreground">{row.value}</code>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 flex-shrink-0"
              title={`${td.copy} ${row.label}`}
              aria-label={`${td.copy} ${row.label}`}
              onClick={() => void copy(row.value)}
            >
              <Copy className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </div>
        ))}
      </div>

      {canVerify && (
        <div className="mt-3 flex justify-end">
          <Button size="sm" onClick={() => void handleVerify()} disabled={verifyOwnership.isPending}>
            {verifyOwnership.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {verifyOwnership.isPending ? td.verifyingOwnership : td.verifyOwnership}
          </Button>
        </div>
      )}
    </section>
  );
}
