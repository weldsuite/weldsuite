/**
 * The workspace's risk categories: show or hide each built-in, add, rename and
 * remove custom ones. Opened from the risk register by members with
 * `portfolio:manage`; the list applies to every project.
 */

import { useId, useMemo, useState, type FormEvent } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Switch } from '@weldsuite/ui/components/switch';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { InlineError } from '@weldsuite/ui/components/error-banner';
import { MAX_CUSTOM_RISK_CATEGORIES, RISK_CATEGORIES } from '@weldsuite/app-api-client/schemas/project-control';
import { useI18n } from '@/lib/i18n/provider';
import { useRiskCategories, useUpdateRiskCategories } from '@/hooks/queries/use-project-control-queries';
import {
  canAddCategory,
  draftBody,
  draftFromCategories,
  draftRowErrors,
  type CategoryDraft,
  type CategoryRowError,
} from '../_lib/categories';

interface RiskCategoriesDialogProps {
  open: boolean;
  onClose: () => void;
}

export function RiskCategoriesDialog({ open, onClose }: Readonly<RiskCategoriesDialogProps>) {
  const { t } = useI18n();
  const copy = t.projects.raid.categoryManager;
  const query = useRiskCategories(open);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="flex max-h-[92vh] flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-6 pt-6 pb-4 text-left">
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        {/* The editor reads the list once when it mounts; a refetch while it is open does not reset the draft. */}
        {query.data ? (
          <CategoryEditor initial={draftFromCategories(query.data)} onClose={onClose} />
        ) : query.isError ? (
          <div className="px-6 py-5">
            <InlineError>{copy.loadFailed}</InlineError>
          </div>
        ) : (
          <PageLoader fullScreen={false} className="py-10" />
        )}
      </DialogContent>
    </Dialog>
  );
}

let localIds = 0;
const newUid = () => `new_${++localIds}`;

function CategoryEditor({ initial, onClose }: Readonly<{ initial: CategoryDraft; onClose: () => void }>) {
  const { t, format } = useI18n();
  const raid = t.projects.raid;
  const copy = raid.categoryManager;
  const save = useUpdateRiskCategories();
  const [draft, setDraft] = useState(initial);
  const [newName, setNewName] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const addId = useId();

  const builtInLabels = useMemo(() => RISK_CATEGORIES.map((key) => raid.categories[key]), [raid.categories]);
  const rowErrors = useMemo(() => draftRowErrors(draft.custom, builtInLabels), [draft.custom, builtInLabels]);
  const newNameError: CategoryRowError | null = useMemo(() => {
    if (!newName.trim()) return null;
    const probe = [...draft.custom, { uid: '__new', name: newName }];
    return draftRowErrors(probe, builtInLabels).get('__new') ?? null;
  }, [newName, draft.custom, builtInLabels]);

  const errorText = (code: CategoryRowError) => copy.errors[code];

  const toggleBuiltIn = (key: (typeof RISK_CATEGORIES)[number], shown: boolean) =>
    setDraft((current) => ({
      ...current,
      hidden: shown ? current.hidden.filter((hidden) => hidden !== key) : [...current.hidden, key],
    }));

  const rename = (uid: string, name: string) =>
    setDraft((current) => ({ ...current, custom: current.custom.map((row) => (row.uid === uid ? { ...row, name } : row)) }));

  const remove = (uid: string) =>
    setDraft((current) => ({ ...current, custom: current.custom.filter((row) => row.uid !== uid) }));

  const add = () => {
    const name = newName.trim();
    if (!name || newNameError || !canAddCategory(draft)) return;
    setDraft((current) => ({ ...current, custom: [...current.custom, { uid: newUid(), name }] }));
    setNewName('');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (rowErrors.size > 0) return;
    try {
      await save.mutateAsync(draftBody(draft));
      toast.success(copy.saved);
      onClose();
    } catch {
      toast.error(copy.saveFailed);
    }
  };

  return (
    <form noValidate onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
        <section className="space-y-2">
          <div>
            <h3 className="text-sm font-medium">{copy.builtInHeading}</h3>
            <p className="text-xs text-muted-foreground">{copy.builtInHint}</p>
          </div>
          <ul className="divide-y rounded-md border">
            {RISK_CATEGORIES.map((key) => {
              const label = raid.categories[key];
              const shown = !draft.hidden.includes(key);
              return (
                <li key={key} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className={shown ? 'text-sm' : 'text-sm text-muted-foreground line-through'}>{label}</span>
                  <Switch
                    checked={shown}
                    onCheckedChange={(checked) => toggleBuiltIn(key, checked)}
                    aria-label={format(copy.show, { name: label })}
                  />
                </li>
              );
            })}
          </ul>
        </section>

        <section className="space-y-2">
          <div>
            <h3 className="text-sm font-medium">{copy.customHeading}</h3>
            <p className="text-xs text-muted-foreground">{copy.removeHint}</p>
          </div>
          {draft.custom.length === 0 ? (
            <p className="text-sm text-muted-foreground">{copy.customEmpty}</p>
          ) : (
            <ul className="space-y-2">
              {draft.custom.map((row) => {
                const rowError = submitted || row.name.trim() !== '' ? rowErrors.get(row.uid) : undefined;
                return (
                  <li key={row.uid}>
                    <div className="flex items-center gap-2">
                      <Input
                        value={row.name}
                        maxLength={100}
                        onChange={(event) => rename(row.uid, event.target.value)}
                        aria-label={copy.nameLabel}
                        aria-invalid={rowError ? true : undefined}
                        className="h-8 text-[13px]"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0"
                        onClick={() => remove(row.uid)}
                        aria-label={format(copy.remove, { name: row.name || copy.nameLabel })}
                      >
                        <Trash2 aria-hidden className="size-4" />
                      </Button>
                    </div>
                    {rowError ? <p className="mt-1 text-xs text-destructive">{errorText(rowError)}</p> : null}
                  </li>
                );
              })}
            </ul>
          )}

          {canAddCategory(draft) ? (
            <div>
              <div className="flex items-center gap-2">
                <Input
                  id={addId}
                  value={newName}
                  maxLength={100}
                  onChange={(event) => setNewName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      add();
                    }
                  }}
                  placeholder={copy.addPlaceholder}
                  aria-label={copy.addPlaceholder}
                  aria-invalid={newNameError ? true : undefined}
                  className="h-8 text-[13px]"
                />
                <Button type="button" variant="outline" size="sm" onClick={add} disabled={!newName.trim() || newNameError !== null}>
                  <Plus aria-hidden />
                  {copy.add}
                </Button>
              </div>
              {newNameError ? <p className="mt-1 text-xs text-destructive">{errorText(newNameError)}</p> : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{format(copy.errors.tooMany, { max: MAX_CUSTOM_RISK_CATEGORIES })}</p>
          )}
        </section>
      </div>

      <div className="flex justify-end gap-2 border-t px-6 py-3.5">
        <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>
          {t.common.actions.cancel}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {save.isPending ? raid.form.saving : copy.save}
        </Button>
      </div>
    </form>
  );
}
