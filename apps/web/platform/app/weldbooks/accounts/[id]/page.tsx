import { useParams, Link } from '@tanstack/react-router';
import { useAccountingAccount } from '@/hooks/queries/use-accounting-queries';
import { PageLoader } from '@/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@weldsuite/ui/components/card';
import { ArrowLeft, Pencil } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';

const formatCurrency = (value: string | number | null | undefined) =>
  new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(
    Number(value ?? 0),
  );

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
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

  if (isLoading) return <PageLoader fullScreen={false} />;

  const account = data?.data;
  if (!account) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">{ta.notFound}</p>
      </div>
    );
  }

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
        <Link to="/weldbooks/accounts/$id/edit" params={{ id: account.id }}>
          <Button variant="outline" size="sm">
            <Pencil className="h-4 w-4 mr-1" />
            {ta.editing}
          </Button>
        </Link>
      </div>

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
          <DetailRow label={ta.currency} value={account.currency ?? 'EUR'} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{ta.balances}</CardTitle>
        </CardHeader>
        <CardContent>
          <DetailRow label={ta.openingBalance} value={formatCurrency(account.openingBalance)} />
          <DetailRow label={ta.currentBalance} value={formatCurrency(account.currentBalance)} />
        </CardContent>
      </Card>
    </div>
  );
}
