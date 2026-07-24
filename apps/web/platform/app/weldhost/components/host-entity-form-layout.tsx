
import { ReactNode } from "react";
import { useRouter, Link } from '@/lib/router';
import { Button } from "@weldsuite/ui/components/button";
import { LucideIcon, ChevronLeft } from "lucide-react";
import { useTranslations } from '@weldsuite/i18n/client';

export interface HostFormSection {
  /** Section title */
  title: string;
  /** Section icon */
  icon: LucideIcon;
  /** Section content (form fields) */
  content: ReactNode;
  /** Optional description */
  description?: string;
}

export interface HostSummaryField {
  /** Field label */
  label: ReactNode;
  /** Field value (ReactNode for flexibility) */
  value: ReactNode;
  /** Show border on top */
  bordered?: boolean;
  /** Hide field if value is empty */
  hideIfEmpty?: boolean;
}

export interface HostEntityFormLayoutProps {
  /** Page title */
  title: string;
  /** Optional subtitle/description */
  subtitle?: string;
  /** Form sections to display in left column */
  sections: HostFormSection[];
  /** Summary title */
  summaryTitle: string;
  /** Summary icon */
  summaryIcon: LucideIcon;
  /** Summary fields to display in right column */
  summaryFields: HostSummaryField[];
  /** Summary fields to display at the bottom (above action buttons) */
  summaryBottomFields?: HostSummaryField[];
  /** Additional summary content (below fields, above actions) */
  summaryContent?: ReactNode;
  /** Form submit handler */
  onSubmit: (e: React.FormEvent) => void;
  /** Is form submitting */
  isPending?: boolean;
  /** Submit button text */
  submitText?: ReactNode;
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
  /** Hide mobile summary panel (use when rendering it elsewhere) */
  hideMobileSummary?: boolean;
  /** Optional action element rendered at the right side of the summary header */
  summaryHeaderAction?: ReactNode;
}

