/**
 * The inbox address of one entity (Settings → Entities → (entity) → WeldBooks,
 * edition feature `books-receipts`): invoices and receipts e-mailed to it land
 * in the Inbox of that entity, and scanning starts by itself once it is set.
 */

import { useState, type FormEvent } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { Label } from '@weldsuite/ui/components/label';
import { useCan } from '@weldsuite/permissions/react';
import { useEntityInbox, useSetEntityInbox } from '@/hooks/queries/use-weldbooks-receipts-queries';
import { useI18n } from '@/lib/i18n/provider';

/** The status of a refused request, or null for anything else. */
function statusOf(error: unknown): number | null {
  const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : null;
  return typeof status === 'number' ? status : null;
}

export function EntityInboxCard({ entityId }: Readonly<{ entityId: string }>) {
  const { t } = useI18n();
  const ts = t.weldbooksReceipts.settings;
  const canEdit = useCan('accounts:update');
  const inbox = useEntityInbox(entityId);
  const save = useSetEntityInbox();
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const email = draft.trim();
    if (!email || save.isPending) return;
    setSaved(false);
    save.mutate(
      { entityId, email },
      {
        onSuccess: () => {
          setDraft('');
          setSaved(true);
        },
      },
    );
  };

  let problem: string | null = null;
  if (save.isError) {
    const status = statusOf(save.error);
    problem = status === 409 ? ts.taken : status === 400 ? ts.invalid : ts.failed;
  }

  return (
    <Card data-testid="entity-inbox-card">
      <CardHeader>
        <CardTitle>{ts.title}</CardTitle>
        <CardDescription>{ts.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {inbox.isError && !inbox.data ? (
          <ErrorState message={ts.loadFailed} onRetry={() => void inbox.refetch()} />
        ) : !inbox.data ? (
          <InlineSpinner />
        ) : (
          <div className="text-sm">
            <span className="text-muted-foreground">{ts.current}: </span>
            {inbox.data.email ? (
              <span className="break-all font-medium" data-testid="entity-inbox-email">
                {inbox.data.email}
              </span>
            ) : (
              <span>{ts.none}</span>
            )}
            {inbox.data.workspaceAddress ? <p className="mt-1 text-xs text-muted-foreground">{ts.workspaceAddress}</p> : null}
          </div>
        )}

        {canEdit ? (
          <form onSubmit={submit} className="space-y-2">
            <Label htmlFor={`${entityId}-inbox-email`}>{ts.label}</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id={`${entityId}-inbox-email`}
                type="email"
                inputMode="email"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder={ts.placeholder}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                aria-invalid={problem ? true : undefined}
                aria-describedby={problem ? `${entityId}-inbox-problem` : undefined}
                className="sm:max-w-sm"
              />
              <Button type="submit" variant="outline" disabled={!draft.trim() || save.isPending}>
                {save.isPending ? ts.saving : ts.save}
              </Button>
            </div>
            {problem ? (
              <p id={`${entityId}-inbox-problem`} className="text-sm text-destructive" role="alert">
                {problem}
              </p>
            ) : null}
            {saved ? (
              <p className="text-sm text-green-600 dark:text-green-400" role="status">
                {ts.saved}
              </p>
            ) : null}
          </form>
        ) : null}

        <p className="text-xs text-muted-foreground">{ts.scanNote}</p>
      </CardContent>
    </Card>
  );
}
