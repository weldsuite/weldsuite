'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { toast } from 'sonner';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useCreateCustomObject } from '@/hooks/queries/use-custom-objects-queries';

/** Max slug length — mirrors CUSTOM_OBJECT_SLUG_MAX_LENGTH on the server. */
const SLUG_MAX_LENGTH = 24;

/** Derive a URL/API slug from the plural label. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'o$1')
    .slice(0, SLUG_MAX_LENGTH);
}

/** Naive singularisation — a starting point the user can correct. */
function singularize(value: string): string {
  if (/ies$/i.test(value)) return value.replace(/ies$/i, 'y');
  if (/(s|sh|ch|x|z)es$/i.test(value)) return value.replace(/es$/i, '');
  if (/s$/i.test(value) && !/ss$/i.test(value)) return value.replace(/s$/i, '');
  return value;
}

export function CreateObjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { t: i18n } = useI18n();
  const t = i18n.weldobjects;
  const createObject = useCreateCustomObject();

  const [labelPlural, setLabelPlural] = React.useState('');
  const [labelSingular, setLabelSingular] = React.useState('');
  const [slug, setSlug] = React.useState('');
  const [slugTouched, setSlugTouched] = React.useState(false);
  const [singularTouched, setSingularTouched] = React.useState(false);
  const [description, setDescription] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setLabelPlural('');
    setLabelSingular('');
    setSlug('');
    setSlugTouched(false);
    setSingularTouched(false);
    setDescription('');
  }, [open]);

  // Derive slug and singular from the plural until the user overrides either.
  function handlePluralChange(value: string) {
    setLabelPlural(value);
    if (!slugTouched) setSlug(slugify(value));
    if (!singularTouched) setLabelSingular(singularize(value));
  }

  const slugValid = /^[a-z][a-z0-9_]*$/.test(slug) && slug.length <= SLUG_MAX_LENGTH;
  const canSubmit = labelPlural.trim() && labelSingular.trim() && slugValid && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const created = await createObject.mutateAsync({
        slug,
        labelSingular: labelSingular.trim(),
        labelPlural: labelPlural.trim(),
        description: description.trim() || undefined,
        // New objects start as drafts: an object with no fields yet would
        // otherwise appear in the sidebar as an empty, broken-looking module.
        status: 'draft',
      });
      onOpenChange(false);
      router.push(`/settings/custom-objects/${created.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.errors.createObjectFailed);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.create.title}</DialogTitle>
          <DialogDescription>{t.create.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>{t.create.pluralLabel}</Label>
            <Input
              value={labelPlural}
              onChange={(e) => handlePluralChange(e.target.value)}
              placeholder={t.create.pluralPlaceholder}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t.create.singularLabel}</Label>
            <Input
              value={labelSingular}
              onChange={(e) => {
                setSingularTouched(true);
                setLabelSingular(e.target.value);
              }}
              placeholder={t.create.singularPlaceholder}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t.create.slugLabel}</Label>
            <Input
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value.toLowerCase());
              }}
              maxLength={SLUG_MAX_LENGTH}
              className={!slugValid && slug ? 'border-destructive' : undefined}
            />
            {/* The permanence warning is the important part of this dialog. A
                slug rename would orphan stored values, saved grid layouts,
                search rows and every granted permission, so the server refuses
                it outright — the user needs to know that before they commit. */}
            <p className="text-xs text-muted-foreground">
              {t.create.slugHelp.replace('{slug}', slug || 'machine')}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>{t.create.descriptionLabel}</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t.form.cancel}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? t.create.creating : t.create.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
