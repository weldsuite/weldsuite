/**
 * Server keys of one project (`panel_projects:manage`): list, create and
 * revoke. A new key (`wps_…`) is shown once, in its own dialog with a copy
 * button, because only its hash is kept; the list shows just its start.
 */

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Check, Copy, KeyRound, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import type { PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';
import type { PanelCreatedKeyDto, PanelKeyDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useCreateWeldPanelKey, useRevokeWeldPanelKey, useWeldPanelProjectKeys } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { formatDate, formatDateTime } from '../lib/format';

function CreateKeyDialog({ open, onOpenChange, onCreate }: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; onCreate: (name: string) => Promise<void> }>) {
  const { t } = useI18n();
  const tk = t.weldpanel.observe.keys;
  const schema = z.object({ name: z.string().trim().min(1, t.weldpanel.validation.nameRequired).max(100, t.weldpanel.validation.nameTooLong) });
  const form = useForm<{ name: string }>({ resolver: zodResolver(schema), defaultValues: { name: '' } });
  useEffect(() => {
    if (open) form.reset({ name: '' });
  }, [open, form]);
  const submitting = form.formState.isSubmitting;

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tk.createTitle}</DialogTitle>
          <DialogDescription>{tk.createDescription}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            noValidate
            className="space-y-4"
            onSubmit={form.handleSubmit(async (values) => {
              await onCreate(values.name.trim());
            })}
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tk.name}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={tk.namePlaceholder} maxLength={100} autoComplete="off" disabled={submitting} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
                {tk.cancel}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="animate-spin" />}
                {tk.createSubmit}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function ShownOnceDialog({ created, onClose }: Readonly<{ created: PanelCreatedKeyDto | null; onClose: () => void }>) {
  const { t } = useI18n();
  const tk = t.weldpanel.observe.keys;
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
    } catch {
      toast.error(tk.copyFailed);
    }
  }

  return (
    <Dialog
      open={created !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tk.shownOnceTitle}</DialogTitle>
          <DialogDescription>{tk.shownOnceDescription}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <code data-testid="new-key" className="min-w-0 flex-1 select-all break-all rounded-md border bg-muted/40 p-3 font-mono text-[13px]">
            {created?.key}
          </code>
          <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => void copy()}>
            {copied ? <Check className="text-emerald-600" /> : <Copy />}
            {copied ? tk.copied : tk.copy}
          </Button>
        </div>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {tk.done}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function KeysTab({ project }: Readonly<{ project: PanelProjectDto }>) {
  const { t, language, format } = useI18n();
  const tk = t.weldpanel.observe.keys;
  const { data: keys, isLoading, error, refetch } = useWeldPanelProjectKeys(project.id);
  const create = useCreateWeldPanelKey(project.id);
  const revoke = useRevokeWeldPanelKey(project.id);
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<PanelCreatedKeyDto | null>(null);
  const [toRevoke, setToRevoke] = useState<PanelKeyDto | null>(null);

  async function createKey(name: string) {
    try {
      const key = await create.mutateAsync({ name });
      setCreateOpen(false);
      setCreated(key);
    } catch {
      toast.error(tk.createFailed);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-2xl">
          <h2 className="text-base font-semibold">{tk.title}</h2>
          <p className="text-sm text-muted-foreground">{tk.description}</p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus />
          {tk.create}
        </Button>
      </div>

      {error ? (
        <ErrorState message={tk.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />
      ) : isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : !keys || keys.length === 0 ? (
        <EmptyState icon={KeyRound} title={tk.empty} description={tk.emptyHint} />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tk.columns.name}</TableHead>
                <TableHead>{tk.columns.key}</TableHead>
                <TableHead>{tk.columns.created}</TableHead>
                <TableHead>{tk.columns.lastUsed}</TableHead>
                <TableHead>{tk.columns.status}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  <TableCell className="font-mono text-xs">{key.prefix}…</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(key.createdAt, language)}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{key.lastUsedAt ? formatDateTime(key.lastUsedAt, language) : tk.neverUsed}</TableCell>
                  <TableCell>
                    {key.revokedAt ? <SoftBadge tone="neutral">{format(tk.revoked, { date: formatDate(key.revokedAt, language) })}</SoftBadge> : <SoftBadge tone="success">{tk.active}</SoftBadge>}
                  </TableCell>
                  <TableCell className="text-right">
                    {!key.revokedAt && (
                      <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setToRevoke(key)}>
                        {tk.revoke}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateKeyDialog open={createOpen} onOpenChange={setCreateOpen} onCreate={createKey} />
      <ShownOnceDialog created={created} onClose={() => setCreated(null)} />
      <ConfirmDialog
        open={toRevoke !== null}
        onOpenChange={(open) => !open && setToRevoke(null)}
        title={format(tk.revokeTitle, { name: toRevoke?.name ?? '' })}
        description={tk.revokeDescription}
        confirmLabel={tk.revokeConfirm}
        variant="destructive"
        loading={revoke.isPending}
        onConfirm={async () => {
          if (!toRevoke) return;
          try {
            await revoke.mutateAsync(toRevoke.id);
            toast.success(tk.revoked_toast);
            setToRevoke(null);
          } catch {
            toast.error(tk.revokeFailed);
          }
        }}
      />
    </div>
  );
}
