import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Pencil, Plus, Signature as SignatureIcon, Star, Trash2 } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import type { MailSignatureRow } from '@weldsuite/app-api-client/domains/mail-signatures';
import { EmptyStateIllustration } from '@/components/entity-list';
import { PageLoader } from '@/components/page-loader';
import {
  useDeleteMailSignature,
  useMailAccounts,
  useMailSignatures,
  useUpdateMailSignature,
} from '@/hooks/queries/use-mail-queries';
import { useI18n } from '@/lib/i18n/provider';
import { getTranslations } from '@/lib/i18n';
import { sanitizeSignatureHtml } from '@/app/weldmail/lib/signature';
import { SignatureEditorDialog, type SignatureAccountOption } from './signature-editor-dialog';

type SignatureLabels = ReturnType<typeof getTranslations<'settings'>>['weldmail']['signatures'];

/**
 * WeldMail settings → Signatures. Everyone manages their own signatures here;
 * mail admins also manage the ones shared with the whole workspace.
 */
export default function MailSignaturesSettingsPage() {
  const ts = getTranslations('settings').weldmail.signatures;
  const { can } = usePermissions();
  const canManageShared = can('weldmail:accounts:update');
  const { data, isLoading, isError } = useMailSignatures();
  const { data: accountsData } = useMailAccounts();
  const updateSignature = useUpdateMailSignature();
  const deleteSignature = useDeleteMailSignature();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<MailSignatureRow | null>(null);
  const [deleting, setDeleting] = useState<MailSignatureRow | null>(null);

  const accounts: SignatureAccountOption[] = useMemo(
    () => (accountsData?.data ?? []).map((account) => ({ id: account.id, email: account.email })),
    [accountsData?.data],
  );
  const signatures = data?.data ?? [];
  const byName = (a: MailSignatureRow, b: MailSignatureRow) => a.name.localeCompare(b.name);
  const mine = signatures.filter((s) => s.type === 'personal').sort(byName);
  const shared = signatures.filter((s) => s.type !== 'personal').sort(byName);

  const openEditor = (signature: MailSignatureRow | null) => {
    setEditing(signature);
    setEditorOpen(true);
  };

  const makeDefault = async (signature: MailSignatureRow) => {
    try {
      await updateSignature.mutateAsync({ id: signature.id, isDefault: true });
      toast.success(ts.messages.updated);
    } catch {
      toast.error(ts.messages.saveFailed);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteSignature.mutateAsync(deleting.id);
      toast.success(ts.messages.deleted);
      setDeleting(null);
    } catch {
      toast.error(ts.messages.deleteFailed);
    }
  };

  if (isLoading) return <PageLoader fullScreen={false} />;

  const accountLabel = (signature: MailSignatureRow) => {
    const ids = signature.accountIds ?? [];
    if (ids.length === 0) return ts.allAccounts;
    if (ids.length === 1) return accounts.find((a) => a.id === ids[0])?.email ?? ts.accountCount.replace('{count}', '1');
    return ts.accountCount.replace('{count}', String(ids.length));
  };

  const renderList = (rows: MailSignatureRow[], editable: boolean) => (
    <ul className="divide-y rounded-lg border">
      {rows.map((signature) => (
        <SignatureRow
          key={signature.id}
          signature={signature}
          accountLabel={accountLabel(signature)}
          editable={editable}
          labels={ts}
          onEdit={() => openEditor(signature)}
          onMakeDefault={() => void makeDefault(signature)}
          onDelete={() => setDeleting(signature)}
        />
      ))}
    </ul>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="text-sm text-muted-foreground max-w-xl">{ts.description}</p>
        <Button onClick={() => openEditor(null)} className="shrink-0" data-testid="signature-new-btn">
          <Plus className="h-4 w-4" />
          {ts.newSignature}
        </Button>
      </div>

      {isError && <p className="text-sm text-destructive">{ts.messages.loadFailed}</p>}

      {!isError && signatures.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16">
          <EmptyStateIllustration>
            <SignatureIcon className="h-16 w-16 text-muted-foreground/50" />
          </EmptyStateIllustration>
          <h3 className="text-lg font-medium mb-1">{ts.noSignatures}</h3>
          <p className="text-sm text-muted-foreground max-w-md text-center">{ts.noSignaturesDescription}</p>
        </div>
      )}

      {mine.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{ts.mine}</h3>
          {renderList(mine, true)}
        </section>
      )}

      {shared.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{ts.shared}</h3>
          {!canManageShared && <p className="text-xs text-muted-foreground">{ts.sharedReadOnly}</p>}
          {renderList(shared, canManageShared)}
        </section>
      )}

      <SignatureEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        signature={editing}
        accounts={accounts}
        canManageShared={canManageShared}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={ts.deleteTitle}
        description={ts.deleteDescription.replace('{name}', deleting?.name ?? '')}
        variant="destructive"
        loading={deleteSignature.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

function SignatureRow({
  signature,
  accountLabel,
  editable,
  labels,
  onEdit,
  onMakeDefault,
  onDelete,
}: Readonly<{
  signature: MailSignatureRow;
  accountLabel: string;
  editable: boolean;
  labels: SignatureLabels;
  onEdit: () => void;
  onMakeDefault: () => void;
  onDelete: () => void;
}>) {
  const { t } = useI18n();
  const preview = useMemo(() => sanitizeSignatureHtml(signature.content), [signature.content]);

  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between" data-testid="signature-row">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium truncate">{signature.name}</span>
          {signature.isDefault && <Badge variant="secondary">{labels.default}</Badge>}
          <span className="text-xs text-muted-foreground">{accountLabel}</span>
        </div>
        {/* Sanitized above: the same allowlist compose applies before inserting it. */}
        <div
          className="max-h-32 overflow-hidden rounded-md bg-muted/40 px-3 py-2 text-sm [&_img]:max-w-full [&_img]:h-auto [&_a]:text-primary [&_a]:underline"
          dangerouslySetInnerHTML={{ __html: preview }}
        />
      </div>
      {editable && (
        <div className="flex items-center gap-1 sm:pl-4">
          {!signature.isDefault && (
            <Button variant="ghost" size="sm" onClick={onMakeDefault} title={labels.makeDefault}>
              <Star className="h-4 w-4" />
              <span className="sr-only sm:not-sr-only">{labels.makeDefault}</span>
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={onEdit} title={t.common.actions.edit} aria-label={t.common.actions.edit}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={onDelete} title={t.common.actions.delete} aria-label={t.common.actions.delete}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      )}
    </li>
  );
}
