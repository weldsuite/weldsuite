/**
 * The e-mail templates of one entity (Settings → Entities → (entity) →
 * WeldBooks, edition feature `books-invoice-email`): one text per kind
 * (invoice, quote, reminder 1 to 3, credit note) and language (Dutch, English),
 * with the placeholders as chips that insert at the cursor, a preview with
 * sample values and "Reset to default". Without a text of its own a kind is
 * sent with WeldSuite's default.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Label } from '@weldsuite/ui/components/label';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { PlaceholderField } from '@weldsuite/ui/components/placeholder-field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useEmailTemplates, useUpdateEmailTemplates } from '@/hooks/queries/use-weldbooks-sales-queries';
import {
  EMAIL_TEMPLATE_KINDS,
  EMAIL_TEMPLATE_LOCALES,
  type EmailTemplatesSettings,
  type EmailTemplateKind,
  type EmailTemplateLocale,
} from '@/lib/api/domains/weldbooks-sales';
import { useI18n } from '@/lib/i18n/provider';
import { fillTemplate, placeholdersFor, unknownPlaceholders } from '@/lib/weldbooks/email-template-preview';

interface Draft {
  subject: string;
  body: string;
}

const draftKey = (kind: string, locale: string) => `${kind}:${locale}`;

function TemplatesEditor({ settings }: Readonly<{ settings: EmailTemplatesSettings }>) {
  const { t } = useI18n();
  const copy = t.weldbooksSales.templates;
  const canEdit = useCan('accounts:update');
  const save = useUpdateEmailTemplates();
  const [kind, setKind] = useState<EmailTemplateKind>('invoice');
  const [locale, setLocale] = useState<EmailTemplateLocale>('nl');
  // Unsaved text per kind and language: switching between them keeps what was typed.
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const stored = settings.templates[kind]?.[locale];
  const key = draftKey(kind, locale);
  const draft = drafts[key] ?? { subject: stored?.subject ?? '', body: stored?.body ?? '' };
  const dirty = drafts[key] !== undefined && (draft.subject !== (stored?.subject ?? '') || draft.body !== (stored?.body ?? ''));
  const offered = placeholdersFor(kind, settings.placeholders);
  const labels = copy.placeholders as Readonly<Record<string, string>>;
  const samples = copy.samples as Readonly<Record<string, string>>;
  const options = offered.map((placeholder) => ({ key: placeholder, label: labels[placeholder] ?? placeholder }));
  const unknown = unknownPlaceholders(`${draft.subject} ${draft.body}`, settings.placeholders);
  const kindLabels = copy.kinds as Readonly<Record<string, string>>;
  const localeLabels = copy.locales as Readonly<Record<string, string>>;
  const canSave = canEdit && dirty && draft.subject.trim() !== '' && draft.body.trim() !== '' && !save.isPending;

  const setDraft = (patch: Partial<Draft>) => setDrafts((current) => ({ ...current, [key]: { ...draft, ...patch } }));
  const discard = () =>
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });

  const failed = (error: unknown) =>
    toast.error(copy.saveFailed, { description: error instanceof Error ? error.message : undefined });
  const saveText = () =>
    save.mutate(
      { [kind]: { [locale]: { subject: draft.subject.trim(), body: draft.body } } },
      {
        onSuccess: () => {
          toast.success(copy.saved);
          discard();
        },
        onError: failed,
      },
    );
  const reset = () =>
    save.mutate(
      { [kind]: { [locale]: null } },
      {
        onSuccess: () => {
          toast.success(copy.resetDone);
          discard();
        },
        onError: failed,
      },
    );

  return (
    <CardContent className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 space-y-1.5">
          <Label htmlFor="template-kind">{copy.kind}</Label>
          <Select value={kind} onValueChange={(value) => setKind(value as EmailTemplateKind)}>
            <SelectTrigger id="template-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EMAIL_TEMPLATE_KINDS.map((option) => (
                <SelectItem key={option} value={option}>
                  {kindLabels[option] ?? option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">{copy.language}</legend>
          <div className="flex gap-1.5">
            {EMAIL_TEMPLATE_LOCALES.map((option) => (
              <Button
                key={option}
                type="button"
                size="sm"
                variant={locale === option ? 'default' : 'outline'}
                aria-pressed={locale === option}
                onClick={() => setLocale(option)}
              >
                {localeLabels[option] ?? option}
              </Button>
            ))}
          </div>
        </fieldset>
        {stored?.isDefault && !dirty ? <span className="pb-2 text-xs text-muted-foreground">{copy.isDefault}</span> : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="template-subject">{copy.subject}</Label>
        <PlaceholderField
          id="template-subject"
          multiline={false}
          value={draft.subject}
          onChange={(subject) => setDraft({ subject })}
          placeholders={options}
          insertLabel={copy.insert}
          chipsLabel={copy.placeholdersLabel}
          maxLength={300}
          disabled={!canEdit}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="template-body">{copy.body}</Label>
        <PlaceholderField
          id="template-body"
          value={draft.body}
          rows={9}
          onChange={(body) => setDraft({ body })}
          placeholders={options}
          insertLabel={copy.insert}
          chipsLabel={copy.placeholdersLabel}
          maxLength={10_000}
          disabled={!canEdit}
        />
      </div>

      {unknown.length > 0 ? (
        <InfoBanner variant="warning">{copy.unknown.replace('{names}', unknown.map((name) => `{${name}}`).join(', '))}</InfoBanner>
      ) : null}

      <section aria-label={copy.preview} className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-3" data-testid="template-preview">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{copy.preview}</h3>
        <p className="text-sm font-medium">{fillTemplate(draft.subject, samples)}</p>
        <p className="text-sm whitespace-pre-wrap">{fillTemplate(draft.body, samples)}</p>
      </section>

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={saveText} disabled={!canSave}>
            {save.isPending ? copy.saving : copy.save}
          </Button>
          {dirty ? (
            <Button type="button" variant="ghost" onClick={discard}>
              {copy.discard}
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={reset} disabled={save.isPending || (stored?.isDefault === true && !dirty)}>
            {copy.reset}
          </Button>
        </div>
      ) : null}
    </CardContent>
  );
}

function TemplatesBody({ query, copy }: Readonly<{ query: ReturnType<typeof useEmailTemplates>; copy: { loadFailed: string } }>) {
  if (query.isError) {
    return (
      <CardContent>
        <ErrorState message={copy.loadFailed} onRetry={() => void query.refetch()} />
      </CardContent>
    );
  }
  if (query.data) return <TemplatesEditor settings={query.data} />;
  return (
    <CardContent>
      <InlineSpinner />
    </CardContent>
  );
}

export function EmailTemplatesCard() {
  const { t } = useI18n();
  const copy = t.weldbooksSales.templates;
  const query = useEmailTemplates();
  return (
    <Card data-testid="email-templates-card">
      <CardHeader>
        <CardTitle>{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <TemplatesBody query={query} copy={copy} />
    </Card>
  );
}
