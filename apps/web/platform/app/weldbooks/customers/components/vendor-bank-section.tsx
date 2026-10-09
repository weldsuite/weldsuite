import { useMemo, useState } from 'react';
import { useFormContext } from 'react-hook-form';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { maskedAccountNumber } from '@/app/weldbooks/banking/components/routing-number';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useRevealAchAccount, useVerifyBankDetails } from '@/hooks/queries/use-weldbooks-1099-queries';
import { useWorkspaceMembers } from '@/hooks/queries/use-settings-queries';
import type { VendorTaxView } from '@/lib/api/domains/weldbooks-1099';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { RevealSecret } from './reveal-secret';
import { SecretInput } from './secret-input';
import type { VendorTaxFormShape } from './vendor-tax-section';
import type { VendorTaxFormValues } from './vendor-tax-model';

const NONE = '__none__';

interface VendorBankSectionProps {
  contact?: VendorTaxView & { id: string };
}

/**
 * "ACH bank details" card of the vendor form: the routing number (checked
 * against the ABA checksum), the account number (write-only, masked, revealed
 * on request), the account type, and the verification that lifts the payment
 * hold a bank-detail change puts on the vendor.
 */
export function VendorBankSection({ contact }: Readonly<VendorBankSectionProps>) {
  const { t } = useI18n();
  const tb = t.weldbooksUs.form1099.bank;
  const { can } = usePermissions();
  const { formatDate, formatDateTime } = useWeldbooksFormat();
  const form = useFormContext<VendorTaxFormShape>();
  const values = form.watch('vendorTax');
  const errors = form.formState.errors.vendorTax;
  const set = <K extends keyof VendorTaxFormValues>(key: K, value: VendorTaxFormValues[K]) =>
    form.setValue(`vendorTax.${key}`, value as never, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });

  const contactId = contact?.id ?? '';
  const revealAccount = useRevealAchAccount(contactId);
  const verify = useVerifyBankDetails(contactId);
  const members = useWorkspaceMembers(1, 100, Boolean(contact?.bankDetailsVerifiedBy));
  const [replacing, setReplacing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const hasStoredAccount = Boolean(contact?.hasAchAccount);
  const showAccountInput = !hasStoredAccount || replacing;
  const canReveal = can('tax_ids:reveal');
  const canVerify = can('banking:manage');

  const verifier = useMemo(() => {
    const id = contact?.bankDetailsVerifiedBy;
    if (!id) return null;
    const member = members.data?.data.find((m) => m.userId === id);
    return member?.name || member?.email || id;
  }, [contact?.bankDetailsVerifiedBy, members.data]);

  const confirmVerify = async () => {
    try {
      await verify.mutateAsync();
      toast.success(tb.verified);
      setConfirmOpen(false);
    } catch (err) {
      toast.error(tb.verifyFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tb.title}</CardTitle>
        <CardDescription>{tb.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {contact?.bankDetailsNeedVerification ? (
          <Alert>
            <ShieldAlert aria-hidden />
            <AlertTitle>{tb.needsVerificationTitle}</AlertTitle>
            <AlertDescription>
              <p>
                {tb.needsVerification.replace('{date}', contact.bankDetailsChangedAt ? formatDateTime(contact.bankDetailsChangedAt) : '')}
              </p>
              {canVerify ? (
                <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => setConfirmOpen(true)}>
                  {tb.verify}
                </Button>
              ) : (
                <p className="mt-1 text-xs">{tb.verifyNeedsPermission}</p>
              )}
            </AlertDescription>
          </Alert>
        ) : contact?.bankDetailsVerifiedAt ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="success">
              <ShieldCheck aria-hidden />
              {tb.verifiedBadge}
            </Badge>
            <span className="text-muted-foreground">
              {tb.verifiedOn.replace('{date}', formatDate(contact.bankDetailsVerifiedAt)).replace('{name}', verifier ?? '')}
            </span>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="vendorTax-achRoutingNumber">{tb.routing}</Label>
            <Input
              id="vendorTax-achRoutingNumber"
              inputMode="numeric"
              maxLength={11}
              autoComplete="off"
              className="font-mono"
              aria-invalid={Boolean(errors?.achRoutingNumber)}
              aria-describedby="vendorTax-achRoutingNumber-help"
              {...form.register('vendorTax.achRoutingNumber')}
            />
            <p id="vendorTax-achRoutingNumber-help" className="text-xs text-muted-foreground">
              {tb.routingHelp}
            </p>
            {errors?.achRoutingNumber ? <p className="text-sm text-destructive">{errors.achRoutingNumber.message}</p> : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="vendorTax-achAccountType">{tb.accountType}</Label>
            <Select
              value={values.achAccountType || NONE}
              onValueChange={(next) => set('achAccountType', next === NONE ? '' : (next as 'checking' | 'savings'))}
            >
              <SelectTrigger id="vendorTax-achAccountType">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t.weldbooksUs.form1099.vendorTax.notSet}</SelectItem>
                <SelectItem value="checking">{tb.types.checking}</SelectItem>
                <SelectItem value="savings">{tb.types.savings}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="vendorTax-achAccountNumber">{tb.account}</Label>
            {hasStoredAccount && !showAccountInput && !values.removeAchAccount ? (
              <div className="space-y-2" data-testid="ach-stored">
                <RevealSecret
                  masked={maskedAccountNumber(contact?.achAccountLast4)}
                  canReveal={canReveal}
                  reveal={async () => (await revealAccount.run()).achAccountNumber}
                  labels={{
                    reveal: tb.reveal,
                    hide: tb.hide,
                    hidesIn: tb.hidesIn,
                    failed: tb.revealFailed,
                    valueLabel: tb.account,
                  }}
                  testId="ach-account-value"
                />
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}>
                    {tb.replace}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => set('removeAchAccount', true)}>
                    {tb.remove}
                  </Button>
                </div>
              </div>
            ) : null}

            {values.removeAchAccount ? (
              <div className="flex flex-wrap items-center gap-2 text-sm" role="status">
                <span>{tb.willRemove}</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => set('removeAchAccount', false)}>
                  {tb.undoRemove}
                </Button>
              </div>
            ) : null}

            {showAccountInput && !values.removeAchAccount ? (
              <div className="space-y-2">
                <SecretInput
                  id="vendorTax-achAccountNumber"
                  value={values.achAccountNumber}
                  showLabel={tb.showTyped}
                  hideLabel={tb.hideTyped}
                  aria-describedby="vendorTax-achAccountNumber-help"
                  aria-invalid={Boolean(errors?.achAccountNumber)}
                  onChange={(next) => set('achAccountNumber', next)}
                />
                <p id="vendorTax-achAccountNumber-help" className="text-xs text-muted-foreground">
                  {tb.accountHelp}
                </p>
                {errors?.achAccountNumber ? <p className="text-sm text-destructive">{errors.achAccountNumber.message}</p> : null}
                {hasStoredAccount ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      set('achAccountNumber', '');
                      setReplacing(false);
                    }}
                  >
                    {tb.keepCurrent}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <p className="text-xs text-muted-foreground">{tb.changeHoldNote}</p>
      </CardContent>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={tb.confirmTitle}
        description={tb.confirmDescription}
        confirmLabel={tb.confirmVerify}
        cancelLabel={tb.cancel}
        loading={verify.isPending}
        onConfirm={confirmVerify}
      />
    </Card>
  );
}
