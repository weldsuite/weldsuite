import { useState } from 'react';
import { useParams, Link, useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import {
  useAccountingCustomer,
  useDeleteAccountingCustomer,
  useSetAccountingCustomerArchived,
} from '@/hooks/queries/use-accounting-queries';
import { errorDetails } from '@/lib/api/domains/weldbooks-banking';
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
import { Archive, ArchiveRestore, ArrowLeft, Pencil, Trash2 } from 'lucide-react';
import { CustomerExemptionsTab } from '@/app/weldbooks/sales-tax/certificates/customer-exemptions-tab';
import { useI18n } from '@/lib/i18n/provider';
import { useCurrentEntityCurrency } from '@/hooks/use-current-entity-currency';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { contactIdLabels } from '@/lib/weldbooks/contact-id-labels';
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

type Contact = NonNullable<NonNullable<ReturnType<typeof useAccountingCustomer>['data']>['data']>;
type ContactDialogState = 'delete' | 'archive' | null;

/** The message of a failed request, when it carries one. */
function errorMessage(err: unknown): string | undefined {
  return err instanceof Error ? err.message : undefined;
}

/** Archive / restore / delete mutations for a contact, plus the dialog state they drive. */
function useContactActions(contact: Contact) {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const navigate = useNavigate();
  const deleteContact = useDeleteAccountingCustomer();
  const setArchived = useSetAccountingCustomerArchived();
  const [dialog, setDialog] = useState<ContactDialogState>(null);
  /** The server's reason a contact can not be deleted (it is used); offers Archive instead. */
  const [deleteBlocked, setDeleteBlocked] = useState<string | null>(null);

  const archive = (archived: boolean) => {
    const messages = archived
      ? { done: tc.contactArchived, failed: tc.archiveFailed }
      : { done: tc.contactRestored, failed: tc.restoreFailed };
    setArchived.mutate(
      { id: contact.id, archived },
      {
        onSuccess: () => {
          toast.success(messages.done);
          setDialog(null);
          setDeleteBlocked(null);
        },
        onError: (err) => {
          setDialog(null);
          setDeleteBlocked(null);
          toast.error(messages.failed, { description: errorMessage(err) });
        },
      },
    );
  };

  const remove = () =>
    deleteContact.mutate(contact.id, {
      onSuccess: () => {
        toast.success(tc.contactDeleted);
        navigate({ to: '/weldbooks/customers' });
      },
      onError: (err) => {
        setDialog(null);
        // 409 CONTACT_IN_USE: say what uses the contact and offer Archive.
        if (errorDetails(err)?.code === 'CONTACT_IN_USE') {
          setDeleteBlocked(errorMessage(err) ?? tc.deleteBlockedTitle);
          return;
        }
        toast.error(tc.deleteFailed, { description: errorMessage(err) });
      },
    });

  return {
    dialog,
    setDialog,
    deleteBlocked,
    setDeleteBlocked,
    archive,
    remove,
    isArchiving: setArchived.isPending,
    isDeleting: deleteContact.isPending,
  };
}

type ContactActions = ReturnType<typeof useContactActions>;

function ContactTitle({ contact, isArchived }: Readonly<{ contact: Contact; isArchived: boolean }>) {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const { labels } = useJurisdictionLabels();
  const roleLabel: Record<string, string> = {
    customer: tc.roles.customer,
    supplier: labels.supplier,
    both: labels.customerAndSupplier,
  };
  return (
    <div>
      <h1 className="text-2xl font-semibold">{contact.name}</h1>
      <div className="mt-1 flex flex-wrap gap-2">
        {contact.role && contact.role !== 'none' ? (
          <Badge variant="outline">{roleLabel[contact.role] ?? contact.role}</Badge>
        ) : null}
        {isArchived ? <Badge variant="secondary">{tc.archived}</Badge> : null}
      </div>
    </div>
  );
}

function ContactHeaderActions({
  contactId,
  isArchived,
  canArchive,
  canDelete,
  actions,
}: Readonly<{
  contactId: string;
  isArchived: boolean;
  canArchive: boolean;
  canDelete: boolean;
  actions: ContactActions;
}>) {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const ArchiveIcon = isArchived ? ArchiveRestore : Archive;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {canArchive ? (
        <Button
          variant="outline"
          size="sm"
          disabled={actions.isArchiving}
          onClick={() => (isArchived ? actions.archive(false) : actions.setDialog('archive'))}
          data-testid="contact-archive"
        >
          <ArchiveIcon className="h-4 w-4 mr-1" />
          {isArchived ? tc.unarchive : tc.archive}
        </Button>
      ) : null}
      {canDelete ? (
        <Button variant="outline" size="sm" onClick={() => actions.setDialog('delete')} data-testid="contact-delete">
          <Trash2 className="h-4 w-4 mr-1" />
          {tc.delete}
        </Button>
      ) : null}
      <Link to="/weldbooks/customers/$id/edit" params={{ id: contactId }}>
        <Button variant="outline" size="sm">
          <Pencil className="h-4 w-4 mr-1" />
          {tc.editContact}
        </Button>
      </Link>
    </div>
  );
}

