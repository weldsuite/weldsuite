/**
 * The suppression list: emails and domains WeldReach never contacts.
 * Unsubscribes, bounces and negative replies land here by themselves; people
 * with `reach_settings:update` can add addresses and domains by hand (one per
 * line) and take entries off again.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, ShieldOff, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { ReachSuppression } from '@weldsuite/app-api-client/schemas/reach';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useAddReachSuppressions,
  useDeleteReachSuppression,
  useReachSuppressions,
} from '@/hooks/queries/use-reach-queries';
import { reachErrorMessage } from '@/lib/reach/errors';
import { useReachFormat } from '@/lib/reach/format';
import { parseSuppressionInput } from '@/lib/reach/suppressions';
import { EmptyPanel, ErrorPanel, SectionCard } from '../components/page-kit';

export function SuppressionsSection() {
  const t = useTranslations();
  const format = useReachFormat();
  const { can } = usePermissions();
  const canUpdate = can('reach_settings:update');

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const suppressions = useReachSuppressions(debounced);
  const remove = useDeleteReachSuppression();
  const [addOpen, setAddOpen] = useState(false);
  const [toRemove, setToRemove] = useState<ReachSuppression | null>(null);

  const rows = useMemo(() => suppressions.data?.pages.flatMap((page) => page.data) ?? [], [suppressions.data]);

  const handleRemove = async () => {
    if (!toRemove) return;
    try {
      await remove.mutateAsync(toRemove.id);
      toast.success(t('reach.settings.suppressions.removed'));
    } catch (error) {
      toast.error(reachErrorMessage(error, t));
    }
    setToRemove(null);
  };

  return (
    <SectionCard
      title={t('reach.settings.suppressions.title')}
      description={t('reach.settings.suppressions.description')}
      action={
        canUpdate ? (
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t('reach.settings.suppressions.add')}
          </Button>
        ) : undefined
      }
      contentClassName="space-y-4"
    >
      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={t('reach.settings.suppressions.search')}
        aria-label={t('reach.settings.suppressions.search')}
        className="sm:max-w-sm"
      />

      {suppressions.isPending && (
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {t('reach.common.loading')}
        </div>
      )}
      {suppressions.isError && <ErrorPanel onRetry={() => void suppressions.refetch()} />}
      {suppressions.data && rows.length === 0 && (
        <EmptyPanel
          icon={ShieldOff}
          title={debounced ? t('reach.settings.suppressions.emptySearch') : t('reach.settings.suppressions.empty')}
        />
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('reach.settings.suppressions.columns.value')}</TableHead>
                <TableHead>{t('reach.settings.suppressions.columns.type')}</TableHead>
                <TableHead>{t('reach.settings.suppressions.columns.reason')}</TableHead>
                <TableHead>{t('reach.settings.suppressions.columns.added')}</TableHead>
                {canUpdate && (
                  <TableHead className="w-12">
                    <span className="sr-only">{t('reach.settings.suppressions.columns.actions')}</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.value}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{t(`reach.settings.suppressions.types.${row.type}`)}</Badge>
                  </TableCell>
                  <TableCell>{t(`reach.settings.suppressions.reasons.${row.reason}`)}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{format.date(row.createdAt)}</TableCell>
                  {canUpdate && (
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        aria-label={t('reach.settings.suppressions.remove')}
                        title={t('reach.settings.suppressions.remove')}
                        onClick={() => setToRemove(row)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {suppressions.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            disabled={suppressions.isFetchingNextPage}
            onClick={() => void suppressions.fetchNextPage()}
          >
            {suppressions.isFetchingNextPage && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('reach.settings.suppressions.loadMore')}
          </Button>
        </div>
      )}

      <AddSuppressionsDialog open={addOpen} onOpenChange={setAddOpen} />

      <ConfirmDialog
        open={toRemove !== null}
        onOpenChange={(open) => !open && setToRemove(null)}
        title={t('reach.settings.suppressions.removeTitle', { value: toRemove?.value ?? '' })}
        description={t('reach.settings.suppressions.removeDescription')}
        confirmLabel={t('reach.settings.suppressions.remove')}
        cancelLabel={t('common.actions.cancel')}
        loading={remove.isPending}
        onConfirm={handleRemove}
      />
    </SectionCard>
  );
}

function AddSuppressionsDialog({ open, onOpenChange }: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>) {
  const t = useTranslations();
  const add = useAddReachSuppressions();
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      setText('');
      setInvalid([]);
    }
  }, [open]);

  const submit = async () => {
    const parsed = parseSuppressionInput(text);
    setInvalid(parsed.invalid);
    if (parsed.invalid.length > 0 || parsed.values.length === 0) return;
    try {
      const res = await add.mutateAsync(parsed.values);
      toast.success(t('reach.settings.suppressions.added', { count: res.data.added }));
      onOpenChange(false);
    } catch (error) {
      toast.error(reachErrorMessage(error, t));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (add.isPending ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('reach.settings.suppressions.addTitle')}</DialogTitle>
          <DialogDescription>{t('reach.settings.suppressions.addDescription')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Textarea
            rows={7}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t('reach.settings.suppressions.addPlaceholder')}
            aria-label={t('reach.settings.suppressions.addTitle')}
            aria-invalid={invalid.length > 0}
            className="font-mono text-sm"
          />
          {invalid.length > 0 && (
            <p className="text-sm text-destructive">
              {t('reach.settings.suppressions.invalidValues', { values: invalid.slice(0, 5).join(', ') })}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={add.isPending} onClick={() => onOpenChange(false)}>
            {t('common.actions.cancel')}
          </Button>
          <Button type="button" disabled={add.isPending || text.trim() === ''} onClick={() => void submit()}>
            {add.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('reach.settings.suppressions.addSubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
