import { useState } from 'react';
import { useParams, Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { useAccountingAccount, useUpdateAccount } from '@/hooks/queries/use-accounting-queries';
import { PageLoader } from '@/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@weldsuite/ui/components/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@weldsuite/ui/components/alert-dialog';
import { ArrowLeft, Ban, CheckCircle2, Pencil } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import { useCurrentEntityCurrency } from '@/hooks/use-current-entity-currency';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { useTaxLineCatalog } from '@/hooks/queries/use-accounting-queries';
import { form1099BoxName, FORM_1099_OMIT } from '@/lib/weldbooks/form-1099';
import { taxLineLabel } from '@/lib/weldbooks/tax-lines';

function DetailRow({ label, value }: Readonly<{ label: string; value: React.ReactNode }>) {
  if (value === null || value === undefined) return null;
  return (
    <div className="flex justify-between py-2 border-b last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

export default function AccountDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { data, isLoading } = useAccountingAccount(id);
  const { t } = useI18n();
  const ta = t.accounting.accounts;
  const { formatMoney, entityCurrency } = useCurrentEntityCurrency();
  const { code: jurisdictionCode, features } = useCurrentJurisdiction();
  const isUs = jurisdictionCode === 'US';
  const tus = t.weldbooksUs.setup.accounts;
  const taxLineCatalog = useTaxLineCatalog(undefined, { enabled: isUs });
  const canUpdate = useCan('accounts:update');
  const updateAccount = useUpdateAccount();
  const [confirmToggle, setConfirmToggle] = useState(false);

  if (isLoading) return <PageLoader fullScreen={false} />;

  const account = data?.data;
  if (!account) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">{ta.notFound}</p>
      </div>
    );
  }

  const isInactive = account.isActive === false;
  const toggleActive = () => {
    updateAccount.mutate(
      { id: account.id, data: { isActive: isInactive } },
      {
        onSuccess: () => {
          toast.success(isInactive ? ta.reactivated : ta.deactivated);
          setConfirmToggle(false);
        },
        onError: (err) => {
          setConfirmToggle(false);
          toast.error(isInactive ? ta.reactivateFailed : ta.deactivateFailed, {
            description: err instanceof Error ? err.message : undefined,
          });
        },
      },
    );
  };

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/weldbooks/accounts">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-semibold">
              <span className="font-mono mr-2">{account.code}</span>
              {account.name}
            </h1>
            <div className="flex gap-2 mt-1">
              <Badge variant="outline" className="capitalize">{account.type}</Badge>
              {account.subtype && (
                <Badge variant="secondary" className="capitalize">
                  {account.subtype.replace(/_/g, ' ')}
                </Badge>
              )}
              {account.isActive === false && (
                <Badge variant="destructive">{ta.inactive}</Badge>
              )}
              {account.isSystemAccount && (
                <Badge variant="secondary">{ta.system}</Badge>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canUpdate && !(account.isSystemAccount && !isInactive) && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmToggle(true)}
              disabled={updateAccount.isPending}
              data-testid="account-toggle-active"
            >
              {isInactive ? <CheckCircle2 className="h-4 w-4 mr-1" /> : <Ban className="h-4 w-4 mr-1" />}
              {isInactive ? ta.reactivate : ta.deactivate}
            </Button>
          )}
          <Link to="/weldbooks/accounts/$id/edit" params={{ id: account.id }}>
            <Button variant="outline" size="sm">
              <Pencil className="h-4 w-4 mr-1" />
              {ta.editing}
            </Button>
          </Link>
        </div>
      </div>

      <AlertDialog open={confirmToggle} onOpenChange={setConfirmToggle}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isInactive ? ta.reactivateTitle : ta.deactivateTitle}</AlertDialogTitle>
            <AlertDialogDescription>{isInactive ? ta.reactivateDesc : ta.deactivateDesc}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{ta.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={toggleActive}>{isInactive ? ta.reactivate : ta.deactivate}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Card>
        <CardHeader>
          <CardTitle>{ta.accountDetails}</CardTitle>
        </CardHeader>
        <CardContent>
          <DetailRow label={ta.summaryCode} value={account.code} />
          <DetailRow label={ta.summaryName} value={account.name} />
          <DetailRow label={ta.description} value={account.description} />
          <DetailRow label={ta.summaryType} value={<span className="capitalize">{account.type}</span>} />
          <DetailRow
            label={ta.subtype}
            value={account.subtype ? <span className="capitalize">{account.subtype.replace(/_/g, ' ')}</span> : null}
          />
          <DetailRow label={ta.normalSide} value={<span className="capitalize">{account.normalSide}</span>} />
          <DetailRow label={ta.currency} value={account.currency ?? entityCurrency ?? '—'} />
        </CardContent>
      </Card>

      {isUs && (
        <Card>
          <CardHeader>
            <CardTitle>{tus.reportingTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <DetailRow
              label={tus.taxLine}
              value={account.taxLine ? taxLineLabel(taxLineCatalog.data, account.taxLine) : tus.notSet}
            />
            {features.form1099 && (
              <DetailRow
                label={tus.form1099Box}
                value={
                  account.form1099Box
                    ? account.form1099Box === FORM_1099_OMIT
                      ? tus.form1099Omit
                      : form1099BoxName(account.form1099Box)
                    : tus.notSet
                }
              />
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{ta.balances}</CardTitle>
        </CardHeader>
        <CardContent>
          <DetailRow label={ta.openingBalance} value={formatMoney(account.openingBalance, account.currency)} />
          <DetailRow label={ta.currentBalance} value={formatMoney(account.currentBalance, account.currency)} />
        </CardContent>
      </Card>
    </div>
  );
}
