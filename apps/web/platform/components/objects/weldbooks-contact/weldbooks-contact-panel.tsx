/**
 * WeldBooks contact object panel (a customer or a supplier).
 *
 * Built on the same shell as the company / person / bank account panels:
 * `useObjectPanelShell` + `EntityDetailView` + `ObjectPanelTabs`, so it
 * inherits the shared header chrome, the panel↔fullscreen toggle and the
 * stacking/back behaviour. It replaces the standalone
 * `/weldbooks/customers/:id` page, which now redirects to the customers list
 * with this panel open in fullscreen.
 *
 * Tabs: Details · Exemptions (US sales tax, customers only) · History.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Archive,
  ArchiveRestore,
  Building2,
  Clock,
  Coins,
  CreditCard,
  Edit,
  EllipsisVertical,
  ExternalLink,
  FileText,
  Hash,
  Landmark,
  Link as LinkIcon,
  Mail,
  MapPin,
  Phone,
  StickyNote,
  Tag,
  Trash2,
  Truck,
  User,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DrawerFieldSettings } from '@weldsuite/ui/components/drawer-field-settings';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  ObjectPanelTabs,
  useObjectPanel,
  useObjectPanelShell,
  useObjectPanelTabConfig,
  type ObjectPanelComponentProps,
} from '@/components/object-panel';
import { EntityAuditPanel } from '@/components/entity-audit-panel';
import { PropertyRow } from '@/components/objects/_shared/property-row';
import { AddressPropertyRow } from '@/components/objects/_shared/address-property-row';
import { SelectPropertyRow } from '@/components/objects/_shared/select-property-row';
import { tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { formatPostalAddressLines } from '@/components/address/postal-address';
import { countryName } from '@/components/address/countries';
import { CustomerExemptionsTab } from '@/app/weldbooks/sales-tax/certificates/customer-exemptions-tab';
import {
  useAccountingCustomer,
  useDeleteAccountingCustomer,
  useSetAccountingCustomerArchived,
  useUpdateAccountingCustomer,
} from '@/hooks/queries/use-accounting-queries';
import { useCurrentEntityCurrency } from '@/hooks/use-current-entity-currency';
import { useWorkspaceUrl } from '@/hooks/use-workspace-url';
import type { Customer } from '@/lib/api/domains/weldbooks';
import { errorDetails } from '@/lib/api/domains/weldbooks-banking';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { normalizeAccountingAddress } from '@/lib/weldbooks/address';
import { contactIdLabels } from '@/lib/weldbooks/contact-id-labels';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import {
  getWeldbooksContactTabs,
  type WeldbooksContactTab,
} from './weldbooks-contact-tabs';

const WELDBOOKS_CONTACT_PANEL_WIDTH = 480;

const PILL = 'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none';
const PILL_GRAY = 'text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary';

/** Read-only rows with no value show a dash instead of the editable "Set …" prompt. */
const EMPTY_VALUE = '—';

type Translations = ReturnType<typeof useI18n>['t'];
type CrmRecord = { type: 'company' | 'person'; id: string };

/** The message of a failed request, when it carries one. */
function errorMessage(err: unknown): string | undefined {
  return err instanceof Error ? err.message : undefined;
}

/** The WeldCRM company or person the contact is; none for a contact from before contacts had a type. */
function crmRecordOf(contact: Customer): CrmRecord | null {
  if (contact.kind === 'company' && contact.companyId) return { type: 'company', id: contact.companyId };
  if (contact.kind === 'person' && contact.personId) return { type: 'person', id: contact.personId };
  return null;
}

// ─── Header ────────────────────────────────────────────────────────────────

function ContactAvatar({ contact }: Readonly<{ contact?: Customer }>) {
  let content: ReactNode = <Building2 className="h-3.5 w-3.5" aria-hidden />;
  if (contact?.kind === 'person') content = <User className="h-3.5 w-3.5" aria-hidden />;
  else if (!contact?.kind && contact?.name) content = contact.name.charAt(0).toUpperCase();
  return (
    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-gray-200 text-[12px] font-medium text-gray-600 dark:bg-accent dark:text-muted-foreground">
      {content}
    </div>
  );
}

