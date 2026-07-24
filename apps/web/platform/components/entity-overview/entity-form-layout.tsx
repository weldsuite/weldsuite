
import { ReactNode } from "react";
import { useRouter, Link } from '@/lib/router';
import { Button } from "@weldsuite/ui/components/button";
import { LucideIcon, Loader2, ChevronLeft } from "lucide-react";
import { useTranslations } from '@weldsuite/i18n/client';

export interface FormSection {
  /** Section title */
  title: string;
  /** Section icon */
  icon: LucideIcon;
  /** Section content (form fields) */
  content: ReactNode;
  /** Optional description */
  description?: string;
}

export interface SummaryField {
  /** Field label */
  label: string;
  /** Field value (ReactNode for flexibility) */
  value: ReactNode;
  /** Show border on top */
  bordered?: boolean;
  /** Hide field if value is empty */
  hideIfEmpty?: boolean;
}

export interface EntityFormLayoutProps {
  /** Page title */
  title: string;
  /** Optional subtitle/description */
  subtitle?: string;
  /** Form sections to display in left column */
  sections: FormSection[];
  /** Summary title */
  summaryTitle: string;
  /** Summary icon */
  summaryIcon: LucideIcon;
  /** Summary fields to display in right column */
  summaryFields: SummaryField[];
  /** Additional summary content (below fields, above actions) */
  summaryContent?: ReactNode;
  /** Form submit handler */
  onSubmit: (e: React.FormEvent) => void;
  /** Is form submitting */
  isPending?: boolean;
  /** Submit button text */
  submitText?: string;
  /** Cancel button link */
  cancelLink?: string;
  /** Cancel button text */
  cancelText?: string;
  /** Submit button variant */
  submitVariant?: "default" | "destructive";
  /** Show back button */
  showBackButton?: boolean;
  /** Back button link (if not provided, uses router.back()) */
  backLink?: string;
  /** Back button text */
  backButtonText?: string;
}

export function EntityFormLayout({
  title,
  sections,
  summaryTitle,
  summaryFields,
  summaryContent,
  onSubmit,
  isPending = false,
  submitText,
  cancelLink,
  cancelText,
  submitVariant = "default",
  showBackButton = false,
  backLink,
  backButtonText,
}: EntityFormLayoutProps) {
  const t = useTranslations();
  const router = useRouter();
  const resolvedSubmitText = submitText ?? t('sweep.entities.save');
  const resolvedCancelText = cancelText ?? t('sweep.entities.cancel');
  const resolvedBackButtonText = backButtonText ?? t('sweep.entities.back');

  const backButton = showBackButton ? (
    backLink ? (
      <Link href={backLink}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 -ml-3"
        >
          <ChevronLeft className="h-4 w-4 mr-0.5" />
          <span className="hidden sm:inline">{resolvedBackButtonText}</span>
          <span className="sm:hidden">{t('sweep.entities.back')}</span>
        </Button>
      </Link>
    ) : (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 -ml-3"
        onClick={() => router.back()}
      >
        <ChevronLeft className="h-4 w-4 mr-0.5" />
        <span className="hidden sm:inline">{resolvedBackButtonText}</span>
        <span className="sm:hidden">{t('sweep.entities.back')}</span>
      </Button>
    )
  ) : null;

  const formContent = (
    <form onSubmit={onSubmit} className="space-y-8 min-h-full" suppressHydrationWarning>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column - Form Sections */}
          <div className="lg:col-span-2 space-y-4">
            <div className="mb-2">
              {backButton}
            </div>
            <h2 className="text-2xl font-semibold">{title}</h2>
            {sections.map((section, index) => (
              <div
                key={index}
                className="bg-background px-6 pt-5 pb-6 rounded-lg border border-border"
              >
                <div className="mb-4">
                  <h3 className="text-base font-semibold">
                    {section.title}
                  </h3>
                  {section.description && (
                    <p className="text-sm text-muted-foreground mt-1">
                      {section.description}
                    </p>
                  )}
                </div>
                <div className="space-y-4">
                  {section.content}
                </div>
              </div>
            ))}
          </div>

          {/* Right Column - Summary */}
          <div className="space-y-6 mt-[84px]">
            <div className="sticky top-20 bg-background p-6 rounded-lg border border-border">
              <div className="mb-4">
                <h3 className="text-base font-semibold">
                  {summaryTitle}
                </h3>
              </div>

              <div className="space-y-4">
                {/* Summary Fields */}
                <div className="space-y-2">
                  {summaryFields.map((field, index) => {
                    // Check if field should be hidden when empty
                    if (field.hideIfEmpty && !field.value) {
                      return null;
                    }

                    return (
                      <div
                        key={index}
                        className={`flex justify-between text-sm ${
                          field.bordered ? "border-t pt-6 mt-6" : ""
                        }`}
                      >
                        <span className="text-muted-foreground">{field.label}</span>
                        <span className="font-medium">{field.value || "—"}</span>
                      </div>
                    );
                  })}
                </div>

                {/* Additional Summary Content */}
                {summaryContent && (
                  <div className="space-y-2">
                    {summaryContent}
                  </div>
                )}

                {/* Actions */}
                <div className="space-y-2 pt-4">
                  <Button
                    type="submit"
                    disabled={isPending}
                    variant={submitVariant}
                    className="w-full shadow-none"
                  >
                    {isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        {t('sweep.entities.savingEllipsis')}
                      </>
                    ) : (
                      resolvedSubmitText
                    )}
                  </Button>

                  {cancelLink && (
                    <Link href={cancelLink} className="block">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={isPending}
                        className="w-full shadow-none"
                      >
                        {resolvedCancelText}
                      </Button>
                    </Link>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </form>
  );

  // Return with or without EntityPageHeader
  return (
      <div className="h-full flex flex-col">
        <div className="flex-1 overflow-y-auto min-h-0 custom-scrollbar bg-muted/30">
          <div className="container mx-auto px-4 py-5 md:px-6 md:py-8 max-w-[1600px] pb-20">
            {formContent}
          </div>
        </div>
      </div>
    );
}
