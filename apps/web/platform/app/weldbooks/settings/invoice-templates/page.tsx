import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { AlertCircle, Check, Copy, FileText, MoreVertical, Pencil, Star, Trash2 } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { PAPER_SIZES, type InvoiceTemplate } from '@weldsuite/books-domain/invoice-template/schema';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyStateIllustration, EntityList, type FilterConfig } from '@/components/entity-list';
import { useAccountingEntity } from '@/hooks/queries/use-accounting-queries';
import {
  useDeleteInvoiceTemplate,
  useDuplicateInvoiceTemplate,
  useInvoiceTemplates,
  useUpdateInvoiceTemplate,
} from '@/hooks/queries/use-invoice-template-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useParams } from '@/lib/router';
import { invoicePaperSize } from '@/lib/weldbooks/invoice-pdf';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { WeldbooksEntityScope } from '../entity-scope';
import { NewTemplateDialog } from './new-template-dialog';
import { applyTemplateFilters } from './template-filters';
import { TemplateThumbnail } from './template-thumbnail';
import { usePreviewData } from './use-template-preview';

type SampleData = ReturnType<typeof usePreviewData>['data'];

/** How much of the page a card's preview shows, from the top. */
const PREVIEW_VISIBLE = 0.75;

interface TemplateCardProps {
  template: InvoiceTemplate;
  data: SampleData;
  canUpdate: boolean;
  canCreate: boolean;
  canDelete: boolean;
  busy: boolean;
  onSetDefault: (template: InvoiceTemplate) => void;
  onDuplicate: (template: InvoiceTemplate) => void;
  onDelete: (template: InvoiceTemplate) => void;
}