function ContactTitle({ contact, t }: Readonly<{ contact?: Customer; t: Translations }>) {
  if (!contact) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate text-[15px] font-medium text-foreground">{contact.name}</span>
      {contact.archivedAt ? (
        <span className={cn(PILL, PILL_GRAY, 'flex-shrink-0')}>{t.accounting.contacts.archived}</span>
      ) : null}
    </div>
  );
}

/** Archive / restore / delete mutations for a contact, plus the dialog state they drive. */
function useContactActions(contact: Customer | undefined, canArchive: boolean, onClose: () => void) {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const deleteContact = useDeleteAccountingCustomer();
  const setArchived = useSetAccountingCustomerArchived();
  const [dialog, setDialog] = useState<'delete' | 'archive' | null>(null);
  /** The server's reason a contact can not be deleted (it is used); offers Archive instead. */
  const [deleteBlocked, setDeleteBlocked] = useState<string | null>(null);

  const archive = (archived: boolean) => {
    if (!contact) return;
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

  const remove = () => {
    if (!contact) return;
    deleteContact.mutate(contact.id, {
      onSuccess: () => {
        toast.success(tc.contactDeleted);
        setDialog(null);
        onClose();
      },
      onError: (err) => {
        setDialog(null);
        // 409 CONTACT_IN_USE: say what uses the contact and offer Archive.
        if (errorDetails(err)?.code === 'CONTACT_IN_USE') {
          const reason = errorMessage(err) ?? tc.deleteBlockedTitle;
          if (canArchive && !contact.archivedAt) setDeleteBlocked(reason);
          else toast.error(tc.deleteBlockedTitle, { description: reason });
          return;
        }
        toast.error(tc.deleteFailed, { description: errorMessage(err) });
      },
    });
  };

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

function ContactHeaderActions({
  contact,
  canArchive,
  canDelete,
  actions,
  t,
}: Readonly<{
  contact?: Customer;
  canArchive: boolean;
  canDelete: boolean;
  actions: ContactActions;
  t: Translations;
}>) {
  const st = useTranslations();
  const workspaceUrl = useWorkspaceUrl();
  const { open: openPanel } = useObjectPanel();
  if (!contact) return null;
  const tc = t.accounting.contacts;
  const isArchived = Boolean(contact.archivedAt);
  const crmRecord = crmRecordOf(contact);
  const ArchiveIcon = isArchived ? ArchiveRestore : Archive;

  const handleCopyLink = async () => {
    // A supplier lives on the suppliers list; everyone else on the customers list.
    const list = contact.role === 'supplier' ? 'suppliers' : 'customers';
    try {
      await navigator.clipboard.writeText(
        workspaceUrl(`/weldbooks/${list}?stack=weldbooks_contact:${contact.id}`),
      );
      toast.success(st('sweep.entities.linkCopied'));
    } catch {
      toast.error(st('sweep.entities.copyLinkFailed'));
    }
  };

  return (
    <div className="flex items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon-sm"
          className="size-7"
        title={tc.editContact}
        aria-label={tc.editContact}
        asChild
      >
        <Link to="/weldbooks/customers/$id/edit" params={{ id: contact.id }}>
          <Edit className="h-4 w-4 text-muted-foreground" />
        </Link>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
            aria-label={t.accounting.invoiceDetail.moreActions}
          >
            <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {crmRecord ? (
            <DropdownMenuItem onClick={() => openPanel({ ...crmRecord, stack: true })}>
              <ExternalLink />
              {tc.openInCrm}
            </DropdownMenuItem>
          ) : null}
          {canArchive ? (
            <DropdownMenuItem
              disabled={actions.isArchiving}
              data-testid="contact-archive"
              onClick={() => (isArchived ? actions.archive(false) : actions.setDialog('archive'))}
            >
              <ArchiveIcon />
              {isArchived ? tc.unarchive : tc.archive}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => void handleCopyLink()}>
            <LinkIcon />
            {st('sweep.entities.copyLink')}
          </DropdownMenuItem>
          {canDelete ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                data-testid="contact-delete"
                onClick={() => actions.setDialog('delete')}
              >
                <Trash2 />
                {tc.delete}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ContactDialogs({ actions, t }: Readonly<{ actions: ContactActions; t: Translations }>) {
  const tc = t.accounting.contacts;
  const { dialog, setDialog, deleteBlocked, setDeleteBlocked, archive, remove, isArchiving, isDeleting } = actions;
  return (
    <>
      <ConfirmDialog
        open={dialog === 'archive'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={tc.archiveTitle}
        description={tc.archiveDesc}
        confirmLabel={tc.archive}
        cancelLabel={tc.cancel}
        loading={isArchiving}
        onConfirm={() => archive(true)}
      />
      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={tc.deleteTitle}
        description={tc.deleteDesc}
        confirmLabel={tc.delete}
        cancelLabel={tc.cancel}
        variant="destructive"
        loading={isDeleting}
        onConfirm={remove}
      />
      <ConfirmDialog
        open={deleteBlocked !== null}
        onOpenChange={(open) => !open && setDeleteBlocked(null)}
        title={tc.deleteBlockedTitle}
        description={
          <>
            {deleteBlocked}
            <span className="mt-2 block">{tc.deleteBlockedHint}</span>
          </>
        }
        confirmLabel={tc.archiveInstead}
        cancelLabel={tc.cancel}
        loading={isArchiving}
        onConfirm={() => archive(true)}
      />
    </>
  );
}

// ─── Tab bar ───────────────────────────────────────────────────────────────

function ContactTabsBar({
  tabs,
  activeTab,
  setActiveTab,
  mode,
}: Readonly<{
  tabs: WeldbooksContactTab[];
  activeTab: WeldbooksContactTab['id'];
  setActiveTab: (id: WeldbooksContactTab['id']) => void;
  mode: 'panel' | 'fullscreen';
}>) {
  const st = useTranslations();
  const configEntries = useMemo(
    () =>
      tabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        required: tab.required,
        defaultVisible:
          mode === 'panel' ? (tab.defaultVisibleInPanel ?? false) : (tab.defaultVisibleInFullscreen ?? false),
      })),
    [tabs, mode],
  );

  const { visibility, isVisible, toggle, resetToDefaults } = useObjectPanelTabConfig({
    objectType: 'weldbooks_contact',
    mode,
    tabs: configEntries,
  });

  useEffect(() => {
    if (isVisible(activeTab)) return;
    const fallback = tabs.find((tab) => isVisible(tab.id));
    if (fallback && fallback.id !== activeTab) setActiveTab(fallback.id);
  }, [activeTab, isVisible, setActiveTab, tabs]);

  const visibleTabs = useMemo(
    () =>
      tabs
        .filter((tab) => isVisible(tab.id))
        .map((tab) => ({ id: tab.id, label: tab.label, icon: tab.icon, count: tab.count })),
    [tabs, isVisible],
  );

  return (
    <div className="group/tabs-header relative">
      <ObjectPanelTabs
        tabs={visibleTabs}
        activeTab={activeTab}
        onChange={(id) => setActiveTab(id as WeldbooksContactTab['id'])}
      />
      <div className="absolute top-0 right-2 h-full flex items-center opacity-0 group-hover/tabs-header:opacity-100 focus-within:opacity-100 transition-opacity">
        <DrawerFieldSettings
          fields={configEntries}
          fieldVisibility={visibility}
          onToggle={toggle}
          onReset={resetToDefaults}
          label={st('sweep.entities.visibleTabs')}
        />
      </div>
    </div>
  );
}

// ─── Details tab ───────────────────────────────────────────────────────────

function Section({
  title,
  action,
  children,
}: Readonly<{ title: string; action?: ReactNode; children: ReactNode }>) {
  return (
    <div className="space-y-1">
      <div className="mb-1.5 flex min-h-[24px] items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
        {action}
      </div>
      {children}
    </div>
  );
}

/**
 * Saving one field of the contact from its Details tab: a PATCH with just that
 * field (an emptied text field is sent as "" and an emptied address as {}, the
 * way the full edit form clears them). `null` while the member may not edit.
 */
type SaveContact = ((patch: Record<string, unknown>) => Promise<void>) | null;
const SaveContactContext = createContext<SaveContact>(null);

function useSaveContact(contact: Customer, canEdit: boolean): SaveContact {
  const update = useUpdateAccountingCustomer();
  const { t } = useI18n();
  const { mutateAsync } = update;
  const save = useCallback(
    async (patch: Record<string, unknown>) => {
      try {
        await mutateAsync({ id: contact.id, data: patch });
      } catch (err) {
        toast.error(t.accounting.contacts.updateFailed, { description: errorMessage(err) });
      }
    },
    [mutateAsync, contact.id, t.accounting.contacts.updateFailed],
  );
  return canEdit ? save : null;
}

/** A read-only Details row that is left out when the contact has no value for it. */
function InfoRow({
  icon,
  label,
  value,
  type,
  renderValue,
}: Readonly<{
  icon: Parameters<typeof PropertyRow>[0]['icon'];
  label: string;
  value: string | number | null | undefined;
  type?: Parameters<typeof PropertyRow>[0]['type'];
  renderValue?: Parameters<typeof PropertyRow>[0]['renderValue'];
}>) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <PropertyRow
      icon={icon}
      label={label}
      value={String(value)}
      type={type}
      renderValue={renderValue}
      placeholder={EMPTY_VALUE}
      readOnly
    />
  );
}

/**
 * A Details row the member can fill in or change in place ("Set …" while it is
 * empty); read-only, and left out while empty, for one who may not edit.
 */
function FieldRow({
  icon,
  label,
  value,
  type,
  renderValue,
  toPatch,
}: Readonly<{
  icon: Parameters<typeof PropertyRow>[0]['icon'];
  label: string;
  value: string | number | null | undefined;
  type?: Parameters<typeof PropertyRow>[0]['type'];
  renderValue?: Parameters<typeof PropertyRow>[0]['renderValue'];
  /** The PATCH body for the new value ("" when the field was emptied); null skips the save. */
  toPatch: (next: string) => Record<string, unknown> | null;
}>) {
  const save = useContext(SaveContactContext);
  if (!save) return <InfoRow icon={icon} label={label} value={value} type={type} renderValue={renderValue} />;
  return (
    <PropertyRow
      icon={icon}
      label={label}
      value={value === null || value === undefined ? '' : String(value)}
      type={type}
      renderValue={renderValue}
      onSave={(next) => {
        const patch = toPatch(next?.trim() ?? '');
        return patch ? save(patch) : undefined;
      }}
    />
  );
}

/** An address as a block of lines; the row's own value is the one-line form. */
function AddressRow({
  icon,
  label,
  lines,
}: Readonly<{ icon: Parameters<typeof PropertyRow>[0]['icon']; label: string; lines: string[] }>) {
  if (lines.length === 0) return null;
  return (
    <PropertyRow
      icon={icon}
      label={label}
      value={lines.join(', ')}
      placeholder={EMPTY_VALUE}
      readOnly
      renderValue={() => (
        <span className="block min-w-0">
          {lines.map((line) => (
            <span key={line} className="block break-words [overflow-wrap:anywhere]">
              {line}
            </span>
          ))}
        </span>
      )}
    />
  );
}

/** "Jane Doe" from the person's names, as the full edit form sends it. */
function personName(firstName: string | null | undefined, lastName: string | null | undefined): string {
  return [firstName, lastName].map((part) => part?.trim()).filter(Boolean).join(' ');
}

function RoleRow({ contact, t }: Readonly<{ contact: Customer; t: Translations }>) {
  const tc = t.accounting.contacts;
  const save = useContext(SaveContactContext);
  const { labels } = useJurisdictionLabels();
  const options = [
    { value: 'customer', label: tc.roles.customer },
    { value: 'supplier', label: labels.supplier },
    { value: 'both', label: labels.customerAndSupplier },
  ];
  const role = contact.role && contact.role !== 'none' ? contact.role : null;
  if (!save) {
    const label = options.find((option) => option.value === role)?.label ?? role;
    return <InfoRow icon={Tag} label={tc.role} value={label} />;
  }
  return (
    <SelectPropertyRow
      icon={Tag}
      label={tc.role}
      value={role}
      options={options}
      // A contact always has a role: clearing the picker keeps the one it has.
      onChange={(next) => {
        if (next && next !== role) void save({ role: next });
      }}
    />
  );
}

function GeneralSection({ contact, t }: Readonly<{ contact: Customer; t: Translations }>) {
  const tc = t.accounting.contacts;
  const isPerson = contact.kind === 'person';
  const KindIcon = isPerson ? User : Building2;
  // A company prints its trading name when it has one, else its registered name.
  const invoiceName = !isPerson && contact.name !== contact.companyName ? contact.name : '';
  return (
    <Section title={tc.general}>
      <InfoRow icon={KindIcon} label={tc.kind} value={contact.kind ? tc.kinds[contact.kind] : null} />
      <RoleRow contact={contact} t={t} />
      {isPerson ? (
        <>
          <FieldRow
            icon={User}
            label={tc.firstName}
            value={contact.firstName}
            toPatch={(next) =>
              next || contact.lastName ? { firstName: next, name: personName(next, contact.lastName) } : null
            }
          />
          <FieldRow
            icon={User}
            label={tc.lastName}
            value={contact.lastName}
            toPatch={(next) =>
              next || contact.firstName ? { lastName: next, name: personName(contact.firstName, next) } : null
            }
          />
        </>
      ) : (
        <>
          <FieldRow
            icon={Building2}
            label={tc.companyName}
            value={contact.companyName}
            // A company always has a name; the trading name stays when it has one.
            toPatch={(next) => (next ? { companyName: next, name: invoiceName || next } : null)}
          />
          <FieldRow
            icon={FileText}
            label={tc.nameOnInvoice}
            value={invoiceName}
            toPatch={(next) => ({ name: next || contact.companyName || contact.name })}
          />
        </>
      )}
      <FieldRow icon={Mail} label={tc.email} value={contact.email} type="email" toPatch={(next) => ({ email: next })} />
      <FieldRow icon={Phone} label={tc.phone} value={contact.phone} type="phone" toPatch={(next) => ({ phone: next })} />
    </Section>
  );
}

/** A company contact's contact person: its billing contact in WeldCRM. */
function ContactPersonSection({ contact, t }: Readonly<{ contact: Customer; t: Translations }>) {
  const tc = t.accounting.contacts;
  const { open: openPanel } = useObjectPanel();
  const contactPerson = contact.contactPerson ?? null;
  return (
    <Section
      title={tc.contactPerson}
      action={
        contactPerson ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => openPanel({ type: 'person', id: contactPerson.personId, stack: true })}
          >
            <ExternalLink className="mr-1 h-3.5 w-3.5" />
            {tc.openInCrm}
          </Button>
        ) : undefined
      }
    >
      {contactPerson ? (
        <>
          <InfoRow icon={User} label={tc.name} value={contactPerson.name} />
          <InfoRow icon={Mail} label={tc.email} value={contactPerson.email} type="email" />
          <InfoRow icon={Phone} label={tc.phone} value={contactPerson.phone} type="phone" />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{tc.noContactPerson}</p>
      )}
    </Section>
  );
}

