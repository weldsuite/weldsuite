import { useEffect, useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useCancelW9Request, useCreateW9Request, useW9Requests } from '@/hooks/queries/use-weldbooks-1099-queries';
import type { W9Request, W9RequestStatus } from '@/lib/api/domains/weldbooks-1099';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

const EXPIRY_CHOICES = [7, 14, 30, 60, 90] as const;
const DEFAULT_EXPIRY_DAYS = 30;

interface W9RequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partyId: string;
  /** The vendor's email, to prefill the request. */
  defaultEmail?: string | null;
}

const STATUS_VARIANT: Record<W9RequestStatus, 'success' | 'warning' | 'secondary' | 'outline'> = {
  pending: 'warning',
  completed: 'success',
  expired: 'secondary',
  cancelled: 'outline',
};

function RequestRow({ request, onCancel, cancelling }: Readonly<{ request: W9Request; onCancel: () => void; cancelling: boolean }>) {
  const { t } = useI18n();
  const tw = t.weldbooksUs.form1099.w9Request;
  const { formatDate } = useWeldbooksFormat();
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={STATUS_VARIANT[request.status]}>{tw.status[request.status]}</Badge>
        <span className="text-muted-foreground">{tw.requestedOn.replace('{date}', formatDate(request.createdAt))}</span>
        {request.status === 'pending' ? (
          <span className="text-muted-foreground">{tw.expiresOn.replace('{date}', formatDate(request.expiresAt))}</span>
        ) : null}
        {request.status === 'completed' && request.completedAt ? (
          <span className="text-muted-foreground">{tw.completedOn.replace('{date}', formatDate(request.completedAt))}</span>
        ) : null}
      </div>
      {request.status === 'pending' ? (
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={cancelling}>
          {tw.cancelRequest}
        </Button>
      ) : null}
    </li>
  );
}

/**
 * Asks a vendor for a W-9 through a one-time link. Nothing is emailed: the
 * link is shown once, to copy and send, because the server keeps only its
 * hash. The link lives in this dialog's state and is dropped on close.
 */
export function W9RequestDialog({ open, onOpenChange, partyId, defaultEmail }: Readonly<W9RequestDialogProps>) {
  const { t } = useI18n();
  const tw = t.weldbooksUs.form1099.w9Request;
  const [email, setEmail] = useState(defaultEmail ?? '');
  const [expiresInDays, setExpiresInDays] = useState<number>(DEFAULT_EXPIRY_DAYS);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useCreateW9Request();
  const cancel = useCancelW9Request();
  const requests = useW9Requests(partyId, { enabled: open });

  const { reset: resetCreate } = create;
  useEffect(() => {
    if (open) {
      setEmail(defaultEmail ?? '');
      setExpiresInDays(DEFAULT_EXPIRY_DAYS);
    } else {
      // The link is shown once: drop it when the dialog closes.
      setLink(null);
      setCopied(false);
      resetCreate();
    }
  }, [open, defaultEmail, resetCreate]);

  const submit = async () => {
    try {
      const result = await create.run({ partyId, email: email.trim() || undefined, expiresInDays });
      setLink(result.url);
      setCopied(false);
    } catch (err) {
      toast.error(tw.createFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.success(tw.copied);
    } catch {
      toast.error(tw.copyFailed);
    }
  };

  const cancelRequest = async (id: string) => {
    try {
      await cancel.mutateAsync(id);
      toast.success(tw.cancelled);
    } catch (err) {
      toast.error(tw.cancelFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const rows = requests.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tw.title}</DialogTitle>
          <DialogDescription>{tw.description}</DialogDescription>
        </DialogHeader>

        {link ? (
          <div className="space-y-3" data-testid="w9-link-panel">
            <Label htmlFor="w9-link">{tw.linkLabel}</Label>
            <div className="flex gap-2">
              <Input id="w9-link" readOnly value={link} className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
              <Button type="button" variant="outline" onClick={copyLink}>
                {copied ? <Check className="mr-1 h-4 w-4" aria-hidden /> : <Copy className="mr-1 h-4 w-4" aria-hidden />}
                {copied ? tw.copiedShort : tw.copy}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">{tw.sendNote}</p>
            <p className="text-xs text-muted-foreground">{tw.shownOnce}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="w9-email">{tw.email}</Label>
              <Input id="w9-email" type="email" autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} />
              <p className="text-xs text-muted-foreground">{tw.emailHelp}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="w9-expiry">{tw.expiry}</Label>
              <Select value={String(expiresInDays)} onValueChange={(value) => setExpiresInDays(Number(value))}>
                <SelectTrigger id="w9-expiry">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_CHOICES.map((days) => (
                    <SelectItem key={days} value={String(days)}>
                      {tw.expiryDays.replace('{days}', String(days))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">{tw.replacesNote}</p>
          </div>
        )}

        {requests.isLoading ? (
          <p className="text-sm text-muted-foreground">{tw.loading}</p>
        ) : requests.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {tw.loadFailed}
          </p>
        ) : rows.length > 0 ? (
          <div>
            <h3 className="text-sm font-medium">{tw.history}</h3>
            <ul className="divide-y">
              {rows.map((request) => (
                <RequestRow
                  key={request.id}
                  request={request}
                  cancelling={cancel.isPending}
                  onCancel={() => void cancelRequest(request.id)}
                />
              ))}
            </ul>
          </div>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {link ? tw.done : tw.close}
          </Button>
          {link ? null : (
            <Button type="button" onClick={() => void submit()} disabled={create.isPending}>
              {create.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
              {tw.createLink}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
