import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ShieldAlert } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { PaymentRunDetail, RunHoldView } from '@/lib/api/domains/weldbooks-payment-runs';
import { holdFixTarget, isUnreleasableHold } from '../payment-run-utils';
import { ReasonDialog } from './reason-dialog';

interface HoldsCardProps {
  run: PaymentRunDetail;
  nameOf: (userId: string | null | undefined) => string;
  /** The person may release holds (`banking:manage`) and the run still can be changed. */
  canRelease: boolean;
  onRelease: (partyId: string, reason: string) => Promise<void>;
}

/** The vendors a run keeps out of its payments, why, and the way to let them in. */
export function HoldsCard({ run, nameOf, canRelease, onRelease }: Readonly<HoldsCardProps>) {
  const { t } = useI18n();
  const th = t.weldbooksUs.payments.holds;
  const { formatDateTime } = useWeldbooksFormat();
  const [releasing, setReleasing] = useState<RunHoldView | null>(null);

  if (run.holds.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5" aria-hidden />
          {th.title}
        </CardTitle>
        <CardDescription>{th.description}</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{th.columns.vendor}</TableHead>
              <TableHead>{th.columns.reason}</TableHead>
              <TableHead>{th.columns.state}</TableHead>
              <TableHead className="w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {run.holds.map((hold) => (
              <TableRow key={`${hold.partyId}-${hold.code}`}>
                <TableCell className="font-medium">{hold.partyName}</TableCell>
                <TableCell>
                  <p>{th.codes[hold.code]}</p>
                  <p className="text-xs text-muted-foreground">{th.help[hold.code]}</p>
                </TableCell>
                <TableCell>
                  {hold.released ? (
                    <div className="space-y-0.5">
                      <Badge variant="success">{th.released}</Badge>
                      <p className="text-xs text-muted-foreground">
                        {th.releasedBy
                          .replace('{name}', nameOf(hold.released.by))
                          .replace('{date}', formatDateTime(hold.released.at))}
                      </p>
                      <p className="text-xs text-muted-foreground">{hold.released.reason}</p>
                    </div>
                  ) : (
                    <Badge variant="warning">{th.active}</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {!hold.released && canRelease ? (
                    isUnreleasableHold(hold.code) || !hold.releasable ? (
                      holdFixTarget(hold.code) === 'chart' ? (
                        <Button asChild variant="outline" size="sm">
                          <Link to="/weldbooks/accounts">{th.fixChart}</Link>
                        </Button>
                      ) : (
                        <Button asChild variant="outline" size="sm">
                          <Link to="/weldbooks/suppliers">{th.fixVendor}</Link>
                        </Button>
                      )
                    ) : (
                      <Button variant="outline" size="sm" onClick={() => setReleasing(hold)}>
                        {th.release}
                      </Button>
                    )
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>

      <ReasonDialog
        open={releasing !== null}
        onOpenChange={(open) => {
          if (!open) setReleasing(null);
        }}
        title={th.releaseTitle.replace('{vendor}', releasing?.partyName ?? '')}
        description={th.releaseDescription}
        label={th.releaseReason}
        submitLabel={th.release}
        onSubmit={async (reason) => {
          if (releasing) await onRelease(releasing.partyId, reason);
        }}
      />
    </Card>
  );
}