function AddressesSection({ contact, t }: Readonly<{ contact: Customer; t: Translations }>) {
  const { language } = useI18n();
  const st = useTranslations();
  const tc = t.accounting.contacts;
  const save = useContext(SaveContactContext);
  const addressLines = (raw: unknown) =>
    formatPostalAddressLines(normalizeAccountingAddress(raw), {
      countryName: (code) => countryName(code, language || 'en'),
    });
  const billingLines = addressLines(contact.billingAddress);
  const shippingLines = addressLines(contact.shippingAddress);
  const shipsElsewhere = shippingLines.length > 0 && shippingLines.join('|') !== billingLines.join('|');

  if (save) {
    const billing = contact.billingAddress as Record<string, unknown> | null | undefined;
    const shipping = contact.shippingAddress as Record<string, unknown> | null | undefined;
    return (
      <Section title={tc.addresses}>
        <AddressPropertyRow
          icon={MapPin}
          label={tc.billingAddress}
          value={billing}
          placeholder={st('sweep.entities.setFieldPlaceholder', { label: tc.billingAddress })}
          onSave={(next) => save({ billingAddress: next ?? {} })}
        />
        <AddressPropertyRow
          icon={Truck}
          label={tc.shippingAddress}
          // Empty while it is the billing address: the placeholder says so.
          value={shipsElsewhere ? shipping : null}
          placeholder={tc.sameAsBilling}
          onSave={(next) => save({ shippingAddress: next ?? billing ?? {} })}
        />
      </Section>
    );
  }

  if (billingLines.length === 0 && shippingLines.length === 0) return null;
  return (
    <Section title={tc.addresses}>
      <AddressRow icon={MapPin} label={tc.billingAddress} lines={billingLines} />
      <AddressRow icon={Truck} label={tc.shippingAddress} lines={shipsElsewhere ? shippingLines : []} />
    </Section>
  );
}

