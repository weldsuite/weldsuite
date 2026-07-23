import { useParams, Link } from '@tanstack/react-router';
import { useAccountingCustomer } from '@/hooks/queries/use-accounting-queries';
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
  if (!value && value !== 0) return null;
  return (
    <div className="flex justify-between py-2 border-b last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

export default function ContactDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { data, isLoading } = useAccountingCustomer(id);
  const { t } = useI18n();
  const tc = t.accounting.contacts;

  if (isLoading) return <PageLoader fullScreen={false} />;

  const contact = data?.data;
  if (!contact) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">{tc.contactNotFound}</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/weldbooks/customers">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-semibold">{contact.name}</h1>
            <Badge variant="outline" className="capitalize mt-1">
              {contact.type}
            </Badge>
          </div>
        </div>
        <Link to={`/weldbooks/customers/${contact.id}/edit` as any}>
          <Button variant="outline" size="sm">
            <Pencil className="h-4 w-4 mr-1" />
            {tc.editContact}
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{tc.general}</CardTitle>
        </CardHeader>
        <CardContent>
          <DetailRow label={tc.name} value={contact.name} />
          <DetailRow label={tc.company} value={contact.companyName} />
          <DetailRow label={tc.firstName} value={contact.firstName} />
          <DetailRow label={tc.lastName} value={contact.lastName} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{tc.contactDetails}</CardTitle>
        </CardHeader>
        <CardContent>
          <DetailRow label={tc.email} value={contact.email} />
          <DetailRow label={tc.phone} value={contact.phone} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{tc.taxAndRegistration}</CardTitle>
        </CardHeader>
        <CardContent>
          <DetailRow label={tc.btwNumber} value={contact.taxNumber} />
          <DetailRow label={tc.kvkNumber} value={contact.kvkNumber} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{tc.bankingSection}</CardTitle>
        </CardHeader>
        <CardContent>
          <DetailRow label={tc.iban} value={contact.iban} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{tc.financial}</CardTitle>
        </CardHeader>
        <CardContent>
          <DetailRow label={tc.outstandingBalance} value={formatCurrency(contact.outstandingBalance)} />
        </CardContent>
      </Card>
    </div>
  );
}
