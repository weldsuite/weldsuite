
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';
import type { ComponentType } from 'react';

interface WizardStep {
  label: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
}

interface EditorWizardNavProps {
  tabs: WizardStep[];
  currentStep: number; // 1-based
  /** Optional right-side content (e.g. Save/Publish buttons) */
  rightContent?: React.ReactNode;
  /** Intercept navigation — return false to block, true to allow */
  onBeforeNavigate?: (href: string) => boolean;
}

export function EditorWizardNav({
  tabs,
  currentStep,
  rightContent,
  onBeforeNavigate,
}: EditorWizardNavProps) {
  const handleNavigate = (e: React.MouseEvent, href: string) => {
    if (onBeforeNavigate && !onBeforeNavigate(href)) {
      e.preventDefault();
    }
  };

  return (
    <div className="bg-background border-b flex-shrink-0 relative z-10">
      <div className="px-2 md:px-4 py-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 md:gap-2">
            <div className="flex items-center gap-0.5">
              {tabs.map((step, index) => {
                const isActive = index + 1 === currentStep;
                const StepIcon = step.icon;

                return (
                  <div key={step.label} className="relative group">
                    <Link
                      href={step.href}
                      onClick={(e) => handleNavigate(e, step.href)}
                      className={cn(
                        'relative flex items-center gap-1.5 text-xs md:text-sm font-medium px-2 md:px-3 py-1.5 rounded-md transition-colors',
                        index === 0 && 'pl-0 md:pl-0',
                        isActive
                          ? 'text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <StepIcon className="h-3.5 w-3.5" />
                      {step.label}
                    </Link>
                    <div
                      className={cn(
                        'absolute -bottom-[11px] h-0.5 transition-colors',
                        index === 0 ? 'left-0' : 'left-2 md:left-3',
                        'right-2 md:right-3',
                        isActive ? 'bg-foreground' : 'bg-transparent group-hover:bg-gray-300 dark:group-hover:bg-gray-600'
                      )}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {rightContent && (
            <div className="flex items-center gap-1 md:gap-2">
              {rightContent}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