function TaxRegistrationSection({ contact, t }: Readonly<{ contact: Customer; t: Translations }>) {
  const tc = t.accounting.contacts;
  const tb = t.weldbooksBr.contact;
  const { labels } = useJurisdictionLabels();
  const canEdit = useContext(SaveContactContext) !== null;
  // The tax and registration number are named after the contact's country, not the books' jurisdiction.
  const idLabels = contactIdLabels(
    normalizeAccountingAddress(contact.billingAddress)?.country,
    t.accounting.terminology,
    labels,
  );
  const br = contact.brFiscal;
  return (
    <Section title={tc.taxAndRegistration}>
      {br?.taxId && !contact.vatNumber ? (
        <InfoRow icon={Hash} label={idLabels.taxId} value={br.taxId} />
      ) : (
        <FieldRow
          icon={Hash}
          label={idLabels.taxId}
          value={contact.vatNumber}
          toPatch={(next) => ({ vatNumber: next })}
        />
      )}
      {idLabels.registrationId !== null || contact.registrationNumber ? (
        <FieldRow
          icon={Hash}
          label={idLabels.registrationId ?? labels.registrationId}
          value={contact.registrationNumber}
          toPatch={(next) => ({ registrationNumber: next })}
        />
      ) : null}
      <InfoRow icon={Hash} label={tb.inscricaoMunicipal} value={br?.inscricaoMunicipal} />
      <InfoRow icon={Hash} label={tb.municipalityCode} value={br?.municipalityCode} />
      {br && br.icmsContributor !== undefined ? (
        <InfoRow
          icon={Hash}
          label={tb.icmsContributor}
          value={br.icmsContributor ? tb.icmsOptions.yes : tb.icmsOptions.no}
        />
      ) : null}
      {br?.simplesNacional ? <InfoRow icon={Hash} label={tb.simplesNacional} value={tb.icmsOptions.yes} /> : null}
      {!canEdit && !contact.vatNumber && !contact.registrationNumber && !br?.taxId ? (
        <p className="text-sm text-muted-foreground">{EMPTY_VALUE}</p>
      ) : null}
    </Section>
  );
}

