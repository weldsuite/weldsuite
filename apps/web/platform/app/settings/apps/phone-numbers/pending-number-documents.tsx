import { useEffect, useMemo, useState } from 'react';
import { getTranslations, type TranslationNamespaces } from '@/lib/i18n';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { VoipPhoneNumber } from '@/lib/api/domains/call-intelligence';
import type { ProviderAddress } from '@/app/settings/apps/phone-numbers/new-number/new-number-client';
import {
  useAddresses,
  usePhoneOrderRequirements,
  useSubmitPhoneOrderRequirements,
  useUploadTelephonyDocument,
  type PhoneOrderRequirement,
} from '@/hooks/use-phone-numbers';

interface PendingNumberDocumentsProps {
  phoneNumbers: VoipPhoneNumber[];
  onActivated?: (id: string) => void;
}

export function PendingNumberDocuments({ phoneNumbers, onActivated }: Readonly<PendingNumberDocumentsProps>) {
  const tp = getTranslations('settings').phoneNumbers;
  const pending = phoneNumbers.filter((p) => p.status === 'pending');
  const [selected, setSelected] = useState<VoipPhoneNumber | null>(null);

  if (pending.length === 0) return null;

  return (
    <>
      <div className="mb-6 rounded-md border bg-muted/20 p-4">
        <div className="mb-3">
          <h3 className="text-sm font-semibold">{tp.pendingDocuments}</h3>
          <p className="text-xs text-muted-foreground">{tp.pendingDocumentsDescription}</p>
        </div>
        <div className="space-y-2">
          {pending.map((phone) => (
            <div
              key={phone.id}
              className="flex items-center justify-between rounded border bg-background p-3"
            >
              <div className="flex items-center gap-3">
                <span className="font-mono font-medium">
                  {phone.formattedNumber || phone.phoneNumber}
                </span>
                <Badge variant="outline">{tp.pendingDocuments}</Badge>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSelected(phone)}>
                <FileText className="h-4 w-4 mr-1.5" />
                {tp.uploadDocuments}
              </Button>
            </div>
          ))}
        </div>
      </div>
      <DocumentsDialog
        phone={selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        onActivated={(id) => {
          setSelected(null);
          onActivated?.(id);
        }}
      />
    </>
  );
}

type PhoneNumberStrings = TranslationNamespaces['settings']['phoneNumbers'];

function RequirementField({
  req,
  value,
  addresses,
  tp,
  onUpload,
  onValueChange,
}: Readonly<{
  req: PhoneOrderRequirement;
  value: string;
  addresses: ProviderAddress[];
  tp: PhoneNumberStrings;
  onUpload: (file: File | undefined) => void;
  onValueChange: (value: string) => void;
}>) {
  if (req.fieldType === 'document') {
    return (
      <div className="flex items-center gap-2">
        <Input type="file" onChange={(e) => onUpload(e.target.files?.[0])} />
        {value ? <Badge variant="secondary">{tp.fileUploaded}</Badge> : null}
      </div>
    );
  }
  if (req.fieldType === 'address') {
    return (
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger>
          <SelectValue placeholder={tp.selectAddressForRequirement} />
        </SelectTrigger>
        <SelectContent>
          {addresses.map((addr) => (
            <SelectItem key={addr.id} value={addr.id}>
              {addr.business_name || addr.friendly_name || addr.customer_name || addr.id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  return (
    <Input
      value={value}
      placeholder={req.example || tp.requirementTextPlaceholder}
      onChange={(e) => onValueChange(e.target.value)}
    />
  );
}

function DocumentsDialog({
  phone,
  onOpenChange,
  onActivated,
}: Readonly<{
  phone: VoipPhoneNumber | null;
  onOpenChange: (open: boolean) => void;
  onActivated?: (id: string) => void;
}>) {
  const tp = getTranslations('settings').phoneNumbers;
  const { data: addresses } = useAddresses();
  const { data, isLoading } = usePhoneOrderRequirements(phone?.id ?? null);
  const uploadMutation = useUploadTelephonyDocument();
  const submitMutation = useSubmitPhoneOrderRequirements();
  const [values, setValues] = useState<Record<string, string>>({});

  const requirements = useMemo(
    () => (data?.requirements ?? []).filter((r) => r.fieldType !== 'action'),
    [data?.requirements],
  );

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const req of data?.requirements ?? []) {
      if (req.fieldValue) next[req.id] = req.fieldValue;
    }
    setValues(next);
  }, [data]);

  const complete = requirements.length > 0 && requirements.every((r) => Boolean(values[r.id]?.trim()));

  const handleUpload = async (req: PhoneOrderRequirement, file: File | undefined) => {
    if (!file) return;
    try {
      const uploaded = await uploadMutation.mutateAsync(file);
      if (uploaded?.id) {
        setValues((prev) => ({ ...prev, [req.id]: uploaded.id }));
        toast.success(tp.fileUploaded);
      }
    } catch {
      toast.error(tp.documentsFailed);
    }
  };

  const handleSubmit = async () => {
    if (!phone) return;
    try {
      const result = await submitMutation.mutateAsync({
        phoneNumberId: phone.id,
        values: requirements.map((r) => ({
          requirementId: r.id,
          fieldValue: values[r.id]!,
        })),
      });
      toast.success(tp.documentsSubmitted);
      if (result?.requirementsMet) onActivated?.(phone.id);
      else onOpenChange(false);
    } catch {
      toast.error(tp.documentsFailed);
    }
  };

  return (
    <Dialog open={Boolean(phone)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{tp.uploadDocuments}</DialogTitle>
          <DialogDescription>{tp.pendingDocumentsDescription}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {phone && (
            <p className="font-mono text-sm">{phone.formattedNumber || phone.phoneNumber}</p>
          )}
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {tp.documentsWaiting}
            </div>
          )}
          {!isLoading && requirements.length === 0 && (
            <p className="text-sm text-muted-foreground">{tp.documentsWaiting}</p>
          )}
          {!isLoading && requirements.map((req) => (
            <div key={req.id} className="space-y-2">
              <Label>{req.name}</Label>
              {req.description ? (
                <p className="text-xs text-muted-foreground">{req.description}</p>
              ) : null}
              <RequirementField
                req={req}
                value={values[req.id] || ''}
                addresses={addresses ?? []}
                tp={tp}
                onUpload={(file) => void handleUpload(req, file)}
                onValueChange={(v) => setValues((prev) => ({ ...prev, [req.id]: v }))}
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tp.editDialog.cancel}
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={!complete || submitMutation.isPending || uploadMutation.isPending}
          >
            {submitMutation.isPending ? (
              <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />{tp.editDialog.saving}</>
            ) : (
              tp.submitDocuments
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
