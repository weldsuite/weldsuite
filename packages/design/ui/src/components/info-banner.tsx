'use client';

import { useState } from 'react';
import { Info, AlertTriangle, CheckCircle2, Lightbulb, X, type LucideIcon } from 'lucide-react';
import { Alert } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { useUiLabels } from '@weldsuite/ui/providers/ui-labels-provider';
import { cn } from '@weldsuite/ui/lib/utils';

export type InfoBannerVariant = 'info' | 'warning' | 'danger' | 'success' | 'tip' | 'neutral';

export interface InfoBannerProps {
  /**
   * The banner content to display
   */
  children?: React.ReactNode;

  /**
   * Visual variant for the banner
   * - info: General informational message (blue)
   * - warning: Warning or caution (yellow)
   * - danger: A problem that needs action (red)
   * - success: Success or confirmation message (green)
   * - tip: Helpful tip or suggestion (purple)
   * - neutral: A quiet hint (grey)
   * @default "info"
   */
  variant?: InfoBannerVariant;

  /**
   * Optional title for the banner
   */
  title?: string | React.ReactNode;

  /**
   * Buttons or links at the end of the banner
   */
  action?: React.ReactNode;

  /**
   * Replaces the variant's icon
   */
  icon?: LucideIcon;

  /**
   * Whether the banner can be dismissed
   * @default false
   */
  dismissible?: boolean;

  /**
   * Callback when banner is dismissed (optional)
   */
  onDismiss?: () => void;

  /**
   * Optional custom className
   */
  className?: string;

  'data-testid'?: string;
}

const variantConfig: Record<InfoBannerVariant, { icon: LucideIcon; className: string; iconClassName: string }> = {
  info: {
    icon: Info,
    className:
      'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100',
    iconClassName: 'text-blue-600 dark:text-blue-400',
  },
  warning: {
    icon: AlertTriangle,
    className:
      'border-yellow-200 bg-yellow-50 text-yellow-900 dark:border-yellow-900 dark:bg-yellow-950 dark:text-yellow-100',
    iconClassName: 'text-yellow-600 dark:text-yellow-400',
  },
  danger: {
    icon: AlertTriangle,
    className: 'border-destructive/40 bg-destructive/10 text-destructive',
    iconClassName: 'text-destructive',
  },
  success: {
    icon: CheckCircle2,
    className:
      'border-green-200 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950 dark:text-green-100',
    iconClassName: 'text-green-600 dark:text-green-400',
  },
  tip: {
    icon: Lightbulb,
    className:
      'border-purple-200 bg-purple-50 text-purple-900 dark:border-purple-900 dark:bg-purple-950 dark:text-purple-100',
    iconClassName: 'text-purple-600 dark:text-purple-400',
  },
  neutral: {
    icon: Info,
    className: 'border-border bg-muted/40 text-muted-foreground',
    iconClassName: 'text-muted-foreground',
  },
};

/**
 * InfoBanner - Full-width contextual banner for page or section-level information
 *
 * @example
 * <InfoBanner variant="warning" title="Action Required" dismissible>
 *   Please complete your tax settings before creating invoices.
 * </InfoBanner>
 */
export function InfoBanner({
  children,
  variant = 'info',
  title,
  action,
  icon,
  dismissible = false,
  onDismiss,
  className,
  'data-testid': testId,
}: Readonly<InfoBannerProps>) {
  const labels = useUiLabels();
  const [dismissed, setDismissed] = useState(false);
  const config = variantConfig[variant];
  const Icon = icon ?? config.icon;

  if (dismissed) {
    return null;
  }

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };

  return (
    <Alert
      role={variant === 'danger' || variant === 'warning' ? 'alert' : 'status'}
      data-testid={testId}
      className={cn(config.className, 'relative', dismissible && 'pr-10', className)}
    >
      <Icon className={cn(config.iconClassName)} aria-hidden="true" />
      <div className="col-start-2 flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          {title && <div className={cn('font-semibold text-sm', children && 'mb-1')}>{title}</div>}
          {children && <div className="text-sm leading-relaxed">{children}</div>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {dismissible && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 absolute top-2 right-2 opacity-70 hover:opacity-100"
          onClick={handleDismiss}
          aria-label={labels.dismiss}
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </Alert>
  );
}