function BankingSection({ contact, t }: Readonly<{ contact: Customer; t: Translations }>) {
  const tc = t.accounting.contacts;
  const canEdit = useContext(SaveContactContext) !== null;
  if (!canEdit && !contact.iban && !contact.bic) return null;
  const mono = (value: string | null | undefined) => <span className="font-mono">{value}</span>;
  return (
    <Section title={tc.bankingSection}>
      <FieldRow
        icon={CreditCard}
        label={tc.iban}
        value={contact.iban}
        renderValue={mono}
        toPatch={(next) => ({ iban: next.replace(/\s+/g, '').toUpperCase() })}
      />
      <FieldRow
        icon={Landmark}
        label={tc.bic}
        value={contact.bic}
        renderValue={mono}
        toPatch={(next) => ({ bic: next.toUpperCase() })}
      />
    </Section>
  );
}

function FinancialSection({ contact, t }: Readonly<{ contact: Customer; t: Translations }>) {
  const tc = t.accounting.contacts;
  const { formatMoney } = useCurrentEntityCurrency();
  return (
    <Section title={tc.financial}>
      <FieldRow
        icon={Clock}
        label={tc.paymentTermsDays}
        value={contact.paymentTermsDays}
        toPatch={(next) => {
          if (next === '') return { paymentTermsDays: null };
          const days = Number(next);
          if (!Number.isInteger(days) || days < 0) {
            toast.error(tc.updateFailed, { description: tc.paymentTermsHelp });
            return null;
          }
          return { paymentTermsDays: days };
        }}
      />
      <InfoRow icon={Coins} label={tc.outstandingBalance} value={formatMoney(contact.outstandingBalance)} />
    </Section>
  );
}

