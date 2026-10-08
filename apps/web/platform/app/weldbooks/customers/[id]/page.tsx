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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { ArrowLeft, Pencil } from 'lucide-react';
import { CustomerExemptionsTab } from '@/app/weldbooks/sales-tax/certificates/customer-exemptions-tab';
import { useI18n } from '@/lib/i18n/provider';
import { useCurrentEntityCurrency } from '@/hooks/use-current-entity-currency';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { normalizeAccountingAddress } from '@/lib/weldbooks/address';
import { formatPostalAddressLines } from '@/components/address/postal-address';
import { countryName } from '@/components/address/countries';

function DetailRow({ label, value }: Readonly<{ label: string; value: React.ReactNode }>) {
  if (!value && value !== 0) return null;
  return (
    <div className="flex justify-between gap-4 py-2 border-b last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium text-right">{value}</span>
    </div>
  );
}

function AddressBlock({ lines }: Readonly<{ lines: string[] }>) {
  if (lines.length === 0) return null;
  return (
    <span className="block">
      {lines.map((line) => (
        <span key={line} className="block">{line}</span>
      ))}
    </span>
  );
}

export default function ContactDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { data, isLoading } = useAccountingCustomer(id);
  const { t, language } = useI18n();
  const tc = t.accounting.contacts;
  const { formatMoney } = useCurrentEntityCurrency();
  const { labels, features } = useJurisdictionLabels();
  const tx = t.weldbooksUs.salesTax.setup.exemptions;

  if (isLoading) return <PageLoader fullScreen={false} />;

  const contact = data?.data;
  if (!contact) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">{tc.contactNotFound}</p>
      </div>
    );
  }

  const addressLines = (raw: unknown) =>
    formatPostalAddressLines(normalizeAccountingAddress(raw), {
      countryName: (code) => countryName(code, language || 'en'),
    });
  const billingLines = addressLines(contact.billingAddress);
  const shippingLines = addressLines(contact.shippingAddress);
  // US entities: a customer can hold sales tax exemption certificates (a supplier buys from us, never from them).
  const showExemptions = features.salesTax && contact.role !== 'supplier';
  const roleLabel: Record<string, string> = {
    customer: tc.roles.customer,
    supplier: labels.supplier,
    both: tc.roles.both,
  };

  return (
    <div className={`p-4 sm:p-6 ${showExemptions ? 'max-w-5xl' : 'max-w-3xl'} space-y-6`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <Link to="/weldbooks/customers">
            <Button variant="ghost" size="icon" aria-label={tc.cancel}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-semibold">{contact.name}</h1>
            {contact.role && contact.role !== 'none' ? (
              <Badge variant="outline" className="mt-1">
                {roleLabel[contact.role] ?? contact.role}
              </Badge>
            ) : null}
          </div>
        </div>
        <Link to="/weldbooks/customers/$id/edit" params={{ id: contact.id }}>
          <Button variant="outline" size="sm">
            <Pencil className="h-4 w-4 mr-1" />
            {tc.editContact}
          </Button>
        </Link>
      </div>

      <Tabs defaultValue="details" className="gap-6">
        {showExemptions ? (
          <TabsList>
            <TabsTrigger value="details">{tx.tabDetails}</TabsTrigger>
            <TabsTrigger value="exemptions">{tx.tabExemptions}</TabsTrigger>
          </TabsList>
        ) : null}
        <TabsContent value="details" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{tc.general}</CardTitle>
            </CardHeader>
            <CardContent>
              <DetailRow label={tc.nameOnInvoice} value={contact.name} />
              <DetailRow label={tc.companyName} value={contact.companyName} />
              <DetailRow label={tc.firstName} value={contact.firstName} />
              <DetailRow label={tc.lastName} value={contact.lastName} />
              <DetailRow label={tc.email} value={contact.email} />
              <DetailRow label={tc.phone} value={contact.phone} />
            </CardContent>
          </Card>

          {(billingLines.length > 0 || shippingLines.length > 0) && (
            <Card>
              <CardHeader>
                <CardTitle>{tc.addresses}</CardTitle>
              </CardHeader>
              <CardContent>
                <DetailRow label={tc.billingAddress} value={<AddressBlock lines={billingLines} />} />
                <DetailRow
                  label={tc.shippingAddress}
                  value={
                    shippingLines.length > 0 && shippingLines.join('|') !== billingLines.join('|') ? (
                      <AddressBlock lines={shippingLines} />
                    ) : null
                  }
                />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>{tc.taxAndRegistration}</CardTitle>
            </CardHeader>
            <CardContent>
              <DetailRow label={labels.taxId} value={contact.vatNumber} />
              <DetailRow label={labels.registrationId} value={contact.registrationNumber} />
              {!contact.vatNumber && !contact.registrationNumber ? (
                <p className="text-sm text-muted-foreground">—</p>
              ) : null}
            </CardContent>
          </Card>

          {(contact.iban || contact.bic) && (
            <Card>
              <CardHeader>
                <CardTitle>{tc.bankingSection}</CardTitle>
              </CardHeader>
              <CardContent>
                <DetailRow label={tc.iban} value={contact.iban} />
                <DetailRow label={tc.bic} value={contact.bic} />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>{tc.financial}</CardTitle>
            </CardHeader>
            <CardContent>
              <DetailRow label={tc.paymentTermsDays} value={contact.paymentTermsDays} />
              <DetailRow label={tc.outstandingBalance} value={formatMoney(contact.outstandingBalance)} />
            </CardContent>
          </Card>

          {contact.notes ? (
            <Card>
              <CardHeader>
                <CardTitle>{tc.notes}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap">{contact.notes}</p>
              </CardContent>
            </Card>
          ) : null}
        </TabsContent>
        {showExemptions ? (
          <TabsContent value="exemptions">
            <CustomerExemptionsTab partyId={contact.id} taxUse={(contact as { taxUse?: string | null }).taxUse} />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}
