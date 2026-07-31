'use client';

import * as React from 'react';
import { Link2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Badge } from '@weldsuite/ui/components/badge';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import {
  useCustomObjectLinks,
  useLinkTargets,
  useCreateCustomObjectLink,
  useDeleteCustomObjectLink,
  type CustomObject,
  type CustomObjectLink,
} from '@/hooks/queries/use-custom-objects-queries';

const CARDINALITIES = ['many_to_one', 'one_to_many', 'many_to_many', 'one_to_one'] as const;
const ON_DELETE = ['set_null', 'cascade', 'restrict'] as const;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
}

/**
 * Relationship editor for one custom object.
 *
 * Relationships supersede the `entity_ref` field type for custom objects — they
 * support many-to-many and index the reverse direction, neither of which a
 * single stored id can do. That's why `entity_ref` isn't offered in the field
 * editor for custom objects.
 */
export function LinksSection({ object }: { object: CustomObject }) {
  const { t: i18n } = useI18n();
  const t = i18n.weldobjects;
  const { data: links } = useCustomObjectLinks(object.id);
  const { data: targets } = useLinkTargets();
  const createLink = useCreateCustomObjectLink();
  const deleteLink = useDeleteCustomObjectLink();

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<CustomObjectLink | null>(null);

  const [targetEntityKey, setTargetEntityKey] = React.useState('');
  const [cardinality, setCardinality] =
    React.useState<(typeof CARDINALITIES)[number]>('many_to_one');
  const [targetLabel, setTargetLabel] = React.useState('');
  const [sourceLabel, setSourceLabel] = React.useState('');
  const [onDelete, setOnDelete] = React.useState<(typeof ON_DELETE)[number]>('set_null');
  const [submitting, setSubmitting] = React.useState(false);

  // Never offer the object itself as a target: a self-link would need distinct
  // source/target semantics the edge table doesn't model.
  const availableTargets = (targets ?? []).filter((tg) => tg.entityType !== object.entityKey);
  const targetLabelFor = (key: string) =>
    availableTargets.find((tg) => tg.entityType === key)?.label ?? key;

  React.useEffect(() => {
    if (!dialogOpen) return;
    setTargetEntityKey('');
    setCardinality('many_to_one');
    setTargetLabel('');
    setSourceLabel('');
    setOnDelete('set_null');
  }, [dialogOpen]);

  // Default the two panel headings from the chosen target, since that's what
  // they almost always should say.
  React.useEffect(() => {
    if (!targetEntityKey) return;
    const label = targetLabelFor(targetEntityKey);
    setTargetLabel((prev) => prev || label);
    setSourceLabel((prev) => prev || object.labelPlural);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetEntityKey]);

  async function handleCreate() {
    if (!targetEntityKey || !targetLabel.trim() || !sourceLabel.trim()) return;
    setSubmitting(true);
    try {
      await createLink.mutateAsync({
        objectId: object.id,
        slug: slugify(targetLabel),
        targetEntityKey,
        cardinality,
        sourceLabel: sourceLabel.trim(),
        targetLabel: targetLabel.trim(),
        onDelete,
      });
      setDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.errors.saveFailed);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t.links.add}
        </Button>
      </div>

      {(links?.length ?? 0) === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <Link2 className="h-8 w-8 text-muted-foreground" />
            <p className="font-medium">{t.links.emptyTitle}</p>
            <p className="max-w-md text-sm text-muted-foreground">{t.links.emptyBody}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {links!.map((link) => (
            <Card key={link.id}>
              <CardContent className="flex items-center gap-3 py-3">
                <Link2 className="h-4 w-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{link.targetLabel}</span>
                    <Badge variant="outline">{t.links.cardinality[link.cardinality]}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {object.labelSingular} → {targetLabelFor(link.targetEntityKey)} ·{' '}
                    {t.links.onDelete[link.onDelete]}
                  </p>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setPendingDelete(link)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t.links.dialogTitle}</DialogTitle>
            <DialogDescription>
              {t.links.dialogDescription.replace('{object}', object.labelSingular)}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>{t.links.target}</Label>
              <Select value={targetEntityKey} onValueChange={setTargetEntityKey}>
                <SelectTrigger>
                  <SelectValue placeholder={t.links.targetPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {availableTargets.map((tg) => (
                    <SelectItem key={tg.entityType} value={tg.entityType}>
                      {tg.label}
                      {tg.kind === 'custom' ? ` · ${t.links.customObject}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>{t.links.cardinalityLabel}</Label>
              <Select
                value={cardinality}
                onValueChange={(v) => setCardinality(v as typeof cardinality)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CARDINALITIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {t.links.cardinalityOption[c].replace(
                        '{object}',
                        object.labelSingular,
                      ).replace('{target}', targetLabelFor(targetEntityKey) || '…')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t.links.targetPanelLabel}</Label>
                <Input value={targetLabel} onChange={(e) => setTargetLabel(e.target.value)} />
                <p className="text-xs text-muted-foreground">{t.links.targetPanelHelp}</p>
              </div>
              <div className="space-y-1.5">
                <Label>{t.links.sourcePanelLabel}</Label>
                <Input value={sourceLabel} onChange={(e) => setSourceLabel(e.target.value)} />
                <p className="text-xs text-muted-foreground">{t.links.sourcePanelHelp}</p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>{t.links.onDeleteLabel}</Label>
              <Select value={onDelete} onValueChange={(v) => setOnDelete(v as typeof onDelete)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ON_DELETE.map((rule) => (
                    <SelectItem key={rule} value={rule}>
                      {t.links.onDeleteOption[rule].replace(
                        '{objects}',
                        object.labelPlural,
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={submitting}>
              {t.form.cancel}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={submitting || !targetEntityKey || !targetLabel.trim()}
            >
              {t.links.create}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={t.links.deleteTitle}
        description={t.links.deleteBody.replace('{link}', pendingDelete?.targetLabel ?? '')}
        confirmLabel={t.detail.delete}
        variant="destructive"
        onConfirm={async () => {
          if (!pendingDelete) return;
          try {
            await deleteLink.mutateAsync({ objectId: object.id, linkId: pendingDelete.id });
            setPendingDelete(null);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : t.errors.deleteFailed);
          }
        }}
      />
    </div>
  );
}