function NotesSection({ contact, t }: Readonly<{ contact: Customer; t: Translations }>) {
  const tc = t.accounting.contacts;
  const canEdit = useContext(SaveContactContext) !== null;
  if (!canEdit && !contact.notes) return null;
  return (
    <Section title={tc.notes}>
      <FieldRow
        icon={StickyNote}
        label={tc.notes}
        value={contact.notes}
        renderValue={(value) => <span className="whitespace-pre-wrap break-words">{value}</span>}
        toPatch={(next) => ({ notes: next })}
      />
    </Section>
  );
}

function WeldbooksContactDetailsTab({
  contact,
  canEdit,
  t,
}: Readonly<{ contact: Customer; canEdit: boolean; t: Translations }>) {
  const save = useSaveContact(contact, canEdit);
  const isPerson = contact.kind === 'person';
  // A person has no VAT or registration number (a Brazilian one has a CPF).
  const showTax =
    !isPerson || Boolean(contact.vatNumber || contact.registrationNumber || contact.brFiscal?.taxId);
  return (
    <SaveContactContext.Provider value={save}>
      <div className="p-4 space-y-5">
        <GeneralSection contact={contact} t={t} />
        {contact.kind === 'company' ? <ContactPersonSection contact={contact} t={t} /> : null}
        <AddressesSection contact={contact} t={t} />
        {showTax ? <TaxRegistrationSection contact={contact} t={t} /> : null}
        <BankingSection contact={contact} t={t} />
        <FinancialSection contact={contact} t={t} />
        <NotesSection contact={contact} t={t} />
      </div>
    </SaveContactContext.Provider>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

export function WeldbooksContactPanel(props: Readonly<ObjectPanelComponentProps>) {
  const { id, onClose, initialTab } = props;
  const { t } = useI18n();
  const st = useTranslations();
  const { can } = usePermissions();
  const { features } = useJurisdictionLabels();
  const tc = t.accounting.contacts;

  const contactQuery = useAccountingCustomer(id);
  const contact = contactQuery.data?.data;

  const canDelete = can('customers:delete') || can('suppliers:delete');
  const canArchive = can('customers:update') || can('suppliers:update');
  const actions = useContactActions(contact, canArchive, onClose);

  const shell = useObjectPanelShell({
    ...props,
    width: WELDBOOKS_CONTACT_PANEL_WIDTH,
    loading: contactQuery.isLoading && !contact,
  });
  const mode = shell.mode;

  // US entities: a customer can hold sales tax exemption certificates (a supplier buys from us, never from them).
  const showExemptions = Boolean(contact) && features.salesTax && contact?.role !== 'supplier';

  const tabs = useMemo(
    () =>
      getWeldbooksContactTabs({
        details: st('sweep.entities.detailsTab'),
        exemptions: t.weldbooksUs.salesTax.setup.exemptions.tabExemptions,
        history: st('sweep.entities.auditLogTab'),
        showExemptions,
      }),
    [st, t, showExemptions],
  );

  const initial = useMemo<WeldbooksContactTab['id']>(() => {
    const match = tabs.find((tab) => tab.id === initialTab);
    return match?.id ?? 'overview';
  }, [initialTab, tabs]);
  const [activeTab, setActiveTab] = useState<WeldbooksContactTab['id']>(initial);

  return (
    <>
      <EntityDetailView
        {...shell.entityDetailViewProps}
        contentClassName={tabBodyClassName(mode)}
        avatar={<ContactAvatar contact={contact} />}
        title={<ContactTitle contact={contact} t={t} />}
        actions={
          <ContactHeaderActions
            contact={contact}
            canArchive={canArchive}
            canDelete={canDelete}
            actions={actions}
            t={t}
          />
        }
        tabs={
          <ContactTabsBar tabs={tabs} activeTab={activeTab} setActiveTab={setActiveTab} mode={mode} />
        }
      >
        {!contactQuery.isLoading && contactQuery.isError && (
          <div className="p-4 text-sm text-destructive">{st('sweep.entities.failedToLoad')}</div>
        )}
        {!contactQuery.isLoading && !contactQuery.isError && !contact && (
          <div className="p-6 text-center text-sm text-muted-foreground">{tc.contactNotFound}</div>
        )}

        {contact && activeTab === 'overview' && (
          <WeldbooksContactDetailsTab contact={contact} canEdit={canArchive} t={t} />
        )}
        {contact && activeTab === 'exemptions' && (
          <div className="p-4">
            <CustomerExemptionsTab
              partyId={contact.id}
              taxUse={(contact as { taxUse?: string | null }).taxUse}
            />
          </div>
        )}
        {contact && activeTab === 'history' && (
          <EntityAuditPanel entityType="accounting_contact" entityId={contact.id} />
        )}
      </EntityDetailView>

      {contact ? <ContactDialogs actions={actions} t={t} /> : null}
    </>
  );
}