export function HostEntityFormLayout({
  title,
  subtitle,
  sections,
  summaryTitle,
  summaryIcon: SummaryIcon,
  summaryFields,
  summaryBottomFields,
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
  hideMobileSummary = false,
  summaryHeaderAction,
}: HostEntityFormLayoutProps) {
  const router = useRouter();
  const t = useTranslations();
  const resolvedSubmitText = submitText ?? t('sweep.miscB.save');
  const resolvedCancelText = cancelText ?? t('sweep.miscB.cancel');
  const resolvedBackButtonText = backButtonText ?? t('sweep.miscB.back');

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
          {resolvedBackButtonText}
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
        {resolvedBackButtonText}
      </Button>
    )
  ) : null;

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-scroll min-h-0 custom-scrollbar bg-muted/30">
        <div className="container mx-auto px-4 md:px-6 py-6 md:py-8 max-w-[1600px] pb-20">
          <>
            {/* Form - full width on mobile, leaves room for sidebar on desktop */}
            <form onSubmit={onSubmit} className="space-y-6 md:space-y-8 min-h-full md:mr-[420px]" suppressHydrationWarning>
              <div className="w-full">
                {/* Form Sections - Full Width */}
                <div className="space-y-4">
                  <div className="mb-2">
                    {backButton}
                  </div>
                  <h2 className="text-xl md:text-2xl font-semibold">{title}</h2>
                  {subtitle && (
                    <p className="text-sm text-muted-foreground -mt-2">{subtitle}</p>
                  )}
                  {sections.map((section, index) => {
                    const hasHeader = section.title || section.description;

                    if (!hasHeader) {
                      // Render without card wrapper if no title/description
                      return (
                        <div key={index} className="space-y-4">
                          {section.content}
                        </div>
                      );
                    }

                    // Render with card wrapper if has title/description
                    return (
                      <div
                        key={index}
                        className="bg-background px-4 md:px-6 pt-4 md:pt-5 pb-5 md:pb-6 rounded-lg border border-border"
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
                    );
                  })}
                </div>
              </div>
            </form>

            {/* Mobile Summary Panel - shown at bottom on mobile (unless hideMobileSummary is true) */}
            {!hideMobileSummary && (
            <div className="md:hidden mt-6 bg-background rounded-lg border border-border">
              <div className="p-4 border-b border-border flex items-center gap-2">
                <SummaryIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                <h3 className="text-base font-semibold">
                  {summaryTitle}
                </h3>
              </div>

              <div className="p-4 space-y-4">
                {/* Summary Fields */}
                {summaryFields.length > 0 && (
                  <div className="space-y-3">
                    {summaryFields.map((field, index) => {
                      if (field.hideIfEmpty && !field.value) {
                        return null;
                      }
                      return (
                        <div
                          key={index}
                          className={`flex justify-between text-sm ${
                            field.bordered ? "border-t pt-3 mt-3" : ""
                          }`}
                        >
                          <span className="text-muted-foreground">{field.label}</span>
                          <span className="font-medium">{field.value || "—"}</span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Additional Summary Content */}
                {summaryContent && (
                  <div className="space-y-2">
                    {summaryContent}
                  </div>
                )}

                {/* Bottom Summary Fields */}
                {summaryBottomFields && summaryBottomFields.length > 0 && (
                  <div className="space-y-3 pt-3 border-t border-border">
                    {summaryBottomFields.map((field, index) => {
                      if (field.hideIfEmpty && !field.value) {
                        return null;
                      }
                      return (
                        <div
                          key={index}
                          className={`flex justify-between text-sm ${
                            field.bordered ? "border-t pt-3 mt-3" : ""
                          }`}
                        >
                          <span className="text-muted-foreground">{field.label}</span>
                          <span className="font-medium">{field.value || "—"}</span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Actions */}
                <div className="space-y-3 pt-2">
                  <Button
                    type="submit"
                    disabled={isPending}
                    variant={submitVariant}
                    className="w-full shadow-none"
                    size="lg"
                    onClick={onSubmit}
                  >
                    {resolvedSubmitText}
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
            )}

            {/* Desktop Right Side Panel - Fixed Overlay (hidden on mobile) */}
            <div className="hidden md:flex fixed top-0 right-0 h-screen w-[400px] bg-background border-l border-border z-40 flex-col pt-16">
              <div className="flex-1 overflow-y-auto">
                <div className="mb-6">
                  <div className="flex items-center justify-between px-4 pt-2.5 mb-2.5">
                    <div className="flex items-center gap-2">
                      <SummaryIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                      <h3 className="text-lg font-semibold">
                        {summaryTitle}
                      </h3>
                    </div>
                    {summaryHeaderAction}
                  </div>
                  <div className="border-t border-border" />
                </div>

                <div className="space-y-6 px-4">
                  {/* Summary Fields */}
                  <div className="space-y-3">
                    {summaryFields.map((field, index) => {
                      // Check if field should be hidden when empty
                      if (field.hideIfEmpty && !field.value) {
                        return null;
                      }

                      return (
                        <div
                          key={index}
                          className={`flex justify-between text-sm ${
                            field.bordered ? "border-t pt-3 mt-3" : ""
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
                </div>
              </div>

              {/* Actions - Fixed at Bottom */}
              <div className="p-4 pt-4 border-t border-border bg-background">
                {/* Bottom Summary Fields */}
                {summaryBottomFields && summaryBottomFields.length > 0 && (
                  <div className="space-y-3 mb-4">
                    {summaryBottomFields.map((field, index) => {
                      // Check if field should be hidden when empty
                      if (field.hideIfEmpty && !field.value) {
                        return null;
                      }

                      return (
                        <div
                          key={index}
                          className={`flex justify-between text-sm ${
                            field.bordered ? "border-t pt-3 mt-3" : ""
                          }`}
                        >
                          <span className="text-muted-foreground">{field.label}</span>
                          <span className="font-medium">{field.value || "—"}</span>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="space-y-3">
                  <Button
                    type="submit"
                    disabled={isPending}
                    variant={submitVariant}
                    className="w-full shadow-none"
                    size="lg"
                    onClick={onSubmit}
                  >
                    {resolvedSubmitText}
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
          </>
        </div>
      </div>
    </div>
  );
}