function ContactDialogs({
  isArchived,
  canArchive,
  actions,
}: Readonly<{ isArchived: boolean; canArchive: boolean; actions: ContactActions }>) {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const { dialog, setDialog, deleteBlocked, setDeleteBlocked, archive, remove, isDeleting } = actions;
  return (
    <>
      <AlertDialog open={dialog === 'archive'} onOpenChange={(open) => !open && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tc.archiveTitle}</AlertDialogTitle>
            <AlertDialogDescription>{tc.archiveDesc}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={() => archive(true)}>{tc.archive}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={dialog === 'delete'} onOpenChange={(open) => !open && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tc.deleteTitle}</AlertDialogTitle>
            <AlertDialogDescription>{tc.deleteDesc}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                remove();
              }}
              disabled={isDeleting}
            >
              {tc.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteBlocked !== null} onOpenChange={(open) => !open && setDeleteBlocked(null)}>
        <AlertDialogContent data-testid="contact-delete-blocked">
          <AlertDialogHeader>
            <AlertDialogTitle>{tc.deleteBlockedTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteBlocked}
              <span className="mt-2 block">{tc.deleteBlockedHint}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc.cancel}</AlertDialogCancel>
            {canArchive && !isArchived ? (
              <AlertDialogAction onClick={() => archive(true)} data-testid="contact-archive-instead">
                {tc.archiveInstead}
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function AddressesCard({ contact }: Readonly<{ contact: Contact }>) {
  const { t, language } = useI18n();
  const tc = t.accounting.contacts;
  const addressLines = (raw: unknown) =>
    formatPostalAddressLines(normalizeAccountingAddress(raw), {
      countryName: (code) => countryName(code, language || 'en'),
    });
  const billingLines = addressLines(contact.billingAddress);
  const shippingLines = addressLines(contact.shippingAddress);
  if (billingLines.length === 0 && shippingLines.length === 0) return null;
  const showShipping = shippingLines.length > 0 && shippingLines.join('|') !== billingLines.join('|');
  return (
    <Card>
      <CardHeader>
        <CardTitle>{tc.addresses}</CardTitle>
      </CardHeader>
      <CardContent>
        <DetailRow label={tc.billingAddress} value={<AddressBlock lines={billingLines} />} />
        <DetailRow label={tc.shippingAddress} value={showShipping ? <AddressBlock lines={shippingLines} /> : null} />
      </CardContent>
    </Card>
  );
}

function TaxRegistrationCard({ contact }: Readonly<{ contact: Contact }>) {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const { labels } = useJurisdictionLabels();
  // The tax and registration number are named after the contact's country, not the books' jurisdiction.
  const idLabels = contactIdLabels(
    normalizeAccountingAddress(contact.billingAddress)?.country,
    t.accounting.terminology,
    labels,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{tc.taxAndRegistration}</CardTitle>
      </CardHeader>
      <CardContent>
        <DetailRow label={idLabels.taxId} value={contact.vatNumber} />
        {(idLabels.registrationId !== null || contact.registrationNumber) && (
          <DetailRow label={idLabels.registrationId ?? labels.registrationId} value={contact.registrationNumber} />
        )}
        {!contact.vatNumber && !contact.registrationNumber ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BankingCard({ contact }: Readonly<{ contact: Contact }>) {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  if (!contact.iban && !contact.bic) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{tc.bankingSection}</CardTitle>
      </CardHeader>
      <CardContent>
        <DetailRow label={tc.iban} value={contact.iban} />
        <DetailRow label={tc.bic} value={contact.bic} />
      </CardContent>
    </Card>
  );
}

function ContactDetailsTab({ contact }: Readonly<{ contact: Contact }>) {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const { formatMoney } = useCurrentEntityCurrency();
  return (
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

      <AddressesCard contact={contact} />
      <TaxRegistrationCard contact={contact} />
      <BankingCard contact={contact} />

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
  );
}

function ContactDetail({ contact }: Readonly<{ contact: Contact }>) {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const { features } = useJurisdictionLabels();
  const tx = t.weldbooksUs.salesTax.setup.exemptions;
  const { can } = usePermissions();
  const canDelete = can('customers:delete') || can('suppliers:delete');
  const canArchive = can('customers:update') || can('suppliers:update');
  const actions = useContactActions(contact);
  // US entities: a customer can hold sales tax exemption certificates (a supplier buys from us, never from them).
  const showExemptions = features.salesTax && contact.role !== 'supplier';
  const isArchived = Boolean(contact.archivedAt);

  return (
    <div className={`p-4 sm:p-6 ${showExemptions ? 'max-w-5xl' : 'max-w-3xl'} space-y-6`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <Link to="/weldbooks/customers">
            <Button variant="ghost" size="icon" aria-label={tc.cancel}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <ContactTitle contact={contact} isArchived={isArchived} />
        </div>
        <ContactHeaderActions
          contactId={contact.id}
          isArchived={isArchived}
          canArchive={canArchive}
          canDelete={canDelete}
          actions={actions}
        />
      </div>

      <ContactDialogs isArchived={isArchived} canArchive={canArchive} actions={actions} />

      <Tabs defaultValue="details" className="gap-6">
        {showExemptions ? (
          <TabsList>
            <TabsTrigger value="details">{tx.tabDetails}</TabsTrigger>
            <TabsTrigger value="exemptions">{tx.tabExemptions}</TabsTrigger>
          </TabsList>
        ) : null}
        <ContactDetailsTab contact={contact} />
        {showExemptions ? (
          <TabsContent value="exemptions">
            <CustomerExemptionsTab partyId={contact.id} taxUse={(contact as { taxUse?: string | null }).taxUse} />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}

export default function ContactDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { data, isLoading } = useAccountingCustomer(id);
  const { t } = useI18n();

  if (isLoading) return <PageLoader fullScreen={false} />;

  const contact = data?.data;
  if (!contact) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">{t.accounting.contacts.contactNotFound}</p>
      </div>
    );
  }

  return <ContactDetail contact={contact} />;
}
