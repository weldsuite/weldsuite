import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { getTranslations } from '@/lib/i18n';
import { useSendcloudSettings } from '@/hooks/queries/use-sendcloud-queries';
import { useShipWeldstashPickList, useWeldstashPickList } from '@/hooks/queries/use-weldstash-queries';

function openPdf(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function SendParcelDialog({
  pickListId,
  open,
  onOpenChange,
}: {
  pickListId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = getTranslations('common').weldstash.packing;
  const sendcloud = useSendcloudSettings();
  const pickList = useWeldstashPickList(pickListId ?? '', Boolean(pickListId) && open);
  const ship = useShipWeldstashPickList();
  const settings = sendcloud.data?.data;
  const list = pickList.data?.data as
    | {
        recipient?: {
          name?: string | null;
          line1?: string | null;
          city?: string | null;
          postalCode?: string | null;
          country?: string | null;
        } | null;
        requiresShipping?: boolean;
      }
    | undefined;

  const senders = useMemo(() => (settings?.senders ?? []).filter((row) => row.enabled), [settings?.senders]);
  const methods = useMemo(() => (settings?.methods ?? []).filter((row) => row.enabled), [settings?.methods]);
  const [senderId, setSenderId] = useState<string>('');
  const [methodCode, setMethodCode] = useState('');
  const [weightKg, setWeightKg] = useState('1');

  useEffect(() => {
    if (!open) return;
    const defaultSender = senders.find((row) => row.isDefault) ?? senders[0];
    const defaultMethod = methods.find((row) => row.isDefault) ?? methods[0];
    setSenderId(defaultSender ? String(defaultSender.id) : '');
    setMethodCode(defaultMethod?.code ?? '');
  }, [open, senders, methods]);

  const configured = Boolean(settings?.connected);
  const ready = configured && senders.length > 0 && methods.length > 0;
  const recipient = list?.recipient;
  const recipientLabel = recipient
    ? [recipient.name, recipient.line1, recipient.postalCode, recipient.city, recipient.country]
        .filter(Boolean)
        .join(', ')
    : '—';

  const submit = () => {
    if (!pickListId) return;
    const weight = Number(weightKg);
    if (!senderId || !methodCode || !Number.isFinite(weight) || weight <= 0) {
      toast.error(t.shipFailed);
      return;
    }
    ship.mutate(
      {
        id: pickListId,
        senderId: Number(senderId),
        shippingOptionCode: methodCode,
        weightKg: weight,
      },
      {
        onSuccess: (res) => {
          toast.success(t.toastLabelCreated);
          const pdf = res.data?.labelPdfBase64;
          if (pdf) openPdf(pdf);
          else if (res.data?.trackingUrl) window.open(res.data.trackingUrl, '_blank', 'noopener,noreferrer');
          onOpenChange(false);
        },
        onError: (err) => toast.error((err as Error).message || t.shipFailed),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.sendParcel}</DialogTitle>
          <DialogDescription>
            {!configured ? t.notConfigured : !ready ? t.noEnabledOptions : t.recipient}
          </DialogDescription>
        </DialogHeader>
        {ready ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{recipientLabel}</p>
            <div className="space-y-2">
              <Label htmlFor="sendcloud-sender">{t.sender}</Label>
              <select
                id="sendcloud-sender"
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={senderId}
                onChange={(e) => setSenderId(e.target.value)}
              >
                {senders.map((sender) => (
                  <option key={sender.id} value={sender.id}>
                    {sender.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sendcloud-method">{t.parcelType}</Label>
              <select
                id="sendcloud-method"
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={methodCode}
                onChange={(e) => setMethodCode(e.target.value)}
              >
                {methods.map((method) => (
                  <option key={method.code} value={method.code}>
                    {method.name}
                    {method.carrierName ? ` · ${method.carrierName}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sendcloud-weight">{t.weightKg}</Label>
              <Input
                id="sendcloud-weight"
                type="number"
                min="0.01"
                step="0.01"
                value={weightKg}
                onChange={(e) => setWeightKg(e.target.value)}
              />
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {getTranslations('common').actions.cancel}
          </Button>
          <Button onClick={submit} disabled={!ready || ship.isPending || !pickListId}>
            {t.sendParcel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
