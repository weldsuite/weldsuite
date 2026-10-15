import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { AlertCircle, ArrowLeft, Check, Copy, FileText, MoreHorizontal, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import type { InvoiceTemplate } from '@weldsuite/books-domain/invoice-template/schema';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useAccountingEntity } from '@/hooks/queries/use-accounting-queries';
import {
  useDeleteInvoiceTemplate,
  useDuplicateInvoiceTemplate,
  useInvoiceTemplates,
  useUpdateInvoiceTemplate,
} from '@/hooks/queries/use-invoice-template-queries';
import { useCurrentAccountingEntityRow } from '@/hooks/use-current-entity-currency';
import { useI18n } from '@/lib/i18n/provider';
import { invoicePaperSize } from '@/lib/weldbooks/invoice-pdf';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { NewTemplateDialog } from './new-template-dialog';
import { TemplateThumbnail } from './template-thumbnail';
import { usePreviewData } from './use-template-preview';

type SampleData = ReturnType<typeof usePreviewData>['data'];

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

  return (
    <Card className="group gap-0 overflow-hidden p-0 transition-shadow hover:shadow-md">
      <Link
        to="/weldbooks/settings/invoice-templates/$id"
        params={{ id: template.id }}
        className="block bg-muted/40 p-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-label={`${tl.edit}: ${template.name}`}
      >
        <TemplateThumbnail
          document={template.document}
          data={data}
          alt={tl.thumbnailAlt.replace('{name}', template.name)}
          className="mx-auto max-w-[15rem] rounded-sm border border-border/60 shadow-sm transition-transform group-hover:-translate-y-0.5"
        />
      </Link>
      <div className="flex items-start gap-2 border-t p-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-medium" title={template.name}>{template.name}</h2>
            {template.isDefault ? (
              <Badge variant="secondary" className="shrink-0 gap-1">
                <Star className="h-3 w-3" aria-hidden />
                {tl.defaultBadge}
              </Badge>
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
            <Button variant="ghost" size="icon-sm" aria-label={`${tl.actions}: ${template.name}`} disabled={busy}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link to="/weldbooks/settings/invoice-templates/$id" params={{ id: template.id }}>
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

function GridSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <Card key={i} className="gap-0 overflow-hidden p-0">
          <div className="bg-muted/40 p-4">
            <Skeleton className="mx-auto aspect-[210/297] max-w-[15rem]" />
          </div>
          <div className="space-y-2 border-t p-3">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </Card>
      ))}
    </div>
  );
}

/**
 * Invoice templates of the current company (settings): a grid of live
 * thumbnails with edit, default, duplicate and delete. Without any template
 * invoices print with the built-in layout.
 */
export default function InvoiceTemplatesPage() {
  const { t } = useI18n();
  const tl = t.accounting.invoiceTemplates.list;
  const canCreate = useCan('accounts:create');
  const canUpdate = useCan('accounts:update');
  const canDelete = useCan('accounts:delete');

  const { entity: row } = useCurrentAccountingEntityRow();
  const { data: entity } = useAccountingEntity(row?.id);
  const templates = useInvoiceTemplates(row?.id);
  const { data } = usePreviewData(entity ?? row, 3);

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

  let body: React.ReactNode;
  if (templates.isLoading || !row) {
    body = <GridSkeleton />;
  } else if (templates.isError) {
    body = (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-12 text-center">
        <AlertCircle className="h-8 w-8 text-destructive" aria-hidden />
        <p className="text-sm text-muted-foreground">{tl.loadError}</p>
        <Button variant="outline" size="sm" onClick={() => void templates.refetch()}>
          {tl.retry}
        </Button>
      </div>
    );
  } else if (list.length === 0) {
    body = (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <FileText className="h-6 w-6 text-muted-foreground" aria-hidden />
        </div>
        <h2 className="text-base font-medium">{tl.emptyTitle}</h2>
        <p className="max-w-md text-sm text-muted-foreground">{tl.emptyDescription}</p>
        {canCreate ? (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            {tl.emptyAction}
          </Button>
        ) : null}
      </div>
    );
  } else {
    body = (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {list.map((template) => (
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
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6 overflow-auto p-4 sm:p-6">
      <div className="space-y-3">
        <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" asChild>
          <Link to="/weldbooks/settings">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            {tl.back}
          </Link>
        </Button>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold">{tl.title}</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">{tl.description}</p>
          </div>
          {canCreate && list.length > 0 ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              {tl.newTemplate}
            </Button>
          ) : null}
        </div>
        {!canCreate && !canUpdate ? <p className="text-sm text-muted-foreground">{tl.readOnly}</p> : null}
      </div>

      {body}

      {row ? (
        <NewTemplateDialog
          open={creating}
          onOpenChange={setCreating}
          entityId={row.id}
          defaultPaperSize={invoicePaperSize({ jurisdictionCode: entity?.jurisdictionCode ?? row.jurisdictionCode, address: entity?.address ?? row.address })}
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
    </div>
  );
}