function TemplateCard({ template, data, canUpdate, canCreate, canDelete, busy, onSetDefault, onDuplicate, onDelete }: Readonly<TemplateCardProps>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceTemplates;
  const tl = ti.list;
  const { formatDate } = useWeldbooksFormat();
  const hasActions = canUpdate || canCreate || canDelete;
  const paper = PAPER_SIZES[template.document.paperSize] ?? PAPER_SIZES.a4;

  return (
    <Card className="group gap-0 overflow-hidden p-0 transition-shadow hover:shadow-md">
      <Link
        to="/settings/entities/$id/invoice-templates/$templateId"
        params={{ id: template.entityId, templateId: template.id }}
        className="block bg-muted/40 px-6 pt-6 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-label={`${tl.edit}: ${template.name}`}
      >
        {/* Zoomed in: the page fills the card's width and shows its top 75%, running into the card's edge. */}
        <div className="overflow-hidden" style={{ aspectRatio: `${paper.width} / ${paper.height * PREVIEW_VISIBLE}` }}>
          <TemplateThumbnail
            document={template.document}
            data={data}
            alt={tl.thumbnailAlt.replace('{name}', template.name)}
            className="rounded-t-sm border border-b-0 border-border/60 shadow-sm transition-transform group-hover:-translate-y-0.5"
          />
        </div>
      </Link>
      <div className="flex items-start gap-2 border-t p-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-medium" title={template.name}>{template.name}</h2>
            {template.isDefault ? (
              <span role="img" aria-label={tl.defaultBadge} title={tl.defaultBadge} className="flex shrink-0 items-center">
                <Star className="h-3.5 w-3.5 fill-yellow-500 text-yellow-500" aria-hidden />
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {ti.paper[template.document.paperSize]}
            {' · '}
            {tl.updated.replace('{date}', formatDate(template.updatedAt))}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="size-7" aria-label={`${tl.actions}: ${template.name}`} disabled={busy}>
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link
                to="/settings/entities/$id/invoice-templates/$templateId"
                params={{ id: template.entityId, templateId: template.id }}
              >
                <Pencil className="mr-2 h-4 w-4" aria-hidden />
                {tl.edit}
              </Link>
            </DropdownMenuItem>
            {canUpdate && !template.isDefault ? (
              <DropdownMenuItem onSelect={() => onSetDefault(template)}>
                <Check className="mr-2 h-4 w-4" aria-hidden />
                {tl.setDefault}
              </DropdownMenuItem>
            ) : null}
            {canCreate ? (
              <DropdownMenuItem onSelect={() => onDuplicate(template)}>
                <Copy className="mr-2 h-4 w-4" aria-hidden />
                {tl.duplicate}
              </DropdownMenuItem>
            ) : null}
            {canDelete ? (
              <>
                {hasActions ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onDelete(template)}>
                  <Trash2 className="mr-2 h-4 w-4" aria-hidden />
                  {tl.delete}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Card>
  );
}

/**
 * `/settings/entities/:id/invoice-templates`: the invoice templates of an
 * entity, a grid of live thumbnails with edit, default, duplicate and delete.
 * Without any template invoices print with the built-in layout.
 */
export default function InvoiceTemplatesPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <WeldbooksEntityScope entityId={id}>
      <InvoiceTemplates entityId={id} />
    </WeldbooksEntityScope>
  );
}

function InvoiceTemplates({ entityId }: Readonly<{ entityId: string }>) {
  const { t } = useI18n();
  const tl = t.accounting.invoiceTemplates.list;
  const canCreate = useCan('accounts:create');
  const canUpdate = useCan('accounts:update');
  const canDelete = useCan('accounts:delete');

  const { data: entity } = useAccountingEntity(entityId);
  const templates = useInvoiceTemplates(entityId);
  const { data } = usePreviewData(entity, 3);

  const updateTemplate = useUpdateInvoiceTemplate();
  const duplicateTemplate = useDuplicateInvoiceTemplate();
  const deleteTemplate = useDeleteInvoiceTemplate();

  const [creating, setCreating] = useState(false);
  const [toDelete, setToDelete] = useState<InvoiceTemplate | null>(null);

  const busy = updateTemplate.isPending || duplicateTemplate.isPending || deleteTemplate.isPending;
  const failed = (err: unknown) => toast.error(tl.failed, { description: err instanceof Error ? err.message : undefined });

  const setDefault = async (template: InvoiceTemplate) => {
    try {
      await updateTemplate.mutateAsync({ id: template.id, data: { isDefault: true } });
      toast.success(tl.defaultSet.replace('{name}', template.name));
    } catch (err) {
      failed(err);
    }
  };

  const duplicate = async (template: InvoiceTemplate) => {
    try {
      await duplicateTemplate.mutateAsync(template.id);
      toast.success(tl.duplicated);
    } catch (err) {
      failed(err);
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    try {
      await deleteTemplate.mutateAsync(toDelete.id);
      toast.success(tl.deleted);
      setToDelete(null);
    } catch (err) {
      failed(err);
    }
  };

  const list = templates.data ?? [];
  const brandingAccent = entity?.branding?.accentColor ?? entity?.branding?.primaryColor ?? null;

  const openCreate = () => setCreating(true);
  const ti = t.accounting.invoiceTemplates;
  const filterConfigs: FilterConfig[] = [
    {
      field: 'paperSize',
      label: ti.designer.paperSize,
      options: [
        { value: 'a4', label: ti.paper.a4 },
        { value: 'letter', label: ti.paper.letter },
      ],
    },
    {
      field: 'default',
      label: tl.defaultBadge,
      options: [
        { value: 'yes', label: tl.filterDefaultYes },
        { value: 'no', label: tl.filterDefaultNo },
      ],
    },
  ];

  return (
    <>
      {templates.isError ? (
        <div className="flex flex-col items-center gap-3 px-6 py-20 text-center">
          <AlertCircle className="h-8 w-8 text-destructive" aria-hidden />
          <p className="text-sm text-muted-foreground">{tl.loadError}</p>
          <Button variant="outline" size="sm" onClick={() => void templates.refetch()}>
            {tl.retry}
          </Button>
        </div>
      ) : (
        // The standard list page (top bar, search, create button, empty state) like every other page;
        // the templates themselves stay cards, laid out as a grid instead of rows.
        <EntityList<InvoiceTemplate>
          items={list}
          isLoading={templates.isLoading}
          filters={filterConfigs}
          applyFilters={applyTemplateFilters}
          searchFields={['name']}
          searchPlaceholder={tl.search}
          createButton={canCreate ? { label: tl.newTemplate, onClick: openCreate } : undefined}
          leftActionButtons={!canCreate && !canUpdate ? <p className="text-xs text-muted-foreground">{tl.readOnly}</p> : undefined}
          itemsClassName="grid grid-cols-[repeat(auto-fill,minmax(0,300px))] gap-4 p-4"
          renderRow={(template) => (
            <TemplateCard
              key={template.id}
              template={template}
              data={data}
              canUpdate={canUpdate}
              canCreate={canCreate}
              canDelete={canDelete}
              busy={busy}
              onSetDefault={(tpl) => void setDefault(tpl)}
              onDuplicate={(tpl) => void duplicate(tpl)}
              onDelete={setToDelete}
            />
          )}
          emptyState={{
            icon: (
              <EmptyStateIllustration>
                <FileText className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
              </EmptyStateIllustration>
            ),
            title: tl.emptyTitle,
            description: tl.emptyDescription,
            action: canCreate ? { label: tl.emptyAction, onClick: openCreate } : undefined,
          }}
          noResultsState={{ title: tl.noResultsTitle, description: tl.noResultsDescription }}
        />
      )}

      {entity ? (
        <NewTemplateDialog
          open={creating}
          onOpenChange={setCreating}
          entityId={entityId}
          defaultPaperSize={invoicePaperSize({ jurisdictionCode: entity.jurisdictionCode, address: entity.address })}
          defaultAccent={brandingAccent}
          previewData={data}
        />
      ) : null}

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
        title={tl.deleteTitle}
        description={(toDelete?.isDefault ? tl.deleteDefaultDescription : tl.deleteDescription).replace('{name}', toDelete?.name ?? '')}
        confirmLabel={tl.deleteConfirm}
        cancelLabel={tl.cancel}
        variant="destructive"
        onConfirm={confirmDelete}
      />
    </>
  );
}
