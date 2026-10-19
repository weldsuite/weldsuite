/**
 * The page the invoice form lives on: the live PDF preview on the left, the
 * fields on the right, and the save / cancel actions in the bar across the
 * top. Below `lg` the fields come first and the preview follows them.
 */

import type { ReactNode } from 'react';
import { ChevronLeft, Loader2 } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import type { FormSection, SummaryField } from '@/components/entity-overview';
import { Link } from '@/lib/router';

interface InvoiceEditorLayoutProps {
  title: string;
  sections: FormSection[];
  summaryFields: SummaryField[];
  summaryContent?: ReactNode;
  preview: ReactNode;
  previewLabel: string;
  onSubmit: (e: React.FormEvent) => void;
  isPending: boolean;
  submitText: string;
  /** Shown while the submit button's save runs; the default is the generic "Saving…". */
  submitPendingText?: string;
  /**
   * A second, main action next to the submit button (e.g. "Create and send").
   * The submit button then turns into the quieter one: Enter in a field still
   * only saves.
   */
  primaryAction?: { label: string; pendingText: string; pending: boolean; disabled?: boolean; title?: string; onClick: () => void };
  backLink: string;
  backText: string;
}

export function InvoiceEditorLayout({
  title,
  sections,
  summaryFields,
  summaryContent,
  preview,
  previewLabel,
  onSubmit,
  isPending,
  submitText,
  submitPendingText,
  primaryAction,
  backLink,
  backText,
}: Readonly<InvoiceEditorLayoutProps>) {
  const t = useTranslations();

  return (
    <form onSubmit={onSubmit} className="flex h-full min-h-0 flex-col" suppressHydrationWarning>
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <Button asChild type="button" variant="ghost" size="icon-sm" className="size-7 -ml-1">
          <Link href={backLink} aria-label={backText} title={backText}>
            <ChevronLeft className="size-4 text-muted-foreground" />
          </Link>
        </Button>
        <h1 className="min-w-0 truncate text-[15px] font-medium text-foreground">{title}</h1>
        <div className="ml-auto flex items-center gap-2">
          <Button asChild type="button" variant="outline" size="sm" className="shadow-none">
            <Link href={backLink} aria-disabled={isPending}>
              {t('sweep.entities.cancel')}
            </Link>
          </Button>
          <Button
            type="submit"
            size="sm"
            variant={primaryAction ? 'outline' : 'default'}
            disabled={isPending}
            className="shadow-none"
          >
            {isPending && !primaryAction?.pending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {submitPendingText ?? t('sweep.entities.savingEllipsis')}
              </>
            ) : (
              submitText
            )}
          </Button>
          {primaryAction ? (
            <Button
              type="button"
              size="sm"
              disabled={isPending || primaryAction.disabled}
              title={primaryAction.title}
              onClick={primaryAction.onClick}
              className="shadow-none"
            >
              {primaryAction.pending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {primaryAction.pendingText}
                </>
              ) : (
                primaryAction.label
              )}
            </Button>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <section
          aria-label={previewLabel}
          className="order-2 bg-muted/40 px-4 py-6 lg:order-1 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-8 lg:py-8 custom-scrollbar"
        >
          {preview}
        </section>

        <aside className="order-1 flex-shrink-0 border-border lg:order-2 lg:w-[480px] lg:overflow-y-auto lg:border-l xl:w-[540px] custom-scrollbar">
          {sections.map(({ title: sectionTitle, icon: Icon, description, content }) => (
            <div key={sectionTitle} className="border-b border-border px-5 py-5">
              <div className="mb-4">
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  {sectionTitle}
                </h2>
                {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
              </div>
              <div className="space-y-4">{content}</div>
            </div>
          ))}

          <div className="space-y-3 px-5 py-5">
            <dl className="space-y-2 text-sm">
              {summaryFields
                .filter((field) => !(field.hideIfEmpty && !field.value))
                .map((field) => (
                  <div
                    key={field.label}
                    className={`flex justify-between gap-4 ${field.bordered ? 'border-t border-border pt-2' : ''}`}
                  >
                    <dt className="text-muted-foreground">{field.label}</dt>
                    <dd className="text-right font-medium tabular-nums">{field.value || '—'}</dd>
                  </div>
                ))}
            </dl>
            {summaryContent}
          </div>
        </aside>
      </div>
    </form>
  );
}
